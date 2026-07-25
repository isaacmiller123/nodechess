// Chess-variant wave: GameSpec adapters over chessops for the 8 lichess
// variants + standard chess (docs/GAMES-PLATFORM-SPEC.md §Phases P1).
//
// Mirrors the patterns of src/renderer/src/chess/chess.ts (thin, stateless
// wrappers over chessops), but immutable-state style for the kernel: state
// carries a live Position that is CLONED on play, never mutated.
//
// Move codec: UCI. Crazyhouse drops are `P@e4` / `N@f3` (chessops parseUci /
// makeUci handle these). Castling is canonically king-takes-rook UCI
// ('e1h1'), as chessops enumerates it: `play` ALSO accepts standard 'e1g1'
// via normalizeMove, so engine output works either way.
// TODO(P2): translate castling to 'e1g1' form at the engine/wire boundary for
// non-960 UCI engines that emit/expect standard notation.

import {
  Position,
  Crazyhouse,
  defaultPosition,
  setupPosition,
  normalizeMove,
  castlingSide
} from 'chessops/variant'
import { parseFen, makeFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { makeUci, parseUci } from 'chessops/util'
import { isDrop } from 'chessops/types'
import type { Move, Role, Rules } from 'chessops/types'
import type { GameKind, GameResult, GameSpec, MoveMeta } from './kernel'

// ---------------------------------------------------------------------------
// State

export interface ChessVariantState {
  readonly rules: Rules
  readonly pos: Position
  /** UCI history (canonical, king-takes-rook castling). */
  readonly moves: readonly string[]
  readonly fen: string
  readonly startFen: string
}

export interface ChessInitOptions {
  /** Start from an arbitrary (variant-legal) FEN instead of the default position. */
  fen?: string
}

export interface Chess960InitOptions extends ChessInitOptions {
  /** Scharnagl position number 0..959 (518 = standard chess). Wins over `seed`. */
  positionNumber?: number
  /** Deterministic seed → position number; same seed, same start. */
  seed?: number
}

// ---------------------------------------------------------------------------
// Chess960 start-position derivation (Scharnagl numbering, 0..959; 518 = RNBQKBNR)

const N5N_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 2], [0, 3], [0, 4], [1, 2],
  [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]
]

export function scharnaglArrangement(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 959) {
    throw new Error(`chess960 position number out of range: ${n}`)
  }
  const files: (string | null)[] = new Array<string | null>(8).fill(null)
  let rest = n
  files[[1, 3, 5, 7][rest % 4]] = 'B' // light-squared bishop
  rest = Math.floor(rest / 4)
  files[[0, 2, 4, 6][rest % 4]] = 'B' // dark-squared bishop
  rest = Math.floor(rest / 4)
  const queenIdx = rest % 6
  rest = Math.floor(rest / 6)
  let free = files.flatMap((p, i) => (p === null ? [i] : []))
  files[free[queenIdx]] = 'Q'
  free = files.flatMap((p, i) => (p === null ? [i] : []))
  const [k1, k2] = N5N_TABLE[rest]
  files[free[k1]] = 'N'
  files[free[k2]] = 'N'
  free = files.flatMap((p, i) => (p === null ? [i] : []))
  files[free[0]] = 'R'
  files[free[1]] = 'K'
  files[free[2]] = 'R'
  return files.join('')
}

// Deterministic seed → 0..959 (mulberry32; stable across platforms).
export function chess960PositionNumber(seed: number): number {
  let a = seed >>> 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * 960) | 0
}

export function chess960Fen(positionNumber: number): string {
  const arrangement = scharnaglArrangement(positionNumber)
  const rookFiles = [...arrangement].flatMap((p, i) => (p === 'R' ? [i] : []))
  const fileChar = (i: number): string => String.fromCharCode(97 + i)
  // Shredder-FEN castling (rook file letters): chessops parses these.
  const castling =
    rookFiles.map((f) => fileChar(f).toUpperCase()).join('') +
    rookFiles.map(fileChar).join('')
  return `${arrangement.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${arrangement} w ${castling} - 0 1`
}

// ---------------------------------------------------------------------------
// Shared rules plumbing

