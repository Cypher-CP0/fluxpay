import { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { swapQueue } from '../services/swapWorker'

const TOKEN_MINTS: Record<string, string> = {
  'So11111111111111111111111111111111111111112': 'SOL',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 'USDC',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/helius', async (req, reply) => {
    const events = req.body as any[]
    if (!Array.isArray(events)) {
      return reply.status(400).send({ error: 'Expected array of events' })
    }
    for (const event of events) {
      try {
        await processHeliusEvent(event)
      } catch (err) {
        console.error('Error processing Helius event:', err)
      }
    }
    return reply.send({ received: true })
  })
}

async function processHeliusEvent(event: any) {
  const accountData: any[] = event.accountData ?? []
  const tokenTransfers: any[] = event.tokenTransfers ?? []
  const nativeTransfers: any[] = event.nativeTransfers ?? []

  const affectedAddresses = accountData.map((a: any) => a.account)
  if (affectedAddresses.length === 0) return

  const placeholders = affectedAddresses.map((_: any, i: number) => `$${i + 1}`).join(',')
  const result = await pool.query(
    `SELECT * FROM payments WHERE deposit_address IN (${placeholders}) AND status = 'pending'`,
    affectedAddresses
  )
  if (result.rows.length === 0) return

  const payment = result.rows[0]
  const depositAddress = payment.deposit_address

  const tokenTransfer = tokenTransfers.find((t: any) => t.toUserAccount === depositAddress)
  const solTransfer = nativeTransfers.find((t: any) => t.toUserAccount === depositAddress)

  let tokenReceived: string
  let amountReceived: number

  if (tokenTransfer) {
    tokenReceived = TOKEN_MINTS[tokenTransfer.mint] ?? tokenTransfer.mint
    amountReceived = tokenTransfer.tokenAmount
  } else if (solTransfer) {
    tokenReceived = 'SOL'
    amountReceived = solTransfer.amount
  } else {
    console.log(`Event for ${depositAddress} but no relevant transfer found`)
    return
  }

  const displayAmount = tokenReceived === 'SOL'
    ? amountReceived / 1_000_000_000
    : amountReceived / 1_000_000

  console.log(`Payment detected: ${displayAmount} ${tokenReceived} for payment ${payment.id}`)

  await pool.query(
    `UPDATE payments SET status = 'detected', amount_received = $1, token_received = $2 WHERE id = $3`,
    [amountReceived, tokenReceived, payment.id]
  )

  await swapQueue.add(
    'swap',
    {
      paymentId: payment.id,
      depositAddress: payment.deposit_address,
      derivationPath: payment.derivation_path,
      tokenReceived,
      amountReceived,
    },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }
  )

  console.log(`Swap job enqueued for payment ${payment.id}`)
}
