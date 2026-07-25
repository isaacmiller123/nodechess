// A6 M1: the per-client account peer (spec §2.2 per-client node stack, §4
// witness fabric, §5 overlay, §11 platform budgets).
//
// Every signed-in client runs THIS on top of a FabricEndpoint. From the device
// signing identity it derives `nodeId = sha256(root)`, builds the Kademlia
// overlay node, bootstraps its routing table from the fabric directory, and
// registers `witnessServe` + `memberServe` so the client is itself an eligible
// witness / PIN-committee member. Then announces a SIGNED presence with the
// per-platform caps (§11: witness+committee true, shardMb by platform). It is an
// app-lifetime singleton: started on sign-in, stopped on sign-out.
//
// PLATFORM-SPECIFIC renderer hosting (the shared tree stays pure). The fabric is
// INJECTED: a `MockFabric` endpoint in suites, Lane A's `createBrowserFabric`
// (native WebRTC + trystero) in production, so this module is transport-
// agnostic and unit-testable headless. Clock is injected (`now`), defaulting to
// Date.now (the renderer layer is where wall-clock time is allowed).

import {
  MemoryWitnessStore,
  PARAMS_A2,
  PARAMS_A2_DIGEST,
  memberServe,
  nodeIdOf,
  signPresence,
  witnessServe,
  type FabricEndpoint,
  type FuseRecord,
  type MemberServeHandle,
  type NodeId,
  type PresenceBody,
  type SignedPresence,
  type WitnessServeHandle,
  type WitnessStore,
} from '@shared/accounts/witness'
import { createOverlayNode, type MergeFn, type OverlayNodeExt, type StoreValidator } from '@shared/accounts/overlay'
import { PARAMS_A3 } from '@shared/accounts/storage/params'
import type { B64u } from '@shared/accounts'
import type { KvStore } from './kvStore'

// ---------------------------------------------------------------------------
// Platform → advertised caps (§11)
// ---------------------------------------------------------------------------

export type Platform = 'desktop' | 'desktop-browser' | 'mobile'

export interface PresenceCaps {
  witness: boolean
  committee: boolean
  /** Advertised shard budget, MB (§11). */
  shardMb: number
}

interface GlobalWithNav {
  navigator?: { userAgent?: string }
}

/**
 * Best-effort platform detection from the user agent (only used to pick the
 * default shard budget). Electron desktop → desktop; a phone/tablet browser →
 * mobile; anything else (incl. a headless/no-navigator context) →
 * desktop-browser. Always overridable via `opts.platform` / `opts.caps`.
 */
export function detectPlatform(): Platform {
  const ua = (globalThis as GlobalWithNav).navigator?.userAgent ?? ''
  if (/Electron/i.test(ua)) return 'desktop'
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile'
  return 'desktop-browser'
}

/** The default §11 capability envelope for a platform (witness + committee on,
 * shard budget per PARAMS_A3). */
export function defaultCapsFor(platform: Platform): PresenceCaps {
  const shardMb =
    platform === 'desktop'
      ? PARAMS_A3.budgetDesktopMb
      : platform === 'mobile'
        ? PARAMS_A3.budgetMobileMb
        : PARAMS_A3.budgetBrowserMb
  return { witness: true, committee: true, shardMb }
}

// ---------------------------------------------------------------------------
// Identity + options
// ---------------------------------------------------------------------------

/** The signed-in device signing identity the peer runs as. In production this
 * is exactly Lane C's `deviceSigningKey()` result (`{ priv, key, root }`). */
export interface AccountPeerIdentity {
  /** Account root pubkey (b64u). `nodeId = sha256(root)`. */
  root: B64u
  /** Device signing child pubkey (advertised in presence, certified in chain). */
  key: B64u
  /** Device signing child private key. Signs presence + attestations/grants. */
  priv: Uint8Array
}

/** Overlay tuning passthrough (suite overrides; storage-layer merge for M3). */
export interface OverlayTuning {
  kBucket?: number
  alpha?: number
  replicateK?: number
  knownCap?: number
  merge?: MergeFn
}

