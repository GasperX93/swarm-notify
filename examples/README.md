# Swarm Notify CLI — Reference App

A CLI tool that exercises every module in the library. Used for manual testing, demos, and as an integration example.

## How It Works

The flow diagram below shows the full lifecycle of a first-contact notification and subsequent messaging between two users (Alice and Bob). Each step maps to a CLI command.

```
 ALICE                                                              BOB
 ─────                                                              ───

 1. PUBLISH IDENTITY                                    1. PUBLISH IDENTITY
 ┌────────────────────┐                                ┌────────────────────┐
 │ identity publish   │                                │ identity publish   │
 │                    │                                │                    │
 │ Writes to Swarm    │                                │ Writes to Swarm    │
 │ feed at topic:     │                                │ feed at topic:     │
 │ keccak256(         │                                │ keccak256(         │
 │  "swarm-identity-" │                                │  "swarm-identity-" │
 │  + ethAddress)     │                                │  + ethAddress)     │
 └────────────────────┘                                └────────────────────┘
          │                                                      │
          ▼                                                      ▼
 2. DISCOVER + ADD CONTACT                             2. DISCOVER + ADD CONTACT
 ┌────────────────────┐    read Bob's identity feed    ┌────────────────────┐
 │ identity resolve   │◄──────────── Swarm ──────────►│ identity resolve   │
 │ contacts add       │                                │ contacts add       │
 └────────────────────┘                                └────────────────────┘
          │                                                      │
          ▼                                                      │
 3. SEND MESSAGE                                                 │
 ┌────────────────────┐                                          │
 │ mailbox send       │                                          │
 │                    │                                          │
 │ ECDH shared secret │                                          │
 │ → AES-256-GCM      │                                          │
 │ → upload to Swarm  │                                          │
 │ → update feed      │                                          │
 └────────────────────┘                                          │
          │                                                      │
          ▼                                                      │
 4. FIRST-CONTACT NOTIFICATION (on-chain)                        │
 ┌────────────────────┐                                          │
 │ registry notify    │                                          │
 │                    │    Gnosis Chain tx:                       │
 │ ECIES-encrypt      │    notify(keccak256(bobAddr),            │
 │ {sender, overlay,  │──────── encryptedPayload) ──────────►   │
 │  feedTopic}        │                                          │
 │ with Bob's pubkey  │                                          │
 └────────────────────┘                                          │
                                                                 ▼
                                                        5. POLL NOTIFICATIONS
                                                       ┌────────────────────┐
                                                       │ registry poll      │
                                                       │                    │
                                                       │ eth_getLogs →      │
                                                       │ ECIES-decrypt →    │
                                                       │ discover Alice's   │
                                                       │ {sender, overlay,  │
                                                       │  feedTopic}        │
                                                       └────────────────────┘
                                                                 │
                                                                 ▼
                                                        6. READ MESSAGES
                                                       ┌────────────────────┐
                                                       │ mailbox read       │
                                                       │                    │
                                                       │ Read Alice's feed →│
                                                       │ ECDH shared secret │
                                                       │ → AES-GCM decrypt  │
                                                       │ → "Project files"  │
                                                       └────────────────────┘
                                                                 │
                                                                 ▼
                                                        7. REPLY
                                                       ┌────────────────────┐
                                                       │ mailbox send       │
                                                       │                    │
 8. CHECK INBOX                                        │ Encrypt + upload   │
 ┌────────────────────┐                                │ to Bob→Alice feed  │
 │ mailbox inbox      │◄───────── Swarm ──────────────│                    │
 │                    │                                └────────────────────┘
 │ "Re: Project files"│
 │ "Got it, thanks!"  │
 └────────────────────┘
```

### Encryption Summary

| Layer | Method | When |
|-------|--------|------|
| Messages (mailbox) | **ECDH + AES-256-GCM** — symmetric, both parties derive same key | Between known contacts |
| Notifications (registry) | **ECIES** — asymmetric, encrypt with recipient's public key | First contact only |
| Identity feeds | Plaintext JSON on Swarm | Public by design |

### What's On-Chain vs Off-Chain

| Data | Where | Cost |
|------|-------|------|
| Identity (public keys, overlay) | **Swarm** feeds | Postage stamp |
| Messages (encrypted) | **Swarm** feeds | Postage stamp |
| Contacts | **Local** storage | Free |
| First-contact notifications | **Gnosis Chain** events | ~22k gas (~0.00002 xDAI) |

## Prerequisites

- Node.js 18+
- A running Bee node (light mode) on `localhost:1633`
- A funded postage stamp batch ID
- A secp256k1 private key

