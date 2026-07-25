// Sub-1320 weak-bot pick model: MIRROR of src/main/ipc/engine.ipc.ts
// (weakDepth / weakMultiPv / weakTemperature / gapKnee / weakBlunderChance /
// blunderGapWindow / openingFullmoves / softmaxPick / pickWeakMove).
//
// Single shared copy for the headless harnesses (scripts/calibrate-weak.mjs,
// scripts/gen-elo-corpus.mjs). Keep in sync with engine.ipc.ts when tuning.
// TODO(P2): unify with production via a shared pure TS module.

/** Linear interpolation over an Elo interval, clamped at both ends. */
export function lerpByElo(elo, e0, v0, e1, v1) {
  const t = Math.max(0, Math.min(1, (elo - e0) / (e1 - e0)))
  return v0 + t * (v1 - v0)
}

/** Piecewise-linear curve over (elo, value) points, clamped at both ends. */
export function curveByElo(elo, points) {
  if (elo <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    if (elo <= points[i][0])
      return lerpByElo(elo, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
  }
  return points[points.length - 1][1]
}

/** Search depth for a sub-floor bot: 4 (Elo ~100) up to 7 (~1250+). */
export const weakDepth = (elo) => Math.round(lerpByElo(elo, 100, 4, 1250, 7))

/** Candidate-line count: weaker bots consider more (and worse) options. */
export const weakMultiPv = (elo) => (elo < 600 ? 8 : elo < 1000 ? 7 : 6)

/** Softmax base temperature (cp): ~650 at Elo 100 tapering to ~170 by 1250. */
export const weakTemperature = (elo) => lerpByElo(elo, 100, 650, 1250, 170)

/** Eval-gap knee (cp): quadratic punishment scale for hanging-material lines. */
export const gapKnee = (elo) =>
  curveByElo(elo, [
    [100, 4000],
    [600, 1200],
    [1000, 500],
    [1300, 250]
  ])

/** Per-band chance per move of an INTENTIONAL mistake pick. */
export const weakBlunderChance = (elo) =>
  curveByElo(elo, [
    [100, 0.3],
    [400, 0.22],
    [600, 0.15],
    [800, 0.1],
    [1000, 0.06],
    [1200, 0.04],
    [1319, 0.025]
  ])

/** Blunder severity window [minGap, maxGap] in cp below the best candidate. */
export function blunderGapWindow(elo) {
  const min = lerpByElo(elo, 100, 60, 1300, 150)
  const max = elo < 700 ? Number.POSITIVE_INFINITY : lerpByElo(elo, 700, 1200, 1300, 400)
  return [min, max]
}

/** Opening phase length (fullmoves) during which choice is deliberately varied. */
export const openingFullmoves = (elo) => Math.round(lerpByElo(elo, 100, 8, 1300, 4))

/**
 * Eval-gap-aware softmax pick over candidates (sorted best-first): weight is
 * exp(-(gap/T) * (1 + gap/knee)).
 */
export function softmaxPick(cands, temperature, knee) {
  const maxCp = cands[0].cp
  const weights = cands.map((c) => {
    const gap = maxCp - c.cp
    return Math.exp(-(gap / temperature) * (1 + gap / knee))
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i]
    if (r <= 0) return cands[i].uci
  }
  return cands[cands.length - 1].uci
}

/**
 * The full sub-floor pick model over sorted-best-first candidates. Production
 * parity with engine.ipc.ts pickWeakMove (including the panic knob).
 */
export function pickWeakMove(cands, elo, fullmove, panic = false) {
  const inOpening = fullmove <= openingFullmoves(elo) && Math.abs(cands[0].cp) < 120
  const knee = gapKnee(elo)
  if (inOpening && !panic) {
    return softmaxPick(cands, weakTemperature(elo) * 1.8, knee)
  }
  const blunderChance = Math.min(0.5, weakBlunderChance(elo) * (panic ? 2 : 1))
  if (cands.length >= 2 && Math.random() < blunderChance) {
    const [minGap, maxGap] = blunderGapWindow(elo)
    const best = cands[0].cp
    const window = cands.filter((c) => best - c.cp >= minGap && best - c.cp <= maxGap)
    if (window.length > 0) return window[Math.floor(Math.random() * window.length)].uci
    // No candidate in the window (quiet position): fall through to the softmax.
  }
  return softmaxPick(cands, weakTemperature(elo) * (panic ? 1.7 : 1), knee)
}
