import { describe, it, expect, vi } from 'vitest'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { feedTopic, send, readMessages, checkInbox } from '../src/mailbox'
import type { Contact } from '../src/types'

// Helper: create a key pair and return { privateKey, publicKeyHex, address }
function makeKeypair() {
  const privateKey = secp.utils.randomPrivateKey()
  const publicKey = secp.getPublicKey(privateKey, true)
  return {
    privateKey,
    publicKeyHex: bytesToHex(publicKey),
    // Fake ETH address from first 20 bytes of public key
    address: '0x' + bytesToHex(publicKey.slice(1, 21)),
  }
}

function makeContact(keypair: ReturnType<typeof makeKeypair>): Contact {
  return {
    ethAddress: keypair.address,
    nickname: 'Test',
    walletPublicKey: keypair.publicKeyHex,
    beePublicKey: '04' + 'cc'.repeat(32),
    addedAt: Date.now(),
  }
}

describe('feedTopic', () => {
  it('deterministic for same pair', () => {
    const a = 'aaaa'
    const b = 'bbbb'
    expect(feedTopic(a, b)).toBe(feedTopic(a, b))
  })

  it('different for reversed pair (Alice→Bob ≠ Bob→Alice)', () => {
    const a = 'aaaa'
    const b = 'bbbb'
    expect(feedTopic(a, b)).not.toBe(feedTopic(b, a))
  })

  it('case-insensitive', () => {
    expect(feedTopic('AAAA', 'BBBB')).toBe(feedTopic('aaaa', 'bbbb'))
  })

  it('returns 64 hex chars', () => {
    expect(feedTopic('aaa', 'bbb')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('send + readMessages', () => {
  it('round-trip: send a message, read it back', async () => {
    const alice = makeKeypair()
    const bob = makeKeypair()
    const bobContact = makeContact(bob)

    // Track what gets uploaded and written to feed
    let uploadedBlob: Uint8Array | null = null
    const uploadRef = 'abc123ref'

    const uploadData = vi.fn().mockImplementation((_stamp: string, data: Uint8Array) => {
      uploadedBlob = data
      return { reference: { toHex: () => uploadRef } }
    })
    const uploadReference = vi.fn().mockResolvedValue({})
    const ownerHex = alice.address
    const makeFeedWriter = vi.fn().mockReturnValue({
      owner: { toHex: () => ownerHex },
      uploadReference,
    })

    // First send: no existing messages (feed not found)
    const downloadPayloadFail = vi.fn().mockRejectedValue(new Error('Not found'))
    const makeFeedReader = vi.fn().mockReturnValue({
      downloadPayload: downloadPayloadFail,
    })

    const bee = { uploadData, makeFeedWriter, makeFeedReader } as any

    await send(
      bee,
      '0x' + bytesToHex(alice.privateKey),
      'stamp123',
      alice.privateKey,
      alice.address,
      bobContact,
      { subject: 'Hello', body: 'First message' },
    )

    expect(uploadData).toHaveBeenCalled()
    expect(uploadReference).toHaveBeenCalled()
    expect(uploadedBlob).not.toBeNull()

    // Now simulate readMessages: bob reads alice's feed
    // The feed reader should return what was uploaded
    const downloadPayloadSuccess = vi.fn().mockResolvedValue({
      payload: { toUint8Array: () => uploadedBlob },
    })
    const makeFeedReaderForRead = vi.fn().mockReturnValue({
      downloadPayload: downloadPayloadSuccess,
    })
    const beeRead = { makeFeedReader: makeFeedReaderForRead } as any

    const aliceContact = makeContact(alice)
    const messages = await readMessages(beeRead, bob.privateKey, bob.address, aliceContact)

    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe('Hello')
    expect(messages[0].body).toBe('First message')
    expect(messages[0].v).toBe(1)
    expect(messages[0].sender).toBe(alice.address)
    expect(messages[0].ts).toBeGreaterThan(0)
  })

  it('send multiple messages: array grows', async () => {
    const alice = makeKeypair()
    const bob = makeKeypair()
    const bobContact = makeContact(bob)

    let uploadedBlob: Uint8Array | null = null
    const uploadData = vi.fn().mockImplementation((_stamp: string, data: Uint8Array) => {
      uploadedBlob = data
      return { reference: { toHex: () => 'ref' } }
    })
    const uploadReference = vi.fn().mockResolvedValue({})
    const ownerHex = alice.address
    const makeFeedWriter = vi.fn().mockReturnValue({
      owner: { toHex: () => ownerHex },
      uploadReference,
    })

    // First send: empty feed
    const makeFeedReader = vi.fn().mockReturnValue({
      downloadPayload: vi.fn().mockRejectedValue(new Error('Not found')),
    })
    const bee = { uploadData, makeFeedWriter, makeFeedReader } as any

    await send(bee, '0x' + bytesToHex(alice.privateKey), 'stamp', alice.privateKey, alice.address, bobContact, {
      subject: 'Msg 1',
      body: 'First',
    })

    const firstBlob = uploadedBlob!

    // Second send: feed now returns the first blob
    const makeFeedReader2 = vi.fn().mockReturnValue({
      downloadPayload: vi.fn().mockResolvedValue({
        payload: { toUint8Array: () => firstBlob },
      }),
    })
    const bee2 = { uploadData, makeFeedWriter, makeFeedReader: makeFeedReader2 } as any

    await send(bee2, '0x' + bytesToHex(alice.privateKey), 'stamp', alice.privateKey, alice.address, bobContact, {
      subject: 'Msg 2',
      body: 'Second',
    })

    // Read back: should have 2 messages
    const makeFeedReaderRead = vi.fn().mockReturnValue({
      downloadPayload: vi.fn().mockResolvedValue({
        payload: { toUint8Array: () => uploadedBlob },
      }),
    })
    const beeRead = { makeFeedReader: makeFeedReaderRead } as any
    const aliceContact = makeContact(alice)
    const messages = await readMessages(beeRead, bob.privateKey, bob.address, aliceContact)

    expect(messages).toHaveLength(2)
    expect(messages[0].subject).toBe('Msg 1')
    expect(messages[1].subject).toBe('Msg 2')
  })
})

describe('readMessages edge cases', () => {
  it('returns [] on non-existent feed', async () => {
    const bob = makeKeypair()
    const alice = makeKeypair()
    const makeFeedReader = vi.fn().mockReturnValue({
      downloadPayload: vi.fn().mockRejectedValue(new Error('Not found')),
    })
    const bee = { makeFeedReader } as any
    const aliceContact = makeContact(alice)

    const messages = await readMessages(bee, bob.privateKey, bob.address, aliceContact)
    expect(messages).toEqual([])
  })
})

describe('checkInbox', () => {
  it('aggregates messages from multiple contacts', async () => {
    const me = makeKeypair()
    const alice = makeKeypair()
    const bob = makeKeypair()

    // Simulate: alice sent me a message, bob's feed is empty
    // We need to create encrypted blobs for alice's messages
    const { deriveSharedSecret, encrypt } = await import('../src/crypto')
    const alicePubBytes = hexToBytes(alice.publicKeyHex)
    const sharedWithAlice = deriveSharedSecret(me.privateKey, alicePubBytes)

    const aliceMessages = [{ v: 1, subject: 'Hi', body: 'From Alice', ts: 1000, sender: alice.address }]
    const plaintext = new TextEncoder().encode(JSON.stringify(aliceMessages))
    const encrypted = await encrypt(plaintext, sharedWithAlice)
    const blob = new Uint8Array(12 + encrypted.ciphertext.length)
    blob.set(encrypted.nonce, 0)
    blob.set(encrypted.ciphertext, 12)

    let callCount = 0
    const makeFeedReader = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // Alice's feed — has messages
        return {
          downloadPayload: vi.fn().mockResolvedValue({
            payload: { toUint8Array: () => blob },
          }),
        }
      }
      // Bob's feed — empty
      return {
        downloadPayload: vi.fn().mockRejectedValue(new Error('Not found')),
      }
    })
    const bee = { makeFeedReader } as any

    const aliceContact = makeContact(alice)
    const bobContact = makeContact(bob)

    const inbox = await checkInbox(bee, me.privateKey, me.address, [aliceContact, bobContact])

    // Only Alice should appear (Bob has no messages)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].contact.ethAddress).toBe(aliceContact.ethAddress)
    expect(inbox[0].messages).toHaveLength(1)
    expect(inbox[0].messages[0].subject).toBe('Hi')
  })
})

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
