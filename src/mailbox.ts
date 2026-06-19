import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import { deriveSharedSecret, encrypt, decrypt } from './crypto'
import type { Bee } from '@ethersphere/bee-js'
import type { Contact, Message } from './types'

// Bumped to v2 with the append-only format. The v1 ('swarm-notify') feeds held
// the whole conversation as one mutable slot; v2 writes one message per index.
// Versioning the topic abandons v1 feeds entirely so the new format always
// starts on a virgin feed at index 0 — a clean break with no migration and no
// chance of a v1 array blob colliding with a v2 index. Both parties upgrade
// together (the single-object payload is unreadable by the v1 reader anyway).
const FEED_SUFFIX = 'swarm-notify/v2'

/**
 * Append-only mailbox.
 *
 * Each message is written to its OWN immutable feed index instead of rewriting
 * a single slot that holds the whole conversation. The decisive property is
 * that the write index comes from a SENDER-CONTROLLED counter, never from a
 * network read-latest — otherwise the overwrite race just relocates from the
 * array layer to the index layer (a rapid second send reads a not-yet-retrievable
 * head, gets the same index, and overwrites the first message).
 *
 * Index resolution priority (see `resolveNextIndex`):
 *   1. `nextIndex` passed by the host  — authoritative, O(1), zero network read
 *   2. in-session cache (`+1` from the last write this session)
 *   3. cold start: discover the tail from the feed (first-ever send / lost cursor)
 *
 * Durable cursors are HOST-owned. The session cache below is a within-session
 * optimization ONLY and is never persisted — persisting it would create a
 * second source of truth that desyncs from the host's cursor.
 */

/** topic -> next index to write this session. NOT persisted (host owns durable cursors). */
const sessionNextIndex = new Map<string, number>()

/**
 * Compute the deterministic mailbox feed topic for a sender-recipient pair.
 * Topic: keccak256(senderEthAddress + recipientEthAddress + "swarm-notify")
 *
 * Uses ETH addresses (not overlays) so feed topics are stable across devices.
 * Same wallet on different Bee nodes = same feed topics = same inbox.
 */
export function feedTopic(senderEthAddress: string, recipientEthAddress: string): string {
  const input = new TextEncoder().encode(senderEthAddress.toLowerCase() + recipientEthAddress.toLowerCase() + FEED_SUFFIX)
  return bytesToHex(keccak_256(input))
}

/**
 * Resolve the index to write the next message to, race-free.
 *
 * Prefers caller-supplied / session-cached state (no network read). Only falls
 * back to discovering the feed tail when neither is available (cold start).
 */
async function resolveNextIndex(
  bee: Bee,
  topic: string,
  ownerAddress: string,
  nextIndex?: number,
): Promise<number> {
  if (typeof nextIndex === 'number') return nextIndex

  const cached = sessionNextIndex.get(topic)
  if (cached !== undefined) return cached

  // Cold start — discover the tail from the latest feed update.
  try {
    const reader = bee.makeFeedReader(topic, ownerAddress)
    const latest = await reader.downloadPayload()
    if (latest.feedIndexNext) return Number(latest.feedIndexNext.toBigInt())

    return Number(latest.feedIndex.toBigInt()) + 1
  } catch {
    // Feed doesn't exist yet — start at 0.
    return 0
  }
}

/**
 * Send an encrypted message to a contact.
 *
 * Writes ONE encrypted chunk at a sender-controlled index (no read-modify-write,
 * so nothing can overwrite). Returns the index written so the host can advance
 * its durable cursor to `index + 1`.
 *
 * @param signer    - Private key hex string or Uint8Array for feed signing
 * @param nextIndex - Optional explicit index to write at. When the host passes
 *                    its durable cursor here, sends are O(1) and race-free by
 *                    construction. Omit it and the library uses a session cache
 *                    (then cold-start discovery) — convenient for naive callers.
 * @returns the feed index the message was written to
 */
export async function send(
  bee: Bee,
  signer: string | Uint8Array,
  stamp: string,
  myPrivateKey: Uint8Array,
  myEthAddress: string,
  recipient: Contact,
  message: Omit<Message, 'v' | 'ts' | 'sender'>,
  nextIndex?: number,
): Promise<number> {
  // Derive shared secret
  const recipientPubKeyBytes = hexToBytes(recipient.walletPublicKey)
  const sharedSecret = deriveSharedSecret(myPrivateKey, recipientPubKeyBytes)

  // Compute feed topic (my ethAddress → their ethAddress)
  const topic = feedTopic(myEthAddress, recipient.ethAddress)

  // The writer's own ETH address — also the owner we read tail from on cold start.
  const writer = bee.makeFeedWriter(topic, signer)
  const ownerAddress = writer.owner.toHex()

  const index = await resolveNextIndex(bee, topic, ownerAddress, nextIndex)

  // Build the single message
  const fullMessage: Message = {
    v: 1,
    ...message,
    ts: Date.now(),
    sender: myEthAddress,
  }

  // Encrypt JUST this one message (not the whole history)
  const plaintext = new TextEncoder().encode(JSON.stringify(fullMessage))
  const encrypted = await encrypt(plaintext, sharedSecret)

  // Pack as [nonce (12) | ciphertext]
  const blob = new Uint8Array(12 + encrypted.ciphertext.length)
  blob.set(encrypted.nonce, 0)
  blob.set(encrypted.ciphertext, 12)

  // Upload the blob, then point THIS feed index at it.
  const uploadResult = await bee.uploadData(stamp, blob)
  await writer.uploadReference(stamp, uploadResult.reference, { index })

  // Advance the session cache so a follow-up send this session is race-free
  // even when the host doesn't pass a cursor.
  sessionNextIndex.set(topic, index + 1)

  return index
}

