import { Worker, Queue } from 'bullmq'
import { redis } from '../db/redis'
import { pool } from '../db'
import { swapToUSDC } from '../services/jupiter'
import { transferUSDCToMerchant } from '../services/tansfer'
import { notifyMerchant } from '../services/notify'
import { unregisterAddressFromHelius } from '../services/helius'

// SOL mint address (for swap input)
const SOL_MINT = 'So11111111111111111111111111111111111111112'

// USDC mint addresses
const USDC_MINT: Record<string, string> = {
    devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
    'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}

export interface SwapJobData {
    paymentId: string
    depositAddress: string
    derivationPath: string
    tokenReceived: string   // "SOL" | "USDC" | "USDT"
    amountReceived: number  // in lamports or token base units
}

// Export queue so webhook route can enqueue jobs
export const swapQueue = new Queue<SwapJobData>('swap', { connection: redis })

// Worker runs in background, picks up jobs from the queue
export const swapWorker = new Worker<SwapJobData>(
    'swap',
    async (job) => {
        const { paymentId, depositAddress, derivationPath, tokenReceived, amountReceived } = job.data
        // const network = (process.env.SOLANA_NETWORK as string) || 'devnet'

        console.log(`Processing swap job for payment ${paymentId}`)

        // Mark as swapping
        await pool.query(
            "UPDATE payments SET status = 'swapping' WHERE id = $1",
            [paymentId]
        )

        const result = await pool.query(
            `SELECT p.*, m.payout_wallet, m.webhook_url
            FROM payments p
            JOIN merchants m ON p.merchant_id = m.id
            WHERE p.id = $1`,
            [paymentId]
        )

        if (result.rows.length === 0) throw new Error('Payment ${paymentId} not found')
        const payment = result.rows[0]


        try {
            let swapTx: string
            let usdcAmount: number

            if (tokenReceived === 'USDC') {
                // User paid directly in USDC — no swap needed
                // TODO: just transfer to merchant payout wallet
                // For now mark as completed
                swapTx = 'no_swap_direct_usdc'
                usdcAmount = amountReceived / 1_000_000 //convert from base units
                console.log(`Payment ${paymentId} direct USDC, skipping swap`)
                // txSignature = 'direct_usdc_no_swap'
            } else {
                // Swap SOL or other token to USDC
                const inputMint = tokenReceived === 'SOL' ? SOL_MINT : tokenReceived
                swapTx = await swapToUSDC(inputMint, amountReceived, derivationPath)
                usdcAmount = Number(payment.amount_usdc)
                // txSignature = await swapToUSDC(inputMint, amountReceived, derivationPath)
            }

            // Transfer USDC from deposit wallet to merchant payout wallet
            let transferTx: string
            if (process.env.MOCK_SWAP === 'true') {
                console.log(`[MOCK] Simulating USDC transfer of ${usdcAmount} USDC to ${payment.payout_wallet}`)
                transferTx = 'mock_transfer_tx_' + Date.now()
            } else {
                transferTx = await transferUSDCToMerchant(
                    derivationPath,
                    payment.payout_wallet,
                    usdcAmount
                )
            }

            // Mark as completed
            await pool.query(
                "UPDATE payments SET status = 'completed' WHERE id = $1",
                [paymentId]
            )


            // Stop watching this address
            await unregisterAddressFromHelius(depositAddress)

            // Notify merchant if they have a webhook configured
            if (payment.webhook_url) {
                await notifyMerchant(payment.webhook_url, {
                    event: 'payment.completed',
                    payment_id: payment.id,
                    order_id: payment.order_id,
                    amount_usdc: usdcAmount,
                    token_received: tokenReceived,
                    amount_received: amountReceived,
                    swap_tx: swapTx,
                    transfer_tx: transferTx,
                    timestamp: new Date().toISOString(),
                })
            }


            console.log(`✅ Payment ${paymentId} fully completed.`)
            return { swapTx, transferTx }

        } catch (err: any) {
            console.error(`Payment ${paymentId} failed:`, err.message)

            // Mark as failed
            await pool.query(
                "UPDATE payments SET status = 'failed' WHERE id = $1",
                [paymentId]
            )

            throw err // BullMQ will retry based on job options
        }
    },
    {
        connection: redis,
        concurrency: 5, // process up to 5 swaps simultaneously
    }
)

swapWorker.on('completed', (job) => {
    console.log(`Swap job ${job.id} completed`)
})

swapWorker.on('failed', (job, err) => {
    console.error(`Swap job ${job?.id} failed:`, err.message)
})
