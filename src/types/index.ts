export type PaymentStatus =
  | 'pending'
  | 'detected'
  | 'swapping'
  | 'completed'
  | 'expired'
  | 'failed'

export interface Merchant {
  id: string
  name: string
  api_key: string
  payout_wallet: string
  webhook_url: string | null
  created_at: Date
}

export interface Payment {
  id: string
  merchant_id: string
  order_id: string
  deposit_address: string
  derivation_path: string
  amount_usdc: number        // amount merchant expects in USDC
  amount_received: number | null
  token_received: string | null  // e.g. "SOL", "USDC", "USDT"
  status: PaymentStatus
  expires_at: Date
  created_at: Date
}

export interface CreatePaymentBody {
  order_id: string
  amount_usdc: number        // how much USDC the merchant wants
  token?: string             // optional: restrict accepted token
}
