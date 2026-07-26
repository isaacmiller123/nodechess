import { useMemo, type JSX } from 'react'
import { useProgressData } from './useProgressData'
import { accuracySeries, puzzleRatingSeries, schoolProgress } from './format'
import MeasuredSection from './MeasuredSection'
import RatingSection from './RatingSection'
import AccuracySection from './AccuracySection'
import SchoolSection from './SchoolSection'
import ThemesSection from './ThemesSection'
import RecentGamesSection from './RecentGamesSection'
import './progress.css'

/**
 * Views the Progress page can navigate to. Kept local (mirrors HomeView's
 * pattern) to avoid coupling to a shared file. App.tsx's setView accepts the
 * superset, so passing it is assignment-compatible.
 */
export type ProgressNavTarget = 'play' | 'puzzles' | 'analysis' | 'school' | 'games'

export interface ProgressViewProps {
  /** Optional: navigate elsewhere within the app. */
  onNavigate?: (view: ProgressNavTarget) => void
  /** Open a saved game (by id) in the Analysis board. */
  onOpenGame?: (gameId: number) => void
}

/**
 * PROGRESS, from design-lab/v1/progress.html.
 *
 * The design draws the page twice, once with nothing on record and once with a
 * sample account's figures, so both readings could be judged side by side.
 * There is one page here and it takes whichever reading the account gives:
 * every section carries its own empty form, because the ladders, the reviews,
 * the curriculum and the archive all fill up at different times and a page that
 * waited for all four would be blank for a week.
 *
 * Nothing on this page is a sample, and nothing on it is a constant standing in
 * for a reading. Where a figure cannot be read the surface says so.
 */
export default function ProgressView({
  onNavigate,
  onOpenGame
}: ProgressViewProps = {}): JSX.Element {
  const { data, loading } = useProgressData()

  const puzzleSeries = useMemo(() => puzzleRatingSeries(data.puzzleHistory), [data.puzzleHistory])
  const accuracy = useMemo(() => accuracySeries(data.trendGames), [data.trendGames])
  const school = useMemo(
    () => schoolProgress(data.chapters, data.mastery),
    [data.chapters, data.mastery]
  )

  /* Every games figure on this page counts chess and only chess: the accuracy
     bars, the recent list and this one. The summary's own gamesPlayed counts
     every kind in the archive, so it is deliberately not used here. */
  const chessGames = data.chessGames

  /* Every well on this page states what is or is not on record, and none of
     those statements is true until the read comes back. So the page waits
     rather than telling an account with sixty games that it has none. The
     marker is the one the shell already shows while this view's own chunk
     loads, so the two read as a single load. Every hook is above this. */
  if (loading) {
    return (
      <div className="view-loading" role="status" aria-live="polite">
        <span className="view-spinner" aria-hidden />
        <span className="visually-hidden">Loading</span>
      </div>
    )
  }

  return (
    <>
      <MeasuredSection
        summary={data.summary}
        chessGames={chessGames}
        puzzle={data.puzzleRating}
        vsBot={data.vsBotRating}
        puzzleSeries={puzzleSeries}
        accuracy={accuracy}
        school={school}
        onNavigate={onNavigate}
      />

      <RatingSection
        summary={data.summary}
        puzzle={data.puzzleRating}
        vsBot={data.vsBotRating}
        puzzleSeries={puzzleSeries}
      />

      <div className="prg-two">
        <AccuracySection accuracy={accuracy} gamesPlayed={chessGames ?? data.trendGames.length} />
        <SchoolSection chapters={data.chapters} school={school} onNavigate={onNavigate} />
      </div>

      <ThemesSection stats={data.puzzleStats} summary={data.summary} onNavigate={onNavigate} />

      <RecentGamesSection games={data.trendGames} total={chessGames} onOpenGame={onOpenGame} />
    </>
  )
}
