import * as anchor from '@coral-xyz/anchor'
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor'
import {
  Connection,
  PublicKey,
  Keypair,
  clusterApiUrl,
  SystemProgram,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

// ── Config ───────────────────────────────────────────────────────────────────

const network = (process.env.SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet'
const connection = new Connection(clusterApiUrl(network), 'confirmed')

const PROGRAM_ID = new PublicKey(process.env.ESCROW_PROGRAM_ID!)
const USDC_MINT = new PublicKey(process.env.ESCROW_USDC_MINT!)

// Admin/payer keypair — signs create_escrow (as payer) and release (as admin).
// Loaded from the raw secret-key JSON array, same format as `solana-keygen`
// output / ~/.config/solana/id.json. This is a SEPARATE secret from
// MASTER_MNEMONIC (Option B — see conversation history for why).
function loadAdminKeypair(): Keypair {
  const raw = process.env.ESCROW_ADMIN_SECRET_KEY
  if (!raw) {
    throw new Error('ESCROW_ADMIN_SECRET_KEY is not set in .env')
  }
  const secretKey = Uint8Array.from(JSON.parse(raw))
  return Keypair.fromSecretKey(secretKey)
}

const adminKeypair = loadAdminKeypair()
const wallet = new Wallet(adminKeypair)
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
anchor.setProvider(provider)

// IDL comes from the fluxpay-contracts submodule — see contracts/README.md.
// Anchor 0.31.x reads the program ID from idl.address, so PROGRAM_ID above
// is used for our own PDA derivations, and must match idl.address exactly.
const idlPath = path.join(
  __dirname,
  '..',
  '..',
  'contracts',
  'solana',
  'escrow',
  'target',
  'idl',
  'fluxpay_escrow.json'
)
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'))

if (idl.address !== PROGRAM_ID.toBase58()) {
  throw new Error(
    `ESCROW_PROGRAM_ID (${PROGRAM_ID.toBase58()}) does not match idl.address (${idl.address}). ` +
      `Update .env or re-check which program was deployed.`
  )
}

// Cast to `any` — same reasoning as the initialize-config.ts script: Anchor's
// generated TS types on some IDL shapes trigger "excessively deep" inference
// errors that don't reflect any real runtime issue.
const program = new Program(idl as anchor.Idl, provider) as Program<any>

// ── Payment ID mapping ────────────────────────────────────────────────────────

/**
 * The on-chain program uses a fixed [u8; 32] payment_id, but our `payments`
 * table uses UUID strings. Derive a deterministic 32-byte ID from the UUID
 * via sha256, so the same payment always maps to the same escrow PDA.
 *
 * NOTE: this is NOT the same as Decision 12 (unguessable payment_id) from
 * EscrowDesign.md — a UUID-derived hash is fine for now since create_escrow
 * is gated to our own backend's admin key, but full unguessability (e.g.
 * merchant-signed nonce) is still a deferred item for later hardening.
 */
export function paymentIdToBytes(paymentUuid: string): number[] {
  const hash = crypto.createHash('sha256').update(paymentUuid).digest()
  return Array.from(hash)
}

// ── PDA derivation ────────────────────────────────────────────────────────────

export function getConfigPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)
  return pda
}

export function getEscrowPda(paymentUuid: string): PublicKey {
  const paymentIdBytes = paymentIdToBytes(paymentUuid)
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), Buffer.from(paymentIdBytes)],
    PROGRAM_ID
  )
  return pda
}

