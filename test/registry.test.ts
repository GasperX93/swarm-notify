import { describe, it, expect, vi } from 'vitest'
import * as secp from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { eciesEncrypt } from '../src/crypto'
import {
  recipientHash,
  sendNotification,
  pollNotifications,
  NOTIFICATION_TOPIC,
} from '../src/registry'
import type { NotifyProvider, NotificationPayload } from '../src/types'

// ─── Helpers ────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** Pad Uint8Array to multiple of 32 bytes. */
function padRight32(data: Uint8Array): Uint8Array {
  const remainder = data.length % 32
  if (remainder === 0) return data
  const padded = new Uint8Array(data.length + (32 - remainder))
  padded.set(data)
  return padded
}

/** Encode a uint256 as 32-byte big-endian. */
function encodeUint256(value: number): Uint8Array {
  const buf = new Uint8Array(32)
  let v = value
  for (let i = 31; i >= 24 && v > 0; i--) {
    buf[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  return buf
}

/**
 * Build a mock event log data field for a `bytes` parameter,
 * mimicking Solidity ABI encoding of a single dynamic bytes param.
 */
function encodeEventData(payload: Uint8Array): string {
  const paddedPayload = padRight32(payload)
  const data = new Uint8Array(32 + 32 + paddedPayload.length)
  // offset to bytes = 0x20
  data.set(encodeUint256(32), 0)
  // length of bytes
  data.set(encodeUint256(payload.length), 32)
  // bytes data (padded)
  data.set(paddedPayload, 64)
  return bytesToHex(data)
}

/** Create a mock NotifyProvider that records calls. */
function createMockProvider(logsToReturn: { data: string; blockNumber: number }[] = []) {
  const provider: NotifyProvider & {
    sentTxs: { to: string; data: string; value?: string }[]
    logFilters: Parameters<NotifyProvider['getLogs']>[0][]
  } = {
    sentTxs: [],
    logFilters: [],
    getLogs: vi.fn(async (filter) => {
      provider.logFilters.push(filter)
      return logsToReturn
    }),
    call: vi.fn(async () => '0x'),
    sendTransaction: vi.fn(async (tx) => {
      provider.sentTxs.push(tx)
      return '0xmocktxhash'
    }),
  }
  return provider
}

const CONTRACT_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

const SAMPLE_PAYLOAD: NotificationPayload = {
  sender: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  overlay: 'abc123overlay',
  feedTopic: 'feedtopic456',
}

// ─── Tests ──────────────────────────────────────────────────────

describe('recipientHash', () => {
  it('returns deterministic keccak256 of address bytes', () => {
    const address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    const hash = recipientHash(address)

    // Compute expected: keccak256 of the 20-byte address
    const addressBytes = hexToBytes(address.toLowerCase())
    const expected = bytesToHex(keccak_256(addressBytes))

    expect(hash).toBe(expected)
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is case-insensitive', () => {
    const lower = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
    const mixed = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
    expect(recipientHash(lower)).toBe(recipientHash(mixed))
  })

  it('different addresses produce different hashes', () => {
    const a = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const b = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    expect(recipientHash(a)).not.toBe(recipientHash(b))
  })
})

describe('ABI encoding', () => {
  it('notify calldata has correct function selector', async () => {
    const provider = createMockProvider()
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)
    const senderPrivKey = secp.utils.randomPrivateKey()

    await sendNotification(
      provider,
      CONTRACT_ADDRESS,
      recipientPubKey,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      SAMPLE_PAYLOAD,
      senderPrivKey,
    )

    const sentData = provider.sentTxs[0].data
    const expectedSelector = bytesToHex(
      keccak_256(new TextEncoder().encode('notify(bytes32,bytes)')).slice(0, 4),
    )
    expect(sentData.slice(0, 10)).toBe(expectedSelector)
  })

  it('notify calldata contains correct recipientHash', async () => {
    const provider = createMockProvider()
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)
    const senderPrivKey = secp.utils.randomPrivateKey()
    const recipientAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    await sendNotification(
      provider,
      CONTRACT_ADDRESS,
      recipientPubKey,
      recipientAddr,
      SAMPLE_PAYLOAD,
      senderPrivKey,
    )

    const sentData = provider.sentTxs[0].data
    // bytes32 recipientHash starts at byte 4 (after selector), = chars 10..74
    const calldataHash = '0x' + sentData.slice(10, 74)
    expect(calldataHash).toBe(recipientHash(recipientAddr))
  })
})

