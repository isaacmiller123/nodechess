import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode
} from 'react'
import { Logo } from './Logo'
import { IconSprite } from './IconSprite'
import { useReadout } from './useReadout'

export type ViewKey =
  | 'home'
  | 'play'
  | 'games'
  | 'analysis'
  | 'puzzles'
  | 'school'
  | 'openings'
  | 'progress'
  | 'account'
  | 'settings'

type NavEntry = { key: ViewKey; label: string; icon: string }

/* THE RAIL, from design-lab/v1. Nine destinations without a wall of words:
   three groups, hairline separated, deliberately unlabelled. Play and Home are
   what you came for, the middle group is where you learn, the last is where you
   look back. Account sits in the foot and Settings in the tool row, because
   those are where you go to change the thing rather than to use it. */
const RAIL_GROUPS: NavEntry[][] = [
  [
    { key: 'home', label: 'Home', icon: 'i-home' },
    { key: 'play', label: 'Play', icon: 'i-play' }
  ],
  [
    { key: 'games', label: 'Games', icon: 'i-games' },
    { key: 'puzzles', label: 'Puzzles', icon: 'i-puzzles' },
    { key: 'school', label: 'School', icon: 'i-school' },
    { key: 'openings', label: 'Openings', icon: 'i-openings' }
  ],
  [
    { key: 'analysis', label: 'Analysis', icon: 'i-analysis' },
    { key: 'progress', label: 'Progress', icon: 'i-progress' }
  ]
]

const ACCOUNT_ENTRY: NavEntry = { key: 'account', label: 'Account', icon: 'i-account' }

/* PHONE NAVIGATION. Ten destinations are not five words in a bottom bar and
   they are not a hamburger in the top left, where no thumb reaches. The four
   opened every session are permanent tabs; the fifth lifts a sheet carrying the
   other six. Everything a thumb needs is at the bottom of the screen, which is
   the only part of a 390px phone a thumb owns. */
const TABS: NavEntry[] = [
  { key: 'home', label: 'Home', icon: 'i-home' },
  { key: 'play', label: 'Play', icon: 'i-play' },
  { key: 'puzzles', label: 'Puzzles', icon: 'i-puzzles' },
  { key: 'school', label: 'School', icon: 'i-school' }
]

const SHEET: NavEntry[] = [
  { key: 'games', label: 'Games', icon: 'i-games' },
  { key: 'openings', label: 'Openings', icon: 'i-openings' },
  { key: 'analysis', label: 'Analysis', icon: 'i-analysis' },
  { key: 'progress', label: 'Progress', icon: 'i-progress' },
  ACCOUNT_ENTRY,
  { key: 'settings', label: 'Settings', icon: 'i-settings' }
]

const SHEET_KEYS = SHEET.map((s) => s.key)
const RAIL_STORE = 'nc.rail'

/** All ten destinations, flat, in rail order. The command palette reads this
 *  so there is one list of places you can go rather than two that drift. */
export const DESTINATIONS: readonly NavEntry[] = [
  ...RAIL_GROUPS.flat(),
  ACCOUNT_ENTRY,
  { key: 'settings', label: 'Settings', icon: 'i-settings' }
]

function Icon({ id, className = 'icon' }: { id: string; className?: string }): JSX.Element {
  return (
    <svg className={className} aria-hidden focusable="false">
      <use href={`#${id}`} />
    </svg>
  )
}

/** What a screen contributes to the readout it is sitting under. */
export interface ReadoutSlot {
  next?: ReactNode
  trace?: number | null
}

const ReadoutSlotCtx = createContext<(slot: ReadoutSlot) => void>(() => {})

