// A6 M1 Lane A — env/config-replaceable STUN/TURN (spec §4 C-11). The ICE server
// set used to live inline in rtcTransport.ts (the proven live WebRTC path); it is
// extracted here VERBATIM so a single module owns relay/TURN selection for BOTH
// the mp game transport (rtcTransport.ts) and the browser accounts fabric
// (browserFabric.ts).
//
// C-11 (spec §4): "signaling currently rides third-party Nostr relays + public
// TURN; both must be replaceable, with the operator peer as fallback". This
// module makes the TURN/STUN list replaceable in ONE place:
//   - `override` (programmatic, highest priority — e.g. a settings panel),
//   - `VITE_ICE_SERVERS` (build-time env, JSON RTCIceServer[]),
//   - else the built-in DEFAULT_ICE_SERVERS (byte-identical to the old inline set),
//   - plus an OPERATOR-FALLBACK slot appended as relay-of-last-resort, from
//     `opts.operatorFallback` or `VITE_TURN_FALLBACK`.
// When no override/env is present the result is byte-identical to the previous
// inline array, so the proven live path is unchanged.
//
// The env fallback exists because a deployment that stands up its own always-awake
// nodes (src/seed, pinned via net/bootstrapPeers.ts) will run coturn on those same
// hosts, and a build-time env is the one place that knows their addresses. It is
// APPENDED, never substituted: TURN is the expensive path, so a self-hosted relay
// belongs after the STUN entries that resolve most NATs for free.
//
// Platform: renderer (DOM RTCIceServer types). The env read is guarded so this
// module still loads in bare-node suite bundles that have no import.meta.env
// (src/web/accountsFlag.ts / src/web/engines/assets.ts precedent).

/**
 * The built-in default STUN/TURN set — extracted verbatim from rtcTransport.ts
 * (was the inline `ICE_SERVERS`). Google STUN is blocked in China, hence the
 * Cloudflare STUN; the openrelay TURN entries are a best-effort fallback for
 * symmetric NATs (ICE silently skips any dead server, so extras never hurt).
 *
 * NOTE (spec §4 honest limit): public openrelay TURN is fine for a demo but is a
 * real availability risk for RATED play — a self-hosted coturn (or the operator
 * peer via the fallback slot below) is the symmetric-NAT reliability floor.
 */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: ['turn:standard.relay.metered.ca:80', 'turn:standard.relay.metered.ca:443?transport=tcp'],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

export interface IceResolveOpts {
  /**
   * Explicit override (highest priority). When present + non-empty it REPLACES
   * the base set entirely — the programmatic C-11 replacement hook (e.g. a
   * settings panel or an ops-served config).
   */
  override?: readonly RTCIceServer[] | null
  /**
   * Operator-fallback slot (spec §4 C-11): the operator peer's TURN / a
   * self-hosted coturn, appended AFTER the base set as relay-of-last-resort.
   * ICE prefers earlier (closer) servers, so this is the reliability floor, not
   * the first choice. Absent ⇒ `VITE_TURN_FALLBACK`; explicit `null` suppresses
   * that env too, for a caller that must build a bare ICE set.
   */
  operatorFallback?: readonly RTCIceServer[] | null
}

/**
 * The effective ICE server list. Precedence: `override` → `VITE_ICE_SERVERS`
 * env → DEFAULT_ICE_SERVERS; then the operator-fallback slot (`operatorFallback`
 * → `VITE_TURN_FALLBACK`) is appended. Returns a FRESH, deeply-copied array (safe
 * to hand to a mutable RTCConfiguration). With no override/env/fallback the
 * result is byte-identical to the old inline `ICE_SERVERS` — the live WebRTC path
 * is unchanged.
 */
export function resolveIceServers(opts: IceResolveOpts = {}): RTCIceServer[] {
  const base =
    opts.override && opts.override.length > 0 ? opts.override : (envIceServers() ?? DEFAULT_ICE_SERVERS)
  const out = base.map(cloneIceServer)
  // `undefined` falls through to the env; an explicit `null` means "no fallback".
  const fallback = opts.operatorFallback === undefined ? envTurnFallback() : opts.operatorFallback
  if (fallback) for (const s of fallback) out.push(cloneIceServer(s))
  return out
}

/**
 * Build-time env override (C-11): a JSON RTCIceServer[] in `VITE_ICE_SERVERS`.
 * Guarded like accountsFlag.ts so the module loads in bare-node bundles with no
 * import.meta.env. A malformed value is IGNORED (falls back to defaults) —
 * garbage never silently breaks NAT traversal.
 */
function envIceServers(): RTCIceServer[] | null {
  const env = (import.meta as { env?: Record<string, unknown> }).env
  const raw = env?.VITE_ICE_SERVERS
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every(isIceServer)) return parsed.map(cloneIceServer)
  } catch {
    /* malformed VITE_ICE_SERVERS — ignore, keep the defaults */
  }
  return null
}

/**
 * The operator-fallback slot from env (C-11): a JSON RTCIceServer[] in
 * `VITE_TURN_FALLBACK`, typically one self-hosted coturn with its credentials.
 * Same guard + all-or-none validation as envIceServers — a malformed value is
 * ignored, leaving the base set alone rather than half-applying it.
 */
function envTurnFallback(): RTCIceServer[] | null {
  const env = (import.meta as { env?: Record<string, unknown> }).env
  const raw = env?.VITE_TURN_FALLBACK
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isIceServer))
      return parsed.map(cloneIceServer)
  } catch {
    /* malformed VITE_TURN_FALLBACK — ignore, ship the base set unchanged */
  }
  return null
}

/** Minimal structural guard: an RTCIceServer needs `urls` (string or string[]). */
function isIceServer(v: unknown): v is RTCIceServer {
  if (typeof v !== 'object' || v === null) return false
  const urls = (v as { urls?: unknown }).urls
  return typeof urls === 'string' || (Array.isArray(urls) && urls.every((u) => typeof u === 'string'))
}

/** Deep-copy one entry (its `urls` array too) so callers can't mutate a source. */
function cloneIceServer(s: RTCIceServer): RTCIceServer {
  return { ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls }
}
