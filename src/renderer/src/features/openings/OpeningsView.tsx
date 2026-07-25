import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from 'chessops/types'
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FlipVertical2,
  RotateCcw,
  Search,
  BookOpen,
  X
} from 'lucide-react'
import { Board } from '../../board/Board'
import { PromotionPicker } from '../../board/PromotionPicker'
import { pieceSetClass } from '../../board/pieceSets'
import { useSound } from '../../sound'
import { useSettings } from '../../state/settings'
import {
  INITIAL_FEN,
  applyMove,
  checkColor,
  destsFor,
  isPromotion,
  turnColor,
  uciToLastMove,
  type Color
} from '../../chess/chess'
import {
  FAMILIES,
  OPENINGS,
  OPENING_GROUPS,
  resolveLine,
  type LineMove,
  type OpeningEntry,
  type OpeningFamily
} from './openings'
import type { OpeningInfo } from '../../../../shared/types'
import './openings.css'

const ALL_GROUPS = 'All'
/** Rendered-row budget for search results before we ask the user to refine. */
const SEARCH_LINE_CAP = 250
/** Per-family cap on variation rows rendered while a search is active. */
const FAMILY_SEARCH_CAP = 60

/** Format a SAN line into numbered move pairs, e.g. "1. e4 e5 2. Nf3". */
function formatLine(line: string[]): string {
  const parts: string[] = []
  for (let i = 0; i < line.length; i += 2) {
    const num = i / 2 + 1
    const white = line[i]
    const black = line[i + 1]
    parts.push(black ? `${num}. ${white} ${black}` : `${num}. ${white}`)
  }
  return parts.join(' ')
}

/** ECO range chip text: "B20–B99", or just "B20" for single-code families. */
function ecoRange(lo: string, hi: string): string {
  return lo === hi ? lo : `${lo}–${hi}`
}

/** One family's slice of the browser under the current group tab + query. */
interface FamilyView {
  fam: OpeningFamily
  /** Variations passing the group filter AND the query. */
  vars: OpeningEntry[]
  /** Popularity weight = lines in this family under the group tab (query-independent,
   *  so the order stays put while typing). */
  weight: number
  ecoLo: string
  ecoHi: string
}