export async function getVaultAta(escrowPda: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(USDC_MINT, escrowPda, true)
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Creates an on-chain escrow for a payment. Call this at payment-creation
 * time, instead of (or alongside) deriving an HD deposit wallet, for
 * direct USDC/USDT payments.
 *
 * Returns the vault ATA address — this is what gets shown to the customer
 * as the "deposit address" in the widget. The customer's USDC/USDT goes
 * directly into this escrow-owned account.
 */
export async function createEscrow(params: {
  paymentUuid: string
  merchantPayoutWallet: string
  amountUsdc: number // human-readable, e.g. 10.5
  paymentWindowSeconds: number
  gracePeriodSeconds: number
}): Promise<{ escrowPda: PublicKey; vaultAta: PublicKey; txSignature: string }> {
  const { paymentUuid, merchantPayoutWallet, amountUsdc, paymentWindowSeconds, gracePeriodSeconds } =
    params

  const paymentIdBytes = paymentIdToBytes(paymentUuid)
  const escrowPda = getEscrowPda(paymentUuid)
  const vaultAta = await getVaultAta(escrowPda)
  const configPda = getConfigPda()
  const merchantPubkey = new PublicKey(merchantPayoutWallet)

  // USDC has 6 decimals — convert human-readable amount to base units.
  const amountBaseUnits = new anchor.BN(Math.floor(amountUsdc * 1_000_000))

  const txSignature = await (program.methods as any)
    .createEscrow(
      paymentIdBytes,
      merchantPubkey,
      amountBaseUnits,
      new anchor.BN(paymentWindowSeconds),
      new anchor.BN(gracePeriodSeconds)
    )
    .accounts({
      config: configPda,
      escrow: escrowPda,
      vault: vaultAta,
      usdcMint: USDC_MINT,
      payer: adminKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc()

  console.log(`✅ Escrow created for payment ${paymentUuid}`)
  console.log(`   Escrow PDA: ${escrowPda.toBase58()}`)
  console.log(`   Vault ATA (deposit address): ${vaultAta.toBase58()}`)
  console.log(`   Tx: ${txSignature}`)

  return { escrowPda, vaultAta, txSignature }
}

/**
 * Releases escrowed funds to the merchant. Call this once Helius confirms
 * the customer's deposit landed in the vault — this REPLACES the old
 * transferUSDCToMerchant() call in swapWorker.ts for direct USDC/USDT
 * payments.
 *
 * Will fail on-chain (ReleaseWindowPassed) if called after the payment
 * window + grace period has expired — in that case the payment should be
 * marked failed/expired, not retried.
 */
// ─────────────────────────────────────────────────────────────────────────────
// REPLACE the existing releaseEscrow function in src/services/escrow.ts
// with this version. Everything else in that file stays as-is.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Releases escrowed funds to the merchant. Call this once a deposit is
 * confirmed in the vault.
 *
 * Deliberately does NOT use Anchor's .rpc() convenience method. .rpc() builds,
 * sends and confirms in one call, and if confirmation times out it throws
 * without reliably surfacing the signature — leaving us unable to check later
 * whether the transaction actually landed. Since that ambiguity is exactly
 * what causes a paid merchant's payment to be marked failed, we send and
 * confirm separately and attach the signature to any confirmation error.
 */
export async function releaseEscrow(params: {
  paymentUuid: string
  merchantPayoutWallet: string
}): Promise<{ txSignature: string }> {
  const { paymentUuid, merchantPayoutWallet } = params

  const paymentIdBytes = paymentIdToBytes(paymentUuid)
  const escrowPda = getEscrowPda(paymentUuid)
  const vaultAta = await getVaultAta(escrowPda)
  const configPda = getConfigPda()
  const merchantPubkey = new PublicKey(merchantPayoutWallet)
  const merchantTokenAccount = await getAssociatedTokenAddress(USDC_MINT, merchantPubkey)

  const tx = await (program.methods as any)
    .release(paymentIdBytes)
    .accounts({
      config: configPda,
      escrow: escrowPda,
      vault: vaultAta,
      merchantTokenAccount,
      admin: adminKeypair.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .transaction()

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = adminKeypair.publicKey
  tx.sign(adminKeypair)

  // If this throws, preflight rejected the transaction and nothing was sent —
  // there is no signature to check, which the classifier handles by falling
  // back to inspecting escrow account state.
  const txSignature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })

  try {
    await connection.confirmTransaction(
      { signature: txSignature, blockhash, lastValidBlockHeight },
      'confirmed'
    )
  } catch (err: any) {
    // The transaction WAS sent. Whether it landed is unknown, so hand the
    // signature to the caller — it turns an ambiguous failure into something
    // verifiable rather than a guess.
    err.signature = txSignature
    throw err
  }

  console.log(`✅ Escrow released for payment ${paymentUuid}`)
  console.log(`   ${merchantPayoutWallet} paid via escrow`)
  console.log(`   Tx: ${txSignature}`)

  return { txSignature }
}

/**
 * Fetches the on-chain status of an escrow. Useful for reconciliation /
 * debugging — lets you check on-chain truth independent of your DB's
 * `payments.status` column.
 */
export async function getEscrowState(paymentUuid: string): Promise<any | null> {
  const escrowPda = getEscrowPda(paymentUuid)
  try {
    return await (program.account as any).escrow.fetch(escrowPda)
  } catch (err) {
    // Account doesn't exist yet (escrow not created) or already closed.
    return null
  }
}

export { PROGRAM_ID as ESCROW_PROGRAM_ID, USDC_MINT as ESCROW_USDC_MINT }