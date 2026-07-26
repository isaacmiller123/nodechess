import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { DESTINATIONS, type ViewKey } from './Layout'
import { OverlayDialog } from './OverlayDialog'

export interface CommandPaletteProps {
  onClose: () => void
  onNavigate: (view: ViewKey) => void
}

type CommandKind = 'nav' | 'action'

interface Command {
  id: string
  label: string
  sub: string
  keywords: string
  /** A symbol id in the v1 sprite (IconSprite.tsx), not a component. The whole
   *  shell draws from that one sheet, so the palette does too. */
  icon: string
  kind: CommandKind
  run: () => void
}

/**
 * Quick actions jump to the view that owns the action. The renderer talks to
 * main only via window.api and there is no cross-view command bus we may add
 * here (feature views are out of this unit's scope), so "New game", "Random
 * puzzle", and "Analyze position" route to Play / Puzzles / Analysis, which is
 * where each flow begins.
 */
const ACTIONS: { id: string; label: string; sub: string; keywords: string; icon: string; view: ViewKey }[] = [
  { id: 'action-new-game', label: 'New game', sub: 'Play', keywords: 'play new game start match bot stockfish', icon: 'i-play', view: 'play' },
  { id: 'action-random-puzzle', label: 'Random puzzle', sub: 'Puzzles', keywords: 'puzzle random train tactics', icon: 'i-puzzles', view: 'puzzles' },
  { id: 'action-analyze', label: 'Analyze position', sub: 'Analysis', keywords: 'analyze analysis engine position evaluate fen', icon: 'i-analysis', view: 'analysis' }
]

export function CommandPalette({ onClose, onNavigate }: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const commands = useMemo<Command[]>(() => {
    const go = (view: ViewKey) => () => {
      onNavigate(view)
      onClose()
    }
    // DESTINATIONS is all ten, Settings included, so there is nothing to append
    // here and no second list to keep in step with the rail.
    const navCommands: Command[] = DESTINATIONS.map(({ key, label, icon }) => ({
      id: `nav-${key}`,
      label,
      sub: 'Go to',
      keywords: `${label} ${key} go to navigate open view`,
      icon,
      kind: 'nav',
      run: go(key)
    }))
    const actionCommands: Command[] = ACTIONS.map((a) => ({
      id: a.id,
      label: a.label,
      sub: a.sub,
      keywords: a.keywords,
      icon: a.icon,
      kind: 'action',
      run: go(a.view)
    }))
    return [...actionCommands, ...navCommands]
  }, [onNavigate, onClose])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    const terms = q.split(/\s+/)
    return commands.filter((c) => {
      const hay = `${c.label} ${c.keywords}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [commands, query])

  // Keep the highlighted index valid whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1))
  }, [activeIndex, results.length])

  // Keep the active option scrolled into view.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, results])

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      results[activeIndex]?.run()
    }
  }

  // Split for labelled groups while preserving the flat index used by the keyboard.
  const firstNavIndex = results.findIndex((c) => c.kind === 'nav')
  const hasActions = results.some((c) => c.kind === 'action')
  const hasNav = firstNavIndex !== -1

  return (
    <OverlayDialog onClose={onClose} placement="top" className="cmdk" label="Command palette">
      <div className="cmdk-search">
        <svg className="icon cmdk-search-icon" aria-hidden focusable="false">
          <use href="#i-more" />
        </svg>
        <input
          className="cmdk-input"
          type="text"
          autoFocus
          value={query}
          placeholder="Search views and actions"
          aria-label="Search views and actions"
          aria-controls="cmdk-listbox"
          aria-activedescendant={results[activeIndex]?.id}
          role="combobox"
          aria-expanded
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        <span className="cmdk-hint">Esc</span>
      </div>

      {results.length === 0 ? (
        <div className="cmdk-empty">No matches for &ldquo;{query}&rdquo;</div>
      ) : (
        <ul className="cmdk-list" id="cmdk-listbox" role="listbox" ref={listRef} aria-label="Commands">
          {results.map((c, i) => {
            const showActionsLabel = hasActions && i === 0 && c.kind === 'action'
            const showNavLabel = hasNav && i === firstNavIndex
            const active = i === activeIndex
            return (
              <li key={c.id} role="presentation">
                {showActionsLabel && (
                  <div className="cmdk-group-label" role="presentation">
                    Quick actions
                  </div>
                )}
                {showNavLabel && (
                  <div className="cmdk-group-label" role="presentation">
                    Navigate
                  </div>
                )}
                <button
                  type="button"
                  id={c.id}
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  className={`cmdk-option${active ? ' is-active' : ''}`}
                  onClick={c.run}
                  onMouseMove={() => setActiveIndex(i)}
                >
                  <span className="cmdk-option-icon">
                    <svg className="icon" aria-hidden focusable="false">
                      <use href={`#${c.icon}`} />
                    </svg>
                  </span>
                  <span className="cmdk-option-label">{c.label}</span>
                  <span className="cmdk-option-sub">{c.sub}</span>
                  {active && (
                    <svg className="icon cmdk-option-sub" aria-hidden focusable="false">
                      <use href="#i-arrow" />
                    </svg>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </OverlayDialog>
  )
}
