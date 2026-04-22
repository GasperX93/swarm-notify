#!/usr/bin/env node
/**
 * Minimal polling agent — a runnable template for autonomous agents.
 *
 * On startup: loads or generates a key, publishes identity.
 * Loop: polls for new notifications (new contacts), checks inbox, auto-responds.
 *
 * Usage:
 *   export BEE_URL=http://localhost:1633 STAMP=<batch-id>
 *   npx ts-node examples/agent/index.ts
 *
 * See docs/agent-integration.md for the full guide.
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { Bee } from '@ethersphere/bee-js'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { keccak_256 } from '@noble/hashes/sha3'

import * as identity from '../../src/identity'
import * as mailbox from '../../src/mailbox'
import * as registry from '../../src/registry'
import { ContactStore } from '../../src/contacts'
import type { Contact, Message, NotifyProvider } from '../../src/types'

// ─── Config ─────────────────────────────────────────────────────

const BEE_URL = process.env.BEE_URL || 'http://localhost:1633'
const STAMP = process.env.STAMP || ''
const GNOSIS_RPC = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com'
const CONTRACT = process.env.CONTRACT_ADDRESS || '0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf'
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '30000')
const DATA_DIR = path.resolve('./data/agent')

// ─── Persistence helpers ────────────────────────────────────────

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

function keyPath(): string { return path.join(DATA_DIR, 'key.json') }
function contactsPath(): string { return path.join(DATA_DIR, 'contacts.json') }
function blockPath(): string { return path.join(DATA_DIR, 'last-block.txt') }

// ─── Key management ─────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function deriveEthAddress(privateKey: Uint8Array): string {
  const pubKey = secp.getPublicKey(privateKey, false)
  const hash = keccak_256(pubKey.slice(1))
  return '0x' + bytesToHex(hash.slice(12))
}

function loadOrCreateKey(): { privateKey: Uint8Array; ethAddress: string; publicKeyHex: string } {
  if (fs.existsSync(keyPath())) {
    const { hex } = JSON.parse(fs.readFileSync(keyPath(), 'utf-8'))
    const privateKey = hexToBytes(hex)
    return {
      privateKey,
      ethAddress: deriveEthAddress(privateKey),
      publicKeyHex: bytesToHex(secp.getPublicKey(privateKey, true)),
    }
  }

  const privateKey = secp.utils.randomPrivateKey()
  fs.writeFileSync(keyPath(), JSON.stringify({ hex: bytesToHex(privateKey) }))
  return {
    privateKey,
    ethAddress: deriveEthAddress(privateKey),
    publicKeyHex: bytesToHex(secp.getPublicKey(privateKey, true)),
  }
}

// ─── Contact persistence ────────────────────────────────────────

function loadContacts(): ContactStore {
  try {
    return ContactStore.from(JSON.parse(fs.readFileSync(contactsPath(), 'utf-8')))
  } catch {
    return new ContactStore()
  }
}

function saveContacts(store: ContactStore): void {
  fs.writeFileSync(contactsPath(), JSON.stringify(store.export(), null, 2))
}

// ─── Block tracking ─────────────────────────────────────────────

function loadLastBlock(): number {
  try { return parseInt(fs.readFileSync(blockPath(), 'utf-8')) } catch { return 0 }
}

function saveLastBlock(block: number): void {
  fs.writeFileSync(blockPath(), String(block))
}

// ─── NotifyProvider (read-only, raw fetch) ──────────────────────

function createProvider(): NotifyProvider {
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(GNOSIS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const json = (await res.json()) as { result?: unknown; error?: { message: string } }
    if (json.error) throw new Error(`RPC: ${json.error.message}`)
    return json.result
  }

  return {
    async getLogs(filter) {
      const result = (await rpc('eth_getLogs', [{
        address: filter.address,
        topics: filter.topics,
        fromBlock: '0x' + filter.fromBlock.toString(16),
        toBlock: filter.toBlock === 'latest' || !filter.toBlock ? 'latest' : '0x' + filter.toBlock.toString(16),
      }])) as { data: string; blockNumber: string }[]
      return result.map(l => ({ data: l.data, blockNumber: parseInt(l.blockNumber, 16) }))
    },
    async call(tx) { return (await rpc('eth_call', [tx, 'latest'])) as string },
    async sendTransaction() { throw new Error('Read-only provider') },
  }
}

// ─── Message handler ────────────────────────────────────────────

async function handleMessage(
  bee: Bee,
  stamp: string,
  privateKey: Uint8Array,
  ethAddress: string,
  contact: Contact,
  msg: Message,
): Promise<void> {
  console.log(`  [${new Date(msg.ts).toLocaleTimeString()}] ${msg.subject}: ${msg.body}`)

  // Auto-respond (echo)
  if (!msg.subject.startsWith('ack:')) {
    console.log(`  → Auto-responding to ${contact.nickname}...`)
    try {
      await mailbox.send(
        bee, '0x' + bytesToHex(privateKey), stamp, privateKey, ethAddress, contact,
        { subject: `ack: ${msg.subject}`, body: `Received your message at ${new Date().toISOString()}` },
      )
    } catch (err) {
      console.warn(`  → Failed to respond: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// ─── Main loop ──────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDataDir()

  if (!STAMP) {
    console.error('STAMP env var is required. Set it to a usable postage batch ID.')
    process.exit(1)
  }

  const bee = new Bee(BEE_URL)
  const provider = createProvider()
  const { privateKey, ethAddress, publicKeyHex } = loadOrCreateKey()
  const signerHex = '0x' + bytesToHex(privateKey)

  console.log(`Agent ETH address: ${ethAddress}`)
  console.log(`Bee: ${BEE_URL} | Contract: ${CONTRACT}`)
  console.log(`Poll interval: ${POLL_INTERVAL / 1000}s`)

  // Publish identity on startup
  try {
    await identity.publish(bee, signerHex, STAMP, {
      walletPublicKey: publicKeyHex,
      beePublicKey: publicKeyHex,
      ethAddress,
    })
    console.log('Identity published.')
  } catch (err) {
    console.error('Failed to publish identity:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  const contacts = loadContacts()
  console.log(`Loaded ${contacts.list().length} contact(s). Polling...`)

  // Poll loop
  while (true) {
    try {
      // 1. Check for new contacts via registry
      const fromBlock = loadLastBlock()
      const notifications = await registry.pollNotifications(
        provider, CONTRACT, ethAddress, privateKey, fromBlock,
      )
      for (const { payload, blockNumber } of notifications) {
        console.log(`New contact: ${payload.sender} (block ${blockNumber})`)
        const id = await identity.resolve(bee, payload.sender)
        if (id) {
          try {
            contacts.add(payload.sender, payload.sender.slice(0, 10), id)
            saveContacts(contacts)
          } catch { /* already exists */ }
        }
        saveLastBlock(blockNumber + 1)
      }

      // 2. Check inbox across all contacts
      const allContacts = contacts.list()
      if (allContacts.length > 0) {
        const inbox = await mailbox.checkInbox(bee, privateKey, ethAddress, allContacts)
        for (const { contact, messages } of inbox) {
          console.log(`Messages from ${contact.nickname}:`)
          for (const msg of messages) {
            await handleMessage(bee, STAMP, privateKey, ethAddress, contact, msg)
          }
        }
      }
    } catch (err) {
      console.error('Poll error:', err instanceof Error ? err.message : err)
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
