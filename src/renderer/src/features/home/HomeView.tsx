import { useMemo, type JSX, type ReactNode } from 'react'
import { useReadoutSlot } from '../../components/Layout'
import { isWebBuild } from '../../platform'
import { useAccountsUi } from '../account/mock/store'
import { useOnlineGame } from '../play/online/useOnlineGame'
// PuzzlesView persists its active mode tab under MODE_KEY and reads it on
// mount: writing 'daily' before navigating lands the Daily row on the daily
// puzzle without a new nav target.
import { MODE_KEY as PUZZLES_MODE_KEY } from '../puzzles/modeKey'
import { useHomeData } from './useHomeData'
import {
  formatRelativeDate,
  moveCountOf,
  opponentLabelOf,
  resultChipLabel,
  resultKind,
  schoolGoLine
} from './format'
import './home.css'

/** Where Home can send you. A subset of Layout's ViewKey, so App.tsx's
 *  navigate (which takes the superset) passes straight in. */
export type HomeNavTarget = 'play' | 'puzzles' | 'analysis' | 'school' | 'settings'

export interface HomeViewProps {
  onNavigate: (view: HomeNavTarget) => void
  onOpenGame: (gameId: number) => void
}

/** v1's practice row: a name, a line of state under it, and an arrow. The
 *  design draws it as a link; navigation here is a callback, so it is a
 *  button. The sub-line is omitted rather than left blank when there is
 *  nothing true to put in it. */
function GoRow({
  name,
  sub,
  onClick
}: {
  name: string
  sub?: string | null
  onClick: () => void
}): JSX.Element {
  return (
    <button className="go" type="button" onClick={onClick}>
      <span>
        <span className="go-name">{name}</span>
        {sub ? <span className="go-sub">{sub}</span> : null}
      </span>
      <svg className="icon go-arrow" aria-hidden focusable="false">
        <use href="#i-arrow" />
      </svg>
    </button>
  )
}

