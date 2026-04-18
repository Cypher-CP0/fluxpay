import axios from 'axios'

const HELIUS_API_KEY = process.env.HELIUS_API_KEY!
const HELIUS_WEBHOOK_ID = process.env.HELIUS_WEBHOOK_ID!
const BASE_URL = `https://api.helius.xyz/v0`

export async function registerAddressWithHelius(address: string) {
    try {
        // Step 1: get current webhook config
        const { data: webhook } = await axios.get(
            `${BASE_URL}/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`
        )

        // Step 2: merge new address into existing list
        const currentAddresses: string[] = webhook.accountAddresses ?? []
        if (currentAddresses.includes(address)) return // already watching

        const updatedAddresses = [...currentAddresses, address]

        // Step 3: PUT full config back with updated addresses
        await axios.put(
            `${BASE_URL}/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
            {
                webhookURL: webhook.webhookURL,
                transactionTypes: webhook.transactionTypes,
                accountAddresses: updatedAddresses,
                webhookType: webhook.webhookType,
            }
        )

        console.log(`✅ Registered address with Helius: ${address}`)
    } catch (err: any) {
        console.error('Failed to register address with Helius:', err?.response?.data || err.message)
    }
}

export async function unregisterAddressFromHelius(address: string) {
    try {
        const { data: webhook } = await axios.get(
            `${BASE_URL}/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`
        )

        const updatedAddresses = (webhook.accountAddresses ?? []).filter(
            (a: string) => a !== address
        )

        await axios.put(
            `${BASE_URL}/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
            {
                webhookURL: webhook.webhookURL,
                transactionTypes: webhook.transactionTypes,
                accountAddresses: updatedAddresses,
                webhookType: webhook.webhookType,
            }
        )

        console.log(`✅ Unregistered address from Helius: ${address}`)
    } catch (err: any) {
        console.error('Failed to unregister address:', err?.response?.data || err.message)
    }
}