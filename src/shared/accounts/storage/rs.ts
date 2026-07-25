// A3 storage: Reed-Solomon erasure codec over GF(2^8) (spec §5 layer 3;
// framing contract: ./types.ts Shard). Systematic coding matrix [I_k; C]
// where C[r][j] = inverse((k + r) XOR j). A Cauchy block with x = {k..n-1}
// and y = {0..k-1}. The index sets are disjoint, so every k-row subset of the
// stacked matrix is invertible: true MDS, ANY k of n shards reconstruct. This
// deliberately sidesteps the Vandermonde-systematic construction, whose k-row
// submatrices can be singular.
//
// Field recipe (FIXED, preserved prework finding): GF(2^8) with irreducible
// polynomial 0x11d and primitive element 0x02. 0x03 is FORBIDDEN here. It
// has multiplicative order 51 mod 0x11d (3 = 2^25, so ord = 255/gcd(255,25) =
// 51) and does NOT generate the field. (The preserved prework note said 85;
// the true order is 51. Either way ord != 255, so 0x03 is disqualified; the
// suite locks generatorOrder(0x03) === 51.) The exp/log tables are built from
// 0x02 at module init.
//
// Integrity is end-to-end: every shard's framing carries dataHash =
// sha256(original blob) and reconstruct() re-hashes its output against it.
// A corrupted or substituted shard set can never yield an accepted blob.
//
// Platform-neutral + pure: no `node:` imports, no DOM globals, no clocks, no
// randomness: same inputs → same shard bytes on node and in the browser.

import { fromB64u, sha256, toB64u } from '../hash'
import type { Shard } from './types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RsErrorCode =
  | 'bad-field-element' // gfMul/gfInv/generatorOrder input outside GF(2^8), or inverse/order of 0
  | 'bad-geometry' // k/n not integers, k < 1, n < k, or n > 255
  | 'bad-shard' // a single shard's framing is malformed (version, idx range, body length/encoding)
  | 'mixed-framing' // shards disagree on k/n/dataLen/dataHash: not one job's set
  | 'duplicate-shard' // two shards claim one idx with DIFFERENT bytes
  | 'insufficient-shards' // fewer than k distinct rows
  | 'singular-matrix' // k×k submatrix not invertible (unreachable with the Cauchy block; kept as a hard stop)
  | 'hash-mismatch' // reconstructed bytes do not hash to dataHash

export class RsError extends Error {
  constructor(readonly code: RsErrorCode, message: string) {
    super(`rs: ${message}`)
    this.name = 'RsError'
  }
}

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic: poly 0x11d, generator 0x02
// ---------------------------------------------------------------------------

export const GF_POLY = 0x11d
export const GF_GENERATOR = 0x02

// exp/log tables built from GF_GENERATOR at module init. EXP is doubled
// (510 entries) so gfMul never needs a mod-255 reduction: LOG[a] + LOG[b]
// is at most 508.
const EXP = new Uint8Array(510)
const LOG = new Uint8Array(256) // LOG[0] is unused (0 has no logarithm)
{
  let v = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = v
    EXP[i + 255] = v
    LOG[v] = i
    v <<= 1
    if (v & 0x100) v ^= GF_POLY
  }
}

function checkElem(x: number, what: string): void {
  if (!Number.isInteger(x) || x < 0 || x > 255)
    throw new RsError('bad-field-element', `${what} must be an integer in [0, 255] (got ${x})`)
}

/** Table-free carry-less (Russian peasant) multiply mod GF_POLY. Used by
 * generatorOrder so the generator claim is provable INDEPENDENTLY of the
 * tables built from that very generator. */
function gfMulSlow(a: number, b: number): number {
  let acc = 0
  let x = a
  let y = b
  while (y) {
    if (y & 1) acc ^= x
    x <<= 1
    if (x & 0x100) x ^= GF_POLY
    y >>= 1
  }
  return acc
}

