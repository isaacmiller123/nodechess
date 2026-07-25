// A5 J2, Tier-1 forensic signals (spec §8 Tier-1): pure functions over
// (transcript, signed clocks, JudgeOutput). Platform-neutral: no node:
// imports, no DOM, no ambient time/randomness. INTEGER OUTPUTS ONLY
// (micro-units for fractional quantities); the only division is floor
// division of safe integers, and the module uses NO transcendentals at all
// (Math.exp/log/pow banned per detmath; nothing here needed even dexp/dln.
// The one logarithmic curve, the ACPL↔Elo anchor set, is precomputed into
// integer knots). Fail-closed: every public entry throws Tier1InputError on
// malformed input; nothing is ever silently coerced.
//
// Tier-1 output feeds T only (spec §8). This module produces the SIGNALS and
// the canonical per-game Tier1Record; the trust re-weighting (mm/trust.ts)
// and the escalation/aggregation (J4) live elsewhere.
//
// ─── POV AND SCORE CONVENTIONS (normative for every formula below) ─────────
// A JudgeOutput judges the position BEFORE each transcript ply: the judged
// position at ply i is the position the mover of ply i faced, so its lines'
// cp/mate scores are ALREADY mover-POV (UCI side-to-move POV). The mover of
// ply i is `firstMover` when i is even, the other color when i is odd
// (segment.ts verifyMoveChain parity).
//
// PLAYED-MOVE EVAL (the ground-truth rule, used by ACPL and engine-match):
//  (a) IN-LIST: if the played move string-equals a judged line's move at
//      ply i, the played eval is THAT LINE's score. The same-snapshot
//      convention the shipped classifier uses for co-best moves
//      (accuracy.ts computeIsBest / REVIEW-SPEC S2 uses PV2's eval at
//      fenBefore). String equality here only SELECTS the score source; it is
//      never itself the match criterion (spec: never exact-move matching).
//  (b) NOT-IN-LIST: the NEXT judged position (exactly ply i+1) is the ground
//      truth: its rank-1 line's score, negated to the mover's POV
//      (cp → −cp; mate m → mate −m, then the mate map below).
//  (c) NEITHER (move outside the MultiPV list and ply i+1 not judged, e.g.
//      the game's final move): the move is UNSCORED. Excluded from both the
//      ACPL and the engine-match denominators and counted in `unscored`.
//
// MATE MAP (ACPL/engine-match). Ported VERBATIM from the shipped
// src/main/analysis/accuracy.ts mateToCp:
//   mate 0 → −2100 (the POV side is already checkmated; unreachable from J1
//   output: a judged line can never carry mate 0 because judgeGame rejects
//   terminal positions, but the branch is kept for port fidelity and for
//   the negated ground-truth path's totality);
//   else sign(m)·(21 − min(10, |m|))·100  (mate-in-1 → ±2000 … ≥10 → ±1100).
//   Consequence (documented, conservative): mate bands are 100cp apart, so a
//   ground-truth-scored mate move matches a listed mate line only at the same
//   band; near-misses fall OUT of the ±15cp window. Fewer matches, i.e. the
//   fail-safe (less suspicious) direction.
//
// ACPL. Port of accuracy.ts acpl():
//   per-move loss  = min(1000, max(0, bestCp − playedCp))      [MAX_CPL_PER_MOVE]
//   acplMicro(L)   = |L| = 0 ? 0
//                  : min(2_000_000_000, floor(1e6·Σloss / |L|)) [MAX_CPL cap]
//   bestCp = the rank-1 line's score at ply i (mover POV, mate-mapped).
//   Deviation from the shipped float mean: floor division in micro-units
//   (≤ 1 micro-unit difference; required by the integers-only contract).
//   NOTE for consumers: acplMicro([]) = 0 mirrors the shipped acpl([]) = 0;
//   J4 MUST weight by `scored`, never read a 0-sample ACPL as strength.
//
// ENGINE MATCH: two criteria, one window width (±PARAMS_A5.scoreEquivCp,
// both sides mate-mapped as above; no new parameter):
//   CALIBRATED any-line criterion (feeds matched/matchMicro: the Tier-2 z
//   input the MEASURED anchors were fit under, anchors.ts matchByElo /
//   sigmaMatchMicro): a scored move is engine-matched iff
//   |playedCp − lineCp| ≤ scoreEquivCp for ANY judged line at that position.
//   An in-list move matches its own line at distance 0; a not-in-list move
//   matches through its ground-truth eval (rule (b)).
//   engineMatchMicro(matched, scored) = scored = 0 ? 0
//                                     : floor(1e6·matched / scored).
//   [A5-14 DEFERRED, CONFIRMED DEFECT in the any-line criterion]: the
//   distance-0 self-match makes the window INERT for listed moves (the
//   criterion extensionally degenerates to MultiPV-list membership; with
//   ≤ t1MultiPv legal moves the judge lists every legal move, so every move
//   in a low-branching position auto-matches regardless of quality), and a
//   not-in-list move is certified by ANY line's score, including a rank-4
//   line hundreds of cp below best. The §8-intended criterion is the
//   BEST-relative window (isEngineMatchedBest / SideMoveScores.matchedBest):
//   matched iff |playedCp − rank1Cp| ≤ scoreEquivCp. Live in BOTH
//   directions for EVERY move and still never exact-move matching (a
//   rank-≥2 or unlisted move within the window of best matches; best line ∈
//   lines ⇒ matchedBest ≤ matched always). matchedBest is DIAGNOSTICS-LEVEL
//   ONLY. Deliberately NOT in Tier1Side/Tier1Record and NEVER a Tier-2
//   input yet: promoting it requires (1) the J6 anchor refit re-measuring
//   matchByElo/sigmaMatchMicro on the honest corpus under the best-relative
//   statistic (engine work; scoring it against the any-line-measured
//   anchors would break the calibrated null), and (2) the coordinated
//   Tier1Record shape re-freeze (the stored J6 corpus engine receipt,
//   test-judge-calibration.mjs, pins tier1Record digests bit-for-bit).
//   Until that single coordinated event, matchMicro's bits and the
//   measured-anchor null are byte-identical to the calibrated behavior.
//
// COMPLEXITY: port of the SHIPPED complexityMultiplier fold
// (src/renderer/src/features/play/botTime.ts), re-derived from the judge's
// OWN fixed-node MultiPV output. Never play-time probe values (spec §8:
// probes are nondeterministic and bot-pacing only). Line scores use the
// probe's cp map (botTime lineCpOf, ported): mate>0 → +1000, mate<0 → −1000,
// cp clamped to ±1000. With best = mapped rank-1 score and
// gap = (≥2 lines) ? max(0, best − mapped rank-2 score) : null
// (signalsFromProbe port), the fold. Same factors, same order, floor after
// every step, in micro-units (m starts at 1_000_000):
//   gap < 15 → ×18/10 | gap < 40 → ×145/100 | gap < 90 → ×115/100
//                                           | gap ≥ 250 → ×80/100
//   50 ≤ |best| ≤ 150 → ×130/100            (decision-boundary bump)
//   |best| ≥ 400      → ×45/100             (autopilot: conversion/freefall)
//   clamp to [300_000, 4_000_000]           (shipped 0.3×..4×)
// DOCUMENTED DEVIATIONS from the shipped fold: the `unstable` (shallow vs
// final best-move flip) and `surprise` (opponent-left-script) signals are
// probe-time-only and nondeterministic: they are dropped, which is exactly
// the shipped fold with both signals false (their neutral value). Floats are
// replaced by exact integer ratio steps (deviation < 1 micro per step).
//
// CLOCK FORENSICS: think-time vs judge-derived complexity fit. Think time
// for the mover s of ply i (i ≥ 1), given the game's Fischer increment incMs
// (the witness-signed RatedBinding.tc.incMs: supplied by the caller; 0 when
// unrated / increment-free / not yet threaded):
//   t_i = min(1e9, max(0, clockMs[i−2][s] − clockMs[i][s] + incMs))
// [A5-16] `before` = clockMs[i−2][s] is s's OWN previous self-signed remaining
// clock (its move at ply i−2, same mover parity), NOT the opponent-signed echo
// at ply i−1. A mover controls BOTH clock fields it signs, so reading the
// opponent's ply-(i−1) echo let the OPPONENT drive t_i (hence clockFitMicro)
// to an extreme against an honest accused (zero every `before` ⇒ T=0 ⇒ the
// maximal-suspicion 0), a §0 adversary-asserted-input violation. This is the
// witness's own ownClock discipline (witnessCore.ts finding A: "time the
// to-move side against ITS OWN value only, never the opponent's echo … trusting
// the opponent's echo let a mover zero the honest player's clock"). s's clock is
// frozen during the opponent's ply i−1, so clockMs[i−2][s] = clockMs[i−1][s] for
// every HONEST transcript ⇒ byte-identical records; only adversarial (framing)
// transcripts change. The second mover's opening reply (ply 1) has no own prior
// snapshot and alone falls back to clockMs[0][s]. A single sample that cannot
// drive the T-sum to an extreme. RESIDUAL (whitewash/evasion): a mover shaping
// its OWN consecutive snapshots to fake complexity-proportional thinks is NOT
// defeated here: that needs the witness's independent wclk/wts elapsed
// timestamps (witnessCore emits them), which Tier-1 does not yet consume;
// bounding t_i against wclk is the witness/transcript-verification layer's duty.
// [A5-15] The signed snapshot is taken AFTER the increment is credited
// (mpSession afterMoveCredit), so on a main-time Fischer move the raw delta
// clockMs[i−2][s] − clockMs[i][s] = elapsed − incMs; crediting incMs BACK
// recovers the true think time BEFORE the ≥0 clamp. Without the credit, honest
// sub-increment play (every elapsed ≤ incMs) drove every t_i to 0 → T=0 → the
// hardcoded maximal-suspicion 0, bit-aliased to an actual instant bot. A
// distinction no later calibration can recover. EVERY sampled ply (i ≥ 1) was
// credited the increment: only the opening move (ply 0, never sampled) is
// credited none (mpSession isOpeningMove), so the credit-back is exact for
// pure-Fischer play. (s's own snapshot after ply i−2 is the instant s's think
// began: the opponent's ply i−1 leaves s's clock untouched; ply 0 has no prior
// snapshot and is never sampled.) A ply is sampled
// iff it is judged (its c_i = complexityMicro of its judged lines exists) and
// i ≥ 1.
// THE EXACT STATISTIC (total-variation misfit of time shares vs complexity
// shares: the shipped budget model planThink spends time ∝ complexity, so a
// human's share of thinking on a position tracks the position's share of
// total complexity; a bot moving uniformly fast on hard positions does not):
//   n < CLOCK_MIN_SAMPLE (8)  → 500_000 (CLOCK_NEUTRAL_MICRO: too little
//                               evidence to speak either way)
//   T = Σt_i = 0 (n ≥ 8)      → 0 (with incMs credited back, an entire sampled
//                               game whose TRUE think was 0ms is machine pacing.
//                               Maximal misfit; an honest human's
//                               increment-credited thinks are > 0 and never
//                               reach this branch)
//   else  a_i = floor(1e6·t_i / T),  e_i = floor(1e6·c_i / C),  C = Σc_i
//         clockForensicMicro = max(0, 1_000_000 − floor(Σ|a_i − e_i| / 2))
// Range [0, 1e6]; LOW = suspicious (uniform-fast on hard positions and
// hard/easy inversions push Σ|a−e| up), proportional human spending scores
// near 1e6. Absolute speed is NOT judged here, only the fit. Byo-yomi is NOT
// correctable here: the period reset (afterMoveCredit) zeroes the delta and
// periodMs rides no signed RatedBinding.tc field. A separate schema/design
// item (out of this lane; see clockSamplesForSide).
//
// STRENGTH TRAJECTORY: OLS slope of per-game acplMicro over a chronological
// window (oldest → newest) of Tier1Records, in micro-cp per game:
//   n < 2 → 0;  x_i = i ∈ [0, n), y_i = acplMicro_i
//   trajectoryMicro = floor((n·Σx_i·y_i − Σx·Σy) / (n·Σx_i² − (Σx)²))
// Negative = ACPL falling = strengthening (the suspicious direction for J4).
// Window bounded to TRAJ_MAX_WINDOW (64 ≥ 2·reganK) so every intermediate
// product stays a safe integer.
// [A5-36] PERSISTENCE + DEFERRED CONSUMPTION. Pre-A5-36 this slope was computed
// and unit-tested but stored nowhere and read by no consumer. The §8 smurf /
// rapid-improvement channel was absent from every verdict. tier1Record now
// OPTIONALLY persists it as Tier1Side.trajectoryMicro when the minting caller
// supplies that account's prior acpl window (priorAcplMicros[side]); this game's
// acplMicro is appended as the newest point, so the stored slope is the window
// ENDING at this game. The window's per-game acplMicro every Tier1Record already
// carries IS the consumption input, so a J4 window consumer equivalently derives
// the slope as trajectoryMicro(window.map(rec → rec[side].acplMicro)); the
// persisted field just co-locates it with the game. Absent ⇒ the field is
// OMITTED (codec skips undefined) ⇒ byte-identical legacy record, so NO frozen
// tier1Digest re-froze. What is DEFERRED is only the VERDICT weight: neither
// gameDevMicro/aggregateZMicro (Tier-2 z) nor mm/trust.ts (T) reads the slope.
// Folding a σ-per-slope term into z/T is a calibration dial with an FPR tradeoff
// and awaits the J4/J6 refit. Wiring it into a verdict here, uncalibrated, is
// exactly the §0 no-false-fraud hazard this brick must not ship.
//
// Tier1Record: the canonical per-game unit J4's escalation trigger and
// window aggregation consume: cjson-v1 value (integers + strings only),
// digest = toB64u(canonicalHash(record)). Embeds PARAMS_A5_DIGEST and the
// judgeOutputDigest of the consumed JudgeOutput; tier1Record REFUSES a
// JudgeOutput whose config echo names a different params digest OR whose
// (nodes, multiPv, hashMb) is not the Tier-1 fixed-node config ([A5-37]: the
// digest pins BOTH tiers, so a Tier-2/degenerate output carries the same
// params echo: a verdict input must name the exact rule set AND config that
// produced it, the config the anchors were fit at).
//
// Tier1Anchors. The ACPL-vs-estimated-strength anchor set (spec §8: the
// estElo anchor fit MUST be re-run at the judge's fixed-node config before it
// feeds T; the shipped fit is depth-12 MultiPV-2 and does not transfer).
// Brick J3 produces the real values; the shape is defined here and a
// provisional set ships below marked [J3-REFIT-PENDING].

