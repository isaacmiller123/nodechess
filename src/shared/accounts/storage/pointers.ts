// A3 storage: authenticated pointers (spec §5 "authenticated pointer records
// closes index poisoning" + the viewing-flow contact sheet; contracts:
// ./types.ts PointerRecord/PointerProof/ContactSheet, kickoff item 4).
//
// A pointer is a HOLDER-signed claim "I hold a segment of subject X, content
// hash H", published into the overlay under a deterministic per-subject key so
// a viewer enumerates one subject's pointers in O(1) lookups. The index is
// built at WRITE time, viewing never searches. Authority NEVER comes from the
// pointer's signature alone (§0: possession of bytes confers nothing): a
// pointer is enumerable ONLY when its EMBEDDED proof independently authorizes
// the holder,
//   'segment': the subject's OWN countersigned segment event (owner-signed +
//              witness-attested) NAMING the holder as counterparty: only a
//              real entanglement partner can carry one;
//   'chain':   the subject's own countersigned head/checkpoint event; the
//              claim "I hold the full chain at this head" is bound by hash at
//              fetch time (sha256 of the served blob), so a liar wastes a
//              fetch but can never serve wrong bytes;
//   'shard':   a verifiable shard-assignment proof. The job's SnapshotHeader
//              (itself embedding the countersigned head, shards.ts verifier)
//              PLUS objective duty: the holder is among dutyCarriers(...) for
//              that shard row's key under a caller-supplied NodeDirectory
//              snapshot.
// Everything else is ignored, never ranked: the contact sheet is structurally
// capped at real entanglement partners + assigned shard carriers.
//
// Revisable parameters: a shard pointer's proof embeds PARAMS_A3_DIGEST via
// its SnapshotHeader (verifySnapshotHeader pins it); segment/chain pointers
// bake in no revisable parameter: their validity is pure signature +
// attestation structure. Store-side caps (pointerCapPerKey) are node-local
// coordination state (C-3), enforced deterministically, never embedded.
//
// Determinism rules (suite-load-bearing): platform-neutral (no `node:`
// imports, no DOM globals), no Date.now / Math.random / timers. Clocks and
// directory snapshots are the caller's. Every verifier is pure, fails closed
// (typed verdicts, never a throw), and is byte-identical on node and in the
// browser bundle. Distance math reuses witness/distance.ts; header + duty
// verification reuse ./shards.ts: nothing is reimplemented.

import { z } from 'zod'
import { certSetFrom } from '../certs'
import {
  canonicalBytes,
  canonicalHash,
  compareKeys,
  type CanonicalObject,
  type CanonicalValue,
} from '../codec'
import { eventId, verifyEventSig, zB64u32, zB64u64, zSignedEvent, zSignedEventCore } from '../events'
import { concatBytes, ed25519, fromB64u, sha256, toB64u, utf8, verifySigB64u } from '../hash'
import { verifySegmentEvent } from '../segment'
import type { B64u, EventId, SignedEvent, WitnessAttestation } from '../types'
import { verifyAttestation } from '../witness/attest'
import { nodeIdOf, xorDistance } from '../witness/distance'
import type { NodeDirectory, NodeId } from '../witness/types'
import type { OverlayNode, StoreValidator, ValueKind } from '../overlay/types'
import type { MergeFn } from '../overlay/node'
import { PARAMS_A3 } from './params'
import {
  dutyCarriers,
  HEADER_CERTS_MAX,
  shardKey,
  storageMerge,
  verifySnapshotHeader,
  zSnapshotHeader,
  type VerifyShardOpts,
} from './shards'
import type {
  ContactSheet,
  PointerRecord,
  SegmentPayload,
  SnapshotHeader,
} from './types'

// ---------------------------------------------------------------------------
// Pointer keys: where a subject's pointer index lives in the overlay keyspace
// ---------------------------------------------------------------------------

/** Domain separator for pointer keys: fixed forever (like SHARD_KEY_TAG the
 * derivation is structural; everything revisable rides the records). */
const POINTER_KEY_TAG = 'cs:a3:pointer-key:v1'

/**
 * The deterministic 32-byte overlay key of a subject's pointer index:
 * sha256(utf8(POINTER_KEY_TAG) ‖ subjectNodeIdBytes) as b64u. ONE key per
 * subject (kind 'pointers'), domain-separated from nodeIdOf(subject) (where
 * 'events' rows live) and from every shardKey, so a viewer enumerates a
 * subject's whole contact sheet with a single overlay lookup, and pointer
 * floods never contend with event or shard storage. Throws on programmer
 * misuse (builders throw; verifiers fail closed).
 */
export function pointerKey(subjectNodeId: NodeId): B64u {
  const sub = fromB64u(subjectNodeId)
  if (sub.length !== 32) throw new Error('pointerKey: subjectNodeId must decode to 32 bytes')
  return toB64u(sha256(concatBytes(utf8(POINTER_KEY_TAG), sub)))
}

/** pointerKey of a subject named by ROOT pubkey (the form pointers carry). */
export function pointerKeyOfRoot(subjectRoot: B64u): B64u {
  return pointerKey(nodeIdOf(subjectRoot))
}

