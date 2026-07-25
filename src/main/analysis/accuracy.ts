// Accuracy / Win% math + move classification (docs/content-coaching.md §0.2, §2.3,
// §3.1 for the Win% math). "REVIEW-SPEC S1-S9" below are rule ids for the
// classification scenarios — there is no REVIEW-SPEC document in this repo, so the
// behaviour these ids name is defined by the code here and held by
// scripts/verify-classification.mjs.
//
// Clean-room re-implementation of the Lichess Win% + Accuracy% pipeline on plain
// numbers, plus the chess.com-model move classifier (freechess-corrected, see
// REVIEW-SPEC S1-S9). No engine, no DB, no Electron — the only dependency is
// chessops (pure chess rules) so this module stays headlessly testable
// (scripts/verify-classification.mjs bundles it with esbuild and runs scenarios).
//
// Conventions:
//  - cp is centipawns from a FIXED point of view (caller decides whose POV).
//  - mate is mate-in-n moves, sign = who delivers mate (positive = the POV side mates).
//  - Win% is 0..100 from that same POV. Classification runs in MOVER POV.

// ---- cp -> Win% (Lichess canonical, lila PR #11148) -----------------------------

/** Lichess winning-chances sigmoid constant. Do NOT mix with the older -0.004. */
export const WIN_MULT = -0.00368208

/** Centipawns are clamped to this magnitude before the sigmoid. */
export const CP_CLAMP = 1000

/** Raw winning chances in [-1, 1] for a cp eval (clamped to +/-1000). */
export function rawWinningChances(cp: number): number {
  const c = Math.max(-CP_CLAMP, Math.min(CP_CLAMP, cp))
  return 2 / (1 + Math.exp(WIN_MULT * c)) - 1
}

/** Map a signed mate distance to a finite high-band cp value. */
export function mateToCp(mate: number): number {
  // 'mate 0' (Stockfish) = the side to move is ALREADY checkmated. That is the
  // losing extreme for this POV, not an equal position — map it to the bottom of
  // the clamp band so Win% -> ~0 and cpLoss reflects a decided position.
  if (mate === 0) return -(21 * 100)
  const sign = Math.sign(mate)
  return sign * (21 - Math.min(10, Math.abs(mate))) * 100
}

/**
 * Win% in 0..100 from the POV the eval is expressed in.
 * Pass `mate` when the score is a forced mate; otherwise pass `scoreCp`.
 */
export function winPercent(scoreCp: number | null, mate: number | null): number {
  const cp = mate != null ? mateToCp(mate) : (scoreCp ?? 0)
  return 50 + 50 * rawWinningChances(cp)
}

/** Winning chances in 0..1 (the 0..100 Win% rescaled), POV-relative. */
export function winChances(scoreCp: number | null, mate: number | null): number {
  return winPercent(scoreCp, mate) / 100
}

// ---- Per-move Accuracy% (content-coaching.md §3.1) -------------------------------

/**
 * Per-move accuracy in 0..100. Both args are Win% (0..100) from the MOVER's POV;
 * winAfter is taken from the post-move position, re-expressed to the mover.
 * Fits the anchor curve 0->100, 5->75, 10->60, 20->42, 40->20, 60->5, 80->0.
 */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100
  const winDiff = winBefore - winAfter
  // Official Lichess curve (lila AccuracyPercent.fromWinPercents): no extra bonus,
  // so per-move accuracy stays comparable to the canonical Lichess values.
  const acc = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411
  return Math.max(0, Math.min(100, acc))
}

// ---- Game accuracy (volatility-weighted-mean + harmonic-mean blend) --------------

