import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import { initDB } from './db'
import { paymentRoutes } from './routes/payments'
import { merchantRoutes } from './routes/merchants'
import { webhookRoutes } from './routes/webhooks'

dotenv.config()

const app = Fastify({ logger: true })

async function main() {
  // Plugins
  await app.register(cors, { origin: '*' })

  // Routes
  await app.register(paymentRoutes, { prefix: '/api' })
  await app.register(merchantRoutes, { prefix: '/api' })
  await app.register(webhookRoutes)

  // Health check
  app.get('/health', async () => ({ status: 'ok', network: process.env.SOLANA_NETWORK }))

  // Init DB schema
  await initDB()

  const port = Number(process.env.PORT) || 3000
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`🚀 FluxPay running on port ${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