// ---------------------------------------------------------------------------
// Bounds (deterministic hygiene caps: validity rules, not revisable params)
// ---------------------------------------------------------------------------

/** Canonical-byte ceiling for ONE pointer record. Generous for a real segment
 * event + certs (~2-6 KB); closes byte-flood via padded proofs. */
export const POINTER_MAX_BYTES = 16 * 1024

/** Freshness skew: a pointer's holder-claimed `ts` is CAPPED for ranking at
 * (embedded proof's witnessed time + this skew): ts is never authority
 * (types.ts PointerBody contract), so lying about it cannot outrank the
 * proof's own witnessed recency by more than this bound. */
export const POINTER_TS_SKEW_MS = 86_400_000 // 24h

// ---------------------------------------------------------------------------
// Boundary schemas (zod at every untrusted input, mirroring types.ts EXACTLY)
// ---------------------------------------------------------------------------

const zPointerProof = z.strictObject({
  event: zSignedEvent.optional(),
  certs: z.array(zSignedEventCore).max(HEADER_CERTS_MAX).optional(),
  header: zSnapshotHeader.optional(),
})

const zPointerBody = z.strictObject({
  v: z.literal(1),
  subject: zB64u32,
  holder: zB64u32,
  key: zB64u32,
  kind: z.enum(['segment', 'chain', 'shard']),
  hash: zB64u32,
  idx: z.int().min(0).max(254).optional(),
  ts: z.int().min(0),
  proof: zPointerProof,
  holderCerts: z.array(zSignedEventCore).max(HEADER_CERTS_MAX),
})

const zPointerRecord = z.strictObject({
  body: zPointerBody,
  sig: zB64u64,
})

/** The value stored under kind 'pointers' at pointerKey(subject): a SET row
 * of pointer records, union-merged + deterministically capped at each holder. */
export interface PointerRow {
  v: 1
  ptrs: PointerRecord[]
}

const zPointerRow = z.strictObject({
  v: z.literal(1),
  ptrs: z.array(z.unknown()).min(1),
})

// ---------------------------------------------------------------------------
// Verification (fail CLOSED: typed verdicts, never a throw)
// ---------------------------------------------------------------------------

export type PointerVerdict =
  | 'ok'
  | 'bad-record' // not shaped like a v1 PointerRecord (or a verifier-internal throw)
  | 'oversize' // canonical bytes exceed the per-record ceiling
  | 'bad-sig' // record signature by body.key does not verify
  | 'uncertified-key' // body.key is neither the holder root nor proven by holderCerts
  | 'wrong-proof' // proof material inconsistent with the kind (missing/extra/idx rules)
  | 'bad-proof' // embedded proof fails its own verification (sig/attestation/params/certs)
  | 'subject-mismatch' // the proof is not the claimed subject's (root mismatch)
  | 'holder-mismatch' // the proof does not authorize THIS holder (opp naming / duty)
  | 'hash-mismatch' // pointer hash does not bind to the proof's content hash

export interface VerifyPointerOpts {
  /** Directory snapshot for 'shard' duty verification. ABSENT ⇒ every shard
   * pointer fails closed with 'holder-mismatch' (duty is unverifiable). */
  directory?: NodeDirectory
  /** Injected clock (ms) for presence staleness: REQUIRED with `directory`. */
  nowMs?: number
  /** Carriers per shard row; default PARAMS_A3.dutyK. */
  dutyK?: number
  /** Shard-header rule set (suite geometries); default PARAMS_A3. */
  shard?: VerifyShardOpts
  /** Freshness skew override; default POINTER_TS_SKEW_MS. */
  tsSkewMs?: number
  /** Per-record byte ceiling override; default POINTER_MAX_BYTES. */
  maxBytes?: number
}

/** What 'ok' verification yields: everything ranking needs, nothing more. */
export interface VerifiedPointer {
  ptr: PointerRecord
  /** nodeIdOf(holder root). The objective duty/ranking identity. */
  holderNodeId: NodeId
  /** AUTHORITY-BOUNDED proof recency: the newest valid witness-attestation wts,
   * CLAMPED at the proof event's OWNER-signed ts. The wit array is covered by
   * neither the event id nor its signature, so a holder can inject a self-signed
   * attestation with any wts: the clamp bounds it to a time the subject actually
   * committed to, so an injected attestation can never lift the ranking ceiling
   * (§0: recency is authority, never a holder claim). */
  proofWts: number
  /** Ranking freshness: min(body.ts, proofWts + tsSkewMs). Never authority. */
  effTs: number
  /** b64u(canonicalHash(record)). Dedupe identity + final tie-break. */
  recId: B64u
}

export interface PointerCheck {
  verdict: PointerVerdict
  /** Present iff verdict === 'ok'. */
  info?: VerifiedPointer
}

/** Newest wts among the attestations that VERIFY against `id`; null if none. */
function proofWtsOf(wit: readonly WitnessAttestation[] | undefined, id: EventId): number | null {
  let best: number | null = null
  for (const att of wit ?? []) {
    if (!verifyAttestation(att, id)) continue
    best = best === null ? att.wts : Math.max(best, att.wts)
  }
  return best
}

