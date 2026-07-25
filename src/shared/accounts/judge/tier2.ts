// A5 J4. Tier-2 (spec §8): salted K-window partition (§7b commit-reveal),
// Regan-style window aggregation, the DETERMINISTIC escalation trigger,
// signed/reproducible verdict + suppression records, and the self-ban
// helpers. Platform-neutral: no `node:` imports, no DOM, no ambient time or
// randomness. INTEGER/MICRO MATH ONLY. Every division below is floor
// division (Math.floor semantics, divisor always a positive integer, floor
// toward −∞ for negative numerators); no transcendentals (the one square
// root is an EXACT integer sqrt with a verification-adjust loop; Math.sqrt
// is used only as a correctly-rounded IEEE-754 seed, then adjusted to the
// exact floor, so the result is bit-identical on every platform).
//
// ARCHITECTURAL RULE (lead-decided): the escalation trigger and verdicts are
// pure functions of the chain GIVEN the judge engine, computable and
// reproducible by anyone holding (chain bytes, Tier1Records, salt reveals),
// but NOT computable inside a synchronous fold step (folds cannot run
// engines). Consequences, mirrored across the codebase:
//   (a) the a4-v1 fold's `bans` state folds ONLY in-chain 'selfban' events
//       (ratings/fold.ts), never a trigger evaluation;
//   (b) suppression (CONVICTION fired on-chain per A5-21, the 5σ line, with
//       no timely selfban) is
//       established by an engine-holding auditor producing a signed,
//       reproducible SUPPRESSION record published to shard space, a
//       read-time fact like witness/pin.ts fuse records, consumed by
//       pairingLegal/displayState as INJECTED EVIDENCE, never folded;
//   (c) every function in this module is deterministic given
//       (chain bytes, Tier1Records, salt reveals).
//
// ─── COMMIT-REVEAL WINDOW SALT (§7b, PARAMS_A5.saltScheme =
//     'lease-threshold-v1'): EXACT DERIVATION ──────────────────────────────
// The threshold-signature material is the T_lease-signed (root ‖ ladder ‖
// windowIndex) tuple, using witness/lease.ts's EXACT threshold-signature byte
// conventions (grantBytes / LeaseGrant, nothing reimplemented):
//   saltBody      = {v:1, t:'cs:a5:t2salt:v1', scheme:'lease-threshold-v1',
//                    root, ladder, window[, anchor]}   (anchor: the OPTIONAL
//                    A5-17 post-game commitment; see UNPREDICTABLE BEFORE)
//   saltBodyHash  = b64u(sha256(canonicalBytes(saltBody)))
//   one grant     = LeaseGrant {w, key, wts, sig} with
//                   sig = ed25519_key( grantBytes(saltBodyHash, w, wts) )
//                       = ed25519_key( canonicalBytes({body: saltBodyHash,
//                                                      w, wts}) )
//   saltRevealBytes(reveal) = concat of the RAW 64 sig bytes of the PINNED
//                   grant subset (A5-18), in fixed ascending-w order (codec
//                   compareKeys byte order). A grant is COUNTED when its
//                   signature verifies under g.key over grantBytes(
//                   saltBodyHash, g.w, g.wts), one grant per distinct w
//                   (duplicates: the lexicographically smallest sig b64u wins).
//                   The PINNED subset of the counted grants is:
//                     · WITH a canonical witnessSet, the FULL CANONICAL
//                       THRESHOLD SET: the `threshold` smallest-NodeId members
//                       of the witness set. The reveal MUST carry a valid grant
//                       from EVERY one of them (else the subset is not pinnable
//                       and the reveal is rejected); grants from the remaining
//                       larger-NodeId witnesses are legal availability
//                       redundancy but NEVER enter the salt.
//                     · WITHOUT a witnessSet, all ≥ threshold counted grants
//                       (legacy, reveal-defined; see UNIQUE below).
//   windowSalt    = sha256(saltRevealBytes)
// UNIQUE / NO POST-HOC GRIND (A5-18): with the canonical witnessSet supplied,
// windowSalt is a UNIQUE function of (root, ladder, window, witnessSet). The
// pinned subset is fixed BY THE WITNESS SET, never chosen by the reveal
// assembler. So a publisher holding MORE than threshold grants cannot slide
// off(w)/b(w) post-hoc (§7b anti-surf), and two honest auditors holding
// DIFFERENT reveals (any superset of the pinned set) derive the SAME salt → the
// SAME closed-window partition → the same z_w and J7 lifetimeVerdict. Deriving
// the canonical witness set needs a directory snapshot and is the embedder's
// (same deliberate thinness as storage/pointers.ts duty checks); the CONSENSUS/
// verdict path MUST supply witnessSet. WITHOUT it the canonical set is unknown,
// so the salt stays reveal-defined (all counted grants) and is NOT grind-proof.
// It is a diagnostic/legacy path only (individual ed25519 grants have no unique
// threshold aggregate absent the pinning set).
// UNPREDICTABLE BEFORE (§7b, A5-17): each pinned sig is a deterministic
// ed25519 output of a WITNESS private key, so the SUBJECT (lacking the private
// keys) cannot compute the salt. But ed25519 IS deterministic and the tuple
// above is fixed at account creation, so a WITNESS, or anyone it hands early
// grants to, could precompute EVERY future window's salt at t=0, leaving
// "unpredictable before the games are played" resting entirely on unenforced
// witness signing-time discipline. The OPTIONAL post-game `anchor` closes the
// in-lane half: when supplied (SaltVerifyOpts.requireAnchor gates it ON for the
// consensus/verdict path) it is a 32-byte commitment to chain state fixed only
// AFTER the games preceding boundary b(w) are played. The embedder binds the
// rated-game key at ordinal w·K−1 (the LATEST ordinal guaranteed < b(w) for
// every off(w) ∈ [0,K), so non-circular and recomputable-after), or a digest
// over ordinals [0, w·K). It is folded into saltBody, hence into every grant's
// signed bytes, so the message a witness signs for window w LITERALLY DOES NOT
// EXIST until that game is chained: an honest witness (signing only over chain
// state it has observed) cannot form or pre-sign it, and any post-hoc swap of
// the anchor invalidates every grant. RECOMPUTABLE AFTER: the published
// SaltReveal carries {grants, anchor}; anyone re-verifies every signature and
// re-derives the identical salt (the anchor value's tie to the true chain
// ordinal is the auditor's chain-bytes duty, the same deliberate thinness as
// the witnessSet). RESIDUAL (A5-17, DEFERRED, cross-lane): FULL soundness
// still needs witness-node SIGNING-TIME discipline (refuse to sign window w
// until ordinal w·K−1 is observed on-chain; set wts to the window-close
// witnessed time, §4) and the embedder wiring that derives + supplies the
// anchor from the chain, witness-side behavior + a directory snapshot, not
// enforceable in this platform-neutral core. Absent it a malicious witness can
// still pre-sign, but only by signing over a chain anchor it has NOT verified.
// That is a narrower, attributable fault than signing a t=0-static tuple.
//
// ─── BOUNDARY JITTER (the salted partition) ────────────────────────────────
// A ladder's rated games are numbered by ORDINAL 0,1,2,… in witnessed chain
// order (the chain-derived rated-game list; fold.ts's rated gate defines
// membership). With K = PARAMS_A5.reganK:
//   off(w)   = u32be(windowSalt(w) bytes 0..3) mod K          (in [0, K))
//              (modulo bias ≤ K/2^32 ≈ 7e-9: negligible, deterministic)
//   b(0)     = 0
//   b(w)     = w·K + off(w)                                    for w ≥ 1
//   window w = ordinals [b(w), b(w+1))
// Since off ∈ [0, K): b(w) ∈ [wK, (w+1)K) and b(w+1) ≥ (w+1)K > b(w). The
// windows are non-empty, non-overlapping, contiguous and exhaustive, each
// boundary jittered by an unpredictable offset within [0, K); window sizes
// lie in [1, 2K−1] with mean K. With the post-game `anchor` bound into the
// salt (above, A5-17) plus its deferred witness signing-time residual, a
// metering cheater cannot know, before the games approaching the boundary are
// played, WHICH game closes a window (§7b: the frontier stops being a
// targetable line), while after reveal the partition is exactly
// recomputable. NOTE the deterministic TRIGGER below is trailing-K (fixed
// geometry, every compliant client must agree without any reveal); the
// salted windows are the Tier-2 VERDICT unit.
//
// ─── REGAN-STYLE WINDOW STATISTIC (exact estimator) ────────────────────────
// Inputs per game: the accused's Tier1Side s = rec[side], and elo, the
// accused's chain-derived strength estimate ENTERING the game (the a4-v1
// fold's ladder display rating, floor(r/1e6), before that game rates;
// a pure function of chain bytes). OPTIONALLY rdMicro, the SAME fold's
// rating deviation (RD) entering the game, micro-Elo (ladder state `rd`,
// equally chain-derived). When present, anchor expectations are evaluated
// at the UPPER-CONFIDENCE strength
//   effElo = elo + floor(RD_CONF_MUL · rdMicro / 1e6)
// (A5-02 fix: the display rating LAGS true strength exactly while RD is
// still large (fresh/placement/fast-improving accounts), so scoring the
// point estimate there stamps the SAME positive deviation on every honest
// game of the window; √n aggregation then escalates honest play. A high-RD
// account is EXPECTED to be up to RD_CONF_MUL·RD stronger than displayed,
// which shrinks the deviation toward honest; a settled account, RD floored
// ≈ 30, shifts ≤ ~60 Elo. The calibrated FPR is preserved.) rdMicro
// ABSENT ⇒ effElo = elo: byte-identical to the legacy point-estimate path.
// Anchor expectations come from an
// injected Tier2Anchors (Tier1Anchors ACPL curve + engine-match curve). The
// MEASURED judge-config bundle is anchors.ts TIER2_ANCHORS_JUDGE (J6
// calibration corpus), the only set that may feed T; this module keeps
// anchors injected so receipts can re-verify historic verdicts under the
// exact bundle they were computed with.
//   A game is SCORED iff s.scored ≥ 1 (J2 contract: a 0-sample ACPL is not
//   strength evidence. Such games contribute NOTHING and do not count in
//   n_eff).
//   devAcplMicro  = floor( (expectedAcplMicro(anchors.acpl, elo)
//                           − s.acplMicro) · 1e6 / anchors.acpl.sigmaAcplMicro )
//   devMatchMicro = floor( (s.matchMicro
//                           − expectedMatchMicro(anchors, elo)) · 1e6
//                          / anchors.sigmaMatchMicro )
//   devMicro      = clamp( floor((devAcplMicro + devMatchMicro) / 2),
//                          −PER_GAME_DEV_CAP_MICRO, +PER_GAME_DEV_CAP_MICRO )
//   (positive = better-than-expected = the suspicious direction; the two
//   terms are averaged, then the per-game contribution is HARD-CAPPED at
//   ±3σ; see NO-SINGLE-GAME rule.)
//   sumDev = Σ devMicro over scored games;  n_eff = scored-game count
//   zMicro = n_eff = 0 ? 0
//          : floor( sumDev · 1000 / isqrt(n_eff · 1_000_000) )
//   (isqrt(n·1e6) = floor(1000·√n) exactly; the quotient floors toward −∞.)
// OVERFLOW AUDIT (all intermediates < 2^53): |expected − acpl| ≤ 2e9
// (MAX_CPL_MICRO cap) → ·1e6 ≤ 2e15; match diff ≤ 1e6 → ·1e6 ≤ 1e12;
// |sumDev| ≤ 59·3e6 < 1.8e8 → ·1000 < 1.8e11.
// NO SINGLE GAME CONVICTS (§8). STRUCTURAL: with the ±3e6 per-game cap,
// zMicro ≤ 3e6·√n_eff, so n_eff = 1 peaks at 3.0 and n_eff = 2 at ≈ 4.24,
// both below zThresholdMicro (5.0). Conviction is arithmetically impossible
// on fewer than 3 scored games, however blatant. (A 1-game window CAN meet
// the 3.0 escalation trigger. Escalation only obliges deeper analysis,
// NEVER the §8 self-ban: the ban obligation anchors on the 5σ conviction
// (A5-21), so no single game can ever oblige a ban either.)
//
// ─── CROSS-WINDOW LIFETIME ACCUMULATION (J7: PARAMS_A5.lifetimeScheme =
//     'z-sum-over-sqrt-windows-v1') ─────────────────────────────────────────
// Regan-style evidence accumulates ACROSS a ladder's CLOSED salted windows,
// closing the §7(a) empty-margin gap J6 measured (metering just under the
// per-window escalation line, ≈2.6σ/window, was a bounded-but-real inflation
// channel; sustained metering must eventually convict). Over the ladder's
// closed windows w = 0..W−1, in chain order, with z_w each window's zMicro:
//   zLifeMicro(W) = floor( (Σ z_w) · 1000 / isqrt(W · 1_000_000) )
// This is the EXACT same isqrt normalization the per-window statistic applies to
// per-game deviations (isqrt(W·1e6) = floor(1000·√W); floor toward −∞).
// NULL DISTRIBUTION: each window z is (by the per-window construction) the
// isqrt-normalized sum of ~N(0,1) per-game deviations, so z_w ~ N(0,1) under
// the null; Σ z_w / √W over W independent windows is again ~N(0,1). Hence the
// SAME thresholds apply: zEscalateMicro / zThresholdMicro, no new dials.
// MULTIPLE EVALUATION: z_life is evaluated at EVERY window close (the trigger
// must be a pure chain condition, not a one-shot), so a lifetime of W windows
// is W looks at a 5σ statistic. The 5σ conviction threshold absorbs this by
// construction (§8 "astronomically-low false-positive thresholds"): per-look
// FPR ≈ 2.9e-7, so even 10^4 closed windows (300k rated games) keep the
// union-bounded lifetime FPR under 3e-3 of ONE conviction, and the 3σ
// escalation looks only oblige deeper analysis, never convict. Cancellation
// is real and intended: honest (mean-zero) windows keep Σ z_w near 0, so
// z_life does not drift with W; sustained metering at c·σ/window grows as
// c·√W and crosses ANY threshold eventually (≈2.6σ/window: escalation at
// W≈2, conviction at W≈4, the closure).
//
// ─── THE DETERMINISTIC ESCALATION TRIGGER (§8) ─────────────────────────────
// escalationDue evaluates, at every chain point i ≥ K−1 of the ladder's
// rated-game list, the aggregate zMicro over the TRAILING K games
// [i−K+1, i]; the trigger fires at the EARLIEST i where zMicro ≥
// PARAMS_A5.zEscalateMicro. This is the protocol-defined pure condition
// every compliant client can evaluate, but evaluating it REQUIRES the
// judge's outputs (Tier1Records are derived from engine analysis), so the
// obligation binds the client that has judged its own games: §8 Tier-1 runs
// on EVERY rated game, so on the compliant path the records exist by
// construction. A missing record therefore fails CLOSED (throw): the
// evaluation is only defined over judged games, and "I didn't judge" is
// itself non-compliance, never an excuse.
// A5-21 (OWNER DECISION 2026-07-22, "an honest player is never banned"):
// the 3σ escalation obliges ONLY the deeper Tier-2 analysis; the §8
// SELF-BAN / SUPPRESSION obligation anchors on the 5σ CONVICTION condition
// (zThresholdMicro; per-look FPR ≈ 2.9e-7, union-bounded < 3e-3 over 10^4
// windows). Gating the ban at 3σ carries ≈1.35e-3/window one-sided FPR.
// An honest 1k/3k/10k-game career eventually owes a false 90-day self-ban
// with probability ≈22.9%/57.9%/93.5%, i.e. the false-fraud §0 forbids.
// Suppression is provable ONLY relative to that deterministic conviction
// (§8), never relative to an arbitrary third-party Tier-2 run, and never
// relative to mere escalation.
//
// ─── VERDICT / SUPPRESSION RECORDS + SELF-BAN ──────────────────────────────
// Tier2VerdictBody is a cjson-v1 value; its canonicalHash digest is what a
// SelfBanPayload.verdict references. Records are signed commend-pattern
// (ratings/conduct.ts): any key works, whether the signer's root or a child key
// proven by inline ROOT-signed cert events (certs.ts isRootSignedCert); certs MUST
// be absent when key === signer. verifyTier2Verdict is a full
// recompute-from-inputs receipt: same (Tier1Records, sides, elos, anchors)
// ⇒ the same zMicro bits, or the record is rejected. The suppression
// variant {kind:'suppression', deadlineEvent} asserts the CONVICTION fired
// at the window-completing game (A5-21: the 5σ line, never mere
// escalation) and NO selfban followed before deadlineEvent (the first
// witnessed-lane event appended after that game); the chain-side absence
// scan is the auditor's, against chain bytes.
// PUBLISHING (thin, per the fuse-record/pointers pattern): records live in
// shard space under the ACCUSED's key at tier2VerdictKey(root); the actual
// overlay publish/store-gate/merge is embedder work (A3 storage), exactly
// like fuse records, a read-time fact injected into pairingLegal/display,
// never folded.

