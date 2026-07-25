// Bot providers, docs/GAMES-PLATFORM-SPEC.md §Bots.
//
// One BotProvider per game kind, resolved from the registry's botProviderId.
// Providers are the ONLY seam between game UIs and bot backends:
//
//   'stockfish'            chess. The existing engine:play ipc (weak-model /
//                          UCI_Elo routing lives in main; PlayView's richer
//                          bot experience remains the primary chess path).
//   'fairy-stockfish'      every other chess-family kind, engine:playVariant
//                          ipc (Fairy-Stockfish with UCI_Variant per kind).
//   'katago'               go: STUB until the KataGo dataset group ships; the
//                          GTP client (src/main/engine/gtp.ts) is already in
//                          place for the binary. move() rejects with
//                          BotUnavailableError; UIs surface it as a toast.
//   'rapid-draughts'       American checkers. The library's own alphaBeta.
//   'worker:checkers-intl' International draughts. Negamax over the spec.
//   'worker:gomoku'        games/gomokuBot.ts threat evaluation.
//   'worker:<small>'       games/small/bots.ts in-process search bots.
//
// Everything in-process is sync under the hood but exposed as Promise so
// engine-backed providers are interchangeable (and so the sync searches can
// move to real workers in a later wave without an API change).
//
// Engine boundary (castling codec, per scripts/probe-fairy-sf.mjs): the kernel
// canonically uses king-takes-rook UCI ('e1h1'); a NON-960 engine emits and
// expects 'e1g1'. Both specs' play() accept the standard form (chessops
// normalizeMove), so engine output needs no translation on the way back, and
// requests carry a bare FEN (no history), so nothing needs translating on the
// way in. chess960 runs the engine with UCI_Chess960=true (KxR both ways).

import { DraughtsPlayer } from 'rapid-draughts'
import type { DraughtsMove1D } from 'rapid-draughts'
import { EnglishDraughts, EnglishDraughtsComputerFactory } from 'rapid-draughts/english'
import type { EnglishDraughtsComputer } from 'rapid-draughts/english'
import type { FairyVariantKind } from '@shared/types'
import {
  INTL_CHECKERS_SPEC,
  americanMoveToCodec,
  type AmericanCheckersState,
  type IntlCheckersState
} from './checkers'
import type { ChessVariantState } from './chessVariants'
import type { FfishState } from './ffishVariants'
import { GO_SPEC, handicapPlacement, vertexToPoint, type GoState } from './go'
import { GOMOKU_BOT } from './gomokuBot'
import type { GameKind } from './kernel'
import { getGame } from './registry'
import { SMALL_BOTS, clampLevel, noisyArgmax } from './small/bots'

/** 5-level bot backend for one game kind (spec §Bots). */
export interface BotProvider {
  readonly levels: 5
  /** Short UI hint for a level ('sharp threat evaluation', '~1400 Elo', ...). */
  describe(level: number): string
  /** Resolve a legal canonical move for the kind's spec state. Rejects with
   *  BotUnavailableError when the backend isn't installed/shipped yet. */
  move(state: unknown, level: number): Promise<string>
}

/** The backend exists but can't play yet (missing binary/dataset). UIs catch
 *  this and show the message as a toast instead of an error screen. */
export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BotUnavailableError'
  }
}

/** Shared level names for pickers: index = level - 1. */
export const BOT_LEVEL_NAMES: readonly string[] = [
  'Beginner',
  'Casual',
  'Club',
  'Strong',
  'Master'
]

// ---------------------------------------------------------------------------
// Chess family: engine ipc

/** Level → target Elo, shared by the chess and fairy providers so a "Club" bot
 *  feels comparable across the whole chess family. */
const CHESS_LEVEL_ELO = [600, 1000, 1400, 1850, 2300] as const
/** Level → engine movetime (ms): stronger levels think a bit longer. */
const CHESS_LEVEL_MOVETIME = [150, 250, 350, 500, 700] as const

const describeElo = (level: number): string => `~${CHESS_LEVEL_ELO[clampLevel(level) - 1]} Elo engine`

function requireApi(): Window['api'] {
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (!api) throw new BotUnavailableError('Engine bridge unavailable in this environment.')
  return api
}

function assertPlayableMove(bestmove: string | undefined): string {
  if (!bestmove || bestmove === '(none)' || bestmove === '0000') {
    throw new Error('engine returned no move (terminal position?)')
  }
  return bestmove
}

