// A2 fabric-core: witness admission + attestation (spec §4 write lease /
// witnessed events, §2 checkpoints). Pure functions the transport calls: they
// decide whether to countersign, and mint/verify the WitnessAttestation. No
// network, no clock: the witness's clock is passed as `wts`. Platform-neutral.

import { canonicalBytes } from '../codec'
import { verifyCheckpointDeep, verifyCheckpointIncremental } from '../checkpoint'
import { eventId, verifyEventSig } from '../events'
import { ed25519, toB64u, verifySigB64u } from '../hash'
import type { B64u, Chain, EventId, SignedEvent, WitnessAttestation } from '../types'
import { prefixBucket } from './distance'
import { leaseBodyHash, verifyGrantSig } from './lease'
import { isFuseActive } from './pin'
import type { CheckpointCosigRule, FuseRecord, Lease, NodeId } from './types'

/** Distinct grantors whose signature verifies over the lease body (context-free,
 * no canonical-set knowledge). The floor an offline witness can always enforce. */
function countValidGrants(lease: Lease): number {
  const hash = leaseBodyHash(lease.body)
  const seen = new Set<NodeId>()
  for (const g of lease.grants) {
    if (seen.has(g.w)) continue
    if (verifyGrantSig(g, hash)) seen.add(g.w)
  }
  return seen.size
}

// ---------------------------------------------------------------------------
// Attestation mint / verify (A1 WitnessAttestation shape, verbatim)
// ---------------------------------------------------------------------------

/** The canonical bytes an attestation signs: {e, epoch, w, wts} (keys sorted
 * by the codec). One place, so mint and verify can never disagree. */
function attestBytes(eventId: EventId, epoch: number, w: B64u, wts: number): Uint8Array {
  return canonicalBytes({ e: eventId, epoch, w, wts })
}

/** Mint an attestation: ed25519 by `witnessPriv` over canonicalBytes({e, epoch, w, wts}). */
export function makeAttestation(
  eventId: EventId,
  epoch: number,
  witnessKey: B64u,
  witnessPriv: Uint8Array,
  wts: number,
): WitnessAttestation {
  const sig = toB64u(ed25519.sign(attestBytes(eventId, epoch, witnessKey, wts), witnessPriv))
  return { w: witnessKey, wts, epoch, sig }
}

/** Verify an attestation binds to `eventId` and was signed by att.w. Never throws. */
export function verifyAttestation(att: WitnessAttestation, eventId: EventId): boolean {
  // Fail closed on a malformed att (e.g. a non-safe-integer epoch/wts that makes
  // canonicalBytes throw) rather than propagating the throw.
  let msg: Uint8Array
  try {
    msg = attestBytes(eventId, att.epoch, att.w, att.wts)
  } catch {
    return false
  }
  return verifySigB64u(att.sig, msg, att.w)
}

// A7 pairing attest (A4-02 fidelity + A4-10 freshness) lives in the leaf
// module witness/pairattest.ts: kept dependency-free to avoid a
// fold↔checkpoint import cycle. Re-exported here for the fabric surface.
export {
  makePairingAttest,
  verifyPairingAttest,
  type PairingWitAttest,
} from './pairattest'

// ---------------------------------------------------------------------------
// Witness admission (the ordered checks from types.ts WitnessAttestation doc)
// ---------------------------------------------------------------------------

/** A witness's cached head for a root's witnessed lane (from WitnessCacheEntry). */
export interface HeadRef {
  id: EventId
  height: number
  /** Highest lease epoch this witness has admitted under, if known. */
  epoch?: number
}

export interface AdmitInput {
  /** The witnessed-lane event to countersign. */
  event: SignedEvent
  /** The lease the client presents (its grant-threshold validity is lease.ts's
   * job; admitEvent binds it to the event and checks expiry/epoch). Null ⇒ refuse. */
  lease: Lease | null
  /** Any fuse record the witness holds for the root. Null ⇒ none. */
  fuse: FuseRecord | null
  /** The witness's cached head for the lane. Null ⇒ the witness has no history. */
  cachedHead: HeadRef | null
  witnessKey: B64u
  witnessPriv: Uint8Array
  /** The witness's own clock reading, ms. Carried into the attestation. */
  wts: number
  params: { timeWindowMs: number }
  /**
   * Full lease validity check for callers that hold the canonical-set context
   * (subject summary + directory + summaries → verifyLease). When supplied it is
   * authoritative: a lease it rejects is refused. Optional because a bare witness
   * without replicated chains (pre-A3) can only enforce the context-free
   * ≥1-valid-grant floor below; a richer witness (the operator peer / any node
   * with A3 chain replication) supplies the real threshold+eligibility check.
   */
  leaseOk?: (lease: Lease) => boolean
}

export type AdmitResult =
  | { ok: true; attestation: WitnessAttestation }
  | { ok: false; reason: string; myHead?: HeadRef }

/**
 * Decide whether to countersign `event`, in the exact order the contract fixes:
 *  0. the event is a well-formed, self-signed witnessed-lane event;
 *  1. a valid unexpired lease for (root, event.key) at a non-stale epoch;
 *  2. no unexpired fuse record for the root;
 *  3. prev/height extend the cached head: else refuse-with-head, or flag a
 *     same-height equivocation as a fork;
 *  4. the witness's own clock within timeWindowMs of the event's claimed ts.
 * On success the attestation carries the WITNESS's clock (wts), not the client's.
 */