/** Is `pub` the subject's root or proven by a root-signed cert in `certs`? */
function keyProven(root: B64u, pub: B64u, certs: readonly SignedEvent[] | undefined): boolean {
  if (pub === root) return true
  return certSetFrom(root, certs ?? []).some((c) => c.pub === pub)
}

/** Capped ranking freshness of a record: min(body.ts, proofWts + skew), the
 * SAME bound checkCore computes (proofWts = attestation wts CLAMPED at the proof
 * event's owner-signed ts). Used to rank/dedup already-stored (prev) rows in the
 * cap fold without re-running the full verifier: a lying ts, or a holder-injected
 * attestation, can never outrank the proof's OWNER-authenticated recency, so the
 * retention decision honors the same authority ceiling the viewer uses. Falls
 * back to body.ts only if the proof carries no valid attestation (a stored record
 * always does). */
function effTsOf(rec: PointerRecord, skew: number): number {
  const b = rec.body
  let ev: SignedEvent | undefined
  let id: EventId | undefined
  if (b.kind === 'shard') {
    if (b.proof.header) {
      ev = b.proof.header.head
      id = b.proof.header.headId
    }
  } else if (b.proof.event) {
    ev = b.proof.event
    id = eventId(b.proof.event.body)
  }
  if (ev === undefined || id === undefined) return b.ts
  const wts = proofWtsOf(ev.wit, id)
  if (wts === null) return b.ts
  return Math.min(b.ts, Math.min(wts, ev.body.ts) + skew)
}

/**
 * The core verifier. `dutyMode` distinguishes the two callers:
 *  - 'require' (checkPointer / store gate / viewers): a 'shard' pointer needs
 *    a directory snapshot and MUST rank among the duty carriers, else
 *    'holder-mismatch' (fail closed);
 *  - 'skip' (the merge fold, which has no directory): every context-free
 *    check still runs (header, subject, hash, idx, signatures, certs). Only
 *    the duty-membership test is skipped, because the fold's cap ordering
 *    ranks shard entries by the same objective XOR distance a duty check
 *    uses, so an off-duty entry can never displace an on-duty one anyway.
 */
function checkCore(rec: unknown, opts: VerifyPointerOpts, dutyMode: 'require' | 'skip'): PointerCheck {
  try {
    if (!zPointerRecord.safeParse(rec).success) return { verdict: 'bad-record' }
    const r = rec as PointerRecord
    const b = r.body

    // Byte ceiling FIRST (cheapest way to bound all later work).
    let bodyBytes: Uint8Array
    let recBytes: Uint8Array
    try {
      bodyBytes = canonicalBytes(b as unknown as CanonicalValue)
      recBytes = canonicalBytes({ body: b, sig: r.sig } as unknown as CanonicalValue)
    } catch {
      return { verdict: 'bad-record' }
    }
    if (recBytes.length > (opts.maxBytes ?? POINTER_MAX_BYTES)) return { verdict: 'oversize' }

    // Holder signature + holder-key certification (who is claiming).
    if (!verifySigB64u(r.sig, bodyBytes, b.key)) return { verdict: 'bad-sig' }
    if (!keyProven(b.holder, b.key, b.holderCerts)) return { verdict: 'uncertified-key' }

    // Kind-consistent proof material (exactly the material the kind needs).
    if (b.kind === 'shard') {
      if (b.proof.header === undefined || b.proof.event !== undefined || b.proof.certs !== undefined)
        return { verdict: 'wrong-proof' }
      if (b.idx === undefined) return { verdict: 'wrong-proof' }
    } else {
      if (b.proof.event === undefined || b.proof.header !== undefined) return { verdict: 'wrong-proof' }
      if (b.idx !== undefined) return { verdict: 'wrong-proof' }
    }

    let proofWts: number
    const holderNodeId = nodeIdOf(b.holder)

    if (b.kind === 'segment') {
      // The subject's OWN countersigned segment event, NAMING the holder.
      const ev = b.proof.event as SignedEvent
      if (ev.body.root !== b.subject) return { verdict: 'subject-mismatch' }
      if (verifySegmentEvent(ev) !== null) return { verdict: 'bad-proof' }
      const id = eventId(ev.body)
      const wts = proofWtsOf(ev.wit, id)
      if (wts === null) return { verdict: 'bad-proof' } // countersigned = witness-attested
      if (!keyProven(b.subject, ev.body.key, b.proof.certs)) return { verdict: 'bad-proof' }
      const payload = ev.body.payload as unknown as SegmentPayload
      if (payload.opp !== b.holder) return { verdict: 'holder-mismatch' }
      if (b.hash !== id) return { verdict: 'hash-mismatch' }
      proofWts = Math.min(wts, ev.body.ts) // authority-bound: clamp at owner-signed ts
    } else if (b.kind === 'chain') {
      // The subject's own countersigned witnessed head/checkpoint event. The
      // blob binding (hash === sha256 of chainToBytes at that head) is checked
      // at FETCH time: the blob is not present here (same deliberate limit as
      // shards.ts blobHash).
      const ev = b.proof.event as SignedEvent
      if (ev.body.lane !== 'w') return { verdict: 'bad-proof' }
      if (ev.body.root !== b.subject) return { verdict: 'subject-mismatch' }
      if (!verifyEventSig(ev)) return { verdict: 'bad-proof' }
      const id = eventId(ev.body)
      const wts = proofWtsOf(ev.wit, id)
      if (wts === null) return { verdict: 'bad-proof' }
      if (!keyProven(b.subject, ev.body.key, b.proof.certs)) return { verdict: 'bad-proof' }
      proofWts = Math.min(wts, ev.body.ts) // authority-bound: clamp at owner-signed ts
    } else {
      // 'shard': verified job header + objective duty by key distance.
      const h = b.proof.header as SnapshotHeader
      if (verifySnapshotHeader(h, opts.shard) !== 'ok') return { verdict: 'bad-proof' }
      if (h.root !== b.subject) return { verdict: 'subject-mismatch' }
      const idx = b.idx as number
      if (idx >= h.n) return { verdict: 'wrong-proof' }
      if (b.hash !== h.blobHash) return { verdict: 'hash-mismatch' }
      const wts = proofWtsOf(h.head.wit, h.headId)
      if (wts === null) return { verdict: 'bad-proof' } // unreachable past header verify; belt to it
      const headTs = h.head.body.ts // authority-bound: clamp at owner-signed head ts
      if (dutyMode === 'require') {
        if (!opts.directory || opts.nowMs === undefined) return { verdict: 'holder-mismatch' }
        const carriers = dutyCarriers(nodeIdOf(b.subject), idx, opts.directory, {
          nowMs: opts.nowMs,
          ...(opts.dutyK !== undefined ? { dutyK: opts.dutyK } : {}),
        })
        if (!carriers.includes(holderNodeId)) return { verdict: 'holder-mismatch' }
      }
      proofWts = Math.min(wts, headTs)
    }

    const skew = opts.tsSkewMs ?? POINTER_TS_SKEW_MS
    const effTs = Math.min(b.ts, proofWts + skew)
    const recId = toB64u(sha256(recBytes))
    return { verdict: 'ok', info: { ptr: r, holderNodeId, proofWts, effTs, recId } }
  } catch {
    return { verdict: 'bad-record' } // verifiers fail closed, never throw
  }
}

