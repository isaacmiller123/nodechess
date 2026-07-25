// Custom variants: runtime GameSpec adapters over user-authored variants.ini
// text (docs/GAMES-PLATFORM-SPEC.md §Phases P3: variants.ini builder UI +
// ffish.loadVariantConfig). The Variant Lab editor (features/games/editor/)
// authors CustomVariantDefs; this module turns one into a live, playable
// registry entry through the dynamic seam (registry.registerDynamic).
//
// Rules engine: the SAME ffish-es6 singleton as games/ffishVariants.ts, with
// specs mirrored from that file's transient-board pattern (states are plain +
// immutable; emscripten Boards are rebuilt per call and .delete()d). The move
// codec is widened to the fairy-sf largeboard limits (files a–l, ranks 1–10).
//
// ffish runtime facts this module is built around (probed against ffish-es6
// 0.7.9. Keep in sync with scripts/test-custom-variants.mjs):
//   - loadVariantConfig REGISTERS but never re-registers: a duplicate name is
//     rejected to stderr and the OLD definition stays live. Every registration
//     here therefore loads under a FRESH runtime name (cv<counter>) so edits
//     always take effect within a session.
//   - ffish.variants() lists runtime-loaded variants: the authoritative
//     "did it register?" check (a bad parent drops the section silently).
//   - A section with ZERO keys crashes Board construction (WASM OOB), so
//     empty bodies are rejected up front with a friendly error.
//   - Unknown keys / malformed betza values are silently ignored by the
//     parser: validation is necessarily behavioral (construct + probe moves).

import { getFfish, preloadFfish } from './ffish'
import type { GameKind, GameResult, GameSpec, MoveMeta } from './kernel'
import {
  registerDynamic,
  unregisterDynamic,
  type GameEntry,
  type GameRendererLoader
} from './registry'

// ---------------------------------------------------------------------------
// Definition (persisted shape: mirrors the custom_variant table)

export interface CustomVariantDef {
  /** Stable id (slug): the dynamic registry kind is `custom-<id>`. */
  id: string
  name: string
  description: string
  /** variants.ini text; the FIRST [section] is the variant that gets played. */
  iniText: string
  boardFiles: number
  boardRanks: number
}

/** fairy-sf largeboard build limits (12 files × 10 ranks). */
export const MAX_BOARD_FILES = 12
export const MAX_BOARD_RANKS = 10
export const MIN_BOARD_SIZE = 4

/** The dynamic registry kind for a custom variant id. */
export function customKindOf(id: string): string {
  return `custom-${id}`
}

// ---------------------------------------------------------------------------
// ini text plumbing

const SECTION_RE = /^\s*\[([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?\]\s*$/

export interface IniHead {
  /** Variant name of the first section. */
  name: string
  /** Parent variant (null = from scratch). */
  parent: string | null
  /** Line index of the first section header. */
  line: number
  /** True when at least one `key = value` line follows before the next section. */
  hasKeys: boolean
}

/** Parse the first [name] / [name:parent] section header of an ini text. */
export function parseIniHead(iniText: string): IniHead | null {
  const lines = iniText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_RE.exec(lines[i])
    if (!m) continue
    let hasKeys = false
    for (let j = i + 1; j < lines.length; j++) {
      if (SECTION_RE.test(lines[j])) break
      const l = lines[j].trim()
      if (l.length === 0 || l.startsWith('#') || l.startsWith(';')) continue
      if (l.includes('=')) {
        hasKeys = true
        break
      }
    }
    return { name: m[1], parent: m[2] ?? null, line: i, hasKeys }
  }
  return null
}

/** Read an integer `key = n` value from the first section (editor pre-checks). */
function readIntKey(iniText: string, key: string): number | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, 'm')
  const m = re.exec(iniText)
  return m ? parseInt(m[1], 10) : null
}

/** Rewrite the FIRST section header to a new variant name (parent preserved). */
function rewriteHead(iniText: string, head: IniHead, newName: string): string {
  const lines = iniText.split(/\r?\n/)
  lines[head.line] = head.parent ? `[${newName}:${head.parent}]` : `[${newName}]`
  return lines.join('\n')
}

let runtimeCounter = 0

// ---------------------------------------------------------------------------
// Validation: friendly errors, behavioral checks

export interface IniValidation {
  ok: boolean
  /** Human-readable problem when !ok. */
  error?: string
  /** Start-position facts when ok. */
  startFen?: string
  moveCount?: number
}

/**
 * Validate a variants.ini text end to end: syntax pre-checks, a real
 * loadVariantConfig under a scratch name, board construction and a legal-move
 * probe. Requires ffish (await preloadFfish() first; the editor does).
 */
