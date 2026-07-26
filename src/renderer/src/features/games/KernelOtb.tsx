// Local over-the-board play for every kernel game (non-chessops kinds).
// Two humans, one machine, rules end-to-end through the registry GameSpec:
// the board proposes moves, this owner answers via spec.play, terminal states
// come from spec.result. Flip policy is respected exactly, 'rotate' kinds
// (checkers, morris) get the auto-flip toggle, 'none' kinds (go, gomoku,
// othello, hex, connect4, tictactoe) never rotate.
//
// Extras the codecs need from the owner:
//   - a Pass button whenever 'pass' is legal (go always; othello when forced),
//     and Swap for hex's pie rule when enabled;
//   - go's scoring phase: the board proposes onAction('markdead <v>') /
//     onAction('finalize'), resolved here through the GoSpec seam;
//   - go board-size picker (9/13/19): picking a size starts a fresh game;
//   - ffish kinds (requiresPreload) await spec.preload() before init.

import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { ComponentType } from 'react'
import { Clapperboard, RotateCcw, Repeat } from 'lucide-react'
import type { CatalogEntry } from './catalog'
import type { SurfaceSetup } from './setup'
import { getGame, isRegisteredGame, type GameBoardProps } from '../../games/registry'
import type { PlayerColor } from '../../games/kernel'
import type { GoHandicap, GoSpec, GoState } from '../../games/go'
import { replayOptionsOf } from '../../games/archive'
import { BYOYOMI_PRESETS, byoyomiPresetById } from '../play/byoyomi'
import { ReplayTheater, buildTheaterInput, type TheaterInput } from '../library/ReplayTheater'
import { Board3DHost, BoardModeToggle, useBoardMode } from './boardMode'
import { GO_MAIN_PRESETS, GoClockPair, useLocalGoClock, type GoClockConfig } from './goClock'
import { SurfaceClockPair, useSurfaceClock } from './otbClock'
import { TerritoryControl, useTerritoryEstimate } from './territory'
import { useOtbOrientation } from './useOtbOrientation'
import { useSaveFinishedGame } from './useSaveFinishedGame'

/** Per-idiom color naming (spec players stay white/black on the wire). */
export function kernelColorLabel(kind: string, c: PlayerColor): string {
  if (kind === 'connect4') return c === 'white' ? 'Red' : 'Yellow'
  if (kind === 'hex') return c === 'white' ? 'Red' : 'Blue'
  if (kind === 'tictactoe') return c === 'white' ? 'X' : 'O'
  return c === 'white' ? 'White' : 'Black'
}

const DOT_COLORS: Record<string, [string, string]> = {
  connect4: ['#d84b40', '#e8c33a'],
  hex: ['#c0392b', '#2a6fb8']
}

// Lazy board components are cached per kind so re-entering a game page never
// re-suspends an already-loaded board.
const BOARD_CACHE = new Map<string, ComponentType<GameBoardProps>>()

function lazyBoard(kind: string): ComponentType<GameBoardProps> {
  const cached = BOARD_CACHE.get(kind)
  if (cached) return cached
  const entry = getGame(kind as never)
  const Board = lazy(entry!.loadRenderer)
  BOARD_CACHE.set(kind, Board as unknown as ComponentType<GameBoardProps>)
  return BOARD_CACHE.get(kind)!
}

const GO_SIZES = [9, 13, 19] as const
/** 'Off' + the standard 2–9 hoshi handicaps (1 is just komi, not a thing). */
const GO_HANDICAPS: readonly GoHandicap[] = [0, 2, 3, 4, 5, 6, 7, 8, 9]

interface StateWithMoves {
  moves: readonly string[]
}