export function admitEvent(input: AdmitInput): AdmitResult {
  const { event, lease, fuse, cachedHead, witnessKey, witnessPriv, wts, params } = input
  const b = event.body
  const id = eventId(b)

  // 0. shape / signature sanity
  if (b.lane !== 'w') return { ok: false, reason: 'not-witnessed-lane' }
  if (!verifyEventSig(event)) return { ok: false, reason: 'bad-event-sig' }

  // 1. lease: present, bound to this root+device, unexpired, non-stale epoch,
  //    and actually GRANTED (not fabricated from nothing).
  if (!lease) return { ok: false, reason: 'no-lease' }
  if (lease.body.root !== b.root) return { ok: false, reason: 'lease-root-mismatch' }
  if (lease.body.device !== b.key) return { ok: false, reason: 'lease-device-mismatch' }
  if (wts >= lease.body.grantedWts + lease.body.ttlMs) return { ok: false, reason: 'lease-expired' }
  if (cachedHead?.epoch !== undefined && lease.body.epoch < cachedHead.epoch)
    return { ok: false, reason: 'stale-epoch', myHead: cachedHead }
  // Context-free floor every witness enforces: a fabricated lease with no valid
  // grant signature can never advance a witness's head cache (§4).
  if (countValidGrants(lease) < 1) return { ok: false, reason: 'lease-no-valid-grant' }
  // Full threshold+eligibility check when the caller has the canonical-set context.
  if (input.leaseOk && !input.leaseOk(lease)) return { ok: false, reason: 'lease-invalid' }

  // 2. fuse: an ACTIVE fuse for the root forbids all witnessing (§1). Use the
  //    full window (trippedWts ≤ wts < expiryWts): a future-dated fuse must not
  //    ban the lane before its intended start.
  if (fuse && fuse.body.root === b.root && isFuseActive(fuse, wts))
    return { ok: false, reason: 'fuse-tripped' }

  // 3. head linkage
  if (!cachedHead) {
    // No history: only a genesis-shaped event can be linked from nothing.
    if (!(b.height === 0 && b.prev === undefined)) return { ok: false, reason: 'behind' }
  } else if (b.height === cachedHead.height + 1) {
    if (b.prev !== cachedHead.id) return { ok: false, reason: 'head-mismatch', myHead: cachedHead }
  } else if (b.height === cachedHead.height) {
    // Same height as the admitted head: identical ⇒ idempotent re-attest;
    // distinct ⇒ two successors of one prev in a linear lane = fork.
    if (id !== cachedHead.id) return { ok: false, reason: 'fork', myHead: cachedHead }
  } else {
    return { ok: false, reason: 'head-mismatch', myHead: cachedHead }
  }

  // 4. clock window
  if (Math.abs(wts - b.ts) > params.timeWindowMs) return { ok: false, reason: 'clock-out-of-window' }

  return { ok: true, attestation: makeAttestation(id, lease.body.epoch, witnessKey, witnessPriv, wts) }
}

// ---------------------------------------------------------------------------
// Checkpoint cosignature (§2c): recompute-gated, diversity-bound
// ---------------------------------------------------------------------------

/**
 * Cosign a checkpoint ONLY after re-deriving its incremental fold step (§2b):
 * cosigning a bad checkpoint is slashable, so the recompute is the gate. Returns
 * null (refuse) if the checkpoint would not verify. Checkpoint cosignatures are
 * not lease-fenced (their strength is the recompute + M-of-N diversity below),
 * so `epoch` defaults to 0; a caller may fence it.
 */
export function cosignCheckpoint(
  ckptEvent: SignedEvent,
  chain: Chain,
  witnessKey: B64u,
  witnessPriv: Uint8Array,
  wts: number,
  epoch = 0,
): WitnessAttestation | null {
  // A4 review fix (A4-15): a fold-id transition checkpoint (basic-v1 → a4-v1)
  // is deep-only by design. Fall back to the full recompute rather than
  // refusing, so first a4-v1 checkpoints can gather their M-of-N cosigners.
  if (!verifyCheckpointIncremental(chain, ckptEvent) && !verifyCheckpointDeep(chain, ckptEvent))
    return null
  return makeAttestation(eventId(ckptEvent.body), epoch, witnessKey, witnessPriv, wts)
}

/**
 * Verify a checkpoint's cosigner set at read time (§2c): ≥ rule.m DISTINCT
 * eligible witnesses (deduped by nodeId), each attestation binding to the ckpt
 * event and signed by an eligible witness key, spanning ≥ rule.prefixDiversityMin
 * distinct /16 nodeId prefixes. `eligible` maps each admissible witness signing
 * key → its nodeId (the fabric builder knows this join from presence records).
 */
export function verifyCheckpointCosigners(
  ckptEvent: SignedEvent,
  attestations: readonly WitnessAttestation[],
  eligible: ReadonlyMap<B64u, NodeId>,
  rule: CheckpointCosigRule,
): boolean {
  const id = eventId(ckptEvent.body)
  const nodeIds = new Set<NodeId>()
  const buckets = new Set<string>()
  for (const att of attestations) {
    const nodeId = eligible.get(att.w)
    if (nodeId === undefined) continue // signer not in the eligible set
    if (nodeIds.has(nodeId)) continue // one node = one cosigner, dedup
    if (!verifyAttestation(att, id)) continue
    nodeIds.add(nodeId)
    buckets.add(prefixBucket(nodeId, 16))
  }
  return nodeIds.size >= rule.m && buckets.size >= rule.prefixDiversityMin
}
