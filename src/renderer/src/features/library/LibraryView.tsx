// Library. Every saved game from every mode, one list (games:listAll).
// Filter chips: game kind (from the DB's own kind counts), mode/source,
// outcome (user-relative, client-side: it needs user_color per row). Chess
// rows route to the full Analysis/review view; every other kind opens the
// GameReplayView on the kind's real board.

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { Library as LibraryIcon, RefreshCw } from 'lucide-react'
import type { GameRow, ListAllGamesResult } from '@shared/types'
import type { GameKind } from '../../games/kernel'
import { getGame, isRegisteredGame } from '../../games/registry'
import { GameReplayView } from './GameReplayView'
import './library.css'

const PAGE = 60

type Outcome = 'win' | 'loss' | 'draw' | 'unknown'
type OutcomeFilter = 'all' | 'win' | 'loss' | 'draw'

/** Result of a game from the USER's perspective (mirrors Analysis's browser). */
function userOutcome(row: GameRow): Outcome {
  const r = row.result
  if (r === '1/2-1/2') return 'draw'
  if (r !== '1-0' && r !== '0-1') return 'unknown'
  const uc = row.user_color
  if (uc !== 'white' && uc !== 'black') return 'unknown'
  const won = (r === '1-0' && uc === 'white') || (r === '0-1' && uc === 'black')
  return won ? 'win' : 'loss'
}