/** kind === 'chess': the long-lived Stockfish play engine via engine:play. */
const stockfishProvider: BotProvider = {
  levels: 5,
  describe: describeElo,
  async move(state: unknown, level: number): Promise<string> {
    const s = state as ChessVariantState
    const l = clampLevel(level)
    const { bestmove } = await requireApi().engine.play({
      fen: s.fen,
      level: { elo: CHESS_LEVEL_ELO[l - 1] },
      limit: { kind: 'movetime', value: CHESS_LEVEL_MOVETIME[l - 1] }
    })
    return assertPlayableMove(bestmove)
  }
}

/** Chess-family variants (chessops + ffish kinds) via engine:playVariant.
 *  Both state shapes carry a current-position `fen`. That's the whole seam. */
function fairyProvider(kind: FairyVariantKind): BotProvider {
  return {
    levels: 5,
    describe: describeElo,
    async move(state: unknown, level: number): Promise<string> {
      const s = state as ChessVariantState | FfishState
      const l = clampLevel(level)
      const { bestmove } = await requireApi().engine.playVariant({
        kind,
        fen: s.fen,
        level: l
      })
      return assertPlayableMove(bestmove)
    }
  }
}

// ---------------------------------------------------------------------------
// Go. KataGo over GTP via engine:playGo (main-process KatagoPool). Two level
// ladders, chosen in MAIN by what's installed: standard nets (visits +
// move-choice temperature) or, when the optional Human-SL net is present, the
// flagship human rank profiles. describe() mirrors that choice. The human
// hints below match KatagoPool's HUMAN_PROFILES ranks 1:1 (keep in sync).

const KATAGO_HINTS = [
  'relaxed: powered by KataGo',
  'steady: powered by KataGo',
  'solid: powered by KataGo',
  'strong: powered by KataGo',
  'relentless: powered by KataGo'
] as const

const KATAGO_HUMAN_HINTS = [
  'plays like a ~15-kyu human',
  'plays like a ~9-kyu human',
  'plays like a ~4-kyu human',
  'plays like a ~1-kyu human',
  'plays like a ~3-dan human'
] as const

const KATAGO_UNAVAILABLE_MSG =
  'KataGo is not installed. Download the Go engine in Settings → Datasets.'

// Whether go levels currently play the Human-SL ladder. Refreshed via
// engine:status fire-and-forget (describe() must stay sync); until the first
// answer lands the standard hints show, which is the safe default.
let katagoHumanStyle = false
function refreshKatagoStyle(): void {
  if (typeof window === 'undefined' || !window.api) return
  void window.api.engine
    .status()
    .then((s) => {
      katagoHumanStyle = s.katagoHumanReady
    })
    .catch(() => undefined)
}

/**
 * KataGo's ruleset and the renderer rules engine (tenuki, positional superko)
 * can rarely disagree on ko/superko legality: KataGo then genmoves a vertex
 * the spec's play() rejects, and the Go bot's turn would hang on an "illegal
 * move" toast forever. Guard: validate the engine's move against
 * spec.legalMoves and degrade to the nearest legal vertex (locally sensible in
 * the ko fight that caused the disagreement), or 'pass' if no point is legal.
 */
function legalizeGoMove(state: GoState, move: string): string {
  const legal = GO_SPEC.legalMoves(state)
  if (legal.length === 0 || legal.includes(move)) return move
  const points = legal.filter((v) => v !== 'pass')
  if (points.length === 0) return 'pass'
  const at = vertexToPoint(move, state.size)
  if (!at) return points[0]
  let bestVertex = points[0]
  let bestDist = Infinity
  for (const v of points) {
    const p = vertexToPoint(v, state.size)
    if (!p) continue
    const dist = Math.max(Math.abs(p.x - at.x), Math.abs(p.y - at.y))
    if (dist < bestDist) {
      bestDist = dist
      bestVertex = v
    }
  }
  return bestVertex
}

const katagoProvider: BotProvider = {
  levels: 5,
  describe(level: number): string {
    const l = clampLevel(level)
    return katagoHumanStyle ? KATAGO_HUMAN_HINTS[l - 1] : KATAGO_HINTS[l - 1]
  },
  async move(state: unknown, level: number): Promise<string> {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api) throw new BotUnavailableError(KATAGO_UNAVAILABLE_MSG)
    const s = state as GoState
    try {
      const { move } = await api.engine.playGo({
        size: s.size,
        komi: s.komi,
        // Handicap stones ride as explicit vertices so both rules engines
        // (tenuki here, KataGo there) agree on the exact points.
        ...(s.handicap >= 2 ? { handicap: handicapPlacement(s.size, s.handicap) } : {}),
        moves: [...s.moves],
        level: clampLevel(level)
      })
      return legalizeGoMove(s, move)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Main rejects with a clear not-installed line until the katago dataset
      // group imports: surface it as the actionable BotUnavailableError.
      if (/not installed/i.test(msg)) throw new BotUnavailableError(KATAGO_UNAVAILABLE_MSG)
      throw err instanceof Error ? err : new Error(msg)
    }
  }
}

