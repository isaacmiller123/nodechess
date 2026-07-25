// A3 storage: shard duty + repair (spec §5 retention layer 3, publish-on-write;
// contracts: ./types.ts SnapshotHeader/ShardEnvelope, ./rs.ts codec, ./params.ts
// PARAMS_A3, docs/ACCOUNTS-PARAMS.md §Storage).
//
// Every witnessed-zone participant carries erasure-coded shards of other
// accounts' chains: shard row `idx` of subject X lives at shardKey(X, idx), and
// the dutyK closest CAPACITY-ADVERTISING live nodes to that key carry it.
// Publish-on-write replicates witnessed events at creation; a final sync cuts a
// snapshot of the full chain and leaves all nShards rows in shard space. Repair
// is a caller-driven scan that re-encodes and redistributes when observed live
// rows fall below kRec + repairHeadroom, browser eviction = churn = healed.
//
// Authority NEVER comes from the overlay or the publisher (§0): a shard row is
// accepted only when its envelope verifies. The embedded head is an
// owner-signed + witness-attested event of the claimed root, the certs prove
// the signing key, and the shard framing binds byte-for-byte to the header.
// The overlay moves bytes and routes; the verifiers here gate acceptance.
//
// Determinism rules (suite-load-bearing): platform-neutral (no `node:` imports,
// no DOM globals), no Date.now / Math.random / timers. Clocks are the
// caller's, repair runs only when ticked. Every verifier is pure and
// byte-identical on node and in the browser bundle. Distance math REUSES
// witness/distance.ts; RS coding REUSES ./rs.ts: nothing is reimplemented.

import { z } from 'zod'
import { chainFromBytes, chainToBytes, verifyChain } from '../chain'
import { certSetFrom, isRootSignedCert } from '../certs'
import { canonicalBytes, compareKeys, type CanonicalObject, type CanonicalValue } from '../codec'
import {
  eventId,
  verifyEventSig,
  witnessedHeadOf,
  zB64u32,
  zB64u64,
  zSignedEvent,
  zSignedEventCore,
} from '../events'
import { concatBytes, ed25519, fromB64u, sha256, toB64u, utf8, verifySigB64u } from '../hash'
import type { B64u, Chain, EventId, SignedEvent } from '../types'
import { verifyAttestation } from '../witness/attest'
import { closestEligible, compareNodeIdBytes, nodeIdOf } from '../witness/distance'
import type { NodeDirectory, NodeId, SignedPresence } from '../witness/types'
import type { OverlayNode, StoreValidator, ValueKind } from '../overlay/types'
import type { MergeFn } from '../overlay/node'
import { PARAMS_A3, PARAMS_A3_DIGEST } from './params'
import { encode, reconstruct } from './rs'
import type { Shard, ShardEnvelope, SnapshotHeader } from './types'

// ---------------------------------------------------------------------------
// Shard keys: where row idx of a subject lives in the overlay keyspace
// ---------------------------------------------------------------------------

/** Domain separator for shard keys: fixed forever (records embed the params
 * digest for everything revisable; the key derivation itself is structural). */
const SHARD_KEY_TAG = 'cs:a3:shard-key:v1'

/**
 * The deterministic 32-byte overlay key of shard row `idx` for a subject:
 * sha256(utf8(SHARD_KEY_TAG) ‖ subjectNodeIdBytes ‖ u32be(idx)) as b64u.
 * Distinct per idx and hash-spread across the keyspace, so one subject's 40
 * rows land on 40 unrelated neighborhoods. No single churn event can take a
 * chain below kRec. Throws on programmer misuse (builders throw; verifiers
 * fail closed).
 */
export function shardKey(subjectNodeId: NodeId, idx: number): B64u {
  const sub = fromB64u(subjectNodeId)
  if (sub.length !== 32) throw new Error('shardKey: subjectNodeId must decode to 32 bytes')
  if (!Number.isInteger(idx) || idx < 0 || idx > 0xffff_ffff)
    throw new Error(`shardKey: idx must be an integer in [0, 2^32) (got ${idx})`)
  const be = new Uint8Array(4)
  be[0] = (idx >>> 24) & 0xff
  be[1] = (idx >>> 16) & 0xff
  be[2] = (idx >>> 8) & 0xff
  be[3] = idx & 0xff
  return toB64u(sha256(concatBytes(utf8(SHARD_KEY_TAG), sub, be)))
}

// ---------------------------------------------------------------------------
// Snapshot cutting + shard jobs (publisher side)
// ---------------------------------------------------------------------------

/** Geometry/params overrides for suites; production uses PARAMS_A3 defaults. */
export interface SnapshotOpts {
  k?: number
  n?: number
  params?: B64u
}

/** Domain separator for the owner's blob commitment. Fixed forever. */
const SNAP_COMMIT_TAG = 'cs:a3:snap-commit:v1'

/**
 * The canonical bytes head.body.key signs to COMMIT a snapshot: the binding
 * fields (root, headId, height, blobHash, blobLen, geometry, params) PLUS the
 * per-row body hashes, under a distinct domain tag. Structurally disjoint from
 * an EventBody (a `t` tag, no lane/type/payload) so the signature can never be
 * confused with an event signature. Committing `bodyHashes` authenticates each
 * shard body per-row (the framing's blob-level dataHash cannot), so a keyless
 * attacker cannot pin a slot with a same-length garbage body. Pure; the
 * commitment is verifiable from the header alone.
 */
export function snapshotCommitBytes(h: {
  root: B64u
  headId: EventId
  height: number
  blobHash: B64u
  blobLen: number
  k: number
  n: number
  params: B64u
  bodyHashes: readonly B64u[]
}): Uint8Array {
  return canonicalBytes({
    t: SNAP_COMMIT_TAG,
    root: h.root,
    headId: h.headId,
    height: h.height,
    blobHash: h.blobHash,
    blobLen: h.blobLen,
    k: h.k,
    n: h.n,
    params: h.params,
    bodyHashes: [...h.bodyHashes],
  } as CanonicalValue)
}

