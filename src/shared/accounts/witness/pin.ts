// PIN record + attempt-counter + fuse + session + handoff layer (spec §1).
// Pure verifiers and builders on top of oprf.ts / shamir.ts. Signing, hashing
// and canonical serialization are A1's (events/codec/hash), never reimplemented.
//
// CHAIN-EVENT vs STANDALONE-RECORD decision (reported to the lead):
//   A1's EventType is 'genesis'|'cert'|'revoke'|'profile'|'ckpt' and is FROZEN
//   (types.ts, events.ts). It does NOT include 'pin'. The spec (§1) says the
//   PIN/fuse records are "published into shard/pointer space under the account's
//   key". A *public signed fact any verifier can check*, not necessarily a
//   witnessed-lane chain event. We therefore carry PIN state as its OWN
//   root-signed standalone records (SignedPinRecord), verifiable with nothing
//   but the record + the account root pubkey: exactly like the fuse record the
//   type contract already models as a standalone {body, sigs}. This needs NO
//   change to the frozen chain event registry. If the lead concludes PIN
//   records MUST ride the witnessed lane, that requires adding a 'pin' EventType
//   to the frozen A1 types.ts + events.ts (a contract change, flagged).
//
// Platform-neutral: no `node:` imports, no DOM globals.

import { z } from 'zod'
import { canonicalBytes, canonicalHash, type CanonicalObject } from '../codec'
import { ed25519, toB64u, verifySigB64u as verifySig } from '../hash'
import { zB64u32, zB64u64 } from '../events'
import type { B64u, EventId } from '../types'
import { PARAMS_A2, PARAMS_A2_DIGEST } from './params'
import type {
  NodeId,
  PinRecordPayload,
  PinAttemptReport,
  FuseRecordBody,
  FuseRecord,
  PinSessionBody,
  PinSession,
  RootSession,
} from './types'

const MS_PER_DAY = 86_400_000

/** The digest a record embeds for a given params revision. For PARAMS_A2 this
 * equals PARAMS_A2_DIGEST; a record minted under an earlier revision carries
 * that revision's digest and is verified against it (see verifyFuseRecord). */
function paramsDigest(params: typeof PARAMS_A2): string {
  return params === PARAMS_A2 ? PARAMS_A2_DIGEST : toB64u(canonicalHash(params))
}

// ---------------------------------------------------------------------------
// Local zod schemas: the 'pin' payloads live HERE (events.ts is frozen and
// has no 'pin' type). Mirror witness/types.ts exactly, all .strict().
// ---------------------------------------------------------------------------

const zNodeId = zB64u32

export const zPinRecordPayload = z.strictObject({
  committee: z.array(zNodeId).min(1),
  t: z.int().min(1),
  shareCommitments: z.array(zB64u32).min(1),
  pinPub: zB64u32,
  params: zB64u32,
  prev: zB64u32.optional(),
  carriedFails: z.int().min(0).optional(),
})

export const zPinAttemptReport = z.strictObject({
  root: zB64u32,
  w: zNodeId,
  fails: z.int().min(0),
  asOfWts: z.int().min(0),
  sig: zB64u64,
})

export const zFuseRecordBody = z.strictObject({
  v: z.literal(1),
  root: zB64u32,
  fails: z.int().min(0),
  trippedWts: z.int().min(0),
  expiryWts: z.int().min(0),
  pinRecord: zB64u32,
  params: zB64u32,
})

export const zPinSessionBody = z.strictObject({
  v: z.literal(1),
  root: zB64u32,
  device: zB64u32,
  purpose: z.enum(['lease-takeover', 'device-witness', 'committee-handoff']),
  evalNonce: zB64u32,
  wts: z.int().min(0),
  epoch: z.int().min(1).optional(),
  record: zB64u32.optional(),
})

/** Uniform verifier result: deterministic, sorted error strings. */
export interface PinVerify {
  ok: boolean
  errors: string[]
}
function fail(...errors: string[]): PinVerify {
  return { ok: false, errors }
}
const OK: PinVerify = { ok: true, errors: [] }

// ===========================================================================
// 1. PIN record: root-signed standalone record
// ===========================================================================

export interface SignedPinRecord {
  payload: PinRecordPayload
  /** Account root pubkey (== signer). */
  root: B64u
  /** ed25519 by root over canonicalBytes(payload). */
  sig: B64u
}

