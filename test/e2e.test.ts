/**
 * End-to-end tests against real infrastructure.
 *
 * Requires:
 * - Bee node running on BEE_URL (default http://localhost:1633) with a usable stamp
 * - Gnosis Chain RPC access
 * - Funded deployer wallet (DEPLOYER_PRIVATE_KEY in .env)
 *
 * Run with: npm run test:e2e
 * NOT included in default `npm test` — these are slow, cost gas, and need live services.
 */
import 'dotenv/config'
import { describe, it, expect, beforeAll } from 'vitest'
import { Bee } from '@ethersphere/bee-js'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { keccak_256 } from '@noble/hashes/sha3'

import * as identity from '../src/identity'
import * as mailbox from '../src/mailbox'
import * as registry from '../src/registry'
import type { NotifyProvider, NotificationPayload } from '../src/types'

// ─── Config from environment ────────────────────────────────────

const BEE_URL = process.env.BEE_URL || 'http://localhost:1633'
const GNOSIS_RPC_URL = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com'
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf'
const PRIVATE_KEY_HEX = process.env.DEPLOYER_PRIVATE_KEY || ''

// ─── Helpers ────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function getEthAddress(privateKey: Uint8Array): string {
  const pubKey = secp.getPublicKey(privateKey, false)
  const hash = keccak_256(pubKey.slice(1))
  return '0x' + bytesToHex(hash.slice(12))
}

/** Create a signing NotifyProvider using ethers. */
function createSigningProvider(rpcUrl: string, privateKey: string): NotifyProvider {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JsonRpcProvider, Wallet } = require('ethers') as typeof import('ethers')
  const provider = new JsonRpcProvider(rpcUrl)
  const wallet = new Wallet(privateKey, provider)

  return {
    async getLogs(filter) {
      const result = await provider.getLogs({
        address: filter.address,
        topics: filter.topics,
        fromBlock: filter.fromBlock,
        toBlock: filter.toBlock === 'latest' ? 'latest' : filter.toBlock,
      })
      return result.map((log) => ({
        data: log.data,
        blockNumber: log.blockNumber,
      }))
    },
    async call(tx) {
      return await provider.call(tx)
    },
    async sendTransaction(tx) {
      const response = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value || '0x0',
      })
      return response.hash
    },
  }
}

// ─── Test state ─────────────────────────────────────────────────

let bee: Bee
let stamp: string
let privateKey: Uint8Array
let ethAddress: string
let publicKeyHex: string
let overlay: string

// Two test identities — Alice (from DEPLOYER_PRIVATE_KEY) and Bob (generated)
let bobPrivateKey: Uint8Array
let bobPublicKeyHex: string
let bobEthAddress: string
let bobOverlay: string

beforeAll(async () => {
  // Validate environment
  if (!PRIVATE_KEY_HEX) {
    throw new Error('DEPLOYER_PRIVATE_KEY not set in .env — needed for E2E tests')
  }

  bee = new Bee(BEE_URL)

  // Check Bee health
  const health = await bee.isConnected()
  if (!health) {
    throw new Error(`Bee node not reachable at ${BEE_URL}`)
  }

  // Get a usable stamp
  const stamps = await bee.getAllPostageBatch()
  const usable = stamps.find((s) => s.usable)
  if (!usable) {
    throw new Error('No usable postage stamp on Bee node')
  }
  stamp = String(usable.batchID)

  // Alice's keys (from .env)
  privateKey = hexToBytes(PRIVATE_KEY_HEX)
  ethAddress = getEthAddress(privateKey)
  publicKeyHex = bytesToHex(secp.getPublicKey(privateKey, true))

  // Get overlay from Bee node
  const addresses = await bee.getNodeAddresses()
  overlay = String(addresses.overlay)

  // Bob's keys (generated)
  bobPrivateKey = secp.utils.randomPrivateKey()
  bobPublicKeyHex = bytesToHex(secp.getPublicKey(bobPrivateKey, true))
  bobEthAddress = getEthAddress(bobPrivateKey)
  bobOverlay = bytesToHex(keccak_256(secp.getPublicKey(bobPrivateKey, true))).slice(0, 32)

  console.log('E2E test config:')
  console.log(`  Bee:      ${BEE_URL}`)
  console.log(`  Stamp:    ${stamp.slice(0, 16)}...`)
  console.log(`  Alice:    ${ethAddress}`)
  console.log(`  Bob:      ${bobEthAddress}`)
  console.log(`  Contract: ${CONTRACT_ADDRESS}`)
}, 30000)

