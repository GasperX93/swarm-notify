# Swarm Notify

> Decentralized encrypted notifications and messaging for Swarm light nodes.

Swarm Notify is a standalone TypeScript library that enables encrypted communication between Swarm nodes — including light nodes where PSS/GSOC can't receive. It provides identity discovery, encrypted mailbox feeds, file attachments, and an on-chain notification registry for first-contact discovery.

Built entirely on existing Swarm primitives (feeds, SOC) + a minimal Gnosis Chain contract. Any Swarm app can integrate it.

## The Problem

Swarm users can store and share files, but can't communicate between nodes. Light nodes (the majority of Swarm apps) can't receive PSS or GSOC messages. Sharing an encrypted drive requires exchanging keys and links through 3rd party apps (Telegram, email).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Swarm Notify                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐    │
│  │  Layer 1      │  │  Layer 2     │  │  Layer 3               │    │
│  │  Identity     │  │  Mailbox     │  │  Notification          │    │
│  │  Feeds        │  │  Feeds       │  │  Registry              │    │
│  │  (Swarm)      │  │  (Swarm)     │  │  (Gnosis Chain)        │    │
│  │              │  │              │  │                        │    │
│  │  "Who is     │  │  "Send and   │  │  "You have new         │    │
│  │   this       │  │   receive    │  │   notifications"       │    │
│  │   person?"   │  │   messages"  │  │                        │    │
│  └──────────────┘  └──────────────┘  └────────────────────────┘    │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐    │
│  │  Crypto       │  │  Contacts    │  │  Types                 │    │
│  │  ECDH +       │  │              │  │                        │    │
│  │  AES-256-GCM  │  │              │  │                        │    │
│  └──────────────┘  └──────────────┘  └────────────────────────┘    │
│                                                                     │
│  Standalone library — depends only on bee-js                        │
└─────────────────────────────────────────────────────────────────────┘
```

**Layer 1 — Identity Feeds (Swarm)**
Publish your public keys to a deterministic Swarm feed. Discoverable by ETH address or ENS name. Opt-in.

**Layer 2 — Mailbox Feeds (Swarm)**
E2E encrypted feeds between sender and recipient. Each sender owns their feed. Works on both light and full nodes.

**Layer 3 — Notification Registry (Gnosis Chain)**
Minimal smart contract for first-contact discovery. Notifications are ECIES-encrypted. Cost: ~0.00002 xDAI. Querying is free.

## Message Flow

```
Bob wants to notify Alice (first time):

Bob                          Swarm              Gnosis          Alice
 │                             │                  │               │
 │  1. Lookup identity feed    │                  │               │
 │ ──────────────────────────> │                  │               │
 │  <── Alice's publicKey ──── │                  │               │
 │                             │                  │               │
 │  2. Encrypt message (ECDH)  │                  │               │
 │  3. Write to mailbox feed   │                  │               │
 │ ──────────────────────────> │                  │               │
 │                             │                  │               │
 │  4. Encrypt notification    │                  │               │
 │     (ECIES, Alice's key)    │                  │               │
 │  5. Call notify()           │                  │               │
 │ ──────────────────────────────────────────── > │               │
 │                             │                  │               │
 │                             │                  │  6. Poll logs │
 │                             │                  │ <──────────── │
 │                             │                  │ ────────────> │
 │                             │                  │               │
 │                             │  7. Read feed    │               │
 │                             │ <─────────────────────────────── │
 │                             │ ── message ────────────────────> │
 │                             │                  │               │
 │                             │                  │  8. Decrypt   │
 │                             │                  │               │
```

After first contact, subsequent messages go directly through mailbox feeds — no on-chain notification needed.

## Privacy

| Data | Visible? |
|------|----------|
| Message content | No — ECDH encrypted on Swarm |
| Sender/recipient identity | No — feed topics are hashed |
| Notification content | No — ECIES encrypted on-chain |
| Recipient address on-chain | No — only keccak256 hash |
| Timing | Yes — block timestamp visible |
| Gas payer | Yes — transaction sender visible |

## Why Not PSS or GSOC?

|                        | PSS | GSOC | Swarm Notify |
|------------------------|-----|------|--------------|
| Light node send        | Yes | Yes  | Yes          |
| Light node receive     | No  | No   | **Yes**      |
| Async (offline)        | No  | No   | **Yes**      |
| First contact discovery| No  | No   | **Yes**      |
| Encrypted              | Yes | Yes  | Yes          |

## Quick Start

```typescript
import { identity, mailbox } from '@swarm/notify'

// Publish your identity
await identity.publish(bee, signer, stamp, {
  walletPublicKey: myPublicKey,
  beePublicKey: beeNodePublicKey,
  overlay: myOverlay,
})

// Resolve someone by ETH address or ENS
const bob = await identity.resolve(bee, '0xBob...')

// Send an encrypted message
await mailbox.send(bee, signer, stamp, bob, {
  subject: 'Project files',
  body: 'Here are the docs.',
  attachments: [{ name: 'report.pdf', file: myFile }],
})

// Check inbox
const messages = await mailbox.checkInbox(bee, signer, myContacts)
```

## Project Structure

```
src/
  identity.ts     Publish/read identity feeds
  mailbox.ts      Send/receive encrypted messages
  contacts.ts     Contact management
  crypto.ts       ECDH + AES-256-GCM + ECIES
  registry.ts     Gnosis notification contract interaction
  types.ts        Message, Contact, Identity types
  index.ts        Public API exports

contracts/
  SwarmNotificationRegistry.sol

test/
  crypto.test.ts
  identity.test.ts
  mailbox.test.ts
  contacts.test.ts
  registry.test.ts
```

## Deployed Contracts

| Network | Address | Explorer |
|---------|---------|----------|
| Gnosis Chain | `0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf` | [Gnosisscan](https://gnosisscan.io/address/0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf) |

## Development

```bash
npm install
npm run build             # TypeScript compilation
npm test                  # Run tests (required before PR)
npm run lint              # ESLint + Prettier
npm run check:types       # TypeScript type check
npm run compile:contracts # Compile Solidity contracts (Hardhat)
```

### Deploying the contract

```bash
# Set deployer key in .env
echo "DEPLOYER_PRIVATE_KEY=0x..." > .env

# Deploy to Gnosis Chain
npm run deploy -- --network gnosis
```

## Contributing

- Every PR must include tests for new functionality
- Every new module/function must have JSDoc documentation
- Run `npm test && npm run check:types && npm run lint` before pushing
- See [CLAUDE.md](./CLAUDE.md) for architecture details and coding conventions

## Team

- @crtahlin
- @misaakidis
- @GasperX93

## Links

- [Nook (first client)](https://github.com/GasperX93/nook) — Desktop app integrating Swarm Notify
- [Swarm](https://ethswarm.org) — The decentralized storage network

## License

[BSD-3-Clause](./LICENSE)