describe('sendNotification', () => {
  it('calls provider.sendTransaction with correct contract address', async () => {
    const provider = createMockProvider()
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)
    const senderPrivKey = secp.utils.randomPrivateKey()

    const txHash = await sendNotification(
      provider,
      CONTRACT_ADDRESS,
      recipientPubKey,
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      SAMPLE_PAYLOAD,
      senderPrivKey,
    )

    expect(txHash).toBe('0xmocktxhash')
    expect(provider.sentTxs).toHaveLength(1)
    expect(provider.sentTxs[0].to).toBe(CONTRACT_ADDRESS)
  })

  it('encrypted payload can be decrypted by recipient', async () => {
    const provider = createMockProvider()
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)
    const senderPrivKey = secp.utils.randomPrivateKey()
    const recipientAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

    await sendNotification(
      provider,
      CONTRACT_ADDRESS,
      recipientPubKey,
      recipientAddr,
      SAMPLE_PAYLOAD,
      senderPrivKey,
    )

    // Extract encrypted payload from calldata and verify it's decryptable
    // Calldata: selector(4) + recipientHash(32) + offset(32) + length(32) + data(...)
    const calldataBytes = hexToBytes(provider.sentTxs[0].data)
    // Read payload length at offset 4+32+32 = 68
    const lengthWord = calldataBytes.slice(68, 100)
    let payloadLength = 0
    for (let i = 28; i < 32; i++) {
      payloadLength = payloadLength * 256 + lengthWord[i]
    }
    const encryptedPayload = calldataBytes.slice(100, 100 + payloadLength)

    // Now feed this to pollNotifications via a mock log
    const eventData = encodeEventData(encryptedPayload)
    const pollProvider = createMockProvider([
      {
        data: eventData,
        blockNumber: 100,
      },
    ])

    const results = await pollNotifications(
      pollProvider,
      CONTRACT_ADDRESS,
      recipientAddr,
      recipientPrivKey,
    )

    expect(results).toHaveLength(1)
    expect(results[0].payload).toEqual(SAMPLE_PAYLOAD)
    expect(results[0].blockNumber).toBe(100)
  })
})

