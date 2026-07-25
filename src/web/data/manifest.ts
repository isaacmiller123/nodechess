// The build manifest that ships next to the puzzle-DB chunks, plus the rowid
// arithmetic it exists to enable.
//
// Written by scripts/build-puzzle-chunks.mjs; see that file for how the numbers
// are produced. Two things live here that the browser cannot afford to ask the
// database for:
//
//   - `themes`: the desktop's listThemes() is a GROUP BY over 21M junction
//     rows. Over HTTP that is hundreds of MB for 73 numbers, so it is baked in.
//   - `ratingCumulative`: because the chunked DB is stored clustered by
//     (Rating, PuzzleId) with rowid == rank in that order, a rating band maps
//     to a CONTIGUOUS rowid range, and this histogram gives the reader that
//     range for free. Every rating-window query then reads one run of adjacent
//     pages instead of descending an index and chasing scattered rowids, which
//     is the difference between one round-trip and twenty-four.

import type { ThemeCount } from '@shared/types'

export interface PuzzleChunkManifest {
  format: 1
  builtAt: string
  /** Cache-buster appended to every chunk URL. Mixing pages from two builds
   *  silently yields wrong rows rather than an error, so it must change
   *  whenever the bytes do. It is the head of the artifact's sha256. */
  buildId: string
  sha256: string
  source: { path: string; bytes: number; mtimeMs: number }
  db: {
    bytes: number
    pageSize: number
    chunkBytes: number
    chunkCount: number
    prefix: string
    suffixLength: number
  }
  puzzleCount: number
  themeRowCount: number
  /** Average bytes a `puzzles` row occupies on disk, index included. Used to
   *  price a contiguous scan against point lookups when planning a batch. */
  puzzleRowBytes: number
  ratingMin: number
  ratingMax: number
  /** `ratingCumulative[i]` = puzzles rated below `ratingMin + i`; length is
   *  `ratingMax - ratingMin + 2`, so the last entry is the total row count. */
  ratingCumulative: number[]
  themes: ThemeCount[]
  daily: { ratingLo: number; ratingHi: number; bandCount: number }
}

const MISSING =
  'Build it with `npm run build:puzzle-chunks` and deploy the output directory (see scripts/build-puzzle-chunks.mjs).'

/** Fetch + validate the manifest. Throws with a pointer to the build step.
 *  There is no partial mode and nothing to substitute: without the manifest the
 *  reader cannot address a single page. */
export async function loadManifest(url: string, fetchImpl: typeof fetch = fetch): Promise<PuzzleChunkManifest> {
  let res: Response
  try {
    // The manifest pins the build the chunk URLs point at, so a stale cached
    // copy would address a database that no longer exists. Always revalidate;
    // it is a few KB.
    res = await fetchImpl(url, { cache: 'no-cache' })
  } catch (err) {
    throw new Error(`Puzzle database manifest ${url} could not be fetched: ${String(err)}. ${MISSING}`)
  }
  if (!res.ok) throw new Error(`Puzzle database manifest ${url} returned HTTP ${res.status}. ${MISSING}`)
  return parseManifest(await res.json(), url)
}

/** Validate every field the reader dereferences. A manifest that disagrees with
 *  the chunks it describes produces plausible-looking wrong puzzles, so this is
 *  strict on purpose. */
export function parseManifest(value: unknown, url: string): PuzzleChunkManifest {
  const m = value as Partial<PuzzleChunkManifest> | null
  const bad = (why: string): never => {
    throw new Error(`Puzzle database manifest ${url} is not usable: ${why}. ${MISSING}`)
  }
  if (!m || typeof m !== 'object') return bad('not an object')
  if (m.format !== 1) return bad(`unsupported format ${String(m.format)} (this build reads format 1)`)
  const db = m.db
  if (!db || typeof db !== 'object') return bad('missing `db` section')
  for (const k of ['bytes', 'pageSize', 'chunkBytes', 'chunkCount', 'suffixLength'] as const) {
    if (!Number.isFinite(db[k]) || db[k] <= 0) return bad(`db.${k} is not a positive number`)
  }
  if (typeof db.prefix !== 'string' || !db.prefix) return bad('db.prefix is empty')
  // A page that straddles two chunk files would need two round-trips to read
  // and the range mapper only ever issues one.
  if (db.chunkBytes % db.pageSize !== 0) return bad(`chunk size ${db.chunkBytes} is not a multiple of page size ${db.pageSize}`)
  if (Math.ceil(db.bytes / db.chunkBytes) !== db.chunkCount) return bad('db.chunkCount disagrees with db.bytes / db.chunkBytes')
  if (typeof m.buildId !== 'string' || !m.buildId) return bad('buildId is empty')
  for (const k of ['puzzleCount', 'themeRowCount', 'puzzleRowBytes', 'ratingMin', 'ratingMax'] as const) {
    if (!Number.isFinite(m[k])) return bad(`${k} is not a number`)
  }
  if (!Array.isArray(m.themes)) return bad('themes is not an array')
  if (!Array.isArray(m.ratingCumulative)) return bad('ratingCumulative is not an array')
  const span = (m.ratingMax as number) - (m.ratingMin as number) + 2
  if (m.ratingCumulative.length !== span) {
    return bad(`ratingCumulative has ${m.ratingCumulative.length} entries, expected ${span} for ratings ${m.ratingMin}–${m.ratingMax}`)
  }
  if (m.ratingCumulative[m.ratingCumulative.length - 1] !== m.puzzleCount) {
    return bad('ratingCumulative does not sum to puzzleCount')
  }
  if (!m.daily || !Number.isFinite(m.daily.bandCount)) return bad('missing daily band statistics')
  return m as PuzzleChunkManifest
}

/** Number of puzzles rated strictly below `rating`, and, since rowid is the
 *  rank in (Rating, PuzzleId) order, the rowid of the last puzzle below it. */
export function rowsBelowRating(m: PuzzleChunkManifest, rating: number): number {
  const i = Math.floor(rating) - m.ratingMin
  if (i <= 0) return 0
  if (i >= m.ratingCumulative.length) return m.puzzleCount
  return m.ratingCumulative[i]
}

/** First rowid rated >= `rating` (may be past the end of the table). */
export function firstRowidAtLeast(m: PuzzleChunkManifest, rating: number): number {
  return rowsBelowRating(m, rating) + 1
}

/** Last rowid rated <= `rating` (0 when nothing is). */
export function lastRowidAtMost(m: PuzzleChunkManifest, rating: number): number {
  return rowsBelowRating(m, rating + 1)
}