/**
 * Cut a SnapshotHeader binding the CURRENT chain state: blobHash/blobLen over
 * chainToBytes(chain), headId/height from the witnessed head, params digest of
 * the rule set the job is cut under. `head` must be the chain's own witnessed
 * head event (its authority: owner signature + witness attestation ride IN it)
 * and `certs` must prove head.body.key belongs to root when device-signed.
 * Both are re-checked by every store-time verifier, so a header is
 * self-authenticating with no external context. `commitPriv` is the private
 * key of head.body.key: the owner signs blobHash into the header so a keyless
 * attacker cannot pair the public head with a foreign blobHash. Throws on
 * programmer misuse (including a commitPriv that does not match head.body.key).
 */
export function cutSnapshot(
  chain: Chain,
  head: SignedEvent,
  certs: SignedEvent[],
  commitPriv: Uint8Array,
  opts: SnapshotOpts = {},
): SnapshotHeader {
  const wh = witnessedHeadOf(chain.events)
  if (!wh) throw new Error('cutSnapshot: chain has no witnessed lane (missing genesis)')
  const headId = eventId(head.body)
  if (headId !== wh.id || head.body.height !== wh.height)
    throw new Error("cutSnapshot: head is not the chain's witnessed head")
  if (head.body.root !== chain.root) throw new Error('cutSnapshot: head root does not match chain root')
  if (toB64u(ed25519.getPublicKey(commitPriv)) !== head.body.key)
    throw new Error('cutSnapshot: commitPriv does not match head.body.key')
  const blob = chainToBytes(chain)
  const k = opts.k ?? PARAMS_A3.kRec
  const n = opts.n ?? PARAMS_A3.nShards
  // Per-row body commitment: hash each erasure-coded shard body so the owner
  // signs the exact bytes each carrier must serve (the framing's blob-level
  // dataHash cannot bind a single row's body). shardJob re-encodes the same
  // blob deterministically, so these hashes match the envelopes it emits.
  const bodyHashes = encode(blob, k, n).map((s) => toB64u(sha256(fromB64u(s.body))))
  const bind = {
    root: chain.root,
    headId,
    height: wh.height,
    blobHash: toB64u(sha256(blob)),
    blobLen: blob.length,
    k,
    n,
    params: opts.params ?? PARAMS_A3_DIGEST,
    bodyHashes,
  }
  return {
    v: 1,
    ...bind,
    head,
    certs,
    commitSig: toB64u(ed25519.sign(snapshotCommitBytes(bind), commitPriv)),
  }
}

/**
 * Erasure-code the chain bytes under a header into n framed ShardEnvelopes
 * (rs.encode already stamps dataHash/dataLen, which MUST equal the header's
 * blobHash/blobLen. Checked, so a job can never ship self-inconsistent).
 * Deterministic: same (header, bytes) → same envelope bytes everywhere.
 */
export function shardJob(header: SnapshotHeader, chainBytes: Uint8Array): ShardEnvelope[] {
  if (chainBytes.length !== header.blobLen || toB64u(sha256(chainBytes)) !== header.blobHash)
    throw new Error('shardJob: chainBytes do not match header blobHash/blobLen')
  return encode(chainBytes, header.k, header.n).map((shard) => ({ v: 1, header, shard }))
}

// ---------------------------------------------------------------------------
// Store-time verification (fail CLOSED: typed verdicts, never a throw)
// ---------------------------------------------------------------------------

export type ShardVerdict =
  | 'ok'
  | 'bad-envelope' // not shaped like a v1 ShardEnvelope (or a verifier-internal throw)
  | 'wrong-params' // params digest or k/n geometry is not the advertised rule set
  | 'bad-head' // head is not a valid owner-signed witnessed event matching root/headId/height
  | 'unattested-head' // head carries no valid witness attestation
  | 'uncertified-key' // head.body.key is neither root nor proven by the embedded certs
  | 'uncommitted-blob' // blobHash/blobLen not committed by head.body.key (foreign-blob poison)
  | 'bad-shard' // shard framing invalid or not bound byte-for-byte to the header

/** Wire-sanity cap on embedded cert chains (one cert proves one device key;
 * a handful covers multi-device. A padded list is bounded, never trusted). */
export const HEADER_CERTS_MAX = 16

/** Exported for the pointer layer (brick 4): a shard pointer embeds a bare
 * SnapshotHeader and must be able to shape-check it at its own boundary. */
export const zSnapshotHeader = z.strictObject({
  v: z.literal(1),
  root: zB64u32,
  headId: zB64u32,
  height: z.int().min(0),
  head: zSignedEvent,
  certs: z.array(zSignedEventCore).max(HEADER_CERTS_MAX),
  blobHash: zB64u32,
  blobLen: z.int().min(1),
  k: z.int().min(1).max(255),
  n: z.int().min(1).max(255),
  params: zB64u32,
  bodyHashes: z.array(zB64u32).min(1).max(255),
  commitSig: zB64u64,
})

const zShardFrame = z.strictObject({
  v: z.literal(1),
  idx: z.int().min(0).max(254),
  k: z.int().min(1).max(255),
  n: z.int().min(1).max(255),
  dataLen: z.int().min(0),
  dataHash: zB64u32,
  body: z.string().min(1),
})

const zShardEnvelope = z.strictObject({
  v: z.literal(1),
  header: zSnapshotHeader,
  shard: zShardFrame,
})

/** Verification context: which rule set a carrier accepts jobs under
 * (defaults: PARAMS_A3). Suites exercising small geometries override here. */
export interface VerifyShardOpts extends SnapshotOpts {}

/**
 * Verify a SnapshotHeader STANDING ALONE (no shard body): shape, advertised
 * rule set (params digest + k/n geometry; a foreign rule set is refused, not
 * guessed), the countersigned head (owner-signed witnessed event of root
 * matching headId/height, ≥1 valid witness attestation), and the embedded
 * cert proof of the signing key. Extracted from verifyShardEnvelope so the
 * pointer layer (brick 4) can verify the header a shard pointer embeds
 * WITHOUT holding the shard bytes; verifyShardEnvelope layers the framing
 * checks on top. blobHash/blobLen are authenticated HERE by the owner's
 * commitSig (head.body.key), so a foreign blobHash is refused at store time,
 * not only at reconstruction. Never throws.
 */