import { z } from 'zod'
import { isRootSignedCert } from '../certs'
import {
  canonicalBytes,
  canonicalHash,
  compareKeys,
  type CanonicalObject,
  type CanonicalValue,
} from '../codec'
import { zB64u32, zB64u64, zSelfBanPayload } from '../events'
import { concatBytes, ed25519, fromB64u, sha256, toB64u, utf8, verifySigB64u } from '../hash'
import type { B64u, EventId, SelfBanPayload, SignedEvent } from '../types'
import { nodeIdOf } from '../witness/distance'
import { grantBytes, verifyGrantSig } from '../witness/lease'
import { PARAMS_A2 } from '../witness/params'
import type { LeaseGrant, NodeId } from '../witness/types'
import { PARAMS_A5, PARAMS_A5_DIGEST } from './params'
import {
  expectedAcplMicro,
  MAX_CPL_MICRO,
  tier1Digest,
  type Side,
  type Tier1Anchors,
  type Tier1Record,
  type Tier1Side,
} from './tier1'

// ---------------------------------------------------------------------------
// Errors + constants
// ---------------------------------------------------------------------------

/** Malformed Tier-2 input. Fail-closed: builders/derivations throw this;
 * verifiers never throw (typed verdicts). */
export class Tier2InputError extends Error {
  override readonly name = 'Tier2InputError'
}

const MS_PER_DAY = 86_400_000

/** Per-game deviation hard cap, micro-σ (±3σ). THE no-single-game-convicts
 * rule, structurally: zMicro ≤ 3e6·√n_eff, so < 3 scored games can never
 * reach zThresholdMicro (header). [A5-CALIBRATED] via PARAMS_A5 thresholds. */
export const PER_GAME_DEV_CAP_MICRO = 3_000_000

/** Max entries one window aggregation accepts (salted windows are ≤ 2K−1;
 * keeps every product a small safe integer). */
export const WINDOW_ENTRIES_MAX = 2 * PARAMS_A5.reganK - 1

/** Domain separator of the salt body, fixed forever (like POINTER_KEY_TAG:
 * the derivation is structural; everything revisable rides PARAMS_A5). */
export const SALT_BODY_TAG = 'cs:a5:t2salt:v1'

