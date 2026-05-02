import { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'

export async function merchantMeRoutes(app: FastifyInstance) {

    // GET /api/merchants/me — get current merchant profile
    app.get('/merchants/me', { preHandler: authMiddleware }, async (req, reply) => {
        const merchant = (req as any).merchant
        return reply.send({
            id: merchant.id,
            name: merchant.name,
            api_key: merchant.api_key,
            payout_wallet: merchant.payout_wallet,
            webhook_url: merchant.webhook_url,
            email: merchant.email,
            created_at: merchant.created_at,
        })
    })

    // PUT /api/merchants/me — update payout wallet and webhook URL
    app.put<{ Body: { payout_wallet?: string; webhook_url?: string } }>(
        '/merchants/me',
        { preHandler: authMiddleware },
        async (req, reply) => {
            const merchant = (req as any).merchant
            const { payout_wallet, webhook_url } = req.body

            const result = await pool.query(
                `UPDATE merchants
         SET payout_wallet = COALESCE($1, payout_wallet),
             webhook_url = COALESCE($2, webhook_url)
         WHERE id = $3
         RETURNING *`,
                [payout_wallet || null, webhook_url || null, merchant.id]
            )

            return reply.send(result.rows[0])
        }
    )

    // GET /api/payments — list all payments for this merchant
    app.get('/payments', { preHandler: authMiddleware }, async (req, reply) => {
        const merchant = (req as any).merchant

        const result = await pool.query(
            `SELECT * FROM payments
       WHERE merchant_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
            [merchant.id]
        )

        return reply.send(result.rows)
    })

    // GET /api/merchants/by-user/:supabaseUserId
    app.get<{ Params: { supabaseUserId: string } }>(
        '/merchants/by-user/:supabaseUserId',
        async (req, reply) => {
            const { supabaseUserId } = req.params
            const result = await pool.query(
                'SELECT * FROM merchants WHERE supabase_user_id = $1',
                [supabaseUserId]
            )
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Merchant not found' })
            }
            return reply.send(result.rows[0])
        }
    )
}