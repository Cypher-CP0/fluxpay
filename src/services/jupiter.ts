import axios from 'axios'
import {
    Connection,
    VersionedTransaction,
    clusterApiUrl,
} from '@solana/web3.js'
import { deriveKeypairFromPath } from './wallet'

// USDC mint address on devnet and mainnet
const USDC_MINT: Record<string, string> = {
    devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', // devnet USDC (fake)
    'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // real USDC
}

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6'

const network = (process.env.SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet'
const connection = new Connection(clusterApiUrl(network), 'confirmed')

export async function swapToUSDC(
    inputMint: string,   // token the user sent
    amountLamports: number, // amount in smallest unit
    derivationPath: string  // to re-derive the deposit wallet keypair
): Promise<string> {
    // Mock swap for Devnet testing - Jupiter has no liquidity on Devnet
    if (process.env.MOCK_SWAP === 'true') {
        console.log(`[MOCK] Simulating Jupiter swap: ${amountLamports} lamports → USDC`)
        await new Promise(res => setTimeout(res, 1000))
        return 'mock_swap_tx_' + Date.now()
    }
    const usdcMint = USDC_MINT[network]
    const mnemonic = process.env.MASTER_MNEMONIC!

    // Re-derive the keypair for the deposit wallet (this wallet holds the received funds)
    const keypair = deriveKeypairFromPath(mnemonic, derivationPath)

    // Step 1: Get quote from Jupiter
    const quoteResponse = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
        params: {
            inputMint,
            outputMint: usdcMint,
            amount: amountLamports,
            slippageBps: 50, // 0.5% slippage tolerance
        },
    })

    const quote = quoteResponse.data
    console.log(`Jupiter quote received, output: ${quote.outAmount} USDC`)

    // Step 2: Get swap transaction from Jupiter
    const swapResponse = await axios.post(`${JUPITER_QUOTE_API}/swap`, {
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true, // handles SOL <-> wSOL automatically
    })

    const { swapTransaction } = swapResponse.data

    // Step 3: Deserialize, sign, and send the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64')
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf)
    transaction.sign([keypair])

    const txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
    })

    // Step 4: Wait for confirmation
    const latestBlockhash = await connection.getLatestBlockhash()
    await connection.confirmTransaction(
        { signature: txid, ...latestBlockhash },
        'confirmed'
    )

    console.log(`✅ Swap confirmed: ${txid}`)
    return txid
}