export function verifySnapshotHeader(header: unknown, opts: VerifyShardOpts = {}): ShardVerdict {
  try {
    if (!zSnapshotHeader.safeParse(header).success) return 'bad-envelope'
    const h = header as SnapshotHeader
    // rule-set pin: the digest names the rules, k/n are its geometry. Both
    // must be the ones this carrier advertises for.
    if (h.params !== (opts.params ?? PARAMS_A3_DIGEST)) return 'wrong-params'
    if (h.k !== (opts.k ?? PARAMS_A3.kRec) || h.n !== (opts.n ?? PARAMS_A3.nShards))
      return 'wrong-params'
    if (h.k > h.n) return 'wrong-params'
    // One committed body hash per shard row (idx order). Geometry pin on the
    // per-row body commitment authenticated by commitSig below.
    if (h.bodyHashes.length !== h.n) return 'wrong-params'
    // head: an owner-signed, witness-attested witnessed event of root.
    const head = h.head
    if (head.body.lane !== 'w') return 'bad-head'
    if (head.body.root !== h.root) return 'bad-head'
    if (head.body.height !== h.height) return 'bad-head'
    const id = eventId(head.body)
    if (id !== h.headId) return 'bad-head'
    if (!verifyEventSig(head)) return 'bad-head'
    if (!(head.wit ?? []).some((att) => verifyAttestation(att, id))) return 'unattested-head'
    if (head.body.key !== h.root) {
      const certs = certSetFrom(h.root, h.certs)
      if (!certs.some((c) => c.pub === head.body.key)) return 'uncertified-key'
    }
    // blob commitment: head.body.key (now proven for root above) signs
    // blobHash/blobLen into the header. Without this a keyless attacker could
    // pair this REAL head with a foreign blobHash and pin a shard slot the
    // honest snapshot could never displace (same headId/height, first-held
    // wins). The commit is the ONE authenticator of blobHash at store time.
    if (!verifySigB64u(h.commitSig, snapshotCommitBytes(h), head.body.key))
      return 'uncommitted-blob'
    return 'ok'
  } catch {
    return 'bad-envelope' // verifiers fail closed, never throw
  }
}

/**
 * The STORE-time verifier every shard carrier runs before accepting a row.
 * A ShardEnvelope is 'ok' iff:
 *  - it is a well-formed v1 envelope under the advertised params digest AND
 *    the advertised k/n geometry (a foreign rule set is refused, not guessed);
 *  - header.head is a witnessed event OF header.root: owner-signed
 *    (verifyEventSig by head.body.key), witness-attested (≥1 attestation
 *    binding to headId: the A2 context-free floor; witness ELIGIBILITY
 *    ranking is the pointer/viewer layer's read-time business), and matches
 *    headId (= eventId(head.body)) and height;
 *  - header.certs prove head.body.key belongs to root (root-signed cert set,
 *    certs.ts rules): empty when the head is root-signed;
 *  - blobHash/blobLen are committed by head.body.key (verifySnapshotHeader's
 *    commitSig check). A header pairing a real head with a foreign blobHash is
 *    refused HERE, so a keyless attacker cannot pin a shard slot with poison;
 *  - the shard framing binds byte-for-byte to the header: k/n/dataLen/dataHash
 *    equal blob geometry, idx ∈ [0, n), body decodes to exactly
 *    ceil(blobLen/k) bytes, and sha256(body) EQUALS the owner-committed
 *    header.bodyHashes[idx] (the per-row body authenticator).
 * The per-row body commitment (bodyHashes, signed by commitSig) means a keyless
 * attacker cannot pin a slot with a same-length garbage/byte-flipped body: such
 * a row is refused at the gate, not merely caught later at reconstruction, so
 * it can never strand an otherwise-recoverable snapshot. Never throws.
 */
export function verifyShardEnvelope(env: unknown, opts: VerifyShardOpts = {}): ShardVerdict {
  try {
    if (!zShardEnvelope.safeParse(env).success) return 'bad-envelope'
    const { header, shard } = env as ShardEnvelope
    const hv = verifySnapshotHeader(header, opts)
    if (hv !== 'ok') return hv
    // shard framing bound to the header (rs.ts framing rules).
    if (shard.k !== header.k || shard.n !== header.n) return 'bad-shard'
    if (shard.dataLen !== header.blobLen || shard.dataHash !== header.blobHash) return 'bad-shard'
    if (shard.idx >= header.n) return 'bad-shard'
    let body: Uint8Array
    try {
      body = fromB64u(shard.body)
    } catch {
      return 'bad-shard'
    }
    if (body.length !== Math.max(1, Math.ceil(header.blobLen / header.k))) return 'bad-shard'
    // Per-row body authenticator: the body must hash to the owner's committed
    // bodyHashes[idx]. Kills the keyless same-length body-flip that the
    // blob-level dataHash cannot see per-row (poison-pin → strand).
    if (toB64u(sha256(body)) !== header.bodyHashes[shard.idx]) return 'bad-shard'
    return 'ok'
  } catch {
    return 'bad-envelope' // verifiers fail closed, never throw
  }
}

// ---------------------------------------------------------------------------
// Duty assignment, who carries shard row idx of a subject
// ---------------------------------------------------------------------------

export interface DutyOpts {
  /** Injected clock (ms) for presence staleness, REQUIRED, no ambient time. */
  nowMs: number
  /** Carriers per row; default PARAMS_A3.dutyK. */
  dutyK?: number
}

/**
 * The ranked ≤dutyK duty carriers for (subject, idx): the closest
 * CAPACITY-ADVERTISING live nodes to shardKey(subject, idx): caps.shardMb > 0
 * and presence not stale at nowMs. Directory records are signature-verified at
 * ingest (presence.ts / MockFabric announce), so no re-verification here; the
 * ranking itself (closestEligible: XOR distance, byte tie-break) is objective.
 * Every observer with the same directory computes the same carriers, which is
 * what makes shard-duty claims checkable by viewers (types.ts PointerKind
 * 'shard').
 */
export function dutyCarriers(
  subjectNodeId: NodeId,
  idx: number,
  directory: NodeDirectory,
  opts: DutyOpts,
): NodeId[] {
  const key = shardKey(subjectNodeId, idx)
  const candidates: { nodeId: NodeId; sp: SignedPresence }[] = []
  for (const [nodeId, sp] of directory.nodes) candidates.push({ nodeId, sp })
  return closestEligible(
    key,
    candidates,
    (c) => c.sp.body.caps.shardMb > 0 && opts.nowMs - c.sp.body.ts <= directory.staleAfterMs,
    opts.dutyK ?? PARAMS_A3.dutyK,
  )
}

