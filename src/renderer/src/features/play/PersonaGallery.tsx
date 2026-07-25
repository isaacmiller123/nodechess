// Grandmaster gallery: the browsing surface of the Play "Grandmasters" tab.
// Photo cards grouped by era with era filter chips; clicking a card opens
// PersonaDetail (via onOpen). Purely presentational: personas + loading state
// come from PlayView, which owns the (lazy, latched) personas:list fetch.
// All Persona fields beyond id/name/era/peakElo/style/bio are nullable.
// Everything here renders defensively (initials disc when no photo, era as a
// stand-in when years are missing, bio when styleDesc is missing).

import { useMemo, useState } from 'react'
import { Crown } from 'lucide-react'
import type { Persona } from '@shared/types'

export interface PersonaGalleryProps {
  personas: Persona[]
  loading: boolean
  /** Open a persona's detail pane. */
  onOpen: (id: string) => void
}

/** Initials for the no-photo fallback disc ("Paul Morphy" -> "PM"). */
export function personaInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join('')
}

/** One-line style hook for a card: the first sentence of styleDesc (fallback
 *  bio). The regex requires whitespace/end after the punctuation so inline
 *  move notation like "1.e4" never truncates the sentence early. */
function hookOf(p: Persona): string {
  const src = (p.styleDesc ?? p.bio).trim()
  const end = src.search(/[.!?](?:\s|$)/)
  return end >= 0 ? src.slice(0, end + 1) : src
}

interface EraGroup {
  era: string
  items: Persona[]
}

export function PersonaGallery({ personas, loading, onOpen }: PersonaGalleryProps) {
  // null = all eras. Hooks stay above every conditional return.
  const [eraFilter, setEraFilter] = useState<string | null>(null)

  // Eras in catalog order (the data is curated chronologically).
  const eras = useMemo(() => {
    const out: string[] = []
    for (const p of personas) if (!out.includes(p.era)) out.push(p.era)
    return out
  }, [personas])

  const countByEra = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of personas) m[p.era] = (m[p.era] ?? 0) + 1
    return m
  }, [personas])

  const groups = useMemo<EraGroup[]>(() => {
    const source = eraFilter ? personas.filter((p) => p.era === eraFilter) : personas
    const m = new Map<string, Persona[]>()
    for (const p of source) {
      const arr = m.get(p.era)
      if (arr) arr.push(p)
      else m.set(p.era, [p])
    }
    return [...m.entries()].map(([era, items]) => ({ era, items }))
  }, [personas, eraFilter])

  if (loading) {
    return (
      <div className="psetup-panel pgal" aria-busy="true">
        <div className="pgal-chips" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="pgal-chip is-skel" />
          ))}
        </div>
        <div className="pgal-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="pgal-card is-skel" aria-hidden>
              <span className="pgal-photo" />
              <span className="pgal-body">
                <span className="pgal-skel-line" />
                <span className="pgal-skel-line is-short" />
              </span>
            </div>
          ))}
        </div>
        <span className="visually-hidden">Loading grandmasters…</span>
      </div>
    )
  }

  if (personas.length === 0) {
    return (
      <div className="psetup-panel pgal-empty">
        <Crown size={28} className="pgal-empty-icon" aria-hidden />
        <p className="pgal-empty-title">No grandmasters available</p>
        <p className="muted small">
          The grandmaster catalog could not be loaded. Try the Quick Match tab, or restart the app.
        </p>
      </div>
    )
  }

  return (
    <div className="psetup-panel pgal">
      <header className="pgal-head">
        <h2>Grandmasters</h2>
        <span className="muted small">
          {personas.length} legends from the Romantic era to today. Pick one to study their games,
          or challenge them.
        </span>
      </header>

      <div className="pgal-chips" role="group" aria-label="Filter by era">
        <button
          type="button"
          className={`pgal-chip${eraFilter === null ? ' on' : ''}`}
          aria-pressed={eraFilter === null}
          onClick={() => setEraFilter(null)}
        >
          All <span className="pgal-chip-n">{personas.length}</span>
        </button>
        {eras.map((era) => (
          <button
            key={era}
            type="button"
            className={`pgal-chip${eraFilter === era ? ' on' : ''}`}
            aria-pressed={eraFilter === era}
            onClick={() => setEraFilter((cur) => (cur === era ? null : era))}
          >
            {era} <span className="pgal-chip-n">{countByEra[era]}</span>
          </button>
        ))}
      </div>

      {groups.map((g) => (
        <section key={g.era} className="pgal-era" aria-label={g.era}>
          <h3 className="pgal-era-name">{g.era}</h3>
          <div className="pgal-grid">
            {g.items.map((p) => (
              <button key={p.id} type="button" className="pgal-card" onClick={() => onOpen(p.id)}>
                <span className="pgal-photo">
                  {p.photo ? (
                    <img src={p.photo} alt="" />
                  ) : (
                    <span className="pgal-initials" aria-hidden>
                      {personaInitials(p.name)}
                    </span>
                  )}
                  <span className="pgal-elo num">Peak {p.peakElo}</span>
                </span>
                <span className="pgal-body">
                  <span className="pgal-name-row">
                    <span className="pgal-name">{p.name}</span>
                    {p.title && <span className="pgal-title">{p.title}</span>}
                  </span>
                  <span className="pgal-years muted">{p.years ?? p.era}</span>
                  <span className="pgal-hook">{hookOf(p)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
