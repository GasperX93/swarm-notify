# Agent Integration Guide

How to use Swarm Notify in autonomous agents, bots, and backend services.

Agents use the same library API as interactive apps. The key differences: agents manage keys programmatically, poll automatically, and run headless (Node.js, no browser). The [CLI reference app](../examples/cli.ts) is a good starting point — the [polling agent example](../examples/agent/) is a more complete template.

## Key Management

Agents don't have wallet UIs. Generate and persist keys on first run.

```typescript
import * as fs from 'fs'
import * as secp from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { keccak_256 } from '@noble/hashes/sha3'

const KEY_FILE = './data/agent-key.json'

function loadOrCreateKey(): { privateKey: Uint8Array; ethAddress: string } {
  if (fs.existsSync(KEY_FILE)) {
    const { hex } = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'))
    const privateKey = hexToBytes(hex)
    return { privateKey, ethAddress: deriveEthAddress(privateKey) }
  }

  const privateKey = secp.utils.randomPrivateKey()
  const hex = bytesToHex(privateKey)
  fs.mkdirSync('./data', { recursive: true })
  fs.writeFileSync(KEY_FILE, JSON.stringify({ hex }))
  return { privateKey, ethAddress: deriveEthAddress(privateKey) }
}

function deriveEthAddress(privateKey: Uint8Array): string {
  const pubKey = secp.getPublicKey(privateKey, false)
  const hash = keccak_256(pubKey.slice(1))
  return '0x' + bytesToHex(hash.slice(12))
}
```

**Key rotation:** Republish identity (`identity.publish()`) after generating a new key. Contacts who cached your old public key will need to re-resolve your identity feed.

## Identity Lifecycle

Publish your identity on agent startup so other agents can discover you:

```typescript
import { Bee } from '@ethersphere/bee-js'
import * as identity from '@swarm-notify/sdk/identity'

const bee = new Bee('http://localhost:1633')
const { privateKey, ethAddress } = loadOrCreateKey()
const publicKeyHex = bytesToHex(secp.getPublicKey(privateKey, true))

// Publish once on startup (idempotent — overwrites previous)
await identity.publish(bee, '0x' + bytesToHex(privateKey), stamp, {
  walletPublicKey: publicKeyHex,
  beePublicKey: publicKeyHex,
  ethAddress,
})

console.log(`Agent identity published: ${ethAddress}`)
```

Share your ETH address with other agents however your system works — config file, on-chain registry, environment variable, etc.

## Contact Management

Use `ContactStore` with file-based persistence:

```typescript
import { ContactStore } from '@swarm-notify/sdk'

const CONTACTS_FILE = './data/contacts.json'

function loadContacts(): ContactStore {
  try {
    return ContactStore.from(JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8')))
  } catch { return new ContactStore() }
}

function saveContacts(store: ContactStore): void {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(store.export()))
}
```

## Automated Polling

The core pattern for agents: a loop that checks for new messages and notifications.

### Inbox polling

```typescript
import * as mailbox from '@swarm-notify/sdk/mailbox'

async function pollInbox(contacts: ContactStore): Promise<void> {
  const inbox = await mailbox.checkInbox(
    bee, privateKey, ethAddress, contacts.list()
  )

  for (const { contact, messages } of inbox) {
    for (const msg of messages) {
      console.log(`[${contact.nickname}] ${msg.subject}: ${msg.body}`)
      await handleMessage(contact, msg)
    }
  }
}
```

### Registry polling (discover new contacts)

Track the last processed block to avoid reprocessing:

```typescript
import * as registry from '@swarm-notify/sdk/registry'

const BLOCK_FILE = './data/last-block.txt'

function loadLastBlock(): number {
  try { return parseInt(fs.readFileSync(BLOCK_FILE, 'utf-8')) } catch { return 0 }
}

function saveLastBlock(block: number): void {
  fs.writeFileSync(BLOCK_FILE, String(block))
}

async function pollNotifications(contacts: ContactStore): Promise<void> {
  const fromBlock = loadLastBlock()
  const notifications = await registry.pollNotifications(
    notifyProvider, contractAddress, ethAddress, privateKey, fromBlock
  )

  for (const { payload, blockNumber } of notifications) {
    console.log(`New contact discovered: ${payload.sender} (block ${blockNumber})`)

    // Resolve and add as contact
    const id = await identity.resolve(bee, payload.sender)
    if (id) {
      try {
        contacts.add(payload.sender, payload.sender, id)
        saveContacts(contacts)
      } catch { /* already exists */ }
    }

    saveLastBlock(blockNumber + 1)
  }
}
```

### Main polling loop

