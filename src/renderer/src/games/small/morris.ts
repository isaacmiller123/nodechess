// Nine Men's Morris: hand-rolled GameSpec (docs/GAMES-PLATFORM-SPEC.md).
//
// Board: the 24 standard points named on a 7x7 grid (a1..g7):
//   a7----d7----g7
//   |  b6--d6--f6 |
//   |  | c5-d5-e5 ||
//   a4-b4-c4  e4-f4-g4
//   |  | c3-d3-e3 ||
//   |  b2--d2--f2 |
//   a1----d1----g1
//
// Codec:
//   placement           'd1'
//   movement (adjacent) 'a1-a4'
//   flying (3 men left) 'a1-e5'   (same syntax; any empty point)
//   capture suffix      append 'x<point>' when the move completes a mill,
//                       e.g. 'a7xd5' or 'a1-a4xf2'. A mill-forming move is
//                       ONLY legal WITH a capture suffix; targets are opponent
//                       men not in a mill, unless ALL opponent men are in
//                       mills, in which case any man may be taken.
//
// Phases (per player): place (9 men in hand) → move (adjacent) → fly (3 men).
// Loss: fewer than 3 men once your hand is empty, or no legal move on your turn.

import type { GameResult, GameSpec, MoveMeta } from '../kernel'

export const MORRIS_POINTS: readonly string[] = [
  'a1', 'd1', 'g1', 'b2', 'd2', 'f2', 'c3', 'd3', 'e3',
  'a4', 'b4', 'c4', 'e4', 'f4', 'g4', 'c5', 'd5', 'e5',
  'b6', 'd6', 'f6', 'a7', 'd7', 'g7'
]

const INDEX_OF: ReadonlyMap<string, number> = new Map(MORRIS_POINTS.map((p, i) => [p, i]))

export const MORRIS_ADJACENT: ReadonlyArray<readonly number[]> = [
  /* a1 */ [1, 9],
  /* d1 */ [0, 2, 4],
  /* g1 */ [1, 14],
  /* b2 */ [4, 10],
  /* d2 */ [1, 3, 5, 7],
  /* f2 */ [4, 13],
  /* c3 */ [7, 11],
  /* d3 */ [4, 6, 8],
  /* e3 */ [7, 12],
  /* a4 */ [0, 10, 21],
  /* b4 */ [3, 9, 11, 18],
  /* c4 */ [6, 10, 15],
  /* e4 */ [8, 13, 17],
  /* f4 */ [5, 12, 14, 20],
  /* g4 */ [2, 13, 23],
  /* c5 */ [11, 16],
  /* d5 */ [15, 17, 19],
  /* e5 */ [12, 16],
  /* b6 */ [10, 19],
  /* d6 */ [16, 18, 20, 22],
  /* f6 */ [13, 19],
  /* a7 */ [9, 22],
  /* d7 */ [19, 21, 23],
  /* g7 */ [14, 22]
]

export const MORRIS_MILLS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2], // a1-d1-g1
  [3, 4, 5], // b2-d2-f2
  [6, 7, 8], // c3-d3-e3
  [9, 10, 11], // a4-b4-c4
  [12, 13, 14], // e4-f4-g4
  [15, 16, 17], // c5-d5-e5
  [18, 19, 20], // b6-d6-f6
  [21, 22, 23], // a7-d7-g7
  [0, 9, 21], // a1-a4-a7
  [3, 10, 18], // b2-b4-b6
  [6, 11, 15], // c3-c4-c5
  [1, 4, 7], // d1-d2-d3
  [16, 19, 22], // d5-d6-d7
  [8, 12, 17], // e3-e4-e5
  [5, 13, 20], // f2-f4-f6
  [2, 14, 23] // g1-g4-g7
]

const MILLS_AT: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = (() => {
  const at: Array<Array<readonly [number, number, number]>> = MORRIS_POINTS.map(() => [])
  for (const mill of MORRIS_MILLS) for (const p of mill) at[p].push(mill)
  return at
})()

export interface MorrisState {
  /** 24 points, 0 empty, 1 white, 2 black. */
  readonly board: readonly number[]
  /** Unplaced men: [white, black]. */
  readonly inHand: readonly [number, number]
  /** 1 = white to move, 2 = black. */
  readonly turn: 1 | 2
  readonly moves: readonly string[]
}

export interface MorrisInitOptions {
  /** 24 chars from [.wb], MORRIS_POINTS order. For tests/dev tooling. */
  board?: string
  inHand?: [number, number]
  turn?: 1 | 2
}

export function morrisCount(board: readonly number[], player: number): number {
  let n = 0
  for (const c of board) if (c === player) n++
  return n
}

/** Is the man at `point` part of a complete mill on `board`? */
export function inMill(board: readonly number[], point: number): boolean {
  const player = board[point]
  if (player === 0) return false
  for (const [a, b, c] of MILLS_AT[point]) {
    if (board[a] === player && board[b] === player && board[c] === player) return true
  }
  return false
}