/** GF(2^8) product via the exp/log tables. */
export function gfMul(a: number, b: number): number {
  checkElem(a, 'a')
  checkElem(b, 'b')
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

/** GF(2^8) multiplicative inverse. Throws on 0. */
export function gfInv(a: number): number {
  checkElem(a, 'a')
  if (a === 0) throw new RsError('bad-field-element', '0 has no multiplicative inverse')
  return EXP[255 - LOG[a]]
}

/**
 * Multiplicative order of `g` in GF(2^8)/0x11d, computed with the table-free
 * multiply. The suite uses this to lock the field recipe: order(0x02) = 255
 * (generates the field), order(0x03) = 51 (does not; hence forbidden).
 */
export function generatorOrder(g: number): number {
  checkElem(g, 'g')
  if (g === 0) throw new RsError('bad-field-element', '0 has no multiplicative order')
  let v = g
  let order = 1
  while (v !== 1) {
    v = gfMulSlow(v, g)
    order++
    if (order > 255)
      throw new RsError('bad-field-element', `no multiplicative order found for ${g}`)
  }
  return order
}

// ---------------------------------------------------------------------------
// Coding matrix
// ---------------------------------------------------------------------------

function checkGeometry(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n))
    throw new RsError('bad-geometry', `k and n must be integers (got k=${k}, n=${n})`)
  if (k < 1) throw new RsError('bad-geometry', `k must be >= 1 (got ${k})`)
  if (n < k) throw new RsError('bad-geometry', `n must be >= k (got k=${k}, n=${n})`)
  if (n > 255)
    throw new RsError(
      'bad-geometry',
      `n must be <= 255 (got ${n}): row indices and Cauchy x-coordinates must fit GF(2^8)`,
    )
}

/**
 * The full n×k stacked coding matrix [I_k; C]: rows 0..k-1 are the identity
 * (systematic data rows), rows k..n-1 the Cauchy parity block
 * C[r][j] = 1/((k + r) XOR j). x = {k..n-1} and y = {0..k-1} are disjoint, so
 * (k + r) XOR j is never 0 and every k-row subset is invertible.
 */
export function codingMatrix(k: number, n: number): number[][] {
  checkGeometry(k, n)
  const rows: number[][] = []
  for (let i = 0; i < k; i++) {
    const row = new Array<number>(k).fill(0)
    row[i] = 1
    rows.push(row)
  }
  for (let r = k; r < n; r++) rows.push(cauchyRow(k, r))
  return rows
}

/** Row `idx` (k ≤ idx < n) of the Cauchy parity block. */
function cauchyRow(k: number, idx: number): number[] {
  const row = new Array<number>(k)
  for (let j = 0; j < k; j++) row[j] = gfInv(idx ^ j)
  return row
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function shardLenOf(dataLen: number, k: number): number {
  return Math.max(1, Math.ceil(dataLen / k))
}

/** dst ^= coef * src, bytewise over GF(2^8) (the hot loop; tables inlined). */
function addScaledRow(dst: Uint8Array, coef: number, src: Uint8Array): void {
  if (coef === 0) return
  const clog = LOG[coef]
  for (let t = 0; t < src.length; t++) {
    const b = src[t]
    if (b !== 0) dst[t] ^= EXP[clog + LOG[b]]
  }
}

/**
 * Erasure-code `data` into n framed shards, any k of which reconstruct it.
 * Data is zero-padded to k * shardLen (shardLen = ceil(dataLen / k), min 1);
 * rows 0..k-1 are the systematic data rows, rows k..n-1 the Cauchy parity.
 * Pure and deterministic: same (data, k, n) → same shard bytes everywhere.
 */
export function encode(data: Uint8Array, k: number, n: number): Shard[] {
  checkGeometry(k, n)
  const dataLen = data.length
  const shardLen = shardLenOf(dataLen, k)
  const padded = new Uint8Array(k * shardLen)
  padded.set(data)
  const dataHash = toB64u(sha256(data))
  const frame = (idx: number, body: Uint8Array): Shard => ({
    v: 1,
    idx,
    k,
    n,
    dataLen,
    dataHash,
    body: toB64u(body),
  })
  const shards: Shard[] = []
  for (let i = 0; i < k; i++)
    shards.push(frame(i, padded.subarray(i * shardLen, (i + 1) * shardLen)))
  for (let r = k; r < n; r++) {
    const row = cauchyRow(k, r)
    const out = new Uint8Array(shardLen)
    for (let j = 0; j < k; j++)
      addScaledRow(out, row[j], padded.subarray(j * shardLen, (j + 1) * shardLen))
    shards.push(frame(r, out))
  }
  return shards
}

// ---------------------------------------------------------------------------
// Reconstruct
// ---------------------------------------------------------------------------

interface CheckedShard {
  idx: number
  k: number
  n: number
  dataLen: number
  dataHash: string
  bodyB64: string
  body: Uint8Array
}

/** Validate ONE shard's framing (runtime checks; shards arrive untrusted). */
function checkFrame(s: Shard): CheckedShard {
  const u = s as { readonly [key: string]: unknown }
  if (typeof u !== 'object' || u === null)
    throw new RsError('bad-shard', 'shard is not an object')
  if (u.v !== 1) throw new RsError('bad-shard', `unknown shard version ${String(u.v)}`)
  const k = u.k
  const n = u.n
  if (typeof k !== 'number' || typeof n !== 'number')
    throw new RsError('bad-shard', 'k and n must be numbers')
  checkGeometry(k, n)
  const idx = u.idx
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= n)
    throw new RsError('bad-shard', `idx ${String(idx)} out of range [0, ${n})`)
  const dataLen = u.dataLen
  if (typeof dataLen !== 'number' || !Number.isInteger(dataLen) || dataLen < 0)
    throw new RsError('bad-shard', `dataLen must be a non-negative integer (got ${String(dataLen)})`)
  if (typeof u.dataHash !== 'string' || typeof u.body !== 'string')
    throw new RsError('bad-shard', 'dataHash and body must be b64u strings')
  let body: Uint8Array
  try {
    body = fromB64u(u.body)
  } catch {
    throw new RsError('bad-shard', `shard ${idx} body is not valid base64url`)
  }
  const wantLen = shardLenOf(dataLen, k)
  if (body.length !== wantLen)
    throw new RsError(
      'bad-shard',
      `shard ${idx} body is ${body.length} bytes, framing implies ${wantLen}`,
    )
  return { idx, k, n, dataLen, dataHash: u.dataHash, bodyB64: u.body, body }
}

