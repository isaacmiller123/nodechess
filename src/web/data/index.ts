// Static puzzle data for the serverless web target.
//
// The desktop reads resources/data/puzzles.sqlite through node:sqlite; the
// current web port proxies the same reads through Fastify (POST /api/ipc/
// puzzles:*). Neither works on a host with no server. This directory reads the
// SAME database directly from the browser: scripts/build-puzzle-chunks.mjs
// splits it into ~24 MiB static files, and the reader below queries it over HTTP
// Range requests so a puzzle costs the handful of B-tree pages it actually
// touches, not the 2 GB the file weighs.
//
//   chunkedDb.ts    the WASM SQLite + range VFS (sql.js-httpvfs). Connection only
//   manifest.ts     the build manifest, and the rowid arithmetic it enables
//   puzzleSource.ts the query surface, mirroring the puzzle IPC channels
//
// Wiring:
//
//   const puzzles = createStaticPuzzleReader()      // <base>puzzles/ by default
//   const { puzzle } = await puzzles.next({ ratingLo: 900, ratingHi: 1400 })
//
// Hold ONE reader for the life of the page: it owns a worker and its page cache,
// and nothing here is per-user. The reader serves the read-only channels only:
// next/get/themes/batch/daily. Attempts, ratings, rush runs and daily results
// are user state that does not exist in a static artifact; `daily()` returns
// `result: null` and the caller merges the local outcome.

export { createStaticPuzzleReader } from './puzzleSource'
export type {
  PuzzleDatasetInfo,
  StaticPuzzleReader,
  StaticPuzzleReaderOptions
} from './puzzleSource'
export { loadManifest, parseManifest } from './manifest'
export type { PuzzleChunkManifest } from './manifest'
export { ChunkedSqlite } from './chunkedDb'
export type { ChunkedDbOptions } from './chunkedDb'
