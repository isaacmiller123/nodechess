import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import { Clapperboard, RotateCcw, Repeat, StepForward } from 'lucide-react'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import type { CatalogEntry } from './catalog'
import { getGame, isRegisteredGame } from '../../games/registry'
import type { GameKind } from '../../games/kernel'
import { replayOptionsOf } from '../../games/archive'
import { useBoardSound } from '../../games/boards/useBoardSound'
import { ReplayTheater, buildTheaterInput, type TheaterInput } from '../library/ReplayTheater'
import { Board3DHost, BoardModeToggle, useBoardMode } from './boardMode'
import { useOtbOrientation } from './useOtbOrientation'
import { useSaveFinishedGame } from './useSaveFinishedGame'

/**
 * Local over-the-board play for the WHOLE chess family (all 14 kinds), driven
 * entirely by the game kernel registry: rules via GameSpec (chessops wave +
 * ffish WASM wave: awaited via spec.preload() behind a shimmer), board via
 * the entry's lazy renderer (games/boards/ChessFamilyBoard.tsx: pockets,
 * promotion dialogs, intersection grids), accurate variant end states,
 * auto-flip per spec.flipPolicy, and kernel moveMeta sounds.
 * TODO(P2): clocks + move list + PGN save via the session layer.
 */

/** Human side labels where white/black is not the tradition. */
const SIDE_NAMES: Partial<Record<GameKind, [string, string]>> = {
  shogi: ['Sente', 'Gote'],
  xiangqi: ['Red', 'Black'],
  janggi: ['Cho (blue)', 'Han (red)']
}

interface CfState {
  fen?: string
  moves?: readonly string[]
}

function turnOf(state: unknown): 'white' | 'black' {
  const s = (state ?? {}) as CfState
  const token = typeof s.fen === 'string' ? s.fen.split(' ')[1] : undefined
  if (token === 'b') return 'black'
  if (token === 'w') return 'white'
  return (s.moves?.length ?? 0) % 2 === 0 ? 'white' : 'black'
}

const PASS_RE = /^([a-i](?:10|[1-9]))\1$/

