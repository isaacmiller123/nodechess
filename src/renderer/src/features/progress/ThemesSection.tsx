import type { JSX } from 'react'
import type { ProgressSummary, PuzzleStats, ThemeStat } from '../../../../shared/types'
import { formatCount, humanizeTheme } from './format'
import type { ProgressNavTarget } from './ProgressView'

export interface ThemesSectionProps {
  stats: PuzzleStats | null
  summary: ProgressSummary | null
  onNavigate?: (view: ProgressNavTarget) => void
}

/** Below this an accuracy is a coin toss, not a ranking. */
const MIN_ATTEMPTS = 4

/** How many rows each side shows at most, as the design draws them. */
const SIDE = 3

interface Ranked {
  strongest: ThemeStat[]
  weakest: ThemeStat[]
}

/**
 * Split the ranked themes so a theme never appears on both sides: the top half
 * can be strong and the bottom half weak, three each at most.
 */
function rank(byTheme: ThemeStat[]): Ranked {
  const usable = byTheme
    .filter((t) => t.attempts >= MIN_ATTEMPTS && t.theme)
    .sort((a, b) => b.accuracy - a.accuracy)
  const top = Math.min(SIDE, Math.ceil(usable.length / 2))
  const bottom = Math.min(SIDE, Math.floor(usable.length / 2))
  return {
    strongest: usable.slice(0, top),
    weakest: bottom > 0 ? usable.slice(-bottom).reverse() : []
  }
}

function ThemeRow({ stat, weak }: { stat: ThemeStat; weak: boolean }): JSX.Element {
  const pct = Math.round(stat.accuracy * 100)
  return (
    <div className={`prg-th${weak ? ' is-weak' : ''}`}>
      <span className="prg-th-name">{humanizeTheme(stat.theme)}</span>
      <span className="prg-th-val">{pct}%</span>
      <svg className="prg-meter" viewBox="0 0 100 3" preserveAspectRatio="none" aria-hidden>
        <rect className="prg-meter-bg" x="0" y="1" width="100" height="1" />
        <rect className="prg-meter-fill" x="0" y="0" width={pct} height="3" />
      </svg>
    </div>
  )
}

/**
 * Strongest and weakest themes.
 *
 * Only a themed attempt carries a theme: plain adaptive training stores none,
 * so hundreds of solves can leave nothing to rank. The empty side says that
 * rather than showing a blank ranking that reads as a fault.
 */
export default function ThemesSection({
  stats,
  summary,
  onNavigate
}: ThemesSectionProps): JSX.Element {
  const solved = stats?.totalSolved ?? summary?.puzzlesSolved ?? null
  const { strongest, weakest } = rank(stats?.byTheme ?? [])
  const tagged = (stats?.byTheme ?? []).length > 0

  // Why a side is empty: nothing tagged at all, or tagged but too thin to rank.
  const thin = tagged && strongest.length === 0

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Puzzle themes</h2>
        {solved != null && <span className="sec-count">{formatCount(solved)} solved</span>}
      </div>
      <div className="prg-two">
        <div className="well">
          <div className="prg-sub">
            <span className="lbl">Strongest</span>
          </div>
          {strongest.length > 0 ? (
            strongest.map((t) => <ThemeRow key={t.theme} stat={t} weak={false} />)
          ) : (
            <div className="empty">
              <p className="empty-line">Nothing to rank yet.</p>
              <p className="empty-line">
                {thin
                  ? `A theme ranks after ${MIN_ATTEMPTS} attempts.`
                  : 'Themed training sorts them as you solve.'}
              </p>
            </div>
          )}
        </div>
        <div className="well">
          <div className="prg-sub">
            <span className="lbl">Weakest</span>
            <button
              className="btn is-quiet"
              type="button"
              onClick={() => onNavigate?.('puzzles')}
            >
              {weakest.length > 0 ? 'Train these' : 'Start puzzles'}
            </button>
          </div>
          {weakest.length > 0 ? (
            weakest.map((t) => <ThemeRow key={t.theme} stat={t} weak />)
          ) : (
            <div className="empty">
              <p className="empty-line">Nothing to work on yet.</p>
              <p className="empty-line">The three you miss most land here.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
