import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { CATALOG, GROUPS, haystack, type CatalogEntry } from './catalog'
import { GmArt } from './gmArt'
import { GameSetup } from './GameSetup'
import { GamePage, ManualPage } from './GamePage'
import type { GameLaunch } from './setup'
import './games.css'
import './play-surfaces.css'

// Variant Lab (features/games/editor), code-split: the builder + ffish tooling
// only load when the user opens the Lab.
const EditorView = lazy(() => import('./editor/EditorView'))
// Library (features/library), code-split: the archive list + replay viewer
// only load when the user opens the saved games.
const LibraryView = lazy(() => import('../library/LibraryView'))

/* THE GAMES LIBRARY, from design-lab/v1/games.html.
 *
 * Chess by itself at the top, then three named shelves: Variants,
 * International and Other. Each shelf shows three games and keeps the rest
 * behind a dropdown that really opens. One text field narrows all twenty-four,
 * and a match inside a shut shelf opens it, because a filter that hides its own
 * results is broken.
 *
 * Picking a game opens one configuration screen (GameSetup). Nothing on this
 * page plays a game; Start hands a launch to GamePage, which owns the board. */

/** How many cards a shelf shows before the dropdown. */
const VISIBLE = 3

function plural(n: number): string {
  return `${n} ${n === 1 ? 'game' : 'games'}`
}

function Chevron(): JSX.Element {
  return (
    <svg className="icon" aria-hidden>
      <use href="#i-chev" />
    </svg>
  )
}

function Card({
  entry,
  hidden,
  hero,
  onOpen
}: {
  entry: CatalogEntry
  hidden: boolean
  hero?: boolean
  onOpen: (e: CatalogEntry) => void
}): JSX.Element {
  return (
    <button
      className={`gm-card grow${hero ? ' gm-hero' : ''}${hidden ? ' is-off' : ''}`}
      type="button"
      aria-haspopup="dialog"
      onClick={() => onOpen(entry)}
    >
      <span className="gm-art">
        <GmArt entry={entry} />
      </span>
      <span className="gm-text">
        <span className="g-name">{entry.title}</span>
        <span className="g-note">{entry.tagline}</span>
      </span>
      {hero && <span className="gm-hero-go">Set up a game</span>}
    </button>
  )
}

/**
 * Games library: the storefront, the per-game setup screen, and the two rooms
 * they open onto (the Variant Lab and the saved-game library).
 */
