// A6 M1 (ext. M3): persistent CanonicalObject key/value store for the account
// net layer (spec §5 overlay & publish-on-write, §11 platform storage budgets).
//
// This is PLATFORM-SPECIFIC renderer hosting (the shared tree stays pure): the
// browser build (Electron desktop renderer, web, phone) persists to IndexedDB
// under `navigator.storage.persist()`; every other context (node suites, SSR, a
// storage-denied private tab) transparently falls back to an in-memory store so
// nothing ever bricks. It is the overlay/shard STORE ADAPTER the persistent
// storage layer plugs into at M3 (makeShardStoreValidator / pointer gates); M1
// ships the durable KV primitive itself.
//
// Wire discipline: values cross the persistence boundary as CANONICAL BYTES
// (canonicalBytes / parseCanonical): exactly as the fabric frames them, so a
// non-canonical or unsafe value fails LOUDLY at write (CodecError), reads are
// byte-faithful, and byte accounting for the §11 budget is exact.

import { canonicalBytes, parseCanonical, type CanonicalObject } from '@shared/accounts'
import { PARAMS_A3 } from '@shared/accounts/storage/params'

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type KvBackendKind = 'indexeddb' | 'memory'

/** The three §11 platforms whose advertised shard budgets this store enforces. */
export type KvPlatform = 'desktop' | 'desktop-browser' | 'mobile'

const MB = 1024 * 1024

/**
 * The §11 persistence budget in BYTES for a platform: desktop 200 MB /
 * desktop-browser 50 MB (paired with `navigator.storage.persist()`) / mobile
 * 15 MB: the PARAMS_A3 advertised envelope, the SAME number the presence caps
 * announce and the overlay shard gate budgets against. Eviction over this floor
 * is tolerated churn that repair heals (§11).
 */
export function budgetBytesForPlatform(platform: KvPlatform): number {
  const mb =
    platform === 'desktop'
      ? PARAMS_A3.budgetDesktopMb
      : platform === 'mobile'
        ? PARAMS_A3.budgetMobileMb
        : PARAMS_A3.budgetBrowserMb
  return mb * MB
}

// ---------------------------------------------------------------------------
// LRU byte budget (§11): the eviction bookkeeping, shared by both backends
// ---------------------------------------------------------------------------

/**
 * A least-recently-used byte budget over opaque keys. Maintains the exact live
 * byte total and an LRU order (a Map: first entry = least-recently-used); a
 * write that would breach `budgetBytes` evicts LRU keys until it fits. Backend-
 * agnostic pure bookkeeping: the caller applies the returned evictions to its
 * store. `budgetBytes` undefined ⇒ unbounded (tracks totals, never evicts), so
 * the no-budget store is byte-for-byte the previous behavior.
 *
 * §11 rationale: over-budget is EVICTION (churn = repaired), never a write
 * refusal: refusing a legitimate write loses data the network could keep, so a
 * lone value larger than the whole budget still stores (it simply evicts the
 * rest); the shard layer re-replicates whatever was dropped.
 */
interface LruBudget {
  readonly budgetBytes: number | undefined
  used(): number
  /** Populate from an entry already on disk at open (no eviction). */
  seed(key: string, bytes: number): void
  /** Mark `key` most-recently-used (on read). */
  touch(key: string): void
  /** Forget `key` (on delete). */
  drop(key: string): void
  /** Record a write of `key`@`bytes` (replacing any prior), evicting LRU keys to
   *  fit the budget. Returns the evicted keys for the caller to delete. */
  admit(key: string, bytes: number): string[]
  clear(): void
}

function makeLruBudget(budgetBytes?: number): LruBudget {
  const sizes = new Map<string, number>() // insertion order == LRU (first = oldest)
  let used = 0
  return {
    budgetBytes,
    used: () => used,
    seed(key, bytes) {
      if (!sizes.has(key)) {
        sizes.set(key, bytes)
        used += bytes
      }
    },
    touch(key) {
      const b = sizes.get(key)
      if (b !== undefined) {
        sizes.delete(key)
        sizes.set(key, b) // re-insert at the MRU tail
      }
    },
    drop(key) {
      const b = sizes.get(key)
      if (b !== undefined) {
        sizes.delete(key)
        used -= b
      }
    },
    admit(key, bytes) {
      const prev = sizes.get(key)
      if (prev !== undefined) {
        sizes.delete(key)
        used -= prev
      }
      const evicted: string[] = []
      if (budgetBytes !== undefined) {
        while (used + bytes > budgetBytes && sizes.size > 0) {
          const oldest = sizes.keys().next().value as string
          used -= sizes.get(oldest) ?? 0
          sizes.delete(oldest)
          evicted.push(oldest)
        }
      }
      sizes.set(key, bytes)
      used += bytes
      return evicted
    },
    clear() {
      sizes.clear()
      used = 0
    },
  }
}