/** Is `myNodeId` among the duty carriers for (subject, idx)? A node absent
 * from the directory (never announced) is never on duty. */
export function isOnDuty(
  myNodeId: NodeId,
  subjectNodeId: NodeId,
  idx: number,
  directory: NodeDirectory,
  opts: DutyOpts,
): boolean {
  return dutyCarriers(subjectNodeId, idx, directory, opts).includes(myNodeId)
}

// ---------------------------------------------------------------------------
// Publish-on-write (§5): witnessed events at creation, full chain at final sync
// ---------------------------------------------------------------------------

/** The value stored under kind 'events' at nodeIdOf(subject root): a set row
 * of the subject's witnessed events, union-merged by event id at each holder.
 * `certs` carry the subject's root-signed device certs so a device-signed event
 * can be AUTHORIZED at the store gate (key proven for root). Without them a
 * gate could not tell an owner's device key from an attacker's throwaway. */
export interface EventsRow {
  v: 1
  events: SignedEvent[]
  /** Root-signed certs proving the events' device keys (empty for root-signed). */
  certs?: SignedEvent[]
}

/** Wire-sanity cap on the certs an events row may carry (mirrors header certs:
 * a handful proves every device; a padded list is bounded, never trusted). */
export const EVENTS_CERTS_MAX = HEADER_CERTS_MAX

/** Deterministic bound on a stored/merged events row: even authentic events
 * cost only a witness countersignature, so an active account's whole witnessed
 * lane would otherwise accumulate off-budget at the replicateK closest nodes,
 * bypassing the advertised capacity (§11). The full chain lives in shard space;
 * this row is the recent-events replication convenience, so it keeps the
 * NEWEST rows (plus genesis, which carries the display name) up to the cap. */
export const EVENTS_ROW_MAX = 8192

const asValue = (v: unknown): CanonicalObject => v as CanonicalObject

const eventsRow = (events: readonly SignedEvent[], certs: readonly SignedEvent[]): CanonicalObject =>
  asValue(certs.length ? { v: 1, events, certs } : { v: 1, events })

/**
 * Replicate one witnessed event at creation: store {v:1, events:[event]} under
 * the subject key on the replicateK overlay-closest nodes (node.put walks the
 * overlay and offers the row; each holder's validator re-verifies the event and
 * its merge unions it into the held row). `certs` prove the event's signing key
 * when device-signed (root-signed certs; omit when the event is root-signed).
 * The gate rejects a device-signed event whose key is not proven. Returns the
 * number of true stores.
 */
export function publishWitnessedEvent(
  node: OverlayNode,
  subjectRoot: B64u,
  event: SignedEvent,
  certs: readonly SignedEvent[] = [],
): Promise<number> {
  return node.put(nodeIdOf(subjectRoot), 'events', eventsRow([event], certs))
}

/**
 * Batch publish-on-write (viewer/suite seam): replicate MANY witnessed events
 * under the subject key in store-gate-sized rows (eventsPageMax per put, the
 * per-store cap acceptEvents enforces). Each holder's merge unions the rows,
 * so the result is identical to per-event publishing at a fraction of the
 * puts. `certs` ride EVERY page so each device-signed event is authorizable at
 * the gate. Returns Σ true stores across the batch puts.
 */
export async function publishWitnessedEvents(
  node: OverlayNode,
  subjectRoot: B64u,
  events: readonly SignedEvent[],
  certs: readonly SignedEvent[] = [],
): Promise<number> {
  const key = nodeIdOf(subjectRoot)
  let stored = 0
  for (let i = 0; i < events.length; i += PARAMS_A3.eventsPageMax) {
    const page = events.slice(i, i + PARAMS_A3.eventsPageMax)
    stored += await node.put(key, 'events', eventsRow(page, certs))
  }
  return stored
}

export interface FinalSyncResult {
  header: SnapshotHeader
  /** Per shard row: how many nodes truly stored it (put acceptance counts). */
  perIdx: number[]
}

/**
 * The §5 final sync: cut a snapshot of the full chain, erasure-code it, and
 * store every ShardEnvelope at its own shardKey(subject, idx). Leaving the
 * complete chain reconstructible from shard space alone. Each row rides
 * node.put, i.e. is offered to the replicateK overlay-closest nodes to its
 * key; the dutyK closest capacity nodes among them are the carriers viewers
 * enumerate (a duty carrier crowded out of one publish is healed by repair).
 */
export async function finalSync(
  node: OverlayNode,
  chain: Chain,
  head: SignedEvent,
  certs: SignedEvent[],
  commitPriv: Uint8Array,
  opts: SnapshotOpts = {},
): Promise<FinalSyncResult> {
  const header = cutSnapshot(chain, head, certs, commitPriv, opts)
  const envelopes = shardJob(header, chainToBytes(chain))
  const subject = nodeIdOf(chain.root)
  const perIdx: number[] = []
  for (const env of envelopes)
    perIdx.push(await node.put(shardKey(subject, env.shard.idx), 'shard', asValue(env)))
  return { header, perIdx }
}

// ---------------------------------------------------------------------------
// Capacity-gated store validator + merge (installed on the overlay node)
// ---------------------------------------------------------------------------

export interface ShardStoreOpts {
  /** Advertised capacity (PresenceBody.caps.shardMb). The honest budget. */
  shardMb: number
  /** Exact byte budget override (suite seam; default shardMb * 2^20). */
  budgetBytes?: number
  /** Verification context for accepted shard jobs (default PARAMS_A3). */
  verify?: VerifyShardOpts
  /** Fallback gate for kinds this layer does not own. Default mirrors the
   * overlay's own default: accept 'record', refuse the rest: compose with
   * pointers.ts makePointerStoreValidator here to gate kind 'pointers'. */
  base?: StoreValidator
}

/** The installed storage gate: validator + merge for createOverlayNode opts,
 * plus the local-accounting seams repair and suites read. */
export interface ShardStoreGate {
  validator: StoreValidator
  merge: MergeFn
  /** Bytes of shard rows currently accepted against the budget. */
  usedBytes(): number
  /** Subject nodeIds this node holds shard rows for (sorted, deduped). The
   * repair scan's worklist (the OverlayNode contract has no key enumeration,
   * so the gate records subjects as it accepts their rows). */
  subjects(): NodeId[]
}

const MB = 1024 * 1024

