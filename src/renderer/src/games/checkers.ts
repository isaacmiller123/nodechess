// Checkers wave — GameSpec adapters for the draughts family
// (docs/GAMES-PLATFORM-SPEC.md §Phases P2):
//
//   - 'checkers'      American checkers / English draughts, 8x8, over
//                     rapid-draughts (MIT; WCDF rules, bitboard engine).
//   - 'checkers-intl' International draughts, 10x10, over @jortvl/draughts
//                     (MPL; FMJD rules). The library was AUDITED before trust
//                     (scripts/test-checkers.mjs): majority capture
//                     (longestCapture keeps only maximum-piece sequences,
//                     quantity rule — kings count the same as men), flying-king
//                     multi-jumps, backwards man captures, Turkish-strike
//                     semantics (captured pieces stay on the board during the
//                     sequence and may not be jumped twice) and promotion only
//                     when the move ENDS on the back row are all correct.
//                     One flaw: its move() applies the FIRST move matching
//                     from/to, so ambiguous capture paths cannot be selected —
//                     this adapter therefore uses the library for move
//                     GENERATION only and applies moves itself (which also
//                     gives us the immutable-state style the kernel requires).
//
// MOVE CODEC (canonical, numeric square notation — both variants):
//   - Squares are the standard 1-based dark-square numbers, top-left to
//     bottom-right along each rank pair:
//       American:      PDN/WCDF 1..32 — Black (first mover) starts on 1..12
//                      at the top, White on 21..32 at the bottom.
//       International: FMJD 1..50 — Black starts on 1..20 at the top, White
//                      (first mover) on 31..50 at the bottom.
//   - Quiet move:      'from-to'                e.g. '11-15', '32-28'
//   - Capture:         'from x landing x ...'   e.g. '11x18x25', '28x19x10'
//     The FULL landing chain is encoded (every intermediate landing square),
//     which uniquely determines the captured pieces and disambiguates
//     multi-path captures that share origin and destination (including
//     flying-king cycles that end on their starting square, '43x...x43').
//
// result() conventions:
//   - no legal moves for the side to move (blocked or wiped out) = LOSS.
//   - American: draw per rapid-draughts' WCDF 40-ply rule (40 plies with no
//     capture AND no man advance).
//   - International: FMJD 25-move rule (50 consecutive plies of king-only,
//     capture-free play) and threefold repetition of the position with the
//     same side to move — both tracked in the state this spec carries.
//     TODO(P2w2): FMJD endgame limits (16-move rule for 1K+2 vs 1K; 5-move
//     rule for tiny king endings) need material-aware counters — add when the
//     session layer surfaces adjudication UI.

import { DraughtsPlayer, DraughtsStatus } from 'rapid-draughts'
import type { DraughtsMove1D } from 'rapid-draughts'
import { EnglishDraughts, EnglishDraughtsBitSquare } from 'rapid-draughts/english'
import type { EnglishDraughtsGame } from 'rapid-draughts/english'
import Draughts from '@jortvl/draughts'
import type { JortvlMove } from '@jortvl/draughts'
import type { GameResult, GameSpec, MoveMeta, PlayerColor } from './kernel'

// ===========================================================================
// American checkers (8x8, rapid-draughts)
// ===========================================================================

/** Plain-data engine snapshot (rapid-draughts DraughtsEngineData<number>). */
export interface AmericanEngineData {
  player: DraughtsPlayer
  board: { light: number; dark: number; king: number }
  stats: { sinceCapture: number; sinceNonKingAdvance: number }
}

export interface AmericanCheckersState {
  readonly data: AmericanEngineData
  /** Codec move history ('11-15' / '11x18x25'). */
  readonly moves: readonly string[]
}

/** Position builder — squares are PDN 1..32. Defaults to the standard start. */
export interface AmericanCheckersInitOptions {
  blackMen?: number[]
  blackKings?: number[]
  whiteMen?: number[]
  whiteKings?: number[]
  /** Side to move ('black' = dark, moves first from the standard start). */
  player?: 'black' | 'white'
  stats?: { sinceCapture: number; sinceNonKingAdvance: number }
}

// --- geometry: PDN position p (0..31) <-> board row/col ---------------------

const posRow = (p: number): number => p >> 2
const posCol = (p: number): number => 2 * (p & 3) + (posRow(p) % 2 === 0 ? 1 : 0)

function posAt(row: number, col: number): number | null {
  if (row < 0 || row > 7 || col < 0 || col > 7) return null
  if ((row % 2 === 0) !== (col % 2 === 1)) return null // dark squares only
  return row * 4 + (col - (row % 2 === 0 ? 1 : 0)) / 2
}