// ---------------------------------------------------------------------------
// American checkers: rapid-draughts' own alphaBeta search

const AMERICAN_DEPTHS = [1, 3, 5, 7, 9] as const
const AMERICAN_HINTS = [
  'sees one move ahead',
  'looks 3 moves ahead',
  'looks 5 moves ahead',
  'looks 7 moves ahead',
  'looks 9 moves ahead'
] as const

const americanComputers = new Map<number, EnglishDraughtsComputer>()

function americanComputer(level: number): EnglishDraughtsComputer {
  let bot = americanComputers.get(level)
  if (!bot) {
    bot = EnglishDraughtsComputerFactory.alphaBeta({ maxDepth: AMERICAN_DEPTHS[level - 1] })
    americanComputers.set(level, bot)
  }
  return bot
}

const americanProvider: BotProvider = {
  levels: 5,
  describe(level: number): string {
    return AMERICAN_HINTS[clampLevel(level) - 1]
  },
  async move(state: unknown, level: number): Promise<string> {
    const s = state as AmericanCheckersState
    const game = EnglishDraughts.setup({
      player: s.data.player,
      board: { ...s.data.board },
      stats: { ...s.data.stats }
    })
    const libMove: DraughtsMove1D = await americanComputer(clampLevel(level))(game)
    const codec = americanMoveToCodec(s, libMove)
    if (!codec) throw new Error('checkers bot: engine move not legal in state')
    return codec
  }
}

// ---------------------------------------------------------------------------
// International draughts. Negamax over the spec, material + king eval
// (task spec: depths 1..7 by level; node budgets keep the top level snappy)

const INTL_DEPTHS = [1, 2, 3, 5, 7] as const
const INTL_BUDGETS = [300, 800, 2000, 6000, 16000] as const
const INTL_NOISE = [60, 20, 0, 0, 0] as const
const INTL_HINTS = [
  'sees one move ahead',
  'looks 2 moves ahead',
  'looks 3 moves ahead',
  'looks 5 moves ahead',
  'looks 7 moves ahead'
] as const

const INTL_BUDGET_EXCEEDED = Symbol('intl-budget-exceeded')

interface IntlBudget {
  n: number
  max: number
}

/** Material from the side-to-move's perspective: man 100, king 320. */
function intlEval(s: IntlCheckersState): number {
  // State fen: 'W:W31,32,K5,...:B1,2,...' (normalized by the spec).
  const [turn, whitePart, blackPart] = s.fen.split(':')
  const count = (part: string): number => {
    let v = 0
    for (const token of part.slice(1).split(',')) {
      if (token === '') continue
      v += token.startsWith('K') ? 320 : 100
    }
    return v
  }
  const diff = count(whitePart) - count(blackPart)
  return turn === 'W' ? diff : -diff
}

/** Captures first, longer chains first ('28x19x10' before '28x19'). */
function intlOrder(moves: string[]): string[] {
  return moves.sort((a, b) => b.split('x').length - a.split('x').length)
}

function intlNegamax(
  s: IntlCheckersState,
  depth: number,
  alpha: number,
  beta: number,
  budget: IntlBudget
): number {
  if (++budget.n > budget.max) throw INTL_BUDGET_EXCEEDED
  const res = INTL_CHECKERS_SPEC.result(s)
  if (res !== null) {
    if (res.winner === null) return 0
    const winnerTurn = res.winner === 'white' ? 'W' : 'B'
    return s.fen.startsWith(winnerTurn) ? 10000 + depth : -(10000 + depth)
  }
  if (depth <= 0) return intlEval(s)
  const moves = intlOrder(INTL_CHECKERS_SPEC.legalMoves(s))
  let best = -Infinity
  for (const m of moves) {
    const child = INTL_CHECKERS_SPEC.play(s, m)
    if (!child) continue
    const v = -intlNegamax(child, depth - 1, -beta, -alpha, budget)
    if (v > best) best = v
    if (best > alpha) alpha = best
    if (alpha >= beta) break
  }
  return best
}