interface HeldRow {
  bytes: number
  height: number
  headId: EventId
  /** b64u(sha256(canonicalBytes(value))) of the accepted row, pins the exact
   * bytes so a same-height "re-store" cannot swap the held row's body. */
  valueHash: B64u
}

/**
 * Build the storage layer's STORE gate for one node.
 *
 * kind 'shard': accepted only when (1) verifyShardEnvelope passes, (2) the
 * target key IS shardKey(nodeIdOf(header.root), shard.idx). An envelope
 * stored under a foreign key would poison another subject's slot, (3) the row
 * is not STALER than the held row for that key (height must advance, or
 * re-store the BYTE-IDENTICAL snapshot row; a same-height different head, or
 * different bytes under the same head, is refused. First-held wins, fork
 * adjudication is §8's business, not a store gate's),
 * and (4) the byte budget holds: usedBytes − held + incoming ≤ budget.
 * Refusal is honest degradation (StoreRes stored:false), never an error.
 *
 * kind 'events': accepted only when every event in the row is a witnessed
 * event OF the subject the target key names: nodeIdOf(root) === target,
 * owner-signed (verifyEventSig), key AUTHORIZED for root (ev.body.key === root
 * or proven by the row's root-signed certs. The §0 floor: standing under the
 * subject key comes from owner signatures, never possession, so an attacker's
 * throwaway key is refused), ≥1 valid witness attestation, and the row is
 * within the per-store cap (PARAMS_A3.eventsPageMax). The merge bounds the
 * accumulated row at EVENTS_ROW_MAX so an active lane cannot grow it without
 * limit off-budget (§11).
 *
 * Everything else falls through to `base` (default: 'record' only), so
 * existing overlay behavior is unchanged.
 */
export function makeShardStoreValidator(opts: ShardStoreOpts): ShardStoreGate {
  const budget = opts.budgetBytes ?? opts.shardMb * MB
  const base: StoreValidator = opts.base ?? ((_f, _t, kind, _v) => kind === 'record')
  const held = new Map<B64u, HeldRow>()
  const subjects = new Set<NodeId>()
  let used = 0

  function acceptShard(target: B64u, value: CanonicalObject): boolean {
    if (verifyShardEnvelope(value, opts.verify) !== 'ok') return false
    const env = value as unknown as ShardEnvelope
    const subject = nodeIdOf(env.header.root)
    if (shardKey(subject, env.shard.idx) !== target) return false // key binding
    const cb = canonicalBytes(value as CanonicalValue)
    const valueHash = toB64u(sha256(cb))
    const prev = held.get(target)
    if (prev) {
      // Freshness gate (merge for 'shard' is plain replace, so the gate is
      // the ONE place staleness is decided. Accounting stays exact).
      if (env.header.height < prev.height) return false
      // Same height: only the BYTE-IDENTICAL row may re-store. A same-length
      // body flip is already refused at verifyShardEnvelope (bodyHashes commit),
      // so a differing valueHash at the same height means an EQUIVOCATING fork
      // (a distinct countersigned head/blob at the same height). First-held
      // wins; fork adjudication is §8's business, not a store gate's.
      if (env.header.height === prev.height && (env.header.headId !== prev.headId || valueHash !== prev.valueHash))
        return false
    }
    const next = used - (prev?.bytes ?? 0) + cb.length
    if (next > budget) return false // over advertised capacity. Honest refusal
    used = next
    held.set(target, { bytes: cb.length, height: env.header.height, headId: env.header.headId, valueHash })
    subjects.add(subject)
    return true
  }

  function acceptEvents(target: B64u, value: CanonicalObject): boolean {
    const row = value as unknown as EventsRow
    if (row.v !== 1 || !Array.isArray(row.events)) return false
    if (row.events.length < 1 || row.events.length > PARAMS_A3.eventsPageMax) return false
    const rawCerts = row.certs
    if (rawCerts !== undefined && (!Array.isArray(rawCerts) || rawCerts.length > EVENTS_CERTS_MAX)) return false
    // Subject root: every event must bind to it (nodeIdOf(root) === target).
    // Derive it from the first event and require each event to re-confirm below.
    const root = (row.events[0] as { body?: { root?: unknown } } | undefined)?.body?.root
    if (typeof root !== 'string' || nodeIdOf(root) !== target) return false
    // EVERY cert must be a shape-valid, root-signed cert of THIS subject. Certs
    // are otherwise consumed lazily (certSetFrom), so a row of root-signed events
    // could legally carry arbitrary junk/oversize certs, which then ride the row
    // off-budget (§11) and, in the merge cap, evict a real device cert. Validate
    // here so junk is refused at the gate, never stored. certSetFrom re-derives
    // the (deduped, sorted) set from the now-known-valid certs.
    if (rawCerts !== undefined) {
      for (const c of rawCerts) if (isRootSignedCert(root, c as SignedEvent) === null) return false
    }
    const certSet = rawCerts !== undefined ? certSetFrom(root, rawCerts as SignedEvent[]) : []
    for (const ev of row.events) {
      if (!zSignedEvent.safeParse(ev).success) return false
      if (ev.body.lane !== 'w') return false
      if (nodeIdOf(ev.body.root) !== target) return false // subject-key binding
      if (!verifyEventSig(ev)) return false
      // Key authorization (§0): a device-signed event stands only when a
      // root-signed cert proves its key: same floor as verifySnapshotHeader
      // and verifyWitnessedOf. Without this any keypair could mint events under
      // any subject's key (authority from possession: forbidden).
      if (ev.body.key !== ev.body.root && !certSet.some((c) => c.pub === ev.body.key)) return false
      // Structural (height, type) sanity. Height 0 is the genesis slot ONLY: a
      // witnessed genesis is height 0 + root-signed, and every other witnessed
      // event is height ≥ 1 (chain.ts linkage rules). Rejecting a device-key
      // "genesis" and any non-genesis event minted at height 0 stops a leaked
      // cert-proven key from flooding height-0 forgeries that masquerade as the
      // display-name genesis in the merge's retention (the row's only height-0
      // event is then the real root-signed genesis).
      if (ev.body.type === 'genesis') {
        if (ev.body.height !== 0 || ev.body.key !== ev.body.root) return false
      } else if (ev.body.height === 0) return false
      const id = eventId(ev.body)
      if (!(ev.wit ?? []).some((att) => verifyAttestation(att, id))) return false
    }
    return true
  }

  const validator: StoreValidator = (from, target, kind, value) => {
    try {
      if (kind === 'shard') return acceptShard(target, value)
      if (kind === 'events') return acceptEvents(target, value)
      return base(from, target, kind, value)
    } catch {
      return false // gates fail closed, never throw into the overlay
    }
  }

  return {
    validator,
    merge: storageMerge,
    usedBytes: () => used,
    subjects: () => [...subjects].sort(compareNodeIdBytes),
  }
}