/** Sample standard deviation of a slice (population std; matches lila harmonic.scala). */
function stdDev(xs: number[]): number {
  if (xs.length === 0) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length
  return Math.sqrt(variance)
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

/**
 * Blend a side's per-move accuracies into a single 0..100 game accuracy.
 *
 * @param accuracies per-move accuracy for this side's moves, in game order.
 * @param winPercents the Win% (0..100, FROM THIS SIDE'S POV) for EACH ply of the
 *        whole game (both sides), in game order — used to compute the volatility
 *        weighting window. If omitted, falls back to a flat weighting.
 * @param sideIndices the indices into `winPercents` of this side's moves (the post
 *        positions), aligned 1:1 with `accuracies`. If omitted, accuracies are
 *        assumed contiguous from index 0.
 */
export function gameAccuracy(
  accuracies: number[],
  winPercents?: number[],
  sideIndices?: number[]
): number {
  const n = accuracies.length
  if (n === 0) return 0
  if (n === 1) return clamp(accuracies[0], 0, 100)

  // Harmonic mean (guard zeros with a small epsilon).
  const EPS = 1e-3
  const harmonicMean = n / accuracies.reduce((a, b) => a + 1 / Math.max(EPS, b), 0)

  // Volatility weights from a centered Win% window over the WHOLE game.
  let weights: number[]
  if (winPercents && winPercents.length > 0 && sideIndices && sideIndices.length === n) {
    const total = winPercents.length
    const windowSize = clamp(Math.round(total / 10), 2, 8)
    weights = sideIndices.map((idx) => {
      const half = Math.floor(windowSize / 2)
      const lo = Math.max(0, Math.min(idx - half, total - windowSize))
      const hi = Math.min(total, lo + windowSize)
      return clamp(stdDev(winPercents.slice(lo, hi)), 0.5, 12)
    })
  } else {
    weights = accuracies.map(() => 1)
  }

  const weightSum = weights.reduce((a, b) => a + b, 0)
  const weightedMean =
    weightSum > 0 ? accuracies.reduce((a, acc, i) => a + acc * weights[i], 0) / weightSum : 0

  return clamp((weightedMean + harmonicMean) / 2, 0, 100)
}

// ---- ACPL (separate stat) -------------------------------------------------------

/** Per-move centipawn loss cap and overall guard (content-coaching.md §3.1). */
export const MAX_CPL_PER_MOVE = 1000
export const MAX_CPL = 2000

/**
 * Average centipawn loss for a side. Each loss is the mover-POV cp drop from the
 * position before the move to after, capped per-move at +/-1000. Pass already-signed
 * losses (>=0). Returns a non-negative integer-ish cp value; lower = stronger.
 */
export function acpl(losses: number[]): number {
  if (losses.length === 0) return 0
  const sum = losses.reduce((a, l) => a + Math.min(MAX_CPL_PER_MOVE, Math.max(0, l)), 0)
  return Math.min(MAX_CPL, sum / losses.length)
}

// ---- Move classification (content-coaching.md §3.2) -----------------------------

export type ReviewVerdict = 'blunder' | 'mistake' | 'inaccuracy' | 'ok'

/**
 * Post-game REVIEW annotation bucket (Lichess Advice.scala).
 * @param delta POV-signed (prevWinChances - currWinChances) on the 0..1 chances scale.
 */
export function reviewVerdict(delta: number): ReviewVerdict {
  if (delta >= 0.3) return 'blunder'
  if (delta >= 0.2) return 'mistake'
  if (delta >= 0.1) return 'inaccuracy'
  return 'ok'
}

export type PracticeVerdict = 'goodMove' | 'inaccuracy' | 'mistake' | 'blunder'

/**
 * Live practice / guess-the-move bucket (Lichess practiceCtrl.ts). The `shift`
 * here is on the HALVED povDiff scale — keep separate from reviewVerdict's delta.
 */
export function practiceVerdict(shift: number, playedIsBest: boolean): PracticeVerdict {
  if (playedIsBest) return 'goodMove'
  if (shift < 0.025) return 'goodMove'
  if (shift < 0.06) return 'inaccuracy'
  if (shift < 0.14) return 'mistake'
  return 'blunder'
}

// ---- Mate transitions (content-coaching.md §3.2c) -------------------------------

export type MateTransition = 'MateCreated' | 'MateLost' | 'MateDelayed' | null

export interface EvalScore {
  /** cp from the mover's POV (set when not a mate). */
  cp?: number | null
  /** mate distance from the mover's POV (set when forced mate; sign = who mates). */
  mate?: number | null
}

/**
 * Classify a mate transition between the best line (prev, before the move, mover POV)
 * and the played line (curr, after the move, re-expressed to the SAME mover POV).
 * Returns the transition kind plus its review severity (null when not annotated).
 */
export function mateTransition(
  prev: EvalScore,
  curr: EvalScore
): { kind: MateTransition; severity: ReviewVerdict | null } {
  const prevMate = prev.mate ?? null
  const currMate = curr.mate ?? null
  const prevCp = prev.cp ?? 0
  const currCp = curr.cp ?? 0

  // cp -> mate(negative for mover) => MateCreated (mover is now getting mated)
  if (prevMate == null && currMate != null && currMate < 0) {
    let severity: ReviewVerdict
    if (prevCp < -999) severity = 'inaccuracy'
    else if (prevCp < -700) severity = 'mistake'
    else severity = 'blunder'
    return { kind: 'MateCreated', severity }
  }

  // mate(positive) -> cp  OR  mate(pos) -> mate(neg) => MateLost
  if (prevMate != null && prevMate > 0) {
    const lostToCp = currMate == null
    const flippedToNeg = currMate != null && currMate < 0
    if (lostToCp || flippedToNeg) {
      const povCp = lostToCp ? currCp : -mateToCp(Math.abs(currMate as number))
      let severity: ReviewVerdict
      if (povCp > 999) severity = 'inaccuracy'
      else if (povCp > 700) severity = 'mistake'
      else severity = 'blunder'
      return { kind: 'MateLost', severity }
    }
    // mate(pos) -> worse mate(pos) => MateDelayed (NOT annotated)
    if (currMate != null && currMate > 0 && currMate > prevMate) {
      return { kind: 'MateDelayed', severity: null }
    }
  }

  return { kind: null, severity: null }
}

// ---- Move classification (REVIEW-SPEC S1-S9, freechess-corrected chess.com model) --

// Single source of truth for the badge union is the shared IPC contract
// (@shared/types MoveBadge, which includes 'Miss'). Type-only import, so this
// module stays headlessly testable; re-exported for existing consumers
// (review.ts imports MoveBadge from here).
export type { MoveBadge } from '../../shared/types'
import type { MoveBadge } from '../../shared/types'

// chessops is a pure rules library (no Electron/DB), safe for headless bundling.
import { Chess, normalizeMove } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci, makeUci, opposite, squareRank } from 'chessops/util'
import { kingAttacks } from 'chessops/attacks'
import { SquareSet } from 'chessops/squareSet'
import type { Color, NormalMove, Role, Square } from 'chessops/types'