/**
 * Fill the readout's NEXT field, and optionally its trace, from inside a view.
 *
 * v1 writes a different NEXT on almost every page ("Pick a way to play",
 * "Solve 16 more to set your puzzle rating", "Take back d3 and castle"),
 * because the one thing to do next is a property of the screen you are on. A
 * view calls this with something TRUE about its own state, or does not call it
 * at all and lets the shell fall back. It must never be given a sentence the
 * app cannot stand behind.
 *
 * `trace` is 0..1 and drives the 1px line under the strip. Pass null when the
 * screen has no proportion worth reporting; a made-up one is worse than none.
 */
export function useReadoutSlot(next: ReactNode, trace: number | null = null): void {
  const set = useContext(ReadoutSlotCtx)
  useEffect(() => {
    set({ next, trace })
    return () => set({})
  }, [set, next, trace])
}

export interface LayoutProps {
  active: ViewKey
  onNavigate: (v: ViewKey) => void
  /** The readout's NEXT field: the one thing this screen says to do next. Left
   *  out, it falls back to a line derived from real state, or to nothing. */
  next?: ReactNode
  /** The readout's trace, 0..1. A real proportion or nothing: the 1px line is
   *  the only quantitative graphic in the chrome and it does not guess. */
  trace?: number | null
  /** A live online game is running while this is not the Play screen. */
  playPulse?: boolean
  children: ReactNode
}

/**
 * The shell, transcribed from design-lab/v1.
 *
 * .app is a two track grid: the rail, whose own width is the animated thing
 * when it collapses, and the content column, which carries the readout strip
 * and then the page. That is v1's structure exactly, including the fact that
 * the readout belongs to the content column rather than sitting as a band under
 * a top bar, so PLAYER lines up with the first section head on every screen.
 *
 * THE MARK. v1's rail-head references a `#mark` rook symbol. The shipping rail
 * draws the quorum logo from Logo.tsx instead: that mark is the approved one
 * and the rook in the mockups was standing in for it. At 16px Logo resolves to
 * its own reduced rook form, which is the same silhouette at the same size.
 */
