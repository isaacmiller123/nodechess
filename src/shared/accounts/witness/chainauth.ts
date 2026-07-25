// A4 seams 2/3/4 — chain-authoritative helpers for the witness fabric
// (the A2->A3 residual seams, closed in A4 brick 1b). Now that A3 replicates
// chains (shards/overlay/viewer), a witness that HOLDS a subject's verified
// chain can be authoritative where A2 could only enforce context-free floors:
//
//  seam 2 — makeChainLeaseCheck: the FULL §4 lease check (threshold tLease
//           valid grants from the canonical witness set, grantor eligibility
//           via eligibility.ts + distance.ts over the directory, epoch
//           monotonicity vs the cached head) as a WitnessDeps.verifyLease
//           hook, degrading honestly (context-free ≥1-grant floor stays with
//           admitEvent) for roots the witness holds no facts for;
//  seam 3 — the 'pin' chain-event anchoring layer: append/read helpers for
//           PinAnchorPayload {record: canonicalHash(PinRecord), gen}, plus
//           checkHandoffAnchor — the handoff gate that requires oldRecord's
//           digest === the NEWEST root-signed 'pin' anchor in the subject's
//           VERIFIED chain, keeping the A2 pinKey-gated co-signature gate as
//           the labeled live fallback when no chain resolves;
//  seam 4 — deviceOwnershipFromChain / checkDeviceOwnership: authenticated
//           device ownership at lease grant — the grantor verifies the
//           requesting device key is a CERTIFIED, UNREVOKED child of the root
//           from the replicated chain (revocation wins, §1); no chain ⇒ the
//           A2 attribution-only path, SURFACED (never a silent blind-sign).
//
// Everything here is a pure function of its inputs (verifiers fail closed,
// never throw on untrusted data); chain/cert verification reuses ../chain.ts
// and ../certs.ts — nothing is reimplemented. NO storage/overlay imports (the
// witness tree must not depend on them): the embedder resolves chains via the
// A3 viewer/overlay and feeds the results in through the *Of hooks.
// Platform-neutral: no `node:` imports, no DOM globals, no ambient clocks.

import { appendWitnessed, verifyChain } from '../chain'
import { certSetFrom } from '../certs'
import { zPinAnchorPayload } from '../events'
import type { B64u, Chain, EventId, PinAnchorPayload, SignedEvent } from '../types'
import { verifyLease, type LeaseParams, type VerifyLeaseCtx } from './lease'
import type { ChainSummary } from './eligibility'
import { pinRecordId, type SignedPinRecord } from './pin'
import type { PinRecordPayload } from './types'
import type { FuseRecord, Lease, NodeDirectory, NodeId, PinSession, SubjectSummary } from './types'

// ===========================================================================
// seam 4 — authenticated device ownership from the replicated chain
// ===========================================================================

export interface DeviceOwnership {
  /** Every pub with a valid root-signed cert anywhere in the verified chain. */
  certified: Set<B64u>
  /** Certified pubs still active (unrevoked) at head — verifyChain's rule. */
  active: Set<B64u>
  /** Certified pubs with a revocation — revocation wins (§1). */
  revoked: Set<B64u>
}

/**
 * Derive device-ownership facts from a subject's replicated chain. The chain
 * must FULLY verify — a chain that fails verification proves nothing and
 * yields null (fail closed: the caller then refuses or falls back per policy,
 * never trusts a broken chain's certs).
 */
export function deviceOwnershipFromChain(chain: Chain): DeviceOwnership | null {
  try {
    const vr = verifyChain(chain)
    if (!vr.ok) return null
    const active = new Set(vr.activeKeys.map((k) => k.pub))
    const certified = new Set(certSetFrom(chain.root, chain.events).map((c) => c.pub))
    const revoked = new Set([...certified].filter((p) => !active.has(p)))
    return { certified, active, revoked }
  } catch {
    return null
  }
}

export type GrantPath = 'chain-verified' | 'attributed'

export type DeviceCheck =
  | { ok: true; path: GrantPath }
  | { ok: false; reason: 'device-revoked' | 'device-uncertified' }

/**
 * The grant-path ownership verdict. `own === null` means the grantor holds no
 * verified chain for the root — the A2 attribution-only behavior remains
 * (grant, attributed via keyOf at adjudication) but is SURFACED as
 * path:'attributed' so nothing silently upgrades a blind-sign to a verified
 * one. With facts: the root key always owns itself; a revoked device is
 * refused (revocation wins over its cert, §1); an uncertified device is
 * refused. Pure.
 */
