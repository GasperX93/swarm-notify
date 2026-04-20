/**
 * In-memory Bee mock for integration tests.
 * Stores blobs and feed pointers in Maps so read-after-write works.
 */

import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'

export class MockBee {
  /** Blob storage: reference → data */
  private blobs = new Map<string, Uint8Array>()
  /** Feed storage: "topic:owner" → payload (Uint8Array) or reference (string) */
  private feedPayloads = new Map<string, Uint8Array>()
  private feedReferences = new Map<string, string>()

  /** Upload data blob. Returns a deterministic reference (hash of data). */
  async uploadData(_stamp: string, data: Uint8Array): Promise<{ reference: { toHex: () => string } }> {
    const ref = bytesToHex(keccak_256(data))
    this.blobs.set(ref, new Uint8Array(data))
    return { reference: { toHex: () => ref } }
  }

  /** Download a previously uploaded blob by reference. */
  async downloadData(reference: string): Promise<{ data: Uint8Array }> {
    const data = this.blobs.get(reference)
    if (!data) throw new Error(`Blob not found: ${reference}`)
    return { data: new Uint8Array(data) }
  }

  /**
   * Create a feed writer for a topic + signer.
   * The signer is used as the owner address (simplified for testing).
   */
  makeFeedWriter(topic: string, signer: string | Uint8Array) {
    const ownerHex = typeof signer === 'string'
      ? signer.replace('0x', '').slice(0, 40)
      : bytesToHex(signer).slice(0, 40)

    const key = `${topic}:${ownerHex}`

    return {
      owner: { toHex: () => ownerHex },

      /** Upload raw payload to the feed (used by identity.publish). */
      uploadPayload: async (_stamp: string, payload: Uint8Array) => {
        this.feedPayloads.set(key, new Uint8Array(payload))
        return { reference: 'feed-' + key }
      },

      /** Upload a reference to the feed (used by mailbox.send). */
      uploadReference: async (_stamp: string, reference: { toHex?: () => string } | string) => {
        const ref = typeof reference === 'string' ? reference : reference.toHex!()
        this.feedReferences.set(key, ref)
      },
    }
  }

  /**
   * Create a feed reader for a topic + owner address.
   * Returns the last payload or referenced blob.
   */
  makeFeedReader(topic: string, address: string) {
    const ownerHex = address.replace('0x', '').toLowerCase()
    const key = `${topic}:${ownerHex}`

    return {
      downloadPayload: async () => {
        // First check for direct payload (identity feeds)
        const directPayload = this.feedPayloads.get(key)
        if (directPayload) {
          return { payload: { toUint8Array: () => new Uint8Array(directPayload) } }
        }

        // Then check for reference-based payload (mailbox feeds)
        const ref = this.feedReferences.get(key)
        if (ref) {
          const data = this.blobs.get(ref)
          if (data) {
            return { payload: { toUint8Array: () => new Uint8Array(data) } }
          }
        }

        throw new Error(`Feed not found: ${key}`)
      },
    }
  }

  /** Reset all stored data. */
  clear(): void {
    this.blobs.clear()
    this.feedPayloads.clear()
    this.feedReferences.clear()
  }
}
