import { FastifyInstance } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import { pool } from '../db'

interface RegisterBody {
  name: string
  payout_wallet: string
  webhook_url?: string
  email?: string
  supabase_user_id?: string
}

export async function merchantRoutes(app: FastifyInstance) {

  // POST /merchants/register
  // Creates a merchant account and returns an API key
  app.post<{ Body: RegisterBody }>(
    '/merchants/register',
    async (req, reply) => {
      const { name, payout_wallet, webhook_url, email, supabase_user_id } = req.body

      if (!name) {
        return reply.status(400).send({ error: 'name and payout_wallet are required' })
      }

      const apiKey = `fp_live_${uuidv4().replace(/-/g, '')}`

      const result = await pool.query(
        `INSERT INTO merchants (name, api_key, payout_wallet, webhook_url, email, supabase_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, api_key, payout_wallet, webhook_url, email, created_at`,
        [name, apiKey, payout_wallet || '', webhook_url || null, email || null, supabase_user_id || null]
      )

      return reply.status(201).send(result.rows[0])
    }
  )
}
