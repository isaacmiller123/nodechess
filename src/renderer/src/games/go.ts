// Go. GameSpec over tenuki (docs/GAMES-PLATFORM-SPEC.md §Approved stack, P2).
//
// tenuki is the rules authority (captures, suicide, positional superko,
// dead-stone marking, area/territory scoring). Its Game object is MUTABLE, so
// to satisfy the kernel's immutable-state contract a GoState is just the
// replayable description of the game: options + move list + scoring-phase
// marks, and a tenuki Game is lazily rebuilt per state (WeakMap-cached, so
// each state replays at most once; states never mutate after creation).
//
// Move codec: 'd4'-style vertices + 'pass'. Columns are a..t SKIPPING i
// (standard go convention, matches tenuki/Shudan coordinate labels), ranks
// count from the BOTTOM (rank 1 = bottom row). Resigns stay session-level,
// exactly like the chess family. The codec is coords|pass only.
//
// End of game / scoring seam (P2 wave 2 builds the marking UI on top):
//   - two consecutive passes end move play: legalMoves → [], but result stays
//     null while dead-stone marking is unresolved;
//   - markDead(s, vertex) toggles a stone group's dead status (tenuki expands
//     the mark to the whole group);
//   - finalizeScore(s) resolves scoring: result then reports the area score
//     with unmarked stones treated as alive (mark nothing → all stones live).

import { Game as TenukiGame } from 'tenuki'
import type { GameResult, GameSpec, MoveMeta, PlayerColor } from './kernel'

// ---------------------------------------------------------------------------
// Options & state

export type GoSize = 9 | 13 | 19
export type GoScoring = 'area' | 'territory'
/** Standard hoshi handicap: 0 = even game; 1 is not a thing (that's just komi). */
export type GoHandicap = 0 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export interface GoOptions {
  size?: GoSize
  komi?: number
  scoring?: GoScoring
  /** Pre-placed black hoshi stones (tenuki placement tables); WHITE moves
   *  first when handicap ≥ 2, and komi defaults down to 0.5. */
  handicap?: GoHandicap
}

export interface GoState {
  readonly size: GoSize
  readonly komi: number
  readonly scoring: GoScoring
  /** Handicap stones pre-placed for black (0 or 2..9). White opens when ≥ 2. */
  readonly handicap: GoHandicap
  /** Codec moves in play order: 'd4' vertices + 'pass'. */
  readonly moves: readonly string[]
  /** Scoring-phase dead-stone TOGGLES (vertices), applied in order after replay. */
  readonly deadMarks: readonly string[]
  /** True once dead-stone marking is resolved; result() reports a score. */
  readonly finalized: boolean
}

const GO_SIZES: readonly GoSize[] = [9, 13, 19]
const GO_HANDICAPS: readonly GoHandicap[] = [0, 2, 3, 4, 5, 6, 7, 8, 9]
const DEFAULT_OPTIONS: Required<GoOptions> = { size: 19, komi: 6.5, scoring: 'area', handicap: 0 }
/** Conventional komi for a handicap game (the stones ARE the compensation). */
export const HANDICAP_KOMI = 0.5

function normalizeOptions(options?: unknown): Required<GoOptions> {
  const o = (options ?? {}) as GoOptions
  const size = o.size ?? DEFAULT_OPTIONS.size
  if (!GO_SIZES.includes(size)) throw new Error(`go: unsupported board size ${size}`)
  const handicap = o.handicap ?? DEFAULT_OPTIONS.handicap
  if (!GO_HANDICAPS.includes(handicap)) throw new Error(`go: unsupported handicap ${handicap}`)
  // Handicap games default to the conventional 0.5 komi (no draw, no double
  // compensation); an explicit komi option still wins.
  const komi = typeof o.komi === 'number' ? o.komi : handicap >= 2 ? HANDICAP_KOMI : DEFAULT_OPTIONS.komi
  const scoring = o.scoring === 'territory' ? 'territory' : DEFAULT_OPTIONS.scoring
  return { size, komi, scoring, handicap }
}

