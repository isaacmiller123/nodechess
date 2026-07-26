import type { JSX } from 'react'
import { seriesStats, type SeriesPoint } from './format'

export interface AccuracySectionProps {
  /** Per-game accuracy for the games that have been reviewed, oldest first. */
  accuracy: SeriesPoint[]
  /** Games saved on this account, so an empty chart can say what is missing. */
  gamesPlayed: number
}

/** Twelve slots, 40 wide on a 50 pitch, as the design draws them. */
const SLOTS = 12
const SLOT_PITCH = 50
const SLOT_X0 = 5
const BAR_W = 40
const PLOT_H = 160

/**
 * Accuracy per game.
 *
 * One bar per REVIEWED game, not per finished game: accuracy_white and
 * accuracy_black are written by a review pass, so a played but unreviewed game
 * has nothing to plot. A full slate of games can legitimately draw no bars,
 * and when it does the empty note says which action fills them.
 *
 * Bars fill from the right, so the newest game is always in the last slot and
 * the stubs stand where readings have not been taken.
 */
export default function AccuracySection({
  accuracy,
  gamesPlayed
}: AccuracySectionProps): JSX.Element {
  const bars = accuracy.slice(-SLOTS)
  const stats = seriesStats(bars)
  const firstFilled = SLOTS - bars.length

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Accuracy</h2>
        <span className="sec-count">
          {stats
            ? `${Math.round(stats.last)}% last, ${Math.round(stats.avg)}% mean`
            : `last ${SLOTS} reviewed`}
        </span>
      </div>
      <div className="well prg-plot">
        <div className="prg-frame">
          <div className="prg-y">
            <span>100%</span>
            <span>75%</span>
            <span>50%</span>
            <span>25%</span>
            <span>0</span>
          </div>
          <div className="prg-canvas">
            <svg className="prg-svg" viewBox="0 0 600 160" preserveAspectRatio="none" aria-hidden>
              {bars.length > 0 && (
                <>
                  <line className="prg-rule" x1="0" y1="40" x2="600" y2="40" />
                  <line className="prg-rule" x1="0" y1="80" x2="600" y2="80" />
                  <line className="prg-rule" x1="0" y1="120" x2="600" y2="120" />
                </>
              )}
              <line className="prg-rule" x1="0" y1="159.5" x2="600" y2="159.5" />
              {Array.from({ length: SLOTS }, (_, i) => {
                const x = SLOT_X0 + i * SLOT_PITCH
                const point = i >= firstFilled ? bars[i - firstFilled] : null
                if (!point) {
                  return (
                    <rect
                      key={i}
                      className="prg-bar is-void"
                      x={x}
                      y="150"
                      width={BAR_W}
                      height="10"
                    />
                  )
                }
                const pct = Math.min(100, Math.max(0, point.value))
                const h = Math.round((pct / 100) * PLOT_H * 10) / 10
                return (
                  <rect
                    key={i}
                    className={`prg-bar${i === SLOTS - 1 ? ' is-last' : ''}`}
                    x={x}
                    y={Math.round((PLOT_H - h) * 10) / 10}
                    width={BAR_W}
                    height={h}
                  />
                )
              })}
            </svg>
            {bars.length === 0 && (
              <div className="prg-void is-mid">
                <p className="empty-line">Nothing measured.</p>
                <p className="empty-line">
                  {gamesPlayed > 0
                    ? 'Review a game to plot its accuracy.'
                    : 'One bar per reviewed game.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