/** Landing square when jumping from `from` over adjacent `over`, or null. */
function jumpLanding(from: number, over: number): number | null {
  const dr = posRow(over) - posRow(from)
  const dc = posCol(over) - posCol(from)
  if (Math.abs(dr) !== 1 || Math.abs(dc) !== 1) return null
  return posAt(posRow(over) + dr, posCol(over) + dc)
}

/** Captured square between two landing squares of one jump, or null. */
function jumpedSquare(from: number, to: number): number | null {
  const dr = posRow(to) - posRow(from)
  const dc = posCol(to) - posCol(from)
  if (Math.abs(dr) !== 2 || Math.abs(dc) !== 2) return null
  return posAt(posRow(from) + dr / 2, posCol(from) + dc / 2)
}

// --- position <-> engine bit mapping, derived through the public API ---------
// EnglishDraughtsBitSquare[i] is the RAW ENGINE BIT 1<<i, whose board position
// is an internal layout detail. We recover position -> bit once by probing
// setup() + board (both documented API), so no internals are hard-coded.

let POS_TO_BIT: number[] | null = null

function posToBit(): number[] {
  if (POS_TO_BIT) return POS_TO_BIT
  const table = new Array<number>(32).fill(0)
  for (let i = 0; i < 32; i++) {
    const bit = EnglishDraughtsBitSquare[i]
    const probe = EnglishDraughts.setup({
      player: DraughtsPlayer.LIGHT,
      board: { light: bit, dark: 0, king: 0 },
      stats: { sinceCapture: 0, sinceNonKingAdvance: 0 }
    })
    for (const sq of probe.board) {
      if (sq.dark && sq.piece) table[sq.position] = bit
    }
  }
  POS_TO_BIT = table
  return table
}

const squaresToMask = (squares: readonly number[]): number => {
  const table = posToBit()
  let mask = 0
  for (const sq of squares) {
    if (!Number.isInteger(sq) || sq < 1 || sq > 32) throw new Error(`bad checkers square: ${sq}`)
    mask |= table[sq - 1]
  }
  return mask >>> 0
}

const cloneAmericanData = (d: AmericanEngineData): AmericanEngineData => ({
  player: d.player,
  board: { light: d.board.light, dark: d.board.dark, king: d.board.king },
  stats: { sinceCapture: d.stats.sinceCapture, sinceNonKingAdvance: d.stats.sinceNonKingAdvance }
})

function americanGame(s: AmericanCheckersState): EnglishDraughtsGame {
  return EnglishDraughts.setup(cloneAmericanData(s.data))
}

// --- codec -------------------------------------------------------------------

interface ParsedMove {
  origin: number
  destination: number
  /** Captured positions (empty = quiet move). */
  captures: number[]
}

/** Parse '11-15' / '11x18x25' into 0-based positions; null = malformed. */
function parseMoveString(str: string, maxSquare: number): ParsedMove | null {
  const isCapture = str.includes('x')
  const parts = str.split(isCapture ? 'x' : '-')
  if (parts.length < 2 || (!isCapture && parts.length !== 2)) return null
  const squares: number[] = []
  for (const p of parts) {
    if (!/^\d{1,2}$/.test(p)) return null
    const n = Number(p)
    if (n < 1 || n > maxSquare) return null
    squares.push(n - 1)
  }
  if (!isCapture) return { origin: squares[0], destination: squares[1], captures: [] }
  const captures: number[] = []
  for (let i = 0; i + 1 < squares.length; i++) {
    const over = jumpedSquare(squares[i], squares[i + 1])
    if (over === null) return null
    captures.push(over)
  }
  return { origin: squares[0], destination: squares[squares.length - 1], captures }
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i])

/**
 * Encode a rapid-draughts move as the codec string. Capture chains are
 * reconstructed by DFS over the capture set (the library only reports
 * origin/destination/captures) — landings must be empty squares (the vacated
 * origin counts as empty, enabling king loops back onto it).
 */
function encodeAmericanMove(m: DraughtsMove1D, occupied: ReadonlySet<number>): string {
  if (m.captures.length === 0) return `${m.origin + 1}-${m.destination + 1}`
  const path: number[] = [m.origin]
  const dfs = (cur: number, remaining: Set<number>): boolean => {
    if (remaining.size === 0) return cur === m.destination
    for (const over of [...remaining]) {
      const land = jumpLanding(cur, over)
      if (land === null) continue
      if (occupied.has(land) && land !== m.origin) continue
      remaining.delete(over)
      path.push(land)
      if (dfs(land, remaining)) return true
      remaining.add(over)
      path.pop()
    }
    return false
  }
  if (!dfs(m.origin, new Set(m.captures))) {
    // Should be unreachable for library-legal moves; keep a defensive fallback.
    return `${m.origin + 1}x${m.destination + 1}`
  }
  return path.map((p) => p + 1).join('x')
}

