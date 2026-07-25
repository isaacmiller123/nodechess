// A2 fabric-core. Signed presence + the observer-local NodeDirectory (spec §4:
// "The lease, presence, and mailbox are ephemeral coordination state, expiring,
// reconstructible, no authority", C-3). Directories are LOCAL: every rule that
// matters (thresholds, eligibility, diversity) is enforced on a record's
// SIGNATURE SET, never on any one observer's directory, so view divergence
// degrades liveness only, never safety.
//
// All functions are pure given `nowMs`. No Date.now(), no Math.random().
// Platform-neutral: no `node:` imports, no DOM globals.

import { z } from 'zod'
import { canonicalBytes, compareKeys } from '../codec'
import { zB64u32, zB64u64 } from '../events'
import { ed25519, toB64u, verifySigB64u } from '../hash'
import type { NodeDirectory, NodeId, PresenceBody, SignedPresence } from './types'
import { nodeIdOf } from './distance'

// ---------------------------------------------------------------------------
// Shape validation (mirror of types.ts PresenceBody, .strict())
// ---------------------------------------------------------------------------

const zPresenceBody = z.strictObject({
  v: z.literal(1),
  root: zB64u32,
  key: zB64u32,
  caps: z.strictObject({
    witness: z.boolean(),
    committee: z.boolean(),
    shardMb: z.int().min(0),
  }),
  params: zB64u32,
  ts: z.int().min(0),
  uptimePct: z.int().min(0).max(100),
})

const zSignedPresence = z.strictObject({ body: zPresenceBody, sig: zB64u64 })

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/** Sign a presence body with the device private key matching body.key. */
export function signPresence(body: PresenceBody, priv: Uint8Array): SignedPresence {
  const sig = toB64u(ed25519.sign(canonicalBytes(body), priv))
  return { body, sig }
}

/**
 * Verify a presence record: strict shape + ed25519 signature by body.key over
 * canonicalBytes(body). Note this proves only that the advertised device key
 * signed the record. NOT that the key is certified under body.root (that is a
 * chain fact judged by eligibility.ts, which reads the node's chain). Never throws.
 */
export function verifyPresence(sp: SignedPresence): boolean {
  if (!zSignedPresence.safeParse(sp).success) return false
  return verifySigB64u(sp.sig, canonicalBytes(sp.body), sp.body.key)
}

// ---------------------------------------------------------------------------
// Directory (observer-local, newest-per-node, staleness-pruned)
// ---------------------------------------------------------------------------

/**
 * The live nodes of a directory at `nowMs`: records whose age (nowMs − body.ts)
 * is within staleAfterMs, sorted deterministically by nodeId. Pure. A record
 * from the (skewed) future is age ≤ 0 → live. Callers use this as the candidate
 * pool for the canonical witness set.
 */
export function liveNodesOf(dir: NodeDirectory, nowMs: number): SignedPresence[] {
  // The directory is keyed by nodeId (ingest/announce set the key to
  // nodeIdOf(root)), so use the key rather than re-deriving sha256(root) here.
  const live: { nodeId: NodeId; sp: SignedPresence }[] = []
  for (const [nodeId, sp] of dir.nodes) {
    if (nowMs - sp.body.ts <= dir.staleAfterMs) live.push({ nodeId, sp })
  }
  live.sort((a, b) => compareKeys(a.nodeId, b.nodeId))
  return live.map((x) => x.sp)
}

export interface DirectoryManager {
  /** The underlying observer-local directory (the NodeDirectory contract). */
  readonly directory: NodeDirectory
  /** Admit a record: verifies its signature, keeps newest-per-nodeId, and
   * drops records already stale at `nowMs`. Returns whether it was stored. */
  ingest(sp: SignedPresence, nowMs: number): boolean
  /** Live records at `nowMs` (see liveNodesOf). Pure given nowMs. */
  liveNodes(nowMs: number): SignedPresence[]
}

/** Create an empty observer-local directory manager. */
export function makeDirectory(staleAfterMs: number): DirectoryManager {
  const directory: NodeDirectory = { nodes: new Map<NodeId, SignedPresence>(), staleAfterMs }
  return {
    directory,
    ingest(sp: SignedPresence, nowMs: number): boolean {
      if (!verifyPresence(sp)) return false
      // Nothing to gain from ingesting a record already dead at nowMs.
      if (nowMs - sp.body.ts > staleAfterMs) return false
      const nodeId = nodeIdOf(sp.body.root)
      const prev = directory.nodes.get(nodeId)
      if (prev && prev.body.ts >= sp.body.ts) return false // newest wins
      directory.nodes.set(nodeId, sp)
      return true
    },
    liveNodes(nowMs: number): SignedPresence[] {
      return liveNodesOf(directory, nowMs)
    },
  }
}