describe('pollNotifications', () => {
  it('calls provider.getLogs with correct topics', async () => {
    const myPrivKey = secp.utils.randomPrivateKey()
    const myAddr = '0xcccccccccccccccccccccccccccccccccccccccc'
    const provider = createMockProvider([])

    await pollNotifications(provider, CONTRACT_ADDRESS, myAddr, myPrivKey)

    expect(provider.getLogs).toHaveBeenCalledOnce()
    const filter = provider.logFilters[0]
    expect(filter.address).toBe(CONTRACT_ADDRESS)
    expect(filter.topics[0]).toBe(NOTIFICATION_TOPIC)
    expect(filter.topics[1]).toBe(recipientHash(myAddr))
    expect(filter.fromBlock).toBe(0)
    expect(filter.toBlock).toBe('latest')
  })

  it('decrypts valid notification payloads', async () => {
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)
    const recipientAddr = '0xdddddddddddddddddddddddddddddddddddddd'

    // Build an ECIES-encrypted payload
    const payloadBytes = new TextEncoder().encode(JSON.stringify(SAMPLE_PAYLOAD))
    const encrypted = await eciesEncrypt(payloadBytes, recipientPubKey)
    const eventData = encodeEventData(encrypted)

    const provider = createMockProvider([{ data: eventData, blockNumber: 42 }])
    const results = await pollNotifications(provider, CONTRACT_ADDRESS, recipientAddr, recipientPrivKey)

    expect(results).toHaveLength(1)
    expect(results[0].payload).toEqual(SAMPLE_PAYLOAD)
    expect(results[0].blockNumber).toBe(42)
  })

  it('respects fromBlock parameter', async () => {
    const myPrivKey = secp.utils.randomPrivateKey()
    const provider = createMockProvider([])

    await pollNotifications(
      provider,
      CONTRACT_ADDRESS,
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      myPrivKey,
      500,
    )

    const filter = provider.logFilters[0]
    expect(filter.fromBlock).toBe(500)
  })

  it('silently discards spam (wrong key)', async () => {
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

    // Encrypt with a completely different public key
    const otherPubKey = secp.getPublicKey(secp.utils.randomPrivateKey(), true)
    const payloadBytes = new TextEncoder().encode(JSON.stringify(SAMPLE_PAYLOAD))
    const encrypted = await eciesEncrypt(payloadBytes, otherPubKey)
    const eventData = encodeEventData(encrypted)

    const provider = createMockProvider([{ data: eventData, blockNumber: 10 }])
    const results = await pollNotifications(provider, CONTRACT_ADDRESS, recipientAddr, recipientPrivKey)

    // Should be empty — decryption failed, discarded silently
    expect(results).toHaveLength(0)
  })

  it('discards malformed log data silently', async () => {
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'

    // Garbage data that can't be decoded/decrypted
    const garbageData =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000004' +
      'deadbeef00000000000000000000000000000000000000000000000000000000'

    const provider = createMockProvider([{ data: garbageData, blockNumber: 5 }])
    const results = await pollNotifications(provider, CONTRACT_ADDRESS, recipientAddr, recipientPrivKey)

    expect(results).toHaveLength(0)
  })

  it('multiple notifications to same recipient: all discoverable', async () => {
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)
    const recipientAddr = '0xffffffffffffffffffffffffffffffffffffffff'

    const payload1: NotificationPayload = {
      sender: '0x1111111111111111111111111111111111111111',
      overlay: 'overlay1',
      feedTopic: 'topic1',
    }
    const payload2: NotificationPayload = {
      sender: '0x2222222222222222222222222222222222222222',
      overlay: 'overlay2',
      feedTopic: 'topic2',
    }
    const payload3: NotificationPayload = {
      sender: '0x3333333333333333333333333333333333333333',
      overlay: 'overlay3',
      feedTopic: 'topic3',
    }

    const enc1 = await eciesEncrypt(new TextEncoder().encode(JSON.stringify(payload1)), recipientPubKey)
    const enc2 = await eciesEncrypt(new TextEncoder().encode(JSON.stringify(payload2)), recipientPubKey)
    const enc3 = await eciesEncrypt(new TextEncoder().encode(JSON.stringify(payload3)), recipientPubKey)

    const provider = createMockProvider([
      { data: encodeEventData(enc1), blockNumber: 100 },
      { data: encodeEventData(enc2), blockNumber: 200 },
      { data: encodeEventData(enc3), blockNumber: 300 },
    ])

    const results = await pollNotifications(provider, CONTRACT_ADDRESS, recipientAddr, recipientPrivKey)

    expect(results).toHaveLength(3)
    expect(results[0].payload).toEqual(payload1)
    expect(results[0].blockNumber).toBe(100)
    expect(results[1].payload).toEqual(payload2)
    expect(results[1].blockNumber).toBe(200)
    expect(results[2].payload).toEqual(payload3)
    expect(results[2].blockNumber).toBe(300)
  })

  it('mixed valid and spam: only valid returned', async () => {
    const recipientPrivKey = secp.utils.randomPrivateKey()
    const recipientPubKey = secp.getPublicKey(recipientPrivKey, true)
    const recipientAddr = '0xffffffffffffffffffffffffffffffffffffffff'

    const validPayload: NotificationPayload = {
      sender: '0x1111111111111111111111111111111111111111',
      overlay: 'overlay1',
      feedTopic: 'topic1',
    }

    // Valid notification
    const encValid = await eciesEncrypt(
      new TextEncoder().encode(JSON.stringify(validPayload)),
      recipientPubKey,
    )
    // Spam: encrypted with wrong key
    const encSpam = await eciesEncrypt(
      new TextEncoder().encode(JSON.stringify(SAMPLE_PAYLOAD)),
      secp.getPublicKey(secp.utils.randomPrivateKey(), true),
    )

    const provider = createMockProvider([
      { data: encodeEventData(encSpam), blockNumber: 50 },
      { data: encodeEventData(encValid), blockNumber: 100 },
      { data: encodeEventData(encSpam), blockNumber: 150 },
    ])

    const results = await pollNotifications(provider, CONTRACT_ADDRESS, recipientAddr, recipientPrivKey)

    expect(results).toHaveLength(1)
    expect(results[0].payload).toEqual(validPayload)
    expect(results[0].blockNumber).toBe(100)
  })
})
