import axios from 'axios'
import {
  Connection,
  VersionedTransaction,
  clusterApiUrl,
} from '@solana/web3.js'
import { deriveKeypairFromPath } from './wallet'

const USDC_MINT: Record<string, string> = {
  devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}

const JUPITER_API_KEY = process.env.JUPITER_API_KEY!
const JUPITER_BASE = 'https://api.jup.ag/swap/v2'

const network = (process.env.SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet'
const connection = new Connection(clusterApiUrl(network), 'confirmed')

export async function swapToUSDC(
  inputMint: string,
  amountLamports: number,
  derivationPath: string
): Promise<string> {
  if (process.env.MOCK_SWAP === 'true') {
    console.log(`[MOCK] Simulating Jupiter swap: ${amountLamports} lamports → USDC`)
    await new Promise(res => setTimeout(res, 1000))
    return 'mock_swap_tx_' + Date.now()
  }

  const usdcMint = USDC_MINT[network]
  const mnemonic = process.env.MASTER_MNEMONIC!
  const keypair = deriveKeypairFromPath(mnemonic, derivationPath)

  // Step 1: Get order (quote + assembled transaction)
  const params = new URLSearchParams({
    inputMint,
    outputMint: usdcMint,
    amount: String(amountLamports),
    slippageBps: '50',
    taker: keypair.publicKey.toBase58(),
  })

  const orderResponse = await axios.get(`${JUPITER_BASE}/order?${params}`, {
    headers: { 'x-api-key': JUPITER_API_KEY },
  })

  const order = orderResponse.data

  if (!order.transaction) {
    throw new Error(`Jupiter order returned no transaction: ${JSON.stringify(order)}`)
  }

  console.log(`Jupiter order received — router: ${order.router}, outAmount: ${order.outAmount}`)

  // Step 2: Partially sign — JupiterZ RFQ requires MM signature added during /execute
  const swapTransactionBuf = Buffer.from(order.transaction, 'base64')
  const versionedTx = VersionedTransaction.deserialize(swapTransactionBuf)
  versionedTx.sign([keypair])

  // Step 3: Execute via Jupiter's managed landing pipeline
  const executeResponse = await axios.post(
    `${JUPITER_BASE}/execute`,
    {
      signedTransaction: Buffer.from(versionedTx.serialize()).toString('base64'),
      requestId: order.requestId,
    },
    {
      headers: {
        'x-api-key': JUPITER_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  )

  const result = executeResponse.data

  if (result.status !== 'Success') {
    throw new Error(`Jupiter swap failed — status: ${result.status}, code: ${result.code}, error: ${result.error}`)
  }

  console.log(`✅ Jupiter swap confirmed: ${result.signature}`)
  console.log(`   Input: ${result.inputAmountResult} | Output: ${result.outputAmountResult} USDC`)

  return result.signature
}