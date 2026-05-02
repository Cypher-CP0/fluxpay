import axios from 'axios'

let cachedPrice: number | null = null
let lastFetched: number = 0
const CACHE_TTL = 30_000 // 30 seconds

export async function getSolPrice(): Promise<number> {
    const now = Date.now()

    if (cachedPrice && now - lastFetched < CACHE_TTL) {
        return cachedPrice
    }

    try {
        // Jupiter price API — most accurate for Solana swaps
        const res = await axios.get(
            'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112'
        )
        const price = res.data?.data?.['So11111111111111111111111111111111111111112']?.price
        if (price) {
            cachedPrice = Number(price)
            lastFetched = now
            return cachedPrice
        }
    } catch (err) {
        console.error('Jupiter price fetch failed, trying CoinGecko fallback')
    }

    try {
        // CoinGecko fallback
        const res = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
        )
        const price = res.data?.solana?.usd
        if (price) {
            cachedPrice = Number(price)
            lastFetched = now
            return cachedPrice
        }
    } catch (err) {
        console.error('CoinGecko price fetch also failed')
    }

    // Last resort — return cached price or fallback
    return cachedPrice ?? 165
}