/** Domain separator of the verdict shard-space key, fixed forever. */
const VERDICT_KEY_TAG = 'cs:a5:t2verdict-key:v1'

const bad = (msg: string): never => {
  throw new Tier2InputError(msg)
}

/** Non-negative safe integer (rejects -0). */
function isNonNegInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0)
}

/** Floor division toward −∞; den must be a positive integer. */
function idiv(num: number, den: number): number {
  return Math.floor(num / den)
}

/** EXACT integer square root: floor(√n) for a non-negative safe integer.
 * Math.sqrt is only a correctly-rounded seed; the adjust loops make the
 * result exact (hence bit-identical) on every platform. */
export function isqrt(n: number): number {
  if (!isNonNegInt(n)) bad(`isqrt: not a non-negative safe integer: ${String(n)}`)
  let r = Math.floor(Math.sqrt(n))
  while ((r + 1) * (r + 1) <= n) r++
  while (r * r > n) r--
  return r
}

// ---------------------------------------------------------------------------
// Commit-reveal window salt (§7b); see header for the exact derivation
// ---------------------------------------------------------------------------

/** The published reveal: the grant set that DEFINES window w's salt. */
export interface SaltReveal {
  v: 1
  /** PARAMS_A5.saltScheme: 'lease-threshold-v1'. */
  scheme: string
  /** Accused/subject account root. */
  root: B64u
  ladder: string
  /** Window index the salt perturbs. */
  window: number
  /** OPTIONAL (A5-17) post-game commitment binding the salt to chain state
   * fixed only AFTER the games preceding boundary b(w) are played: a 32-byte
   * b64u the embedder derives from the rated-game key at ordinal w·K−1 (or a
   * digest over ordinals [0, w·K)). Folded into saltBody so it is unforgeable
   * (a swap invalidates every grant) and makes windowSalt(w) uncomputable
   * before that game is chained, the §7b unpredictable-before property. Absent
   * ⇒ the legacy path (predictable-before, diagnostic only); SaltVerifyOpts
   * .requireAnchor rejects an anchorless reveal on the consensus/verdict path. */
  anchor?: B64u
  /** T_lease threshold-signature grants (witness/lease.ts LeaseGrant bytes). */
  grants: readonly LeaseGrant[]
}

const zSaltGrant = z.strictObject({
  w: zB64u32,
  key: zB64u32,
  wts: z.int().min(0),
  sig: zB64u64,
})

/** Exported for the A7 canonical-reveal publication slot (judge/transport.ts
 * saltRevealKey gate). The schema stays the single shape authority. */
export const zSaltReveal = z.strictObject({
  v: z.literal(1),
  scheme: z.literal(PARAMS_A5.saltScheme),
  root: zB64u32,
  ladder: z.string().min(1).max(64),
  window: z.int().min(0),
  anchor: zB64u32.optional(),
  grants: z.array(zSaltGrant).min(1).max(64),
})

/** b64u(sha256(canonicalBytes(saltBody))): what each grantor signs over
 * (via lease.ts grantBytes, the exact lease threshold-sig convention). A5-17:
 * an OPTIONAL post-game `anchor` (32-byte b64u) is folded in when present, so
 * the signed body, hence windowSalt(w), commits to chain state fixed only
 * after the games preceding b(w) are played (header: UNPREDICTABLE BEFORE).
 * Absent ⇒ byte-identical to the pre-A5-17 legacy body (goldens unchanged). */
export function saltBodyHash(root: B64u, ladder: string, windowIndex: number, anchor?: B64u): B64u {
  if (typeof root !== 'string' || root.length !== 43) bad('saltBodyHash: root must be a 32-byte b64u')
  if (typeof ladder !== 'string' || ladder.length === 0 || ladder.length > 64)
    bad('saltBodyHash: ladder must be a 1..64-char string')
  if (!isNonNegInt(windowIndex)) bad('saltBodyHash: windowIndex must be a non-negative safe integer')
  if (anchor !== undefined && (typeof anchor !== 'string' || anchor.length !== 43))
    bad('saltBodyHash: anchor, when present, must be a 32-byte b64u commitment')
  return toB64u(
    canonicalHash({
      v: 1,
      t: SALT_BODY_TAG,
      scheme: PARAMS_A5.saltScheme,
      root,
      ladder,
      window: windowIndex,
      ...(anchor !== undefined ? { anchor } : {}),
    }),
  )
}

/** One witness signs the salt tuple, byte-identical to a lease grant over
 * saltBodyHash (grantBytes convention). Builder: throws on misuse. */
export function signSaltGrant(
  root: B64u,
  ladder: string,
  windowIndex: number,
  w: NodeId,
  key: B64u,
  priv: Uint8Array,
  wts: number,
  anchor?: B64u,
): LeaseGrant {
  if (toB64u(ed25519.getPublicKey(priv)) !== key) bad('signSaltGrant: priv does not match key')
  if (!isNonNegInt(wts)) bad('signSaltGrant: wts must be a non-negative safe integer')
  const sig = toB64u(ed25519.sign(grantBytes(saltBodyHash(root, ladder, windowIndex, anchor), w, wts), priv))
  return { w, key, wts, sig }
}

export interface SaltVerifyOpts {
  /** Grant threshold; default PARAMS_A2.tLease. With a witnessSet the
   * effective threshold is max(1, min(tLease, |witnessSet|)), lease.ts's
   * small-population rule. */
  tLease?: number
  /** Optional canonical witness set: grants from outside it never count, AND
   * (A5-18) it PINS the salt: the reveal must carry the `threshold`
   * smallest-NodeId members of this set (the full canonical threshold set) and
   * the salt is derived from exactly those, so no supra-threshold subset choice
   * can grind the boundary. Deriving the set needs a directory snapshot,
   * embedder context (same thinness as storage/pointers.ts duty checks); the
   * consensus/verdict path MUST supply it for a unique, grind-proof salt. */
  witnessSet?: readonly NodeId[]
  /** A5-17: when true, a reveal WITHOUT a post-game `anchor` is REJECTED. The
   * consensus/verdict path sets this so windowSalt(w) provably commits to chain
   * state fixed only after the games preceding b(w) are played (§7b
   * unpredictable-before). Default false keeps the legacy/diagnostic path
   * (predictable-before). Orthogonal to witnessSet: a consensus reveal sets
   * both (grind-proof AND unpredictable-before). */
  requireAnchor?: boolean
}

export interface SaltVerify {
  ok: boolean
  /** Deterministic, sorted error strings (lease.ts convention). */
  errors: string[]
  /** Present iff ok: b64u(windowSalt). */
  salt?: B64u
}

/** The PINNED grant subset of a reveal (A5-18): counted = verified, in-set,
 * deduped (smallest sig b64u per w); then, WITH a witnessSet, pinned to the
 * FULL CANONICAL THRESHOLD SET (the `threshold` smallest-NodeId members of the
 * set, fixed order) so the salt is a UNIQUE function of (root, ladder, window,
 * witnessSet) and no supra-threshold subset choice can grind the boundary;
 * WITHOUT a witnessSet the canonical set is unknown, so it falls back to all
 * counted grants (reveal-defined, see header). Internal to derivation + verifier. */
function countedGrants(reveal: SaltReveal, opts: SaltVerifyOpts): { grants: LeaseGrant[]; errors: string[] } {
  const errors: string[] = []
  // A5-17: the consensus/verdict path pins requireAnchor so no anchorless
  // (predictable-before) salt is ever blessed. The anchor is folded into
  // bodyHash below, so it also binds every grant's signature (a post-hoc swap
  // makes every verifyGrantSig fail, so the binding is unforgeable).
  if (opts.requireAnchor === true && reveal.anchor === undefined)
    errors.push('salt: requireAnchor set but the reveal carries no post-game anchor (§7b unpredictable-before)')
  const bodyHash = saltBodyHash(reveal.root, reveal.ladder, reveal.window, reveal.anchor)
  const inSet = opts.witnessSet === undefined ? null : new Set(opts.witnessSet)
  const byW = new Map<NodeId, LeaseGrant>()
  for (const g of reveal.grants) {
    if (inSet !== null && !inSet.has(g.w)) {
      errors.push(`salt: grantor ${g.w} not in the supplied witness set`)
      continue
    }
    if (!verifyGrantSig(g, bodyHash)) {
      errors.push(`salt: bad grant signature from ${g.w}`)
      continue
    }
    const prev = byW.get(g.w)
    if (prev === undefined || compareKeys(g.sig, prev.sig) < 0) byW.set(g.w, g)
  }
  const tLease = opts.tLease ?? PARAMS_A2.tLease
  const threshold =
    inSet === null ? tLease : Math.max(1, Math.min(tLease, (opts.witnessSet as readonly NodeId[]).length))
  if (byW.size < threshold) errors.push(`salt: only ${byW.size} valid grantors (need ${threshold})`)
  const sortedCounted = [...byW.values()].sort((a, b) => compareKeys(a.w, b.w))
  // A5-18: PIN THE SALT to a canonical subset so the reveal assembler cannot
  // grind off(w)/b(w) post-hoc and two honest auditors agree. With the
  // canonical witnessSet, the salt is derived from the `threshold` smallest-
  // NodeId members of the set (the full canonical threshold set, fixed order):
  // the reveal must carry a valid grant from EVERY one of them, and grants from
  // the remaining larger-NodeId witnesses never enter the salt, so the salt is
  // invariant to which supra-threshold subset the reveal carries. Without a
  // witnessSet the canonical set is unknown ⇒ reveal-defined fallback (header).
  if (inSet !== null && errors.length === 0) {
    const designated = [...new Set(opts.witnessSet as readonly NodeId[])].sort(compareKeys).slice(0, threshold)
    const pinned: LeaseGrant[] = []
    for (const w of designated) {
      const g = byW.get(w)
      if (g === undefined)
        errors.push(`salt: canonical grantor ${w} did not sign. The pinned threshold subset is incomplete`)
      else pinned.push(g)
    }
    return { grants: pinned, errors }
  }
  return { grants: sortedCounted, errors }
}

