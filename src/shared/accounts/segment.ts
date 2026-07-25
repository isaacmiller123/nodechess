// A3 entanglement primitives (spec §3): the per-move signature chain, the
// transcript digest, the witness stream signatures, and the 'segment'
// witnessed-lane event builders/verifiers. ONE definition consumed by BOTH the
// storage layer (segments, pointers, reconstruction) and wire v6 (mpSession's
// signed move messages). The wire and the chain must agree on these bytes.
//
// Conventions are A1's: cjson-v1 canonical bytes, sha256 ids, ed25519
// signatures, base64url-no-pad strings. Pure + platform-neutral: no `node:`
// imports, no DOM globals, no ambient time or randomness.

import { z } from 'zod'
import { canonicalBytes, canonicalHash, type CanonicalObject } from './codec'
import { ed25519, toB64u, verifySigB64u } from './hash'
import { zB64u32, zCkptEvent, zSegmentPayload, eventId, verifyEventSig } from './events'
import { isRootSignedCert } from './certs'
import { PARAMS_A2 } from './witness/params'
import type { B64u, EventId, SignedEvent, WitnessAttestation } from './types'
import type {
  ProfileSnapshot,
  SegmentPayload,
  WitnessedResultBody,
  WitnessedResultRecord,
} from './storage/types'

// ---------------------------------------------------------------------------
// Game key: the value every per-move signature covers
// ---------------------------------------------------------------------------

/**
 * The GLOBAL game identifier signed into every move. Minted by the host at
 * game start; both players and the witness verify they hold the same key
 * before signing anything. Binding the players' ROOTS + a host nonce makes a
 * signature from one game unreplayable into any other (different roots or
 * nonce → different key → different signed bytes).
 */
export interface GameKeySeed extends CanonicalObject {
  v: 1
  t: 'game-key'
  /** Player roots by color. */
  w: B64u
  b: B64u
  /** Host-supplied 32-byte nonce, b64u (from the host's CSPRNG; injected). */
  nonce: B64u
  /** Host-claimed start time (unix ms). Informational, witness time rules. */
  ts: number
}

export function gameKey(seed: GameKeySeed): B64u {
  return toB64u(canonicalHash(seed))
}

// ---------------------------------------------------------------------------
// Per-move signature chain (§3 / wire v6)
// ---------------------------------------------------------------------------

/** One signed move: the mover signs (game, ply, move, clocks, prev move sig).
 * The RECEIVER's next move signs over this move's sig via `prev`. That is
 * the pairwise countersigning: neither side can alter or drop an interior
 * move without breaking the other's chain of signatures. */
export interface SignedMove extends CanonicalObject {
  ply: number
  /** Game-defined move codec (chess: UCI). Bounded 1..64 chars. */
  move: string
  /** Mover's clock snapshot AFTER the move, ms. */
  clockMs: { w: number; b: number }
  /** ed25519 by the mover's device key over moveSigBytes(...). */
  sig: B64u
}

/** The exact bytes a mover signs for ply `ply`. `prev` is the PREVIOUS ply's
 * sig. Absent only at ply 0. */
export function moveSigBytes(
  game: B64u,
  ply: number,
  move: string,
  clockMs: { w: number; b: number },
  prev?: B64u,
): Uint8Array {
  const body: CanonicalObject = {
    v: 1,
    t: 'mv',
    g: game,
    ply,
    move,
    clock: { w: clockMs.w, b: clockMs.b },
    ...(prev !== undefined ? { prev } : {}),
  }
  return canonicalBytes(body)
}

export function signMove(
  priv: Uint8Array,
  game: B64u,
  ply: number,
  move: string,
  clockMs: { w: number; b: number },
  prev?: B64u,
): SignedMove {
  const sig = toB64u(ed25519.sign(moveSigBytes(game, ply, move, clockMs, prev), priv))
  return { ply, move, clockMs: { w: clockMs.w, b: clockMs.b }, sig }
}

