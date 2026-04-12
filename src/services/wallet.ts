import * as bip39 from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { Keypair, PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'

// Solana's coin type in BIP44 is 501
// Path structure: m/44'/501'/{merchantIndex}'/{orderIndex}'
// We use a hash of the IDs to get a numeric index

function toIndex(str: string): number {
  // Simple deterministic numeric index from a string
  // In production use a proper counter stored in DB instead
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return hash % 2147483647 // keep within BIP32 index range
}

export function deriveDepositAddress(
  mnemonic: string,
  merchantId: string,
  orderId: string
): { address: string; derivationPath: string } {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic')
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic)

  const merchantIndex = toIndex(merchantId)
  const orderIndex = toIndex(orderId)
  const derivationPath = `m/44'/501'/${merchantIndex}'/${orderIndex}'`

  const { key } = derivePath(derivationPath, seed.toString('hex'))
  const keyPair = nacl.sign.keyPair.fromSeed(key)
  const publicKey = new PublicKey(keyPair.publicKey)

  return {
    address: publicKey.toBase58(),
    derivationPath,
  }
}

// Use this when you need to sweep funds out of a deposit wallet
export function deriveKeypairFromPath(
  mnemonic: string,
  derivationPath: string
): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic)
  const { key } = derivePath(derivationPath, seed.toString('hex'))
  const keyPair = nacl.sign.keyPair.fromSeed(key)
  return Keypair.fromSecretKey(keyPair.secretKey)
}
