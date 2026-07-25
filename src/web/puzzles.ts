// The puzzle library, client side.
//
// One reader for the life of the page (src/web/data; WASM SQLite over HTTP
// range requests against the chunked artifact under <base>puzzles/). It answers
// the five READ channels; everything user-scoped, attempts, ratings, daily
// results, Rush runs, is local state webApi merges around it (localData.ts).
//
// The reader is created on FIRST USE so a session that never opens Puzzles
// never downloads the WASM, and reused so its page cache stays warm: a rating
// window is one contiguous range read, and the next puzzle from the same band
// usually costs nothing.

import { createStaticPuzzleReader, type StaticPuzzleReader } from './data'

let reader: StaticPuzzleReader | null = null

export function puzzleReader(): StaticPuzzleReader {
  if (!reader) reader = createStaticPuzzleReader()
  return reader
}

/** Reachability probe for datasets.status: does the artifact actually answer?
 *  The manifest alone settles it: one small fetch, no database read. Throws
 *  when the artifact isn't deployed, which is the caller's signal. */
export function puzzleDatasetInfo(): ReturnType<StaticPuzzleReader['info']> {
  return puzzleReader().info()
}