export interface KvEntry {
  key: string
  value: CanonicalObject
}

/**
 * An async CanonicalObject KV. Keys are opaque non-empty strings (the storage
 * layer maps `${kind}|${target}` overlay keys onto them); values round-trip
 * through the canonical codec, so what comes out is byte-identical to what went
 * in. Enumeration is ascending by key (matching IndexedDB's native key order),
 * so `keys`/`entries` are deterministic across both backends.
 */
export interface KvStore {
  /** Which implementation backs this handle. */
  readonly backend: KvBackendKind
  /** Whether `navigator.storage.persist()` granted durable (non-evictable)
   * storage. Always false for the memory backend / when the request was denied
   * or unavailable. Informational. Eviction is tolerated (§11: churn = repair). */
  readonly persisted: boolean
  get(key: string): Promise<CanonicalObject | null>
  /** Store `value` under `key`, overwriting. Rejects (CodecError) on a
   * non-canonical / unsafe-integer value. The boundary never persists junk. */
  put(key: string, value: CanonicalObject): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  /** Keys (optionally filtered to those starting with `prefix`), ascending. */
  keys(prefix?: string): Promise<string[]>
  /** Key/value pairs (optionally prefix-filtered), ascending by key. */
  entries(prefix?: string): Promise<KvEntry[]>
  /** Number of stored records (optionally under `prefix`). */
  count(prefix?: string): Promise<number>
  /** Sum of stored canonical value byte lengths (§11 budget accounting). */
  bytes(): Promise<number>
  clear(): Promise<void>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Shared codec + key helpers (identical semantics across both backends)
// ---------------------------------------------------------------------------

const DB_NAME = 'chess-accounts-kv'
const STORE_NAME = 'kv'

/** Canonical encode. Throws CodecError on any non-canonical / unsafe value. */
function encode(value: CanonicalObject): Uint8Array {
  return canonicalBytes(value)
}
function decode(bytes: Uint8Array): CanonicalObject {
  return parseCanonical(bytes) as CanonicalObject
}
function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0)
    throw new TypeError('kvStore: key must be a non-empty string')
}

// ---------------------------------------------------------------------------
// In-memory backend (suites, node, SSR, storage-denied fallback)
// ---------------------------------------------------------------------------

/** Budget knobs shared by every factory: an optional §11 byte budget (LRU
 * eviction over it) and an eviction sink (diagnostics / the shard layer's
 * re-replication trigger). Absent budget ⇒ unbounded (previous behavior). */
export interface KvBudgetOpts {
  /** LRU byte budget (§11). Default unbounded. Prefer budgetBytesForPlatform(). */
  budgetBytes?: number
  /** Called with each key evicted to honor the budget (eviction = churn). */
  onEvict?: (key: string) => void
}

/** A non-persistent KvStore over a Map. Pure (no DOM, no node built-ins) so
 * it runs headless under the account net suites exactly as it does in a browser
 * that can't reach IndexedDB. With `budgetBytes` it enforces the §11 budget via
 * LRU eviction (get counts as a use); unbounded by default. */
