// Game replay viewer: open ANY saved non-chess game (variants, ffish kinds,
// go, checkers, small games, Variant Lab customs) and step through it on the
// kind's real 2D board: two-column notation list, click-to-jump, keyboard
// arrows, autoplay with speed control, sounds, and a local eval bar where an
// engine exists (Fairy-Stockfish for the chess family, KataGo raw-net for go).
// From any position exploratory moves fork an in-memory VARIATION (indented
// under the mainline, chess-Analysis-lite); "Back to game" snaps to the
// mainline. Chess rows never route here: the Library sends those to the full
// Analysis/review view.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type JSX
} from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clapperboard,
  Cpu,
  FlipVertical2,
  Layers,
  Pause,
  Play,
  Undo2
} from 'lucide-react'
import type { GameRow } from '@shared/types'
import { pieceSetClass } from '../../board/pieceSets'
import { EvalBar } from '../../board/EvalBar'
import { useSettings } from '../../state/settings'
import type { GameKind, GameSpec, PlayerColor } from '../../games/kernel'
import { getGame, isRegisteredGame, type GameBoardProps, type GameEntry } from '../../games/registry'
import { registerCustomVariant } from '../../games/customVariants'
import { useBoardSound } from '../../games/boards/useBoardSound'
import type { GoState } from '../../games/go'
import { kernelColorLabel } from '../games/KernelOtb'
import { useTerritoryEstimate } from '../games/territory'
import {
  buildReplay,
  notationFor,
  parseReplayArchive,
  turnAt,
  type ParsedArchive,
  type ReplayLine
} from './replayData'
import { ReplayTheater } from './ReplayTheater'
import { useReplayEval } from './useReplayEval'

type Phase =
  | { t: 'loading' }
  | { t: 'error'; message: string }
  | { t: 'ready'; entry: GameEntry; parsed: ParsedArchive; replay: ReplayLine }

/** In-memory exploration line forked off mainline ply `base`:
 *  states[0] === mainline states[base]; moves/notated align 1:1. */
interface Branch {
  base: number
  moves: string[]
  notated: string[]
  states: unknown[]
}

// Autoplay speeds: label × → ms per ply.
const SPEEDS = [
  { label: '½×', ms: 2400 },
  { label: '1×', ms: 1200 },
  { label: '2×', ms: 600 },
  { label: '3×', ms: 400 }
] as const

// Lazy board components cached per kind (KernelOtb discipline) so stepping in
// and out of the viewer never re-suspends a loaded board.
const BOARD_CACHE = new Map<string, ComponentType<GameBoardProps>>()
function lazyBoard(kind: string, entry: GameEntry): ComponentType<GameBoardProps> {
  const cached = BOARD_CACHE.get(kind)
  if (cached) return cached
  const Board = lazy(entry.loadRenderer) as unknown as ComponentType<GameBoardProps>
  BOARD_CACHE.set(kind, Board)
  return Board
}

/** Stable placeholder spec while the archive resolves (hooks stay unconditional). */
const NO_EVAL_SPEC = { kind: 'tictactoe', family: 'grid' } as unknown as GameSpec<unknown>

function resultTone(result?: string | null): 'white' | 'black' | 'draw' | 'open' {
  if (result === '1-0') return 'white'
  if (result === '0-1') return 'black'
  if (result === '1/2-1/2') return 'draw'
  return 'open'
}

