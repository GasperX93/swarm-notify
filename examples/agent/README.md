# Polling Agent — Minimal Template

A runnable autonomous agent that publishes its identity, polls for new contacts and messages, and auto-responds.

## Setup

```bash
# From the project root
export BEE_URL=http://localhost:1633
export STAMP=<your-postage-batch-id>

# Optional
export GNOSIS_RPC_URL=https://rpc.gnosischain.com
export CONTRACT_ADDRESS=0x318aE190B77bA39fbcdFA4e84BB7CFD16b846Fcf
export POLL_INTERVAL=30000  # ms, default 30s
```

## Run

```bash
npx ts-node examples/agent/index.ts
```

## What it does

1. **Startup:** Generates or loads a key pair from `data/agent/key.json`
2. **Publishes identity** to Swarm (so other agents can discover it)
3. **Polling loop** (every 30s):
   - Polls Gnosis Chain for new notification events (discovers new contacts)
   - Checks inbox across all known contacts
   - Auto-responds with an acknowledgment to any new message
4. **Persists** contacts (`data/agent/contacts.json`) and last-processed block (`data/agent/last-block.txt`)

## Data

All state is stored in `data/agent/`:

| File | Purpose |
|------|---------|
| `key.json` | Agent's private key (hex) |
| `contacts.json` | Known contacts (ContactStore export) |
| `last-block.txt` | Last processed block number for registry polling |

## Customization

- **Message handling:** Edit `handleMessage()` to process incoming messages (currently echo/ack)
- **Poll interval:** Set `POLL_INTERVAL` env var (ms)
- **Sending notifications:** The agent uses a read-only provider. To send on-chain notifications, replace `createProvider()` with a signing provider (see `examples/provider.ts`)

## See Also

- [Agent integration guide](../../docs/agent-integration.md) — full guide with patterns
- [CLI reference app](../cli.ts) — interactive command-line usage