/** Invert a k×k matrix over GF(2^8) by Gauss-Jordan elimination. */
function invertMatrix(m: number[][], k: number): number[][] {
  // augmented [m | I]
  const a = m.map((row, i) => {
    const aug = row.slice()
    for (let j = 0; j < k; j++) aug.push(i === j ? 1 : 0)
    return aug
  })
  for (let col = 0; col < k; col++) {
    let pivot = -1
    for (let r = col; r < k; r++)
      if (a[r][col] !== 0) {
        pivot = r
        break
      }
    if (pivot < 0)
      throw new RsError('singular-matrix', `no pivot in column ${col}: shard rows not independent`)
    if (pivot !== col) {
      const tmp = a[col]
      a[col] = a[pivot]
      a[pivot] = tmp
    }
    const inv = gfInv(a[col][col])
    for (let j = 0; j < 2 * k; j++) a[col][j] = gfMul(a[col][j], inv)
    for (let r = 0; r < k; r++) {
      if (r === col || a[r][col] === 0) continue
      const f = a[r][col]
      for (let j = 0; j < 2 * k; j++) a[r][j] ^= gfMul(f, a[col][j])
    }
  }
  return a.map((row) => row.slice(k))
}

/**
 * Rebuild the original blob from ≥ k shards of one job. Framing must be
 * consistent across the set (same k/n/dataLen/dataHash); duplicate idx with
 * identical bytes collapses to one, with different bytes is rejected. Row
 * selection is deterministic (k lowest indices). The output MUST hash to the
 * framing's dataHash or the whole reconstruction is rejected. Corrupt shards
 * can waste work but never produce an accepted wrong blob.
 */
export function reconstruct(shards: Shard[]): Uint8Array {
  if (!Array.isArray(shards) || shards.length === 0)
    throw new RsError('insufficient-shards', 'no shards given')
  const first = checkFrame(shards[0])
  const { k, n, dataLen, dataHash } = first
  const byIdx = new Map<number, CheckedShard>()
  for (const s of shards) {
    const c = checkFrame(s)
    if (c.k !== k || c.n !== n || c.dataLen !== dataLen || c.dataHash !== dataHash)
      throw new RsError('mixed-framing', `shard ${c.idx} disagrees on k/n/dataLen/dataHash`)
    const prior = byIdx.get(c.idx)
    if (prior) {
      if (prior.bodyB64 !== c.bodyB64)
        throw new RsError('duplicate-shard', `two shards claim idx ${c.idx} with different bytes`)
      continue // identical duplicate: keep one
    }
    byIdx.set(c.idx, c)
  }
  if (byIdx.size < k)
    throw new RsError('insufficient-shards', `need ${k} distinct shards, have ${byIdx.size}`)
  const rows = [...byIdx.values()].sort((a, b) => a.idx - b.idx).slice(0, k)
  // The k×k submatrix of [I_k; C] picked out by the surviving row indices.
  const sub = rows.map((r) => {
    if (r.idx < k) {
      const unit = new Array<number>(k).fill(0)
      unit[r.idx] = 1
      return unit
    }
    return cauchyRow(k, r.idx)
  })
  const inv = invertMatrix(sub, k)
  const shardLen = shardLenOf(dataLen, k)
  const out = new Uint8Array(k * shardLen)
  for (let i = 0; i < k; i++) {
    const dst = out.subarray(i * shardLen, (i + 1) * shardLen)
    for (let j = 0; j < k; j++) addScaledRow(dst, inv[i][j], rows[j].body)
  }
  const data = out.slice(0, dataLen)
  if (toB64u(sha256(data)) !== dataHash)
    throw new RsError(
      'hash-mismatch',
      'reconstructed bytes do not hash to dataHash: shard set corrupted or substituted',
    )
  return data
}
