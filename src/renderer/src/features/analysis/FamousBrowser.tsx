import { useEffect, useMemo, useState, type JSX } from 'react'
import type { FamousGameMeta } from '@shared/types'
import { detailToPgn, groupGames, resultTone } from './famousData'
import { parsePgnToGame, type LoadedGame } from './shareGame'

type Loadable<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; data: T | null }

export interface FamousBrowserProps {
  /** Load a chosen famous game's mainline into the Analysis tree. */
  onLoadGame: (game: LoadedGame) => void
}

/**
 * Library-list half of the former Famous-games view, embedded in the Analysis
 * sidebar. Lists window.api.famous.list() bucketed by era; clicking a card pulls
 * the full detail, converts it to PGN, parses it into a LoadedGame, and hands it
 * up to AnalysisView.loadGame. There is NO second board here. The Analysis board
 * is the viewer.
 */
export function FamousBrowser({ onLoadGame }: FamousBrowserProps): JSX.Element {
  const [list, setList] = useState<Loadable<FamousGameMeta[]>>({ status: 'loading', data: null })
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const api = window.api?.famous
    if (!api) {
      setList({ status: 'error', data: null })
      return
    }
    let cancelled = false
    setList({ status: 'loading', data: null })
    api
      .list()
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

  const sections = useMemo(() => groupGames(list.data ?? []), [list.data])

  const openGame = (id: string): void => {
    const api = window.api?.famous
    if (!api) return
    setLoadingId(id)
    setLoadError(null)
    api
      .get(id)
      .then((r) => {
        if (!r.game) {
          setLoadError('That game could not be loaded.')
          return
        }
        const loaded = parsePgnToGame(detailToPgn(r.game))
        if (!loaded) {
          setLoadError('That game could not be read.')
          return
        }
        onLoadGame(loaded)
      })
      .catch(() => setLoadError('That game could not be loaded.'))
      .finally(() => setLoadingId(null))
  }

  return (
    <div className="famous-library">
      {list.status === 'loading' && <ListSkeleton />}

      {list.status === 'error' && (
        <div className="famous-empty">Could not load the games library.</div>
      )}

      {list.status === 'ready' && (list.data?.length ?? 0) === 0 && (
        <div className="famous-empty">No famous games are available yet.</div>
      )}

      {loadError && (
        <p className="famous-load-error small" role="alert">
          {loadError}
        </p>
      )}

      {list.status === 'ready' &&
        sections.map((section) => (
          <section className="famous-section" key={section.group}>
            <header className="famous-section-head">
              <span className="famous-section-label">{section.label}</span>
              <span className="famous-section-blurb muted small">{section.blurb}</span>
            </header>
            <ul className="famous-cards">
              {section.games.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    className={`card famous-card ${g.id === loadingId ? 'is-loading' : ''}`}
                    disabled={loadingId !== null}
                    onClick={() => openGame(g.id)}
                  >
                    <div className="famous-card-top">
                      <span className="famous-card-players">
                        {g.white} <span className="famous-vs muted">vs</span> {g.black}
                      </span>
                      <span className={`fg-result-chip fg-result-${resultTone(g.result)}`}>
                        {g.result}
                      </span>
                    </div>
                    <div className="famous-card-meta muted small">
                      <span className="famous-card-event">{g.event}</span>
                      <span className="famous-card-dot">·</span>
                      <span className="num">{g.year}</span>
                      {g.eco && (
                        <>
                          <span className="famous-card-dot">·</span>
                          <span className="num">{g.eco}</span>
                        </>
                      )}
                    </div>
                    {g.significance && <div className="famous-card-sig small">{g.significance}</div>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  )
}

function ListSkeleton(): JSX.Element {
  return (
    <div className="famous-skeleton" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="famous-skel-card" key={i} />
      ))}
    </div>
  )
}
