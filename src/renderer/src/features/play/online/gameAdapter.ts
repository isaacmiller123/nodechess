// Online game-kernel seam (spec §Architecture / §Wire-v4). The onlineStore is
// game-agnostic: it keeps `moves: string[]` + an opaque `gameState` and consults
// a registered OnlineGameAdapter for EVERYTHING rules-shaped (apply a move,
// detect a terminal position, whose turn it is, flag adjudication). Chess is the
// built-in default (chessAdapter.ts) so existing online chess is behaviorally
// untouched; every OTHER registered game bridges in through adapterFromSpec()
// below, which wraps a kernel GameSpec (games/kernel.ts). The store registers
// the whole games/registry.ts at init, so every registered game is playable
// online automatically.
//
// Like the store, this module must run in BARE NODE (scripts/test-mp-store.mjs):
// no React, no Vite-only imports. GameSpec/SoundName imports are type-only.

import type { MpColor } from '@shared/types'
import type { GameResult } from '../../../chess/chess'
import type { GameSpec } from '../../../games/kernel'
import type { SoundName } from '../../../sound/SoundManager'

/** Presentation metadata for one applied move (sound + notation). Games without
 *  SAN-style notation may echo the move string as `san`. */
export interface OnlineMoveMeta {
  san: string
  capture: boolean
  check: boolean
  /** Spec-provided sound hint. Absent (chess) = the store's SAN heuristics. */
  sound?: SoundName
}

/** What the store needs from a game to run it online. `S` is the game's own
 *  immutable state snapshot (chess: a FEN string). All move strings are the
 *  game's canonical codec: the same opaque strings that ride the v4 wire. */
export interface OnlineGameAdapter<S = unknown> {
  /** Registry key; matches MpGameConfig.game.kind ('chess' when absent). */
  kind: string
  /** Fresh initial state for the (game-defined, JSON-round-tripped) options. */
  init(options?: unknown): S
  /** Apply one canonical move string; null = illegal in `s`. */
  play(s: S, move: string): S | null
  /** Terminal check; null = game still ongoing. */
  result(s: S): { result: GameResult; reason: string } | null
  /** Which side is to move in `s` (maps onto the wire's white/black seats). */
  turn(s: S): MpColor
  /** Opaque render/position key the UI board consumes (chess: the FEN). */
  positionKey(s: S): string
  /** Metadata for playing `move` in `s` (assumed legal). null = unknown. */
  moveMeta(s: S, move: string): OnlineMoveMeta | null
  /**
   * Adjudicate a timeout: `by` flagged in position `s`. Chess family applies
   * the lichess insufficient-material rule (a winner who can never mate gets a
   * draw); everything else treats a flag as a plain loss on time. Absent =
   * plain loss (the store's default).
   */
  flagResult?(s: S, by: MpColor): { result: GameResult; reason: string }
  /**
   * Present when the rules engine loads asynchronously (ffish WASM). The store
   * awaits it before init/play during host()/start. See needsPreload().
   */
  preload?(): Promise<void>
  /** True while preload() has not yet resolved (skip the async path when the
   *  engine is already up, so sync games start synchronously). */
  needsPreload?(): boolean
}

// Type-erased registry. Adapters are registered by kind; the store resolves the
// adapter for a game config at start.
const adapters = new Map<string, OnlineGameAdapter<unknown>>()

export function registerOnlineGameAdapter<S>(adapter: OnlineGameAdapter<S>): void {
  adapters.set(adapter.kind, adapter as OnlineGameAdapter<unknown>)
}

/** Resolve the adapter for a game kind (undefined kind = chess). Returns null
 *  when this build has no kernel for it. The store surfaces a friendly error
 *  instead of corrupting state. */
export function resolveOnlineGameAdapter(kind: string | undefined): OnlineGameAdapter<unknown> | null {
  return adapters.get(kind ?? 'chess') ?? null
}

// ---------------------------------------------------------------------------
// GameSpec → OnlineGameAdapter bridge.
// ---------------------------------------------------------------------------

/** The state fields adapterFromSpec reads structurally. Every kernel spec's
 *  state carries `moves` (its full codec history); the chess family also
 *  carries a `fen` whose second whitespace field is the side to move. */
interface SpecStateShape {
  moves?: readonly string[]
  fen?: string
  /** rapid-draughts engine snapshot (American checkers). */
  data?: { player?: unknown }
}

