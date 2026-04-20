import type { NotifyProvider, NotificationPayload } from './types'

/**
 * Compute the recipient hash for the registry.
 * Returns keccak256(ethAddress) as hex string.
 */
export function recipientHash(_ethAddress: string): string {
  throw new Error('Not implemented')
}

/**
 * Send an on-chain notification to a recipient.
 * ECIES-encrypts the payload and calls notify() on the registry contract.
 */
export async function sendNotification(
  _provider: NotifyProvider,
  _contractAddress: string,
  _recipientPublicKey: Uint8Array,
  _recipientEthAddress: string,
  _payload: NotificationPayload,
  _senderPrivateKey: Uint8Array,
): Promise<string> {
  throw new Error('Not implemented')
}

/**
 * Poll for new notifications addressed to me.
 * Queries eth_getLogs, ECIES-decrypts each payload, discards spam.
 */
export async function pollNotifications(
  _provider: NotifyProvider,
  _contractAddress: string,
  _myEthAddress: string,
  _myPrivateKey: Uint8Array,
  _fromBlock?: number,
): Promise<{ payload: NotificationPayload; blockNumber: number }[]> {
  throw new Error('Not implemented')
}
