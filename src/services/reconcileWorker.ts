import { Worker, Queue } from 'bullmq'
import { redis } from '../db/redis'
import { pool } from '../db'
import { swapQueue } from './swapWorker'
import { getEscrowState, getVaultAta, getEscrowPda } from './escrow'
import { Connection, clusterApiUrl } from '@solana/web3.js'
import { getAccount } from '@solana/spl-token'

const network = (process.env.SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet'
const connection = new Connection(clusterApiUrl(network), 'confirmed')

// Only reconcile payments older than this — avoids racing the normal webhook
// path, which should handle the vast majority within seconds.
const MIN_AGE_SECONDS = 30

import { reconcileQueue } from './queues'
export { reconcileQueue }

/**
 * Reconciliation safety net. Runs on a repeatable schedule and independently
 * checks the blockchain — NOT Helius — for deposits the webhook path may have
 * missed (Helius outage, our downtime, dropped ngrok tunnel, etc.).
 *
 * For each still-pending escrow payment, it reads the on-chain escrow account:
 * if the escrow is Funded (customer genuinely called deposit()) but our DB
 * still says 'pending', a webhook was missed — so we enqueue the swap job.
 * That job goes through the SAME idempotency guard, so if the real webhook
 * arrives late, we still won't double-process.
 *
 * This is deliberately independent of Helius: the whole point of a backup is
 * that it doesn't share a failure mode with the primary path.
 */
export const reconcileWorker = new Worker(
  'reconcile',
  async () => {
    const cutoff = new Date(Date.now() - MIN_AGE_SECONDS * 1000)

    // Pending escrow payments past the grace delay, not yet expired.
    const result = await pool.query(
      `SELECT id, deposit_address, escrow_used, created_at, expires_at
         FROM payments
        WHERE status = 'pending'
          AND escrow_used = true
          AND deposit_address IS NOT NULL
          AND created_at < $1
          AND expires_at > NOW()`,
      [cutoff]
    )

    if (result.rows.length === 0) {
      console.log('[reconcile] tick — no pending escrow payments to check')
      return
    }

    console.log(`[reconcile] checking ${result.rows.length} pending escrow payment(s)`)

    for (const payment of result.rows) {
      try {
        // On-chain truth: is this escrow actually Funded?
        const escrow = await getEscrowState(payment.id)
        if (!escrow) continue // escrow account not found — nothing to reconcile

        const status = escrow.status
        const isFunded = JSON.stringify(status) === JSON.stringify({ funded: {} })
        if (!isFunded) continue // still Pending on-chain — customer hasn't deposited yet

        // Escrow is Funded but our DB still says pending → missed webhook.
        // Read the vault balance to report the amount, then enqueue.
        let amountReceived = 0
        try {
          const escrowPda = await getEscrowPda(payment.id)
          const vaultAta = await getVaultAta(escrowPda)
          const vaultAccount = await getAccount(connection, vaultAta)
          amountReceived = Number(vaultAccount.amount) / 1_000_000 // 6 decimals
        } catch {
          // If we can't read the vault, fall back to the escrow's recorded amount.
          amountReceived = escrow.amount ? Number(escrow.amount) / 1_000_000 : 0
        }

        console.log(
          `[reconcile] MISSED deposit detected for payment ${payment.id} ` +
            `(escrow Funded, DB pending) — enqueuing swap job`
        )

        const claimed = await pool.query(
          `UPDATE payments SET status = 'detected', amount_received = $1, token_received = 'USDC' WHERE id = $2 AND status = 'pending'`,
          [amountReceived, payment.id]
        )
        if (claimed.rowCount === 0) {
          console.log(`[reconcile] payment ${payment.id} already claimed — skipping`)
          continue
        }

        await swapQueue.add(
          'swap',
          {
            paymentId: payment.id,
            depositAddress: payment.deposit_address,
            derivationPath: null, // escrow payments have no derivation path
            tokenReceived: 'USDC',
            amountReceived,
          },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
          }
        )
      } catch (err) {
        console.error(`[reconcile] error checking payment ${payment.id}:`, err)
        // Continue with the rest — one bad payment shouldn't stop reconciliation.
      }
    }
  },
  { connection: redis }
)

reconcileWorker.on('failed', (job, err) => {
  console.error('[reconcile] job failed:', err.message)
})

/**
 * Registers the repeatable reconciliation job. Call once at startup.
 * Every 2 minutes is a reasonable cadence — frequent enough that a missed
 * payment is caught quickly, infrequent enough not to hammer the RPC.
 */
export async function scheduleReconciliation() {
  // Remove any stale repeatable definitions first, so changing the interval
  // later doesn't leave duplicate schedules registered.
  const repeatables = await reconcileQueue.getRepeatableJobs()
  for (const r of repeatables) {
    await reconcileQueue.removeRepeatableByKey(r.key)
  }

  await reconcileQueue.add(
    'reconcile-tick',
    {},
    {
      repeat: { every: 2 * 60 * 1000 }, // every 2 minutes
      removeOnComplete: true,
      removeOnFail: true,
    }
  )
  console.log('✅ Reconciliation job scheduled (every 2 min)')
}