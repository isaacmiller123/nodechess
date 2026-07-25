// A4 deterministic Glicko-2 (spec §6, brick 2a). An EXACT port of the app's
// shipped src/main/rating/glicko2.ts (Glickman spec: same SCALE, same
// RD_MIN/RD_MAX clamps, same Illinois regula-falsi volatility loop with the
// 100-iteration cap and 1e-6 epsilon, same no-games RD-growth branch) with the
// implementation-approximated Math calls swapped for the 1a detmath module:
//   Math.exp  → dexp        (fdlibm, bit-identical across engines)
//   Math.log  → dln
//   Math.pow(x, 2) → x·x    (basic op, correctly rounded)
//   Math.PI:    an exact spec constant, kept
//   Math.sqrt: a correctly-rounded IEEE-754 basic op, kept
// Every other operation is + − × ÷ / min / max / abs in the SAME evaluation
// order as the source file, so on identical double inputs every conforming JS
// engine computes identical double outputs, and identical micro outputs.
//
// ── MICRO-UNIT BOUNDARY (the fold's integer contract) ──────────────────────
// Fold state is integers only (canonical codec rule), so the exported update
// takes and returns {ratingMicro, rdMicro, volMicro}, fixed-point ×10⁶.
//
//   micro → double:  x = m / 1e6. ONE correctly-rounded IEEE division.
//     Deterministic by ECMA-262.
//   double → micro:  m = Math.floor(x·1e6 + 0.5), ROUND-HALF-UP. The multiply
//     and add are correctly rounded, floor is exact, so the result is a pure
//     function of the double x, and x itself is bit-identical everywhere
//     (above). Chosen over Math.round for an explicit, self-documenting rule
//     (Math.round is the same half-up on positives; the floor form also pins
//     the negative-tie direction: toward +∞). Range: Glicko ratings/RDs/vols
//     keep |x·1e6 + 0.5| far below 2^53, so the float result is the exact
//     integer: no precision cliff.
//
// One SEGMENT = one single-game rating period: the fold calls the update with
// exactly one game per segment (fold.ts); the games=[] RD-growth branch is
// ported for completeness/parity but unused by the A4 fold (no idle decay).
//
// Platform-neutral: no `node:` imports, no DOM, no ambient time, no
// Math.exp/log/pow.

import { PARAMS_A4 } from './params'
import { dexp, dln } from './detmath'

/** Glicko-2 scale constant: verbatim from src/main/rating/glicko2.ts. */
export const SCALE = 173.7178
/** RD clamps (= PARAMS_A4.rdMin/rdMax = the shipped glicko2.ts 30/350). */
const RD_MAX = PARAMS_A4.rdMax
const RD_MIN = PARAMS_A4.rdMin
/** Default tau (PARAMS_A4.tauMicro/1e6 = the shipped 0.5). */
const TAU_DEFAULT = PARAMS_A4.tauMicro / 1_000_000

// ---------------------------------------------------------------------------
// Float core: the exact glicko2.ts math on detmath transcendentals
// ---------------------------------------------------------------------------

export interface Glicko {
  rating: number
  rd: number
  vol: number
}

export interface Opponent {
  rating: number
  rd: number
  /** 1 win, 0.5 draw, 0 loss (all exactly representable doubles). */
  score: number
}

/**
 * Deterministic float-level Glicko-2 update: glicko2Update ported verbatim
 * (see header). Exposed for the suite's cross-check against the shipped
 * float implementation; fold code goes through glickoUpdateMicro.
 */
export function glicko2UpdateDet(p: Glicko, games: readonly Opponent[], tau = TAU_DEFAULT): Glicko {
  // No games this period: only RD grows toward the prior.
  if (games.length === 0) {
    const phi = p.rd / SCALE
    const phiStar = Math.sqrt(phi * phi + p.vol * p.vol)
    return { rating: p.rating, rd: Math.min(phiStar * SCALE, RD_MAX), vol: p.vol }
  }

  const mu = (p.rating - 1500) / SCALE
  const phi = p.rd / SCALE
  const g = (ph: number): number => 1 / Math.sqrt(1 + (3 * ph * ph) / (Math.PI * Math.PI))
  const expect = (muj: number, phj: number): number => 1 / (1 + dexp(-g(phj) * (mu - muj)))

  let vInv = 0
  let deltaSum = 0
  for (const o of games) {
    const muj = (o.rating - 1500) / SCALE
    const phj = o.rd / SCALE
    const gj = g(phj)
    const ej = expect(muj, phj)
    vInv += gj * gj * ej * (1 - ej)
    deltaSum += gj * (o.score - ej)
  }
  const v = 1 / vInv
  const delta = v * deltaSum

  // Volatility via Illinois (regula falsi). Cap and epsilon verbatim.
  const a = dln(p.vol * p.vol)
  const f = (x: number): number => {
    const ex = dexp(x)
    const den = phi * phi + v + ex // Math.pow(den, 2) → den·den (exact-op form)
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (den * den)) - (x - a) / (tau * tau)
  }
  let A = a
  let B: number
  if (delta * delta > phi * phi + v) {
    B = dln(delta * delta - phi * phi - v)
  } else {
    let k = 1
    while (f(a - k * tau) < 0) k++
    B = a - k * tau
  }
  let fA = f(A)
  let fB = f(B)
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA)
    const fC = f(C)
    if (fC * fB <= 0) {
      A = B
      fA = fB
    } else {
      fA = fA / 2
    }
    B = C
    fB = fC
  }
  const newVol = dexp(A / 2)

  const phiStar = Math.sqrt(phi * phi + newVol * newVol)
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v)
  const newMu = mu + newPhi * newPhi * deltaSum

  return {
    rating: newMu * SCALE + 1500,
    rd: Math.max(RD_MIN, Math.min(newPhi * SCALE, RD_MAX)),
    vol: newVol,
  }
}

// ---------------------------------------------------------------------------
// Micro-unit boundary
// ---------------------------------------------------------------------------

/** Integer micro-unit Glicko state (×10⁶): the fold's ladder numbers. */
export interface GlickoMicro {
  ratingMicro: number
  rdMicro: number
  volMicro: number
}

export interface OpponentMicro {
  ratingMicro: number
  rdMicro: number
  /** 1 win, 0.5 draw, 0 loss. */
  score: number
}

/** double → micro: round-half-up, floor(x·1e6 + 0.5). See header. */
export function toMicro(x: number): number {
  return Math.floor(x * 1_000_000 + 0.5)
}

/** micro → double: one correctly-rounded IEEE division. See header. */
export function fromMicro(m: number): number {
  return m / 1_000_000
}

/**
 * The fold's rating update: integer micro state in, integer micro state out.
 * Internally: convert each micro input to a double (one exact-order division
 * each), run the verbatim float core, round each output half-up back to
 * micro. Deterministic end to end (header argument).
 */
export function glickoUpdateMicro(
  p: GlickoMicro,
  games: readonly OpponentMicro[],
  tauMicro: number = PARAMS_A4.tauMicro,
): GlickoMicro {
  const out = glicko2UpdateDet(
    { rating: fromMicro(p.ratingMicro), rd: fromMicro(p.rdMicro), vol: fromMicro(p.volMicro) },
    games.map((o) => ({ rating: fromMicro(o.ratingMicro), rd: fromMicro(o.rdMicro), score: o.score })),
    fromMicro(tauMicro),
  )
  return { ratingMicro: toMicro(out.rating), rdMicro: toMicro(out.rd), volMicro: toMicro(out.vol) }
}
