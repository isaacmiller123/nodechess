// A3 storage: the reconstruction viewer (spec §5 viewing flow, §2 checkpoint
// verification rules, kickoff item 5; contracts: ./types.ts HolderSummary /
// ReconstructedProfile, ./pointers.ts contact sheet, ./shards.ts shard read
// path, ../checkpoint.ts incremental/deep verification).
//
// The owner-gone flow: resolve(subject) → ONE overlay lookup for the
// authenticated pointer row (the index was built at write time; viewing never
// searches) → verified contact sheet → assemble the profile page from the
// 3-5 freshest legitimate holders (newest witnessed head + newest M-of-N
// checkpoint + profile), every element verified per §2 (incremental step +
// spot-check), THEN the full chain via the shard layer (any kRec of nShards
// rows reconstruct, blob bound to the countersigned head). Guaranteed floor =
// the union of survivors' VERIFIED holdings; expected = everything via the
// shard layer + final sync. Failure mode is temporary unavailability that
// heals (honest typed reports), never silent loss and never unverified bytes.
//
// Authority NEVER comes from the overlay, the publisher, or possession of
// bytes (§0): every acceptance decision here is a pure verifier over owner
// signatures + witness attestations. The overlay only moves bytes.
//
// Determinism rules (suite-load-bearing): platform-neutral (no `node:`
// imports, no DOM globals), no Date.now / Math.random / timers. Clocks,
// directory snapshots, and the §2 spot-check draw are all INJECTED by the
// caller. Every verifier is pure, fails closed, and is byte-identical on node
// and in the browser bundle. Distance/duty math reuses witness/distance.ts via
// pointers/shards; chain and checkpoint verification reuse ../chain.ts and
// ../checkpoint.ts: nothing is reimplemented.

import { z } from 'zod'
import { certSetFrom, certsProving } from '../certs'
import { appendEvent, chainFromBytes, verifyChain } from '../chain'
import { verifyCheckpointDeep, verifyCheckpointIncremental } from '../checkpoint'
import { compareKeys, type CanonicalObject, type CanonicalValue } from '../codec'
import { eventId, verifyEventSig, zCkptEvent, zSignedEvent, zSignedEventCore } from '../events'
import {
  PROFILE_FIELDS,
  type B64u,
  type Chain,
  type CheckpointPayload,
  type EventId,
  type SignedEvent,
} from '../types'
import { verifyAttestation, verifyCheckpointCosigners } from '../witness/attest'
import { nodeIdOf, prefixBucket } from '../witness/distance'
import type { CheckpointCosigRule, NodeId } from '../witness/types'
import { PARAMS_A3 } from './params'
import {
  buildContactSheet,
  checkPointer,
  pointerKeyOfRoot,
  type PointerReadNode,
  type VerifyPointerOpts,
} from './pointers'
import {
  EVENTS_CERTS_MAX,
  HEADER_CERTS_MAX,
  reconstructTolerant,
  shardKey,
  verifyShardEnvelope,
  type VerifyShardOpts,
} from './shards'
import type {
  ContactSheet,
  HolderSummary,
  PointerKind,
  PointerRecord,
  ReconstructedProfile,
  ShardEnvelope,
} from './types'

// ---------------------------------------------------------------------------
// Bounds (viewer-side hygiene caps: processing bounds, not revisable params)
// ---------------------------------------------------------------------------

/** Max events of a merged 'events' row the viewer verifies per resolve. Real
 * rows grow only with real chain growth (every member costs a witness
 * countersignature to mint), so this bounds hostile-responder CPU, not honest
 * data; processed newest-first (plus genesis candidates) when exceeded. */
export const VIEWER_EVENTS_MAX = 8192

/** Max profile events a HolderSummary may carry (fast-path page budget). */
export const SUMMARY_PROFILE_MAX = 16

// ---------------------------------------------------------------------------
// Options & result surfaces
// ---------------------------------------------------------------------------

/** §2 checkpoint-audit context. `spot` is the INJECTED probabilistic draw
 * (roll ∈ [0,1) from the caller's RNG; drawn when roll < p): the viewer has
 * no ambient randomness. `cosig` supplies the eligible-witness join + M-of-N
 * rule; WITHOUT it cosigner diversity is unknowable, and the viewer fails
 * toward auditing (spot-check whenever coverage allows). */
export interface CkptAuditOpts {
  cosig?: { eligible: ReadonlyMap<B64u, NodeId>; rule: CheckpointCosigRule }
  spot?: { p: number; roll: number }
}

export interface ResolveOpts extends VerifyPointerOpts, CkptAuditOpts {
  /** Profile fast path reads the freshest holders (spec §5 "3-5 freshest");
   * defaults PARAMS_A3.viewerHoldersMax / viewerHoldersMin. */
  holdersMax?: number
  holdersMin?: number
  /** Verified HolderSummary inputs pre-fetched by the embedder (A6 fabric RPC
   * seam): verified here regardless of source; junk contributes nothing. */
  summaries?: readonly unknown[]
  /** Events-row processing bound; default VIEWER_EVENTS_MAX. */
  eventsMax?: number
}

/** How the newest checkpoint was verified + what A4 needs pinned about its
 * cosigner set. `mOfN`/`prefixes16` are present only when opts.cosig supplied
 * the eligibility join: surfacing the honest A4 seam otherwise. */
export interface CkptSurface {
  event: SignedEvent
  id: EventId
  through: number
  state: CanonicalObject
  /** 'deep' = re-derived from genesis (spot-check ran and passed). */
  verified: 'incremental' | 'deep'
  /** True when the §2 spot-check was wanted (draw / diversity / unknown). */
  spotWanted: boolean
  /** True when the deep re-derivation actually ran (coverage permitting). */
  spotChecked: boolean
  /** Distinct witness keys whose attestation verifies against this event. */
  cosigners: number
  prefixes16?: number
  mOfN?: boolean
}

export type ShardReadReason = 'no-rows' | 'below-k' | 'reconstruct-failed' | 'bad-chain'

/** Honest availability report for the shard-layer read (§5 failure mode:
 * temporary unavailability that heals: never silent loss). */
export interface ShardReadReport {
  /** Verified live rows observed for the freshest snapshot group. */
  liveRows: number
  needK: number
  totalRows: number
  /** Freshest snapshot observed (whether or not it reconstructed). */
  height?: number
  headId?: EventId
  /** Why no chain came back; absent on success. */
  reason?: ShardReadReason
}

export interface RankedHolder {
  holder: B64u
  kind: PointerKind
  /** Capped ranking freshness (never authority) of the holder's best pointer. */
  effTs: number
  ptr: PointerRecord
}

export interface ResolvedProfile extends ReconstructedProfile {
  /** 'expected' = full chain reconstructed; 'floor' = survivors' union only. */
  status: 'expected' | 'floor'
  /** Genesis display name, when a verified genesis was reachable. */
  name?: string
  /** The countersigned head EVENT itself (A4 pinned input). */
  headEvent?: SignedEvent
  /** Checkpoint verification + cosigner surface (A4 pinned input). */
  ckptInfo?: CkptSurface
  /** The ≤holdersMax freshest legitimate holders (spec §5 fast path). */
  holdersRanked: RankedHolder[]
  shardReport: ShardReadReport
  /** Root-signed device certs collected across all sources: carried so the
   * floor-path history pager can prove device keys (historyFromView), which
   * ResolvedProfile is otherwise the only place to reach them from. */
  certs: SignedEvent[]
}

