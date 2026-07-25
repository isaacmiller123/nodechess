// A6 M3, LIVE STORAGE DUTY: wire the §5 storage substrate into the running
// AccountPeer overlay (spec §5 three retention layers / publish-on-write /
// authenticated pointers / repair, §11 per-platform budgets).
//
// The §5 substrate is FULLY BUILT + tested (storage/{rs,shards,pointers,viewer}.ts,
// proven bit-faithful in scripts/test-accounts-reconstruct.mjs). This module does
// NOT reimplement any of it. It COMPOSES it onto a live overlay node:
//
//   1. makeStorageDutyGate. The overlay STORE-ACCEPT gate: makeShardStoreValidator
//      (kind 'shard'/'events', capacity-budgeted) composed over
//      makePointerStoreValidator (kind 'pointers', duty-checked) + the pointer
//      merge. The lead passes {validator, merge} into startAccountPeer; the gate
//      handle exposes usedBytes()/subjects() for accounting + the repair worklist.
//   2. publishWitnessedWrite, publish-on-write of one just-landed witnessed event
//      (segment/checkpoint/…): replicate it under the subject key so the guaranteed
//      floor (the events row) carries it the instant it is created (§5).
//   3. finalSyncOwnChain. The §5 final sync: cut a snapshot of the OWNER's full
//      chain, erasure-code it, and leave every row in shard space at its duty key,
//      PLUS a self 'chain' pointer whose embedded countersigned head survives the
//      owner going offline (it pins the head on the floor path). This is what makes
//      an account's chain reconstructible with the owner gone forever.
//   4. publishHeldShardPointers. The carrier side: for every shard row THIS node
//      is an assigned duty carrier of, publish an authenticated 'shard' pointer so
//      viewers enumerate the real carriers (the write-time index; §5 viewing never
//      searches).
//   5. publishSegmentPointerFor. The entanglement side: publish a 'segment' pointer
//      under a partner's key from THEIR countersigned segment event naming us, the
//      §5 "I hold a segment of X" record (only a real entanglement partner can mint
//      one). The live wire that hands us the opponent's segment is an M2/M4 seam.
//   6. runShardRepair / startShardRepairLoop. The background repair loop
//      (storage/shards.ts runRepair) on a cadence: eviction = churn = HEALED. When
//      observed live rows fall below kRec + headroom the freshest reconstructible
//      snapshot is re-encoded and redistributed to live carriers.
//
// Honest degradation (spec C-8): every scarcity, signed out, no peer, no reachable
// carriers, over-budget, is a NO-OP / typed report, NEVER a crash and NEVER a fake
// profile. The viewer surfaces temporary unavailability that repair heals.
//
// Renderer-hosted (it drives a live OverlayNode), but every byte is A1/A2/A3 crypto
// from @shared: `src/shared/accounts` stays pure. Clocks + directory snapshots are
// INJECTED so the whole path runs headless over a MockFabric fleet
// (scripts/test-accounts-shard-duty.mjs) exactly as it runs in the browser.

import { certsProving, chainToBytes } from '@shared/accounts'
import type { B64u, Chain, SignedEvent } from '@shared/accounts/types'
import type { NodeDirectory, NodeId } from '@shared/accounts/witness'
import type { MergeFn, OverlayNode, StoreValidator } from '@shared/accounts/overlay'
import {
  PARAMS_A3,
  finalSync,
  isOnDuty,
  makePointerStoreValidator,
  makeSegmentPointer,
  makeShardPointer,
  makeShardStoreValidator,
  makeChainPointer,
  publishPointer,
  publishWitnessedEvent,
  runRepair,
  shardKey,
} from '@shared/accounts/storage'
import { sha256, toB64u } from '@shared/accounts/hash'
import type {
  RepairAction,
  RepairOpts,
  ShardEnvelope,
  SnapshotHeader,
  VerifyShardOpts,
} from '@shared/accounts/storage'

// ---------------------------------------------------------------------------
// Head helper: the head EVENT (witnessedHeadOf yields only {id,height})
// ---------------------------------------------------------------------------

/** The highest-height witnessed event of a chain (the countersigned head the
 *  final sync commits against), or null when the chain has no witnessed lane. */
function headEventOf(chain: Chain): SignedEvent | null {
  let best: SignedEvent | null = null
  for (const ev of chain.events) {
    if (ev.body.lane !== 'w') continue
    if (!best || ev.body.height > best.body.height) best = ev
  }
  return best
}

