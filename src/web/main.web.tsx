// Web entry (docs/WEB-PORT-SPEC.md): install the web `Api` implementation,
// then boot the UNCHANGED renderer. The import of '@/main' is dynamic so
// `window.api` (and the platform flag below) are guaranteed to exist before any
// renderer module evaluates: static imports would hoist above the assignments.

import { webApi } from './webApi'
// Decentralized accounts (A1 packaging): side-effect import pulls the shared
// accounts tree (ed25519 + hash-wasm argon2) into the web bundle and exposes
// the window.__chessAccounts dev/test surface. This is the account system.
// The interim server accounts (/api/auth/*) are gone along with the server.
import './accounts'
import { watchConnection } from './offlineNotice'
import { installUpdateRecovery } from './updateRecovery'

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
// hook: 3D PBR textures load with no Electron path probing. Dev: leave it
// unset; the renderer's own /@fs sentinel mechanism (games/art.ts) resolves
// against the Vite dev server.
if (!import.meta.env.DEV) {
  window.__gamesArtBase = `${import.meta.env.BASE_URL}games-art`
}

// Installed BEFORE the first import so a chunk that fails on the way in is
// caught too. See updateRecovery.ts: a tab open across a deploy asks for chunk
// hashes that no longer exist, and this reloads it once instead of leaving a
// dead route. Nobody should have to clear their cache because we shipped.
installUpdateRecovery()

// A failed chunk load (flaky network, mid-deploy refresh) must say so. An
// uncaught boot rejection would leave a silent blank page. installUpdateRecovery
// handles the stale-build case above; this is the floor under everything else.
import('@/main').catch((err) => {
  console.error('nodechess failed to boot', err)
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML =
      '<p style="font:14px system-ui,sans-serif;padding:2em">' +
      'nodechess failed to load. Please refresh the page.</p>'
  }
})

watchConnection()
void registerWorker()

// ---- offline (src/web/sw.ts) ------------------------------------------------
//
// DEV IS DELIBERATELY EXCLUDED. A worker holding a shell cache in front of
// Vite's module graph turns every edit into a debugging session, and a
// registration made at :5199 outlives whatever is served there next.
//
// UPDATES. The worker precaches a shell keyed to the build, so a deploy gets
// its own copy and a tab that is mid-game keeps the one it booted with. Three
// things together stop anyone from sitting on a stale shell:
//
//   1. `updateViaCache: 'none'` plus an update() on load and on every return to
//      the tab, so a new sw.js is FOUND rather than waited for.
//   2. The new worker is told to activate as soon as it has finished
//      installing. That is safe because the previous build's hashed assets stay
//      in the asset cache, so the running page can still load a route it has
//      not opened yet.
//   3. Navigations are network-first in the worker. The next reload therefore
//      gets the deployed index.html, not a cached one, whenever there is a
//      connection to get it from.
//
// Nothing reloads the page underneath the player. Being one reload behind is
// the cost, and it is the right one for an app you are three moves into.
async function registerWorker(): Promise<void> {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return
  const base = import.meta.env.BASE_URL
  let reg: ServiceWorkerRegistration
  try {
    reg = await navigator.serviceWorker.register(`${base}sw.js`, {
      scope: base,
      updateViaCache: 'none'
    })
  } catch (err) {
    // No offline layer this session. Everything still works with a network,
    // which is the state the app was in before any of this existed.
    console.warn('nodechess offline support is not available', err)
    return
  }

  const activateWhenReady = (worker: ServiceWorker | null): void => {
    if (!worker) return
    const nudge = (): void => {
      if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' })
    }
    worker.addEventListener('statechange', nudge)
    nudge()
  }
  activateWhenReady(reg.waiting)
  reg.addEventListener('updatefound', () => activateWhenReady(reg.installing))

  let checking = false
  const check = (): void => {
    if (checking || document.visibilityState !== 'visible') return
    checking = true
    void reg.update().finally(() => {
      checking = false
    })
  }
  document.addEventListener('visibilitychange', check)

  // The chess engine is 7.1 MB and is fetched the first time a player opens
  // Play or Analysis. If that first time is offline, there is no engine and
  // nothing to run one from, so it is pulled in behind the boot instead: idle
  // bandwidth now, in exchange for analysis that works on a plane later. Not on
  // a connection the browser has told us to be careful with.
  //
  // ONE of the two chess builds, the one this context would actually run:
  // src/web/engines/assets.ts picks by crossOriginIsolated. Fairy-Stockfish
  // (1.6 MB) is not warmed; the variant boards reach it on their own and
  // report honestly when they cannot.
  const link = (navigator as { connection?: { saveData?: boolean } }).connection
  if (link?.saveData === true) return
  const build =
    typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
      ? 'stockfish-18-lite'
      : 'stockfish-18-lite-single'
  addEventListener(
    'load',
    () => {
      setTimeout(() => {
        const worker = navigator.serviceWorker.controller ?? reg.active
        worker?.postMessage({
          type: 'WARM',
          urls: [`${base}engines/${build}.js`, `${base}engines/${build}.wasm`]
        })
      }, 8000)
    },
    { once: true }
  )
}