// Chess.com official EP-loss bands x100 (REVIEW-SPEC S1), on
// drop = max(0, winBefore - winAfter) win-points, mover POV:
//   drop <= EXCELLENT  -> Excellent      (essentially no chances lost)
//   drop <= GOOD       -> Good           (small concession)
//   drop <= INACCURACY -> Inaccuracy ?!
//   drop <= MISTAKE    -> Mistake ?
//   otherwise          -> Blunder ??
// Best is NEVER awarded from the band table (only via S2/S3.4).
export const DROP_EXCELLENT = 2
export const DROP_GOOD = 5
export const DROP_INACCURACY = 10
export const DROP_MISTAKE = 20

/** S2: co-best tolerance (win-points) when the played move matches the PV2 line. */
export const CO_BEST_GAP = 1.0
/** S5-G4: Great = only good move; the 2nd line must be at least this much worse. */
export const GREAT_ONLY_GAP = 12
/** S4-B2: the mover must not be worse after a Brilliant (win%, mover POV). */
export const BRILLIANT_HOLD = 50
/** S4-B3: a second line at/above this win% means "winning anyways" (~700cp). */
export const SECOND_LINE_WINNING = 93
/** S6: the mover counted as "winning" before the move at/above this win% (~+300cp). */
export const MISS_WINNING_BEFORE = 75
/** S7-C1: a "Blunder" that still leaves the mover at/above this win% is Good. */
export const CAP_STILL_WINNING = 90
/** S7-C2: a "Blunder" from a position already at/below this win% is Good. */
export const CAP_ALREADY_LOST = 10
/** S3.2: Book can only apply through this 1-based ply (12 full moves). */
export const BOOK_MAX_PLY = 24

// ---- chessops board helpers (freechess-exact hanging/attacker model) -------------

const ROLE_VALUES: Record<Role, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: Infinity
}

/** Piece value for exchange logic; the king counts as infinite (freechess parity). */
function roleValue(role: Role): number {
  return ROLE_VALUES[role]
}

const PROMO_ROLES: Role[] = ['queen', 'knight', 'rook', 'bishop']

function setupPos(fen: string): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  const pos = Chess.fromSetup(setup.value)
  return pos.isErr ? null : pos.value
}

/** Position with side-to-move forced to `turn` and en passant cleared (S4 attackers). */
function posWithTurn(fen: string, turn: Color): Chess | null {
  const setup = parseFen(fen)
  if (setup.isErr) return null
  setup.value.turn = turn
  setup.value.epSquare = undefined
  const pos = Chess.fromSetup(setup.value)
  return pos.isErr ? null : pos.value
}

interface InfluencingPiece {
  square: Square
  role: Role
}

/**
 * Enemy pieces of `color` with a legal capture of `sq` (side-to-move flipped, en
 * passant cleared), plus an adjacent `color` king if that capture is legal or
 * another attacker exists (battery counting; freechess getAttackers).
 */
function getAttackers(fen: string, sq: Square, color: Color): InfluencingPiece[] {
  const pos = posWithTurn(fen, color)
  if (!pos) return []
  const out: InfluencingPiece[] = []
  const ctx = pos.ctx()
  for (const [from, dests] of pos.allDests(ctx)) {
    if (!dests.has(sq)) continue
    const piece = pos.board.get(from)
    if (!piece || piece.role === 'king') continue
    out.push({ square: from, role: piece.role })
  }
  const kingSq = pos.board.kingOf(color)
  if (kingSq !== undefined && kingAttacks(kingSq).has(sq)) {
    const legal = pos.dests(kingSq, ctx).has(sq)
    if (legal || out.length > 0) out.push({ square: kingSq, role: 'king' })
  }
  return out
}

