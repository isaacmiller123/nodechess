// A4 display states (spec §6, brick 2a). The rendering rule every client
// derives identically from public data:
//   Placement (n/10) → Provisional (n/reveal) → Ranked (rating).
// Hiding is a RENDERING rule (§6 honest limit C-4): the precise number is
// always computable by a modified client, but every compliant client renders
// these states, on every surface, for everyone: a rating is a judgment other
// machines make. The per-category reveal thresholds live in PARAMS_A4
// (ladders.ts revealThreshold).
//
// DISPLAY ROUNDING (micro → display Elo): rating = Math.floor(rMicro / 1e6),
// floor toward −∞: EXACTLY mm/pairing.ts's eloOf, so the rendered number,
// the pairing-cost distance, and the spillover bracket rails all quantize one
// way (a micro rating on a rail boundary lands in the same bracket for every
// rule). Exact: |rMicro| < 2^53 and floor of a correctly-rounded quotient of
// a safe integer by 1e6 cannot cross an integer boundary.
//
// DisplayState is STRUCTURALLY IDENTICAL to its twin in mm/pairing.ts (the
// kickoff's shared union: the cross-brick contract). It is deliberately NOT
// imported from mm/ (nor exported to it): each module compiles standalone;
// TypeScript's structural typing makes values interchangeable. Do not let the
// shapes drift: the suite asserts a pairViewOf(...) feeds mm pairingLegal.
//
// Platform-neutral, pure integer math: no `node:` imports, no DOM, no time.

import type { B64u } from '../types'
import { revealThreshold, type RatedCategory } from './ladders'
import { PARAMS_A4 } from './params'

/** §6 display union: twin of mm/pairing.ts DisplayState (see header).
 * 'banned' (A5 J4) is an ACTIVE §8/§9 ban on the ladder at the evaluated
 * wts: a PUBLIC fact (bans derive from public signed records), rendered
 * honestly to everyone; `until` = ban expiry wts. */
export type DisplayState =
  | { state: 'placement'; n: number; of: number }
  | { state: 'provisional'; n: number; of: number }
  | { state: 'ranked'; rating: number }
  | { state: 'banned'; until: number }

/**
 * Derive the §6 display state for one ladder. `ladder` is the fold's stored
 * ladder state (fold.ts LadderState; only n and r are read, so a fresh
 * ladderInit() renders Placement 0/10 for a never-played ladder):
 *   ban active at atWts (A5 J4)   → banned (until: see below)
 *   n < placementGames            → placement (n / 10)
 *   n < revealThreshold(category) → provisional (n / reveal)
 *   else                          → ranked (display-Elo, floor, header rule)
 * `ban` is the fold's bans[ladderId] entry for this ladder (fold.ts
 * LadderBan: only `until` is read; injected suppression evidence,
 * judge/tier2.ts, may feed it too) and `atWts` the caller's evaluation
 * instant (the same protocol-pinned wts convention as pairingLegal's atWts,
 * NEVER ambient now). Active ⇔ until > atWts, both safe integers; an
 * expired or malformed ban falls through to the normal states. Both
 * parameters are additive-optional: omitting them is exactly the pre-A5
 * rendering (no ban information supplied).
 */
export function displayState(
  ladder: { n: number; r: number },
  category: RatedCategory,
  ban?: { until: number },
  atWts?: number,
): DisplayState {
  if (
    ban !== undefined &&
    atWts !== undefined &&
    Number.isSafeInteger(ban.until) &&
    Number.isSafeInteger(atWts) &&
    ban.until > atWts
  )
    return { state: 'banned', until: ban.until }
  if (ladder.n < PARAMS_A4.placementGames)
    return { state: 'placement', n: ladder.n, of: PARAMS_A4.placementGames }
  const of = revealThreshold(category)
  if (ladder.n < of) return { state: 'provisional', n: ladder.n, of }
  return { state: 'ranked', rating: Math.floor(ladder.r / 1_000_000) }
}

/**
 * One side of a §7 pairing-legality check. Twin of mm/pairing.ts PairView
 * (structurally identical; not imported, see header). ratingMicro/rdMicro are
 * the protocol quantities, tMicro the §7 trust score at the pairing record's
 * witnessed timestamp (the pairingLegal `atWts`. See pairViewOf), display
 * the §6 state.
 */
export interface PairView {
  root: B64u
  ladderId: string
  ratingMicro: number
  rdMicro: number
  tMicro: number
  display: DisplayState
  /** A5 J4: fold bans[ladderId].until when a selfban exists (twin of the mm
   * member), pairingLegal compares it to atWts. Absent = no ban on record. */
  banUntilWts?: number
}

/**
 * Compose the mm PairView input for one ladder from public state: the
 * account root, the ladder id, the ladder's micro numbers, the trust score,
 * and the derived display state. LADDER SOURCE (A4-02): for any judgment
 * about ANOTHER account (opponent views, pairing legality, leaderboards)
 * `ladderState` must be the verifier's own roster-VOUCHED ladder:
 * ratings/fold.ts ratingEvidenceOf(chain, eligible).ladders[ladderId]. Not
 * a raw embedded claim; the fold's embedded ladder is the deterministic
 * seed-pinned FLOOR (byte-identical to the no-roster evidence output), so
 * passing it is always SAFE (never inflated), merely under-stated. `tMicro` is mm/trust.ts trustT
 * evaluated at the PAIRING RECORD's witnessed timestamp, the exact `atWts`
 * later passed to pairingLegal (A4-16 pinned-evaluation-time convention),
 * NEVER the caller's ambient now, so both clients compute the identical T
 * for the identical instant and verify the pairing with mm/pairing.ts
 * pairingLegal. A5 J4 (additive-optional): pass the fold's bans[ladderId]
 * entry as `ban` plus the SAME atWts to surface an active ban. The view
 * then carries banUntilWts and a 'banned' display, and pairingLegal at that
 * atWts refuses it.
 */
export function pairViewOf(
  root: B64u,
  ladderId: string,
  ladderState: { n: number; r: number; rd: number },
  tMicro: number,
  category: RatedCategory,
  ban?: { until: number },
  atWts?: number,
): PairView {
  return {
    root,
    ladderId,
    ratingMicro: ladderState.r,
    rdMicro: ladderState.rd,
    tMicro,
    display: displayState(ladderState, category, ban, atWts),
    ...(ban !== undefined && Number.isSafeInteger(ban.until) ? { banUntilWts: ban.until } : {}),
  }
}
