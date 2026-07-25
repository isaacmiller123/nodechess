import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import {
  Timer,
  Heart,
  HeartCrack,
  Flame,
  Trophy,
  Crown,
  Zap,
  History,
  Play,
  RotateCcw,
  X,
  Hourglass,
  Skull,
  Target,
  Check,
  Gauge
} from 'lucide-react'
import type { RushMode as RushModeId, RushRunRow, RushBest, RushEndReason } from '@shared/types'
import { Board } from '../../../board/Board'
import { pieceSetClass } from '../../../board/pieceSets'
import { useSettings } from '../../../state/settings'
import { useRushSession, RUSH_VARIANTS, type RushVariant } from './rush-session'
import './rush.css'

// ============================================================================
// SLICE B: Puzzle Rush / Storm (timed).  ★ OWNED BY THE RUSH BUILDER ★
//
// Variant picker -> live solve (board + HUD) -> results card, plus a personal-
// best leaderboard and recent-run history. The whole clock-driven solve loop
// lives in ./rush-session.ts (useRushSession); this file is the view.
// ============================================================================

const MODE_PREF_KEY = 'oct.puzzles.rush.mode.v1'

const VARIANT_ORDER: RushModeId[] = ['rush3', 'rush5', 'storm', 'survival']

const VARIANT_ICON: Record<RushModeId, typeof Timer> = {
  rush3: Heart,
  rush5: Heart,
  storm: Zap,
  survival: Skull
}