// ---------------------------------------------------------------------------
// Vertex codec ('d4' ↔ tenuki top-left y/x). Shared with gomoku.

/** Column letters in go convention: 'i' is skipped. */
export const GO_COL_LETTERS = 'abcdefghjklmnopqrst'

export interface BoardPoint {
  /** Row from the top (tenuki convention). */
  y: number
  /** Column from the left. */
  x: number
}

export function vertexToPoint(vertex: string, size: number): BoardPoint | null {
  const m = /^([a-hj-t])(\d{1,2})$/.exec(vertex)
  if (!m) return null
  const x = GO_COL_LETTERS.indexOf(m[1])
  const rank = Number(m[2])
  if (x < 0 || x >= size || rank < 1 || rank > size) return null
  return { y: size - rank, x }
}

export function pointToVertex(y: number, x: number, size: number): string {
  return `${GO_COL_LETTERS[x]}${size - y}`
}

// ---------------------------------------------------------------------------
// Handicap placement: the standard hoshi tables, mirroring tenuki's
// BoardState._initialFor exactly (tenuki does the actual placement inside
// gameFor via `handicapStones`; this export exists so engine requests and
// tests can name the same vertices without reaching into tenuki internals).

/** The hoshi vertices tenuki pre-places for `handicap` black stones on a
 *  9/13/19 board, in tenuki's own placement order. Empty for handicap 0. */
export function handicapPlacement(size: GoSize, handicap: GoHandicap): string[] {
  if (handicap < 2) return []
  const off = size > 11 ? 3 : 2 // hoshi offset from the edge (tenuki rule)
  const mid = (size - 1) / 2
  const v = (y: number, x: number): string => pointToVertex(y, x, size)
  const topRight = v(off, size - off - 1)
  const bottomLeft = v(size - off - 1, off)
  const bottomRight = v(size - off - 1, size - off - 1)
  const topLeft = v(off, off)
  const middle = v(mid, mid)
  const middleLeft = v(mid, off)
  const middleRight = v(mid, size - off - 1)
  const middleTop = v(off, mid)
  const middleBottom = v(size - off - 1, mid)
  const tables: Record<number, string[]> = {
    2: [topRight, bottomLeft],
    3: [topRight, bottomLeft, bottomRight],
    4: [topRight, bottomLeft, bottomRight, topLeft],
    5: [topRight, bottomLeft, bottomRight, topLeft, middle],
    6: [topRight, bottomLeft, bottomRight, topLeft, middleLeft, middleRight],
    7: [topRight, bottomLeft, bottomRight, topLeft, middleLeft, middleRight, middle],
    8: [topRight, bottomLeft, bottomRight, topLeft, middleLeft, middleRight, middleTop, middleBottom],
    9: [topRight, bottomLeft, bottomRight, topLeft, middleLeft, middleRight, middleTop, middleBottom, middle]
  }
  return tables[handicap]
}

// ---------------------------------------------------------------------------
// State → tenuki Game (lazy, cached; a state's game is NEVER mutated after
// construction, so cache hits are safe).

const gameCache = new WeakMap<GoState, TenukiGame>()

function gameFor(s: GoState): TenukiGame {
  const cached = gameCache.get(s)
  if (cached) return cached
  const game = new TenukiGame({
    boardSize: s.size,
    komi: s.komi,
    scoring: s.scoring,
    koRule: 'positional-superko',
    // Fixed hoshi placement (tenuki's own tables: handicapPlacement mirrors
    // them); with ≥ 2 stones tenuki makes WHITE the side to move.
    handicapStones: s.handicap
  })
  for (const move of s.moves) {
    const applied =
      move === 'pass'
        ? game.pass({ render: false })
        : (() => {
            const p = vertexToPoint(move, s.size)
            return p ? game.playAt(p.y, p.x, { render: false }) : false
          })()
    if (!applied) throw new Error(`go: corrupt state. Replay rejected move '${move}'`)
  }
  for (const mark of s.deadMarks) {
    const p = vertexToPoint(mark, s.size)
    if (!p) throw new Error(`go: corrupt state, bad dead mark '${mark}'`)
    game.toggleDeadAt(p.y, p.x, { render: false })
  }
  gameCache.set(s, game)
  return game
}