// ─── Identity tests (Bee node) ──────────────────────────────────

describe('identity: real Bee node', () => {
  it('publishes and resolves identity', async () => {
    const swarmIdentity = {
      walletPublicKey: publicKeyHex,
      beePublicKey: publicKeyHex,
      overlay,
      ethAddress,
    }

    // Publish Alice's identity (signer = private key, not ETH address)
    await identity.publish(bee, PRIVATE_KEY_HEX, stamp, swarmIdentity)

    // Resolve it back
    const resolved = await identity.resolve(bee, ethAddress)

    expect(resolved).not.toBeNull()
    expect(resolved!.walletPublicKey).toBe(publicKeyHex)
    expect(resolved!.overlay).toBe(overlay)
  }, 30000)

  it('returns null for non-existent identity', async () => {
    const fakeAddress = '0x' + '00'.repeat(20)
    const resolved = await identity.resolve(bee, fakeAddress)
    expect(resolved).toBeNull()
  }, 10000)
})

// ─── Mailbox tests (Bee node) ───────────────────────────────────

describe('mailbox: real Bee node', () => {
  it('sends a message and reads it back', async () => {
    // Create a contact for Bob (using generated keys)
    const bobContact = {
      ethAddress: bobEthAddress.toLowerCase(),
      nickname: 'Bob',
      walletPublicKey: bobPublicKeyHex,
      beePublicKey: bobPublicKeyHex,
      overlay: bobOverlay,
      addedAt: Date.now(),
    }

    // Alice sends a message to Bob (signer = private key hex)
    const testSubject = `E2E test ${Date.now()}`
    await mailbox.send(bee, PRIVATE_KEY_HEX, stamp, privateKey, overlay, bobContact, {
      subject: testSubject,
      body: 'End-to-end test message via real Bee node',
    })

    // Bob reads messages from Alice
    const aliceContact = {
      ethAddress: ethAddress.toLowerCase(),
      nickname: 'Alice',
      walletPublicKey: publicKeyHex,
      beePublicKey: publicKeyHex,
      overlay,
      addedAt: Date.now(),
    }
    const messages = await mailbox.readMessages(bee, bobPrivateKey, bobOverlay, aliceContact)

    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe(testSubject)
    expect(messages[0].body).toBe('End-to-end test message via real Bee node')
    expect(messages[0].v).toBe(1)
  }, 60000)
})

// ─── Registry tests (Gnosis Chain) ─────────────────────────────

describe('registry: real Gnosis Chain', () => {
  let notificationBlockNumber: number

  it('sends an on-chain notification', async () => {
    const provider = createSigningProvider(GNOSIS_RPC_URL, PRIVATE_KEY_HEX)

    const payload: NotificationPayload = {
      sender: ethAddress,
      overlay,
      feedTopic: mailbox.feedTopic(overlay, bobOverlay),
    }

    const txHash = await registry.sendNotification(
      provider,
      CONTRACT_ADDRESS,
      secp.getPublicKey(bobPrivateKey, true),
      bobEthAddress,
      payload,
      privateKey,
    )

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/)
    console.log(`  Notification tx: ${txHash}`)

    // Wait for tx to be mined
    const { JsonRpcProvider } = require('ethers') as typeof import('ethers')
    const ethProvider = new JsonRpcProvider(GNOSIS_RPC_URL)
    const receipt = await ethProvider.waitForTransaction(txHash, 1, 30000)
    expect(receipt).not.toBeNull()
    notificationBlockNumber = receipt!.blockNumber
    console.log(`  Mined in block: ${notificationBlockNumber}`)
  }, 60000)

  it('polls and discovers the notification', async () => {
    const provider = createSigningProvider(GNOSIS_RPC_URL, PRIVATE_KEY_HEX)

    // Bob polls from the block before the notification
    const fromBlock = notificationBlockNumber > 0 ? notificationBlockNumber - 1 : 0
    const notifications = await registry.pollNotifications(
      provider,
      CONTRACT_ADDRESS,
      bobEthAddress,
      bobPrivateKey,
      fromBlock,
    )

    expect(notifications.length).toBeGreaterThanOrEqual(1)

    // Find our notification
    const ours = notifications.find((n) => n.payload.sender === ethAddress)
    expect(ours).toBeDefined()
    expect(ours!.payload.overlay).toBe(overlay)
    expect(ours!.payload.feedTopic).toBe(mailbox.feedTopic(overlay, bobOverlay))
    expect(ours!.blockNumber).toBe(notificationBlockNumber)
  }, 30000)
})