export interface MakePinRecordOpts {
  committee: NodeId[]
  t: number
  shareCommitments: B64u[]
  pinPub: B64u
  /** Previous 'pin' record id when re-provisioning (handoff). */
  prev?: EventId
  /** Carried-forward failure count (handoff). A fresh committee can never
   * start below this (spec §1). */
  carriedFails?: number
}

/**
 * Build a validated PinRecordPayload with PARAMS_A2_DIGEST embedded. Enforces
 * the committee shape (length == pinN, threshold == pinT, one commitment per
 * member) so a malformed record can never be signed.
 */
export function makePinRecordPayload(opts: MakePinRecordOpts): PinRecordPayload {
  if (opts.committee.length !== PARAMS_A2.pinN)
    throw new Error(`makePinRecordPayload: committee must have ${PARAMS_A2.pinN} members`)
  if (opts.t !== PARAMS_A2.pinT) throw new Error(`makePinRecordPayload: t must be ${PARAMS_A2.pinT}`)
  if (opts.shareCommitments.length !== opts.committee.length)
    throw new Error('makePinRecordPayload: one share commitment per committee member required')
  if (new Set(opts.committee).size !== opts.committee.length)
    throw new Error('makePinRecordPayload: committee has duplicate members')
  const payload: PinRecordPayload = {
    committee: [...opts.committee],
    t: opts.t,
    shareCommitments: [...opts.shareCommitments],
    pinPub: opts.pinPub,
    params: PARAMS_A2_DIGEST,
  }
  if (opts.prev !== undefined) payload.prev = opts.prev
  if (opts.carriedFails !== undefined) payload.carriedFails = opts.carriedFails
  // Validate against the schema so a bad shape throws at build time, not verify.
  const parsed = zPinRecordPayload.safeParse(payload)
  if (!parsed.success) throw new Error(`makePinRecordPayload: invalid payload: ${parsed.error.issues[0]?.code}`)
  return payload
}

/** Deterministic id of a PIN record = sha256(canonicalBytes(payload)) b64u. */
export function pinRecordId(payload: PinRecordPayload): EventId {
  return toB64u(canonicalHash(payload))
}

/** Root-sign a PIN record payload into a standalone verifiable record. */
export function buildPinRecord(payload: PinRecordPayload, rootPriv: Uint8Array, root: B64u): SignedPinRecord {
  if (toB64u(ed25519.getPublicKey(rootPriv)) !== root)
    throw new Error('buildPinRecord: rootPriv does not match root')
  const sig = toB64u(ed25519.sign(canonicalBytes(payload), rootPriv))
  return { payload, root, sig }
}

/**
 * Standalone verify: signature by root, params digest matches, committee shape,
 * commitment alignment. Pure. `expectDigest` defaults to the current A2 digest;
 * a record made under an earlier revision carries its own digest and is checked
 * against whatever the caller passes.
 */
export function verifyPinRecord(rec: SignedPinRecord, expectDigest: string = PARAMS_A2_DIGEST): PinVerify {
  const errors: string[] = []
  const parsed = zPinRecordPayload.safeParse(rec.payload)
  if (!parsed.success) return fail('pin-record: malformed payload')
  const p = rec.payload
  if (p.params !== expectDigest) errors.push('pin-record: params digest mismatch')
  if (p.committee.length !== PARAMS_A2.pinN) errors.push('pin-record: committee size != pinN')
  if (p.t !== PARAMS_A2.pinT) errors.push('pin-record: t != pinT')
  if (p.shareCommitments.length !== p.committee.length) errors.push('pin-record: commitment count mismatch')
  if (new Set(p.committee).size !== p.committee.length) errors.push('pin-record: duplicate committee members')
  if (!verifySig(rec.sig, canonicalBytes(p), rec.root)) errors.push('pin-record: bad root signature')
  return errors.length ? { ok: false, errors: errors.sort() } : OK
}

// ===========================================================================
// 2. Attempt counter (C-2, spec §1): evaluations minus proven successes
// ===========================================================================

/** Per-member local counter state. Persisted by each committee member. */
export interface PinCounterState {
  evaluations: number
  successes: number
}

