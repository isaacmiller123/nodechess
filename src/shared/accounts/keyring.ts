// Local keyring (spec §14-A1: "local keyring"; contract: types.ts KeyStore /
// StoredAccount). Persists per-device account records and chain files through
// a minimal async KV. THE ROOT SEED IS NOT STORED by default: sign-in
// re-derives it; StoredAccount.seedB64u is the explicit "keep me signed in"
// opt-in (types.ts doc).
//
// Platform-neutral: no `node:` imports, no DOM globals. The web adapter works
// over localStorage WITHOUT DOM types via the structural StorageLike below;
// a node file adapter would live outside this tree (server/operator).
//
// Storage layout (all keys namespaced 'acct.v1.'):
//   acct.v1.a.<foldedName>#<TAG> → canonical-JSON StoredAccount
//   acct.v1.c.<rootB64u>         → chainToBytes(chain) (the canonical chain file)

import { z } from 'zod'
import { chainFromBytes, chainToBytes } from './chain'
import { canonicalBytes, compareKeys, type CanonicalValue } from './codec'
import { zB64u32 } from './events'
import type { B64u, Chain, KeyStore, StoredAccount } from './types'

const NS = 'acct.v1.'
const ACCOUNT_PREFIX = `${NS}a.`
const CHAIN_PREFIX = `${NS}c.`

/** Records are keyed by (foldedName, tag). Spec §1: identities sharing a
 *  folded name are disambiguated by tag and must coexist on one device.
 *  '#' cannot survive normalizeUsername, so the delimiter is unambiguous. */
export const accountKeyFor = (foldedName: string, tag: string): string =>
  `${ACCOUNT_PREFIX}${foldedName}#${tag}`
export const chainKeyFor = (root: B64u): string => CHAIN_PREFIX + root

const tagFromKey = (key: string): string => key.slice(key.lastIndexOf('#') + 1)

/** Thrown by tag-less getAccount/removeAccount when several identities share
 *  one folded name. The caller must disambiguate by tag (spec §1). */
export class AmbiguousAccountError extends Error {
  constructor(
    readonly foldedName: string,
    readonly tags: string[],
  ) {
    super(
      `keyring: '${foldedName}' matches ${tags.length} accounts on this device (tags: ${tags.join(', ')}): disambiguate by tag`,
    )
    this.name = 'AmbiguousAccountError'
  }
}

// ---------------------------------------------------------------------------
// KeyStore implementations
// ---------------------------------------------------------------------------

/** In-memory KeyStore: tests and ephemeral sessions. */
export class MemoryKeyStore implements KeyStore {
  private readonly map = new Map<string, Uint8Array>()

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.map.get(key)
    return v === undefined ? null : v.slice()
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.map.set(key, value.slice())
  }

  async del(key: string): Promise<void> {
    this.map.delete(key)
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
}

/**
 * The minimal structural shape of the Web Storage API (localStorage /
 * sessionStorage): declared locally so this module needs NO DOM lib types
 * and still typechecks under tsconfig.node.json.
 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

/**
 * KeyStore over any StorageLike (sync, string-valued). Bytes are stored as
 * base64url-no-pad strings via the manual codec below (no atob/btoa: DOM;
 * no Buffer: node) so the SAME bytes round-trip on every engine.
 */
export class StorageLikeKeyStore implements KeyStore {
  constructor(private readonly storage: StorageLike) {}

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.storage.getItem(key)
    return v === null ? null : decodeB64(v)
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.storage.setItem(key, encodeB64(value))
  }

  async del(key: string): Promise<void> {
    this.storage.removeItem(key)
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i)
      if (k !== null && k.startsWith(prefix)) out.push(k)
    }
    return out.sort()
  }
}

// Manual base64url-no-pad for the storage value encoding: engine-independent,
// no atob/btoa (not in workers everywhere historically, and typing them would
// drag DOM libs in), no Buffer (node-only).
const B64U_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64U_LOOKUP: Record<string, number> = {}
for (let i = 0; i < B64U_ALPHABET.length; i++) B64U_LOOKUP[B64U_ALPHABET[i]] = i

function encodeB64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64U_ALPHABET[b0 >> 2]
    out += B64U_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]
    if (i + 1 < bytes.length) out += B64U_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)]
    if (i + 2 < bytes.length) out += B64U_ALPHABET[b2 & 63]
  }
  return out
}

