import type { JSX } from 'react'
import type { GameRow } from '../../../../shared/types'
import {
  formatAccuracy,
  formatGameDate,
  moveCountOf,
  opponentLabelOf,
  resultChipLabel,
  resultKind,
  userAccuracyOf
} from './format'

export interface RecentGamesSectionProps {
  /** Newest-first chess games; only the first ROWS are drawn. */
  games: GameRow[]
  /** Every chess game saved, so the count says what the five are five of. */
  total: number | null
  onOpenGame?: (gameId: number) => void
}

const ROWS = 5

/**
 * The five most recent games.
 *
 * Five is the design's number and the count in the head says what the five are
 * five of, which is the design's whole answer to a deeper archive. A row opens
 * that game in Analysis.
 */
export default function RecentGamesSection({
  games,
  total,
  onOpenGame
}: RecentGamesSectionProps): JSX.Element {
  const rows = games.slice(0, ROWS)
  const clickable = typeof onOpenGame === 'function'

  return (
    <section className="sec prg-games">
      <div className="sec-head">
        <h2 className="lbl">Recent games</h2>
        {rows.length > 0 && total != null && (
          <span className="sec-count">
            {rows.length} of {total}
          </span>
        )}
      </div>
      <div className="well">
        {rows.length > 0 ? (
          <table className="gtable">
            <thead>
              <tr>
                <th className="col-name">
                  <span className="lbl">Opponent</span>
                </th>
                <th className="prg-c-res">
                  <span className="lbl">Result</span>
                </th>
                <th className="prg-c-mv">
                  <span className="lbl">Moves</span>
                </th>
                <th className="prg-c-acc">
                  <span className="lbl">Accuracy</span>
                </th>
                <th className="prg-c-when">
                  <span className="lbl">When</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => {
                const kind = resultKind(g)
                const moves = moveCountOf(g.pgn)
                const acc = userAccuracyOf(g)
                const when = formatGameDate(g.created_at)
                const open = clickable ? () => onOpenGame?.(g.id) : undefined
                return (
                  <tr
                    key={g.id}
                    className="grow"
                    tabIndex={clickable ? 0 : undefined}
                    onClick={open}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onOpenGame?.(g.id)
                            }
                          }
                        : undefined
                    }
                  >
                    <td>
                      <span className="g-name">{opponentLabelOf(g)}</span>
                    </td>
                    <td>
                      <span
                        className={`prg-res${kind === 'win' ? ' is-win' : kind === 'loss' ? ' is-loss' : ''}`}
                      >
                        {resultChipLabel(kind)}
                      </span>
                    </td>
                    <td className="num-cell">{moves ?? '·'}</td>
                    <td className="num-cell">{acc == null ? '·' : formatAccuracy(acc)}</td>
                    <td className="num-cell prg-when-cell">{when || '·'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <>
            <div className="empty-head">
              <span className="lbl">Opponent</span>
              <span className="lbl">Result</span>
              <span className="lbl">Moves</span>
              <span className="lbl">When</span>
            </div>
            <div className="empty">
              <p className="empty-line">No games yet.</p>
              <p className="empty-line">Finished games land here, newest first.</p>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