// ---------------------------------------------------------------------------
// Spec functions

function initGo(options?: unknown): GoState {
  const { size, komi, scoring, handicap } = normalizeOptions(options)
  return { size, komi, scoring, handicap, moves: [], deadMarks: [], finalized: false }
}

function legalMovesOf(s: GoState): string[] {
  const g = gameFor(s)
  if (g.isOver()) return [] // scoring phase / finished: no board moves
  const out: string[] = []
  for (const i of g.intersections()) {
    if (i.isEmpty() && !g.isIllegalAt(i.y, i.x)) out.push(pointToVertex(i.y, i.x, s.size))
  }
  out.push('pass')
  return out
}

function playOn(s: GoState, move: string): GoState | null {
  const g = gameFor(s)
  if (g.isOver()) return null
  if (move !== 'pass') {
    const p = vertexToPoint(move, s.size)
    if (!p || g.isIllegalAt(p.y, p.x)) return null
  }
  return { ...s, moves: [...s.moves, move] }
}

function resultOf(s: GoState): GameResult | null {
  const g = gameFor(s)
  // Ongoing, or over but dead-stone marking unresolved (the scoring phase).
  if (!g.isOver() || !s.finalized) return null
  const { black, white } = g.score() // komi already added to white
  const winner: PlayerColor | null = black > white ? 'black' : white > black ? 'white' : null
  // GameScore stays color-anchored like chess: '1-0' = white wins.
  const score = winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '1/2-1/2'
  return { winner, score, reason: 'score' }
}

function moveMetaOf(s: GoState, move: string): MoveMeta {
  if (move === 'pass') return { capture: false, sound: 'move' }
  const g = gameFor(s)
  if (g.isOver()) return {}
  const p = vertexToPoint(move, s.size)
  if (!p || g.isIllegalAt(p.y, p.x)) return {}
  // Pure simulation on the current immutable board state (never pushed).
  const after = g.currentState().playAt(p.y, p.x, g.currentPlayer())
  const capture = after.capturedPositions.length > 0
  return { capture, sound: capture ? 'capture' : 'move' }
}

// ---------------------------------------------------------------------------
// Scoring seam + read-model helpers (consumed by GoBoard/bots/session, P2w2)

export interface GoSpec extends GameSpec<GoState> {
  /** True after two consecutive passes while the score is not yet finalized. */
  isScoringPhase(s: GoState): boolean
  /**
   * Toggle the dead status of the stone GROUP at `vertex` (tenuki expands the
   * mark). Scoring phase only; null if not in scoring phase / not a stone.
   */
  markDead(s: GoState, vertex: string): GoState | null
  /** Resolve scoring: unmarked stones count as alive. Scoring phase only. */
  finalizeScore(s: GoState): GoState | null
  /** Raw points (komi included in white). Non-null once the game is over. */
  scoreDetail(s: GoState): { black: number; white: number } | null
}

function isScoringPhase(s: GoState): boolean {
  return gameFor(s).isOver() && !s.finalized
}

function markDead(s: GoState, vertex: string): GoState | null {
  if (!isScoringPhase(s)) return null
  const p = vertexToPoint(vertex, s.size)
  if (!p || gameFor(s).intersectionAt(p.y, p.x).isEmpty()) return null
  return { ...s, deadMarks: [...s.deadMarks, vertex] }
}

function finalizeScore(s: GoState): GoState | null {
  if (!isScoringPhase(s)) return null
  return { ...s, finalized: true }
}

export function scoreDetail(s: GoState): { black: number; white: number } | null {
  const g = gameFor(s)
  if (!g.isOver()) return null
  return g.score()
}

/** Side to move. Black first in an even game, WHITE first when handicap ≥ 2
 *  (tenuki owns the rule). Meaningless once the game is over. */
export function turnOf(s: GoState): PlayerColor {
  return gameFor(s).currentPlayer()
}

