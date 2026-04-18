import IORedis from 'ioredis'

export const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // required for BullMQ
})

redis.on('connect', () => console.log('✅ Redis connected'))
redis.on('error', (err) => console.error('Redis error:', err))