import { canonicalHash, type CanonicalObject } from '../codec'
import { toB64u } from '../hash'
import { PARAMS_A5, PARAMS_A5_DIGEST } from './params'
import type { JudgeLine, JudgeOutput, JudgedPosition } from './types'

// ---------------------------------------------------------------------------
// Errors + constants
// ---------------------------------------------------------------------------

/** Malformed Tier-1 input. Fail-closed: no signal is computed. */
export class Tier1InputError extends Error {
  override readonly name = 'Tier1InputError'
}

/** Per-move centipawn-loss cap (accuracy.ts MAX_CPL_PER_MOVE, ported). */
export const MAX_CPL_PER_MOVE = 1000
/** ACPL guard cap in micro-cp (accuracy.ts MAX_CPL = 2000, ported). */
export const MAX_CPL_MICRO = 2_000_000_000
/** Complexity clamp floor/ceiling (shipped complexityMultiplier 0.3×..4×). */
export const COMPLEXITY_FLOOR_MICRO = 300_000
export const COMPLEXITY_CEIL_MICRO = 4_000_000
/** Minimum clock samples before the fit statistic speaks. */
export const CLOCK_MIN_SAMPLE = 8
/** The neutral clock-fit value returned under CLOCK_MIN_SAMPLE. */
export const CLOCK_NEUTRAL_MICRO = 500_000
/** Cap on a single derived think time (keeps micro products safe-integer). */
export const CLOCK_THINK_CAP_MS = 1_000_000_000
/** [A5-15] Upper bound on the Fischer increment credited back in the think-time
 * derivation: mirrors the witness-signed RatedBinding.tc.incMs schema bound
 * (segment.ts / events.ts: incMs ≤ 3_600_000). Not a calibration dial: a
 * validation guard that keeps the credited value inside the signed envelope. */
