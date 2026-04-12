import { FastifyInstance } from 'fastify'
import { pool } from '../db'

export async function webhookRoutes(app: FastifyInstance) {

  // POST /webhooks/helius
  // Helius calls this when a tx hits one of our deposit addresses
  // Full swap logic goes here in week 2
  app.post('/webhooks/helius', async (req, reply) => {
    const events = req.body as any[]

    if (!Array.isArray(events)) {
      return reply.status(400).send({ error: 'Expected array of events' })
    }

    for (const event of events) {
      try {
        // Helius sends enhanced transaction events
        // Each event has accountData showing which accounts were affected
        const affectedAccounts: string[] = event.accountData?.map(
          (a: any) => a.account
        ) ?? []

        // Find if any affected account is one of our deposit addresses
        if (affectedAccounts.length === 0) continue

        const placeholders = affectedAccounts
          .map((_, i) => `$${i + 1}`)
          .join(',')

        const result = await pool.query(
          `SELECT * FROM payments
           WHERE deposit_address IN (${placeholders})
           AND status = 'pending'`,
          affectedAccounts
        )

        if (result.rows.length === 0) continue

        const payment = result.rows[0]

        // Mark as detected — swap logic plugs in here in week 2
        await pool.query(
          "UPDATE payments SET status = 'detected' WHERE id = $1",
          [payment.id]
        )

        console.log(`✅ Payment detected: ${payment.id} | order: ${payment.order_id}`)
        // TODO week 2: enqueue Jupiter swap job here

      } catch (err) {
        console.error('Error processing Helius event:', err)
      }
    }

    return reply.send({ received: true })
  })
}
