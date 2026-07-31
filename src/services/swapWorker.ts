import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../db/redis'
import { pool } from '../db'
import { swapToUSDC } from './jupiter'
import { transferUSDCToMerchant } from './tansfer'
import { releaseEscrow } from './escrow'
import { classifyReleaseFailure } from './verification'
import { recordDeadLetter, resolveDeadLettersForPayment } from './deadLetter'
import { notifyMerchant } from './notify'
import { unregisterAddressFromHelius } from './helius'
import { swapQueue, SwapJobData } from './queues'



export { swapQueue }
export type { SwapJobData }

const SOL_MINT = 'So11111111111111111111111111111111111111112'

const USDC_MINT: Record<string, string> = {
  devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}

/** Statuses from which no further processing is meaningful. */
const TERMINAL_STATUSES = ['completed', 'expired', 'refunded']



/** True when this is the last attempt BullMQ will make for this job. */
function isFinalAttempt(job: Job): boolean {
  const configured = job.opts?.attempts ?? 1
  // attemptsMade counts attempts already completed, so the current attempt is
  // number attemptsMade + 1. Compare defensively — the exact semantics have
  // shifted across BullMQ versions, and over-reporting a final attempt is far
  // less harmful than never recording a dead letter at all.
  return job.attemptsMade + 1 >= configured
}