/**
 * Defenders of the piece on `sq`: simulate the cheapest attacker's capture and
 * count the recapturers; with no attackers, plant an enemy queen on `sq` and
 * count its attackers (freechess getDefenders; the plant branch is kept for
 * parity even though H4 never consults defenders when attackers is empty).
 */
function getDefenders(fen: string, sq: Square): InfluencingPiece[] {
  const pos = setupPos(fen)
  const piece = pos?.board.get(sq)
  if (!pos || !piece) return []
  const enemy = opposite(piece.color)
  const attackers = getAttackers(fen, sq, enemy).sort(
    (a, b) => roleValue(a.role) - roleValue(b.role)
  )
  const cheapest = attackers[0]
  if (cheapest) {
    const sim = posWithTurn(fen, enemy)
    if (!sim) return []
    const needsPromo =
      cheapest.role === 'pawn' && squareRank(sq) === (enemy === 'white' ? 7 : 0)
    for (const promotion of needsPromo ? PROMO_ROLES : [undefined]) {
      const mv: NormalMove = { from: cheapest.square, to: sq, promotion }
      if (!sim.isLegal(mv)) continue
      const after = sim.clone()
      after.play(mv)
      return getAttackers(makeFen(after.toSetup()), sq, piece.color)
    }
    return []
  }
  const setup = parseFen(fen)
  if (setup.isErr) return []
  setup.value.turn = piece.color
  setup.value.epSquare = undefined
  setup.value.board.take(sq)
  setup.value.board.set(sq, { role: 'queen', color: enemy })
  const planted = Chess.fromSetup(setup.value)
  if (planted.isErr) return []
  return getAttackers(makeFen(planted.value.toSetup()), sq, piece.color)
}

/**
 * Is the piece on `sq` (in fenAfter) hanging? freechess-exact (REVIEW-SPEC S4):
 *  H1. Not hanging if it just completed an equal-or-better trade on sq.
 *  H2. Not hanging if a rook just took a minor defended by exactly one minor.
 *  H3. Hanging if ANY attacker is cheaper than the piece.
 *  H4. If attackers > defenders: not hanging iff (piece < cheapest attacker AND
 *      some defender < that attacker) or any defender is a pawn; else hanging.
 *  H5. Otherwise not hanging.
 */
export function isPieceHanging(fenBefore: string, fenAfter: string, sq: Square): boolean {
  const before = setupPos(fenBefore)
  const after = setupPos(fenAfter)
  const piece = after?.board.get(sq)
  if (!after || !piece) return false
  const lastPiece = before?.board.get(sq)

  const attackers = getAttackers(fenAfter, sq, opposite(piece.color))
  const defenders = getDefenders(fenAfter, sq)

  // H1: equal-or-better trade just completed on this square.
  if (
    lastPiece &&
    lastPiece.color !== piece.color &&
    roleValue(lastPiece.role) >= roleValue(piece.role)
  ) {
    return false
  }

  // H2: favourable rook-takes-minor "defended" by exactly one minor.
  if (
    piece.role === 'rook' &&
    lastPiece &&
    lastPiece.color !== piece.color &&
    roleValue(lastPiece.role) === 3 &&
    attackers.length === 1 &&
    attackers.every((a) => roleValue(a.role) === 3)
  ) {
    return false
  }

  // H3: any attacker cheaper than the piece.
  if (attackers.some((a) => roleValue(a.role) < roleValue(piece.role))) return true

  // H4: more attackers than defenders.
  if (attackers.length > defenders.length) {
    let minAttackerValue = Infinity
    for (const a of attackers) minAttackerValue = Math.min(minAttackerValue, roleValue(a.role))
    if (
      roleValue(piece.role) < minAttackerValue &&
      defenders.some((d) => roleValue(d.role) < minAttackerValue)
    ) {
      return false
    }
    if (defenders.some((d) => d.role === 'pawn')) return false
    return true
  }

  // H5.
  return false
}

/** Does the side to move have a mate in 1 (any legal move that checkmates)? */
function hasMateInOne(pos: Chess): boolean {
  const ctx = pos.ctx()
  for (const [from, dests] of pos.allDests(ctx)) {
    const isPawn = pos.board.get(from)?.role === 'pawn'
    for (const to of dests) {
      const promos = isPawn && SquareSet.backranks().has(to) ? PROMO_ROLES : [undefined]
      for (const promotion of promos) {
        const child = pos.clone()
        try {
          child.play({ from, to, promotion })
        } catch {
          continue
        }
        if (child.isCheckmate()) return true
      }
    }
  }
  return false
}

