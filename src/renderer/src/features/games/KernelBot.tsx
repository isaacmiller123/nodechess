// vs Bot for every NON-chess kernel game (go, gomoku, othello, connect4, hex,
// morris, tictactoe, checkers both). The sibling of VariantBot (chess family)
// built on the same seams: rules through the registry GameSpec, moves through
// the games/bots.ts provider (KataGo GTP ipc for go, in-process searches for
// the rest), board via the registry's lazy renderer. KernelOtb's extras carry
// over: per-idiom color names, pass/swap buttons, go board sizes and go's
// scoring phase (the bot defers to the human on dead-stone marking, mark, then
// finalize on the board).
//
// Go's engine dependency is surfaced INLINE (spec task: not a dead toast): when
// KataGo isn't installed the setup card swaps Start for an install prompt that
// deep-links to Settings → Datasets.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type JSX
} from 'react'
import { Bot, Clapperboard, Download, RotateCcw, Swords } from 'lucide-react'
import { isWebBuild } from '../../platform'
import { resolveBotProvider, BotUnavailableError, BOT_LEVEL_NAMES } from '../../games/bots'
import type { GameKind, PlayerColor } from '../../games/kernel'
import { getGame, type GameBoardProps } from '../../games/registry'
import type { GoHandicap, GoSpec, GoState } from '../../games/go'
import { replayOptionsOf } from '../../games/archive'
import { useBoardSound } from '../../games/boards/useBoardSound'
import { BYOYOMI_PRESETS, byoyomiPresetById } from '../play/byoyomi'
import { ReplayTheater, buildTheaterInput, type TheaterInput } from '../library/ReplayTheater'
import type { CatalogEntry } from './catalog'
import { kernelColorLabel } from './KernelOtb'
import { Board3DHost, BoardModeToggle, useBoardMode } from './boardMode'
import { GO_MAIN_PRESETS, GoClockPair, useLocalGoClock, type GoClockConfig } from './goClock'
import { TerritoryControl, useTerritoryEstimate } from './territory'
import { useSaveFinishedGame } from './useSaveFinishedGame'

type Phase = 'setup' | 'playing'

const GO_SIZES = [9, 13, 19] as const
/** 'Off' + the standard 2–9 hoshi handicaps (games/go.ts placement tables). */
const GO_HANDICAPS: readonly GoHandicap[] = [0, 2, 3, 4, 5, 6, 7, 8, 9]

// Lazy board components cached per kind (same discipline as KernelOtb).
const BOARD_CACHE = new Map<string, ComponentType<GameBoardProps>>()
function lazyBoard(kind: GameKind, loader: () => Promise<{ default: ComponentType<GameBoardProps> }>) {
  const cached = BOARD_CACHE.get(kind)
  if (cached) return cached
  const Board = lazy(loader)
  BOARD_CACHE.set(kind, Board as unknown as ComponentType<GameBoardProps>)
  return BOARD_CACHE.get(kind)!
}

