import { describe, it, expect } from 'vitest'
import * as secp from '@noble/secp256k1'
import { deriveSharedSecret, encrypt, decrypt, eciesEncrypt, eciesDecrypt } from '../src/crypto'

describe('deriveSharedSecret', () => {
  it('Alice and Bob derive the same shared secret', () => {
    const alicePrivKey = secp.utils.randomPrivateKey()
    const bobPrivKey = secp.utils.randomPrivateKey()
    const alicePubKey = secp.getPublicKey(alicePrivKey, true)
    const bobPubKey = secp.getPublicKey(bobPrivKey, true)

    const aliceSecret = deriveSharedSecret(alicePrivKey, bobPubKey)
    const bobSecret = deriveSharedSecret(bobPrivKey, alicePubKey)

    expect(aliceSecret).toEqual(bobSecret)
    expect(aliceSecret.length).toBe(32)
  })

  it('different key pairs produce different secrets', () => {
    const key1 = secp.utils.randomPrivateKey()
    const key2 = secp.utils.randomPrivateKey()
    const key3 = secp.utils.randomPrivateKey()

    const secret12 = deriveSharedSecret(key1, secp.getPublicKey(key2, true))
    const secret13 = deriveSharedSecret(key1, secp.getPublicKey(key3, true))

    expect(secret12).not.toEqual(secret13)
  })
})

describe('encrypt / decrypt', () => {
  it('round-trip: plaintext matches after decrypt', async () => {
    const plaintext = new TextEncoder().encode('Hello, Swarm!')
    const secret = deriveSharedSecret(
      secp.utils.randomPrivateKey(),
      secp.getPublicKey(secp.utils.randomPrivateKey(), true),
    )

    const encrypted = await encrypt(plaintext, secret)
    const decrypted = await decrypt(encrypted, secret)

    expect(decrypted).toEqual(plaintext)
  })

  it('decrypt with wrong key throws', async () => {
    const plaintext = new TextEncoder().encode('secret message')
    const correctSecret = deriveSharedSecret(
      secp.utils.randomPrivateKey(),
      secp.getPublicKey(secp.utils.randomPrivateKey(), true),
    )
    const wrongSecret = deriveSharedSecret(
      secp.utils.randomPrivateKey(),
      secp.getPublicKey(secp.utils.randomPrivateKey(), true),
    )

    const encrypted = await encrypt(plaintext, correctSecret)

    await expect(decrypt(encrypted, wrongSecret)).rejects.toThrow()
  })

  it('decrypt tampered ciphertext throws (GCM authentication)', async () => {
    const plaintext = new TextEncoder().encode('tamper test')
    const secret = deriveSharedSecret(
      secp.utils.randomPrivateKey(),
      secp.getPublicKey(secp.utils.randomPrivateKey(), true),
    )

    const encrypted = await encrypt(plaintext, secret)
    // Flip a byte in the ciphertext
    encrypted.ciphertext[0] ^= 0xff

    await expect(decrypt(encrypted, secret)).rejects.toThrow()
  })

  it('different nonces produce different ciphertexts for same plaintext', async () => {
    const plaintext = new TextEncoder().encode('same message')
    const secret = deriveSharedSecret(
      secp.utils.randomPrivateKey(),
      secp.getPublicKey(secp.utils.randomPrivateKey(), true),
    )

    const enc1 = await encrypt(plaintext, secret)
    const enc2 = await encrypt(plaintext, secret)

    expect(enc1.nonce).not.toEqual(enc2.nonce)
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext)
  })

  it('large payload (>4KB)', async () => {
    const plaintext = new Uint8Array(8192)
    crypto.getRandomValues(plaintext)
    const secret = deriveSharedSecret(
      secp.utils.randomPrivateKey(),
      secp.getPublicKey(secp.utils.randomPrivateKey(), true),
    )

    const encrypted = await encrypt(plaintext, secret)
    const decrypted = await decrypt(encrypted, secret)

    expect(decrypted).toEqual(plaintext)
  })
})

describe('eciesEncrypt / eciesDecrypt', () => {
  it('round-trip: encrypt and decrypt', async () => {
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)

    const data = new TextEncoder().encode('ECIES test payload')
    const blob = await eciesEncrypt(data, recipientPubKey)
    const decrypted = await eciesDecrypt(blob, recipientPrivKey)

    expect(decrypted).toEqual(data)
  })

  it('decrypt with wrong private key throws', async () => {
    const recipientPubKey = secp.getPublicKey(secp.utils.randomPrivateKey(), true)
    const wrongPrivKey = secp.utils.randomPrivateKey()

    const data = new TextEncoder().encode('wrong key test')
    const blob = await eciesEncrypt(data, recipientPubKey)

    await expect(eciesDecrypt(blob, wrongPrivKey)).rejects.toThrow()
  })

  it('blob too short throws', async () => {
    const shortBlob = new Uint8Array(10)
    await expect(eciesDecrypt(shortBlob, secp.utils.randomPrivateKey())).rejects.toThrow(
      'ECIES blob too short',
    )
  })

  it('large payload ECIES round-trip', async () => {
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)

    const data = new Uint8Array(8192)
    crypto.getRandomValues(data)

    const blob = await eciesEncrypt(data, recipientPubKey)
    const decrypted = await eciesDecrypt(blob, recipientPrivKey)

    expect(decrypted).toEqual(data)
  })
})
