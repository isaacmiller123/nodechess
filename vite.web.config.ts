import { resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Web-target build (docs/WEB-PORT-SPEC.md): the UNCHANGED renderer compiled as
// a plain SPA against src/web/main.web.tsx (which installs the web `Api`
// implementation before booting '@/main'). Fully separate from
// electron.vite.config.ts — the desktop build never reads this file.
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

// Engine WASM assets (web port W2, src/web/engines): copied verbatim to
// <outDir>/engines/ on build AND served at /engines/ by the dev server
// (vite-plugin-static-copy does both), so the engine workers load same-origin
// — which is what COEP require-corp demands and what lets the multithreaded
// builds spawn their nested pthread workers.
//
//  - stockfish-18-lite[.js/.wasm]        chess: multithreaded, small NNUE
//                                        EMBEDDED (~7 MB — no separate net).
//  - stockfish-18-lite-single[.js/.wasm] chess fallback when the page is not
//                                        crossOriginIsolated.
//    (each stockfish.js worker resolves its .wasm as <same basename>.wasm
//     next to the script — the js/wasm pairs MUST stay together)
//  - fairy/*                             Fairy-Stockfish 14 (pychess build):
//                                        UMD script + wasm + its pthread
//                                        worker glue (stockfish.worker.js),
//                                        kept in their own dir because all
//                                        three files resolve relative paths.
// (rename stripBase flattens the copies to <dest>/<basename> — without it the
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
// Emission is deliberately DUMB — copy the bytes, derive only the chapter index
// and the photo split. Every decision about the DATA (which chapter is locked,
// how SAN movetext expands, how a persona row is coerced) stays in typechecked
// TypeScript next to the shared types it has to satisfy, mirroring the desktop
// repos exactly as src/web/data mirrors puzzles.repo.ts.

const CONTENT_DIR = 'content'
const RESOURCES = resolve(__dirname, 'resources')

interface ContentFile {
  /** Path under <outDir>, e.g. 'content/famous.json'. */
  fileName: string
  /** Read on demand — the art tree alone is 24 MB, and the dev server only
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
    return [] // lean checkout without the curriculum — the loader reports it
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
  // Curriculum order (band, then order within band) — allChapters()'s sort.
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
 *  (curated wins an id collision). Movetext stays SAN — the per-ply expansion
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
 *  photos.json inlines every portrait as a base64 data URI — 6.6 MB of JSON the
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
 *  tree ships with the site — read per file at emit time, never all at once. */
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
    return [] // no art tree in this checkout — the loader has its fallback
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

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  // Cloudflare Pages reads _headers from the deploy root; publicDir copies it
  // there verbatim.
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
  plugins: [react(), viteStaticCopy({ targets: ENGINE_ASSETS }), staticContent()]
})
