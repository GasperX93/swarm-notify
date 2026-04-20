import type { Bee } from '@ethersphere/bee-js'
import type { SwarmIdentity } from './types'

/**
 * Compute the deterministic feed topic for an identity feed.
 * Topic: keccak256("swarm-identity-" + ethAddress)
 */
export function feedTopic(_ethAddress: string): string {
  throw new Error('Not implemented')
}

/**
 * Publish identity to a Swarm feed. One-time operation (or when keys change).
 * @param signer - Private key hex string or Uint8Array for feed signing
 */
export async function publish(
  _bee: Bee,
  _signer: string | Uint8Array,
  _stamp: string,
  _identity: SwarmIdentity,
): Promise<void> {
  throw new Error('Not implemented')
}

/**
 * Resolve an identity by ETH address. Reads the feed at the deterministic topic.
 * Returns null if no identity feed found.
 */
export async function resolve(
  _bee: Bee,
  _ethAddress: string,
): Promise<SwarmIdentity | null> {
  throw new Error('Not implemented')
}
