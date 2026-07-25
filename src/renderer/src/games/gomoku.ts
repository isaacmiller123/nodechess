// Gomoku (five in a row): hand-rolled rules, no engine dependency
// (docs/GAMES-PLATFORM-SPEC.md §Approved stack: small games are hand-rolled).
//
// Freestyle rules: black moves first, five OR MORE in a row (overlines win)
// horizontally, vertically or diagonally wins; a full board is a draw. The
// standard board is 15×15; `size` is an option so tests (and future modes)
// can use smaller boards.
//
// Move codec: go-style vertices ('h8': columns a.. skipping 'i', rank 1 at
// the bottom), shared with games/go.ts. Board layout is intersections, like
// go, and Shudan renders it with the same signMap convention.
//
// Bots (P2w2): freestyle has no opening restriction, but the convention (and
// the strongest first move) is the center point. GOMOKU_CENTER below is the
// canonical opening for bot providers.

import type { GameResult, GameSpec, MoveMeta, PlayerColor } from './kernel'
import { GO_COL_LETTERS, goLikeNotation, pointToVertex, vertexToPoint } from './go'

export const GOMOKU_SIZE = 15
/** Center of the standard 15×15 board: canonical bot opening move. */
export const GOMOKU_CENTER = 'h8'

export interface GomokuOptions {
  /** Board side length, 5..19 (default 15). */
  size?: number
}

export interface GomokuState {
  readonly size: number
  /** Row-major from the TOP-LEFT (index y * size + x); null = empty. */
  readonly cells: readonly (PlayerColor | null)[]
  /** Codec moves in play order. */
  readonly moves: readonly string[]
  /** Set as soon as a five (or more) in a row appears. */
  readonly winner: PlayerColor | null
}

function initGomoku(options?: unknown): GomokuState {
  const o = (options ?? {}) as GomokuOptions
  const size = o.size ?? GOMOKU_SIZE
  if (!Number.isInteger(size) || size < 5 || size > GO_COL_LETTERS.length) {
    throw new Error(`gomoku: unsupported board size ${size}`)
  }
  return { size, cells: new Array<PlayerColor | null>(size * size).fill(null), moves: [], winner: null }
}

function turnOfGomoku(s: GomokuState): PlayerColor {
  return s.moves.length % 2 === 0 ? 'black' : 'white'
}

function isOver(s: GomokuState): boolean {
  return s.winner !== null || s.moves.length === s.size * s.size
}

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal ↘
  [1, -1] // diagonal ↙
]

/** Freestyle five detection through the stone just placed at (y, x). */
function makesFive(cells: readonly (PlayerColor | null)[], size: number, y: number, x: number): boolean {
  const color = cells[y * size + x]
  for (const [dy, dx] of DIRECTIONS) {
    let run = 1
    for (const sign of [1, -1]) {
      let ny = y + dy * sign
      let nx = x + dx * sign
      while (ny >= 0 && ny < size && nx >= 0 && nx < size && cells[ny * size + nx] === color) {
        run++
        ny += dy * sign
        nx += dx * sign
      }
    }
    if (run >= 5) return true
  }
  return false
}

function legalMovesOf(s: GomokuState): string[] {
  if (isOver(s)) return []
  const out: string[] = []
  for (let y = 0; y < s.size; y++) {
    for (let x = 0; x < s.size; x++) {
      if (s.cells[y * s.size + x] === null) out.push(pointToVertex(y, x, s.size))
    }
  }
  return out
}

function playOn(s: GomokuState, move: string): GomokuState | null {
  if (isOver(s)) return null
  const p = vertexToPoint(move, s.size)
  if (!p || s.cells[p.y * s.size + p.x] !== null) return null
  const color = turnOfGomoku(s)
  const cells = s.cells.slice()
  cells[p.y * s.size + p.x] = color
  const winner = makesFive(cells, s.size, p.y, p.x) ? color : null
  return { size: s.size, cells, moves: [...s.moves, move], winner }
}

function resultOf(s: GomokuState): GameResult | null {
  if (s.winner !== null) {
    // Color-anchored like chess: '1-0' = white wins.
    return {
      winner: s.winner,
      score: s.winner === 'white' ? '1-0' : '0-1',
      reason: 'five-in-a-row'
    }
  }
  if (s.moves.length === s.size * s.size) {
    return { winner: null, score: '1/2-1/2', reason: 'board-full' }
  }
  return null
}

function moveMetaOf(s: GomokuState, move: string): MoveMeta {
  if (isOver(s)) return {}
  const p = vertexToPoint(move, s.size)
  if (!p || s.cells[p.y * s.size + p.x] !== null) return {}
  return { capture: false, sound: 'move' }
}

/** Shudan-convention sign map: row 0 = top row; 1 = black, -1 = white, 0 = empty. */
export function gomokuSignMapOf(s: GomokuState): number[][] {
  return Array.from({ length: s.size }, (_, y) =>
    Array.from({ length: s.size }, (_, x) => {
      const c = s.cells[y * s.size + x]
      return c === 'black' ? 1 : c === 'white' ? -1 : 0
    })
  )
}

export { turnOfGomoku }

export const GOMOKU_SPEC: GameSpec<GomokuState> = {
  kind: 'gomoku',
  family: 'grid',
  title: 'Gomoku',
  tagline: 'Five in a row wins. Simple to learn, vicious to master.',
  players: ['black', 'white'],
  board: { layout: 'intersections', files: GOMOKU_SIZE, ranks: GOMOKU_SIZE },
  flipPolicy: 'none',
  clock: { supported: true },
  init: initGomoku,
  legalMoves: legalMovesOf,
  play: playOn,
  result: resultOf,
  moveMeta: moveMetaOf,
  // Same 'B H8' / 'W Q16' convention as go ('pass' never occurs in gomoku).
  notate: (s: GomokuState, move: string): string => goLikeNotation(turnOfGomoku(s), move),
  serializeOptions: (o: unknown): string =>
    JSON.stringify({ size: ((o ?? {}) as GomokuOptions).size ?? GOMOKU_SIZE })
}
