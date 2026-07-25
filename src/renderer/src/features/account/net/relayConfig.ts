// RELAY-SEAM — the Nostr SIGNALING relays every trystero user rides (spec §4
// C-11, the signaling half of the same requirement iceConfig.ts covers for
// STUN/TURN). One module owns the relay list for ALL THREE trystero call sites:
// the browser accounts fabric (browserFabric.ts), the matchmaking pool
// (matchmaking.ts), and the mp game transport (play/online/rtcTransport.ts).
//
// WHY A PINNED LIST INSTEAD OF THE FORK DEFAULTS. Signaling is not broken — the
// fork ships ~44 public relays and picks 5 (@trystero-p2p/nostr:144), so peer
// discovery works with no config at all. The problem is that we neither chose
// nor vet those 5: the fork picks them with `shuffle(defaults, strToNum(appId))`
// (@trystero-p2p/core/dist/utils.mjs:45), so the SUBSET is a function of the
// appId. Our three call sites use two different appIds, which means the game
// transport and the accounts fabric currently sit on two disjoint relay sets,
// each re-rolled by any dependency bump that reorders the list. Pinning makes
// the signaling surface one known, tested set that moves only when we move it.
//
// The pinned relays are PUBLIC ones we verified, not ones we run — the honest
// upgrade is `VITE_NOSTR_RELAYS` pointed at relays we operate. Both are one env
// var apart, which is the whole point of the seam.
//
// Platform: renderer, but DOM-free (plain strings + a config object), so it also
// loads in the bare-node smoke bundles that import browserFabric/matchmaking. The
// env read is guarded EXACTLY like iceConfig.ts / accountsFlag.ts so the module
// still loads where there is no import.meta.env; a malformed value is IGNORED
// (keep the pinned list) — garbage never silently breaks signaling.
//
// FORMAT of `VITE_NOSTR_RELAYS` (any of):
//   • comma-separated:  wss://relay.a.example,wss://relay.b.example
//   • JSON string array: ["wss://relay.a.example","wss://relay.b.example"]
//   • the literal `default` — hand trystero NO relayConfig and take whatever the
//     fork ships. The escape hatch for the day our pinned set is the thing that
//     is down; it is the ONLY way to get the old behavior back.
// Every entry must be a ws:// or wss:// URL; if any entry is malformed the whole
// value is ignored and the pinned list stands (mirrors iceConfig's all-or-none
// `every(isIceServer)` guard).

/**
 * The pinned signaling relays. Every one was verified by full round-trip —
 * subscribe to an ephemeral kind with trystero's `#x` tag filter, publish a
 * signed event on it, read it back — because that, not a WebSocket that merely
 * opens, is what trystero signaling actually needs: a relay can accept `REQ`,
 * look healthy to a naive probe, and silently drop the ephemeral kinds
 * (20000-29999) trystero publishes because it is paid, NIP-42 gated, or blocks
 * ephemerals outright. Several popular relays fail exactly that way.
 *
 * Eight rather than the fork's five, spread over independent operators and three
 * regions (US / EU / APAC), because a relay list is a correlated-failure surface:
 * signaling needs only one or two of these alive, so the cost of extras is a
 * socket and the benefit is that no single operator or region outage is fatal.
 * All eight are used verbatim — see `redundancy` below.
 */
export const DEFAULT_NOSTR_RELAYS: readonly string[] = [
  'wss://relay.damus.io', // US — largest public relay
  'wss://nos.lol', // US
  'wss://relay.primal.net', // US, independent operator
  'wss://offchain.pub', // US
  'wss://nostr-pub.wellorder.net', // US, long-running
  'wss://nostr.oxtr.dev', // EU
  'wss://strfry.openhoofd.nl', // EU (NL)
  'wss://yabu.me', // APAC (JP) — the only entry Asia-Pacific peers reach quickly
]

/**
 * The relay config handed to trystero's `joinRoom` (a structural subset of the
 * fork's `RelayConfig`, declared inline so this module imports nothing — the same
 * zero-import discipline as iceConfig.ts).
 *
 * `redundancy` is set to the full list length to state the intent, but note it
 * is DEAD when `urls` is present: `getRelays` is
 * `config.relayConfig?.urls || defaults.slice(0, redundancy)`
 * (@trystero-p2p/core/dist/utils.mjs:45), so an explicit list is used whole and
 * redundancy only ever slices the fork's OWN defaults. Kept because it matches
 * the proven smoke shape (scripts/smoke/turnBrowserEntry.js) and because a fork
 * that starts honoring it should sample all of our list, not a prefix.
 */
export interface NostrRelayConfig {
  urls: string[]
  redundancy: number
}

/**
 * The effective Nostr signaling relay config, or `null` to take the trystero fork
 * defaults. Precedence: `VITE_NOSTR_RELAYS` env → DEFAULT_NOSTR_RELAYS. Null is
 * returned ONLY for the explicit `default` sentinel, so the call sites' existing
 * `relayConfig ? {relayConfig} : {}` spread keeps meaning "let the fork choose".
 */
export function resolveNostrRelays(): NostrRelayConfig | null {
  const env = envNostrRelays()
  if (env === FORK_DEFAULTS) return null
  const urls = env ?? DEFAULT_NOSTR_RELAYS
  return { urls: [...urls], redundancy: urls.length }
}

/** Sentinel for `VITE_NOSTR_RELAYS=default`, distinct from "env absent" (null). */
const FORK_DEFAULTS = Symbol('trystero-fork-default-relays')

/**
 * Build-time env override (C-11): a comma-separated or JSON-array list of relay
 * URLs in `VITE_NOSTR_RELAYS`, or `default` for the fork's own list. Guarded like
 * iceConfig.ts / accountsFlag.ts so the module loads in bare-node bundles with no
 * import.meta.env. A malformed value is IGNORED (falls back to the pinned list) —
 * garbage never silently breaks signaling.
 */
function envNostrRelays(): string[] | typeof FORK_DEFAULTS | null {
  const env = (import.meta as { env?: Record<string, unknown> }).env
  const raw = env?.VITE_NOSTR_RELAYS
  if (typeof raw !== 'string' || raw.trim() === '') return null
  if (raw.trim().toLowerCase() === 'default') return FORK_DEFAULTS
  const urls = parseRelayList(raw)
  // All-or-none, mirroring iceConfig's `parsed.every(isIceServer)`: any malformed
  // entry ⇒ ignore the whole value and keep the pinned list.
  if (urls && urls.length > 0 && urls.every(isRelayUrl)) return urls
  return null
}

/**
 * Parse the raw env value into a candidate URL list (not yet validated): a JSON
 * string array (leading `[`) or a comma-separated list. Empty segments are
 * dropped; each is trimmed. Returns null when the JSON form is malformed / not a
 * string array (so the caller keeps the pinned list).
 */
function parseRelayList(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.every((u) => typeof u === 'string'))
        return parsed.map((u) => (u as string).trim()).filter((s) => s !== '')
    } catch {
      /* malformed JSON VITE_NOSTR_RELAYS — ignore, keep the pinned list */
    }
    return null
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** Minimal structural guard: a Nostr relay is a `ws://` or `wss://` URL. */
function isRelayUrl(u: unknown): u is string {
  return typeof u === 'string' && /^wss?:\/\/[^\s]+$/i.test(u)
}
