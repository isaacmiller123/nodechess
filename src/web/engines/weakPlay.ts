// Sub-floor ("weak play") model: VERBATIM port of the calibrated pick model in
// src/main/ipc/engine.ipc.ts (weakDepth / weakMultiPv / weakTemperature /
// gapKnee / weakBlunderChance / blunderGapWindow / openingFullmoves /
// softmaxPick / pickWeakMove / collectCandidates / weakPlay). The same model is
// mirrored in scripts/lib/weak-model.mjs; scripts/test-web-engines.mjs proves
// this port pick-for-pick identical against that mirror under a seeded RNG.
//
// Stockfish's own weakening (UCI_LimitStrength/UCI_Elo) bottoms out at 1320
// (ENGINE_ELO_FLOOR). Below that we weaken the CHOICE, not the search: a short
// full-strength MultiPV search, then an Elo-scaled softmax pick over the
// engine's own candidate moves, plus an Elo-scaled chance of a "human blunder"
// pick from a bounded severity window. Every constant here is calibrated
// (scripts/calibrate-weak.mjs, 2026-07-06): do not retune independently of
// desktop; shared/botStrength.ts MEASURED_WEAK_ANCHORS depends on this model.

import type { BestMove, InfoLine } from './uci'
import type { WebUciEngine } from './WebUciEngine'

/** Linear interpolation over an Elo interval, clamped at both ends. */
export function lerpByElo(elo: number, e0: number, v0: number, e1: number, v1: number): number {
  const t = Math.max(0, Math.min(1, (elo - e0) / (e1 - e0)))
  return v0 + t * (v1 - v0)
}