// ---------------------------------------------------------------------------
// Verified-event pool (the union of survivors' holdings, §0-checked)
// ---------------------------------------------------------------------------

/** Is `ev` a fully-verified witnessed event OF `subjectRoot`: strict shape,
 * lane 'w', root binding, owner signature, ≥1 valid witness attestation, and
 * (when device-signed) key proven by `certs`. The viewer's one admission rule
 * for overlay-delivered events: same floor the store gates enforce, re-run
 * here because the overlay confers nothing (§0). Never throws. */
export function verifyWitnessedOf(
  subjectRoot: B64u,
  ev: unknown,
  certs: readonly SignedEvent[] = [],
): boolean {
  try {
    if (!zSignedEvent.safeParse(ev).success) return false
    const e = ev as SignedEvent
    if (e.body.lane !== 'w' || e.body.root !== subjectRoot) return false
    if (!verifyEventSig(e)) return false
    const id = eventId(e.body)
    if (!(e.wit ?? []).some((att) => verifyAttestation(att, id))) return false
    if (e.body.key !== subjectRoot && !certSetFrom(subjectRoot, certs).some((c) => c.pub === e.body.key))
      return false
    return true
  } catch {
    return false
  }
}

interface Pool {
  /** Verified witnessed events, deduped by id. */
  byId: Map<EventId, SignedEvent>
  /** Verified personal-lane profile events (from summaries), deduped by id. */
  personal: Map<EventId, SignedEvent>
  /** Cert events collected from proofs/summaries (root-signed, position-free). */
  certs: SignedEvent[]
}

function newPool(): Pool {
  return { byId: new Map(), personal: new Map(), certs: [] }
}

function poolAddWitnessed(pool: Pool, ev: SignedEvent): void {
  const id = eventId(ev.body)
  if (!pool.byId.has(id)) pool.byId.set(id, ev)
}

function poolAddCerts(pool: Pool, certs: readonly SignedEvent[] | undefined): void {
  for (const c of certs ?? []) {
    const id = eventId(c.body)
    if (!pool.certs.some((x) => eventId(x.body) === id)) pool.certs.push(c)
  }
}

/** Witnessed pool events sorted (height asc, id asc). The fold order. */
function poolSorted(pool: Pool): SignedEvent[] {
  return [...pool.byId.entries()]
    .sort((a, b) => a[1].body.height - b[1].body.height || compareKeys(a[0], b[0]))
    .map(([, ev]) => ev)
}

// ---------------------------------------------------------------------------
// Head selection: verified-freshest, never claimed-freshest
// ---------------------------------------------------------------------------

/**
 * The newest VERIFIED witnessed head among `events`: max height wins, ties
 * break to the lexicographically smallest id (repair's rule, deterministic
 * everywhere). Candidates must carry ≥1 valid witness attestation, an
 * unattested event pins nothing. This is why a stale-but-"newer-claimed"
 * snapshot loses: claims (pointer ts, header freshness talk) never rank a
 * head; only countersigned height does, and a higher height cannot be minted
 * without the owner's signature plus a witness attestation.
 */
export function selectHead(events: readonly SignedEvent[]): { id: EventId; height: number; event: SignedEvent } | null {
  let best: { id: EventId; height: number; event: SignedEvent } | null = null
  for (const ev of events) {
    if (ev.body.lane !== 'w') continue
    const id = eventId(ev.body)
    if (!(ev.wit ?? []).some((att) => verifyAttestation(att, id))) continue
    if (!best || ev.body.height > best.height || (ev.body.height === best.height && compareKeys(id, best.id) < 0))
      best = { id, height: ev.body.height, event: ev }
  }
  return best
}

// ---------------------------------------------------------------------------
// Checkpoint selection (§2: incremental step + spot-check + M-of-N surface)
// ---------------------------------------------------------------------------

function ckptCosigSurface(
  ev: SignedEvent,
  id: EventId,
  audit: CkptAuditOpts,
): { cosigners: number; prefixes16?: number; mOfN?: boolean; diversityLacking: boolean } {
  const keys = new Set<B64u>()
  const nodePrefixes = new Set<string>()
  for (const att of ev.wit ?? []) {
    if (!verifyAttestation(att, id)) continue
    keys.add(att.w)
    const nid = audit.cosig?.eligible.get(att.w)
    if (nid !== undefined) nodePrefixes.add(prefixBucket(nid, 16))
  }
  if (!audit.cosig) return { cosigners: keys.size, diversityLacking: true } // unknown ⇒ audit
  const mOfN = verifyCheckpointCosigners(ev, ev.wit ?? [], audit.cosig.eligible, audit.cosig.rule)
  return {
    cosigners: keys.size,
    prefixes16: nodePrefixes.size,
    mOfN,
    diversityLacking: nodePrefixes.size < audit.cosig.rule.prefixDiversityMin,
  }
}

/** Do the working set's witnessed heights cover 0..through contiguously
 * (deep re-derivation possible)? */
function coversFromGenesis(working: Chain, through: number): boolean {
  const heights = new Set<number>()
  for (const ev of working.events) if (ev.body.lane === 'w') heights.add(ev.body.height)
  for (let h = 0; h <= through; h++) if (!heights.has(h)) return false
  return true
}

/**
 * Pick the newest checkpoint of `working` that VERIFIES (§2): candidates
 * newest-first (height desc, id asc), each must be an attested, owner-signed
 * ckpt event whose incremental step recomputes from the prior checkpoint's
 * embedded state. The spot-check (deep re-derivation from genesis) runs when
 * the injected draw fires, when the cosigner set lacks diversity, or when
 * diversity is UNKNOWN (no cosig join supplied), and always fails the
 * candidate on mismatch (self-authenticating fraud, §2). When the M-of-N join
 * is supplied, the newest candidate PASSING the M-of-N rule is preferred; if
 * none passes, the newest otherwise-verified candidate is surfaced with
 * mOfN:false so the caller sees the gap honestly. Pure; never throws.
 */
