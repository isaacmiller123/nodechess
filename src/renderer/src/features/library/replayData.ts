// Archive → replay data pipeline for the Library's game replay viewer.
//
// PURE module (no React, no window): scripts/test-replay-pipe.mjs bundles it
// for bare node together with the game registry, so keep renderer-only imports
// out. Two storage formats parse into one ParsedArchive:
//   - the JSON envelope (src/shared/gameArchive.ts: every non-chess save
//     since the archive contract landed), and
//   - the LEGACY generic text older online games saved (PGN-style tags incl.
//     [Variant "<kind>"] + wire-codec moves joined by spaces, result-terminated.
//     onlineStore.genericArchive).
// buildReplay() then replays the moves through GameSpec.play into one state
// per ply, validating every move and collecting display notation as it goes.

import { isArchiveJson, parseGameArchive } from '@shared/gameArchive'
import type { GameSpec, PlayerColor } from '../../games/kernel'

export interface ParsedArchive {
  /** Registry game kind. */
  kind: string
  /** Wire-codec moves, play order. */
  moves: string[]
  /** Per-move notation aligned with `moves` (envelope meta.notated). */
  notated?: string[]
  /** GameSpec.init options reproducing the start position. */
  options?: unknown
  result?: string
  reason?: string
  white?: string
  black?: string
  event?: string
  date?: string
  format: 'envelope' | 'legacy'
}

const RESULT_TOKENS = ['1-0', '0-1', '1/2-1/2', '*']

const TAG_RE = /^\[([A-Za-z][A-Za-z0-9_]*)\s+"([^"]*)"\]\s*$/

/** Parse the legacy generic archive text (tags + one moves line). Null when
 *  the text has no [Variant] tag. That shape is chess PGN, not a kernel game. */
function parseLegacyArchive(text: string): ParsedArchive | null {
  const lines = text.split(/\r?\n/)
  const tags: Record<string, string> = {}
  const moveLines: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t.length === 0) continue
    const m = TAG_RE.exec(t)
    if (m) tags[m[1]] = m[2]
    else moveLines.push(t)
  }
  const kind = tags.Variant
  if (!kind) return null
  const tokens = moveLines.join(' ').split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length > 0 && RESULT_TOKENS.includes(tokens[tokens.length - 1])) tokens.pop()
  return {
    kind,
    moves: tokens,
    result: tags.Result,
    white: tags.White,
    black: tags.Black,
    event: tags.Event,
    date: tags.Date,
    format: 'legacy'
  }
}

/**
 * Parse a game row's `pgn` column into replayable data. `fallbackKind` is the
 * row's game_kind column: legacy rows are stamped there too, so a missing
 * [Variant] tag still resolves. Returns null for chess PGN (the Library routes
 * those to the real Analysis view) and for unparseable text.
 */
export function parseReplayArchive(pgnText: string, fallbackKind?: string): ParsedArchive | null {
  const env = parseGameArchive(pgnText)
  if (env) {
    return {
      kind: env.kind,
      moves: env.moves,
      notated: env.meta?.notated,
      options: env.meta?.options,
      result: env.result,
      reason: env.meta?.reason,
      white: env.meta?.white,
      black: env.meta?.black,
      event: env.meta?.event,
      date: env.meta?.date,
      format: 'envelope'
    }
  }
  // JSON-shaped text that failed the strict parse (corrupt, or a FUTURE
  // envelope version) must never be re-read as legacy tag text.
  if (isArchiveJson(pgnText) || pgnText.trimStart().startsWith('{')) return null
  const legacy = parseLegacyArchive(pgnText)
  if (legacy) return legacy
  // Tag text without a Variant tag: only replayable if the row itself says
  // it's a non-chess kind (defensive: no known writer produces this).
  if (fallbackKind && fallbackKind !== 'chess') {
    const retagged = parseLegacyArchive(`[Variant "${fallbackKind}"]\n${pgnText}`)
    if (retagged) return retagged
  }
  return null
}

/** Notation for one move about to be played from `s`. The kernel notate
 *  contract with the codec string as the universal fallback. */
export function notationFor<S>(spec: GameSpec<S>, s: S, move: string): string {
  if (!spec.notate) return move
  try {
    return spec.notate(s, move)
  } catch {
    return move
  }
}

export interface ReplayLine<S = unknown> {
  /** One state per ply: states[0] = start, states[i] = after moves[i-1]. */
  states: S[]
  /** Moves actually replayed (= parsed.moves unless truncated). */
  moves: string[]
  /** Display notation aligned with `moves`. */
  notated: string[]
  /** True when a move failed to replay (corrupt/foreign archive): states/
   *  moves/notated stop at the last legal position. */
  truncated: boolean
}

/**
 * Replay a parsed archive through the spec: init(options) then play() per
 * move. Every position is validated by the rules engine itself (play returns
 * null for illegal moves); a reject truncates instead of throwing so a
 * damaged row still shows its legal prefix. Stored notation (meta.notated) is
 * preferred; missing/misaligned entries fall back to live spec.notate.
 */
export function buildReplay<S>(spec: GameSpec<S>, parsed: ParsedArchive): ReplayLine<S> {
  const states: S[] = [spec.init(parsed.options)]
  const moves: string[] = []
  const notated: string[] = []
  const stored = parsed.notated
  const storedAligned = stored !== undefined && stored.length === parsed.moves.length
  let truncated = false
  for (let i = 0; i < parsed.moves.length; i++) {
    const s = states[states.length - 1]
    const move = parsed.moves[i]
    const next = spec.play(s, move)
    if (next === null) {
      truncated = true
      break
    }
    moves.push(move)
    notated.push(storedAligned ? stored[i] : notationFor(spec, s, move))
    states.push(next)
  }
  return { states, moves, notated, truncated }
}

/** Side to move in `s` after `plies` moves. The kernel turn contract
 *  (options-aware via spec.turn: go handicap makes white open) with strict
 *  players-order alternation as the fallback. */
export function turnAt<S>(spec: GameSpec<S>, s: S, plies: number): PlayerColor {
  if (spec.turn) {
    try {
      return spec.turn(s)
    } catch {
      /* fall through to parity */
    }
  }
  return spec.players[plies % 2]
}
