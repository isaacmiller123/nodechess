// Web entry (docs/WEB-PORT-SPEC.md): install the web `Api` implementation,
// then boot the UNCHANGED renderer. The import of '@/main' is dynamic so
// `window.api` (and the platform flag below) are guaranteed to exist before any
// renderer module evaluates — static imports would hoist above the assignments.

import { webApi } from './webApi'
// Decentralized accounts (A1 packaging): side-effect import pulls the shared
// accounts tree (ed25519 + hash-wasm argon2) into the web bundle and exposes
// the window.__chessAccounts dev/test surface. This is the account system —
// the interim server accounts (/api/auth/*) are gone along with the server.
import './accounts'

declare global {
  interface Window {
    __gamesArtBase?: string
    __chessSharpWeb?: boolean
  }
}

// Platform flag for renderer copy (src/renderer/src/platform.ts reads it).
// MUST be set before '@/main' evaluates any renderer module.
window.__chessSharpWeb = true

window.api = webApi

// Production: the build copies resources/games-art to <outDir>/games-art, and
// games/three/artLoader.ts documents this pre-set global as its highest-priority
// hook — 3D PBR textures load with no Electron path probing. Dev: leave it
// unset; the renderer's own /@fs sentinel mechanism (games/art.ts) resolves
// against the Vite dev server.
if (!import.meta.env.DEV) {
  window.__gamesArtBase = `${import.meta.env.BASE_URL}games-art`
}

// A failed chunk load (flaky network, mid-deploy refresh) must say so — an
// uncaught boot rejection would leave a silent blank page.
import('@/main').catch((err) => {
  console.error('nodechess failed to boot', err)
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML =
      '<p style="font:14px system-ui,sans-serif;padding:2em">' +
      'nodechess failed to load — please refresh the page.</p>'
  }
})
