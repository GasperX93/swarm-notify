// ─── Identity ────────────────────────────────────────────────────

/** A user's published identity on Swarm. Discoverable by ETH address. */
export interface SwarmIdentity {
  /** Compressed secp256k1 public key (66 hex chars) — used for ECDH encryption */
  walletPublicKey: string
  /** Bee node public key — used for ACT grantee lists */
  beePublicKey: string
  /** Bee overlay address — used for mailbox feed topic computation */
  overlay: string
  /** Publisher's ETH address (optional, derivable from feed owner) */
  ethAddress?: string
}

// ─── Messages ────────────────────────────────────────────────────

/** An encrypted message stored in a mailbox feed. */
export interface Message {
  /** Format version */
  v: 1
  /** Message subject line */
  subject: string
  /** Message body text */
  body: string
  /** Unix timestamp in milliseconds */
  ts: number
  /** Sender's overlay address */
  sender: string
  /** Message type — default: 'message' */
  type?: 'message' | 'drive-share'
  /** File attachments (encrypted separately on Swarm) */
  attachments?: Attachment[]
  /** Swarm share link for drive-share messages */
  driveShareLink?: string
  /** Human-readable drive name for drive-share messages */
  driveName?: string
  /** Number of files in shared drive */
  fileCount?: number
}

/** A file attachment — encrypted and uploaded to Swarm separately from the message. */
export interface Attachment {
  /** Original filename */
  name: string
  /** File size in bytes */
  size: number
  /** MIME type */
  mime: string
  /** Swarm reference to the encrypted file blob */
  ref: string
}

// ─── Contacts ────────────────────────────────────────────────────

/** A contact in the user's address book. Keyed by ETH address (stable across devices). */
export interface Contact {
  /** ETH address — primary key, stable across devices */
  ethAddress: string
  /** User-assigned nickname */
  nickname: string
  /** Cached from identity feed — compressed secp256k1 public key for ECDH */
  walletPublicKey: string
  /** Cached from identity feed — Bee node public key for ACT */
  beePublicKey: string
  /** Cached from identity feed — Bee overlay address for feed topics */
  overlay: string
  /** ENS name if known */
  ensName?: string
  /** When this contact was added (unix timestamp ms) */
  addedAt: number
}

// ─── Notifications ───────────────────────────────────────────────

/** Payload sent via the on-chain notification registry (ECIES-encrypted). */
export interface NotificationPayload {
  /** Sender's ETH address */
  sender: string
  /** Sender's Bee overlay address */
  overlay: string
  /** Mailbox feed topic to read messages from */
  feedTopic: string
}

// ─── Crypto ──────────────────────────────────────────────────────

/** Result of AES-256-GCM encryption. */
export interface EncryptedData {
  /** Encrypted bytes */
  ciphertext: Uint8Array
  /** 12-byte random nonce (unique per encryption) */
  nonce: Uint8Array
}

// ─── Framework-agnostic provider ─────────────────────────────────

/**
 * Generic blockchain provider interface for the registry module.
 * Host app wraps its own ethers/web3/viem provider into this interface.
 * Works with ethers v5, v6, viem, or raw fetch — library doesn't care.
 */
export interface NotifyProvider {
  /** Query event logs (eth_getLogs) */
  getLogs(filter: {
    address: string
    topics: string[]
    fromBlock: number
    toBlock?: number | 'latest'
  }): Promise<{ data: string; blockNumber: number }[]>

  /** Read-only contract call (eth_call) */
  call(tx: { to: string; data: string }): Promise<string>

  /** Send a signed transaction. Returns transaction hash. */
  sendTransaction(tx: {
    to: string
    data: string
    value?: string
  }): Promise<string>
}