/** Full pointer verification (spec §5 rules above). Never throws. */
export function checkPointer(rec: unknown, opts: VerifyPointerOpts = {}): PointerCheck {
  return checkCore(rec, opts, 'require')
}

/** Verdict-only convenience over checkPointer. */
export function verifyPointer(rec: unknown, opts: VerifyPointerOpts = {}): PointerVerdict {
  return checkPointer(rec, opts).verdict
}

// ---------------------------------------------------------------------------
// Builders (holder side): builders THROW on programmer misuse
// ---------------------------------------------------------------------------

export interface MakePointerBase {
  /** Subject root the pointer indexes. */
  subject: B64u
  /** Holder account root. */
  holder: B64u
  /** The certified device key that signs (or the holder root itself). */
  key: B64u
  /** Private key matching `key`. */
  priv: Uint8Array
  /** Holder-claimed freshness, unix ms. The CALLER's clock (ranking only). */
  ts: number
  /** Root-signed certs proving `key` belongs to `holder` (omit if key===holder). */
  holderCerts?: SignedEvent[]
}

function signRecord(body: PointerRecord['body'], priv: Uint8Array, key: B64u): PointerRecord {
  if (toB64u(ed25519.getPublicKey(priv)) !== key) throw new Error('makePointer: priv does not match key')
  const sig = toB64u(ed25519.sign(canonicalBytes(body as unknown as CanonicalValue), priv))
  return { body, sig }
}

function assertOk(rec: PointerRecord, opts: VerifyPointerOpts, allow: PointerVerdict[] = []): PointerRecord {
  const v = verifyPointer(rec, opts)
  if (v !== 'ok' && !allow.includes(v)) throw new Error(`makePointer: built record does not verify (${v})`)
  return rec
}

/**
 * Mint a 'segment' pointer: `event` is the SUBJECT's countersigned segment
 * event (wit attached) whose payload names THIS holder as counterparty;
 * `certs` prove the subject's signing key when device-signed. hash = the
 * event's id (the content a viewer will fetch and re-hash).
 */
export function makeSegmentPointer(
  o: MakePointerBase & { event: SignedEvent; certs?: SignedEvent[] },
): PointerRecord {
  const body: PointerRecord['body'] = {
    v: 1,
    subject: o.subject,
    holder: o.holder,
    key: o.key,
    kind: 'segment',
    hash: eventId(o.event.body),
    ts: o.ts,
    proof: { event: o.event, ...(o.certs !== undefined ? { certs: o.certs } : {}) },
    holderCerts: o.holderCerts ?? [],
  }
  return assertOk(signRecord(body, o.priv, o.key), {})
}

/**
 * Mint a 'chain' pointer: `event` is the subject's countersigned witnessed
 * head/checkpoint event; `blobHash` = sha256(chainToBytes(chain)) at exactly
 * that head (the caller holds the chain; that is the claim).
 */