/** The canonical threshold-signature material: concat of the counted grants'
 * RAW 64 sig bytes (header derivation). Throws Tier2InputError when the
 * reveal does not prove a threshold: no salt from an unproven reveal. */
export function saltRevealBytes(reveal: SaltReveal, opts: SaltVerifyOpts = {}): Uint8Array {
  const p = zSaltReveal.safeParse(reveal)
  if (!p.success) bad('saltRevealBytes: malformed SaltReveal')
  const { grants, errors } = countedGrants(reveal, opts)
  if (errors.length > 0) bad(`saltRevealBytes: ${errors.sort()[0]}`)
  return concatBytes(...grants.map((g) => fromB64u(g.sig)))
}

/** windowSalt = sha256(saltRevealBytes), 32 salt bytes (header contract:
 * unpredictable before the witnesses sign, exactly recomputable after). */
export function windowSalt(reveal: SaltReveal, opts: SaltVerifyOpts = {}): Uint8Array {
  return sha256(saltRevealBytes(reveal, opts))
}

/** Fail-closed reveal verifier (typed verdict, never throws): re-derives the
 * salt iff the reveal proves a threshold of valid grants. */
export function verifySaltReveal(reveal: unknown, opts: SaltVerifyOpts = {}): SaltVerify {
  try {
    const p = zSaltReveal.safeParse(reveal)
    if (!p.success) return { ok: false, errors: ['salt: malformed SaltReveal'] }
    const r = reveal as SaltReveal
    const { grants, errors } = countedGrants(r, opts)
    if (errors.length > 0) return { ok: false, errors: errors.sort() }
    return { ok: true, errors: [], salt: toB64u(sha256(concatBytes(...grants.map((g) => fromB64u(g.sig))))) }
  } catch {
    return { ok: false, errors: ['salt: internal'] } // verifiers fail closed
  }
}

// ---------------------------------------------------------------------------
// Salted window partition (boundary jitter, header geometry)
// ---------------------------------------------------------------------------

/** off(w) ∈ [0, reganK): u32be of salt bytes 0..3 mod K (header; the mod
 * bias ≤ K/2^32 is negligible and deterministic). */
export function saltOffset(salt: Uint8Array): number {
  if (!(salt instanceof Uint8Array) || salt.length < 4) bad('saltOffset: salt must carry ≥ 4 bytes')
  const u32 = salt[0] * 16_777_216 + salt[1] * 65_536 + salt[2] * 256 + salt[3]
  return u32 % PARAMS_A5.reganK
}

/** Offsets provider: window index → off(w) ∈ [0, reganK). The caller closes
 * over its verified salt reveals; every result is re-validated here. */
export type OffsetOf = (windowIndex: number) => number

function offAt(offsetOf: OffsetOf, w: number): number {
  const off = offsetOf(w)
  if (!isNonNegInt(off) || off >= PARAMS_A5.reganK)
    bad(`windowStart: offsetOf(${w}) must be an integer in [0, ${PARAMS_A5.reganK}), got ${String(off)}`)
  return off
}

/** b(w): the first ordinal of window w. It is 0 for w=0, else w·K + off(w). */
export function windowStart(windowIndex: number, offsetOf: OffsetOf): number {
  if (!isNonNegInt(windowIndex)) bad('windowStart: windowIndex must be a non-negative safe integer')
  if (windowIndex === 0) return 0
  return windowIndex * PARAMS_A5.reganK + offAt(offsetOf, windowIndex)
}

/** Window w's ordinal range [start, end): end = b(w+1). Sizes ∈ [1, 2K−1];
 * consecutive windows tile the ordinals exactly (header proof). */
export function windowBounds(windowIndex: number, offsetOf: OffsetOf): { start: number; end: number } {
  return { start: windowStart(windowIndex, offsetOf), end: windowStart(windowIndex + 1, offsetOf) }
}

/** The window containing ordinal o: w = floor(o/K), minus 1 iff o < b(w)
 * (header: b(w) ∈ [wK, (w+1)K) makes these the only two candidates). */
export function windowIndexOfOrdinal(ordinal: number, offsetOf: OffsetOf): number {
  if (!isNonNegInt(ordinal)) bad('windowIndexOfOrdinal: ordinal must be a non-negative safe integer')
  const w = idiv(ordinal, PARAMS_A5.reganK)
  if (w >= 1 && ordinal < windowStart(w, offsetOf)) return w - 1
  return w
}

/** Slice window w out of the ladder's chain-ordered rated-game list. The
 * window is COMPLETE only when the list already extends past b(w+1); a
 * partial (still-open) window is returned as-is. The caller decides. */
export function windowGames<T>(games: readonly T[], windowIndex: number, offsetOf: OffsetOf): T[] {
  if (!Array.isArray(games)) bad('windowGames: games is not an array')
  const { start, end } = windowBounds(windowIndex, offsetOf)
  return games.slice(start, Math.min(end, games.length))
}

// ---------------------------------------------------------------------------
// Tier2Anchors: ACPL curve (J2's Tier1Anchors) + engine-match expectation
// ---------------------------------------------------------------------------

/** Anchor bundle the z-estimator consumes. `matchByElo` is the expected
 * engine-match fraction (micro) by strength at the judge's Tier-1 config:
 * ascending elo, ascending match. The MEASURED judge-config bundle lives in
 * anchors.ts (TIER2_ANCHORS_JUDGE, J6 calibration corpus); this module
 * takes anchors by injection only, so verdict receipts re-verify under the
 * exact bundle (pinned by digest in the record) they were computed with. */
export interface Tier2Anchors {
  v: 1
  acpl: Tier1Anchors
  matchByElo: readonly { elo: number; matchMicro: number }[]
  /** Residual std of per-game match fraction about the curve, micro. */
  sigmaMatchMicro: number
  /** Provenance tag (corpus + fit lineage). */
  fit: string
}

function checkTier2Anchors(a: Tier2Anchors): void {
  if (typeof a !== 'object' || a === null || a.v !== 1) bad('anchors: not a v1 Tier2Anchors')
  if (typeof a.acpl !== 'object' || a.acpl === null) bad('anchors: missing acpl anchor set')
  if (!isNonNegInt(a.sigmaMatchMicro) || a.sigmaMatchMicro <= 0) bad('anchors: invalid sigmaMatchMicro')
  if (!Array.isArray(a.matchByElo) || a.matchByElo.length < 2) bad('anchors: need ≥ 2 match knots')
  let prevElo = -1
  for (const k of a.matchByElo) {
    if (typeof k !== 'object' || k === null) bad('anchors: match knot is not an object')
    if (!isNonNegInt(k.elo) || k.elo <= prevElo) bad('anchors: match knot elos must be ascending safe integers')
    if (!isNonNegInt(k.matchMicro) || k.matchMicro > 1_000_000) bad('anchors: match knot matchMicro out of range')
    prevElo = k.elo
  }
}

/** canonicalHash digest of the anchor bundle, embedded in every verdict. */
export function tier2AnchorsDigest(a: Tier2Anchors): B64u {
  checkTier2Anchors(a)
  return toB64u(canonicalHash(a as unknown as CanonicalObject))
}

/** Expected engine-match fraction (micro) at strength `elo`: piecewise-linear
 * floor interpolation between knots, clamped to the end knots, the exact
 * mirror of tier1.ts expectedAcplMicro's rounding. */
export function expectedMatchMicro(anchors: Tier2Anchors, elo: number): number {
  checkTier2Anchors(anchors)
  if (!Number.isSafeInteger(elo)) bad('expectedMatchMicro: elo must be a safe integer')
  const ks = anchors.matchByElo
  if (elo <= ks[0].elo) return ks[0].matchMicro
  const last = ks[ks.length - 1]
  if (elo >= last.elo) return last.matchMicro
  for (let i = 1; i < ks.length; i++) {
    if (elo <= ks[i].elo) {
      const a = ks[i - 1]
      const b = ks[i]
      return a.matchMicro + idiv((elo - a.elo) * (b.matchMicro - a.matchMicro), b.elo - a.elo)
    }
  }
  return last.matchMicro // unreachable
}

// ---------------------------------------------------------------------------
// The window z-statistic (exact estimator, header formulas)
// ---------------------------------------------------------------------------

/** [A5-CALIBRATED] Upper-confidence multiplier on the fold RD (header:
 * effElo = elo + floor(RD_CONF_MUL·rdMicro/1e6)). 2 ⇒ a settled account
 * (RD floored at 30) shifts ≤ 60 Elo, negligible against the anchor-knot
 * spacing, so the J6-calibrated honest-holdout FPR is preserved, while a
 * placement/climbing account (RD 300+) shifts ≥ 600 Elo, covering the
 * display-rating lag (A5-02). LOCAL const, deliberately NOT in PARAMS_A5:
 * folding it into the params bundle (and re-deriving the honest-holdout
 * margin with rdMicro exercised) is deferred to the next calibration
 * re-pin; do not drift PARAMS_A5_DIGEST for it here. */
const RD_CONF_MUL = 2

/** Validation bound on rdMicro (micro-Elo). The a4-v1 fold clamps RD to the
 * 350 seed; 1000 leaves headroom while keeping RD_CONF_MUL·rdMicro and
 * effElo trivially safe integers (overflow audit: 2·1e9 = 2e9 ≪ 2^53). */
const RD_MICRO_MAX = 1_000_000_000

/** One game of a window: the Tier1Record, the accused's color, and the
 * accused's chain-derived strength entering the game (header). */
