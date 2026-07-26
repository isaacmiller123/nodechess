import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { Role } from 'chessops/types'
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
  ECO_VOLUMES,
  FAMILIES,
  OPENINGS,
  continuationsFor,
  deepestBookLine,
  entryForLine,
  formatMoves,
  resolveLine,
  type EcoVolume,
  type LineMove,
  type OpeningEntry,
  type OpeningFamily
} from './openings'
import type { OpeningInfo } from '../../../../shared/types'
import './openings.css'

/** Rendered-row budget across all families while a search is active. */
const SEARCH_LINE_CAP = 250
/** Per-family cap on variation rows while a search is active, so one family
 *  cannot flood the result of a query that several families answer. */
const FAMILY_SEARCH_CAP = 60

const NUM = new Intl.NumberFormat('en-US')
const TOTAL_LINES = NUM.format(OPENINGS.length)

/** Split a book name into the plate's title and its variation line. */
function splitName(name: string): [string, string | null] {
  const colon = name.indexOf(':')
  if (colon === -1) return [name, null]
  return [name.slice(0, colon).trim(), name.slice(colon + 1).trim() || null]
}

/** ECO range chip text: "B20-B99", or the single code for a one-code family. */
function ecoRange(lo: string, hi: string): string {
  return lo === hi ? lo : `${lo}-${hi}`
}

/**
 * One book line in the index: its ECO code, what it is called under the family
 * that owns it, and the move order that reaches it. Clicking it plays the line
 * onto the board. The moves are printed rather than hidden in a tooltip: they
 * are what tells two same-named checkpoints apart, and they are what a query
 * like "1.e4 c5" matched on.
 */
function Line({
  entry,
  label,
  activeId,
  onPlay
}: {
  entry: OpeningEntry
  label: string
  activeId: string | null
  onPlay: (entry: OpeningEntry) => void
}): JSX.Element {
  const here = entry.id === activeId
  return (
    <button
      className={`grow open-line${here ? ' is-here' : ''}`}
      type="button"
      aria-current={here ? 'true' : undefined}
      onClick={() => onPlay(entry)}
    >
      <span className="open-line-eco">{entry.eco}</span>
      <span className="open-line-text">
        {/* The title sits on the span, not the button: a long name is
            ellipsized here, and a title on the control itself would compete
            with its own label. */}
        <span className="g-name open-line-name" title={label}>
          {label}
        </span>
        <span className="g-note">{formatMoves(entry.line)}</span>
      </span>
    </button>
  )
}

/** One family's slice of the index under the current volume tab and query. */
interface FamilyView {
  fam: OpeningFamily
  /** Variations passing the volume tab AND the query. */
  vars: OpeningEntry[]
  /** Popularity weight: lines in this family under the tab. Query-independent,
   *  so the order stays put while you type rather than reshuffling per key. */
  weight: number
  ecoLo: string
  ecoHi: string
}