export const CLOCK_INC_MAX_MS = 3_600_000
/** Trajectory window bound (≥ 2·PARAMS_A5.reganK; keeps products safe). */
export const TRAJ_MAX_WINDOW = 64

/** UCI long-algebraic move shape (same guard as judge.ts). */
const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][nbrq]?$/

const bad = (msg: string): never => {
  throw new Tier1InputError(msg)
}

/** Non-negative safe integer (rejects -0 like cjson does). */
function isNonNegInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0)
}

/** Exact floor division; den must be a positive integer. */
function idiv(num: number, den: number): number {
  return Math.floor(num / den)
}

// ---------------------------------------------------------------------------
// Score maps (both ported: see header)
// ---------------------------------------------------------------------------

/**
 * Signed mate distance → finite high-band cp. PORTED VERBATIM from the
 * shipped accuracy.ts mateToCp (see header for the mate-band consequence).
 */
export function mateToCp(mate: number): number {
  if (mate === 0) return -(21 * 100)
  const sign = mate > 0 ? 1 : -1
  const abs = mate > 0 ? mate : -mate
  return sign * (21 - Math.min(10, abs)) * 100
}

function checkLine(l: JudgeLine, where: string): void {
  if (typeof l !== 'object' || l === null) bad(`${where}: line is not an object`)
  if (typeof l.move !== 'string' || !UCI_MOVE_RE.test(l.move))
    bad(`${where}: line move is not UCI-shaped: ${JSON.stringify(l.move)}`)
  const hasCp = l.cp !== undefined
  const hasMate = l.mate !== undefined
  if (hasCp === hasMate) bad(`${where}: line must carry exactly one of cp | mate`)
  if (hasCp && !Number.isSafeInteger(l.cp)) bad(`${where}: cp is not a safe integer`)
  if (hasMate) {
    if (!Number.isSafeInteger(l.mate)) bad(`${where}: mate is not a safe integer`)
    if (l.mate === 0) bad(`${where}: mate 0 cannot occur in a judged line (terminal position)`)
  }
}

/** ACPL/engine-match cp of a judged line, mover(=side-to-move) POV. */
export function acplLineCp(l: JudgeLine): number {
  return l.mate !== undefined ? mateToCp(l.mate) : (l.cp as number)
}

/**
 * Complexity cp of a judged line. The shipped probe map (botTime lineCpOf,
 * ported): mate → ±1000, cp clamped to ±1000.
 */
export function probeLineCp(l: JudgeLine): number {
  if (l.mate !== undefined) return l.mate > 0 ? 1000 : -1000
  const cp = l.cp as number
  return cp > 1000 ? 1000 : cp < -1000 ? -1000 : cp
}

// ---------------------------------------------------------------------------
// acplMicro / engineMatchMicro (aggregates over per-move scores)
// ---------------------------------------------------------------------------

/**
 * Average centipawn loss in micro-cp over already-derived per-move losses
 * (each an integer in [0, MAX_CPL_PER_MOVE] from sideMoveScores). Port of
 * accuracy.ts acpl(): empty ⇒ 0, per-move cap re-applied, mean capped at
 * MAX_CPL_MICRO, floor division (header formula).
 */
