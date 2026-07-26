import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import type { OutputAsset, OutputChunk } from 'rollup'
import type { Connect, Plugin } from 'vite'
import { defineConfig, loadEnv } from 'vite'
import { build as esbuild } from 'esbuild'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Web-target build (docs/WEB-PORT-SPEC.md): the UNCHANGED renderer compiled as
// a plain SPA against src/web/main.web.tsx (which installs the web `Api`
// implementation before booting '@/main'). This is fully separate from
// electron.vite.config.ts. The desktop build never reads this file.
//
// The output is a STATIC SITE: no server process anywhere in the request path.
// Puzzles come from the chunked SQLite artifact (src/web/data), the curriculum/
// famous/persona catalogs from the content files emitted below, everything else
// runs in the browser (engines, review, coaching) or in localStorage.
//
// COOP/COEP headers: multi-threaded Stockfish WASM (W2) needs
// SharedArrayBuffer, which browsers only enable in a crossOriginIsolated
// context. src/web/public/_headers asks Cloudflare Pages for the same two
// headers, so dev, preview and production share one isolation story.

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

const CROSS_ORIGIN_ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
}

// ---- the puzzle artifact is NOT part of the site -------------------------------
//
// scripts/build-puzzle-chunks.mjs writes 60 chunk files + a manifest to
// dist-puzzles/, and src/web/data reads them with HTTP Range requests. They used
// to be symlinked into publicDir, which put them in dist-web and therefore on
// Cloudflare Pages. That does not work, and not slowly: PAGES DOES NOT SERVE
// RANGES. Measured against the live site on 2026-07-26,
// `Range: bytes=0-1023` on /puzzles/puzzles.sqlite.000 came back `200` with all
// 25,165,824 bytes (the same request to this dev server returns 206 and 1,024
// bytes), and sql.js-httpvfs reads that body as if it were the range, so pages
// land at the wrong offsets. In production the chunks therefore live in an
// object store that does byte serving, and VITE_PUZZLE_BASE_URL points the
// reader and the service worker at it (docs/DEPLOY-WEB.md Part 6).
//
// Which leaves dev and `vite preview` needing to serve them from disk. That is
// what puzzleArtifact() below does, with real 206s, so a range bug reproduces
// locally instead of only after a deploy.

const PUZZLE_ARTIFACT_DIR = resolve(__dirname, 'dist-puzzles')
/** Path the reader asks for when VITE_PUZZLE_BASE_URL is unset. Must agree with
 *  puzzleArtifactBaseUrl() in src/web/data/puzzleSource.ts, whose default is
 *  `<base>puzzles/` and whose base is `/`. */
const PUZZLE_URL_PATH = '/puzzles/'
/** The env dir is the REPO ROOT, not `root` (src/web), so a .env.production
 *  sits where someone would look for it. Only VITE_-prefixed keys reach the
 *  bundle, which is the whole of what this reads. */
const ENV_DIR = resolve(__dirname)

/** Where the chunks are served from, trailing slash guaranteed. Same rule as
 *  the reader's, because the service worker is handed this value and has to
 *  recognise the URLs the reader will ask for. */
function puzzleBaseUrl(configured: string | undefined): string {
  const base = configured?.trim()
  if (!base) return PUZZLE_URL_PATH
  return base.endsWith('/') ? base : `${base}/`
}

/** Stream one chunk file, honouring Range. Deliberately narrow: GET and HEAD,
 *  one flat directory, one `bytes=a-b` shape, no directory listing. */
function puzzleArtifactMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    let path: string
    try {
      path = decodeURIComponent((req.url ?? '').split('?')[0])
    } catch {
      return next() // malformed percent-encoding: not a chunk name, not ours
    }
    if (!path.startsWith(PUZZLE_URL_PATH)) return next()
    const name = path.slice(PUZZLE_URL_PATH.length)
    // The names build-puzzle-chunks.mjs writes and nothing else: no traversal,
    // no nested paths, no dotfiles.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return next()
    const file = resolve(PUZZLE_ARTIFACT_DIR, name)
    let size: number
    try {
      const stat = statSync(file)
      if (!stat.isFile()) return next()
      size = stat.size
    } catch {
      // Not built yet. Vite answers 404 and the reader reports the artifact
      // missing, which is the honest state; `npm run setup` is the fix.
      return next()
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader(
      'Content-Type',
      name.endsWith('.json') ? 'application/json' : 'application/octet-stream'
    )
    for (const [header, value] of Object.entries(CROSS_ORIGIN_ISOLATION)) {
      res.setHeader(header, value)
    }

    // The reader's server probe. Headers only; a HEAD with a body is a
    // protocol error and the caller only reads Content-Length/Accept-Ranges.
    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', String(size))
      res.statusCode = 200
      res.end()
      return
    }

    const asked = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
    if (!asked) {
      res.setHeader('Content-Length', String(size))
      res.statusCode = 200
      createReadStream(file).pipe(res)
      return
    }
    const start = Number(asked[1])
    const end = asked[2] === '' ? size - 1 : Math.min(Number(asked[2]), size - 1)
    if (!Number.isSafeInteger(start) || start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`)
      res.statusCode = 416
      res.end()
      return
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', String(end - start + 1))
    res.statusCode = 206
    createReadStream(file, { start, end }).pipe(res)
  }
}

/** dist-puzzles at /puzzles/ for `dev:web` and `vite preview`, and NOTHING in
 *  the build output: 1.4 GB of chunks in dist-web would only be uploaded to a
 *  host that cannot serve them. */
function puzzleArtifact(): Plugin {
  return {
    name: 'nodechess-puzzle-artifact',
    configureServer(server) {
      server.middlewares.use(puzzleArtifactMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(puzzleArtifactMiddleware())
    }
  }
}

// Engine WASM assets (web port W2, src/web/engines): copied verbatim to
// <outDir>/engines/ on build AND served at /engines/ by the dev server
// (vite-plugin-static-copy does both), so the engine workers load same-origin,
// which is what COEP require-corp demands and what lets the multithreaded
// builds spawn their nested pthread workers.
//
//  - stockfish-18-lite[.js/.wasm]        chess: multithreaded, small NNUE
//                                        EMBEDDED (~7 MB, no separate net).
//  - stockfish-18-lite-single[.js/.wasm] chess fallback when the page is not
//                                        crossOriginIsolated.
//    (each stockfish.js worker resolves its .wasm as <same basename>.wasm
//     next to the script, so the js/wasm pairs MUST stay together)
//  - fairy/*                             Fairy-Stockfish 14 (pychess build):
//                                        UMD script + wasm + its pthread
//                                        worker glue (stockfish.worker.js),
//                                        kept in their own dir because all
//                                        three files resolve relative paths.
// (rename stripBase flattens the copies to <dest>/<basename>. Without it the
// plugin recreates the whole node_modules/... path under dest.)
const ENGINE_ASSETS = [
  ...[
    'stockfish-18-lite.js',
    'stockfish-18-lite.wasm',
    'stockfish-18-lite-single.js',
    'stockfish-18-lite-single.wasm'
  ].map((f) => ({
    src: resolve(__dirname, 'node_modules/stockfish/bin', f),
    dest: 'engines',
    rename: { stripBase: true as const }
  })),
  ...['stockfish.js', 'stockfish.wasm', 'stockfish.worker.js'].map((f) => ({
    src: resolve(__dirname, 'node_modules/fairy-stockfish-nnue.wasm', f),
    dest: 'engines/fairy',
    rename: { stripBase: true as const }
  }))
]

// ---- Static content (the channels the server used to answer) -------------------
//
// Desktop reads resources/{curriculum,famous,personas} from disk in the main
// process and serves school:*/famous:*/personas:list over IPC; the interim web
// server proxied those same handlers over /api/ipc. A static host has neither,
// so the resource files are emitted under <outDir>/content/ and fetched by
// src/web/content/*. The games-art tree rides along here too, because it needs
// its directory structure preserved and the copy plugin's rename modes either
// flatten the tree or keep the repo path.
//
// Emission is deliberately DUMB. Copy the bytes, derive only the chapter index
// and the photo split. Every decision about the DATA (which chapter is locked,
// how SAN movetext expands, how a persona row is coerced) stays in typechecked
// TypeScript next to the shared types it has to satisfy, mirroring the desktop
// repos exactly as src/web/data mirrors puzzles.repo.ts.

const CONTENT_DIR = 'content'
const RESOURCES = resolve(__dirname, 'resources')

interface ContentFile {
  /** Path under <outDir>, e.g. 'content/famous.json'. */
  fileName: string
  /** Read on demand. The art tree alone is 24 MB, and the dev server only
   *  ever wants one file at a time. */
  source: () => Buffer | string
}

function readJsonFile<T>(...segments: string[]): T | null {
  try {
    return JSON.parse(readFileSync(resolve(RESOURCES, ...segments), 'utf8')) as T
  } catch {
    return null
  }
}

/** Curriculum: every chapter verbatim, plus the index the school view lists.
 *  The index carries `eloFloor` because the unlock rule is computed in the
 *  browser now (school.repo.chapterMetas did it in the main process); the web
 *  loader strips it before anything renderable sees a chapter. */
function schoolContent(): ContentFile[] {
  const dir = resolve(RESOURCES, 'curriculum/chapters')
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch {
    return [] // lean checkout without the curriculum. The loader reports it
  }

  const out: ContentFile[] = []
  const index: Record<string, unknown>[] = []
  for (const file of files) {
    const raw = readFileSync(resolve(dir, file), 'utf8')
    let ch: Record<string, unknown>
    try {
      ch = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue // one bad file must not fail the build (school.repo.ts skips it too)
    }
    const id = ch.id
    if (typeof id !== 'string' || !id) continue
    out.push({ fileName: `${CONTENT_DIR}/school/chapter/${id}.json`, source: () => raw })
    index.push({
      id,
      band: ch.band,
      order: ch.order,
      title: ch.title,
      subtitle: ch.subtitle,
      estMinutes: ch.estMinutes,
      conceptCount: Array.isArray(ch.concepts) ? ch.concepts.length : 0,
      lessonCount: Array.isArray(ch.lessons) ? ch.lessons.length : 0,
      eloFloor: typeof ch.eloFloor === 'number' ? ch.eloFloor : 0
    })
  }
  // Curriculum order (band, then order within band): allChapters()'s sort.
  index.sort((a, b) =>
    a.band === b.band
      ? (a.order as number) - (b.order as number)
      : (a.band as string) < (b.band as string)
        ? -1
        : 1
  )
  const chapters = JSON.stringify({ chapters: index })
  out.push({ fileName: `${CONTENT_DIR}/school/chapters.json`, source: () => chapters })
  return out
}

/** Famous games: the two shards merged the way famous.repo.ts merges them
 *  (curated wins an id collision). Movetext stays SAN. The per-ply expansion
 *  is chessops work the browser already has. */
function famousContent(): ContentFile[] {
  interface Shard {
    games?: { id?: string }[]
  }
  const merged = new Map<string, unknown>()
  for (const shard of ['games.json', 'persona-games.json']) {
    const parsed = readJsonFile<Shard>('famous', shard)
    for (const g of parsed?.games ?? []) {
      if (g && typeof g.id === 'string' && !merged.has(g.id)) merged.set(g.id, g)
    }
  }
  const games = JSON.stringify({ games: [...merged.values()] })
  return [{ fileName: `${CONTENT_DIR}/famous.json`, source: () => games }]
}

/** Personas: the catalog (~35 KB) plus one image file per portrait.
 *  photos.json inlines every portrait as a base64 data URI: 6.6 MB of JSON the
 *  gallery would have to download and parse before its first paint. Split back
 *  into real image files the browser fetches per card and caches. */
function personaContent(): ContentFile[] {
  interface CatalogFile {
    personas?: Record<string, unknown>[]
  }
  const catalog = readJsonFile<CatalogFile>('personas', 'personas.json')
  const rows = Array.isArray(catalog?.personas) ? catalog.personas : []
  if (rows.length === 0) return []

  const photos = readJsonFile<Record<string, { dataUri?: string; attribution?: string }>>(
    'personas',
    'photos.json'
  )
  const out: ContentFile[] = []
  const photoIndex: Record<string, { file: string; attribution: string | null }> = {}
  for (const [id, entry] of Object.entries(photos ?? {})) {
    const m = /^data:image\/(jpeg|jpg|png|webp|gif);base64,(.+)$/s.exec(entry?.dataUri ?? '')
    if (!m) continue
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    const file = `${id}.${ext}`
    const b64 = m[2]
    out.push({
      fileName: `${CONTENT_DIR}/personas/${file}`,
      source: () => Buffer.from(b64, 'base64')
    })
    photoIndex[id] = { file, attribution: entry?.attribution ?? null }
  }
  const catalogJson = JSON.stringify({ personas: rows, photos: photoIndex })
  out.push({ fileName: `${CONTENT_DIR}/personas.json`, source: () => catalogJson })
  return out
}

/** The 3D tabletop's PBR sets, meshes and piece SVGs (24 MB, 196 files).
 *  main.web.tsx points window.__gamesArtBase at <base>games-art in production;
 *  without these the boards fall back to procedural materials, so the whole
 *  tree ships with the site. Read per file at emit time, never all at once. */
function gamesArtContent(): ContentFile[] {
  const root = resolve(RESOURCES, 'games-art')
  const out: ContentFile[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, rel)
      else out.push({ fileName: `games-art/${rel}`, source: () => readFileSync(abs) })
    }
  }
  try {
    walk(root, '')
  } catch {
    return [] // no art tree in this checkout. The loader has its fallback
  }
  return out
}

let contentCache: ContentFile[] | null = null

function contentFiles(): ContentFile[] {
  if (!contentCache) {
    contentCache = [
      ...schoolContent(),
      ...famousContent(),
      ...personaContent(),
      ...gamesArtContent()
    ]
  }
  return contentCache
}

const MIME: Record<string, string> = {
  json: 'application/json',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  glb: 'model/gltf-binary',
  txt: 'text/plain'
}

/** Emit the tree on build; serve the identical bytes from the dev server, so a
 *  content bug reproduces in `npm run dev:web` instead of only after a deploy. */
function staticContent(): Plugin {
  return {
    name: 'nodechess-static-content',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0])
        if (!url.startsWith(`/${CONTENT_DIR}/`) && !url.startsWith('/games-art/')) return next()
        const hit = contentFiles().find((f) => `/${f.fileName}` === url)
        if (!hit) return next()
        const ext = hit.fileName.split('.').pop() ?? ''
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
        res.end(hit.source())
      })
    },
    generateBundle() {
      for (const f of contentFiles()) {
        this.emitFile({ type: 'asset', fileName: f.fileName, source: f.source() })
      }
    }
  }
}

// ---- Offline (src/web/sw.ts) ---------------------------------------------------
//
// The service worker cannot be a rollup input: it has to land at the deploy
// root under the exact name `sw.js` (the name is its scope), it must be a
// classic script rather than a module, and it needs a list of the files this
// build just emitted, which does not exist until the bundle is generated. So it
// is compiled at generateBundle time with the precache list and a build id
// defined into it, and emitted as an asset.
//
// WHAT GETS PRECACHED, and why not more. The shell is what a return visit needs
// to PAINT with the network off: the document, the entry chunk and everything
// it statically imports, that closure's stylesheets, the fonts and the icons.
// Route chunks, the engines, the content tree and the 3D art are NOT in it.
// They are cached the first time they are actually used, which is the honest
// version of "you can see it offline if you have seen it before" and keeps a
// first visit from paying 60 MB up front for screens the player may never open.

const SW_SOURCE = resolve(__dirname, 'src/web/sw.ts')
const SW_PUBLIC_FILES = [
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
]

function serviceWorker(puzzleBase: string): Plugin {
  return {
    name: 'nodechess-service-worker',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const chunks = new Map<string, OutputChunk>()
      for (const [name, out] of Object.entries(bundle)) {
        if (out.type === 'chunk') chunks.set(name, out)
      }
      const entry = [...chunks.values()].find((c) => c.isEntry)
      if (!entry) {
        this.error('nodechess-service-worker: the bundle has no entry chunk to precache')
        return
      }

      // The boot closure has TWO seeds, and the second one is the point:
      // main.web.tsx reaches the renderer through `import('@/main')` so that
      // window.api exists before any renderer module evaluates, which makes the
      // app itself a dynamic import. Seeding only the entry would precache an
      // 8 KB stub that then asks the network for the megabyte it needs.
      //
      // The renderer's own dynamic imports (route views) and webApi's (the
      // openings book, the persona and bot catalogs) are NOT seeds. They are
      // half a megabyte the first paint never touches, and they cache
      // themselves the first time a player opens the screen that wants them.
      // Found by CONTENT, not by name: rollup gives this chunk no
      // facadeModuleId (it is a dynamic entry that also absorbed its own
      // static imports), and its emitted name is hashed.
      const rendererMain = [...chunks.values()].find(
        (c) =>
          c.isDynamicEntry &&
          Object.keys(c.modules).some((m) =>
            m.replace(/\\/g, '/').endsWith('/renderer/src/main.tsx')
          )
      )
      if (!rendererMain) {
        this.error("nodechess-service-worker: no chunk contains '@/main'; the shell would not boot")
        return
      }

      const js = new Set<string>()
      const css = new Set<string>()
      const walk = (name: string): void => {
        if (js.has(name)) return
        js.add(name)
        const chunk = chunks.get(name)
        if (!chunk) return
        const meta = (chunk as OutputChunk & { viteMetadata?: { importedCss?: Set<string> } })
          .viteMetadata
        for (const sheet of meta?.importedCss ?? []) css.add(sheet)
        for (const next of chunk.imports) walk(next)
      }
      walk(entry.fileName)
      walk(rendererMain.fileName)

      const fonts = Object.keys(bundle).filter((name) => name.endsWith('.woff2'))
      const core = ['index.html', entry.fileName, rendererMain.fileName]
      const precache = [...new Set([...core, ...js, ...css, ...fonts, ...SW_PUBLIC_FILES])]

      const sizeOf = (name: string): number => {
        const out = bundle[name] as OutputChunk | OutputAsset | undefined
        if (out?.type === 'chunk') return Buffer.byteLength(out.code)
        if (out?.type === 'asset') {
          const source = (out as OutputAsset).source
          return typeof source === 'string' ? Buffer.byteLength(source) : source.byteLength
        }
        try {
          return statSync(resolve(__dirname, 'src/web/public', name)).size
        } catch {
          return 0
        }
      }
      const bytes = precache.reduce((sum, name) => sum + sizeOf(name), 0)

      // The id changes exactly when the shell does, which is what makes the
      // per-build shell cache self-invalidating.
      const buildId = createHash('sha256')
        .update(precache.slice().sort().join('\n'))
        .digest('hex')
        .slice(0, 16)

      const compiled = await esbuild({
        entryPoints: [SW_SOURCE],
        bundle: true,
        format: 'iife',
        target: 'es2022',
        platform: 'browser',
        write: false,
        legalComments: 'none',
        define: {
          __BUILD_ID__: JSON.stringify(buildId),
          __PRECACHE__: JSON.stringify(precache),
          __CORE__: JSON.stringify(core),
          // The worker matches puzzle requests by full URL, so it needs the
          // same base the reader was built with, cross-origin or not.
          __PUZZLE_BASE__: JSON.stringify(puzzleBase)
        }
      })
      const code = compiled.outputFiles?.[0]?.text
      if (!code) {
        this.error('nodechess-service-worker: esbuild produced no output for src/web/sw.ts')
        return
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code })

      const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`
      this.warn(
        `offline shell ${buildId}: ${precache.length} files, ${kb(bytes)} precached ` +
          `(${js.size} js, ${css.size} css, ${fonts.length} fonts, ${SW_PUBLIC_FILES.length} manifest/icons)`
      )
    }
  }
}

