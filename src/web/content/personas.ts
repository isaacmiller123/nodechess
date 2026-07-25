// The persona catalog, read from the static content tree instead of
// personas:list. Mirrors src/main/personas/personas.ts toPersona(): same
// defaults, same field coercion, same "a bad row is dropped, never faked".
//
// ONE deliberate difference. Desktop merges resources/personas/photos.json,
// where each portrait is a base64 data URI, and hands `Persona.photo` back
// inline, 6.6 MB of JSON for 24 portraits. The build splits those back into
// image files, so `photo` here is a URL into the content tree. Every consumer
// puts it straight into an <img src>, which treats the two identically, and the
// gallery now paints from a 35 KB catalog while the browser fetches (and
// caches) portraits per card.

import type { Persona } from '@shared/types'
import { contentUrl, loadContent } from './fetchContent'

/** A catalog row: a Persona minus the photo fields, exactly as personas.json
 *  stores it (the build copies the rows verbatim). */
type PersonaRow = Omit<Persona, 'photo' | 'photoAttribution'>

interface CatalogFile {
  personas?: PersonaRow[]
  /** id -> emitted image file + its attribution line. */
  photos?: Record<string, { file?: string; attribution?: string | null }>
}

function toPersona(row: PersonaRow, photos: NonNullable<CatalogFile['photos']>): Persona | null {
  if (!row || typeof row.id !== 'string' || row.id.length === 0) return null
  if (typeof row.name !== 'string' || typeof row.peakElo !== 'number' || !row.style) return null
  const photo = photos[row.id]
  return {
    id: row.id,
    name: row.name,
    era: typeof row.era === 'string' ? row.era : '',
    peakElo: row.peakElo,
    style: {
      aggression: row.style.aggression ?? 0.5,
      risk: row.style.risk ?? 0.5,
      prefersAttack: row.style.prefersAttack ?? false,
      prefersSolid: row.style.prefersSolid ?? false
    },
    bio: typeof row.bio === 'string' ? row.bio : '',
    title: row.title ?? null,
    country: row.country ?? null,
    years: row.years ?? null,
    peakYear: row.peakYear ?? null,
    modernElo: row.modernElo ?? null,
    modernEloNote: row.modernEloNote ?? null,
    styleDesc: row.styleDesc ?? null,
    photo: photo?.file ? contentUrl(`personas/${photo.file}`) : null,
    photoAttribution: photo?.attribution ?? null,
    famousGameIds: Array.isArray(row.famousGameIds)
      ? row.famousGameIds.filter((g): g is string => typeof g === 'string')
      : [],
    timeStyle:
      row.timeStyle === 'blitzer' || row.timeStyle === 'steady' || row.timeStyle === 'tanker'
        ? row.timeStyle
        : undefined
  }
}

export async function listPersonas(): Promise<Persona[]> {
  const file = await loadContent<CatalogFile>('personas.json')
  const rows = Array.isArray(file.personas) ? file.personas : []
  const photos = file.photos ?? {}
  return rows.map((r) => toPersona(r, photos)).filter((p): p is Persona => p !== null)
}
