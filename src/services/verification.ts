import { Connection, clusterApiUrl } from '@solana/web3.js'
import { getEscrowPda, getEscrowState, ESCROW_PROGRAM_ID } from './escrow'

const network = (process.env.SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet'
const connection = new Connection(clusterApiUrl(network), 'confirmed')

/**
 * How a failed release attempt should be handled.
 *
 * The distinction that matters most is between "the payment failed" and
 * "we don't know whether the payment failed" — those look similar in an
 * error message but are very different once money is involved.
 */
export type FailureClass =
  /** Release window + grace has passed. Funds are still in escrow and the
   *  customer can permissionlessly refund themselves. Not our failure. */
  | 'terminal_expired'
  /** On-chain state shows the release already succeeded — the merchant has
   *  the funds. The job failed; the payment did not. */
  | 'already_settled'
  /** Customer reclaimed the funds. Terminal, and not a merchant payment. */
  | 'terminal_refunded'
  /** Transient (RPC, network, congestion). Worth another attempt. */
  | 'retryable'
  /** Genuinely, permanently broken. Needs a human. */
  | 'terminal_failed'
  /** Could not determine. Retry, then dead-letter for review. */
  | 'unknown'

export interface ClassifiedFailure {
  class: FailureClass
  reason: string
  /** Signature we managed to verify, when one was available. */
  signature?: string
}

/** Error substrings that indicate a transient condition worth retrying. */
const RETRYABLE_PATTERNS = [
  'blockhash not found',
  'block height exceeded',
  'timed out',
  'timeout',
  'econnreset',
  'etimedout',
  'socket hang up',
  'fetch failed',
  'network request failed',
  '429',
  'too many requests',
  'rate limit',
  'node is behind',
  'service unavailable',
]

function messageOf(err: any): string {
  return (
    err?.message ??
    err?.error?.errorMessage ??
    err?.toString?.() ??
    ''
  ).toLowerCase()
}

/**
 * Anchor sometimes surfaces the signature of a transaction that was sent but
 * whose confirmation failed. Dig it out when present — a signature turns an
 * ambiguous failure into a checkable fact.
 */
function extractSignature(err: any): string | undefined {
  if (typeof err?.signature === 'string') return err.signature
  if (typeof err?.txid === 'string') return err.txid
  const msg = err?.message ?? ''
  const match = msg.match(/Transaction ([1-9A-HJ-NP-Za-km-z]{80,90})/)
  return match?.[1]
}

/**
 * Anchor encodes Rust enums as single-key objects: { released: {} }.
 */
function statusIs(status: any, variant: string): boolean {
  return !!status && typeof status === 'object' && variant in status
}

// ── Verification tiers ────────────────────────────────────────────────────────

/**
 * Tier 1 + 2: did this specific transaction land, and did our program run
 * without erroring?
 *
 * The strongest evidence available, but only usable when we actually have a
 * signature — which we don't when the failure happened during simulation,
 * before anything was sent.
 */
async function verifyTransactionFinalized(
  signature: string
): Promise<{ finalized: boolean; succeeded: boolean; touchedOurProgram: boolean }> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })

  if (!tx) {
    return { finalized: false, succeeded: false, touchedOurProgram: false }
  }

  const succeeded = tx.meta?.err === null || tx.meta?.err === undefined
  const logs = tx.meta?.logMessages ?? []
  const touchedOurProgram = logs.some((l) => l.includes(ESCROW_PROGRAM_ID.toBase58()))

  return { finalized: true, succeeded, touchedOurProgram }
}

type EscrowStatusCheck =
  | { kind: 'released' }
  | { kind: 'refunded' }
  | { kind: 'funded' }
  | { kind: 'pending' }
  | { kind: 'absent' }
  | { kind: 'unrecognized'; raw: any }

/**
 * Tier 3: read the escrow's own status field.
 *
 * NOTE: release does NOT close the escrow account — it closes the *vault*
 * (an ATA) and drains its rent to the merchant, while the escrow PDA itself
 * survives holding status = Released. So "escrow account is gone" is the
 * wrong test; the status field is the direct evidence.
 *
 * That distinction is exactly why a redundant release attempt reports
 * AccountNotInitialized against `vault` rather than against `escrow`.
 *
 * Uses getAccountInfo first so an RPC failure throws rather than being
 * misread as an absent account — concluding "settled" from a network blip
 * would be the worst possible failure mode here.
 */
