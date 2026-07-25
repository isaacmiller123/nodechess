/**
 * cp -> Win% -> Accuracy and move-classification math.
 *
 * Authoritative source: docs/content-coaching.md §0.2, §3.1, §3.2.
 * All numbers/formulas are re-implemented from the documented behaviour
 * (Lichess `Advice.scala`, `winningChances.ts`, `practiceCtrl.ts`). Math/facts
 * are not copyrightable; no AGPL/GPL source text is reproduced here.
 *
 * Eval convention used throughout this module: a "score" is a pair
 * `{ cp: number | null, mate: number | null }` already expressed from a FIXED
 * point of view (the player whose move is being judged). The caller (index.ts)
 * is responsible for flipping side-to-move evals into the mover's POV before
 * calling anything here.
 */

export interface PovScore {
  /** centipawns from the judged player's POV (null when mate is set). */
  cp: number | null
  /** mate-in-n plies from the judged player's POV (positive = mover mates). */
  mate: number | null
}

/** Lichess Win% constant (lila PR #11148). Do NOT use the older -0.004. */
const WIN_MULT = -0.00368208

/** -1..1 winning chances for a clamped centipawn score. */
export function rawWinningChances(cp: number): number {
  const c = Math.max(-1000, Math.min(1000, cp))
  return 2 / (1 + Math.exp(WIN_MULT * c)) - 1
}

/** Map a signed mate distance to a finite high-band centipawn value. */
export function mateToCp(mate: number): number {
  const sign = Math.sign(mate)
  return sign * (21 - Math.min(10, Math.abs(mate))) * 100
}

/** 0..100 win percentage for a POV score. */
export function winPercent(score: PovScore): number {
  const cp = score.mate != null ? mateToCp(score.mate) : (score.cp ?? 0)
  return 50 + 50 * rawWinningChances(cp)
}

/** -1..1 winning chances for a POV score (used for the chances-delta buckets). */
export function winningChances(score: PovScore): number {
  const cp = score.mate != null ? mateToCp(score.mate) : (score.cp ?? 0)
  return rawWinningChances(cp)
}

/**
 * Per-move accuracy% (§3.1). Both inputs 0..100 from the mover's POV;
 * `winAfter` is the post-move position evaluated for the mover.
 */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100
  const winDiff = winBefore - winAfter
  const acc = 103.1668 * Math.exp(-0.04354 * winDiff) - 3.1669 + 1 // +1 uncertainty bonus
  return Math.max(0, Math.min(100, acc))
}

export type ReviewVerdict = 'blunder' | 'mistake' | 'inaccuracy' | 'ok'

/**
 * Post-game REVIEW annotation buckets (§3.2a, Lichess `Advice.scala`).
 * `delta` = POV-signed (chancesBefore - chancesAfter) on the 0..1 chances scale.
 * NB: this is the *full* chances delta, NOT the halved practice shift.
 */
export function reviewVerdict(delta: number): ReviewVerdict {
  if (delta >= 0.3) return 'blunder'
  if (delta >= 0.2) return 'mistake'
  if (delta >= 0.1) return 'inaccuracy'
  return 'ok'
}

export type PracticeVerdict = 'goodMove' | 'inaccuracy' | 'mistake' | 'blunder'

/**
 * Live PRACTICE buckets (§3.2b, Lichess `practiceCtrl.ts`).
 * `shift` already HALVES the chances difference (povDiff), hence tighter
 * thresholds. Kept as a separate function from reviewVerdict by design.
 */
export function practiceVerdict(shift: number, playedIsBest: boolean): PracticeVerdict {
  if (playedIsBest) return 'goodMove'
  if (shift < 0.025) return 'goodMove'
  if (shift < 0.06) return 'inaccuracy'
  if (shift < 0.14) return 'mistake'
  return 'blunder'
}

export type MateTransition = 'mateCreated' | 'mateLost' | 'mateDelayed' | null

/**
 * Special-cased mate transitions (§3.2c). `before`/`after` are POV scores for
 * the mover. Returns the transition kind, or null when no mate is involved.
 */
export function mateTransition(before: PovScore, after: PovScore): MateTransition {
  const mb = before.mate
  const ma = after.mate
  if (mb == null && ma == null) return null
  // cp -> mate(negative for mover): the mover is now getting mated.
  if (mb == null && ma != null && ma < 0) return 'mateCreated'
  // mate(positive) -> cp: a forced mate was thrown away.
  if (mb != null && mb > 0 && ma == null) return 'mateLost'
  // mate(pos) -> mate(neg): had a mate, now being mated.
  if (mb != null && mb > 0 && ma != null && ma < 0) return 'mateLost'
  // mate(pos) -> worse (larger) mate(pos): slower but still mating. Not annotated.
  if (mb != null && mb > 0 && ma != null && ma > 0 && ma > mb) return 'mateDelayed'
  return null
}

/**
 * Severity of a mate transition (§3.2c). `prevPovCp`/`povCp` are the relevant
 * centipawn proxies (mateToCp) used by the documented thresholds.
 */
export function mateSeverity(kind: MateTransition, prevPovCp: number, povCp: number): ReviewVerdict {
  if (kind === 'mateCreated') {
    if (prevPovCp < -999) return 'inaccuracy'
    if (prevPovCp < -700) return 'mistake'
    return 'blunder'
  }
  if (kind === 'mateLost') {
    if (povCp > 999) return 'inaccuracy'
    if (povCp > 700) return 'mistake'
    return 'blunder'
  }
  return 'ok'
}

/** Format a POV score like "+1.2", "-0.8", "M3", "-M2". */
export function formatScore(score: PovScore): string {
  if (score.mate != null) {
    return (score.mate < 0 ? '-M' : 'M') + Math.abs(score.mate)
  }
  const cp = score.cp ?? 0
  const pawns = cp / 100
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(1)
}

export type EvalBand =
  | 'equal'
  | 'slightly better'
  | 'clearly better'
  | 'winning'
  | 'completely winning'

/**
 * Verbal eval band from the mover's POV centipawns (§7.5 / §2.3 thresholds).
 * Mate is handled separately by the caller ("forced mate in N").
 */
export function evalBand(cp: number): EvalBand {
  const a = Math.abs(cp)
  if (a <= 50) return 'equal'
  if (a <= 150) return 'slightly better'
  if (a <= 300) return 'clearly better'
  if (a <= 600) return 'winning'
  return 'completely winning'
}

/**
 * Phrase the eval band for the mover, accounting for being worse. Mate handled
 * by caller. Returns a fragment like "equal", "clearly better",
 * "clearly worse", "completely lost".
 */
export function evalBandPhrase(score: PovScore): string {
  if (score.mate != null) {
    const n = Math.abs(score.mate)
    if (n === 0) return score.mate >= 0 ? 'delivering checkmate' : 'checkmated'
    return score.mate > 0 ? `with a forced mate in ${n}` : `getting mated in ${n}`
  }
  const cp = score.cp ?? 0
  const band = evalBand(cp)
  if (band === 'equal') return 'equal'
  if (cp >= 0) return band
  // mirror the positive labels into "worse"/"lost" wording
  switch (band) {
    case 'slightly better':
      return 'slightly worse'
    case 'clearly better':
      return 'clearly worse'
    case 'winning':
      return 'losing'
    case 'completely winning':
      return 'completely lost'
    default:
      return 'equal'
  }
}