export function VariantOtb({ entry }: { entry: CatalogEntry }): JSX.Element {
  const { settings } = useSettings()
  const kind = (isRegisteredGame(entry.kind) ? entry.kind : 'chess') as GameKind
  const game = getGame(kind)
  if (!game) throw new Error(`unregistered game kind: ${entry.kind}`)
  const spec = game.spec

  const [ready, setReady] = useState(!game.requiresPreload)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [state, setState] = useState<unknown>(() => (game.requiresPreload ? null : spec.init()))
  const [moveCount, setMoveCount] = useState(0)
  const [autoFlip, setAutoFlip] = useState(true)
  const { is3d } = useBoardMode(kind)

  // ffish WASM preload: the board renders behind a shimmer until resolved.
  useEffect(() => {
    if (ready || !spec.preload) return
    let cancelled = false
    spec
      .preload()
      .then(() => {
        if (cancelled) return
        setState(spec.init())
        setReady(true)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [ready, spec])

  const Board = useMemo(() => lazy(game.loadRenderer), [game])

  useBoardSound(kind, state)

  const outcome = ready && state !== null ? spec.result(state) : null
  const turn = turnOf(state)

  const legal = useMemo<readonly string[]>(() => {
    if (!ready || state === null || outcome) return []
    try {
      return spec.legalMoves(state)
    } catch {
      return []
    }
  }, [ready, state, outcome, spec])

  // Janggi pass = a same-square king move ('e2e2'): not expressible as a
  // board gesture, so it gets a dedicated control.
  const passMove = useMemo(() => legal.find((m) => PASS_RE.test(m)), [legal])

  const onMove = useCallback(
    (move: string) => {
      setState((s: unknown) => {
        if (s === null) return s
        const next = spec.play(s, move)
        if (!next) return s
        setMoveCount((n) => n + 1)
        return next
      })
    },
    [spec]
  )

  const reset = useCallback(() => {
    if (!ready) return
    setState(spec.init())
    setMoveCount(0)
  }, [ready, spec])

  const rotates = spec.flipPolicy === 'rotate'
  // Chess-OTB timing: flip a beat AFTER the committed move, instant repaint.
  const orientation = useOtbOrientation(turn, rotates && autoFlip)
  const sides = SIDE_NAMES[kind] ?? ['White', 'Black']
  const sideName = (color: 'white' | 'black'): string => (color === 'white' ? sides[0] : sides[1])

  // Archive every finished OTB game (feature foundation: reviewable later).
  useSaveFinishedGame(spec, state, outcome, {
    white: sides[0],
    black: sides[1],
    event: 'Over the board',
    source: 'play-otb',
    opponentKind: 'human',
    opponentLabel: 'Over the board'
  })

  const resultLabel =
    outcome &&
    (outcome.winner === null
      ? `Draw: ${outcome.reason.replace(/-/g, ' ')}`
      : `${sideName(outcome.winner)} wins: ${outcome.reason.replace(/-/g, ' ')}`)

  // Post-game Replay Theater (cinematic 3D/2D re-run of the finished game).
  const [theater, setTheater] = useState<TheaterInput | null>(null)
  const openTheater = useCallback(() => {
    if (state === null || !outcome) return
    setTheater(
      buildTheaterInput({
        entry: game,
        moves: ((state as CfState).moves ?? []) as readonly string[],
        options: replayOptionsOf(spec, state),
        result: outcome.score,
        reason: outcome.reason,
        white: sides[0],
        black: sides[1],
        event: 'Over the board'
      })
    )
  }, [state, outcome, game, spec, sides])

  const shimmer = (
    <div
      className="cfb-loading"
      style={{ '--cfb-files': spec.board.files, '--cfb-ranks': spec.board.ranks } as CSSProperties}
    >
      <span className="cfb-loading-label">{loadError ?? `Setting up the ${spec.title} board…`}</span>
    </div>
  )

  return (
    <div className="votb">
      <div className="votb-stage">
        <div className={`votb-cfb board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}>
          {!ready || state === null ? (
            shimmer
          ) : is3d ? (
            <Board3DHost
              kind={kind}
              state={state}
              orientation={orientation}
              interactive={!outcome}
              onMove={onMove}
            />
          ) : (
            <Suspense fallback={shimmer}>
              <Board
                kind={kind}
                state={state}
                orientation={orientation}
                interactive={!outcome}
                onMove={onMove}
              />
            </Suspense>
          )}
        </div>
        {outcome && (
          <div className="votb-banner" role="status">
            <strong>{resultLabel}</strong>
            <button type="button" className="votb-btn" onClick={openTheater}>
              <Clapperboard size={14} aria-hidden /> Watch replay
            </button>
            <button type="button" className="votb-btn is-primary" onClick={reset}>
              <RotateCcw size={14} aria-hidden /> Play again
            </button>
          </div>
        )}
        {theater && <ReplayTheater data={theater} onExit={() => setTheater(null)} />}
      </div>
      <aside className="votb-side">
        <div className="votb-turn">
          <span className={`votb-turn-dot is-${turn}`} aria-hidden />
          {outcome ? 'Game over' : `${sideName(turn)} to move`}
          <span className="votb-movecount">{moveCount === 1 ? '1 move' : `${moveCount} moves`}</span>
        </div>
        <BoardModeToggle kind={kind} />
        {rotates && (
          <label className="votb-flip">
            <input type="checkbox" checked={autoFlip} onChange={(e) => setAutoFlip(e.target.checked)} />
            <Repeat size={14} aria-hidden />
            Auto-flip board to the side to move
          </label>
        )}
        {passMove && !outcome && (
          <button type="button" className="votb-btn" onClick={() => onMove(passMove)}>
            <StepForward size={14} aria-hidden /> Pass turn
          </button>
        )}
        <button type="button" className="votb-btn" onClick={reset} disabled={!ready}>
          <RotateCcw size={14} aria-hidden /> {kind === 'chess960' ? 'New position' : 'Restart game'}
        </button>
        <p className="votb-note">Over-the-board: two players, one machine. Pass it between moves.</p>
      </aside>
    </div>
  )
}
