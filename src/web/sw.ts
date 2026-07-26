// The offline layer for the static web target.
//
// Compiled to <outDir>/sw.js by the `nodechess-service-worker` plugin in
// vite.web.config.ts, which injects the build id and the precache list from the
// bundle it just emitted. Nothing imports this file; it runs in its own thread.
//
// WHAT IS HERE, and why each store is separate:
//
//   nodechess-shell-<build>   the app shell: index.html, the entry chunk and
//                             its static imports, every stylesheet, the two
//                             fonts, the icons. Precached at install, so the
//                             SECOND visit paints with the network off. Keyed
//                             to the build, so a deploy gets its own copy and
//                             the page that is already running keeps the one it
//                             booted with.
//   nodechess-assets-v1       hashed /assets/ files a route pulled in lazily.
//                             Cache-first forever: the name IS the content
//                             hash. FIFO-trimmed so a year of deploys cannot
//                             grow without bound.
//   nodechess-static-v1       /engines/, /content/, /games-art/: real files
//                             with unfingerprinted names. Cache-first, and
//                             each entry carries the build that stored it, so
//                             a deploy revalidates each one exactly once
//                             instead of on every load.
//   nodechess-puzzles-v1      the puzzle manifest, the reader's server probe,
//                             and the individual BYTE RANGES it has read.
//                             See the block above puzzleResponse().
//
// WHAT IS DELIBERATELY NOT HERE: the puzzle chunk files themselves (60 files,
// 1.49 GB) and any response that was never fetched. When something is missing
// and the network is gone this answers with an error, never with a stand-in.

export {}

// ---- injected by the build ------------------------------------------------

/** Short hash of the precache list. Changes exactly when the shell changes. */
declare const __BUILD_ID__: string
/** Shell files, relative to the registration scope. */
declare const __PRECACHE__: string[]
/** The subset of __PRECACHE__ without which there is no app to open offline.
 *  Install fails rather than leaving a half-shell that boots into nothing. */
declare const __CORE__: string[]
/** Where the puzzle chunks are served from: `/puzzles/` in dev, the object
 *  store in production (VITE_PUZZLE_BASE_URL, see docs/DEPLOY-WEB.md Part 6).
 *  Injected rather than derived from the scope, because this worker has to
 *  recognise those URLs when they belong to somebody else's origin. */
declare const __PUZZLE_BASE__: string

// ---- the small slice of the ServiceWorker global this file touches ---------
//
// tsconfig.web.json compiles this directory with lib DOM (the renderer needs
// it) and cannot also load lib WebWorker: the two disagree about `self`. So the
// handful of service-worker types used here are declared, and everything else
// (Request, Response, Headers, caches, fetch) comes from DOM, where it is
// identical.

interface SwExtendableEvent extends Event {
  waitUntil(f: Promise<unknown>): void
}
interface SwFetchEvent extends SwExtendableEvent {
  readonly request: Request
  respondWith(r: Response | Promise<Response>): void
}
type SwMessageEvent = MessageEvent & { waitUntil(f: Promise<unknown>): void }
interface SwClient {
  postMessage(message: unknown): void
}
interface SwGlobalScope {
  readonly location: Location
  readonly registration: { readonly scope: string }
  readonly clients: {
    claim(): Promise<void>
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<SwClient[]>
  }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', listener: (e: SwExtendableEvent) => void): void
  addEventListener(type: 'fetch', listener: (e: SwFetchEvent) => void): void
  addEventListener(type: 'message', listener: (e: SwMessageEvent) => void): void
}
declare const self: SwGlobalScope

// ---- cache names ----------------------------------------------------------

const SHELL_CACHE = `nodechess-shell-${__BUILD_ID__}`
const ASSET_CACHE = 'nodechess-assets-v1'
const STATIC_CACHE = 'nodechess-static-v1'
const PUZZLE_CACHE = 'nodechess-puzzles-v1'
const OURS = /^nodechess-/

/** Every cache this build still wants. Anything else nodechess owns is dropped
 *  at activate: that is how an old shell stops taking up room. */
const KEEP = new Set([SHELL_CACHE, ASSET_CACHE, STATIC_CACHE, PUZZLE_CACHE])

/** Hashed assets from builds nobody is running any more. The cap is generous
 *  on purpose: pruning to exactly the current build would pull chunks out from
 *  under a tab that is still on the previous one. */