export interface WindowEntry {
  rec: Tier1Record
  side: Side
  elo: number
  /** OPTIONAL (A5-02): the a4-v1 fold's ladder RD ENTERING the game,
   * micro-Elo. Present ⇒ expectations score at the upper-confidence
   * effElo (header); absent ⇒ legacy point-estimate path, byte-identical
   * to pre-A5-02 behavior. */
  rdMicro?: number
}

function checkTier1Side(s: Tier1Side, where: string): void {
  if (typeof s !== 'object' || s === null) bad(`${where}: side is not an object`)
  if (!isNonNegInt(s.scored)) bad(`${where}: scored is not a non-negative safe integer`)
  if (!isNonNegInt(s.acplMicro) || s.acplMicro > MAX_CPL_MICRO) bad(`${where}: acplMicro out of range`)
  if (!isNonNegInt(s.matchMicro) || s.matchMicro > 1_000_000) bad(`${where}: matchMicro out of range`)
}

function checkEntry(e: WindowEntry, i: number, ladder: string | null): string {
  if (typeof e !== 'object' || e === null) bad(`entry[${i}] is not an object`)
  if (e.side !== 'w' && e.side !== 'b') bad(`entry[${i}].side must be 'w' | 'b'`)
  if (!Number.isSafeInteger(e.elo)) bad(`entry[${i}].elo must be a safe integer`)
  if (e.rdMicro !== undefined && (!isNonNegInt(e.rdMicro) || e.rdMicro > RD_MICRO_MAX))
    bad(`entry[${i}].rdMicro must be a non-negative safe integer ≤ ${RD_MICRO_MAX} when present`)
  const r = e.rec
  if (typeof r !== 'object' || r === null || r.v !== 1) bad(`entry[${i}].rec is not a v1 Tier1Record`)
  if (typeof r.game !== 'string' || r.game.length === 0) bad(`entry[${i}].rec.game invalid`)
  if (typeof r.ladder !== 'string' || r.ladder.length === 0) bad(`entry[${i}].rec.ladder invalid`)
  if (ladder !== null && r.ladder !== ladder)
    bad(`entry[${i}].rec.ladder ${JSON.stringify(r.ladder)} differs from the window's ${JSON.stringify(ladder)}`)
  if (r.params !== PARAMS_A5_DIGEST)
    bad(`entry[${i}].rec.params does not name PARAMS_A5_DIGEST. Refusing a foreign rule set`)
  checkTier1Side(r[e.side], `entry[${i}].rec.${e.side}`)
  return r.ladder
}

/** Per-game standardized deviation, micro-σ (header formula; positive =
 * suspicious), or null when the game is unscored (s.scored = 0: no
 * evidence, excluded from n_eff). */
export function gameDevMicro(entry: WindowEntry, anchors: Tier2Anchors): number | null {
  checkTier2Anchors(anchors)
  checkEntry(entry, 0, null)
  const s = entry.rec[entry.side]
  if (s.scored === 0) return null
  // A5-02: score against the upper-confidence strength when the fold RD is
  // supplied (header); rdMicro ≥ 0 so idiv here is a plain floor.
  const effElo = entry.rdMicro === undefined ? entry.elo : entry.elo + idiv(RD_CONF_MUL * entry.rdMicro, 1_000_000)
  const devAcpl = idiv(
    (expectedAcplMicro(anchors.acpl, effElo) - s.acplMicro) * 1_000_000,
    anchors.acpl.sigmaAcplMicro,
  )
  const devMatch = idiv((s.matchMicro - expectedMatchMicro(anchors, effElo)) * 1_000_000, anchors.sigmaMatchMicro)
  const dev = idiv(devAcpl + devMatch, 2)
  return dev > PER_GAME_DEV_CAP_MICRO ? PER_GAME_DEV_CAP_MICRO : dev < -PER_GAME_DEV_CAP_MICRO ? -PER_GAME_DEV_CAP_MICRO : dev
}

/** The window aggregate (header formula): zMicro over the scored games. */
export function aggregateZMicro(
  entries: readonly WindowEntry[],
  anchors: Tier2Anchors,
): { zMicro: number; scoredGames: number } {
  checkTier2Anchors(anchors)
  if (!Array.isArray(entries)) bad('aggregateZMicro: entries is not an array')
  if (entries.length > WINDOW_ENTRIES_MAX)
    bad(`aggregateZMicro: ${entries.length} entries exceed WINDOW_ENTRIES_MAX ${WINDOW_ENTRIES_MAX}`)
  let ladder: string | null = null
  let sum = 0
  let nEff = 0
  for (let i = 0; i < entries.length; i++) {
    ladder = checkEntry(entries[i], i, ladder)
    const dev = gameDevMicro(entries[i], anchors)
    if (dev === null) continue
    sum += dev
    nEff++
  }
  if (nEff === 0) return { zMicro: 0, scoredGames: 0 }
  return { zMicro: idiv(sum * 1000, isqrt(nEff * 1_000_000)), scoredGames: nEff }
}

export interface WindowVerdict {
  zMicro: number
  /** Entries in the window (incl. unscored games). */
  games: number
  /** Games that actually carried evidence (s.scored ≥ 1). */
  scoredGames: number
  /** zMicro ≥ PARAMS_A5.zThresholdMicro, the Tier-2 conviction. */
  convicted: boolean
  /** zMicro ≥ PARAMS_A5.zEscalateMicro, the escalation condition. */
  escalate: boolean
}

/** Judge one window's Tier1Records for one (root, ladder): header estimator;
 * conviction below 3 scored games is structurally impossible (per-game cap). */
export function windowVerdict(entries: readonly WindowEntry[], anchors: Tier2Anchors): WindowVerdict {
  const { zMicro, scoredGames } = aggregateZMicro(entries, anchors)
  return {
    zMicro,
    games: entries.length,
    scoredGames,
    convicted: zMicro >= PARAMS_A5.zThresholdMicro,
    escalate: zMicro >= PARAMS_A5.zEscalateMicro,
  }
}

// ---------------------------------------------------------------------------
// Cross-window lifetime accumulation (J7, header contract)
// ---------------------------------------------------------------------------

/** Structural per-window |zMicro| bound: |sumDev| ≤ n_eff·PER_GAME_DEV_CAP
 * with n_eff ≤ WINDOW_ENTRIES_MAX, so |zMicro| ≤ cap·√n_eff (+1 absorbs the
 * floor-toward-−∞ asymmetry on negative sums). Any claimed window z outside
 * this bound is arithmetically impossible and refused. */
export const WINDOW_Z_CAP_MICRO =
  idiv(WINDOW_ENTRIES_MAX * PER_GAME_DEV_CAP_MICRO * 1000, isqrt(WINDOW_ENTRIES_MAX * 1_000_000)) + 1

/** Max closed windows one lifetime aggregation accepts (300k rated games on
 * one ladder). Keeps every intermediate a safe integer: |Σ z_w|·1000 ≤
 * LIFETIME_WINDOWS_MAX · WINDOW_Z_CAP_MICRO · 1000 < 2.4e14 < 2^53. */
export const LIFETIME_WINDOWS_MAX = 10_000

export interface LifetimeVerdict {
  /** zLifeMicro(W) = floor(Σ z_w · 1000 / isqrt(W·1e6)), header formula. */
  zLifeMicro: number
  /** W: the closed-window count the statistic was evaluated over. */
  windows: number
  /** zLifeMicro ≥ PARAMS_A5.zThresholdMicro, the SAME 5σ conviction line. */
  convicted: boolean
  /** zLifeMicro ≥ PARAMS_A5.zEscalateMicro, the SAME 3σ escalation line. */
  escalate: boolean
}

/**
 * The lifetime statistic (PARAMS_A5.lifetimeScheme, header math): aggregate
 * the ladder's CLOSED windows' zMicro values, in chain order, exactly as the
 * per-window statistic aggregates per-game deviations. z_w ~ N(0,1) under
 * the null ⇒ z_life ~ N(0,1): the same thresholds apply, no new dials; the
 * 5σ conviction line absorbs the evaluate-at-every-W multiplicity (header).
 * W = 0 (no closed window yet) is the empty statistic: z = 0, no flags.
 * Deterministic given the window zs; pure integer math.
 */
export function lifetimeVerdict(windowZs: readonly number[]): LifetimeVerdict {
  if (!Array.isArray(windowZs)) bad('lifetimeVerdict: windowZs is not an array')
  const W = windowZs.length
  if (W > LIFETIME_WINDOWS_MAX)
    bad(`lifetimeVerdict: ${W} windows exceed LIFETIME_WINDOWS_MAX ${LIFETIME_WINDOWS_MAX}`)
  let sum = 0
  for (let i = 0; i < W; i++) {
    const z = windowZs[i]
    if (typeof z !== 'number' || !Number.isSafeInteger(z))
      bad(`lifetimeVerdict: windowZs[${i}] is not a safe integer`)
    if (z > WINDOW_Z_CAP_MICRO || z < -WINDOW_Z_CAP_MICRO)
      bad(`lifetimeVerdict: windowZs[${i}] = ${z} exceeds the structural window bound ±${WINDOW_Z_CAP_MICRO}`)
    sum += z
  }
  const zLifeMicro = W === 0 ? 0 : idiv(sum * 1000, isqrt(W * 1_000_000))
  return {
    zLifeMicro,
    windows: W,
    convicted: zLifeMicro >= PARAMS_A5.zThresholdMicro,
    escalate: zLifeMicro >= PARAMS_A5.zEscalateMicro,
  }
}

// ---------------------------------------------------------------------------
// The deterministic escalation trigger (§8, header contract)
// ---------------------------------------------------------------------------

/** One game of the chain-derived rated-game list for (root, ladder):
 * gameKey, the accused's color, and the accused's strength entering it. */
