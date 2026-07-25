// A2 fabric-core: key-distance (spec §4 canonical witness set / §5 overlay
// metric). nodeId = sha256(rootPub); all fabric distance is XOR over the raw
// 32-byte nodeId. Pure + deterministic: same inputs → same bytes on node and
// in the browser bundle. Platform-neutral: no `node:` imports, no DOM globals.

import { fromB64u, sha256, toB64u } from '../hash'
import type { B64u } from '../types'
import type { NodeId } from './types'

/** nodeId = base64url(sha256(rootPub)), 32 bytes. Accepts raw pub bytes or a
 * b64u-encoded root pubkey (the form carried in PresenceBody.root / LeaseBody.root). */
export function nodeIdOf(rootPub: Uint8Array | B64u): NodeId {
  const bytes = typeof rootPub === 'string' ? fromB64u(rootPub) : rootPub
  return toB64u(sha256(bytes))
}

/** Raw-byte lexicographic compare of two nodeIds (the §4 canonical tie-break).
 * NB: NOT the same order as codec.compareKeys, which orders the *b64u strings*;
 * distance/tie-break math is defined over the decoded 32-byte values. */
export function compareNodeIdBytes(a: NodeId, b: NodeId): number {
  const ab = fromB64u(a)
  const bb = fromB64u(b)
  const n = Math.min(ab.length, bb.length)
  for (let i = 0; i < n; i++) if (ab[i] !== bb[i]) return ab[i] < bb[i] ? -1 : 1
  return ab.length === bb.length ? 0 : ab.length < bb.length ? -1 : 1
}

/**
 * XOR distance between two nodeIds as a bigint (Kademlia metric). Because XOR
 * against a fixed subject is a bijection, distances from one subject are unique
 * per distinct nodeId, so closestEligible's byte tie-break is only ever reached
 * for duplicate nodeIds, but is applied for full determinism regardless.
 */
export function xorDistance(a: NodeId, b: NodeId): bigint {
  const ab = fromB64u(a)
  const bb = fromB64u(b)
  const n = Math.max(ab.length, bb.length)
  let acc = 0n
  for (let i = 0; i < n; i++) acc = (acc << 8n) | BigInt((ab[i] ?? 0) ^ (bb[i] ?? 0))
  return acc
}

/**
 * The canonical closest set: the `k` closest CANDIDATES for which `eligible`
 * holds, by XOR distance to `subject`, deterministic tie-break by raw nodeId
 * bytes. Returns fewer than `k` when fewer eligible candidates exist (the
 * small-population case: the M-of-N + diversity rules bound single-witness
 * power downstream). Duplicate nodeIds are collapsed (first occurrence wins).
 */
export function closestEligible<C extends { nodeId: NodeId }>(
  subject: NodeId,
  candidates: readonly C[],
  eligible: (c: C) => boolean,
  k: number,
): NodeId[] {
  const seen = new Set<NodeId>()
  const rows: { nodeId: NodeId; d: bigint }[] = []
  for (const c of candidates) {
    if (!eligible(c)) continue
    if (seen.has(c.nodeId)) continue
    seen.add(c.nodeId)
    rows.push({ nodeId: c.nodeId, d: xorDistance(subject, c.nodeId) })
  }
  rows.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : compareNodeIdBytes(x.nodeId, y.nodeId)))
  return rows.slice(0, Math.max(0, k)).map((r) => r.nodeId)
}

/**
 * The /`bits` prefix bucket of a nodeId (checkpoint diversity bound, §2c: ≥3
 * distinct /16 prefixes). Returns a lowercase-hex string of the top `bits`
 * bits (trailing bits within the last partial byte are masked to zero), so two
 * nodeIds share a bucket iff their leading `bits` bits are equal.
 */
export function prefixBucket(nodeId: NodeId, bits: number): string {
  const bytes = fromB64u(nodeId)
  const full = bits >> 3
  const rem = bits & 7
  const out: string[] = []
  for (let i = 0; i < full; i++) out.push((bytes[i] ?? 0).toString(16).padStart(2, '0'))
  if (rem) {
    const mask = (0xff << (8 - rem)) & 0xff
    out.push(((bytes[full] ?? 0) & mask).toString(16).padStart(2, '0'))
  }
  return out.join('')
}
