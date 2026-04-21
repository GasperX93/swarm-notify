import { keccak_256 } from '@noble/hashes/sha3'
import { eciesEncrypt, eciesDecrypt } from './crypto'
import type { NotifyProvider, NotificationPayload } from './types'

// ─── Internal helpers ────────────────────────────────────────────

/** Convert hex string (with or without 0x prefix) to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Convert Uint8Array to 0x-prefixed hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** Pad a Uint8Array to the right with zeros to reach a multiple of 32 bytes. */
function padRight32(data: Uint8Array): Uint8Array {
  const remainder = data.length % 32
  if (remainder === 0) return data
  const padded = new Uint8Array(data.length + (32 - remainder))
  padded.set(data)
  return padded
}

/** Encode a uint256 value (number) as a 32-byte big-endian Uint8Array. */
function encodeUint256(value: number): Uint8Array {
  const buf = new Uint8Array(32)
  // Write value as big-endian in the last 8 bytes (safe for numbers up to 2^53)
  let v = value
  for (let i = 31; i >= 24 && v > 0; i--) {
    buf[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  return buf
}

// ─── ABI encoding / decoding ────────────────────────────────────

/**
 * Function selector for notify(bytes32,bytes).
 * First 4 bytes of keccak256("notify(bytes32,bytes)").
 */
const NOTIFY_SELECTOR = keccak_256(new TextEncoder().encode('notify(bytes32,bytes)')).slice(0, 4)

/**
 * Event topic for Notification(bytes32 indexed,bytes).
 * keccak256("Notification(bytes32,bytes)").
 */
const NOTIFICATION_EVENT_TOPIC = bytesToHex(
  keccak_256(new TextEncoder().encode('Notification(bytes32,bytes)')),
)

/**
 * ABI-encode calldata for notify(bytes32 recipientHash, bytes encryptedPayload).
 *
 * Layout:
 *   [0:4]     function selector
 *   [4:36]    bytes32 recipientHash
 *   [36:68]   offset to bytes data = 64 (0x40)
 *   [68:100]  length of bytes data
 *   [100:...] bytes data, right-padded to 32-byte boundary
 */
function encodeNotifyCalldata(recipientHashBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const paddedPayload = padRight32(payload)
  const totalLength = 4 + 32 + 32 + 32 + paddedPayload.length
  const calldata = new Uint8Array(totalLength)

  let offset = 0

  // Function selector (4 bytes)
  calldata.set(NOTIFY_SELECTOR, offset)
  offset += 4

  // bytes32 recipientHash
  calldata.set(recipientHashBytes, offset)
  offset += 32

  // Offset to bytes data = 64 (0x40) — relative to start of params
  calldata.set(encodeUint256(64), offset)
  offset += 32

  // Length of bytes data
  calldata.set(encodeUint256(payload.length), offset)
  offset += 32

  // Bytes data (padded)
  calldata.set(paddedPayload, offset)

  return calldata
}

/**
 * Decode the `bytes encryptedPayload` from an event log's data field.
 *
 * Event data ABI layout for a single dynamic `bytes` parameter:
 *   [0:32]    offset to bytes = 0x20
 *   [32:64]   length of bytes
 *   [64:...]  bytes data
 */
function decodeEventPayload(dataHex: string): Uint8Array {
  const data = hexToBytes(dataHex)
  // Read length from offset 32..64 (last 4 bytes of the 32-byte word, safe for reasonable sizes)
  const lengthWord = data.slice(32, 64)
  let length = 0
  for (let i = 28; i < 32; i++) {
    length = length * 256 + lengthWord[i]
  }
  return data.slice(64, 64 + length)
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Compute the recipient hash for the registry.
 * Returns keccak256 of the 20-byte ETH address as a 0x-prefixed hex string (bytes32).
 *
 * @param ethAddress - ETH address (0x-prefixed hex string)
 * @returns 0x-prefixed bytes32 hex string
 */
export function recipientHash(ethAddress: string): string {
  const addressBytes = hexToBytes(ethAddress.toLowerCase())
  return bytesToHex(keccak_256(addressBytes))
}

/**
 * Send an on-chain notification to a recipient.
 *
 * Steps:
 * 1. ECIES-encrypt the payload with the recipient's public key
 * 2. ABI-encode the notify(bytes32, bytes) calldata
 * 3. Call provider.sendTransaction
 *
 * Cost: ~22,000 gas on Gnosis Chain (~0.00002 xDAI).
 * Only needed for first contact — subsequent messages are discovered via mailbox feeds.
 *
 * @param provider - Framework-agnostic blockchain provider
 * @param contractAddress - Deployed SwarmNotificationRegistry address
 * @param recipientPublicKey - Recipient's compressed secp256k1 public key (33 bytes)
 * @param recipientEthAddress - Recipient's ETH address
 * @param payload - Notification payload (sender info + feed topic)
 * @returns Transaction hash
 */
export async function sendNotification(
  provider: NotifyProvider,
  contractAddress: string,
  recipientPublicKey: Uint8Array,
  recipientEthAddress: string,
  payload: NotificationPayload,
): Promise<string> {
  // 1. JSON-encode and ECIES-encrypt the payload
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  const encryptedPayload = await eciesEncrypt(payloadBytes, recipientPublicKey)

  // 2. Compute recipient hash
  const hashHex = recipientHash(recipientEthAddress)
  const hashBytes = hexToBytes(hashHex)

  // 3. ABI-encode calldata
  const calldata = encodeNotifyCalldata(hashBytes, encryptedPayload)

  // 4. Send transaction
  return provider.sendTransaction({
    to: contractAddress,
    data: bytesToHex(calldata),
  })
}

/**
 * Poll for new notifications addressed to me.
 *
 * Queries eth_getLogs for Notification events matching my recipientHash,
 * ECIES-decrypts each payload, and silently discards any that fail
 * decryption (spam or not intended for us).
 *
 * @param provider - Framework-agnostic blockchain provider
 * @param contractAddress - Deployed SwarmNotificationRegistry address
 * @param myEthAddress - My ETH address
 * @param myPrivateKey - My secp256k1 private key for ECIES decryption
 * @param fromBlock - Start block for log query (default: 0). Store last processed block locally to avoid reprocessing.
 * @returns Array of decrypted notification payloads with block numbers
 */
export async function pollNotifications(
  provider: NotifyProvider,
  contractAddress: string,
  myEthAddress: string,
  myPrivateKey: Uint8Array,
  fromBlock?: number,
): Promise<{ payload: NotificationPayload; blockNumber: number }[]> {
  // 1. Compute filter topics
  const myHash = recipientHash(myEthAddress)

  // 2. Query logs: topic[0] = event signature, topic[1] = indexed recipientHash
  const logs = await provider.getLogs({
    address: contractAddress,
    topics: [NOTIFICATION_EVENT_TOPIC, myHash],
    fromBlock: fromBlock ?? 0,
    toBlock: 'latest',
  })

  // 3. Decode and decrypt each log
  const results: { payload: NotificationPayload; blockNumber: number }[] = []

  for (const log of logs) {
    try {
      const encryptedPayload = decodeEventPayload(log.data)
      const decrypted = await eciesDecrypt(encryptedPayload, myPrivateKey)
      const payload: NotificationPayload = JSON.parse(new TextDecoder().decode(decrypted))
      results.push({ payload, blockNumber: log.blockNumber })
    } catch {
      // Decryption or parse failure → spam or not for us, discard silently
      continue
    }
  }

  return results
}

// ─── Exported constants (useful for tests and tooling) ──────────

/** The event topic hash for Notification(bytes32,bytes). */
export const NOTIFICATION_TOPIC = NOTIFICATION_EVENT_TOPIC