export function selectCheckpoint(working: Chain, opts: CkptAuditOpts = {}): CkptSurface | null {
  const cands = working.events
    .filter((e) => e.body.lane === 'w' && e.body.type === 'ckpt')
    .map((ev) => ({ ev, id: eventId(ev.body) }))
    .sort((a, b) => b.ev.body.height - a.ev.body.height || compareKeys(a.id, b.id))
  const drawn = opts.spot !== undefined && opts.spot.roll < opts.spot.p
  let fallback: CkptSurface | null = null

  for (const { ev, id } of cands) {
    try {
      if (!zCkptEvent.safeParse(ev).success) continue
      if (!verifyEventSig(ev)) continue
      const surface = ckptCosigSurface(ev, id, opts)
      if (surface.cosigners < 1) continue // never attested ⇒ pins nothing
      const payload = ev.body.payload as CheckpointPayload
      // A4 review fix (A4-15): a fold-id transition (basic-v1 → a4-v1) is NOT
      // one-step-verifiable by design: checkpoint.ts's incremental verifier
      // returns false there. Take the promised deep-verify fallback instead of
      // skipping, so an account's FIRST a4-v1 checkpoint (its ladders/rep/
      // trust surface) is never displaced by the stale basic-v1 one.
      let deepFallback = false
      if (!verifyCheckpointIncremental(working, ev)) {
        if (!coversFromGenesis(working, payload.through)) continue
        if (!verifyCheckpointDeep(working, ev)) continue // fraud: skip, never surface
        deepFallback = true
      }
      const spotWanted = drawn || surface.diversityLacking
      let spotChecked = deepFallback
      if (!deepFallback && spotWanted && coversFromGenesis(working, payload.through)) {
        if (!verifyCheckpointDeep(working, ev)) continue // fraud: skip, never surface
        spotChecked = true
      }
      const out: CkptSurface = {
        event: ev,
        id,
        through: payload.through,
        state: payload.state as CanonicalObject,
        verified: spotChecked || deepFallback ? 'deep' : 'incremental',
        spotWanted,
        spotChecked,
        cosigners: surface.cosigners,
        ...(surface.prefixes16 !== undefined ? { prefixes16: surface.prefixes16 } : {}),
        ...(surface.mOfN !== undefined ? { mOfN: surface.mOfN } : {}),
      }
      if (!opts.cosig || surface.mOfN) return out // newest M-of-N (or no join to demand)
      if (!fallback) fallback = out // newest verified sans M-of-N, surfaced honestly
    } catch {
      continue // verifiers fail closed, never throw
    }
  }
  return fallback
}

// ---------------------------------------------------------------------------
// Shard-layer read (expected path): rows → freshest snapshot → verified chain
// ---------------------------------------------------------------------------

export interface ShardReadResult {
  chain?: Chain
  report: ShardReadReport
  /** Rows that fed the successful reconstruction (0 when none). */
  shardsUsed: number
  /** The FRESHEST observed group's countersigned head event (verified inside
   * its envelope) + its cert proof: surfaced even when that group could not
   * reconstruct, so a viewer forced onto an older snapshot still pins the
   * newest verified head instead of silently presenting stale as current. */
  freshestHead?: SignedEvent
  freshestCerts?: SignedEvent[]
}

/**
 * Read a subject's chain out of shard space: one overlay get per row key,
 * verify every envelope (owner-signed attested head, certs, params pin, idx
 * and subject binding: shards.ts rules), group rows by snapshot, then try
 * groups freshest-first (max height, then smallest headId): reconstruct
 * (erasure-tolerant), parse, and accept ONLY when the chain fully verifies
 * AND its witnessed head equals the group's countersigned headId (the
 * blob↔head binding that kills a real-head/foreign-blob header). Everything
 * short of that is a typed, honest unavailability report. Never bytes.
 */
export async function readChainFromShards(
  node: PointerReadNode,
  subjectRoot: B64u,
  opts: VerifyShardOpts = {},
): Promise<ShardReadResult> {
  const subjectNodeId = nodeIdOf(subjectRoot)
  const n = opts.n ?? PARAMS_A3.nShards
  const k = opts.k ?? PARAMS_A3.kRec
  const groups = new Map<string, { height: number; headId: EventId; envs: Map<number, ShardEnvelope> }>()
  for (let idx = 0; idx < n; idx++) {
    let got: CanonicalObject | null = null
    try {
      got = await node.get(shardKey(subjectNodeId, idx), 'shard')
    } catch {
      got = null // an unreachable neighborhood is an erasure, not an error
    }
    if (got === null || verifyShardEnvelope(got, opts) !== 'ok') continue
    const env = got as unknown as ShardEnvelope
    if (env.shard.idx !== idx || nodeIdOf(env.header.root) !== subjectNodeId) continue
    if (env.header.root !== subjectRoot) continue
    const gk = env.header.headId + '|' + env.header.blobHash
    let g = groups.get(gk)
    if (!g) {
      g = { height: env.header.height, headId: env.header.headId, envs: new Map() }
      groups.set(gk, g)
    }
    if (!g.envs.has(idx)) g.envs.set(idx, env)
  }

  const ordered = [...groups.values()].sort(
    (a, b) => b.height - a.height || compareKeys(a.headId, b.headId),
  )
  if (ordered.length === 0)
    return { report: { liveRows: 0, needK: k, totalRows: n, reason: 'no-rows' }, shardsUsed: 0 }

  const freshest = ordered[0]
  const anyEnv = freshest.envs.values().next().value as ShardEnvelope
  const freshestHead = anyEnv.header.head
  const freshestCerts = anyEnv.header.certs
  const baseReport: ShardReadReport = {
    liveRows: freshest.envs.size,
    needK: k,
    totalRows: n,
    height: freshest.height,
    headId: freshest.headId,
  }
  let reason: ShardReadReason = 'below-k'
  for (const g of ordered) {
    if (g.envs.size < k) {
      reason = 'below-k'
      continue
    }
    const blob = reconstructTolerant([...g.envs.values()].map((e) => e.shard))
    if (blob === null) {
      reason = 'reconstruct-failed'
      continue
    }
    let chain: Chain
    try {
      chain = chainFromBytes(blob)
    } catch {
      reason = 'bad-chain'
      continue
    }
    if (chain.root !== subjectRoot) {
      reason = 'bad-chain'
      continue
    }
    const vr = verifyChain(chain)
    if (!vr.ok || vr.witnessedHead !== g.headId) {
      reason = 'bad-chain' // real head + foreign blob dies HERE (SnapshotHeader contract)
      continue
    }
    return {
      chain,
      shardsUsed: g.envs.size,
      report: { ...baseReport, height: g.height, headId: g.headId },
      freshestHead,
      freshestCerts,
    }
  }
  return { report: { ...baseReport, reason }, shardsUsed: 0, freshestHead, freshestCerts }
}

// ---------------------------------------------------------------------------
// Chain extension: publish-on-write events newer than the last final sync
// ---------------------------------------------------------------------------

/**
 * Extend a verified chain with newer verified pool events (height > head),
 * walking the linked continuation one height at a time: at each height the
 * unique successor that links to the current head is appended (appendEvent
 * enforces linkage + signature + shape); the extended chain must STILL fully
 * verify or the extension is discarded whole.
 *
 * A height where TWO distinct pool events link to the current head is an
 * equivocation/fork, §8's to adjudicate, never the viewer's. It STOPS the
 * extension (neither branch is taken) rather than picking one by an id
 * tie-break: pool events are only verifyWitnessedOf-checked, so an attacker
 * holding any leaked certified key can ground out a forgery whose eventId sorts
 * below the honest successor's and, on a reconstructed snapshot that lags the
 * honest tip (publish-on-write appends without re-sharding), win that race.
 * Orphaning the honest continuation and laundering a would-be-linked forgery
 * into the chain the assembly then trusts. Stopping at the fork keeps the
 * honest events in the pool floor (served by selection) instead of truncating
 * them out of the chain.
 */
