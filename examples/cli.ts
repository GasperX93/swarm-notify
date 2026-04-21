#!/usr/bin/env node
/**
 * Swarm Notify CLI — reference app for testing and demos.
 *
 * Usage: npx ts-node examples/cli.ts <command> [options]
 * Or:    npm run cli -- <command> [options]
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { Command } from 'commander'
import { Bee } from '@ethersphere/bee-js'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { keccak_256 } from '@noble/hashes/sha3'

import * as identity from '../src/identity'
import * as mailbox from '../src/mailbox'
import { ContactStore } from '../src/contacts'
import * as registry from '../src/registry'
import { createReadOnlyProvider, createSigningProvider } from './provider'

// ─── Contact persistence (file-based, CLI layer) ────────────────

const CONTACTS_FILE = path.resolve('./data/contacts.json')

function loadContacts(): ContactStore {
  try {
    const raw = fs.readFileSync(CONTACTS_FILE, 'utf-8')
    return ContactStore.from(JSON.parse(raw))
  } catch {
    return new ContactStore()
  }
}

function saveContacts(store: ContactStore): void {
  fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true })
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(store.export(), null, 2))
}

// ─── Config ─────────────────────────────────────────────────────

const BEE_URL = process.env.BEE_URL || 'http://localhost:1633'
const STAMP = process.env.STAMP || ''
const GNOSIS_RPC_URL = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com'
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf'

function getPrivateKey(): Uint8Array {
  const hex = process.env.PRIVATE_KEY
  if (!hex) {
    console.error('Error: PRIVATE_KEY env var is required. Set it in .env or export it.')
    process.exit(1)
  }
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function getPublicKeyHex(privateKey: Uint8Array): string {
  return bytesToHex(secp.getPublicKey(privateKey, true))
}

function getEthAddress(privateKey: Uint8Array): string {
  const pubKey = secp.getPublicKey(privateKey, false) // uncompressed
  const hash = keccak_256(pubKey.slice(1)) // remove 0x04 prefix
  return '0x' + bytesToHex(hash.slice(12)) // last 20 bytes
}

function requireStamp(): string {
  if (!STAMP) {
    console.error('Error: STAMP env var is required for write operations.')
    process.exit(1)
  }
  return STAMP
}

// ─── CLI ────────────────────────────────────────────────────────

const program = new Command()
program
  .name('swarm-notify')
  .description('CLI reference app for the Swarm Notify library')
  .version('0.1.0')

// ─── Identity ───────────────────────────────────────────────────

const identityCmd = program.command('identity').description('Publish and resolve identity feeds on Swarm (Layer 1)')

identityCmd
  .command('publish')
  .description('Publish your identity (public keys + overlay) to a Swarm feed. One-time setup — others can then discover you by ETH address.')
  .option('--overlay <hex>', 'Override overlay address (default: fetched from Bee node)')
  .action(async (opts) => {
    const privKey = getPrivateKey()
    const stamp = requireStamp()
    const bee = new Bee(BEE_URL)

    let overlay = opts.overlay
    if (!overlay) {
      try {
        const addresses = await bee.getNodeAddresses()
        overlay = String(addresses.overlay)
      } catch (e) {
        console.error('Could not fetch overlay from Bee node. Pass --overlay or check BEE_URL.')
        process.exit(1)
      }
    }

    const ethAddress = getEthAddress(privKey)
    const pubKeyHex = getPublicKeyHex(privKey)

    // Use ethAddress as signer for the feed
    await identity.publish(bee, ethAddress, stamp, {
      walletPublicKey: pubKeyHex,
      beePublicKey: pubKeyHex, // Using wallet key as bee key for CLI simplicity
      overlay,
      ethAddress,
    })

    console.log(`Identity published for ${ethAddress}`)
    console.log(`  walletPublicKey: ${pubKeyHex}`)
    console.log(`  overlay: ${overlay}`)
  })

identityCmd
  .command('resolve')
  .description('Look up someone\'s identity (public keys + overlay) from their Swarm feed')
  .argument('<ethAddress>', 'ETH address to look up')
  .action(async (ethAddress: string) => {
    const bee = new Bee(BEE_URL)
    const result = await identity.resolve(bee, ethAddress)

    if (!result) {
      console.log(`No identity found for ${ethAddress}`)
      return
    }

    console.log(`Identity for ${ethAddress}:`)
    console.log(JSON.stringify(result, null, 2))
  })

// ─── Contacts ───────────────────────────────────────────────────

const contactsCmd = program.command('contacts').description('Manage local address book (stored in ./data/contacts/)')

contactsCmd
  .command('add')
  .description('Add a contact — resolves their identity from Swarm, or pass keys manually with --wallet-pub and --overlay')
  .argument('<ethAddress>', 'ETH address')
  .argument('<nickname>', 'Display name')
  .option('--wallet-pub <hex>', 'Manually provide wallet public key (skip identity resolve)')
  .option('--bee-pub <hex>', 'Manually provide bee public key')
  .option('--overlay <hex>', 'Manually provide overlay address')
  .action(async (ethAddress: string, nickname: string, opts) => {
    let swarmId

    if (opts.walletPub && opts.overlay) {
      // Manual mode — no Bee node needed
      swarmId = {
        walletPublicKey: opts.walletPub,
        beePublicKey: opts.beePub || opts.walletPub,
        overlay: opts.overlay,
      }
    } else {
      // Resolve from Swarm
      const bee = new Bee(BEE_URL)
      const resolved = await identity.resolve(bee, ethAddress)
      if (!resolved) {
        console.error(`No identity found for ${ethAddress}. Use --wallet-pub and --overlay to add manually.`)
        process.exit(1)
      }
      swarmId = resolved
    }

    const store = loadContacts()
    const contact = store.add(ethAddress, nickname, swarmId)
    saveContacts(store)
    console.log(`Contact added: ${contact.nickname} (${contact.ethAddress})`)
  })

contactsCmd
  .command('remove')
  .description('Remove a contact')
  .argument('<ethAddress>', 'ETH address')
  .action((ethAddress: string) => {
    const store = loadContacts()
    store.remove(ethAddress)
    saveContacts(store)
    console.log(`Contact removed: ${ethAddress}`)
  })

contactsCmd
  .command('list')
  .description('List all contacts')
  .action(() => {
    const all = loadContacts().list()
    if (all.length === 0) {
      console.log('No contacts.')
      return
    }
    for (const c of all) {
      console.log(`  ${c.nickname} — ${c.ethAddress} (overlay: ${c.overlay.slice(0, 16)}...)`)
    }
  })

// ─── Mailbox ────────────────────────────────────────────────────

const mailboxCmd = program.command('mailbox').description('Send and receive E2E encrypted messages via Swarm feeds (Layer 2)')

mailboxCmd
  .command('send')
  .description('Send an ECDH+AES-256-GCM encrypted message to a contact via their Swarm mailbox feed')
  .argument('<ethAddress>', 'Recipient ETH address (must be in contacts)')
  .requiredOption('-s, --subject <text>', 'Message subject')
  .requiredOption('-b, --body <text>', 'Message body')
  .action(async (ethAddress: string, opts) => {
    const privKey = getPrivateKey()
    const stamp = requireStamp()
    const bee = new Bee(BEE_URL)

    const myAddress = getEthAddress(privKey)
    let myOverlay: string
    try {
      const addresses = await bee.getNodeAddresses()
      myOverlay = String(addresses.overlay)
    } catch {
      console.error('Could not fetch overlay from Bee node. Check BEE_URL.')
      process.exit(1)
    }

    const contact = loadContacts().list().find((c) => c.ethAddress.toLowerCase() === ethAddress.toLowerCase())
    if (!contact) {
      console.error(`Contact not found: ${ethAddress}. Add them first with 'contacts add'.`)
      process.exit(1)
    }

    await mailbox.send(bee, myAddress, stamp, privKey, myOverlay, contact, {
      subject: opts.subject,
      body: opts.body,
    })

    console.log(`Message sent to ${contact.nickname} (${contact.ethAddress})`)
  })

mailboxCmd
  .command('read')
  .description('Read messages from a specific contact')
  .argument('<ethAddress>', 'Contact ETH address')
  .action(async (ethAddress: string) => {
    const privKey = getPrivateKey()
    const bee = new Bee(BEE_URL)

    let myOverlay: string
    try {
      const addresses = await bee.getNodeAddresses()
      myOverlay = String(addresses.overlay)
    } catch {
      console.error('Could not fetch overlay from Bee node. Check BEE_URL.')
      process.exit(1)
    }

    const contact = loadContacts().list().find((c) => c.ethAddress.toLowerCase() === ethAddress.toLowerCase())
    if (!contact) {
      console.error(`Contact not found: ${ethAddress}`)
      process.exit(1)
    }

    const messages = await mailbox.readMessages(bee, privKey, myOverlay, contact)

    if (messages.length === 0) {
      console.log(`No messages from ${contact.nickname}.`)
      return
    }

    for (const msg of messages) {
      const date = new Date(msg.ts).toLocaleString()
      console.log(`\n[${date}] ${msg.subject}`)
      console.log(`  ${msg.body}`)
    }
  })

mailboxCmd
  .command('inbox')
  .description('Check inbox across all contacts')
  .action(async () => {
    const privKey = getPrivateKey()
    const bee = new Bee(BEE_URL)

    let myOverlay: string
    try {
      const addresses = await bee.getNodeAddresses()
      myOverlay = String(addresses.overlay)
    } catch {
      console.error('Could not fetch overlay from Bee node. Check BEE_URL.')
      process.exit(1)
    }

    const allContacts = loadContacts().list()
    if (allContacts.length === 0) {
      console.log('No contacts. Add some first.')
      return
    }

    const inbox = await mailbox.checkInbox(bee, privKey, myOverlay, allContacts)

    if (inbox.length === 0) {
      console.log('No new messages.')
      return
    }

    for (const { contact, messages } of inbox) {
      console.log(`\n── ${contact.nickname} (${messages.length} message${messages.length > 1 ? 's' : ''}) ──`)
      for (const msg of messages) {
        const date = new Date(msg.ts).toLocaleString()
        console.log(`  [${date}] ${msg.subject}`)
        console.log(`    ${msg.body}`)
      }
    }
  })

// ─── Registry ───────────────────────────────────────────────────

const registryCmd = program.command('registry').description('On-chain notification registry on Gnosis Chain (Layer 3) — for first-contact discovery')

registryCmd
  .command('notify')
  .description('Send ECIES-encrypted first-contact notification on Gnosis Chain (~22k gas). Only needed once per new contact.')
  .argument('<ethAddress>', 'Recipient ETH address (must be in contacts)')
  .action(async (ethAddress: string) => {
    const privKey = getPrivateKey()
    const provider = createSigningProvider(GNOSIS_RPC_URL, '0x' + bytesToHex(privKey))

    let myOverlay: string
    try {
      const bee = new Bee(BEE_URL)
      const addresses = await bee.getNodeAddresses()
      myOverlay = String(addresses.overlay)
    } catch {
      console.error('Could not fetch overlay from Bee node. Check BEE_URL.')
      process.exit(1)
    }

    const contact = loadContacts().list().find((c) => c.ethAddress.toLowerCase() === ethAddress.toLowerCase())
    if (!contact) {
      console.error(`Contact not found: ${ethAddress}. Add them first.`)
      process.exit(1)
    }

    const myAddress = getEthAddress(privKey)
    const feedTopic = mailbox.feedTopic(myOverlay, contact.overlay)
    const recipientPubKey = hexToBytes(contact.walletPublicKey)

    const txHash = await registry.sendNotification(
      provider,
      CONTRACT_ADDRESS,
      recipientPubKey,
      contact.ethAddress,
      { sender: myAddress, overlay: myOverlay, feedTopic },
      privKey,
    )

    console.log(`Notification sent to ${contact.nickname}`)
    console.log(`  tx: ${txHash}`)
  })

registryCmd
  .command('poll')
  .description('Poll Gnosis Chain for incoming notifications — discovers new contacts who messaged you')
  .option('--from-block <n>', 'Start block (default: 0)', '0')
  .action(async (opts) => {
    const privKey = getPrivateKey()
    const myAddress = getEthAddress(privKey)
    const provider = createReadOnlyProvider(GNOSIS_RPC_URL)
    const fromBlock = parseInt(opts.fromBlock)

    console.log(`Polling notifications for ${myAddress} from block ${fromBlock}...`)

    const notifications = await registry.pollNotifications(provider, CONTRACT_ADDRESS, myAddress, privKey, fromBlock)

    if (notifications.length === 0) {
      console.log('No notifications found.')
      return
    }

    console.log(`Found ${notifications.length} notification(s):`)
    for (const n of notifications) {
      console.log(`\n  Block ${n.blockNumber}:`)
      console.log(`    sender:    ${n.payload.sender}`)
      console.log(`    overlay:   ${n.payload.overlay}`)
      console.log(`    feedTopic: ${n.payload.feedTopic}`)
    }
  })

// ─── Helpers ────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// ─── Run ────────────────────────────────────────────────────────

program.parse()
