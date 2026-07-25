// ffish family wave: GameSpec adapters over ffish-es6 (Fairy-Stockfish WASM)
// for xiangqi, shogi, janggi, makruk and placement chess
// (docs/GAMES-PLATFORM-SPEC.md §Phases P2).
//
// Async-init contract: ffish loads asynchronously (games/ffish.ts singleton)
// while GameSpec is sync, so every spec exposes preload() and every rules call
// throws a clear "not loaded yet" error until preloadFfish() resolves.
// Registry entries carry `requiresPreload: true`.
//
// Move codec: ffish UCI strings VERBATIM. Shogi drops 'P@e5' and promotions
// 'h8b2+', makruk promotions 'c4b3m', janggi pass = same-square king move
// 'e2e2', xiangqi/janggi two-digit ranks 'e9e10'. Colors are ffish's: `white`
// is the FIRST mover in every variant here (shogi sente = 'white' internally;
// the renderer labels sides per game in P2 wave 2), which keeps kernel colors,
// wire payloads and Fairy-Stockfish engine output in one color space.
//
// State is immutable and PLAIN (safe for the wire/store): variant id + start
// FEN + verbatim move list (+ cached current FEN). Emscripten Board objects
// are heap-allocated and need .delete(), so they are transient: every call
// rebuilds a board from (startFen, moves) inside withBoard() and frees it.
// Move lists in a session are short; if profiling ever disagrees, memoize the
// last (state → board) pair in P2 wave 2: the API stays unchanged.

import { getFfish, preloadFfish } from './ffish'
import type { GameKind, GameResult, GameSpec, MoveMeta, BoardShape } from './kernel'

// ---------------------------------------------------------------------------
// State

export interface FfishState {
  /** ffish variant id (equals the GameKind for all five games here). */
  readonly variant: string
  readonly startFen: string
  /** Verbatim ffish UCI history. */
  readonly moves: readonly string[]
  readonly fen: string
}

export interface FfishInitOptions {
  /** Start from an arbitrary (variant-legal) FEN instead of the default position. */
  fen?: string
}

// ---------------------------------------------------------------------------
// Codec guards (cheap pre-checks; board.push() stays authoritative)

// square = file a–i + rank 1–10 (two-digit ranks on 10-rank boards)
const MOVE_RE = /^(?:[A-Z]@[a-i](?:10|[1-9])|[a-i](?:10|[1-9])[a-i](?:10|[1-9])[a-z+]?)$/
// from+to fully consumed with a trailing promotion suffix ('+' shogi, letter makruk/placement)
const PROMO_RE = /^[a-i](?:10|[1-9])[a-i](?:10|[1-9])[a-z+]$/

// ---------------------------------------------------------------------------
// Transient-board plumbing

interface FfishBoard {
  delete(): void
  legalMoves(): string
  push(uciMove: string): boolean
  pushMoves(uciMoves: string): void
  fen(): string
  isGameOver(claimDraw?: boolean): boolean
  result(claimDraw?: boolean): string
  isCheck(): boolean
  isBikjang(): boolean
  isCapture(uciMove: string): boolean
  numberLegalMoves(): number
  isInsufficientMaterial(): boolean
  /** SAN for a LEGAL uci move at the current position (default Notation.SAN). */
  sanMove(uciMove: string): string
}

function makeBoard(variant: string, fen?: string): FfishBoard {
  const ffish = getFfish()
  // emscripten-generated constructor: typed as an interface with a construct signature
  const BoardCtor = ffish.Board as unknown as new (variant: string, fen?: string) => FfishBoard
  return fen === undefined ? new BoardCtor(variant) : new BoardCtor(variant, fen)
}

function withBoard<T>(s: FfishState, fn: (board: FfishBoard) => T): T {
  const board = makeBoard(s.variant, s.startFen)
  try {
    if (s.moves.length > 0) board.pushMoves(s.moves.join(' '))
    return fn(board)
  } finally {
    board.delete()
  }
}

// ---------------------------------------------------------------------------
// Spec behavior (shared across the five variants)

function initOf(variant: string, options?: unknown): FfishState {
  const opts = (options ?? {}) as FfishInitOptions
  const ffish = getFfish()
  let startFen: string
  if (opts.fen !== undefined) {
    if (ffish.validateFen(opts.fen, variant) !== 1) {
      throw new Error(`invalid ${variant} FEN: ${opts.fen}`)
    }
    startFen = opts.fen
  } else {
    // Board().fen() is the canonical form, ffish.startingFen('shogi') uses a
    // legacy counter layout that does not round-trip through the constructor.
    const board = makeBoard(variant)
    try {
      startFen = board.fen()
    } finally {
      board.delete()
    }
  }
  return { variant, startFen, moves: [], fen: startFen }
}

function legalMovesOf(s: FfishState): string[] {
  return withBoard(s, (board) => {
    const raw = board.legalMoves().trim()
    return raw.length > 0 ? raw.split(/\s+/) : []
  })
}