export function extendChainFromPool(chain: Chain, pool: readonly SignedEvent[]): { chain: Chain; appended: number } {
  const have = new Set(chain.events.map((e) => eventId(e.body)))
  let headH = -1
  let headId: EventId | undefined
  for (const e of chain.events)
    if (e.body.lane === 'w' && e.body.height > headH) {
      headH = e.body.height
      headId = eventId(e.body)
    }
  const byHeight = new Map<number, SignedEvent[]>()
  for (const e of pool) {
    if (e.body.lane !== 'w' || e.body.height <= headH || have.has(eventId(e.body))) continue
    const g = byHeight.get(e.body.height)
    if (g) g.push(e)
    else byHeight.set(e.body.height, [e])
  }
  let cur = chain
  let curHeadId = headId
  let appended = 0
  for (let h = headH + 1; ; h++) {
    const group = byHeight.get(h)
    if (!group) break // height gap: stop
    const linking = group.filter((e) => e.body.prev === curHeadId)
    if (linking.length === 0) break // nothing links to the current head: stop
    const distinct = new Set(linking.map((e) => eventId(e.body)))
    if (distinct.size > 1) break // equivocation/fork at this height: §8's, not the viewer's
    try {
      cur = appendEvent(cur, linking[0])
      appended++
      curHeadId = eventId(linking[0].body)
    } catch {
      break // structural reject: stop, stay honest
    }
  }
  if (appended === 0) return { chain, appended: 0 }
  return verifyChain(cur).ok ? { chain: cur, appended } : { chain, appended: 0 }
}

// ---------------------------------------------------------------------------
// Holder summaries: the §5 fast-path payload (A6 fabric RPC seam)
// ---------------------------------------------------------------------------

const zHolderSummary = z.strictObject({
  v: z.literal(1),
  root: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
  head: zSignedEvent.optional(),
  ckpt: zCkptEvent.optional(),
  profileEvents: z.array(zSignedEventCore).max(SUMMARY_PROFILE_MAX),
  certs: z.array(zSignedEventCore).max(HEADER_CERTS_MAX),
})

/**
 * Build what a holder serves on the profile fast path from a chain it holds:
 * the witnessed head EVENT, the newest ckpt event, and the newest
 * profile-bearing personal events (merge order, newest first, capped at
 * SUMMARY_PROFILE_MAX: enough to cover every profile field's last write in
 * practice; the chain remains the authority). Throws on a chain with no
 * witnessed lane (builders throw; verifiers fail closed).
 */
export function buildHolderSummary(chain: Chain): HolderSummary {
  let head: SignedEvent | null = null
  let ckpt: SignedEvent | null = null
  for (const ev of chain.events) {
    if (ev.body.lane !== 'w') continue
    if (!head || ev.body.height > head.body.height) head = ev
    if (ev.body.type === 'ckpt' && (!ckpt || ev.body.height > ckpt.body.height)) ckpt = ev
  }
  if (!head) throw new Error('buildHolderSummary: chain has no witnessed lane')
  const profileAll = chain.events
    .filter((e) => e.body.lane === 'p' && e.body.type === 'profile')
    .sort(
      (a, b) =>
        b.body.ts - a.body.ts ||
        compareKeys(b.body.key, a.body.key) ||
        b.body.height - a.body.height ||
        compareKeys(eventId(b.body), eventId(a.body)),
    )
  const profileEvents = profileAll.slice(0, SUMMARY_PROFILE_MAX)
  const keys = new Set<B64u>([head.body.key])
  if (ckpt) keys.add(ckpt.body.key)
  for (const ev of profileEvents) keys.add(ev.body.key)
  keys.delete(chain.root)
  return {
    v: 1,
    root: chain.root,
    head,
    ...(ckpt !== null ? { ckpt } : {}),
    profileEvents,
    certs: certsProving(chain.root, chain.events, [...keys]),
  }
}

export interface VerifiedSummary {
  ok: boolean
  /** Elements that failed their own verification, dropped honestly. */
  dropped: ('head' | 'ckpt' | 'profile')[]
  head?: SignedEvent
  ckpt?: SignedEvent
  profileEvents: SignedEvent[]
  certs: SignedEvent[]
}

/**
 * Verify a HolderSummary from an UNTRUSTED holder: strict shape, subject
 * binding, then each element on its own merits: head/ckpt must be
 * owner-signed, witness-attested witnessed events of the subject; profile
 * events must be owner/cert-signed personal 'profile' events. Failed elements
 * are dropped (and named), never partially trusted: the summary itself
 * confers nothing (types.ts contract). Never throws.
 */
export function verifyHolderSummary(summary: unknown, subjectRoot: B64u): VerifiedSummary {
  const none: VerifiedSummary = { ok: false, dropped: [], profileEvents: [], certs: [] }
  try {
    if (!zHolderSummary.safeParse(summary).success) return none
    const s = summary as HolderSummary
    if (s.root !== subjectRoot) return none
    const dropped: VerifiedSummary['dropped'] = []
    const certs = s.certs.filter((c) => certSetFrom(subjectRoot, [c]).length === 1)
    let head: SignedEvent | undefined
    if (s.head !== undefined) {
      if (verifyWitnessedOf(subjectRoot, s.head, certs)) head = s.head
      else dropped.push('head')
    }
    let ckpt: SignedEvent | undefined
    if (s.ckpt !== undefined) {
      if (s.ckpt.body.type === 'ckpt' && verifyWitnessedOf(subjectRoot, s.ckpt, certs)) ckpt = s.ckpt
      else dropped.push('ckpt')
    }
    const certSet = certSetFrom(subjectRoot, certs)
    const profileEvents: SignedEvent[] = []
    let profileDropped = false
    for (const ev of s.profileEvents) {
      const okEv =
        zSignedEvent.safeParse(ev).success &&
        ev.body.lane === 'p' &&
        ev.body.type === 'profile' &&
        ev.body.root === subjectRoot &&
        verifyEventSig(ev) &&
        (ev.body.key === subjectRoot || certSet.some((c) => c.pub === ev.body.key))
      if (okEv) profileEvents.push(ev)
      else profileDropped = true
    }
    if (profileDropped) dropped.push('profile')
    return { ok: true, dropped, profileEvents, certs, ...(head ? { head } : {}), ...(ckpt ? { ckpt } : {}) }
  } catch {
    return none
  }
}

/** LWW profile fold over VERIFIED personal profile events in the documented
 * merge order (ts, key, height, id): the fast-path approximation of the
 * chain's own fold (which stays authoritative once the chain is present).
 * `revokedAt` (pub → earliest revocation ts) makes it match verifyChain's rule:
 * a write by a key AFTER that key was revoked is ignored, so a leaked
 * since-revoked device key cannot render an attacker's profile on the floor
 * path (§0: a revoked key is not owner authority). */
export function foldProfileLww(
  events: readonly SignedEvent[],
  revokedAt?: ReadonlyMap<B64u, number>,
): CanonicalObject {
  const sorted = [...events].sort(
    (a, b) =>
      a.body.ts - b.body.ts ||
      compareKeys(a.body.key, b.body.key) ||
      a.body.height - b.body.height ||
      compareKeys(eventId(a.body), eventId(b.body)),
  )
  const profile: Record<string, CanonicalValue> = {}
  for (const ev of sorted) {
    if (ev.body.type !== 'profile') continue
    const rv = revokedAt?.get(ev.body.key)
    if (rv !== undefined && ev.body.ts > rv) continue // revoked-key write. Ignored
    const fields = (ev.body.payload as { fields?: CanonicalObject }).fields
    if (!fields) continue
    for (const f of PROFILE_FIELDS) {
      const v = fields[f]
      if (v !== undefined) profile[f] = v
    }
  }
  return profile
}

