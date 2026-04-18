import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import { initDB } from './db'
import { paymentRoutes } from './routes/payments'
import { merchantRoutes } from './routes/merchants'
import { webhookRoutes } from './routes/webhooks'
import { swapWorker } from './services/swapWorker'

dotenv.config()

const app = Fastify({ logger: true })

async function main() {
  await app.register(cors, { origin: '*' })

  await app.register(paymentRoutes, { prefix: '/api' })
  await app.register(merchantRoutes, { prefix: '/api' })
  await app.register(webhookRoutes)

  app.get('/health', async () => ({ status: 'ok', network: process.env.SOLANA_NETWORK }))

  await initDB()

  // Start the swap worker
  console.log('✅ Swap worker started')
  // swapWorker is imported and starts automatically on import

  const port = Number(process.env.PORT) || 3000
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`🚀 FluxPay running on port ${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
