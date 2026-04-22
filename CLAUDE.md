# CLAUDE.md

## What this is

Swarm Notify is a standalone TypeScript library for encrypted notifications and messaging on the Swarm network. It works on light nodes (unlike PSS/GSOC). Three layers: identity feeds (Swarm), mailbox feeds (Swarm), notification registry (Gnosis Chain smart contract).

First client: [Nook](https://github.com/GasperX93/nook) (Electron desktop app).

## Commands

```bash
npm install            # Install dependencies
npm run build          # TypeScript compilation
npm test               # Run vitest tests
npm run lint           # ESLint + Prettier fix
npm run lint:check     # ESLint check only (no fix)
npm run check:types    # TypeScript type check
```

## Architecture

### Data Flow

```
SENDING A MESSAGE (Bob → Alice):

  Bob's App
    │
    ├─ 1. identity.resolve(bee, aliceEthAddress)
    │     └─ reads feed at keccak256("swarm-identity-" + aliceEthAddress)
    │     └─ returns: { walletPublicKey, beePublicKey }
    │
    ├─ 2. crypto.deriveSharedSecret(bobPrivateKey, aliceWalletPublicKey)
    │     └─ ECDH → 32-byte shared secret (both parties derive the same one)
    │
    ├─ 3. crypto.encrypt(messageJSON, sharedSecret)
    │     └─ AES-256-GCM → { ciphertext, nonce }
    │
    ├─ 4. bee.uploadData(stamp, encryptedBlob)
    │     └─ upload to Swarm → reference hash
    │
    ├─ 5. bee.makeFeedWriter(topic, signer).upload(stamp, reference)
    │     └─ topic = keccak256(bobEthAddress + aliceEthAddress + "swarm-notify")
    │     └─ updates Bob→Alice mailbox feed
    │
    └─ 6. registry.sendNotification(provider, aliceEthAddress, payload, bobPrivateKey)
          └─ ECIES-encrypt { sender } with Alice's publicKey
          └─ call notify(keccak256(aliceEthAddress), encryptedBlob) on Gnosis Chain
          └─ only needed for FIRST contact

RECEIVING A MESSAGE (Alice checks):

  Alice's App
    │
    ├─ 1. registry.pollNotifications(provider, aliceEthAddress, alicePrivateKey)
    │     └─ eth_getLogs for keccak256(aliceEthAddress)
    │     └─ ECIES-decrypt each → discover new senders
    │     └─ auto-add as contacts
    │
    ├─ 2. For each contact: mailbox.readMessages(bee, signer, contact)
    │     └─ topic = keccak256(contactEthAddress + aliceEthAddress + "swarm-notify")
    │     └─ read feed → download blob → ECDH derive secret → AES-GCM decrypt
    │     └─ returns: Message[]
    │
    └─ 3. Merge all messages, sort by timestamp → inbox
```

### Feed Topic Conventions

```
Identity feed:  keccak256("swarm-identity-" + ethAddress)
Mailbox feed:   keccak256(senderEthAddress + recipientEthAddress + "swarm-notify")
```

Both feed types are keyed by ETH address — stable across devices and Bee installations.

### Encryption

Two types:
- **ECDH + AES-256-GCM** — for messages between known contacts. Both parties derive the same shared secret independently.
- **ECIES** — for notifications to unknown recipients. Asymmetric: encrypt with public key, only private key can decrypt.

### Smart Contract

```solidity
contract SwarmNotificationRegistry {
    event Notification(bytes32 indexed recipientHash, bytes encryptedPayload);
    function notify(bytes32 recipientHash, bytes calldata encryptedPayload) external {
        emit Notification(recipientHash, encryptedPayload);
    }
}
```

~20 lines. No storage, no admin. Privacy from encryption, not access control.

**Deployed:** Gnosis Chain — `0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf`

## Core Types

These are the shared interfaces. Every module uses them.

```typescript
// ─── Identity ────────────────────────────────────────────────────

interface SwarmIdentity {
  walletPublicKey: string    // compressed secp256k1 (66 hex) — for ECDH encryption
  beePublicKey: string       // Bee node public key — for ACT grantee lists
  ethAddress?: string        // publisher's ETH address (optional, derivable from feed)
}

// ─── Messages ────────────────────────────────────────────────────

interface Message {
  v: 1                       // format version
  subject: string
  body: string
  ts: number                 // unix timestamp ms
  sender: string             // sender's ETH address
  type?: 'message' | 'drive-share'  // default: 'message'
  attachments?: Attachment[]
  // drive-share specific
  driveShareLink?: string
  driveName?: string
  fileCount?: number
}

interface Attachment {
  name: string
  size: number
  mime: string
  ref: string                // Swarm reference to encrypted file blob
}

// ─── Contacts ────────────────────────────────────────────────────

interface Contact {
  ethAddress: string         // primary key — stable across devices
  nickname: string
  walletPublicKey: string    // cached from identity feed
  beePublicKey: string       // cached from identity feed
  ensName?: string
  addedAt: number            // unix timestamp ms
}

// ─── Notifications ───────────────────────────────────────────────

interface NotificationPayload {
  sender: string             // sender's ETH address
}

// ─── Crypto ──────────────────────────────────────────────────────

interface EncryptedData {
  ciphertext: Uint8Array
  nonce: Uint8Array          // 12 bytes, random per encryption
}

// ─── Framework-agnostic provider (registry module) ──────────────
// Host app wraps its own ethers/web3/viem provider into this interface.
// Works with ethers v5, v6, viem, or raw fetch — library doesn't care.

interface NotifyProvider {
  getLogs(filter: {
    address: string
    topics: string[]
    fromBlock: number
    toBlock?: number | 'latest'
  }): Promise<{ data: string; blockNumber: number }[]>

  call(tx: { to: string; data: string }): Promise<string>  // eth_call for read-only

  sendTransaction(tx: {
    to: string
    data: string
    value?: string           // hex wei, default "0x0"
  }): Promise<string>        // returns txHash
}
```

## Module API Surface

```typescript
// ─── crypto.ts ───────────────────────────────────────────────────

function deriveSharedSecret(myPrivateKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array
function encrypt(plaintext: Uint8Array, sharedSecret: Uint8Array): Promise<EncryptedData>
function decrypt(encrypted: EncryptedData, sharedSecret: Uint8Array): Promise<Uint8Array>
function eciesEncrypt(data: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array>
function eciesDecrypt(blob: Uint8Array, myPrivateKey: Uint8Array): Promise<Uint8Array>

// ─── identity.ts ─────────────────────────────────────────────────

function publish(bee: Bee, signer: string | Uint8Array, stamp: string, identity: SwarmIdentity): Promise<void>
function resolve(bee: Bee, ethAddress: string): Promise<SwarmIdentity | null>
function feedTopic(ethAddress: string): string  // returns keccak256("swarm-identity-" + ethAddress)
// NOTE: ENS resolution is NOT in this library — host app resolves ENS → ETH address,
// then calls resolve(bee, ethAddress). Keeps the library framework-agnostic.

// ─── mailbox.ts ──────────────────────────────────────────────────

function send(bee: Bee, signer: string | Uint8Array, stamp: string, myPrivateKey: Uint8Array, myEthAddress: string, recipient: Contact, message: Omit<Message, 'v' | 'ts' | 'sender'>): Promise<void>
function readMessages(bee: Bee, myPrivateKey: Uint8Array, myEthAddress: string, contact: Contact): Promise<Message[]>
function checkInbox(bee: Bee, myPrivateKey: Uint8Array, myEthAddress: string, contacts: Contact[]): Promise<{ contact: Contact; messages: Message[] }[]>
function feedTopic(senderEthAddress: string, recipientEthAddress: string): string

// ─── contacts.ts ─────────────────────────────────────────────────
// ContactStore is an in-memory class. Host apps handle persistence.

class ContactStore {
  static from(data: Contact[]): ContactStore
  add(ethAddress: string, nickname: string, identity: SwarmIdentity): Contact
  remove(ethAddress: string): void
  list(): Contact[]
  update(ethAddress: string, changes: Partial<Pick<Contact, 'nickname' | 'walletPublicKey' | 'beePublicKey'>>): Contact
  export(): Contact[]
}

// ─── registry.ts ─────────────────────────────────────────────────
// Uses NotifyProvider (framework-agnostic) — NOT ethers Provider directly.
// Host app wraps its own provider. See NotifyProvider interface above.

function sendNotification(provider: NotifyProvider, contractAddress: string, recipientPublicKey: Uint8Array, recipientEthAddress: string, payload: NotificationPayload): Promise<string>
function pollNotifications(provider: NotifyProvider, contractAddress: string, myEthAddress: string, myPrivateKey: Uint8Array, fromBlock?: number): Promise<{ payload: NotificationPayload; blockNumber: number }[]>
function recipientHash(ethAddress: string): string  // returns keccak256(ethAddress)
```

## File Structure

```
src/
  types.ts          All shared interfaces (Message, Contact, SwarmIdentity, etc.)
  crypto.ts         ECDH, AES-256-GCM, ECIES — zero Swarm dependency
  identity.ts       Publish/resolve identity feeds — depends on crypto, bee-js
  mailbox.ts        Send/receive messages — depends on crypto, identity, bee-js
  contacts.ts       Contact CRUD — depends on types only
  registry.ts       Gnosis Chain notification contract — depends on crypto + NotifyProvider (no ethers)
  index.ts          Public API: re-exports { identity, mailbox, contacts, crypto, registry }

contracts/
  SwarmNotificationRegistry.sol

test/
  crypto.test.ts        Round-trip ECDH, AES-GCM, ECIES
  identity.test.ts      Publish + resolve, missing identity, ENS
  mailbox.test.ts       Send + receive, multiple messages, empty inbox
  contacts.test.ts      CRUD, import from grantee labels
  registry.test.ts      Deploy, notify, poll, decrypt
```

## Dependency Graph

```
types.ts (no deps)
  ↑
crypto.ts (no deps, uses @noble/secp256k1 + Web Crypto API)
  ↑
identity.ts (depends on: crypto, bee-js)
  ↑
mailbox.ts (depends on: crypto, identity, bee-js)
  ↑
contacts.ts (depends on: types only — pure CRUD)

registry.ts (depends on: crypto, NotifyProvider interface — no ethers, no Swarm dependency)
```

## Git Workflow

- **Never commit directly to `main`.** All work happens on feature branches.
- Create branches from `development` (not `main`).
- Merge finished work back into `development`.
- PRs to `main` require approval from **@GasperX93**.
- Branch naming: `feature/<issue-number>-<short-description>` or `fix/<issue-number>-<short-description>`.

## Maintenance Notes

- If `contracts/SwarmNotificationRegistry.sol` changes, update the ABI and key values table in `README.md` to match.
- When code or logic changes in any module (`src/`), check whether **all** of the following need updating:
  - Reference CLI app (`examples/cli.ts`)
  - Web UI reference app (`examples/web/`) — including step descriptions, use case cards, privacy table, and flow diagrams
  - Agent integration guide (`docs/agent-integration.md`) and polling agent example (`examples/agent/`)
  - Unit tests, integration tests (`test/integration.test.ts`), and E2E tests (`test/e2e.test.ts`)
  - Playwright tests (`examples/web/tests/`)

## Coding Conventions

- TypeScript strict mode
- All functions must have JSDoc comments
- All new code must have tests — PRs without tests will be rejected
- Use `Uint8Array` for binary data, not `Buffer` (browser compatibility)
- No Node.js-specific APIs — must work in browser, Electron, and Node
- `bee-js` is the only Swarm dependency — no direct HTTP calls to Bee
- `@noble/secp256k1` for elliptic curve operations
- Web Crypto API for AES-256-GCM (browser-native, fast)
- **No ethers dependency** — registry uses `NotifyProvider` interface. Host app provides the adapter.
- Export everything through `src/index.ts` — no deep imports

## Key Design Decisions

1. **ETH address as sole identifier.** Overlay is not used anywhere — identity, mailbox feed topics, and notifications all key on ETH address. This means the same wallet on different Bee nodes shares one inbox.

2. **Two feeds per conversation.** Alice→Bob and Bob→Alice are separate feeds (each owned by the sender). Merge by timestamp to get full conversation.

3. **Full message array per feed update.** Feeds are single-pointer (overwrite, not append). Each send downloads existing messages, appends, re-encrypts, re-uploads. Pagination is a future optimization.

4. **Application-level encryption, not ACT.** Messages are encrypted with ECDH+AES-GCM before upload. Bee sees raw bytes. Simpler, more portable, no ACT headers needed. Trade-off: no protocol-level revocation.

5. **Notification registry is permissionless.** Anyone can call `notify()`. Spam defense is decryption filtering — junk notifications fail ECIES decrypt and are silently discarded.

6. **Framework-agnostic — no ethers, no web3, no viem.** The registry module accepts a `NotifyProvider` interface, not a specific library's provider. Host apps wrap their own provider (ethers v5, v6, viem, raw fetch — whatever they use). This lets any Swarm app integrate without dependency conflicts.

7. **ENS resolution is the host app's job.** The library works with ETH addresses only. If the host app supports ENS, it resolves the name and passes the address. This avoids pulling in ethers/viem just for name resolution.

8. **Contact import is the host app's job.** The library provides `contacts.add()` but not app-specific import methods like `importFromGranteeLabels`. Each app imports contacts its own way.

## Integration Guide

Any Swarm app can integrate Swarm Notify. The library needs two things from the host:

### 1. Bee connection (bee-js)
```typescript
import { Bee } from '@ethersphere/bee-js'
const bee = new Bee('http://localhost:1633')
```

### 2. NotifyProvider (for registry / on-chain notifications)
Wrap your app's blockchain library:

```typescript
// ethers v5 example (Nook)
import { ethers } from 'ethers'
const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com')
const wallet = new ethers.Wallet(privateKey, provider)

const notifyProvider: NotifyProvider = {
  getLogs: (filter) => provider.getLogs(filter),
  call: (tx) => provider.call(tx),
  sendTransaction: (tx) => wallet.sendTransaction(tx).then(r => r.hash),
}

// ethers v6 example (Swarm Desktop)
import { JsonRpcProvider, Wallet } from 'ethers'
const provider = new JsonRpcProvider('https://rpc.gnosischain.com')
const wallet = new Wallet(privateKey, provider)

const notifyProvider: NotifyProvider = {
  getLogs: (filter) => provider.getLogs(filter),
  call: (tx) => provider.call(tx),
  sendTransaction: (tx) => wallet.sendTransaction(tx).then(r => r.hash),
}

// viem example
import { createPublicClient, createWalletClient, http } from 'viem'
import { gnosis } from 'viem/chains'
const public = createPublicClient({ chain: gnosis, transport: http() })
const wallet = createWalletClient({ chain: gnosis, transport: http(), account })

const notifyProvider: NotifyProvider = {
  getLogs: (filter) => public.getLogs(filter),
  call: (tx) => public.call(tx),
  sendTransaction: (tx) => wallet.sendTransaction(tx),
}
```

### 3. Signer (bee-js Signer interface)
The library uses bee-js's standard `Signer` type for feed operations. Host apps provide this from their key management — wallet-derived, Bee node key, or any secp256k1 key pair.

### 4. ENS (optional, host app handles)
```typescript
// Host app resolves ENS → ETH address, then passes to library
const ethAddress = await myApp.resolveENS('alice.eth')
const identity = await swarmNotify.identity.resolve(bee, ethAddress)
```

## Nook Integration

Nook is the first client. Integration issues are in [GasperX93/nook](https://github.com/GasperX93/nook):
- [nook#33](https://github.com/GasperX93/nook/issues/33) — Mail page UI
- [nook#34](https://github.com/GasperX93/nook/issues/34) — ACT share notifications
- [nook#35](https://github.com/GasperX93/nook/issues/35) — Auto-check mail + polling

Nook already has infrastructure that Swarm Notify builds on:
- Wallet key derivation (`ui/src/crypto/signer.ts`) — NookSigner with `deriveSharedSecret()`
- Feed read/write endpoints (`src/server.ts`) — `/feed-read`, `/feed-update`
- Contact autocomplete — grantee labels in ShareModal
- Gnosis Chain RPC — already configured for xBZZ/xDAI
