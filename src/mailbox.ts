import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import { deriveSharedSecret, encrypt, decrypt } from './crypto'
import type { Bee } from '@ethersphere/bee-js'
import type { Contact, Message } from './types'

const FEED_SUFFIX = 'swarm-notify'

/**
 * Compute the deterministic mailbox feed topic for a sender-recipient pair.
 * Topic: keccak256(senderOverlay + recipientOverlay + "swarm-notify")
 */
export function feedTopic(senderOverlay: string, recipientOverlay: string): string {
  const input = new TextEncoder().encode(senderOverlay.toLowerCase() + recipientOverlay.toLowerCase() + FEED_SUFFIX)
  return bytesToHex(keccak_256(input))
}

/**
 * Read existing messages from a mailbox feed. Returns empty array if feed doesn't exist.
 */
async function readFeedMessages(
  bee: Bee,
  topic: string,
  ownerAddress: string,
  sharedSecret: Uint8Array,
): Promise<Message[]> {
  try {
    const reader = bee.makeFeedReader(topic, ownerAddress)
    const result = await reader.downloadPayload()
    const encryptedBytes = result.payload.toUint8Array()

    // Split nonce (first 12 bytes) and ciphertext (rest)
    const nonce = encryptedBytes.slice(0, 12)
    const ciphertext = encryptedBytes.slice(12)

    const decryptedBytes = await decrypt({ ciphertext, nonce }, sharedSecret)
    const json = new TextDecoder().decode(decryptedBytes)
    return JSON.parse(json) as Message[]
  } catch {
    // Feed not found or decrypt failure — return empty
    return []
  }
}

/**
 * Send an encrypted message to a contact.
 *
 * Steps:
 * 1. Derive shared secret via ECDH (my private key + their public key)
 * 2. Read existing messages from my→them feed (if any)
 * 3. Append new message to array
 * 4. Encrypt full array with AES-256-GCM
 * 5. Upload encrypted blob to Swarm
 * 6. Update mailbox feed to point to new blob
 *
 * @param signer - Private key hex string or Uint8Array for feed signing
 */
export async function send(
  bee: Bee,
  signer: string | Uint8Array,
  stamp: string,
  myPrivateKey: Uint8Array,
  myOverlay: string,
  recipient: Contact,
  message: Omit<Message, 'v' | 'ts' | 'sender'>,
): Promise<void> {
  // Derive shared secret
  const recipientPubKeyBytes = hexToBytes(recipient.walletPublicKey)
  const sharedSecret = deriveSharedSecret(myPrivateKey, recipientPubKeyBytes)

  // Compute feed topic (my overlay → their overlay)
  const topic = feedTopic(myOverlay, recipient.overlay)

  // Get the writer's ETH address for reading existing messages
  const writer = bee.makeFeedWriter(topic, signer)
  const ownerAddress = writer.owner.toHex()

  // Read existing messages from this feed
  const existing = await readFeedMessages(bee, topic, ownerAddress, sharedSecret)

  // Append new message
  const fullMessage: Message = {
    v: 1,
    ...message,
    ts: Date.now(),
    sender: myOverlay,
  }
  existing.push(fullMessage)

  // Encrypt the full array
  const plaintext = new TextEncoder().encode(JSON.stringify(existing))
  const encrypted = await encrypt(plaintext, sharedSecret)

  // Pack as [nonce (12) | ciphertext]
  const blob = new Uint8Array(12 + encrypted.ciphertext.length)
  blob.set(encrypted.nonce, 0)
  blob.set(encrypted.ciphertext, 12)

  // Upload encrypted blob and update feed
  const uploadResult = await bee.uploadData(stamp, blob)
  await writer.uploadReference(stamp, uploadResult.reference)
}

/**
 * Read all messages from a specific contact's mailbox feed.
 * Reads the contact→me feed (contact is the sender/owner).
 */
export async function readMessages(
  bee: Bee,
  myPrivateKey: Uint8Array,
  myOverlay: string,
  contact: Contact,
): Promise<Message[]> {
  // Derive shared secret
  const contactPubKeyBytes = hexToBytes(contact.walletPublicKey)
  const sharedSecret = deriveSharedSecret(myPrivateKey, contactPubKeyBytes)

  // Topic: contact→me (contact is sender)
  const topic = feedTopic(contact.overlay, myOverlay)

  // The feed owner is the contact's ETH address
  return readFeedMessages(bee, topic, contact.ethAddress, sharedSecret)
}

/**
 * Check inbox across all contacts. Returns messages per contact.
 */
export async function checkInbox(
  bee: Bee,
  myPrivateKey: Uint8Array,
  myOverlay: string,
  contacts: Contact[],
): Promise<{ contact: Contact; messages: Message[] }[]> {
  const results = await Promise.allSettled(
    contacts.map(async (contact) => ({
      contact,
      messages: await readMessages(bee, myPrivateKey, myOverlay, contact),
    })),
  )

  return results
    .filter((r): r is PromiseFulfilledResult<{ contact: Contact; messages: Message[] }> =>
      r.status === 'fulfilled',
    )
    .map((r) => r.value)
    .filter((r) => r.messages.length > 0)
}

/** Convert hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