// ---------------------------------------------------------------------------
// 1. The composed overlay STORE-ACCEPT gate (§5 store-time verification)
// ---------------------------------------------------------------------------

/** Everything the storage gate needs from the host: the advertised budget, a
 *  live directory snapshot (shard-duty checks) and an injected clock. */
export interface StorageDutyGateOpts {
  /** Advertised shard capacity, MB (PresenceBody.caps.shardMb, §11). */
  shardMb: number
  /** Live directory snapshot provider. Each store is judged under THIS
   *  carrier's current view (C-3 local coordination state). In prod:
   *  `() => peer.fabric.directory()`. */
  directory: () => NodeDirectory
  /** Injected clock (ms). REQUIRED: no ambient time. In prod: the peer clock. */
  nowMs: () => number
  /** Carriers per shard row (default PARAMS_A3.dutyK). */
  dutyK?: number
  /** Per-subject stored-pointer cap (default PARAMS_A3.pointerCapPerKey). */
  capPerKey?: number
  /** Shard-header rule set (suite geometries); default PARAMS_A3 production. */
  verify?: VerifyShardOpts
  /** Exact byte budget override (suite seam; default shardMb·2^20). */
  budgetBytes?: number
}

/** The installed storage gate: the composed validator + merge to hand
 *  createOverlayNode, plus the local-accounting seams the repair loop reads. */
export interface StorageDutyGate {
  /** Pass as startAccountPeer `validator` (kind shard/events/pointers/record). */
  validator: StoreValidator
  /** Pass as startAccountPeer `overlay.merge` (pointers union + storage merge). */
  merge: MergeFn
  /** Bytes of shard rows currently accepted against the budget (§11 accounting). */
  usedBytes(): number
  /** Subject nodeIds this node holds shard rows for. The repair scan worklist. */
  subjects(): NodeId[]
}

/**
 * Build the overlay's storage STORE gate by COMPOSING the two frozen substrate
 * gates: makePointerStoreValidator (kind 'pointers': every record's embedded
 * proof + shard-duty verified under this node's directory) provides the base
 * the shard gate falls through to, and makeShardStoreValidator (kind 'shard'
 * capacity-budgeted + kind 'events' witnessed-lane) sits on top. The overlay
 * runs `gate.validator` before every accept and `gate.merge` as its local
 * fold, so the whole storage layer ('events' union, 'shard' replace-if-fresher,
 * 'pointers' capped union) is one install. `subjects()` is the repair worklist;
 * `usedBytes()` is the live §11 accounting. Nothing here reimplements a verifier.
 * It wires the ones the reconstruct suite already proved.
 */
export function makeStorageDutyGate(opts: StorageDutyGateOpts): StorageDutyGate {
  const pointerGate = makePointerStoreValidator({
    directory: opts.directory,
    nowMs: opts.nowMs,
    ...(opts.dutyK !== undefined ? { dutyK: opts.dutyK } : {}),
    ...(opts.capPerKey !== undefined ? { capPerKey: opts.capPerKey } : {}),
    ...(opts.verify !== undefined ? { shard: opts.verify } : {}),
  })
  const shardGate = makeShardStoreValidator({
    shardMb: opts.shardMb,
    ...(opts.budgetBytes !== undefined ? { budgetBytes: opts.budgetBytes } : {}),
    ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
    // Kinds the shard layer does not own ('pointers', 'record') fall through to
    // the pointer gate. One composed validator gates all four kinds.
    base: pointerGate.validator,
  })
  return {
    validator: shardGate.validator,
    merge: pointerGate.merge,
    usedBytes: shardGate.usedBytes,
    subjects: shardGate.subjects,
  }
}

// ---------------------------------------------------------------------------
// The owner's device signing identity (exactly accounts.deviceSigningKey())
// ---------------------------------------------------------------------------

export interface DutySigning {
  /** Account root pubkey (b64u). The subject key derives from it. */
  root: B64u
  /** Device signing child pubkey (advertised in presence, certified in chain). */
  key: B64u
  /** Device signing child private key. */
  priv: Uint8Array
}

/** Root-signed certs proving `signing.key` belongs to `signing.root` (empty when
 *  the head is root-signed). Pulled from the chain's own personal lane so a
 *  device-signed event/shard is authorizable at every store gate + the viewer. */
function certsFor(signing: DutySigning, chain: Chain): SignedEvent[] {
  return signing.key === signing.root ? [] : certsProving(signing.root, chain.events, [signing.key])
}

