import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

export async function initDB() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS merchants (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name              TEXT NOT NULL,
        api_key           TEXT NOT NULL UNIQUE,
        -- NOT NULL, but registration inserts '' — the payments route checks
        -- for an empty wallet at runtime before allowing payment creation.
        payout_wallet     TEXT NOT NULL,
        webhook_url       TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        supabase_user_id  TEXT,
        email             TEXT
      );

      CREATE TABLE IF NOT EXISTS payments (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id      UUID NOT NULL REFERENCES merchants(id),
        order_id         TEXT NOT NULL,
        -- Nullable: set at token-selection time, not payment creation, since
        -- the deposit target depends on which token the customer picks.
        deposit_address  TEXT UNIQUE,
        derivation_path  TEXT,
        amount_usdc      NUMERIC(18, 6) NOT NULL,
        amount_received  NUMERIC(18, 6),
        token_received   TEXT,
        token_selected   TEXT,
        escrow_used      BOOLEAN DEFAULT FALSE,
        escrow_pda       TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        expires_at       TIMESTAMPTZ NOT NULL,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(merchant_id, order_id)
      );

      -- Webhook idempotency ledger. UNIQUE(signature) is the durable backstop
      -- behind the Redis fast layer — it survives a Redis flush.
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        signature     TEXT NOT NULL UNIQUE,
        payment_id    UUID REFERENCES payments(id),
        processed_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- Durable record of jobs that exhausted their BullMQ retries. BullMQ
      -- handles the retrying; this is what an operator reads afterwards.
      CREATE TABLE IF NOT EXISTS dead_letter_jobs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id      UUID REFERENCES payments(id),
        queue_name      TEXT NOT NULL,
        job_id          TEXT,
        job_data        JSONB NOT NULL,
        error_class     TEXT NOT NULL,
        error_message   TEXT,
        attempts_made   INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        replayed_at     TIMESTAMPTZ,
        resolved        BOOLEAN NOT NULL DEFAULT FALSE,
        notes           TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_payments_deposit_address
        ON payments(deposit_address);

      CREATE INDEX IF NOT EXISTS idx_payments_status
        ON payments(status);

      CREATE INDEX IF NOT EXISTS idx_processed_webhooks_signature
        ON processed_webhooks(signature);

      CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_payment
        ON dead_letter_jobs(payment_id);

      CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_unresolved
        ON dead_letter_jobs(created_at DESC) WHERE resolved = FALSE;
    `)
    console.log('✅ DB schema ready')
  } finally {
    client.release()
  }
}