export function acplMicro(losses: readonly number[]): number {
  if (!Array.isArray(losses)) bad('acplMicro: losses is not an array')
  if (losses.length === 0) return 0
  let sum = 0
  for (const l of losses) {
    if (!isNonNegInt(l)) bad(`acplMicro: loss is not a non-negative safe integer: ${String(l)}`)
    sum += l > MAX_CPL_PER_MOVE ? MAX_CPL_PER_MOVE : l
  }
  return Math.min(MAX_CPL_MICRO, idiv(sum * 1_000_000, losses.length))
}

/**
 * Engine-match fraction in micro-units: floor(1e6·matched/scored); 0 when
 * nothing was scored (fail-safe low, J4 weights by `scored`).
 */
export function engineMatchMicro(matched: number, scored: number): number {
  if (!isNonNegInt(matched) || !isNonNegInt(scored) || matched > scored)
    bad(`engineMatchMicro: need 0 ≤ matched ≤ scored, got ${String(matched)}/${String(scored)}`)
  if (scored === 0) return 0
  return idiv(matched * 1_000_000, scored)
}

/** Is `playedCp` within the §8 score-equivalence window of ANY judged line?
 * The CALIBRATED criterion behind matched/matchMicro (header, including its
 * confirmed A5-14 degeneration for listed moves). */
export function isEngineMatched(playedCp: number, lines: readonly JudgeLine[]): boolean {
  if (!Number.isSafeInteger(playedCp)) bad('isEngineMatched: playedCp is not a safe integer')
  if (!Array.isArray(lines) || lines.length === 0) bad('isEngineMatched: empty lines')
  for (const l of lines) {
    checkLine(l, 'isEngineMatched')
    const d = playedCp - acplLineCp(l)
    if ((d >= 0 ? d : -d) <= PARAMS_A5.scoreEquivCp) return true
  }
  return false
}

/** Is `playedCp` within the score-equivalence window of the BEST (rank-1)
 * line? The §8-intended criterion (header [A5-14 DEFERRED]): the window is
 * live for every move (in-list or not) and never exact-move matching.
 * Same ±PARAMS_A5.scoreEquivCp width; lines beyond rank 1 are validated but
 * never widen the criterion. Feeds SideMoveScores.matchedBest (diagnostics
 * only) until the J6 refit promotes it. */
export function isEngineMatchedBest(playedCp: number, lines: readonly JudgeLine[]): boolean {
  if (!Number.isSafeInteger(playedCp)) bad('isEngineMatchedBest: playedCp is not a safe integer')
  if (!Array.isArray(lines) || lines.length === 0) bad('isEngineMatchedBest: empty lines')
  for (const l of lines) checkLine(l, 'isEngineMatchedBest')
  const d = playedCp - acplLineCp(lines[0])
  return (d >= 0 ? d : -d) <= PARAMS_A5.scoreEquivCp
}

// ---------------------------------------------------------------------------
// complexityMicro (the ported fold)
// ---------------------------------------------------------------------------

/**
 * The shipped complexityMultiplier fold over the judge's own MultiPV lines
 * (header: exact factors/order/clamp; unstable/surprise neutral-dropped).
 * Returns micro-units in [COMPLEXITY_FLOOR_MICRO, COMPLEXITY_CEIL_MICRO].
 */
export function complexityMicro(lines: readonly JudgeLine[]): number {
  if (!Array.isArray(lines) || lines.length === 0) bad('complexityMicro: empty lines')
  for (const l of lines) checkLine(l, 'complexityMicro')
  const best = probeLineCp(lines[0])
  let m = 1_000_000
  if (lines.length >= 2) {
    const raw = best - probeLineCp(lines[1])
    const gap = raw > 0 ? raw : 0 // signalsFromProbe: max(0, top1 − top2)
    if (gap < 15) m = idiv(m * 18, 10)
    else if (gap < 40) m = idiv(m * 145, 100)
    else if (gap < 90) m = idiv(m * 115, 100)
    else if (gap >= 250) m = idiv(m * 80, 100)
  }
  const abs = best < 0 ? -best : best
  if (abs >= 50 && abs <= 150) m = idiv(m * 130, 100)
  if (abs >= 400) m = idiv(m * 45, 100)
  return Math.max(COMPLEXITY_FLOOR_MICRO, Math.min(COMPLEXITY_CEIL_MICRO, m))
}

// ---------------------------------------------------------------------------
// clockForensicMicro
// ---------------------------------------------------------------------------

/** One mover-ply clock sample (derived by clockSamplesForSide). */
export type ClockSample = {
  /** Derived think time, ms (≥ 0, capped at CLOCK_THINK_CAP_MS). */
  thinkMs: number
  /** complexityMicro of the judged position the mover faced. */
  complexityMicro: number
}

/**
 * The think-time/complexity fit statistic (header: exact TV-misfit formula).
 * Range [0, 1e6]; low = suspicious; CLOCK_NEUTRAL_MICRO under
 * CLOCK_MIN_SAMPLE; 0 when a full sample thought 0ms total.
 */
export function clockForensicMicro(samples: readonly ClockSample[]): number {
  if (!Array.isArray(samples)) bad('clockForensicMicro: samples is not an array')
  let T = 0
  let C = 0
  for (const s of samples) {
    if (typeof s !== 'object' || s === null) bad('clockForensicMicro: sample is not an object')
    if (!isNonNegInt(s.thinkMs) || s.thinkMs > CLOCK_THINK_CAP_MS)
      bad(`clockForensicMicro: thinkMs out of range: ${String(s.thinkMs)}`)
    if (
      !isNonNegInt(s.complexityMicro) ||
      s.complexityMicro < COMPLEXITY_FLOOR_MICRO ||
      s.complexityMicro > COMPLEXITY_CEIL_MICRO
    )
      bad(`clockForensicMicro: complexityMicro out of range: ${String(s.complexityMicro)}`)
    T += s.thinkMs
    C += s.complexityMicro
  }
  if (samples.length < CLOCK_MIN_SAMPLE) return CLOCK_NEUTRAL_MICRO
  if (T === 0) return 0
  let misfit = 0
  for (const s of samples) {
    const a = idiv(s.thinkMs * 1_000_000, T)
    const e = idiv(s.complexityMicro * 1_000_000, C)
    misfit += a > e ? a - e : e - a
  }
  const fit = 1_000_000 - idiv(misfit, 2)
  return fit > 0 ? fit : 0
}

// ---------------------------------------------------------------------------
// trajectoryMicro
// ---------------------------------------------------------------------------

/**
 * OLS slope of per-game acplMicro over a chronological window (header
 * formula), micro-cp per game; negative = strengthening. n < 2 ⇒ 0.
 */