export function newCounter(): PinCounterState {
  return { evaluations: 0, successes: 0 }
}
/** Every blind-evaluation request served increments evaluations. */
export function applyEval(s: PinCounterState): PinCounterState {
  return { evaluations: s.evaluations + 1, successes: s.successes }
}
/** A pinKey-signed success proof marks one evaluation successful (net 0). */
export function applySuccess(s: PinCounterState): PinCounterState {
  // successes can never exceed evaluations (a success always follows its eval).
  return { evaluations: s.evaluations, successes: Math.min(s.successes + 1, s.evaluations) }
}
/** This member's reported failure count = evaluations − successes. */
export function memberFails(s: PinCounterState): number {
  return Math.max(0, s.evaluations - s.successes)
}

/** Bytes a PinAttemptReport signs (the report minus its own sig). */
function attemptReportBytes(r: Omit<PinAttemptReport, 'sig'>): Uint8Array {
  const body: CanonicalObject = { root: r.root, w: r.w, fails: r.fails, asOfWts: r.asOfWts }
  return canonicalBytes(body)
}

/**
 * A committee member signs its current count into a portable report. `memberKey`
 * is the member's signing pubkey (certified in its own chain); `priv` matches it.
 */
export function signAttemptReport(
  state: PinCounterState,
  root: B64u,
  w: NodeId,
  memberKey: B64u,
  priv: Uint8Array,
  wts: number,
): PinAttemptReport {
  if (toB64u(ed25519.getPublicKey(priv)) !== memberKey)
    throw new Error('signAttemptReport: priv does not match memberKey')
  const base = { root, w, fails: memberFails(state), asOfWts: wts }
  const sig = toB64u(ed25519.sign(attemptReportBytes(base), priv))
  return { ...base, sig }
}

/**
 * Verify a report's signature. PinAttemptReport carries no signing-key field
 * (only the member NodeId `w`), so the verifier must supply the member's signing
 * pubkey out of band: from the committee's presence/cert records, exactly like
 * the rest of the fabric maps NodeId→key. (Reported as a contract observation.)
 */
export function verifyAttemptReport(report: PinAttemptReport, memberKey: B64u): boolean {
  const parsed = zPinAttemptReport.safeParse(report)
  if (!parsed.success) return false
  const { sig, ...base } = report
  return verifySig(sig, attemptReportBytes(base), memberKey)
}

/**
 * Committee-effective failure count from a set of co-attested reports: the t-th
 * largest reported value (a minority of ≤ N−t malicious members can neither
 * low-ball nor inflate it: spec §1 "a minority can't low-ball"). Requires ≥ t
 * reports for the SAME root; returns 0 when fewer than t reports agree.
 * Deterministic. `reports` should be pre-filtered to verified reports.
 */
export function effectiveCount(reports: readonly PinAttemptReport[], t: number): number {
  // One report per member (highest fails wins if a member is double-counted).
  const byMember = new Map<NodeId, number>()
  for (const r of reports) {
    const cur = byMember.get(r.w)
    if (cur === undefined || r.fails > cur) byMember.set(r.w, r.fails)
  }
  const fails = [...byMember.values()].sort((a, b) => b - a) // descending
  if (fails.length < t) return 0
  return fails[t - 1]
}

// ===========================================================================
// 3. Fuse (spec §1): threshold-signed ban record + refill semantics
// ===========================================================================

/**
 * Failure threshold for the (tripsSoFar)-th trip: 100, 120, 140, … The counter
 * NEVER resets; each post-expiry cycle needs pinRefill more failures.
 */
export function fuseThreshold(tripsSoFar: number, params: typeof PARAMS_A2 = PARAMS_A2): number {
  // Clamp: a negative trip index must never lower the threshold below the
  // lifetime minimum (a caller-supplied negative would otherwise forge a trip).
  const trips = Number.isInteger(tripsSoFar) && tripsSoFar > 0 ? tripsSoFar : 0
  return params.pinLifetimeFails + trips * params.pinRefill
}

/**
 * Whether the fuse should trip now: effective count has reached this cycle's
 * threshold and the cycle isn't already tripped. `tripsSoFar` = number of prior
 * trips (0 for the first).
 */
export function shouldTrip(
  effective: number,
  tripsSoFar: number,
  alreadyTrippedThisCycle: boolean,
  params: typeof PARAMS_A2 = PARAMS_A2,
): boolean {
  if (alreadyTrippedThisCycle) return false
  return effective >= fuseThreshold(tripsSoFar, params)
}

