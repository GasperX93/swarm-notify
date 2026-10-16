import { describe, it, expect, vi } from 'vitest'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import * as identity from '../src/identity'
import { send, readMessages } from '../src/mailbox'
import { makeFeedReader, makeFeedWriter, uploadData, downloadData } from '../src/bee-compat'
import { MockBee } from './helpers/mock-bee'
import type { Contact } from '../src/types'

const STAMP = 'stamp123'

/**
 * A bee-js 13-shaped Bee: only the namespaced calls exist (`feed.*`, `data.*`),
 * the old names are gone — exactly like a real bee-js 13 instance.
 */
function bee13(mock = new MockBee()) {
  return {
    feed: {
      makeReader: (topic: string, owner: string) => mock.makeFeedReader(topic, owner),
      makeWriter: (topic: string, signer: string | Uint8Array) =>
        mock.makeFeedWriter(topic, signer),
    },
    data: {
      upload: (stamp: string, data: Uint8Array) => mock.uploadData(stamp, data),
      download: (reference: string) => mock.downloadData(reference),
    },
  }
}

function makeKeypair() {
  const privateKey = secp.utils.randomPrivateKey()
  const publicKey = secp.getPublicKey(privateKey, true)
  return {
    privateKey,
    publicKeyHex: bytesToHex(publicKey),
    address: '0x' + bytesToHex(publicKey.slice(1, 21)),
  }
}

function makeContact(keypair: ReturnType<typeof makeKeypair>): Contact {
  return {
    ethAddress: keypair.address,
    nickname: 'Test',
    walletPublicKey: keypair.publicKeyHex,
    beePublicKey: '04' + 'cc'.repeat(32),
    addedAt: Date.now(),
  }
}

describe('bee-compat routing', () => {
  it('uses the bee-js 13 namespaces when present (and never the old names)', async () => {
    const makeReader = vi.fn().mockReturnValue('reader')
    const makeWriter = vi.fn().mockReturnValue('writer')
    const upload = vi.fn().mockResolvedValue('uploaded')
    const download = vi.fn().mockResolvedValue('downloaded')
    const old = vi.fn()
    const bee = {
      feed: { makeReader, makeWriter },
      data: { upload, download },
      makeFeedReader: old,
      makeFeedWriter: old,
      uploadData: old,
      downloadData: old,
    } as any

    expect(makeFeedReader(bee, 'topic', '0xowner')).toBe('reader')
    expect(makeFeedWriter(bee, 'topic', 'key')).toBe('writer')
    expect(await uploadData(bee, STAMP, new Uint8Array([1]), { deferred: false })).toBe('uploaded')
    expect(await downloadData(bee, 'ref')).toBe('downloaded')

    expect(makeReader).toHaveBeenCalledWith('topic', '0xowner')
    expect(makeWriter).toHaveBeenCalledWith('topic', 'key')
    expect(upload).toHaveBeenCalledWith(STAMP, new Uint8Array([1]), { deferred: false })
    expect(download).toHaveBeenCalledWith('ref')
    expect(old).not.toHaveBeenCalled()
  })

  it('falls back to the old names on a bee-js 12 Bee', async () => {
    const makeFeedReaderOld = vi.fn().mockReturnValue('reader')
    const makeFeedWriterOld = vi.fn().mockReturnValue('writer')
    const uploadDataOld = vi.fn().mockResolvedValue('uploaded')
    const downloadDataOld = vi.fn().mockResolvedValue('downloaded')
    const bee = {
      makeFeedReader: makeFeedReaderOld,
      makeFeedWriter: makeFeedWriterOld,
      uploadData: uploadDataOld,
      downloadData: downloadDataOld,
    } as any

    expect(makeFeedReader(bee, 'topic', '0xowner')).toBe('reader')
    expect(makeFeedWriter(bee, 'topic', 'key')).toBe('writer')
    expect(await uploadData(bee, STAMP, new Uint8Array([1]), { deferred: false })).toBe('uploaded')
    expect(await downloadData(bee, 'ref')).toBe('downloaded')
    expect(uploadDataOld).toHaveBeenCalledWith(STAMP, new Uint8Array([1]), { deferred: false })
  })
})

describe('SDK on a bee-js 13 Bee', () => {
  it('identity publish + resolve round-trip', async () => {
    const bee = bee13()
    const alice = makeKeypair()

    await identity.publish(bee as any, alice.address, STAMP, {
      walletPublicKey: alice.publicKeyHex,
      beePublicKey: '04' + 'aa'.repeat(32),
      ethAddress: alice.address,
    })
    const resolved = await identity.resolve(bee as any, alice.address)

    expect(resolved).not.toBeNull()
    expect(resolved!.walletPublicKey).toBe(alice.publicKeyHex)
  })

  it('mailbox send + read round-trip', async () => {
    const bee = bee13()
    const alice = makeKeypair()
    const bob = makeKeypair()

    await send(
      bee as any,
      alice.address,
      STAMP,
      alice.privateKey,
      alice.address,
      makeContact(bob),
      {
        subject: 'Hi',
        body: 'From bee-js 13',
      },
    )
    const messages = await readMessages(bee as any, bob.privateKey, bob.address, makeContact(alice))

    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('From bee-js 13')
  })
})
