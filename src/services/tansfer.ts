import {
    Connection,
    PublicKey,
    clusterApiUrl,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
    getOrCreateAssociatedTokenAccount,
    createTransferInstruction,
    getMint,
} from '@solana/spl-token'
import { deriveKeypairFromPath } from './wallet'

const USDC_MINT: Record<string, string> = {
    devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
    'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}

const network = (process.env.SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet'
const connection = new Connection(clusterApiUrl(network), 'confirmed')

export async function transferUSDCToMerchant(
    derivationPath: string,   // to re-derive deposit wallet keypair
    merchantPayoutWallet: string,  // merchant's configured wallet
    amountUsdc: number        // amount in USDC (human readable, e.g. 10.5)
): Promise<string> {
    const mnemonic = process.env.MASTER_MNEMONIC!
    const usdcMint = new PublicKey(USDC_MINT[network])

    // Re-derive the deposit wallet keypair (this holds the USDC after swap)
    const depositKeypair = deriveKeypairFromPath(mnemonic, derivationPath)
    const merchantPublicKey = new PublicKey(merchantPayoutWallet)

    // Get USDC mint info to determine decimals (USDC = 6 decimals)
    const mintInfo = await getMint(connection, usdcMint)
    const amountInSmallestUnit = Math.floor(amountUsdc * Math.pow(10, mintInfo.decimals))

    // Get or create the Associated Token Account (ATA) for the deposit wallet
    // ATA is where SPL tokens like USDC are actually held
    const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        depositKeypair,       // payer for account creation if needed
        usdcMint,
        depositKeypair.publicKey
    )

    // Get or create the ATA for the merchant's wallet
    const toTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        depositKeypair,       // deposit wallet pays for merchant ATA creation if needed
        usdcMint,
        merchantPublicKey
    )

    // Build the transfer instruction
    const transferInstruction = createTransferInstruction(
        fromTokenAccount.address,  // source ATA
        toTokenAccount.address,    // destination ATA
        depositKeypair.publicKey,  // owner of source
        amountInSmallestUnit
    )

    const transaction = new Transaction().add(transferInstruction)

    // Sign and send
    const txSignature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [depositKeypair],
        { commitment: 'confirmed' }
    )

    console.log(`✅ USDC transfer confirmed: ${txSignature}`)
    console.log(`   ${amountUsdc} USDC → ${merchantPayoutWallet}`)

    return txSignature
}