/** Value of the piece captured by `playedUci` at fenBefore (0 for quiet moves). */
function capturedValue(before: Chess, playedUci: string): number {
  const mv = parseUci(playedUci)
  if (!mv || !('to' in mv) || !('from' in mv)) return 0
  const target = before.board.get(mv.to)
  if (target && target.color !== before.turn) {
    const v = roleValue(target.role)
    return Number.isFinite(v) ? v : 0
  }
  // en passant: pawn changes file onto an empty square
  const moverPiece = before.board.get(mv.from)
  if (!target && moverPiece?.role === 'pawn' && (mv.from & 7) !== (mv.to & 7)) return 1
  return 0
}

/**
 * S4-B6 sacrifice detector: mover knights/bishops/rooks/queens left hanging by the
 * played move whose value STRICTLY exceeds what the move just captured.
 */
function detectSacrifice(
  fenBefore: string,
  fenAfter: string,
  playedUci: string
): InfluencingPiece[] {
  const before = setupPos(fenBefore)
  const after = setupPos(fenAfter)
  if (!before || !after) return []
  const moverColor = before.turn
  const captured = capturedValue(before, playedUci)
  const out: InfluencingPiece[] = []
  for (const role of ['knight', 'bishop', 'rook', 'queen'] as Role[]) {
    if (roleValue(role) <= captured) continue
    for (const sq of after.board.pieces(moverColor, role)) {
      if (isPieceHanging(fenBefore, fenAfter, sq)) out.push({ square: sq, role })
    }
  }
  return out
}

/**
 * S4-B7 viability: at least one hanging sac piece must be actually takable. A
 * capture is NOT viable if it counter-hangs a capturer's piece worth >= the max
 * sacrificed value, or (minor sacs only) lets the sacrificer mate in 1.
 */
function anySacrificeViablyCapturable(fenAfter: string, sacs: InfluencingPiece[]): boolean {
  const base = setupPos(fenAfter)
  if (!base || sacs.length === 0) return false
  const oppColor = base.turn // the opponent is to move after the played move
  let maxSacValue = 0
  for (const s of sacs) maxSacValue = Math.max(maxSacValue, roleValue(s.role))
  for (const sac of sacs) {
    for (const attacker of getAttackers(fenAfter, sac.square, oppColor)) {
      const needsPromo =
        attacker.role === 'pawn' && squareRank(sac.square) === (oppColor === 'white' ? 7 : 0)
      for (const promotion of needsPromo ? PROMO_ROLES : [undefined]) {
        const mv: NormalMove = { from: attacker.square, to: sac.square, promotion }
        if (!base.isLegal(mv)) continue
        const afterCapture = base.clone()
        afterCapture.play(mv)
        const fenAfterCapture = makeFen(afterCapture.toSetup())
        // (i) pin / counter-win refutation: a capturer piece >= max sac value hangs.
        let refuted = false
        for (const [sq, piece] of afterCapture.board) {
          if (piece.color !== oppColor || piece.role === 'king' || piece.role === 'pawn') continue
          if (roleValue(piece.role) < maxSacValue) continue
          if (isPieceHanging(fenAfter, fenAfterCapture, sq)) {
            refuted = true
            break
          }
        }
        if (refuted) continue
        // (ii) minors only: not viable if the sacrificer now has mate in 1.
        if (roleValue(sac.role) < 5 && hasMateInOne(afterCapture)) continue
        return true
      }
    }
  }
  return false
}

function countLegalMoves(pos: Chess): number {
  let n = 0
  const ctx = pos.ctx()
  for (const [, dests] of pos.allDests(ctx)) {
    n += dests.size()
    if (n > 1) return n
  }
  return n
}

// ---- isBest (S2) ------------------------------------------------------------------

/**
 * S2: the played move is "best" when it matches the engine's PV1 move exactly, or
 * matches PV2 whose eval (same fenBefore snapshot) is within CO_BEST_GAP win-points
 * of PV1. Pass canonicalised UCIs (castling normalised) for exact comparison.
 */
export function computeIsBest(
  playedUci: string,
  bestUci: string,
  secondUci: string | null,
  bestEval: EvalScore,
  secondEval: EvalScore | null
): boolean {
  if (playedUci === bestUci) return true
  if (secondUci != null && playedUci === secondUci && secondEval != null) {
    const secondWin = winPercent(secondEval.cp ?? null, secondEval.mate ?? null)
    const bestWin = winPercent(bestEval.cp ?? null, bestEval.mate ?? null)
    return secondWin >= bestWin - CO_BEST_GAP
  }
  return false
}

// ---- Badge classification (S3-S9) ---------------------------------------------------