export default function OpeningsView() {
  const { settings } = useSettings()
  const { playMove } = useSound()

  // Linear move history (each entry = a played ply). cursor is the number of
  // plies currently shown: 0 = starting position, history.length = end of line.
  const [history, setHistory] = useState<LineMove[]>([])
  const [cursor, setCursor] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)

  const [orientation, setOrientation] = useState<Color>('white')
  const [pendingPromo, setPendingPromo] = useState<{ orig: string; dest: string } | null>(null)
  const [nonce, setNonce] = useState(0)

  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<string>(ALL_GROUPS)
  const [opening, setOpening] = useState<OpeningInfo | null>(null)
  // Families the user opened while browsing (no query active).
  const [manualOpen, setManualOpen] = useState<ReadonlySet<string>>(() => new Set<string>())
  // While searching, hits auto-expand; this holds families whose auto state the
  // user flipped by hand. Reset whenever the query text changes.
  const [searchToggled, setSearchToggled] = useState<ReadonlySet<string>>(() => new Set<string>())

  const fen = cursor === 0 ? INITIAL_FEN : history[cursor - 1].fen
  const dests = useMemo(() => destsFor(fen), [fen])
  const turn = turnColor(fen)
  const check = checkColor(fen)
  const lastMove = cursor > 0 ? uciToLastMove(history[cursor - 1].uci) : undefined

  const canPrev = cursor > 0
  const canNext = cursor < history.length

  // ---- Live opening lookup (debounced) ----
  useEffect(() => {
    const api = window.api?.openings
    if (!api) return
    let cancelled = false
    const t = setTimeout(() => {
      api
        .lookup(fen)
        .then((r) => {
          if (!cancelled) setOpening(r.opening)
        })
        .catch(() => {
          if (!cancelled) setOpening(null)
        })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [fen])

  // ---- Board interaction ----
  const commit = useCallback(
    (orig: string, dest: string, promotion?: Role) => {
      const m = applyMove(fen, orig, dest, promotion)
      if (!m) {
        setNonce((n) => n + 1) // illegal: re-sync board to truth
        return
      }
      setHistory((prev) => [...prev.slice(0, cursor), m])
      setCursor((c) => c + 1)
      setActiveId(null) // diverged from any curated line
      playMove(m)
    },
    [fen, cursor, playMove]
  )

  const onMove = useCallback(
    (orig: string, dest: string) => {
      if (isPromotion(fen, orig, dest)) setPendingPromo({ orig, dest })
      else commit(orig, dest)
    },
    [fen, commit]
  )

  // ---- Navigation ----
  const first = useCallback(() => setCursor(0), [])
  const prev = useCallback(() => setCursor((c) => Math.max(0, c - 1)), [])
  const next = useCallback(() => setCursor((c) => Math.min(history.length, c + 1)), [history.length])
  const last = useCallback(() => setCursor(history.length), [history.length])

  const reset = useCallback(() => {
    setHistory([])
    setCursor(0)
    setActiveId(null)
    setNonce((n) => n + 1)
  }, [])

  const playOpening = useCallback((entry: OpeningEntry) => {
    const moves = resolveLine(entry.line)
    setHistory(moves)
    setCursor(moves.length)
    setActiveId(entry.id)
  }, [])

  // ---- Keyboard nav (skip while typing in the search box) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowUp') first()
      else if (e.key === 'ArrowDown') last()
      else if (e.key === 'f') setOrientation((o) => (o === 'white' ? 'black' : 'white'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [first, prev, next, last])

  // ---- Two-level opening browser (families -> variations) ----
  // Precompute a lowercased haystack per opening once (the full book is ~3.7k
  // entries, so we avoid rebuilding search strings on every keystroke). Each
  // haystack carries the FULL book name, so a family-level query ("sicilian")
  // matches every line of that family: search spans both levels for free.
  const haystacks = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of OPENINGS) {
      m.set(o.id, `${o.name}\n${o.eco}\n${o.group}\n${o.line.join(' ')}`.toLowerCase())
    }
    return m
  }, [])

  const trimmedQuery = query.trim().toLowerCase()
  const searching = trimmedQuery.length > 0

  const view = useMemo(() => {
    const out: FamilyView[] = []
    for (const fam of FAMILIES) {
      const inGroup =
        group === ALL_GROUPS ? fam.variations : fam.variations.filter((v) => v.group === group)
      if (inGroup.length === 0) continue
      const vars = trimmedQuery
        ? inGroup.filter((v) => (haystacks.get(v.id) ?? '').includes(trimmedQuery))
        : inGroup
      if (vars.length === 0) continue
      let ecoLo = vars[0].eco
      let ecoHi = ecoLo
      for (const v of vars) {
        if (v.eco < ecoLo) ecoLo = v.eco
        if (v.eco > ecoHi) ecoHi = v.eco
      }
      out.push({ fam, vars, weight: inGroup.length, ecoLo, ecoHi })
    }
    // Popularity order within the active tab: biggest families of this volume
    // first (weight ignores the query so the list doesn't jump while typing).
    out.sort((a, b) => b.weight - a.weight || a.fam.name.localeCompare(b.fam.name))
    return out
  }, [trimmedQuery, group, haystacks])

  const totalLines = useMemo(() => view.reduce((n, f) => n + f.vars.length, 0), [view])

  // While searching, auto-expand hit families top-down until the row budget is
  // spent; the rest stay collapsed (still openable by hand). Budget math only
  // depends on the view order, so manual toggles can't re-shuffle it.
  const autoOpen = useMemo(() => {
    const open = new Set<string>()
    if (!searching) return open
    let budget = SEARCH_LINE_CAP
    for (const f of view) {
      if (budget <= 0) break
      open.add(f.fam.key)
      budget -= Math.min(f.vars.length, FAMILY_SEARCH_CAP)
    }
    return open
  }, [searching, view])

  const isOpen = useCallback(
    (key: string): boolean =>
      searching ? autoOpen.has(key) !== searchToggled.has(key) : manualOpen.has(key),
    [searching, autoOpen, searchToggled, manualOpen]
  )

  const toggleFamily = useCallback(
    (key: string) => {
      if (searching) {
        setSearchToggled((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      } else {
        setManualOpen((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }
    },
    [searching]
  )

  const updateQuery = useCallback((q: string) => {
    setQuery(q)
    setSearchToggled(new Set<string>()) // fresh query, fresh auto-expansion
  }, [])

  // Jump a clicked move in the line preview to the right cursor.
  const moveListRef = useRef<HTMLDivElement>(null)

  const liveName = opening?.name ?? null
  const liveEco = opening?.eco ?? null
  // Banner shows "Family · Variation" (book names are "Family: Variation").
  const [liveFamily, liveVariation] = useMemo((): [string | null, string | null] => {
    if (!liveName) return [null, null]
    const colon = liveName.indexOf(':')
    if (colon === -1) return [liveName, null]
    return [liveName.slice(0, colon).trim(), liveName.slice(colon + 1).trim() || null]
  }, [liveName])

  return (
    <div className="openings-view">
      <div className="board-area">
        <div className="board-stage">
          <div className={`board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`}>
            <Board
              fen={fen}
              orientation={orientation}
              turnColor={turn}
              dests={dests}
              lastMove={lastMove}
              check={check}
              showDests={settings.showLegal}
              coordinates={settings.coordinates}
              animation={settings.animation}
              onMove={onMove}
              syncNonce={nonce}
            />
            {pendingPromo && (
              <PromotionPicker
                color={turn}
                onSelect={(role) => {
                  commit(pendingPromo.orig, pendingPromo.dest, role)
                  setPendingPromo(null)
                }}
                onCancel={() => {
                  setPendingPromo(null)
                  setNonce((n) => n + 1)
                }}
              />
            )}
          </div>
        </div>

        <div className="board-controls">
          <button
            className="icon-btn"
            onClick={() => setOrientation((o) => (o === 'white' ? 'black' : 'white'))}
            title="Flip board (f)"
          >
            <FlipVertical2 size={18} />
          </button>
          <div className="nav-group">
            <button className="icon-btn" onClick={first} disabled={!canPrev} title="First">
              <ChevronsLeft size={18} />
            </button>
            <button className="icon-btn" onClick={prev} disabled={!canPrev} title="Previous (left arrow)">
              <ChevronLeft size={18} />
            </button>
            <button className="icon-btn" onClick={next} disabled={!canNext} title="Next (right arrow)">
              <ChevronRight size={18} />
            </button>
            <button className="icon-btn" onClick={last} disabled={!canNext} title="Last">
              <ChevronsRight size={18} />
            </button>
          </div>
          <button className="icon-btn" onClick={reset} disabled={history.length === 0} title="Reset to start">
            <RotateCcw size={18} />
          </button>
        </div>

        <div className={`opening-banner${liveName ? '' : ' is-idle'}`}>
          <span className="opening-banner-icon">
            <BookOpen size={18} />
          </span>
          <div className="opening-banner-text">
            {liveName ? (
              <>
                <span className="opening-banner-name" title={liveName} key={liveName}>
                  {liveFamily}
                  {liveVariation && (
                    <span className="opening-banner-variation">{liveVariation}</span>
                  )}
                </span>
                {liveEco && <span className="eval-chip opening-eco">{liveEco}</span>}
              </>
            ) : (
              <span className="opening-banner-name muted">
                {cursor === 0 ? 'Play a move or pick an opening' : 'Out of book'}
              </span>
            )}
          </div>
        </div>
      </div>

      <aside className="openings-sidebar">
        <div className="panel openings-explorer">
          <div className="panel-head">
            <span className="panel-title">Openings</span>
            <span className="muted small">
              {view.length} openings · {totalLines} lines
            </span>
          </div>

          <div className="explorer-search">
            <Search size={15} className="explorer-search-icon" />
            <input
              className="explorer-search-input"
              type="text"
              placeholder="Search name, ECO, or moves…"
              value={query}
              onChange={(e) => updateQuery(e.target.value)}
            />
            {query && (
              <button className="explorer-search-clear" onClick={() => updateQuery('')} title="Clear search">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="explorer-groups">
            <button
              className={`seg ${group === ALL_GROUPS ? 'on' : ''}`}
              onClick={() => setGroup(ALL_GROUPS)}
            >
              {ALL_GROUPS}
            </button>
            {OPENING_GROUPS.map((g) => (
              <button key={g} className={`seg ${group === g ? 'on' : ''}`} onClick={() => setGroup(g)}>
                {g}
              </button>
            ))}
          </div>

          <ul className="explorer-list">
            {view.length === 0 && <li className="explorer-empty">No openings match your search.</li>}
            {view.map((fv) => {
              const { fam, vars } = fv

              // Single-line openings are leaves: clicking loads the line directly.
              if (fam.count === 1) {
                const v = vars[0]
                return (
                  <li key={fam.key}>
                    <button
                      className={`explorer-item ${activeId === v.id ? 'is-active' : ''}`}
                      onClick={() => playOpening(v)}
                      title={formatLine(v.line)}
                    >
                      <span className="explorer-item-main">
                        <span className="explorer-item-name">{v.name}</span>
                        <span className="explorer-item-line">{formatLine(v.line)}</span>
                      </span>
                      <span className="eval-chip explorer-item-eco">{v.eco}</span>
                    </button>
                  </li>
                )
              }

              const open = isOpen(fam.key)
              const shownVars = open ? (searching ? vars.slice(0, FAMILY_SEARCH_CAP) : vars) : []
              const hiddenCount = open ? vars.length - shownVars.length : 0
              const hasActive = activeId !== null && vars.some((v) => v.id === activeId)

              return (
                <li key={fam.key} className="explorer-family-block">
                  <button
                    className={`explorer-family${open ? ' is-open' : ''}${
                      hasActive && !open ? ' has-active' : ''
                    }`}
                    onClick={() => toggleFamily(fam.key)}
                    aria-expanded={open}
                  >
                    <ChevronRight size={15} className="explorer-family-chevron" aria-hidden />
                    <span className="explorer-family-name">{fam.name}</span>
                    <span className="explorer-family-count num">{vars.length}</span>
                    <span className="eval-chip explorer-item-eco explorer-family-eco">
                      {ecoRange(fv.ecoLo, fv.ecoHi)}
                    </span>
                  </button>
                  {open && (
                    <ul className="explorer-variations">
                      {shownVars.map((v) => (
                        <li key={v.id}>
                          <button
                            className={`explorer-item explorer-variation ${
                              activeId === v.id ? 'is-active' : ''
                            }`}
                            onClick={() => playOpening(v)}
                            title={formatLine(v.line)}
                          >
                            <span className="explorer-item-main">
                              <span className="explorer-item-name">{v.variationLabel}</span>
                              <span className="explorer-item-line">{formatLine(v.line)}</span>
                            </span>
                            <span className="eval-chip explorer-item-eco">{v.eco}</span>
                          </button>
                        </li>
                      ))}
                      {hiddenCount > 0 && (
                        <li className="explorer-more-inline">
                          +{hiddenCount} more line{hiddenCount === 1 ? '' : 's'}. Refine your
                          search.
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
            {searching && totalLines > SEARCH_LINE_CAP && (
              <li className="explorer-more">
                {totalLines} lines match. Top families are expanded, so refine to narrow it down.
              </li>
            )}
          </ul>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Line</span>
            {history.length > 0 && <span className="muted small">{history.length} ply</span>}
          </div>
          <div className="opening-moves" ref={moveListRef}>
            {history.length === 0 ? (
              <div className="opening-moves-empty">No moves yet.</div>
            ) : (
              history.map((m, i) => {
                const ply = i + 1
                const isWhite = i % 2 === 0
                return (
                  <span key={i} className="opening-move-slot">
                    {isWhite && <span className="move-num">{Math.floor(i / 2) + 1}.</span>}
                    <button
                      className={`move opening-move ${ply === cursor ? 'is-current' : ''}`}
                      onClick={() => setCursor(ply)}
                    >
                      <span className="move-san">{m.san}</span>
                    </button>
                  </span>
                )
              })
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}