/**
 * Verify a full interleaved move chain. Mover alternation: ply 0 is
 * `firstMover` (chess: 'w'), parity alternates. Checks: contiguous plies from
 * 0, every signature verifies against the mover's key, every sig chains over
 * the previous sig. Returns the first failing ply, or -1 when the whole
 * chain verifies.
 */
export function verifyMoveChain(
  game: B64u,
  moves: readonly SignedMove[],
  keys: { w: B64u; b: B64u },
  firstMover: 'w' | 'b' = 'w',
): number {
  let prev: B64u | undefined
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    if (m.ply !== i) return i
    const mover = (i % 2 === 0) === (firstMover === 'w') ? 'w' : 'b'
    // Fail CLOSED like MoveChainVerifier.check: moveSigBytes → canonicalBytes
    // THROWS on an unencodable clock (non-safe integer, -0, NaN; the wire
    // clock schema is float-permissive), so an untrusted transcript (overlay /
    // A6 reconstruction) must reject the ply, never propagate a RangeError out
    // of this documented byte-deterministic verifier.
    let bytes: Uint8Array
    try {
      bytes = moveSigBytes(game, m.ply, m.move, m.clockMs, prev)
    } catch {
      return i
    }
    if (!verifySigB64u(m.sig, bytes, keys[mover])) return i
    prev = m.sig
  }
  return -1
}

// ---------------------------------------------------------------------------
// Transcript digest
// ---------------------------------------------------------------------------

/** The digest a segment event + witness stream bind: the FULL signed move
 * list plus the result. Deterministic bytes → one digest per game outcome. */
export function transcriptDigest(
  game: B64u,
  moves: readonly SignedMove[],
  result: '1-0' | '0-1' | '1/2-1/2',
  reason: string,
): B64u {
  const body: CanonicalObject = {
    v: 1,
    t: 'transcript',
    g: game,
    moves: moves.map((m) => ({
      ply: m.ply,
      move: m.move,
      clock: { w: m.clockMs.w, b: m.clockMs.b },
      sig: m.sig,
    })),
    result,
    reason,
  }
  return toB64u(canonicalHash(body))
}

// ---------------------------------------------------------------------------
// Witness stream (§3): countersigned clock stream + terminal signature
// ---------------------------------------------------------------------------

/** Bytes the witness signs periodically over the interleaved stream: the
 * latest countersigned ply + clocks, at the witness's own clock reading. */
export function witnessClockBytes(
  game: B64u,
  ply: number,
  clockMs: { w: number; b: number },
  wts: number,
): Uint8Array {
  return canonicalBytes({ v: 1, t: 'wclk', g: game, ply, clock: { w: clockMs.w, b: clockMs.b }, wts })
}

/**
 * A4 rated binding (§6) folded into the terminal witness signature: the
 * (kind, tc) pair naming which ladder the game rates in, plus. A4 review
 * fixes A4-01/A4-08: the player ROOTS by color and the termination reason.
 * OPTIONAL and field-wise: a field is covered only when present, and when ALL
 * are absent the signed bytes are EXACTLY the pre-A4 legacy shape
 * `{v:1, t:'wend', g, result, plies, transcript}` (byte-asserted in
 * scripts/test-mp-v6.mjs), so every existing signature stays valid.
 * The WITNESS is the authority for these values (it observes the session
 * config, the hellos/start identities, and the terminal it adjudicated):
 *  - kind/tc close ladder-lying (the author cannot pick a ladder the witness
 *    did not sign);
 *  - players closes color/opp-lying (A4-01: the witness signs result, and
 *    players binds WHICH root held which color, so a witnessed loss cannot be
 *    relabeled a win by flipping `color` or swapping `opp`);
 *  - reason closes reason-lying (A4-08: disconnect/abandon vs resign feeds
 *    the reputation misconduct axes and the 0.30-weight trust completion
 *    term: self-asserted before this binding).
 */
