import { describe, it, expect, vi } from 'vitest'
import { feedTopic, publish, resolve } from '../src/identity'

describe('feedTopic', () => {
  it('deterministic for same ethAddress', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678'
    expect(feedTopic(addr)).toBe(feedTopic(addr))
  })

  it('case-insensitive (lowercased internally)', () => {
    const lower = '0xabcdef1234567890abcdef1234567890abcdef12'
    const upper = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'
    expect(feedTopic(lower)).toBe(feedTopic(upper))
  })

  it('different for different ethAddresses', () => {
    const addr1 = '0x1111111111111111111111111111111111111111'
    const addr2 = '0x2222222222222222222222222222222222222222'
    expect(feedTopic(addr1)).not.toBe(feedTopic(addr2))
  })

  it('returns 64 hex chars (32 bytes)', () => {
    const topic = feedTopic('0x1234567890abcdef1234567890abcdef12345678')
    expect(topic).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('publish', () => {
  it('throws if ethAddress is missing', async () => {
    const bee = {} as any
    await expect(
      publish(bee, '0x' + 'aa'.repeat(32), 'stamp123', {
        walletPublicKey: '02' + 'ab'.repeat(32),
        beePublicKey: '04' + 'cd'.repeat(32),
      }),
    ).rejects.toThrow('ethAddress is required')
  })

  const identity = {
    walletPublicKey: '02' + 'ab'.repeat(32),
    beePublicKey: '04' + 'cd'.repeat(32),
    ethAddress: '0x1234567890abcdef1234567890abcdef12345678',
  }

  const asPayload = (data: object) => ({
    payload: { toUint8Array: () => new TextEncoder().encode(JSON.stringify(data)) },
  })

  /** Feed reader whose slots are the given payloads; probes past them reject. */
  const readerWithSlots = (slots: object[]) =>
    vi.fn().mockImplementation(async ({ index }: { index: number }) => {
      if (index < slots.length) return asPayload(slots[index])
      throw new Error('Not found')
    })

  it('publishes to index 0 when the feed is empty', async () => {
    const uploadPayload = vi.fn().mockResolvedValue({ reference: 'abc123' })
    const makeFeedWriter = vi.fn().mockReturnValue({ uploadPayload })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload: readerWithSlots([]) })
    const bee = { makeFeedWriter, makeFeedReader } as any

    await publish(bee, '0x' + 'aa'.repeat(32), 'stamp123', identity)

    expect(makeFeedWriter).toHaveBeenCalledWith(
      feedTopic(identity.ethAddress),
      '0x' + 'aa'.repeat(32),
    )
    expect(uploadPayload).toHaveBeenCalledWith('stamp123', expect.any(Uint8Array), { deferred: false, index: 0 })

    // Verify the payload is valid JSON with the right fields
    const payload = uploadPayload.mock.calls[0][1]
    const parsed = JSON.parse(new TextDecoder().decode(payload))
    expect(parsed.walletPublicKey).toBe(identity.walletPublicKey)
    expect(parsed.beePublicKey).toBe(identity.beePublicKey)
  })

  it('publishes a CHANGED identity to the next free slot (reinstall case)', async () => {
    const oldIdentity = { walletPublicKey: identity.walletPublicKey, beePublicKey: '04' + 'ee'.repeat(32) }
    const uploadPayload = vi.fn().mockResolvedValue({ reference: 'abc123' })
    const makeFeedWriter = vi.fn().mockReturnValue({ uploadPayload })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload: readerWithSlots([oldIdentity]) })
    const bee = { makeFeedWriter, makeFeedReader } as any

    await publish(bee, '0x' + 'aa'.repeat(32), 'stamp123', identity)

    expect(uploadPayload).toHaveBeenCalledTimes(1)
    expect(uploadPayload).toHaveBeenCalledWith('stamp123', expect.any(Uint8Array), { deferred: false, index: 1 })
  })

  it('is idempotent — an unchanged identity writes nothing', async () => {
    const current = { walletPublicKey: identity.walletPublicKey, beePublicKey: identity.beePublicKey }
    const uploadPayload = vi.fn().mockResolvedValue({ reference: 'abc123' })
    const makeFeedWriter = vi.fn().mockReturnValue({ uploadPayload })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload: readerWithSlots([current]) })
    const bee = { makeFeedWriter, makeFeedReader } as any

    await publish(bee, '0x' + 'aa'.repeat(32), 'stamp123', identity)

    expect(uploadPayload).not.toHaveBeenCalled()
  })

  it('throws when every slot is occupied by a different identity', async () => {
    const stranger = { walletPublicKey: '02' + 'ff'.repeat(32), beePublicKey: '04' + 'ff'.repeat(32) }
    const uploadPayload = vi.fn()
    const makeFeedWriter = vi.fn().mockReturnValue({ uploadPayload })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload: readerWithSlots(Array(32).fill(stranger)) })
    const bee = { makeFeedWriter, makeFeedReader } as any

    await expect(publish(bee, '0x' + 'aa'.repeat(32), 'stamp123', identity)).rejects.toThrow('full')
    expect(uploadPayload).not.toHaveBeenCalled()
  })
})

