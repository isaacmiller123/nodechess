import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import { Bot, Clapperboard, RotateCcw, Swords } from 'lucide-react'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import { resolveBotProvider, BotUnavailableError, BOT_LEVEL_NAMES } from '../../games/bots'
import type { GameKind } from '../../games/kernel'
import { getGame } from '../../games/registry'
import { replayOptionsOf } from '../../games/archive'
import { useBoardSound } from '../../games/boards/useBoardSound'
import { ReplayTheater, buildTheaterInput, type TheaterInput } from '../library/ReplayTheater'
import type { CatalogEntry } from './catalog'
import { Board3DHost, BoardModeToggle, useBoardMode } from './boardMode'
import { useSaveFinishedGame } from './useSaveFinishedGame'

type Phase = 'setup' | 'playing'

/**
 * vs Bot for the WHOLE chess family: 5-level Fairy-Stockfish opponents over
 * the game kernel (games/bots.ts provider seam), board via the registry
 * entry's lazy renderer (games/boards/ChessFamilyBoard.tsx: pockets,
 * promotion dialogs, intersection boards, canonical move strings). ffish
 * kinds preload their WASM rules behind the setup screen. Standard chess
 * stays on the richer PlayView path and never routes here.
 */
export function VariantBot({
  entry,
  onToast
}: {
  entry: CatalogEntry
  onToast: (msg: string) => void
}): JSX.Element {
  const { settings } = useSettings()
  const kind = entry.kind as GameKind
  // The registry entry is static for the chess wave; resolve once per mount.
  const game = useMemo(() => getGame(kind)!, [kind])
  const spec = game.spec
  const provider = useMemo(() => resolveBotProvider(kind), [kind])
  const BoardView = useMemo(() => lazy(game.loadRenderer), [game])

  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState(3)
  const [userColor, setUserColor] = useState<'white' | 'black'>('white')
  const [ready, setReady] = useState(!game.requiresPreload)
  const [state, setState] = useState<unknown>(() => (game.requiresPreload ? null : spec.init()))
  const [thinking, setThinking] = useState(false)
  const { is3d } = useBoardMode(kind)
  // Monotonic game id: a stale engine reply from a finished/restarted game is dropped.
  const gameSeq = useRef(0)

  // ffish WASM preload: runs behind the setup card; Start waits on it.
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
      .catch(() => {
        if (!cancelled) onToast('The rules engine failed to load. Try reopening this game.')
      })
    return () => {
      cancelled = true
    }
  }, [ready, spec, onToast])

  useBoardSound(kind, state)

  const moves = ((state ?? {}) as { moves?: readonly string[] }).moves ?? []
  const fen = ((state ?? {}) as { fen?: string }).fen
  const fenTurn = fen?.split(' ')[1]
  const turn: 'white' | 'black' =
    fenTurn === 'b' ? 'black' : fenTurn === 'w' ? 'white' : moves.length % 2 === 0 ? 'white' : 'black'
  const outcome = ready && state !== null ? spec.result(state) : null
  const isUserTurn = phase === 'playing' && !outcome && turn === userColor

  // Archive every finished bot game (feature foundation: reviewable later).
  const botLabel = `Bot L${level}`
  useSaveFinishedGame(spec, state, outcome, {
    white: userColor === 'white' ? 'You' : botLabel,
    black: userColor === 'black' ? 'You' : botLabel,
    event: 'Play vs Bot',
    source: 'play-bot',
    userColor,
    opponentKind: 'engine',
    opponentLabel: `${botLabel} · ${BOT_LEVEL_NAMES[level - 1]}`
  })

  const applyMove = useCallback(
    (move: string): void => {
      setState((s: unknown) => (s === null ? s : (spec.play(s, move) ?? s)))
    },
    [spec]
  )

  // Bot turn: ask the provider once per position; drop stale replies.
  useEffect(() => {
    if (phase !== 'playing' || outcome || turn === userColor || state === null) return
    const seq = gameSeq.current
    let cancelled = false
    setThinking(true)
    provider
      .move(state, level)
      .then((mv) => {
        if (cancelled || seq !== gameSeq.current) return
        setThinking(false)
        // Validate against the exact state the provider was asked about (the
        // cancelled/seq guards above drop stale replies). NEVER smuggle a
        // success flag out of a setState updater: React runs updaters during
        // render, and its eager fast path is skipped when another update
        // (setThinking above) is already pending, so a flag read back
        // synchronously is ALWAYS false and the toast fired on every legal
        // bot reply (live packaged-app audit, 2026-07-07).
        const next = spec.play(state, mv)
        if (next) setState(next)
        else onToast(`The engine offered an illegal move (${mv}). Try restarting.`)
      })
      .catch((err) => {
        if (cancelled || seq !== gameSeq.current) return
        setThinking(false)
        onToast(
          err instanceof BotUnavailableError
            ? err.message
            : 'The engine failed to move. Is the engines dataset installed?'
        )
        setPhase('setup')
      })
    return () => {
      cancelled = true
    }
  }, [phase, state, turn, userColor, outcome, provider, level, spec, onToast])

  // The board proposes canonical kernel moves (promotion dialogs and pocket
  // drops included). Validate through spec.play and ignore rejects.
  const onUserMove = useCallback(
    (move: string) => {
      if (isUserTurn) applyMove(move)
    },
    [isUserTurn, applyMove]
  )

  const start = useCallback(() => {
    if (!ready) return
    gameSeq.current++
    setState(spec.init())
    setThinking(false)
    setPhase('playing')
  }, [ready, spec])

  const backToSetup = useCallback(() => {
    gameSeq.current++
    setThinking(false)
    setPhase('setup')
  }, [])

  const resultLabel =
    outcome &&
    (outcome.score === '1/2-1/2'
      ? `Draw: ${outcome.reason.replace(/-/g, ' ')}`
      : `${outcome.winner === userColor ? 'You win' : 'Bot wins'}: ${outcome.reason.replace(/-/g, ' ')}`)

  // Post-game Replay Theater (cinematic 3D/2D re-run of the finished game).
  const [theater, setTheater] = useState<TheaterInput | null>(null)
  const openTheater = useCallback(() => {
    if (state === null || !outcome) return
    setTheater(
      buildTheaterInput({
        entry: game,
        moves,
        options: replayOptionsOf(spec, state),
        result: outcome.score,
        reason: outcome.reason,
        white: userColor === 'white' ? 'You' : botLabel,
        black: userColor === 'black' ? 'You' : botLabel,
        event: 'Play vs Bot'
      })
    )
  }, [state, outcome, game, spec, moves, userColor, botLabel])

  if (phase === 'setup') {
    return (
      <div className="vbot-setup">
        <div className="vbot-setup-card">
          <div className="vbot-setup-head">
            <span className="mode-icon">
              <Bot size={22} aria-hidden />
            </span>
            <div>
              <h3>Play {entry.title} vs Bot</h3>
              <p>Five engine strengths, powered by Fairy-Stockfish.</p>
            </div>
          </div>

          <div className="vbot-levels" role="radiogroup" aria-label="Bot strength">
            {BOT_LEVEL_NAMES.map((name, i) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={level === i + 1}
                className={`vbot-level${level === i + 1 ? ' is-active' : ''}`}
                onClick={() => setLevel(i + 1)}
              >
                <span className="vbot-level-num">{i + 1}</span>
                <span className="vbot-level-name">{name}</span>
              </button>
            ))}
          </div>
          <p className="vbot-level-hint">{provider.describe(level)}</p>

          <div className="vbot-colors" role="radiogroup" aria-label="Play as">
            {(['white', 'black'] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={userColor === c}
                className={`vbot-color${userColor === c ? ' is-active' : ''}`}
                onClick={() => setUserColor(c)}
              >
                <span className={`votb-turn-dot is-${c}`} aria-hidden />
                {c === 'white' ? 'Play White' : 'Play Black'}
              </button>
            ))}
          </div>

          <button type="button" className="votb-btn is-primary vbot-start" onClick={start} disabled={!ready}>
            <Swords size={15} aria-hidden /> {ready ? 'Start game' : 'Loading rules…'}
          </button>
        </div>
      </div>
    )
  }

  const shimmer = (
    <div
      className="cfb-loading"
      style={{ '--cfb-files': spec.board.files, '--cfb-ranks': spec.board.ranks } as CSSProperties}
    >
      <span className="cfb-loading-label">Setting up the {spec.title} board…</span>
    </div>
  )

  return (
    <div className="votb">
      <div className="votb-stage">
        <div className={`votb-cfb board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}>
          {state === null ? (
            shimmer
          ) : is3d ? (
            <Board3DHost
              kind={kind}
              state={state}
              orientation={userColor}
              interactive={isUserTurn}
              onMove={onUserMove}
            />
          ) : (
            <Suspense fallback={shimmer}>
              <BoardView
                kind={kind}
                state={state}
                orientation={userColor}
                interactive={isUserTurn}
                onMove={onUserMove}
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
            <button type="button" className="votb-btn is-primary" onClick={start}>
              <RotateCcw size={14} aria-hidden /> Rematch
            </button>
          </div>
        )}
        {theater && <ReplayTheater data={theater} onExit={() => setTheater(null)} />}
      </div>
      <aside className="votb-side">
        <div className="votb-turn">
          <span className={`votb-turn-dot is-${turn}`} aria-hidden />
          {outcome ? 'Game over' : turn === userColor ? 'Your move' : 'Bot to move'}
          <span className="votb-movecount">{moves.length} moves</span>
        </div>
        <div className={`vbot-opponent${thinking ? ' is-thinking' : ''}`}>
          <Bot size={16} aria-hidden />
          <span>
            Level {level} · {BOT_LEVEL_NAMES[level - 1]}
          </span>
          {thinking && (
            <span className="vbot-dots" aria-label="Bot is thinking">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        <BoardModeToggle kind={kind} />
        <button type="button" className="votb-btn" onClick={start}>
          <RotateCcw size={14} aria-hidden /> {kind === 'chess960' ? 'New position' : 'Restart game'}
        </button>
        <button type="button" className="votb-btn" onClick={backToSetup}>
          Change level
        </button>
        <p className="votb-note">
          {entry.title} vs Fairy-Stockfish: {provider.describe(level)}.
        </p>
      </aside>
    </div>
  )
}
