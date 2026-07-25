// BOOTSTRAP-SEAM — the always-awake overlay nodes a client prefers when seeding
// its Kademlia routing table (spec §5). Twin of relayConfig.ts / iceConfig.ts:
// one env var, empty default, no behavior change until a deployment sets it.
//
// WHAT THIS IS AND IS NOT. It cannot create connectivity — trystero's relays do
// that, and a peer we have not met over the fabric is unreachable no matter what
// is configured here. What it changes is WHICH of the peers we have met seed the
// routing table. `overlayNode.bootstrap()` with no seeds ingests the whole fabric
// directory (overlay/node.ts:431), so on a network of browser tabs the table
// fills with nodes that close when someone closes a tab. Every one of those costs
// a k-bucket slot and an `admitOutbound` round-trip, and buckets are small. Seeded
// from the seed program's nodes (src/seed, run to be up permanently) the table
// starts with entries that are still there on the next lookup, and Kademlia's own
// self-lookup discovers everyone else from them — which is the ordinary design of
// a bootstrap node, not a special case.
//
// A pinned root grants NO authority. It does not make a node a witness, a
// committee member or a shard host: eligibility reads the advertised, SIGNED caps
// and nothing else, and every seed here still goes through `verifyPresence`
// before it enters the table. The worst a bad entry can do is waste a lookup.
//
// FORMAT of `VITE_BOOTSTRAP_PEERS` — the b64u ROOT pubkeys (not nodeIds; nodeId =
// sha256(root) and the directory is keyed by it, so we match on the root the
// presence body carries) of the bootstrap nodes, either:
//   • comma-separated:  <root>,<root>
//   • JSON string array: ["<root>","<root>"]
// `SeedSwarm.nodeIdsFor()` prints nodeIds for display; the roots come from the
// same derivation (src/seed/swarm.ts, `toB64u(deriveChild(...).pub)`).
// Any malformed entry ⇒ the whole value is ignored and the overlay bootstraps
// exactly as it does today (all-or-none, mirroring relayConfig/iceConfig).

import { liveNodesOf } from '@shared/accounts/witness'
import type { NodeDirectory, SignedPresence } from '@shared/accounts/witness'
import type { B64u } from '@shared/accounts'

/**
 * An ed25519 pubkey is 32 bytes, which `toB64u` (base64url, unpadded) renders as
 * exactly 43 chars. Checking the exact length rather than a loose charset match
 * catches the realistic deployment mistake — a truncated copy/paste, or a nodeId
 * pasted where a root belongs would still be 43, but a half-copied key is caught.
 */
const ROOT_B64U = /^[A-Za-z0-9_-]{43}$/

/**
 * The configured bootstrap peer roots, empty when `VITE_BOOTSTRAP_PEERS` is unset
 * or malformed. Empty is the shipped default: nothing about the overlay changes
 * until a deployment names its seed nodes.
 */
export function resolveBootstrapPeers(): readonly B64u[] {
  return envBootstrapPeers() ?? []
}

/** Whether `root` is a configured bootstrap peer — for status surfaces that need
 *  to say honestly whether a client has reached one. */
export function isBootstrapPeer(root: B64u): boolean {
  return resolveBootstrapPeers().includes(root)
}

/**
 * The seed list to hand `overlayNode.bootstrap()` / `startAccountPeer({seeds})`:
 * the LIVE presences of the configured bootstrap peers, or `undefined` to keep
 * today's behavior (bootstrap ingests the whole directory).
 *
 * `undefined` is returned both when no peers are configured and when none of them
 * are currently live, so a bootstrap node that is down or not yet gossiped can
 * never be worse than no configuration at all — it degrades to the directory
 * rather than to an empty seed set. Liveness uses the directory's own
 * `staleAfterMs` via `liveNodesOf`, so a bootstrap peer that stopped announcing
 * is treated as gone like any other node.
 */
export function selectBootstrapSeeds(
  directory: NodeDirectory,
  nowMs: number,
): SignedPresence[] | undefined {
  const roots = resolveBootstrapPeers()
  if (roots.length === 0) return undefined
  const wanted = new Set<string>(roots)
  const seeds = liveNodesOf(directory, nowMs).filter((sp) => wanted.has(sp.body.root))
  return seeds.length > 0 ? seeds : undefined
}

/**
 * Build-time env read, guarded exactly like relayConfig.ts / iceConfig.ts so the
 * module still loads in bare-node bundles with no import.meta.env. Returns null
 * for absent OR malformed — the caller treats both as "no bootstrap peers".
 */
function envBootstrapPeers(): B64u[] | null {
  const env = (import.meta as { env?: Record<string, unknown> }).env
  const raw = env?.VITE_BOOTSTRAP_PEERS
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const roots = parsePeerList(raw)
  if (roots && roots.length > 0 && roots.every((r) => ROOT_B64U.test(r))) return roots
  return null
}

/**
 * Parse the raw env value into a candidate root list (not yet validated): a JSON
 * string array (leading `[`) or a comma-separated list. Empty segments are
 * dropped; each is trimmed. Returns null when the JSON form is malformed / not a
 * string array.
 */
function parsePeerList(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.every((r) => typeof r === 'string'))
        return parsed.map((r) => (r as string).trim()).filter((s) => s !== '')
    } catch {
      /* malformed JSON VITE_BOOTSTRAP_PEERS — ignore, bootstrap from the directory */
    }
    return null
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}