const ASSET_CACHE_MAX_ENTRIES = 600

/** Ceiling on cached puzzle byte ranges, and the mark FIFO eviction trims back
 *  to. A worked puzzle session reads single-digit MB, so this holds a lot of
 *  history without ever approaching an origin storage quota. */
const PUZZLE_BUDGET_BYTES = 128 * 1024 * 1024
const PUZZLE_TRIM_TO_BYTES = 96 * 1024 * 1024

/** How long a navigation waits for the network before the cached shell answers.
 *  Network-first is what keeps a deploy from going unnoticed; the timeout is
 *  what keeps a dead connection from stalling the paint. */
const NAV_TIMEOUT_MS = 3000

const SCOPE = self.registration.scope.endsWith('/')
  ? self.registration.scope
  : `${self.registration.scope}/`
const INDEX_URL = new URL('index.html', SCOPE).href
/** Absolute and slash-terminated, so a prefix test on a request URL is exact
 *  and works whichever origin the artifact ended up on. */
const PUZZLE_BASE = ((): string => {
  const raw = __PUZZLE_BASE__ && __PUZZLE_BASE__.length > 0 ? __PUZZLE_BASE__ : 'puzzles/'
  return new URL(raw.endsWith('/') ? raw : `${raw}/`, SCOPE).href
})()
const ASSET_PATH = new URL('assets/', SCOPE).pathname
const STATIC_PATHS = ['engines/', 'content/', 'games-art/'].map((p) => new URL(p, SCOPE).pathname)

/** Build that stored a /engines/ or /content/ entry, so the next deploy can
 *  refresh it once rather than revalidating on every read. */
const BUILD_HEADER = 'x-nodechess-build'

// ---- install: the shell ---------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
})

async function precache(): Promise<void> {
  const cache = await caches.open(SHELL_CACHE)
  const failed: string[] = []
  // Individually, not addAll: addAll is all-or-nothing, and one missing icon
  // must not cost the whole offline story. __CORE__ is checked after.
  await Promise.all(
    __PRECACHE__.map(async (path) => {
      const url = new URL(path, SCOPE).href
      try {
        // The document is forced past every intermediary: it is the one file
        // whose name does not change when its contents do, and a stale copy of
        // it would name assets this build never emitted. Everything else in the
        // list is content-hashed, so the browser's own cache is authoritative
        // and reusing it makes install nearly free right after a first load.
        const init: RequestInit = path === 'index.html' ? { cache: 'reload' } : {}
        const res = await netFetch(new Request(url, init))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await cache.put(url, res)
      } catch (err) {
        failed.push(`${path} (${String(err)})`)
      }
    })
  )
  if (failed.length > 0) {
    console.warn(`nodechess: ${failed.length} shell file(s) did not precache`, failed)
  }
  for (const path of __CORE__) {
    const url = new URL(path, SCOPE).href
    if (!(await cache.match(url))) {
      throw new Error(`nodechess: ${url} did not precache; the offline shell would not boot`)
    }
  }
}

// ---- activate: drop what this build no longer uses -------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (OURS.test(name) && !KEEP.has(name)) await caches.delete(name)
      }
      await trimAssetCache()
      await self.clients.claim()
    })()
  )
})

/** Two messages from the page, both deliberate; see registerWorker() in
 *  main.web.tsx.
 *
 *   SKIP_WAITING  a new build finished installing while a tab was open. The
 *                 page decides when that is safe; this side just steps aside.
 *   WARM          pull a URL into the static cache with nobody waiting on it.
 *                 Used for the chess engine, which is 7 MB and would otherwise
 *                 only reach the cache once the player opens Analysis. */
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; urls?: string[] } | null
  if (!data || typeof data.type !== 'string') return
  if (data.type === 'SKIP_WAITING') {
    void self.skipWaiting()
    return
  }
  // A page that has just loaded has missed every announcement made before it
  // existed, and the state it missed is exactly the interesting one: a reload
  // with nothing answering. So it asks.
  if (data.type === 'NETWORK_STATUS') {
    const source = (event as unknown as { source?: SwClient | null }).source
    source?.postMessage({ type: 'nodechess-network', offline: announced === 'offline' })
    return
  }
  if (data.type === 'WARM' && Array.isArray(data.urls)) {
    const urls = data.urls.filter((u): u is string => typeof u === 'string').slice(0, 16)
    event.waitUntil(warm(urls))
  }
})

