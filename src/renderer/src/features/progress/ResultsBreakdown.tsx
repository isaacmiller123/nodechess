import type { JSX } from 'react'
import type { GameRow } from '../../../../shared/types'
import { groupByOpponent, scorePercent, type ResultTally } from './format'

export interface ResultsBreakdownProps {
  games: GameRow[]
}

/** A win/draw/loss stacked bar; segments hidden at zero width. */
function ResultBar({ tally }: { tally: ResultTally }): JSX.Element {
  const decided = tally.wins + tally.draws + tally.losses
  const denom = decided > 0 ? decided : 1
  const pct = (n: number): number => (n / denom) * 100
  return (
    <div
      className="rb-bar"
      role="img"
      aria-label={`${tally.wins} wins, ${tally.draws} draws, ${tally.losses} losses`}
    >
      {tally.wins > 0 && <span className="rb-seg win" style={{ width: `${pct(tally.wins)}%` }} />}
      {tally.draws > 0 && (
        <span className="rb-seg draw" style={{ width: `${pct(tally.draws)}%` }} />
      )}
      {tally.losses > 0 && (
        <span className="rb-seg loss" style={{ width: `${pct(tally.losses)}%` }} />
      )}
    </div>
  )
}

/**
 * Results breakdown grouped by opponent kind (bots vs personas). Each group
 * shows a stacked W/D/L bar, the raw tally, and a score percentage. Graceful
 * empty state for a brand-new profile.
 */
export default function ResultsBreakdown({ games }: ResultsBreakdownProps): JSX.Element {
  const groups = groupByOpponent(games)

  return (
    <section className="card progress-card breakdown-card">
      <div className="card-title-row">
        <h3 className="card-title">Results breakdown</h3>
        {games.length > 0 && <span className="small muted">last {games.length} games</span>}
      </div>

      {groups.length === 0 ? (
        <p className="muted small breakdown-empty">
          Win/draw/loss splits against bots and personas appear here once you have played.
        </p>
      ) : (
        <ul className="rb-groups">
          {groups.map((g) => {
            const score = scorePercent(g.tally)
            return (
              <li className="rb-group" key={g.key}>
                <div className="rb-row-head">
                  <span className="rb-group-label">{g.label}</span>
                  <span className="rb-score small num">
                    {score == null ? '·' : `${score}%`}
                  </span>
                </div>
                <ResultBar tally={g.tally} />
                <div className="rb-tally small">
                  <span className="rb-count win">{g.tally.wins}W</span>
                  <span className="rb-count draw">{g.tally.draws}D</span>
                  <span className="rb-count loss">{g.tally.losses}L</span>
                  <span className="rb-total muted">{g.tally.total} total</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