export function makeChainPointer(
  o: MakePointerBase & { event: SignedEvent; certs?: SignedEvent[]; blobHash: B64u },
): PointerRecord {
  const body: PointerRecord['body'] = {
    v: 1,
    subject: o.subject,
    holder: o.holder,
    key: o.key,
    kind: 'chain',
    hash: o.blobHash,
    ts: o.ts,
    proof: { event: o.event, ...(o.certs !== undefined ? { certs: o.certs } : {}) },
    holderCerts: o.holderCerts ?? [],
  }
  return assertOk(signRecord(body, o.priv, o.key), {})
}

/**
 * Mint a 'shard' pointer for row `idx` of the job `header`. When a directory
 * snapshot is supplied the builder ALSO asserts the holder is on duty (throws
 * otherwise); without one the duty claim is left to store gates + viewers
 * (the publisher's directory may lag theirs; duty is judged by observers).
 */
export function makeShardPointer(
  o: MakePointerBase & {
    header: SnapshotHeader
    idx: number
    verify?: VerifyShardOpts
    directory?: NodeDirectory
    nowMs?: number
    dutyK?: number
  },
): PointerRecord {
  const body: PointerRecord['body'] = {
    v: 1,
    subject: o.subject,
    holder: o.holder,
    key: o.key,
    kind: 'shard',
    hash: o.header.blobHash,
    idx: o.idx,
    ts: o.ts,
    proof: { header: o.header },
    holderCerts: o.holderCerts ?? [],
  }
  const rec = signRecord(body, o.priv, o.key)
  const opts: VerifyPointerOpts = {
    ...(o.verify !== undefined ? { shard: o.verify } : {}),
    ...(o.directory !== undefined ? { directory: o.directory } : {}),
    ...(o.nowMs !== undefined ? { nowMs: o.nowMs } : {}),
    ...(o.dutyK !== undefined ? { dutyK: o.dutyK } : {}),
  }
  // Without a directory the ONLY acceptable non-ok is the unverifiable-duty
  // verdict (every context-free check must still have passed).
  return assertOk(rec, opts, o.directory === undefined ? ['holder-mismatch'] : [])
}

// ---------------------------------------------------------------------------
// Deterministic per-key cap (merge fold): honest pointers survive floods
// ---------------------------------------------------------------------------
//
// The stored row is bounded at capPerKey. Which entries survive is decided by
// a TOTAL deterministic order built from proof strength, never arrival luck:
//   0. seg/chain DEDUP per (holder, hash): a holder's variants of ONE proof
//      (same segment event / same head blobHash) collapse to a single entry
//      (freshest by capped effTs). Without this a single real entanglement
//      partner could re-sign its ONE segment pointer with cap-many `ts` values
//      (each a distinct record) and, since segments outrank shard/chain,
//      evict EVERY shard and chain pointer from the subject's index.
//   1. kind rank: segment(0) < shard(1) < chain(2). Segment pointers cannot be
//      minted without the subject's own signed event naming the holder, and
//      shard entries rank by objective key distance, so the one freely
//      sybil-mintable kind ('chain', from the subject's public head) is always
//      truncated FIRST. An attacker flood can never evict a real partner.
//   2. fair share: within 'segment'/'chain', each holder's DISTINCT proofs are
//      indexed 0,1,2… (its own freshest first, by capped effTs) and round r of
//      every holder outranks round r+1 of any holder: one noisy holder cannot
//      crowd others out. Within 'shard', entries rank per idx by XOR distance
//      of the holder to that row's shardKey (closest first; the duty metric
//      itself), then round-robin across rows, so each row keeps its closest
//      carriers before any row keeps extras.
//   3. final tie-break: record id (total order ⇒ byte-deterministic rows).
//
// Ranking uses the AUTHORITY-BOUNDED effTs (min(ts, proofWts + skew)), never the
// raw holder-claimed ts, so a lying ts cannot win a scarce retention slot over
// an honest record: the same ceiling the viewer applies at display time.

interface CapEntry {
  rec: PointerRecord
  recId: B64u
  kindRank: number
  rank2: number
  /** seg/chain: capped effTs (desc); shard: idx (asc). */
  rank3: number
}

const KIND_RANK: Record<string, number> = { segment: 0, shard: 1, chain: 2 }