/** Canonical fuse body: signers and assemblers agree on these exact bytes. */
export function fuseRecordBody(
  root: B64u,
  fails: number,
  trippedWts: number,
  pinRecord: EventId,
  params: typeof PARAMS_A2 = PARAMS_A2,
): FuseRecordBody {
  return {
    v: 1,
    root,
    fails,
    trippedWts,
    expiryWts: trippedWts + params.pinBanDays * MS_PER_DAY,
    pinRecord,
    params: paramsDigest(params),
  }
}

/** A committee member signs a fuse body. */
export function signFuse(
  body: FuseRecordBody,
  w: NodeId,
  memberKey: B64u,
  priv: Uint8Array,
): { w: NodeId; key: B64u; sig: B64u } {
  if (toB64u(ed25519.getPublicKey(priv)) !== memberKey) throw new Error('signFuse: priv does not match memberKey')
  return { w, key: memberKey, sig: toB64u(ed25519.sign(canonicalBytes(body), priv)) }
}

/** Assemble a fuse record from a body + collected member signatures. */
export function makeFuseRecord(
  root: B64u,
  fails: number,
  trippedWts: number,
  pinRecord: EventId,
  memberSigs: { w: NodeId; key: B64u; sig: B64u }[],
): FuseRecord {
  const body = fuseRecordBody(root, fails, trippedWts, pinRecord)
  return { body, sigs: [...memberSigs] }
}

export interface VerifyFuseOpts {
  params?: typeof PARAMS_A2
}

/**
 * Verify a fuse record: ≥ pinT distinct committee members with valid signatures
 * over the body, expiry = tripped + ban window, params digest current. Pure.
 *
 * `keyOf` (nodeId → the member's advertised signing key, from presence/certs) is
 * REQUIRED and load-bearing: without binding each signer's nodeId to its real
 * advertised key, one malicious member could forge the whole record by emitting
 * pinT entries that each claim a distinct honest member's `w` but sign with its
 * OWN key. A signer whose `w` is unbound, whose key mismatches, or whose sig
 * fails is not counted, so a forged record can never reach pinT.
 */
export function verifyFuseRecord(
  fr: FuseRecord,
  committee: readonly NodeId[],
  keyOf: ReadonlyMap<NodeId, B64u>,
  opts: VerifyFuseOpts = {},
): PinVerify {
  const params = opts.params ?? PARAMS_A2
  const parsed = zFuseRecordBody.safeParse(fr.body)
  if (!parsed.success) return fail('fuse: malformed body')
  if (!Array.isArray(fr.sigs)) return fail('fuse: malformed sigs') // fail closed, never throw
  const errors: string[] = []
  const member = new Set(committee)
  const msg = canonicalBytes(fr.body)
  // Verify against the revision the CALLER supplies (opts.params), mirroring
  // verifyPinRecord's expectDigest: a fuse minted under an earlier params
  // revision carries that revision's digest and stays verifiable across a bump.
  if (fr.body.params !== paramsDigest(params)) errors.push('fuse: params digest mismatch')
  if (fr.body.expiryWts !== fr.body.trippedWts + params.pinBanDays * MS_PER_DAY)
    errors.push('fuse: expiry != tripped + ban window')
  const counted = new Set<NodeId>()
  for (const s of fr.sigs) {
    if (!member.has(s.w)) {
      errors.push(`fuse: signer ${s.w} not in committee`)
      continue
    }
    if (counted.has(s.w)) continue // one vote per member
    const bound = keyOf.get(s.w)
    if (bound === undefined) {
      errors.push(`fuse: signer ${s.w} has no advertised key binding`)
      continue
    }
    if (bound !== s.key) {
      errors.push(`fuse: signer ${s.w} key does not match its advertised key`)
      continue
    }
    if (!verifySig(s.sig, msg, bound)) {
      errors.push(`fuse: bad signature from ${s.w}`)
      continue
    }
    counted.add(s.w)
  }
  if (counted.size < params.pinT) errors.push(`fuse: only ${counted.size} valid member signatures (need ${params.pinT})`)
  return errors.length ? { ok: false, errors: errors.sort() } : OK
}

