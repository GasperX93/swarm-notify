/** Main entry point — initializes the demo UI. */

// Polyfill SharedArrayBuffer if not available (needed by crypto module's toBuffer guard).
// In non-crossOriginIsolated contexts, SharedArrayBuffer is undefined and instanceof throws.
if (typeof SharedArrayBuffer === 'undefined') {
  (globalThis as any).SharedArrayBuffer = class SharedArrayBuffer {
    constructor() {
      throw new Error('SharedArrayBuffer not supported')
    }
  }
}

import { Bee } from '@ethersphere/bee-js'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import * as identityModule from '@lib/identity'

import { Panel } from './panel'
import { logAlice, logBob, logSystem, clearLog, short } from './log'
import { createReadOnlyProvider, createSigningProvider } from './provider'

// ─── State ──────────────────────────────────────────────────────

let bee: Bee
let stamp: string
let contractAddress: string
let rpcUrl: string
let fundedKey: string // optional funded private key for on-chain ops
let alice: Panel
let bob: Panel

// ─── UI Helpers ─────────────────────────────────────────────────

function $(id: string): HTMLElement {
  return document.getElementById(id)!
}

function setResult(id: string, html: string, cls: 'success' | 'error' | 'info' = 'info'): void {
  const el = $(id)
  el.innerHTML = html
  el.className = `result ${cls}`
}