function orderEntries(subjectNodeId: NodeId, list: { rec: PointerRecord; recId: B64u; effTs: number }[]): PointerRecord[] {
  const entries: CapEntry[] = []
  const fresher = (a: { effTs: number; recId: B64u }, b: { effTs: number; recId: B64u }): number =>
    b.effTs - a.effTs || compareKeys(a.recId, b.recId)
  // seg/chain: collapse each holder's variants of ONE proof to its freshest,
  // then fair-share the holder's DISTINCT proofs by capped effTs. The dedup key
  // is the OWNER-signed proof event id, NOT body.hash. For 'segment' the two are
  // equal (checkCore binds hash === event id), but for 'chain' body.hash is the
  // holder-chosen, unverified-at-this-stage blobHash: keying on it would let ONE
  // holder mint many chain pointers with distinct fake hashes and occupy many
  // slots. Keying on the event id collapses a holder's variants of one head.
  for (const kind of ['segment', 'chain'] as const) {
    const byHolder = new Map<B64u, Map<B64u, { rec: PointerRecord; recId: B64u; effTs: number }>>()
    for (const e of list) {
      if (e.rec.body.kind !== kind) continue
      const proofKey = e.rec.body.proof.event ? eventId(e.rec.body.proof.event.body) : e.rec.body.hash
      const perHash = byHolder.get(e.rec.body.holder) ?? new Map()
      const prev = perHash.get(proofKey)
      if (!prev || fresher(e, prev) < 0) perHash.set(proofKey, e)
      byHolder.set(e.rec.body.holder, perHash)
    }
    for (const perHash of byHolder.values()) {
      const arr = [...perHash.values()].sort(fresher)
      arr.forEach((e, i) =>
        entries.push({ rec: e.rec, recId: e.recId, kindRank: KIND_RANK[kind], rank2: i, rank3: -e.effTs }),
      )
    }
  }
  // shard per-idx objective distance ranks.
  {
    const byIdx = new Map<number, { rec: PointerRecord; recId: B64u; d: bigint }[]>()
    for (const e of list) {
      if (e.rec.body.kind !== 'shard') continue
      const idx = e.rec.body.idx as number
      const d = xorDistance(nodeIdOf(e.rec.body.holder), shardKey(subjectNodeId, idx))
      const arr = byIdx.get(idx) ?? []
      arr.push({ ...e, d })
      byIdx.set(idx, arr)
    }
    for (const [idx, arr] of byIdx) {
      arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : compareKeys(a.recId, b.recId)))
      // One slot per DISTINCT carrier first (closest-first), duplicates of a
      // carrier behind every unique: a carrier re-publishing (fresh ts, old
      // header) can never crowd the row's other true carriers out of the cap.
      const perHolder = new Map<B64u, number>()
      let uniq = 0
      let dup = 0
      for (const e of arr) {
        const c = perHolder.get(e.rec.body.holder) ?? 0
        perHolder.set(e.rec.body.holder, c + 1)
        const rank2 = c === 0 ? uniq++ : arr.length + dup++
        entries.push({ rec: e.rec, recId: e.recId, kindRank: KIND_RANK.shard, rank2, rank3: idx })
      }
    }
  }
  entries.sort(
    (a, b) => a.kindRank - b.kindRank || a.rank2 - b.rank2 || a.rank3 - b.rank3 || compareKeys(a.recId, b.recId),
  )
  return entries.map((e) => e.rec)
}

const asValue = (v: unknown): CanonicalObject => v as CanonicalObject
const recIdOf = (rec: PointerRecord): B64u => toB64u(canonicalHash({ body: rec.body, sig: rec.sig } as unknown as CanonicalValue))

/** Shape-parse a stored/offered row into records; [] on anything non-conforming
 * (fail closed), including a row LARGER than the cap, which no honest holder
 * can ever produce (stored rows are capped), so it contributes nothing. */
function rowPtrs(value: unknown, capPerKey: number): PointerRecord[] {
  const p = zPointerRow.safeParse(value)
  if (!p.success) return []
  const raw = (value as PointerRow).ptrs
  if (raw.length > capPerKey) return []
  const out: PointerRecord[] = []
  for (const r of raw) {
    if (zPointerRecord.safeParse(r).success) out.push(r as PointerRecord)
  }
  return out
}

export interface PointerMergeOpts {
  /** Stored-row bound; default PARAMS_A3.pointerCapPerKey. */
  capPerKey?: number
  /** Context-free verification knobs for newly-arrived records. */
  shard?: VerifyShardOpts
  tsSkewMs?: number
  maxBytes?: number
}

/**
 * The pointer-set fold (overlay MergeFn): kind 'pointers' unions prev ∪ next
 * (dedup by record id), re-verifies every NEWLY-ARRIVED record with the
 * context-free core (prev entries passed it when they arrived; the fold is
 * inductive, and read-side getMerged folds start from null so EVERY record a
 * reader accumulates has passed it), enforces the per-subject key binding,
 * and caps deterministically per orderEntries. Every other kind delegates to
 * shards.storageMerge: install this ONE merge and the whole storage layer
 * ('events' union, 'shard' replace, 'pointers' capped union) is composed.
 * On an internal error it returns prev (fail closed; never store junk).
 */
export function makePointerMerge(o: PointerMergeOpts = {}): MergeFn {
  const cap = o.capPerKey ?? PARAMS_A3.pointerCapPerKey
  const coreOpts: VerifyPointerOpts = {
    ...(o.shard !== undefined ? { shard: o.shard } : {}),
    ...(o.tsSkewMs !== undefined ? { tsSkewMs: o.tsSkewMs } : {}),
    ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
  }
  const skew = o.tsSkewMs ?? POINTER_TS_SKEW_MS
  return (prev, next, kind, target) => {
    if (kind !== 'pointers') return storageMerge(prev, next, kind, target)
    try {
      const seen = new Set<B64u>()
      const union: { rec: PointerRecord; recId: B64u; effTs: number }[] = []
      let subjectNodeId: NodeId | null = null
      for (const rec of rowPtrs(prev, cap)) {
        const recId = recIdOf(rec)
        if (seen.has(recId)) continue
        seen.add(recId)
        // prev already passed the verifier when stored. Recompute only its
        // capped effTs (cheap) so the cap fold ranks it against next by the same
        // authority ceiling.
        union.push({ rec, recId, effTs: effTsOf(rec, skew) })
        subjectNodeId = subjectNodeId ?? nodeIdOf(rec.body.subject)
      }
      for (const rec of rowPtrs(next, cap)) {
        const c = checkCore(rec, coreOpts, 'skip')
        if (c.verdict !== 'ok' || !c.info) continue
        if (pointerKey(nodeIdOf(rec.body.subject)) !== target) continue // foreign-subject row
        if (seen.has(c.info.recId)) continue
        seen.add(c.info.recId)
        union.push({ rec, recId: c.info.recId, effTs: c.info.effTs })
        subjectNodeId = subjectNodeId ?? nodeIdOf(rec.body.subject)
      }
      if (union.length === 0 || subjectNodeId === null) return prev ?? asValue({ v: 1, ptrs: [] })
      const ptrs = orderEntries(subjectNodeId, union).slice(0, cap)
      return asValue({ v: 1, ptrs })
    } catch {
      return prev ?? asValue({ v: 1, ptrs: [] }) // fold fails closed, never stores junk
    }
  }
}

