import { pool } from '../db'
import { redis } from '../db/redis'

// Redis fast-layer TTL — long enough to absorb Helius retries and rapid
// duplicate deliveries, short enough not to accumulate unbounded keys.
// Postgres remains the permanent ledger past this window.
const REDIS_TTL_SECONDS = 48 * 60 * 60 // 48h

/**
 * Dual-layer idempotency check for an incoming webhook, keyed on the
 * transaction signature (unique per on-chain event).
 *
 * Layer 1 (Redis, fast): blocks rapid concurrent / retried duplicates
 * cheaply, before we touch Postgres. Uses SET NX so the check-and-claim
 * is atomic — no race between two simultaneous deliveries.
 *
 * Layer 2 (Postgres, durable): the permanent source of truth. Even if
 * Redis is flushed, the UNIQUE constraint on processed_webhooks.signature
 * guarantees a given signature is only ever processed once.
 *
 * Returns true if this signature is NEW (caller should process it), or
 * false if it's a duplicate (caller should skip).
 */
export async function claimWebhook(signature: string, paymentId?: string): Promise<boolean> {
  if (!signature) {
    // No signature to dedup on — process it, but this is unusual and worth noting.
    console.warn('claimWebhook called with empty signature — processing without dedup')
    return true
  }

  // ── Layer 1: Redis fast claim ────────────────────────────────────────────
  // SET key 1 NX EX <ttl> — returns 'OK' if newly set, null if key existed.
  const redisKey = `webhook:${signature}`
  try {
    const claimed = await redis.set(redisKey, '1', 'EX', REDIS_TTL_SECONDS, 'NX')
    if (claimed === null) {
      // Key already existed — a duplicate we've very recently seen.
      return false
    }
  } catch (err) {
    // If Redis is down, don't fail open silently — fall through to Postgres,
    // which is the real source of truth. Log so it's visible.
    console.error('Redis claim failed, falling through to Postgres:', err)
  }

  // ── Layer 2: Postgres durable ledger ─────────────────────────────────────
  // ON CONFLICT DO NOTHING + checking rowCount tells us atomically whether
  // THIS insert won the race (new) or hit the UNIQUE constraint (duplicate).
  try {
    const result = await pool.query(
      `INSERT INTO processed_webhooks (signature, payment_id)
       VALUES ($1, $2)
       ON CONFLICT (signature) DO NOTHING`,
      [signature, paymentId ?? null]
    )
    // rowCount === 0 means the row already existed → duplicate.
    if (result.rowCount === 0) {
      return false
    }
  } catch (err) {
    console.error('Postgres webhook claim failed:', err)
    // On a genuine DB error (not a conflict), err on the side of NOT
    // processing — better to rely on reconciliation to pick it up later
    // than to risk a double-process we can't dedup.
    return false
  }

  return true
}