/** Is the fuse currently banning? (spec §1: now within the ban window.) */
export function isFuseActive(fr: FuseRecord, nowWts: number): boolean {
  return nowWts >= fr.body.trippedWts && nowWts < fr.body.expiryWts
}

// ===========================================================================
// 4. PIN session (spec §1), pinKey-signed authorization for takeover / enroll
// ===========================================================================

export function makePinSession(body: PinSessionBody, pinPriv: Uint8Array): PinSession {
  const parsed = zPinSessionBody.safeParse(body)
  if (!parsed.success) throw new Error(`makePinSession: invalid body: ${parsed.error.issues[0]?.code}`)
  return { body, pinSig: toB64u(ed25519.sign(canonicalBytes(body), pinPriv)) }
}

/** Verify a PIN session against the pinPub in the account's active PIN record. */
export function verifyPinSession(session: PinSession, pinPub: B64u): boolean {
  const parsed = zPinSessionBody.safeParse(session.body)
  if (!parsed.success) return false
  return verifySig(session.pinSig, canonicalBytes(session.body), pinPub)
}

/**
 * Root-signed authorization for an account with NO active PIN record. Same body
 * and same replay-binding as makePinSession; the root key signs instead of the
 * pinKey. Mirrors buildPinRecord's rootPriv/root agreement check so a caller can
 * never mint a session under a key the account does not own.
 */
export function makeRootSession(
  body: PinSessionBody,
  rootPriv: Uint8Array,
  root: B64u,
): RootSession {
  const parsed = zPinSessionBody.safeParse(body)
  if (!parsed.success) throw new Error(`makeRootSession: invalid body: ${parsed.error.issues[0]?.code}`)
  if (toB64u(ed25519.getPublicKey(rootPriv)) !== root)
    throw new Error('makeRootSession: rootPriv does not match root')
  if (body.root !== root) throw new Error('makeRootSession: body.root does not match root')
  return { body, rootSig: toB64u(ed25519.sign(canonicalBytes(body), rootPriv)) }
}

/**
 * Verify a root session against the account root pubkey. The root IS the
 * account identifier (LeaseBody.root / PresenceBody.root), so this needs no
 * lookup: the caller passes the same root the record binds to.
 */
export function verifyRootSession(session: RootSession, root: B64u): boolean {
  const parsed = zPinSessionBody.safeParse(session.body)
  if (!parsed.success) return false
  if (session.body.root !== root) return false
  return verifySig(session.rootSig, canonicalBytes(session.body), root)
}

// ===========================================================================
// 5. Committee handoff (spec §1): re-provision that carries the counter forward
// ===========================================================================

export interface HandoffAuth {
  root: B64u
  /** Previous 'pin' record id being replaced. */
  prevPinRecord: EventId
  /** New 'pin' record id being authorized. */
  newPinRecord: EventId
  /** Failure count carried forward. The new committee starts here, never below. */
  carriedFails: number
  /** pinKey-signed session, purpose 'committee-handoff'. */
  session: PinSession
  /** ≥ old-committee pinT signatures over the handoff body. */
  oldSigs: { w: NodeId; key: B64u; sig: B64u }[]
}

function handoffBody(root: B64u, prevPinRecord: EventId, newPinRecord: EventId, carriedFails: number): Uint8Array {
  return canonicalBytes({ root, prevPinRecord, newPinRecord, carriedFails, purpose: 'committee-handoff' })
}

/** An old committee member signs a handoff authorization. */
export function signHandoff(
  root: B64u,
  prevPinRecord: EventId,
  newPinRecord: EventId,
  carriedFails: number,
  w: NodeId,
  memberKey: B64u,
  priv: Uint8Array,
): { w: NodeId; key: B64u; sig: B64u } {
  if (toB64u(ed25519.getPublicKey(priv)) !== memberKey) throw new Error('signHandoff: priv does not match memberKey')
  return { w, key: memberKey, sig: toB64u(ed25519.sign(handoffBody(root, prevPinRecord, newPinRecord, carriedFails), priv)) }
}

