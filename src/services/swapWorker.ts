import { Worker, Queue } from 'bullmq'
import { redis } from '../db/redis'
import { pool } from '../db'
import { swapToUSDC } from './jupiter'
import { transferUSDCToMerchant } from './tansfer'
import { notifyMerchant } from './notify'
import { unregisterAddressFromHelius } from './helius'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

const USDC_MINT: Record<string, string> = {
    devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}

export interface SwapJobData {
    paymentId: string
    depositAddress: string
    derivationPath: string
    tokenReceived: string
    amountReceived: number
}

export const swapQueue = new Queue<SwapJobData>('swap', { connection: redis })

export const swapWorker = new Worker<SwapJobData>(
    'swap',
    async (job) => {
        const { paymentId, depositAddress, derivationPath, tokenReceived, amountReceived } = job.data

        console.log(`Processing swap job for payment ${paymentId}`)

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

        if (result.rows.length === 0) throw new Error(`Payment ${paymentId} not found`)
        const payment = result.rows[0]

        try {
            let swapTx: string = ''
            let transferTx: string = ''
            let usdcAmount: number = 0

            if (tokenReceived === 'USDC' || tokenReceived === 'USDT') {
                // Direct stablecoin payment — no swap needed
                usdcAmount = amountReceived / 1_000_000

                if (process.env.MOCK_SWAP === 'true') {
                    console.log(`[MOCK] Direct ${tokenReceived} payment, skipping swap`)
                    swapTx = `direct_${tokenReceived.toLowerCase()}_no_swap`
                    transferTx = 'mock_transfer_tx_' + Date.now()
                } else {
                    swapTx = `direct_${tokenReceived.toLowerCase()}_no_swap`
                    transferTx = await transferUSDCToMerchant(
                        derivationPath,
                        payment.payout_wallet,
                        usdcAmount
                    )
                }

            } else {
                // SOL or other token — swap to USDC first
                const inputMint = tokenReceived === 'SOL' ? SOL_MINT : tokenReceived
                usdcAmount = Number(payment.amount_usdc)

                if (process.env.MOCK_SWAP === 'true') {
                    console.log(`[MOCK] Simulating Jupiter swap: ${amountReceived} lamports → USDC`)
                    swapTx = 'mock_swap_tx_' + Date.now()
                    console.log(`[MOCK] Simulating USDC transfer of ${usdcAmount} USDC to ${payment.payout_wallet}`)
                    transferTx = 'mock_transfer_tx_' + Date.now()
                } else {
                    swapTx = await swapToUSDC(inputMint, amountReceived, derivationPath)
                    transferTx = await transferUSDCToMerchant(
                        derivationPath,
                        payment.payout_wallet,
                        usdcAmount
                    )
                }
            }

            await pool.query(
                "UPDATE payments SET status = 'completed' WHERE id = $1",
                [paymentId]
            )

            await unregisterAddressFromHelius(depositAddress)

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

            await pool.query(
                "UPDATE payments SET status = 'failed' WHERE id = $1",
                [paymentId]
            )

            throw err
        }
    },
    {
        connection: redis,
        concurrency: 5,
    }
)

swapWorker.on('completed', (job) => {
    console.log(`Swap job ${job.id} completed`)
})

swapWorker.on('failed', (job, err) => {
    console.error(`Swap job ${job?.id} failed:`, err.message)
})