export interface BadgeInput {
  /** FEN of the position the mover faced. */
  fenBefore: string
  /** FEN after the played move. */
  fenAfter: string
  /** Played move (UCI) — used for the sacrifice / hanging-destination board tests. */
  playedUci: string
  /** Played move SAN (S4-B4: promotions are never Brilliant). */
  playedSan: string
  /** S2 isBest (co-best aware, incl. the delivered-checkmate override). */
  isBest: boolean
  /** Engine eval of the best line at fenBefore, mover POV. */
  bestEval: EvalScore
  /** Eval after the played move, mover POV (PV2's eval when the move matched PV2). */
  playedEval: EvalScore
  /** Engine eval of the second line at fenBefore, mover POV (null without MultiPV 2). */
  secondEval: EvalScore | null
  /** S3.2 Book: unbroken openings-DB prefix hit at ply <= BOOK_MAX_PLY (caller-computed). */
  inBook: boolean
  /** FINAL badge (post-caps) of the opponent's immediately preceding move. */
  prevOppFinalBadge: MoveBadge | null
}

export interface BadgeResult {
  badge: MoveBadge
  verdict: ReviewVerdict
  /** The piece given up when badge === 'Brilliant' (S4-B6 detector), else null. */
  sacrificedRole: Role | null
}

/** S8: the verdict is DERIVED from the final badge so chip and verdict never disagree. */
export function badgeToVerdict(badge: MoveBadge): ReviewVerdict {
  switch (badge) {
    case 'Blunder':
      return 'blunder'
    case 'Mistake':
    case 'Miss':
      return 'mistake'
    case 'Inaccuracy':
      return 'inaccuracy'
    default:
      return 'ok'
  }
}

/** S3.4 mate-transition table (freechess-exact). Returns null when both evals are cp. */
function mateTableLabel(
  pMate: number | null,
  aMate: number | null,
  aCp: number
): MoveBadge | null {
  // (a) cp -> mate
  if (pMate == null && aMate != null) {
    if (aMate > 0) return 'Best'
    if (aMate >= -2) return 'Blunder'
    if (aMate >= -5) return 'Mistake'
    return 'Inaccuracy'
  }
  // (b) mate -> cp
  if (pMate != null && aMate == null) {
    if (pMate < 0 && aCp < 0) return 'Best'
    if (aCp >= 400) return 'Good'
    if (aCp >= 150) return 'Inaccuracy'
    if (aCp >= -100) return 'Mistake'
    return 'Blunder'
  }
  // (c) mate -> mate
  if (pMate != null && aMate != null) {
    if (pMate > 0) {
      if (aMate <= -4) return 'Mistake'
      if (aMate < 0) return 'Blunder'
      if (aMate < pMate) return 'Best'
      if (aMate <= pMate + 2) return 'Excellent'
      return 'Good'
    }
    if (pMate < 0) return aMate === pMate ? 'Best' : 'Good'
    // pMate === 0 cannot occur for a side that has a move; fall through to bands.
  }
  return null
}

/** S1 band table on drop (win-points). Best is never awarded here. */
function bandLabel(drop: number): MoveBadge {
  if (drop > DROP_MISTAKE) return 'Blunder'
  if (drop > DROP_INACCURACY) return 'Mistake'
  if (drop > DROP_GOOD) return 'Inaccuracy'
  if (drop > DROP_EXCELLENT) return 'Good'
  return 'Excellent'
}

/** S4 Brilliant gates B2-B7 (B1 = label Best is enforced by the caller). */
function brilliantSacrifice(
  i: BadgeInput,
  winAfter: number,
  secondWin: number | null,
  posBefore: Chess | null
): Role | null {
  // B2: the mover must not be worse after the move.
  if (winAfter < BRILLIANT_HOLD) return null
  // B3: not "winning anyways" — second line unavailable fails conservatively.
  if (secondWin == null) return null
  if (secondWin >= SECOND_LINE_WINNING) return null
  if ((i.bestEval.mate ?? 0) > 0 && (i.secondEval?.mate ?? 0) > 0) return null
  // B4: no promotions.
  if (i.playedSan.includes('=')) return null
  // B5: the mover was not in check before the move.
  if (posBefore?.isCheck()) return null
  // B6: a mover piece hangs, worth strictly more than what the move captured.
  const sacs = detectSacrifice(i.fenBefore, i.fenAfter, i.playedUci)
  if (sacs.length === 0) return null
  // B7: some sac piece must be viably capturable.
  if (!anySacrificeViablyCapturable(i.fenAfter, sacs)) return null
  let best = sacs[0]
  for (const s of sacs) if (roleValue(s.role) > roleValue(best.role)) best = s
  return best.role
}

/** S5 Great gates G2-G5 (G1 = label Best + Brilliant failed enforced by caller). */
function greatUpgrade(i: BadgeInput, winAfter: number, secondWin: number | null): boolean {
  // G2: both evals cp (no mates either side).
  if (i.bestEval.mate != null || i.playedEval.mate != null) return false
  // G3: the opponent's immediately preceding move's FINAL badge is Blunder.
  if (i.prevOppFinalBadge !== 'Blunder') return false
  // G4: the second line is much worse.
  if (secondWin == null || winAfter - secondWin < GREAT_ONLY_GAP) return false
  // G5: the moved piece is not hanging on its destination square.
  const mv = parseUci(i.playedUci)
  if (mv && 'to' in mv && isPieceHanging(i.fenBefore, i.fenAfter, mv.to)) return false
  return true
}

