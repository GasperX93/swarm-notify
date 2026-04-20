import type { Bee } from '@ethersphere/bee-js'
import type { Contact, Message } from './types'

/**
 * Compute the deterministic mailbox feed topic for a sender-recipient pair.
 * Topic: keccak256(senderOverlay + recipientOverlay + "swarm-notify")
 */
export function feedTopic(_senderOverlay: string, _recipientOverlay: string): string {
  throw new Error('Not implemented')
}

/**
 * Send an encrypted message to a contact.
 * @param signer - Private key hex string or Uint8Array for feed signing
 */
export async function send(
  _bee: Bee,
  _signer: string | Uint8Array,
  _stamp: string,
  _myPrivateKey: Uint8Array,
  _myOverlay: string,
  _recipient: Contact,
  _message: Omit<Message, 'v' | 'ts' | 'sender'>,
): Promise<void> {
  throw new Error('Not implemented')
}

/**
 * Read all messages from a specific contact's mailbox feed.
 */
export async function readMessages(
  _bee: Bee,
  _myPrivateKey: Uint8Array,
  _myOverlay: string,
  _contact: Contact,
): Promise<Message[]> {
  throw new Error('Not implemented')
}

/**
 * Check inbox across all contacts. Returns messages per contact.
 */
export async function checkInbox(
  _bee: Bee,
  _myPrivateKey: Uint8Array,
  _myOverlay: string,
  _contacts: Contact[],
): Promise<{ contact: Contact; messages: Message[] }[]> {
  throw new Error('Not implemented')
}
