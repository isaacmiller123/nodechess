import { useEffect, useState, type JSX } from 'react'
import type { GameRow } from '@shared/types'

type Loadable<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; data: T | null }

export interface MyGamesBrowserProps {
  /** Hand a chosen saved game row up to AnalysisView (it parses + loads the PGN). */
  onLoadGame: (row: GameRow) => void
}

/** Result of a game from the USER's perspective (needs a known user color). */
function userOutcome(row: GameRow): 'win' | 'loss' | 'draw' | 'unknown' {
  const r = row.result
  if (r === '1/2-1/2') return 'draw'
  if (r !== '1-0' && r !== '0-1') return 'unknown'
  const uc = row.user_color
  if (uc !== 'white' && uc !== 'black') return 'unknown'
  const won = (r === '1-0' && uc === 'white') || (r === '0-1' && uc === 'black')
  return won ? 'win' : 'loss'
}

function outcomeLabel(o: 'win' | 'loss' | 'draw'): string {
  return o === 'win' ? 'Win' : o === 'loss' ? 'Loss' : 'Draw'
}

/** Who the user played against, best-effort from the stored row. */
function opponentName(row: GameRow): string {
  if (row.opponent_label) return row.opponent_label
  if (row.user_color === 'white') return row.black_name ?? 'Black'
  if (row.user_color === 'black') return row.white_name ?? 'White'
  const w = row.white_name ?? 'White'
  const b = row.black_name ?? 'Black'
  return `${w} vs ${b}`
}

/** The user's own accuracy for the game, when a review has stored one. */
function userAccuracy(row: GameRow): number | null {
  if (row.user_color === 'white') return row.accuracy_white
  if (row.user_color === 'black') return row.accuracy_black
  return null
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return ''
  }
}

/**
 * "Your games" half of the Analysis game library: lists the saved-game archive
 * (window.api.games.list). Clicking a row loads its PGN into the Analysis board
 * via the same parsePgnToGame -> loadGame path famous games use, oriented to the
 * side the user played.
 */
export function MyGamesBrowser({ onLoadGame }: MyGamesBrowserProps): JSX.Element {
  const [list, setList] = useState<Loadable<GameRow[]>>({ status: 'loading', data: null })

  useEffect(() => {
    const api = window.api?.games
    if (!api) {
      setList({ status: 'error', data: null })
      return
    }
    let cancelled = false
    setList({ status: 'loading', data: null })
    api
      .list({ limit: 60 })
      .then((r) => {
        if (!cancelled) setList({ status: 'ready', data: r.games })
      })
      .catch(() => {
        if (!cancelled) setList({ status: 'error', data: null })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="ug-list">
      {list.status === 'loading' && (
        <div className="ug-skeleton" aria-hidden>
          {Array.from({ length: 4 }).map((_, i) => (
            <div className="ug-skel-row" key={i} />
          ))}
        </div>
      )}

      {list.status === 'error' && <div className="famous-empty">Could not load your games.</div>}

      {list.status === 'ready' && (list.data?.length ?? 0) === 0 && (
        <div className="famous-empty">No saved games yet. Finish a game and it lands here.</div>
      )}

      {list.status === 'ready' && (list.data?.length ?? 0) > 0 && (
        <ul className="ug-rows">
          {(list.data ?? []).map((g) => {
            const outcome = userOutcome(g)
            const acc = userAccuracy(g)
            return (
              <li key={g.id}>
                <button type="button" className="ug-row" onClick={() => onLoadGame(g)}>
                  {outcome !== 'unknown' ? (
                    <span className={`ug-chip ug-chip-${outcome}`}>{outcomeLabel(outcome)}</span>
                  ) : (
                    <span className="ug-chip ug-chip-open num">{g.result ?? '*'}</span>
                  )}
                  <span className="ug-main">
                    <span className="ug-opponent">
                      <span className="ug-vs muted">vs</span> {opponentName(g)}
                    </span>
                    <span className="ug-meta muted small">
                      <span className="num">{formatDate(g.created_at)}</span>
                      {acc != null && (
                        <>
                          <span className="ug-dot">·</span>
                          <span className="num">{acc.toFixed(1)}% acc</span>
                        </>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