function positionFromFen(rules: Rules, fen: string): Position {
  return setupPosition(rules, parseFen(fen).unwrap()).unwrap()
}

function toState(rules: Rules, pos: Position, moves: readonly string[], startFen?: string): ChessVariantState {
  const fen = makeFen(pos.toSetup())
  return { rules, pos, moves, fen, startFen: startFen ?? fen }
}

const isBackrank = (sq: number): boolean => sq < 8 || sq >= 56

const DROP_ROLES: readonly Role[] = ['queen', 'rook', 'bishop', 'knight', 'pawn']

function legalMovesOf(s: ChessVariantState): string[] {
  const pos = s.pos
  const ctx = pos.ctx()
  const out: string[] = []
  const promoRoles: readonly Role[] =
    s.rules === 'antichess'
      ? ['queen', 'rook', 'bishop', 'knight', 'king'] // antichess allows king promotion
      : ['queen', 'rook', 'bishop', 'knight']
  for (const [from, tos] of pos.allDests(ctx)) {
    const isPawn = pos.board.get(from)?.role === 'pawn'
    for (const to of tos) {
      if (isPawn && isBackrank(to)) {
        for (const promotion of promoRoles) out.push(makeUci({ from, to, promotion }))
      } else {
        out.push(makeUci({ from, to }))
      }
    }
  }
  if (s.rules === 'crazyhouse' && pos.pockets) {
    const pocket = pos.pockets[pos.turn]
    const targets = (pos as Crazyhouse).dropDests(ctx)
    for (const role of DROP_ROLES) {
      if (pocket[role] <= 0) continue
      for (const to of targets) {
        const drop: Move = { role, to }
        if (pos.isLegal(drop, ctx)) out.push(makeUci(drop))
      }
    }
  }
  return out
}

function parseMove(pos: Position, moveStr: string): Move | undefined {
  const parsed = parseUci(moveStr)
  if (!parsed) return undefined
  return isDrop(parsed) ? parsed : normalizeMove(pos, parsed)
}

function playOn(s: ChessVariantState, moveStr: string): ChessVariantState | null {
  const move = parseMove(s.pos, moveStr)
  if (!move || !s.pos.isLegal(move)) return null
  const pos = s.pos.clone()
  pos.play(move)
  return toState(s.rules, pos, [...s.moves, makeUci(move)], s.startFen)
}

function resultOf(s: ChessVariantState): GameResult | null {
  const pos = s.pos
  if (!pos.isEnd()) return null
  const outcome = pos.outcome()
  const winner = outcome?.winner ?? null
  const score = winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '1/2-1/2'
  const reason = pos.isVariantEnd()
    ? 'variant'
    : pos.isCheckmate()
      ? 'checkmate'
      : pos.isStalemate()
        ? 'stalemate'
        : pos.isInsufficientMaterial()
          ? 'insufficient-material'
          : 'draw'
  // TODO(P2): threefold / 50-move draws are adjudicated by the session layer
  // (chessops isEnd does not track move history); expose helpers when wiring.
  return { winner, score, reason }
}

/** SAN for the move about to be played from `s` (kernel notate contract).
 *  chessops makeSan is variant-aware through the Position (checkmate '#'
 *  covers variant ends too) and handles crazyhouse drops ('N@f3') and both
 *  castling encodings ('e1h1' king-takes-rook and 'e1g1'). Falls back to the
 *  raw move string for anything unparseable/illegal. */
function notateOf(s: ChessVariantState, moveStr: string): string {
  const move = parseMove(s.pos, moveStr)
  if (!move || !s.pos.isLegal(move)) return moveStr
  return makeSan(s.pos, move)
}

function moveMetaOf(s: ChessVariantState, moveStr: string): MoveMeta {
  const pos = s.pos
  const move = parseMove(pos, moveStr)
  if (!move || !pos.isLegal(move)) return {}
  let capture = false
  let castle = false
  let promote = false
  if (!isDrop(move)) {
    castle = castlingSide(pos, move) !== undefined
    promote = move.promotion !== undefined
    capture =
      (!castle && pos.board.get(move.to) !== undefined) ||
      (pos.board.get(move.from)?.role === 'pawn' && move.to === pos.epSquare)
  }
  const after = pos.clone()
  after.play(move)
  const check = after.isCheck()
  const sound = check ? 'check' : promote ? 'promote' : castle ? 'castle' : capture ? 'capture' : 'move'
  return { capture, sound }
}