async function warm(urls: string[]): Promise<void> {
  const cache = await caches.open(STATIC_CACHE)
  for (const raw of urls) {
    let url: URL
    try {
      url = new URL(raw, SCOPE)
    } catch {
      continue
    }
    if (url.origin !== self.location.origin) continue
    if (!STATIC_PATHS.some((p) => url.pathname.startsWith(p))) continue
    const hit = await cache.match(url.href)
    if (hit && hit.headers.get(BUILD_HEADER) === __BUILD_ID__) continue
    try {
      const res = await netFetch(url.href)
      if (res.ok) await cache.put(url.href, stamped(res))
    } catch {
      // Warming is best effort by definition. The on-demand path caches it.
    }
  }
}

// ---- routing ---------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' && req.method !== 'HEAD') return
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  // Puzzles FIRST, and by full URL: the artifact is usually not on this origin
  // (Cloudflare Pages does not serve ranges, so the chunks live in a bucket),
  // and the range cache below is the only reason a read of a chunk this device
  // has already seen is free.
  if (req.url.startsWith(PUZZLE_BASE)) {
    event.respondWith(puzzleResponse(event).then(crossOriginReadable))
    return
  }
  // Someone else's origin: the accounts layer's peers, a CDN, an extension.
  // Not ours to cache and not ours to answer for.
  if (url.origin !== self.location.origin) return

  // A HEAD is a REACHABILITY QUESTION, and offline it has to be answered from
  // what is stored or the answer is wrong. src/web/engines/assets.ts asks one
  // per engine asset and engine.status() reports not-ready when it fails, which
  // gates Play and Analysis: pass these to the network and a fully cached
  // 7 MB Stockfish sits on disk unused behind a screen that says it is not
  // installed.
  if (req.method === 'HEAD') {
    event.respondWith(headResponse(req))
    return
  }
  if (req.mode === 'navigate') {
    event.respondWith(navigationResponse(req))
    return
  }
  if (url.pathname.startsWith(ASSET_PATH)) {
    event.respondWith(assetResponse(event, req))
    return
  }
  if (STATIC_PATHS.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(staticResponse(event, req))
    return
  }
  event.respondWith(shellFirstResponse(req))
})

/** Headers only, from whichever cache holds the GET for this URL. Never a body:
 *  a HEAD with one is a protocol error, and the callers only read headers. */
async function headResponse(request: Request): Promise<Response> {
  const hit = await caches.match(request.url)
  if (hit) return new Response(null, { status: 200, statusText: 'OK', headers: hit.headers })
  try {
    return await netFetch(request)
  } catch (err) {
    return offlineResource(request.url, err)
  }
}

// ---- navigations: network first, cached shell when it does not answer ------