function americanOccupied(game: EnglishDraughtsGame, origin: number): Set<number> {
  const occupied = new Set<number>()
  for (const sq of game.board) {
    if (sq.dark && sq.piece && sq.position !== origin) occupied.add(sq.position)
  }
  return occupied
}

function americanLegalMoves(s: AmericanCheckersState): string[] {
  const game = americanGame(s)
  if (game.status !== DraughtsStatus.PLAYING) return []
  const out: string[] = []
  for (const m of game.moves) out.push(encodeAmericanMove(m, americanOccupied(game, m.origin)))
  return out
}

function findAmericanMove(game: EnglishDraughtsGame, parsed: ParsedMove): DraughtsMove1D | undefined {
  return game.moves.find(
    (m) =>
      m.origin === parsed.origin &&
      m.destination === parsed.destination &&
      sameSet(m.captures, parsed.captures)
  )
}

/**
 * Codec string ('11-15' / '11x18x25') for a rapid-draughts library move that is
 * legal in `s` — games/bots.ts resolves alphaBeta engine moves through this.
 * Returns null when the library move doesn't match any legal move of `s`.
 */
export function americanMoveToCodec(s: AmericanCheckersState, m: DraughtsMove1D): string | null {
  const game = americanGame(s)
  const move = findAmericanMove(game, {
    origin: m.origin,
    destination: m.destination,
    captures: [...m.captures]
  })
  if (!move) return null
  return encodeAmericanMove(move, americanOccupied(game, move.origin))
}

function americanPlay(s: AmericanCheckersState, moveStr: string): AmericanCheckersState | null {
  const parsed = parseMoveString(moveStr, 32)
  if (!parsed) return null
  const game = americanGame(s)
  if (game.status !== DraughtsStatus.PLAYING) return null
  const move = findAmericanMove(game, parsed)
  if (!move) return null
  const canonical = encodeAmericanMove(move, americanOccupied(game, move.origin))
  game.move(move)
  return {
    data: cloneAmericanData(game.engine.serialize() as AmericanEngineData),
    moves: [...s.moves, canonical]
  }
}

function americanResult(s: AmericanCheckersState): GameResult | null {
  const status = americanGame(s).status
  switch (status) {
    case DraughtsStatus.PLAYING:
      return null
    case DraughtsStatus.DRAW:
      // rapid-draughts: 40 plies with no capture AND no man advance (WCDF).
      return { winner: null, score: '1/2-1/2', reason: '40-move' }
    case DraughtsStatus.LIGHT_WON:
      return { winner: 'white', score: '1-0', reason: 'no-moves' }
    case DraughtsStatus.DARK_WON:
      return { winner: 'black', score: '0-1', reason: 'no-moves' }
  }
}

function americanMoveMeta(s: AmericanCheckersState, moveStr: string): MoveMeta {
  const parsed = parseMoveString(moveStr, 32)
  if (!parsed) return {}
  const game = americanGame(s)
  const move = findAmericanMove(game, parsed)
  if (!move) return {}
  const capture = move.captures.length > 0
  const piece = game.board.find((sq) => sq.dark && sq.position === move.origin)?.piece
  const crownRow = game.player === DraughtsPlayer.DARK ? 7 : 0
  const crowns = piece !== undefined && !piece.king && posRow(move.destination) === crownRow
  return { capture, sound: capture ? 'capture' : crowns ? 'promote' : 'move' }
}

function americanInit(options?: unknown): AmericanCheckersState {
  const opts = (options ?? {}) as AmericanCheckersInitOptions
  if (!opts.blackMen && !opts.blackKings && !opts.whiteMen && !opts.whiteKings) {
    return { data: EnglishDraughts.setup().engine.serialize() as AmericanEngineData, moves: [] }
  }
  const dark = squaresToMask([...(opts.blackMen ?? []), ...(opts.blackKings ?? [])])
  const light = squaresToMask([...(opts.whiteMen ?? []), ...(opts.whiteKings ?? [])])
  const king = squaresToMask([...(opts.blackKings ?? []), ...(opts.whiteKings ?? [])])
  const data: AmericanEngineData = {
    player: opts.player === 'white' ? DraughtsPlayer.LIGHT : DraughtsPlayer.DARK,
    board: { light, dark, king },
    stats: opts.stats ?? { sinceCapture: 0, sinceNonKingAdvance: 0 }
  }
  return { data, moves: [] }
}

