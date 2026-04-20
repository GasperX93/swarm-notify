/**
 * NotifyProvider implementations for the CLI.
 *
 * - createReadOnlyProvider: raw fetch JSON-RPC (zero deps beyond Node 18+ fetch)
 * - createSigningProvider: ethers-based for transaction signing (devDependency)
 */

import type { NotifyProvider } from '../src/types'

/** JSON-RPC helper — makes a raw fetch call to an Ethereum JSON-RPC endpoint. */
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result
}

/**
 * Create a read-only NotifyProvider using raw fetch (no ethers dependency).
 * Supports getLogs and call. sendTransaction throws — use createSigningProvider for writes.
 */
export function createReadOnlyProvider(rpcUrl: string): NotifyProvider {
  return {
    async getLogs(filter) {
      const params = [
        {
          address: filter.address,
          topics: filter.topics,
          fromBlock: '0x' + filter.fromBlock.toString(16),
          toBlock: filter.toBlock === 'latest' || !filter.toBlock ? 'latest' : '0x' + filter.toBlock.toString(16),
        },
      ]
      const result = (await rpcCall(rpcUrl, 'eth_getLogs', params)) as {
        data: string
        blockNumber: string
      }[]
      return result.map((log) => ({
        data: log.data,
        blockNumber: parseInt(log.blockNumber, 16),
      }))
    },

    async call(tx) {
      return (await rpcCall(rpcUrl, 'eth_call', [tx, 'latest'])) as string
    },

    async sendTransaction() {
      throw new Error(
        'Read-only provider cannot send transactions. Use createSigningProvider() for write operations.',
      )
    },
  }
}

/**
 * Create a signing NotifyProvider using ethers (devDependency).
 * Supports all operations including sendTransaction.
 */
export function createSigningProvider(rpcUrl: string, privateKey: string): NotifyProvider {
  // Dynamic import — ethers is a devDependency, not in the library's runtime bundle
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JsonRpcProvider, Wallet } = require('ethers') as typeof import('ethers')
  const provider = new JsonRpcProvider(rpcUrl)
  const wallet = new Wallet(privateKey, provider)

  const readOnly = createReadOnlyProvider(rpcUrl)

  return {
    getLogs: readOnly.getLogs,
    call: readOnly.call,

    async sendTransaction(tx) {
      const response = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value || '0x0',
      })
      return response.hash
    },
  }
}
