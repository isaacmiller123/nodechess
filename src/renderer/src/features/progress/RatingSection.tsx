import type { JSX } from 'react'
import type { ProgressSummary, RatingValue } from '../../../../shared/types'
import { plotY, polylinePoints, ratingScale, type SeriesPoint } from './format'

export interface RatingSectionProps {
  summary: ProgressSummary | null
  puzzle: RatingValue | null
  vsBot: RatingValue | null
  /** The puzzle ladder over time, oldest to newest. */
  puzzleSeries: SeriesPoint[]
}

function shortDate(t: number): string {
  try {
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

/**
 * Rating over time.
 *
 * The design draws two tracks. Only one of them can be a line here: the puzzle
 * ladder keeps a row per attempt, while the rating table holds a single current
 * row per ladder, so the bot ladder's figure is real and its past is not, and
 * drawing it as a line would be an invention. Its key stays in the legend with
 * the figure and no line.
 *
 * The axis is drawn around a reading or not at all. A chart centred on a
 * constant would make a failed read look exactly like a measurement of that
 * constant, so when neither ladder answers there is no scale, no level line and
 * no tick: the well says the rating is not on record and what puts it there.
 */
export default function RatingSection({
  summary,
  puzzle,
  vsBot,
  puzzleSeries
}: RatingSectionProps): JSX.Element {
  const puzzleNow = puzzle?.rating ?? summary?.puzzleRating ?? null
  const vsBotNow = vsBot?.rating ?? summary?.vsBotRating ?? null

  // One point is a reading, not a line.
  const line = puzzleSeries.length >= 2 ? puzzleSeries : []
  const hasLine = line.length > 0
  const center = puzzleNow ?? vsBotNow

  const legend = (
    <div className="prg-legend">
      <span className={`prg-key ${hasLine ? 'is-a' : 'is-off'}`}>
        <i className="prg-dot" />
        {puzzleNow == null ? 'Puzzles' : `Puzzles ${Math.round(puzzleNow)}`}
      </span>
      <span className="prg-key is-off">
        <i className="prg-dot" />
        {vsBotNow == null ? 'Vs bot' : `Vs bot ${Math.round(vsBotNow)}`}
      </span>
    </div>
  )

  // Nothing read from either ladder: no reading, so no chart.
  if (!hasLine && center == null) {
    return (
      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Rating</h2>
          {legend}
        </div>
        <div className="well">
          <div className="empty">
            <p className="empty-line">No rating on record.</p>
            <p className="empty-line">A rated puzzle or a game against a bot sets the first one.</p>
          </div>
        </div>
      </section>
    )
  }

  const scale = ratingScale(
    line.map((p) => p.value),
    center ?? line[line.length - 1].value
  )

  // One time domain for the plot, so the end labels name the span the line
  // actually covers.
  const from = hasLine ? Math.min(...line.map((p) => p.t)) : 0
  const to = hasLine ? Math.max(...line.map((p) => p.t)) : 0

  // Null only when a line is being drawn instead, never a stand-in figure.
  const levelY = center == null ? null : plotY(center, scale)

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Rating</h2>
        {legend}
      </div>

      <div className="well prg-plot">
        <div className="prg-frame">
          <div className="prg-y">
            {scale.labels.map((v) => (
              <span key={v}>{v}</span>
            ))}
          </div>
          <div className="prg-canvas">
            <svg className="prg-svg" viewBox="0 0 600 160" preserveAspectRatio="none" aria-hidden>
              <line className="prg-rule" x1="0" y1="0.5" x2="600" y2="0.5" />
              <line className="prg-rule" x1="0" y1="40" x2="600" y2="40" />
              <line className="prg-rule" x1="0" y1="80" x2="600" y2="80" />
              <line className="prg-rule" x1="0" y1="120" x2="600" y2="120" />
              <line className="prg-rule" x1="0" y1="159.5" x2="600" y2="159.5" />
              {hasLine ? (
                <polyline className="prg-a" points={polylinePoints(line, from, to, scale)} />
              ) : (
                levelY != null && (
                  <>
                    {/* The rating as it stands, and the single tick that is the
                        only point actually on record. */}
                    <line className="prg-level" x1="0" y1={levelY} x2="600" y2={levelY} />
                    <rect className="prg-seed" x="0" y={levelY - 3} width="3" height="6" />
                  </>
                )
              )}
            </svg>
            {!hasLine && (
              <div className="prg-void">
                <p className="empty-line">
                  {puzzleNow != null && puzzleNow === vsBotNow
                    ? `${Math.round(puzzleNow)} to start, both tracks.`
                    : 'Nothing plotted yet.'}
                </p>
                <p className="empty-line">
                  {puzzleSeries.length === 1
                    ? 'One more rated puzzle draws the line.'
                    : 'A rated puzzle plots the first point.'}
                </p>
              </div>
            )}
          </div>
          {hasLine && (
            <div className="prg-x ticks">
              <span className="lbl">{shortDate(from)}</span>
              <span className="lbl">{shortDate(to)}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
