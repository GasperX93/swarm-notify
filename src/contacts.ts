import type { Contact, SwarmIdentity } from './types'

/**
 * In-memory contact store. Host apps are responsible for persistence
 * (localStorage, file, database — whatever fits their platform).
 *
 * Usage:
 *   const store = new ContactStore()
 *   store.add('0x...', 'Alice', identity)
 *   const all = store.list()
 *
 * To persist, serialize with store.export() and restore with ContactStore.from(data).
 */
export class ContactStore {
  private contacts: Contact[] = []

  /**
   * Create a store from previously exported data (for persistence).
   */
  static from(data: Contact[]): ContactStore {
    const store = new ContactStore()
    store.contacts = [...data]
    return store
  }

  /**
   * Add a contact. Stores identity info for quick access.
   * Throws if contact already exists (case-insensitive ETH address match).
   */
  add(ethAddress: string, nickname: string, identity: SwarmIdentity): Contact {
    const existing = this.contacts.find(
      (c) => c.ethAddress.toLowerCase() === ethAddress.toLowerCase(),
    )
    if (existing) {
      throw new Error(`Contact already exists: ${ethAddress}`)
    }

    const contact: Contact = {
      ethAddress: ethAddress.toLowerCase(),
      nickname,
      walletPublicKey: identity.walletPublicKey,
      beePublicKey: identity.beePublicKey,
      addedAt: Date.now(),
    }
    this.contacts.push(contact)
    return contact
  }

  /**
   * Remove a contact by ETH address (case-insensitive).
   */
  remove(ethAddress: string): void {
    this.contacts = this.contacts.filter(
      (c) => c.ethAddress.toLowerCase() !== ethAddress.toLowerCase(),
    )
  }

  /**
   * List all contacts.
   */
  list(): Contact[] {
    return [...this.contacts]
  }

  /**
   * Update a contact's nickname or refresh cached identity keys.
   * Throws if contact not found.
   */
  update(
    ethAddress: string,
    changes: Partial<Pick<Contact, 'nickname' | 'walletPublicKey' | 'beePublicKey'>>,
  ): Contact {
    const index = this.contacts.findIndex(
      (c) => c.ethAddress.toLowerCase() === ethAddress.toLowerCase(),
    )
    if (index === -1) {
      throw new Error(`Contact not found: ${ethAddress}`)
    }
    this.contacts[index] = { ...this.contacts[index], ...changes }
    return this.contacts[index]
  }

  /**
   * Export contacts for persistence. Returns a plain array that can be
   * JSON.stringify'd and later restored with ContactStore.from().
   */
  export(): Contact[] {
    return [...this.contacts]
  }
}
