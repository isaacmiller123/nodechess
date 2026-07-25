// A4 pairing math (spec §7, brick 2b): trust-width matchmaking legality as
// pure functions over plain-value inputs. BOTH clients recompute and verify a
// pairing was legal (§14-A4 proof obligation): every function here is
// deterministic integer math, total, and symmetric where the spec demands it
// (pairingLegal(a, b) ≡ pairingLegal(b, a), asserted in the suite).
//
// DISPLAY-STATE CONTRACT: `DisplayState` below is the kickoff's shared union.
// It is DEFINED here (not imported from ratings/display.ts, which another
// brick builds in parallel) so mm/ compiles standalone; the union's shape is
// the cross-brick contract and must not drift.
//
// ── FORMULAS (exact, integer) ──────────────────────────────────────────────
//
// WIDTH (PARAMS_A4): width(T) = widthMin + widthSpan·(1 − T)² in integer Elo.
//   With T in micro-units, u = 1e6 − clamp(T, 0, 1e6):
//     width = widthMin + floor(widthSpan · u · u / 1e12)
//   ROUNDING: single floor at the end (u·u ≤ 1e12, ·450 ≤ 4.5e14 < 2^53,
//   exact in float64). Goldens: T=1e6 → 50, T=0 → 500, T=500_000 → 162.
//
// ISLAND (PARAMS_A4): when EITHER side's T < islandGateMicro, the pairing
// cost gains an Elo-equivalent penalty attracting comparable-suspicion
// accounts to each other:
//     islandCostElo = floor(islandCoefMicro · |T_a − T_b| · islandScale / 1e12)
//   (≤ 1.75e14 before the divide: exact), else 0. |T_a−T_b| small ⇒ tiny
//   cost ⇒ suspicious accounts pair among themselves.
//
// BRACKETS (§6/§7 spillover): fixed rails, multiples of bracketWidth (800):
// …, [-800,0), [0,800), [800,1600), [1600,2400), …, bracketOf(rating) =
// {lo: floor(rating/800)·800, hi: lo+800} with floor toward −∞ (Math.floor),
// so negative ratings rail correctly (−1 → [−800, 0)). A rating exactly on a
// rail belongs to the bracket it opens (1600 → [1600, 2400)).
//
// ELO FROM MICRO: eloOf = floor(ratingMicro / 1e6), floor toward −∞.
//
// PINNED EVALUATION TIME (A4 review fix A4-16): trustT's age term is monotone
// in witnessed time, so T, width(T), and islandCostElo are time-dependent.
// Without one protocol-pinned instant, two honest verifiers evaluating the
// same pairing at different "now"s reach contradictory legality verdicts near
// a width/island boundary. pairingLegal therefore takes `atWts`. The PAIRING
// RECORD's witnessed timestamp (§4 witnessed time, the one instant both
// clients share), and each side's PairView.tMicro MUST be trustT evaluated
// at that SAME atWts (see PairView). There is deliberately NO 2-arg form:
// atWts is required, and a malformed atWts (non-safe-integer, negative,
// undefined from an untyped caller) fails CLOSED as 'bad-at-wts'.
//
// PAIRING LEGALITY (pairingLegal(a, b, atWts)). Rule order, all symmetric:
//   0. atWts not a safe integer ≥ 0          → illegal 'bad-at-wts'
//   1. a.root === b.root                     → illegal 'same-root'
//   2. a.ladderId !== b.ladderId             → illegal 'ladder-mismatch'
//  2b. EITHER side carries an ACTIVE ban for the ladder at atWts (§8/§9,
//      A5 J4) → illegal 'banned'. Active = banUntilWts > atWts, OR the
//      side's display state is 'banned' with until > atWts (both signals
//      honored: the fold's `bans` entry feeds banUntilWts, the display
//      union carries the same fact). Bans are derived from public signed
//      records (in-chain selfban / injected suppression evidence): a
//      banned ladder simply cannot pair, in the unranked pool too.
//   3. neither ranked (placement/provisional) → LEGAL. The provisional-first
//      pool carries zero rating signal; no rating math at all.
//   4. exactly one ranked (spillover)        → legal iff BOTH sides sit on
//      the SAME fixed rail: bracketOf(eloOf(a)).lo === bracketOf(eloOf(b)).lo,
//      else 'bracket-mismatch'. The provisional's protocol rating enters ONLY
//      through its quantized bracket, NEVER a precise-rating distance
//      against a hidden number (§6: the bracket is a protocol quantity).
//      RD-DISCOUNT NOTE: no extra rule is needed to keep these games cheap.
//      The ranked side's Glicko-2 update discounts by the provisional's high
//      RD naturally, so spillover barely moves a ranked rating (§7).
//   5. ranked × ranked → cost = |eloOf(a) − eloOf(b)| + islandCostElo(Ta, Tb);
//      legal iff cost ≤ width(Ta) AND cost ≤ width(Tb) (BOTH sides' curves
//      bind. High trust earns precision and cannot be dragged wide by a
//      low-trust counterpart), else 'width-exceeded'.
//
// PROVISIONAL INFORMATION RULE (§6, pure helpers): a placement/provisional
// VIEWER gets nothing rating-shaped about anyone. Every surface shows
// 'unranked-pool'. A ranked viewer (and any spectator, who has no PairView:
// use spectatorOpponentInfo) sees the quantized bracket ONLY for a
// placement/provisional opponent, and the full revealed rating for a ranked
// opponent.
//
// Platform-neutral: no `node:` imports, no DOM, no ambient time, pure integer
// math throughout (no Math.exp/log/pow).

