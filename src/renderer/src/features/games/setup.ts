// The configuration screen's model: what design-lab/v1/games.html asks for,
// narrowed to what this build can actually honour, and turned into the options
// the play surfaces already take.
//
// v1 draws one dialog for all twenty-four games and fills its Advanced panel
// from a per-game map. That map was written against src/renderer/src/games, so
// most of it lands: go.ts really does take a size, a komi, a handicap and a
// scoring rule; chessVariants.ts really does take a Scharnagl number or a start
// FEN; hex.ts really does take the pie rule. Where it does not land, the row is
// absent rather than dead. Each omission is named at its case below.
import { INITIAL_FEN, makeFen, parseFen } from 'chessops/fen'
import { RemainingChecks, type Setup } from 'chessops/setup'
import type { PlayerColor } from '../../games/kernel'
import { getGame, isRegisteredGame } from '../../games/registry'
import { HANDICAP_KOMI, type GoHandicap, type GoScoring, type GoSize } from '../../games/go'
import { GOMOKU_SIZE } from '../../games/gomoku'
import { CATALOG, type CatalogEntry } from './catalog'

export type SetupMode = 'local' | 'bot' | 'online'

/** Which side of the board a seat picker refers to. */
export type SidePick = 'first' | 'second' | 'random'

export interface SetupState {
  mode: SetupMode
  /** 1..5, indexes games/bots.ts BOT_LEVEL_NAMES. */
  level: number
  /** A features/play/timeControl.ts id: the twelve v1 offers, 'unlimited' first. */
  tcId: string
  side: SidePick
  /** Chess family: start from the standard position or from a pasted FEN. */
  fromFen: boolean
  fen: string
  /** Chess960: shuffle, or the Scharnagl number below. */
  byNumber: boolean
  positionNumber: string
  /** Three-check: how many checks end it. chessops carries it in the position. */
  checks: number
  /** Checkers: which of the two boards, which is a different game kind. */
  draughtsKind: string
  goSize: GoSize
  goHandicap: GoHandicap
  goKomi: string
  goScoring: GoScoring
  goMainId: string
  goByoId: string
  gomokuSize: number
  hexSwap: boolean
  /** Create your own: which of the editor's seven starts to open. */
  templateId: string
  /** Create your own: the board the Lab opens on, "<files>x<ranks>". */
  boardSize: string
}

/**
 * What the configuration screen hands a play surface.
 *
 * Every field is a seed, not a lock: the surfaces keep their own controls, so
 * a second game from the same board can change its mind without walking back
 * out to the library.
 */
export interface SurfaceSetup {
  /** Skip the surface's own setup screen: this game was already configured. */
  autoStart?: boolean
  /** 1..5, indexes games/bots.ts BOT_LEVEL_NAMES. */
  level?: number
  /** The seat the user takes vs a bot, or the side the local board opens on.
   *  Random is already resolved. */
  color?: PlayerColor
  /** Base-plus-increment clock (features/play/timeControl.ts id). */
  tcId?: string
  /** Passed straight to spec.init() by surfaces that do not build their own. */
  initOptions?: unknown
  goSize?: GoSize
  goHandicap?: GoHandicap
  goKomi?: number
  goScoring?: GoScoring
  /** Local go clocks (features/games/goClock.tsx preset ids). */
  goMainId?: string
  goByoId?: string
}

/** Everything GamePage needs to open the right board on the right options. */
export interface GameLaunch {
  /** Usually the card that was clicked. Checkers is the exception: its Board
   *  row picks between two kinds, not between two options of one kind. */
  entry: CatalogEntry
  mode: SetupMode
  surface: SurfaceSetup
}