export interface RatedBinding {
  kind?: string
  tc?: { baseMs: number; incMs: number }
  /** Player account roots by color. */
  players?: { w: B64u; b: B64u }
  /** Termination reason (the same bounded string the transcript folds). */
  reason?: string
}

/** @deprecated Pre-review name: the binding now also covers players/reason. */
export type LadderBinding = RatedBinding

/** Terminal witness signature bytes: what SegmentPayload.wstream.sig covers.
 * `binding` absent (or ALL fields absent) ⇒ EXACT legacy bytes; each present
 * field is folded into the signed bytes (cjson-v1 sorted keys). */
export function witnessEndBytes(
  game: B64u,
  result: '1-0' | '0-1' | '1/2-1/2',
  plies: number,
  transcript: B64u,
  binding?: RatedBinding,
): Uint8Array {
  return canonicalBytes({
    v: 1,
    t: 'wend',
    g: game,
    result,
    plies,
    transcript,
    ...(binding?.kind !== undefined ? { kind: binding.kind } : {}),
    ...(binding?.tc !== undefined ? { tc: { baseMs: binding.tc.baseMs, incMs: binding.tc.incMs } } : {}),
    ...(binding?.players !== undefined ? { players: { w: binding.players.w, b: binding.players.b } } : {}),
    ...(binding?.reason !== undefined ? { reason: binding.reason } : {}),
  })
}

export function signWitnessEnd(
  wpriv: Uint8Array,
  wkey: B64u,
  game: B64u,
  result: '1-0' | '0-1' | '1/2-1/2',
  plies: number,
  transcript: B64u,
  binding?: RatedBinding,
): { wkey: B64u; sig: B64u } {
  return { wkey, sig: toB64u(ed25519.sign(witnessEndBytes(game, result, plies, transcript, binding), wpriv)) }
}

export function verifyWitnessEnd(
  wstream: { wkey: B64u; sig: B64u },
  game: B64u,
  result: '1-0' | '0-1' | '1/2-1/2',
  plies: number,
  transcript: B64u,
  binding?: RatedBinding,
): boolean {
  return verifySigB64u(wstream.sig, witnessEndBytes(game, result, plies, transcript, binding), wstream.wkey)
}

// ---------------------------------------------------------------------------
// Witnessed result record (§3 rage-quit denial)
// ---------------------------------------------------------------------------

export function makeWitnessedResult(
  wpriv: Uint8Array,
  wroot: B64u,
  wkey: B64u,
  // Spelled out (not Omit<WitnessedResultBody,'v'>): the CanonicalObject index
  // signature makes Omit collapse the named properties. kind/tc are the A4
  // ladder binding (LadderBinding): absent ⇒ EXACT legacy body bytes, so
  // pre-A4 records and their signatures stay valid.
  body: {
    game: B64u
    players: { w: B64u; b: B64u }
    result: '1-0' | '0-1' | '1/2-1/2'
    reason: string
    transcript: B64u
    plies: number
    wts: number
    kind?: string
    tc?: { baseMs: number; incMs: number }
  },
): WitnessedResultRecord {
  const full: WitnessedResultBody = { ...body, v: 1 }
  return {
    body: full,
    wroot,
    wkey,
    sig: toB64u(ed25519.sign(canonicalBytes(full as unknown as CanonicalObject), wpriv)),
  }
}

export function verifyWitnessedResult(rec: WitnessedResultRecord): boolean {
  if (rec.body.v !== 1) return false
  if (!zWitnessedResultBody.safeParse(rec.body).success) return false
  return verifySigB64u(rec.sig, canonicalBytes(rec.body as unknown as CanonicalObject), rec.wkey)
}

export const zResult = z.enum(['1-0', '0-1', '1/2-1/2'])