import { PARAMS_A4 } from '../ratings/params'
import type { B64u } from '../types'

// ---------------------------------------------------------------------------
// Display states (the kickoff's shared union: defined HERE, see header)
// ---------------------------------------------------------------------------

export type DisplayState =
  | { state: 'placement'; n: number; of: number }
  | { state: 'provisional'; n: number; of: number }
  | { state: 'ranked'; rating: number }
  /** A5 J4: an active §8/§9 ban on this ladder at the evaluated wts. A
   * PUBLIC fact (bans derive from public signed records, §9), rendered
   * honestly to everyone on every surface. `until` = ban expiry wts. */
  | { state: 'banned'; until: number }

/**
 * One side of a pairing-legality check. A plain-value projection both
 * clients can compute from public data. `ratingMicro`/`rdMicro` are the
 * protocol quantities (micro-units); `tMicro` is the §7 trust score:
 * mm/trust.ts trustT evaluated AT THE PAIRING RECORD'S WITNESSED TIMESTAMP,
 * i.e. the exact `atWts` passed to pairingLegal (A4-16 pinned evaluation
 * time; ratings/display.ts pairViewOf composes this projection); `display`
 * the §6 display state.
 */
export interface PairView {
  root: B64u
  ladderId: string
  ratingMicro: number
  rdMicro: number
  tMicro: number
  display: DisplayState
  /** A5 J4: the fold's bans[ladderId].until for this ladder, when a selfban
   * exists (ratings/fold.ts LadderBan). Compared against pairingLegal's
   * atWts; absent = no ban on record. Injected suppression evidence may
   * feed this too (judge/tier2.ts, read-time fact, never folded). */
  banUntilWts?: number
}

