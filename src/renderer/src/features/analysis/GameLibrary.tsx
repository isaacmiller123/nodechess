import { useEffect, useMemo, useState, type JSX } from 'react'
import type { FamousGameMeta, GameRow } from '@shared/types'
import { detailToPgn, groupGames } from './famousData'
import { parsePgnToGame, type LoadedGame } from './shareGame'

type Loadable<T> = { status: 'loading' | 'ready' | 'error'; data: T | null }

export interface GameLibraryProps {
  /** A saved row: Analysis re-runs reviews under its id and orients to the
   *  side the user played, so it takes the row rather than a parsed game. */
  onLoadSavedGame: (row: GameRow) => void
  /** A famous game, already parsed into a mainline. */
  onLoadGame: (game: LoadedGame) => void
}

/** Score as it is written, not as it is stored. */
function resultText(result: string | null | undefined): string {
  if (result === '1-0') return '1–0'
  if (result === '0-1') return '0–1'
  if (result === '1/2-1/2') return '½–½'
  return '*'
}

/** How the game went for the user. Needs a known colour and a decided game. */
function userOutcome(row: GameRow): string | null {
  const r = row.result
  if (r === '1/2-1/2') return 'Draw'
  if (r !== '1-0' && r !== '0-1') return null
  const uc = row.user_color
  if (uc !== 'white' && uc !== 'black') return null
  return (r === '1-0') === (uc === 'white') ? 'Win' : 'Loss'
}

/** The user's own accuracy, present only once a review has stored one. */
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
 * The two ways a game gets onto the board, under one segmented control: the
 * archive of games you played, and the 79 famous games that ship with the app.
 * Both are the same row, so both are the same object on screen.
 */
export function GameLibrary({ onLoadSavedGame, onLoadGame }: GameLibraryProps): JSX.Element {
  const [tab, setTab] = useState<'mine' | 'famous'>('mine')

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Game library</h2>
        <span className="sec-count">Open one on the board</span>
      </div>

      <div className="panel">
        <div className="an-libhead">
          <div className="segmented" role="group" aria-label="Game library source">
            <button
              className="seg"
              type="button"
              aria-pressed={tab === 'mine'}
              onClick={() => setTab('mine')}
            >
              Your games
            </button>
            <button
              className="seg"
              type="button"
              aria-pressed={tab === 'famous'}
              onClick={() => setTab('famous')}
            >
              Famous
            </button>
          </div>
        </div>

        {tab === 'mine' ? (
          <MyGames onLoadSavedGame={onLoadSavedGame} />
        ) : (
          <FamousGames onLoadGame={onLoadGame} />
        )}
      </div>
    </section>
  )
}

function MyGames({
  onLoadSavedGame
}: {
  onLoadSavedGame: (row: GameRow) => void
}): JSX.Element {
  const [list, setList] = useState<Loadable<GameRow[]>>({ status: 'loading', data: null })

  useEffect(() => {
    const api = window.api?.games
    if (!api) {
      setList({ status: 'error', data: null })
      return
    }
    let cancelled = false
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

  if (list.status === 'loading') {
    return (
      <div className="empty" role="status">
        <p className="empty-line">Looking for your saved games.</p>
      </div>
    )
  }

  if (list.status === 'error') {
    return (
      <div className="empty">
        <p className="empty-line">Could not load your games.</p>
      </div>
    )
  }

  const games = list.data ?? []
  if (games.length === 0) {
    return (
      <div className="empty">
        <p className="empty-line">You have not saved a game yet.</p>
        <p className="empty-line">Finish a game and it lands here, ready to review.</p>
      </div>
    )
  }

  return (
    <>
      {games.map((g) => {
        const outcome = userOutcome(g)
        const acc = userAccuracy(g)
        const sub = [outcome, formatDate(g.created_at), acc != null ? `${acc.toFixed(1)}% acc` : null]
          .filter(Boolean)
          .join(' · ')
        return (
          <button className="an-lib" type="button" key={g.id} onClick={() => onLoadSavedGame(g)}>
            <span>
              <span className="an-lib-name">
                {g.white_name ?? 'White'} – {g.black_name ?? 'Black'}
              </span>
              <span className="an-lib-sub">{sub}</span>
            </span>
            <span className="an-lib-res">{resultText(g.result)}</span>
          </button>
        )
      })}
    </>
  )
}

function FamousGames({ onLoadGame }: { onLoadGame: (game: LoadedGame) => void }): JSX.Element {
  const [list, setList] = useState<Loadable<FamousGameMeta[]>>({ status: 'loading', data: null })
  const [openError, setOpenError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)

  useEffect(() => {
    const api = window.api?.famous
    if (!api) {
      setList({ status: 'error', data: null })
      return
    }
    let cancelled = false
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

  // Three eras, in order, each with its own head. v1 drew four rows in a flat
  // list; the real library is 79, which needs the landmarks.
  const sections = useMemo(() => groupGames(list.data ?? []), [list.data])

  const open = (id: string): void => {
    const api = window.api?.famous
    if (!api || opening !== null) return // one load at a time; no row is greyed out for it
    setOpening(id)
    setOpenError(null)
    api
      .get(id)
      .then((r) => {
        if (!r.game) {
          setOpenError('That game could not be loaded.')
          return
        }
        const loaded = parsePgnToGame(detailToPgn(r.game))
        if (!loaded) {
          setOpenError('That game could not be read.')
          return
        }
        onLoadGame(loaded)
      })
      .catch(() => setOpenError('That game could not be loaded.'))
      .finally(() => setOpening(null))
  }

  if (list.status === 'loading') {
    return (
      <div className="empty" role="status">
        <p className="empty-line">Opening the games library.</p>
      </div>
    )
  }

  if (list.status === 'error') {
    return (
      <div className="empty">
        <p className="empty-line">Could not load the games library.</p>
      </div>
    )
  }

  if (sections.length === 0) {
    return (
      <div className="empty">
        <p className="empty-line">No famous games are available yet.</p>
      </div>
    )
  }

  return (
    <>
      {openError && (
        <div className="empty" role="alert">
          <p className="empty-line">{openError}</p>
        </div>
      )}
      {sections.map((section) => (
        <div key={section.group}>
          <div className="an-libhead">
            <span className="lbl">{section.label}</span>
            <span className="an-libblurb">{section.blurb}</span>
          </div>
          {section.games.map((g) => (
            <button
              className="an-lib"
              type="button"
              key={g.id}
              title={g.significance}
              onClick={() => open(g.id)}
            >
              <span>
                <span className="an-lib-name">
                  {g.white} – {g.black}
                </span>
                <span className="an-lib-sub">
                  {[g.event, g.year, g.eco].filter(Boolean).join(' ')}
                </span>
              </span>
              <span className="an-lib-res">{resultText(g.result)}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
