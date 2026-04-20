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

import { Panel } from './panel'
import { logAlice, logBob, logSystem, clearLog, short } from './log'
import { createReadOnlyProvider, createSigningProvider } from './provider'

// ─── State ──────────────────────────────────────────────────────

let bee: Bee
let stamp: string
let contractAddress: string
let rpcUrl: string
let alice: Panel
let bob: Panel

// ─── UI Helpers ─────────────────────────────────────────────────

function $(id: string): HTMLElement {
  return document.getElementById(id)!
}

function setResult(id: string, text: string, cls: 'success' | 'error' | 'info' = 'info'): void {
  const el = $(id)
  el.textContent = text
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
    if (resultId) setResult(resultId, `Error: ${msg}`, 'error')
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

// ─── Initialize ─────────────────────────────────────────────────

$('btn-init').addEventListener('click', async () => {
  const beeUrl = ($('cfg-bee') as HTMLInputElement).value
  stamp = ($('cfg-stamp') as HTMLInputElement).value
  contractAddress = ($('cfg-contract') as HTMLInputElement).value
  rpcUrl = ($('cfg-rpc') as HTMLInputElement).value

  if (!stamp) {
    ($('init-status') as HTMLElement).textContent = 'Stamp is required!'
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

  // Fetch overlay from Bee node (shared — same node)
  await alice.fetchOverlay(bee)
  // Bob uses a synthetic overlay (different identity, same node)
  bob.overlay = bytesToHex(secp.getPublicKey(bobPrivKey, true)).slice(0, 32)
  logBob(`Overlay (synthetic): <code>${short(bob.overlay!)}</code>`)

  // Display identity info
  $('alice-eth').textContent = alice.ethAddress
  $('alice-pub').textContent = short(alice.publicKeyHex, 12)
  $('bob-eth').textContent = bob.ethAddress
  $('bob-pub').textContent = short(bob.publicKeyHex, 12)

  logSystem('Demo initialized. Two identities generated.')
  logSystem(`Bee node: ${beeUrl} | Contract: <code>${short(contractAddress)}</code>`)

  // Enable step 1 buttons
  enableButtons('alice-publish', 'bob-publish')
  ;($('init-status') as HTMLElement).textContent = 'Connected!'
  ;($('init-status') as HTMLElement).style.color = 'var(--success)'
})

// ─── Step 1: Publish Identity ───────────────────────────────────

$('alice-publish').addEventListener('click', () =>
  withLoading('alice-publish', async () => {
    await alice.publishIdentity(bee, stamp)
    setResult('alice-publish-result', 'Identity published!', 'success')
    enableButtons('bob-resolve')
  }),
)

$('bob-publish').addEventListener('click', () =>
  withLoading('bob-publish', async () => {
    await bob.publishIdentity(bee, stamp)
    setResult('bob-publish-result', 'Identity published!', 'success')
    enableButtons('alice-resolve')
  }),
)

// ─── Step 2: Resolve ────────────────────────────────────────────

$('alice-resolve').addEventListener('click', () =>
  withLoading('alice-resolve', async () => {
    const resolved = await alice.resolveOther(bee)
    if (resolved) {
      setResult(
        'alice-resolve-result',
        `Found Bob!\nPubKey: ${short(resolved.walletPublicKey, 12)}\nOverlay: ${short(resolved.overlay)}`,
        'success',
      )
      enableButtons('alice-send')
      enableInputs('alice-msg-subject', 'alice-msg-body')
    } else {
      setResult('alice-resolve-result', 'Not found. Publish Bob\'s identity first.', 'error')
    }
  }),
)

$('bob-resolve').addEventListener('click', () =>
  withLoading('bob-resolve', async () => {
    const resolved = await bob.resolveOther(bee)
    if (resolved) {
      setResult(
        'bob-resolve-result',
        `Found Alice!\nPubKey: ${short(resolved.walletPublicKey, 12)}\nOverlay: ${short(resolved.overlay)}`,
        'success',
      )
      enableButtons('bob-send', 'bob-read', 'bob-poll')
      enableInputs('bob-msg-subject', 'bob-msg-body')
    } else {
      setResult('bob-resolve-result', 'Not found. Publish Alice\'s identity first.', 'error')
    }
  }),
)

// ─── Step 3: Send Message ───────────────────────────────────────

$('alice-send').addEventListener('click', () =>
  withLoading('alice-send', async () => {
    const subject = ($('alice-msg-subject') as HTMLInputElement).value || 'Hello Bob'
    const body = ($('alice-msg-body') as HTMLTextAreaElement).value || 'First message from Alice!'

    await alice.sendMessage(bee, stamp, subject, body)
    setResult('alice-send-result', `Sent: "${subject}"`, 'success')
    enableButtons('bob-read', 'alice-notify')
  }, 'alice-send-result'),
)

// ─── Step 4: Read Messages ──────────────────────────────────────

$('bob-read').addEventListener('click', () =>
  withLoading('bob-read', async () => {
    const messages = await bob.readMessages(bee)
    renderMessages('bob-read-result', messages)
  }),
)

// ─── Step 5: Send Notification ──────────────────────────────────

$('alice-notify').addEventListener('click', () =>
  withLoading('alice-notify', async () => {
    const provider = createSigningProvider(rpcUrl, '0x' + bytesToHex(alice.privateKey))
    const txHash = await alice.sendNotification(provider, contractAddress)
    setResult('alice-notify-result', `Tx: ${txHash}\nWaiting for confirmation...`, 'info')

    // Wait for mining
    logAlice('Waiting for tx to be mined...')
    const { JsonRpcProvider } = await import('ethers')
    const ethProvider = new JsonRpcProvider(rpcUrl)
    const receipt = await ethProvider.waitForTransaction(txHash, 1, 60000)
    if (receipt) {
      setResult('alice-notify-result', `Tx: ${short(txHash)}\nBlock: ${receipt.blockNumber}\nGas: ${receipt.gasUsed.toString()}`, 'success')
      logAlice(`Mined in block ${receipt.blockNumber} (${receipt.gasUsed.toString()} gas)`)
    }
    enableButtons('bob-poll')
  }),
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
        (n) => `Sender: ${short(n.payload.sender)}\nOverlay: ${short(n.payload.overlay)}\nBlock: ${n.blockNumber}`,
      )
      setResult('bob-poll-result', `Found ${notifications.length}:\n\n${lines.join('\n\n')}`, 'success')
    }
  }),
)

// ─── Step 7: Reply & Inbox ──────────────────────────────────────

$('bob-send').addEventListener('click', () =>
  withLoading('bob-send', async () => {
    const subject = ($('bob-msg-subject') as HTMLInputElement).value || 'Re: Hello'
    const body = ($('bob-msg-body') as HTMLTextAreaElement).value || 'Got it, thanks!'

    await bob.sendMessage(bee, stamp, subject, body)
    setResult('bob-send-result', `Sent: "${subject}"`, 'success')
    enableButtons('alice-inbox')
  }, 'bob-send-result'),
)

$('alice-inbox').addEventListener('click', () =>
  withLoading('alice-inbox', async () => {
    const messages = await alice.readMessages(bee)
    renderMessages('alice-inbox-result', messages)
  }),
)

// ─── Log Clear ──────────────────────────────────────────────────

$('log-clear').addEventListener('click', clearLog)
