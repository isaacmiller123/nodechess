/**
 * Local coaching engine: public surface (docs/content-coaching.md §3).
 *
 * explainMove(): classify the played move by Win% drop, diff the board, detect
 * motifs from the engine PV (best move) and the played continuation, then fill a
 * deterministic template. positional(): static positional summary for a FEN.
 *
 * Fully offline, no LLM, no network. Built on chessops + this package's
 * board-diff/motif/NLG modules. All strings authored fresh (no AGPL text).
 */

import { Chess } from 'chessops/chess'
import { makeSanAndPlay, makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import type { Color, NormalMove } from 'chessops/types'

import {
  type PovScore,
  winningChances,
  winPercent,
  reviewVerdict,
  mateTransition,
  mateSeverity,
  mateToCp,
  formatScore,
  evalBandPhrase
} from './winrate'
import { positionFromFen, materialFor } from './board'
import {
  buildLine,
  detectFork,
  detectPin,
  detectSkewer,
  detectDoubleCheck,
  detectDiscovered,
  detectHangingCapture,
  detectBackRankMate,
  detectMate,
  detectDeflection,
  detectInterference,
  detectOverloaded,
  detectCapturingDefender,
  detectXRay,
  type MotifHit,
  type MotifKey,
  type Ply
} from './motifs'
import {
  render,
  evalPrefix,
  type Verdict,
  type Slots
} from './nlg'
import { positionalReport, type PositionalResult } from './positional'

/** Raw engine eval, side-to-move relative (as Stockfish reports it). */
export interface EngineEval {
  cp?: number | null
  mate?: number | null
}

export interface ExplainMoveInput {
  /** FEN of the position BEFORE the played move. */
  fenBefore: string
  /** Played move in UCI (e.g. "g1f3", "e7e8q"). */
  played: string
  /** Engine best move in UCI. */
  best: string
  /** Engine principal variation (UCI moves) for the BEST line from fenBefore. */
  pv: string[]
  /** Eval BEFORE the move, side-to-move (mover) relative. */
  evalBefore: EngineEval
  /** Eval AFTER the played move, now side-to-move (the opponent) relative. */
  evalAfter: EngineEval
  /** Optional ply index for deterministic wording (defaults to fullmove guess). */
  ply?: number
}

export interface ExplainMoveResult {
  verdict: string
  motifs: string[]
  text: string
}

/** Normalize an EngineEval into a PovScore (cp xor mate). */
function toPov(e: EngineEval, flip: boolean): PovScore {
  let cp = e.cp ?? null
  let mate = e.mate ?? null
  if (flip) {
    if (mate != null) mate = -mate
    if (cp != null) cp = -cp
  }
  // Ensure cp/mate are mutually exclusive (mate wins).
  if (mate != null) cp = null
  return { cp, mate }
}

/** Centipawn proxy of a POV score for mate-severity thresholds. */
function povCp(score: PovScore): number {
  return score.mate != null ? mateToCp(score.mate) : (score.cp ?? 0)
}

/** Map a review verdict + mate transition into the NLG verdict enum. */
function classify(before: PovScore, after: PovScore, playedIsBest: boolean): {
  verdict: Verdict
  reviewLabel: string
  isMate: 'mateLost' | 'mateCreated' | null
} {
  const mt = mateTransition(before, after)
  if (mt === 'mateLost' || mt === 'mateCreated') {
    const sev = mateSeverity(mt, povCp(before), povCp(after))
    // sev is the review severity; the NLG verdict carries the mate semantics.
    return {
      verdict: mt === 'mateLost' ? 'mateLost' : 'mateCreated',
      reviewLabel: sev === 'ok' ? 'inaccuracy' : sev,
      isMate: mt
    }
  }
  if (playedIsBest) {
    return { verdict: 'best', reviewLabel: 'best', isMate: null }
  }
  // chances delta on 0..1 scale (full delta, review bucket).
  const delta = winningChances(before) - winningChances(after)
  const rv = reviewVerdict(delta)
  if (rv === 'ok') {
    // small loss but not best -> "good"
    return { verdict: 'good', reviewLabel: 'good', isMate: null }
  }
  return { verdict: rv as Verdict, reviewLabel: rv, isMate: null }
}

/** Whether the played move at least matches the best move (UCI compare). */
function isBestMove(played: string, best: string): boolean {
  return played.length > 0 && played === best
}

/** Convert a UCI move string into a legal NormalMove in `pos`, or null. */
function legalMove(pos: Chess, uci: string): NormalMove | null {
  const m = parseUci(uci)
  if (!m || !('from' in m)) return null
  return pos.isLegal(m) ? m : null
}

/**
 * Run motif detectors over a replayed line (the BEST line, to explain the best
 * move). Returns the first/strongest hit, gated by the caller on eval swing.
 */
function detectBestLineMotifs(start: Chess, line: Ply[], mover: Color, mateInPlies: number | null): MotifHit | null {
  if (line.length === 0) return null
  const firstPly = line[0]

  // Mate first (most decisive).
  const finalPos = line[line.length - 1].after
  const back = detectBackRankMate(finalPos)
  if (back) return back
  const mate = detectMate(finalPos, mateInPlies)

  // Single-ply tactics that read only the move itself: run on the first ply,
  // which is the move we are explaining.
  const ordered: (MotifHit | null)[] = [
    detectFork(firstPly),
    detectHangingCapture(firstPly),
    detectDoubleCheck(firstPly),
    detectDiscovered(null, firstPly),
    detectCapturingDefender(firstPly)
  ]

  // Combination detectors take a (prev, capture) pair and assume the CAPTURE is
  // a mover ply. In the best line the mover moves on plies whose moved colour ==
  // `mover`; run them with the immediately preceding ply as the setup move.
  for (let i = 1; i < line.length; i++) {
    if (line[i].moved.color !== mover) continue
    ordered.push(detectSkewer(line[i - 1], line[i]))
    ordered.push(detectDeflection(line[i - 1], line[i]))
    ordered.push(detectInterference(line[i - 1], line[i]))
  }

  // Position-level relations (read from the position after the move).
  ordered.push(detectPin(firstPly.after, mover))
  ordered.push(detectOverloaded(start, mover))
  ordered.push(detectXRay(firstPly.after, mover))

  for (const hit of ordered) {
    if (hit) return hit
  }
  // Mate-net last so a concrete tactic is named first when both apply.
  if (mate) return mate
  return null
}

/**
 * Detect what the PLAYED move walked into (to explain a mistake). We look at the
 * opponent's best reply against the played position for a fork/mate/hanging.
 */
function detectPlayedMotif(
  posAfterPlayed: Chess,
  oppPv: string[]
): MotifHit | null {
  // Build the opponent's line from the played position.
  const moves: { from: number; to: number; promotion?: string }[] = []
  for (const uci of oppPv) {
    const m = parseUci(uci)
    if (!m || !('from' in m)) break
    moves.push({ from: m.from, to: m.to, promotion: m.promotion })
  }
  const line = buildLine(posAfterPlayed, moves)
  if (line.length === 0) {
    // Even without a PV, a mate against the mover is detectable.
    return detectBackRankMate(posAfterPlayed) ?? null
  }
  const firstPly = line[0]
  const finalPos = line[line.length - 1].after
  const back = detectBackRankMate(finalPos)
  if (back) return back
  const candidates: (MotifHit | null)[] = [
    detectFork(firstPly),
    detectHangingCapture(firstPly),
    detectCapturingDefender(firstPly),
    detectMate(finalPos, null)
  ]
  for (const hit of candidates) {
    if (hit) return hit
  }
  return null
}

/** Narrate the first few plies of the best PV in SAN. */
function narratePv(start: Chess, pvUci: string[], maxPlies = 6): string {
  const sans: string[] = []
  const pos = start.clone()
  let count = 0
  for (const uci of pvUci) {
    if (count >= maxPlies) break
    const m = legalMove(pos, uci)
    if (!m) break
    sans.push(makeSanAndPlay(pos, m))
    count++
  }
  if (sans.length <= 1) return ''
  // skip the first (it's the best move already named). Narrate the follow-up.
  const follow = sans.slice(1).join(' ')
  return ` After ${follow}.`
}

const MOTIF_SLOT_KEY: Record<MotifKey, MotifKey> = {
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discoveredAttack',
  discoveredCheck: 'discoveredCheck',
  doubleCheck: 'doubleCheck',
  hangingPiece: 'hangingPiece',
  backRankMate: 'backRankMate',
  mate: 'mate',
  deflection: 'deflection',
  interference: 'interference',
  overloaded: 'overloaded',
  capturingDefender: 'capturingDefender',
  xRay: 'xRay',
  trappedPiece: 'trappedPiece'
}

/**
 * Explain a single move. Deterministic, offline. See ExplainMoveInput.
 */
export function explainMove(input: ExplainMoveInput): ExplainMoveResult {
  const posBefore = positionFromFen(input.fenBefore)
  if (!posBefore) {
    return { verdict: 'unknown', motifs: [], text: 'Position could not be analysed.' }
  }
  const mover: Color = posBefore.turn
  const ply = input.ply ?? posBefore.fullmoves * 2 - (mover === 'white' ? 1 : 0)

  // POV scores for the mover. evalBefore is already mover-relative; evalAfter is
  // opponent-relative (side to move flipped), so flip it back to the mover.
  const before = toPov(input.evalBefore, false)
  const after = toPov(input.evalAfter, true)

  const playedIsBest = isBestMove(input.played, input.best)
  const { verdict, reviewLabel, isMate } = classify(before, after, playedIsBest)

  // SAN of played + best.
  const playedMove = legalMove(posBefore, input.played)
  const bestMove = legalMove(posBefore, input.best)
  const playedSan = playedMove ? makeSan(posBefore, playedMove) : input.played
  const bestSan = bestMove ? makeSan(posBefore, bestMove) : input.best

  // Resulting positions.
  const posAfterPlayed = posBefore.clone()
  if (playedMove) posAfterPlayed.play(playedMove)

  // Build the BEST line from fenBefore using the PV (or fall back to just best).
  const pvUci = input.pv && input.pv.length ? input.pv : input.best ? [input.best] : []
  const bestLineMoves: { from: number; to: number; promotion?: string }[] = []
  {
    const probe = posBefore.clone()
    for (const uci of pvUci) {
      const m = legalMove(probe, uci)
      if (!m) break
      bestLineMoves.push({ from: m.from, to: m.to, promotion: m.promotion })
      probe.play(m)
    }
  }
  const bestLine = buildLine(posBefore, bestLineMoves)

  // Mate distance of the BEST line, if it forces mate (drives "forced mate in N").
  const mateInPlies =
    after.mate != null && after.mate > 0
      ? after.mate
      : before.mate != null && before.mate > 0
        ? before.mate
        : bestLineFinalMatePlies(bestLine)

  // Eval swing gate: only assert motifs when the eval actually moved.
  const chancesSwing = Math.abs(winningChances(before) - winningChances(after))
  const winSwing = Math.abs(winPercent(before) - winPercent(after))

  // Material the mover stands to lose after the played move (vs before): used to
  // corroborate "hanging piece" claims so a static scan can't over-assert.
  const materialDrop = materialFor(posBefore, mover) - materialFor(posAfterPlayed, mover)

  let motif: MotifHit | null = null
  if (verdict === 'best' || verdict === 'good') {
    // Explain the best move's idea (the mover plays the best line).
    motif = detectBestLineMotifs(posBefore, bestLine, mover, mateInPlies)
  } else if (winSwing >= 3 || isMate) {
    // Explain the mistake by the concrete threat the played move ALLOWED: the
    // opponent is to move in posAfterPlayed, so detect on that position (the
    // opponent forking/mating/grabbing a hanging piece). Gated on a real swing
    // so a static scan can't invent a motif. We only keep a motif here if a
    // matching blunder/mistake template cell exists, otherwise the generic
    // verdict template explains it and motifs[] stays empty.
    motif = detectPlayedMotif(posAfterPlayed, [])
  }

  // For mate verdicts, force the mate motif.
  if (isMate && (!motif || motif.key !== 'mate')) {
    motif = { key: 'mate', detail: motif?.detail ?? 'a forced mate' }
  }

  // Build eval-band phrase for the resulting position (mover POV).
  const bandPhrase = isMate === 'mateLost' ? 'with the win gone' : evalBandPhrase(after)
  const evalBeforeStr = formatScore(before)
  const evalAfterStr = formatScore(after)

  const slots: Slots = {
    playedSan,
    bestSan,
    evalBand: bandPhrase,
    evalBefore: evalBeforeStr,
    evalAfter: evalAfterStr
  }
  if (motif) {
    slots.motifDetail = motif.detail
    slots.targetName = motif.targetName
    slots.square = motif.square
    // {pieceName} is the acting piece (forking knight) when known, else the
    // targeted piece (a hanging piece names itself).
    slots.pieceName = motif.pieceName ?? motif.targetName
  }
  // For a hanging-piece mistake, only keep the claim if material is actually
  // lost; otherwise soften to the generic verdict template (avoid false motifs).
  if ((verdict === 'blunder' || verdict === 'mistake') && motif?.key === 'hangingPiece') {
    if (materialDrop <= 0) motif = null
  }

  // PV narration only for generic/positive cells (kept short).
  if (verdict === 'best' || verdict === 'good' || verdict === 'inaccuracy') {
    slots.pvNarration = narratePv(posBefore, pvUci)
  } else {
    slots.pvNarration = ''
  }

  // Render.
  let text = render({
    verdict,
    motif: motif ? MOTIF_SLOT_KEY[motif.key] : null,
    slots,
    ply,
    fen: input.fenBefore
  })

  // Prefix the eval transition for non-trivial mistakes (matches the spec's
  // "(+3.1 → +0.2) ..." baseline) when there is a meaningful swing.
  if ((verdict === 'blunder' || verdict === 'mistake' || isMate) && chancesSwing >= 0.05) {
    text = evalPrefix(evalBeforeStr, evalAfterStr) + text
  }

  const motifs = motif ? [motif.key] : []

  return { verdict: reviewLabel, motifs, text }
}

/** If the best line ends in checkmate, return its length in plies. */
function bestLineFinalMatePlies(line: Ply[]): number | null {
  if (line.length === 0) return null
  const finalPos = line[line.length - 1].after
  if (finalPos.isCheckmate()) return line.length
  return null
}

export interface PositionalInput {
  fen: string
}

/** Static positional summary for a FEN (no engine). */
export function positional(input: PositionalInput): PositionalResult {
  return positionalReport(input.fen)
}

export type { PositionalResult }
