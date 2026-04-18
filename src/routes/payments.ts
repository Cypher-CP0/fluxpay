import { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'
import { deriveDepositAddress } from '../services/wallet'
import { registerAddressWithHelius } from '../services/helius'
import { CreatePaymentBody } from '../types'

export async function paymentRoutes(app: FastifyInstance) {

  app.post<{ Body: CreatePaymentBody }>(
    '/payments/create',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const merchant = (req as any).merchant
      const { order_id, amount_usdc } = req.body

      if (!order_id || !amount_usdc || amount_usdc <= 0) {
        return reply.status(400).send({ error: 'order_id and amount_usdc are required' })
      }

      const existing = await pool.query(
        'SELECT id, status FROM payments WHERE merchant_id = $1 AND order_id = $2',
        [merchant.id, order_id]
      )
      if (existing.rows.length > 0) {
        return reply.status(409).send({
          error: 'Payment for this order_id already exists',
          payment_id: existing.rows[0].id,
          status: existing.rows[0].status,
        })
      }

      const mnemonic = process.env.MASTER_MNEMONIC!
      const { address, derivationPath } = deriveDepositAddress(mnemonic, merchant.id, order_id)
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

      const result = await pool.query(
        `INSERT INTO payments
          (merchant_id, order_id, deposit_address, derivation_path, amount_usdc, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [merchant.id, order_id, address, derivationPath, amount_usdc, expiresAt]
      )

      const payment = result.rows[0]

      // Register this address with Helius so it starts watching it
      await registerAddressWithHelius(address)

      return reply.status(201).send({
        payment_id: payment.id,
        deposit_address: payment.deposit_address,
        amount_usdc: payment.amount_usdc,
        expires_at: payment.expires_at,
        status: payment.status,
        network: process.env.SOLANA_NETWORK,
      })
    }
  )

  app.get<{ Params: { id: string } }>(
    '/payments/:id',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const merchant = (req as any).merchant
      const { id } = req.params

      const result = await pool.query(
        'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2',
        [id, merchant.id]
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Payment not found' })
      }

      const payment = result.rows[0]

      if (payment.status === 'pending' && new Date() > new Date(payment.expires_at)) {
        await pool.query("UPDATE payments SET status = 'expired' WHERE id = $1", [payment.id])
        payment.status = 'expired'
      }

      return reply.send({
        payment_id: payment.id,
        order_id: payment.order_id,
        deposit_address: payment.deposit_address,
        amount_usdc: payment.amount_usdc,
        amount_received: payment.amount_received,
        token_received: payment.token_received,
        status: payment.status,
        expires_at: payment.expires_at,
        created_at: payment.created_at,
      })
    }
  )
}
