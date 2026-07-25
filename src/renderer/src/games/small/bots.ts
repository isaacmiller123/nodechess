// In-process bots for the small hand-rolled games (docs/GAMES-PLATFORM-SPEC.md
// §Bots, 'worker:<game>' providers; the worker WRAPPER is P2w2, the sync
// search lives here and is called in-process for now).
//
// Each game exposes 5 levels. Depth targets follow the spec (othello 2..10,
// connect4 ~2/4/7/10/13, ...); every search additionally carries a node
// budget with iterative deepening so a single move stays interactive even at
// the top level: when the budget trips, the best move from the last fully
// completed depth is used. Low levels add random noise to root scores so
// weak play is varied, not deterministic.

import type { GameKind } from '../kernel'
import {
  othelloMoveMask,
  othelloFlips,
  othelloName,
  popcount,
  type OthelloState
} from './othello'
import { c4Bit, c4Wins, type Connect4State } from './connect4'
import { HEX_N, hexName, type HexState } from './hex'
import {
  MORRIS_SPEC,
  MORRIS_ADJACENT,
  MORRIS_MILLS,
  morrisCount,
  type MorrisState
} from './morris'
import { TICTACTOE_SPEC, tttWinner, type TicTacToeState } from './tictactoe'

export interface SmallBot {
  readonly levels: 5
  describe(level: number): string
  /** Returns a legal canonical move for `state` (sync, in-process). */
  move(state: unknown, level: number): string
}

/** Shared by every 5-level provider (games/bots.ts, games/gomokuBot.ts). */
export const clampLevel = (level: number): number => Math.min(5, Math.max(1, Math.round(level)))

/** Thrown when a search exceeds its node budget; callers keep the previous depth's move. */
const BUDGET_EXCEEDED = Symbol('budget-exceeded')

interface Budget {
  n: number
  max: number
}

function tick(b: Budget): void {
  if (++b.n > b.max) throw BUDGET_EXCEEDED
}

/** Argmax with uniform ±noise on each score. Low levels vary, high levels don't. */
export function noisyArgmax(moves: string[], scores: number[], noise: number): string {
  let best = 0
  let bestScore = -Infinity
  for (let i = 0; i < moves.length; i++) {
    const s = scores[i] + (noise > 0 ? (Math.random() * 2 - 1) * noise : 0)
    if (s > bestScore) {
      bestScore = s
      best = i
    }
  }
  return moves[best]
}

// ---------------------------------------------------------------------------
// Othello: negamax depth 2..10 by level, mobility + corners (+ late discs) eval

const OTH_CORNERS = (1n << 0n) | (1n << 7n) | (1n << 56n) | (1n << 63n)

const OTH_SQUARE_WEIGHTS: readonly number[] = (() => {
  const row0 = [100, -20, 10, 5, 5, 10, -20, 100]
  const row1 = [-20, -50, -2, -2, -2, -2, -50, -20]
  const row2 = [10, -2, -1, -1, -1, -1, -2, 10]
  const row3 = [5, -2, -1, -1, -1, -1, -2, 5]
  return [...row0, ...row1, ...row2, ...row3, ...row3, ...row2, ...row1, ...row0]
})()

/** Static move-ordering: corners first, X/C squares last. */
const OTH_ORDER: readonly number[] = Array.from({ length: 64 }, (_, i) => i).sort(
  (a, b) => OTH_SQUARE_WEIGHTS[b] - OTH_SQUARE_WEIGHTS[a]
)

function othEval(own: bigint, opp: bigint): number {
  const mob = popcount(othelloMoveMask(own, opp)) - popcount(othelloMoveMask(opp, own))
  const corners = popcount(own & OTH_CORNERS) - popcount(opp & OTH_CORNERS)
  let e = 25 * corners + 3 * mob
  const total = popcount(own | opp)
  if (total > 44) e += (popcount(own) - popcount(opp)) * (total - 44)
  return e
}