export function validateCustomVariantIni(iniText: string): IniValidation {
  const pre = precheckIni(iniText)
  if (pre) return { ok: false, error: pre }
  const head = parseIniHead(iniText)!
  try {
    const loaded = loadUnderRuntimeName(iniText, head)
    if (!loaded.registered) {
      return {
        ok: false,
        error: head.parent
          ? `The engine did not register “${head.name}”. Its parent variant “${head.parent}” is unknown. ` +
            'Use a built-in parent like chess, atomic, placement, grand or crazyhouse.'
          : `The engine did not register “${head.name}”. Check the [${head.name}] section for typos.`
      }
    }
    const ffish = getFfish()
    const BoardCtor = ffish.Board as unknown as new (variant: string) => FfishBoardLike
    const board = new BoardCtor(loaded.runtimeName)
    try {
      const startFen = board.fen()
      const moveCount = board.numberLegalMoves()
      if (moveCount === 0) {
        return {
          ok: false,
          error: 'The variant loads, but the side to move has NO legal moves in the start position, ' +
            'check the startFen (kings present? side to move not already mated?).'
        }
      }
      return { ok: true, startFen, moveCount }
    } finally {
      board.delete()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error:
        `The engine rejected this configuration (${msg}). ` +
        'Most common causes: a startFen that does not match the board size, or a piece letter used in ' +
        'startFen that no rule line defines.'
    }
  }
}

/** Cheap syntax pre-checks with actionable messages (null = fine). */
function precheckIni(iniText: string): string | null {
  if (iniText.trim().length === 0) return 'The variant definition is empty. Start from a template.'
  const head = parseIniHead(iniText)
  if (!head) {
    return 'No [variant] section found. The first line of a variant is its header, e.g. [myvariant:chess].'
  }
  if (!head.hasKeys) {
    return `The [${head.name}] section has no rule lines. Add at least one, e.g. “startFen = …”, ` +
      'an empty section crashes the rules engine.'
  }
  const files = readIntKey(iniText, 'maxFile')
  const ranks = readIntKey(iniText, 'maxRank')
  if (files !== null && (files < MIN_BOARD_SIZE || files > MAX_BOARD_FILES)) {
    return `maxFile = ${files} is out of range. The engine supports ${MIN_BOARD_SIZE} to ${MAX_BOARD_FILES} files.`
  }
  if (ranks !== null && (ranks < MIN_BOARD_SIZE || ranks > MAX_BOARD_RANKS)) {
    return `maxRank = ${ranks} is out of range. The engine supports ${MIN_BOARD_SIZE} to ${MAX_BOARD_RANKS} ranks.`
  }
  return null
}

function loadUnderRuntimeName(
  iniText: string,
  head: IniHead
): { runtimeName: string; registered: boolean } {
  const ffish = getFfish()
  const runtimeName = `cv${++runtimeCounter}x${head.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}`
  ffish.loadVariantConfig(rewriteHead(iniText, head, runtimeName))
  const registered = ffish
    .variants()
    .split(/\s+/)
    .includes(runtimeName)
  return { runtimeName, registered }
}

// ---------------------------------------------------------------------------
// GameSpec over a runtime-loaded custom variant (mirrors games/ffishVariants.ts.
// See that file for the transient-board rationale)

export interface CustomVariantState {
  /** ffish runtime variant name (cv<N>…; unique per registration). */
  readonly variant: string
  readonly startFen: string
  readonly moves: readonly string[]
  readonly fen: string
}

// Largeboard square = file a–l + rank 1–10 (two-digit ranks).
const SQ = '[a-l](?:10|[1-9])'
const MOVE_RE = new RegExp(`^(?:[A-Z+]?@${SQ}|${SQ}${SQ}[a-z+]?)$`)
const PROMO_RE = new RegExp(`^${SQ}${SQ}[a-z+]$`)

interface FfishBoardLike {
  delete(): void
  legalMoves(): string
  push(uciMove: string): boolean
  pushMoves(uciMoves: string): void
  fen(): string
  isGameOver(claimDraw?: boolean): boolean
  result(claimDraw?: boolean): string
  isCheck(): boolean
  isCapture(uciMove: string): boolean
  numberLegalMoves(): number
  isInsufficientMaterial(): boolean
  /** SAN for a LEGAL uci move at the current position (default Notation.SAN). */
  sanMove(uciMove: string): string
}

function makeBoard(variant: string, fen?: string): FfishBoardLike {
  const ffish = getFfish()
  const BoardCtor = ffish.Board as unknown as new (variant: string, fen?: string) => FfishBoardLike
  return fen === undefined ? new BoardCtor(variant) : new BoardCtor(variant, fen)
}

function withBoard<T>(s: CustomVariantState, fn: (board: FfishBoardLike) => T): T {
  const board = makeBoard(s.variant, s.startFen)
  try {
    if (s.moves.length > 0) board.pushMoves(s.moves.join(' '))
    return fn(board)
  } finally {
    board.delete()
  }
}

export interface CustomVariantInitOptions {
  /** Start from an arbitrary (variant-legal) FEN instead of the ini startFen. */
  fen?: string
}

