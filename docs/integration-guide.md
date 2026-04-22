# Swarm Notify — Integration Guide

How to add encrypted messaging and notifications to your Swarm app.

## Prerequisites

- **Bee node** running in light mode (or higher) on `localhost:1633`
- **bee-js** — the official Swarm JavaScript SDK
- **Wallet private key** — secp256k1 key for ECDH encryption and feed signing
- **Gnosis Chain RPC** — for the notification registry (e.g., `https://rpc.gnosischain.com`)

## Install

```bash
npm install @swarm-notify/sdk @ethersphere/bee-js
```

```typescript
import { Bee } from '@ethersphere/bee-js'
import { identity, mailbox, ContactStore, crypto, registry } from '@swarm-notify/sdk'
import type { NotifyProvider } from '@swarm-notify/sdk'

const bee = new Bee('http://localhost:1633')
```

## 1. Set up NotifyProvider

The registry module needs to interact with Gnosis Chain. Instead of depending on a specific library, Swarm Notify uses a generic `NotifyProvider` interface. You wrap your app's provider:

### ethers v5

```typescript
import { ethers } from 'ethers'

const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com')
const wallet = new ethers.Wallet(privateKeyHex, provider)

const notifyProvider: NotifyProvider = {
  getLogs: (filter) => provider.getLogs(filter),
  call: (tx) => provider.call(tx),
  sendTransaction: (tx) => wallet.sendTransaction(tx).then((r) => r.hash),
}
```

### ethers v6

```typescript
import { JsonRpcProvider, Wallet } from 'ethers'

const provider = new JsonRpcProvider('https://rpc.gnosischain.com')
const wallet = new Wallet(privateKeyHex, provider)

const notifyProvider: NotifyProvider = {
  getLogs: (filter) => provider.getLogs(filter),
  call: (tx) => provider.call(tx),
  sendTransaction: (tx) => wallet.sendTransaction(tx).then((r) => r.hash),
}
```

### viem

```typescript
import { createPublicClient, createWalletClient, http } from 'viem'
import { gnosis } from 'viem/chains'

const publicClient = createPublicClient({ chain: gnosis, transport: http() })
const walletClient = createWalletClient({ chain: gnosis, transport: http(), account })

const notifyProvider: NotifyProvider = {
  getLogs: (filter) => publicClient.getLogs(filter),
  call: (tx) => publicClient.call(tx),
  sendTransaction: (tx) => walletClient.sendTransaction(tx),
}
```

If your app doesn't use the notification registry, you can skip this step — identity, contacts, and mailbox work without it.

## 2. Publish your identity

Before others can message you, publish your public keys to a discoverable Swarm feed.

```typescript
const myIdentity = {
  walletPublicKey: myCompressedPublicKey,  // 66 hex chars, compressed secp256k1
  beePublicKey: beeNodePublicKey,          // from bee.getNodeAddresses()
  ethAddress: myEthAddress,                // your wallet address
}

await identity.publish(bee, myPrivateKeyHex, myPostageStampId, myIdentity)
```

This writes a small JSON document to a deterministic feed at `keccak256("swarm-identity-" + ethAddress)`. Anyone who knows your ETH address can now look you up.

This is a one-time operation. Only re-publish if your keys change (e.g., new Bee node).

**Multi-device:** ETH address is cross-device-stable — the same wallet on different machines shares one inbox. Identity and mailbox feeds are keyed by ETH address, not by Bee overlay, so switching Bee nodes does not change your address or break existing conversations.

## 3. Discover someone

Look up another user's identity by their ETH address:

```typescript
const alice = await identity.resolve(bee, '0xAliceEthAddress...')

if (!alice) {
  console.log('Alice has not published her identity yet')
  return
}

// alice.walletPublicKey — for ECDH encryption
// alice.beePublicKey    — for ACT grantee lists
```

**ENS support:** Swarm Notify takes ETH addresses only. If your app supports ENS, resolve the name first:

```typescript
// Your app resolves ENS → ETH address
const ethAddress = await yourApp.resolveENS('alice.eth')
const alice = await identity.resolve(bee, ethAddress)
```

## 4. Add as contact

Create a `ContactStore` and save the resolved identity. The store is in-memory — your app handles persistence (localStorage, file, database).

```typescript
const contacts = new ContactStore()

const aliceContact = contacts.add(
  alice.ethAddress!,
  'Alice',         // nickname
  alice,           // SwarmIdentity from resolve()
)
```

Other contact operations:

```typescript
contacts.list()                                    // all contacts
contacts.update(ethAddress, { nickname: 'Ali' })   // update fields
contacts.remove(ethAddress)                        // stop tracking
```

Persistence — serialize and restore:

```typescript
// Save to your storage
const json = JSON.stringify(contacts.export())
localStorage.setItem('contacts', json)

// Restore later
const restored = ContactStore.from(JSON.parse(localStorage.getItem('contacts')!))
```

## 5. Send a message

```typescript
await mailbox.send(
  bee,
  myPrivateKeyHex,       // feed signing key
  myPostageStampId,
  myEncryptionPrivKey,   // Uint8Array — for ECDH shared secret
  myEthAddress,
  aliceContact,
  {
    subject: 'Hello from my app',
    body: 'This message is end-to-end encrypted.',
  },
)
```