// ---------------------------------------------------------------------------
// Store gate (installed on the overlay node), the write-time index
// ---------------------------------------------------------------------------

export interface PointerStoreOpts {
  /** Directory snapshot provider for shard-duty checks at store time (each
   * store is judged under the CARRIER's own current view. C-3 local state). */
  directory: () => NodeDirectory
  /** Injected clock (ms). REQUIRED. No ambient time. */
  nowMs: () => number
  dutyK?: number
  /** Verification context for accepted records (default PARAMS_A3). */
  shard?: VerifyShardOpts
  tsSkewMs?: number
  maxBytes?: number
  /** Stored-row bound; default PARAMS_A3.pointerCapPerKey. */
  capPerKey?: number
  /** Fallback gate for kinds this layer does not own. Default mirrors the
   * overlay's own default: accept 'record', refuse the rest. Compose with
   * makeShardStoreValidator via ITS `base` to gate all four kinds. */
  base?: StoreValidator
}

export interface PointerStoreGate {
  validator: StoreValidator
  merge: MergeFn
}

/**
 * Build the pointer layer's STORE gate for one node. kind 'pointers' is
 * accepted only when the offered row is a well-formed set row within the cap
 * and EVERY record in it (1) fully verifies. Embedded proof, holder certs,
 * shard duty under this node's directory snapshot at its injected clock, and
 * (2) is bound to the target key: pointerKey(nodeIdOf(subject)) === target.
 * All-or-nothing per row (an honest publisher's row is entirely its own).
 * Growth is bounded by the merge's deterministic cap, so a flood can neither
 * exhaust storage nor evict proof-stronger honest pointers. Refusal is honest
 * degradation (StoreRes stored:false), never an error.
 */