export interface AuthorizeHandoffOpts {
  root: B64u
  prevPinRecord: EventId
  newPinRecord: EventId
  carriedFails: number
  session: PinSession
  oldSigs: { w: NodeId; key: B64u; sig: B64u }[]
}
export function authorizeHandoff(opts: AuthorizeHandoffOpts): HandoffAuth {
  return {
    root: opts.root,
    prevPinRecord: opts.prevPinRecord,
    newPinRecord: opts.newPinRecord,
    carriedFails: opts.carriedFails,
    session: opts.session,
    oldSigs: [...opts.oldSigs],
  }
}

export interface VerifyHandoffOpts {
  /** Old committee NodeIds (from the previous PIN record). */
  oldCommittee: readonly NodeId[]
  /** nodeId → each old member's advertised signing key (presence/certs). REQUIRED
   * and load-bearing: binds each handoff signer to its real key so one malicious
   * old member cannot forge the old-committee threshold by claiming peers' `w`s. */
  keyOf: ReadonlyMap<NodeId, B64u>
  /** pinPub from the OLD PIN record. The handoff must be signed by the same PIN key. */
  pinPub: B64u
  /** The new PIN record the handoff authorizes (its carriedFails is checked). */
  newRecord: SignedPinRecord
  /** The effective count at handoff time. The new record can never start below it. */
  minCarry: number
  params?: typeof PARAMS_A2
}

/**
 * Verify a handoff: (a) the pinKey session is valid and purpose 'committee-handoff';
 * (b) ≥ old pinT distinct old-committee members signed the handoff body;
 * (c) the new record's carriedFails == the authorized carriedFails AND is ≥ the
 * pre-handoff effective count, so a password thief cannot re-provision to nodes
 * he controls and reset the fuse to zero (spec §1). Pure.
 */
export function verifyHandoff(auth: HandoffAuth, opts: VerifyHandoffOpts): PinVerify {
  const params = opts.params ?? PARAMS_A2
  const errors: string[] = []

  // (a) PIN-key session gate: bound to THIS specific handoff (root + new record)
  // so a captured session can't be replayed to authorize a different re-provision.
  if (!verifyPinSession(auth.session, opts.pinPub)) errors.push('handoff: bad pinKey session signature')
  if (auth.session.body.purpose !== 'committee-handoff') errors.push('handoff: session purpose is not committee-handoff')
  if (auth.session.body.root !== auth.root) errors.push('handoff: session root mismatch')
  if (auth.session.body.record !== auth.newPinRecord) errors.push('handoff: session not bound to the new PIN record')

  // (b) old-committee threshold.
  const member = new Set(opts.oldCommittee)
  const msg = handoffBody(auth.root, auth.prevPinRecord, auth.newPinRecord, auth.carriedFails)
  const counted = new Set<NodeId>()
  const oldSigs = Array.isArray(auth.oldSigs) ? auth.oldSigs : [] // fail closed, never throw
  for (const s of oldSigs) {
    if (!member.has(s.w)) {
      errors.push(`handoff: signer ${s.w} not in old committee`)
      continue
    }
    if (counted.has(s.w)) continue
    const bound = opts.keyOf.get(s.w)
    if (bound === undefined) {
      errors.push(`handoff: signer ${s.w} has no advertised key binding`)
      continue
    }
    if (bound !== s.key) {
      errors.push(`handoff: signer ${s.w} key does not match its advertised key`)
      continue
    }
    if (!verifySig(s.sig, msg, bound)) {
      errors.push(`handoff: bad signature from ${s.w}`)
      continue
    }
    counted.add(s.w)
  }
  if (counted.size < params.pinT) errors.push(`handoff: only ${counted.size} old-committee signatures (need ${params.pinT})`)

  // (c) counter carried forward. Never below the pre-handoff count.
  if (auth.carriedFails < opts.minCarry) errors.push('handoff: carriedFails below pre-handoff effective count')
  const newCarried = opts.newRecord.payload.carriedFails ?? 0
  if (newCarried !== auth.carriedFails) errors.push('handoff: new record carriedFails != authorized carriedFails')
  if (newCarried < opts.minCarry) errors.push('handoff: new record resets the counter below the carried count')
  if (opts.newRecord.payload.prev !== auth.prevPinRecord) errors.push('handoff: new record does not link the previous PIN record')
  if (pinRecordId(opts.newRecord.payload) !== auth.newPinRecord) errors.push('handoff: authorized newPinRecord id mismatch')

  return errors.length ? { ok: false, errors: errors.sort() } : OK
}
