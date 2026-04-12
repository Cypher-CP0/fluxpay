import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export async function initDB() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS merchants (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name          TEXT NOT NULL,
        api_key       TEXT NOT NULL UNIQUE,
        payout_wallet TEXT NOT NULL,
        webhook_url   TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id      UUID NOT NULL REFERENCES merchants(id),
        order_id         TEXT NOT NULL,
        deposit_address  TEXT NOT NULL UNIQUE,
        derivation_path  TEXT NOT NULL,
        amount_usdc      NUMERIC(18, 6) NOT NULL,
        amount_received  NUMERIC(18, 6),
        token_received   TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        expires_at       TIMESTAMPTZ NOT NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(merchant_id, order_id)
      );

      CREATE INDEX IF NOT EXISTS idx_payments_deposit_address
        ON payments(deposit_address);

      CREATE INDEX IF NOT EXISTS idx_payments_status
        ON payments(status);
    `)
    console.log('✅ DB schema ready')
  } finally {
    client.release()
  }
}