export interface StartAccountPeerOpts {
  identity: AccountPeerIdentity
  /** Injected transport endpoint for THIS node. Its `nodeId` MUST equal
   * `sha256(root)`. Lane A's browser fabric in prod, a MockFabric endpoint in
   * suites. */
  fabric: FabricEndpoint
  /** Presence caps. Default: the per-platform §11 envelope. Partial overrides
   * merge over the default. */
  caps?: Partial<PresenceCaps>
  /** Platform (only picks the default caps). Default: `detectPlatform()`. */
  platform?: Platform
  /** Single wall-clock source (ms) for the overlay clock AND witnessed time.
   * Default `Date.now`. */
  now?: () => number
  /** Params revision advertised in presence + coordinated under. Default
   * PARAMS_A2_DIGEST (matches the operator peer, so they coordinate together). */
  paramsDigest?: B64u
  /** Advertised trailing-30d uptime percent (0-100). Default 100. */
  uptimePct?: number
  /** Fork-detection gossip memory (C-1). Default a fresh MemoryWitnessStore. */
  witnessStore?: WitnessStore
  /** Shared fuse view consulted before granting / evaluating. Default none. */
  fuseOf?: (root: B64u) => FuseRecord | null
  /** Overlay STORE gate (the storage layer installs this at M3). Default: the
   * overlay's own record-only validator. */
  validator?: StoreValidator
  /** Overlay tuning overrides. */
  overlay?: OverlayTuning
  /** Bootstrap seeds. Default: the fabric directory (Kademlia). */
  seeds?: SignedPresence[]
  /** Run `bootstrap()` during start. Default true. Suites that need
   * announce-all-then-bootstrap-all set false and call `peer.bootstrap()`. */
  autoBootstrap?: boolean
  /** Re-announce presence every N ms (browser keepalive: presence is
   * ephemeral, §4/§11). Default: off (no timer; determinism preserved). */
  announceIntervalMs?: number
  /** Persistent CanonicalObject store for overlay/shard persistence (M3). Held
   * on the peer for the lead / M3 to wire; unused by the M1 core. */
  kv?: KvStore
  /** `stop()` closes the injected fabric. Default true (the browser fabric is
   * 1:1 with the signed-in identity). Set false when the caller owns it. */
  ownsFabric?: boolean
}

// ---------------------------------------------------------------------------
// AccountPeer
// ---------------------------------------------------------------------------

export interface AccountPeer {
  readonly nodeId: NodeId
  readonly root: B64u
  readonly key: B64u
  readonly caps: PresenceCaps
  readonly fabric: FabricEndpoint
  readonly overlay: OverlayNodeExt
  readonly witness: WitnessServeHandle
  readonly member: MemberServeHandle
  /** The persistent store handed in (M3 wiring), or null. */
  readonly kv: KvStore | null
  /** (Re)broadcast this peer's signed presence into the fabric. */
  announce(nowMs?: number): void
  /** (Re)seed the routing table from the fabric directory (or `seeds`) + a
   * self-lookup. Safe to call repeatedly as the directory fills (e.g. after
   * more peers join the room). */
  bootstrap(seeds?: SignedPresence[]): Promise<void>
  /** Tear down: stop re-announce, close the overlay (peers observe us as
   * unreachable and evict us), and: when `ownsFabric`. Close the fabric. */
  stop(): Promise<void>
}

/**
 * Build and start the per-client node stack over an injected fabric endpoint.
 * Order: overlay (registers overlay-* handlers) → witness/member serve
 * (registers before we advertise the caps we must then honor) → announce signed
 * presence → bootstrap the routing table.
 */