function othNegamax(
  own: bigint,
  opp: bigint,
  depth: number,
  alpha: number,
  beta: number,
  budget: Budget
): number {
  tick(budget)
  const mask = othelloMoveMask(own, opp)
  if (mask === 0n) {
    if (othelloMoveMask(opp, own) === 0n) {
      const diff = popcount(own) - popcount(opp)
      return diff > 0 ? 10000 + diff : diff < 0 ? -10000 + diff : 0
    }
    return -othNegamax(opp, own, depth - 1, -beta, -alpha, budget) // forced pass
  }
  if (depth <= 0) return othEval(own, opp)
  let best = -Infinity
  for (const i of OTH_ORDER) {
    const sq = 1n << BigInt(i)
    if ((mask & sq) === 0n) continue
    const flips = othelloFlips(own, opp, sq)
    const v = -othNegamax(opp & ~flips, own | sq | flips, depth - 1, -beta, -alpha, budget)
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

const OTH_DEPTHS = [2, 4, 6, 8, 10]
const OTH_BUDGETS = [3000, 8000, 15000, 30000, 60000]
const OTH_NOISE = [6, 2, 0, 0, 0]

const othelloBot: SmallBot = {
  levels: 5,
  describe(level: number): string {
    const l = clampLevel(level)
    return `Level ${l}: negamax depth ${OTH_DEPTHS[l - 1]}, mobility + corners`
  },
  move(state: unknown, level: number): string {
    const s = state as OthelloState
    const l = clampLevel(level)
    const [own, opp] = s.turn === 0 ? [s.black, s.white] : [s.white, s.black]
    const mask = othelloMoveMask(own, opp)
    if (mask === 0n) return 'pass'
    const moves: number[] = []
    for (const i of OTH_ORDER) if ((mask & (1n << BigInt(i))) !== 0n) moves.push(i)
    const budget: Budget = { n: 0, max: OTH_BUDGETS[l - 1] }
    let bestScores: number[] = moves.map((i) => OTH_SQUARE_WEIGHTS[i])
    try {
      for (let depth = 2; depth <= OTH_DEPTHS[l - 1]; depth += 2) {
        const scores: number[] = []
        for (const i of moves) {
          const sq = 1n << BigInt(i)
          const flips = othelloFlips(own, opp, sq)
          scores.push(-othNegamax(opp & ~flips, own | sq | flips, depth - 1, -Infinity, Infinity, budget))
        }
        bestScores = scores
      }
    } catch (e) {
      if (e !== BUDGET_EXCEEDED) throw e
    }
    return othelloName(
      Number(noisyArgmax(moves.map(String), bestScores, OTH_NOISE[l - 1]))
    )
  }
}

// ---------------------------------------------------------------------------
// Connect Four: negamax + center-first ordering, depths ~2/4/7/10/13

const C4_ORDER = [3, 2, 4, 1, 5, 0, 6]

/** Number of 4-in-a-row windows through each cell, by bit index (col*7+row). */
const C4_WEIGHTS: readonly number[] = (() => {
  const byRow = [
    [3, 4, 5, 7, 5, 4, 3],
    [4, 6, 8, 10, 8, 6, 4],
    [5, 8, 11, 13, 11, 8, 5],
    [5, 8, 11, 13, 11, 8, 5],
    [4, 6, 8, 10, 8, 6, 4],
    [3, 4, 5, 7, 5, 4, 3]
  ]
  const w = new Array<number>(49).fill(0)
  for (let col = 0; col < 7; col++) for (let row = 0; row < 6; row++) w[col * 7 + row] = byRow[row][col]
  return w
})()

/**
 * `score` is the white-perspective positional sum, maintained incrementally.
 * Returns the value from the perspective of `turn`.
 */
function c4Negamax(
  bb: bigint[],
  heights: number[],
  turn: number,
  depth: number,
  alpha: number,
  beta: number,
  score: number,
  budget: Budget
): number {
  tick(budget)
  if (depth <= 0) return turn === 0 ? score : -score
  let best = -Infinity
  let any = false
  for (const col of C4_ORDER) {
    if (heights[col] >= 6) continue
    any = true
    const w = C4_WEIGHTS[col * 7 + heights[col]]
    const bit = c4Bit(col, heights[col])
    bb[turn] |= bit
    heights[col]++
    let v: number
    if (c4Wins(bb[turn])) {
      v = 100000 + depth // prefer faster wins
    } else {
      v = -c4Negamax(bb, heights, turn ^ 1, depth - 1, -beta, -alpha, score + (turn === 0 ? w : -w), budget)
    }
    heights[col]--
    bb[turn] &= ~bit
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return any ? best : 0 // board full → draw
}

const C4_DEPTHS = [2, 4, 7, 10, 13]
const C4_BUDGETS = [20000, 40000, 80000, 150000, 300000]
const C4_NOISE = [4, 2, 0, 0, 0]

const connect4Bot: SmallBot = {
  levels: 5,
  describe(level: number): string {
    const l = clampLevel(level)
    return `Level ${l}: negamax depth ${C4_DEPTHS[l - 1]}, center-first`
  },
  move(state: unknown, level: number): string {
    const s = state as Connect4State
    const l = clampLevel(level)
    const bb: bigint[] = [s.bb[0], s.bb[1]]
    const heights = s.heights.slice()
    const cols = C4_ORDER.filter((c) => heights[c] < 6)
    if (cols.length === 0) throw new Error('connect4 bot: no legal moves')
    const budget: Budget = { n: 0, max: C4_BUDGETS[l - 1] }
    let bestScores: number[] = cols.map((c) => C4_WEIGHTS[c * 7 + heights[c]])
    try {
      for (let depth = 2; depth <= C4_DEPTHS[l - 1]; depth++) {
        const scores: number[] = []
        for (const col of cols) {
          const w = C4_WEIGHTS[col * 7 + heights[col]]
          const bit = c4Bit(col, heights[col])
          bb[s.turn] |= bit
          heights[col]++
          scores.push(
            c4Wins(bb[s.turn])
              ? 100000 + depth
              : -c4Negamax(
                  bb,
                  heights,
                  s.turn ^ 1,
                  depth - 1,
                  -Infinity,
                  Infinity,
                  s.turn === 0 ? w : -w,
                  budget
                )
          )
          heights[col]--
          bb[s.turn] &= ~bit
        }
        bestScores = scores
      }
    } catch (e) {
      if (e !== BUDGET_EXCEEDED) throw e
    }
    return String(Number(noisyArgmax(cols.map(String), bestScores, C4_NOISE[l - 1])) + 1)
  }
}

// ---------------------------------------------------------------------------
// Hex: shortest-connection eval (0-1 BFS), shallow minimax, levels via depth+noise

const HEX_NEIGHBORS: ReadonlyArray<readonly number[]> = (() => {
  const offs = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [-1, 1],
    [1, -1]
  ]
  const out: number[][] = []
  for (let r = 0; r < HEX_N; r++) {
    for (let c = 0; c < HEX_N; c++) {
      const ns: number[] = []
      for (const [dr, dc] of offs) {
        const nr = r + dr
        const nc = c + dc
        if (nr >= 0 && nr < HEX_N && nc >= 0 && nc < HEX_N) ns.push(nr * HEX_N + nc)
      }
      out.push(ns)
    }
  }
  return out
})()

const HEX_INF = 1e9

/** Cheapest edge-to-edge path cost for `player` (own stone 0, empty 1, opponent blocked). */
export function hexDistance(cells: readonly number[], player: number): number {
  const dist = new Array<number>(HEX_N * HEX_N).fill(HEX_INF)
  const deque: number[] = []
  const cost = (i: number): number => (cells[i] === player ? 0 : cells[i] === 0 ? 1 : HEX_INF)
  for (let k = 0; k < HEX_N; k++) {
    const i = player === 1 ? k * HEX_N : k // white: col 0; black: row 0
    const c = cost(i)
    if (c >= HEX_INF) continue
    if (c < dist[i]) {
      dist[i] = c
      if (c === 0) deque.unshift(i)
      else deque.push(i)
    }
  }
  while (deque.length > 0) {
    const i = deque.shift()!
    for (const n of HEX_NEIGHBORS[i]) {
      const c = cost(n)
      if (c >= HEX_INF) continue
      const d = dist[i] + c
      if (d < dist[n]) {
        dist[n] = d
        if (c === 0) deque.unshift(n)
        else deque.push(n)
      }
    }
  }
  let best = HEX_INF
  for (let k = 0; k < HEX_N; k++) {
    const i = player === 1 ? k * HEX_N + (HEX_N - 1) : (HEX_N - 1) * HEX_N + k
    if (dist[i] < best) best = dist[i]
  }
  return best
}

function hexEval(cells: readonly number[], mover: number): number {
  const my = hexDistance(cells, mover)
  const op = hexDistance(cells, 3 - mover)
  if (my === 0) return 100000
  if (op === 0) return -100000
  return op - my
}

interface HexLevelCfg {
  depth: 1 | 2
  noise: number
  topK: number
}
const HEX_LEVELS: readonly HexLevelCfg[] = [
  { depth: 1, noise: 6, topK: 0 },
  { depth: 1, noise: 3, topK: 0 },
  { depth: 1, noise: 1, topK: 0 },
  { depth: 2, noise: 0.5, topK: 8 },
  { depth: 2, noise: 0, topK: 12 }
]

const hexBot: SmallBot = {
  levels: 5,
  describe(level: number): string {
    const l = clampLevel(level)
    const cfg = HEX_LEVELS[l - 1]
    return `Level ${l}: shortest-path eval, depth ${cfg.depth}`
  },
  move(state: unknown, level: number): string {
    const s = state as HexState
    const cfg = HEX_LEVELS[clampLevel(level) - 1]
    const me = s.turn
    const empties: number[] = []
    for (let i = 0; i < HEX_N * HEX_N; i++) if (s.cells[i] === 0) empties.push(i)
    if (empties.length === 0) throw new Error('hex bot: no legal moves')
    const cells = s.cells.slice()
    const shallow = empties.map((i) => {
      cells[i] = me
      const e = hexEval(cells, me)
      cells[i] = 0
      return e
    })
    let scores = shallow
    if (cfg.depth === 2) {
      const ranked = empties
        .map((cell, k) => ({ cell, k, e: shallow[k] }))
        .sort((a, b) => b.e - a.e)
        .slice(0, cfg.topK)
      scores = shallow.map(() => -Infinity)
      for (const { cell, k, e } of ranked) {
        if (e >= 100000) {
          scores[k] = e // immediate win
          continue
        }
        cells[cell] = me
        // opponent's best reply (their strongest placement anywhere)
        let worst = Infinity
        for (const r of empties) {
          if (r === cell) continue
          cells[r] = 3 - me
          const v = hexEval(cells, me)
          cells[r] = 0
          if (v < worst) worst = v
        }
        cells[cell] = 0
        scores[k] = worst
      }
      // unranked moves keep their shallow score heavily discounted
      for (let k = 0; k < scores.length; k++) if (scores[k] === -Infinity) scores[k] = shallow[k] - 1000
    }
    const idx = Number(noisyArgmax(empties.map(String), scores, cfg.noise))
    return hexName(idx)
  }
}

// ---------------------------------------------------------------------------
// Morris: minimax over the spec with mill/mobility/material eval

function morrisEval(s: MorrisState): number {
  const p = s.turn
  const o = 3 - p
  const men =
    morrisCount(s.board, p) + s.inHand[p - 1] - (morrisCount(s.board, o) + s.inHand[o - 1])
  let freedomP = 0
  let freedomO = 0
  for (let i = 0; i < 24; i++) {
    if (s.board[i] === 0) continue
    let free = 0
    for (const n of MORRIS_ADJACENT[i]) if (s.board[n] === 0) free++
    if (s.board[i] === p) freedomP += free
    else freedomO += free
  }
  let millsP = 0
  let millsO = 0
  for (const [a, b, c] of MORRIS_MILLS) {
    if (s.board[a] !== 0 && s.board[a] === s.board[b] && s.board[b] === s.board[c]) {
      if (s.board[a] === p) millsP++
      else millsO++
    }
  }
  return 30 * men + 2 * (freedomP - freedomO) + 8 * (millsP - millsO)
}

function morrisNegamax(s: MorrisState, depth: number, alpha: number, beta: number, budget: Budget): number {
  tick(budget)
  const res = MORRIS_SPEC.result(s)
  if (res !== null) {
    if (res.winner === null) return 0
    const winnerPlayer = res.winner === 'white' ? 1 : 2
    return winnerPlayer === s.turn ? 10000 + depth : -(10000 + depth)
  }
  if (depth <= 0) return morrisEval(s)
  const moves = MORRIS_SPEC.legalMoves(s)
  moves.sort((a, b) => Number(b.includes('x')) - Number(a.includes('x'))) // captures first
  let best = -Infinity
  for (const m of moves) {
    const child = MORRIS_SPEC.play(s, m)
    if (!child) continue
    const v = -morrisNegamax(child, depth - 1, -beta, -alpha, budget)
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

const MORRIS_DEPTHS = [1, 2, 3, 4, 5]
const MORRIS_BUDGETS = [3000, 6000, 12000, 20000, 30000]
const MORRIS_NOISE = [8, 3, 0, 0, 0]

const morrisBot: SmallBot = {
  levels: 5,
  describe(level: number): string {
    const l = clampLevel(level)
    return `Level ${l}: minimax depth ${MORRIS_DEPTHS[l - 1]}, mill + mobility eval`
  },
  move(state: unknown, level: number): string {
    const s = state as MorrisState
    const l = clampLevel(level)
    const moves = MORRIS_SPEC.legalMoves(s)
    if (moves.length === 0) throw new Error('morris bot: no legal moves')
    const budget: Budget = { n: 0, max: MORRIS_BUDGETS[l - 1] }
    let bestScores: number[] = moves.map((m) => Number(m.includes('x')))
    try {
      for (let depth = 1; depth <= MORRIS_DEPTHS[l - 1]; depth++) {
        const scores: number[] = []
        for (const m of moves) {
          const child = MORRIS_SPEC.play(s, m)!
          scores.push(-morrisNegamax(child, depth - 1, -Infinity, Infinity, budget))
        }
        bestScores = scores
      }
    } catch (e) {
      if (e !== BUDGET_EXCEEDED) throw e
    }
    return noisyArgmax(moves, bestScores, MORRIS_NOISE[l - 1])
  }
}

// ---------------------------------------------------------------------------
// Tic-tac-toe: random → perfect minimax

function tttNegamax(s: TicTacToeState, depth: number): number {
  const w = tttWinner(s.cells)
  if (w !== null) return -(100 + depth) // the player who just moved won
  const moves = TICTACTOE_SPEC.legalMoves(s)
  if (moves.length === 0) return 0
  let best = -Infinity
  for (const m of moves) {
    const v = -tttNegamax(TICTACTOE_SPEC.play(s, m)!, depth - 1)
    if (v > best) best = v
  }
  return best
}

const tictactoeBot: SmallBot = {
  levels: 5,
  describe(level: number): string {
    const l = clampLevel(level)
    return l <= 1
      ? 'Level 1: random'
      : l <= 3
        ? `Level ${l}: win/block heuristics`
        : `Level ${l}: perfect minimax`
  },
  move(state: unknown, level: number): string {
    const s = state as TicTacToeState
    const l = clampLevel(level)
    const moves = TICTACTOE_SPEC.legalMoves(s)
    if (moves.length === 0) throw new Error('tictactoe bot: no legal moves')
    if (l === 1) return moves[Math.floor(Math.random() * moves.length)]
    if (l <= 3) {
      // take a win
      for (const m of moves) {
        const after = TICTACTOE_SPEC.play(s, m)!
        if (tttWinner(after.cells) === s.turn) return m
      }
      if (l === 3) {
        // block an opponent win
        for (const m of moves) {
          const oppView: TicTacToeState = { cells: s.cells, turn: s.turn === 1 ? 2 : 1, moves: s.moves }
          const after = TICTACTOE_SPEC.play(oppView, m)
          if (after && tttWinner(after.cells) === oppView.turn) return m
        }
      }
      return moves[Math.floor(Math.random() * moves.length)]
    }
    let best = moves[0]
    let bestV = -Infinity
    for (const m of moves) {
      const v = -tttNegamax(TICTACTOE_SPEC.play(s, m)!, 9)
      if (v > bestV) {
        bestV = v
        best = m
      }
    }
    return best
  }
}

// ---------------------------------------------------------------------------

export const SMALL_BOTS: Readonly<Partial<Record<GameKind, SmallBot>>> = {
  othello: othelloBot,
  connect4: connect4Bot,
  hex: hexBot,
  morris: morrisBot,
  tictactoe: tictactoeBot
}