/**
 * Classify one move per REVIEW-SPEC S9:
 * 1 Forced, 2 Book, 3 Best (S2) else mate table (S3.4) else band (S1),
 * 4 Brilliant upgrade, 5 Great upgrade, 6 Miss relabel, 7 caps C1/C2,
 * 8 verdict := badgeToVerdict(badge). All evals are MOVER POV.
 */
export function classifyBadge(i: BadgeInput): BadgeResult {
  const winBefore = winPercent(i.bestEval.cp ?? null, i.bestEval.mate ?? null)
  const winAfter = winPercent(i.playedEval.cp ?? null, i.playedEval.mate ?? null)
  const drop = Math.max(0, winBefore - winAfter)
  const secondWin = i.secondEval
    ? winPercent(i.secondEval.cp ?? null, i.secondEval.mate ?? null)
    : null

  const posBefore = setupPos(i.fenBefore)
  let sacrificedRole: Role | null = null
  let badge: MoveBadge

  // 1. Forced short-circuits everything.
  if (posBefore && countLegalMoves(posBefore) <= 1) {
    badge = 'Forced'
  } else if (i.inBook) {
    // 2. Book, checked BEFORE Best/bands; no sub-classification.
    badge = 'Book'
  } else {
    // 3. Best, else mate table, else band.
    if (i.isBest) {
      badge = 'Best'
    } else {
      const pMate = i.bestEval.mate ?? null
      const aMate = i.playedEval.mate ?? null
      badge =
        pMate != null || aMate != null
          ? (mateTableLabel(pMate, aMate, i.playedEval.cp ?? 0) ?? bandLabel(drop))
          : bandLabel(drop)
    }

    // 4./5. Brilliant then Great, upgrades from Best only.
    if (badge === 'Best') {
      const sac = brilliantSacrifice(i, winAfter, secondWin, posBefore)
      if (sac) {
        badge = 'Brilliant'
        sacrificedRole = sac
      } else if (greatUpgrade(i, winAfter, secondWin)) {
        badge = 'Great'
      }
    }

    // 6. Miss relabels a would-be Mistake or Blunder when an opportunity was lost
    //    (not the game): opponent slipped last ply / a mate was on / mover was winning,
    //    AND the mover is still not worse than equal after the move.
    if (badge === 'Mistake' || badge === 'Blunder') {
      const prev = i.prevOppFinalBadge
      const opportunity =
        prev === 'Inaccuracy' ||
        prev === 'Mistake' ||
        prev === 'Miss' ||
        prev === 'Blunder' ||
        (i.bestEval.mate ?? 0) > 0 ||
        winBefore >= MISS_WINNING_BEFORE
      if (opportunity && winAfter >= 50) badge = 'Miss'
    }

    // 7. Blunder caps C1/C2 (defense in depth: still-winning / already-lost).
    if (badge === 'Blunder') {
      const playedIsCp = i.playedEval.mate == null
      if (playedIsCp && winAfter >= CAP_STILL_WINNING) badge = 'Good'
      else if (playedIsCp && i.bestEval.mate == null && winBefore <= CAP_ALREADY_LOST) {
        badge = 'Good'
      }
    }
  }

  return { badge, verdict: badgeToVerdict(badge), sacrificedRole }
}

// ---- Canonical UCI + SAN helpers (shared by review.ts and the comment builder) -----

/**
 * Canonicalise a UCI string at a position: castling gets the chessops king-to-rook
 * encoding so engine "e1g1" and chessops "e1h1" compare equal. Unparseable input
 * is returned as-is.
 */
export function canonicalUci(fen: string, uci: string): string {
  const pos = setupPos(fen)
  const mv = parseUci(uci)
  if (!pos || !mv || !('from' in mv)) return uci
  try {
    return makeUci(normalizeMove(pos, mv))
  } catch {
    return uci
  }
}

/** SAN-ify up to `max` UCI moves walked from `fen`; stops at the first illegal move. */
export function sanLine(fen: string, ucis: string[], max = 3): string[] {
  const pos = setupPos(fen)
  if (!pos) return []
  const out: string[] = []
  for (const u of ucis) {
    if (out.length >= max) break
    const mv = parseUci(u)
    if (!mv || !pos.isLegal(mv)) break
    out.push(makeSan(pos, mv))
    pos.play(mv)
  }
  return out
}

// ---- Factual review comments (COMMENT-SPEC) -----------------------------------------