/**
 * The storage layer's local-store fold (overlay MergeFn): kind 'events' unions
 * rows by event id, sorted (height, id): deterministic over the SET of events
 * regardless of arrival order, and BOUNDS the result at EVENTS_ROW_MAX (newest
 * rows, plus genesis, survive) so an active lane cannot grow the row without
 * limit off the advertised byte budget (§11). Root-signed certs union too
 * (bounded), so a device-signed event's authorization travels with it. Every
 * other kind replaces ('shard' staleness is decided by the validator above, so
 * replace is always forward). Falls back to replace on any unexpected shape.
 * The validator gates what gets here.
 */
export const storageMerge: MergeFn = (prev, next, kind, target) => {
  if (kind !== 'events' || prev === null) return next
  try {
    const a = prev as unknown as EventsRow
    const b = next as unknown as EventsRow
    if (a.v !== 1 || b.v !== 1 || !Array.isArray(a.events) || !Array.isArray(b.events)) return next
    // CPU pre-bound: a stored/gate-accepted row is already ≤ EVENTS_ROW_MAX, but
    // getMerged folds RAW find-value responses through here, so an oversized
    // hostile row would otherwise cost O(N) canonical-hash work BEFORE the cap.
    // Slice each side to the cap FIRST (legit rows are never oversized, so this
    // is a no-op for them). The eventId loop then hashes a bounded set.
    const cap = (evs: SignedEvent[]) => (evs.length > EVENTS_ROW_MAX ? evs.slice(0, EVENTS_ROW_MAX) : evs)
    const byId = new Map<EventId, { ev: SignedEvent; id: EventId }>()
    for (const ev of [...cap(a.events), ...cap(b.events)]) {
      const id = eventId(ev.body)
      if (!byId.has(id)) byId.set(id, { ev, id })
    }
    let recs = [...byId.values()].sort(
      (x, y) => x.ev.body.height - y.ev.body.height || compareKeys(x.id, y.id),
    )
    if (recs.length > EVENTS_ROW_MAX) {
      // Height is attacker-chosen. A leaked cert-proven key mints unlimited
      // witnessed forgeries at any height (acceptEvents cannot check linkage),
      // so it must NOT drive eviction: "keep newest by height" would let a
      // high-height flood evict the real head + segments AND the root-signed
      // revoke that gates the leaked key, silencing honest records on the floor
      // path. Preserve instead what a flood cannot manufacture:
      //   · the subject's ROOT-signed events (genesis carries the display name;
      //     root revokes gate leaked keys). A device key, leaked or not, can
      //     never mint them (bounded: a handful per account);
      //   · the LINKED spine: every event reachable from the real genesis over
      //     chain-shaped links (prev matches AND height steps +1, the shape
      //     verifyChain enforces). A DISCONNECTED high-height flood is
      //     off-spine and cannot displace it, and a forged SIBLING link costs
      //     the attacker its own spine slot but never unseats the real branch
      //     (the walk is reachability, NOT a unique-successor walk; a unique-
      //     successor walk would collapse to genesis-only on a single forged
      //     h1 link, handing the disconnected flood the eviction back).
      // Any remaining budget is filled newest-first (harmless: the viewer
      // re-verifies + revocation-gates every event it reads). recs is sorted
      // ascending by (height, id), so a tail slice keeps the newest. A leaked
      // key that mints a WHOLE contiguous linked branch from genesis can still
      // crowd the spine window on the pure floor path. Indistinguishable from
      // real chain growth without key-active-ness (the viewer's job), and
      // priced at one attested forgery per height, but the root-signed gate
      // is preserved, so NO-FORGE holds even then.
      const rootBound = (r: { ev: SignedEvent }): boolean => {
        try {
          return r.ev.body.key === r.ev.body.root && nodeIdOf(r.ev.body.root) === target
        } catch {
          return false
        }
      }
      const isGenesis = (r: { ev: SignedEvent }): boolean =>
        r.ev.body.type === 'genesis' && r.ev.body.height === 0 && rootBound(r)
      const spineIds = new Set<EventId>()
      const genesisRec = recs.find(isGenesis)
      if (genesisRec) {
        const byPrev = new Map<EventId, { ev: SignedEvent; id: EventId }[]>()
        for (const r of recs) {
          const p = r.ev.body.prev
          if (p === undefined) continue
          const g = byPrev.get(p)
          if (g) g.push(r)
          else byPrev.set(p, [r])
        }
        // Reachable-set walk (breadth-first; membership is reachability, so it
        // is order-free and set-deterministic; each rec is visited at most
        // once, bounding the walk at the already-capped recs length). The h+1
        // step keeps the spine chain-shaped: a "link" claiming prev=genesis at
        // height 999999 is off-spine, not a walk-stopper.
        const queue = [genesisRec]
        spineIds.add(genesisRec.id)
        for (let qi = 0; qi < queue.length; qi++) {
          const cur = queue[qi]
          for (const s of byPrev.get(cur.id) ?? []) {
            if (spineIds.has(s.id) || s.ev.body.height !== cur.ev.body.height + 1) continue
            spineIds.add(s.id)
            queue.push(s)
          }
        }
      }
      const pinned = recs.filter(rootBound) // root-signed: always kept (un-forgeable)
      if (pinned.length >= EVENTS_ROW_MAX) {
        const g = pinned.filter(isGenesis)
        recs = [...g, ...pinned.filter((r) => !isGenesis(r)).slice(-(EVENTS_ROW_MAX - g.length))]
      } else {
        const keptIds = new Set<EventId>(pinned.map((r) => r.id))
        const take = (from: { ev: SignedEvent; id: EventId }[]): void => {
          for (let i = from.length - 1; i >= 0 && keptIds.size < EVENTS_ROW_MAX; i--)
            keptIds.add(from[i].id) // newest-first; Set dedups pinned/spine overlap
        }
        take(recs.filter((r) => spineIds.has(r.id))) // the real chain spine first
        take(recs) // then the newest of everything else
        recs = recs.filter((r) => keptIds.has(r.id))
      }
      recs.sort((x, y) => x.ev.body.height - y.ev.body.height || compareKeys(x.id, y.id))
    }
    const events = recs.map((r) => r.ev)
    // Cert union: DETERMINISTIC over the SET (arrival-order independent) and
    // bounded. Keep only shape-valid, root-signed certs of the subject (junk can
    // never occupy a slot), prefer the certs the SURVIVING events actually NEED
    // (so an unneeded-cert flood cannot evict a real device cert), and break ties
    // by (height, certId): never by concatenation order. Root taken from the
    // surviving events (all share it; the read path re-verifies regardless).
    const root = events.length ? events[0].body.root : null
    const ranked: { cert: SignedEvent; pub: B64u; height: number; id: EventId }[] = []
    const seenCert = new Set<EventId>()
    if (root !== null) {
      for (const c of [...(a.certs ?? []), ...(b.certs ?? [])]) {
        const info = isRootSignedCert(root, c as SignedEvent)
        if (!info || seenCert.has(info.certId)) continue
        seenCert.add(info.certId)
        ranked.push({ cert: c as SignedEvent, pub: info.pub, height: info.height, id: info.certId })
      }
    }
    ranked.sort((x, y) => x.height - y.height || compareKeys(x.id, y.id))
    const needed = new Set<B64u>()
    for (const ev of events) if (ev.body.key !== root) needed.add(ev.body.key)
    const certs = [
      ...ranked.filter((c) => needed.has(c.pub)),
      ...ranked.filter((c) => !needed.has(c.pub)),
    ]
      .slice(0, EVENTS_CERTS_MAX)
      .map((c) => c.cert)
    return asValue(certs.length ? { v: 1, events, certs } : { v: 1, events })
  } catch {
    return next
  }
}

