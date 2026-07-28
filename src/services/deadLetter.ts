import { pool } from '../db'
import { swapQueue, SwapJobData } from './swapWorker'

/**
 * Records a job that exhausted its BullMQ retries.
 *
 * BullMQ keeps its own failed-jobs set in Redis, which is fine for immediate
 * operational triage — but it's Redis, so it doesn't survive a flush and
 * isn't queryable alongside the rest of your data. This table is the durable
 * record: what failed, why, with enough payload to replay it later.
 *
 * Idempotent on (payment_id, job_id) so a worker that reports the same
 * exhausted job twice doesn't create duplicate rows.
 */
export async function recordDeadLetter(params: {
  paymentId: string
  queueName: string
  jobId?: string
  jobData: any
  errorClass: string
  errorMessage: string
  attemptsMade: number
}): Promise<void> {
  const { paymentId, queueName, jobId, jobData, errorClass, errorMessage, attemptsMade } = params

  try {
    await pool.query(
      `INSERT INTO dead_letter_jobs
         (payment_id, queue_name, job_id, job_data, error_class, error_message, attempts_made)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [paymentId, queueName, jobId ?? null, JSON.stringify(jobData), errorClass, errorMessage.slice(0, 2000), attemptsMade]
    )
    console.error(
      `[dlq] payment ${paymentId} dead-lettered after ${attemptsMade} attempts ` +
        `(${errorClass}): ${errorMessage.slice(0, 200)}`
    )
  } catch (err) {
    // A DLQ write failing is bad — it's the last line of record-keeping. Log
    // loudly; the payment row status is still the fallback signal.
    console.error(`[dlq] FAILED TO RECORD dead letter for payment ${paymentId}:`, err)
  }
}

/**
 * Lists dead-lettered jobs awaiting human attention.
 */
export async function listUnresolvedDeadLetters(limit = 50) {
  const result = await pool.query(
    `SELECT d.*, p.order_id, p.amount_usdc, p.status AS payment_status
       FROM dead_letter_jobs d
       LEFT JOIN payments p ON p.id = d.payment_id
      WHERE d.resolved = FALSE
      ORDER BY d.created_at DESC
      LIMIT $1`,
    [limit]
  )
  return result.rows
}

/**
 * Manually replays a dead-lettered job.
 *
 * Deliberately manual: a job reaching the DLQ means automated recovery is
 * exhausted, so re-running it without a human first understanding (and
 * usually fixing) the cause just burns another set of retries.
 *
 * Marks replayed_at immediately. `resolved` stays false until the replayed
 * job actually completes — so a row with replayed_at set and resolved false
 * is a replay that failed again, which is worth surfacing.
 */
export async function replayDeadLetter(deadLetterId: string): Promise<{ jobId: string }> {
  const result = await pool.query(
    `SELECT * FROM dead_letter_jobs WHERE id = $1`,
    [deadLetterId]
  )
  if (result.rows.length === 0) {
    throw new Error(`Dead letter ${deadLetterId} not found`)
  }
  const record = result.rows[0]

  if (record.resolved) {
    throw new Error(`Dead letter ${deadLetterId} is already resolved`)
  }

  const jobData = record.job_data as SwapJobData

  const job = await swapQueue.add('swap', jobData, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  })

  await pool.query(
    `UPDATE dead_letter_jobs SET replayed_at = NOW() WHERE id = $1`,
    [deadLetterId]
  )

  console.log(`[dlq] replayed dead letter ${deadLetterId} as job ${job.id}`)
  return { jobId: String(job.id) }
}

/**
 * Marks a dead letter resolved — either because a replay succeeded, or
 * because an operator determined no action was needed.
 */
export async function resolveDeadLetter(deadLetterId: string, notes?: string): Promise<void> {
  await pool.query(
    `UPDATE dead_letter_jobs SET resolved = TRUE, notes = COALESCE($2, notes) WHERE id = $1`,
    [deadLetterId, notes ?? null]
  )
}

/**
 * Resolves any outstanding dead letters for a payment. Called when a payment
 * reaches a terminal-good state, so a later successful attempt automatically
 * closes out the earlier failure record.
 */
export async function resolveDeadLettersForPayment(paymentId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE dead_letter_jobs
        SET resolved = TRUE,
            notes = COALESCE(notes, '') || ' [auto-resolved: payment reached terminal success]'
      WHERE payment_id = $1 AND resolved = FALSE`,
    [paymentId]
  )
  if (result.rowCount && result.rowCount > 0) {
    console.log(`[dlq] auto-resolved ${result.rowCount} dead letter(s) for payment ${paymentId}`)
  }
}