// ---------------------------------------------------------------------------
// Spec factory

interface VariantConfig {
  kind: GameKind
  rules: Rules
  title: string
  tagline: string
  init?(options?: unknown): ChessVariantState
}

function makeSpec(cfg: VariantConfig): GameSpec<ChessVariantState> {
  return {
    kind: cfg.kind,
    family: 'chess',
    title: cfg.title,
    tagline: cfg.tagline,
    players: ['white', 'black'],
    board: { layout: 'cells', files: 8, ranks: 8 },
    flipPolicy: 'rotate',
    clock: { supported: true },
    init:
      cfg.init ??
      ((options?: unknown): ChessVariantState => {
        const opts = (options ?? {}) as ChessInitOptions
        const pos = opts.fen ? positionFromFen(cfg.rules, opts.fen) : defaultPosition(cfg.rules)
        return toState(cfg.rules, pos, [])
      }),
    legalMoves: legalMovesOf,
    play: playOn,
    result: resultOf,
    moveMeta: moveMetaOf,
    notate: notateOf,
    serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
  }
}

function initChess960(options?: unknown): ChessVariantState {
  const opts = (options ?? {}) as Chess960InitOptions
  if (opts.fen) return toState('chess', positionFromFen('chess', opts.fen), [])
  const n =
    opts.positionNumber !== undefined
      ? opts.positionNumber
      : opts.seed !== undefined
        ? chess960PositionNumber(opts.seed)
        : Math.floor(Math.random() * 960)
  return toState('chess', positionFromFen('chess', chess960Fen(n)), [])
}

// ---------------------------------------------------------------------------
// The wave. chessops rules ids: 'chess' | 'antichess' | 'kingofthehill' |
// '3check' | 'atomic' | 'horde' | 'racingkings' | 'crazyhouse'.

export const CHESS_VARIANT_SPECS: Readonly<
  Partial<Record<GameKind, GameSpec<ChessVariantState>>>
> = {
  chess: makeSpec({
    kind: 'chess',
    rules: 'chess',
    title: 'Chess',
    tagline: 'The classic game.'
  }),
  chess960: makeSpec({
    kind: 'chess960',
    rules: 'chess', // 960 is standard rules from a shuffled start; chessops castling is start-agnostic
    title: 'Chess960',
    tagline: 'Fischer random: a shuffled back rank, pure skill from move one.',
    init: initChess960
  }),
  crazyhouse: makeSpec({
    kind: 'crazyhouse',
    rules: 'crazyhouse',
    title: 'Crazyhouse',
    tagline: 'Captured pieces switch sides. Drop them back anywhere.'
  }),
  atomic: makeSpec({
    kind: 'atomic',
    rules: 'atomic',
    title: 'Atomic',
    tagline: 'Every capture explodes. Blow up the enemy king.'
  }),
  antichess: makeSpec({
    kind: 'antichess',
    rules: 'antichess',
    title: 'Antichess',
    tagline: 'Captures are forced. Lose everything to win.'
  }),
  kingofthehill: makeSpec({
    kind: 'kingofthehill',
    rules: 'kingofthehill',
    title: 'King of the Hill',
    tagline: 'March your king to the center to win.'
  }),
  threecheck: makeSpec({
    kind: 'threecheck',
    rules: '3check',
    title: 'Three-check',
    tagline: 'Give three checks and the game is yours.'
  }),
  horde: makeSpec({
    kind: 'horde',
    rules: 'horde',
    title: 'Horde',
    tagline: 'A pawn horde against a full army. Destroy or be mated.'
  }),
  racingkings: makeSpec({
    kind: 'racingkings',
    rules: 'racingkings',
    title: 'Racing Kings',
    tagline: 'No checks allowed. Race your king to the eighth rank.'
  })
}
