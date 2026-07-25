// nodechess seed: the node swarm.
//
// Runs N independent nodechess nodes in ONE process (a browser tab or the
// desktop shell) so a volunteer can contribute real capacity without owning N
// machines. Each node is a full peer: its own identity, its own fabric room
// membership, its own Kademlia routing table and its own slice of shard space.
//
// WHAT A SEED NODE IS FOR, and what it deliberately is NOT.
//
// Default mode is INFRASTRUCTURE: `caps.witness = false`, `caps.committee =
// false`, `shardMb > 0`. Such a node does routing, shard hosting, mailbox relay
// and presence: all of which are *verifiable* services. It cannot attest to a
// game, cosign a checkpoint, grant a write lease or hold a PIN share, because
// eligibility for every one of those reads the advertised caps
// (eligibility.ts 'no-witness-cap'; pinClient.drawPinCommittee filters
// caps.committee). A node that holds no authority is safe to run in bulk: 25 of
// them are 25× the capacity and 0× the trust, so it does not matter who runs
// them or how many they run.
//
// WITNESS mode flips caps.witness on. That IS authority. One witness is enough
// to certify a rated result, so it is opt-in, off by default, and deliberately
// not something the UI encourages running at scale. It exists so an operator
// can bring up the third machine a 2-player rated table needs while the network
// is small, and so real volunteers can carry witness duty once there are enough
// independent ones for that to mean anything.
//
// Identities are derived from ONE locally-stored seed (index 0..n-1), so a node
// keeps its identity across restarts. Uptime and reputation accrue to a stable
// nodeId instead of resetting every launch.

import { KEY_PURPOSE, deriveChild, toB64u } from '@shared/accounts'
import { liveNodesOf, nodeIdOf } from '@shared/accounts/witness'
import { createBrowserFabric } from '@/features/account/net/browserFabric'
import { startAccountPeer, type AccountPeer } from '@/features/account/net/peerService'
import { summarizeNetStatus } from '@/features/account/net/accountNetStatus'
import { openKvStore, type KvStore } from '@/features/account/net/kvStore'

/** Presence re-announce cadence. Presence is ephemeral (§4/§11): a node that
 *  stops announcing drops out of everyone's directory within the stale window,
 *  which is exactly the behavior we want when a volunteer closes the tab. */
const ANNOUNCE_INTERVAL_MS = 30_000

/** Per-node shard budget. Kept modest because a swarm multiplies it: 25 nodes ×
 *  40 MB is a 1 GB contribution from one machine, which is already generous. */
const DEFAULT_SHARD_MB = 40

/** Hard ceiling on swarm size. Each node opens its own relay sockets, so an
 *  unbounded count would exhaust the browser's connection budget and degrade
 *  every node instead of helping. */
export const MAX_NODES = 25

export type SeedMode = 'infrastructure' | 'witness'

export interface SeedStats {
  /** Nodes that reached 'started' (some may still be finding peers). */
  nodesRunning: number
  /** Nodes that can currently see at least one other node. */
  nodesConnected: number
  /** Distinct remote nodes visible across the swarm (deduped, 25 nodes seeing
   *  the same peer is one peer, not 25). */
  peersReachable: number
  /** Total advertised shard capacity, MB. */
  capacityMb: number
  /** Bytes currently held on behalf of other accounts, across the swarm. */
  storedBytes: number
  /** ms since start(), or 0 when stopped. */
  uptimeMs: number
}

export const EMPTY_STATS: SeedStats = {
  nodesRunning: 0,
  nodesConnected: 0,
  peersReachable: 0,
  capacityMb: 0,
  storedBytes: 0,
  uptimeMs: 0,
}

export interface SeedConfig {
  nodes: number
  mode: SeedMode
  shardMb: number
}

export const DEFAULT_CONFIG: SeedConfig = {
  nodes: 5,
  mode: 'infrastructure',
  shardMb: DEFAULT_SHARD_MB,
}

interface RunningNode {
  peer: AccountPeer
  kv: KvStore
  root: string
}

const SEED_STORAGE_KEY = 'nodechess.seed.identity.v1'

/**
 * The swarm's long-lived identity seed. Generated once and persisted, so this
 * installation's nodes keep their nodeIds (and therefore their accrued uptime)
 * across restarts. Falls back to an ephemeral seed when storage is unavailable.
 * A private-mode tab still contributes, it just starts fresh each time.
 */
function loadOrCreateSeed(): Uint8Array {
  const store = (globalThis as { localStorage?: Storage }).localStorage
  const existing = store?.getItem(SEED_STORAGE_KEY)
  if (existing) {
    try {
      const bytes = Uint8Array.from(atob(existing), (c) => c.charCodeAt(0))
      if (bytes.length === 32) return bytes
    } catch {
      /* corrupt entry: fall through and mint a new one */
    }
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32))
  try {
    store?.setItem(SEED_STORAGE_KEY, btoa(String.fromCharCode(...fresh)))
  } catch {
    /* storage denied: run ephemerally */
  }
  return fresh
}

