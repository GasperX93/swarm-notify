import * as secp from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import type { EncryptedData } from './types'

/** Convert Uint8Array to ArrayBuffer for Web Crypto API (TS 5.8 compatibility) */
function toBuffer(arr: Uint8Array): ArrayBuffer {
  // `SharedArrayBuffer` is undefined in browsers without cross-origin isolation
  // (Brave by default, and any non-COOP/COEP page). Guard with `typeof` so the
  // `instanceof` check doesn't throw ReferenceError when the global is missing.
  const isShared =
    typeof SharedArrayBuffer !== 'undefined' && arr.buffer instanceof SharedArrayBuffer
  return isShared
    ? arr.slice().buffer
    : (arr.buffer as ArrayBuffer).slice(arr.byteOffset, arr.byteOffset + arr.byteLength)
}

/**
 * Derive a shared secret from my private key and their public key using ECDH.
 * Both parties independently derive the same 32-byte secret.
 */
export function deriveSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
): Uint8Array {
  const sharedPoint = secp.getSharedSecret(myPrivateKey, theirPublicKey, false)
  // Hash the shared point (skip the 0x04 prefix byte) to get a uniform 32-byte key
  return keccak_256(sharedPoint.slice(1))
}

/**
 * Encrypt plaintext with a shared secret using AES-256-GCM.
 * Returns ciphertext + 12-byte random nonce.
 */
export async function encrypt(
  plaintext: Uint8Array,
  sharedSecret: Uint8Array,
): Promise<EncryptedData> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey('raw', toBuffer(sharedSecret), 'AES-GCM', false, [
    'encrypt',
  ])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(nonce) }, key, toBuffer(plaintext)),
  )
  return { ciphertext, nonce }
}

/**
 * Decrypt ciphertext with a shared secret using AES-256-GCM.
 * Throws if tampered or wrong key.
 */
export async function decrypt(
  encrypted: EncryptedData,
  sharedSecret: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', toBuffer(sharedSecret), 'AES-GCM', false, [
    'decrypt',
  ])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(encrypted.nonce) },
    key,
    toBuffer(encrypted.ciphertext),
  )
  return new Uint8Array(plaintext)
}

/**
 * ECIES encrypt: encrypt data so only the holder of the recipient's private key can decrypt.
 * Used for notification registry payloads.
 *
 * Format: [ephemeralPublicKey (33 bytes compressed) | nonce (12 bytes) | ciphertext]
 */
export async function eciesEncrypt(
  data: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  // Generate ephemeral key pair
  const ephemeralPrivKey = secp.utils.randomPrivateKey()
  const ephemeralPubKey = secp.getPublicKey(ephemeralPrivKey, true) // 33 bytes compressed

  // Derive shared secret between ephemeral private key and recipient's public key
  const sharedSecret = deriveSharedSecret(ephemeralPrivKey, recipientPublicKey)

  // Encrypt with shared secret
  const { ciphertext, nonce } = await encrypt(data, sharedSecret)

  // Pack: [ephemeralPubKey (33) | nonce (12) | ciphertext (variable)]
  const result = new Uint8Array(33 + 12 + ciphertext.length)
  result.set(ephemeralPubKey, 0)
  result.set(nonce, 33)
  result.set(ciphertext, 45)
  return result
}

/**
 * ECIES decrypt: decrypt a blob encrypted with eciesEncrypt.
 * Throws if wrong key or tampered.
 */
export async function eciesDecrypt(
  blob: Uint8Array,
  myPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < 45) {
    throw new Error('ECIES blob too short')
  }

  // Unpack
  const ephemeralPubKey = blob.slice(0, 33)
  const nonce = blob.slice(33, 45)
  const ciphertext = blob.slice(45)

  // Derive shared secret between my private key and the ephemeral public key
  const sharedSecret = deriveSharedSecret(myPrivateKey, ephemeralPubKey)

  // Decrypt
  return decrypt({ ciphertext, nonce }, sharedSecret)
}