export function checkDeviceOwnership(own: DeviceOwnership | null, device: B64u, root: B64u): DeviceCheck {
  if (own === null) return { ok: true, path: 'attributed' }
  if (device === root) return { ok: true, path: 'chain-verified' }
  if (own.revoked.has(device)) return { ok: false, reason: 'device-revoked' }
  if (!own.certified.has(device)) return { ok: false, reason: 'device-uncertified' }
  return { ok: true, path: 'chain-verified' }
}

// ===========================================================================
// seam 2 — the full canonical-set lease check as a WitnessDeps.verifyLease hook
// ===========================================================================

/** The chain-derived facts a witness holds for a subject (via A3 replication
 * or an overlay fetch) that make the FULL lease check computable. */
export interface SubjectFacts {
  subject: SubjectSummary
  /** Chain-derived candidate facts keyed by nodeId (eligibility inputs). */
  summaries: ReadonlyMap<NodeId, ChainSummary>
  /** pinPub from the subject's active PIN record (takeover verification). */
  pinPub?: B64u
  /** Last observed lease binding {epoch, device} — fences takeover gating. */
  prior?: { epoch: number; device: B64u } | null
  /** Takeover session lookup by its id (lease.body.takeover). */
  sessionOf?: (id: B64u) => PinSession | undefined
}

export interface ChainLeaseCheckOpts {
  /** Replication hook: verified facts for a root, or null (no facts held). */
  factsOf: (root: B64u) => SubjectFacts | null
  /** Live directory snapshot source (fabric.directory). */
  directory: () => NodeDirectory
  params: LeaseParams
  nowMs: () => number
  fuseOf?: (root: B64u) => FuseRecord | null
  /** Highest lease epoch this witness has admitted under for a root (cached
   * head) — epoch monotonicity. Undefined ⇒ no history. */
  epochOf?: (root: B64u) => number | undefined
}

/**
 * Build the WitnessDeps.verifyLease hook (protocol.ts witnessServe): when the
 * witness holds the subject's chain facts, the hook is AUTHORITATIVE — it runs
 * the full §4 verifyLease (threshold from the canonical set, eligibility,
 * epoch/takeover/fuse rules) plus epoch monotonicity vs the cached head; a
 * lease it rejects is refused at attest ('lease-invalid'). For a root with NO
 * facts it returns true — honest degradation, UNCHANGED from A2: admitEvent's
 * context-free ≥1-valid-grant floor is then the only lease gate.
 */
export function makeChainLeaseCheck(opts: ChainLeaseCheckOpts): (lease: Lease) => boolean {
  return (lease) => {
    try {
      const root = lease.body.root
      const facts = opts.factsOf(root)
      if (!facts) return true // no chain facts — the ≥1-grant floor governs
      const cachedEpoch = opts.epochOf?.(root)
      if (cachedEpoch !== undefined && lease.body.epoch < cachedEpoch) return false
      const session = lease.body.takeover !== undefined ? facts.sessionOf?.(lease.body.takeover) : undefined
      const ctx: VerifyLeaseCtx = {
        subject: facts.subject,
        directory: opts.directory(),
        summaries: facts.summaries,
        params: opts.params,
        nowMs: opts.nowMs(),
        fuse: opts.fuseOf?.(root) ?? null,
        prior: facts.prior ?? null,
        ...(facts.pinPub !== undefined ? { pinPub: facts.pinPub } : {}),
        ...(session !== undefined ? { session } : {}),
      }
      return verifyLease(lease, ctx).ok
    } catch {
      return false // fail closed on hostile input
    }
  }
}

/**
 * Derive a SubjectSummary from a subject's VERIFIED chain: entangled roots are
 * the opponents named by its segment events (§3 edges). Returns null when the
 * chain does not verify (fail closed). Second-degree roots require the
 * opponents' chains — the caller merges them in when it replicates those too.
 */
export function subjectSummaryFromChain(chain: Chain, nodeIdOfRoot: (root: B64u) => NodeId): SubjectSummary | null {
  try {
    if (!verifyChain(chain).ok) return null
    const entangled = new Set<string>()
    for (const ev of chain.events) {
      if (ev.body.lane !== 'w' || ev.body.type !== 'segment') continue
      const opp = (ev.body.payload as { opp?: unknown }).opp
      if (typeof opp === 'string') entangled.add(opp)
    }
    return {
      root: chain.root,
      nodeId: nodeIdOfRoot(chain.root),
      entangledRoots: entangled,
      secondDegreeRoots: new Set<string>(),
    }
  } catch {
    return null
  }
}