// ---------------------------------------------------------------------------
// 2. Publish-on-write: replicate one just-landed witnessed event (§5 floor)
// ---------------------------------------------------------------------------

/**
 * Replicate ONE just-landed witnessed event of the OWNER's own chain onto the
 * replicateK overlay-closest nodes (publish-on-write, §5 "witnessed events
 * replicate at creation"). The certs proving the device key ride the row so a
 * device-signed event is authorizable at every carrier's gate. Cheap: call it
 * on every landed segment/checkpoint. Returns the number of true stores (0 is
 * honest degradation: no reachable carrier yet. Repair + the next final sync
 * catch up, and casual play is untouched). Never throws.
 */
export async function publishWitnessedWrite(
  node: OverlayNode,
  signing: DutySigning,
  chain: Chain,
  event: SignedEvent,
): Promise<number> {
  try {
    return await publishWitnessedEvent(node, signing.root, event, certsFor(signing, chain))
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// 3. Final sync: leave the OWNER's full chain in shard space (§5 expected path)
// ---------------------------------------------------------------------------

export interface FinalSyncOpts extends VerifyShardOpts {
  /** Wall clock (ms) for the self chain-pointer freshness stamp. Default the
   *  event ts of the head, so the whole path stays deterministic headless. */
  nowMs?: number
  /** Skip the self 'chain' pointer (shard rows only). Default false. */
  noChainPointer?: boolean
}

export type FinalSyncOwnChainResult =
  | {
      ok: true
      /** The countersigned snapshot header (blob↔head binding). */
      header: SnapshotHeader
      /** Per shard row: how many carriers truly stored it (put acceptance). */
      perIdx: number[]
      /** Distinct shard rows that landed on ≥1 carrier. */
      liveRows: number
      /** True stores of the self 'chain' pointer (0 when skipped/unreachable). */
      chainPointerStored: number
    }
  | { ok: false; reason: 'no-genesis' | 'head-not-signable' }

/**
 * The §5 FINAL SYNC for the owner's OWN chain: cut a snapshot bound to the
 * current countersigned head, erasure-code the full chain, and store every row
 * at its shardKey(subject, idx) (each row rides node.put → the replicateK
 * closest, the dutyK closest of which are the carriers viewers enumerate). Then
 * publish a self 'chain' pointer whose EMBEDDED head event survives the owner
 * going offline: it pins the head on the guaranteed-floor path even when no
 * shard row is reachable (the reconstruct suite's "the countersigned head STILL
 * pins" invariant). Both paths reuse the frozen substrate verbatim.
 *
 * Honest guards (never a crash): a chain with no witnessed head → 'no-genesis';
 * a head whose signing key is not the supplied device key (e.g. a genesis-only
 * or root-signed tip, which the device priv cannot commit) → 'head-not-signable'
 * (skip: the event was still replicated by publishWitnessedWrite). The zero-
 * capacity owner (a phone, shardMb 0) refuses its OWN rows, so the full chain
 * lands entirely on the network, which is the whole point (§5: the network IS
 * the storage).
 */
export async function finalSyncOwnChain(
  node: OverlayNode,
  signing: DutySigning,
  chain: Chain,
  opts: FinalSyncOpts = {},
): Promise<FinalSyncOwnChainResult> {
  const head = headEventOf(chain)
  if (!head) return { ok: false, reason: 'no-genesis' }
  // finalSync commits blobHash with the head signing key; we can only sign with
  // the device priv, so the head must be device-signed (the post-game case).
  if (head.body.key !== signing.key) return { ok: false, reason: 'head-not-signable' }
  const certs = certsFor(signing, chain)
  const geo: VerifyShardOpts = {
    ...(opts.k !== undefined ? { k: opts.k } : {}),
    ...(opts.n !== undefined ? { n: opts.n } : {}),
    ...(opts.params !== undefined ? { params: opts.params } : {}),
  }
  const fs = await finalSync(node, chain, head, certs, signing.priv, geo)
  const liveRows = fs.perIdx.reduce((acc, c) => acc + (c > 0 ? 1 : 0), 0)

  let chainPointerStored = 0
  if (!opts.noChainPointer) {
    try {
      const ptr = makeChainPointer({
        subject: signing.root,
        holder: signing.root,
        key: signing.key,
        priv: signing.priv,
        ts: opts.nowMs ?? head.body.ts,
        event: head,
        ...(certs.length ? { certs } : {}),
        // holder === subject === root, signed by the device key ⇒ the SAME certs
        // prove the pointer-signing key belongs to the holder root.
        ...(certs.length ? { holderCerts: certs } : {}),
        blobHash: toB64u(sha256(chainToBytes(chain))),
      })
      chainPointerStored = await publishPointer(node, ptr)
    } catch {
      chainPointerStored = 0 // an unsignable/oversize pointer never blocks the sync
    }
  }
  return { ok: true, header: fs.header, perIdx: fs.perIdx, liveRows, chainPointerStored }
}

// ---------------------------------------------------------------------------
// 4. Carrier side: publish authenticated 'shard' pointers for held rows (§5)
// ---------------------------------------------------------------------------

export interface HeldShardPointerOpts {
  /** Live directory snapshot for the objective duty ranking. */
  directory: NodeDirectory
  /** Injected clock (ms). Freshness stamp + presence staleness. */
  nowMs: number
  /** The repair worklist. Typically gate.subjects(). */
  subjects: readonly NodeId[]
  /** Carriers per row (default PARAMS_A3.dutyK). */
  dutyK?: number
  /** Shard-header rule set (suite geometries); default PARAMS_A3. */
  verify?: VerifyShardOpts
}

/**
 * The carrier-side write-time index: for every shard row this node HOLDS and is
 * an assigned duty carrier of (isOnDuty under the supplied directory), publish
 * an authenticated 'shard' pointer naming THIS node as holder, so a viewer
 * enumerating the subject's contact sheet finds the real carriers (§5 "the index
 * is built at write time; viewing never searches"). Reconstruction reads rows by
 * their deterministic keys directly, so these pointers ENRICH the contact sheet
 * (holder ranking, duty proof); an off-duty or over-cap pointer is refused by the
 * gates, so we publish only rows we can prove duty for. Returns Σ true stores.
 * Pure over (holdings, directory, nowMs); never throws.
 *
 * `chain` is THIS carrier's OWN chain. The source of the root-signed device
 * certs proving the pointer-signing key belongs to this holder root (the live
 * peer signs with its device key, never the cold root). key === root ⇒ none.
 */
export async function publishHeldShardPointers(
  node: OverlayNode,
  signing: DutySigning,
  chain: Chain,
  opts: HeldShardPointerOpts,
): Promise<number> {
  const n = opts.verify?.n ?? PARAMS_A3.nShards
  const dutyOpts = { nowMs: opts.nowMs, ...(opts.dutyK !== undefined ? { dutyK: opts.dutyK } : {}) }
  const holderCerts = certsFor(signing, chain)
  let stored = 0
  for (const subject of opts.subjects) {
    for (let idx = 0; idx < n; idx++) {
      let env: ShardEnvelope | null
      try {
        env = node.localGet(shardKey(subject, idx), 'shard') as ShardEnvelope | null
      } catch {
        env = null
      }
      if (env === null) continue
      if (!isOnDuty(node.nodeId, subject, idx, opts.directory, dutyOpts)) continue
      try {
        const ptr = makeShardPointer({
          subject: env.header.root,
          holder: signing.root,
          key: signing.key,
          priv: signing.priv,
          ts: opts.nowMs,
          header: env.header,
          idx,
          ...(holderCerts.length ? { holderCerts } : {}),
          ...(opts.verify !== undefined ? { verify: opts.verify } : {}),
          directory: opts.directory,
          nowMs: opts.nowMs,
          ...(opts.dutyK !== undefined ? { dutyK: opts.dutyK } : {}),
        })
        stored += await publishPointer(node, ptr)
      } catch {
        // A row we cannot prove duty for (directory lag) is skipped, never fatal.
      }
    }
  }
  return stored
}

// ---------------------------------------------------------------------------
// 5. Entanglement side: publish a 'segment' pointer under a partner's key (§5)
// ---------------------------------------------------------------------------

export interface SegmentPointerOpts {
  /** The partner (subject) whose contact sheet this pointer enriches. */
  subject: B64u
  /** The SUBJECT's OWN countersigned segment event naming US as counterparty
   *  (segment.opp === signing.root). Only a real entanglement partner holds one. */
  event: SignedEvent
  /** Certs proving the subject's signing key when the segment is device-signed. */
  certs?: SignedEvent[]
  /** Freshness stamp (ms). Ranking only, never authority. */
  nowMs: number
}

/**
 * Publish a 'segment' pointer under a partner's key: the §5 "I hold a segment of
 * X, hash H" record whose embedded proof is X's OWN countersigned segment event
 * naming us: unmintable by anyone who did not actually play X (the naming rule
 * closes index poisoning). The live seam that hands us the opponent's segment
 * event (each player writes their own chain; the exchange is the M2/M4 pre-game/
 * mailbox transport) supplies `event`; this is the thin publish over it. Returns
 * the number of true stores; never throws.
 */
export async function publishSegmentPointerFor(
  node: OverlayNode,
  signing: DutySigning,
  chain: Chain,
  opts: SegmentPointerOpts,
): Promise<number> {
  try {
    const ptr = makeSegmentPointer({
      subject: opts.subject,
      holder: signing.root,
      key: signing.key,
      priv: signing.priv,
      ts: opts.nowMs,
      event: opts.event,
      ...(opts.certs !== undefined ? { certs: opts.certs } : {}),
      ...(signing.key !== signing.root ? { holderCerts: certsFor(signing, chain) } : {}),
    })
    return await publishPointer(node, ptr)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// 6. Background repair: the §5 heal loop (eviction = churn = healed)
// ---------------------------------------------------------------------------

export interface ShardRepairOpts {
  /** The overlay node whose holdings + fetch + redistribute the tick rides. */
  node: OverlayNode
  /** Live directory snapshot for duty ranking at the tick's clock. */
  directory: NodeDirectory
  /** Subjects to scan. Typically gate.subjects() (+ any this node is on duty
   *  for). */
  subjects: readonly NodeId[]
  /** Injected tick clock (ms). */
  nowMs: number
  /** Geometry / headroom passthrough (default PARAMS_A3 production). */
  repair?: RepairOpts
}

/**
 * One repair TICK (deterministic given holdings + reachable population +
 * directory + clock): scan each subject, observe live rows through the overlay,
 * and when the freshest reconstructible snapshot is below kRec + headroom,
 * re-encode it and redistribute the missing rows to live carriers. A thin,
 * honest wrapper over the frozen storage/shards.ts runRepair. The reconstruct
 * suite proves eviction=churn=healed and that an unrecoverable subject is
 * reported, never crashed. The embedder schedules the cadence
 * (startShardRepairLoop); this tick self-schedules nothing (determinism).
 */
export function runShardRepair(o: ShardRepairOpts): Promise<RepairAction[]> {
  return runRepair(
    {
      node: o.node,
      directory: o.directory,
      subjects: o.subjects,
      ...(o.repair !== undefined ? { opts: o.repair } : {}),
    },
    o.nowMs,
  )
}

export interface ShardRepairLoopOpts {
  node: OverlayNode
  /** The composed gate. Its subjects() is the live repair worklist. */
  gate: Pick<StorageDutyGate, 'subjects'>
  /** Live directory snapshot provider (peer.fabric.directory in prod). */
  directory: () => NodeDirectory
  /** Injected clock (ms). */
  nowMs: () => number
  /** Additional subjects this node is on duty for beyond the ones it already
   *  holds rows of (optional). */
  extraSubjects?: () => readonly NodeId[]
  /** ONLINE-time cadence between ticks. Default PARAMS_A3.repairScanMs (6h). */
  intervalMs?: number
  /** Geometry / headroom passthrough (default PARAMS_A3 production). */
  repair?: RepairOpts
  /** Per-tick report sink (diagnostics / UI). */
  onTick?: (actions: RepairAction[]) => void
  /** Error sink; default swallow (a repair tick must never crash the app). */
  onError?: (err: unknown) => void
}

/**
 * Start the BACKGROUND repair loop on a cadence (§5: scan owned shard space
 * every repairScanMs of ONLINE time; eviction=churn=healed). Ticks run
 * non-overlapping (a slow tick never stacks). Returns a stop handle for
 * sign-out / peer teardown. This is the ONLY timer in the module. Every
 * primitive above is pure/injected so the suite drives runShardRepair directly.
 */
export function startShardRepairLoop(o: ShardRepairLoopOpts): () => void {
  const intervalMs = o.intervalMs ?? PARAMS_A3.repairScanMs
  const onError = o.onError ?? ((): void => {})
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      const held = o.gate.subjects()
      const extra = o.extraSubjects?.() ?? []
      const subjects = [...new Set<NodeId>([...held, ...extra])]
      if (subjects.length > 0) {
        const actions = await runShardRepair({
          node: o.node,
          directory: o.directory(),
          subjects,
          nowMs: o.nowMs(),
          ...(o.repair !== undefined ? { repair: o.repair } : {}),
        })
        o.onTick?.(actions)
      }
    } catch (err) {
      onError(err)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  return (): void => {
    stopped = true
    clearInterval(timer)
  }
}