export const zWitnessedResultBody = z.strictObject({
  v: z.literal(1),
  game: zB64u32,
  players: z.strictObject({ w: zB64u32, b: zB64u32 }),
  result: zResult,
  reason: z.string().min(1).max(64),
  transcript: zB64u32,
  plies: z.int().min(0).max(4096),
  wts: z.int().min(0),
  // A4 ladder binding: same bounds as events.ts zSegmentPayload. Absent =
  // legacy/unrated; when present the record's signature covers them.
  kind: z.string().min(1).max(32).optional(),
  tc: z
    .strictObject({ baseMs: z.int().min(0).max(86_400_000), incMs: z.int().min(0).max(3_600_000) })
    .optional(),
})

// ---------------------------------------------------------------------------
// Segment payload builder + verifier
// ---------------------------------------------------------------------------

export interface MakeSegmentOpts {
  game: B64u
  opp: B64u
  color: 'w' | 'b'
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: string
  moves: readonly SignedMove[]
  heads: { w: { head: B64u; height: number }; b: { head: B64u; height: number } }
  wstream: { wkey: B64u; sig: B64u }
  oppCkpt?: SignedEvent
  /** A4 review fix (A4-02): cert events proving oppCkpt.body.key belongs to
   * `opp` when the embedded checkpoint is device-signed. */
  oppCerts?: SignedEvent[]
  oppProfile: ProfileSnapshot
  /** A4 ladder binding (§6). Both present on rated segments. */
  kind?: string
  tc?: { baseMs: number; incMs: number }
}

/** Build the SegmentPayload for THIS player's chain (the caller appends it
 * via appendWitnessed(chain, priv, key, 'segment', payload, ts)). */
export function makeSegmentPayload(o: MakeSegmentOpts): SegmentPayload {
  return {
    game: o.game,
    opp: o.opp,
    color: o.color,
    result: o.result,
    reason: o.reason,
    transcript: transcriptDigest(o.game, o.moves, o.result, o.reason),
    plies: o.moves.length,
    heads: o.heads,
    wstream: o.wstream,
    ...(o.oppCkpt !== undefined ? { oppCkpt: o.oppCkpt } : {}),
    ...(o.oppCerts !== undefined ? { oppCerts: o.oppCerts } : {}),
    oppProfile: o.oppProfile,
    ...(o.kind !== undefined ? { kind: o.kind } : {}),
    ...(o.tc !== undefined ? { tc: o.tc } : {}),
  }
}

export type SegmentVerifyError =
  | 'not-segment'
  | 'bad-payload'
  | 'bad-event-sig'
  | 'bad-wstream'
  | 'bad-ladder-binding'
  | 'opp-is-self'
  | 'bad-opp-ckpt'

/** ACCOUNTS-PARAMS §Witness fabric checkpoint diversity bound: cosigners must
 * span ≥ 3 distinct /16 key-space prefixes. Two b64u chars = the top 12 bits
 * of the signing key: the self-contained proxy for the fabric's nodeId
 * prefix bucket (a standalone verifier has no key→nodeId join to consult).
 * Exported: the read-time eligibility evidence layers (mm/trust.ts
 * trustEvidenceOf, ratings/reputation.ts repEvidenceOf, ratings/fold.ts
 * ratingEvidenceOf) re-apply the SAME bound to the roster-eligible cosigner
 * subset (A4-03/05/14, A4-02). */
export const OPP_CKPT_PREFIX_DIVERSITY_MIN = 3

/** ratings/fold.ts A4_FOLD_ID, restated locally. Importing fold.ts here
 * would close the cycle segment → fold → segment (same pattern as
 * attestationSigOk). Byte-equality with the fold id is asserted in
 * scripts/test-accounts-ratings.mjs. */
const A4_FOLD_ID_LOCAL = 'a4-v1'

/** ed25519 check of one WitnessAttestation over canonicalBytes({e, epoch, w,
 * wts}): the exact byte contract of witness/attest.ts attestBytes (types.ts
 * WitnessAttestation doc). Re-stated locally because importing witness/attest
 * here would close the cycle segment → attest → checkpoint → ratings/fold →
 * segment. Never throws (canonicalBytes can throw on malformed numbers). */
