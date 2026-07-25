// Fetching the static content tree (<base>content/, emitted by
// vite.web.config.ts). One helper, three rules:
//
//   - Every file is fetched at most once per page and memoized. The catalogs
//     are immutable for the life of the deployment, and the renderer asks for
//     them from several surfaces (the school index re-reads chapters on every
//     mount, the gallery re-reads personas).
//   - A failed fetch clears its own memo, so a flaky network is retried on the
//     next call rather than poisoning the surface for the session.
//   - Failure is LOUD and names the file. There is no fixture fallback: a
//     missing content file means the deploy is incomplete, and saying so beats
//     rendering an empty curriculum that looks like a finished one.

const cache = new Map<string, Promise<unknown>>()

/** Vite base URL; guarded so non-Vite bundlers (the esbuild test harnesses)
 *  can evaluate this module. Mirrors src/web/engines/assets.ts. */
function base(): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env
  return env?.BASE_URL ?? '/'
}

/** Absolute URL of one file in the content tree, e.g. 'personas/morphy.jpg'. */
export function contentUrl(path: string): string {
  return `${base()}content/${path}`
}

export function loadContent<T>(path: string): Promise<T> {
  const hit = cache.get(path)
  if (hit) return hit as Promise<T>

  const url = contentUrl(path)
  const pending = (async () => {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`nodechess content missing: ${url} (HTTP ${res.status})`)
    }
    try {
      return (await res.json()) as T
    } catch {
      // A 200 that isn't JSON means the host answered with something else
      // entirely (an SPA catch-all, a captive portal); say which file.
      throw new Error(`nodechess content unreadable: ${url} did not return JSON`)
    }
  })().catch((err: unknown) => {
    cache.delete(path)
    throw err
  })

  cache.set(path, pending)
  return pending
}
