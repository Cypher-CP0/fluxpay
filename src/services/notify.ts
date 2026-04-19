import axios from 'axios'

export interface PaymentCompletedPayload {
    event: 'payment.completed'
    payment_id: string
    order_id: string
    amount_usdc: number
    token_received: string
    amount_received: number
    swap_tx: string
    transfer_tx: string
    timestamp: string
}

export async function notifyMerchant(
    webhookUrl: string,
    payload: PaymentCompletedPayload
): Promise<void> {
    try {
        await axios.post(webhookUrl, payload, {
            timeout: 10000, // 10 second timeout
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'FluxPay/1.0',
            },
        })
        console.log(`✅ Merchant notified: ${webhookUrl}`)
    } catch (err: any) {
        // Don't throw, merchant webhook failure should not fail the payment
        // Payment is already complete on-chain at this point
        console.error(
            `Failed to notify merchant at ${webhookUrl}:`,
            err?.response?.status ?? err.message
        )
    }
}