export function GameReplayView({
  row,
  onBack
}: {
  row: GameRow
  onBack: () => void
}): JSX.Element {
  const { settings } = useSettings()
  const [phase, setPhase] = useState<Phase>({ t: 'loading' })
  const [ply, setPly] = useState(0)
  const [branch, setBranch] = useState<Branch | null>(null)
  const [branchPly, setBranchPly] = useState(0)
  const [orientation, setOrientation] = useState<PlayerColor>('white')
  const [playing, setPlaying] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(1)
  const [evalOn, setEvalOn] = useState(true)
  const [theaterOpen, setTheaterOpen] = useState(false)

  // ---- Resolve the archive into a registry entry + replayed states ----------
  useEffect(() => {
    let cancelled = false
    setPhase({ t: 'loading' })
    setPly(0)
    setBranch(null)
    setPlaying(false)
    void (async () => {
      try {
        const parsed = parseReplayArchive(row.pgn, row.game_kind)
        if (!parsed) throw new Error('This game was saved in a format this build cannot replay.')
        let entry: GameEntry | undefined
        if (isRegisteredGame(parsed.kind)) {
          entry = getGame(parsed.kind as GameKind)
        } else if (parsed.kind.startsWith('custom-')) {
          // Variant Lab game: load the saved definition and register its
          // dynamic entry with the Lab's real board (same path PlayCustom takes).
          const id = parsed.kind.slice('custom-'.length)
          const res = await window.api?.customVariants.get(id)
          if (!res?.variant) {
            throw new Error('This game used a custom variant that has since been deleted.')
          }
          entry = await registerCustomVariant(res.variant, () => import('../games/editor/CustomBoard'))
        }
        if (!entry) throw new Error(`Unknown game kind “${parsed.kind}”.`)
        if (entry.requiresPreload) await entry.spec.preload?.()
        const replay = buildReplay(entry.spec as GameSpec<unknown>, parsed)
        if (cancelled) return
        setPhase({ t: 'ready', entry, parsed, replay })
      } catch (err) {
        if (cancelled) return
        setPhase({ t: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [row.id, row.pgn, row.game_kind])

  const ready = phase.t === 'ready' ? phase : null
  const spec = ready ? (ready.entry.spec as GameSpec<unknown>) : null
  const kind = ready ? ready.parsed.kind : row.game_kind

  const onMainline = branch === null
  const currentState: unknown =
    ready === null ? null : onMainline ? ready.replay.states[ply] : branch!.states[branchPly]
  const currentPlies = onMainline ? ply : branch!.base + branchPly

  useBoardSound(kind as GameKind, currentState)

  const evalState = useReplayEval(
    spec ?? NO_EVAL_SPEC,
    spec ? currentState : null,
    currentPlies,
    evalOn && ready !== null
  )

  // Territory shading overlay (go only, KataGo-gated; the toggle renders only
  // when the engine is installed; the eval strip above carries the score).
  const [territoryOn, setTerritoryOn] = useState(false)
  const territory = useTerritoryEstimate(
    kind === 'go' && ready !== null ? (currentState as GoState | null) : null,
    kind === 'go' && ready !== null && territoryOn
  )

  // ---- Navigation (branch-aware) --------------------------------------------
  const goMainline = useCallback((p: number) => {
    setBranch(null)
    setBranchPly(0)
    setPly(p)
  }, [])

  const stepPrev = useCallback(() => {
    setPlaying(false)
    if (branch) {
      if (branchPly > 1) setBranchPly(branchPly - 1)
      else goMainline(branch.base)
      return
    }
    setPly((p) => Math.max(0, p - 1))
  }, [branch, branchPly, goMainline])

  const stepNext = useCallback(() => {
    if (!ready) return
    if (branch) {
      setBranchPly((p) => Math.min(branch.moves.length, p + 1))
      return
    }
    setPly((p) => Math.min(ready.replay.moves.length, p + 1))
  }, [ready, branch])

  const goFirst = useCallback(() => {
    setPlaying(false)
    goMainline(0)
  }, [goMainline])

  const goLast = useCallback(() => {
    if (!ready) return
    setPlaying(false)
    goMainline(ready.replay.moves.length)
  }, [ready, goMainline])

  // ---- Autoplay --------------------------------------------------------------
  useEffect(() => {
    if (!playing || !ready || branch) return
    if (ply >= ready.replay.moves.length) {
      setPlaying(false)
      return
    }
    const timer = window.setTimeout(() => setPly((p) => p + 1), SPEEDS[speedIdx].ms)
    return () => window.clearTimeout(timer)
  }, [playing, ready, branch, ply, speedIdx])

  // ---- Keyboard (lichess-style, matching AnalysisView) ------------------------
  useEffect(() => {
    if (theaterOpen) return // the theater overlay owns the keyboard
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t && t.isContentEditable)
      )
        return
      if (e.key === 'ArrowLeft') stepPrev()
      else if (e.key === 'ArrowRight') {
        setPlaying(false)
        stepNext()
      } else if (e.key === 'ArrowUp') goFirst()
      else if (e.key === 'ArrowDown') goLast()
      else if (e.key === 'f') setOrientation((o) => (o === 'white' ? 'black' : 'white'))
      else if (e.key === ' ') setPlaying((p) => !p)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepPrev, stepNext, goFirst, goLast, theaterOpen])

  // ---- Exploratory moves → variation branch ----------------------------------
  const onMove = useCallback(
    (move: string) => {
      if (!ready || !spec || currentState === null || playing) return
      const s = currentState
      // Re-walking the recorded line: just advance the cursor.
      if (onMainline && ply < ready.replay.moves.length && move === ready.replay.moves[ply]) {
        setPly(ply + 1)
        return
      }
      if (branch && branchPly < branch.moves.length && move === branch.moves[branchPly]) {
        setBranchPly(branchPly + 1)
        return
      }
      const next = spec.play(s, move)
      if (next === null) return // board proposed something the rules reject
      const notated = notationFor(spec, s, move)
      if (onMainline) {
        setBranch({ base: ply, moves: [move], notated: [notated], states: [s, next] })
        setBranchPly(1)
      } else {
        // Extend (or fork within) the live branch at the cursor.
        const keep = branchPly
        setBranch({
          base: branch!.base,
          moves: [...branch!.moves.slice(0, keep), move],
          notated: [...branch!.notated.slice(0, keep), notated],
          states: [...branch!.states.slice(0, keep + 1), next]
        })
        setBranchPly(keep + 1)
      }
    },
    [ready, spec, currentState, playing, onMainline, ply, branch, branchPly]
  )

  // ---- Derived display bits ----------------------------------------------------
  const title = spec?.title ?? kind
  const whiteName = ready?.parsed.white ?? row.white_name ?? undefined
  const blackName = ready?.parsed.black ?? row.black_name ?? undefined
  const result = ready?.parsed.result ?? row.result ?? '*'
  const turn = spec && currentState !== null ? turnAt(spec, currentState, currentPlies) : 'white'

  const moveRows = useMemo(() => {
    if (!ready) return []
    const out: { num: number; a: number; b: number | null }[] = []
    for (let i = 0; i < ready.replay.moves.length; i += 2) {
      out.push({ num: i / 2 + 1, a: i, b: i + 1 < ready.replay.moves.length ? i + 1 : null })
    }
    return out
  }, [ready])

  const Board = ready ? lazyBoard(kind, ready.entry) : null
  const isChessFamily = spec?.family === 'chess'

  if (phase.t === 'loading') {
    return (
      <div className="view-loading" role="status" aria-live="polite">
        <span className="view-spinner" aria-hidden />
        <span className="visually-hidden">Loading game…</span>
      </div>
    )
  }

  if (phase.t === 'error') {
    return (
      <div className="replay-error">
        <button type="button" className="game-back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden /> Library
        </button>
        <div className="replay-error-card" role="alert">
          <AlertTriangle size={18} aria-hidden />
          <p>{phase.message}</p>
        </div>
      </div>
    )
  }

  const replay = ready!.replay
  const atEnd = onMainline && ply >= replay.moves.length
  const sideLabel = (c: PlayerColor): string => kernelColorLabel(kind, c)
  const boardCls = isChessFamily
    ? `votb-cfb board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`
    : 'replay-board-host'

  const moveButton = (i: number): JSX.Element => (
    <button
      type="button"
      className={`replay-move num${onMainline && ply === i + 1 ? ' is-current' : ''}`}
      onClick={() => {
        setPlaying(false)
        goMainline(i + 1)
      }}
    >
      {replay.notated[i]}
    </button>
  )

  // The branch renders indented under the row holding the move it replaces
  // (fork from the final position anchors to the last row; −1 = no rows at
  // all, rendered standalone after the empty list).
  const branchRowIdx =
    branch === null || moveRows.length === 0
      ? -1
      : Math.min(Math.floor(branch.base / 2), moveRows.length - 1)
  const branchBlock =
    branch === null ? null : (
      <div className="replay-branch" aria-label="Exploration line">
        <span className="replay-branch-marker" aria-hidden>
          ↳
        </span>
        {branch.moves.map((_, j) => (
          <button
            key={j}
            type="button"
            className={`replay-move is-branch num${branchPly === j + 1 ? ' is-current' : ''}`}
            onClick={() => setBranchPly(j + 1)}
          >
            {branch.notated[j]}
          </button>
        ))}
      </div>
    )

  return (
    <div className="replay-view">
      <header className="game-playbar">
        <button type="button" className="game-back" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden /> Library
        </button>
        <h2 className="game-playbar-title">{title}</h2>
        <span className="game-playbar-mode">Replay</span>
      </header>

      <div className="votb replay-votb">
        <div className="votb-stage">
          <div className="replay-stage-row">
            {evalState.family === 'chess' && (
              <EvalBar score={evalState.score} orientation={orientation} />
            )}
            <div className={boardCls}>
              {evalState.family === 'go' && (
                <div className="replay-go-eval" aria-label="KataGo estimate">
                  {evalState.whiteWin === null ? (
                    <span className="replay-go-pending">estimating…</span>
                  ) : (
                    <>
                      <span
                        className="replay-go-fill"
                        style={{ width: `${Math.round((1 - evalState.whiteWin) * 100)}%` }}
                        aria-hidden
                      />
                      <span className="replay-go-label num">
                        B {Math.round((1 - evalState.whiteWin) * 100)}% ·{' '}
                        {evalState.whiteLead >= 0
                          ? `W+${evalState.whiteLead.toFixed(1)}`
                          : `B+${(-evalState.whiteLead).toFixed(1)}`}
                      </span>
                    </>
                  )}
                </div>
              )}
              <Suspense fallback={<div className="kotb-loading">Setting up the board…</div>}>
                {Board && currentState !== null && (
                  <Board
                    kind={kind as GameKind}
                    state={currentState}
                    orientation={orientation}
                    interactive={!playing}
                    onMove={onMove}
                    territory={territoryOn && kind === 'go' ? territory.estimate?.ownership : undefined}
                  />
                )}
              </Suspense>
            </div>
          </div>

          <div className="boardbar replay-controls">
            <button
              className="icon-btn"
              onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
              title="Flip board (f)"
            >
              <FlipVertical2 size={18} />
            </button>
            <div className="replay-nav">
              <button className="icon-btn" onClick={goFirst} disabled={onMainline && ply === 0} title="First">
                <ChevronsLeft size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={stepPrev}
                disabled={onMainline && ply === 0}
                title="Previous (←)"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={() => {
                  setPlaying(false)
                  stepNext()
                }}
                disabled={branch ? branchPly >= branch.moves.length : atEnd}
                title="Next (→)"
              >
                <ChevronRight size={18} />
              </button>
              <button className="icon-btn" onClick={goLast} disabled={atEnd} title="Last">
                <ChevronsRight size={18} />
              </button>
            </div>
            <button
              className={`icon-btn${playing ? ' active' : ''}`}
              onClick={() => {
                if (branch) goMainline(branch.base)
                setPlaying((p) => !p)
              }}
              disabled={replay.moves.length === 0}
              title={playing ? 'Pause (space)' : 'Autoplay (space)'}
            >
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="replay-speeds" role="radiogroup" aria-label="Autoplay speed">
              {SPEEDS.map((s, i) => (
                <button
                  key={s.label}
                  type="button"
                  role="radio"
                  aria-checked={speedIdx === i}
                  className={`replay-speed num${speedIdx === i ? ' is-active' : ''}`}
                  onClick={() => setSpeedIdx(i)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {spec !== null && (spec.family === 'chess' || spec.kind === 'go') && (
              <button
                className={`icon-btn${evalOn ? ' active' : ''}`}
                onClick={() => setEvalOn((v) => !v)}
                title="Toggle eval"
              >
                <Cpu size={18} />
              </button>
            )}
            {kind === 'go' && territory.available && (
              <button
                className={`icon-btn${territoryOn ? ' active' : ''}`}
                onClick={() => setTerritoryOn((v) => !v)}
                title="Territory shading (KataGo)"
              >
                <Layers size={18} />
              </button>
            )}
            <button
              className="icon-btn"
              onClick={() => {
                setPlaying(false)
                setTheaterOpen(true)
              }}
              disabled={replay.moves.length === 0}
              title="Watch in Replay Theater"
            >
              <Clapperboard size={18} />
            </button>
          </div>
        </div>

        <aside className="votb-side replay-side">
          <div className="replay-header-card">
            <div className="replay-players">
              <span className="replay-player">
                <span className="votb-turn-dot is-white" aria-hidden /> {whiteName ?? sideLabel('white')}
              </span>
              <span className={`replay-result num is-${resultTone(result)}`}>{result}</span>
              <span className="replay-player">
                <span className="votb-turn-dot is-black" aria-hidden /> {blackName ?? sideLabel('black')}
              </span>
            </div>
            <div className="replay-meta muted small">
              {ready!.parsed.event && <span>{ready!.parsed.event}</span>}
              {ready!.parsed.date && <span className="num">{ready!.parsed.date}</span>}
              {ready!.parsed.reason && <span>{ready!.parsed.reason.replace(/-/g, ' ')}</span>}
            </div>
            {replay.truncated && (
              <p className="replay-truncated" role="alert">
                <AlertTriangle size={13} aria-hidden /> This archive could not be fully replayed. Showing the legal
                prefix.
              </p>
            )}
          </div>

          <div className="votb-turn replay-turn">
            <span className={`votb-turn-dot is-${turn}`} aria-hidden />
            {branch
              ? 'Exploring your line'
              : atEnd && result !== '*'
                ? 'Final position'
                : `${sideLabel(turn)} to move`}
            <span className="votb-movecount num">
              {onMainline ? ply : `${branch!.base}+${branchPly}`}/{replay.moves.length}
            </span>
          </div>

          {branch && (
            <button type="button" className="votb-btn is-primary replay-back-btn" onClick={() => goMainline(branch.base)}>
              <Undo2 size={14} aria-hidden /> Back to game
            </button>
          )}

          <div className="panel replay-moves-panel">
            <div className="panel-head">
              <h2 className="lbl">Moves</h2>
            </div>
            <div className="replay-moves" role="list">
              {replay.moves.length === 0 && !branch && (
                <p className="replay-empty muted small">No moves were recorded for this game.</p>
              )}
              {moveRows.map((r2, rowIdx) => (
                <div key={r2.num}>
                  <div className="replay-move-row" role="listitem">
                    <span className="replay-move-num num">{r2.num}.</span>
                    {moveButton(r2.a)}
                    {r2.b !== null ? moveButton(r2.b) : <span className="replay-move-fill" />}
                  </div>
                  {branch && rowIdx === branchRowIdx && branchBlock}
                </div>
              ))}
              {branch && branchRowIdx === -1 && branchBlock}
            </div>
          </div>

          <p className="votb-note replay-hint">
            Step with ←/→, space autoplays. Play a move on the board to explore a variation. It never
            touches the saved game.
          </p>
        </aside>
      </div>

      {theaterOpen && (
        <ReplayTheater
          data={{
            kind,
            entry: ready!.entry,
            replay,
            result,
            reason: ready!.parsed.reason,
            white: whiteName,
            black: blackName,
            event: ready!.parsed.event
          }}
          onExit={() => setTheaterOpen(false)}
        />
      )}
    </div>
  )
}