const intlProvider: BotProvider = {
  levels: 5,
  describe(level: number): string {
    return INTL_HINTS[clampLevel(level) - 1]
  },
  async move(state: unknown, level: number): Promise<string> {
    const s = state as IntlCheckersState
    const l = clampLevel(level)
    const moves = intlOrder(INTL_CHECKERS_SPEC.legalMoves(s))
    if (moves.length === 0) throw new Error('draughts bot: no legal moves')
    const budget: IntlBudget = { n: 0, max: INTL_BUDGETS[l - 1] }
    // Iterative deepening with a node budget: when the budget trips, the last
    // fully completed depth's scores stand (same pattern as games/small/bots.ts).
    let bestScores: number[] = moves.map((m) => m.split('x').length - 1)
    try {
      for (let depth = 1; depth <= INTL_DEPTHS[l - 1]; depth++) {
        const scores: number[] = []
        for (const m of moves) {
          const child = INTL_CHECKERS_SPEC.play(s, m)
          if (!child) throw new Error(`draughts bot: spec rejected its own move ${m}`)
          scores.push(-intlNegamax(child, depth - 1, -Infinity, Infinity, budget))
        }
        bestScores = scores
      }
    } catch (e) {
      if (e !== INTL_BUDGET_EXCEEDED) throw e
    }
    return noisyArgmax(moves, bestScores, INTL_NOISE[l - 1])
  }
}

// ---------------------------------------------------------------------------
// Small in-process bots (games/small/bots.ts + games/gomokuBot.ts)

const SMALL_HINTS: Readonly<Partial<Record<GameKind, readonly string[]>>> = {
  othello: [
    'plays loose discs',
    'guards the corners',
    'mobility and corners',
    'deep corner play',
    'endgame disc counting'
  ],
  connect4: [
    'drops casually',
    'blocks open threats',
    'plans double threats',
    'deep column reading',
    'near-perfect columns'
  ],
  hex: [
    'wanders the board',
    'follows the shortest path',
    'sharp path blocking',
    'reads your best reply',
    'relentless connections'
  ],
  morris: [
    'places freely',
    'chases mills',
    'mills and mobility',
    'double-mill setups',
    'grinding endgames'
  ],
  tictactoe: ['plays at random', 'takes wins', 'takes wins, blocks yours', 'perfect play', 'perfect play']
}

function smallProvider(kind: GameKind): BotProvider {
  const bot = kind === 'gomoku' ? GOMOKU_BOT : SMALL_BOTS[kind]
  if (!bot) throw new Error(`no in-process bot for kind: ${kind}`)
  const hints = SMALL_HINTS[kind]
  return {
    levels: 5,
    describe(level: number): string {
      const l = clampLevel(level)
      return hints ? hints[l - 1] : bot.describe(l)
    },
    move(state: unknown, level: number): Promise<string> {
      // Sync search wrapped async (spec §Bots: real workers are a later wave).
      return Promise.resolve(bot.move(state, level))
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution

const cache = new Map<GameKind, BotProvider>()

/** The bot backend for a registered game kind (throws on unknown kind). */
export function resolveBotProvider(kind: GameKind): BotProvider {
  const cached = cache.get(kind)
  if (cached) {
    // Every (re-)resolution refreshes the go ladder choice, so installing the
    // Human-SL net mid-session flips describe() on the next setup screen.
    if (cached === katagoProvider) refreshKatagoStyle()
    return cached
  }
  const entry = getGame(kind)
  if (!entry) throw new Error(`resolveBotProvider: unregistered game kind '${kind}'`)
  const id = entry.botProviderId
  let provider: BotProvider
  if (id === 'stockfish') provider = stockfishProvider
  else if (id === 'fairy-stockfish') provider = fairyProvider(kind as FairyVariantKind)
  else if (id === 'katago') {
    provider = katagoProvider
    refreshKatagoStyle() // async: describe() flips to the human hints when the Human-SL net is installed
  }
  else if (id === 'rapid-draughts') provider = americanProvider
  else if (id === 'worker:checkers-intl') provider = intlProvider
  else if (id.startsWith('worker:')) provider = smallProvider(kind)
  else throw new Error(`resolveBotProvider: unknown bot provider id '${id}' for '${kind}'`)
  cache.set(kind, provider)
  return provider
}

// Re-exported for tests/UI convenience (single import site).
export { DraughtsPlayer }