export const AMERICAN_CHECKERS_SPEC: GameSpec<AmericanCheckersState> = {
  kind: 'checkers',
  family: 'draughts',
  title: 'Checkers',
  tagline: 'American checkers — jump, chain, and crown your kings.',
  players: ['black', 'white'], // Black (dark) moves first
  board: { layout: 'cells', files: 8, ranks: 8 },
  flipPolicy: 'rotate',
  clock: { supported: true },
  init: americanInit,
  legalMoves: americanLegalMoves,
  play: americanPlay,
  result: americanResult,
  moveMeta: americanMoveMeta,
  serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
}

// ===========================================================================
// International draughts (10x10, @jortvl/draughts)
// ===========================================================================

export interface IntlCheckersState {
  /** Normalized library FEN: 'W:W31,32,...:B1,2,...' (kings prefixed K). */
  readonly fen: string
  /** Codec move history ('32-28' / '28x19x10'). */
  readonly moves: readonly string[]
  /** Plies since the last capture, man move or promotion (FMJD 25-move rule = 50 plies). */
  readonly quietKingPlies: number
  /** Position keys since the last irreversible ply, current included (threefold). */
  readonly seen: readonly string[]
}

export interface IntlCheckersInitOptions {
  /** Library FEN ('W:W31-50:B1-20' ranges accepted). Defaults to the start position. */
  fen?: string
  /** Session-restore hooks for the draw counters carried by the state. */
  quietKingPlies?: number
  seen?: string[]
}

interface IntlPosition {
  turn: 'W' | 'B'
  /** square -> isKing */
  white: Map<number, boolean>
  black: Map<number, boolean>
}

const INTL_START_FEN = 'W:W31-50:B1-20'

function parseIntlFen(fen: string): IntlPosition {
  const parts = fen.trim().split(':')
  const turn = parts[0]?.toUpperCase()
  if ((turn !== 'W' && turn !== 'B') || parts.length !== 3) throw new Error(`bad draughts FEN: ${fen}`)
  const pos: IntlPosition = { turn, white: new Map(), black: new Map() }
  for (const part of parts.slice(1)) {
    const side = part.charAt(0).toUpperCase()
    if (side !== 'W' && side !== 'B') throw new Error(`bad draughts FEN side: ${fen}`)
    const target = side === 'W' ? pos.white : pos.black
    const body = part.slice(1)
    if (body === '') continue
    for (const token of body.split(',')) {
      const m = /^(K?)(\d{1,2})(?:-(\d{1,2}))?$/.exec(token.trim())
      if (!m) throw new Error(`bad draughts FEN token '${token}': ${fen}`)
      const from = Number(m[2])
      const to = m[3] !== undefined ? Number(m[3]) : from
      if (from < 1 || to > 50 || from > to) throw new Error(`bad draughts FEN square '${token}': ${fen}`)
      for (let sq = from; sq <= to; sq++) target.set(sq, m[1] === 'K')
    }
  }
  return pos
}

function formatIntlFen(pos: IntlPosition): string {
  const fmt = (pieces: Map<number, boolean>): string =>
    [...pieces.keys()]
      .sort((a, b) => a - b)
      .map((sq) => (pieces.get(sq) ? `K${sq}` : `${sq}`))
      .join(',')
  return `${pos.turn}:W${fmt(pos.white)}:B${fmt(pos.black)}`
}

const encodeIntlMove = (m: JortvlMove): string =>
  m.takes.length > 0 ? m.jumps.join('x') : `${m.from}-${m.to}`

function intlLibMoves(fen: string): JortvlMove[] {
  return new Draughts(fen).moves()
}

function intlLegalMovesRaw(s: IntlCheckersState): string[] {
  const out: string[] = []
  const dedupe = new Set<string>()
  for (const m of intlLibMoves(s.fen)) {
    const str = encodeIntlMove(m)
    if (!dedupe.has(str)) {
      dedupe.add(str)
      out.push(str)
    }
  }
  return out
}

function intlResult(s: IntlCheckersState): GameResult | null {
  const pos = parseIntlFen(s.fen)
  if (intlLibMoves(s.fen).length === 0) {
    // Side to move is blocked or wiped out: loss (covers 'no pieces').
    return pos.turn === 'W'
      ? { winner: 'black', score: '0-1', reason: 'no-moves' }
      : { winner: 'white', score: '1-0', reason: 'no-moves' }
  }
  const key = s.seen[s.seen.length - 1]
  if (key !== undefined && s.seen.filter((k) => k === key).length >= 3) {
    return { winner: null, score: '1/2-1/2', reason: 'threefold' }
  }
  if (s.quietKingPlies >= 50) {
    // FMJD 25-move rule: 25 moves per side of king-only, capture-free play.
    return { winner: null, score: '1/2-1/2', reason: '25-move' }
  }
  return null
}

