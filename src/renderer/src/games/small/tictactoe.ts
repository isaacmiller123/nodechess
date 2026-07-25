// Tic-tac-toe: hand-rolled GameSpec (docs/GAMES-PLATFORM-SPEC.md, small games).
//
// Codec: a move is the target cell in algebraic form 'a1'..'c3' (file a–c =
// column left→right, rank 1–3 = row bottom→top; a1 is bottom-left). White = X
// and moves first; black = O.

import type { GameResult, GameSpec, MoveMeta } from '../kernel'

export interface TicTacToeState {
  /** 9 cells, index = row * 3 + col (a1=0, b1=1, ... c3=8). 0 empty, 1 white/X, 2 black/O. */
  readonly cells: readonly number[]
  /** 1 = white (X) to move, 2 = black (O). */
  readonly turn: 1 | 2
  readonly moves: readonly string[]
}

const LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
]

export function tttIndex(move: string): number | null {
  if (!/^[a-c][1-3]$/.test(move)) return null
  return (move.charCodeAt(1) - 49) * 3 + (move.charCodeAt(0) - 97)
}

export function tttName(index: number): string {
  return String.fromCharCode(97 + (index % 3)) + String(Math.floor(index / 3) + 1)
}

export function tttWinner(cells: readonly number[]): 1 | 2 | null {
  for (const [a, b, c] of LINES) {
    if (cells[a] !== 0 && cells[a] === cells[b] && cells[b] === cells[c]) {
      return cells[a] as 1 | 2
    }
  }
  return null
}

function resultOf(s: TicTacToeState): GameResult | null {
  const w = tttWinner(s.cells)
  if (w !== null) {
    return w === 1
      ? { winner: 'white', score: '1-0', reason: 'line' }
      : { winner: 'black', score: '0-1', reason: 'line' }
  }
  if (s.cells.every((c) => c !== 0)) return { winner: null, score: '1/2-1/2', reason: 'draw' }
  return null
}

export const TICTACTOE_SPEC: GameSpec<TicTacToeState> = {
  kind: 'tictactoe',
  family: 'grid',
  title: 'Tic-tac-toe',
  tagline: 'Three in a row. Simple to learn, impossible to win. Against perfect play.',
  players: ['white', 'black'],
  board: { layout: 'cells', files: 3, ranks: 3 },
  flipPolicy: 'none',
  clock: { supported: true },
  init(): TicTacToeState {
    return { cells: new Array<number>(9).fill(0), turn: 1, moves: [] }
  },
  legalMoves(s: TicTacToeState): string[] {
    if (resultOf(s) !== null) return []
    const out: string[] = []
    for (let i = 0; i < 9; i++) if (s.cells[i] === 0) out.push(tttName(i))
    return out
  },
  play(s: TicTacToeState, move: string): TicTacToeState | null {
    if (resultOf(s) !== null) return null
    const i = tttIndex(move)
    if (i === null || s.cells[i] !== 0) return null
    const cells = s.cells.slice()
    cells[i] = s.turn
    return { cells, turn: s.turn === 1 ? 2 : 1, moves: [...s.moves, move] }
  },
  result: resultOf,
  moveMeta(): MoveMeta {
    return { capture: false, sound: 'move' }
  },
  serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
}
