import type { JSX } from 'react'
import type { ProgressSummary, RatingValue } from '../../../../shared/types'
import {
  formatCount,
  ratingBand,
  seriesStats,
  type SchoolProgress,
  type SeriesPoint
} from './format'
import type { ProgressNavTarget } from './ProgressView'

/** A Glicko rd at or above this is still wide enough to call the rating
 *  provisional, which is the word the readout and the design both use. */
const PROVISIONAL_RD = 110

/** The accuracy chart's window, so the fact and the bars report the same set. */
const ACCURACY_WINDOW = 12

export interface MeasuredSectionProps {
  summary: ProgressSummary | null
  /**
   * Chess games saved on this account, or null when the archive could not be
   * read. The summary carries a gamesPlayed of its own and it counts EVERY kind
   * in the archive (go, gomoku, imports), while the accuracy bars and the
   * recent list below are chess only, so using it here would make the page
   * contradict itself.
   */
  chessGames: number | null
  puzzle: RatingValue | null
  vsBot: RatingValue | null
  /** The puzzle ladder over time, oldest to newest. */
  puzzleSeries: SeriesPoint[]
  /** Per-game accuracy for the games that have been reviewed. */
  accuracy: SeriesPoint[]
  school: SchoolProgress
  onNavigate?: (view: ProgressNavTarget) => void
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** The note under a rating: how far it has moved, or how wide it still is. */
function ratingNote(series: SeriesPoint[], rating: number | null, rd: number | null): string {
  if (series.length >= 2) {
    const delta = Math.round(series[series.length - 1].value - series[0].value)
    const n = series.length
    if (delta === 0) return `level over ${n} attempts`
    return `${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} in ${n} attempts`
  }
  if (rating == null || rd == null || !Number.isFinite(rd)) return ''
  if (rd >= PROVISIONAL_RD) return 'provisional'
  return `± ${ratingBand(rating, rd).pm}`
}

/**
 * The four readings the rest of the page then draws out, or, on an account
 * with nothing behind it, the one row that starts them.
 *
 * Three states, and which one shows turns on what came back rather than on a
 * zero: figures when there are figures, the starting row when the reads agree
 * that nothing has happened yet, and a plain statement when a read did not
 * arrive, because an empty page and an unread one are not the same page.
 */
export default function MeasuredSection({
  summary,
  chessGames,
  puzzle,
  vsBot,
  puzzleSeries,
  accuracy,
  school,
  onNavigate
}: MeasuredSectionProps): JSX.Element {
  const games = chessGames
  const solved = summary ? summary.puzzlesSolved : null
  const tried = summary ? summary.puzzlesTried : null

  const measured = (games ?? 0) > 0 || (tried ?? 0) > 0
  const nothingYet = games === 0 && tried === 0

  const puzzleRating = puzzle?.rating ?? summary?.puzzleRating ?? null
  const puzzleRd = puzzle?.rd ?? summary?.puzzleRd ?? null
  const vsBotRating = vsBot?.rating ?? summary?.vsBotRating ?? null
  const vsBotRd = vsBot?.rd ?? summary?.vsBotRd ?? null

  const recent = accuracy.slice(-ACCURACY_WINDOW)
  const accStats = seriesStats(recent)

  // Only the counts that came back get named, so a missing one is absent
  // rather than rendered as a zero.
  const counted: string[] = []
  if (games != null) counted.push(`${formatCount(games)} games`)
  if (solved != null) counted.push(`${formatCount(solved)} puzzles`)

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Measured so far</h2>
        {counted.length > 0 && <span className="sec-count">{counted.join(', ')}</span>}
      </div>

      {measured ? (
        <div className="panel">
          <div className="facts">
            <div className="fact">
              <span className="lbl">Puzzles</span>
              <span className="fact-value">
                {puzzleRating == null ? '·' : Math.round(puzzleRating)}
                <span className="fact-note">
                  {ratingNote(puzzleSeries, puzzleRating, puzzleRd)}
                </span>
              </span>
            </div>
            <div className="fact">
              <span className="lbl">Vs bot</span>
              <span className="fact-value">
                {vsBotRating == null ? '·' : Math.round(vsBotRating)}
                {/* No note about movement: the bot ladder keeps one current
                    row, so how far it has come is not on record anywhere. */}
                <span className="fact-note">{ratingNote([], vsBotRating, vsBotRd)}</span>
              </span>
            </div>
            <div className="fact">
              <span className="lbl">Accuracy</span>
              <span className="fact-value">
                {accStats ? `${Math.round(accStats.avg)}%` : 'none'}
                <span className="fact-note">
                  {accStats ? `last ${recent.length} reviewed` : 'review a game'}
                </span>
              </span>
            </div>
            {school.total > 0 && (
              <div className="fact">
                <span className="lbl">School</span>
                <span className="fact-value">
                  {school.completed} of {school.total}
                  <span className="fact-note">
                    {school.current
                      ? `chapter ${pad2(school.current.order)} open`
                      : 'every chapter done'}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
      ) : nothingYet ? (
        <div className="startrow is-first">
          <div>
            <div className="startrow-name">
              Nothing on the instruments yet <span className="tag">provisional</span>
            </div>
            {/* The design promised that one game moves the accuracy figure too.
                It does not: accuracy is written by a review, not by finishing a
                game, so the sentence says what actually happens. */}
            <div className="startrow-spec">
              One game moves the rating and the list at the bottom of this page. Reviewing it adds
              the accuracy figure.
            </div>
          </div>
          <button className="btn is-primary" type="button" onClick={() => onNavigate?.('play')}>
            Play your first game
          </button>
        </div>
      ) : (
        <div className="well">
          <div className="empty">
            <p className="empty-line">Nothing could be read from this device.</p>
            <p className="empty-line">Open this page again to take the readings.</p>
          </div>
        </div>
      )}
    </section>
  )
}