export function createMemoryKvStore(opts: KvBudgetOpts = {}): KvStore {
  const map = new Map<string, Uint8Array>()
  const lru = makeLruBudget(opts.budgetBytes)
  const onEvict = opts.onEvict
  const selectKeys = (prefix?: string): string[] => {
    const out: string[] = []
    for (const k of map.keys()) if (prefix === undefined || k.startsWith(prefix)) out.push(k)
    out.sort() // UTF-16 code-unit order == IndexedDB string key order
    return out
  }
  return {
    backend: 'memory',
    persisted: false,
    async get(key) {
      assertKey(key)
      const b = map.get(key)
      if (b === undefined) return null
      lru.touch(key) // a read makes the key most-recently-used
      return decode(b)
    },
    async put(key, value) {
      assertKey(key)
      const enc = encode(value) // encode throws before ANY mutation on bad input
      for (const k of lru.admit(key, enc.byteLength)) {
        map.delete(k)
        onEvict?.(k)
      }
      map.set(key, enc)
    },
    async delete(key) {
      assertKey(key)
      if (map.delete(key)) lru.drop(key)
    },
    async has(key) {
      assertKey(key)
      return map.has(key)
    },
    async keys(prefix) {
      return selectKeys(prefix)
    },
    async entries(prefix) {
      return selectKeys(prefix).map((k) => ({ key: k, value: decode(map.get(k) as Uint8Array) }))
    },
    async count(prefix) {
      return prefix === undefined ? map.size : selectKeys(prefix).length
    },
    async bytes() {
      return lru.used() // exact live total (Σ encoded byte lengths), O(1)
    },
    async clear() {
      map.clear()
      lru.clear()
    },
    async close() {
      /* nothing to release */
    },
  }
}

// ---------------------------------------------------------------------------
// IndexedDB backend (browser: desktop renderer, web, phone)
// ---------------------------------------------------------------------------

interface StorageLikePersist {
  persist?: () => Promise<boolean>
  persisted?: () => Promise<boolean>
}
interface GlobalWithIdb {
  indexedDB?: IDBFactory
}
interface GlobalWithStorage {
  navigator?: { storage?: StorageLikePersist }
}

export interface OpenKvStoreOpts extends KvBudgetOpts {
  /** IndexedDB database name. Default 'chess-accounts-kv'. */
  dbName?: string
  /** Object-store name. Default 'kv'. */
  storeName?: string
  /** Schema version. Default 1. */
  version?: number
  /** Injected IDBFactory (suites / non-global environments). Default
   * `globalThis.indexedDB`. */
  indexedDB?: IDBFactory
  /** Request durable storage via `navigator.storage.persist()`. Default true. */
  requestPersist?: boolean
  /** Injected StorageManager-like object (suites). Default
   * `globalThis.navigator.storage`. */
  storage?: StorageLikePersist
  /** Force the in-memory backend regardless of environment (suites / opt-out). */
  forceMemory?: boolean
}

/** Promisify a single IDBRequest. */
function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = (): void => resolve(r.result)
    r.onerror = (): void => reject(r.error ?? new Error('kvStore: IndexedDB request failed'))
  })
}

function openDb(
  idb: IDBFactory,
  dbName: string,
  storeName: string,
  version: number,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(dbName, version)
    req.onupgradeneeded = (): void => {
      const db = req.result
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
    }
    req.onsuccess = (): void => resolve(req.result)
    req.onerror = (): void => reject(req.error ?? new Error('kvStore: IndexedDB open failed'))
    // Another tab holding an older version open blocks the upgrade; the success
    // handler still fires once it closes, so this is only diagnostic.
    req.onblocked = (): void => {}
  })
}

async function requestPersist(storage?: StorageLikePersist): Promise<boolean> {
  const s = storage ?? (globalThis as GlobalWithStorage).navigator?.storage
  if (!s) return false
  try {
    if (typeof s.persisted === 'function' && (await s.persisted())) return true
    if (typeof s.persist === 'function') return await s.persist()
  } catch {
    /* denied / unavailable: non-fatal, we simply run non-durable */
  }
  return false
}

/**
 * Open the IndexedDB-backed store. Throws when no IndexedDB is reachable: use
 * `openKvStore` for the fall-back-to-memory factory. Each operation runs in its
 * own short transaction (no cross-await transaction lifetimes, the classic IDB
 * footgun), so concurrent callers never share (and prematurely commit) a txn.
 */
