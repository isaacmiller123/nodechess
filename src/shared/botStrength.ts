// Measured bot strength: the SINGLE SOURCE OF TRUTH for the Elo a bot game is
// rated at (vs-bot Glicko updates in main) and shown at (level/persona UI
// subtitles in the renderer). src/main/ratings/botStrength.ts re-exports this
// module for main-process consumers; renderer code imports it via @shared.
//
// WHY THIS EXISTS: Stockfish can only be natively weakened down to UCI_Elo 1320
// (ENGINE_ELO_FLOOR). Below that, engine.ipc.ts substitutes an engine-driven
// weakening (MultiPV softmax pick model) whose NOMINAL level labels are only
// approximations. Engine-vs-engine calibration (scripts/calibrate-weak.mjs)
// measured the sub-floor bands and found them consistently STRONGER than their
// labels: up to ~+270 Elo at the 1200 band. Rating a user's game against the
// nominal label therefore corrupted the vs-bot Glicko; everything must rate and
// display through measuredElo() instead.
//
// CALIBRATION RECORD (2026-07-06, scripts/calibrate-weak.mjs, 32 games/band,
// anchor = same binary at native UCI_Elo 1320, depth 8; 95% CI ≈ ±150 Elo):
//   current ("new") pick model:  800→926   1000→1208   1200→1470
//                                400, 600 → 0/32 vs the anchor (censored ≤600)
//   pre-recalibration ("old") model, for reference. Historical games were
//   played against it: 600→723   800→850   1000→1157   1200→1575.
//   Old-vs-new differences are within the harness CI except at 600, so ONE
//   curve (the current model's) is used both forward and for the v8 history
//   recompute (src/main/ratings/recompute.ts).
// Re-run the harness and update MEASURED_WEAK_ANCHORS whenever the pick model
// in src/main/ipc/engine.ipc.ts is retuned.

import { ENGINE_ELO_FLOOR } from './types'

/** The opponent kinds that move the vs-bot Glicko ladder. */
export interface RatedBotConfig {
  kind: 'engine' | 'persona' | 'maia'
  /** The config's nominal Elo: the UI-selected level for engines, the persona's
   *  modernElo ?? peakElo for personas, the net's training band for maia
   *  (maia-1500 ⇒ 1500). */
  elo: number
}

/**
 * Piecewise-linear [nominal level, measured Elo] anchors for the sub-floor
 * weak-play model. Between anchors: linear interpolation; outside: clamped.
 *  - 100..600: below the anchor's resolving power (0/32 score vs 1320 ⇒ the
 *    measurement only bounds them at ≤600); values are the bound + a monotone
 *    interpolation beneath it.
 *  - 1319: extrapolated from the measured 1000→1200 slope. The sub-floor model
 *    does NOT converge to native 1320 strength at the boundary; it overshoots.
 */
export const MEASURED_WEAK_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [100, 250],
  [400, 450],
  [600, 600],
  [800, 930],
  [1000, 1210],
  [1200, 1470],
  [1319, 1620]
]

function interpolate(elo: number): number {
  const pts = MEASURED_WEAK_ANCHORS
  if (elo <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (elo <= pts[i][0]) {
      const [e0, v0] = pts[i - 1]
      const [e1, v1] = pts[i]
      const t = (elo - e0) / (e1 - e0)
      return v0 + t * (v1 - v0)
    }
  }
  return pts[pts.length - 1][1]
}

/**
 * The measured playing strength of a bot config: the Elo that vs-bot Glicko
 * updates MUST use and that strength subtitles MUST show.
 *  - engine at >= ENGINE_ELO_FLOOR: native UCI_Elo is its own calibrated label.
 *  - engine below the floor: the calibration curve above (rounded to 10s).
 *  - persona: modernElo/peakElo is already an honest strength estimate.
 *    Passthrough (persona moves are produced by selectMove capped near that).
 *  - maia: the net's NOMINAL training band IS the measurement. Each maia-<elo>
 *    net was trained to predict moves of players at that lichess rating and
 *    plays within a few dozen Elo of it at nodes=1 (CSSLab's published
 *    move-match evals): passthrough, never the sub-floor weak curve.
 */
export function measuredElo(config: RatedBotConfig): number {
  if (config.kind === 'persona' || config.kind === 'maia') return Math.round(config.elo)
  if (config.elo >= ENGINE_ELO_FLOOR) return Math.round(config.elo)
  return Math.round(interpolate(config.elo) / 10) * 10
}

/** True when the strength figure is an estimate (sub-floor engine, persona or
 *  maia), i.e. the UI must render it '~1470'-style, never as a bare point value. */
export function isApproxElo(config: RatedBotConfig): boolean {
  return config.kind !== 'engine' || config.elo < ENGINE_ELO_FLOOR
}

/** Display label for a bot's strength: '1500' for native engine levels,
 *  '~1470' for measured sub-floor levels and persona estimates. */
export function botEloLabel(config: RatedBotConfig): string {
  const m = measuredElo(config)
  return isApproxElo(config) ? `~${m}` : String(m)
}
