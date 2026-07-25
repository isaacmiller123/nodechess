// A3 overlay: the Kademlia node over a FabricEndpoint (overlay/types.ts
// contract, spec §5, C-11: the fabric is transport + bootstrap ONLY. All
// routing lives here).
//
// Determinism rules (suite-load-bearing):
//  - no Date.now / Math.random / timers: the clock is opts.nowMs, and refresh
//    is caller-driven; nothing here schedules anything;
//  - every candidate ordering is XOR distance with the compareNodeIdBytes
//    tie-break (witness/distance.ts: reused, never reimplemented);
//  - iterative lookups probe SEQUENTIALLY in that deterministic order
//    (parallelism is a later optimization the suites must not depend on).
//
// Admission (anti-eclipse, overlay/types.ts KBucket rule):
//  - contacts learned from FIND_NODE responses are ROUTING HINTS only. They
//    ride the lookup shortlist + hint book, never the table;
//  - a contact enters the table only after a DIRECT exchange: it answered our
//    RPC (outbound path: full eviction-candidate ping flow) or it sent us a
//    valid RPC (inbound path; admitted only into a non-full bucket: no ping
//    from inside a handler, so admission chains cannot recurse across nodes);
//  - a full bucket NEVER evicts a live long-standing contact: the newcomer is
//    dropped unless the least-recently-seen contact fails a ping.

import type { CanonicalObject } from '../codec'
import type { B64u } from '../types'
import { nodeIdOf, xorDistance, compareNodeIdBytes } from '../witness/distance'
import { verifyPresence } from '../witness/presence'
import type { FabricEndpoint, NodeId, SignedPresence } from '../witness/types'
import { PARAMS_A3 } from '../storage/params'
import {
  allContacts,
  closestContacts,
  insertContact,
  newRoutingTable,
  removeContact,
  replaceContact,
  touchContact,
} from './kbucket'
import {
  onOverlay,
  overlayRequest,
  zFindNodeReq,
  zFindNodeRes,
  zFindValueReq,
  zFindValueRes,
  zPingReq,
  zPingRes,
  zStoreReq,
  zStoreRes,
} from './rpc'
import { zB64u32 } from '../events'
import type { Contact, OverlayNode, OverlayOpts, StoreValidator, ValueKind } from './types'

// ---------------------------------------------------------------------------
// Options & extended surface
// ---------------------------------------------------------------------------

/** Local-store fold: prev is the held value (null when none). Default is
 * replace (return next). Pointer-set union semantics live in the STORAGE
 * layer's merge. The overlay stays value-agnostic. */
export type MergeFn = (
  prev: CanonicalObject | null,
  next: CanonicalObject,
  kind: ValueKind,
  target: B64u,
) => CanonicalObject

export interface LookupStats {
  rpcs: number
  rounds: number
}

export interface OverlayNodeOpts extends OverlayOpts {
  merge?: MergeFn
  /** Suite overrides; default PARAMS_A3. */
  kBucket?: number
  alpha?: number
  replicateK?: number
  knownCap?: number
}

/** The full node surface: the OverlayNode contract plus the storage-layer and
 * suite seams (getMerged / localPut / lastLookupStats). */
