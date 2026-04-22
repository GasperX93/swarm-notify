/**
 * Integration tests — exercise the full library flow end-to-end
 * with mocked Bee node and NotifyProvider.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { MockBee } from './helpers/mock-bee'
import * as identity from '../src/identity'
import * as mailbox from '../src/mailbox'
import { ContactStore } from '../src/contacts'
import * as registry from '../src/registry'
import { eciesEncrypt } from '../src/crypto'
import type { NotifyProvider, NotificationPayload } from '../src/types'

// ─── Helpers ────────────────────────────────────────────────────

function makeUser() {
  const privateKey = secp.utils.randomPrivateKey()
  const publicKey = secp.getPublicKey(privateKey, true)
  const publicKeyHex = bytesToHex(publicKey)
  const ethAddress = '0x' + bytesToHex(publicKey.slice(1, 21))
  const beePublicKey = '04' + bytesToHex(secp.utils.randomPrivateKey())
  return { privateKey, publicKey, publicKeyHex, ethAddress, beePublicKey }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
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

/** Build mock event log data for a bytes parameter. */
function encodeEventData(payload: Uint8Array): string {
  const paddedPayload = padRight32(payload)
  const data = new Uint8Array(32 + 32 + paddedPayload.length)
  data.set(encodeUint256(32), 0)
  data.set(encodeUint256(payload.length), 32)
  data.set(paddedPayload, 64)
  return (
    '0x' +
    Array.from(data)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** Create a mock NotifyProvider that stores logs for read-after-write. */
function createMockProvider() {
  const logs: { data: string; blockNumber: number; topics: string[] }[] = []
  let blockNumber = 0

  const provider: NotifyProvider & {
    logs: typeof logs
    sentTxs: { to: string; data: string }[]
  } = {
    logs,
    sentTxs: [],

    getLogs: vi.fn(async (filter) => {
      return logs
        .filter(
          (log) =>
            log.blockNumber >= filter.fromBlock &&
            (!filter.topics[1] || log.topics[1] === filter.topics[1]),
        )
        .map((log) => ({ data: log.data, blockNumber: log.blockNumber }))
    }),

    call: vi.fn(async () => '0x'),

    sendTransaction: vi.fn(async (tx) => {
      provider.sentTxs.push(tx)
      blockNumber++

      // Extract recipientHash and encryptedPayload from calldata to store as event log
      const calldata = hexToBytes(tx.data)
      // calldata: selector(4) + recipientHash(32) + offset(32) + length(32) + data(...)
      const recipientHashBytes = calldata.slice(4, 36)
      const recipientHashHex =
        '0x' +
        Array.from(recipientHashBytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')

      // Read payload length and data
      const lengthWord = calldata.slice(68, 100)
      let payloadLength = 0
      for (let i = 28; i < 32; i++) {
        payloadLength = payloadLength * 256 + lengthWord[i]
      }
      const encryptedPayload = calldata.slice(100, 100 + payloadLength)
      const eventData = encodeEventData(encryptedPayload)

      logs.push({
        data: eventData,
        blockNumber,
        topics: [registry.NOTIFICATION_TOPIC, recipientHashHex],
      })

      return '0xmocktx' + blockNumber
    }),
  }
  return provider
}

const CONTRACT = '0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf'
const STAMP = 'mock-stamp-id'

// ─── Tests ──────────────────────────────────────────────────────

let contacts: ContactStore

beforeEach(() => {
  contacts = new ContactStore()
})

describe('identity: publish + resolve round-trip', () => {
  it('publishes identity and resolves it back', async () => {
    const bee = new MockBee()
    const alice = makeUser()

    const swarmIdentity = {
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
      ethAddress: alice.ethAddress,
    }

    // Publish
    await identity.publish(bee as any, alice.ethAddress, STAMP, swarmIdentity)

    // Resolve
    const resolved = await identity.resolve(bee as any, alice.ethAddress)

    expect(resolved).not.toBeNull()
    expect(resolved!.walletPublicKey).toBe(alice.publicKeyHex)
    expect(resolved!.beePublicKey).toBe(alice.beePublicKey)
  })

  it('returns null for non-existent identity', async () => {
    const bee = new MockBee()
    const resolved = await identity.resolve(bee as any, '0x0000000000000000000000000000000000000000')
    expect(resolved).toBeNull()
  })
})

describe('contacts: CRUD operations', () => {
  it('add, list, update, remove cycle', () => {
    const alice = makeUser()
    const swarmId = {
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
    }

    // Add
    const contact = contacts.add(alice.ethAddress, 'Alice', swarmId)
    expect(contact.nickname).toBe('Alice')
    expect(contact.ethAddress).toBe(alice.ethAddress.toLowerCase())

    // List
    const all = contacts.list()
    expect(all).toHaveLength(1)

    // Update
    const updated = contacts.update(alice.ethAddress, { nickname: 'Alice Updated' })
    expect(updated.nickname).toBe('Alice Updated')

    // Remove
    contacts.remove(alice.ethAddress)
    expect(contacts.list()).toHaveLength(0)
  })

  it('prevents duplicate contacts', () => {
    const alice = makeUser()
    const swarmId = {
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
    }

    contacts.add(alice.ethAddress, 'Alice', swarmId)
    expect(() => contacts.add(alice.ethAddress, 'Alice2', swarmId)).toThrow('Contact already exists')
  })
})

describe('full messaging flow: Alice ↔ Bob', () => {
  it('Alice sends message to Bob, Bob reads it', async () => {
    const bee = new MockBee()
    const alice = makeUser()
    const bob = makeUser()

    // Both publish identities
    await identity.publish(bee as any, alice.ethAddress, STAMP, {
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
      ethAddress: alice.ethAddress,
    })
    await identity.publish(bee as any, bob.ethAddress, STAMP, {
      walletPublicKey: bob.publicKeyHex,
      beePublicKey: bob.beePublicKey,
      ethAddress: bob.ethAddress,
    })

    // Alice resolves Bob and adds as contact
    const bobIdentity = await identity.resolve(bee as any, bob.ethAddress)
    expect(bobIdentity).not.toBeNull()

    const bobContact = contacts.add(bob.ethAddress, 'Bob', bobIdentity!)

    // Alice sends a message to Bob
    await mailbox.send(
      bee as any,
      alice.ethAddress, // signer
      STAMP,
      alice.privateKey,
      alice.ethAddress,
      bobContact,
      { subject: 'Hello Bob', body: 'This is a test message from Alice' },
    )

    // Bob reads messages from Alice
    const aliceContact = contacts.add(alice.ethAddress, 'Alice', {
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
    })
    const messages = await mailbox.readMessages(bee as any, bob.privateKey, bob.ethAddress, aliceContact)

    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe('Hello Bob')
    expect(messages[0].body).toBe('This is a test message from Alice')
    expect(messages[0].sender).toBe(alice.ethAddress)
    expect(messages[0].v).toBe(1)
    expect(messages[0].ts).toBeGreaterThan(0)
  })

  it('multiple messages accumulate in the feed', async () => {
    const bee = new MockBee()
    const alice = makeUser()
    const bob = makeUser()

    const bobContact = {
      ethAddress: bob.ethAddress.toLowerCase(),
      nickname: 'Bob',
      walletPublicKey: bob.publicKeyHex,
      beePublicKey: bob.beePublicKey,
      addedAt: Date.now(),
    }

    // Alice sends 3 messages
    for (let i = 1; i <= 3; i++) {
      await mailbox.send(
        bee as any,
        alice.ethAddress,
        STAMP,
        alice.privateKey,
        alice.ethAddress,
        bobContact,
        { subject: `Message ${i}`, body: `Body ${i}` },
      )
    }

    // Bob reads all
    const aliceContact = {
      ethAddress: alice.ethAddress.toLowerCase(),
      nickname: 'Alice',
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
      addedAt: Date.now(),
    }
    const messages = await mailbox.readMessages(bee as any, bob.privateKey, bob.ethAddress, aliceContact)

    expect(messages).toHaveLength(3)
    expect(messages[0].subject).toBe('Message 1')
    expect(messages[1].subject).toBe('Message 2')
    expect(messages[2].subject).toBe('Message 3')
  })

  it('bidirectional conversation via checkInbox', async () => {
    const bee = new MockBee()
    const alice = makeUser()
    const bob = makeUser()

    const bobContact = {
      ethAddress: bob.ethAddress.toLowerCase(),
      nickname: 'Bob',
      walletPublicKey: bob.publicKeyHex,
      beePublicKey: bob.beePublicKey,
      addedAt: Date.now(),
    }
    const aliceContact = {
      ethAddress: alice.ethAddress.toLowerCase(),
      nickname: 'Alice',
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
      addedAt: Date.now(),
    }

    // Alice → Bob
    await mailbox.send(bee as any, alice.ethAddress, STAMP, alice.privateKey, alice.ethAddress, bobContact, {
      subject: 'Hi Bob',
      body: 'Hello from Alice',
    })

    // Bob → Alice
    await mailbox.send(bee as any, bob.ethAddress, STAMP, bob.privateKey, bob.ethAddress, aliceContact, {
      subject: 'Hi Alice',
      body: 'Hello from Bob',
    })

    // Alice checks inbox — should see Bob's message
    const aliceInbox = await mailbox.checkInbox(bee as any, alice.privateKey, alice.ethAddress, [bobContact])
    expect(aliceInbox).toHaveLength(1)
    expect(aliceInbox[0].messages[0].subject).toBe('Hi Alice')

    // Bob checks inbox — should see Alice's message
    const bobInbox = await mailbox.checkInbox(bee as any, bob.privateKey, bob.ethAddress, [aliceContact])
    expect(bobInbox).toHaveLength(1)
    expect(bobInbox[0].messages[0].subject).toBe('Hi Bob')
  })
})

describe('registry notification flow', () => {
  it('full discovery: send notification → poll → discover sender', async () => {
    const alice = makeUser()
    const bob = makeUser()
    const provider = createMockProvider()

    // Bob sends notification to Alice (first contact)
    const payload: NotificationPayload = {
      sender: bob.ethAddress,
    }

    await registry.sendNotification(
      provider,
      CONTRACT,
      alice.publicKey,
      alice.ethAddress,
      payload,
    )

    // Alice polls — discovers Bob
    const notifications = await registry.pollNotifications(
      provider,
      CONTRACT,
      alice.ethAddress,
      alice.privateKey,
    )

    expect(notifications).toHaveLength(1)
    expect(notifications[0].payload.sender).toBe(bob.ethAddress)
    expect(notifications[0].blockNumber).toBe(1)
  })

  it('spam notifications are silently filtered', async () => {
    const alice = makeUser()
    const bob = makeUser()
    const provider = createMockProvider()

    // Bob sends a valid notification
    const validPayload: NotificationPayload = {
      sender: bob.ethAddress,
    }
    await registry.sendNotification(provider, CONTRACT, alice.publicKey, alice.ethAddress, validPayload)

    // Spammer sends notification encrypted with a different key (Alice can't decrypt)
    const spammer = makeUser()
    const spamPayload: NotificationPayload = {
      sender: spammer.ethAddress,
    }
    // Encrypt with spammer's own key instead of Alice's — Alice can't decrypt this
    const spamBytes = new TextEncoder().encode(JSON.stringify(spamPayload))
    const spamEncrypted = await eciesEncrypt(spamBytes, spammer.publicKey)
    const spamEventData = encodeEventData(spamEncrypted)

    // Manually inject spam log with Alice's recipientHash
    const aliceHash = registry.recipientHash(alice.ethAddress)
    provider.logs.push({
      data: spamEventData,
      blockNumber: 99,
      topics: [registry.NOTIFICATION_TOPIC, aliceHash],
    })

    // Alice polls — should only get Bob's valid notification
    const notifications = await registry.pollNotifications(provider, CONTRACT, alice.ethAddress, alice.privateKey)

    expect(notifications).toHaveLength(1)
    expect(notifications[0].payload.sender).toBe(bob.ethAddress)
  })

  it('multiple senders discoverable via polling', async () => {
    const alice = makeUser()
    const provider = createMockProvider()

    // Three different senders notify Alice
    const senders: ReturnType<typeof makeUser>[] = []
    for (let i = 0; i < 3; i++) {
      const sender = makeUser()
      senders.push(sender)
      const payload: NotificationPayload = {
        sender: sender.ethAddress,
      }
      await registry.sendNotification(provider, CONTRACT, alice.publicKey, alice.ethAddress, payload)
    }

    const notifications = await registry.pollNotifications(provider, CONTRACT, alice.ethAddress, alice.privateKey)
    expect(notifications).toHaveLength(3)
    expect(notifications[0].payload.sender).toBe(senders[0].ethAddress)
    expect(notifications[1].payload.sender).toBe(senders[1].ethAddress)
    expect(notifications[2].payload.sender).toBe(senders[2].ethAddress)
  })

  it('fromBlock filters old notifications', async () => {
    const alice = makeUser()
    const provider = createMockProvider()

    // Send two notifications (block 1 and block 2)
    const senders: ReturnType<typeof makeUser>[] = []
    for (let i = 0; i < 2; i++) {
      const sender = makeUser()
      senders.push(sender)
      await registry.sendNotification(
        provider,
        CONTRACT,
        alice.publicKey,
        alice.ethAddress,
        { sender: sender.ethAddress },
      )
    }

    // Poll from block 2 — should only get the second one
    const notifications = await registry.pollNotifications(provider, CONTRACT, alice.ethAddress, alice.privateKey, 2)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].payload.sender).toBe(senders[1].ethAddress)
  })
})

describe('end-to-end: discovery → messaging', () => {
  it('Bob discovers Alice via registry, then reads her message', async () => {
    const bee = new MockBee()
    const provider = createMockProvider()
    const alice = makeUser()
    const bob = makeUser()

    // 1. Both publish identities
    await identity.publish(bee as any, alice.ethAddress, STAMP, {
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: alice.beePublicKey,
      ethAddress: alice.ethAddress,
    })
    await identity.publish(bee as any, bob.ethAddress, STAMP, {
      walletPublicKey: bob.publicKeyHex,
      beePublicKey: bob.beePublicKey,
      ethAddress: bob.ethAddress,
    })

    // 2. Alice resolves Bob and sends a message
    const bobId = await identity.resolve(bee as any, bob.ethAddress)
    const bobContact = {
      ethAddress: bob.ethAddress.toLowerCase(),
      nickname: 'Bob',
      walletPublicKey: bobId!.walletPublicKey,
      beePublicKey: bobId!.beePublicKey,
      addedAt: Date.now(),
    }

    await mailbox.send(bee as any, alice.ethAddress, STAMP, alice.privateKey, alice.ethAddress, bobContact, {
      subject: 'Project files',
      body: 'Attached the latest version',
    })

    // 3. Alice sends on-chain notification to Bob (first contact)
    await registry.sendNotification(
      provider,
      CONTRACT,
      bob.publicKey,
      bob.ethAddress,
      { sender: alice.ethAddress },
    )

    // 4. Bob polls registry — discovers Alice
    const notifications = await registry.pollNotifications(provider, CONTRACT, bob.ethAddress, bob.privateKey)
    expect(notifications).toHaveLength(1)

    const discovered = notifications[0].payload
    expect(discovered.sender).toBe(alice.ethAddress)

    // 5. Bob resolves Alice's identity from discovered ETH address
    const aliceId = await identity.resolve(bee as any, discovered.sender)
    expect(aliceId).not.toBeNull()

    // 6. Bob reads messages from Alice
    const aliceContact = {
      ethAddress: discovered.sender.toLowerCase(),
      nickname: 'Alice',
      walletPublicKey: aliceId!.walletPublicKey,
      beePublicKey: aliceId!.beePublicKey,
      addedAt: Date.now(),
    }
    const messages = await mailbox.readMessages(bee as any, bob.privateKey, bob.ethAddress, aliceContact)

    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe('Project files')
    expect(messages[0].body).toBe('Attached the latest version')
  })
})
