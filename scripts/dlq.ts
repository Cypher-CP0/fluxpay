/**
 * Dead-letter queue operator CLI.
 *
 *   npx ts-node scripts/dlq.ts list
 *   npx ts-node scripts/dlq.ts show <deadLetterId>
 *   npx ts-node scripts/dlq.ts replay <deadLetterId>
 *   npx ts-node scripts/dlq.ts resolve <deadLetterId> [notes...]
 *
 * A job reaching the dead-letter queue means automated recovery is exhausted,
 * so replay is deliberately manual — the point is that a human looks at the
 * cause before another attempt is made.
 *
 * Note on environment: this enqueues onto the same Redis the worker consumes,
 * so REDIS_URL must point wherever that worker actually runs. Against
 * production that means Railway's Redis URL, not localhost.
 */

import 'dotenv/config'
import { pool } from '../src/db'
import { redis } from '../src/db/redis'
import { swapQueue, SwapJobData } from '../src/services/queues'
import { getEscrowState } from '../src/services/escrow'

function fmtDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19)
}

function truncate(s: string | null, n: number): string {
  if (!s) return '—'
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

/** Reads on-chain escrow status, so an operator can see whether a replay
 *  could even help before attempting one. */
async function escrowStatusFor(paymentId: string): Promise<string> {
  try {
    const escrow = await getEscrowState(paymentId)
    if (!escrow) return 'absent'
    const status = escrow.status
    if (!status || typeof status !== 'object') return 'unrecognized'
    return Object.keys(status)[0] ?? 'unrecognized'
  } catch (err) {
    return `unreadable (${(err as Error).message.slice(0, 40)})`
  }
}

async function list() {
  const result = await pool.query(
    `SELECT d.*, p.order_id, p.amount_usdc, p.status AS payment_status, p.escrow_used
       FROM dead_letter_jobs d
       LEFT JOIN payments p ON p.id = d.payment_id
      WHERE d.resolved = FALSE
      ORDER BY d.created_at DESC
      LIMIT 50`
  )

  if (result.rows.length === 0) {
    console.log('\nNo unresolved dead letters. Nothing needs attention.\n')
    return
  }

  console.log(`\n${result.rows.length} unresolved dead letter(s):\n`)

  for (const row of result.rows) {
    const escrowStatus = row.escrow_used ? await escrowStatusFor(row.payment_id) : 'n/a'

    console.log('─'.repeat(78))
    console.log(`  id             ${row.id}`)
    console.log(`  payment        ${row.payment_id}  (order ${row.order_id ?? '—'})`)
    console.log(`  amount         ${row.amount_usdc ?? '—'} USDC`)
    console.log(`  payment status ${row.payment_status ?? '—'}`)
    console.log(`  escrow status  ${escrowStatus}`)
    console.log(`  error class    ${row.error_class}`)
    console.log(`  attempts       ${row.attempts_made}`)
    console.log(`  failed at      ${fmtDate(row.created_at)}`)
    console.log(`  replayed       ${fmtDate(row.replayed_at)}`)
    console.log(`  error          ${truncate(row.error_message, 200)}`)
  }
  console.log('─'.repeat(78))

  // The two cases worth calling out, because they change what an operator
  // should do next.
  const settled = result.rows.filter((r) => r.payment_status === 'completed')
  if (settled.length > 0) {
    console.log(
      `\nNote: ${settled.length} of these belong to payments already marked completed —` +
        ` they likely just need resolving, not replaying.`
    )
  }
  const retried = result.rows.filter((r) => r.replayed_at && !r.resolved)
  if (retried.length > 0) {
    console.log(
      `Note: ${retried.length} have been replayed already and failed again —` +
        ` replaying a third time without changing something is unlikely to help.`
    )
  }
  console.log()
}

async function show(id: string) {
  const result = await pool.query(
    `SELECT d.*, p.order_id, p.amount_usdc, p.status AS payment_status,
            p.escrow_used, p.escrow_pda, p.deposit_address
       FROM dead_letter_jobs d
       LEFT JOIN payments p ON p.id = d.payment_id
      WHERE d.id = $1`,
    [id]
  )
  if (result.rows.length === 0) {
    console.error(`No dead letter with id ${id}`)
    process.exit(1)
  }
  const row = result.rows[0]

  console.log('\nDead letter', row.id)
  console.log('─'.repeat(78))
  console.log(`  payment          ${row.payment_id} (order ${row.order_id ?? '—'})`)
  console.log(`  amount           ${row.amount_usdc ?? '—'} USDC`)
  console.log(`  payment status   ${row.payment_status ?? '—'}`)
  console.log(`  escrow used      ${row.escrow_used}`)
  console.log(`  escrow pda       ${row.escrow_pda ?? '—'}`)
  console.log(`  deposit address  ${row.deposit_address ?? '—'}`)
  if (row.escrow_used) {
    console.log(`  escrow status    ${await escrowStatusFor(row.payment_id)}`)
  }
  console.log(`  queue            ${row.queue_name}`)
  console.log(`  original job id  ${row.job_id ?? '—'}`)
  console.log(`  error class      ${row.error_class}`)
  console.log(`  attempts made    ${row.attempts_made}`)
  console.log(`  failed at        ${fmtDate(row.created_at)}`)
  console.log(`  replayed at      ${fmtDate(row.replayed_at)}`)
  console.log(`  resolved         ${row.resolved}`)
  console.log(`  notes            ${row.notes ?? '—'}`)
  console.log('─'.repeat(78))
  console.log('\nFull error:\n')
  console.log(row.error_message ?? '—')
  console.log('\nJob payload:\n')
  console.log(JSON.stringify(row.job_data, null, 2))
  console.log()
}

async function replay(id: string) {
  const result = await pool.query(`SELECT * FROM dead_letter_jobs WHERE id = $1`, [id])
  if (result.rows.length === 0) {
    console.error(`No dead letter with id ${id}`)
    process.exit(1)
  }
  const row = result.rows[0]

  if (row.resolved) {
    console.error(`Dead letter ${id} is already resolved — nothing to replay.`)
    process.exit(1)
  }

  const payment = await pool.query(`SELECT status FROM payments WHERE id = $1`, [row.payment_id])
  const paymentStatus = payment.rows[0]?.status

  if (['completed', 'expired', 'refunded'].includes(paymentStatus)) {
    console.error(
      `Payment ${row.payment_id} is already '${paymentStatus}'. The worker will refuse ` +
        `to act on it, so a replay would be a no-op.\n` +
        `Use 'resolve' instead if this dead letter no longer needs attention.`
    )
    process.exit(1)
  }

  const jobData = row.job_data as SwapJobData
  const job = await swapQueue.add('swap', jobData, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  })

  await pool.query(`UPDATE dead_letter_jobs SET replayed_at = NOW() WHERE id = $1`, [id])

  console.log(`\nReplayed dead letter ${id} as job ${job.id}.`)
  console.log('Watch the worker logs to see how it resolves.')
  console.log(
    `\nThe row stays unresolved until the payment reaches a terminal success —` +
      ` at which point it is closed out automatically.\n`
  )
}