/** Display title for a game kind chip/badge. */
function kindTitle(kind: string): string {
  if (isRegisteredGame(kind)) {
    const t = getGame(kind as GameKind)?.spec.title
    if (t) return t
  }
  if (kind.startsWith('custom-')) return 'Variant Lab'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** Display label for a source/mode value. */
function sourceLabel(source: string): string {
  switch (source) {
    case 'play':
      return 'vs Bot'
    case 'online':
      return 'Online'
    case 'otb':
      return 'Local OTB'
    case 'bot':
      return 'vs Bot'
    default:
      return source.charAt(0).toUpperCase() + source.slice(1)
  }
}

function opponentLine(row: GameRow): string {
  if (row.opponent_label) return `vs ${row.opponent_label}`
  const w = row.white_name
  const b = row.black_name
  if (row.user_color === 'white' && b) return `vs ${b}`
  if (row.user_color === 'black' && w) return `vs ${w}`
  if (w || b) return `${w ?? 'White'} vs ${b ?? 'Black'}`
  return 'Local game'
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

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: ListAllGamesResult; exhausted: boolean }

export default function LibraryView({
  onOpenChessGame
}: {
  /** Route a chess row into the full Analysis/review view (App.openGame). */
  onOpenChessGame: (gameId: number) => void
}): JSX.Element {
  const [kindFilter, setKindFilter] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all')
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [replayRow, setReplayRow] = useState<GameRow | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const fetchPage = useCallback(
    async (offset: number): Promise<ListAllGamesResult | null> => {
      const api = window.api?.games
      if (!api?.listAll) return null
      return api.listAll({
        kind: kindFilter ?? undefined,
        source: sourceFilter ?? undefined,
        limit: PAGE,
        offset
      })
    },
    [kindFilter, sourceFilter]
  )

  useEffect(() => {
    let cancelled = false
    setLoad({ status: 'loading' })
    fetchPage(0)
      .then((r) => {
        if (cancelled) return
        if (!r) setLoad({ status: 'error' })
        else setLoad({ status: 'ready', data: r, exhausted: r.games.length < PAGE })
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [fetchPage, refreshNonce])

  const loadMore = useCallback(() => {
    if (load.status !== 'ready' || load.exhausted) return
    const offset = load.data.games.length
    void fetchPage(offset)
      .then((r) => {
        if (!r) return
        setLoad((prev) => {
          if (prev.status !== 'ready') return prev
          return {
            status: 'ready',
            data: { ...r, games: [...prev.data.games, ...r.games] },
            exhausted: r.games.length < PAGE
          }
        })
      })
      .catch(() => {})
  }, [load, fetchPage])

  const rows = useMemo(() => {
    if (load.status !== 'ready') return []
    if (outcomeFilter === 'all') return load.data.games
    return load.data.games.filter((g) => userOutcome(g) === outcomeFilter)
  }, [load, outcomeFilter])

  if (replayRow) {
    return <GameReplayView row={replayRow} onBack={() => setReplayRow(null)} />
  }

  const kinds = load.status === 'ready' ? load.data.kinds : []
  const sources = load.status === 'ready' ? load.data.sources : []

  const openRow = (g: GameRow): void => {
    if (g.game_kind === 'chess') onOpenChessGame(g.id)
    else setReplayRow(g)
  }

  return (
    <div className="library-view">
      <div className="lib-toolbar">
        <div className="lib-chips" role="group" aria-label="Game kind">
          <button
            type="button"
            className={`lib-chip${kindFilter === null ? ' is-active' : ''}`}
            onClick={() => setKindFilter(null)}
          >
            All games
          </button>
          {kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`lib-chip${kindFilter === k.kind ? ' is-active' : ''}`}
              onClick={() => setKindFilter(kindFilter === k.kind ? null : k.kind)}
            >
              {kindTitle(k.kind)} <span className="lib-chip-count num">{k.count}</span>
            </button>
          ))}
        </div>
        <div className="lib-subfilters">
          {sources.length > 1 && (
            <div className="lib-chips lib-chips-sub" role="group" aria-label="Mode">
              <button
                type="button"
                className={`lib-chip is-sub${sourceFilter === null ? ' is-active' : ''}`}
                onClick={() => setSourceFilter(null)}
              >
                Any mode
              </button>
              {sources.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`lib-chip is-sub${sourceFilter === s ? ' is-active' : ''}`}
                  onClick={() => setSourceFilter(sourceFilter === s ? null : s)}
                >
                  {sourceLabel(s)}
                </button>
              ))}
            </div>
          )}
          <div className="lib-chips lib-chips-sub" role="group" aria-label="Outcome">
            {(
              [
                ['all', 'Any result'],
                ['win', 'Wins'],
                ['loss', 'Losses'],
                ['draw', 'Draws']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`lib-chip is-sub${outcomeFilter === key ? ' is-active' : ''}`}
                onClick={() => setOutcomeFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="icon-btn lib-refresh"
            title="Refresh"
            onClick={() => setRefreshNonce((n) => n + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {load.status === 'loading' && (
        <div className="lib-skeleton" aria-hidden>
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="lib-skel-row" key={i} />
          ))}
        </div>
      )}

      {load.status === 'error' && (
        <div className="lib-empty" role="alert">
          Could not load your games.
        </div>
      )}

      {load.status === 'ready' && rows.length === 0 && (
        <div className="lib-empty">
          <LibraryIcon size={22} aria-hidden />
          <p>
            {load.data.games.length === 0
              ? 'No saved games yet. Finish a game in any mode and it lands here.'
              : 'Nothing matches these filters.'}
          </p>
        </div>
      )}

      {load.status === 'ready' && rows.length > 0 && (
        <ul className="lib-rows">
          {rows.map((g) => {
            const outcome = userOutcome(g)
            return (
              <li key={g.id}>
                <button type="button" className="lib-row" onClick={() => openRow(g)}>
                  <span className={`lib-kind-badge lib-kind-${g.game_kind === 'chess' ? 'chess' : 'other'}`}>
                    {kindTitle(g.game_kind)}
                  </span>
                  {outcome !== 'unknown' ? (
                    <span className={`lib-chip-result is-${outcome}`}>
                      {outcome === 'win' ? 'Win' : outcome === 'loss' ? 'Loss' : 'Draw'}
                    </span>
                  ) : (
                    <span className="lib-chip-result is-open num">{g.result ?? '*'}</span>
                  )}
                  <span className="lib-main">
                    <span className="lib-opponent">{opponentLine(g)}</span>
                    <span className="lib-meta muted small">
                      <span className="num">{formatDate(g.created_at)}</span>
                      {g.source && (
                        <>
                          <span className="lib-dot">·</span>
                          <span>{sourceLabel(g.source)}</span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="lib-open muted small">
                    {g.game_kind === 'chess' ? 'Review' : 'Replay'} →
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {load.status === 'ready' && !load.exhausted && outcomeFilter === 'all' && (
        <button type="button" className="votb-btn lib-more" onClick={loadMore}>
          Load more
        </button>
      )}
    </div>
  )
}
