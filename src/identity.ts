import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'
import type { Bee } from '@ethersphere/bee-js'
import type { SwarmIdentity } from './types'

const FEED_PREFIX = 'swarm-identity-'

/**
 * Compute the deterministic feed topic for an identity feed.
 * Topic: keccak256("swarm-identity-" + ethAddress)
 */
export function feedTopic(ethAddress: string): string {
  const input = new TextEncoder().encode(FEED_PREFIX + ethAddress.toLowerCase())
  return bytesToHex(keccak_256(input))
}

/**
 * Publish identity to a Swarm feed. One-time operation (or when keys change).
 * @param signer - Private key hex string or Uint8Array for feed signing
 */
export async function publish(
  bee: Bee,
  signer: string | Uint8Array,
  stamp: string,
  identity: SwarmIdentity,
): Promise<void> {
  const topic = feedTopic(identity.ethAddress ?? '')
  if (!identity.ethAddress) {
    throw new Error('ethAddress is required to publish an identity feed')
  }

  const payload = new TextEncoder().encode(
    JSON.stringify({
      walletPublicKey: identity.walletPublicKey,
      beePublicKey: identity.beePublicKey,
    }),
  )

  const writer = bee.makeFeedWriter(topic, signer)
  // deferred: false — push the identity to the network BEFORE returning.
  // On a light node a deferred upload stays local: the publisher's own node
  // resolves the feed (self-readback lies), while every other node gets
  // "Not Found" and lookups by address fail. Same bug class as the 0.5.2
  // "sent means sent" fix for message payloads — this was the missed path.
  await writer.uploadPayload(stamp, payload, { deferred: false })
}

/**
 * Resolve an identity by ETH address. Reads the feed at the deterministic topic.
 * Returns null if no identity feed found.
 */
export async function resolve(
  bee: Bee,
  ethAddress: string,
): Promise<SwarmIdentity | null> {
  const topic = feedTopic(ethAddress)

  // We need the feed owner address to create a reader.
  // For identity feeds, the owner IS the person whose identity we're looking up.
  // But we don't know their Bee node address — we only have their ETH address.
  // So we use fetchLatestFeedUpdate with the ETH address as owner.
  try {
    const reader = bee.makeFeedReader(topic, ethAddress)
    const result = await reader.downloadPayload()
    const text = new TextDecoder().decode(result.payload.toUint8Array())
    const data = JSON.parse(text)

    // Validate required fields
    if (!data.walletPublicKey || !data.beePublicKey) {
      return null
    }

    return {
      walletPublicKey: data.walletPublicKey,
      beePublicKey: data.beePublicKey,
      ethAddress: ethAddress.toLowerCase(),
    }
  } catch {
    // Feed not found or invalid data
    return null
  }
}
