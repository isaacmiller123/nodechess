import { useState, type JSX } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  formatAccuracy,
  formatGameDate,
  opponentEloOf,
  opponentLabelOf,
  resultChipLabel,
  resultKind,
  userAccuracyOf,
  userColorLabel,
  userColorOf
} from './format'
import { useGamesPage } from './useProgressData'

export interface GamesTableProps {
  /** Optional navigation hook; a row click opens the game (e.g. in analysis). */
  onOpenGame?: (gameId: number) => void
}

const PAGE_SIZE = 12

export default function GamesTable({ onOpenGame }: GamesTableProps): JSX.Element {
  const [page, setPage] = useState(0)
  const offset = page * PAGE_SIZE
  const { games, loading, initial, hasMore } = useGamesPage(offset, PAGE_SIZE)

  const onPrev = (): void => setPage((p) => Math.max(0, p - 1))
  const onNext = (): void => {
    if (hasMore) setPage((p) => p + 1)
  }

  // First load with no rows: empty profile state.
  if (initial && loading) {
    return (
      <section className="card progress-card games-card">
        <h3 className="card-title">My games</h3>
        <div className="games-loading muted small">Loading games…</div>
      </section>
    )
  }

  if (page === 0 && games.length === 0) {
    return (
      <section className="card progress-card games-card">
        <h3 className="card-title">My games</h3>
        <div className="games-empty">
          <p className="muted">No games recorded yet.</p>
          <p className="muted small">
            Games you play against the bots will appear here with results and accuracy.
          </p>
        </div>
      </section>
    )
  }

  const start = offset + 1
  const end = offset + games.length

  return (
    <section className="card progress-card games-card">
      <div className="card-title-row">
        <h3 className="card-title">My games</h3>
        <div className="games-pager">
          <span className="small muted games-range">
            {start}–{end}
          </span>
          <button
            className="icon-btn"
            onClick={onPrev}
            disabled={page === 0 || loading}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button
            className="icon-btn"
            onClick={onNext}
            disabled={!hasMore || loading}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight size={16} aria-hidden />
          </button>
        </div>
      </div>

      <div className="games-table-wrap" aria-busy={loading}>
        <table className="games-table">
          <thead>
            <tr>
              <th className="col-date">Date</th>
              <th className="col-opp">Opponent</th>
              <th className="col-elo">Elo</th>
              <th className="col-color">Color</th>
              <th className="col-result">Result</th>
              <th className="col-acc">Accuracy</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => {
              const kind = resultKind(g)
              const color = userColorOf(g)
              const acc = userAccuracyOf(g)
              const elo = opponentEloOf(g)
              const date = formatGameDate(g.created_at)
              const clickable = !!onOpenGame
              return (
                <tr
                  key={g.id}
                  className={clickable ? 'row-clickable' : undefined}
                  onClick={clickable ? () => onOpenGame?.(g.id) : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  role={clickable ? 'button' : undefined}
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
                  <td className="col-date num">{date || '·'}</td>
                  <td className="col-opp">
                    <span className="opp-label">{opponentLabelOf(g)}</span>
                  </td>
                  <td className="col-elo num">{elo || '·'}</td>
                  <td className="col-color">
                    {color ? (
                      <span className={`color-dot ${color}`} aria-hidden />
                    ) : null}
                    <span>{userColorLabel(color)}</span>
                  </td>
                  <td className="col-result">
                    <span className={`result-chip ${kind}`}>{resultChipLabel(kind)}</span>
                  </td>
                  <td className="col-acc num">
                    {acc != null ? formatAccuracy(acc) : <span className="muted">·</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