export async function openIndexedDbKvStore(opts: OpenKvStoreOpts = {}): Promise<KvStore> {
  const idb = opts.indexedDB ?? (globalThis as GlobalWithIdb).indexedDB
  if (!idb) throw new Error('kvStore: no IndexedDB in this environment')
  const dbName = opts.dbName ?? DB_NAME
  const storeName = opts.storeName ?? STORE_NAME
  const version = opts.version ?? 1
  const db = await openDb(idb, dbName, storeName, version)
  const persisted = opts.requestPersist === false ? false : await requestPersist(opts.storage)

  const store = (mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(storeName, mode).objectStore(storeName)

  /** Cursor-scan every record in ascending key order. */
  const forEach = (visit: (key: string, value: Uint8Array) => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const cur = store('readonly').openCursor()
      cur.onsuccess = (): void => {
        const c = cur.result
        if (!c) {
          resolve()
          return
        }
        visit(c.key as string, c.value as Uint8Array)
        c.continue()
      }
      cur.onerror = (): void => reject(cur.error ?? new Error('kvStore: cursor failed'))
    })

  const keys = async (prefix?: string): Promise<string[]> => {
    const out: string[] = []
    await forEach((k) => {
      if (prefix === undefined || k.startsWith(prefix)) out.push(k)
    })
    return out
  }

  // §11 LRU byte budget. When set, seed the exact live total + LRU order from
  // disk once at open, then maintain it on every mutation; over-budget writes
  // evict the least-recently-used rows (eviction = churn = repaired). When
  // unset the store is unbounded. Every path below stays byte-identical to the
  // pre-budget behavior (no seed scan, no eviction, bytes() cursor-sums).
  const lru = makeLruBudget(opts.budgetBytes)
  const budgeted = opts.budgetBytes !== undefined
  const onEvict = opts.onEvict
  if (budgeted) await forEach((k, b) => lru.seed(k, b.byteLength))

  return {
    backend: 'indexeddb',
    persisted,
    async get(key) {
      assertKey(key)
      const v = await reqP(store('readonly').get(key))
      if (v === undefined) return null
      if (budgeted) lru.touch(key)
      return decode(v as Uint8Array)
    },
    async put(key, value) {
      assertKey(key)
      const bytes = encode(value) // throws (rejects) before opening a txn
      if (budgeted) {
        for (const k of lru.admit(key, bytes.byteLength)) {
          await reqP(store('readwrite').delete(k))
          onEvict?.(k)
        }
      }
      await reqP(store('readwrite').put(bytes, key))
    },
    async delete(key) {
      assertKey(key)
      await reqP(store('readwrite').delete(key))
      if (budgeted) lru.drop(key)
    },
    async has(key) {
      assertKey(key)
      return (await reqP(store('readonly').count(key))) > 0
    },
    keys,
    async entries(prefix) {
      const out: KvEntry[] = []
      await forEach((k, b) => {
        if (prefix === undefined || k.startsWith(prefix)) out.push({ key: k, value: decode(b) })
      })
      return out
    },
    async count(prefix) {
      if (prefix === undefined) return reqP(store('readonly').count())
      return (await keys(prefix)).length
    },
    async bytes() {
      if (budgeted) return lru.used() // exact live total, maintained since open
      let n = 0
      await forEach((_k, b) => {
        n += b.byteLength
      })
      return n
    },
    async clear() {
      await reqP(store('readwrite').clear())
      lru.clear()
    },
    async close() {
      db.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Factory: IndexedDB where available, memory everywhere else
// ---------------------------------------------------------------------------

/**
 * Open the best available KvStore: IndexedDB when reachable (durable storage
 * requested), otherwise an in-memory store. IndexedDB open failures (private
 * mode, quota, blocked) degrade HONESTLY to memory rather than throwing. Data
 * won't survive a reload, but nothing bricks (§11 tolerates eviction/churn; the
 * shard layer re-replicates). Inspect `.backend` to know which you got.
 */
export async function openKvStore(opts: OpenKvStoreOpts = {}): Promise<KvStore> {
  // The §11 budget is honored on WHICHEVER backend we land on. A private-tab /
  // no-IDB user still evicts over the platform floor (churn = repaired).
  const memOpts: KvBudgetOpts = {
    ...(opts.budgetBytes !== undefined ? { budgetBytes: opts.budgetBytes } : {}),
    ...(opts.onEvict !== undefined ? { onEvict: opts.onEvict } : {}),
  }
  if (opts.forceMemory) return createMemoryKvStore(memOpts)
  const idb = opts.indexedDB ?? (globalThis as GlobalWithIdb).indexedDB
  if (!idb) return createMemoryKvStore(memOpts)
  try {
    return await openIndexedDbKvStore({ ...opts, indexedDB: idb })
  } catch {
    return createMemoryKvStore(memOpts)
  }
}