function decodeB64(s: string): Uint8Array {
  const rem = s.length % 4
  if (rem === 1) throw new Error('keyring: corrupt stored value (bad base64 length)')
  const outLen = Math.floor((s.length * 3) / 4)
  const out = new Uint8Array(outLen)
  let o = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < s.length; i++) {
    const v = B64U_LOOKUP[s[i]]
    if (v === undefined) throw new Error('keyring: corrupt stored value (bad base64 char)')
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// StoredAccount (de)serialization
// ---------------------------------------------------------------------------

const zStoredAccount = z.strictObject({
  v: z.literal(1),
  foldedName: z.string().min(1),
  displayName: z.string().min(1),
  tag: z.string().regex(/^[A-Z2-7]{5}$/),
  rootPub: zB64u32,
  device: z.strictObject({
    index: z.int().min(0),
    pub: zB64u32,
    certEvent: zB64u32,
  }),
  seedB64u: z.string().min(1).optional(),
})

function accountToBytes(acct: StoredAccount): Uint8Array {
  // canonicalBytes gives one deterministic byte stream per record (and throws
  // on malformed input a plain stringify would silently store).
  return canonicalBytes(acct as unknown as CanonicalValue)
}

function accountFromBytes(bytes: Uint8Array): StoredAccount {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const parsed = zStoredAccount.safeParse(JSON.parse(text))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `keyring: stored account record is invalid: ${issue ? `${issue.path.map(String).join('.')}: ${issue.message}` : 'bad shape'}`,
    )
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Keyring
// ---------------------------------------------------------------------------

/**
 * The device keyring: account records + chain files over a KeyStore.
 * Chains persist through the canonical file format (chainToBytes /
 * chainFromBytes) so stored bytes are bit-identical across platforms for
 * equal chains: a stored chain IS the self-carried file (§0).
 */
export class Keyring {
  constructor(private readonly store: KeyStore) {}

  /** Validates, then persists the account record under its (foldedName, tag). */
  async saveAccount(acct: StoredAccount): Promise<void> {
    const checked = zStoredAccount.safeParse(acct)
    if (!checked.success) {
      const issue = checked.error.issues[0]
      throw new Error(
        `keyring: refusing to save invalid account: ${issue ? `${issue.path.map(String).join('.')}: ${issue.message}` : 'bad shape'}`,
      )
    }
    await this.store.set(accountKeyFor(acct.foldedName, acct.tag), accountToBytes(acct))
  }

  /** All record keys for one folded name, the '#' delimiter (never in a
   *  folded name) makes the prefix exact per name. */
  private async accountKeysFor(foldedName: string): Promise<string[]> {
    return (await this.store.list(`${ACCOUNT_PREFIX}${foldedName}#`)).sort()
  }

  /** Exact lookup with `tag`; without it, the sole record for the folded name
   *  (null when none): several tags under one name throw AmbiguousAccountError. */
  async getAccount(foldedName: string, tag?: string): Promise<StoredAccount | null> {
    if (tag !== undefined) {
      const bytes = await this.store.get(accountKeyFor(foldedName, tag))
      return bytes === null ? null : accountFromBytes(bytes)
    }
    const keys = await this.accountKeysFor(foldedName)
    if (keys.length === 0) return null
    if (keys.length > 1) throw new AmbiguousAccountError(foldedName, keys.map(tagFromKey))
    const bytes = await this.store.get(keys[0])
    return bytes === null ? null : accountFromBytes(bytes)
  }

  /** All stored accounts, sorted by (foldedName, tag) (list order is store-agnostic). */
  async listAccounts(): Promise<StoredAccount[]> {
    const keys = await this.store.list(ACCOUNT_PREFIX)
    const out: StoredAccount[] = []
    for (const k of keys.sort()) {
      const bytes = await this.store.get(k)
      if (bytes !== null) out.push(accountFromBytes(bytes))
    }
    out.sort((a, b) => compareKeys(a.foldedName, b.foldedName) || compareKeys(a.tag, b.tag))
    return out
  }

  /** Removes the account RECORD only: never the chain (the chain is the
   *  self-carried history; dropping it is a separate, deliberate act).
   *  Mirrors getAccount: exact with `tag`, sole-match without,
   *  AmbiguousAccountError when several tags share the name. */
  async removeAccount(foldedName: string, tag?: string): Promise<void> {
    if (tag !== undefined) {
      await this.store.del(accountKeyFor(foldedName, tag))
      return
    }
    const keys = await this.accountKeysFor(foldedName)
    if (keys.length > 1) throw new AmbiguousAccountError(foldedName, keys.map(tagFromKey))
    if (keys.length === 1) await this.store.del(keys[0])
  }

  async saveChain(root: B64u, chain: Chain): Promise<void> {
    if (chain.root !== root) throw new Error('keyring: chain root does not match the given root')
    await this.store.set(chainKeyFor(root), chainToBytes(chain))
  }

  /** Loads + strictly parses the stored chain file (null when absent).
   *  Throws on corrupt bytes. Semantic verdicts stay with verifyChain. */
  async loadChain(root: B64u): Promise<Chain | null> {
    const bytes = await this.store.get(chainKeyFor(root))
    return bytes === null ? null : chainFromBytes(bytes)
  }

  async removeChain(root: B64u): Promise<void> {
    await this.store.del(chainKeyFor(root))
  }
}

// Exposed so tests can inspect raw stored values without duplicating the codec.
export const _storageValueCodec = { encodeB64, decodeB64 }