function makeCustomSpec(def: CustomVariantDef, runtimeName: string): GameSpec<CustomVariantState> {
  const init = (options?: unknown): CustomVariantState => {
    const opts = (options ?? {}) as CustomVariantInitOptions
    const ffish = getFfish()
    let startFen: string
    if (opts.fen !== undefined) {
      if (ffish.validateFen(opts.fen, runtimeName) !== 1) {
        throw new Error(`invalid ${def.name} FEN: ${opts.fen}`)
      }
      startFen = opts.fen
    } else {
      const board = makeBoard(runtimeName)
      try {
        startFen = board.fen()
      } finally {
        board.delete()
      }
    }
    return { variant: runtimeName, startFen, moves: [], fen: startFen }
  }

  return {
    // Dynamic kinds live outside the closed GameKind union by design. The
    // registry's dynamic seam keys entries by this string.
    kind: customKindOf(def.id) as GameKind,
    family: 'chess',
    title: def.name,
    tagline: def.description || 'A Variant Lab original.',
    players: ['white', 'black'],
    board: { layout: 'cells', files: def.boardFiles, ranks: def.boardRanks },
    flipPolicy: 'rotate',
    clock: { supported: true },
    preload: async (): Promise<void> => {
      await preloadFfish()
    },
    init,
    legalMoves: (s: CustomVariantState): string[] =>
      withBoard(s, (board) => {
        const raw = board.legalMoves().trim()
        return raw.length > 0 ? raw.split(/\s+/) : []
      }),
    play: (s: CustomVariantState, move: string): CustomVariantState | null => {
      if (!MOVE_RE.test(move)) return null
      return withBoard(s, (board) => {
        if (!board.push(move)) return null
        return { variant: s.variant, startFen: s.startFen, moves: [...s.moves, move], fen: board.fen() }
      })
    },
    result: (s: CustomVariantState): GameResult | null =>
      withBoard(s, (board) => {
        if (!board.isGameOver()) return null
        const score = board.result()
        if (score !== '1-0' && score !== '0-1' && score !== '1/2-1/2') return null
        const winner = score === '1-0' ? 'white' : score === '0-1' ? 'black' : null
        const reason =
          board.numberLegalMoves() === 0
            ? board.isCheck()
              ? 'checkmate'
              : 'stalemate'
            : board.isInsufficientMaterial()
              ? 'insufficient-material'
              : 'variant'
        return { winner, score, reason }
      }),
    moveMeta: (s: CustomVariantState, move: string): MoveMeta => {
      if (!MOVE_RE.test(move)) return {}
      return withBoard(s, (board) => {
        const capture = board.isCapture(move)
        if (!board.push(move)) return {}
        const check = board.isCheck()
        const promote = PROMO_RE.test(move)
        const sound = check ? 'check' : promote ? 'promote' : capture ? 'capture' : 'move'
        return { capture, sound }
      })
    },
    // SAN via ffish (kernel notate contract): legality-checked first, since
    // sanMove on an illegal move is undefined behavior in the WASM.
    notate: (s: CustomVariantState, move: string): string => {
      if (!MOVE_RE.test(move)) return move
      return withBoard(s, (board) => {
        const legal = board.legalMoves().trim()
        if (legal.length === 0 || !legal.split(/\s+/).includes(move)) return move
        return board.sanMove(move)
      })
    },
    serializeOptions: (o: unknown): string => JSON.stringify(o ?? null)
  }
}

// ---------------------------------------------------------------------------
// Registration: def → live dynamic registry entry

const placeholderRenderer: GameRendererLoader = () => import('./PlaceholderBoard')

/** id → registered entry (replaced wholesale on re-registration). */
const LIVE = new Map<string, GameEntry>()

/**
 * Load a custom variant into ffish and (re)register its dynamic registry
 * entry. Await-safe to call repeatedly for the same id. Every call loads a
 * fresh runtime variant name so edits take effect immediately.
 *
 * `loadRenderer` lets the caller supply a real board component (the Variant
 * Lab passes its chess-family custom board); defaults to the placeholder.
 */
export async function registerCustomVariant(
  def: CustomVariantDef,
  loadRenderer?: GameRendererLoader
): Promise<GameEntry> {
  await preloadFfish()
  const pre = precheckIni(def.iniText)
  if (pre) throw new Error(pre)
  const head = parseIniHead(def.iniText)!
  const { runtimeName, registered } = loadUnderRuntimeName(def.iniText, head)
  if (!registered) {
    throw new Error(
      head.parent
        ? `Variant “${def.name}” did not register, unknown parent “${head.parent}”.`
        : `Variant “${def.name}” did not register. Check its [section] header.`
    )
  }
  const entry: GameEntry = {
    spec: makeCustomSpec(def, runtimeName) as GameSpec<unknown>,
    loadRenderer: loadRenderer ?? placeholderRenderer,
    botProviderId: 'fairy-stockfish',
    manualId: 'custom-variant',
    requiresPreload: true
  }
  registerDynamic(entry)
  LIVE.set(def.id, entry)
  return entry
}

/** Drop a custom variant's dynamic registry entry (ffish keeps the loaded config; harmless). */
export function unregisterCustomVariant(id: string): void {
  LIVE.delete(id)
  unregisterDynamic(customKindOf(id))
}