export const swapWorker = new Worker<SwapJobData>(
  'swap',
  async (job) => {
    const { paymentId, depositAddress, derivationPath, tokenReceived, amountReceived } = job.data

    const isStablecoin = tokenReceived === 'USDC' || tokenReceived === 'USDT'
    const jobType = isStablecoin ? 'transfer' : 'swap'

    console.log(`Processing ${jobType} job for payment ${paymentId}`)

    // Read before writing. The old order updated the status first, which meant
    // a job for an already-settled payment clobbered its terminal status with
    // 'transferring' before anything had a chance to notice.
    const result = await pool.query(
      `SELECT p.*, m.payout_wallet, m.webhook_url
       FROM payments p
       JOIN merchants m ON p.merchant_id = m.id
       WHERE p.id = $1`,
      [paymentId]
    )

    if (result.rows.length === 0) throw new Error(`Payment ${paymentId} not found`)
    const payment = result.rows[0]

    // A job arriving for a payment that has already settled is a replay or a
    // duplicate. There is nothing left to do, and proceeding would both
    // overwrite the terminal status and risk a second merchant notification.
    if (TERMINAL_STATUSES.includes(payment.status)) {
      console.log(`Payment ${paymentId} is already ${payment.status} — nothing to do`)
      return { swapTx: 'n/a', transferTx: `already_${payment.status}` }
    }

    await pool.query(
      `UPDATE payments SET status = $1 WHERE id = $2`,
      [isStablecoin ? 'transferring' : 'swapping', paymentId]
    )

    /**
     * Shared success path — used both by a normal completion and by the
     * 'already_settled' case, where the merchant was in fact paid and simply
     * needs the same bookkeeping a first-attempt success would have done.
     *
     * The status transition is conditional on the payment not already being
     * completed, so this can run more than once for the same payment without
     * notifying the merchant twice. A duplicate payment.completed is worse
     * than it sounds: a naive integration may fulfil the order again.
     */
    const settleAsCompleted = async (swapTx: string, transferTx: string, usdcAmount: number) => {
      const transitioned = await pool.query(
        `UPDATE payments SET status = 'completed'
          WHERE id = $1 AND status <> 'completed'`,
        [paymentId]
      )

      // Cheap and idempotent, so it runs either way — if an earlier completion
      // died partway through, this gives the cleanup another chance.
      await unregisterAddressFromHelius(depositAddress)

      if (transitioned.rowCount === 0) {
        console.log(
          `Payment ${paymentId} was already completed — skipping duplicate merchant notification`
        )
        return
      }

      await resolveDeadLettersForPayment(paymentId)

      if (payment.webhook_url) {
        await notifyMerchant(payment.webhook_url, {
          event: 'payment.completed',
          payment_id: payment.id,
          order_id: payment.order_id,
          amount_usdc: usdcAmount,
          token_received: tokenReceived,
          amount_received: amountReceived,
          swap_tx: swapTx,
          transfer_tx: transferTx,
          timestamp: new Date().toISOString(),
        })
      }
    }

    try {
      let swapTx: string = ''
      let transferTx: string = ''
      let usdcAmount: number = 0

      if (isStablecoin) {
        usdcAmount = amountReceived
        swapTx = `direct_${tokenReceived.toLowerCase()}_no_swap`

        if (payment.escrow_used) {
          console.log(`Releasing escrow for payment ${paymentId}`)
          const { txSignature } = await releaseEscrow({
            paymentUuid: paymentId,
            merchantPayoutWallet: payment.payout_wallet,
          })
          transferTx = txSignature
        } else {
          console.log(`Direct ${tokenReceived} payment of ${usdcAmount} to ${payment.payout_wallet}`)
          transferTx = await transferUSDCToMerchant(
            derivationPath!,
            payment.payout_wallet,
            usdcAmount
          )
        }
      } else {
        const inputMint = tokenReceived === 'SOL' ? SOL_MINT : tokenReceived
        usdcAmount = Number(payment.amount_usdc)

        if (process.env.MOCK_SWAP === 'true') {
          console.log(`[MOCK] Simulating Jupiter swap: ${amountReceived} lamports → USDC`)
          swapTx = 'mock_swap_tx_' + Date.now()
          console.log(`[MOCK] Simulating USDC transfer of ${usdcAmount} USDC to ${payment.payout_wallet}`)
          transferTx = 'mock_transfer_tx_' + Date.now()
        } else {
          swapTx = await swapToUSDC(inputMint, amountReceived, derivationPath!)
          transferTx = await transferUSDCToMerchant(
            derivationPath!,
            payment.payout_wallet,
            usdcAmount
          )
        }
      }

      await settleAsCompleted(swapTx, transferTx, usdcAmount)

      console.log(`✅ Payment ${paymentId} fully completed.`)
      return { swapTx, transferTx }

    } catch (err: any) {
      const rawMessage = err?.message ?? String(err)

      // Consult the chain before deciding what this failure means. The error
      // text alone can't distinguish "the release failed" from "the release
      // already succeeded and this attempt was redundant" — and getting that
      // wrong marks a paid merchant's payment as failed.
      const verdict = await classifyReleaseFailure(err, {
        id: paymentId,
        escrow_pda: payment.escrow_pda,
        escrow_used: payment.escrow_used,
      })

      console.error(
        `Payment ${paymentId} release attempt failed [${verdict.class}]: ${verdict.reason}`
      )

      switch (verdict.class) {
        case 'already_settled': {
          // The merchant has the money. The job failed; the payment did not.
          console.log(
            `✅ Payment ${paymentId} verified settled on-chain — recording as completed`
          )
          await settleAsCompleted(
            `direct_${tokenReceived.toLowerCase()}_no_swap`,
            verdict.signature ?? 'verified_on_chain',
            amountReceived
          )
          return { swapTx: 'n/a', transferTx: verdict.signature ?? 'verified_on_chain' }
        }

        case 'terminal_expired': {
          // Funds remain escrowed and the customer can refund themselves.
          // Not a failure on our side, and retrying can never help.
          await pool.query("UPDATE payments SET status = 'expired' WHERE id = $1", [paymentId])
          await unregisterAddressFromHelius(depositAddress)
          console.log(
            `Payment ${paymentId} expired — funds remain in escrow for customer refund`
          )
          return { swapTx: 'n/a', transferTx: 'release_window_passed' }
        }

        case 'terminal_refunded': {
          // The customer reclaimed their deposit. Terminal, and not a payment
          // to the merchant — retrying could never produce one.
          await pool.query("UPDATE payments SET status = 'refunded' WHERE id = $1", [paymentId])
          await unregisterAddressFromHelius(depositAddress)
          console.log(`Payment ${paymentId} was refunded to the customer`)
          return { swapTx: 'n/a', transferTx: 'refunded' }
        }

        case 'terminal_failed': {
          // Genuinely broken and retrying won't help. Record for a human.
          await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId])
          await recordDeadLetter({
            paymentId,
            queueName: 'swap',
            jobId: String(job.id),
            jobData: job.data,
            errorClass: verdict.class,
            errorMessage: `${verdict.reason} | raw: ${rawMessage}`,
            attemptsMade: job.attemptsMade + 1,
          })
          return { swapTx: 'n/a', transferTx: 'failed' }
        }

        case 'retryable':
        case 'unknown':
        default: {
          if (isFinalAttempt(job)) {
            // Automated recovery is exhausted. Hand it to a human rather than
            // silently burying it in a 'failed' status with no context.
            await pool.query("UPDATE payments SET status = 'failed' WHERE id = $1", [paymentId])
            await recordDeadLetter({
              paymentId,
              queueName: 'swap',
              jobId: String(job.id),
              jobData: job.data,
              errorClass: verdict.class,
              errorMessage: `${verdict.reason} | raw: ${rawMessage}`,
              attemptsMade: job.attemptsMade + 1,
            })
          }
          // Throw so BullMQ retries with its configured backoff. Leave the
          // status as 'transferring'/'swapping' between attempts — marking it
          // 'failed' now would be premature while retries remain.
          throw err
        }
      }
    }
  },
  {
    connection: redis,
    concurrency: 5,
  }
)

swapWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`)
})

swapWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message)
})