// ─── Full flow (Bee + Gnosis Chain) ─────────────────────────────

describe('full E2E flow: identity → message → notification → discovery', () => {
  it('Alice publishes, sends message, notifies — Bob discovers and reads', async () => {
    const provider = createSigningProvider(GNOSIS_RPC_URL, PRIVATE_KEY_HEX)

    // Generate a fresh "Charlie" to avoid collisions with earlier tests
    const charliePrivateKey = secp.utils.randomPrivateKey()
    const charliePublicKeyHex = bytesToHex(secp.getPublicKey(charliePrivateKey, true))
    const charlieEthAddress = getEthAddress(charliePrivateKey)
    const charlieOverlay = bytesToHex(keccak_256(secp.getPublicKey(charliePrivateKey, true))).slice(0, 32)

    // 1. Ensure Alice's identity is published
    await identity.publish(bee, PRIVATE_KEY_HEX, stamp, {
      walletPublicKey: publicKeyHex,
      beePublicKey: publicKeyHex,
      overlay,
      ethAddress,
    })
    const aliceId = await identity.resolve(bee, ethAddress)
    expect(aliceId).not.toBeNull()

    // 2. Alice sends a message to Charlie
    const charlieContact = {
      ethAddress: charlieEthAddress.toLowerCase(),
      nickname: 'Charlie',
      walletPublicKey: charliePublicKeyHex,
      beePublicKey: charliePublicKeyHex,
      overlay: charlieOverlay,
      addedAt: Date.now(),
    }

    const testSubject = `Full flow ${Date.now()}`
    await mailbox.send(bee, PRIVATE_KEY_HEX, stamp, privateKey, overlay, charlieContact, {
      subject: testSubject,
      body: 'Full E2E flow test',
    })

    // 3. Alice sends on-chain notification to Charlie
    const feedTopic = mailbox.feedTopic(overlay, charlieOverlay)
    const txHash = await registry.sendNotification(
      provider,
      CONTRACT_ADDRESS,
      secp.getPublicKey(charliePrivateKey, true),
      charlieEthAddress,
      { sender: ethAddress, overlay, feedTopic },
      privateKey,
    )
    console.log(`  Full flow notification tx: ${txHash}`)

    // Wait for mining
    const { JsonRpcProvider } = require('ethers') as typeof import('ethers')
    const ethProvider = new JsonRpcProvider(GNOSIS_RPC_URL)
    const receipt = await ethProvider.waitForTransaction(txHash, 1, 30000)

    // 4. Charlie polls registry — discovers Alice
    const notifications = await registry.pollNotifications(
      provider,
      CONTRACT_ADDRESS,
      charlieEthAddress,
      charliePrivateKey,
      receipt!.blockNumber - 1,
    )

    expect(notifications.length).toBeGreaterThanOrEqual(1)
    const discovery = notifications.find((n) => n.payload.sender === ethAddress)
    expect(discovery).toBeDefined()

    // 5. Charlie resolves Alice's identity from discovered address
    const discoveredAlice = await identity.resolve(bee, discovery!.payload.sender)
    expect(discoveredAlice).not.toBeNull()
    expect(discoveredAlice!.walletPublicKey).toBe(publicKeyHex)

    // 6. Charlie reads messages from Alice
    const aliceContact = {
      ethAddress: ethAddress.toLowerCase(),
      nickname: 'Alice',
      walletPublicKey: discoveredAlice!.walletPublicKey,
      beePublicKey: discoveredAlice!.beePublicKey,
      overlay: discoveredAlice!.overlay,
      addedAt: Date.now(),
    }
    const messages = await mailbox.readMessages(bee, charliePrivateKey, charlieOverlay, aliceContact)

    expect(messages).toHaveLength(1)
    expect(messages[0].subject).toBe(testSubject)
    expect(messages[0].body).toBe('Full E2E flow test')

    console.log('  Full E2E flow passed: identity → message → notification → discovery → read')
  }, 120000)
})