export interface LadderGameRef {
  game: string
  side: Side
  elo: number
  /** OPTIONAL (A5-02): the fold's ladder RD entering the game, micro-Elo;
   * threaded into WindowEntry.rdMicro (upper-confidence scoring, header). */
  rdMicro?: number
}

export interface EscalationVerdict {
  due: boolean
  /** Earliest index (into the game list) whose trailing-K aggregate reached
   * the 3σ ESCALATION line. A5-20: when `lifetime` is ALSO present, the
   * deeper-analysis obligation began at whichever of the two firing games is
   * EARLIER in chain order (see the fn doc). A5-21: escalation firings anchor
   * ONLY the deeper-analysis obligation: the self-ban anchor is
   * `conviction`, never these fields. */
  atIndex?: number
  /** That game's key. */
  game?: string
  /** The trailing-K zMicro at the firing point. */
  zMicro?: number
  /** Present iff the LIFETIME accumulation escalated, reported INDEPENDENTLY
   * of the trailing-K arm (A5-20: BOTH may be present when both fire, since
   * either can escalate at the earlier chain ordinal). z_life at the earliest
   * escalating closed-window count W (windows = W, i.e. closed windows
   * 0..W−1). The corresponding chain game is the one closing window W−1,
   * ordinal b(W)−1 of the salted partition, mapped by the caller (this
   * function never sees the partition). */
  lifetime?: { zLifeMicro: number; windows: number }
  /** A5-21 (owner decision 2026-07-22): present iff either arm reached the
   * 5σ CONVICTION line (zThresholdMicro), THE §8 self-ban / suppression
   * anchor. Same both-arms / min-by-ordinal contract as the escalation
   * fields: `atIndex/game/zMicro` name the EARLIEST trailing-K window whose
   * recomputed z convicted; `lifetime` names the EARLIEST convicting
   * closed-window prefix; when both are present the §8 self-ban deadline
   * anchors on whichever firing is EARLIER in chain order (games[atIndex] vs
   * the game at ordinal b(W)−1, caller-mapped). Escalation alone NEVER
   * obliges a ban: at 3σ an honest career's eventual false 90-day ban is
   * near-certain (header §A5-21), which §0 no-false-fraud forbids. */
  conviction?: {
    atIndex?: number
    game?: string
    zMicro?: number
    lifetime?: { zLifeMicro: number; windows: number }
  }
}

/**
 * THE deterministic, protocol-defined escalation condition (header): at each
 * chain point i ≥ reganK−1, aggregate the trailing reganK games; fire at the
 * earliest zMicro ≥ zEscalateMicro. `records` maps gameKey → Tier1Record;
 * on the compliant path these exist for every rated game (§8 Tier-1 runs on
 * all of them); a missing record fails CLOSED (Tier2InputError), because the
 * condition is only defined over judged games and an unjudged rated game is
 * itself non-compliance. Deterministic given (chain bytes, Tier1Records).
 *
 * J7 (ADDITIVE, 3-arg callers are byte-unchanged): when `closedWindowZs`
 * (the ladder's closed salted windows' zMicro values, chain order; the
 * caller derives them from its verified salt reveals) is supplied, the
 * trigger ALSO fires when the lifetime statistic escalates at any prefix:
 * the earliest W with lifetimeVerdict(closedWindowZs[0..W)).escalate. A5-20:
 * the two arms are evaluated INDEPENDENTLY and BOTH firings are reported
 * (`atIndex/game/zMicro` for trailing-K, `lifetime` for the lifetime prefix);
 * a trailing-K firing no longer suppresses an EARLIER-in-chain-order lifetime
 * firing. `due` is their OR: the ESCALATION (deeper-analysis) obligation.
 *
 * A5-21 (owner decision 2026-07-22, honest players are never banned): each
 * arm is ALSO scanned for its earliest crossing of the 5σ CONVICTION line
 * (zThresholdMicro), reported under `conviction`. THE §8 self-ban deadline
 * anchors on the earliest CONVICTION firing: games[conviction.atIndex] for
 * trailing-K vs the game closing conviction.lifetime's window W−1 (ordinal
 * b(W)−1), NEVER on a mere escalation firing. Only the partition-holding
 * caller can name b(W)−1, so it (which already resolves that ordinal) takes
 * the min; this function never sees the partition and so cannot order the
 * two. Surfacing both losslessly is precisely what lets the caller set the
 * deadline no later than the earliest conviction (the same A5-20 lossless
 * contract, now applied at the conviction line). A conviction structurally
 * implies escalation (zThresholdMicro > zEscalateMicro), so `conviction`
 * present ⇒ `due` true.
 *
 * VALIDATION DOMAIN (ratified at the A5-21 post-fix review): the condition
 * is defined only over a FULLY-well-formed input: every entry and every
 * closedWindowZs element is deep-validated UPFRONT, before any window or
 * prefix is evaluated, so a malformed chain fails closed (Tier2InputError)
 * regardless of where the escalation/conviction crossings sit. Throw
 * behavior is input-shape-determined, never scan-depth-determined.
 * Deterministic given (chain bytes, Tier1Records, salt reveals), the module
 * contract.
 */
export function escalationDue(
  games: readonly LadderGameRef[],
  records: ReadonlyMap<string, Tier1Record>,
  anchors: Tier2Anchors,
  closedWindowZs?: readonly number[],
): EscalationVerdict {
  if (!Array.isArray(games)) bad('escalationDue: games is not an array')
  if (!(records instanceof Map)) bad('escalationDue: records must be a Map')
  const K = PARAMS_A5.reganK
  // Trailing-K arm (salt-free, fixed geometry): the EARLIEST chain point i
  // whose trailing-K aggregate reaches the escalation line, and (A5-21) the
  // EARLIEST that reaches the conviction line. The conviction crossing is at
  // or after the escalation crossing (a convicting window also escalates),
  // so the scan stops at the first conviction.
  let trailingK: { atIndex: number; game: string; zMicro: number } | undefined
  let trailingKConv: { atIndex: number; game: string; zMicro: number } | undefined
  if (games.length >= K) {
    const entries: WindowEntry[] = games.map((g, i) => {
      if (typeof g !== 'object' || g === null || typeof g.game !== 'string' || g.game.length === 0)
        bad(`escalationDue: games[${i}] is malformed`)
      const rec = records.get(g.game)
      if (rec === undefined)
        bad(`escalationDue: no Tier1Record for rated game ${JSON.stringify(g.game)}. Unjudged rated games are non-compliant (§8)`)
      return g.rdMicro === undefined
        ? { rec: rec as Tier1Record, side: g.side, elo: g.elo }
        : { rec: rec as Tier1Record, side: g.side, elo: g.elo, rdMicro: g.rdMicro }
    })
    // A5-21 post-fix review ratification: the §8 condition is defined only
    // over a FULLY-well-formed input. EVERY entry is deep-validated upfront
    // (the same checkEntry the aggregation applies, rdMicro/params/ladder/
    // side stats), so whether a chain throws is INPUT-SHAPE-determined,
    // never scan-depth-determined: two evaluators can never split into
    // verdict-vs-throw on identical bytes because one scanned further. (The
    // pre-A5-21 early-break scan validated only the windows it happened to
    // aggregate. A malformed record beyond the first escalation crossing
    // was silently unexamined; strictly MORE fail-closed now, per §0.)
    let lad: string | null = null
    for (let i = 0; i < entries.length; i++) lad = checkEntry(entries[i], i, lad)
    for (let i = K - 1; i < entries.length; i++) {
      const { zMicro } = aggregateZMicro(entries.slice(i - K + 1, i + 1), anchors)
      if (trailingK === undefined && zMicro >= PARAMS_A5.zEscalateMicro)
        trailingK = { atIndex: i, game: games[i].game, zMicro }
      if (zMicro >= PARAMS_A5.zThresholdMicro) {
        trailingKConv = { atIndex: i, game: games[i].game, zMicro }
        break
      }
    }
  }
  // J7 lifetime arm (over closed salted windows): the EARLIEST escalating
  // prefix W. A5-20: evaluated INDEPENDENTLY of the trailing-K arm, neither
  // suppresses the other, because either can escalate at the earlier chain
  // ordinal and the §8 deadline must anchor on whichever fired FIRST. Both
  // firings are surfaced losslessly; the partition-holding caller (the only
  // party that can name the lifetime firing's ordinal b(W)−1) takes the min.
  let lifetime: { zLifeMicro: number; windows: number } | undefined
  let lifetimeConv: { zLifeMicro: number; windows: number } | undefined
  if (closedWindowZs !== undefined) {
    if (!Array.isArray(closedWindowZs)) bad('escalationDue: closedWindowZs is not an array')
    // Same upfront full-domain rule as the trailing-K arm: validate the
    // WHOLE closed-window list (every element + the LIFETIME_WINDOWS_MAX
    // bound) before any prefix is evaluated. Throw behavior must not depend
    // on where the escalation/conviction crossings happen to sit.
    lifetimeVerdict(closedWindowZs)
    for (let w = 1; w <= closedWindowZs.length; w++) {
      const lv = lifetimeVerdict(closedWindowZs.slice(0, w))
      if (lifetime === undefined && lv.escalate)
        lifetime = { zLifeMicro: lv.zLifeMicro, windows: lv.windows }
      if (lv.convicted) {
        lifetimeConv = { zLifeMicro: lv.zLifeMicro, windows: lv.windows }
        break
      }
    }
  }
  // A5-21: the conviction report (either arm crossed zThresholdMicro), THE
  // §8 self-ban anchor. Structurally conviction ⇒ escalation, so it can
  // never be present on a not-due verdict.
  const conviction =
    trailingKConv !== undefined || lifetimeConv !== undefined
      ? {
          ...(trailingKConv !== undefined ? trailingKConv : {}),
          ...(lifetimeConv !== undefined ? { lifetime: lifetimeConv } : {}),
        }
      : undefined
  if (trailingK === undefined && lifetime === undefined) return { due: false }
  return {
    due: true,
    ...(trailingK !== undefined ? trailingK : {}),
    ...(lifetime !== undefined ? { lifetime } : {}),
    ...(conviction !== undefined ? { conviction } : {}),
  }
}