export function trajectoryMicro(acplMicros: readonly number[]): number {
  if (!Array.isArray(acplMicros)) bad('trajectoryMicro: window is not an array')
  const n = acplMicros.length
  if (n > TRAJ_MAX_WINDOW) bad(`trajectoryMicro: window ${n} exceeds TRAJ_MAX_WINDOW ${TRAJ_MAX_WINDOW}`)
  for (const y of acplMicros) {
    if (!isNonNegInt(y) || y > MAX_CPL_MICRO)
      bad(`trajectoryMicro: acplMicro out of range: ${String(y)}`)
  }
  if (n < 2) return 0
  let sy = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sy += acplMicros[i]
    sxy += i * acplMicros[i]
  }
  const sx = (n * (n - 1)) / 2
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6
  return idiv(n * sxy - sx * sy, n * sxx - sx * sx)
}

// ---------------------------------------------------------------------------
// Per-side derivation over (JudgeOutput, transcript)
// ---------------------------------------------------------------------------

/** The transcript slice Tier-1 needs (segment.ts SignedMove is assignable). */
export type TranscriptMove = {
  ply: number
  move: string
  clockMs: { w: number; b: number }
}

export type Side = 'w' | 'b'

/** Per-move scoring result for one side (see header rules (a)–(c)). */
export type SideMoveScores = {
  /** Per-move losses (each in [0, MAX_CPL_PER_MOVE]), scored moves only. */
  losses: readonly number[]
  /** Engine-matched count among scored moves (calibrated any-line window). */
  matched: number
  /** BEST-relative-window matched count (isEngineMatchedBest: the §8
   * corrected A5-14 criterion). Diagnostics only: NOT in Tier1Side/
   * Tier1Record and never a Tier-2 input until the J6 anchor refit
   * (header [A5-14 DEFERRED]). Invariant: matchedBest ≤ matched. */
  matchedBest: number
  /** Scored mover moves (ACPL + engine-match denominator). */
  scored: number
  /** Judged mover moves excluded under rule (c). */
  unscored: number
}

function moverOf(ply: number, firstMover: Side): Side {
  return (ply % 2 === 0) === (firstMover === 'w') ? 'w' : 'b'
}

function checkSide(s: unknown, what: string): asserts s is Side {
  if (s !== 'w' && s !== 'b') bad(`${what} must be 'w' | 'b', got ${String(s)}`)
}

/** Validate a JudgeOutput for Tier-1 use; returns positions keyed by ply. */
function checkJudgeOutput(out: JudgeOutput): Map<number, JudgedPosition> {
  if (typeof out !== 'object' || out === null) bad('JudgeOutput is not an object')
  if (out.v !== 1) bad(`JudgeOutput.v must be 1, got ${String((out as { v?: unknown }).v)}`)
  const c = out.config
  if (typeof c !== 'object' || c === null) bad('JudgeOutput.config missing')
  if (!isNonNegInt(c.nodes) || c.nodes <= 0) bad('JudgeOutput.config.nodes invalid')
  if (!isNonNegInt(c.multiPv) || c.multiPv <= 0) bad('JudgeOutput.config.multiPv invalid')
  if (!isNonNegInt(c.hashMb) || c.hashMb <= 0) bad('JudgeOutput.config.hashMb invalid')
  if (typeof c.params !== 'string' || c.params.length === 0) bad('JudgeOutput.config.params invalid')
  if (!Array.isArray(out.positions) || out.positions.length === 0)
    bad('JudgeOutput.positions must be a non-empty array')
  const byPly = new Map<number, JudgedPosition>()
  let prev = -1
  for (const p of out.positions) {
    if (typeof p !== 'object' || p === null) bad('judged position is not an object')
    if (!isNonNegInt(p.ply)) bad(`judged ply is not a non-negative safe integer`)
    if (p.ply <= prev) bad(`judged plies not strictly increasing (${p.ply} after ${prev})`)
    prev = p.ply
    // A5-01 bare-FEN pin: a verdict-path JudgedPosition is exactly {ply,
    // lines}. A moves/path field means the producer judged via the
    // `position fen <start> moves …` encoding: a different bit surface
    // than the normative bare-fenBefore one (transcriptToJudgePositions).
    if ((p as { moves?: unknown }).moves !== undefined)
      bad(`judged position at ply ${p.ply} carries a moves/path field. The verdict surface is bare-FEN only (transcriptToJudgePositions)`)
    if (!Array.isArray(p.lines) || p.lines.length === 0) bad(`empty lines at ply ${p.ply}`)
    if (p.lines.length > c.multiPv) bad(`${p.lines.length} lines > multiPv ${c.multiPv} at ply ${p.ply}`)
    for (const l of p.lines) checkLine(l, `ply ${p.ply}`)
    byPly.set(p.ply, p)
  }
  return byPly
}

/** Validate the transcript: contiguous plies from 0, bounded moves, integer clocks. */
function checkTranscript(moves: readonly TranscriptMove[]): void {
  if (!Array.isArray(moves) || moves.length === 0) bad('transcript is empty')
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    if (typeof m !== 'object' || m === null) bad(`transcript[${i}] is not an object`)
    if (m.ply !== i) bad(`transcript plies not contiguous from 0 (ply ${String(m.ply)} at index ${i})`)
    if (typeof m.move !== 'string' || m.move.length < 1 || m.move.length > 64)
      bad(`transcript[${i}].move is not a 1..64-char string`)
    const c = m.clockMs
    if (typeof c !== 'object' || c === null || !isNonNegInt(c.w) || !isNonNegInt(c.b))
      bad(`transcript[${i}].clockMs must carry non-negative safe-integer w and b`)
  }
}

/**
 * Derive the played-move eval (mover POV, mate-mapped) per header rules
 * (a)/(b), or null under rule (c).
 */
function playedCpOf(
  pos: JudgedPosition,
  played: string,
  next: JudgedPosition | undefined
): number | null {
  for (const l of pos.lines) {
    if (l.move === played) return acplLineCp(l) // (a) in-list, same-snapshot
  }
  if (next === undefined) return null // (c) unscored
  const top = next.lines[0] // (b) ground truth: next rank-1, negated to mover POV
  return top.mate !== undefined ? mateToCp(-top.mate) : -(top.cp as number)
}

/**
 * Score every judged move of `side`: per-move losses (ACPL), the
 * engine-match count, and the scored/unscored split (header rules).
 */
