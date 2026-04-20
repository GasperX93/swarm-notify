/** Browser-compatible NotifyProvider implementations. */

import type { NotifyProvider } from '@lib/types'

/** JSON-RPC helper using browser fetch. */
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

/** Read-only provider using raw fetch (no deps). */
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
      throw new Error('Read-only provider')
    },
  }
}

/** Signing provider using ethers (dynamic import for browser ESM). */
export function createSigningProvider(rpcUrl: string, privateKey: string): NotifyProvider {
  const readOnly = createReadOnlyProvider(rpcUrl)

  // Lazily initialized on first sendTransaction call
  let walletPromise: Promise<import('ethers').Wallet> | null = null

  async function getWallet() {
    if (!walletPromise) {
      walletPromise = import('ethers').then(({ JsonRpcProvider, Wallet }) => {
        const provider = new JsonRpcProvider(rpcUrl)
        return new Wallet(privateKey, provider)
      })
    }
    return walletPromise
  }

  return {
    getLogs: readOnly.getLogs,
    call: readOnly.call,
    async sendTransaction(tx) {
      const wallet = await getWallet()
      const response = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value || '0x0',
      })
      return response.hash
    },
  }
}
