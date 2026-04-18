import { Worker, Queue } from 'bullmq'
import { redis } from '../db/redis'
import { pool } from '../db'
import { swapToUSDC } from '../services/jupiter'
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
        const network = (process.env.SOLANA_NETWORK as string) || 'devnet'

        console.log(`Processing swap job for payment ${paymentId}`)

        // Mark as swapping
        await pool.query(
            "UPDATE payments SET status = 'swapping' WHERE id = $1",
            [paymentId]
        )

        try {
            let txSignature: string

            if (tokenReceived === 'USDC') {
                // User paid directly in USDC — no swap needed
                // TODO: just transfer to merchant payout wallet
                // For now mark as completed
                console.log(`Payment ${paymentId} received in USDC directly, no swap needed`)
                txSignature = 'direct_usdc_no_swap'
            } else {
                // Swap SOL or other token to USDC
                const inputMint = tokenReceived === 'SOL' ? SOL_MINT : tokenReceived
                txSignature = await swapToUSDC(inputMint, amountReceived, derivationPath)
            }

            // Mark as completed
            await pool.query(
                "UPDATE payments SET status = 'completed' WHERE id = $1",
                [paymentId]
            )

            // Stop watching this address
            await unregisterAddressFromHelius(depositAddress)

            console.log(`✅ Payment ${paymentId} completed. Swap tx: ${txSignature}`)
            return { txSignature }

        } catch (err: any) {
            console.error(`Swap failed for payment ${paymentId}:`, err.message)

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