// ---------------------------------------------------------------------------
// Freshest-holder ranking (spec §5: page from the 3-5 freshest holders)
// ---------------------------------------------------------------------------

/**
 * The ≤holdersMax freshest legitimate holders across the sheet's segment +
 * chain entries, by verified capped effTs (a lying ts cannot outrank the
 * embedded proof's witnessed recency, pointers.ts contract). Both sheet
 * lists arrive freshest-first, so this is a two-list merge that re-verifies
 * only the entries it takes. Pure given (sheet, opts).
 */
export function pickFreshHolders(sheet: ContactSheet, opts: VerifyPointerOpts = {}, holdersMax?: number): RankedHolder[] {
  const max = holdersMax ?? PARAMS_A3.viewerHoldersMax
  const rank = (list: { holder: B64u; ptr: PointerRecord }[]): RankedHolder[] => {
    const out: RankedHolder[] = []
    for (const e of list) {
      const c = checkPointer(e.ptr, opts)
      if (c.verdict !== 'ok' || !c.info) continue
      out.push({ holder: e.holder, kind: e.ptr.body.kind, effTs: c.info.effTs, ptr: e.ptr })
      if (out.length >= max) break
    }
    return out
  }
  const segs = rank(sheet.segments)
  const chains = rank(sheet.chains)
  const merged: RankedHolder[] = []
  const seen = new Set<B64u>()
  let i = 0
  let j = 0
  while (merged.length < max && (i < segs.length || j < chains.length)) {
    const a = i < segs.length ? segs[i] : null
    const b = j < chains.length ? chains[j] : null
    const take = !b || (a !== null && a.effTs >= b.effTs) ? (i++, a!) : (j++, b)
    if (seen.has(take.holder)) continue
    seen.add(take.holder)
    merged.push(take)
  }
  return merged
}

// ---------------------------------------------------------------------------
// resolveProfile: the owner-gone viewing flow (§5), end to end
// ---------------------------------------------------------------------------

/**
 * Resolve a subject with the owner gone: ONE overlay lookup enumerates the
 * authenticated pointer row → verified contact sheet (poisoned/unproven
 * pointers ignored, never ranked) → the publish-on-write events row → the
 * shard layer for the full chain → assemble: newest verified head, newest
 * verified (M-of-N-surfaced, spot-checked) checkpoint, profile fold, genesis
 * name, the verified segment union (guaranteed floor), and the full chain
 * when the shard read succeeded (expected). Every fact is verified here from
 * owner signatures + witness attestations; holders and the overlay confer
 * nothing. Returns honest reports, never throws on hostile data.
 */
