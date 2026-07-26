// The one thing the offline layer says out loud.
//
// sw.ts makes the app open with the network gone. It cannot make the whole app
// WORK with the network gone: a puzzle from a part of the 1.49 GB database this
// device has never read, an opponent, an account on the network. Those surfaces
// answer empty, which is correct and which is also indistinguishable from "no
// results" unless something says why. This is that something.
//
// It is a strip, not a dialog. It appears when the connection drops and leaves
// when it returns; it never appears online, and it never explains how any of it
// works. Written in plain DOM rather than React because it has to be able to
// appear when the renderer has failed to boot.

const ID = 'nodechess-offline-strip'
const LINE = 'Offline. What you have already opened still works. New puzzles and anything online do not.'

const CSS = `
#${ID} {
  position: fixed;
  left: var(--space-5, 16px);
  bottom: var(--space-5, 16px);
  z-index: 2147483000;
  max-width: min(30rem, calc(100vw - 2 * var(--space-5, 16px)));
  padding: var(--space-3, 8px) var(--space-4, 12px);
  border: 1px solid var(--border, #353639);
  border-radius: var(--radius-md, 8px);
  background: var(--surface, #222325);
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.4));
  color: var(--text-secondary, #a6a8aa);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 0.8125rem;
  line-height: 1.45;
}
`

let strip: HTMLElement | null = null

let styled = false

function show(): void {
  if (strip) return
  if (!styled) {
    // In the head, never inside the strip: the strip is a live region, and a
    // stylesheet parked in one is read out as its content.
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    styled = true
  }
  strip = document.createElement('aside')
  strip.id = ID
  strip.setAttribute('role', 'status')
  strip.setAttribute('aria-live', 'polite')
  strip.textContent = LINE
  document.body.appendChild(strip)
}

function hide(): void {
  strip?.remove()
  strip = null
}

/** What the worker last observed, which is a different and better question than
 *  navigator.onLine: see the announce() block in sw.ts. Either source saying so
 *  is enough to show the strip. */
let workerSaysOffline = false

/** Idempotent. Safe to call before the renderer has mounted. */
export function watchConnection(): void {
  const sync = (): void => {
    if (!navigator.onLine || workerSaysOffline) show()
    else hide()
  }
  addEventListener('online', () => {
    // The device has a link again. Whether the site answers is the worker's to
    // say, and it will on the next request either way.
    workerSaysOffline = false
    sync()
  })
  addEventListener('offline', sync)
  const sw = navigator.serviceWorker
  if (sw) {
    sw.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; offline?: boolean } | null
      if (!data || data.type !== 'nodechess-network') return
      workerSaysOffline = data.offline === true
      sync()
    })
    // A reload with the network gone is served entirely from storage, so
    // nothing fails and nothing gets announced. Ask instead of waiting.
    const ask = (): void => sw.controller?.postMessage({ type: 'NETWORK_STATUS' })
    sw.addEventListener('controllerchange', ask)
    ask()
  }
  if (document.body) sync()
  else addEventListener('DOMContentLoaded', sync, { once: true })
}