describe('resolve', () => {
  it('returns identity when feed exists', async () => {
    const identityData = {
      walletPublicKey: '02' + 'ab'.repeat(32),
      beePublicKey: '04' + 'cd'.repeat(32),
    }
    const payload = new TextEncoder().encode(JSON.stringify(identityData))
    const downloadPayload = vi.fn().mockResolvedValue({
      payload: { toUint8Array: () => payload },
    })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload })
    const bee = { makeFeedReader } as any

    const ethAddress = '0x1234567890abcdef1234567890abcdef12345678'
    const result = await resolve(bee, ethAddress)

    expect(result).not.toBeNull()
    expect(result!.walletPublicKey).toBe(identityData.walletPublicKey)
    expect(result!.beePublicKey).toBe(identityData.beePublicKey)
    expect(result!.ethAddress).toBe(ethAddress.toLowerCase())
  })

  it('returns null when feed not found', async () => {
    const downloadPayload = vi.fn().mockRejectedValue(new Error('Not found'))
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload })
    const bee = { makeFeedReader } as any

    const result = await resolve(bee, '0x0000000000000000000000000000000000000000')
    expect(result).toBeNull()
  })

  it('returns null when feed has invalid data (missing fields)', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ walletPublicKey: '02abc' }))
    const downloadPayload = vi.fn().mockResolvedValue({
      payload: { toUint8Array: () => payload },
    })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload })
    const bee = { makeFeedReader } as any

    const result = await resolve(bee, '0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBeNull()
  })

  it('returns null when feed has invalid JSON', async () => {
    const payload = new TextEncoder().encode('not json')
    const downloadPayload = vi.fn().mockResolvedValue({
      payload: { toUint8Array: () => payload },
    })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload })
    const bee = { makeFeedReader } as any

    const result = await resolve(bee, '0x1234567890abcdef1234567890abcdef12345678')
    expect(result).toBeNull()
  })

  it('returns the LAST slot when the identity was updated (reinstall case)', async () => {
    const oldData = { walletPublicKey: '02' + 'ab'.repeat(32), beePublicKey: '04' + 'ee'.repeat(32) }
    const newData = { walletPublicKey: '02' + 'ab'.repeat(32), beePublicKey: '04' + 'cd'.repeat(32) }
    const encode = (d: object) => ({
      payload: { toUint8Array: () => new TextEncoder().encode(JSON.stringify(d)) },
    })
    const downloadPayload = vi.fn().mockImplementation(async ({ index }: { index: number }) => {
      if (index === 0) return encode(oldData)
      if (index === 1) return encode(newData)
      throw new Error('Not found')
    })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload })
    const bee = { makeFeedReader } as any

    const result = await resolve(bee, '0x1234567890abcdef1234567890abcdef12345678')
    expect(result!.beePublicKey).toBe(newData.beePublicKey)
  })

  it('skips a malformed slot but keeps walking to later valid slots', async () => {
    const newData = { walletPublicKey: '02' + 'ab'.repeat(32), beePublicKey: '04' + 'cd'.repeat(32) }
    const downloadPayload = vi.fn().mockImplementation(async ({ index }: { index: number }) => {
      if (index === 0) return { payload: { toUint8Array: () => new TextEncoder().encode('garbage') } }
      if (index === 1)
        return { payload: { toUint8Array: () => new TextEncoder().encode(JSON.stringify(newData)) } }
      throw new Error('Not found')
    })
    const makeFeedReader = vi.fn().mockReturnValue({ downloadPayload })
    const bee = { makeFeedReader } as any

    const result = await resolve(bee, '0x1234567890abcdef1234567890abcdef12345678')
    expect(result!.beePublicKey).toBe(newData.beePublicKey)
  })
})
