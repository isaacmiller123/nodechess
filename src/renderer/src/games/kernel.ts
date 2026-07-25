// Game kernel, docs/GAMES-PLATFORM-SPEC.md §Game kernel (binding).
//
// Every game in the library is described by a GameSpec: a pure, headless rules
// adapter (no React, no window, no engine). Library UI, online (wire v4), local
// OTB and bots consume specs ONLY through games/registry.ts. Specs must run
// unchanged in bare node (scripts/test-games-kernel.mjs bundles them headless),
// so keep renderer-only imports type-only.

import type { SoundName } from '../sound/useSound'

/**
 * Every game the platform will ever host (P1–P3). Only kinds present in the
 * registry are playable; the union is complete up front so wire v4 payloads,
 * manuals and dataset ids can be typed once.
 */
export type GameKind =
  // chess family: chessops (P1, live)
  | 'chess'
  | 'chess960'
  | 'crazyhouse'
  | 'atomic'
  | 'antichess'
  | 'kingofthehill'
  | 'threecheck'
  | 'horde'
  | 'racingkings'
  // chess family: ffish-es6 (P2)
  | 'xiangqi'
  | 'shogi'
  | 'janggi'
  | 'makruk'
  | 'placement'
  // other families (P2)
  | 'go'
  | 'checkers'
  | 'checkers-intl'
  | 'othello'
  | 'gomoku'
  | 'connect4'
  | 'hex'
  | 'morris'
  | 'tictactoe'

export type GameFamily = 'chess' | 'draughts' | 'go' | 'grid'

export type PlayerColor = 'white' | 'black'

export type GameScore = '1-0' | '0-1' | '1/2-1/2'

/** Terminal state of a finished game. `winner: null` = draw. */
export interface GameResult {
  winner: PlayerColor | null
  score: GameScore
  /** Machine-readable end reason, e.g. 'checkmate' | 'stalemate' | 'variant' | 'insufficient-material' | 'draw'. */
  reason: string
}

export interface BoardShape {
  layout: 'cells' | 'intersections'
  files: number
  ranks: number
}

export interface MoveMeta {
  capture?: boolean
  sound?: SoundName
}

/**
 * Pure rules adapter for one game. States are treated as immutable: `play`
 * returns a NEW state (or null for an illegal move) and never mutates its
 * input. Move strings use a per-game canonical codec (chess family: UCI, with
 * `P@e4`-style drops for crazyhouse and king-takes-rook castling).
 */
export interface GameSpec<S = unknown> {
  kind: GameKind
  family: GameFamily
  title: string
  tagline: string
  /** Move order; first entry moves first. */
  players: ['white', 'black'] | ['black', 'white']
  board: BoardShape
  /** OTB auto-flip; go/gomoku/othello/hex/c4 = 'none'. */
  flipPolicy: 'rotate' | 'none'
  clock: { supported: boolean; byoyomi?: boolean }
  /**
   * Present when the rules engine needs async init (e.g. ffish WASM). Await it
   * once before any other spec call; the other methods throw a clear error if
   * used first. Registry entries mirror this via `requiresPreload`.
   */
  preload?(): Promise<void>
  init(options?: unknown): S
  /** Canonical move strings, empty when the game is over. */
  legalMoves(s: S): string[]
  /** null = illegal. Returns a fresh state; never mutates `s`. */
  play(s: S, move: string): S | null
  /** null = ongoing. */
  result(s: S): GameResult | null
  /**
   * Side to move in `s`. OPTIONAL: absent means strict alternation from
   * players[0] (turn = players[moves.length % 2]): true for every kernel game
   * whose opening side never varies. Implemented when init OPTIONS can change
   * who opens (go: handicap ≥ 2 makes WHITE move first); consumers must prefer
   * it over parity whenever present.
   */
  turn?(s: S): PlayerColor
  /** Presentation hints for a move ABOUT to be played from `s` (capture flag + sound). */
  moveMeta(s: S, move: string): MoveMeta
  /**
   * Human notation for a move ABOUT to be played from `s` (assumed legal).
   * Per family: chess = SAN (chessops/ffish, variant-aware), draughts = PDN
   * ('11-15' / '11x18x25'), go/gomoku = 'B D4' / 'W Q16' color-prefixed
   * vertices ('pass' stays bare), grid games = their codec where it already IS
   * the standard notation (othello 'd3', hex 'c7', morris 'd2-d3xg7', ttt
   * 'b2'), connect4 = landing square 'd4'. OPTIONAL: absent means the codec
   * string is already the notation. Never throws on garbage: implementations
   * fall back to echoing `move`.
   */
  notate?(s: S, move: string): string
  /** Stable string form of init options for the wire v4 start config. */
  serializeOptions?(o: unknown): string
}

/**
 * Notation for a finished (or partial) game: replay `moves` from the START
 * state through spec.play, collecting spec.notate for each move as it is about
 * to be played. States are immutable, so callers hold onto their init state
 * and pass it here at save time (src/shared/gameArchive.ts meta.notated).
 * Defensive: an illegal move (should never happen for a recorded game) stops
 * the replay. Remaining moves are echoed verbatim.
 */
export function notateGame<S>(spec: GameSpec<S>, start: S, moves: readonly string[]): string[] {
  const out: string[] = []
  let s: S | null = start
  for (let i = 0; i < moves.length; i++) {
    if (s === null) {
      out.push(moves[i])
      continue
    }
    out.push(spec.notate ? spec.notate(s, moves[i]) : moves[i])
    s = spec.play(s, moves[i])
  }
  return out
}