export function KernelBot({
  entry,
  kind,
  onToast,
  onOpenSettings
}: {
  entry: CatalogEntry
  /** Registry kind (GamePage resolves catalog aliases like checkers-8). */
  kind: GameKind
  onToast: (msg: string) => void
  /** Deep link to Settings → Datasets (the go install prompt). */
  onOpenSettings?: () => void
}): JSX.Element {
  const game = useMemo(() => getGame(kind)!, [kind])
  const spec = game.spec
  const provider = useMemo(() => resolveBotProvider(kind), [kind])
  const Board = lazyBoard(kind, game.loadRenderer)
  const isGo = kind === 'go'

  const [phase, setPhase] = useState<Phase>('setup')
  const [level, setLevel] = useState(3)
  const [userColor, setUserColor] = useState<PlayerColor>(spec.players[0])
  const [goSize, setGoSize] = useState<9 | 13 | 19>(9)
  const [goHandicap, setGoHandicap] = useState<GoHandicap>(0)
  // Go clocks (QoL): main + byo-yomi presets, both 'off' by default (untimed).
  const [goMainId, setGoMainId] = useState('off')
  const [goByoId, setGoByoId] = useState('off')
  const [state, setState] = useState<unknown>(null)
  const [thinking, setThinking] = useState(false)
  // A side lost on time (local go clocks). Terminal beside spec outcome.
  const [timeLoss, setTimeLoss] = useState<PlayerColor | null>(null)
  const [clockEpoch, setClockEpoch] = useState(0)
  const [territoryOn, setTerritoryOn] = useState(false)
  const { is3d } = useBoardMode(kind)
  // Go engine availability: null = probing, then katagoReady. Non-go kinds are
  // always available (in-process bots).
  const [engineReady, setEngineReady] = useState<boolean | null>(isGo ? null : true)
  // Monotonic game id: a stale engine reply from a finished/restarted game is dropped.
  const gameSeq = useRef(0)

  // Probe KataGo availability behind the setup card (go only). Re-probed on
  // every setup return so finishing a Settings download is picked up.
  useEffect(() => {
    if (!isGo || phase !== 'setup') return
    let cancelled = false
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api) {
      setEngineReady(false)
      return
    }
    api.engine
      .status()
      .then((s) => {
        if (!cancelled) setEngineReady(s.katagoReady)
      })
      .catch(() => {
        if (!cancelled) setEngineReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [isGo, phase])

  useBoardSound(kind, state)

  const initOptions = isGo
    ? { size: goSize, ...(goHandicap >= 2 ? { handicap: goHandicap } : {}) }
    : undefined
  const moves = ((state ?? {}) as { moves?: readonly string[] }).moves ?? []
  const outcome = state !== null ? spec.result(state) : null
  const legal = useMemo(
    () => (state !== null && !outcome ? spec.legalMoves(state) : []),
    [spec, state, outcome]
  )
  // spec.turn (when present) outranks parity: go's handicap makes WHITE open.
  const turn: PlayerColor =
    state !== null && spec.turn ? spec.turn(state) : spec.players[moves.length % 2]
  const goScoring =
    isGo && state !== null && !outcome && (spec as unknown as GoSpec).isScoringPhase(state as GoState)
  // The bot only ever answers board moves; in go's scoring phase (no legal
  // moves, result pending) the HUMAN resolves dead stones for both sides.
  const isUserTurn =
    phase === 'playing' && !outcome && !goScoring && timeLoss === null && turn === userColor

  // Local go clocks (both sides tick; the bot burns real think time too).
  const goClockCfg = useMemo<GoClockConfig | null>(() => {
    if (!isGo) return null
    const mainMs = GO_MAIN_PRESETS.find((p) => p.id === goMainId)?.ms ?? 0
    const byo = byoyomiPresetById(goByoId).byo
    return mainMs > 0 || byo ? { mainMs, byo } : null
  }, [isGo, goMainId, goByoId])
  const clockRunning =
    phase === 'playing' &&
    state !== null &&
    !outcome &&
    !goScoring &&
    timeLoss === null &&
    moves.length > 0
  const goClock = useLocalGoClock(goClockCfg, turn, clockRunning, clockEpoch, setTimeLoss)

  // Territory estimate overlay + strip (hidden entirely without KataGo).
  const territory = useTerritoryEstimate(
    isGo && phase === 'playing' ? (state as GoState | null) : null,
    isGo && phase === 'playing' && territoryOn && !goScoring && !outcome && timeLoss === null
  )

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
    if (phase !== 'playing' || outcome || goScoring || timeLoss !== null) return
    if (turn === userColor || state === null) return
    if (legal.length === 0) return
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
        else onToast(`The bot offered an illegal move (${mv}). Try restarting.`)
      })
      .catch((err) => {
        if (cancelled || seq !== gameSeq.current) return
        setThinking(false)
        setPhase('setup')
        if (err instanceof BotUnavailableError) {
          // Back on the setup card the availability probe re-runs and renders
          // the inline install prompt: the toast is just the immediate why.
          if (isGo) setEngineReady(false)
          onToast(err.message)
        } else {
          onToast('The bot failed to move. Try restarting the game.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [phase, state, turn, userColor, outcome, goScoring, timeLoss, legal, provider, level, spec, onToast, isGo])

  const onUserMove = useCallback(
    (move: string) => {
      if (isUserTurn) applyMove(move)
    },
    [isUserTurn, applyMove]
  )

  // Go scoring actions (markdead/finalize). Proposed by the board, resolved
  // through the GoSpec seam exactly like KernelOtb.
  const onAction = useCallback(
    (action: string) => {
      if (!isGo) return
      const gs = spec as unknown as GoSpec
      setState((s: unknown) => {
        if (s === null) return s
        if (action === 'finalize') return gs.finalizeScore(s as GoState) ?? s
        if (action.startsWith('markdead ')) {
          return gs.markDead(s as GoState, action.slice('markdead '.length)) ?? s
        }
        return s
      })
    },
    [isGo, spec]
  )

  const start = useCallback(() => {
    gameSeq.current++
    setState(spec.init(initOptions))
    setThinking(false)
    setTimeLoss(null)
    setClockEpoch((e) => e + 1)
    setPhase('playing')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, goSize, goHandicap])

  const backToSetup = useCallback(() => {
    gameSeq.current++
    setThinking(false)
    setPhase('setup')
  }, [])

  const canPass = isUserTurn && legal.includes('pass')
  const canSwap = isUserTurn && legal.includes('swap')

  const resultLabel = timeLoss
    ? `${timeLoss === userColor ? 'Bot wins' : 'You win'} on time`
    : outcome &&
      (outcome.winner === null
        ? `Draw: ${outcome.reason.replace(/-/g, ' ')}`
        : `${outcome.winner === userColor ? 'You win' : 'Bot wins'}: ${outcome.reason.replace(/-/g, ' ')}`)

  const over = outcome !== null || timeLoss !== null

  // Post-game Replay Theater (cinematic 3D/2D re-run of the finished game).
  const [theater, setTheater] = useState<TheaterInput | null>(null)
  const openTheater = useCallback(() => {
    if (state === null) return
    setTheater(
      buildTheaterInput({
        entry: game,
        moves,
        options: replayOptionsOf(spec, state),
        result:
          outcome?.score ??
          (timeLoss ? (timeLoss === 'white' ? '0-1' : '1-0') : '*'),
        reason: outcome?.reason ?? (timeLoss ? 'time' : undefined),
        white: userColor === 'white' ? 'You' : botLabel,
        black: userColor === 'black' ? 'You' : botLabel,
        event: 'Play vs Bot'
      })
    )
  }, [state, game, spec, moves, outcome, timeLoss, userColor, botLabel])

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
              <p>
                {isGo
                  ? 'Five strengths, powered by KataGo.'
                  : 'Five strengths, engine-free and instant.'}
              </p>
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

          {isGo && (
            <div className="vbot-colors is-three" role="radiogroup" aria-label="Board size">
              {GO_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  role="radio"
                  aria-checked={goSize === sz}
                  className={`vbot-color${goSize === sz ? ' is-active' : ''}`}
                  onClick={() => setGoSize(sz)}
                >
                  {sz}×{sz}
                </button>
              ))}
            </div>
          )}

          {isGo && (
            <>
              <div className="kotb-opt-row" role="group" aria-label="Handicap stones">
                <span className="kotb-opt-name">Handicap</span>
                {GO_HANDICAPS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className={`kotb-chip is-mini${goHandicap === h ? ' is-active' : ''}`}
                    aria-pressed={goHandicap === h}
                    title={
                      h === 0
                        ? 'Even game'
                        : `Black pre-places ${h} hoshi stones; White moves first; komi 0.5`
                    }
                    onClick={() => setGoHandicap(h)}
                  >
                    {h === 0 ? 'Off' : h}
                  </button>
                ))}
              </div>
              <div className="kotb-opt-row" role="group" aria-label="Main time">
                <span className="kotb-opt-name">Main time</span>
                {GO_MAIN_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`kotb-chip is-mini${goMainId === p.id ? ' is-active' : ''}`}
                    aria-pressed={goMainId === p.id}
                    onClick={() => setGoMainId(p.id)}
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
                    aria-pressed={goByoId === p.id}
                    title={
                      p.byo
                        ? `${p.byo.periods} overtime periods of ${p.byo.periodMs / 1000}s. A move inside a period resets it.`
                        : 'No overtime, main time only'
                    }
                    onClick={() => setGoByoId(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {goHandicap >= 2 && (
                <p className="vbot-level-hint">
                  Black pre-places {goHandicap} stones, White moves first, komi drops to 0.5.
                  {userColor === 'black' ? ' You take the handicap stones.' : ' The bot takes the handicap stones.'}
                </p>
              )}
            </>
          )}

          <div className="vbot-colors" role="radiogroup" aria-label="Play as">
            {spec.players.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={userColor === c}
                className={`vbot-color${userColor === c ? ' is-active' : ''}`}
                onClick={() => setUserColor(c)}
              >
                <span className={`votb-turn-dot is-${c}`} aria-hidden />
                Play {kernelColorLabel(kind, c)}
                {c === spec.players[0] ? ' (first)' : ''}
              </button>
            ))}
          </div>

          {engineReady === false ? (
            // Web build: KataGo can't be downloaded here. No CTA, just the
            // honest status (matches bots.ts BotUnavailableError copy).
            <div className="vbot-install" role="status">
              {isWebBuild ? (
                <p>
                  Go bots are coming to the web. Available today in the{' '}
                  <strong>desktop app</strong>.
                </p>
              ) : (
                <>
                  <p>
                    Go bots run on <strong>KataGo</strong>, a small engine download that stays on this
                    machine. Grab it once and every level (including the human-style ranks) unlocks.
                  </p>
                  {onOpenSettings ? (
                    <button type="button" className="votb-btn is-primary" onClick={onOpenSettings}>
                      <Download size={15} aria-hidden /> Download in Settings → Datasets
                    </button>
                  ) : (
                    <p className="muted small">Open Settings → Datasets to download it.</p>
                  )}
                </>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="votb-btn is-primary vbot-start"
              onClick={start}
              disabled={engineReady === null}
            >
              <Swords size={15} aria-hidden /> {engineReady === null ? 'Checking engine…' : 'Start game'}
            </button>
          )}
        </div>
      </div>
    )
  }

  const shimmer = <div className="kotb-loading">Setting up the {spec.title} board…</div>

  return (
    <div className="votb">
      <div className="votb-stage">
        {state === null ? (
          shimmer
        ) : is3d ? (
          <Board3DHost
            kind={kind}
            state={state}
            orientation={userColor === 'black' && spec.flipPolicy === 'rotate' ? 'black' : 'white'}
            // Scoring phase (go): the human marks dead stones for BOTH sides.
            interactive={isUserTurn || (goScoring && timeLoss === null)}
            onMove={onUserMove}
            onAction={onAction}
          />
        ) : (
          <Suspense fallback={shimmer}>
            <Board
              kind={kind}
              state={state}
              orientation={userColor === 'black' && spec.flipPolicy === 'rotate' ? 'black' : 'white'}
              // Scoring phase (go): the human marks dead stones for BOTH sides.
              interactive={isUserTurn || (goScoring && timeLoss === null)}
              onMove={onUserMove}
              onAction={onAction}
              territory={territoryOn && !goScoring ? territory.estimate?.ownership : undefined}
            />
          </Suspense>
        )}
        {over && (
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
        {isGo && goClockCfg && (
          <GoClockPair
            clock={goClock}
            turn={turn}
            labels={{
              black: userColor === 'black' ? 'You' : 'Bot',
              white: userColor === 'white' ? 'You' : 'Bot'
            }}
            over={over || goScoring}
          />
        )}
        <div className="votb-turn">
          <span className={`votb-turn-dot is-${turn}`} aria-hidden />
          {goScoring
            ? 'Scoring: tap dead groups'
            : over
              ? 'Game over'
              : isUserTurn
                ? 'Your move'
                : 'Bot to move'}
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
        {isGo && (
          <TerritoryControl territory={territory} on={territoryOn} onToggle={setTerritoryOn} />
        )}
        <BoardModeToggle kind={kind} />
        {canPass && (
          <button type="button" className="votb-btn" onClick={() => onUserMove('pass')}>
            Pass{kind === 'othello' ? ' (no legal placement)' : ''}
          </button>
        )}
        {canSwap && (
          <button type="button" className="votb-btn" onClick={() => onUserMove('swap')}>
            Swap (pie rule)
          </button>
        )}
        <button type="button" className="votb-btn" onClick={start}>
          <RotateCcw size={14} aria-hidden /> Restart game
        </button>
        <button type="button" className="votb-btn" onClick={backToSetup}>
          Change level
        </button>
        <p className="votb-note">
          {entry.title} vs bot: {provider.describe(level)}.
        </p>
      </aside>
    </div>
  )
}