export interface PairingVerdict {
  legal: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Curve, island, brackets
// ---------------------------------------------------------------------------

function clampMicro(t: number): number {
  return Math.min(1_000_000, Math.max(0, t))
}

/** Integer Elo from a micro-unit rating, floor toward −∞. */
export function eloOf(ratingMicro: number): number {
  return Math.floor(ratingMicro / 1_000_000)
}

/** Pairing width in integer Elo: widthMin + widthSpan·(1−T)², floor-rounded. */
export function width(tMicro: number): number {
  const u = 1_000_000 - clampMicro(tMicro)
  return PARAMS_A4.widthMin + Math.floor((PARAMS_A4.widthSpan * u * u) / 1_000_000_000_000)
}

/** Island term (Elo-equivalent cost): 0 unless either side's T is below the
 * gate; then islandCoefMicro·|T_a−T_b|·islandScale, floor-rounded. */
export function islandCostElo(taMicro: number, tbMicro: number): number {
  const ta = clampMicro(taMicro)
  const tb = clampMicro(tbMicro)
  if (ta >= PARAMS_A4.islandGateMicro && tb >= PARAMS_A4.islandGateMicro) return 0
  const d = ta > tb ? ta - tb : tb - ta
  return Math.floor((PARAMS_A4.islandCoefMicro * d * PARAMS_A4.islandScale) / 1_000_000_000_000)
}

/** Fixed spillover rail containing `rating` (integer Elo): multiples of
 * bracketWidth, floor toward −∞. The bracket is [lo, hi). */
export function bracketOf(rating: number): { lo: number; hi: number } {
  const w = PARAMS_A4.bracketWidth
  const lo = Math.floor(rating / w) * w
  return { lo, hi: lo + w }
}

/** Rule 2b (header): does `v` carry an ACTIVE ladder ban at atWts? Honors
 * both signals: the fold-fed banUntilWts and the 'banned' display state
 * (each an integer wts compared to atWts; a malformed value is no ban). */
function hasActiveBan(v: PairView, atWts: number): boolean {
  if (typeof v.banUntilWts === 'number' && Number.isSafeInteger(v.banUntilWts) && v.banUntilWts > atWts) return true
  return v.display.state === 'banned' && Number.isSafeInteger(v.display.until) && v.display.until > atWts
}

// ---------------------------------------------------------------------------
// Pairing legality
// ---------------------------------------------------------------------------

/**
 * The §7 pairing-legality check. Pure, symmetric, both-sides-verifiable.
 * See the header for the exact rule order. `atWts` is the pairing record's
 * witnessed timestamp: the protocol-pinned instant BOTH sides' tMicro were
 * evaluated at (trustT(inputs, rep, atWts, evidence)); a verifier auditing a
 * pairing recomputes each T at this same atWts and then calls this function
 * with the same three values, so verdicts can never flip with the auditor's
 * clock (A4-16). Required. A missing/malformed atWts fails closed.
 */
export function pairingLegal(a: PairView, b: PairView, atWts: number): PairingVerdict {
  if (!Number.isSafeInteger(atWts) || atWts < 0) return { legal: false, reason: 'bad-at-wts' }
  if (a.root === b.root) return { legal: false, reason: 'same-root' }
  if (a.ladderId !== b.ladderId) return { legal: false, reason: 'ladder-mismatch' }
  if (hasActiveBan(a, atWts) || hasActiveBan(b, atWts)) return { legal: false, reason: 'banned' }
  const aRanked = a.display.state === 'ranked'
  const bRanked = b.display.state === 'ranked'
  if (!aRanked && !bRanked) return { legal: true } // provisional-first pool
  if (aRanked !== bRanked) {
    // Spillover: bracket math ONLY. Never precise distance vs a provisional.
    return bracketOf(eloOf(a.ratingMicro)).lo === bracketOf(eloOf(b.ratingMicro)).lo
      ? { legal: true }
      : { legal: false, reason: 'bracket-mismatch' }
  }
  const diff = Math.abs(eloOf(a.ratingMicro) - eloOf(b.ratingMicro))
  const cost = diff + islandCostElo(a.tMicro, b.tMicro)
  if (cost <= width(a.tMicro) && cost <= width(b.tMicro)) return { legal: true }
  return { legal: false, reason: 'width-exceeded' }
}

// ---------------------------------------------------------------------------
// Provisional information rule (§6 surface projections)
// ---------------------------------------------------------------------------

export type OpponentInfo =
  /** Provisional/placement viewer: NOTHING rating-shaped, any opponent. */
  | { kind: 'unranked-pool' }
  /** Ranked viewer/spectator on a placement/provisional opponent: the
   * quantized bracket only. */
  | { kind: 'bracket'; lo: number; hi: number }
  /** Ranked viewer/spectator on a ranked opponent: the revealed rating. */
  | { kind: 'rating'; rating: number }
  /** ANY viewer on a banned opponent (A5 J4): §9 bans derive from public
   * signed records. A PUBLIC fact, rendered honestly to everyone (the §6
   * information rule hides RATINGS, never bans). */
  | { kind: 'banned'; until: number }

/** What a spectator surface (no PairView of its own) MAY show about `opp`.
 * The ranked-viewer projection (§6: ranked players + spectators see the
 * bracket for provisionals, the full rating for ranked; a BAN is shown
 * as-is: a public §9 fact, never rating-shaped). */
export function spectatorOpponentInfo(opp: PairView): OpponentInfo {
  if (opp.display.state === 'banned') return { kind: 'banned', until: opp.display.until }
  if (opp.display.state === 'ranked') return { kind: 'rating', rating: opp.display.rating }
  return { kind: 'bracket', ...bracketOf(eloOf(opp.ratingMicro)) }
}

/** What `viewer`'s surfaces MAY show about `opp` (§6). A placement or
 * provisional viewer gets 'unranked-pool': no rating, no bracket, on ANY
 * surface (matchmaking, in-game, post-game); a ranked viewer gets the
 * spectator projection. EXCEPTION (A5 J4): a banned opponent renders
 * 'banned' to EVERY viewer, ranked or not: §9 bans are public facts and
 * carry no rating information. */
export function visibleOpponentInfo(viewer: PairView, opp: PairView): OpponentInfo {
  if (opp.display.state === 'banned') return { kind: 'banned', until: opp.display.until }
  if (viewer.display.state !== 'ranked') return { kind: 'unranked-pool' }
  return spectatorOpponentInfo(opp)
}