// ---------------------------------------------------------------------------
// Reconstruction with erasure tolerance (repair + viewer helper)
// ---------------------------------------------------------------------------

/**
 * rs.reconstruct with corrupt-shard tolerance. A same-length corrupted body is
 * undetectable per-shard (the framing's dataHash covers the ORIGINAL blob, and
 * that framing is frozen), so it surfaces as a whole-set hash-mismatch throw;
 * this wrapper treats the throw as an erasure: try the full set, then
 * deterministic leave-one-out: any success is end-to-end verified by the
 * dataHash gate inside reconstruct, so a wrong blob can never come back.
 * Heals one corrupt shard per set (deeper corruption = honest null =
 * temporary unavailability, §5's stated failure mode). Never throws.
 */
export function reconstructTolerant(shards: readonly Shard[]): Uint8Array | null {
  const list = [...shards]
  const attempt = (set: Shard[]): Uint8Array | null => {
    try {
      return reconstruct(set)
    } catch {
      return null
    }
  }
  const full = attempt(list)
  if (full !== null) return full
  for (let i = 0; i < list.length; i++) {
    const got = attempt(list.filter((_, j) => j !== i))
    if (got !== null) return got
  }
  return null
}

// ---------------------------------------------------------------------------
// Background repair: caller-driven, deterministic given inputs
// ---------------------------------------------------------------------------

export interface RepairOpts extends SnapshotOpts {
  dutyK?: number
  repairHeadroom?: number
}

export interface RepairCtx {
  /** This node's overlay (local holdings + fetch + redistribute all ride it). */
  node: OverlayNode
  /** Presence view for duty ranking (staleness judged at the tick's nowMs). */
  directory: NodeDirectory
  /** Subjects to scan: typically ShardStoreGate.subjects() (the rows this
   * node has accepted); the embedder may add subjects it is on duty for. */
  subjects: readonly NodeId[]
  opts?: RepairOpts
}

export type RepairOutcome =
  | 'healthy'
  | 'healed' // every missing row was re-encoded AND landed on ≥1 carrier
  | 'heal-incomplete' // reconstructed, but ≥1 re-store was refused (over-budget carriers)
  | 'unrecoverable'
  | 'not-on-duty'

/** One subject's scan result. Emitted for EVERY subject examined: what could
 * not be healed is reported, never silently dropped. */
export interface RepairAction {
  subject: NodeId
  outcome: RepairOutcome
  /** Verified live rows observed for the freshest snapshot. */
  live: number
  /** Rows re-encoded and re-stored (ascending idx; empty unless healed). */
  redistributed: number[]
  /** Σ per-row store acceptance counts for the redistributed rows. */
  stored: number
  /** Freshest snapshot observed, when any row verified. */
  headId?: EventId
  height?: number
}

/**
 * One repair tick (the embedder schedules it: PARAMS_A3.repairScanMs of
 * ONLINE time between ticks; nothing here self-schedules). For each subject
 * this node is on duty for (or holds rows of): observe live rows by querying
 * every shardKey(subject, idx) through the overlay (local holdings answer
 * first; dead carriers simply don't), verify each envelope, group by snapshot.
 * The report pins the freshest observed snapshot (max height, then lexicographic
 * headId). When the freshest group is below kRec + repairHeadroom, heal from
 * the freshest group that RECONSTRUCTS: iterating freshest-first, exactly like
 * readChainFromShards, so a below-kRec or same-height equivocating group at the
 * front cannot strand a recoverable snapshot behind it. Re-encode with rs, and
 * re-store every missing row at its duty key. No group ≥ kRec that reconstructs
 * ⇒ 'unrecoverable' (honest unavailability, never a crash or silent truncation);
 * reconstructed but ≥1 re-store refused ⇒ 'heal-incomplete' (the caller retries,
 * never a false 'healed'). Deterministic given (holdings, reachable population,
 * directory, nowMs): subjects scan in sorted order, groups freshest-first, rows
 * in ascending idx.
 */
