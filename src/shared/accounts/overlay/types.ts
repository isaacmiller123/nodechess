// A3 overlay: shared type contract (spec §5 overlay & publish-on-write,
// ACCOUNTS-PARAMS §Storage). Types + protocol rules only; implementations live
// in sibling modules. Platform-neutral: no `node:` imports, no DOM globals.
//
// The overlay is a Kademlia-style key-distance routing layer built OVER the A2
// FabricEndpoint abstraction (witness/types.ts). The fabric (trystero/Nostr or
// MockFabric) provides transport + bootstrap ONLY, never routing (C-11). All
// distance math reuses witness/distance.ts (XOR over decoded 32-byte nodeIds).
//
// Determinism: no Date.now / Math.random anywhere in the overlay. Clocks are
// injected (nowMs) and every candidate ordering is by XOR distance with the
// compareNodeIdBytes tie-break, so the same topology + same inputs walk the
// same route on node and in the browser bundle.

import type { CanonicalObject } from '../codec'
import type { B64u } from '../types'
import type { NodeId, SignedPresence } from '../witness/types'

// ---------------------------------------------------------------------------
// Contacts & routing table
// ---------------------------------------------------------------------------

/** A routing-table entry. `key` is the contact's advertised signing key from
 * its presence record; `root` its account root. Contacts enter the table only
 * from a verified SignedPresence or from a signed RPC we served/received. */
export interface Contact extends CanonicalObject {
  nodeId: NodeId
  root: B64u
  key: B64u
  /** Last time (injected clock, ms) we heard from this contact. */
  lastSeenMs: number
}

/**
 * One k-bucket: at most kBucket contacts sharing a distance prefix to OUR
 * nodeId. Kademlia's anti-eclipse admission rule is MANDATORY: a full bucket
 * NEVER evicts a live long-standing contact for a newcomer. The newcomer is
 * dropped unless the least-recently-seen contact fails a ping. (Long-lived
 * honest contacts are sticky; an attacker who floods fresh nodeIds cannot
 * displace them.)
 */
export interface KBucket {
  /** Ordered least-recently-seen first (head = eviction candidate). */
  contacts: Contact[]
}

export interface RoutingTable {
  self: NodeId
  /** buckets[i] holds contacts that share an i-bit prefix with self, i.e.
   * whose XOR distance has bit-length 256 − i (bucketIndexOf computes
   * idx = 256 − distance.bitLength). So buckets[255] is the nearest ring
   * (1-bit distance) and buckets[0] the farthest; bucket count = 256. */
  buckets: KBucket[]
}

// ---------------------------------------------------------------------------
// RPC payloads (ride FabricEndpoint.request as canonical objects)
// ---------------------------------------------------------------------------
// Every overlay RPC response carries the responder's k-closest view so lookups
// converge in O(log N) hops. Responders NEVER trust the requester's claimed
// identity beyond the transport's `from` nodeId; stored values are validated
// by the STORAGE layer's own verifiers (pointers/shards) before acceptance.
// The overlay moves bytes and routes, it never confers authority (§0).

export interface FindNodeReq extends CanonicalObject {
  v: 1
  /** Target key (nodeId-shaped, 32 bytes b64u). */
  target: B64u
}

export interface FindNodeRes extends CanonicalObject {
  v: 1
  /** Responder's kBucket closest known contacts to `target`. */
  contacts: Contact[]
}

/** What class of value a key holds. One key can hold several classes
 * (pointers + events for the same subject); shards live at their own keys. */
export type ValueKind = 'pointers' | 'events' | 'shard' | 'record'

export interface FindValueReq extends CanonicalObject {
  v: 1
  target: B64u
  kind: ValueKind
}

/** Either the value (hit) or the k-closest contacts (miss), never both. */
export interface FindValueRes extends CanonicalObject {
  v: 1
  /** Present on hit: opaque canonical payload, validated by the storage layer. */
  value?: CanonicalObject
  contacts?: Contact[]
}

export interface StoreReq extends CanonicalObject {
  v: 1
  target: B64u
  kind: ValueKind
  value: CanonicalObject
}

export interface StoreRes extends CanonicalObject {
  v: 1
  /** false = refused (over budget, cap hit, failed validation). Refusal is
   * honest degradation, never an error. */
  stored: boolean
  reason?: string
}

export interface PingReq extends CanonicalObject {
  v: 1
}

export interface PingRes extends CanonicalObject {
  v: 1
  nodeId: NodeId
}

// ---------------------------------------------------------------------------
// Node surface
// ---------------------------------------------------------------------------

/** Validation hook the storage layer installs on an overlay node: called
 * before any STORE is accepted locally. Return false to refuse. Pure. */
export type StoreValidator = (
  from: NodeId,
  target: B64u,
  kind: ValueKind,
  value: CanonicalObject,
) => boolean

export interface OverlayOpts {
  /** Injected clock (ms). REQUIRED. The overlay has no ambient time. */
  nowMs: () => number
  /** Storage-layer STORE gate (default: refuse everything but 'record'). */
  validator?: StoreValidator
}

/**
 * The overlay node contract. `lookup` is iterative FIND_NODE convergence
 * (returns the k closest live contacts to target); `get`/`put` are
 * FIND_VALUE/STORE against the replicateK closest nodes. Bootstrap seeds the
 * table from the fabric directory (presence records) + an iterative
 * self-lookup, per Kademlia.
 */
export interface OverlayNode {
  readonly nodeId: NodeId
  readonly table: RoutingTable
  bootstrap(seeds?: SignedPresence[]): Promise<void>
  lookup(target: B64u): Promise<Contact[]>
  get(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
  put(target: B64u, kind: ValueKind, value: CanonicalObject): Promise<number>
  /** Local store view (for repair scans + suites). */
  localGet(target: B64u, kind: ValueKind): CanonicalObject | null
  close(): Promise<void>
}