async function navigationResponse(request: Request): Promise<Response> {
  const shell = await caches.open(SHELL_CACHE)
  const cached = await shell.match(INDEX_URL)
  const network = netFetch(request).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  })
  if (!cached) return network.catch(() => offlineDocument())

  let timer: ReturnType<typeof setTimeout> | undefined
  const fallback = new Promise<Response>((resolve) => {
    timer = setTimeout(() => resolve(cached.clone()), NAV_TIMEOUT_MS)
  })
  try {
    return await Promise.race([network, fallback])
  } catch {
    return cached.clone()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---- hashed assets: the name is the content hash --------------------------

async function assetResponse(event: SwFetchEvent, request: Request): Promise<Response> {
  const shell = await caches.open(SHELL_CACHE)
  const precached = await shell.match(request.url)
  if (precached) return precached

  const cache = await caches.open(ASSET_CACHE)
  const hit = await cache.match(request.url)
  if (hit) return hit
  try {
    const res = await netFetch(request)
    if (res.ok) event.waitUntil(cache.put(request.url, res.clone()))
    return res
  } catch (err) {
    return offlineResource(request.url, err)
  }
}

// ---- engines, content, games-art: named files, refreshed once per deploy ---

async function staticResponse(event: SwFetchEvent, request: Request): Promise<Response> {
  const cache = await caches.open(STATIC_CACHE)
  const hit = await cache.match(request.url)
  if (hit) {
    // Stored by an older build. Serve it now (it is almost always still the
    // same file) and pull the current bytes in behind the reader, so the next
    // load is up to date without this one paying for it.
    if (hit.headers.get(BUILD_HEADER) !== __BUILD_ID__) {
      event.waitUntil(
        netFetch(request)
          .then((res) => (res.ok ? cache.put(request.url, stamped(res)) : undefined))
          .catch(() => undefined)
      )
    }
    return hit
  }
  try {
    const res = await netFetch(request)
    if (res.ok) event.waitUntil(cache.put(request.url, stamped(res.clone())))
    return res
  } catch (err) {
    return offlineResource(request.url, err)
  }
}

/** The same response with the build id attached. The body is passed through as
 *  a stream, so a 7 MB engine is never held in memory to be tagged. */
function stamped(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set(BUILD_HEADER, __BUILD_ID__)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

// ---- anything else same-origin (the web manifest, the icons) ---------------

async function shellFirstResponse(request: Request): Promise<Response> {
  const shell = await caches.open(SHELL_CACHE)
  const precached = await shell.match(request.url)
  if (precached) return precached
  try {
    return await netFetch(request)
  } catch (err) {
    const any = await caches.match(request.url)
    return any ?? offlineResource(request.url, err)
  }
}

// ---- puzzles ---------------------------------------------------------------
//
// The artifact is 60 files totalling 1.49 GB, read by HTTP range request from a
// WASM SQLite worker (src/web/data). Precaching it is not on the table, and a
// cached FULL response would be worse than useless: hand a 200 to a reader that
// asked for bytes 8192-16383 and it reads the wrong pages and answers with
// puzzles that do not exist.
//
// So the ranges themselves are the cache unit. Each entry is keyed by the exact
// URL (cache-buster included) AND the exact byte range that was requested, and
// is replayed as a 206 carrying the Content-Range the server sent. An exact key
// match therefore replays byte-identical bytes; a range that was never fetched
// misses, and offline that surfaces as an error the puzzle surfaces already
// handle by showing nothing rather than something invented.
//
// Net effect: puzzles the player has already worked through stay available with
// the network off. A new random puzzle from an unread part of the database does
// not, and says so.
//
// THE ARTIFACT IS NORMALLY ON ANOTHER ORIGIN. Cloudflare Pages, which serves
// the site, replies to a ranged GET with 200 and the whole 24 MiB object, so
// the chunks live in a bucket that does byte serving instead
// (docs/DEPLOY-WEB.md Part 6). Two consequences here: PUZZLE_BASE is matched as
// a full URL rather than a path, and everything this worker hands back for one
// of those URLs is given Cross-Origin-Resource-Policy, because the page is
// crossOriginIsolated and a response synthesised here carries no headers except
// the ones it is given.
//
// Three request shapes arrive here:
//   GET  puzzles.manifest.json      small, revalidated, kept as a fallback
//   HEAD puzzles.sqlite.000?cb=...  the reader's one-time server probe
//   GET  puzzles.sqlite.NNN?cb=...  with Range: bytes=a-b

async function puzzleResponse(event: SwFetchEvent): Promise<Response> {
  const request = event.request
  const url = new URL(request.url)

  if (url.pathname.endsWith('.json')) return puzzleManifestResponse(event, request)
  if (request.method === 'HEAD') return puzzleProbeResponse(event, request, url)

  const range = parseRange(request.headers.get('range'))
  if (!range) {
    // A whole 25 MiB chunk. Nothing asks for this in normal operation, and
    // storing one would spend the entire budget on a single entry.
    return netFetch(request).catch((err) => offlineResource(request.url, err))
  }

  const cache = await caches.open(PUZZLE_CACHE)
  const key = rangeKey(url, range)
  const hit = await cache.match(key)
  if (hit) return replayRange(hit)

  let res: Response
  try {
    res = await netFetch(request)
  } catch (err) {
    return offlinePuzzleRange(err)
  }
  // A 200 to a ranged GET means the origin does not do byte serving, and the
  // reader cannot tell (sql.js-httpvfs takes any 2xx body as the bytes it
  // asked for), so this is a correctness problem before it is a bandwidth one.
  // sliceRange cuts the requested window out of whatever arrived.
  const partial = res.status === 200 ? await sliceRange(res, range, request.url) : res
  const contentRange = partial.status === 206 ? partial.headers.get('content-range') : null
  if (contentRange) {
    const copy = partial.clone()
    const headers = new Headers()
    headers.set('x-nodechess-content-range', contentRange)
    const type = partial.headers.get('content-type')
    if (type) headers.set('x-nodechess-content-type', type)
    const bytes = rangeLength(contentRange)
    headers.set('x-nodechess-bytes', String(bytes))
    event.waitUntil(
      cache
        .put(key, new Response(copy.body, { status: 200, headers }))
        .then(() => noteRangeBytes(bytes))
        .catch(() => undefined)
    )
  }
  return partial
}

/** Bytes this worker is willing to hold in memory to rescue one range read.
 *  A chunk is 24 MiB by construction (scripts/build-puzzle-chunks.mjs sizes
 *  them for Cloudflare Pages' 25 MiB file cap); anything larger is not our
 *  artifact and is refused rather than buffered. */
const MAX_WHOLE_CHUNK_BYTES = 32 * 1024 * 1024

/** The requested window, cut out of a response that is the WHOLE file.
 *
 *  Only reachable when the puzzle origin ignored `Range`. It is a floor, not
 *  the fix: the download already happened, so the read costs the whole chunk.
 *  What it buys is correctness, which is not optional here, because the caller
 *  would otherwise read 25 MB of file as if it were the 8 KiB page it asked
 *  for and answer with puzzles that do not exist. The fix is an origin that
 *  answers 206 (docs/DEPLOY-WEB.md Part 6). */
async function sliceRange(res: Response, range: ByteRange, url: string): Promise<Response> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_WHOLE_CHUNK_BYTES) return rangeUnsupported(url)
  let whole: ArrayBuffer
  try {
    whole = await res.arrayBuffer()
  } catch (err) {
    return offlinePuzzleRange(err)
  }
  if (whole.byteLength > MAX_WHOLE_CHUNK_BYTES || range.start >= whole.byteLength) {
    return rangeUnsupported(url)
  }
  const end = Math.min(range.end, whole.byteLength - 1)
  const body = whole.slice(range.start, end + 1)
  warnRangeIgnored(url, whole.byteLength, body.byteLength)
  const headers = new Headers()
  headers.set('Content-Range', `bytes ${range.start}-${end}/${whole.byteLength}`)
  headers.set('Content-Length', String(body.byteLength))
  headers.set('Accept-Ranges', 'bytes')
  const type = res.headers.get('content-type')
  if (type) headers.set('Content-Type', type)
  return new Response(body, { status: 206, statusText: 'Partial Content', headers })
}