export async function runRepair(ctx: RepairCtx, nowMs: number): Promise<RepairAction[]> {
  const o = ctx.opts ?? {}
  const n = o.n ?? PARAMS_A3.nShards
  const kRec = o.k ?? PARAMS_A3.kRec
  const headroom = o.repairHeadroom ?? PARAMS_A3.repairHeadroom
  const dutyOpts: DutyOpts = { nowMs, ...(o.dutyK !== undefined ? { dutyK: o.dutyK } : {}) }
  const verifyOpts: VerifyShardOpts = {
    ...(o.k !== undefined ? { k: o.k } : {}),
    ...(o.n !== undefined ? { n: o.n } : {}),
    ...(o.params !== undefined ? { params: o.params } : {}),
  }
  const subjects = [...new Set(ctx.subjects)].sort(compareNodeIdBytes)
  const actions: RepairAction[] = []

  for (const subject of subjects) {
    try {
      actions.push(await repairSubject(ctx, subject, n, kRec, headroom, dutyOpts, verifyOpts))
    } catch {
      // A repair pass must never crash the tick; the subject is reported, not dropped.
      actions.push({ subject, outcome: 'unrecoverable', live: 0, redistributed: [], stored: 0 })
    }
  }
  return actions
}

async function repairSubject(
  ctx: RepairCtx,
  subject: NodeId,
  n: number,
  kRec: number,
  headroom: number,
  dutyOpts: DutyOpts,
  verifyOpts: VerifyShardOpts,
): Promise<RepairAction> {
  const keys = Array.from({ length: n }, (_, idx) => shardKey(subject, idx))

  // Duty gate: scan a subject we are on duty for (any row) or hold rows of.
  let onDuty = false
  for (let idx = 0; idx < n && !onDuty; idx++)
    onDuty = isOnDuty(ctx.node.nodeId, subject, idx, ctx.directory, dutyOpts)
  const holdsAny = keys.some((key) => ctx.node.localGet(key, 'shard') !== null)
  if (!onDuty && !holdsAny)
    return { subject, outcome: 'not-on-duty', live: 0, redistributed: [], stored: 0 }

  // Observe: one overlay get per row (local answers first; only reachable
  // carriers count: that IS the live measurement), verify, group by snapshot.
  const byGroup = new Map<string, { height: number; headId: EventId; envs: Map<number, ShardEnvelope> }>()
  for (let idx = 0; idx < n; idx++) {
    const got = await ctx.node.get(keys[idx], 'shard')
    if (got === null || verifyShardEnvelope(got, verifyOpts) !== 'ok') continue
    const env = got as unknown as ShardEnvelope
    if (env.shard.idx !== idx || nodeIdOf(env.header.root) !== subject) continue // foreign row under our key
    const gk = env.header.headId + '|' + env.header.blobHash
    let g = byGroup.get(gk)
    if (!g) {
      g = { height: env.header.height, headId: env.header.headId, envs: new Map() }
      byGroup.set(gk, g)
    }
    if (!g.envs.has(idx)) g.envs.set(idx, env)
  }

  // Groups freshest-first (max height, then lexicographically smallest headId).
  // The SAME total order readChainFromShards uses. Committing to a single
  // tie-broken group and giving up on it would let a below-kRec (or same-height
  // equivocating) group at the front report 'unrecoverable' while a recoverable
  // snapshot sits behind it, so we iterate.
  const ordered = [...byGroup.values()].sort(
    (a, b) => b.height - a.height || compareKeys(a.headId, b.headId),
  )
  if (ordered.length === 0)
    return { subject, outcome: 'unrecoverable', live: 0, redistributed: [], stored: 0 }

  const report = (
    g: { height: number; headId: EventId; envs: Map<number, ShardEnvelope> },
    outcome: RepairOutcome,
    redistributed: number[] = [],
    stored = 0,
  ): RepairAction => ({ subject, outcome, live: g.envs.size, redistributed, stored, headId: g.headId, height: g.height })

  // Reconstruct AND fully RESOLVE a group's chain the SAME way readChainFromShards
  // accepts one: any kRec rows reconstruct (erasure-tolerant), the bytes parse,
  // the chain fully verifies, and its witnessed head is the group's committed
  // head. A group that reconstructs to a SEMANTICALLY-INVALID chain (a
  // publisher's since-revoked-key / bad-checkpoint / linkage-gap snapshot. Bytes
  // that pass every envelope gate yet no viewer can resolve) is NOT resolvable,
  // so repair never reports it healthy nor re-replicates it: repair's health
  // verdict tracks viewer resolvability, not mere row count.
  const resolve = (
    g: { height: number; headId: EventId; envs: Map<number, ShardEnvelope> },
  ): { blob: Uint8Array; header: SnapshotHeader } | null => {
    if (g.envs.size < kRec) return null
    const blob = reconstructTolerant([...g.envs.values()].map((e) => e.shard))
    if (blob === null) return null
    const header = g.envs.get(Math.min(...g.envs.keys()))!.header
    let chain: Chain
    try {
      chain = chainFromBytes(blob)
    } catch {
      return null
    }
    if (chain.root !== header.root) return null
    const vr = verifyChain(chain)
    if (!vr.ok || vr.witnessedHead !== g.headId) return null
    return { blob, header }
  }

  // The freshest observed snapshot governs the report (stale never masquerades as
  // current). Heal from the freshest group that actually RESOLVES, iterating
  // freshest-first: a below-kRec / non-reconstructing / semantically-invalid
  // group at the front cannot strand a recoverable snapshot behind it.
  const freshest = ordered[0]
  for (const g of ordered) {
    const r = resolve(g)
    if (r === null) continue
    // Healthy: the freshest observed group is resolvable AND above the repair
    // band: nothing to redistribute. (An older resolvable group behind a broken
    // freshest one is HEALED, not reported healthy: the freshest is unusable.)
    if (g === freshest && g.envs.size >= kRec + headroom) return report(g, 'healthy')
    const envelopes = shardJob(r.header, r.blob)
    const redistributed: number[] = []
    let stored = 0
    let healedRows = 0
    for (let idx = 0; idx < n; idx++) {
      if (g.envs.has(idx)) continue
      const s = await ctx.node.put(keys[idx], 'shard', asValue(envelopes[idx]))
      stored += s
      if (s > 0) healedRows++
      redistributed.push(idx)
    }
    // 'healed' ONLY when every missing row landed somewhere, a scheduler keying
    // off 'healed' must never conclude a subject is safe when nothing was
    // re-replicated (over-budget carriers refuse every put).
    return report(g, healedRows === redistributed.length ? 'healed' : 'heal-incomplete', redistributed, stored)
  }
  return report(freshest, 'unrecoverable')
}

// Re-export the storage ValueKind for embedders wiring gates without pulling
// the overlay barrel (type-only; no runtime dependency on the overlay).
export type { ValueKind }