export function sideMoveScores(
  out: JudgeOutput,
  moves: readonly TranscriptMove[],
  side: Side,
  firstMover: Side = 'w'
): SideMoveScores {
  checkSide(side, 'side')
  checkSide(firstMover, 'firstMover')
  const byPly = checkJudgeOutput(out)
  checkTranscript(moves)
  for (const ply of byPly.keys()) {
    if (ply >= moves.length) bad(`judged ply ${ply} has no transcript move`)
  }
  const losses: number[] = []
  let matched = 0
  let matchedBest = 0
  let unscored = 0
  for (const [ply, pos] of byPly) {
    if (moverOf(ply, firstMover) !== side) continue
    const playedCp = playedCpOf(pos, moves[ply].move, byPly.get(ply + 1))
    if (playedCp === null) {
      unscored++
      continue
    }
    const raw = acplLineCp(pos.lines[0]) - playedCp
    losses.push(raw <= 0 ? 0 : raw > MAX_CPL_PER_MOVE ? MAX_CPL_PER_MOVE : raw)
    if (isEngineMatched(playedCp, pos.lines)) matched++
    if (isEngineMatchedBest(playedCp, pos.lines)) matchedBest++
  }
  return { losses, matched, matchedBest, scored: losses.length, unscored }
}

/**
 * The clock samples for `side` (header: t_i from the mover's own clock between
 * s's OWN ply i−2 and ply i snapshots, i ≥ 1; judged plies only, [A5-16]:
 * `before` is s's own prior snapshot, never the opponent's ply i−1 echo).
 *
 * [A5-15] `incMs` is the game's Fischer increment. The witness-signed
 * RatedBinding.tc.incMs (segment.ts), the ONLY verified time-control datum the
 * derivation needs. Because the signed snapshots are post-increment
 * (afterMoveCredit), the raw delta before−after already NETS OUT the increment
 * (= elapsed − incMs on a main-time move); crediting it back recovers the true
 * think time before the ≥0 clamp, so honest sub-increment play is no longer
 * aliased to the T=0 machine-pacing value. Default 0 ⇒ byte-for-byte the
 * pre-A5-15 delta (unrated / increment-free / callers not yet threading tc).
 * Byo-yomi periodMs is not a signed tc field and the period reset zeroes the
 * delta, so byo-yomi think-time is NOT recoverable here (header residual).
 */
export function clockSamplesForSide(
  out: JudgeOutput,
  moves: readonly TranscriptMove[],
  side: Side,
  firstMover: Side = 'w',
  incMs = 0
): ClockSample[] {
  checkSide(side, 'side')
  checkSide(firstMover, 'firstMover')
  if (!isNonNegInt(incMs) || incMs > CLOCK_INC_MAX_MS)
    bad(`clockSamplesForSide: incMs out of range [0, ${CLOCK_INC_MAX_MS}]: ${String(incMs)}`)
  const byPly = checkJudgeOutput(out)
  checkTranscript(moves)
  const samples: ClockSample[] = []
  for (const [ply, pos] of byPly) {
    if (ply < 1 || ply >= moves.length) continue
    if (moverOf(ply, firstMover) !== side) continue
    // [A5-16] `before` is the accused's OWN last self-signed remaining clock.
    // The snapshot from ITS previous move (ply−2, same mover parity). NOT the
    // opponent's echo at ply−1. A mover controls both fields of the clock it
    // signs, so consuming the opponent-signed ply−1 echo let the OPPONENT drive
    // t_i (hence clockFitMicro) to an extreme against an honest accused; this
    // mirrors the witness's ownClock discipline (witnessCore.ts finding A). In
    // honest play the two are equal (a side's clock is frozen during the
    // opponent's move) ⇒ byte-identical records; only adversarial transcripts
    // change. The second mover's opening reply (ply 1) has no own prior snapshot
    // and alone falls back to the ply−0 value. A single bounded sample.
    const prevOwn = ply - 2
    const before = prevOwn >= 0 ? moves[prevOwn].clockMs[side] : moves[ply - 1].clockMs[side]
    const after = moves[ply].clockMs[side]
    // Credit the increment back (see doc): before − after = elapsed − incMs on a
    // post-afterMoveCredit main-time snapshot, so + incMs recovers elapsed.
    const raw = before - after + incMs
    const thinkMs = raw <= 0 ? 0 : raw > CLOCK_THINK_CAP_MS ? CLOCK_THINK_CAP_MS : raw
    samples.push({ thinkMs, complexityMicro: complexityMicro(pos.lines) })
  }
  return samples
}

// ---------------------------------------------------------------------------
// Tier1Record: the canonical per-game unit (cjson-v1, integers only)
// ---------------------------------------------------------------------------

/** One side's Tier-1 signals (all non-negative safe integers, except the
 * signed trajectory slope). The seven CORE fields are digest-frozen:
 * SideMoveScores.matchedBest (A5-14) deliberately stays OUT of the record until
 * the J6-refit coordinated re-freeze (header). [A5-36] `trajectoryMicro` is the
 * lone OPTIONAL field: present iff the caller supplied this account's prior
 * acpl window; ABSENT ⇒ omitted by the codec ⇒ byte-identical legacy record
 * (the rdMicro/incMs discipline), so adding it re-froze no existing digest. */
export type Tier1Side = {
  /** Scored mover moves (ACPL + match denominator). */
  scored: number
  /** Judged mover moves excluded under ground-truth rule (c). */
  unscored: number
  /** Average centipawn loss, micro-cp (0 when scored = 0; weight by scored). */
  acplMicro: number
  /** Engine-matched count among scored moves. */
  matched: number
  /** Engine-match fraction, micro (0 when scored = 0). */
  matchMicro: number
  /** Think-time/complexity fit, micro (CLOCK_NEUTRAL_MICRO under min sample). */
  clockFitMicro: number
  /** Clock samples behind clockFitMicro. */
  clockN: number
  /** [A5-36] OPTIONAL OLS strength-trajectory slope (signed micro-cp/game) of
   * THIS account's chronological acpl window ENDING at this game (negative =
   * strengthening). Present ONLY when tier1Record was given priorAcplMicros for
   * this side; consumption into the Tier-2 z / trust T is DEFERRED to the J4
   * calibrated weight (no consumer reads it yet; see header). */
  trajectoryMicro?: number
}

/**
 * The canonical per-game Tier-1 record (header). J4's deterministic
 * escalation trigger and reganK-window aggregation consume these.
 */
export type Tier1Record = {
  v: 1
  /** Game key (caller-defined canonical id of the judged game). */
  game: string
  /** Ladder the game was rated on. */
  ladder: string
  /** judgeOutputDigest of the consumed JudgeOutput. */
  judge: string
  /** PARAMS_A5_DIGEST. Names the exact rule set (must match the config echo). */
  params: string
  w: Tier1Side
  b: Tier1Side
}

