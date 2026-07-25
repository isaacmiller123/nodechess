// The chunked SQLite connection: a WASM SQLite in a worker whose file reads are
// HTTP Range requests against the split files build-puzzle-chunks.mjs produced.
//
// WHY sql.js-httpvfs rather than a VFS of our own over wa-sqlite or
// @sqlite.org/sqlite-wasm: it is the only published implementation of the exact
// shape this deployment needs — a byte range mapped onto `<prefix><nnn>` split
// files, so a 2 GB database survives Cloudflare Pages' 25 MiB per-file cap. Its
// reads are synchronous XHR inside the worker, which means no COOP/COEP
// requirement of its own, no Asyncify/JSPI build, and no browser-support
// caveats; and its read-head heuristic already grows sequential fetches, which
// is what makes the clustered rating scans cheap. The alternatives would each
// need several hundred lines of hand-written, hard-to-test VFS to reach parity.
// The costs, both accepted knowingly: the package has been unmaintained since
// 2022, and its page cache never evicts (see `transferStats`).
//
// Everything here is deliberately thin — the queries live in puzzleSource.ts.

import { releaseProxy } from 'comlink'
import { createDbWorker, type SqliteStats, type WorkerHttpvfs } from 'sql.js-httpvfs'
// The worker script and its wasm ship inside the package as prebuilt files;
// Vite emits them as assets and hands us the URLs. They must be same-origin
// (COEP require-corp — vite.web.config.ts sets it for the engine workers).
import defaultWorkerUrl from 'sql.js-httpvfs/dist/sqlite.worker.js?url'
import defaultWasmUrl from 'sql.js-httpvfs/dist/sql-wasm.wasm?url'
import type { PuzzleChunkManifest } from './manifest'

export type SqlParam = string | number | null

export interface ChunkedDbOptions {
  /** Directory the chunk files live in, e.g. '/puzzles/'. Resolved against the
   *  document before use: the worker resolves relative URLs against ITS own
   *  location (the emitted /assets/ path), which would 404 every read. */
  baseUrl: string
  manifest: PuzzleChunkManifest
  workerUrl?: string
  wasmUrl?: string
  /** Hard ceiling on bytes read per open. Left unbounded by default — a query
   *  that trips it fails mid-flight, which is worse than a slow one. */
  maxBytesToRead?: number
}

export class ChunkedSqlite {
  private readonly opts: ChunkedDbOptions
  private handle: WorkerHttpvfs | null = null
  private opening: Promise<WorkerHttpvfs> | null = null
  private closed = false

  constructor(opts: ChunkedDbOptions) {
    this.opts = opts
  }

  /** Idempotent, single-flight: several surfaces (home card, trainer, school)
   *  race to the first query on boot and must share one worker. */
  private connect(): Promise<WorkerHttpvfs> {
    if (this.closed) return Promise.reject(new Error('puzzle database connection is closed'))
    if (this.handle) return Promise.resolve(this.handle)
    if (!this.opening) {
      this.opening = this.spawn().then(
        (h) => {
          this.handle = h
          return h
        },
        (err) => {
          // Drop the failed attempt so a later call can retry (a transient
          // network failure on boot must not brick puzzles for the session).
          this.opening = null
          throw err
        }
      )
    }
    return this.opening
  }

  private async spawn(): Promise<WorkerHttpvfs> {
    const { manifest: m } = this.opts
    const base = absoluteUrl(this.opts.baseUrl)
    return createDbWorker(
      [
        {
          from: 'inline',
          config: {
            serverMode: 'chunked',
            // The mapper builds `${urlPrefix}${chunkIndex padded to
            // suffixLength}` — matching the names the build script writes.
            urlPrefix: `${base}${m.db.prefix}`,
            serverChunkSize: m.db.chunkBytes,
            databaseLengthBytes: m.db.bytes,
            suffixLength: m.db.suffixLength,
            // Must equal the database's page size, or every page read costs two
            // requests (too small) or fetches dead bytes (too large).
            requestChunkSize: m.db.pageSize,
            cacheBust: m.buildId
          }
        }
      ],
      this.opts.workerUrl ?? defaultWorkerUrl,
      this.opts.wasmUrl ?? defaultWasmUrl,
      this.opts.maxBytesToRead
    )
  }

  async query<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const h = await this.connect()
    // `query` forwards its rest args straight to sql.js `exec(sql, bindParams)`,
    // so the parameters go over as ONE array argument, not spread.
    return (await h.db.query(sql, params)) as T[]
  }

  /** Bytes and requests this connection has pulled. Worth watching: the
   *  library's page cache is unbounded, so `totalFetchedBytes` is also roughly
   *  the worker's retained heap. */
  async stats(): Promise<SqliteStats | null> {
    if (!this.handle) return null
    return (await this.handle.worker.getStats()) ?? null
  }

  /** Releases the Comlink proxies. The library exposes no handle on the
   *  underlying Worker, so the thread itself lives until the page unloads —
   *  which is why callers should hold ONE reader for the app's lifetime rather
   *  than opening one per view. */
  async close(): Promise<void> {
    this.closed = true
    const h = this.handle
    this.handle = null
    this.opening = null
    if (!h) return
    h.db[releaseProxy]()
    h.worker[releaseProxy]()
  }
}

/** Absolute URL for a possibly root-relative base, always with a trailing
 *  slash so the chunk prefix concatenates cleanly. */
function absoluteUrl(url: string): string {
  const withSlash = url.endsWith('/') ? url : `${url}/`
  if (/^https?:\/\//i.test(withSlash)) return withSlash
  if (typeof location === 'undefined') {
    throw new Error(`puzzle chunk baseUrl must be absolute outside a browser context: ${url}`)
  }
  return new URL(withSlash, location.href).href
}