export function defaultSetup(entry: CatalogEntry): SetupState {
  return {
    mode: 'local',
    level: 3,
    // v1 opens every game on 10+0 and go on its longest control.
    tcId: '10+0',
    side: 'first',
    fromFen: false,
    fen: '',
    byNumber: false,
    positionNumber: '518',
    checks: 3,
    draughtsKind: entry.kind,
    goSize: 19,
    goHandicap: 0,
    goKomi: '6.5',
    goScoring: 'area',
    // v1 opens go on its longest control. The app's local go clocks are
    // goClock.tsx's four main-time presets, not the twelve Fischer ones, so
    // "the longest" here is 30m.
    goMainId: entry.kind === 'go' ? '30m' : 'off',
    goByoId: 'off',
    gomokuSize: GOMOKU_SIZE,
    hexSwap: false,
    templateId: 'standard',
    boardSize: '8x8'
  }
}

/** "<files>x<ranks>" split back into two numbers, or null if it is neither. */
export function parseBoardSize(size: string): { files: number; ranks: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(size)
  if (!m) return null
  return { files: Number(m[1]), ranks: Number(m[2]) }
}

/** The two seats of a game, in the order the game names them, opener first. */
export function sideLabels(kind: string): [string, string] {
  if (kind === 'shogi') return ['Sente', 'Gote']
  if (kind === 'xiangqi') return ['Red', 'Black']
  if (kind === 'janggi') return ['Cho (blue)', 'Han (red)']
  if (kind === 'connect4') return ['Red', 'Yellow']
  if (kind === 'hex') return ['Red', 'Blue']
  if (kind === 'tictactoe') return ['X', 'O']
  return sideColors(kind)[0] === 'white' ? ['White', 'Black'] : ['Black', 'White']
}

/** The two seats as the kernel names them, opener first. */
export function sideColors(kind: string): [PlayerColor, PlayerColor] {
  const spec = isRegisteredGame(kind) ? getGame(kind)?.spec : undefined
  const players = spec?.players
  return players ? [players[0], players[1]] : ['white', 'black']
}

/**
 * Which clock a mode and a game really have.
 *
 * 'fischer' is v1's twelve base-plus-increment controls, run by otbClock.tsx on
 * every local and vs-bot surface. Go is its own kind, because a go clock is
 * main time plus byo-yomi periods and an increment is not a thing there.
 * Online carries its own picker on the screen it opens, and the wire refuses an
 * untimed game, so that one choice still belongs there rather than here.
 */
export type ClockKind = 'go' | 'online-owns-it' | 'fischer'

export function clockKind(entry: CatalogEntry, mode: SetupMode): ClockKind {
  if (mode === 'online') return 'online-owns-it'
  return entry.kind === 'go' ? 'go' : 'fischer'
}

/**
 * What the seat picker decides in this mode.
 *
 * vs a bot it is the seat you take. Locally there is no seat to take (two
 * people, one machine), but there is still a side of the board you sit on, and
 * that is the side the board opens facing. Online the host's colour is asked
 * for on the screen the mode opens, so nothing here would reach it.
 */
export function seatMeaning(mode: SetupMode): 'seat' | 'orientation' | null {
  if (mode === 'bot') return 'seat'
  return mode === 'local' ? 'orientation' : null
}

/** Whether a seat picker means anything here. */
export function hasSeatChoice(mode: SetupMode): boolean {
  return seatMeaning(mode) !== null
}

export class SetupError extends Error {}

/**
 * Turn the screen into a launch, or explain why it cannot be one.
 *
 * The two free-text fields are the only places this can fail: chessops and
 * ffish both throw on a position they cannot set up, and a thrown error in the
 * board surface is a blank screen, so it is caught here where there is a form
 * to put the message next to.
 */
export function resolveLaunch(entry: CatalogEntry, s: SetupState): GameLaunch {
  const target = entry.family === 'draughts' ? draughtsEntry(entry, s.draughtsKind) : entry
  const colors = sideColors(target.kind)
  const color = !hasSeatChoice(s.mode)
    ? null
    : s.side === 'random'
      ? colors[Math.random() < 0.5 ? 0 : 1]
      : colors[s.side === 'first' ? 0 : 1]

  return {
    entry: target,
    mode: s.mode,
    surface: {
      autoStart: true,
      level: s.level,
      ...(color ? { color } : {}),
      ...(clockKind(target, s.mode) === 'fischer' ? { tcId: s.tcId } : {}),
      initOptions: checked(target, initOptionsFor(target, s)),
      ...(target.kind === 'go'
        ? {
            goSize: s.goSize,
            goHandicap: s.goHandicap,
            goKomi: goKomi(s),
            goScoring: s.goScoring,
            goMainId: s.goMainId,
            goByoId: s.goByoId
          }
        : {})
    }
  }
}