function attestationSigOk(att: WitnessAttestation, id: EventId): boolean {
  let msg: Uint8Array
  try {
    msg = canonicalBytes({ e: id, epoch: att.epoch, w: att.w, wts: att.wts })
  } catch {
    return false
  }
  return verifySigB64u(att.sig, msg, att.w)
}

/**
 * A4 review fix (A4-02, foundation for A4-05/06): verify the EMBEDDED opponent
 * checkpoint entirely from the segment payload: self-contained, fail-closed,
 * NO recursion into the opponent's chain.
 *
 * WHAT THIS CHECK IS, AND IS NOT (A4-02 completion, stated honestly): it
 * proves STRUCTURE and PROVENANCE (root-binding, signatures, ≥M distinct
 * prefix-diverse cosigners), which makes an embedded checkpoint expensive to
 * malform and root-bound to the named opponent. It CANNOT prove roster
 * ELIGIBILITY of those cosigners: a deterministic, standalone check has no
 * roster, and 4 fresh sybil keypairs with prefix-diverse key prefixes pass
 * every line below. That is why NO fold reads the checkpoint's asserted
 * numbers (ratings/fold.ts pins the §6 seeds for every opponent) and every
 * score-RAISING consumption of these cosigners happens at read time under
 * the verifier's own WitnessEligibility predicate (trustEvidenceOf,
 * repEvidenceOf, ratingEvidenceOf). This gate's role is (i) the fail-hard
 * embed discipline: an author who embeds an unverifiable checkpoint loses
 * the whole segment, and (ii) the shared structural floor the read-time
 * eligibility judgments build on.
 *
 * True only when ALL of:
 *
 *  (a) oppCkpt is a shape-valid witnessed-lane 'ckpt' event whose
 *      body.root === p.opp (the checkpoint is OF the named opponent; the
 *      A4-06 binding: a borrowed checkpoint of some other real account can
 *      never proxy for a differently-named opp);
 *  (b) its event signature verifies AND the signing key is authorized: either
 *      the opp root itself, or proven the opp's child by a root-signed cert
 *      event in p.oppCerts (certs.ts isRootSignedCert). BOUNDARY, stated
 *      honestly: a REVOKE of that device key lives on the opponent's chain and
 *      cannot be seen inline. A revoked-but-certified key still passes here.
 *      That window is closed by §6's one-level audit / fork-detection gossip,
 *      not by this standalone check;
 *  (c) ≥ PARAMS_A2.ckptM cosigner attestations ride in oppCkpt.wit, EVERY one
 *      carrying a valid signature over canonicalBytes({e: eventId(oppCkpt.body),
 *      epoch, w, wts}) under its own `w`, all `w` distinct, none equal to
 *      p.opp or `owner` (players may not cosign their own fold inputs; roots
 *      are the only player identity visible inline), spanning
 *      ≥ OPP_CKPT_PREFIX_DIVERSITY_MIN distinct 2-char b64u key prefixes (the
 *      §Witness-fabric /16 diversity bound). The wit list rides INSIDE the
 *      segment-owner-signed payload, so it is not relay-malleable here. The
 *      embedder curates it, and one malformed entry fails the whole check;
 *  (d) sanity on the self-claimed numbers other folds read: payload.through
 *      and body.height are safe integers ≥ 0;
 *  (e) FOLD-ID RULE (A4 review fix A4-10, verify side): on a RATED-SHAPED
 *      (kind/tc-bearing) segment the embedded state must self-describe as the
 *      a4-v1 fold (state.f === 'a4-v1'). A rated player's checkpoint IS
 *      a4-v1 (chain.ts / checkpoint.ts REQUIRE it once rated segments exist),
 *      so presenting a pre-rated basic-v1 checkpoint for a RATED opponent is
 *      never honest necessity. It was the seed-washing dial: ratings read
 *      seeds (1200/350) from a basic-v1 state while trust read a full
 *      established-opponent proxy from the same bytes. An opponent whose
 *      history is genuinely unrated is represented honestly by OMITTING
 *      oppCkpt (the §6 young-opponent seeds path). Unbound (legacy/casual)
 *      segments are out of §6 scope and keep accepting any state shape.
 *      A4-10 CLOSED (A7): when the caller supplies `attestedHeadHeight`. The
 *      pairing record's serving-witness attest of the opponent's current §4
 *      head height (witness/attest.ts PairingWitAttest, verified by the
 *      caller). This check bounds oppCkpt.payload.through against that
 *      witness-signed height: a checkpoint claiming to fold PAST the
 *      attested head is stale-or-fabricated and is refused. Without the
 *      param (legacy callers, no pairing attest) behavior is unchanged and
 *      the §2/§6 one-level audit remains the stale-state backstop.
 *
 * Returns false on ANY malformation. Never throws.
 */
