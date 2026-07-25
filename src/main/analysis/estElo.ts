// Per-game estimated-Elo BAND from accuracy + ACPL (+ optional opponent Elo)
// (content-coaching.md §3.1 accuracy, architecture.md §11.1.8 "accuracy-based
// per-game Elo band ... always a range, labeled distinct from the Glicko
// rating").
//
// This is a deliberately SEPARATE estimate from the Glicko puzzle/vs-bot rating.
//
// ---------------------------------------------------------------------------------
// EMPIRICALLY FITTED MODEL (v3): every constant below comes from a measured fit,
// not folklore. The previous hand-guessed anchor table was calibrated against a
// DIFFERENT accuracy formula than ours and overrated club-level games by
// ~600-800 Elo (e.g. a measured-1000-strength game read as ~1800).
//
//   Corpus:   scripts/gen-elo-corpus.mjs, 352 rows (176 engine-vs-engine games,
//             2 rows/game) at 13 known strengths {400..1200 weak-model bands,
//             1320..2700 native UCI_Elo}, self-play + cross-pairings at +/-200
//             and +/-400, analyzed headlessly with the EXACT review.ts accuracy/
//             ACPL math (esbuild-bundled accuracy.ts, depth-12 MultiPV-2 pass).
//   Fit:      scripts/fit-elo-model.mjs (2026-07-06), 266 train / 86 holdout
//             rows split by game. Inverse-calibrated per-band curves (PAV) so
//             the estimate stays per-band UNBIASED (train bias within ~+/-170
//             across all 13 bands) instead of regressing to the middle.
//   Holdout MAE:  275 Elo with oppElo | 325 without | 481 accuracy-only.
//   Per-band holdout MAE (with opp): 400:250 600:192 800:310 1000:227 1200:248
//             1320:385 1500:410 1700:296 1900:435 2100:373 2300:220 2500:211
//             2700:68 (n=2-12 per band; individual cells are noisy; the
//             overall MAE and the residual-std bands below are the signal).
//   Bands:    half-width = MEASURED residual std per nMoves bucket (not vibes).
//             A single game pins strength to roughly +/-300-650 Elo. The wide
//             band is the honest truth of the metric.
//   Tests:    scripts/test-est-elo.mjs (golden holdout MAE, monotonicity,
//             short-game widening, opponent-delta direction).
//
// Model shape (simple + monotone):
//   eloAcc(accuracy)      piecewise-linear inverse-calibration curve
//   eloAcpl(log(1+acpl))  ditto (ACPL is the stronger single signal)
//   est0 = A0 + A1*eloAcc + (1-A1)*eloAcpl   (acpl known; slopes sum to 1)
//        = C0 + eloAcc                        (acpl unknown)
//   est1 = est0 + B_SHRINK*(est0-1500)*s(n)  short-game shrink toward center,
//          s(n) = sqrt(30/clamp(n,6,30)) - 1, 0 for n >= 30
//   est  = (est1 - G_OPP*oppElo)/(1 - G_OPP) when oppElo is known (structural
//          within-band slope: stronger opposition depresses measured accuracy,
//          so the same accuracy vs a stronger opponent implies a higher Elo)
// ---------------------------------------------------------------------------------

export interface EloBand {
  /** Point estimate (rounded). */
  est: number
  /** Lower bound of the band (rounded). */
  low: number
  /** Upper bound of the band (rounded). */
  high: number
  /** The accuracy% the estimate was derived from (echoed for the UI). */
  accuracy: number
  /** Always 'estimate', UI must label this distinct from the Glicko rating. */
  kind: 'estimate'
}

/** Extended input for estimateEloEx (review/ratings can adopt incrementally). */
export interface EstEloInput {
  /** Game accuracy% (0..100). The review pipeline's gameAccuracy blend. */
  accuracy: number
  /** The side's average centipawn loss, if known. */
  acpl?: number | null
  /** The side's own analyzed move count (drives shrink + band width). */
  nMoves?: number | null
  /** Opponent strength (e.g. the bot's Elo), if known. Sharpens the estimate. */
  oppElo?: number | null
}

const ELO_FLOOR = 250
const ELO_CEIL = 3000
const SHRINK_CENTER = 1500

// ---- Fitted constants (scripts/data/elo-fit.json, 2026-07-06, 352 rows) ----------

/** Inverse-calibrated accuracy% -> Elo knots (PAV band means, fit 2026-07-06). */
const ACC_KNOTS: { acc: number; elo: number }[] = [
  { acc: 65.75, elo: 400 },
  { acc: 75.46, elo: 600 },
  { acc: 77.05, elo: 800 },
  { acc: 80.3, elo: 1000 },
  { acc: 82.11, elo: 1337 },
  { acc: 84.23, elo: 1700 },
  { acc: 86.94, elo: 2014 },
  { acc: 89.06, elo: 2300 },
  { acc: 91.23, elo: 2585 }
]

/** Inverse-calibrated log(1+acpl) -> Elo knots (ascending feat, descending Elo). */
const ACPL_KNOTS: { la: number; elo: number }[] = [
  { la: 3.043, elo: 2700 },
  { la: 3.152, elo: 2500 },
  { la: 3.473, elo: 2300 },
  { la: 3.615, elo: 2100 },
  { la: 3.67, elo: 1900 },
  { la: 3.785, elo: 1700 },
  { la: 3.947, elo: 1500 },
  { la: 4.08, elo: 1263 },
  { la: 4.239, elo: 1000 },
  { la: 4.421, elo: 800 },
  { la: 4.671, elo: 600 },
  { la: 4.765, elo: 400 }
]