export default function OpeningsView(): JSX.Element {
  const { settings } = useSettings()
  const { playMove } = useSound()

  // Linear move history (each entry = a played ply). cursor is the number of
  // plies currently shown: 0 = starting position, history.length = end of line.
  // Plies past the cursor are kept, which is what lets the path strip hold the
  // branch you stepped back from instead of deleting it.
  const [history, setHistory] = useState<LineMove[]>([])
  const [cursor, setCursor] = useState(0)

  const [orientation, setOrientation] = useState<Color>('white')
  const [pendingPromo, setPendingPromo] = useState<{ orig: string; dest: string } | null>(null)
  const [nonce, setNonce] = useState(0)

  const [query, setQuery] = useState('')
  const [volume, setVolume] = useState<EcoVolume | ''>('')
  const [opening, setOpening] = useState<OpeningInfo | null>(null)

  // Families opened by hand while browsing (no query active).
  const [manualOpen, setManualOpen] = useState<ReadonlySet<string>>(() => new Set<string>())
  // While searching, hit families expand themselves; this holds the ones whose
  // automatic state the user flipped. Cleared whenever the query text changes.
  const [searchToggled, setSearchToggled] = useState<ReadonlySet<string>>(() => new Set<string>())

  const listRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef<HTMLDivElement>(null)

  const fen = cursor === 0 ? INITIAL_FEN : history[cursor - 1].fen
  const dests = useMemo(() => destsFor(fen), [fen])
  const turn = turnColor(fen)
  const check = checkColor(fen)
  const lastMove = cursor > 0 ? uciToLastMove(history[cursor - 1].uci) : undefined

  const canPrev = cursor > 0
  const canNext = cursor < history.length

  // The move order you are standing on. Everything the book knows about this
  // screen is keyed off it: the plate, the continuations and the index marker.
  const path = useMemo(() => history.slice(0, cursor).map((m) => m.san), [history, cursor])

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

  const playOpening = useCallback((entry: OpeningEntry) => {
    const moves = resolveLine(entry.line)
    setHistory(moves)
    setCursor(moves.length)
  }, [])

  /* Descending a continuation. When the reply is already the next ply of the
     line you are on, only the cursor moves, so the branch ahead survives being
     walked back into. Otherwise the line is rebuilt to the new move and
     anything past the cursor goes, which is what playing a move means. */
  const descend = useCallback(
    (san: string) => {
      if (history[cursor]?.san === san) {
        setCursor(cursor + 1)
      } else {
        const moves = resolveLine([...path, san])
        if (moves.length !== path.length + 1) return
        setHistory(moves)
        setCursor(moves.length)
      }
      playMove({ san, capture: san.includes('x'), check: /[+#]/.test(san) })
    },
    [history, cursor, path, playMove]
  )

  // ---- Keyboard nav (skip while typing in the search box) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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

  /* THE CHIP YOU ARE STANDING ON, KEPT IN THE STRIP'S VIEW.
     On a phone openings.css caps the path strip at three rows of chips and
     lets it scroll inside itself, because an uncapped strip on a 36 ply line
     pushed the board 190px under the tab bar. A capped strip can hold the
     cursor out of sight, so stepping through the line brings it back.

     The guard is the whole of the width story: above 720 the strip has no
     ceiling and never overflows, so scrollHeight is never greater than
     clientHeight and this does nothing at all. It moves the strip's own
     scrollTop rather than calling scrollIntoView, which would also scroll
     every ancestor and take the page with it. */
  useEffect(() => {
    const strip = pathRef.current
    if (!strip || strip.scrollHeight <= strip.clientHeight) return
    const chip = strip.querySelector<HTMLElement>('.open-ply.is-here')
    if (!chip) {
      // Ply 0 is the starting position and has no chip: the top of the line.
      strip.scrollTop = 0
      return
    }
    // Measured off the boxes rather than offsetTop, which would be read
    // against whichever ancestor happens to be positioned at this width.
    const top =
      chip.getBoundingClientRect().top - strip.getBoundingClientRect().top + strip.scrollTop
    const bottom = top + chip.offsetHeight
    if (top < strip.scrollTop) strip.scrollTop = top
    else if (bottom > strip.scrollTop + strip.clientHeight) {
      strip.scrollTop = bottom - strip.clientHeight
    }
  }, [cursor, history])

  // ---- The book, read three ways ----
  const continuations = useMemo(() => continuationsFor(path), [path])
  const aheadSan = history[cursor]?.san ?? null

  // The deepest ply this move order still follows, and whether the position in
  // front of you is one the book names itself.
  const bookLine = useMemo(() => deepestBookLine(path), [path])
  const exactEntry = useMemo(() => entryForLine(path), [path])
  const activeId = exactEntry?.id ?? null

  const named = opening ?? (exactEntry ? { eco: exactEntry.eco, name: exactEntry.name } : null)
  const [plateTitle, plateVariation] = named ? splitName(named.name) : [null, null]
  const matchedPly = bookLine ? bookLine.line.length : 0

  // ---- The index: families first, variations inside them ----
  // One lowercased haystack per line, built once: the book is 3,733 entries and
  // rebuilding search strings on every keystroke is the only way this list gets
  // slow. Name, code and moves, which is exactly what the field promises. The
  // haystack carries the FULL book name, so a family-level query ("sicilian")
  // matches every line of that family: one pass searches both levels.
  const haystacks = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of OPENINGS) m.set(o.id, `${o.name}\n${o.eco}\n${formatMoves(o.line)}`.toLowerCase())
    return m
  }, [])

  const trimmedQuery = query.trim().toLowerCase()
  const searching = trimmedQuery.length > 0

  const view = useMemo(() => {
    const out: FamilyView[] = []
    for (const fam of FAMILIES) {
      // A family can straddle volumes (the English runs A10 to C20), so the
      // tab filters its LINES and the family shows up wherever it has any.
      const inVolume = volume ? fam.variations.filter((v) => v.volume === volume) : fam.variations
      if (inVolume.length === 0) continue
      const vars = trimmedQuery
        ? inVolume.filter((v) => (haystacks.get(v.id) ?? '').includes(trimmedQuery))
        : inVolume
      if (vars.length === 0) continue
      let ecoLo = vars[0].eco
      let ecoHi = ecoLo
      for (const v of vars) {
        if (v.eco < ecoLo) ecoLo = v.eco
        if (v.eco > ecoHi) ecoHi = v.eco
      }
      out.push({ fam, vars, weight: inVolume.length, ecoLo, ecoHi })
    }
    // Popularity order within the active tab: the biggest families of this
    // volume first.
    out.sort((a, b) => b.weight - a.weight || a.fam.name.localeCompare(b.fam.name))
    return out
  }, [volume, trimmedQuery, haystacks])

  const matchCount = useMemo(() => view.reduce((n, f) => n + f.vars.length, 0), [view])

  // A fresh filter is a fresh list: back to the top of the well.
  useEffect(() => {
    listRef.current?.scrollTo(0, 0)
  }, [volume, trimmedQuery])

  // While searching, hit families open themselves top-down until the row budget
  // is spent; the rest stay shut and are still openable by hand. The budget only
  // reads the view order, so a manual toggle cannot reshuffle it.
  const autoOpen = useMemo(() => {
    const open = new Set<string>()
    if (!searching) return open
    let left = SEARCH_LINE_CAP
    for (const f of view) {
      if (left <= 0) break
      open.add(f.fam.key)
      left -= Math.min(f.vars.length, FAMILY_SEARCH_CAP)
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
      const flip = (prev: ReadonlySet<string>): ReadonlySet<string> => {
        const nextSet = new Set(prev)
        if (nextSet.has(key)) nextSet.delete(key)
        else nextSet.add(key)
        return nextSet
      }
      if (searching) setSearchToggled(flip)
      else setManualOpen(flip)
    },
    [searching]
  )

  const updateQuery = useCallback((q: string) => {
    setQuery(q)
    setSearchToggled(new Set<string>()) // fresh query, fresh auto-expansion
  }, [])

  const flipBoard = useCallback(() => setOrientation((o) => (o === 'white' ? 'black' : 'white')), [])

  return (
    <>
      {/* open-search is a hook for the phone rule that closes the gap under
          this block; it carries no styling at any other width. */}
      <section className="sec open-search">
        <div className="sec-head">
          <h2 className="lbl">Openings</h2>
          <span className="sec-count">{TOTAL_LINES} named lines</span>
        </div>
        <div className="filterbar">
          <input
            className="filter-input"
            type="search"
            autoComplete="off"
            placeholder="Name, ECO code or moves"
            aria-label="Search openings"
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
          />
          <div className="segmented" role="group" aria-label="ECO volume" data-segs="">
            <button
              className="seg"
              type="button"
              aria-pressed={volume === ''}
              onClick={() => setVolume('')}
            >
              All
            </button>
            {ECO_VOLUMES.map((v) => (
              <button
                key={v.letter}
                className="seg"
                type="button"
                title={v.label}
                aria-pressed={volume === v.letter}
                onClick={() => setVolume(v.letter)}
              >
                {v.letter}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* The line, pinned. Plies after the cursor are kept and dimmed. */}
      <div className="open-path" ref={pathRef}>
        <span className="lbl">Line</span>
        {history.map((m, i) => {
          const ply = i + 1
          const here = ply === cursor
          return (
            <button
              key={i}
              className={`open-ply${here ? ' is-here' : ''}${ply > cursor ? ' is-ahead' : ''}`}
              type="button"
              aria-current={here ? 'true' : undefined}
              onClick={() => setCursor(ply)}
            >
              {i % 2 === 0 ? `${i / 2 + 1}. ${m.san}` : m.san}
            </button>
          )
        })}
        <span className="open-pathmeta">{`ply ${cursor} of ${history.length}`}</span>
      </div>

      <div className="open">
        {/* ---------------- board ---------------- */}
        <div className="open-boardcol">
          <div className="board-area">
            <div className="open-plate board-under">
              {named && <span className="open-eco">{named.eco}</span>}
              <span>
                {/* "Unnamed position" rather than "out of book": stepping back
                    to a ply between two named checkpoints is still inside the
                    line, and matched ply says where the last name was. */}
                <span className="open-title">
                  {plateTitle ?? (cursor === 0 ? 'Starting position' : 'Unnamed position')}
                </span>
                <span className="open-sub">
                  {plateVariation && <span>{plateVariation}</span>}
                  {matchedPly > 0 && <span>matched ply {matchedPly}</span>}
                  {named && <span className="tag">in book</span>}
                </span>
              </span>
            </div>

            <div className="board-stage">
              <div className={`board-wrap ${pieceSetClass(settings.pieceSet)}`}>
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

            <div className="boardbar">
              <span className="turn">
                <span className={`turn-chip${turn === 'black' ? ' open-turn-b' : ''}`} />
                {turn === 'black' ? 'Black to move' : 'White to move'}
              </span>
              <button className="key" type="button" title="Start" onClick={first} disabled={!canPrev}>
                {'|<'}
              </button>
              <button className="key" type="button" title="Back" onClick={prev} disabled={!canPrev}>
                {'<'}
              </button>
              <button className="key" type="button" title="Forward" onClick={next} disabled={!canNext}>
                {'>'}
              </button>
              <button
                className="key"
                type="button"
                title="End of line"
                onClick={last}
                disabled={!canNext}
              >
                {'>|'}
              </button>
              <button className="btn is-quiet" type="button" onClick={flipBoard}>
                Flip
              </button>
            </div>

            <div className="open-fen board-under">
              <span className="lbl">Fen</span>
              {fen}
            </div>
          </div>
        </div>

        {/* ---------------- continuations ---------------- */}
        <div className="open-cont">
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Continuations</h2>
              <span className="sec-count">
                {continuations.length} named {continuations.length === 1 ? 'reply' : 'replies'}
              </span>
            </div>
            <div className="panel">
              <div className="open-cont-head">
                <span className="lbl">Move</span>
                <span className="lbl">Leads to</span>
                <span className="lbl">Below</span>
              </div>

              {continuations.length === 0 ? (
                <div className="empty">
                  <p className="empty-line">The book names no reply from here.</p>
                  <p className="empty-line">Step back along the line, or pick another from the index.</p>
                </div>
              ) : (
                continuations.map((c) => (
                  <button
                    key={c.san}
                    className={`open-cont-row${c.san === aheadSan ? ' is-here' : ''}`}
                    type="button"
                    onClick={() => descend(c.san)}
                  >
                    <span className="open-mv">{c.san}</span>
                    <span className="open-leads">
                      <span>{c.name}</span>
                      <span className="open-leads-eco">{c.eco}</span>
                    </span>
                    <span className="open-below">{c.below}</span>
                  </button>
                ))
              )}

              {/* v1 put "Play from here" here. Nothing in the app starts a game
                  from a given position, and a button with no destination is
                  worse than the sentence that says where the moves do go. */}
              <div className="panel-foot">
                <p className="foot-note">Play on from here by moving on the board above.</p>
              </div>
            </div>
          </section>
        </div>

        {/* ---------------- the index ----------------

            Two levels, and the top one is a NAME. 3,733 lines in one list is a
            scroll nobody finishes; the same book as 148 families is a page you
            read. Each family is a disclosure: aria-expanded on the button and a
            real hidden attribute on its panel, so a shut family is out of the
            accessibility tree rather than merely invisible. */}
        <div className="open-index">
          <section className="sec">
            <div className="sec-head">
              <h2 className="lbl">Index</h2>
              <span className="sec-count">
                {NUM.format(view.length)} {view.length === 1 ? 'opening' : 'openings'} ·{' '}
                {NUM.format(matchCount)} {matchCount === 1 ? 'line' : 'lines'}
              </span>
            </div>
            <div className="well">
              <div className="open-list" ref={listRef}>
                {view.map((fv, i) => {
                  const { fam, vars } = fv
                  const range = ecoRange(fv.ecoLo, fv.ecoHi)

                  // A family the book gives one line is a leaf, not a drawer:
                  // opening it to reveal the single row it already named is a
                  // click that tells you nothing.
                  if (fam.count === 1) {
                    return (
                      <Line
                        key={fam.key}
                        entry={vars[0]}
                        label={fam.name}
                        activeId={activeId}
                        onPlay={playOpening}
                      />
                    )
                  }

                  const open = isOpen(fam.key)
                  const shown = open ? (searching ? vars.slice(0, FAMILY_SEARCH_CAP) : vars) : []
                  const hiddenCount = open ? vars.length - shown.length : 0
                  const holdsActive = activeId !== null && vars.some((v) => v.id === activeId)
                  const panelId = `open-fam-${i}`

                  return (
                    <div className="open-fam" key={fam.key}>
                      <button
                        className={`ghead ghead-inner open-fam-head${holdsActive && !open ? ' has-active' : ''}`}
                        type="button"
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => toggleFamily(fam.key)}
                      >
                        <svg className="icon" aria-hidden>
                          <use href="#i-chev" />
                        </svg>
                        <span className="g-name open-fam-name" title={fam.name}>
                          {fam.name}
                        </span>
                        <span className="chip open-fam-eco">{range}</span>
                        <span className="ghead-count">{vars.length}</span>
                      </button>
                      <div className="open-fam-lines" id={panelId} hidden={!open}>
                        {shown.map((v) => (
                          <Line
                            key={v.id}
                            entry={v}
                            label={v.variationLabel}
                            activeId={activeId}
                            onPlay={playOpening}
                          />
                        ))}
                        {hiddenCount > 0 && (
                          <p className="open-fam-more">
                            {hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'} in this
                            opening. Narrow the search to reach them.
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {view.length === 0 && (
                <div className="empty">
                  <p className="empty-line">Nothing in the book matches that.</p>
                  <p className="empty-line">Try a name, an ECO code, or paste the moves.</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