export function makePointerStoreValidator(opts: PointerStoreOpts): PointerStoreGate {
  const cap = opts.capPerKey ?? PARAMS_A3.pointerCapPerKey
  const base: StoreValidator = opts.base ?? ((_f, _t, kind, _v) => kind === 'record')
  const mergeOpts: PointerMergeOpts = {
    capPerKey: cap,
    ...(opts.shard !== undefined ? { shard: opts.shard } : {}),
    ...(opts.tsSkewMs !== undefined ? { tsSkewMs: opts.tsSkewMs } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  }

  const validator: StoreValidator = (from, target, kind, value) => {
    try {
      if (kind !== 'pointers') return base(from, target, kind, value)
      const p = zPointerRow.safeParse(value)
      if (!p.success) return false
      const raw = (value as unknown as PointerRow).ptrs
      if (raw.length > cap) return false
      const vOpts: VerifyPointerOpts = {
        directory: opts.directory(),
        nowMs: opts.nowMs(),
        ...(opts.dutyK !== undefined ? { dutyK: opts.dutyK } : {}),
        ...(opts.shard !== undefined ? { shard: opts.shard } : {}),
        ...(opts.tsSkewMs !== undefined ? { tsSkewMs: opts.tsSkewMs } : {}),
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      }
      for (const rec of raw) {
        const c = checkPointer(rec, vOpts)
        if (c.verdict !== 'ok') return false
        if (pointerKey(nodeIdOf((rec as PointerRecord).body.subject)) !== target) return false
      }
      return true
    } catch {
      return false // gates fail closed, never throw into the overlay
    }
  }

  return { validator, merge: makePointerMerge(mergeOpts) }
}

// ---------------------------------------------------------------------------
// Publish helpers (the WRITE-time index, spec §5: viewing never searches)
// ---------------------------------------------------------------------------

/** Publish one pointer into the overlay under its subject's pointer key:
 * offered to the replicateK closest nodes, each of which re-verifies it via
 * its own gate. Returns the number of true stores. */
export function publishPointer(node: OverlayNode, rec: PointerRecord): Promise<number> {
  return node.put(pointerKeyOfRoot(rec.body.subject), 'pointers', asValue({ v: 1, ptrs: [rec] }))
}

/** Publish a batch, grouped one put per subject key (deterministic order,
 * input order of first appearance). Returns Σ true stores. */
export async function publishPointers(node: OverlayNode, recs: readonly PointerRecord[]): Promise<number> {
  const bySubject = new Map<B64u, PointerRecord[]>()
  for (const rec of recs) {
    const key = pointerKeyOfRoot(rec.body.subject)
    const arr = bySubject.get(key) ?? []
    arr.push(rec)
    bySubject.set(key, arr)
  }
  let stored = 0
  for (const [key, ptrs] of bySubject) stored += await node.put(key, 'pointers', asValue({ v: 1, ptrs }))
  return stored
}

// ---------------------------------------------------------------------------
// Viewer side: enumerate → verify → ranked contact sheet
// ---------------------------------------------------------------------------

/** Minimal read surface: any OverlayNode; when the node exposes getMerged
 * (OverlayNodeExt) enumeration folds ALL holders' rows, not the first hit. */
export interface PointerReadNode {
  get(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
  getMerged?(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
}

/** Fetch + shape-parse a subject's pointer row. Records returned are
 * UNVERIFIED (shape only): feed them to buildContactSheet / checkPointer. */
export async function enumeratePointers(
  node: PointerReadNode,
  subjectRoot: B64u,
  capPerKey = PARAMS_A3.pointerCapPerKey,
): Promise<PointerRecord[]> {
  const key = pointerKeyOfRoot(subjectRoot)
  const row = node.getMerged ? await node.getMerged(key, 'pointers') : await node.get(key, 'pointers')
  if (row === null) return []
  return rowPtrs(row, capPerKey)
}

/**
 * Build the verified, ranked ContactSheet from an enumerated row (spec §5:
 * "viewers rank by embedded proof and ignore the rest"). Only records whose
 * embedded proof verifies AND names this subject survive; segments/chains
 * sort freshest-first by capped effTs (tie: record id); shard entries rank
 * per idx by objective XOR distance to the row's key. Closest first, deduped
 * per holder, at most dutyK per idx. Pure + deterministic given (row, opts).
 */
export function buildContactSheet(subjectRoot: B64u, row: unknown, opts: VerifyPointerOpts = {}): ContactSheet {
  const sheet: ContactSheet = { subject: subjectRoot, segments: [], chains: [], shards: new Map() }
  const subjectNodeId = nodeIdOf(subjectRoot)
  const dutyK = opts.dutyK ?? PARAMS_A3.dutyK
  const seen = new Set<B64u>()
  const segs: { holder: B64u; ptr: PointerRecord; effTs: number; recId: B64u }[] = []
  const chains: { holder: B64u; ptr: PointerRecord; effTs: number; recId: B64u }[] = []
  const shards = new Map<number, { holder: B64u; nodeId: NodeId; ptr: PointerRecord; d: bigint; recId: B64u }[]>()

  for (const rec of rowPtrs(row, PARAMS_A3.pointerCapPerKey)) {
    const c = checkPointer(rec, opts)
    if (c.verdict !== 'ok' || !c.info) continue // ignored, never ranked
    const b = rec.body
    if (b.subject !== subjectRoot) continue
    if (seen.has(c.info.recId)) continue
    seen.add(c.info.recId)
    if (b.kind === 'segment') {
      segs.push({ holder: b.holder, ptr: rec, effTs: c.info.effTs, recId: c.info.recId })
    } else if (b.kind === 'chain') {
      chains.push({ holder: b.holder, ptr: rec, effTs: c.info.effTs, recId: c.info.recId })
    } else {
      const idx = b.idx as number
      const d = xorDistance(c.info.holderNodeId, shardKey(subjectNodeId, idx))
      const arr = shards.get(idx) ?? []
      arr.push({ holder: b.holder, nodeId: c.info.holderNodeId, ptr: rec, d, recId: c.info.recId })
      shards.set(idx, arr)
    }
  }

  const freshFirst = <T extends { effTs: number; recId: B64u }>(a: T, b: T): number =>
    b.effTs - a.effTs || compareKeys(a.recId, b.recId)
  sheet.segments = segs.sort(freshFirst).map(({ holder, ptr }) => ({ holder, ptr }))
  sheet.chains = chains.sort(freshFirst).map(({ holder, ptr }) => ({ holder, ptr }))
  for (const [idx, arr] of [...shards.entries()].sort((a, b) => a[0] - b[0])) {
    arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : compareKeys(a.recId, b.recId)))
    const perHolder: { holder: B64u; nodeId: NodeId; ptr: PointerRecord }[] = []
    const holders = new Set<B64u>()
    for (const e of arr) {
      if (holders.has(e.holder)) continue // one slot per carrier per row
      holders.add(e.holder)
      perHolder.push({ holder: e.holder, nodeId: e.nodeId, ptr: e.ptr })
      if (perHolder.length >= dutyK) break
    }
    sheet.shards.set(idx, perHolder)
  }
  return sheet
}

/** The O(1) viewing entry: ONE overlay lookup (pointerKey of the subject) →
 * verified ranked sheet. */
export async function enumerateContactSheet(
  node: PointerReadNode,
  subjectRoot: B64u,
  opts: VerifyPointerOpts = {},
): Promise<ContactSheet> {
  const key = pointerKeyOfRoot(subjectRoot)
  const row = node.getMerged ? await node.getMerged(key, 'pointers') : await node.get(key, 'pointers')
  return buildContactSheet(subjectRoot, row, opts)
}