/** Once per worker lifetime, with the numbers that were actually measured. */
let rangeWarned = false

function warnRangeIgnored(url: string, sent: number, wanted: number): void {
  if (rangeWarned) return
  rangeWarned = true
  console.warn(
    `nodechess: the puzzle origin ignored Range and sent ${sent} bytes for a ${wanted} byte read ` +
      `(${url}). The bytes served to the reader are correct, this worker cut them out, but every ` +
      'uncached read costs a whole chunk. See docs/DEPLOY-WEB.md Part 6.'
  )
}

function rangeUnsupported(url: string): Response {
  return new Response(
    `nodechess: ${url} answered a byte-range request with the whole file, and it is too large to ` +
      'cut the range out of. The puzzle origin does not support HTTP Range; see ' +
      'docs/DEPLOY-WEB.md Part 6.',
    { status: 502, statusText: 'Range Not Supported', headers: PLAIN }
  )
}

/** Cross-Origin-Resource-Policy on everything the worker returns for a puzzle
 *  URL. The document is crossOriginIsolated (COEP require-corp), where a
 *  cross-origin subresource has to be agreed to; the bucket's CORS agreement
 *  covers the responses that come off the network, and this covers the ones
 *  this file builds itself (a replayed range, an offline notice), which carry
 *  no headers but their own. Same-origin puzzles neither need it nor mind it. */
