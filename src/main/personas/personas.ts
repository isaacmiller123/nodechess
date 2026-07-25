// GM-style persona catalog (docs/feature-addendum.md §2b), data-driven.
//
// IMPORTANT FRAMING (mirrors the spec): these are NOT models that "play as" a
// given grandmaster. No open, redistributable net does that. Each persona is a
// strength-capped Stockfish whose move *selection* is style-weighted toward that
// player's documented tendencies (aggression / risk / attacking vs solid), plus
// a real opening book of that player's documented repertoire (book.ts). The
// renderer must frame them honestly: "plays in X's style," never "play as X."
//
// The catalog lives in resources/personas/personas.json — GENERATED from
// resources/personas/research.json by scripts/build-persona-data.mjs (edit
// research.json, not personas.json). Portraits are merged at load time from
// resources/personas/photos.json ({ id: { dataUri, attribution } }), produced by
// scripts/fetch-persona-photos.mjs. Resource resolution mirrors school.repo.ts /
// book.ts: in dev the main bundle is out/main/index.js so __dirname/../../resources
// is the repo resources dir; packaged builds ship under process.resourcesPath
// (electron-builder extraResources "resources/personas" -> "personas").
//
// Missing/corrupt files must never crash the app — they degrade to an empty
// catalog (renderer shows "no personas") / photo-less personas.

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { Persona, PersonaStyle } from '../../shared/types'

export type { Persona, PersonaStyle }

/** personas.json rows: a Persona minus the photo fields (merged from photos.json). */
type PersonaRow = Omit<Persona, 'photo' | 'photoAttribution'>

interface PersonasFile {
  version?: number
  personas?: PersonaRow[]
}

interface PhotoEntry {
  dataUri?: string
  attribution?: string
}

let cache: Persona[] | null = null

function resourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'personas')
    : path.join(__dirname, '../../resources/personas')
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(resourceDir(), file), 'utf-8')) as T
  } catch {
    return null
  }
}

/** Coerce one raw catalog row into a fully-shaped Persona (photo merged in). */
function toPersona(row: PersonaRow, photos: Record<string, PhotoEntry>): Persona | null {
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
    photo: typeof photo?.dataUri === 'string' ? photo.dataUri : null,
    photoAttribution: typeof photo?.attribution === 'string' ? photo.attribution : null,
    famousGameIds: Array.isArray(row.famousGameIds)
      ? row.famousGameIds.filter((g): g is string => typeof g === 'string')
      : [],
    // Clock personality (bot time manager). Omitted/unknown values stay
    // undefined — the renderer falls back to botTime's by-id map, then 'steady'.
    timeStyle:
      row.timeStyle === 'blitzer' || row.timeStyle === 'steady' || row.timeStyle === 'tanker'
        ? row.timeStyle
        : undefined
  }
}

function load(): Persona[] {
  if (cache) return cache
  const parsed = readJson<PersonasFile>('personas.json')
  const photos = readJson<Record<string, PhotoEntry>>('photos.json') ?? {}
  const rows = Array.isArray(parsed?.personas) ? parsed.personas : []
  cache = rows
    .map((r) => toPersona(r, photos))
    .filter((p): p is Persona => p !== null)
  return cache
}

/** The full persona catalog, in file order. */
export function listPersonas(): Persona[] {
  return load()
}

/** Look up a persona by id, or undefined if unknown. */
export function getPersona(id: string): Persona | undefined {
  return load().find((p) => p.id === id)
}
