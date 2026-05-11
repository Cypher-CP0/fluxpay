import {
    Connection,
    PublicKey,
    clusterApiUrl,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
    getOrCreateAssociatedTokenAccount,
    createTransferInstruction,
    getMint,
} from '@solana/spl-token'
import { deriveKeypairFromPath } from './wallet'

const USDC_MINT: Record<string, string> = {
    devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
    'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}

const network = (process.env.SOLANA_NETWORK as 'devnet' | 'mainnet-beta') || 'devnet'
const connection = new Connection(clusterApiUrl(network), 'confirmed')

export async function transferUSDCToMerchant(
    derivationPath: string,
    merchantPayoutWallet: string,
    amountUsdc: number
): Promise<string> {
    const mnemonic = process.env.MASTER_MNEMONIC!
    const usdcMint = new PublicKey(USDC_MINT[network])

    const depositKeypair = deriveKeypairFromPath(mnemonic, derivationPath)
    const merchantPublicKey = new PublicKey(merchantPayoutWallet)

    console.log(`Transferring ${amountUsdc} USDC`)
    console.log(`From deposit wallet: ${depositKeypair.publicKey.toBase58()}`)
    console.log(`To merchant wallet: ${merchantPayoutWallet}`)
    console.log(`Using mint: ${USDC_MINT[network]}`)
    console.log(`Network: ${network}`)

    try {
        const mintInfo = await getMint(connection, usdcMint)
        const amountInSmallestUnit = Math.floor(amountUsdc * Math.pow(10, mintInfo.decimals))
        console.log(`Amount in smallest unit: ${amountInSmallestUnit}`)

        const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            depositKeypair,
            usdcMint,
            depositKeypair.publicKey
        )

        const toTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            depositKeypair,
            usdcMint,
            merchantPublicKey
        )

        console.log(`From ATA: ${fromTokenAccount.address.toBase58()}`)
        console.log(`To ATA: ${toTokenAccount.address.toBase58()}`)
        console.log(`From ATA balance: ${fromTokenAccount.amount}`)

        const transferInstruction = createTransferInstruction(
            fromTokenAccount.address,
            toTokenAccount.address,
            depositKeypair.publicKey,
            amountInSmallestUnit
        )

        const transaction = new Transaction().add(transferInstruction)

        const txSignature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [depositKeypair],
            { commitment: 'confirmed' }
        )

        console.log(`✅ USDC transfer confirmed: ${txSignature}`)
        console.log(`   ${amountUsdc} USDC → ${merchantPayoutWallet}`)

        return txSignature

    } catch (err: any) {
        console.error('transferUSDCToMerchant error:', err?.message)
        console.error('transferUSDCToMerchant logs:', err?.logs)
        console.error('Full transfer error:', JSON.stringify(err, null, 2))
        throw err
    }
}