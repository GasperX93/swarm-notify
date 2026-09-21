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
 * Identity slots are forward-probed, never walked as a bee-js sequence feed.
 *
 * Why not a single pinned slot (the 2026-09-17 fix): SOC chunks are immutable
 * — the network keeps the FIRST payload ever written to an address. A pinned
 * index 0 therefore freezes the identity at its first publish; a reinstall
 * (new bee node key) can never update it, and the publisher's own node lies
 * about it on readback (its localstore serves the new chunk while every other
 * node serves the original — proven live 2026-09-21).
 *
 * Why not bee-js latest-index resolution (the pre-09-17 design): its walk
 * dies on any missing historic index, making the identity unresolvable even
 * when the newest update propagated fine.
 *
 * Forward-probe threads the needle: each update writes the next free index,
 * resolvers walk up from 0 and keep the LAST slot found. Updates are rare
 * (key changes on reinstall) and always direct-pushed, so holes are unlikely
 * — and a hole degrades to a stale-but-resolvable identity, never to
 * unresolvable. Old resolvers that only read index 0 keep working (stale).
 */
const MAX_IDENTITY_SLOTS = 32

function encodeIdentityPayload(identity: SwarmIdentity): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      walletPublicKey: identity.walletPublicKey,
      beePublicKey: identity.beePublicKey,
    }),
  )
}

/**
 * Publish identity to a Swarm feed. Idempotent: republishing an unchanged
 * identity writes nothing; a changed identity lands in the next free slot.
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

  const payload = encodeIdentityPayload(identity)
  const payloadText = new TextDecoder().decode(payload)

  const writer = bee.makeFeedWriter(topic, signer)
  const reader = bee.makeFeedReader(topic, identity.ethAddress)

  for (let index = 0; index < MAX_IDENTITY_SLOTS; index++) {
    let existing: string | null = null
    try {
      const result = await reader.downloadPayload({ index })
      existing = new TextDecoder().decode(result.payload.toUint8Array())
    } catch {
      // slot is free — publish here
    }

    if (existing === null) {
      // deferred: false — push the identity to the network BEFORE returning.
      // On a light node a deferred upload stays local: the publisher's own
      // node resolves the feed (self-readback lies), while every other node
      // gets "Not Found" and lookups by address fail.
      await writer.uploadPayload(stamp, payload, { deferred: false, index })
      return
    }

    if (existing === payloadText) {
      // Identity already published and unchanged — don't burn a slot.
      return
    }
  }

  throw new Error(`Identity feed is full (${MAX_IDENTITY_SLOTS} slots) — cannot publish an update`)
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

  // The feed owner IS the person being looked up — their ETH address signs
  // the feed, so it doubles as the reader's owner parameter.
  const reader = bee.makeFeedReader(topic, ethAddress)

  // Forward-probe (see publish): keep the LAST readable slot. A malformed
  // slot doesn't end the walk — later slots may hold a valid update — but
  // a missing slot does: publishes are sequential and direct-pushed, so the
  // first hole marks the end of the written range.
  let latest: SwarmIdentity | null = null

  for (let index = 0; index < MAX_IDENTITY_SLOTS; index++) {
    let text: string
    try {
      const result = await reader.downloadPayload({ index })
      text = new TextDecoder().decode(result.payload.toUint8Array())
    } catch {
      break
    }

    try {
      const data = JSON.parse(text)
      if (data.walletPublicKey && data.beePublicKey) {
        latest = {
          walletPublicKey: data.walletPublicKey,
          beePublicKey: data.beePublicKey,
          ethAddress: ethAddress.toLowerCase(),
        }
      }
    } catch {
      // malformed slot — skip, keep walking
    }
  }

  return latest
}