/** Go's scoring seam (games/go.ts GoSpec). Detected structurally so this
 *  module stays free of per-game imports. */
interface ScoringSeam<S> {
  isScoringPhase?(s: S): boolean
  finalizeScore?(s: S): S | null
}

/**
 * Bridge a kernel GameSpec into the store's online seam.
 *
 * Turn derivation (no turn() on GameSpec; derived per family, see each spec):
 *   - chess family (chessops + ffish states): the FEN's side-to-move field.
 *     Robust against custom-FEN start options;
 *   - American checkers: engine snapshot `data.player` ('light' = white);
 *   - International draughts: the library FEN's leading 'W'/'B';
 *   - everything else: move-count parity against spec.players. Every codec
 *     move is exactly one ply in every kernel game (go/othello passes, hex
 *     'swap' and morris mill-captures included).
 *
 * Terminal mapping: kernel GameResult.score → the store's '1-0' result string.
 * Go's scoring phase (two passes, dead-stone marking unresolved) has no wire
 * messages yet, so ONLINE go scores immediately after the second pass with
 * every stone treated as alive (Tromp-Taylor style), deterministic on both
 * peers. Play captures out before passing.
 */
export function adapterFromSpec<S>(spec: GameSpec<S>): OnlineGameAdapter<S> {
  const shape = (s: S): SpecStateShape => s as unknown as SpecStateShape
  const scoring = spec as unknown as ScoringSeam<S>
  let rulesReady = spec.preload === undefined

  const turn = (s: S): MpColor => {
    // A spec that knows its own side-to-move (go: handicap can make WHITE open)
    // outranks every structural derivation below.
    if (spec.turn) return spec.turn(s)
    const st = shape(s)
    if (spec.family === 'chess' && typeof st.fen === 'string') {
      const toMove = st.fen.split(/\s+/)[1]
      if (toMove === 'b') return 'black'
      if (toMove === 'w') return 'white'
    }
    if (spec.kind === 'checkers' && typeof st.data?.player === 'string') {
      return st.data.player === 'light' ? 'white' : 'black'
    }
    if (spec.kind === 'checkers-intl' && typeof st.fen === 'string') {
      return st.fen.startsWith('B') ? 'black' : 'white'
    }
    return spec.players[(st.moves?.length ?? 0) % 2]
  }

  const result = (s: S): { result: GameResult; reason: string } | null => {
    let out = spec.result(s)
    if (!out && scoring.finalizeScore && scoring.isScoringPhase?.(s)) {
      const finalized = scoring.finalizeScore(s)
      if (finalized) out = spec.result(finalized)
    }
    return out ? { result: out.score, reason: out.reason } : null
  }

  const adapter: OnlineGameAdapter<S> = {
    kind: spec.kind,

    init(options?: unknown): S {
      return spec.init(options)
    },

    play(s: S, move: string): S | null {
      return spec.play(s, move)
    },

    result,

    turn,

    positionKey(s: S): string {
      const st = shape(s)
      return typeof st.fen === 'string' ? st.fen : (st.moves ?? []).join(' ')
    },

    moveMeta(s: S, move: string): OnlineMoveMeta | null {
      const meta = spec.moveMeta(s, move)
      return {
        san: move, // non-SAN games echo the codec string (module contract above)
        capture: meta.capture === true,
        check: meta.sound === 'check',
        ...(meta.sound ? { sound: meta.sound } : {})
      }
    },

    flagResult(s: S, by: MpColor): { result: GameResult; reason: string } {
      const winner: MpColor = by === 'white' ? 'black' : 'white'
      if (spec.family === 'chess') {
        // chessops-backed states expose a live Position with the variant-aware
        // insufficient-material test; ffish states don't (fen-only). Their
        // flag is a plain loss, like every non-chess family.
        const pos = (s as { pos?: { hasInsufficientMaterial?(c: MpColor): boolean } }).pos
        if (pos?.hasInsufficientMaterial?.(winner) === true) {
          return { result: '1/2-1/2', reason: 'time out: insufficient material' }
        }
      }
      return { result: winner === 'white' ? '1-0' : '0-1', reason: 'on time' }
    }
  }

  if (spec.preload) {
    adapter.preload = async (): Promise<void> => {
      await spec.preload!()
      rulesReady = true
    }
    adapter.needsPreload = (): boolean => !rulesReady
  }

  return adapter
}