// ---------------------------------------------------------------------------
// Verdict + suppression records (header contract)
// ---------------------------------------------------------------------------

/** Canonical verdict body (cjson-v1). For kind 'verdict', `window` is the
 * SALTED window index; for 'suppression' it is the ORDINAL of the trailing-
 * K-window-completing game (the chain point the CONVICTION fired at;
 * A5-21: suppression asserts the 5σ conviction, never mere escalation).
 * `games` and `tier1` are parallel arrays in window order.
 *
 * J7 `lifetime` (OPTIONAL EVIDENCE, the simpler consistent rule, chosen
 * over a dedicated kind): any record MAY additionally claim the lifetime
 * statistic over the ladder's closed windows. zLifeMicro/windows are DERIVED
 * from windowZs (verifyTier2Verdict recomputes them exactly like zMicro from
 * the entries; receipts hold); on kind 'verdict' the claim must be evaluated
 * AT this record's window (windows = window+1, and this window's own z is
 * the last entry: windowZs[window] = zMicro, schema-refined). That the
 * windowZs really ARE the ladder's closed-window zs is the auditor's
 * chain-bytes check against the salted partition + per-window records, the
 * same deliberate thinness as the "entries really are the named window"
 * claim (header). */
export interface Tier2VerdictBody {
  v: 1
  kind: 'verdict' | 'suppression'
  /** The accused's root. The record publishes under THIS key. */
  root: B64u
  ladder: string
  window: number
  zMicro: number
  games: readonly string[]
  /** tier1Digest of each window record, parallel to `games`. */
  tier1: readonly B64u[]
  /** tier2AnchorsDigest of the anchor bundle used. */
  anchors: B64u
  /** PARAMS_A5_DIGEST: the exact rule set that produced this verdict. */
  params: string
  /** Computing party's witnessed-time claim (ranking/expiry math upstream). */
  verdictWts: number
  /** SUPPRESSION ONLY: the first witnessed-lane event appended after the
   * completing game, the §8 deadline the missing selfban is judged by. */
  deadlineEvent?: EventId
  /** OPTIONAL lifetime claim (J7, doc comment above): windowZs is the
   * ladder's closed windows' zMicro list in chain order; zLifeMicro/windows
   * are derived, never asserted. */
  lifetime?: {
    zLifeMicro: number
    windows: number
    windowZs: readonly number[]
  }
}

/** Signed verdict record, commend-pattern signer (header). */
export interface Tier2VerdictRecord {
  body: Tier2VerdictBody
  /** Computing party's account root. */
  signer: B64u
  /** Signing key: the signer root, or a child proven by `certs`. */
  key: B64u
  /** ed25519 over canonicalBytes(body). */
  sig: B64u
  /** Inline ROOT-signed cert events of the signer (present iff key ≠ signer). */
  certs?: readonly SignedEvent[]
}

const zGameKey = z.string().min(1).max(128)

const zTier2VerdictBody = z
  .strictObject({
    v: z.literal(1),
    kind: z.enum(['verdict', 'suppression']),
    root: zB64u32,
    ladder: z.string().min(1).max(64),
    window: z.int().min(0),
    zMicro: z.int(),
    games: z.array(zGameKey).min(1).max(WINDOW_ENTRIES_MAX),
    tier1: z.array(zB64u32).min(1).max(WINDOW_ENTRIES_MAX),
    anchors: zB64u32,
    params: zB64u32,
    verdictWts: z.int().min(0),
    deadlineEvent: zB64u32.optional(),
    lifetime: z
      .strictObject({
        zLifeMicro: z.int(),
        windows: z.int().min(1),
        windowZs: z
          .array(z.int().min(-WINDOW_Z_CAP_MICRO).max(WINDOW_Z_CAP_MICRO))
          .min(1)
          .max(LIFETIME_WINDOWS_MAX),
      })
      .optional(),
  })
  .refine((b) => b.games.length === b.tier1.length, { message: 'games/tier1 must be parallel' })
  .refine((b) => (b.kind === 'suppression') === (b.deadlineEvent !== undefined), {
    message: "deadlineEvent is required for 'suppression' and forbidden otherwise",
  })
  .refine((b) => b.lifetime === undefined || b.lifetime.windows === b.lifetime.windowZs.length, {
    message: 'lifetime.windows must equal lifetime.windowZs.length',
  })
  .refine(
    (b) =>
      b.lifetime === undefined ||
      b.kind !== 'verdict' ||
      (b.lifetime.windows === b.window + 1 && b.lifetime.windowZs[b.window] === b.zMicro),
    {
      message:
        "a 'verdict' lifetime claim must be evaluated AT the record's window (windows = window+1, windowZs[window] = zMicro)",
    },
  )

const zTier2VerdictRecord = z.strictObject({
  body: zTier2VerdictBody,
  signer: zB64u32,
  key: zB64u32,
  sig: zB64u64,
  certs: z.array(z.unknown()).max(8).optional(),
})

/** canonicalHash(body) b64u: what SelfBanPayload.verdict references. */
export function tier2VerdictDigest(body: Tier2VerdictBody): B64u {
  return toB64u(canonicalHash(body as unknown as CanonicalObject))
}

export interface MakeTier2VerdictOpts {
  kind: 'verdict' | 'suppression'
  root: B64u
  ladder: string
  window: number
  /** The window's entries. zMicro/games/tier1 are DERIVED, never asserted. */
  entries: readonly WindowEntry[]
  anchors: Tier2Anchors
  verdictWts: number
  deadlineEvent?: EventId
  /** OPTIONAL lifetime claim: the closed windows' zMicro list (chain order).
   * body.lifetime is DERIVED from it via lifetimeVerdict, never asserted.
   * On kind 'verdict' the schema requires it to end at this record's window
   * with this window's zMicro (body doc comment). */
  lifetimeWindowZs?: readonly number[]
  /** Computing party. */
  signer: B64u
  key: B64u
  priv: Uint8Array
  certs?: readonly SignedEvent[]
}

/** Build + sign a verdict/suppression record. Builder: throws on misuse;
 * the built record always passes verifyTier2Verdict against its inputs. */
export function makeTier2Verdict(o: MakeTier2VerdictOpts): Tier2VerdictRecord {
  if (toB64u(ed25519.getPublicKey(o.priv)) !== o.key) bad('makeTier2Verdict: priv does not match key')
  const { zMicro } = aggregateZMicro(o.entries, o.anchors)
  const life = o.lifetimeWindowZs === undefined ? undefined : lifetimeVerdict(o.lifetimeWindowZs)
  // A5-03 + A5-21: a suppression record asserts the deterministic CONVICTION
  // FIRED (§8, at the 5σ line, owner decision 2026-07-22: escalation alone
  // never obliges a ban, so a sub-conviction suppression is a false-fraud
  // instrument against honest accounts). The condition is fully derivable
  // from these inputs, so the builder refuses to mint one whose own evidence
  // disproves it: either the trailing-K window path (a FULL reganK window
  // whose zMicro meets zThresholdMicro) or the J7 lifetime path
  // (lifetimeVerdict(...).convicted) must hold.
  if (o.kind === 'suppression') {
    const windowFired = o.entries.length === PARAMS_A5.reganK && zMicro >= PARAMS_A5.zThresholdMicro
    const lifetimeFired = life !== undefined && life.convicted
    if (!windowFired && !lifetimeFired)
      bad(
        `makeTier2Verdict: suppression requires the conviction to have fired. Window path needs ${PARAMS_A5.reganK} entries with zMicro ≥ ${PARAMS_A5.zThresholdMicro} (got ${o.entries.length} entries, zMicro ${zMicro})` +
          (life === undefined
            ? '; no lifetime claim'
            : `; lifetime path zLifeMicro ${life.zLifeMicro} < ${PARAMS_A5.zThresholdMicro}`),
      )
  }
  const body: Tier2VerdictBody = {
    v: 1,
    kind: o.kind,
    root: o.root,
    ladder: o.ladder,
    window: o.window,
    zMicro,
    games: o.entries.map((e) => e.rec.game),
    tier1: o.entries.map((e) => tier1Digest(e.rec)),
    anchors: tier2AnchorsDigest(o.anchors),
    params: PARAMS_A5_DIGEST,
    verdictWts: o.verdictWts,
    ...(o.deadlineEvent !== undefined ? { deadlineEvent: o.deadlineEvent } : {}),
    ...(life !== undefined
      ? {
          lifetime: {
            zLifeMicro: life.zLifeMicro,
            windows: life.windows,
            windowZs: [...(o.lifetimeWindowZs as readonly number[])],
          },
        }
      : {}),
  }
  if (!zTier2VerdictBody.safeParse(body).success) bad('makeTier2Verdict: built body does not satisfy the schema')
  const sig = toB64u(ed25519.sign(canonicalBytes(body as unknown as CanonicalValue), o.priv))
  const rec: Tier2VerdictRecord = {
    body,
    signer: o.signer,
    key: o.key,
    sig,
    ...(o.certs !== undefined ? { certs: o.certs } : {}),
  }
  const v = verifyTier2Verdict(rec, { entries: o.entries, anchors: o.anchors })
  if (!v.ok) bad(`makeTier2Verdict: built record does not verify (${v.errors[0]})`)
  return rec
}

export interface VerifyTier2Opts {
  /** The window inputs (chain-derived sides/elos + the Tier1Records). */
  entries: readonly WindowEntry[]
  anchors: Tier2Anchors
}

