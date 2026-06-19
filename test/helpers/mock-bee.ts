/**
 * In-memory Bee mock for integration tests.
 * Stores blobs and feed pointers in Maps so read-after-write works.
 *
 * Mailbox feeds are now APPEND-ONLY: each index is a separate slot, so the mock
 * keys references by `topic:owner:index` and tracks the latest index per feed
 * (to mimic bee-js `feedIndex` / `feedIndexNext` on a latest read). Identity
 * feeds still use the direct-payload path (single slot, no index).
 */

import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'

/** Minimal stand-in for bee-js FeedIndex (only `toBigInt` is used by the SDK). */
function feedIndex(n: number): { toBigInt: () => bigint } {
  return { toBigInt: () => BigInt(n) }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)

  return bytes
}

export class MockBee {
  /** Blob storage: reference → data */
  private blobs = new Map<string, Uint8Array>()
  /** Direct feed payloads (identity feeds): "topic:owner" → payload */
  private feedPayloads = new Map<string, Uint8Array>()
  /** Reference feeds (mailbox), per index: "topic:owner:index" → reference */
  private feedReferences = new Map<string, string>()
  /** Latest written index per mailbox feed: "topic:owner" → index */
  private feedLatestIndex = new Map<string, number>()

  /** Upload data blob. Returns a deterministic reference (hash of data). */
  async uploadData(_stamp: string, data: Uint8Array): Promise<{ reference: { toHex: () => string } }> {
    const ref = bytesToHex(keccak_256(data))
    this.blobs.set(ref, new Uint8Array(data))
    return { reference: { toHex: () => ref } }
  }

  /** Download a previously uploaded blob by reference. Returns a `Bytes`-like
   * (real bee-js returns a `Bytes` with `toUint8Array()`). */
  async downloadData(reference: string): Promise<{ toUint8Array: () => Uint8Array }> {
    const data = this.blobs.get(reference)
    if (!data) throw new Error(`Blob not found: ${reference}`)
    return { toUint8Array: () => new Uint8Array(data) }
  }

  /**
   * Create a feed writer for a topic + signer.
   * The signer is used as the owner address (simplified for testing).
   */
  makeFeedWriter(topic: string, signer: string | Uint8Array) {
    const ownerHex = (typeof signer === 'string'
      ? signer.replace('0x', '').slice(0, 40)
      : bytesToHex(signer).slice(0, 40)
    ).toLowerCase()

    const key = `${topic}:${ownerHex}`

    return {
      owner: { toHex: () => ownerHex },

      /** Upload raw payload to the feed (used by identity.publish — single slot). */
      uploadPayload: async (_stamp: string, payload: Uint8Array) => {
        this.feedPayloads.set(key, new Uint8Array(payload))
        return { reference: 'feed-' + key }
      },

      /** Upload a reference at a specific index (used by mailbox.send — append-only). */
      uploadReference: async (
        _stamp: string,
        reference: { toHex?: () => string } | string,
        opts?: { index?: number | { toBigInt: () => bigint } },
      ) => {
        const ref = typeof reference === 'string' ? reference : reference.toHex!()
        const index = opts?.index === undefined
          ? 0
          : typeof opts.index === 'number'
            ? opts.index
            : Number(opts.index.toBigInt())

        this.feedReferences.set(`${key}:${index}`, ref)

        const prev = this.feedLatestIndex.get(key)
        if (prev === undefined || index > prev) this.feedLatestIndex.set(key, index)

        return { reference: ref }
      },
    }
  }

  /**
   * Create a feed reader for a topic + owner address.
   * Honors an explicit `index`; with no index returns the latest update.
   */
  makeFeedReader(topic: string, address: string) {
    const ownerHex = address.replace('0x', '').toLowerCase()
    const key = `${topic}:${ownerHex}`

    // Resolve a mailbox feed index → its stored reference (or throw if absent).
    const resolveRef = (requested?: number) => {
      const latest = this.feedLatestIndex.get(key)
      const index = requested ?? latest
      if (index === undefined) throw new Error(`Feed not found: ${key}`)
      const ref = this.feedReferences.get(`${key}:${index}`)
      if (!ref) throw new Error(`Feed not found at index ${index}: ${key}`)
      const isLatest = latest !== undefined && index === latest

      return { ref, index, feedIndexNext: isLatest ? feedIndex(latest + 1) : undefined }
    }

    const toIndex = (opts?: { index?: number | { toBigInt: () => bigint } }) =>
      opts?.index === undefined
        ? undefined
        : typeof opts.index === 'number'
          ? opts.index
          : Number(opts.index.toBigInt())

    return {
      // Faithful to real bee-js: the no-index ("latest") read goes through the
      // /feeds endpoint and RESOLVES the reference to the content; an explicit
      // index read returns the raw single-owner-chunk payload (the reference
      // bytes), NOT the content. So mailbox reads must use downloadReference.
      downloadPayload: async (opts?: { index?: number | { toBigInt: () => bigint } }) => {
        const requested = toIndex(opts)

        // Identity feeds: direct single-slot payload (only on a no-index/latest read).
        if (requested === undefined) {
          const directPayload = this.feedPayloads.get(key)
          if (directPayload) {
            return {
              payload: { toUint8Array: () => new Uint8Array(directPayload) },
              feedIndex: feedIndex(0),
            }
          }
          // Mailbox: no-index resolves the latest reference to its content.
          const { ref, index, feedIndexNext } = resolveRef(undefined)
          const data = this.blobs.get(ref)
          if (!data) throw new Error(`Blob not found: ${ref}`)

          return { payload: { toUint8Array: () => new Uint8Array(data) }, feedIndex: feedIndex(index), feedIndexNext }
        }

        // Explicit index: return the RAW reference bytes (does NOT resolve) —
        // mirrors real bee-js so callers can't accidentally rely on resolution.
        const { ref, index, feedIndexNext } = resolveRef(requested)

        return { payload: { toUint8Array: () => hexToBytes(ref) }, feedIndex: feedIndex(index), feedIndexNext }
      },

      // Returns the reference stored at an index; the caller downloads it.
      downloadReference: async (opts?: { index?: number | { toBigInt: () => bigint } }) => {
        const { ref, index, feedIndexNext } = resolveRef(toIndex(opts))

        return { reference: ref, feedIndex: feedIndex(index), feedIndexNext }
      },
    }
  }

  /** Reset all stored data. */
  clear(): void {
    this.blobs.clear()
    this.feedPayloads.clear()
    this.feedReferences.clear()
    this.feedLatestIndex.clear()
  }
}