What happens under the hood:
1. Derives a shared secret via ECDH (your private key + Alice's public key)
2. Reads any existing messages from your feed to Alice
3. Appends the new message
4. Encrypts the full array with AES-256-GCM
5. Uploads the encrypted blob to Swarm
6. Updates the mailbox feed pointer

### Send a drive-share notification

When your app shares an encrypted drive, notify the recipient:

```typescript
await mailbox.send(
  bee, signer, stamp, myPrivateKey, myEthAddress, aliceContact,
  {
    subject: 'Shared: Project files',
    body: 'I shared a drive with you.',
    type: 'drive-share',
    driveShareLink: 'swarm://feed?topic=abc&owner=def&publisher=ghi',
    driveName: 'Project files',
    fileCount: 12,
  },
)
```

## 6. Read messages

Read messages from a specific contact:

```typescript
const messages = await mailbox.readMessages(
  bee,
  myEncryptionPrivKey,
  myEthAddress,
  aliceContact,
)

for (const msg of messages) {
  console.log(`[${new Date(msg.ts).toLocaleString()}] ${msg.subject}`)
  console.log(msg.body)

  if (msg.type === 'drive-share') {
    console.log(`Shared drive: ${msg.driveName} (${msg.fileCount} files)`)
    console.log(`Link: ${msg.driveShareLink}`)
  }
}
```

Check inbox across all contacts:

```typescript
const inbox = await mailbox.checkInbox(
  bee,
  myEncryptionPrivKey,
  myEthAddress,
  contacts.list(),
)

for (const { contact, messages } of inbox) {
  console.log(`${contact.nickname}: ${messages.length} message(s)`)
}
```

## 7. First-contact notifications (Registry)

When you message someone for the first time, they don't know to check your feed. The notification registry solves this — it posts an ECIES-encrypted event on Gnosis Chain that the recipient can discover.

### Send a notification

```typescript
const REGISTRY_ADDRESS = '0x...'  // deployed contract address

await registry.sendNotification(
  notifyProvider,
  REGISTRY_ADDRESS,
  hexToBytes(aliceContact.walletPublicKey),  // recipient's public key
  aliceContact.ethAddress,
  {
    sender: myEthAddress,
  },
)
```

Only needed once per new contact. Subsequent messages go directly through the mailbox feed.

### Poll for notifications

```typescript
const notifications = await registry.pollNotifications(
  notifyProvider,
  REGISTRY_ADDRESS,
  myEthAddress,
  myEncryptionPrivKey,
  lastCheckedBlock,  // optional: skip already-processed events
)

for (const { payload, blockNumber } of notifications) {
  console.log(`New contact: ${payload.sender}`)

  // Resolve their identity and add as contact
  const senderIdentity = await identity.resolve(bee, payload.sender)
  if (senderIdentity) {
    contacts.add(payload.sender, payload.sender, senderIdentity)
  }
}
```

Spam is handled automatically — notifications encrypted with the wrong key fail ECIES decryption and are silently discarded.

## Full flow example

Putting it all together — Bob sends Alice a message for the first time:

```typescript
import { Bee } from '@ethersphere/bee-js'
import { identity, mailbox, ContactStore, registry } from '@swarm-notify/sdk'

const bee = new Bee('http://localhost:1633')
const REGISTRY = '0x...'
const contacts = new ContactStore()

// ── Bob's setup ──────────────────────────────────────────────

// 1. Publish Bob's identity (one-time)
await identity.publish(bee, bobSignerKey, bobStamp, {
  walletPublicKey: bobPublicKeyHex,
  beePublicKey: bobBeePublicKey,
  ethAddress: bobEthAddress,
})

// 2. Look up Alice
const alice = await identity.resolve(bee, aliceEthAddress)
const aliceContact = contacts.add(alice.ethAddress!, 'Alice', alice)

// 3. Send message
await mailbox.send(bee, bobSignerKey, bobStamp, bobPrivateKey, bobEthAddress, aliceContact, {
  subject: 'Hey Alice',
  body: 'Check out this shared drive!',
  type: 'drive-share',
  driveShareLink: 'swarm://feed?topic=abc&owner=def&publisher=ghi',
  driveName: 'Research docs',
  fileCount: 5,
})

// 4. Notify Alice on-chain (first time only)
await registry.sendNotification(
  bobNotifyProvider, REGISTRY,
  hexToBytes(alice.walletPublicKey), alice.ethAddress!,
  { sender: bobEthAddress },
)

// ── Alice's side ─────────────────────────────────────────────

// 5. Alice polls for notifications
const notifications = await registry.pollNotifications(
  aliceNotifyProvider, REGISTRY, aliceEthAddress, alicePrivateKey,
)

// 6. Alice discovers Bob
for (const { payload } of notifications) {
  const sender = await identity.resolve(bee, payload.sender)
  if (sender) contacts.add(payload.sender, 'New contact', sender)
}

// 7. Alice reads her inbox
const inbox = await mailbox.checkInbox(bee, alicePrivateKey, aliceEthAddress, contacts.list())
for (const { contact, messages } of inbox) {
  for (const msg of messages) {
    console.log(`${contact.nickname}: ${msg.subject} — ${msg.body}`)
  }
}
```

## What the library does NOT do

- **ENS resolution** — your app resolves ENS names, passes ETH addresses to the library
- **Contact import from app-specific sources** — your app calls `contacts.add()` with resolved identities
- **UI** — the library is headless; you build the interface
- **Key management** — your app provides private keys and signers; the library doesn't store them
- **File uploads/encryption** — use your app's existing file handling (e.g., ACT for encrypted drives); Swarm Notify sends share links as message metadata