export default defineConfig(({ mode }) => {
  // VITE_PUZZLE_BASE_URL is read HERE as well as by the client bundle, because
  // the service worker is compiled by esbuild and gets it as a define. One
  // source, so the worker can never disagree with the reader about which URLs
  // are puzzle chunks.
  const env = loadEnv(mode, ENV_DIR, 'VITE_')
  const puzzleBase = puzzleBaseUrl(env.VITE_PUZZLE_BASE_URL)

  return {
    root: resolve(__dirname, 'src/web'),
    envDir: ENV_DIR,
    // Cloudflare Pages reads _headers from the deploy root; publicDir copies it
    // there verbatim. The puzzle chunks are NOT in here (see puzzleArtifact()).
    publicDir: resolve(__dirname, 'src/web/public'),
    define: {
      __WEB_APP_VERSION__: JSON.stringify(pkg.version)
    },
    server: {
      port: 5199,
      headers: CROSS_ORIGIN_ISOLATION,
      // games/art.ts resolves resources/games-art via /@fs in dev; allow the
      // whole repo explicitly so outside-root asset URLs never 403 (same
      // allowance as electron.vite.config.ts).
      fs: { allow: [resolve(__dirname)] }
    },
    preview: {
      port: 5199,
      headers: CROSS_ORIGIN_ISOLATION
    },
    build: {
      outDir: resolve(__dirname, 'dist-web'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/web/index.html') }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [
      react(),
      viteStaticCopy({ targets: ENGINE_ASSETS }),
      staticContent(),
      puzzleArtifact(),
      serviceWorker(puzzleBase)
    ]
  }
})