function crossOriginReadable(res: Response): Response {
  // An opaque response has no headers to copy and cannot be reconstructed.
  if (res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res
  if (res.headers.get('cross-origin-resource-policy') === 'cross-origin') return res
  const headers = new Headers(res.headers)
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/** The manifest pins which build the chunk URLs address, so it is fetched fresh
 *  whenever there is a network (the reader asks for `cache: 'no-cache'` too).
 *  The stored copy exists purely so the reader can still open offline. A build
 *  id that has moved invalidates every stored range: those bytes belong to a
 *  database that is no longer deployed. */
async function puzzleManifestResponse(event: SwFetchEvent, request: Request): Promise<Response> {
  const cache = await caches.open(PUZZLE_CACHE)
  let res: Response
  try {
    res = await netFetch(request)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    const hit = await cache.match(request.url)
    return hit ?? offlineResource(request.url, new Error('offline'))
  }
  const copy = res.clone()
  event.waitUntil(
    (async () => {
      try {
        const parsed = (await copy.clone().json()) as { buildId?: unknown }
        if (typeof parsed.buildId === 'string') await onPuzzleBuild(parsed.buildId)
        await (await caches.open(PUZZLE_CACHE)).put(request.url, copy)
      } catch {
        // A manifest that will not parse is the reader's to report, and not
        // something worth keeping a copy of.
      }
    })()
  )
  return res
}

const PUZZLE_BUILD_KEY = new URL('__nodechess/puzzle-build', SCOPE).href

async function onPuzzleBuild(buildId: string): Promise<void> {
  const cache = await caches.open(PUZZLE_CACHE)
  const seen = await cache.match(PUZZLE_BUILD_KEY)
  const previous = seen ? await seen.text() : null
  if (previous === buildId) return
  // A different artifact: every stored range addresses bytes that have moved.
  if (previous !== null) await caches.delete(PUZZLE_CACHE)
  const fresh = await caches.open(PUZZLE_CACHE)
  await fresh.put(PUZZLE_BUILD_KEY, new Response(buildId))
  puzzleBytes = null
}

/** The reader opens with a synchronous HEAD against chunk 000 and refuses to
 *  start if it does not answer. Stored headers let that succeed offline. */
async function puzzleProbeResponse(
  event: SwFetchEvent,
  request: Request,
  url: URL
): Promise<Response> {
  const cache = await caches.open(PUZZLE_CACHE)
  const key = probeKey(url)
  try {
    const res = await netFetch(request)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const record: Record<string, string> = {}
    for (const name of ['content-length', 'accept-ranges', 'content-type']) {
      const value = res.headers.get(name)
      if (value) record[name] = value
    }
    event.waitUntil(cache.put(key, new Response(JSON.stringify(record), { status: 200 })))
    return res
  } catch (err) {
    const hit = await cache.match(key)
    if (!hit) return offlinePuzzleRange(err)
    const record = (await hit.json()) as Record<string, string>
    const headers = new Headers()
    for (const [name, value] of Object.entries(record)) headers.set(name, value)
    if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes')
    return new Response(null, { status: 200, statusText: 'OK', headers })
  }
}

interface ByteRange {
  start: number
  end: number
}

/** Only `bytes=<start>-<end>`, which is the single shape the reader sends. An
 *  open-ended or multi-part range is passed through uncached rather than
 *  guessed at. */
function parseRange(header: string | null): ByteRange | null {
  if (!header) return null
  const m = /^bytes=(\d+)-(\d+)$/.exec(header.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null
  return { start, end }
}

function rangeKey(url: URL, range: ByteRange): string {
  const key = new URL(url.href)
  key.searchParams.set('__ncrange', `${range.start}-${range.end}`)
  return key.href
}

function probeKey(url: URL): string {
  const key = new URL(url.href)
  key.searchParams.set('__ncprobe', '1')
  return key.href
}

/** `bytes 0-8191/25165824` -> 8192. A server may return fewer bytes than were
 *  asked for (the reader's read-ahead can run past the end of a chunk file), so
 *  the stored Content-Range is the truth and is replayed verbatim. */
function rangeLength(contentRange: string): number {
  const m = /^bytes (\d+)-(\d+)\//.exec(contentRange.trim())
  if (!m) return 0
  return Number(m[2]) - Number(m[1]) + 1
}

async function replayRange(entry: Response): Promise<Response> {
  const contentRange = entry.headers.get('x-nodechess-content-range')
  if (!contentRange) return offlinePuzzleRange(new Error('stored range lost its Content-Range'))
  const body = await entry.arrayBuffer()
  const headers = new Headers()
  headers.set('Content-Range', contentRange)
  headers.set('Content-Length', String(body.byteLength))
  headers.set('Accept-Ranges', 'bytes')
  const type = entry.headers.get('x-nodechess-content-type')
  if (type) headers.set('Content-Type', type)
  return new Response(body, { status: 206, statusText: 'Partial Content', headers })
}

// ---- eviction --------------------------------------------------------------

/** Running total of the puzzle range cache, counted once per worker lifetime. */
let puzzleBytes: number | null = null

async function noteRangeBytes(bytes: number): Promise<void> {
  if (puzzleBytes === null) puzzleBytes = await measurePuzzleCache()
  puzzleBytes += bytes
  if (puzzleBytes <= PUZZLE_BUDGET_BYTES) return
  const cache = await caches.open(PUZZLE_CACHE)
  // cache.keys() is insertion ordered, so the front is the oldest range and the
  // least likely to belong to a puzzle the player still remembers.
  for (const request of await cache.keys()) {
    if (puzzleBytes <= PUZZLE_TRIM_TO_BYTES) break
    if (request.url === PUZZLE_BUILD_KEY) continue
    const size = entryBytes(await cache.match(request))
    if (await cache.delete(request)) puzzleBytes -= size
  }
}

async function measurePuzzleCache(): Promise<number> {
  const cache = await caches.open(PUZZLE_CACHE)
  let total = 0
  for (const request of await cache.keys()) total += entryBytes(await cache.match(request))
  return total
}

function entryBytes(entry: Response | undefined): number {
  const size = Number(entry?.headers.get('x-nodechess-bytes') ?? 0)
  return Number.isFinite(size) ? size : 0
}

async function trimAssetCache(): Promise<void> {
  const cache = await caches.open(ASSET_CACHE)
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - ASSET_CACHE_MAX_ENTRIES; i++) {
    await cache.delete(keys[i])
  }
}

// ---- telling the page ------------------------------------------------------
//
// `navigator.onLine` answers a narrower question than the app needs: it says
// this device has a link, not that the site is reachable. A dead host, a
// captive portal and a tunnel that has dropped all read as online, and the
// screens that go quiet in those states look identical to a screen with nothing
// in it. Every request goes through here, so this is the one place that knows
// the difference, and it tells the page (src/web/offlineNotice.ts) on change.

let announced: 'online' | 'offline' | null = null

function announce(state: 'online' | 'offline'): void {
  if (announced === state) return
  announced = state
  void self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      client.postMessage({ type: 'nodechess-network', offline: state === 'offline' })
    }
  })
}