function tier1Side(
  out: JudgeOutput,
  moves: readonly TranscriptMove[],
  side: Side,
  firstMover: Side,
  incMs: number,
  priorAcplMicros: readonly number[] | undefined
): Tier1Side {
  const s = sideMoveScores(out, moves, side, firstMover)
  const clock = clockSamplesForSide(out, moves, side, firstMover, incMs)
  const acpl = acplMicro(s.losses)
  const base: Tier1Side = {
    scored: s.scored,
    unscored: s.unscored,
    acplMicro: acpl,
    matched: s.matched,
    matchMicro: engineMatchMicro(s.matched, s.scored),
    clockFitMicro: clockForensicMicro(clock),
    clockN: clock.length,
  }
  // [A5-36] Persist the strength-trajectory slope ONLY when the caller supplies
  // this account's PRIOR-game acpl window; this game's freshly-derived acplMicro
  // is appended as the newest point, so the stored slope is the window ENDING at
  // this game (header formula, fail-closed via trajectoryMicro's own guards).
  // Absent ⇒ the field is omitted (codec skips undefined) ⇒ byte-identical
  // record: every pre-A5-36 tier1Digest is untouched.
  if (priorAcplMicros === undefined) return base
  if (!Array.isArray(priorAcplMicros)) bad('tier1Record: priorAcplMicros side window is not an array')
  return { ...base, trajectoryMicro: trajectoryMicro([...priorAcplMicros, acpl]) }
}

/**
 * Build the canonical Tier1Record for one judged game. Fail-closed on any
 * malformed input, on a JudgeOutput whose config echo names a params
 * digest other than PARAMS_A5_DIGEST or whose (nodes, multiPv, hashMb) is not
 * the Tier-1 fixed-node config judgeConfigForTier(1), [A5-37] the digest pins
 * both tiers' rule set at once, so a Tier-1 signal may only be derived under the
 * exact rule set AND the exact fixed-node config it will be judged/anchored by,
 * and (the A5-01 coverage rule) on a JudgeOutput whose judged ply set is not EXACTLY
 * {0, 1, …, moves.length−1}: the normative verdict surface
 * (transcriptToJudgePositions) judges every transcript ply, bare-FEN, no
 * tail. A cherry-picked subset/gap would zero the micro signals and
 * nullify the deterministic escalation trigger, so it is rejected at this
 * trust boundary regardless of how the producer built its positions.
 * (Partial-view scoring stays available at the sideMoveScores level for
 * diagnostics only: it can never form a record.)
 *
 * [A5-15] `incMs`, the game's witness-signed Fischer increment
 * (RatedBinding.tc.incMs, segment.ts), is threaded into the clock-forensic
 * think-time derivation so honest sub-increment play is not aliased to the
 * maximal-suspicion clockFitMicro=0 (see clockSamplesForSide). It is a
 * derivation INPUT only, never stored in the record (the record shape and
 * every frozen tier1Digest stay untouched); a verifier recomputes with the
 * same signed tc. Default 0 ⇒ byte-identical to the pre-A5-15 record.
 *
 * [A5-36] `priorAcplMicros`. The account-on-each-side's PRIOR-game acpl window
 * (oldest→newest, EXCLUDING this game), keyed by color. When a side's window is
 * given, that Tier1Side persists trajectoryMicro([...window, thisGameAcpl]).
 * The §8 strength-trajectory slope of the window ending at this game (negative =
 * strengthening); a side with no window (or the whole arg omitted) carries no
 * trajectory field and is byte-identical to the pre-A5-36 record. It is a
 * DERIVATION INPUT the minting caller supplies from the account's already-minted
 * prior Tier1Records (each carries acplMicro); the per-game record just STORES
 * the slope. No verdict reads it yet: folding a σ-per-slope weight into the
 * Tier-2 z (gameDevMicro) or trust T (mm/trust.ts) is a calibration dial
 * (FPR tradeoff) DEFERRED to J4/J6.
 */
export function tier1Record(
  gameKey: string,
  ladderId: string,
  out: JudgeOutput,
  moves: readonly TranscriptMove[],
  firstMover: Side = 'w',
  incMs = 0,
  priorAcplMicros?: { readonly w?: readonly number[]; readonly b?: readonly number[] }
): Tier1Record {
  if (typeof gameKey !== 'string' || gameKey.length === 0) bad('gameKey must be a non-empty string')
  if (typeof ladderId !== 'string' || ladderId.length === 0) bad('ladderId must be a non-empty string')
  if (
    priorAcplMicros !== undefined &&
    (typeof priorAcplMicros !== 'object' || priorAcplMicros === null || Array.isArray(priorAcplMicros))
  )
    bad('tier1Record: priorAcplMicros must be an object with optional w/b acpl windows')
  checkJudgeOutput(out)
  checkTranscript(moves)
  // A5-01 full-coverage rule (normative): with judged plies already strictly
  // increasing, positions[i].ply === i for every i plus equal lengths pins
  // the judged set to exactly {0..moves.length−1}. Contiguous, complete,
  // none missing, none ≥ moves.length.
  if (out.positions.length !== moves.length)
    bad(
      `JudgeOutput judges ${out.positions.length} of ${moves.length} transcript plies. The verdict surface is every ply 0..${moves.length - 1} (full contiguous coverage required)`
    )
  for (let i = 0; i < out.positions.length; i++) {
    if (out.positions[i].ply !== i)
      bad(`judged ply set is not exactly {0..${moves.length - 1}}: position ${i} judges ply ${out.positions[i].ply}`)
  }
  if (out.config.params !== PARAMS_A5_DIGEST)
    bad(
      `JudgeOutput params echo ${JSON.stringify(out.config.params)} does not name PARAMS_A5_DIGEST. Refusing to derive Tier-1 signals under a foreign rule set`
    )
  // [A5-37] Canonical-config gate. PARAMS_A5_DIGEST pins BOTH tiers' rule set at
  // once (params.ts folds t1*/t2* into one digest), so the params echo alone does
  // NOT separate a Tier-1 output from a Tier-2 (t2Nodes/t2MultiPv) or a degenerate
  // (nodes=1) one: same digest, different search width ⇒ different bits. Those
  // signals are meaningful, and this record bit-reproducible, ONLY under the exact
  // fixed-node config the §8 anchors were fit at (judgeConfigForTier(1) =
  // t1Nodes/t1MultiPv/hashMb; TIER2_ANCHORS_JUDGE at 200k/MPV4). The record already
  // commits to the whole JudgeOutput through `judge` (canonicalHash covers config),
  // so pinning the config HERE is what makes a wrong-config record both unmintable
  // and unverifiable: a verifier's own tier1Record recompute re-runs this gate and
  // throws rather than reproducing junk. Require the config to equal the Tier-1 one.
  const cfg = out.config
  if (cfg.nodes !== PARAMS_A5.t1Nodes || cfg.multiPv !== PARAMS_A5.t1MultiPv || cfg.hashMb !== PARAMS_A5.hashMb)
    bad(
      `JudgeOutput config (nodes ${cfg.nodes}, multiPv ${cfg.multiPv}, hashMb ${cfg.hashMb}) is not the Tier-1 config (${PARAMS_A5.t1Nodes}/${PARAMS_A5.t1MultiPv}/${PARAMS_A5.hashMb}). Refusing to derive Tier-1 signals from a non-canonical judge config`
    )
  return {
    v: 1,
    game: gameKey,
    ladder: ladderId,
    judge: toB64u(canonicalHash(out as CanonicalObject)),
    params: PARAMS_A5_DIGEST,
    w: tier1Side(out, moves, 'w', firstMover, incMs, priorAcplMicros?.w),
    b: tier1Side(out, moves, 'b', firstMover, incMs, priorAcplMicros?.b),
  }
}

