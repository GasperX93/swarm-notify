import { describe, it, expect } from 'vitest'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { feedTopic, send, readMessages, checkInbox } from '../src/mailbox'
import { deriveSharedSecret, encrypt } from '../src/crypto'
import { MockBee } from './helpers/mock-bee'
import type { Contact } from '../src/types'

const STAMP = 'stamp123'

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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

describe('feedTopic', () => {
  it('deterministic for same pair', () => {
    expect(feedTopic('aaaa', 'bbbb')).toBe(feedTopic('aaaa', 'bbbb'))
  })

  it('different for reversed pair (Alice→Bob ≠ Bob→Alice)', () => {
    expect(feedTopic('aaaa', 'bbbb')).not.toBe(feedTopic('bbbb', 'aaaa'))
  })

  it('case-insensitive', () => {
    expect(feedTopic('AAAA', 'BBBB')).toBe(feedTopic('aaaa', 'bbbb'))
  })

  it('returns 64 hex chars', () => {
    expect(feedTopic('aaa', 'bbb')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('send + readMessages (append-only)', () => {
  it('round-trip: send a message, read it back', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()

    await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, makeContact(bob), {
      subject: 'Hello',
      body: 'First message',
    })

    const messages = await readMessages(bee as any, bob.privateKey, bob.address, makeContact(alice))

    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe('Hello')
    expect(messages[0].body).toBe('First message')
    expect(messages[0].v).toBe(1)
    expect(messages[0].sender).toBe(alice.address)
    expect(messages[0].ts).toBeGreaterThan(0)
  })

  it('send returns the monotonic index it wrote', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()
    const bobContact = makeContact(bob)

    const i0 = await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: 'a' })
    const i1 = await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: 'b' })
    const i2 = await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: 'c' })

    expect([i0, i1, i2]).toEqual([0, 1, 2])
  })

  it('multiple sequential sends accumulate in order', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()
    const bobContact = makeContact(bob)

    for (let i = 1; i <= 3; i++) {
      await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, {
        subject: `Msg ${i}`,
        body: `Body ${i}`,
      })
    }

    const messages = await readMessages(bee as any, bob.privateKey, bob.address, makeContact(alice))

    expect(messages.map(m => m.subject)).toEqual(['Msg 1', 'Msg 2', 'Msg 3'])
  })

  // The headline regression: this is the bug #55 fixes. With the old single-slot
  // read-modify-write, concurrent sends overwrote each other and only the last
  // survived. Append-only with host-supplied indices is race-free by construction.
  it('rapid CONCURRENT sends with host cursor → all delivered, in order', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()
    const bobContact = makeContact(bob)

    const N = 8
    const indices = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: `m${i}` }, i),
      ),
    )

    // every send landed at its own distinct index
    expect([...indices].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i))

    const messages = await readMessages(bee as any, bob.privateKey, bob.address, makeContact(alice))
    expect(messages.map(m => m.body)).toEqual(Array.from({ length: N }, (_, i) => `m${i}`))
  })

  it('readMessages(fromIndex) returns only the tail', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()
    const bobContact = makeContact(bob)

    for (let i = 0; i < 4; i++) {
      await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: `m${i}` })
    }

    const tail = await readMessages(bee as any, bob.privateKey, bob.address, makeContact(alice), 2)
    expect(tail.map(m => m.body)).toEqual(['m2', 'm3'])
  })
})

describe('warmup / gap handling', () => {
  it('stops at a not-yet-propagated gap, then picks it up once filled', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()
    const bobContact = makeContact(bob)
    const aliceContact = makeContact(alice)

    // Write indices 0, 1, 3 — index 2 hasn't propagated yet (explicit indices).
    await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: 'm0' }, 0)
    await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: 'm1' }, 1)
    await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: 'm3' }, 3)

    // Reader stops at the gap (index 2) — strict ordering, no out-of-order delivery.
    const before = await readMessages(bee as any, bob.privateKey, bob.address, aliceContact)
    expect(before.map(m => m.body)).toEqual(['m0', 'm1'])

    // Gap fills in; reader now sees everything in order.
    await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, bobContact, { subject: '', body: 'm2' }, 2)
    const after = await readMessages(bee as any, bob.privateKey, bob.address, aliceContact)
    expect(after.map(m => m.body)).toEqual(['m0', 'm1', 'm2', 'm3'])
  })
})

describe('readMessages edge cases', () => {
  it('returns [] on non-existent feed', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()

    const messages = await readMessages(bee as any, bob.privateKey, bob.address, makeContact(alice))
    expect(messages).toEqual([])
  })

  it('clean break: a legacy single-slot ARRAY blob yields [] (no throw)', async () => {
    const bee = new MockBee()
    const alice = makeKeypair()
    const bob = makeKeypair()

    // Reconstruct the OLD format: the whole conversation as one encrypted array
    // at index 0 of the alice→bob feed.
    const sharedSecret = deriveSharedSecret(alice.privateKey, hexToBytes(bob.publicKeyHex))
    const legacyArray = [
      { v: 1, subject: 'old', body: 'legacy 1', ts: 1000, sender: alice.address },
      { v: 1, subject: 'old', body: 'legacy 2', ts: 2000, sender: alice.address },
    ]
    const encrypted = await encrypt(new TextEncoder().encode(JSON.stringify(legacyArray)), sharedSecret)
    const blob = new Uint8Array(12 + encrypted.ciphertext.length)
    blob.set(encrypted.nonce, 0)
    blob.set(encrypted.ciphertext, 12)

    const topic = feedTopic(alice.address, bob.address)
    const { reference } = await bee.uploadData(STAMP, blob)
    await bee.makeFeedWriter(topic, alice.address).uploadReference(STAMP, reference, { index: 0 })

    const messages = await readMessages(bee as any, bob.privateKey, bob.address, makeContact(alice))
    expect(messages).toEqual([])
  })
})

describe('checkInbox', () => {
  it('aggregates messages from contacts that have any, skips empty ones', async () => {
    const bee = new MockBee()
    const me = makeKeypair()
    const alice = makeKeypair()
    const bob = makeKeypair()

    // Alice sends me a message; Bob never does.
    await send(bee as any, alice.address, STAMP, alice.privateKey, alice.address, makeContact(me), {
      subject: 'Hi',
      body: 'From Alice',
    })

    const inbox = await checkInbox(bee as any, me.privateKey, me.address, [makeContact(alice), makeContact(bob)])

    expect(inbox).toHaveLength(1)
    expect(inbox[0].contact.ethAddress).toBe(alice.address)
    expect(inbox[0].messages).toHaveLength(1)
    expect(inbox[0].messages[0].subject).toBe('Hi')
  })
})