```typescript
const POLL_INTERVAL = 30_000 // 30 seconds

async function runAgent(): Promise<void> {
  const { privateKey, ethAddress } = loadOrCreateKey()
  const contacts = loadContacts()

  // Publish identity on startup
  await publishIdentity()

  console.log(`Agent running. Polling every ${POLL_INTERVAL / 1000}s...`)

  while (true) {
    try {
      await pollNotifications(contacts)
      await pollInbox(contacts)
    } catch (err) {
      console.error('Poll error:', err instanceof Error ? err.message : err)
      // Don't crash — wait and retry
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
  }
}

runAgent()
```

## Error Recovery

### Bee node restarts

The Bee node may restart or become temporarily unreachable. Wrap Swarm operations in retry logic:

```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 5000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn() }
    catch (err) {
      if (i === retries - 1) throw err
      console.warn(`Retry ${i + 1}/${retries} in ${delay}ms...`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}

// Usage
await withRetry(() => mailbox.send(bee, signer, stamp, privateKey, ethAddress, contact, message))
```

### Transaction failures

On-chain notifications may fail due to:
- **Insufficient funds** — agent wallet needs xDAI on Gnosis Chain
- **Nonce conflicts** — if agent sends multiple tx rapidly
- **RPC timeouts** — public RPCs can be slow

For production agents, consider using a dedicated RPC endpoint and monitoring the agent wallet balance.

### Stamp expiry

Postage stamps expire. Production agents should monitor stamp availability:

```typescript
const stamps = await bee.getAllPostageBatch()
const usable = stamps.find(s => s.usable)
if (!usable) {
  console.error('No usable stamp — buy a new batch')
  // Alert, pause operations, or auto-purchase
}
```

## Communication Patterns

### Request/Response

Agent A sends a task, Agent B replies with results:

```typescript
// Agent A: send task
await mailbox.send(bee, signer, stamp, privateKey, ethAddress, agentBContact, {
  subject: 'task:analyze',
  body: JSON.stringify({ dataset: 'swarm://ref/abc123', params: { threshold: 0.8 } }),
})

// Agent B: process and reply
const messages = await mailbox.readMessages(bee, privateKey, ethAddress, agentAContact)
for (const msg of messages) {
  if (msg.subject.startsWith('task:')) {
    const result = await processTask(JSON.parse(msg.body))
    await mailbox.send(bee, signer, stamp, privateKey, ethAddress, agentAContact, {
      subject: `result:${msg.subject}`,
      body: JSON.stringify(result),
    })
  }
}
```

**Convention:** Use structured `subject` prefixes (`task:`, `result:`, `status:`) for message routing.

### Pub/Sub via Registry

A service agent broadcasts to subscribers:

```typescript
// Publisher: notify all known subscribers
for (const subscriber of contacts.list()) {
  await registry.sendNotification(
    notifyProvider, contractAddress,
    hexToBytes(subscriber.walletPublicKey),
    subscriber.ethAddress,
    { sender: myEthAddress },
  )
}

// Subscriber: poll for new publishers, then read their feeds
const notifications = await registry.pollNotifications(...)
// Add new publishers as contacts, then checkInbox to get updates
```

**Cost:** First notification per subscriber costs gas (~22k). Subsequent updates go through Swarm feeds only — free.

### Drive Sharing

Share datasets or files between agents:

```typescript
await mailbox.send(bee, signer, stamp, privateKey, ethAddress, recipientContact, {
  subject: 'Shared: Training data Q4',
  body: 'Updated dataset for the analysis pipeline.',
  type: 'drive-share',
  driveShareLink: 'swarm://feed?topic=abc&owner=def',
  driveName: 'Training data Q4',
  fileCount: 142,
})
```

### Multi-Agent Coordination

Fan-out (one sender, many recipients):

```typescript
const status = { subject: 'status:pipeline', body: JSON.stringify({ stage: 'complete', output: ref }) }
for (const agent of contacts.list()) {
  await mailbox.send(bee, signer, stamp, privateKey, ethAddress, agent, status)
}
```

Fan-in (many senders, one aggregator):

```typescript
// Aggregator polls all known agents
const inbox = await mailbox.checkInbox(bee, privateKey, ethAddress, contacts.list())
const results = inbox.flatMap(({ messages }) =>
  messages.filter(m => m.subject.startsWith('result:')).map(m => JSON.parse(m.body))
)
```

## Running Headless

Agents run in Node.js without a browser. Key setup:

```typescript
import 'dotenv/config'
import { Bee } from '@ethersphere/bee-js'

const bee = new Bee(process.env.BEE_URL || 'http://localhost:1633')
const stamp = process.env.STAMP || ''
const contractAddress = process.env.CONTRACT_ADDRESS || '0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf'
```

For the `NotifyProvider`, see the [CLI provider](../examples/provider.ts) — it uses raw `fetch` for reads and ethers for signing.

## See Also

- [Polling agent example](../examples/agent/) — complete runnable template
- [CLI reference app](../examples/cli.ts) — interactive command-line usage
- [Integration guide](./integration-guide.md) — general library integration
- [Web UI demo](../examples/web/) — visual demo with explanations