export default function GamesView({
  onOpenSettings,
  onOpenChessGame
}: {
  /** Deep link to the Settings view (bot engine install prompts). */
  onOpenSettings?: () => void
  /** Route a saved CHESS game into the full Analysis/review view (Library). */
  onOpenChessGame?: (gameId: number) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  // The shelves the user opened by hand. A search opens every shelf that has a
  // hit and shuts them again when the field is cleared, so this only decides
  // what an unfiltered page looks like.
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [setup, setSetup] = useState<CatalogEntry | null>(null)
  const [launch, setLaunch] = useState<GameLaunch | null>(null)
  const [manual, setManual] = useState<CatalogEntry | null>(null)
  // The Lab, opened on the start and the board the setup screen chose.
  const [lab, setLab] = useState<{
    templateId: string
    board: { files: number; ranks: number } | null
  } | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [saved, setSaved] = useState<number | null>(null)
  // Focus returns to the card that opened the screen, the way it left.
  const opener = useRef<HTMLElement | null>(null)

  /* How many finished games are in the archive. The number is the whole point
     of the row: a door to an empty room is a lie, and a door drawn before the
     count arrives is the same lie told early. null means not known yet, and
     nothing is drawn until it stops being null. An unavailable channel leaves
     it null, so a failed read shows no row rather than an invented zero. */
  useEffect(() => {
    let cancelled = false
    window.api?.games
      ?.listAll({ limit: 1 })
      .then((res) => {
        if (!cancelled) setSaved(res.kinds.reduce((n, k) => n + k.count, 0))
      })
      .catch(() => {
        /* An unavailable channel reports nothing rather than a zero. */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const terms = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query]
  )

  /* One pass over the catalog: which cards match, and how many per shelf. */
  const hits = useMemo(() => {
    const set = new Set<string>()
    for (const entry of CATALOG) {
      const hay = haystack(entry)
      if (terms.every((t) => hay.includes(t))) set.add(entry.kind)
    }
    return set
  }, [terms])

  const searching = terms.length > 0
  const shown = hits.size

  const openSetup = useCallback((entry: CatalogEntry, from?: HTMLElement | null) => {
    opener.current = from ?? (document.activeElement as HTMLElement | null)
    setSetup(entry)
  }, [])

  const closeSetup = useCallback(() => {
    setSetup(null)
    opener.current?.focus()
    opener.current = null
  }, [])

  if (lab !== null) {
    return (
      <Suspense
        fallback={
          <div className="view-loading" role="status">
            <span className="view-spinner" aria-hidden />
          </div>
        }
      >
        <EditorView
          onExit={() => setLab(null)}
          initialTemplateId={lab.templateId}
          initialBoard={lab.board ?? undefined}
        />
      </Suspense>
    )
  }

  if (libraryOpen) {
    return (
      <Suspense
        fallback={
          <div className="view-loading" role="status">
            <span className="view-spinner" aria-hidden />
          </div>
        }
      >
        <LibraryView onOpenChessGame={(id) => onOpenChessGame?.(id)} />
      </Suspense>
    )
  }

  if (launch) {
    return (
      <GamePage
        launch={launch}
        onBack={() => setLaunch(null)}
        onOpenSettings={onOpenSettings}
      />
    )
  }

  if (manual) {
    return <ManualPage entry={manual} onBack={() => setManual(null)} />
  }

  return (
    <div>
      <div className="gm-bar">
        <div className="filterbar">
          <label className="vh" htmlFor="gm-q">
            Filter games
          </label>
          <input
            className="filter-input"
            id="gm-q"
            type="search"
            autoComplete="off"
            placeholder="reversi, draughts, fischer, five in a row"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
          />
          <span className="ghead-count gm-count">
            {shown === CATALOG.length ? plural(shown) : `${shown} of ${CATALOG.length}`}
          </span>
        </div>
      </div>

      {GROUPS.map((group) => {
        const here = group.entries.filter((e) => hits.has(e.kind)).length
        // A shelf whose whole contents were filtered out is not an empty
        // shelf, it is a shelf that is not part of this answer.
        if (here === 0) return null
        const total = group.entries.length
        const more = group.entries.slice(VISIBLE)
        const isOpen = searching || opened[group.id] === true
        const panelId = `gm-more-${group.id}`

        return (
          <section className="sec gm-group" key={group.id}>
            <div className="sec-head">
              <h2 className="lbl">{group.title}</h2>
              <span className="sec-count">
                {here === total ? plural(here) : `${here} of ${total}`}
              </span>
            </div>

            <div className={`gm-grid${total === 1 ? ' gm-solo' : ''}`}>
              {group.entries.slice(0, VISIBLE).map((entry) => (
                <Card
                  key={entry.kind}
                  entry={entry}
                  hero={group.id === 'chess'}
                  hidden={!hits.has(entry.kind)}
                  onOpen={openSetup}
                />
              ))}
            </div>

            {more.length > 0 && (
              <>
                <button
                  className="gm-disc"
                  type="button"
                  aria-controls={panelId}
                  aria-expanded={isOpen}
                  onClick={() => setOpened((o) => ({ ...o, [group.id]: !isOpen }))}
                >
                  <Chevron />
                  <span className="gm-disc-shut">{more.length} more</span>
                  <span className="gm-disc-open">Show fewer</span>
                </button>

                <div className="gm-grid gm-more" id={panelId} hidden={!isOpen}>
                  {more.map((entry) => (
                    <Card
                      key={entry.kind}
                      entry={entry}
                      hidden={!hits.has(entry.kind)}
                      onOpen={openSetup}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        )
      })}

      {shown === 0 && (
        <div className="well gm-none is-on">
          <div className="empty">
            <p className="empty-line">No game here is called that.</p>
            <p className="empty-line">
              Try one word, or clear the field to see all {CATALOG.length}.
            </p>
          </div>
        </div>
      )}

      {/* Every finished game of every kind, over the board, against a bot or
          online. v1 has four shelves and this is not a fifth: it is one row of
          furniture at the foot of the four, in v1's own .panel / .go language,
          with no heading and no count of its own to make it a peer.

          It draws nothing until the archive has answered. `saved` starts null,
          which means "not known yet", and neither "there is a library" nor
          "there is nothing" is true of a number that has not arrived. */}
      {!searching && saved !== null && (
        <div className="panel">
          {saved === 0 ? (
            <div className="empty">
              <p className="empty-line">Nothing saved yet.</p>
              <p className="empty-line">Finish a game from any shelf above and it lands here.</p>
            </div>
          ) : (
            <button type="button" className="go" onClick={() => setLibraryOpen(true)}>
              <span>
                <span className="go-name">Open the library</span>
                <span className="go-sub">
                  {plural(saved)} saved. Replay any board, review any chess game
                </span>
              </span>
              <svg className="icon go-arrow" aria-hidden>
                <use href="#i-arrow" />
              </svg>
            </button>
          )}
        </div>
      )}

      {setup && (
        <GameSetup
          entry={setup}
          onClose={closeSetup}
          onStart={(l) => {
            setSetup(null)
            setLaunch(l)
          }}
          onOpenManual={() => {
            const entry = setup
            setSetup(null)
            setManual(entry)
          }}
          onOpenEditor={(templateId, board) => {
            setSetup(null)
            setLab({ templateId, board })
          }}
        />
      )}
    </div>
  )
}