export function Layout({
  active,
  onNavigate,
  next,
  trace = null,
  playPulse = false,
  children
}: LayoutProps): JSX.Element {
  const readout = useReadout()
  const [slot, setSlot] = useState<ReadoutSlot>({})
  const [sheetOpen, setSheetOpen] = useState(false)
  const [railMin, setRailMin] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.rail === 'min'
  )

  const inSheet = SHEET_KEYS.includes(active)

  /* data-rail is set on <html> by the pre-paint snippet in index.html and owned
     by React from here on, so the two never disagree about which state the rail
     is in. Collapse is chrome rather than a preference, which is why it lives
     under its own key instead of inside the settings blob. */
  const toggleRail = useCallback(() => {
    setRailMin((min) => {
      const nextMin = !min
      if (nextMin) document.documentElement.setAttribute('data-rail', 'min')
      else document.documentElement.removeAttribute('data-rail')
      try {
        localStorage.setItem(RAIL_STORE, nextMin ? 'min' : 'full')
      } catch {
        /* storage may be unavailable */
      }
      return nextMin
    })
  }, [])

  const closeSheet = useCallback(() => setSheetOpen(false), [])

  /* v1 puts the sheet's open state on <body>, and shell.css reads it there to
     lift the sheet and fade the scrim in. */
  useEffect(() => {
    document.body.classList.toggle('sheet-open', sheetOpen)
    return () => document.body.classList.remove('sheet-open')
  }, [sheetOpen])

  useEffect(() => {
    if (!sheetOpen) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeSheet()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sheetOpen, closeSheet])

  /* Leaving the phone layout with the sheet up would strand it off screen with
     no tab bar left to close it from. */
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const wide = window.matchMedia('(min-width: 721px)')
    const sync = (): void => {
      if (wide.matches) setSheetOpen(false)
    }
    sync()
    wide.addEventListener('change', sync)
    return () => wide.removeEventListener('change', sync)
  }, [])

  /* A NOTE FOR WHOEVER DEBUGS A BOARD THAT DROPS PIECES ON THE WRONG SQUARE.
     chessground caches the board's bounding rect and clears it on window resize
     and on a scroll listener bound to `document` with capture: true
     (chessground/src/events.ts). Making .content the scroller instead of the
     window looks like it should break that, and it does not: a scroll event
     fired at a descendant still runs the capture path through document, so the
     memo is cleared. Measured, with a real scroll: one scroll event on .content
     produces exactly one capture hit on document.
     Measure this in a VISIBLE tab. A backgrounded tab is throttled and fires no
     scroll events at all, which reads as a broken listener and is not one. */

  const go = (key: ViewKey): void => {
    setSheetOpen(false)
    onNavigate(key)
  }

  /* NEXT falls back to the only thing that is true of an account with nothing
     behind it yet. A screen that knows better supplies its own (useReadoutSlot);
     a screen with nothing true to say leaves the slot out rather than filling
     it. Precedence: an explicit prop, then the current screen, then the
     fallback. */
  const nextText = next ?? slot.next ?? (readout.games === 0 ? 'Play your first game' : null)
  const traceValue = trace ?? slot.trace ?? null

  const railLink = (n: NavEntry): JSX.Element => {
    const isActive = active === n.key
    const pulse = n.key === 'play' && playPulse
    return (
      <button
        key={n.key}
        type="button"
        className={`rail-link${isActive ? ' is-here' : ''}`}
        aria-current={isActive ? 'page' : undefined}
        title={n.label}
        onClick={() => onNavigate(n.key)}
      >
        <span className="rail-icon-wrap">
          <Icon id={n.icon} className="icon rail-icon" />
          {pulse && <span className="rail-live-dot" aria-hidden />}
        </span>
        <span className="rail-label">{n.label}</span>
        {pulse && <span className="vh"> (online game in progress)</span>}
      </button>
    )
  }

  return (
    <>
      <IconSprite />

      <div className="app">
        {/* ================= THE RAIL ================= */}
        <nav className="rail" aria-label="Main">
          <button
            type="button"
            className="rail-head"
            onClick={() => onNavigate('home')}
            title="nodechess"
          >
            {/* THE MARK. v1 references a 16px `#mark` rook, which was a
                placeholder: the approved mark is the quorum lattice in
                Logo.tsx. It is drawn in full here, at 28, because below about
                25 the lattice stops resolving and there is no surface left for
                the wave to cross. Collapsed, the rail is 56px wide and there is
                no room for it, so Logo falls to its own reduced rook at 20,
                which is the silhouette v1 drew in the first place. */}
            <span className="rail-mark">
              <Logo size={railMin ? 20 : 28} motion="both" />
            </span>
            {/* node is bold, chess is regular, one word, no space between them
                and no colour change. The weight is the only division. */}
            <span className="rail-word nc-word">
              <span className="nc-word-a">node</span>
              <span className="nc-word-b">chess</span>
            </span>
          </button>

          <div className="rail-nav">
            {RAIL_GROUPS.map((group, i) => (
              <div className="rail-group" key={i}>
                {group.map(railLink)}
              </div>
            ))}
          </div>

          <div className="rail-foot">
            {railLink(ACCOUNT_ENTRY)}

            {/* v1 put eight palette swatches here, on every page. They are gone
                on purpose. A palette is chosen once and then lived in, so a
                permanent row of eight chips spends the most valuable strip in
                the product on a decision nobody makes twice, and it read as
                navigation sitting directly under Account. Settings owns the
                eight, where each one has its name and a line saying what it is
                for, which a 12px chip could never carry. */}

            <div className="rail-tools">
              <button
                type="button"
                className={`rail-tool${active === 'settings' ? ' is-here' : ''}`}
                aria-current={active === 'settings' ? 'page' : undefined}
                title="Settings"
                onClick={() => onNavigate('settings')}
              >
                <Icon id="i-settings" />
                <span className="rail-tool-label">Settings</span>
              </button>
              <button
                className="rail-tool rail-toggle"
                type="button"
                title={railMin ? 'Expand' : 'Collapse'}
                aria-expanded={!railMin}
                onClick={toggleRail}
              >
                <Icon id="i-chev" />
                <span className="vh">{railMin ? 'Expand sidebar' : 'Collapse sidebar'}</span>
              </button>
            </div>
          </div>
        </nav>

        {/* ================= CONTENT ================= */}
        <div className="content">
          {/* Phone only: the rail is gone, so the brand needs a home. */}
          <header className="topbar-m">
            <span className="rail-mark">
              <Logo size={24} motion="both" />
            </span>
            {/* node is bold, chess is regular, one word, no space between them
                and no colour change. The weight is the only division. */}
            <span className="rail-word nc-word">
              <span className="nc-word-a">node</span>
              <span className="nc-word-b">chess</span>
            </span>
          </header>

          {/* THE READOUT. The same four slots on every screen. Everything in it
              is real or absent: no handle until there is an account, no rating
              and no count until the summary has actually loaded. v1 drew a
              1500 here and the app has no such number, so it reports the one it
              has. */}
          <div className="readout">
            <div className="rd-field">
              <span className="lbl">Player</span>
              {readout.handle ? (
                <span className="rd-value">{readout.handle}</span>
              ) : (
                <button
                  type="button"
                  className="rd-value is-quiet"
                  onClick={() => onNavigate('account')}
                >
                  Not signed in
                </button>
              )}
            </div>
            <div className="rd-field">
              <span className="lbl">Rating</span>
              {readout.rating === null ? (
                <span className="rd-value is-quiet">{readout.loading ? '' : 'unrated'}</span>
              ) : (
                <>
                  <span className="rd-value">{readout.rating}</span>
                  {readout.provisional && <span className="rd-value is-quiet">provisional</span>}
                </>
              )}
            </div>
            <div className="rd-field">
              <span className="lbl">Games</span>
              <span className="rd-value">{readout.games ?? ''}</span>
            </div>
            {nextText !== null && (
              <div className="rd-field is-next">
                <span className="lbl">Next</span>
                <span className="rd-next-text">{nextText}</span>
              </div>
            )}
            <div
              className={`trace${traceValue === null ? ' is-0' : ''}`}
              style={
                traceValue === null
                  ? undefined
                  : ({ '--trace-w': `${Math.round(traceValue * 100)}%` } as CSSProperties)
              }
              aria-hidden
            />
          </div>

          <main className="main" id="main-content" tabIndex={-1}>
            <ReadoutSlotCtx.Provider value={setSlot}>{children}</ReadoutSlotCtx.Provider>
          </main>
        </div>
      </div>

      {/* ================= PHONE NAVIGATION ================= */}
      <button type="button" className="scrim" tabIndex={-1} aria-hidden onClick={closeSheet} />

      <div
        className="sheet"
        id="sheet"
        role="group"
        aria-label="More destinations"
        inert={!sheetOpen}
      >
        {SHEET.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`sheet-link${active === s.key ? ' is-here' : ''}`}
            aria-current={active === s.key ? 'page' : undefined}
            onClick={() => go(s.key)}
          >
            <Icon id={s.icon} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>

      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => {
          const isActive = active === t.key
          const pulse = t.key === 'play' && playPulse
          return (
            <button
              key={t.key}
              type="button"
              className={`tab${isActive ? ' is-here' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => go(t.key)}
            >
              <span className="rail-icon-wrap">
                <Icon id={t.icon} />
                {pulse && <span className="rail-live-dot" aria-hidden />}
              </span>
              {t.label}
            </button>
          )
        })}
        <button
          type="button"
          className={`tab${inSheet ? ' is-here' : ''}`}
          aria-expanded={sheetOpen}
          aria-controls="sheet"
          aria-current={inSheet ? 'page' : undefined}
          onClick={() => setSheetOpen((o) => !o)}
        >
          <Icon id="i-more" />
          More
        </button>
      </nav>
    </>
  )
}