/**
 * The swarm controller: start / stop / observe. One instance per page. Start is
 * idempotent-ish (a second call while running is a no-op) and stop always tears
 * down everything it managed to bring up, including on a partial start.
 */
export class SeedSwarm {
  private nodes: RunningNode[] = []
  private startedAt = 0
  private starting = false
  private seed = loadOrCreateSeed()
  private listeners = new Set<() => void>()
  /** root -> bytes held, refreshed by a slow poll. kv.bytes() is async and
   *  stats() is read from render, so the number is cached rather than awaited. */
  private heldBytes = new Map<string, number>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  /** Subscribe to state changes (start/stop/partial progress). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  get running(): boolean {
    return this.nodes.length > 0 || this.starting
  }

  /** This swarm's stable nodeIds, for display. Derived, so they are known even
   *  before the nodes are up. */
  nodeIdsFor(count: number): string[] {
    const ids: string[] = []
    for (let i = 0; i < Math.min(count, MAX_NODES); i++) {
      ids.push(nodeIdOf(toB64u(deriveChild(this.seed, KEY_PURPOSE.device, i).pub)))
    }
    return ids
  }

  async start(config: SeedConfig): Promise<void> {
    if (this.running) return
    this.starting = true
    this.startedAt = Date.now()
    this.emit()

    const count = Math.max(1, Math.min(config.nodes, MAX_NODES))
    // Sequential, not Promise.all: each node join is a burst of relay sockets,
    // and starting 25 at once reliably trips connection limits. Nodes come up
    // one at a time and the UI counts them as they land.
    for (let i = 0; i < count; i++) {
      if (!this.starting) break // stop() was called mid-start
      try {
        this.nodes.push(await this.startOne(i, config))
        this.emit()
      } catch {
        // One node failing to come up is not fatal, the rest still contribute.
      }
    }
    this.starting = false
    // Byte accounting is a slow poll, not a hot path: shard traffic changes on
    // the order of minutes and 25 IndexedDB scans per second would be absurd.
    this.pollTimer = setInterval(() => void this.refreshHeldBytes(), 10_000)
    void this.refreshHeldBytes()
    this.emit()
  }

  private async refreshHeldBytes(): Promise<void> {
    for (const n of this.nodes) {
      try {
        this.heldBytes.set(n.root, await n.kv.bytes())
      } catch {
        /* a closing store mid-poll is expected during stop() */
      }
    }
    this.emit()
  }

  private async startOne(index: number, config: SeedConfig): Promise<RunningNode> {
    // Each node gets its own derived identity. root === the device key here:
    // a seed node has no account chain and never appends one, so there is no
    // root/child split to maintain: it only ever signs its own presence.
    const kpNode = deriveChild(this.seed, KEY_PURPOSE.device, index)
    const root = toB64u(kpNode.pub)
    const kv = await openKvStore({
      budgetBytes: config.shardMb * 1024 * 1024,
      requestPersist: index === 0, // one persistence prompt, not 25
      dbName: `nodechess-seed-${index}`,
    })
    const fabric = createBrowserFabric({ nodeId: nodeIdOf(root) })
    const peer = await startAccountPeer({
      identity: { root, key: root, priv: kpNode.priv },
      fabric,
      kv,
      announceIntervalMs: ANNOUNCE_INTERVAL_MS,
      caps: {
        // The whole safety argument in one object: capacity yes, authority no.
        witness: config.mode === 'witness',
        committee: false,
        shardMb: config.shardMb,
      },
    })
    return { peer, kv, root }
  }

  async stop(): Promise<void> {
    this.starting = false
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    const running = this.nodes
    this.nodes = []
    this.startedAt = 0
    this.heldBytes.clear()
    this.emit()
    await Promise.allSettled(
      running.map(async (n) => {
        await n.peer.stop()
        await n.kv.close()
      }),
    )
    this.emit()
  }

  stats(): SeedStats {
    if (this.nodes.length === 0) return EMPTY_STATS
    const now = Date.now()
    const distinctPeers = new Set<string>()
    let connected = 0
    let storedBytes = 0
    let capacityMb = 0

    for (const n of this.nodes) {
      const status = summarizeNetStatus(n.peer, now)
      if (status.peersReachable > 0) connected++
      capacityMb += n.peer.caps.shardMb
      storedBytes += this.heldBytes.get(n.root) ?? 0
      for (const sp of liveNodesOf(n.peer.fabric.directory(), now)) {
        // Our own nodes are not "peers reached". Only strangers count.
        if (!this.nodes.some((own) => own.root === sp.body.root)) distinctPeers.add(sp.body.root)
      }
    }

    return {
      nodesRunning: this.nodes.length,
      nodesConnected: connected,
      peersReachable: distinctPeers.size,
      capacityMb,
      storedBytes,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
    }
  }
}