async function resolve(id: string, notes?: string) {
  const result = await pool.query(
    `UPDATE dead_letter_jobs
        SET resolved = TRUE, notes = COALESCE($2, notes)
      WHERE id = $1 AND resolved = FALSE
      RETURNING id`,
    [id, notes ?? null]
  )
  if (result.rowCount === 0) {
    console.error(`No unresolved dead letter with id ${id}`)
    process.exit(1)
  }
  console.log(`\nResolved dead letter ${id}.\n`)
}

async function main() {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case 'list':
      await list()
      break
    case 'show':
      if (!args[0]) throw new Error('Usage: dlq.ts show <deadLetterId>')
      await show(args[0])
      break
    case 'replay':
      if (!args[0]) throw new Error('Usage: dlq.ts replay <deadLetterId>')
      await replay(args[0])
      break
    case 'resolve':
      if (!args[0]) throw new Error('Usage: dlq.ts resolve <deadLetterId> [notes...]')
      await resolve(args[0], args.slice(1).join(' ') || undefined)
      break
    default:
      console.log(`
Dead-letter queue operator CLI

  npx ts-node scripts/dlq.ts list
      Show everything still awaiting attention, with current payment and
      on-chain escrow status alongside each failure.

  npx ts-node scripts/dlq.ts show <id>
      Full detail for one entry: complete error text and job payload.

  npx ts-node scripts/dlq.ts replay <id>
      Re-enqueue the job. Refuses if the payment has already settled.

  npx ts-node scripts/dlq.ts resolve <id> [notes]
      Mark handled without replaying — for cases that needed no action.
`)
  }

  await pool.end()
  await redis.quit()
}

main().catch(async (err) => {
  console.error('\n' + (err?.message ?? err) + '\n')
  try {
    await pool.end()
    await redis.quit()
  } catch {
    // best effort
  }
  process.exit(1)
})