/**
 * Set the position up once, here, so a FEN the rules refuse is a sentence
 * under the form instead of a board that quietly opens somewhere else.
 *
 * The ffish kinds are the exception: their rules live in a WASM module that
 * has to be awaited, so the only place that can judge their FEN is the board
 * itself, once it has loaded.
 */
function checked(entry: CatalogEntry, options: unknown): unknown {
  if (options === undefined) return undefined
  const game = isRegisteredGame(entry.kind) ? getGame(entry.kind) : undefined
  if (!game || game.requiresPreload) return options
  try {
    game.spec.init(options)
  } catch {
    throw new SetupError('The rules cannot set that position up. Check the FEN.')
  }
  return options
}

/** A FEN as a chessops setup, or the message that says why it is not one. */
function readFen(fen: string): Setup {
  try {
    return parseFen(fen).unwrap()
  } catch {
    throw new SetupError('The rules cannot set that position up. Check the FEN.')
  }
}

/** Komi as a number, or the message that says why it is not one. */
function goKomi(s: SetupState): number {
  const komi = Number(s.goKomi)
  if (!Number.isFinite(komi) || komi < -10 || komi > 20) {
    throw new SetupError('Komi runs from -10 to 20.')
  }
  return komi
}

/* 8x8 and 10x10 are two kinds with two specs and two cards, not one game with
   a size option, so the Board row hands back the other card. */
function draughtsEntry(entry: CatalogEntry, kind: string): CatalogEntry {
  if (kind === entry.kind) return entry
  return CATALOG.find((e) => e.kind === kind) ?? entry
}

function initOptionsFor(entry: CatalogEntry, s: SetupState): unknown {
  if (entry.kind === 'chess960') {
    if (!s.byNumber) return undefined
    const n = Number(s.positionNumber)
    if (!Number.isInteger(n) || n < 0 || n > 959) {
      throw new SetupError('A start position is a whole number from 0 to 959.')
    }
    return { positionNumber: n }
  }

  if (entry.family === 'chess') {
    const pasted = s.fromFen ? s.fen.trim() : ''
    if (s.fromFen && !pasted) {
      throw new SetupError('Paste a position, or set Position back to Standard.')
    }

    /* "Checks to win" is not a rule bolted on beside the position: chessops
       keeps the remaining checks IN the position (RemainingChecks, the "2+2"
       field of the FEN), which is why it can be set on a pasted FEN as well as
       on the standard start and why the count survives every move from here. */
    if (entry.kind === 'threecheck') {
      const setup = readFen(pasted || INITIAL_FEN)
      setup.remainingChecks = new RemainingChecks(s.checks, s.checks)
      return { fen: makeFen(setup) }
    }

    if (!s.fromFen) return undefined
    return { fen: pasted }
  }

  // Go's four options reach the spec through the surface's own go controls
  // (KernelOtb / KernelBot build them, so a restart there keeps them), which
  // is why they travel as fields rather than as an opaque options blob.
  if (entry.kind === 'go') return undefined

  if (entry.kind === 'gomoku') return { size: s.gomokuSize }
  if (entry.kind === 'hex') return s.hexSwap ? { swap: true } : undefined

  // othello, connect4, morris, tictactoe and both draughts boards take no
  // options: their specs have none to take.
  return undefined
}

/** Komi the moment stones are placed: the stones ARE the compensation. */
export function komiForHandicap(handicap: GoHandicap): string {
  return handicap >= 2 ? String(HANDICAP_KOMI) : '6.5'
}