/** Number of stones the given color has captured so far. */
export function capturesOf(s: GoState, by: PlayerColor): number {
  const st = gameFor(s).currentState()
  return by === 'black' ? st.whiteStonesCaptured : st.blackStonesCaptured
}

/** Shudan-convention sign map: row 0 = top row; 1 = black, -1 = white, 0 = empty. */
export function signMapOf(s: GoState): number[][] {
  const rows: number[][] = Array.from({ length: s.size }, () => new Array<number>(s.size).fill(0))
  for (const i of gameFor(s).intersections()) {
    rows[i.y][i.x] = i.isBlack() ? 1 : i.isWhite() ? -1 : 0
  }
  return rows
}

/** Marked-dead points (group-expanded), as codec vertices. Scoring phase UI. */
export function deadStonesOf(s: GoState): string[] {
  return gameFor(s)
    .deadStones()
    .map((p) => pointToVertex(p.y, p.x, s.size))
}

/**
 * The ko point (recapture currently banned) as a codec vertex, or null. Read
 * as: the previous move captured exactly ONE stone and playing back on that
 * point is illegal for the side to move, the classic ko shape. Board UI only.
 */
export function koVertexOf(s: GoState): string | null {
  const g = gameFor(s)
  if (g.isOver()) return null
  const st = g.currentState()
  // tenuki's INITIAL state carries no capturedPositions array. Guard it.
  if (st.pass || !Array.isArray(st.capturedPositions) || st.capturedPositions.length !== 1) return null
  const p = st.capturedPositions[0]
  if (!g.intersectionAt(p.y, p.x).isEmpty() || !g.isIllegalAt(p.y, p.x)) return null
  return pointToVertex(p.y, p.x, s.size)
}

/**
 * Territory read-model for the scoring phase: empty vertices owned by each
 * color with marked-dead stones treated as captures (tenuki recomputes as
 * marks toggle). Null while the game is still in move play.
 */
export function territoryOf(s: GoState): { black: string[]; white: string[] } | null {
  const g = gameFor(s)
  if (!g.isOver()) return null
  const t = g.territory()
  return {
    black: t.black.map((p) => pointToVertex(p.y, p.x, s.size)),
    white: t.white.map((p) => pointToVertex(p.y, p.x, s.size))
  }
}

/** Notation for the move about to be played (kernel notate contract): color
 *  prefix + uppercase vertex: 'B D4' / 'W Q16' (columns skip I, per the
 *  codec); 'pass' stays bare. Mover comes from turnOf, so handicap games
 *  (white opens) notate correctly. Shared with gomoku via goLikeNotation. */
export function goLikeNotation(mover: PlayerColor, move: string): string {
  if (move === 'pass') return 'pass'
  return `${mover === 'black' ? 'B' : 'W'} ${move.toUpperCase()}`
}

function notateOf(s: GoState, move: string): string {
  return goLikeNotation(turnOf(s), move)
}

// ---------------------------------------------------------------------------
// The spec

export const GO_SPEC: GoSpec = {
  kind: 'go',
  family: 'go',
  title: 'Go',
  tagline: 'Surround territory, capture stones, the deepest game on earth.',
  players: ['black', 'white'],
  // Kernel board shape is the DEFAULT (19×19); per-game size lives in state
  // (GoState.size). Boards must read the state, not this static shape.
  board: { layout: 'intersections', files: 19, ranks: 19 },
  flipPolicy: 'none',
  clock: { supported: true, byoyomi: true },
  init: initGo,
  legalMoves: legalMovesOf,
  play: playOn,
  result: resultOf,
  moveMeta: moveMetaOf,
  // Options can flip the opening side (handicap ≥ 2 → white first), so go
  // implements the kernel's optional turn() instead of relying on players[]
  // parity (see GameSpec.turn).
  turn: turnOf,
  notate: notateOf,
  serializeOptions: (o: unknown): string => JSON.stringify(normalizeOptions(o)),
  isScoringPhase,
  markDead,
  finalizeScore,
  scoreDetail
}
