// A3 overlay: k-bucket routing table (overlay/types.ts contract, spec §5).
// 256 buckets indexed by the shared-prefix length of a contact's nodeId vs
// SELF (bucket p holds contacts sharing exactly p leading bits); each bucket
// holds at most kBucket contacts ordered least-recently-seen first.
//
// Anti-eclipse admission is MANDATORY and lives HERE: a full bucket never
// evicts a live long-standing contact for a newcomer: insertContact returns
// the least-recently-seen contact as an eviction CANDIDATE and does NOT admit
// the newcomer; the node pings the candidate and calls touchContact (keep old,
// drop new) on success or replaceContact on failure.
//
// All distance math reuses witness/distance.ts (never reimplemented); every
// ordering is XOR distance with the compareNodeIdBytes tie-break, so the same
// call sequence produces the same table on node and in the browser bundle.
// Platform-neutral: no `node:` imports, no DOM globals, no ambient clock:
// every lastSeenMs is the caller's injected time.

import { closestEligible, xorDistance } from '../witness/distance'
import type { NodeId } from '../witness/types'
import type { Contact, KBucket, RoutingTable } from './types'

/** 32-byte nodeIds → 256 possible shared-prefix lengths (self excluded). */
export const BUCKET_COUNT = 256

/** A fresh routing table for `self`: 256 empty buckets. */
export function newRoutingTable(self: NodeId): RoutingTable {
  const buckets: KBucket[] = []
  for (let i = 0; i < BUCKET_COUNT; i++) buckets.push({ contacts: [] })
  return { self, buckets }
}

/**
 * Bucket index of `other` relative to `self` = shared-prefix length of the two
 * nodeIds (the XOR distance's leading-zero count). Returns -1 for self
 * (distance 0; never bucketed).
 */
export function bucketIndexOf(self: NodeId, other: NodeId): number {
  const d = xorDistance(self, other)
  if (d === 0n) return -1
  const idx = BUCKET_COUNT - d.toString(2).length
  return idx < 0 ? 0 : idx > BUCKET_COUNT - 1 ? BUCKET_COUNT - 1 : idx
}

/** Outcome of an admission attempt. On 'full' the newcomer was NOT admitted.
 * The caller pings the candidate and then keeps old (touchContact) or replaces
 * (replaceContact). */
export type InsertOutcome =
  | { kind: 'inserted' }
  | { kind: 'updated' }
  | { kind: 'self' }
  | { kind: 'full'; evictionCandidate: Contact }

/**
 * Admit `contact` into its bucket:
 *  - already present → refresh root/key/lastSeenMs, move to tail ('updated');
 *  - room in the bucket → append at tail ('inserted');
 *  - bucket full → return the head (least-recently-seen) as the eviction
 *    candidate WITHOUT admitting the newcomer ('full').
 */
export function insertContact(table: RoutingTable, contact: Contact, kBucket: number): InsertOutcome {
  const idx = bucketIndexOf(table.self, contact.nodeId)
  if (idx < 0) return { kind: 'self' }
  const bucket = table.buckets[idx]
  const at = bucket.contacts.findIndex((c) => c.nodeId === contact.nodeId)
  if (at >= 0) {
    bucket.contacts.splice(at, 1)
    bucket.contacts.push(contact)
    return { kind: 'updated' }
  }
  if (bucket.contacts.length < kBucket) {
    bucket.contacts.push(contact)
    return { kind: 'inserted' }
  }
  return { kind: 'full', evictionCandidate: bucket.contacts[0] }
}

/** Refresh a tabled contact (ping answered / any direct exchange): bump
 * lastSeenMs and move it to the tail of its bucket. False when not tabled. */
export function touchContact(table: RoutingTable, nodeId: NodeId, nowMs: number): boolean {
  const idx = bucketIndexOf(table.self, nodeId)
  if (idx < 0) return false
  const bucket = table.buckets[idx]
  const at = bucket.contacts.findIndex((c) => c.nodeId === nodeId)
  if (at < 0) return false
  const [c] = bucket.contacts.splice(at, 1)
  // Floor defensively: lastSeenMs must stay integer for zContact/codec even if
  // a caller passes a fractional clock directly (node.ts already floors).
  bucket.contacts.push({ ...c, lastSeenMs: Math.floor(nowMs) })
  return true
}

/** Drop a contact (failed request / failed eviction ping). False when absent. */
export function removeContact(table: RoutingTable, nodeId: NodeId): boolean {
  const idx = bucketIndexOf(table.self, nodeId)
  if (idx < 0) return false
  const bucket = table.buckets[idx]
  const at = bucket.contacts.findIndex((c) => c.nodeId === nodeId)
  if (at < 0) return false
  bucket.contacts.splice(at, 1)
  return true
}

/** The eviction-ping FAILED: drop `oldId` and admit `newcomer` at the tail of
 * its bucket. Returns whether the newcomer was admitted. */
export function replaceContact(table: RoutingTable, oldId: NodeId, newcomer: Contact, kBucket: number): boolean {
  removeContact(table, oldId)
  const out = insertContact(table, newcomer, kBucket)
  return out.kind === 'inserted' || out.kind === 'updated'
}

/** Every tabled contact, bucket order (diagnostics + closest scans). */
export function allContacts(table: RoutingTable): Contact[] {
  const out: Contact[] = []
  for (const bucket of table.buckets) for (const c of bucket.contacts) out.push(c)
  return out
}

/** Total tabled contacts. */
export function tableSize(table: RoutingTable): number {
  let n = 0
  for (const bucket of table.buckets) n += bucket.contacts.length
  return n
}

/**
 * The k closest tabled contacts to `target`. Ordering delegated to
 * witness/distance.ts closestEligible (XOR distance, compareNodeIdBytes
 * tie-break), the ONE ordering every layer shares.
 */
export function closestContacts(table: RoutingTable, target: NodeId, k: number): Contact[] {
  const all = allContacts(table)
  // A nodeId lives in exactly one bucket, so allContacts never repeats one.
  // The map is a plain id→contact index (no dedup guard needed).
  const byId = new Map<NodeId, Contact>()
  for (const c of all) byId.set(c.nodeId, c)
  const ids = closestEligible(target, all, () => true, k)
  const out: Contact[] = []
  for (const id of ids) {
    const c = byId.get(id)
    if (c) out.push(c)
  }
  return out
}