/** Piecewise-linear curve over (elo, value) points, clamped at both ends. */
export function curveByElo(elo: number, points: ReadonlyArray<readonly [number, number]>): number {
  if (elo <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    if (elo <= points[i][0]) {
      return lerpByElo(elo, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
    }
  }
  return points[points.length - 1][1]
}

/** Search depth for a sub-floor bot: 4 (Elo ~100) up to 7 (~1250+). */
export function weakDepth(elo: number): number {
  return Math.round(lerpByElo(elo, 100, 4, 1250, 7))
}

/** Candidate-line count: weaker bots consider more (and worse) options. */
export function weakMultiPv(elo: number): number {
  return elo < 600 ? 8 : elo < 1000 ? 7 : 6
}

/** Softmax base temperature in centipawns: ~650 at Elo 100 to ~170 by 1250. */
export function weakTemperature(elo: number): number {
  return lerpByElo(elo, 100, 650, 1250, 170)
}

/** Eval-gap knee (cp): weight is exp(-(gap/T) * (1 + gap/knee)). Quadratic
 *  punishment for candidates that hang material, knee shrinking with Elo. */
export function gapKnee(elo: number): number {
  return curveByElo(elo, [
    [100, 4000],
    [600, 1200],
    [1000, 500],
    [1300, 250]
  ])
}

/** Per-band blunder-rate targets: chance per move of an INTENTIONAL mistake. */
export function weakBlunderChance(elo: number): number {
  return curveByElo(elo, [
    [100, 0.3],
    [400, 0.22],
    [600, 0.15],
    [800, 0.1],
    [1000, 0.06],
    [1200, 0.04],
    [1319, 0.025]
  ])
}

/** Blunder severity window [minGap, maxGap] in cp below the best candidate. */
export function blunderGapWindow(elo: number): [number, number] {
  const min = lerpByElo(elo, 100, 60, 1300, 150)
  const max = elo < 700 ? Number.POSITIVE_INFINITY : lerpByElo(elo, 700, 1200, 1300, 400)
  return [min, max]
}

/** Opening phase length (fullmoves) during which choice is deliberately varied. */
export function openingFullmoves(elo: number): number {
  return Math.round(lerpByElo(elo, 100, 8, 1300, 4))
}

/** Fullmove number from a normalized FEN (defaults to 1 on malformed input). */
export function fenFullmove(fen: string): number {
  const n = Number(fen.split(' ')[5])
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/** Bounded side-to-move cp for a candidate line (mate maps to ±1000, as in review). */
export function lineCp(info: InfoLine): number {
  if (info.mate !== undefined) return info.mate > 0 ? 1000 : -1000
  return Math.max(-1000, Math.min(1000, info.scoreCp ?? 0))
}

export interface WeakCandidate {
  uci: string
  cp: number
}

/** RNG seam: production uses Math.random; the headless parity test injects a
 *  seeded generator so this port and scripts/lib/weak-model.mjs (patched to
 *  the same seed) must produce IDENTICAL picks. */
export type Rng = () => number

/** Eval-gap-aware softmax pick over candidates (sorted best-first). */
export function softmaxPick(
  cands: WeakCandidate[],
  temperature: number,
  knee: number,
  rng: Rng = Math.random
): string {
  const maxCp = cands[0].cp
  const weights = cands.map((c) => {
    const gap = maxCp - c.cp
    return Math.exp(-(gap / temperature) * (1 + gap / knee))
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i]
    if (r <= 0) return cands[i].uci
  }
  return cands[cands.length - 1].uci
}

/**
 * The full sub-floor pick model over sorted-best-first candidates:
 *  1. Opening phase (fullmove small, near-balanced): hotter softmax, no blunder
 *     roll: varied openings without instant self-destruction.
 *  2. Blunder roll at the band's target rate (doubled under panic, cap 50%):
 *     uniform pick from candidates inside the band's severity window.
 *  3. Otherwise: eval-gap-aware softmax (~1.7x hotter under panic).
 */
export function pickWeakMove(
  cands: WeakCandidate[],
  elo: number,
  fullmove: number,
  panic: boolean,
  rng: Rng = Math.random
): string {
  const inOpening = fullmove <= openingFullmoves(elo) && Math.abs(cands[0].cp) < 120
  const knee = gapKnee(elo)
  if (inOpening && !panic) {
    return softmaxPick(cands, weakTemperature(elo) * 1.8, knee, rng)
  }
  const blunderChance = Math.min(0.5, weakBlunderChance(elo) * (panic ? 2 : 1))
  if (cands.length >= 2 && rng() < blunderChance) {
    const [minGap, maxGap] = blunderGapWindow(elo)
    const best = cands[0].cp
    const window = cands.filter((c) => best - c.cp >= minGap && best - c.cp <= maxGap)
    if (window.length > 0) return window[Math.floor(rng() * window.length)].uci
    // No candidate in the window (quiet position): fall through to the softmax.
  }
  return softmaxPick(cands, weakTemperature(elo) * (panic ? 1.7 : 1), knee, rng)
}

/**
 * One bounded MultiPV search on an engine; resolves with the latest info line
 * per multipv index plus the engine's own bestmove. Every exit path (bestmove /
 * timeout / engine exit / engine error) detaches all listeners so nothing
 * leaks onto the long-lived engine. Desktop collectCandidates verbatim.
 */
export function collectCandidates(
  eng: WebUciEngine,
  fen: string,
  depth: number,
  multipv: number,
  movetimeMs: number
): Promise<{ lines: Map<number, InfoLine>; best: BestMove }> {
  return new Promise((resolve, reject) => {
    const lines = new Map<number, InfoLine>()
    let done = false
    const onInfo = (info: InfoLine): void => {
      const idx = info.multipv ?? 1
      if (info.pv && info.pv.length > 0) lines.set(idx, info)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      clearTimeout(softStop)
      eng.off('info', onInfo)
      eng.off('bestmove', onBest)
      eng.off('exit', onExit)
      eng.off('engineError', onErr)
    }
    const onBest = (bm: BestMove): void => {
      if (done) return
      done = true
      cleanup()
      resolve({ lines, best: bm })
    }
    const fail = (e: Error): void => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const onExit = (): void => fail(new Error('engine exited during weak-play search'))
    const onErr = (err: Error): void =>
      fail(err instanceof Error ? err : new Error('engine error during weak-play search'))
    // Hard crash ceiling so a wedged engine can never hang the bot's turn.
    const timer = setTimeout(() => fail(new Error('weak-play search timeout')), 20000)
    // The caller's movetime budget is a SOFT cap: at the budget, `stop` the
    // search: bestmove arrives immediately and the pick runs over whatever
    // completed candidate lines exist by then.
    const softStop = setTimeout(() => void eng.stop(), movetimeMs)
    eng.on('info', onInfo)
    eng.once('bestmove', onBest)
    eng.once('exit', onExit)
    eng.once('engineError', onErr)
    void eng.search(fen, { kind: 'depth', value: depth }, multipv)
  })
}

/** Fallback weak-model budget when the caller sent a non-movetime limit. */
export const WEAK_DEFAULT_MOVETIME_MS = 400

/** Resolve a sub-floor bot move. Same response shape as eng.bestMove().
 *  `panic` = time-trouble collapse: 2 plies shallower (floor 3), softmax ~1.7x
 *  hotter, blunder chance doubled (capped at 50%). */
export async function weakPlay(
  eng: WebUciEngine,
  fen: string,
  elo: number,
  panic = false,
  movetimeMs = WEAK_DEFAULT_MOVETIME_MS
): Promise<BestMove> {
  // Full-strength search: honest candidate evals; the weakening is in the pick.
  eng.setOption('UCI_LimitStrength', false)
  eng.setOption('Skill Level', 20)
  const depth = panic ? Math.max(3, weakDepth(elo) - 2) : weakDepth(elo)
  const budget = Math.max(50, Math.round(movetimeMs))
  const { lines, best } = await collectCandidates(eng, fen, depth, weakMultiPv(elo), budget)
  const cands: WeakCandidate[] = []
  for (const info of lines.values()) {
    const uci = info.pv?.[0]
    if (uci) cands.push({ uci, cp: lineCp(info) })
  }
  // No usable lines (terminal position / odd output): the engine's own answer.
  if (cands.length === 0) return best
  cands.sort((a, b) => b.cp - a.cp)
  return { bestmove: pickWeakMove(cands, elo, fenFullmove(fen), panic) }
}
