# FluxPay ⚡

A Solana-based stablecoin payment gateway. Merchants accept payments in USDC/USDT while users can pay with SOL or any supported token — auto-converted via Jupiter DEX.

Built for [Colosseum Hackathon 2026](https://colosseum.org).

---

## How it works

```
Merchant creates order → FluxPay derives unique deposit address (HD wallet)
                                        ↓
                    User sends SOL/USDC to deposit address
                                        ↓
                    Helius detects on-chain transaction (webhook)
                                        ↓
                    Jupiter swaps SOL → USDC automatically
                                        ↓
                    USDC transferred to merchant's payout wallet
                                        ↓
                    Merchant notified via webhook
```

No shared addresses. Every order gets its own unique deposit wallet derived from a master seed — child private keys are never stored.

---

## Features

- **HD Wallet Derivation** — one master seed generates unlimited unique deposit addresses deterministically
- **Merchant API** — API key auth, merchant registration, payout wallet configuration
- **Payment Sessions** — create payments with configurable expiry, unique deposit address per order
- **On-chain Detection** — Helius webhooks fire the moment SOL/USDC hits a deposit address
- **Dynamic Address Watching** — deposit addresses registered with Helius automatically on payment creation, unregistered on completion
- **Auto-swap** — Jupiter DEX integration converts received token to USDC automatically
- **Background Jobs** — BullMQ + Redis job queue handles swaps asynchronously, never blocking the webhook handler
- **USDC Transfer** — after swap, USDC transferred from deposit wallet to merchant's payout wallet via SPL token transfer
- **Merchant Notifications** — merchant's configured webhook URL called on payment completion
- **Idempotent webhook handling** — duplicate Helius events safely ignored
- **Auto-expiry** — pending payments past expiry automatically marked expired
- **Retry logic** — failed swap jobs retry up to 3 times with exponential backoff

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + TypeScript |
| Server | Fastify |
| Database | PostgreSQL (Supabase) |
| Cache / Queue | Redis + BullMQ |
| Blockchain | Solana (Devnet / Mainnet) |
| On-chain Indexing | Helius Webhooks |
| DEX / Swap | Jupiter Aggregator |
| Token Transfer | @solana/spl-token |
| HD Wallet | bip39 + ed25519-hd-key + tweetnacl |

---

## Project structure

```
fluxpay/
├── src/
│   ├── index.ts                  ← Fastify server entry point
│   ├── types/index.ts            ← shared TypeScript types
│   ├── db/
│   │   ├── index.ts              ← PostgreSQL pool + schema init
│   │   └── redis.ts              ← Redis client
│   ├── middleware/
│   │   └── auth.ts               ← API key validation
│   ├── services/
│   │   ├── wallet.ts             ← HD wallet derivation (core logic)
│   │   ├── helius.ts             ← register/unregister addresses with Helius
│   │   ├── jupiter.ts            ← Jupiter quote + swap (+ mock for Devnet)
│   │   ├── transfer.ts           ← SPL token transfer to merchant wallet
│   │   ├── notify.ts             ← merchant webhook notification
│   │   └── swapWorker.ts         ← BullMQ worker for background swaps
│   └── routes/
│       ├── payments.ts           ← POST /payments/create, GET /payments/:id
│       ├── merchants.ts          ← POST /merchants/register
│       └── webhooks.ts           ← POST /webhooks/helius
├── .env.example
├── .gitignore
├── Week1.md
├── week-2-till-now.md
├── package.json
└── tsconfig.json
```

---

## Getting started

### Prerequisites

- Node.js 18+
- PostgreSQL (or [Supabase](https://supabase.com) free tier)
- Redis (`docker run -d --name fluxpay-redis -p 6379:6379 redis:alpine`)
- [Helius](https://helius.dev) account (free tier)
- [ngrok](https://ngrok.com) for local webhook testing

### Setup

```bash
# Clone the repo
git clone https://github.com/Cypher-CP0/fluxpay.git
cd fluxpay

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in your values

# Start Redis
docker start fluxpay-redis

# Run in development
npm run dev
```

You should see:
```
✅ Redis connected
✅ DB schema ready
✅ Swap worker started
🚀 FluxPay running on port 3000
```

---

## Environment variables

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://postgres:password@host:5432/postgres

# HD Wallet master seed — NEVER commit the real value
# Generate: node -e "const b = require('bip39'); console.log(b.generateMnemonic())"
MASTER_MNEMONIC="twelve word bip39 mnemonic seed phrase goes here"

# Helius
HELIUS_API_KEY=your_helius_api_key
HELIUS_WEBHOOK_ID=your_webhook_id_from_helius_dashboard

# Redis
REDIS_URL=redis://localhost:6379

# Network: devnet | mainnet-beta
SOLANA_NETWORK=devnet

# Set to true for Devnet testing (skips real Jupiter swap + transfer)
MOCK_SWAP=true
```

---

## API reference

### Register a merchant

```
POST /api/merchants/register
```

```json
{
  "name": "My Store",
  "payout_wallet": "<solana_wallet_address>",
  "webhook_url": "https://mystore.com/webhooks/fluxpay"
}
```

Response:
```json
{
  "id": "uuid",
  "name": "My Store",
  "api_key": "fp_live_...",
  "payout_wallet": "<address>",
  "webhook_url": "https://...",
  "created_at": "..."
}
```

---

### Create a payment

```
POST /api/payments/create
x-api-key: fp_live_...
```

```json
{
  "order_id": "order_123",
  "amount_usdc": 25.00
}
```

Response:
```json
{
  "payment_id": "uuid",
  "deposit_address": "<unique solana address>",
  "amount_usdc": "25.000000",
  "expires_at": "2026-04-18T12:00:00.000Z",
  "status": "pending",
  "network": "devnet"
}
```

Show `deposit_address` to the user as a QR code. They send SOL or USDC to this address.

---

### Check payment status

```
GET /api/payments/:payment_id
x-api-key: fp_live_...
```

Response:
```json
{
  "payment_id": "uuid",
  "order_id": "order_123",
  "deposit_address": "<address>",
  "amount_usdc": "25.000000",
  "amount_received": "1.00",
  "token_received": "SOL",
  "status": "completed",
  "expires_at": "...",
  "created_at": "..."
}
```

---

## Payment status flow

```
pending → detected → swapping → completed
                              → failed (retries up to 3x with exponential backoff)
pending → expired  (after expiry window with no payment)
```

---

## Full payment loop

```
1. POST /api/payments/create
   → HD wallet derives unique deposit address
   → Address registered with Helius for watching
   → Payment record created in DB (status: pending)

2. User sends SOL/USDC to deposit address

3. Helius detects transaction → POST /webhooks/helius
   → Webhook identifies token + amount received
   → Payment updated (status: detected)
   → Swap job enqueued in BullMQ (webhook returns immediately)

4. BullMQ swap worker picks up job
   → Status: swapping
   → Jupiter swaps received token → USDC
   → USDC transferred via SPL token transfer to merchant payout wallet
   → Status: completed
   → Address unregistered from Helius
   → Merchant webhook_url notified
```

---

## Database schema

**merchants**
```sql
id            UUID PRIMARY KEY
name          TEXT
api_key       TEXT UNIQUE
payout_wallet TEXT
webhook_url   TEXT
created_at    TIMESTAMPTZ
```

**payments**
```sql
id               UUID PRIMARY KEY
merchant_id      UUID → merchants.id
order_id         TEXT
deposit_address  TEXT UNIQUE
derivation_path  TEXT
amount_usdc      NUMERIC
amount_received  NUMERIC
token_received   TEXT
status           TEXT
expires_at       TIMESTAMPTZ
created_at       TIMESTAMPTZ
```

---

## HD Wallet derivation

Every payment gets a unique deposit address derived from a master seed using BIP44:

```
m/44'/501'/{merchantIndex}'/{orderIndex}'
             ↑ 501 = Solana coin type
```

Only the derivation path is stored in DB — never child private keys. To sweep funds, the keypair is re-derived on demand using the stored path.

---

## Local webhook testing with ngrok

```bash
# Terminal 1 — run the server
npm run dev

# Terminal 2 — expose to internet
ngrok http 3000
```

Use the ngrok URL as your Helius webhook URL:
```
https://your-ngrok-url.ngrok-free.dev/webhooks/helius
```

Keep ngrok running — free tier gives a new URL on every restart.

---

## Devnet testing notes

- Jupiter has no liquidity on Devnet — set `MOCK_SWAP=true` in `.env` to simulate swaps and transfers
- Get Devnet SOL from [faucet.solana.com](https://faucet.solana.com) (2 airdrops per 8 hours)
- Set `MOCK_SWAP=false` and `SOLANA_NETWORK=mainnet-beta` for production

---

## Git branch strategy

```
main      ← stable, tested, merged at end of each week
week-2    ← current (pending final end-to-end test)
week-3    ← UI layer (coming next)
```

---

## Roadmap

- [x] HD wallet derivation
- [x] Merchant registration + API key auth
- [x] Payment create / status endpoints
- [x] Helius webhook receiver
- [x] Dynamic address registration with Helius
- [x] BullMQ + Redis job queue
- [x] Jupiter swap integration (+ mock for Devnet)
- [x] USDC SPL token transfer to merchant payout wallet
- [x] Merchant webhook notification on completion
- [x] Retry logic with exponential backoff
- [ ] Full end-to-end Devnet test (pending faucet cooldown)
- [ ] Checkout widget UI (week 3)
- [ ] Merchant dashboard (week 3)
- [ ] Mainnet deployment (week 4)