export function verifyEmbeddedOppCkpt(
  p: SegmentPayload,
  owner?: B64u,
  attestedHeadHeight?: number,
): boolean {
  try {
    const c = p.oppCkpt
    if (c === undefined) return false
    // (a) shape (zCkptEvent is the recursion-bounded schema) + identity.
    if (!zCkptEvent.safeParse(c).success) return false
    if (c.body.type !== 'ckpt' || c.body.lane !== 'w' || c.body.root !== p.opp) return false
    // (e) fold-id rule (A4-10): rated-shaped segments may embed a4-v1
    // checkpoints ONLY (doc above). zCheckpointPayload guarantees `state` is
    // a plain object at runtime; the guard fails closed regardless.
    if (p.kind !== undefined || p.tc !== undefined) {
      const st = (c.body.payload as { state?: unknown }).state
      if (typeof st !== 'object' || st === null || Array.isArray(st)) return false
      if ((st as { f?: unknown }).f !== A4_FOLD_ID_LOCAL) return false
    }
    // (d) safe-int sanity on the numbers the folds consume.
    const through = (c.body.payload as { through: number }).through
    if (!Number.isSafeInteger(through) || through < 0) return false
    if (!Number.isSafeInteger(c.body.height) || c.body.height < 0) return false
    // (f) A4-10 freshness bound (A7): a witness-attested head height, when
    // supplied, caps how far the embedded checkpoint may claim to have
    // folded. Malformed bound ⇒ fail closed (refuse), never ignore.
    if (attestedHeadHeight !== undefined) {
      if (!Number.isSafeInteger(attestedHeadHeight) || attestedHeadHeight < 0) return false
      if (through > attestedHeadHeight) return false
    }
    // (b) event signature + signing-key authorization.
    if (!verifyEventSig(c)) return false
    if (c.body.key !== p.opp) {
      const certs = p.oppCerts
      if (certs === undefined || !certs.some((ce) => isRootSignedCert(p.opp, ce)?.pub === c.body.key))
        return false
    }
    // (c) M-of-N cosigner attestations, strict.
    const wit = c.wit
    if (wit === undefined || wit.length < PARAMS_A2.ckptM) return false
    const id = eventId(c.body)
    const cosigners = new Set<B64u>()
    const prefixes = new Set<string>()
    for (const att of wit) {
      if (att.w === p.opp || (owner !== undefined && att.w === owner)) return false
      if (cosigners.has(att.w)) return false
      if (!attestationSigOk(att, id)) return false
      cosigners.add(att.w)
      prefixes.add(att.w.slice(0, 2))
    }
    if (cosigners.size < PARAMS_A2.ckptM) return false
    if (prefixes.size < OPP_CKPT_PREFIX_DIVERSITY_MIN) return false
    return true
  } catch {
    return false
  }
}

