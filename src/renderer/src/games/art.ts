// games-art asset URLs (docs/GAMES-PLATFORM-SPEC.md §3D/art; assets owned by
// the art pipeline under resources/games-art/**, credits in docs/CREDITS.md).
//
// The same relative paths (e.g. 'textures/felt_color.jpg', 'shogi/kanji/0OU.svg')
// resolve in BOTH runtimes:
//  - dev: the Vite dev server serves the repo's resources/ dir via /@fs
//    (electron.vite.config.ts allows the repo root). The base is derived from
//    an import.meta.glob over the tiny per-set attribution .txt files. A
//    sentinel, NOT a full asset glob, so the ~14 MB of art is never emitted
//    into the renderer bundle (boards/chessFamilyArt.ts already bundles the 2D
//    piece SVGs it needs; this module serves everything else, e.g. 3D textures).
//  - packaged: electron-builder extraResources copies resources/games-art ->
//    <resourcesPath>/games-art (electron-builder.yml), addressed with absolute
//    file:// URLs derived from the window location, mirroring how the main
//    process finds process.resourcesPath siblings (personas/, openings/, ...).
//    An unpackaged `electron .` run (out/renderer under the repo) falls back to
//    the repo's resources/games-art.
//
// URLs are NOT existence-checked. Callers keep their procedural/glyph
// fallbacks on load failure (games/three/artLoader.ts already does).
//
// Importing this module also installs the base as window.__gamesArtBase, the
// documented lowest-priority hook of games/three/artLoader.ts, so the 3D
// tabletop picks up PBR textures without importing three here (main.tsx
// imports us once at startup).

const SENTINEL_PREFIX = '../../../../resources/games-art/'

// Sub-4KB text files inline as data: URIs at build time (useless dead code the
// bundler may drop), but in dev they resolve to real /@fs/<repo>/resources/…
// URLs we can derive the directory base from.
const SENTINELS: Record<string, string> = import.meta.env.DEV
  ? import.meta.glob<string>(
      [
        '../../../../resources/games-art/*/ATTRIBUTION.txt',
        '../../../../resources/games-art/textures/SOURCES.txt'
      ],
      { eager: true, query: '?url', import: 'default' }
    )
  : {}

/** Common dev-server URL prefix (…/@fs/<repo>/resources/games-art), no trailing slash. */
function devBase(): string | null {
  for (const [key, rawUrl] of Object.entries(SENTINELS)) {
    const rel = key.slice(SENTINEL_PREFIX.length)
    const url = rawUrl.split('?')[0]
    if (url.startsWith('data:')) continue
    if (url.endsWith(`/${rel}`)) return url.slice(0, url.length - rel.length - 1)
  }
  return null
}

/** Packaged/unpackaged file:// base for resources/games-art, null when not file://. */
function fileBase(): string | null {
  if (typeof window === 'undefined') return null
  // file:///…/Resources/app.asar/out/renderer/index.html -> …/Resources/games-art
  // file:///…/<checkout>/out/renderer/index.html         -> …/<checkout>/resources/games-art
  const m = window.location.href.match(/^(file:.*)\/out\/renderer\//)
  if (!m) return null
  const asar = m[1].match(/^(.*)\/app(?:\.asar)?$/)
  return asar ? `${asar[1]}/games-art` : `${m[1]}/resources/games-art`
}

/**
 * Base URL of the games-art directory (no trailing slash), or null when
 * unresolvable (headless tests, non-Vite preview). Callers must fall back
 * gracefully. Never throw.
 */
export function gamesArtBase(): string | null {
  return import.meta.env.DEV ? devBase() : fileBase()
}

/**
 * URL for one games-art asset by path relative to resources/games-art
 * (e.g. 'textures/slate_color.jpg'). Null when the base is unresolvable.
 */
export function gamesArtUrl(relPath: string): string | null {
  const base = gamesArtBase()
  return base ? `${base}/${relPath}` : null
}

// Install the base for games/three/artLoader.ts (its documented lowest-priority
// hook). Never clobber a harness-provided value.
declare global {
  interface Window {
    __gamesArtBase?: string
  }
}
if (typeof window !== 'undefined' && !window.__gamesArtBase) {
  const base = gamesArtBase()
  if (base) window.__gamesArtBase = base
}
