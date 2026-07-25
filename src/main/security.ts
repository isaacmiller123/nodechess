import { session, type BrowserWindow } from 'electron'

// Strict CSP for production; a HMR-friendly relaxation for the Vite dev server.
// connect-src allows wss: so the renderer can reach the multiplayer signaling
// relays (trystero/Nostr), WebRTC media itself isn't gated by connect-src.
// img-src/connect-src allow file: for the extraResources games art
// (<resourcesPath>/games-art: 2D/3D textures + SVG decals load via <img>,
// the chess3d manifest + GLBs via fetch: see renderer games/art.ts). While
// the window is served by loadFile 'self' happens to cover file:, but the
// explicit scheme keeps art working after the planned app:// migration
// (window.ts TODO(packaging)).
//
// script-src 'wasm-unsafe-eval': required for WebAssembly compilation (the
// ffish-es6 rules engine behind xiangqi/shogi/janggi/makruk/placement and the
// Variant Lab). It allows ONLY wasm compilation, not JS string-eval. Do NOT
// widen to 'unsafe-eval': ffish's embind glue used to need it (new Function)
// but is rewritten eval-free by scripts/patch-ffish-csp.mjs (npm postinstall).
// Both keywords are scheme-independent, so this holds for file:// today and
// the planned app:// migration alike. Verified against the packaged app by
// scripts/smoke-packed-wasm.mjs: dev CSP has 'unsafe-eval', so ONLY the
// packaged app proves this; run the smoke after touching this line.
const PROD_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: file:; font-src 'self'; connect-src 'self' wss: file:; " +
  "media-src 'self'"

const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self' ws: wss: http://localhost:*; media-src 'self'"

export function installCsp(isPackaged: boolean): void {
  const csp = isPackaged ? PROD_CSP : DEV_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}

export function hardenWindow(win: BrowserWindow): void {
  // Never open new windows; never navigate to a remote origin.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    const allowed = (devUrl && url.startsWith(devUrl)) || url.startsWith('app://')
    if (!allowed) e.preventDefault()
  })
}
