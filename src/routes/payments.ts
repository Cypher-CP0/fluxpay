import { FastifyInstance } from 'fastify'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'
import { deriveDepositAddress } from '../services/wallet'
import { registerAddressWithHelius } from '../services/helius'
import { createEscrow } from '../services/escrow'
import { CreatePaymentBody } from '../types'
import { getSolPrice } from '../services/price'

// Escrow timing (seconds). Payment window matches the widget's 15-min countdown;
// grace period absorbs late Helius webhook confirmations before refunds unlock.
const PAYMENT_WINDOW_SECONDS = 15 * 60
const GRACE_PERIOD_SECONDS = 10 * 60

export async function paymentRoutes(app: FastifyInstance) {

  // ── Create payment ──────────────────────────────────────────────────────────
  // Just creates the record. Deposit address + Helius registration are deferred
  // to /select-token, because the deposit target depends on which token the
  // customer picks (HD wallet for SOL, escrow vault for USDC/USDT).
  app.post<{ Body: CreatePaymentBody }>(
    '/payments/create',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const merchant = (req as any).merchant
      const { order_id, amount_usdc } = req.body

      if (!order_id || !amount_usdc || amount_usdc <= 0) {
        return reply.status(400).send({ error: 'order_id and amount_usdc are required' })
      }
      if (!merchant.payout_wallet) {
        return reply.status(400).send({
          error: 'Payout wallet not configured. Please set your payout wallet in dashboard settings before accepting payments.'
        })
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

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)

      // No deposit_address / derivation_path yet — set at token selection.
      const result = await pool.query(
        `INSERT INTO payments
          (merchant_id, order_id, amount_usdc, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [merchant.id, order_id, amount_usdc, expiresAt]
      )

      const payment = result.rows[0]

      return reply.status(201).send({
        payment_id: payment.id,
        amount_usdc: payment.amount_usdc,
        expires_at: payment.expires_at,
        status: payment.status,
        network: process.env.SOLANA_NETWORK,
        sol_price_usd: await getSolPrice(),
      })
    }
  )

  // ── Select token ────────────────────────────────────────────────────────────
  // Called by the widget once the customer picks SOL / USDC / USDT. Sets up the
  // correct deposit target and registers it with Helius. Idempotent-ish: if the
  // same token is re-selected, returns the existing address rather than
  // re-creating anything.
  app.post<{ Params: { id: string }; Body: { token: 'SOL' | 'USDC' | 'USDT' } }>(
    '/payments/:id/select-token',
    { preHandler: authMiddleware },
    async (req, reply) => {
      const merchant = (req as any).merchant
      const { id } = req.params
      const { token } = req.body

      if (!token || !['SOL', 'USDC', 'USDT'].includes(token)) {
        return reply.status(400).send({ error: 'token must be one of SOL, USDC, USDT' })
      }

      const result = await pool.query(
        'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2',
        [id, merchant.id]
      )
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Payment not found' })
      }
      const payment = result.rows[0]

      if (payment.status !== 'pending') {
        return reply.status(409).send({
          error: `Payment is already ${payment.status}; cannot change token`,
        })
      }

      // If a token was already selected, only allow re-selecting the SAME token
      // (returns existing address). Switching tokens mid-flow would orphan the
      // first deposit target, so we block it.
      if (payment.token_selected && payment.token_selected !== token) {
        return reply.status(409).send({
          error: `Token already set to ${payment.token_selected} for this payment`,
        })
      }
      if (payment.token_selected === token && payment.deposit_address) {
        return reply.send({
          payment_id: payment.id,
          deposit_address: payment.deposit_address,
          token_selected: payment.token_selected,
          escrow_used: payment.escrow_used,
        })
      }

      let depositAddress: string
      let derivationPath: string | null = null
      let escrowUsed = false
      let escrowPda: string | null = null

      if (token === 'USDC' || token === 'USDT') {
        // Direct stablecoin — route through the on-chain escrow program.
        const { escrowPda: pda, vaultAta } = await createEscrow({
          paymentUuid: payment.id,
          merchantPayoutWallet: merchant.payout_wallet,
          amountUsdc: Number(payment.amount_usdc),
          paymentWindowSeconds: PAYMENT_WINDOW_SECONDS,
          gracePeriodSeconds: GRACE_PERIOD_SECONDS,
        })
        depositAddress = vaultAta.toBase58()
        escrowUsed = true
        escrowPda = pda.toBase58()
      } else {
        // SOL — existing HD-wallet + Jupiter-swap flow, unchanged.
        const mnemonic = process.env.MASTER_MNEMONIC!
        const derived = deriveDepositAddress(mnemonic, merchant.id, payment.order_id)
        depositAddress = derived.address
        derivationPath = derived.derivationPath
      }

      await pool.query(
        `UPDATE payments
           SET deposit_address = $1,
               derivation_path = $2,
               token_selected = $3,
               escrow_used = $4,
               escrow_pda = $5
         WHERE id = $6`,
        [depositAddress, derivationPath, token, escrowUsed, escrowPda, payment.id]
      )

      // Register the deposit target with Helius so it starts watching.
      await registerAddressWithHelius(depositAddress)

      return reply.send({
        payment_id: payment.id,
        deposit_address: depositAddress,
        token_selected: token,
        escrow_used: escrowUsed,
      })
    }
  )

  // ── Get payment ─────────────────────────────────────────────────────────────
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
        deposit_address: payment.deposit_address, // may be null until token selected
        amount_usdc: payment.amount_usdc,
        amount_received: payment.amount_received,
        token_received: payment.token_received,
        token_selected: payment.token_selected,
        status: payment.status,
        expires_at: payment.expires_at,
        created_at: payment.created_at,
      })
    }
  )

  // GET /api/price/sol — returns current SOL price in USD
  app.get('/price/sol', async (req, reply) => {
    const price = await getSolPrice()
    return reply.send({ sol_usd: price, cached: true })
  })

}