function loadModePref(): RushModeId {
  try {
    const raw = localStorage.getItem(MODE_PREF_KEY)
    if (raw === 'rush3' || raw === 'rush5' || raw === 'storm' || raw === 'survival') return raw
  } catch {
    /* storage may be unavailable */
  }
  return 'rush3'
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function fmtAgo(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}

const REASON_LABEL: Record<RushEndReason, string> = {
  time: "Time's up",
  lives: 'Out of lives',
  quit: 'Run ended',
  cleared: 'Band cleared'
}

export default function RushMode(): JSX.Element {
  const [mode, setMode] = useState<RushModeId>(loadModePref)
  const s = useRushSession(mode)

  const chooseMode = useCallback(
    (m: RushModeId) => {
      if (s.phase !== 'idle' && s.phase !== 'over') return
      if (m === mode) return
      // Switching variant clears any lingering result card from the prior run so
      // the new variant's lobby starts clean (the hook state persists across the
      // mode-prop change otherwise).
      if (s.phase === 'over') s.reset()
      setMode(m)
      try {
        localStorage.setItem(MODE_PREF_KEY, m)
      } catch {
        /* ignore */
      }
    },
    [s, mode]
  )

  const isIdle = s.phase === 'idle'
  const isOver = s.phase === 'over'
  const isLive = !isIdle && !isOver

  if (isLive) return <RushPlaying s={s} />

  return (
    <RushLobby
      mode={mode}
      onChoose={chooseMode}
      onStart={s.start}
      apiReady={s.apiReady}
      result={isOver ? s : null}
    />
  )
}

// ---------------------------------------------------------------------------
// Lobby: variant picker + (when a run just ended) the results card, with the
// personal-best board and recent history beneath.
// ---------------------------------------------------------------------------
function RushLobby(props: {
  mode: RushModeId
  onChoose: (m: RushModeId) => void
  onStart: () => void
  apiReady: boolean
  result: ReturnType<typeof useRushSession> | null
}): JSX.Element {
  const { mode, onChoose, onStart, apiReady, result } = props
  const variant = RUSH_VARIANTS[mode]

  const [bests, setBests] = useState<RushBest[]>([])
  const [runs, setRuns] = useState<RushRunRow[]>([])
  // Re-pull stats whenever a run finishes (result identity changes via saving flag).
  const refreshKey = result ? `${result.solved}-${result.missed}-${result.saving}` : 'init'

  useEffect(() => {
    const api = window.api?.puzzles
    if (!api) return
    let cancelled = false
    void api
      .rushBests()
      .then((r) => {
        if (!cancelled && r?.bests) setBests(r.bests)
      })
      .catch(() => {
        /* leaderboard optional */
      })
    void api
      .rushRuns({ limit: 12 })
      .then((r) => {
        if (!cancelled && r?.runs) setRuns(r.runs)
      })
      .catch(() => {
        /* history optional */
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const bestForMode = bests.find((b) => b.mode === mode)?.best ?? 0

  return (
    <div className="rush-lobby">
      {result && <RushResultCard s={result} onPlayAgain={onStart} />}

      <section className="rush-picker panel">
        <header className="rush-picker-head">
          <div className="rush-picker-title">
            <Timer size={18} aria-hidden />
            <h2>Puzzle Rush</h2>
          </div>
          <p className="muted small">Solve against the clock. Difficulty ramps as you climb.</p>
        </header>

        <div className="rush-variant-grid" role="radiogroup" aria-label="Rush variant">
          {VARIANT_ORDER.map((m) => {
            const v = RUSH_VARIANTS[m]
            const Icon = VARIANT_ICON[m]
            const best = bests.find((b) => b.mode === m)?.best ?? 0
            const active = m === mode
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                className={`rush-variant-card${active ? ' is-active' : ''}`}
                onClick={() => onChoose(m)}
              >
                <span className="rush-variant-icon" aria-hidden>
                  <Icon size={20} />
                </span>
                <span className="rush-variant-body">
                  <span className="rush-variant-name">{v.label}</span>
                  <span className="rush-variant-blurb">{v.blurb}</span>
                </span>
                <span className="rush-variant-best">
                  <Trophy size={12} aria-hidden />
                  {best > 0 ? best : '·'}
                </span>
              </button>
            )
          })}
        </div>

        <div className="rush-start-row">
          <div className="rush-start-meta">
            <VariantTagline variant={variant} />
            {bestForMode > 0 && (
              <span className="rush-start-best">
                Best <strong>{bestForMode}</strong>
              </span>
            )}
          </div>
          <button type="button" className="btn rush-start-btn" onClick={onStart}>
            <Play size={16} aria-hidden />
            Start {variant.label}
          </button>
        </div>

        {!apiReady && (
          <p className="muted small rush-preview-note">
            Preview mode. Connect to the desktop app to load puzzles.
          </p>
        )}
      </section>

      <div className="rush-stats">
        <RushLeaderboard bests={bests} />
        <RushHistory runs={runs} />
      </div>
    </div>
  )
}

function VariantTagline({ variant }: { variant: RushVariant }): JSX.Element {
  if (variant.clock && variant.mode === 'survival') {
    return (
      <span className="rush-start-rule">
        <Hourglass size={13} aria-hidden /> One life · shrinking clock
      </span>
    )
  }
  if (variant.clock) {
    return (
      <span className="rush-start-rule">
        <Hourglass size={13} aria-hidden /> {variant.startSec}s · +{variant.bonusSec}s per solve
      </span>
    )
  }
  return (
    <span className="rush-start-rule">
      <Heart size={13} aria-hidden /> {variant.lives} lives
    </span>
  )
}

// ---------------------------------------------------------------------------
// Live run: board on the left, HUD on the right.
// ---------------------------------------------------------------------------
function RushPlaying({ s }: { s: ReturnType<typeof useRushSession> }): JSX.Element {
  const { settings } = useSettings()
  const isSolving = s.phase === 'solving'
  const isLoading = s.phase === 'loading'

  // Esc quits the run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') s.quit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s])

  return (
    <div className="rush-play">
      <div className="board-area">
        <div className="board-stage">
          <div className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}>
            <Board
              fen={s.fen}
              orientation={s.orientation}
              turnColor={s.turn}
              dests={s.dests}
              movableColor={s.orientation}
              viewOnly={!isSolving}
              lastMove={s.lastMove}
              check={s.check}
              showDests={settings.showLegal}
              coordinates={settings.coordinates}
              animation={settings.animation}
              onMove={s.onUserMove}
              syncNonce={s.nonce}
            />
            {isLoading && <div className="puzzle-skeleton" aria-hidden />}
          </div>
        </div>
      </div>

      <aside className="rush-hud">
        <RushHud s={s} />
      </aside>
    </div>
  )
}

function RushHud({ s }: { s: ReturnType<typeof useRushSession> }): JSX.Element {
  const v = s.variant
  const lowTime = s.clockOn && s.clockMs <= 10_000
  return (
    <>
      <div className={`rush-hud-card panel${s.flash === 'solve' ? ' flash-solve' : ''}${s.flash === 'miss' ? ' flash-miss' : ''}`}>
        <div className="rush-hud-label">{v.label}</div>
        <div className="rush-score" aria-live="polite" aria-label={`Score ${s.score}`}>
          {s.score}
        </div>
        <div className="rush-hud-sub">solved</div>
      </div>

      {s.clockOn ? (
        <div className={`rush-clock panel${lowTime ? ' is-low' : ''}`}>
          <Hourglass size={16} aria-hidden />
          <span className="rush-clock-time">{fmtClock(s.clockMs)}</span>
          {v.mode === 'storm' && s.comboMult > 1 && (
            <span className="rush-combo">×{s.comboMult}</span>
          )}
        </div>
      ) : (
        <div className="rush-lives panel" aria-label={`${s.livesLeft} of ${s.maxLives} lives`}>
          {Array.from({ length: s.maxLives }).map((_, i) =>
            i < s.livesLeft ? (
              <Heart key={i} size={20} className="rush-life is-on" aria-hidden />
            ) : (
              <HeartCrack key={i} size={20} className="rush-life is-off" aria-hidden />
            )
          )}
        </div>
      )}

      <div className="rush-hud-stats panel">
        <div className="rush-stat">
          <Flame size={15} className={s.streak > 0 ? 'rush-stat-ico is-hot' : 'rush-stat-ico'} aria-hidden />
          <span className="rush-stat-val">{s.streak}</span>
          <span className="rush-stat-key">streak</span>
        </div>
        <div className="rush-stat">
          <Target size={15} className="rush-stat-ico" aria-hidden />
          <span className="rush-stat-val">{s.solved}</span>
          <span className="rush-stat-key">solved</span>
        </div>
        <div className="rush-stat">
          <X size={15} className="rush-stat-ico is-miss" aria-hidden />
          <span className="rush-stat-val">{s.missed}</span>
          <span className="rush-stat-key">missed</span>
        </div>
      </div>

      {s.puzzle && (
        <div className="rush-puzzle-meta panel">
          <span className="muted small">
            {s.orientation === 'white' ? 'White' : 'Black'} to move
          </span>
          <span className="rush-puzzle-rating">
            <Gauge size={13} aria-hidden /> {s.puzzle.rating}
          </span>
        </div>
      )}

      <button type="button" className="btn ghost rush-quit" onClick={s.quit}>
        <X size={15} aria-hidden /> End run
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// Results card (shown in the lobby after a run ends).
// ---------------------------------------------------------------------------
function RushResultCard(props: {
  s: ReturnType<typeof useRushSession>
  onPlayAgain: () => void
}): JSX.Element {
  const { s, onPlayAgain } = props
  const v = s.variant
  const accuracy = s.solved + s.missed > 0 ? Math.round((s.solved / (s.solved + s.missed)) * 100) : 0
  const isBest = s.result?.isBest ?? false
  const best = s.result?.best ?? s.score

  return (
    <section className={`rush-result panel${isBest ? ' is-best' : ''}`}>
      <header className="rush-result-head">
        <div className="rush-result-eyebrow">
          {s.endedReason ? REASON_LABEL[s.endedReason] : 'Run complete'} · {v.label}
        </div>
        {isBest ? (
          <div className="rush-result-badge is-best">
            <Crown size={15} aria-hidden /> New personal best!
          </div>
        ) : (
          best > 0 && (
            <div className="rush-result-badge">
              <Trophy size={14} aria-hidden /> Best {best}
            </div>
          )
        )}
      </header>

      <div className="rush-result-score">
        <span className="rush-result-num">{s.score}</span>
        <span className="rush-result-unit">solved</span>
      </div>

      <div className="rush-result-grid">
        <ResultStat icon={<Flame size={16} aria-hidden />} label="Best streak" value={s.bestStreak} />
        <ResultStat icon={<Target size={16} aria-hidden />} label="Accuracy" value={`${accuracy}%`} />
        <ResultStat icon={<X size={16} aria-hidden />} label="Missed" value={s.missed} />
        <ResultStat
          icon={<Gauge size={16} aria-hidden />}
          label="Hardest solved"
          value={s.topRating > 0 ? s.topRating : '·'}
        />
        {s.durationMs > 0 && (
          <ResultStat
            icon={<Hourglass size={16} aria-hidden />}
            label="Time"
            value={fmtDuration(s.durationMs)}
          />
        )}
      </div>

      <div className="rush-result-actions">
        <button type="button" className="btn rush-again" onClick={onPlayAgain}>
          <RotateCcw size={16} aria-hidden /> Play again
        </button>
        {s.saving && <span className="muted small rush-saving">Saving…</span>}
      </div>
    </section>
  )
}

function ResultStat(props: {
  icon: JSX.Element
  label: string
  value: string | number
}): JSX.Element {
  return (
    <div className="rush-result-stat">
      <span className="rush-result-stat-ico" aria-hidden>
        {props.icon}
      </span>
      <span className="rush-result-stat-val">{props.value}</span>
      <span className="rush-result-stat-key">{props.label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Personal-best leaderboard (per mode).
// ---------------------------------------------------------------------------
function RushLeaderboard({ bests }: { bests: RushBest[] }): JSX.Element {
  const ordered = VARIANT_ORDER.map((m) => bests.find((b) => b.mode === m)).filter(
    (b): b is RushBest => !!b
  )
  const has = ordered.some((b) => b.runs > 0)
  return (
    <section className="panel rush-board">
      <header className="rush-board-head">
        <Trophy size={15} aria-hidden />
        <h3>Personal bests</h3>
      </header>
      {has ? (
        <ul className="rush-board-list">
          {ordered.map((b) => {
            const Icon = VARIANT_ICON[b.mode]
            return (
              <li key={b.mode} className="rush-board-row">
                <span className="rush-board-mode">
                  <Icon size={15} aria-hidden />
                  {RUSH_VARIANTS[b.mode].label}
                </span>
                <span className="rush-board-best">{b.runs > 0 ? b.best : '·'}</span>
                <span className="rush-board-runs muted small">
                  {b.runs} {b.runs === 1 ? 'run' : 'runs'}
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted small rush-empty">No runs yet. Your bests will show up here.</p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Recent-run history.
// ---------------------------------------------------------------------------
function RushHistory({ runs }: { runs: RushRunRow[] }): JSX.Element {
  return (
    <section className="panel rush-board">
      <header className="rush-board-head">
        <History size={15} aria-hidden />
        <h3>Recent runs</h3>
      </header>
      {runs.length > 0 ? (
        <ul className="rush-history-list">
          {runs.map((r) => {
            const Icon = VARIANT_ICON[r.mode]
            return (
              <li key={r.id} className="rush-history-row">
                <span className="rush-history-mode">
                  <Icon size={14} aria-hidden />
                  {RUSH_VARIANTS[r.mode].label}
                </span>
                <span className="rush-history-score">
                  <Check size={12} aria-hidden /> {r.score}
                </span>
                <span className="rush-history-streak muted small">
                  <Flame size={11} aria-hidden /> {r.bestStreak}
                </span>
                <span className="rush-history-when muted small">{fmtAgo(r.createdAt)}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted small rush-empty">No history yet. Start a run!</p>
      )}
    </section>
  )
}