/**
 * Verify what a segment event can prove ABOUT ITSELF, with no chain context:
 * the event signature, the witness terminal signature over (game, result,
 * plies, transcript, plus kind/tc/players/reason when the segment is
 * rated-shaped: the A4 rated binding), opp ≠ owner, and (when present) the
 * full verifyEmbeddedOppCkpt check on the embedded opponent checkpoint.
 * Chain-context rules (linkage, cert of the signing key, attestations) are
 * verifyChain's / the witness layer's job, not duplicated here.
 */
export function verifySegmentEvent(ev: SignedEvent): SegmentVerifyError | null {
  if (ev.body.type !== 'segment' || ev.body.lane !== 'w') return 'not-segment'
  // Fail CLOSED on a malformed payload (the module invariant; see
  // verifyEventSig / verifyWitnessedResult): a valid ed25519 signature over a
  // shape-invalid payload must return a typed error, never throw. This is the
  // designated standalone entry point for untrusted, overlay-delivered segment
  // events (brick 4/5 feed it PointerProof.event), so the shape gate precedes
  // every field dereference below. The try/catch is a backstop: zSegmentPayload
  // is now bounded-depth (oppCkpt = zCkptEvent, non-recursive), but a deeply
  // nested value smuggled through a ckpt's free-form `state` could still
  // overflow the codec stack in a later verify. A RangeError here must still
  // read as 'bad-payload', never propagate.
  try {
    if (!zSegmentPayload.safeParse(ev.body.payload).success) return 'bad-payload'
  } catch {
    return 'bad-payload'
  }
  if (!verifyEventSig(ev)) return 'bad-event-sig'
  const p = ev.body.payload as unknown as SegmentPayload
  if (p.opp === ev.body.root) return 'opp-is-self'
  // A4 rated binding (§6, review fixes A4-01/A4-08): a kind/tc-bearing
  // (rated-shaped) segment is valid ONLY if the witness terminal signature
  // covers end-bytes including kind, tc, players AND reason. The binding is
  // ATOMIC: rated ⇔ fully bound. `players` is derived from the payload's own
  // (root, opp, color), so the witness's signature simultaneously enforces
  // players[p.color] === ev.body.root and players[other] === p.opp. A
  // flipped color, a swapped opp, a relabeled reason, a value mismatch, a
  // half-binding, or a legacy (partial) wstream sig on a rated-shaped segment
  // all fail here as 'bad-ladder-binding'. Segments without kind/tc verify
  // over the EXACT legacy bytes and keep the 'bad-wstream' taxonomy: pre-A4
  // behavior byte-for-byte.
  const bound = p.kind !== undefined || p.tc !== undefined
  const players =
    p.color === 'w' ? { w: ev.body.root, b: p.opp } : { w: p.opp, b: ev.body.root }
  if (
    !verifyWitnessEnd(
      { wkey: p.wstream.wkey, sig: p.wstream.sig },
      p.game,
      p.result,
      p.plies,
      p.transcript,
      bound ? { kind: p.kind, tc: p.tc, players, reason: p.reason } : undefined,
    )
  )
    return bound ? 'bad-ladder-binding' : 'bad-wstream'
  // A4 review fix (A4-02): a PRESENT oppCkpt must pass the full embedded-
  // checkpoint check. Fail-HARD (the segment, not just the checkpoint) rather
  // than fail-to-seeds: the segment AUTHOR chose to embed it. Letting an
  // unverifiable checkpoint silently downgrade to 1200/350 seeds would give a
  // forger a free retry surface (embed garbage, keep the game, hide the
  // attempt) and hide real fraud from every verifier. An honest author embeds
  // either a verifiable cosigned checkpoint or nothing.
  if (p.oppCkpt !== undefined && !verifyEmbeddedOppCkpt(p, ev.body.root)) return 'bad-opp-ckpt'
  return null
}

/** The id a pointer names when it points at this segment. */
export function segmentEventId(ev: SignedEvent): EventId {
  return eventId(ev.body)
}