export interface Tier2Verify {
  ok: boolean
  /** Deterministic, sorted error strings. */
  errors: string[]
}

/**
 * FULL receipt verification (header): shape, params pin, anchors digest,
 * per-game tier1 digests + game keys, exact zMicro recomputation (same
 * inputs ⇒ same bits, or rejected), the 'suppression' CONVICTION condition
 * (A5-03 + A5-21: recomputed from the same inputs, full-reganK window
 * zMicro ≥ zThresholdMicro, or lifetime zLifeMicro ≥ zThresholdMicro; mere
 * escalation never grounds a suppression),
 * commend-pattern key provenance, and the
 * record signature. Fail-closed: never throws. The chain-side claims, that
 * `entries` really are the named window of the accused's ladder, and (for
 * 'suppression') that no selfban precedes deadlineEvent, are the auditor's
 * chain-bytes checks; this verifier owns everything derivable from its
 * inputs.
 */
export function verifyTier2Verdict(rec: unknown, opts: VerifyTier2Opts): Tier2Verify {
  const errors: string[] = []
  try {
    if (!zTier2VerdictRecord.safeParse(rec).success) return { ok: false, errors: ['verdict: malformed record'] }
    const r = rec as Tier2VerdictRecord
    const b = r.body
    if (b.params !== PARAMS_A5_DIGEST) errors.push('verdict: params digest does not name PARAMS_A5_DIGEST')
    if (b.anchors !== tier2AnchorsDigest(opts.anchors)) errors.push('verdict: anchors digest mismatch')
    // A5-03 + A5-21 conviction evidence (suppression), recomputed below
    // from the inputs.
    let windowConvictionFired = false
    let lifetimeConvictionFired = false
    const entries = opts.entries
    if (!Array.isArray(entries) || entries.length !== b.games.length) {
      errors.push('verdict: supplied entries do not match the games list length')
    } else {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (e.rec.game !== b.games[i]) {
          errors.push(`verdict: entry[${i}] game key mismatch`)
          continue
        }
        if (e.rec.ladder !== b.ladder) errors.push(`verdict: entry[${i}] ladder mismatch`)
        if (tier1Digest(e.rec) !== b.tier1[i]) errors.push(`verdict: entry[${i}] tier1 digest mismatch`)
      }
      if (errors.length === 0) {
        const { zMicro } = aggregateZMicro(entries, opts.anchors)
        if (zMicro !== b.zMicro) errors.push('verdict: zMicro does not recompute from the inputs')
        windowConvictionFired = entries.length === PARAMS_A5.reganK && zMicro >= PARAMS_A5.zThresholdMicro
      }
    }
    // J7: the lifetime claim is a receipt too. zLifeMicro must recompute
    // from the claimed windowZs bit-for-bit (windows/windowZs parallelism and
    // the on-kind-'verdict' tie to zMicro are schema-refined above; the zod
    // ±WINDOW_Z_CAP_MICRO bounds guarantee lifetimeVerdict cannot throw).
    if (b.lifetime !== undefined) {
      const lv = lifetimeVerdict(b.lifetime.windowZs)
      if (lv.zLifeMicro !== b.lifetime.zLifeMicro)
        errors.push('verdict: lifetime zLifeMicro does not recompute from windowZs')
      lifetimeConvictionFired = lv.convicted
    }
    // A5-03 + A5-21: 'suppression' asserts the deterministic CONVICTION
    // FIRED (§8, 5σ), a condition fully derivable from the supplied inputs,
    // so this verifier owns it (header contract): either the trailing-K
    // window path (a FULL reganK window whose RECOMPUTED zMicro meets
    // zThresholdMicro) or the J7 lifetime path (RECOMPUTED zLifeMicro meets
    // zThresholdMicro, i.e. lifetimeVerdict(...).convicted). Neither ⇒ the
    // record claims a conviction its own evidence disproves. Rejected.
    // Escalation alone NEVER grounds a suppression (owner decision
    // 2026-07-22: honest players are never banned).
    if (b.kind === 'suppression' && !windowConvictionFired && !lifetimeConvictionFired)
      errors.push(
        'verdict: suppression conviction did not fire on the recomputed evidence (needs a full trailing-K window with zMicro ≥ zThresholdMicro, or a lifetime claim with zLifeMicro ≥ zThresholdMicro)',
      )
    // Commend-pattern key provenance (conduct.ts verifyCommend rules).
    if (r.key === r.signer) {
      if (r.certs !== undefined) errors.push('verdict: certs must be absent when key === signer')
    } else if (r.certs === undefined || r.certs.length === 0) {
      errors.push('verdict: child key carries no signer certs')
    } else {
      let proven = false
      for (const c of r.certs) {
        const info = isRootSignedCert(r.signer, c as SignedEvent)
        if (info !== null && info.pub === r.key) {
          proven = true
          break
        }
      }
      if (!proven) errors.push('verdict: certs do not prove key belongs to signer')
    }
    if (!verifySigB64u(r.sig, canonicalBytes(b as unknown as CanonicalValue), r.key))
      errors.push('verdict: bad record signature')
    errors.sort()
    return { ok: errors.length === 0, errors }
  } catch {
    return { ok: false, errors: ['verdict: internal'] } // verifiers fail closed
  }
}

// ---------------------------------------------------------------------------
// Publishing (thin, the fuse-record/pointers pattern, header contract)
// ---------------------------------------------------------------------------

/** The deterministic 32-byte shard-space key verdict records for `root`
 * publish under: sha256(utf8(tag) ‖ nodeIdOf(root) bytes), the exact
 * pointerKey construction, domain-separated forever. Overlay publish /
 * store-gate / merge are embedder work (A3 storage), like fuse records. */
export function tier2VerdictKey(subjectRoot: B64u): B64u {
  const sub = fromB64u(nodeIdOf(subjectRoot))
  if (sub.length !== 32) bad('tier2VerdictKey: subject nodeId must decode to 32 bytes')
  return toB64u(sha256(concatBytes(utf8(VERDICT_KEY_TAG), sub)))
}

/** The row shape stored at tier2VerdictKey (a SET row like PointerRow). */
export interface Tier2VerdictRow {
  v: 1
  verdicts: Tier2VerdictRecord[]
}

/** Bundle records for publishing. All must name the same accused root. */
export function verdictRow(recs: readonly Tier2VerdictRecord[]): Tier2VerdictRow {
  if (!Array.isArray(recs) || recs.length === 0) bad('verdictRow: need ≥ 1 record')
  const root = recs[0].body.root
  for (const r of recs) {
    if (r.body.root !== root) bad('verdictRow: records name different accused roots')
  }
  return { v: 1, verdicts: [...recs] }
}

// ---------------------------------------------------------------------------
// Self-ban helpers (§8 deadline / §9 term)
// ---------------------------------------------------------------------------

/** Ban expiry from the CONVICTION's witnessed time (A5-21: the ban anchors
 * on the 5σ conviction, never mere escalation): + selfBanDays (§9: 90d,
 * diversity-bound witnessed time). */
export function selfBanExpiryWts(convictionWts: number): number {
  if (!isNonNegInt(convictionWts)) bad('selfBanExpiryWts: convictionWts must be a non-negative safe integer')
  return convictionWts + PARAMS_A5.selfBanDays * MS_PER_DAY
}

/** Build the schema-validated SelfBanPayload the compliant client appends
 * (witnessed lane, type 'selfban'). `verdictDigest` = tier2VerdictDigest of
 * the reproducible verdict record published under the accused's key. */
export function makeSelfBanPayload(o: {
  ladder: string
  window: number
  expiryWts: number
  verdictDigest: B64u
}): SelfBanPayload {
  const payload: SelfBanPayload = {
    kind: 'anticheat',
    ladder: o.ladder,
    window: o.window,
    expiryWts: o.expiryWts,
    verdict: o.verdictDigest,
  }
  if (!zSelfBanPayload.safeParse(payload).success)
    bad('makeSelfBanPayload: payload does not satisfy zSelfBanPayload')
  return payload
}

/**
 * The §8 deadline rule, as a pure predicate. A5-21 (OWNER DECISION
 * 2026-07-22, "an honest player is never banned"): the ban obligation
 * anchors on the deterministic CONVICTION (escalationDue(...).conviction:
 * either arm crossing zThresholdMicro, 5σ), NEVER on mere escalation. Once
 * the conviction has fired at some chain point and this chain carries no
 * selfban for that (ladder, conviction) yet, the compliant client's NEXT
 * witnessed-lane event MUST be the selfban. Appending ANY other
 * witnessed-lane event after the conviction-completing game while this
 * predicate is true is what a SUPPRESSION record proves (deadlineEvent =
 * that first other event). The 3σ escalation obliges ONLY the deeper Tier-2
 * analysis: at 3σ the one-sided ban FPR is ≈1.35e-3/window, making an
 * honest career's eventual false 90-day ban near-certain (header §A5-21),
 * the false-fraud §0 forbids; at 5σ the per-look FPR is ≈2.9e-7,
 * union-bounded < 3e-3 over 10^4 windows (§8 "astronomically low").
 * Suppression is provable ONLY relative to the deterministic conviction,
 * never relative to an arbitrary third-party Tier-2 run (§8): a client that
 * never met the on-chain condition is never condemned by a stranger's later
 * computation.
 */
export function selfBanDueNow(s: { escalation: EscalationVerdict; selfBanAppended: boolean }): boolean {
  if (typeof s !== 'object' || s === null || typeof s.escalation !== 'object' || s.escalation === null)
    bad('selfBanDueNow: malformed state')
  const c = s.escalation.conviction
  return typeof c === 'object' && c !== null && s.selfBanAppended !== true
}
