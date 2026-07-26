// Nobody should ever have to clear their cache because we shipped.
//
// THE FAILURE THIS EXISTS FOR. Every route in this app is a dynamic import, so
// a tab holds the entry bundle from the build it booted with and fetches the
// rest by hashed filename as you walk around. Deploy a new build and those
// hashes change. A tab that has been open across the deploy therefore asks for
// a chunk from the OLD build the moment you open a route you had not opened
// yet, and the browser reports:
//
//     Failed to fetch dynamically imported module: .../assets/AccountView-<hash>.js
//
// which lands on the player as a screen that will not open, with no hint that
// the fix is to reload.
//
// registerWorker() in main.web.tsx already reasons about this and concludes the
// old chunks stay reachable, which is true right up until they are not: the
// asset cache is keyed to the build and gets cleaned on activate, a hosting
// provider can drop an old artifact, and the network can simply fail on the one
// request that matters. It is the difference between "should not happen" and
// "cannot happen", and only the second one is worth a player's afternoon.
//
// WHAT THIS DOES. Catches that specific failure and reloads once, which is the
// entire fix: navigations are network-first in the worker, so the reload gets
// the deployed index.html and with it the current hashes.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not reload on a whim, it does not
// reload the moment a new worker appears, and it does not reload twice. The app
// is something you are three moves into; yanking the page out from under a game
// to save a click is a worse bug than the one being fixed. This fires only
// after a route has ALREADY failed to open, when the alternative is a dead
// screen.

/** One auto-reload per tab per deploy. sessionStorage, so it dies with the tab
 *  and a genuinely broken deploy cannot put anyone in a reload loop. */
const ATTEMPT_KEY = 'nodechess.chunkReload.v1'

/** Long enough that a reload has plainly been tried and has plainly not worked. */
const RETRY_WINDOW_MS = 30_000

function alreadyTried(): boolean {
  try {
    const last = Number(sessionStorage.getItem(ATTEMPT_KEY) ?? 0)
    return Number.isFinite(last) && Date.now() - last < RETRY_WINDOW_MS
  } catch {
    // Private mode with storage denied. Better to allow the one reload than to
    // strand the player on a dead route.
    return false
  }
}

function markTried(): void {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, String(Date.now()))
  } catch {
    /* storage may be unavailable */
  }
}

/**
 * A stale chunk means the worker is holding an old shell, so ask it to look for
 * a new one before reloading. Bounded: a worker that never answers must not
 * stop the reload, which is the part that actually fixes it.
 */
async function refreshWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return
    await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 1500))])
  } catch {
    /* the reload is what matters; this is only a courtesy */
  }
}

function recover(what: string): void {
  if (alreadyTried()) {
    // Reloading again would loop. Say so instead: a player who knows the build
    // is broken can wait, and a console line is what a bug report gets pasted
    // from. This is the honest end of the road, not a silent retry.
    console.error(
      `nodechess: a route could not be loaded and reloading did not fix it (${what}). ` +
        'The deployed build may be incomplete.'
    )
    return
  }
  markTried()
  void refreshWorker().finally(() => window.location.reload())
}

/** Vite fires this on window when a dynamically imported chunk fails to load.
 *  Typed here because it is not in lib.dom. */
interface PreloadErrorEvent extends Event {
  payload?: unknown
}

/** Does this look like the stale-chunk failure rather than an error thrown by
 *  code INSIDE a module that loaded perfectly well? Reloading cannot fix the
 *  latter, and reloading on every error would hide real crashes behind a
 *  refresh loop. */
function isChunkLoadFailure(message: string): boolean {
  return (
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message) ||
    /\bChunkLoadError\b/.test(message)
  )
}

export function installUpdateRecovery(): void {
  if (typeof window === 'undefined') return

  // The precise signal, when the bundler gives us one.
  window.addEventListener('vite:preloadError', (event) => {
    const e = event as PreloadErrorEvent
    // Without this Vite rethrows and the app dies on an error we are handling.
    e.preventDefault()
    recover('vite:preloadError')
  })

  // The same failure arriving as a rejected import() that nothing caught,
  // which is what happens for a lazy route with no error boundary above it.
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string } | string | undefined
    const message = typeof reason === 'string' ? reason : (reason?.message ?? '')
    if (isChunkLoadFailure(message)) recover('unhandledrejection')
  })

  // And as a plain error event, which is how some browsers report a failed
  // module script.
  window.addEventListener('error', (event) => {
    if (isChunkLoadFailure(event.message ?? '')) recover('error')
  })
}
