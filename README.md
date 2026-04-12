# FluxPay ⚡

Solana-based stablecoin payment gateway. Accept SOL, convert to USDC automatically via Jupiter DEX.

Built for [Colosseum Hackathon 2026](https://colosseum.org).

## How it works

1. Merchant calls `POST /api/payments/create` with order amount in USDC
2. FluxPay derives a unique deposit address (HD wallet) for that order
3. User sends SOL or USDC to the deposit address
4. Helius webhook fires when payment is detected on-chain
5. Jupiter swap converts SOL → USDC automatically
6. USDC lands in merchant's configured payout wallet

## Stack

- **Runtime**: Node.js + TypeScript
- **Server**: Fastify
- **DB**: PostgreSQL
- **Chain**: Solana (Devnet for now)
- **Indexer**: Helius webhooks
- **Swap**: Jupiter DEX (week 2)

## Getting started

```bash
cp .env.example .env
# fill in your values

npm install
npm run dev
```

## API

### Register a merchant
```
POST /api/merchants/register
{ "name": "My Store", "payout_wallet": "<solana_address>", "webhook_url": "https://..." }
```

### Create a payment
```
POST /api/payments/create
x-api-key: fp_live_...
{ "order_id": "order_123", "amount_usdc": 25.00 }
```

### Check payment status
```
GET /api/payments/:id
x-api-key: fp_live_...
```

## Status flow
`pending` → `detected` → `swapping` → `completed`

## Roadmap
- [x] HD wallet derivation
- [x] Payment create/status endpoints
- [x] Merchant registration + API key auth
- [x] Helius webhook receiver
- [ ] Jupiter swap integration (week 2)
- [ ] Checkout widget UI (week 3)
- [ ] Merchant dashboard (week 3)