function playOn(s: FfishState, move: string): FfishState | null {
  if (!MOVE_RE.test(move)) return null
  return withBoard(s, (board) => {
    if (!board.push(move)) return null
    return { variant: s.variant, startFen: s.startFen, moves: [...s.moves, move], fen: board.fen() }
  })
}

function resultOf(s: FfishState): GameResult | null {
  return withBoard(s, (board) => {
    if (!board.isGameOver()) return null
    const score = board.result()
    if (score !== '1-0' && score !== '0-1' && score !== '1/2-1/2') return null
    const winner = score === '1-0' ? 'white' : score === '0-1' ? 'black' : null
    const noMoves = board.numberLegalMoves() === 0
    // Reason labels: 'stalemate' covers every no-move, no-check end, including
    // wins (xiangqi stalemate loses; janggi double-pass adjudication).
    const reason =
      s.variant === 'janggi' && board.isBikjang()
        ? 'bikjang'
        : noMoves
          ? board.isCheck()
            ? 'checkmate'
            : 'stalemate'
          : board.isInsufficientMaterial()
            ? 'insufficient-material'
            : 'variant'
    return { winner, score, reason }
  })
}

function moveMetaOf(s: FfishState, move: string): MoveMeta {
  if (!MOVE_RE.test(move)) return {}
  return withBoard(s, (board) => {
    const capture = board.isCapture(move)
    if (!board.push(move)) return {}
    const check = board.isCheck()
    const promote = PROMO_RE.test(move)
    // TODO(P2 wave 2): 'castle' sound for placement castling (plain king UCI
    // like e1g1. Needs piece introspection to tell it from a king step).
    const sound = check ? 'check' : promote ? 'promote' : capture ? 'capture' : 'move'
    return { capture, sound }
  })
}

/** SAN for the move about to be played from `s` (kernel notate contract).
 *  ffish's board.sanMove is variant-aware (shogi drops/promotions, xiangqi
 *  two-digit ranks, makruk promotion letters). Only ever called on a LEGAL
 *  move (sanMove on garbage is undefined behavior in the WASM) so legality
 *  is checked first and anything else echoes the raw move string. */
function notateOf(s: FfishState, move: string): string {
  if (!MOVE_RE.test(move)) return move
  return withBoard(s, (board) => {
    const legal = board.legalMoves().trim()
    if (legal.length === 0 || !legal.split(/\s+/).includes(move)) return move
    return board.sanMove(move)
  })
}

/**
 * Renderer helper (boards/ChessFamilyBoard.tsx): is the side to move in
 * check? Highlight only: never rules-authoritative. Requires preloadFfish()
 * (like every other rules call).
 */
export function ffishStateCheck(s: FfishState): boolean {
  return withBoard(s, (board) => board.isCheck())
}

// ---------------------------------------------------------------------------
// Spec factory

interface FfishVariantConfig {
  kind: GameKind
  title: string
  tagline: string
  board: BoardShape
}

function makeSpec(cfg: FfishVariantConfig): GameSpec<FfishState> {
  const variant = cfg.kind
  return {
    kind: cfg.kind,
    family: 'chess',
    title: cfg.title,
    tagline: cfg.tagline,
    players: ['white', 'black'],
    board: cfg.board,
    flipPolicy: 'rotate',
    clock: { supported: true },
    preload: async (): Promise<void> => {
      await preloadFfish()
    },
    init: (options?: unknown): FfishState => initOf(variant, options),
    legalMoves: legalMovesOf,
    play: playOn,
    result: resultOf,
    moveMeta: moveMetaOf,
    notate: notateOf,
    serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
  }
}

// ---------------------------------------------------------------------------
// The wave. ffish variant ids match the GameKind for all five.

export const FFISH_VARIANT_SPECS: Readonly<Partial<Record<GameKind, GameSpec<FfishState>>>> = {
  xiangqi: makeSpec({
    kind: 'xiangqi',
    title: 'Xiangqi',
    tagline: 'Chinese chess: cannons, rivers and palaces.',
    board: { layout: 'intersections', files: 9, ranks: 10 }
  }),
  shogi: makeSpec({
    kind: 'shogi',
    title: 'Shogi',
    tagline: 'Japanese chess: captured pieces return as your own.',
    board: { layout: 'cells', files: 9, ranks: 9 }
  }),
  janggi: makeSpec({
    kind: 'janggi',
    title: 'Janggi',
    tagline: 'Korean chess: open palaces and leaping cannons.',
    board: { layout: 'intersections', files: 9, ranks: 10 }
  }),
  makruk: makeSpec({
    kind: 'makruk',
    title: 'Makruk',
    tagline: 'Thai chess: ancient rules, razor-sharp endgames.',
    board: { layout: 'cells', files: 8, ranks: 8 }
  }),
  placement: makeSpec({
    kind: 'placement',
    title: 'Placement',
    tagline: 'Set up your own back rank, then play chess.',
    board: { layout: 'cells', files: 8, ranks: 8 }
  })
}