## Setup

```bash
# From the project root
npm install

# Create .env with your config
cat > .env << 'EOF'
PRIVATE_KEY=0x<your-private-key>
BEE_URL=http://localhost:1633
STAMP=<your-postage-batch-id>
GNOSIS_RPC_URL=https://rpc.gnosischain.com
CONTRACT_ADDRESS=0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf
EOF
```

## Commands

```bash
# Identity
npm run cli -- identity publish              # Publish your identity feed
npm run cli -- identity resolve <ethAddress>  # Look up someone's identity

# Contacts
npm run cli -- contacts add <ethAddress> <nickname>   # Add (resolves identity from Swarm)
npm run cli -- contacts add <ethAddress> <nickname> \  # Add manually (no Bee needed)
    --wallet-pub <hex> --overlay <hex>
npm run cli -- contacts remove <ethAddress>           # Remove
npm run cli -- contacts list                          # List all

# Mailbox
npm run cli -- mailbox send <ethAddress> -s "Subject" -b "Body"  # Send message
npm run cli -- mailbox read <ethAddress>                          # Read from contact
npm run cli -- mailbox inbox                                      # Check all contacts

# Registry (on-chain notifications)
npm run cli -- registry notify <ethAddress>      # Send first-contact notification
npm run cli -- registry poll                     # Poll for notifications
npm run cli -- registry poll --from-block 1000   # Poll from specific block
```

## Manual Test: Two-Terminal Demo

This walks through the full notification flow with two identities.

### Setup

Open two terminals. Each represents a different user.

**Terminal 1 (Alice):**
```bash
export PRIVATE_KEY=0x<alice-private-key>
export BEE_URL=http://localhost:1633
export STAMP=<stamp-id>
```

**Terminal 2 (Bob):**
```bash
export PRIVATE_KEY=0x<bob-private-key>
export BEE_URL=http://localhost:1633
export STAMP=<stamp-id>
```

### Steps

1. **Alice publishes her identity:**
   ```bash
   # Terminal 1
   npm run cli -- identity publish
   # → Identity published for 0xAlice...
   ```

2. **Bob publishes his identity:**
   ```bash
   # Terminal 2
   npm run cli -- identity publish
   # → Identity published for 0xBob...
   ```

3. **Alice resolves Bob and adds as contact:**
   ```bash
   # Terminal 1
   npm run cli -- identity resolve 0xBob...
   npm run cli -- contacts add 0xBob... "Bob"
   ```

4. **Bob resolves Alice and adds as contact:**
   ```bash
   # Terminal 2
   npm run cli -- identity resolve 0xAlice...
   npm run cli -- contacts add 0xAlice... "Alice"
   ```

5. **Alice sends Bob a message:**
   ```bash
   # Terminal 1
   npm run cli -- mailbox send 0xBob... -s "Project files" -b "Attached the latest version"
   ```

6. **Alice sends on-chain notification (first contact):**
   ```bash
   # Terminal 1
   npm run cli -- registry notify 0xBob...
   # → Notification sent, tx: 0x...
   ```

7. **Bob polls for notifications:**
   ```bash
   # Terminal 2
   npm run cli -- registry poll
   # → Found 1 notification: sender=0xAlice...
   ```

8. **Bob reads Alice's message:**
   ```bash
   # Terminal 2
   npm run cli -- mailbox read 0xAlice...
   # → [timestamp] Project files
   #     Attached the latest version
   ```

9. **Bob replies:**
   ```bash
   # Terminal 2
   npm run cli -- mailbox send 0xAlice... -s "Re: Project files" -b "Got it, thanks!"
   ```

10. **Alice checks inbox:**
    ```bash
    # Terminal 1
    npm run cli -- mailbox inbox
    # → Bob (1 message)
    #     [timestamp] Re: Project files
    #       Got it, thanks!
    ```

## Data Storage

- **Contacts** are stored in `./data/contacts/` (localStorage polyfill)
- **Messages** are stored on the Swarm network (encrypted)
- **Notifications** are on Gnosis Chain (ECIES-encrypted events)

To reset contacts: `rm -rf ./data/contacts/`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | Yes | — | secp256k1 private key (hex, 0x-prefixed) |
| `BEE_URL` | No | `http://localhost:1633` | Bee node API URL |
| `STAMP` | For writes | — | Postage stamp batch ID |
| `GNOSIS_RPC_URL` | No | `https://rpc.gnosischain.com` | Gnosis Chain RPC endpoint |
| `CONTRACT_ADDRESS` | No | `0x318aE1...` | SwarmNotificationRegistry address |
