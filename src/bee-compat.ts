import type { Bee } from '@ethersphere/bee-js'

/**
 * bee-js 13 moved Bee calls into namespaces (`bee.feed.makeReader`,
 * `bee.data.upload`, …) and removed the old names. The SDK runs on whatever
 * Bee instance the host app passes in, so it supports both: the namespaced
 * call when present (bee-js ≥ 13), the old name otherwise (bee-js ≤ 12).
 *
 * The feed reader/writer objects themselves (downloadPayload, downloadReference,
 * uploadPayload, uploadReference) are the same in both versions.
 */

type FeedReader = ReturnType<Bee['makeFeedReader']>
type FeedWriter = ReturnType<Bee['makeFeedWriter']>
type UploadResult = Awaited<ReturnType<Bee['uploadData']>>
type DownloadResult = Awaited<ReturnType<Bee['downloadData']>>

/** The bee-js 13 namespaces the SDK uses — absent on older Bee instances. */
interface Bee13 {
  feed?: {
    makeReader: (topic: string, owner: string) => FeedReader
    makeWriter: (topic: string, signer: string | Uint8Array) => FeedWriter
  }
  data?: {
    upload: (
      stamp: string,
      data: Uint8Array,
      options?: { deferred?: boolean },
    ) => Promise<UploadResult>
    download: (reference: Parameters<Bee['downloadData']>[0]) => Promise<DownloadResult>
  }
}

export function makeFeedReader(bee: Bee, topic: string, owner: string): FeedReader {
  const feed = (bee as unknown as Bee13).feed
  if (feed?.makeReader) return feed.makeReader(topic, owner)

  return bee.makeFeedReader(topic, owner)
}

export function makeFeedWriter(bee: Bee, topic: string, signer: string | Uint8Array): FeedWriter {
  const feed = (bee as unknown as Bee13).feed
  if (feed?.makeWriter) return feed.makeWriter(topic, signer)

  return bee.makeFeedWriter(topic, signer)
}

export function uploadData(
  bee: Bee,
  stamp: string,
  data: Uint8Array,
  options?: { deferred?: boolean },
): Promise<UploadResult> {
  const ns = (bee as unknown as Bee13).data
  if (ns?.upload) return ns.upload(stamp, data, options)

  return bee.uploadData(stamp, data, options)
}

export function downloadData(
  bee: Bee,
  reference: Parameters<Bee['downloadData']>[0],
): Promise<DownloadResult> {
  const ns = (bee as unknown as Bee13).data
  if (ns?.download) return ns.download(reference)

  return bee.downloadData(reference)
}
