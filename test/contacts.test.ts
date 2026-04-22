import { describe, it, expect, beforeEach } from 'vitest'
import { ContactStore } from '../src/contacts'

const mockIdentity = {
  walletPublicKey: '02' + 'ab'.repeat(32),
  beePublicKey: '04' + 'cd'.repeat(32),
}

let store: ContactStore

beforeEach(() => {
  store = new ContactStore()
})

describe('add', () => {
  it('creates contact with all fields', () => {
    const contact = store.add('0x1234567890abcdef1234567890abcdef12345678', 'Alice', mockIdentity)

    expect(contact.ethAddress).toBe('0x1234567890abcdef1234567890abcdef12345678')
    expect(contact.nickname).toBe('Alice')
    expect(contact.walletPublicKey).toBe(mockIdentity.walletPublicKey)
    expect(contact.beePublicKey).toBe(mockIdentity.beePublicKey)
    expect(contact.addedAt).toBeGreaterThan(0)
  })

  it('throws on duplicate ethAddress', () => {
    store.add('0x1234567890abcdef1234567890abcdef12345678', 'Alice', mockIdentity)
    expect(() =>
      store.add('0x1234567890abcdef1234567890abcdef12345678', 'Alice2', mockIdentity),
    ).toThrow('Contact already exists')
  })

  it('duplicate check is case-insensitive', () => {
    store.add('0xabcdef1234567890abcdef1234567890abcdef12', 'Alice', mockIdentity)
    expect(() =>
      store.add('0xABCDEF1234567890ABCDEF1234567890ABCDEF12', 'Alice2', mockIdentity),
    ).toThrow('Contact already exists')
  })
})

describe('remove', () => {
  it('removes contact from list', () => {
    store.add('0x1111111111111111111111111111111111111111', 'Alice', mockIdentity)
    store.add('0x2222222222222222222222222222222222222222', 'Bob', mockIdentity)

    store.remove('0x1111111111111111111111111111111111111111')

    const contacts = store.list()
    expect(contacts).toHaveLength(1)
    expect(contacts[0].nickname).toBe('Bob')
  })
})

describe('list', () => {
  it('returns empty array when no contacts', () => {
    expect(store.list()).toEqual([])
  })

  it('returns all contacts', () => {
    store.add('0x1111111111111111111111111111111111111111', 'Alice', mockIdentity)
    store.add('0x2222222222222222222222222222222222222222', 'Bob', mockIdentity)

    expect(store.list()).toHaveLength(2)
  })

  it('returns a copy (mutations do not affect store)', () => {
    store.add('0x1111111111111111111111111111111111111111', 'Alice', mockIdentity)
    const list = store.list()
    list.pop()
    expect(store.list()).toHaveLength(1)
  })
})

describe('update', () => {
  it('updates nickname', () => {
    store.add('0x1111111111111111111111111111111111111111', 'Alice', mockIdentity)

    const updated = store.update('0x1111111111111111111111111111111111111111', {
      nickname: 'Alice Updated',
    })

    expect(updated.nickname).toBe('Alice Updated')
    expect(store.list()[0].nickname).toBe('Alice Updated')
  })

  it('throws if contact not found', () => {
    expect(() =>
      store.update('0x0000000000000000000000000000000000000000', { nickname: 'Nobody' }),
    ).toThrow('Contact not found')
  })
})

describe('export / from', () => {
  it('round-trips through export and from', () => {
    store.add('0x1111111111111111111111111111111111111111', 'Alice', mockIdentity)
    store.add('0x2222222222222222222222222222222222222222', 'Bob', mockIdentity)

    const exported = store.export()
    const restored = ContactStore.from(exported)

    expect(restored.list()).toHaveLength(2)
    expect(restored.list()[0].nickname).toBe('Alice')
    expect(restored.list()[1].nickname).toBe('Bob')
  })

  it('export returns a copy', () => {
    store.add('0x1111111111111111111111111111111111111111', 'Alice', mockIdentity)
    const exported = store.export()
    exported.pop()
    expect(store.list()).toHaveLength(1)
  })
})