/** canonicalHash of a Tier1Record, base64url. The cross-platform parity unit. */
export function tier1Digest(rec: Tier1Record): string {
  return toB64u(canonicalHash(rec as CanonicalObject))
}

// ---------------------------------------------------------------------------
// Tier1Anchors: ACPL vs estimated strength (values INJECTED by brick J3)
// ---------------------------------------------------------------------------

/**
 * The estElo-at-judge-config anchor data the ACPL-vs-strength expectation
 * consumes. J3 re-runs the corpus/fit harness at (t1Nodes, t1MultiPv) and
 * produces the real values; consumers must inject an anchor set whose
 * (nodes, multiPv) match the JudgeOutput config they are judging against.
 */
export type Tier1Anchors = {
  v: 1
  /** Judge config the anchor fit was run at. */
  nodes: number
  multiPv: number
  /** elo (ascending) → expected mean per-game ACPL, micro-cp (descending). */
  acplByElo: readonly { elo: number; acplMicro: number }[]
  /** Residual std of per-game ACPL about the curve, micro-cp (J4's z scale). */
  sigmaAcplMicro: number
  /** Provenance tag; '[J3-REFIT-PENDING]…' until J3 lands real values. */
  fit: string
}

/**
 * [J3-REFIT-PENDING]: PROVISIONAL anchors, NOT calibrated at the judge
 * config. Derivation: the shipped depth-12 MultiPV-2 fit's log(1+acpl)→Elo
 * knots (src/main/analysis/estElo.ts ACPL_KNOTS, fit 2026-07-06) inverted to
 * elo→acpl via acpl = e^la − 1, precomputed offline to integer micro-cp.
 * sigmaAcplMicro ≈ the shipped no-opp residual std (~455 Elo at 30 moves)
 * mapped through the local curve slope (~0.035 cp/Elo near 1500) ⇒ ~16 cp.
 * Spec §8 is explicit that this fit DOES NOT TRANSFER to the judge's
 * fixed-node config: these values must never feed T. They exist so J2/J4
 * code and suites can run against the real SHAPE until J3 injects the refit.
 */
export const TIER1_ANCHORS_PROVISIONAL: Tier1Anchors = {
  v: 1,
  nodes: PARAMS_A5.t1Nodes,
  multiPv: PARAMS_A5.t1MultiPv,
  acplByElo: [
    { elo: 400, acplMicro: 116_331_117 },
    { elo: 600, acplMicro: 105_804_494 },
    { elo: 800, acplMicro: 82_179_423 },
    { elo: 1000, acplMicro: 68_338_479 },
    { elo: 1263, acplMicro: 58_145_470 },
    { elo: 1500, acplMicro: 50_779_794 },
    { elo: 1700, acplMicro: 43_035_671 },
    { elo: 1900, acplMicro: 38_251_906 },
    { elo: 2100, acplMicro: 36_151_346 },
    { elo: 2300, acplMicro: 31_233_297 },
    { elo: 2500, acplMicro: 22_382_783 },
    { elo: 2700, acplMicro: 19_968_053 },
  ],
  sigmaAcplMicro: 16_000_000,
  fit: '[J3-REFIT-PENDING] inverted shipped depth-12 MultiPV-2 fit (elo-fit.json 2026-07-06). Must not feed T',
}

function checkAnchors(a: Tier1Anchors): void {
  if (typeof a !== 'object' || a === null || a.v !== 1) bad('anchors: not a v1 Tier1Anchors')
  if (!isNonNegInt(a.nodes) || a.nodes <= 0 || !isNonNegInt(a.multiPv) || a.multiPv <= 0)
    bad('anchors: invalid judge config echo')
  if (!isNonNegInt(a.sigmaAcplMicro) || a.sigmaAcplMicro <= 0) bad('anchors: invalid sigmaAcplMicro')
  if (!Array.isArray(a.acplByElo) || a.acplByElo.length < 2) bad('anchors: need ≥ 2 knots')
  let prevElo = -1
  for (const k of a.acplByElo) {
    if (typeof k !== 'object' || k === null) bad('anchors: knot is not an object')
    if (!isNonNegInt(k.elo) || k.elo <= prevElo) bad('anchors: knot elos must be ascending safe integers')
    if (!isNonNegInt(k.acplMicro) || k.acplMicro === 0 || k.acplMicro > MAX_CPL_MICRO)
      bad('anchors: knot acplMicro out of range')
    prevElo = k.elo
  }
}

/**
 * Expected per-game ACPL (micro-cp) at estimated strength `elo` under an
 * injected anchor set: piecewise-linear between knots (floor-division
 * interpolation), clamped to the end knots outside the fitted range. J4's
 * ACPL-vs-strength term compares observed acplMicro against this, scaled by
 * anchors.sigmaAcplMicro.
 */
export function expectedAcplMicro(anchors: Tier1Anchors, elo: number): number {
  checkAnchors(anchors)
  if (typeof elo !== 'number' || !Number.isSafeInteger(elo)) bad('expectedAcplMicro: elo must be a safe integer')
  const ks = anchors.acplByElo
  if (elo <= ks[0].elo) return ks[0].acplMicro
  const last = ks[ks.length - 1]
  if (elo >= last.elo) return last.acplMicro
  for (let i = 1; i < ks.length; i++) {
    if (elo <= ks[i].elo) {
      const a = ks[i - 1]
      const b = ks[i]
      // floor interp; slope may be negative (acpl falls as elo rises)
      return a.acplMicro + idiv((elo - a.elo) * (b.acplMicro - a.acplMicro), b.elo - a.elo)
    }
  }
  return last.acplMicro // unreachable
}
