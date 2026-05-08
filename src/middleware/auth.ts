import { FastifyRequest, FastifyReply } from 'fastify'
import { pool } from '../db'

export async function authMiddleware(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const apiKey = req.headers['x-api-key'] as string

  if (!apiKey) {
    return reply.status(401).send({ error: 'Missing x-api-key header' })
  }

  const result = await pool.query(
    'SELECT * FROM merchants WHERE api_key = $1',
    [apiKey]
  )

  if (result.rows.length === 0) {
    return reply.status(401).send({ error: 'Invalid API key' })
  }

  const merchant = result.rows[0]

  // Log merchant info for debugging
  console.log(`🔑 Merchant authenticated: ${merchant.name} | payout_wallet: ${merchant.payout_wallet}`)

  // Attach merchant to request so routes can use it
  ;(req as any).merchant = merchant
}
