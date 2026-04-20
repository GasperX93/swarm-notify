import type { Contact, SwarmIdentity } from './types'

const STORAGE_KEY = 'swarm-notify-contacts'

function readStore(): Contact[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function writeStore(contacts: Contact[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(contacts))
}

/**
 * Add a contact. Stores identity info locally for quick access.
 */
export function add(ethAddress: string, nickname: string, identity: SwarmIdentity): Contact {
  const contacts = readStore()
  const existing = contacts.find((c) => c.ethAddress.toLowerCase() === ethAddress.toLowerCase())
  if (existing) {
    throw new Error(`Contact already exists: ${ethAddress}`)
  }

  const contact: Contact = {
    ethAddress: ethAddress.toLowerCase(),
    nickname,
    walletPublicKey: identity.walletPublicKey,
    beePublicKey: identity.beePublicKey,
    overlay: identity.overlay,
    addedAt: Date.now(),
  }
  contacts.push(contact)
  writeStore(contacts)
  return contact
}

/**
 * Remove a contact by ETH address. Stops checking their feed.
 */
export function remove(ethAddress: string): void {
  const contacts = readStore()
  const filtered = contacts.filter((c) => c.ethAddress.toLowerCase() !== ethAddress.toLowerCase())
  writeStore(filtered)
}

/**
 * List all contacts.
 */
export function list(): Contact[] {
  return readStore()
}

/**
 * Update a contact's nickname or refresh cached identity keys.
 */
export function update(
  ethAddress: string,
  changes: Partial<Pick<Contact, 'nickname' | 'overlay' | 'walletPublicKey' | 'beePublicKey'>>,
): Contact {
  const contacts = readStore()
  const index = contacts.findIndex(
    (c) => c.ethAddress.toLowerCase() === ethAddress.toLowerCase(),
  )
  if (index === -1) {
    throw new Error(`Contact not found: ${ethAddress}`)
  }
  contacts[index] = { ...contacts[index], ...changes }
  writeStore(contacts)
  return contacts[index]
}