/** Capture targets for `player` having just milled: opponent men, mill-protected unless all are milled. */
function captureTargets(board: readonly number[], player: number): number[] {
  const opp = 3 - player
  const free: number[] = []
  const all: number[] = []
  for (let i = 0; i < 24; i++) {
    if (board[i] !== opp) continue
    all.push(i)
    if (!inMill(board, i)) free.push(i)
  }
  return free.length > 0 ? free : all
}

interface Candidate {
  from: number | null
  to: number
}

function candidates(s: MorrisState): Candidate[] {
  const p = s.turn
  const out: Candidate[] = []
  if (s.inHand[p - 1] > 0) {
    for (let to = 0; to < 24; to++) if (s.board[to] === 0) out.push({ from: null, to })
    return out
  }
  const flying = morrisCount(s.board, p) === 3
  for (let from = 0; from < 24; from++) {
    if (s.board[from] !== p) continue
    if (flying) {
      for (let to = 0; to < 24; to++) if (s.board[to] === 0) out.push({ from, to })
    } else {
      for (const to of MORRIS_ADJACENT[from]) if (s.board[to] === 0) out.push({ from, to })
    }
  }
  return out
}

function moveString(c: Candidate, capture: number | null): string {
  const base = c.from === null ? MORRIS_POINTS[c.to] : `${MORRIS_POINTS[c.from]}-${MORRIS_POINTS[c.to]}`
  return capture === null ? base : `${base}x${MORRIS_POINTS[capture]}`
}

function genMoves(s: MorrisState): string[] {
  const p = s.turn
  const out: string[] = []
  for (const c of candidates(s)) {
    const board = s.board.slice()
    if (c.from !== null) board[c.from] = 0
    board[c.to] = p
    if (inMill(board, c.to)) {
      for (const t of captureTargets(board, p)) out.push(moveString(c, t))
    } else {
      out.push(moveString(c, null))
    }
  }
  return out
}

function materialLoss(s: MorrisState, player: 1 | 2): boolean {
  return s.inHand[player - 1] === 0 && morrisCount(s.board, player) < 3
}

function winFor(player: 1 | 2, reason: string): GameResult {
  const winner = player === 1 ? 'white' : 'black'
  return { winner, score: winner === 'white' ? '1-0' : '0-1', reason }
}

function resultOf(s: MorrisState): GameResult | null {
  const p = s.turn
  const o = (3 - p) as 1 | 2
  if (materialLoss(s, p)) return winFor(o, 'material')
  // normally detected on the loser's turn, but guard the opponent too so a
  // stored just-captured terminal state reads terminal either way
  if (materialLoss(s, o)) return winFor(p, 'material')
  if (genMoves(s).length === 0) return winFor(o, 'no-moves')
  return null
}

function legalMovesOf(s: MorrisState): string[] {
  if (materialLoss(s, s.turn) || materialLoss(s, (3 - s.turn) as 1 | 2)) return []
  return genMoves(s)
}

const MOVE_RE = /^([a-g][1-7])(?:-([a-g][1-7]))?(?:x([a-g][1-7]))?$/

export const MORRIS_SPEC: GameSpec<MorrisState> = {
  kind: 'morris',
  family: 'grid',
  title: 'Nine Men’s Morris',
  tagline: 'Line up three, take one away. The oldest strategy game in Europe.',
  players: ['white', 'black'],
  board: { layout: 'intersections', files: 7, ranks: 7 },
  flipPolicy: 'rotate',
  clock: { supported: true },
  init(options?: unknown): MorrisState {
    const opts = (options ?? {}) as MorrisInitOptions
    if (opts.board !== undefined) {
      if (!/^[.wb]{24}$/.test(opts.board)) {
        throw new Error('morris board must be 24 chars from [.wb] in MORRIS_POINTS order')
      }
      const board = [...opts.board].map((ch) => (ch === 'w' ? 1 : ch === 'b' ? 2 : 0))
      return {
        board,
        inHand: opts.inHand ?? [0, 0],
        turn: opts.turn ?? 1,
        moves: []
      }
    }
    return { board: new Array<number>(24).fill(0), inHand: [9, 9], turn: 1, moves: [] }
  },
  legalMoves: legalMovesOf,
  play(s: MorrisState, move: string): MorrisState | null {
    const m = MOVE_RE.exec(move)
    if (!m) return null
    if (!legalMovesOf(s).includes(move)) return null
    const p = s.turn
    const from = m[2] !== undefined ? INDEX_OF.get(m[1])! : null
    const to = m[2] !== undefined ? INDEX_OF.get(m[2])! : INDEX_OF.get(m[1])!
    const capture = m[3] !== undefined ? INDEX_OF.get(m[3])! : null
    const board = s.board.slice()
    if (from !== null) board[from] = 0
    board[to] = p
    if (capture !== null) board[capture] = 0
    const inHand: [number, number] = [s.inHand[0], s.inHand[1]]
    if (from === null) inHand[p - 1]--
    return { board, inHand, turn: (3 - p) as 1 | 2, moves: [...s.moves, move] }
  },
  result: resultOf,
  moveMeta(_s: MorrisState, move: string): MoveMeta {
    const capture = move.includes('x')
    return { capture, sound: capture ? 'capture' : 'move' }
  },
  serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
}