function renderMessages(containerId: string, messages: { subject: string; body: string; ts: number; sender: string }[]): void {
  const el = $(containerId)
  if (messages.length === 0) {
    el.innerHTML = '<span class="result info">No messages yet.</span>'
    return
  }
  el.innerHTML = messages
    .map(
      (m) => `<div class="message">
        <div class="msg-time">${new Date(m.ts).toLocaleTimeString()}</div>
        <div class="msg-subject">${escapeHtml(m.subject)}</div>
        <div class="msg-body">${escapeHtml(m.body)}</div>
      </div>`,
    )
    .join('')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function withLoading(btnId: string, fn: () => Promise<void>, resultId?: string): Promise<void> {
  const btn = $(btnId) as HTMLButtonElement
  btn.classList.add('loading')
  btn.disabled = true
  try {
    await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logSystem(`Error: ${msg}`)
    if (resultId) setResult(resultId, `Error: ${escapeHtml(msg)}`, 'error')
  } finally {
    btn.classList.remove('loading')
    btn.disabled = false
  }
}

function enableButtons(...ids: string[]): void {
  for (const id of ids) {
    ($(id) as HTMLButtonElement).disabled = false
  }
}

function enableInputs(...ids: string[]): void {
  for (const id of ids) {
    ($(id) as HTMLInputElement).disabled = false
  }
}

// ─── Auto-fetch stamp ───────────────────────────────────────────

async function autoFetchStamp(beeUrl: string): Promise<void> {
  try {
    const res = await fetch(`${beeUrl}/stamps`)
    const data = (await res.json()) as { stamps?: { batchID: string; usable: boolean }[] }
    const usable = data.stamps?.find((s) => s.usable)
    if (usable) {
      const stampInput = $('cfg-stamp') as HTMLInputElement
      if (!stampInput.value) {
        stampInput.value = usable.batchID
        logSystem(`Auto-detected stamp: <code>${short(usable.batchID)}</code>`)
      }
    }
  } catch {
    // Bee not reachable yet, that's fine
  }
}

// Try to auto-detect stamp on page load
autoFetchStamp(($('cfg-bee') as HTMLInputElement).value)

// ─── Initialize ─────────────────────────────────────────────────

$('btn-init').addEventListener('click', async () => {
  const beeUrl = ($('cfg-bee') as HTMLInputElement).value
  stamp = ($('cfg-stamp') as HTMLInputElement).value
  contractAddress = ($('cfg-contract') as HTMLInputElement).value
  rpcUrl = ($('cfg-rpc') as HTMLInputElement).value
  fundedKey = ($('cfg-funded-key') as HTMLInputElement).value

  // Auto-fetch stamp if not provided
  if (!stamp) {
    await autoFetchStamp(beeUrl)
    stamp = ($('cfg-stamp') as HTMLInputElement).value
  }

  if (!stamp) {
    ($('init-status') as HTMLElement).textContent = 'No usable stamp found. Buy one or paste a batch ID.'
    ($('init-status') as HTMLElement).style.color = 'var(--error)'
    return
  }

  try {
    bee = new Bee(beeUrl)
    const health = await bee.isConnected()
    if (!health) throw new Error('Bee not connected')
  } catch {
    ($('init-status') as HTMLElement).textContent = `Cannot connect to Bee at ${beeUrl}`
    ($('init-status') as HTMLElement).style.color = 'var(--error)'
    return
  }

  // Generate two random key pairs
  const alicePrivKey = secp.utils.randomPrivateKey()
  const bobPrivKey = secp.utils.randomPrivateKey()

  alice = new Panel('Alice', alicePrivKey, logAlice)
  bob = new Panel('Bob', bobPrivKey, logBob)
  alice.otherPanel = bob
  bob.otherPanel = alice

  // Display identity info with full addresses
  $('alice-eth').textContent = alice.ethAddress
  $('alice-pub').textContent = short(alice.publicKeyHex, 12)
  $('bob-eth').textContent = bob.ethAddress
  $('bob-pub').textContent = short(bob.publicKeyHex, 12)

  logSystem('Demo initialized. Two fresh identities generated.')
  logSystem(`Bee node: ${beeUrl} | Contract: <code>${short(contractAddress)}</code>`)
  logSystem(`In this demo, both identities share the same Bee node. In production, each user runs their own node.`)

  // Enable step 1 buttons
  enableButtons('alice-publish', 'bob-publish')
  ;($('init-status') as HTMLElement).textContent = 'Connected!'
  ;($('init-status') as HTMLElement).style.color = 'var(--success)'
})

// ─── Step 1: Publish Identity ───────────────────────────────────

$('alice-publish').addEventListener('click', () =>
  withLoading('alice-publish', async () => {
    await alice.publishIdentity(bee, stamp)
    const topic = identityModule.feedTopic(alice.ethAddress)
    setResult(
      'alice-publish-result',
      `Published!<br/>Feed topic: <code>${short(topic)}</code><br/>ETH address: <code>${alice.ethAddress}</code><br/><small>Share this address with Bob so he can discover you.</small>`,
      'success',
    )
    enableButtons('bob-resolve')
  }, 'alice-publish-result'),
)

$('bob-publish').addEventListener('click', () =>
  withLoading('bob-publish', async () => {
    await bob.publishIdentity(bee, stamp)
    const topic = identityModule.feedTopic(bob.ethAddress)
    setResult(
      'bob-publish-result',
      `Published!<br/>Feed topic: <code>${short(topic)}</code><br/>ETH address: <code>${bob.ethAddress}</code><br/><small>Share this address with Alice so she can discover you.</small>`,
      'success',
    )
    enableButtons('alice-resolve')
  }, 'bob-publish-result'),
)

// ─── Step 2: Resolve ────────────────────────────────────────────

$('alice-resolve').addEventListener('click', () =>
  withLoading('alice-resolve', async () => {
    const resolved = await alice.resolveOther(bee)
    if (resolved) {
      setResult(
        'alice-resolve-result',
        `Found Bob!<br/>PubKey: <code>${short(resolved.walletPublicKey, 12)}</code>`,
        'success',
      )
      enableButtons('alice-send', 'alice-notify', 'alice-inbox')
      enableInputs('alice-msg-subject', 'alice-msg-body')
    } else {
      setResult('alice-resolve-result', 'Not found. Publish Bob\'s identity first.', 'error')
    }
  }, 'alice-resolve-result'),
)

$('bob-resolve').addEventListener('click', () =>
  withLoading('bob-resolve', async () => {
    const resolved = await bob.resolveOther(bee)
    if (resolved) {
      setResult(
        'bob-resolve-result',
        `Found Alice!<br/>PubKey: <code>${short(resolved.walletPublicKey, 12)}</code>`,
        'success',
      )
      enableButtons('bob-send', 'bob-read', 'bob-poll')
      enableInputs('bob-msg-subject', 'bob-msg-body')
    } else {
      setResult('bob-resolve-result', 'Not found. Publish Alice\'s identity first.', 'error')
    }
  }, 'bob-resolve-result'),
)

// ─── Step 3: Send Message ───────────────────────────────────────

$('alice-send').addEventListener('click', () =>
  withLoading('alice-send', async () => {
    const subject = ($('alice-msg-subject') as HTMLInputElement).value || 'Hello Bob'
    const body = ($('alice-msg-body') as HTMLTextAreaElement).value || 'First message from Alice!'

    await alice.sendMessage(bee, stamp, subject, body)
    setResult('alice-send-result', `Sent: "${escapeHtml(subject)}"`, 'success')
    enableButtons('bob-read')
  }, 'alice-send-result'),
)

// ─── Step 4: Read Messages ──────────────────────────────────────

$('bob-read').addEventListener('click', () =>
  withLoading('bob-read', async () => {
    const messages = await bob.readMessages(bee)
    renderMessages('bob-read-result', messages)
  }, 'bob-read-result'),
)

// ─── Step 5: Send Notification ──────────────────────────────────

$('alice-notify').addEventListener('click', () =>
  withLoading('alice-notify', async () => {
    // Use funded key if provided, otherwise Alice's random key
    const signingKey = fundedKey || ('0x' + bytesToHex(alice.privateKey))
    if (!fundedKey) {
      logAlice('No funded key provided — using Alice\'s random key (likely has no xDAI)')
    } else {
      logAlice('Using funded key for on-chain transaction')
    }

    const provider = createSigningProvider(rpcUrl, signingKey)
    setResult('alice-notify-result', 'Sending tx to Gnosis Chain...', 'info')

    try {
      const txHash = await alice.sendNotification(provider, contractAddress)
      setResult('alice-notify-result', `Tx: <code>${short(txHash)}</code><br/>Waiting for confirmation (this may take up to 2 minutes)...`, 'info')

      // Wait for mining — Gnosis Chain blocks are ~5s but RPC can be slow
      logAlice('Waiting for tx to be mined (up to 2 min)...')
      const { JsonRpcProvider } = await import('ethers')
      const ethProvider = new JsonRpcProvider(rpcUrl)
      try {
        const receipt = await ethProvider.waitForTransaction(txHash, 1, 120000)
        if (receipt) {
          setResult(
            'alice-notify-result',
            `Tx: <code>${short(txHash)}</code><br/>Block: ${receipt.blockNumber}<br/>Gas: ${receipt.gasUsed.toString()}`,
            'success',
          )
          logAlice(`Mined in block ${receipt.blockNumber} (${receipt.gasUsed.toString()} gas)`)
        }
      } catch (waitErr) {
        // Timeout waiting for confirmation — tx was sent but confirmation slow
        setResult(
          'alice-notify-result',
          `Tx sent: <code>${short(txHash)}</code><br/>Confirmation timed out — the tx is likely pending. Bob can try polling.`,
          'info',
        )
        logAlice(`Confirmation timed out for ${short(txHash)} — tx may still be pending`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('INSUFFICIENT_FUNDS') || msg.includes('insufficient funds')) {
        setResult(
          'alice-notify-result',
          'Insufficient funds. Paste a funded private key (with xDAI on Gnosis Chain) in the "Funded Key" config field above, then re-initialize.',
          'error',
        )
        logAlice('Transaction failed: wallet has no xDAI on Gnosis Chain')
      } else {
        setResult('alice-notify-result', `Error: ${escapeHtml(msg)}`, 'error')
      }
      throw err // re-throw so withLoading also logs it
    }
  }, 'alice-notify-result'),
)

// ─── Step 6: Poll Notifications ─────────────────────────────────

$('bob-poll').addEventListener('click', () =>
  withLoading('bob-poll', async () => {
    const provider = createReadOnlyProvider(rpcUrl)
    const notifications = await bob.pollNotifications(provider, contractAddress)

    if (notifications.length === 0) {
      setResult('bob-poll-result', 'No notifications found.', 'info')
    } else {
      const lines = notifications.map(
        (n) => `Sender: <code>${short(n.payload.sender)}</code><br/>Block: ${n.blockNumber}`,
      )
      setResult('bob-poll-result', `Found ${notifications.length}:<br/><br/>${lines.join('<br/><br/>')}`, 'success')
    }
  }, 'bob-poll-result'),
)

// ─── Step 7: Reply ──────────────────────────────────────────────

$('bob-send').addEventListener('click', () =>
  withLoading('bob-send', async () => {
    const subject = ($('bob-msg-subject') as HTMLInputElement).value || 'Re: Hello'
    const body = ($('bob-msg-body') as HTMLTextAreaElement).value || 'Got it, thanks!'

    await bob.sendMessage(bee, stamp, subject, body)
    setResult('bob-send-result', `Sent: "${escapeHtml(subject)}"`, 'success')
    enableButtons('alice-inbox')
  }, 'bob-send-result'),
)

// ─── Step 8: Alice reads reply ──────────────────────────────────

$('alice-inbox').addEventListener('click', () =>
  withLoading('alice-inbox', async () => {
    const messages = await alice.readMessages(bee)
    renderMessages('alice-inbox-result', messages)
  }, 'alice-inbox-result'),
)

// ─── Log Clear ──────────────────────────────────────────────────

$('log-clear').addEventListener('click', clearLog)
