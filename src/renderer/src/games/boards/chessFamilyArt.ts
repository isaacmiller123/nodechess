// Piece art for the East-Asian chess family boards (xiangqi / janggi / shogi).
// resources/games-art SVGs (Kadagaden xiangqi/janggi + Ka-hu shogi, CC-BY;
// see the LICENSE.txt next to each set) mapped onto chessgroundx piece classes.
//
// The SVGs are pulled in with a Vite glob (`?url` → hashed asset URLs, loaded
// on demand: the shogi kanji set alone is ~8MB, so NO data-URI inlining) and
// turned into one injected stylesheet, scoped under `.cfb-wrap.cfb-<kind>`.
// If builder-assets ever moves/renames the art, only the globs below change.
//
// Shogi orientation: chessgroundx tags every piece `ally` (color ===
// orientation, points away from the viewer) or `enemy`; the art ships both
// ways: `0*.svg` upright, `1*.svg` pre-rotated 180°, so OTB rotation just
// works. Kings follow convention: sente (internal white) gets 玉 (GY), gote
// gets 王 (OU).
//
// When a set is missing (glob came back empty) hasBoardArt() reports false and
// ChessFamilyBoard adds `cfb-noart`, switching pieces to the CSS disc+glyph
// fallback in chess-family-board.css: the board ALWAYS renders.
//
// This module is registry-reachable from headless node test bundles (esbuild
// keeps `import.meta.glob` untransformed): everything here is lazy and
// window-guarded; nothing runs at import time in node.

type UrlMap = Record<string, string>

function globUrls(glob: () => UrlMap): UrlMap {
  // import.meta.glob exists only under Vite; headless bundles never call this
  // (guarded by ensureChessFamilyArtCss's document check), but stay defensive.
  try {
    return glob()
  } catch {
    return {}
  }
}

const xiangqiFiles = (): UrlMap =>
  import.meta.glob('../../../../../resources/games-art/xiangqi/*.svg', {
    eager: true,
    query: '?url',
    import: 'default'
  }) as UrlMap

const janggiFiles = (): UrlMap =>
  import.meta.glob('../../../../../resources/games-art/janggi/*.svg', {
    eager: true,
    query: '?url',
    import: 'default'
  }) as UrlMap

const shogiFiles = (): UrlMap =>
  import.meta.glob('../../../../../resources/games-art/shogi/kanji/*.svg', {
    eager: true,
    query: '?url',
    import: 'default'
  }) as UrlMap

/** basename without extension → url */
function byName(files: UrlMap): Map<string, string> {
  const out = new Map<string, string>()
  for (const [path, url] of Object.entries(files)) {
    const base = path.split('/').pop()
    if (base) out.set(base.replace(/\.svg$/, ''), url)
  }
  return out
}

// FEN letter role → art name fragment, per game.
const XIANGQI_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['r', 'rook'],
  ['n', 'knight'],
  ['b', 'bishop'],
  ['a', 'advisor'],
  ['c', 'cannon'],
  ['k', 'king'],
  ['p', 'pawn']
]
const JANGGI_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['r', 'chariot'],
  ['n', 'horse'],
  ['b', 'elephant'],
  ['a', 'advisor'],
  ['c', 'cannon'],
  ['k', 'king'],
  ['p', 'pawn']
]
// Shogi role → Ka-hu code (0<code> upright / 1<code> rotated). Kings are
// per-color below.
const SHOGI_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['p', 'FU'],
  ['l', 'KY'],
  ['n', 'KE'],
  ['s', 'GI'],
  ['g', 'KI'],
  ['b', 'KA'],
  ['r', 'HI'],
  ['pp', 'TO'],
  ['pl', 'NY'],
  ['pn', 'NK'],
  ['ps', 'NG'],
  ['pb', 'UM'],
  ['pr', 'RY']
]

interface ArtSheet {
  css: string
  complete: boolean
}

function colorMappedSheet(
  kind: 'xiangqi' | 'janggi',
  art: Map<string, string>,
  whitePrefix: string,
  blackPrefix: string,
  roles: ReadonlyArray<readonly [string, string]>
): ArtSheet {
  const rules: string[] = []
  let complete = true
  for (const [letter, name] of roles) {
    for (const [color, prefix] of [
      ['white', whitePrefix],
      ['black', blackPrefix]
    ] as const) {
      const url = art.get(`${prefix}_${name}`)
      if (!url) {
        complete = false
        continue
      }
      rules.push(
        `.cfb-wrap.cfb-${kind} piece.${letter}-piece.${color} { background-image: url('${url}'); }`
      )
    }
  }
  return { css: rules.join('\n'), complete }
}

function shogiSheet(art: Map<string, string>): ArtSheet {
  const rules: string[] = []
  let complete = true
  const push = (selector: string, name: string): void => {
    const url = art.get(name)
    if (!url) {
      complete = false
      return
    }
    rules.push(`.cfb-wrap.cfb-shogi ${selector} { background-image: url('${url}'); }`)
  }
  for (const [letter, code] of SHOGI_ROLES) {
    push(`piece.${letter}-piece.ally`, `0${code}`)
    push(`piece.${letter}-piece.enemy`, `1${code}`)
  }
  // Kings: sente (white) 玉 GY, gote (black) 王 OU.
  push('piece.k-piece.white.ally', '0GY')
  push('piece.k-piece.white.enemy', '1GY')
  push('piece.k-piece.black.ally', '0OU')
  push('piece.k-piece.black.enemy', '1OU')
  return { css: rules.join('\n'), complete }
}

let injected = false
let availability: Record<string, boolean> | null = null

function buildSheets(): { css: string; available: Record<string, boolean> } {
  const xiangqi = colorMappedSheet('xiangqi', byName(globUrls(xiangqiFiles)), 'red', 'black', XIANGQI_ROLES)
  const janggi = colorMappedSheet('janggi', byName(globUrls(janggiFiles)), 'blue', 'red', JANGGI_ROLES)
  const shogi = shogiSheet(byName(globUrls(shogiFiles)))
  return {
    css: [xiangqi.css, janggi.css, shogi.css].filter(Boolean).join('\n'),
    available: { xiangqi: xiangqi.complete, janggi: janggi.complete, shogi: shogi.complete }
  }
}

/**
 * Idempotently injects the art stylesheet. Safe to call from render paths;
 * no-op outside the browser (headless test bundles).
 */
export function ensureChessFamilyArtCss(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const { css, available } = buildSheets()
  availability = available
  if (!css) return
  const style = document.createElement('style')
  style.dataset.cfbArt = 'true'
  style.textContent = css
  document.head.appendChild(style)
}

/** True when the kind's full piece-art set resolved (else use the CSS fallback). */
export function hasBoardArt(kind: string): boolean {
  ensureChessFamilyArtCss()
  // Chess-piece kinds are covered by chess-family-pieces.css (always bundled).
  if (!availability || !(kind in availability)) return true
  return availability[kind]
}
