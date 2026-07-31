import { Queue } from 'bullmq'
import { redis } from '../db/redis'

/**
 * Queue definitions, deliberately separate from the Worker instances that
 * consume them.
 *
 * Importing a worker module instantiates a Worker as a side effect, which
 * immediately starts pulling jobs. That's correct for the server process and
 * wrong for anything else — a CLI that imported it would begin processing
 * jobs and then exit partway through one. Producers (routes, scripts, the
 * reconciler) import queues from here; only the server imports the workers.
 */

export interface SwapJobData {
  paymentId: string
  depositAddress: string
  derivationPath: string | null // null for escrow (USDC/USDT) payments
  tokenReceived: string
  amountReceived: number
}

export const swapQueue = new Queue<SwapJobData>('swap', { connection: redis })

export const reconcileQueue = new Queue('reconcile', { connection: redis })