export async function startAccountPeer(opts: StartAccountPeerOpts): Promise<AccountPeer> {
  const { identity, fabric } = opts
  const root = identity.root
  const nodeId = nodeIdOf(root)
  if (fabric.nodeId !== nodeId)
    throw new Error(
      `peerService: injected fabric nodeId ${fabric.nodeId} != sha256(root) ${nodeId}, mint the endpoint for this identity`,
    )

  const now = opts.now ?? ((): number => Date.now())
  const platform = opts.platform ?? detectPlatform()
  const caps: PresenceCaps = { ...defaultCapsFor(platform), ...opts.caps }
  const paramsDigest = opts.paramsDigest ?? PARAMS_A2_DIGEST
  const uptimePct = opts.uptimePct ?? 100

  // 1. Overlay node over the injected fabric (registers overlay-* handlers now).
  const overlay = createOverlayNode(
    fabric,
    { root, key: identity.key },
    {
      nowMs: now,
      ...(opts.validator ? { validator: opts.validator } : {}),
      ...(opts.overlay ?? {}),
    },
  )

  // 2. Serve as an eligible witness + PIN-committee member. Register BEFORE the
  //    announce so we can honor the witness/committee caps the moment we
  //    advertise them.
  const serveId = { nodeId, key: identity.key, priv: identity.priv }
  const witness = witnessServe(fabric, serveId, {
    store: opts.witnessStore ?? new MemoryWitnessStore(),
    wts: now,
    ...(opts.fuseOf ? { fuseOf: opts.fuseOf } : {}),
    timeWindowMs: PARAMS_A2.timeWindowMs,
  })
  const member = memberServe(fabric, serveId, {
    wts: now,
    ...(opts.fuseOf ? { fuseOf: opts.fuseOf } : {}),
  })

  // 3. Announce signed presence with the per-platform caps (§11).
  const announce = (nowMs: number = now()): void => {
    const body: PresenceBody = {
      v: 1,
      root,
      key: identity.key,
      caps: { witness: caps.witness, committee: caps.committee, shardMb: caps.shardMb },
      params: paramsDigest,
      ts: nowMs,
      uptimePct,
    }
    const sp: SignedPresence = signPresence(body, identity.priv)
    fabric.announce(sp)
  }
  announce()

  // Optional browser keepalive re-announce (presence expires; a live tab must
  // refresh it). Off by default so suites stay timer-free / deterministic.
  let timer: ReturnType<typeof setInterval> | undefined
  if (opts.announceIntervalMs !== undefined && opts.announceIntervalMs > 0)
    timer = setInterval(() => announce(), opts.announceIntervalMs)

  // 4. Bootstrap the routing table from the directory + self-lookup.
  if (opts.autoBootstrap !== false) await overlay.bootstrap(opts.seeds)

  let stopped = false
  return {
    nodeId,
    root,
    key: identity.key,
    caps,
    fabric,
    overlay,
    witness,
    member,
    kv: opts.kv ?? null,
    announce,
    bootstrap: (seeds) => overlay.bootstrap(seeds ?? opts.seeds),
    async stop() {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      await overlay.close()
      if (opts.ownsFabric !== false) await fabric.close()
    },
  }
}

// ---------------------------------------------------------------------------
// App-lifetime singleton (started on sign-in, stopped on sign-out)
// ---------------------------------------------------------------------------

let current: AccountPeer | null = null
let pending: Promise<AccountPeer> | null = null

/** The live account peer, or null when signed out / not yet started. */
export function getAccountPeer(): AccountPeer | null {
  return current
}

/**
 * Start the app-lifetime peer (idempotent): a second call while one is live or
 * mid-start returns the SAME instance/promise. Call `stopAccountPeerSingleton`
 * before starting a different identity.
 */
export async function startAccountPeerSingleton(opts: StartAccountPeerOpts): Promise<AccountPeer> {
  if (current) return current
  if (pending) return pending
  pending = (async () => {
    try {
      const peer = await startAccountPeer(opts)
      current = peer
      return peer
    } finally {
      pending = null
    }
  })()
  return pending
}

/** Stop + clear the app-lifetime peer (sign-out). Waits out an in-flight start
 * first so a start/stop race can't leak a live peer. No-op when none is live. */
export async function stopAccountPeerSingleton(): Promise<void> {
  if (pending) {
    try {
      await pending
    } catch {
      /* the start already failed: nothing to stop */
    }
  }
  const peer = current
  current = null
  if (peer) await peer.stop()
}