async function checkEscrowStatus(paymentUuid: string): Promise<EscrowStatusCheck> {
  const escrowPda = getEscrowPda(paymentUuid)

  // Throws on RPC failure. Returns null only if the account genuinely is not there.
  const info = await connection.getAccountInfo(escrowPda)
  if (info === null) return { kind: 'absent' }

  const escrow = await getEscrowState(paymentUuid)
  if (!escrow) return { kind: 'absent' }

  const status = escrow.status
  if (statusIs(status, 'released')) return { kind: 'released' }
  if (statusIs(status, 'refunded')) return { kind: 'refunded' }
  if (statusIs(status, 'funded')) return { kind: 'funded' }
  if (statusIs(status, 'pending')) return { kind: 'pending' }
  return { kind: 'unrecognized', raw: status }
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Decide what a failed release attempt actually means, consulting the chain
 * when the error alone isn't conclusive.
 *
 * `payment` needs at least { id, escrow_pda, escrow_used }.
 */
export async function classifyReleaseFailure(
  err: any,
  payment: { id: string; escrow_pda?: string | null; escrow_used?: boolean }
): Promise<ClassifiedFailure> {
  const msg = messageOf(err)
  const signature = extractSignature(err)

  // Expired is unambiguous and needs no chain lookup: the program refused
  // because the window closed, funds are still escrowed, and the customer's
  // refund path is open.
  if (msg.includes('releasewindowpassed') || msg.includes('release window')) {
    return {
      class: 'terminal_expired',
      reason: 'Release window + grace elapsed; funds remain in escrow for customer refund',
    }
  }

  // Non-escrow payments have no on-chain escrow state to consult.
  if (!payment.escrow_used) {
    if (RETRYABLE_PATTERNS.some((p) => msg.includes(p))) {
      return { class: 'retryable', reason: 'Transient error on legacy transfer path' }
    }
    return { class: 'unknown', reason: `Unclassified legacy-path error: ${msg.slice(0, 200)}` }
  }

  // ── Tier 1 + 2: check the transaction itself, when we have one ──
  if (signature) {
    try {
      const { finalized, succeeded, touchedOurProgram } =
        await verifyTransactionFinalized(signature)

      if (finalized && succeeded && touchedOurProgram) {
        return {
          class: 'already_settled',
          reason: 'Transaction finalized successfully; release executed',
          signature,
        }
      }
    } catch (verifyErr) {
      console.error(`[verify] could not fetch tx ${signature}:`, verifyErr)
    }
  }

  // ── Tier 3: the escrow's own status is the authoritative answer ──
  try {
    const check = await checkEscrowStatus(payment.id)

    switch (check.kind) {
      case 'released':
        return {
          class: 'already_settled',
          reason: 'Escrow status is Released; merchant has been paid',
          signature,
        }

      case 'refunded':
        return {
          class: 'terminal_refunded',
          reason: 'Escrow status is Refunded; customer reclaimed the funds',
        }

      case 'funded':
        // Deposit is in the vault and release genuinely has not happened.
        // A retry is legitimate — unless the error says otherwise.
        if (RETRYABLE_PATTERNS.some((p) => msg.includes(p))) {
          return { class: 'retryable', reason: `Escrow still Funded; transient error: ${msg.slice(0, 150)}` }
        }
        return {
          class: 'unknown',
          reason: `Escrow still Funded but release failed: ${msg.slice(0, 200)}`,
          signature,
        }

      case 'pending':
        // No deposit yet. Releasing was premature; nothing to retry against.
        return {
          class: 'terminal_failed',
          reason: 'Escrow status is Pending — no deposit to release',
        }

      case 'absent':
        // Release doesn't close the escrow, so absence means it was never
        // created (or was cancelled while Pending). Either way, nothing to release.
        return {
          class: 'terminal_failed',
          reason: 'Escrow account does not exist; nothing to release',
        }

      case 'unrecognized':
        return {
          class: 'unknown',
          reason: `Unrecognized escrow status: ${JSON.stringify(check.raw)}`,
          signature,
        }
    }
  } catch (verifyErr) {
    // Couldn't reach the chain — precisely the ambiguity 'unknown' exists for.
    return {
      class: 'unknown',
      reason: `Could not verify on-chain state: ${(verifyErr as Error).message}`,
      signature,
    }
  }

  if (RETRYABLE_PATTERNS.some((p) => msg.includes(p))) {
    return { class: 'retryable', reason: `Transient: ${msg.slice(0, 200)}` }
  }

  return { class: 'unknown', reason: `Unclassified: ${msg.slice(0, 200)}`, signature }
}