export interface CommentInput {
  /** FINAL badge (post Miss/caps). */
  badge: MoveBadge
  /** Mover color (evals are rendered WHITE-POV per COMMENT-SPEC R3). */
  color: 'white' | 'black'
  san: string
  bestSan: string
  /** SAN of the engine's second line first move (Great template); null if none. */
  secondSan: string | null
  /** Best-line eval at fenBefore, mover POV. */
  bestEval: EvalScore
  /** Eval after the played move, mover POV. */
  playedEval: EvalScore
  /** First 2-3 opponent-reply SANs from the played line (fenAfter), for Mistake/Blunder/Miss. */
  refSans: string[]
  /** Opening name for Book moves (openings.repo lookup). */
  openingName?: string | null
  /** Sacrificed piece for Brilliant (S4-B6 detector). */
  sacrificedRole?: Role | string | null
}

/** White-POV eval string: "+2.3" / "-0.5" pawns, or "mate in n for White/Black". */
function fmtEvalWhite(e: EvalScore, color: 'white' | 'black'): string {
  if (e.mate != null) {
    const whiteMate = color === 'white' ? e.mate : -e.mate
    return `mate in ${Math.abs(whiteMate)} for ${whiteMate >= 0 ? 'White' : 'Black'}`
  }
  const cp = e.cp ?? 0
  let pawns = Math.round((color === 'white' ? cp : -cp) / 10) / 10
  if (Object.is(pawns, -0)) pawns = 0
  return pawns >= 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1)
}

/**
 * COMMENT-SPEC templates, computed from the FINAL badge. Derived ONLY from review
 * data (SANs, PV, eval numbers, opening name, sacrifice piece) — never board-scan
 * motif guesses. Plain SANs, at most one eval mention, <= ~180 chars.
 */
export function buildComment(i: CommentInput): string {
  const ref = i.refSans.slice(0, 3).join(' ')
  switch (i.badge) {
    case 'Book':
      return i.openingName
        ? `${i.san} is a book move — ${i.openingName}.`
        : `${i.san} is a book move.`
    case 'Forced':
      return `${i.san} was forced — the only legal move.`
    case 'Brilliant': {
      const name = pieceName(i.sacrificedRole)
      return `${i.san} is brilliant! Giving up the ${name} is the best move here.`
    }
    case 'Great':
      return i.secondSan
        ? `${i.san} is a great move — the only good move here. The next best, ${i.secondSan}, was much worse.`
        : `${i.san} is a great move — the only good move here.`
    case 'Best':
      return `${i.san} is the best move.`
    case 'Excellent':
      return i.bestSan && i.bestSan !== i.san
        ? `${i.san} is excellent. Nearly as strong as ${i.bestSan}.`
        : `${i.san} is excellent.`
    case 'Good':
      return `${i.san} is a good move. ${i.bestSan} was more accurate.`
    case 'Inaccuracy':
      return `${i.san} is an inaccuracy. ${i.bestSan} was better (${fmtEvalWhite(i.bestEval, i.color)} → ${fmtEvalWhite(i.playedEval, i.color)}).`
    case 'Mistake':
      return ref
        ? `${i.san} is a mistake. ${i.bestSan} was best. Now ${ref} (${fmtEvalWhite(i.playedEval, i.color)}).`
        : `${i.san} is a mistake. ${i.bestSan} was best (${fmtEvalWhite(i.playedEval, i.color)}).`
    case 'Miss': {
      if ((i.bestEval.mate ?? 0) > 0) {
        return `${i.san} misses a forced mate. ${i.bestSan} led to mate in ${i.bestEval.mate}.`
      }
      const kept = `${i.san} misses the chance. ${i.bestSan} kept a winning advantage (${fmtEvalWhite(i.bestEval, i.color)}).`
      return ref ? `${kept} Now ${ref}.` : kept
    }
    case 'Blunder': {
      const mateAgainst = (i.playedEval.mate ?? 0) < 0
      if (mateAgainst) {
        const n = Math.abs(i.playedEval.mate as number)
        return ref
          ? `${i.san} is a blunder. ${i.bestSan} was best. Now ${ref} — this allows mate in ${n}.`
          : `${i.san} is a blunder. ${i.bestSan} was best — this allows mate in ${n}.`
      }
      return ref
        ? `${i.san} is a blunder. ${i.bestSan} was best. Now ${ref} (${fmtEvalWhite(i.playedEval, i.color)}).`
        : `${i.san} is a blunder. ${i.bestSan} was best (${fmtEvalWhite(i.playedEval, i.color)}).`
    }
  }
}

function pieceName(role: Role | string | null | undefined): string {
  switch (role) {
    case 'knight':
    case 'n':
      return 'knight'
    case 'bishop':
    case 'b':
      return 'bishop'
    case 'rook':
    case 'r':
      return 'rook'
    case 'queen':
    case 'q':
      return 'queen'
    default:
      return 'piece'
  }
}