export default function HomeView({ onNavigate, onOpenGame }: HomeViewProps): JSX.Element {
  const { data, loading } = useHomeData()
  const online = useOnlineGame()
  const accounts = useAccountsUi()

  const live = online.phase === 'game' || online.phase === 'hosting'
  const games = data.games
  const solved = data.summary?.puzzlesSolved ?? 0

  /* NEXT. A live session outranks everything, because returning to it is the
     only thing on this screen with a clock running. Otherwise the only line
     Home can stand behind is v1's own, and it is only true while there is
     nothing behind the account. */
  const next = useMemo<ReactNode>(() => {
    if (live) return 'Return to your game'
    if (loading) return null
    const played = data.summary?.gamesPlayed ?? 0
    return games.length === 0 && played === 0 ? 'Play your first game' : null
  }, [live, loading, data.summary, games.length])

  // The trace is the one ratio a screen is about, and Home is not about a
  // ratio. It stays at zero rather than inventing one.
  useReadoutSlot(next, null)

  /* Playing a bot runs on Stockfish. With no engine on disk the row cannot
     honour "choose a level", so it says why and points at the one place that
     fixes it. On the web there is nothing to download, so there is no CTA. */
  const engineMissing = data.datasets !== null && !data.datasets.engine
  const puzzlesMissing = data.datasets !== null && !data.datasets.puzzles

  /* Strength matching is the rated ladder, and the rated ladder needs an
     account (RatedPanel: "Rated games need an account"). Signed out, the row
     describes what is actually on offer. */
  const onlineSpec = accounts.signedIn
    ? 'Matched against someone near your strength.'
    : 'Play a friend by code, or sign in to be matched.'

  const puzzlesSub = puzzlesMissing
    ? 'Not installed yet'
    : solved > 0
      ? `${solved} solved, by theme`
      : 'By theme, or by rating'

  const streak = data.dailyStreak
  const dailySub = !streak
    ? null
    : streak.todaySolved
      ? streak.current > 1
        ? `Solved. ${streak.current} days running`
        : 'Solved today'
      : "Today's is still open"

  const openDaily = (): void => {
    try {
      localStorage.setItem(PUZZLES_MODE_KEY, 'daily')
    } catch {
      /* storage may be unavailable; the trainer still opens */
    }
    onNavigate('puzzles')
  }

  return (
    <div className="home">
      <div className="home-col">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Start a game</h2>
            <span className="sec-count">3 ways</span>
          </div>

          <div className="startrow is-first">
            <div>
              <div className="startrow-name">
                Play online <span className="tag">start here</span>
              </div>
              <div className="startrow-spec">{onlineSpec}</div>
            </div>
            <button className="btn is-primary" type="button" onClick={() => onNavigate('play')}>
              Play online
            </button>
          </div>

          <div className="startrow">
            <div>
              <div className="startrow-name">Play a bot</div>
              <div className="startrow-spec">
                {engineMissing
                  ? isWebBuild
                    ? 'Engines are coming online here in a future update.'
                    : 'Stockfish is not installed yet.'
                  : 'Eight levels. It waits as long as you need.'}
              </div>
            </div>
            {engineMissing ? (
              isWebBuild ? (
                <button className="btn" type="button" disabled>
                  Choose a level
                </button>
              ) : (
                <button className="btn" type="button" onClick={() => onNavigate('settings')}>
                  Open Settings
                </button>
              )
            ) : (
              <button className="btn" type="button" onClick={() => onNavigate('play')}>
                Choose a level
              </button>
            )}
          </div>

          <div className="startrow">
            <div>
              <div className="startrow-name">Local board</div>
              <div className="startrow-spec">Two players, one screen. Clock optional.</div>
            </div>
            <button className="btn" type="button" onClick={() => onNavigate('play')}>
              Open board
            </button>
          </div>
        </section>

        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Resume</h2>
          </div>
          <div className="well">
            <div className="empty-head">
              <span className="lbl">Opponent</span>
              <span className="lbl">Result</span>
              <span className="lbl">Moves</span>
              <span className="lbl">When</span>
            </div>

            {/* The one genuinely resumable thing in the app: a live session,
                which is in memory rather than in the archive. It takes the
                marked row so it reads as the current one. */}
            {live && (
              <button
                type="button"
                className="hm-row is-here"
                onClick={() => onNavigate('play')}
              >
                <span className="g-name">
                  {online.phase === 'hosting' ? 'Waiting for an opponent' : online.opponentName}
                </span>
                <span className="hm-res is-live">
                  {online.phase === 'hosting' ? 'Hosting' : 'In play'}
                </span>
                <span className="hm-num">
                  {online.phase === 'game' ? Math.ceil(online.plyCount / 2) : ''}
                </span>
                <span className="hm-num">now</span>
              </button>
            )}

            {games.map((g) => {
              const kind = resultKind(g)
              const moves = moveCountOf(g.pgn)
              return (
                <button
                  key={g.id}
                  type="button"
                  className="hm-row"
                  onClick={() => onOpenGame(g.id)}
                >
                  <span className="g-name">{opponentLabelOf(g)}</span>
                  <span
                    className={`hm-res${kind === 'win' ? ' is-win' : kind === 'loss' ? ' is-loss' : ''}`}
                  >
                    {resultChipLabel(kind)}
                  </span>
                  <span className="hm-num">{moves ?? ''}</span>
                  <span className="hm-num">{formatRelativeDate(g.created_at)}</span>
                </button>
              )
            })}

            {/* Only once the archive has actually answered. Saying "nothing"
                before anyone has looked is a claim, not an empty state. */}
            {!loading && !live && games.length === 0 && (
              <div className="empty">
                <p className="empty-line">Nothing to resume yet.</p>
                <p className="empty-line">Finished games land here, newest first.</p>
              </div>
            )}
          </div>
        </section>
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Practice</h2>
          </div>
          <div className="panel golist">
            <GoRow name="Puzzles" sub={puzzlesSub} onClick={() => onNavigate('puzzles')} />
            <GoRow
              name="School"
              sub={schoolGoLine(data.chapters, data.mastery)}
              onClick={() => onNavigate('school')}
            />
            <GoRow
              name="Analysis"
              sub="Paste a game or set up a position"
              onClick={() => onNavigate('analysis')}
            />
            {/* A dated capability v1 never drew: one puzzle a day, the same one
                for everyone, with a streak behind it. It only exists while the
                library is on disk, so it only appears then. */}
            {data.datasets?.puzzles && (
              <GoRow name="Daily puzzle" sub={dailySub} onClick={openDaily} />
            )}
          </div>
        </section>
      </aside>
    </div>
  )
}