// ===========================================================================
// seam 3 — chain-authoritative PIN-record anchoring ('pin' witnessed events)
// ===========================================================================

/** The newest root-signed 'pin' anchor of a chain (chain-authoritative). */
export interface PinAnchor {
  /** canonicalHash of the anchored PinRecordPayload (== pinRecordId). */
  record: B64u
  gen: number
  /** Witnessed-lane height of the anchoring event. */
  height: number
}

/** Build the PinAnchorPayload for a PIN record (types.ts contract). */
export function makePinAnchorPayload(record: PinRecordPayload, gen: number): PinAnchorPayload {
  return { record: pinRecordId(record), gen }
}

/**
 * The NEWEST 'pin' anchor among `events` for `root`: witnessed lane, type
 * 'pin', ROOT-signed (an anchor is the root's own §1 statement — a device
 * cannot re-anchor the committee), payload schema-valid; highest height wins.
 * The events are expected to come from a VERIFIED chain (use verifiedPinAnchor
 * for the fail-closed gate). Never throws.
 */
export function newestPinAnchor(root: B64u, events: readonly SignedEvent[]): PinAnchor | null {
  let best: PinAnchor | null = null
  for (const ev of events) {
    try {
      if (ev.body.lane !== 'w' || ev.body.type !== 'pin') continue
      if (ev.body.root !== root || ev.body.key !== root) continue
      const p = zPinAnchorPayload.safeParse(ev.body.payload)
      if (!p.success) continue
      if (!best || ev.body.height > best.height)
        best = { record: p.data.record, gen: p.data.gen, height: ev.body.height }
    } catch {
      continue
    }
  }
  return best
}

/**
 * The chain-authoritative anchor: verifyChain first (an unverified chain
 * anchors NOTHING — fail closed), then the newest root-signed 'pin' event.
 * Feed this a chain resolved via the A3 viewer/overlay (resolveProfile's
 * expected path / readChainFromShards) or held via replication.
 */
export function verifiedPinAnchor(chain: Chain): PinAnchor | null {
  try {
    if (!verifyChain(chain).ok) return null
  } catch {
    return null
  }
  return newestPinAnchor(chain.root, chain.events)
}

/** The gen the NEXT anchor must carry: newest.gen + 1, or 0 for the first. */
export function nextAnchorGen(root: B64u, events: readonly SignedEvent[]): number {
  const cur = newestPinAnchor(root, events)
  return cur ? cur.gen + 1 : 0
}

/**
 * Append the ROOT-signed 'pin' anchor for `record` onto the owner's chain
 * (provision appends gen 0; every handoff appends gen+1). This is the local
 * append — production wraps the same body through clientAppendWitnessed so
 * the event gathers witness attestations like any witnessed-lane event.
 */
export function appendPinAnchor(
  chain: Chain,
  rootPriv: Uint8Array,
  record: PinRecordPayload,
  ts: number,
): Chain {
  const gen = nextAnchorGen(chain.root, chain.events)
  return appendWitnessed(chain, rootPriv, chain.root, 'pin', makePinAnchorPayload(record, gen), ts)
}

export type HandoffAnchorPath = 'chain-anchored' | 'cosig-fallback'

export type HandoffAnchorCheck =
  | { ok: true; path: HandoffAnchorPath }
  | { ok: false; reason: 'stale-old-record' }

/**
 * The seam-3 handoff gate: with a resolved anchor, the presented oldRecord
 * MUST be the account's REAL current record (its digest === the newest 'pin'
 * anchor in the verified chain) — a captured STALE or FOREIGN record can no
 * longer authorize a re-provision. With NO anchor (anchor === null: no chain
 * resolvable), the A2 pinKey-gated co-signature gate remains the live
 * authority and the verdict is LABELED 'cosig-fallback' (C-12-style honest
 * surfacing — the caller sees WHICH path admitted). Pure.
 */
export function checkHandoffAnchor(oldRecord: SignedPinRecord, anchor: PinAnchor | null): HandoffAnchorCheck {
  if (anchor === null) return { ok: true, path: 'cosig-fallback' }
  let oldId: EventId
  try {
    oldId = pinRecordId(oldRecord.payload)
  } catch {
    return { ok: false, reason: 'stale-old-record' }
  }
  if (oldId !== anchor.record) return { ok: false, reason: 'stale-old-record' }
  return { ok: true, path: 'chain-anchored' }
}