export function KernelOtb({
  entry,
  setup
}: {
  entry: CatalogEntry
  /** What the setup screen chose. Seeds only: the controls below still own
   *  every game after this one. */
  setup?: SurfaceSetup
}): JSX.Element {
  const kind = entry.kind
  const game = isRegisteredGame(kind) ? getGame(kind) : undefined
  if (!game) throw new Error(`KernelOtb: unregistered kind ${kind}`)
  const spec = game.spec

  const [goSize, setGoSize] = useState<9 | 13 | 19>(setup?.goSize ?? 19)
  const [goHandicap, setGoHandicap] = useState<GoHandicap>(setup?.goHandicap ?? 0)
  // Go clocks (QoL): main-time preset + Japanese byo-yomi preset; both 'off' =
  // no clock at all (the historical untimed OTB default stays the default).
  const [goMainId, setGoMainId] = useState(setup?.goMainId ?? 'off')
  const [goByoId, setGoByoId] = useState(setup?.goByoId ?? 'off')
  // Komi and the scoring rule have no control on this screen, so they stay as
  // the setup screen left them. Handicap stones ARE the compensation, so go.ts
  // drops komi to 0.5 by itself the moment the size chips place any.
  const goKomi = setup?.goKomi
  const goScoringRule = setup?.goScoring
  const initOptions = useMemo(
    () =>
      kind === 'go'
        ? {
            size: goSize,
            ...(goScoringRule ? { scoring: goScoringRule } : {}),
            ...(goHandicap >= 2
              ? { handicap: goHandicap }
              : goKomi !== undefined
                ? { komi: goKomi }
                : {})
          }
        : setup?.initOptions,
    [kind, goSize, goHandicap, goKomi, goScoringRule, setup]
  )

  const [ready, setReady] = useState(() => game.requiresPreload !== true)
  const [state, setState] = useState<unknown>(() => (game.requiresPreload ? null : spec.init(initOptions)))
  const [autoFlip, setAutoFlip] = useState(true)
  // A side lost on time (local go clocks). A terminal state the SPEC cannot
  // know about, so it lives beside `result` and freezes the board the same way.
  const [timeLoss, setTimeLoss] = useState<PlayerColor | null>(null)
  // Bumped on every fresh game so the clock hook re-inits from its config.
  const [clockEpoch, setClockEpoch] = useState(0)
  const [territoryOn, setTerritoryOn] = useState(false)
  const { is3d } = useBoardMode(kind)

  useEffect(() => {
    if (ready) return
    let alive = true
    void spec.preload?.().then(() => {
      if (!alive) return
      setState(spec.init(initOptions))
      setReady(true)
    })
    return (): void => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const Board = lazyBoard(kind)

  const moves = state !== null ? (state as StateWithMoves).moves : []
  const result = useMemo(() => (state !== null && ready ? spec.result(state) : null), [spec, state, ready])
  const legal = useMemo(
    () => (state !== null && ready && !result ? spec.legalMoves(state) : []),
    [spec, state, ready, result]
  )
  // spec.turn (when present) outranks parity: go's handicap makes WHITE open.
  const turn: PlayerColor =
    state !== null && ready && spec.turn ? spec.turn(state) : spec.players[moves.length % 2]
  const goScoring =
    kind === 'go' && state !== null && !result && (spec as unknown as GoSpec).isScoringPhase(state as GoState)

  // Local go clocks: main + byo-yomi presets → the shared byo-yomi math. The
  // opener thinks free (clock arms on the first committed move, like online's
  // first-move grace); scoring phase and terminal states pause everything.
  const goClockCfg = useMemo<GoClockConfig | null>(() => {
    if (kind !== 'go') return null
    const mainMs = GO_MAIN_PRESETS.find((p) => p.id === goMainId)?.ms ?? 0
    const byo = byoyomiPresetById(goByoId).byo
    return mainMs > 0 || byo ? { mainMs, byo } : null
  }, [kind, goMainId, goByoId])
  const clockRunning =
    state !== null && ready && !result && !goScoring && timeLoss === null && moves.length > 0
  const goClock = useLocalGoClock(goClockCfg, turn, clockRunning, clockEpoch, setTimeLoss)

  // Every other kind runs v1's base-plus-increment control instead: same
  // opener's grace, same flag, one clock model per game rather than per page.
  const over = result !== null || timeLoss !== null
  const fischer = useSurfaceClock({
    tcId: kind === 'go' ? undefined : setup?.tcId,
    gameKey: clockEpoch,
    turn,
    moves: moves.length,
    live: state !== null && ready && !over,
    over,
    onFlag: setTimeLoss
  })

  // Territory estimate (KataGo ownership overlay + score strip). Hidden
  // entirely unless the engine is installed; scoring phase has its own exact
  // paint, so the live estimate stands down there.
  const territory = useTerritoryEstimate(
    kind === 'go' ? (state as GoState | null) : null,
    kind === 'go' && territoryOn && !goScoring && !result && timeLoss === null
  )

  // Archive every finished OTB game (feature foundation: reviewable later).
  useSaveFinishedGame(spec, state, result, {
    white: kernelColorLabel(kind, 'white'),
    black: kernelColorLabel(kind, 'black'),
    event: 'Over the board',
    source: 'play-otb',
    opponentKind: 'human',
    opponentLabel: 'Over the board'
  })

  const onMove = useCallback(
    (move: string) => {
      setState((s: unknown) => (s === null ? s : (spec.play(s, move) ?? s)))
    },
    [spec]
  )

  const onAction = useCallback(
    (action: string) => {
      if (kind !== 'go') return
      const gs = spec as unknown as GoSpec
      setState((s: unknown) => {
        if (s === null) return s
        if (action === 'finalize') return gs.finalizeScore(s as GoState) ?? s
        if (action.startsWith('markdead ')) return gs.markDead(s as GoState, action.slice('markdead '.length)) ?? s
        return s
      })
    },
    [kind, spec]
  )

  const reset = useCallback(
    (options?: unknown) => {
      if (!ready) return
      setState(spec.init(options ?? initOptions))
      setTimeLoss(null)
      setClockEpoch((e) => e + 1)
    },
    [spec, ready, initOptions]
  )

  // Post-game Replay Theater (cinematic 3D/2D re-run of the finished game).
  const [theater, setTheater] = useState<TheaterInput | null>(null)
  const openTheater = useCallback(() => {
    if (state === null) return
    setTheater(
      buildTheaterInput({
        entry: game,
        moves: (state as StateWithMoves).moves,
        options: replayOptionsOf(spec, state),
        result: result?.score ?? (timeLoss ? (timeLoss === 'white' ? '0-1' : '1-0') : '*'),
        reason: result?.reason ?? (timeLoss ? 'time' : undefined),
        white: kernelColorLabel(kind, 'white'),
        black: kernelColorLabel(kind, 'black'),
        event: 'Over the board'
      })
    )
  }, [state, game, spec, result, timeLoss, kind])

  const rotates = spec.flipPolicy === 'rotate'
  // Chess-OTB timing: flip a beat AFTER the committed move, instant repaint.
  // The setup screen's "Play as" is the side the board opens facing.
  const orientation: PlayerColor = useOtbOrientation(
    turn,
    rotates && autoFlip,
    setup?.color ?? 'white'
  )
  const canPass = timeLoss === null && legal.includes('pass')
  const canSwap = timeLoss === null && legal.includes('swap')

  const resultLabel = timeLoss
    ? `${kernelColorLabel(kind, timeLoss === 'white' ? 'black' : 'white')} wins on time`
    : result &&
      (result.winner === null
        ? `Draw: ${result.reason.replace(/-/g, ' ')}`
        : `${kernelColorLabel(kind, result.winner)} wins: ${result.reason.replace(/-/g, ' ')}`)

  const dot = DOT_COLORS[kind]
  const turnLabel = goScoring
    ? 'Scoring: tap dead groups'
    : over
      ? 'Game over'
      : `${kernelColorLabel(kind, turn)} to move`

  return (
    <div className="votb">
      <div className="votb-stage">
        {/* shell.css owns the measure: .board-stage centres, .board-wrap sizes. */}
        <div className="board-stage">
          <div className="board-wrap">
            <Suspense fallback={<div className="kotb-loading">Setting up the board…</div>}>
              {state !== null && ready ? (
                is3d ? (
                  <Board3DHost
                    kind={kind as never}
                    state={state}
                    orientation={orientation}
                    interactive={!over}
                    onMove={onMove}
                    onAction={onAction}
                  />
                ) : (
                  <Board
                    kind={kind as never}
                    state={state}
                    orientation={orientation}
                    interactive={!over}
                    onMove={onMove}
                    onAction={onAction}
                    territory={territoryOn && !goScoring ? territory.estimate?.ownership : undefined}
                  />
                )
              ) : (
                <div className="kotb-loading">Loading rules engine…</div>
              )}
            </Suspense>
          </div>
        </div>
        {over && (
          <div className="votb-banner" role="status">
            <strong>{resultLabel}</strong>
            <button type="button" className="votb-btn" onClick={openTheater}>
              <Clapperboard size={14} aria-hidden /> Watch replay
            </button>
            <button type="button" className="votb-btn is-primary" onClick={() => reset()}>
              <RotateCcw size={14} aria-hidden /> Play again
            </button>
          </div>
        )}
        {theater && <ReplayTheater data={theater} onExit={() => setTheater(null)} />}
      </div>
      <aside className="votb-side">
        {kind === 'go' && goClockCfg && (
          <GoClockPair
            clock={goClock}
            turn={turn}
            labels={{ black: 'Black', white: 'White' }}
            over={over || goScoring}
          />
        )}
        {kind !== 'go' && (
          <SurfaceClockPair
            clock={fischer}
            turn={turn}
            labels={{
              white: kernelColorLabel(kind, 'white'),
              black: kernelColorLabel(kind, 'black')
            }}
            order={spec.players}
            over={over}
          />
        )}
        <div className="votb-turn">
          <span
            className={`votb-turn-dot${dot ? '' : ` is-${turn}`}`}
            style={dot ? { background: dot[turn === 'white' ? 0 : 1], borderColor: 'transparent' } : undefined}
            aria-hidden
          />
          {turnLabel}
          <span className="votb-movecount">
            {moves.length === 1 ? '1 move' : `${moves.length} moves`}
          </span>
        </div>
        {kind === 'go' && (
          <div className="kotb-sizes" role="group" aria-label="Board size">
            {GO_SIZES.map((sz) => (
              <button
                key={sz}
                type="button"
                className={`kotb-chip${goSize === sz ? ' is-active' : ''}`}
                onClick={() => {
                  setGoSize(sz)
                  reset({ size: sz, ...(goHandicap >= 2 ? { handicap: goHandicap } : {}) })
                }}
              >
                {sz}×{sz}
              </button>
            ))}
          </div>
        )}
        {kind === 'go' && (
          <div className="kotb-opt-row" role="group" aria-label="Handicap stones">
            <span className="kotb-opt-name">Handicap</span>
            {GO_HANDICAPS.map((h) => (
              <button
                key={h}
                type="button"
                className={`kotb-chip is-mini${goHandicap === h ? ' is-active' : ''}`}
                title={h === 0 ? 'Even game' : `Black pre-places ${h} hoshi stones; White moves first; komi 0.5`}
                onClick={() => {
                  setGoHandicap(h)
                  reset({ size: goSize, ...(h >= 2 ? { handicap: h } : {}) })
                }}
              >
                {h === 0 ? 'Off' : h}
              </button>
            ))}
          </div>
        )}
        {kind === 'go' && (
          <>
            <div className="kotb-opt-row" role="group" aria-label="Main time">
              <span className="kotb-opt-name">Main time</span>
              {GO_MAIN_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`kotb-chip is-mini${goMainId === p.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setGoMainId(p.id)
                    reset()
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="kotb-opt-row" role="group" aria-label="Byo-yomi overtime">
              <span className="kotb-opt-name">Byo-yomi</span>
              {BYOYOMI_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`kotb-chip is-mini${goByoId === p.id ? ' is-active' : ''}`}
                  title={
                    p.byo
                      ? `${p.byo.periods} overtime periods of ${p.byo.periodMs / 1000}s. A move inside a period resets it.`
                      : 'No overtime, main time only'
                  }
                  onClick={() => {
                    setGoByoId(p.id)
                    reset()
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </>
        )}
        {kind === 'go' && (
          <TerritoryControl territory={territory} on={territoryOn} onToggle={setTerritoryOn} />
        )}
        <BoardModeToggle kind={kind} />
        {rotates && (
          <label className="votb-flip">
            <input type="checkbox" checked={autoFlip} onChange={(e) => setAutoFlip(e.target.checked)} />
            <Repeat size={14} aria-hidden />
            Auto-flip board to the side to move
          </label>
        )}
        {canPass && (
          <button type="button" className="votb-btn" onClick={() => onMove('pass')}>
            Pass{kind === 'othello' ? ' (no legal placement)' : ''}
          </button>
        )}
        {canSwap && (
          <button type="button" className="votb-btn" onClick={() => onMove('swap')}>
            Swap (pie rule)
          </button>
        )}
        <button type="button" className="votb-btn" onClick={() => reset()}>
          <RotateCcw size={14} aria-hidden /> Restart game
        </button>
        <p className="votb-note">
          Over-the-board: pass the machine between moves.
        </p>
      </aside>
    </div>
  )
}