/**
 * Decrypt a single message stored at one feed index.
 * Returns null when the index is absent OR doesn't hold a single Message object
 * (e.g. a legacy single-slot blob, which was an array — clean-break: ignored).
 *
 * IMPORTANT: each feed update stores a *reference* to the encrypted blob (the
 * send path uses `uploadReference`), not the blob inline. bee-js's
 * `downloadPayload({ index })` returns the raw single-owner-chunk payload — i.e.
 * the reference bytes — WITHOUT resolving it (only the no-index "latest" read
 * goes through the `/feeds` endpoint that resolves server-side). So we must
 * follow the reference ourselves: read the reference at this index, then
 * download the blob it points to.
 */
async function readMessageAt(
  bee: Bee,
  reader: ReturnType<Bee['makeFeedReader']>,
  index: number,
  sharedSecret: Uint8Array,
): Promise<Message | null> {
  try {
    const { reference } = await reader.downloadReference({ index })
    const downloaded = await bee.downloadData(reference)
    // Real Bee returns a `Bytes` (toUint8Array); the test mock returns `{ data }`.
    const encryptedBytes =
      typeof (downloaded as { toUint8Array?: () => Uint8Array }).toUint8Array === 'function'
        ? (downloaded as { toUint8Array: () => Uint8Array }).toUint8Array()
        : (downloaded as unknown as { data: Uint8Array }).data

    const nonce = encryptedBytes.slice(0, 12)
    const ciphertext = encryptedBytes.slice(12)

    const decryptedBytes = await decrypt({ ciphertext, nonce }, sharedSecret)
    const parsed = JSON.parse(new TextDecoder().decode(decryptedBytes)) as unknown

    // New format = one Message object per index. A legacy array (old single-slot
    // format) is intentionally ignored → yields [] for that thread (clean break).
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    return parsed as Message
  } catch {
    // Index not yet retrievable, missing, or decrypt failure.
    return null
  }
}

/**
 * Read messages from a contact's mailbox feed (the contact→me feed) starting at
 * `fromIndex`, in index order.
 *
 * Stops at the FIRST gap (an index that can't be read). Because the sender
 * writes indices contiguously and pins each chunk, a gap is a transient
 * not-yet-propagated chunk, not a permanent hole — so stopping preserves strict
 * ordering and the missing messages are picked up on a later poll, once the
 * lagging chunk propagates. (Skipping a gap would deliver later messages out of
 * order, which is worse for a chat.)
 *
 * @param fromIndex - First index to read (host passes its read cursor here for
 *                    O(1) incremental reads). Defaults to 0 = full history.
 */
export async function readMessages(
  bee: Bee,
  myPrivateKey: Uint8Array,
  myEthAddress: string,
  contact: Contact,
  fromIndex = 0,
): Promise<Message[]> {
  // Derive shared secret
  const contactPubKeyBytes = hexToBytes(contact.walletPublicKey)
  const sharedSecret = deriveSharedSecret(myPrivateKey, contactPubKeyBytes)

  // Topic: contact→me (contact is the sender/owner)
  const topic = feedTopic(contact.ethAddress, myEthAddress)
  const reader = bee.makeFeedReader(topic, contact.ethAddress)

  const messages: Message[] = []

  for (let index = fromIndex; ; index++) {
    const msg = await readMessageAt(bee, reader, index, sharedSecret)
    if (!msg) break
    messages.push(msg)
  }

  return messages
}

/**
 * Check inbox across all contacts. Returns messages per contact.
 *
 * v1 reads each contact from index 0 — incremental (per-contact cursor) reads
 * are a host-cursor concern; `checkInbox` holds no per-contact state, so the
 * host should call `readMessages(..., fromIndex)` directly when it wants O(1)
 * incremental polling.
 */
export async function checkInbox(
  bee: Bee,
  myPrivateKey: Uint8Array,
  myEthAddress: string,
  contacts: Contact[],
): Promise<{ contact: Contact; messages: Message[] }[]> {
  const results = await Promise.allSettled(
    contacts.map(async (contact) => ({
      contact,
      messages: await readMessages(bee, myPrivateKey, myEthAddress, contact),
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