/** fetch(), plus the observation. A non-2xx is a REACHED server, so only a
 *  thrown request counts as offline; a 404 means the deploy is missing a file
 *  and saying "offline" about it would be a lie. */
async function netFetch(request: Request | string): Promise<Response> {
  try {
    const res = await fetch(request as Request)
    announce('online')
    return res
  } catch (err) {
    announce('offline')
    throw err
  }
}

// ---- what missing looks like ------------------------------------------------
//
// Never an empty 200. A caller that gets a 200 with no body believes it, and
// believing it is how a screen ends up showing something that is not there.

const PLAIN = { 'Content-Type': 'text/plain; charset=utf-8' }

function offlineResource(url: string, err: unknown): Response {
  return new Response(
    `nodechess is offline and ${url} is not stored on this device. ${String(err)}`,
    { status: 504, statusText: 'Offline', headers: PLAIN }
  )
}

function offlinePuzzleRange(err: unknown): Response {
  return new Response(
    'nodechess is offline. This part of the puzzle database has not been read on this device yet. ' +
      String(err),
    { status: 504, statusText: 'Offline', headers: PLAIN }
  )
}

/** Only reachable on a first-ever visit that is already offline, where there is
 *  no shell to fall back to and so no app to say this inside. */
function offlineDocument(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>nodechess</title>' +
      '<body style="font:14px system-ui,sans-serif;background:#1a1b1d;color:#e6e7e7;padding:2em">' +
      '<p>nodechess has not been loaded on this device yet, and there is no connection to load it with.</p>' +
      '<p>Open it once with a connection and it will work offline afterwards.</p>',
    { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}