export async function resolveProfile(
  node: PointerReadNode,
  subjectRoot: B64u,
  opts: ResolveOpts = {},
): Promise<ResolvedProfile> {
  const subjectNodeId = nodeIdOf(subjectRoot)
  const pool = newPool()

  // 1. Authenticated pointer index. One O(1) lookup, then pure verification.
  let row: CanonicalObject | null = null
  try {
    const key = pointerKeyOfRoot(subjectRoot)
    row = node.getMerged ? await node.getMerged(key, 'pointers') : await node.get(key, 'pointers')
  } catch {
    row = null
  }
  const sheet = buildContactSheet(subjectRoot, row, opts)
  let shardPtrs = 0
  for (const arr of sheet.shards.values()) shardPtrs += arr.length
  const pointers = sheet.segments.length + sheet.chains.length + shardPtrs
  const holderRoots = new Set<B64u>()
  for (const e of sheet.segments) {
    holderRoots.add(e.holder)
    const proof = e.ptr.body.proof
    if (proof.event) {
      poolAddWitnessed(pool, proof.event)
      poolAddCerts(pool, proof.certs)
    }
  }
  for (const e of sheet.chains) {
    holderRoots.add(e.holder)
    const proof = e.ptr.body.proof
    if (proof.event) {
      poolAddWitnessed(pool, proof.event)
      poolAddCerts(pool, proof.certs)
    }
  }
  for (const arr of sheet.shards.values())
    for (const e of arr) {
      const h = e.ptr.body.proof.header
      if (h) {
        poolAddWitnessed(pool, h.head)
        poolAddCerts(pool, h.certs)
      }
    }

  // 2. Publish-on-write events row (kind 'events' at the subject key).
  let eventsRow: CanonicalObject | null = null
  try {
    eventsRow = node.getMerged
      ? await node.getMerged(subjectNodeId, 'events')
      : await node.get(subjectNodeId, 'events')
  } catch {
    eventsRow = null
  }
  if (eventsRow !== null && typeof eventsRow === 'object') {
    // Root-signed certs ride the events row (bounded) so device-signed events
    // authorize even for a viewer with no pointer-sourced certs.
    const rowCerts = (eventsRow as { certs?: unknown }).certs
    if (Array.isArray(rowCerts)) poolAddCerts(pool, (rowCerts as SignedEvent[]).slice(0, EVENTS_CERTS_MAX))
    const raw = (eventsRow as { events?: unknown }).events
    if (Array.isArray(raw)) {
      const cap = opts.eventsMax ?? VIEWER_EVENTS_MAX
      // Newest-first processing under the cap (facts the page needs), plus
      // height-0 entries (genesis carries the display name).
      const list = [...(raw as unknown[])]
      list.sort((a, b) => {
        const ha = typeof (a as SignedEvent)?.body?.height === 'number' ? (a as SignedEvent).body.height : -1
        const hb = typeof (b as SignedEvent)?.body?.height === 'number' ? (b as SignedEvent).body.height : -1
        return hb - ha
      })
      let processed = 0
      for (const ev of list) {
        const isGenesisH = (ev as SignedEvent)?.body?.height === 0
        if (processed >= cap && !isGenesisH) continue
        processed++
        if (verifyWitnessedOf(subjectRoot, ev, pool.certs)) poolAddWitnessed(pool, ev as SignedEvent)
      }
    }
  }

  // 3. Injected holder summaries (A6 fast-path seam). Verified here.
  for (const s of opts.summaries ?? []) {
    const v = verifyHolderSummary(s, subjectRoot)
    if (!v.ok) continue
    poolAddCerts(pool, v.certs)
    if (v.head) poolAddWitnessed(pool, v.head)
    if (v.ckpt) poolAddWitnessed(pool, v.ckpt)
    for (const ev of v.profileEvents) {
      const id = eventId(ev.body)
      if (!pool.personal.has(id)) pool.personal.set(id, ev)
    }
  }

  // 4. Expected path: the full chain out of shard space, then extend it with
  //    any newer publish-on-write events.
  const shardOpts: VerifyShardOpts = opts.shard ?? {}
  const read = await readChainFromShards(node, subjectRoot, shardOpts)
  if (read.freshestHead) {
    poolAddCerts(pool, read.freshestCerts)
    poolAddWitnessed(pool, read.freshestHead)
  }
  const poolEvents = poolSorted(pool)

  // Revocation floor (§0: a revoked key is NOT owner authority, and an
  // unproven revocation CLAIM is no authority either). TWO invariants hold at
  // once here: (A) NO-FORGE. A leaked, since-revoked device key (its cert is
  // never deleted) must not pin the head or inject a segment/checkpoint/name/
  // profile; and (B) NO-SUPPRESS: pool/summary events are only
  // verifyWitnessedOf-checked (owner signature + ANY attestation + cert-proven
  // key, NOT chain-linked), so a pool revoke's very presence and claimed
  // body.height are attacker-mintable with any leaked certified key, and such a
  // claim must never drop honest verified events or downgrade the verified
  // head. On the EXPECTED path (a verified chain is present) BOTH are absolute.
  // On the FLOOR path (A) stays absolute and (B) is best-effort: the two
  // provably cannot both be absolute there (see the C-12 note below), and §0
  // is paramount, so the floor fails toward NO-FORGERY, shrinks the collateral
  // suppression as far as evidence allows, and SURFACES the remainder via
  // `revocationContested`, never silently. Revocations enter `revokedAtHeight`
  // (and, for the profile fold, `revokedTs`) when:
  //   · ROOT-signed revokes from ANY source (events row, summaries, proofs):
  //     the root is the ultimate authority, cannot be revoked, and its
  //     signature covers the height: unforgeable, replay-truthful;
  //   · every revoke inside the VERIFIED chain, at its linked height, including
  //     ones the pool extension LINKED WITHOUT a fork (extendChainFromPool
  //     refuses to link past an equivocation, so a ground-out forgery cannot
  //     win an id race on a stale snapshot and launder itself in);
  //   · on the FLOOR path only (no chain to vet linkage): DEVICE-signed pool
  //     revokes, shrunk + flagged below (the cold-root flow, revoking a lost
  //     device from the still-active device, is a supported model feature, so
  //     refusing them all would let a device-revoked leaked key forge freely).
  const revokedAtHeight = new Map<B64u, number>()
  const revokedTs = new Map<B64u, number>()
  const admitRevoke = (ev: SignedEvent): void => {
    if (ev.body.lane !== 'w' || ev.body.type !== 'revoke') return
    const pub = (ev.body.payload as { pub?: unknown }).pub
    if (typeof pub !== 'string' || pub === subjectRoot) return // the root cannot be revoked
    const curH = revokedAtHeight.get(pub)
    if (curH === undefined || ev.body.height < curH) revokedAtHeight.set(pub, ev.body.height)
    const curT = revokedTs.get(pub)
    if (curT === undefined || ev.body.ts < curT) revokedTs.set(pub, ev.body.ts)
  }
  for (const ev of poolEvents) if (ev.body.key === subjectRoot) admitRevoke(ev) // ROOT-signed pool revokes
  // A pool event by a revoked key confers NOTHING (§0), regardless of its
  // attacker-chosen claimed height: an unlinked pool event's height is not a
  // real linked position, so the `height <= revocationHeight` allowance
  // verifyChain applies to LINKED events (one per height, real) cannot be
  // extended to pool events without letting a revoked key inject a game at any
  // pre-revocation height. A revoked key's GENUINE pre-revocation events ride
  // the verified chain (ungated, below); this bars ONLY unlinked pool claims.
  const notRevoked = (ev: SignedEvent): boolean => !revokedAtHeight.has(ev.body.key)

  let chain = read.chain
  let revocationContested = false
  if (chain) {
    for (const ev of chain.events) admitRevoke(ev) // linked revokes: verifyChain vetted them at their real height
    // Extend with newer pool events (revoked keys pre-filtered so a key revoked
    // by a not-yet-linkable root-signed revoke cannot slip a linking forgery
    // past verifyChain). extendChainFromPool stops at any equivocating fork, so
    // the events it links are a genuine continuation, not a race winner.
    const ext = extendChainFromPool(chain, poolEvents.filter(notRevoked))
    chain = ext.chain
    for (const ev of chain.events) admitRevoke(ev) // revokes the extension linked WITHOUT a fork (trustworthy)
  } else {
    // FLOOR path: no linked chain to vet device-signed revocations. §1: a
    // witnessed revocation invalidates enrollments, including a device-signed
    // one (certs.ts makeRevokeEvent, chain.ts verifyChain: the cold-root flow,
    // revoking a lost device from the still-active device, is a supported
    // model feature). The floor MUST therefore honor device-signed pool
    // revokes, or a leaked key whose revocation was device-signed would forge
    // heads/segments freely here (NO-FORGE, §0: paramount). But an unlinked
    // pool revoke's evidence (presence, height, ts) is mintable by ANY leaked
    // certified key, so honoring it can also SUPPRESS an honest device on an
    // attacker's word. Both invariants provably cannot be absolute at once on
    // the pure floor; §0 wins, and the collateral is SHRUNK, then SURFACED:
    //   · shrink 1: a device revoke whose SIGNER is shown-revoked by a
    //     ROOT-signed revoke in the visible verified pool is ignored (the root
    //     is unforgeable, so the signer is a proven non-authority);
    //   · shrink 2: a device revoke whose TARGET is already root-revoked is
    //     ignored (the root evidence already gates that key, and skipping the
    //     device claim keeps a forged backdated ts from widening the root's
    //     own ts gate in the profile fold);
    //   · shrink 3: a device revoke naming a pub NO root-signed cert in the
    //     visible pool proves is ignored (every pool/personal event's key is
    //     cert-proven, so such a revoke can gate no visible content, and it
    //     must not trip the contested signal);
    //   · MUTUAL/CONTESTED pairs (dOld revokes dAct AND dAct revokes dOld,
    //     neither root-refuted) gate BOTH keys: the viewer cannot tell the
    //     legitimate revoker from the leaked one without chain linkage, and
    //     any tie-break (id, ts, height, cert age) is attacker-winnable, so
    //     NEITHER key's content renders as authoritative. Suppressing the
    //     honest half is the accepted cost of never rendering the forged half.
    // WHAT REMAINS IS IRREDUCIBLE (accepted compromise C-12, spec §12): with
    // the owner gone, <K_rec shard rows surviving, and no chain linkage, a
    // device-signed revoke minted with a leaked certified key whose OWN
    // revocation is not visible in this pool is bit-for-bit indistinguishable
    // from the legitimate cold-root flow, so it can transiently hide the
    // honest key's content. Failing the other way would let that same leaked
    // key FORGE content instead (strictly worse, §0). The suppression is
    // temporary unavailability that HEALS (§14): any reconstructing chain
    // adjudicates every revoke at its real linked height, and the view is
    // never silent about it: every device-attested-only gate honored below
    // sets `revocationContested` so callers can render the floor view as
    // revocation-degraded rather than complete.
    const rootRevoked = new Set(revokedAtHeight.keys()) // ROOT-signed evidence only (snapshot BEFORE device admissions, so admission stays order-independent)
    const certifiedPubs = new Set(certSetFrom(subjectRoot, pool.certs).map((c) => c.pub))
    for (const ev of poolEvents) {
      if (ev.body.key === subjectRoot || ev.body.lane !== 'w' || ev.body.type !== 'revoke') continue
      if (rootRevoked.has(ev.body.key)) continue // shrink 1: signer root-refuted. Confers nothing
      const pub = (ev.body.payload as { pub?: unknown }).pub
      if (typeof pub !== 'string' || pub === subjectRoot) continue // the root cannot be revoked
      if (rootRevoked.has(pub)) continue // shrink 2: target already gated by root evidence
      if (!certifiedPubs.has(pub)) continue // shrink 3: unproven target. Gates nothing visible
      admitRevoke(ev)
      revocationContested = true // C-12: honored on device-attested evidence only. Surfaced, never silent
    }
  }

  // 5. Assemble. Working set for checkpoint/head/name: the verified chain
  //    when present (UNGATED: its revocation semantics are verifyChain's,
  //    already enforced), else the gated verified pool union (the floor).
  //    EXPECTED-PATH RULE (round 5): with a chain present, content (head,
  //    segments: checkpoint/name/profile were already chain-derived) draws
  //    from chain.events plus ONLY pool events holding a REAL LINKED
  //    POSITION (groundedPool below): never from raw poolAdmitted.
  //    verifyWitnessedOf is a possession-grade admission floor (owner
  //    signature + ANY attestation + cert-proven key: NO linkage), so a
  //    bare NON-LINKING witnessed event at an attacker-chosen claimed
  //    height, minted with a leaked but NOT-YET-REVOKED certified device
  //    key (the exact case notRevoked cannot filter and no floor shrink
  //    rule touches), must never contribute content or outrank the verified
  //    head (§0: view.head is an A4 pinned input).
  const workingEvents = chain ? chain.events : poolEvents
  const poolAdmitted = poolEvents.filter(notRevoked)
  const working: Chain = chain ?? { root: subjectRoot, events: poolAdmitted }

  // groundedPool. The admitted pool events holding a REAL linked position:
  // reachable from the verified chain's own witnessed events over hash links
  // with height-contiguous (h+1) steps. extendChainFromPool already absorbed
  // the unambiguous continuation into chain.events; what grounding ADDS back
  // is the fork-stopped case (round 3: the extension refuses to adjudicate
  // an equivocation (§8's business) and the honest continuation must keep
  // serving from the pool: NO-SUPPRESS). What it EXCLUDES is round 5's
  // weapon: a bare non-linking event at an arbitrary claimed height/prev.
  // LINKAGE evidence, not possession of a certified key, is what earns
  // content on the expected path (§0): NO-FORGE.
  const groundedPool: SignedEvent[] = []
  if (chain) {
    const have = new Set(chain.events.map((e) => eventId(e.body)))
    const byPrev = new Map<EventId, SignedEvent[]>()
    for (const ev of poolAdmitted) {
      if (ev.body.lane !== 'w' || ev.body.prev === undefined || have.has(eventId(ev.body))) continue
      const g = byPrev.get(ev.body.prev)
      if (g) g.push(ev)
      else byPrev.set(ev.body.prev, [ev])
    }
    // Reachable-set walk (breadth-first; membership is reachability, so the
    // result is order-free over the event SET; each event enqueues at most
    // once, bounding the walk at the already-capped pool size).
    const queue: { id: EventId; height: number }[] = []
    const grounded = new Set<EventId>()
    for (const e of chain.events)
      if (e.body.lane === 'w') {
        const id = eventId(e.body)
        grounded.add(id)
        queue.push({ id, height: e.body.height })
      }
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]
      for (const s of byPrev.get(cur.id) ?? []) {
        const sid = eventId(s.body)
        if (grounded.has(sid) || s.body.height !== cur.height + 1) continue
        grounded.add(sid)
        groundedPool.push(s)
        queue.push({ id: sid, height: s.body.height })
      }
    }
  }

  // Floor head candidacy: a DEVICE-signed pool revoke is consumed above as
  // revocation EVIDENCE (subtractive: it can gate keys, shrunk + flagged);
  // it is never elevated to CONTENT: with no chain linkage its height is a
  // bare claim, so letting it pin the head would hand a leaked certified key
  // an arbitrary-height forged head for the price of one minted revoke.
  // ROOT-signed revokes stay eligible (the root's signature covers the
  // height: unforgeable). On the expected path only the VERIFIED CHAIN and
  // linked-position pool events pin the head (round-5 rule above): a
  // NON-linking pool event by a certified NON-revoked key must never
  // outrank the verified head on a bare claimed height.
  const floorHeadOk = (ev: SignedEvent): boolean => ev.body.type !== 'revoke' || ev.body.key === subjectRoot
  const headCands = chain ? [...chain.events, ...groundedPool] : poolAdmitted.filter(floorHeadOk)
  const head = selectHead(headCands)
  const ckptInfo = selectCheckpoint(working, opts)

  let name: string | undefined
  for (const ev of workingEvents) {
    // genesis is ALWAYS root-signed (verifyChain rule), a device-signed
    // "genesis" cannot set the display name on the floor path.
    if (ev.body.lane === 'w' && ev.body.type === 'genesis' && ev.body.height === 0 && ev.body.key === subjectRoot) {
      const n = (ev.body.payload as { name?: unknown }).name
      if (typeof n === 'string') name = n
      break
    }
  }

  // Profile: the chain's own deterministic fold is authoritative; the floor
  // falls back to the verified summary events' LWW fold (advisory until the
  // chain confirms: HolderSummary contract). The floor fold honors the SAME
  // revocations as the witnessed gate above (revokedTs, populated by
  // admitRevoke, ts semantics matching verifyChain's personal-lane rule): a
  // leaked since-revoked device key, revoked by root OR by the still-active
  // device, cannot render an attacker's post-revocation profile write (A);
  // where an honored device-signed revoke may instead be silencing HONEST
  // writes, the view carries revocationContested (C-12 residual, surfaced).
  let profile: CanonicalObject
  if (chain) {
    const chainIds = new Set(chain.events.map((e) => eventId(e.body)))
    const extra = [...pool.personal.values()].filter((ev) => !chainIds.has(eventId(ev.body)))
    profile = verifyChain({ root: subjectRoot, events: [...chain.events, ...extra] }).profile
  } else {
    profile = foldProfileLww([...pool.personal.values()], revokedTs)
  }

  // Segments: on the expected path the game set is the VERIFIED CHAIN plus
  // linked-position pool segments only (round-5 rule): chain segments ride
  // ungated (revocation-checked by verifyChain at their linked heights; an
  // unlinked pool revoke cannot drop an honest game), the fork-stopped
  // grounded continuation keeps serving (round 3), and a NON-linking pool
  // event never injects a fabricated game. On the floor, pool segments face
  // the floor gate: a revoked device key cannot inject a game (§0). Chain
  // first, so on a duplicate id the chain's copy wins.
  const segMap = new Map<EventId, SignedEvent>()
  for (const ev of chain ? [...chain.events, ...groundedPool] : poolAdmitted) {
    if (ev.body.lane !== 'w' || ev.body.type !== 'segment') continue
    const id = eventId(ev.body)
    if (!segMap.has(id)) segMap.set(id, ev)
  }
  const segments = [...segMap.entries()]
    .sort((a, b) => a[1].body.height - b[1].body.height || compareKeys(a[0], b[0]))
    .map(([, ev]) => ev)

  return {
    root: subjectRoot,
    status: chain ? 'expected' : 'floor',
    ...(revocationContested ? { revocationContested: true } : {}),
    ...(head ? { head: { id: head.id, height: head.height }, headEvent: head.event } : {}),
    ...(ckptInfo
      ? { ckpt: { id: ckptInfo.id, through: ckptInfo.through, state: ckptInfo.state }, ckptInfo }
      : {}),
    profile,
    ...(name !== undefined ? { name } : {}),
    ...(chain ? { chain } : {}),
    segments,
    holdersRanked: pickFreshHolders(sheet, opts, opts.holdersMax),
    shardReport: read.report,
    certs: pool.certs,
    sources: {
      pointers,
      holders: holderRoots.size,
      shardsUsed: read.shardsUsed,
      viaChain: chain !== undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// Lazy game-history pages (~2 KB/game): verified against the pinned head
// ---------------------------------------------------------------------------

/** Async page source: witnessed events of the subject covering heights
 * [from, to] (inclusive). May return extras or junk. The pager verifies. */
export interface HistorySource {
  events(from: number, to: number): Promise<readonly SignedEvent[]>
}

export type HistoryPageFail = 'out-of-range' | 'unavailable' | 'broken-linkage' | 'bad-page'

export type HistoryPage =
  | { ok: true; page: number; from: number; to: number; events: SignedEvent[]; games: number }
  | { ok: false; page: number; reason: HistoryPageFail }

export interface HistoryPager {
  pageSize: number
  pageCount: number
  page(i: number): Promise<HistoryPage>
}

/**
 * Open the lazy history pager anchored at a PINNED countersigned head
 * (id + height: the §2 anchor a viewer already verified). Pages run
 * newest-first: page 0 ends at the head. Every page is verified before it is
 * returned: each event's id must equal the id the chain ABOVE it demands
 * (walking prev links down from the anchor), signatures must verify, and
 * device keys must be proven by `certs`, so NO PAGE SUBSTITUTION is
 * possible: a swapped interior event breaks the id chain at its own boundary
 * and the page comes back as a typed failure, never as wrong bytes. Anchors
 * are cached per page boundary, so sequential paging verifies each event
 * once. Pure given (source contents, anchor).
 */
export function openHistory(
  subjectRoot: B64u,
  anchor: { id: EventId; height: number },
  source: HistorySource,
  opts: { pageSize?: number; certs?: readonly SignedEvent[] } = {},
): HistoryPager {
  const pageSize = Math.max(1, opts.pageSize ?? PARAMS_A3.eventsPageMax)
  const pageCount = Math.max(1, Math.ceil((anchor.height + 1) / pageSize))
  const certs = opts.certs ?? []
  /** anchors[i] = required (id, height) of the TOP event of page i. */
  const anchors = new Map<number, { id: EventId; height: number }>([[0, anchor]])

  const boundsOf = (i: number): { from: number; to: number } => {
    const to = anchor.height - i * pageSize
    const from = Math.max(0, to - pageSize + 1)
    return { from, to }
  }

  /** Verify page i's event run top-down from its anchor. On success caches
   * page i+1's anchor and returns the events (ascending height). */
  async function verifyPage(i: number): Promise<HistoryPage> {
    const want = anchors.get(i)
    if (!want) return { ok: false, page: i, reason: 'broken-linkage' }
    const { from, to } = boundsOf(i)
    let fetched: readonly SignedEvent[]
    try {
      fetched = await source.events(from, to)
    } catch {
      return { ok: false, page: i, reason: 'unavailable' }
    }
    const byHeight = new Map<number, SignedEvent[]>()
    for (const ev of fetched) {
      const h = (ev as SignedEvent)?.body?.height
      if (typeof h !== 'number' || h < from || h > to) continue
      const g = byHeight.get(h)
      if (g) g.push(ev)
      else byHeight.set(h, [ev])
    }
    const run: SignedEvent[] = []
    let expect = want
    for (let h = to; h >= from; h--) {
      if (expect.height !== h) return { ok: false, page: i, reason: 'broken-linkage' }
      const cands = byHeight.get(h)
      if (!cands || cands.length === 0) return { ok: false, page: i, reason: 'unavailable' }
      let picked: SignedEvent | null = null
      for (const ev of cands) {
        try {
          if (eventId(ev.body) === expect.id) {
            picked = ev
            break
          }
        } catch {
          continue
        }
      }
      if (!picked) return { ok: false, page: i, reason: 'broken-linkage' } // substitution dies here
      if (!zSignedEvent.safeParse(picked).success) return { ok: false, page: i, reason: 'bad-page' }
      if (picked.body.lane !== 'w' || picked.body.root !== subjectRoot)
        return { ok: false, page: i, reason: 'bad-page' }
      if (!verifyEventSig(picked)) return { ok: false, page: i, reason: 'bad-page' }
      if (
        picked.body.key !== subjectRoot &&
        !certSetFrom(subjectRoot, [...certs]).some((c) => c.pub === picked!.body.key)
      )
        return { ok: false, page: i, reason: 'bad-page' }
      run.push(picked)
      if (h === 0) {
        if (picked.body.prev !== undefined) return { ok: false, page: i, reason: 'bad-page' }
        break
      }
      if (picked.body.prev === undefined) return { ok: false, page: i, reason: 'broken-linkage' }
      expect = { id: picked.body.prev, height: h - 1 }
    }
    if (from > 0 && i + 1 < pageCount) anchors.set(i + 1, expect)
    run.reverse() // ascending height within the page
    return {
      ok: true,
      page: i,
      from,
      to,
      events: run,
      games: run.filter((e) => e.body.type === 'segment').length,
    }
  }

  async function page(i: number): Promise<HistoryPage> {
    if (!Number.isInteger(i) || i < 0 || i >= pageCount) return { ok: false, page: i, reason: 'out-of-range' }
    // Fill missing boundary anchors by verifying the pages above (cached, so
    // sequential access does this at most once per boundary).
    for (let j = 0; j < i; j++) {
      if (anchors.has(j + 1)) continue
      const r = await verifyPage(j)
      if (!r.ok) return { ok: false, page: i, reason: r.reason }
    }
    return verifyPage(i)
  }

  return { pageSize, pageCount, page }
}

/** Pager over an already-resolved view: chain events when reconstruction
 * succeeded, else the verified segment floor (missing heights honestly page
 * as 'unavailable'). Anchored at the view's pinned head. Device-signed events
 * need the cert proof at every page: on the floor path (no chain to scrape
 * certs from) it comes from view.certs (the certs resolveProfile collected)
 * so a device-signed account's surviving history pages instead of failing
 * closed as 'bad-page'. */
export function historyFromView(
  view: ResolvedProfile,
  opts: { pageSize?: number } = {},
): HistoryPager | null {
  if (!view.head) return null
  const events = view.chain ? view.chain.events : view.segments
  const certs = view.chain
    ? view.chain.events.filter((e) => e.body.lane === 'p' && e.body.type === 'cert')
    : (view.certs ?? [])
  const source: HistorySource = {
    events: (from, to) =>
      Promise.resolve(events.filter((e) => e.body.lane === 'w' && e.body.height >= from && e.body.height <= to)),
  }
  return openHistory(view.root, view.head, source, { ...opts, certs })
}