export interface OverlayNodeExt extends OverlayNode {
  /** Query ALL of the final k-closest set and fold hits through the merge. */
  getMerged(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
  /** Storage-layer local write. Same validator+merge path as overlay-store. */
  localPut(target: B64u, kind: ValueKind, value: CanonicalObject): boolean
  /** Stats of the most recent iterative walk (lookup or get). */
  readonly lastLookupStats: LookupStats | null
  /** Current hint-book size (test seam for the knownCap anti-DoS bound). */
  readonly knownSize: number
}

const defaultValidator: StoreValidator = (_from, _target, kind, _value) => kind === 'record'
const defaultMerge: MergeFn = (_prev, next) => next

// ---------------------------------------------------------------------------
// createOverlayNode
// ---------------------------------------------------------------------------

interface Slot {
  nodeId: NodeId
  root: B64u
  key: B64u
  state: 'new' | 'ok' | 'fail'
}

export function createOverlayNode(
  fabric: FabricEndpoint,
  contact: { root: B64u; key: B64u },
  opts: OverlayNodeOpts,
): OverlayNodeExt {
  const nodeId: NodeId = nodeIdOf(contact.root)
  const table = newRoutingTable(nodeId)
  const kBucket = opts.kBucket ?? PARAMS_A3.kBucket
  const alpha = opts.alpha ?? PARAMS_A3.alpha
  const replicateK = opts.replicateK ?? PARAMS_A3.replicateK
  const validator = opts.validator ?? defaultValidator
  const merge = opts.merge ?? defaultMerge

  /** Local value store, keyed kind+'|'+target. */
  const store = new Map<string, CanonicalObject>()
  /** Hint book: routing info (root/key per nodeId) learned from responses,
   * seeds, and the directory: feeds shortlists and inbound admission. Bounded
   * (see rememberHint): a malicious responder cannot inflate it without limit. */
  const known = new Map<NodeId, { root: B64u; key: B64u }>()
  const knownCap = opts.knownCap ?? PARAMS_A3.knownCap
  let closed = false
  let lastLookupStats: LookupStats | null = null

  const storeKey = (kind: ValueKind, target: B64u): string => kind + '|' + target
  const alive = (): boolean => !closed
  // Contact.lastSeenMs rides the wire (zContact = z.int()) and through the
  // canonical codec (integers only), so the injected clock, which an embedder
  // may wire to a fractional source like performance.now(), MUST be floored at
  // every stamp site, or a single FIND_NODE response carrying a fractional
  // lastSeenMs fails the responder's zFindNodeRes/codec check and collapses
  // routing. lastSeenMs is only ever an LRU tiebreak, so flooring is lossless.
  const nowInt = (): number => Math.floor(opts.nowMs())

  /** Record a hint, FIFO-bounded at knownCap. JS Map preserves insertion order,
   * so evicting the first key drops the oldest hint deterministically. The cap
   * turns drain-mode cost + memory into a constant (never attacker-scalable),
   * while the routing table (anti-eclipse-bounded, seeds every lookup) still
   * carries correctness. A re-observed nodeId refreshes to newest by delete+set. */
  function rememberHint(id: NodeId, info: { root: B64u; key: B64u }): void {
    if (known.has(id)) known.delete(id)
    known.set(id, info)
    while (known.size > knownCap) {
      const oldest = known.keys().next().value as NodeId | undefined
      if (oldest === undefined) break
      known.delete(oldest)
    }
  }

  // --- admission ----------------------------------------------------------

  async function pingContact(id: NodeId): Promise<boolean> {
    const r = await overlayRequest(fabric, id, 'overlay-ping', { v: 1 }, zPingRes)
    return r.ok && r.res.nodeId === id
  }

  /** Direct-exchange admission, OUTBOUND path (they answered our RPC or came
   * from a verified presence seed): full anti-eclipse flow. A full bucket
   * pings its least-recently-seen contact; only a dead one is replaced. */
  async function admitOutbound(info: { nodeId: NodeId; root: B64u; key: B64u }): Promise<void> {
    if (info.nodeId === nodeId) return
    const c: Contact = { nodeId: info.nodeId, root: info.root, key: info.key, lastSeenMs: nowInt() }
    const out = insertContact(table, c, kBucket)
    if (out.kind !== 'full') return
    const candidate = out.evictionCandidate
    if (await pingContact(candidate.nodeId)) {
      // Live long-standing contact stays; the newcomer is dropped.
      touchContact(table, candidate.nodeId, nowInt())
    } else {
      replaceContact(table, candidate.nodeId, c, kBucket)
    }
  }

  /** Direct-exchange admission, INBOUND path (they sent us a valid RPC):
   * admitted only into a non-full bucket. No ping is issued from inside a
   * handler (pinging here would let admission chains recurse fabric-wide)
   * so on a full bucket the newcomer is simply dropped (still anti-eclipse:
   * the long-standing contact is never displaced). */
  function admitInbound(from: NodeId): void {
    if (from === nodeId) return
    if (touchContact(table, from, nowInt())) return
    // Prefer the verified directory record over a hint-book entry.
    const dir = fabric.directory().nodes.get(from)
    const info = dir ? { root: dir.body.root, key: dir.body.key } : known.get(from)
    if (!info) return
    // Identity binding is MANDATORY: nodeId = sha256(rootPub) (§4). A hint
    // carrying a forged root paired with a reachable nodeId must never enter
    // the table: the pointer/duty layer ranks by nodeIdOf(holder root), so an
    // unbound (nodeId, root) pair is an index-poisoning primitive. `known` is
    // already binding-filtered at ingest, but this is the belt to that
    // suspenders (directory records are self-consistent by construction).
    if (nodeIdOf(info.root) !== from) return
    insertContact(table, { nodeId: from, root: info.root, key: info.key, lastSeenMs: nowInt() }, kBucket)
  }

  // --- local store --------------------------------------------------------

  /** The ONE store gate: shape sanity → validator → merge. Shared by the wire
   * handler, localPut, and put()'s store-to-self. */
  function acceptStore(from: NodeId, target: B64u, kind: ValueKind, value: CanonicalObject): boolean {
    if (!zB64u32.safeParse(target).success) return false
    if (!validator(from, target, kind, value)) return false
    const k = storeKey(kind, target)
    store.set(k, merge(store.get(k) ?? null, value, kind, target))
    return true
  }

  function localGet(target: B64u, kind: ValueKind): CanonicalObject | null {
    return store.get(storeKey(kind, target)) ?? null
  }

  // --- handlers -----------------------------------------------------------

  onOverlay(fabric, 'overlay-ping', zPingReq, async (from) => {
    admitInbound(from)
    return { v: 1, nodeId }
  }, alive)

  onOverlay(fabric, 'overlay-find-node', zFindNodeReq, async (from, req) => {
    admitInbound(from)
    const contacts = closestContacts(table, req.target, kBucket).filter((c) => c.nodeId !== from)
    return { v: 1, contacts } as unknown as CanonicalObject
  }, alive)

  onOverlay(fabric, 'overlay-find-value', zFindValueReq, async (from, req) => {
    admitInbound(from)
    const hit = store.get(storeKey(req.kind, req.target))
    if (hit !== undefined) return { v: 1, value: hit } as unknown as CanonicalObject
    const contacts = closestContacts(table, req.target, kBucket).filter((c) => c.nodeId !== from)
    return { v: 1, contacts } as unknown as CanonicalObject
  }, alive)

  onOverlay(fabric, 'overlay-store', zStoreReq, async (from, req) => {
    admitInbound(from)
    const stored = acceptStore(from, req.target, req.kind, req.value as CanonicalObject)
    return stored ? { v: 1, stored: true } : { v: 1, stored: false, reason: 'refused' }
  }, alive)

  // --- iterative walks ----------------------------------------------------

  function sortSlots(slots: Slot[], target: B64u): Slot[] {
    return slots.sort((a, b) => {
      const da = xorDistance(target, a.nodeId)
      const db = xorDistance(target, b.nodeId)
      return da < db ? -1 : da > db ? 1 : compareNodeIdBytes(a.nodeId, b.nodeId)
    })
  }

  function seedSlots(target: B64u): Map<NodeId, Slot> {
    const slots = new Map<NodeId, Slot>()
    // Self participates as a live, already-"queried" slot: we never RPC
    // ourselves; our own table IS the seed. Keeps "the k closest live nodes"
    // exact when this node is among them (put/duty correctness).
    slots.set(nodeId, { nodeId, root: contact.root, key: contact.key, state: 'ok' })
    for (const c of closestContacts(table, target, kBucket))
      if (!slots.has(c.nodeId)) slots.set(c.nodeId, { nodeId: c.nodeId, root: c.root, key: c.key, state: 'new' })
    return slots
  }

  function ingestHints(slots: Map<NodeId, Slot>, contacts: readonly Contact[], target: B64u, bestBefore: bigint | null): boolean {
    let addedCloser = false
    for (const c of contacts) {
      if (c.nodeId === nodeId) continue
      // Drop any hint whose claimed root doesn't hash to its nodeId (§4:
      // nodeId = sha256(rootPub)). A direct exchange with the endpoint only
      // re-confirms the transport nodeId; the root/key ride entirely from the
      // (possibly malicious) responder that supplied this hint, so the binding
      // must be checked HERE. The single gate feeding both the hint book and
      // the shortlist that lookup() returns and admitOutbound tables.
      if (nodeIdOf(c.root) !== c.nodeId) continue
      // Unconditional: re-observing a hint refreshes it to the FIFO tail
      // (rememberHint), so honest contacts we keep hearing from survive a
      // drain-mode flood of fresh nodeIds instead of aging out at their
      // original insertion slot.
      rememberHint(c.nodeId, { root: c.root, key: c.key })
      if (!slots.has(c.nodeId)) {
        slots.set(c.nodeId, { nodeId: c.nodeId, root: c.root, key: c.key, state: 'new' })
        if (bestBefore === null || xorDistance(target, c.nodeId) < bestBefore) addedCloser = true
      }
    }
    return addedCloser
  }

  /**
   * The shared iterative engine. Each round probes the closest unqueried
   * slots (alpha of them while rounds keep adding closer contacts; ALL
   * unqueried within the k closest once progress stalls) sequentially in
   * deterministic order; failed probes evict the contact from table, hint
   * book, and shortlist. A failure-free walk terminates when the k closest
   * surviving slots are all queried (the O(log N) window rule).
   *
   * The FIRST failed probe flips the walk into DRAIN mode: churn (or a
   * fabricated hint) has proven our view of the target neighborhood stale,
   * and under churn the k closest SURVIVORS can sit at overall ranks the
   * window rule never reaches (responders' k-capped replies stay crowded
   * with dead contacts they haven't observed failing). Drain widens the
   * shortlist to every contact we know (table + hint book) and terminates
   * only when NO unqueried slot remains anywhere. Exactness at the price
   * of probing the reachable population once. Bounded by the contacts we
   * have ever heard of; the common no-failure path never enters it.
   *
   * `probe` returns 'hit' to short-circuit (find-value), 'ok' on a live
   * answer, 'fail' on an unreachable/broken contact.
   */
  async function walk(
    target: B64u,
    probe: (s: Slot, slots: Map<NodeId, Slot>, bestBefore: bigint | null) => Promise<{ state: 'ok' | 'fail'; addedCloser: boolean; hit?: CanonicalObject }>,
  ): Promise<{ closest: Slot[]; hit: CanonicalObject | null; stats: LookupStats }> {
    const stats: LookupStats = { rpcs: 0, rounds: 0 }
    const slots = seedSlots(target)
    let lastProgress = true
    let draining = false

    function enterDrain(): void {
      if (draining) return
      draining = true
      for (const c of allContacts(table))
        if (!slots.has(c.nodeId)) slots.set(c.nodeId, { nodeId: c.nodeId, root: c.root, key: c.key, state: 'new' })
      for (const [id, info] of known)
        if (id !== nodeId && !slots.has(id)) slots.set(id, { nodeId: id, root: info.root, key: info.key, state: 'new' })
    }

    for (;;) {
      const active = sortSlots([...slots.values()].filter((s) => s.state !== 'fail'), target)
      const kClosest = active.slice(0, kBucket)
      const pending = (draining ? active : kClosest).filter((s) => s.state === 'new')
      if (pending.length === 0) {
        lastLookupStats = stats
        return { closest: kClosest, hit: null, stats }
      }
      const batch = draining
        ? pending.slice(0, alpha)
        : lastProgress
          ? active.filter((s) => s.state === 'new').slice(0, alpha)
          : pending
      stats.rounds++
      const bestBefore = active.length ? xorDistance(target, active[0].nodeId) : null
      let progressed = false
      for (const s of batch) {
        stats.rpcs++
        const r = await probe(s, slots, bestBefore)
        s.state = r.state
        if (r.state === 'fail') {
          removeContact(table, s.nodeId)
          known.delete(s.nodeId)
          enterDrain()
          continue
        }
        if (r.hit !== undefined) {
          lastLookupStats = stats
          return { closest: kClosest, hit: r.hit, stats }
        }
        if (r.addedCloser) progressed = true
      }
      lastProgress = progressed
    }
  }

  async function findNodeProbe(s: Slot, slots: Map<NodeId, Slot>, bestBefore: bigint | null, target: B64u) {
    const r = await overlayRequest(fabric, s.nodeId, 'overlay-find-node', { v: 1, target }, zFindNodeRes)
    if (!r.ok) return { state: 'fail' as const, addedCloser: false }
    await admitOutbound(s) // answered our RPC → direct exchange
    return { state: 'ok' as const, addedCloser: ingestHints(slots, r.res.contacts as Contact[], target, bestBefore) }
  }

  async function lookup(target: B64u): Promise<Contact[]> {
    const { closest } = await walk(target, (s, slots, best) => findNodeProbe(s, slots, best, target))
    return closest
      .filter((s) => s.state === 'ok')
      .map((s) => ({ nodeId: s.nodeId, root: s.root, key: s.key, lastSeenMs: nowInt() }))
  }

  async function get(target: B64u, kind: ValueKind): Promise<CanonicalObject | null> {
    const local = localGet(target, kind)
    if (local !== null) return local
    const { hit } = await walk(target, async (s, slots, best) => {
      const r = await overlayRequest(fabric, s.nodeId, 'overlay-find-value', { v: 1, target, kind }, zFindValueRes)
      if (!r.ok) return { state: 'fail' as const, addedCloser: false }
      await admitOutbound(s)
      if (r.res.value !== undefined) return { state: 'ok' as const, addedCloser: false, hit: r.res.value as CanonicalObject }
      const contacts = (r.res.contacts ?? []) as Contact[]
      return { state: 'ok' as const, addedCloser: ingestHints(slots, contacts, target, best) }
    })
    return hit
  }

  async function getMerged(target: B64u, kind: ValueKind): Promise<CanonicalObject | null> {
    const holders = await lookup(target)
    let acc: CanonicalObject | null = null
    for (const h of holders) {
      let value: CanonicalObject | null = null
      if (h.nodeId === nodeId) {
        value = localGet(target, kind)
      } else {
        const r = await overlayRequest(fabric, h.nodeId, 'overlay-find-value', { v: 1, target, kind }, zFindValueRes)
        if (r.ok && r.res.value !== undefined) value = r.res.value as CanonicalObject
      }
      if (value !== null) acc = acc === null ? merge(null, value, kind, target) : merge(acc, value, kind, target)
    }
    return acc
  }

  async function put(target: B64u, kind: ValueKind, value: CanonicalObject): Promise<number> {
    const closest = await lookup(target)
    let stored = 0
    for (const c of closest.slice(0, replicateK)) {
      if (c.nodeId === nodeId) {
        // Self among the replicateK closest → same gate, no self-RPC.
        if (acceptStore(nodeId, target, kind, value)) stored++
        continue
      }
      const r = await overlayRequest(fabric, c.nodeId, 'overlay-store', { v: 1, target, kind, value }, zStoreRes)
      if (r.ok && r.res.stored) stored++
      else if (!r.ok) {
        removeContact(table, c.nodeId)
        known.delete(c.nodeId)
      }
      // stored:false is honest degradation. The contact stays tabled.
    }
    return stored
  }

  // --- bootstrap / close ----------------------------------------------------

  async function bootstrap(seeds?: SignedPresence[]): Promise<void> {
    const pool = seeds && seeds.length ? seeds : [...fabric.directory().nodes.values()]
    const list: { nodeId: NodeId; root: B64u; key: B64u }[] = []
    for (const sp of pool) {
      if (!verifyPresence(sp)) continue // only signature-valid presences seed the table
      const id = nodeIdOf(sp.body.root)
      if (id === nodeId) continue
      list.push({ nodeId: id, root: sp.body.root, key: sp.body.key })
    }
    // Deterministic ingest order regardless of directory iteration order.
    list.sort((a, b) => compareNodeIdBytes(a.nodeId, b.nodeId))
    for (const c of list) {
      rememberHint(c.nodeId, { root: c.root, key: c.key }) // refresh-to-newest
      // A verified presence is a direct-ish attestation → normal insert path.
      await admitOutbound(c)
    }
    // Self-lookup populates the near buckets (per Kademlia).
    await lookup(nodeId)
  }

  async function close(): Promise<void> {
    // FabricEndpoint has no handler deregistration; the alive() gate makes
    // every handler throw, so peers observe this node as unreachable and
    // evict it. fabric.close() itself is the embedder's call.
    closed = true
    store.clear()
    known.clear()
  }

  return {
    nodeId,
    table,
    bootstrap,
    lookup,
    get,
    getMerged,
    put,
    localGet,
    localPut: (target, kind, value) => acceptStore(nodeId, target, kind, value),
    close,
    get lastLookupStats() {
      return lastLookupStats
    },
    get knownSize() {
      return known.size
    },
  }
}