/** Blend intercept (acpl known). */
const A0 = 7.5
/** Accuracy-curve weight in the blend; 1-A1 goes to the ACPL curve. The
 *  unconstrained fit picks A1=0 (ACPL dominates); 0.1 is a robustness floor
 *  costing ~4.6 holdout MAE (grid: 0 -> 320.0, 0.1 -> 324.6, 0.3 -> 344.6). */
const A1 = 0.1
/** Accuracy-only intercept (acpl unknown: placement, raw perf:estimate). */
const C0 = -58.7
/** Short-game shrink toward SHRINK_CENTER; bounded fit (raw OLS -2.19 is
 *  confounded: short corpus games are decisive high-band games). */
const B_SHRINK = -0.32
/** Structural opponent slope: estNoOpp ~ trueElo + G_OPP*(oppElo - trueElo). */
const G_OPP = -0.1902

/**
 * Band half-widths: MEASURED residual std per nMoves bucket (all 352 rows),
 * per input variant, PAV-pooled to be nonincreasing in n. The <15-moves bucket
 * had n=2, so its width is floored at the 15-24 bucket's. Interpolated
 * piecewise-linearly, constant beyond the ends.
 */
const WIDTH_KNOTS: Record<'withOpp' | 'noOpp' | 'accOnly', [number, number][]> = {
  withOpp: [
    [10, 395],
    [30, 378],
    [48, 295]
  ],
  noOpp: [
    [10, 540],
    [30, 455],
    [48, 350]
  ],
  accOnly: [
    [10, 667],
    [30, 652],
    [48, 541]
  ]
}

// ---- Curve evaluation -------------------------------------------------------------

function interp(points: [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1]
  const last = points[points.length - 1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1]
      const [x1, y1] = points[i]
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  return last[1]
}

const ACC_POINTS: [number, number][] = ACC_KNOTS.map((k) => [k.acc, k.elo])
const ACPL_POINTS: [number, number][] = ACPL_KNOTS.map((k) => [k.la, k.elo])

/** Short-game evidence factor: sqrt(30/clamp(n,6,30)) - 1 (0 for n >= 30). */
function shrinkS(n: number): number {
  return Math.sqrt(30 / Math.max(6, Math.min(30, n))) - 1
}

// ---- Main entries -------------------------------------------------------------------

/**
 * Estimate a per-game Elo band from the fitted model. All inputs beyond
 * accuracy are optional; each one that is present sharpens the estimate AND
 * narrows the honest band (widths are the measured residual std of the
 * corresponding model variant).
 */
export function estimateEloEx(input: EstEloInput): EloBand {
  const accuracy = Math.max(0, Math.min(100, input.accuracy))
  const hasAcpl = input.acpl != null && Number.isFinite(input.acpl)
  const hasOpp = input.oppElo != null && Number.isFinite(input.oppElo)
  const n = Math.max(1, input.nMoves != null && Number.isFinite(input.nMoves) ? input.nMoves : 30)

  // 1) Calibrated blend (slopes sum to 1 => per-band unbiased).
  let est: number
  if (hasAcpl) {
    const a = interp(ACC_POINTS, accuracy)
    const c = interp(ACPL_POINTS, Math.log(1 + Math.max(0, input.acpl as number)))
    est = A0 + A1 * a + (1 - A1) * c
  } else {
    est = C0 + interp(ACC_POINTS, accuracy)
  }

  // 2) Short-game shrink: little evidence pulls extremes toward the center.
  est += B_SHRINK * (est - SHRINK_CENTER) * shrinkS(n)

  // 3) Opponent adjustment (invert estNoOpp = T + G_OPP*(opp - T)).
  if (hasOpp) {
    est = (est - G_OPP * (input.oppElo as number)) / (1 - G_OPP)
  }

  est = Math.max(ELO_FLOOR, Math.min(ELO_CEIL, est))

  // 4) Honest band: measured residual std for this variant at this nMoves.
  const widths = hasOpp ? WIDTH_KNOTS.withOpp : hasAcpl ? WIDTH_KNOTS.noOpp : WIDTH_KNOTS.accOnly
  const halfWidth = interp(widths, n)

  return {
    est: Math.round(est),
    low: Math.round(Math.max(ELO_FLOOR, est - halfWidth)),
    high: Math.round(Math.min(ELO_CEIL, est + halfWidth)),
    accuracy: Math.round(accuracy * 10) / 10,
    kind: 'estimate'
  }
}

/**
 * Estimate a per-game Elo band from accuracy, blended with ACPL.
 * Back-compat wrapper over estimateEloEx (same callers: review.ts summarize,
 * review.ipc perf:estimate, placement.repo).
 *
 * @param accuracy game accuracy% (0..100).
 * @param moveCount number of the side's own moves analyzed (band width +
 *        short-game shrink; <30 moves shrinks toward the middle and widens).
 * @param acplValue the side's average centipawn loss for the game, if known.
 *        Omitted (e.g. raw perf:estimate calls, placement) => accuracy-only
 *        variant with its (wider) measured band.
 */
export function estimateElo(accuracy: number, moveCount = 30, acplValue?: number): EloBand {
  return estimateEloEx({ accuracy, nMoves: moveCount, acpl: acplValue ?? null })
}