function intlLegalMoves(s: IntlCheckersState): string[] {
  return intlResult(s) === null ? intlLegalMovesRaw(s) : []
}

function intlPlay(s: IntlCheckersState, moveStr: string): IntlCheckersState | null {
  if (intlResult(s) !== null) return null
  const move = intlLibMoves(s.fen).find((m) => encodeIntlMove(m) === moveStr)
  if (!move) return null
  // Apply the move ourselves: the library's move() cannot disambiguate capture
  // paths sharing from/to, and manual application keeps states immutable.
  const pos = parseIntlFen(s.fen)
  const own = pos.turn === 'W' ? pos.white : pos.black
  const opp = pos.turn === 'W' ? pos.black : pos.white
  const isKing = own.get(move.from)
  if (isKing === undefined) return null
  own.delete(move.from)
  for (const taken of move.takes) opp.delete(taken)
  const promotes = !isKing && (pos.turn === 'W' ? move.to <= 5 : move.to >= 46)
  own.set(move.to, isKing || promotes)
  pos.turn = pos.turn === 'W' ? 'B' : 'W'
  const fen = formatIntlFen(pos)
  const irreversible = move.takes.length > 0 || !isKing
  return {
    fen,
    moves: [...s.moves, moveStr],
    quietKingPlies: irreversible ? 0 : s.quietKingPlies + 1,
    seen: irreversible ? [fen] : [...s.seen, fen]
  }
}

function intlMoveMeta(s: IntlCheckersState, moveStr: string): MoveMeta {
  const move = intlLibMoves(s.fen).find((m) => encodeIntlMove(m) === moveStr)
  if (!move) return {}
  const pos = parseIntlFen(s.fen)
  const isKing = (pos.turn === 'W' ? pos.white : pos.black).get(move.from)
  const capture = move.takes.length > 0
  const promotes = isKing === false && (pos.turn === 'W' ? move.to <= 5 : move.to >= 46)
  return { capture, sound: capture ? 'capture' : promotes ? 'promote' : 'move' }
}

function intlInit(options?: unknown): IntlCheckersState {
  const opts = (options ?? {}) as IntlCheckersInitOptions
  const fen = formatIntlFen(parseIntlFen(opts.fen ?? INTL_START_FEN))
  return {
    fen,
    moves: [],
    quietKingPlies: opts.quietKingPlies ?? 0,
    seen: opts.seen ?? [fen]
  }
}

export const INTL_CHECKERS_SPEC: GameSpec<IntlCheckersState> = {
  kind: 'checkers-intl',
  family: 'draughts',
  title: 'International Draughts',
  tagline: '10×10 draughts — flying kings and majority capture.',
  players: ['white', 'black'], // White moves first (FMJD)
  board: { layout: 'cells', files: 10, ranks: 10 },
  flipPolicy: 'rotate',
  clock: { supported: true },
  init: intlInit,
  legalMoves: intlLegalMoves,
  play: intlPlay,
  result: intlResult,
  moveMeta: intlMoveMeta,
  serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
}

// ===========================================================================
// Board read-model helpers (games/boards/CheckersBoard.tsx) — presentation
// only, no rules authority. Squares are the 1-based codec numbers.
// ===========================================================================

export interface CheckersPieceView {
  /** 1-based codec square (PDN 1..32 / FMJD 1..50). */
  square: number
  color: PlayerColor
  king: boolean
}

/** Pieces on the board, ascending square order. */
export function americanPiecesOf(s: AmericanCheckersState): CheckersPieceView[] {
  const out: CheckersPieceView[] = []
  for (const sq of americanGame(s).board) {
    if (!sq.dark || !sq.piece) continue
    out.push({
      square: sq.position + 1,
      color: sq.piece.player === DraughtsPlayer.DARK ? 'black' : 'white',
      king: sq.piece.king
    })
  }
  return out.sort((a, b) => a.square - b.square)
}

/** Pieces on the board, ascending square order. */
export function intlPiecesOf(s: IntlCheckersState): CheckersPieceView[] {
  const pos = parseIntlFen(s.fen)
  const out: CheckersPieceView[] = []
  for (const [square, king] of pos.white) out.push({ square, color: 'white', king })
  for (const [square, king] of pos.black) out.push({ square, color: 'black', king })
  return out.sort((a, b) => a.square - b.square)
}

