/** Panel class — manages one identity's operations and UI updates. */

import { Bee } from '@ethersphere/bee-js'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { keccak_256 } from '@noble/hashes/sha3'

import * as identity from '@lib/identity'
import * as mailbox from '@lib/mailbox'
import * as registry from '@lib/registry'
import type { Contact, SwarmIdentity, NotifyProvider, Message, NotificationPayload } from '@lib/types'

import { short } from './log'

/** Derive ETH address from private key. */
function getEthAddress(privateKey: Uint8Array): string {
  const pubKey = secp.getPublicKey(privateKey, false)
  const hash = keccak_256(pubKey.slice(1))
  return '0x' + bytesToHex(hash.slice(12))
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(h.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export class Panel {
  readonly name: string
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
  readonly publicKeyHex: string
  readonly ethAddress: string
  otherPanel: Panel | null = null
  contact: Contact | null = null // the other party

  private logger: (msg: string) => void

  constructor(name: string, privateKey: Uint8Array, logger: (msg: string) => void) {
    this.name = name
    this.privateKey = privateKey
    this.publicKey = secp.getPublicKey(privateKey, true)
    this.publicKeyHex = bytesToHex(this.publicKey)
    this.ethAddress = getEthAddress(privateKey)
    this.logger = logger
  }

  /** Publish identity to Swarm feed. */
  async publishIdentity(bee: Bee, stamp: string): Promise<void> {
    const signerHex = '0x' + bytesToHex(this.privateKey)
    const swarmId: SwarmIdentity = {
      walletPublicKey: this.publicKeyHex,
      beePublicKey: this.publicKeyHex,
      ethAddress: this.ethAddress,
    }

    const topic = identity.feedTopic(this.ethAddress)
    this.logger(`Feed topic: <code>${short(topic)}</code>`)
    this.logger(`Publishing identity to Swarm...`)

    await identity.publish(bee, signerHex, stamp, swarmId)
    this.logger(`Identity published for <code>${short(this.ethAddress)}</code>`)
  }

  /** Resolve the other panel's identity from Swarm. */
  async resolveOther(bee: Bee): Promise<SwarmIdentity | null> {
    if (!this.otherPanel) throw new Error('Other panel not set')

    const otherAddr = this.otherPanel.ethAddress
    this.logger(`Resolving <code>${short(otherAddr)}</code>...`)

    const resolved = await identity.resolve(bee, otherAddr)
    if (!resolved) {
      this.logger(`No identity found for <code>${short(otherAddr)}</code>`)
      return null
    }

    // Construct Contact object directly (bypass contacts module to avoid localStorage collision)
    this.contact = {
      ethAddress: otherAddr.toLowerCase(),
      nickname: this.otherPanel.name,
      walletPublicKey: resolved.walletPublicKey,
      beePublicKey: resolved.beePublicKey,
      addedAt: Date.now(),
    }

    this.logger(`Resolved ${this.otherPanel.name}: pubKey=<code>${short(resolved.walletPublicKey)}</code>`)
    return resolved
  }

  /** Send an encrypted message to the other party. */
  async sendMessage(bee: Bee, stamp: string, subject: string, body: string): Promise<void> {
    if (!this.contact) throw new Error('Not ready')

    const signerHex = '0x' + bytesToHex(this.privateKey)
    const feedTopic = mailbox.feedTopic(this.ethAddress, this.contact.ethAddress)
    this.logger(`Mailbox feed topic: <code>${short(feedTopic)}</code>`)
    this.logger(`ECDH: deriving shared secret from ${this.name}'s privKey + ${this.contact.nickname}'s pubKey`)
    this.logger(`AES-256-GCM encrypting message...`)

    await mailbox.send(bee, signerHex, stamp, this.privateKey, this.ethAddress, this.contact, {
      subject,
      body,
    })

    this.logger(`Message sent: "${subject}"`)
  }

  /** Read messages from the other party's mailbox feed. */
  async readMessages(bee: Bee): Promise<Message[]> {
    if (!this.contact) throw new Error('Not ready')

    this.logger(`Reading ${this.contact.nickname}'s mailbox feed...`)
    this.logger(`ECDH: deriving shared secret from ${this.name}'s privKey + ${this.contact.nickname}'s pubKey`)

    const messages = await mailbox.readMessages(bee, this.privateKey, this.ethAddress, this.contact)

    if (messages.length === 0) {
      this.logger(`No messages from ${this.contact.nickname}`)
    } else {
      this.logger(`Decrypted ${messages.length} message(s) from ${this.contact.nickname}`)
      for (const msg of messages) {
        this.logger(`  AES-256-GCM decrypt: "${msg.subject}"`)
      }
    }

    return messages
  }

  /** Send an on-chain notification to the other party. */
  async sendNotification(provider: NotifyProvider, contractAddress: string): Promise<string> {
    if (!this.contact || !this.otherPanel) throw new Error('Not ready')

    const recipientPubKey = hexToBytes(this.contact.walletPublicKey)

    const payload: NotificationPayload = {
      sender: this.ethAddress,
    }

    this.logger(`ECIES-encrypting notification payload with ${this.contact.nickname}'s public key`)
    this.logger(`Sending tx to Gnosis Chain...`)

    const txHash = await registry.sendNotification(
      provider,
      contractAddress,
      recipientPubKey,
      this.contact.ethAddress,
      payload,
      this.privateKey,
    )

    this.logger(`Notification tx: <code>${short(txHash)}</code>`)
    return txHash
  }

  /** Poll for incoming notifications. */
  async pollNotifications(
    provider: NotifyProvider,
    contractAddress: string,
    fromBlock = 0,
  ): Promise<{ payload: NotificationPayload; blockNumber: number }[]> {
    this.logger(`Polling Gnosis Chain from block ${fromBlock}...`)

    const notifications = await registry.pollNotifications(
      provider,
      contractAddress,
      this.ethAddress,
      this.privateKey,
      fromBlock,
    )

    if (notifications.length === 0) {
      this.logger(`No notifications found`)
    } else {
      this.logger(`Found ${notifications.length} notification(s):`)
      for (const n of notifications) {
        this.logger(`  ECIES-decrypted: sender=<code>${short(n.payload.sender)}</code> at block ${n.blockNumber}`)
      }
    }

    return notifications
  }
}
