// A3 BRICK-1 SUITE: Reed-Solomon codec (src/shared/accounts/storage/rs.ts).
//
//   node scripts/test-accounts-rs.mjs
//
// Locks the FIXED field recipe (GF(2^8)/0x11d, generator 0x02: 0x03 does NOT
// generate the field and is forbidden), proves true-MDS at a tractable size
// (ALL C(6,3) subsets), hammers the default k=12/n=40 geometry with 100
// deterministically-seeded subsets over a REAL chain blob, drives the tamper
// matrix to typed RsError codes, pins cross-build byte goldens, and proves
// node/browser bundle parity byte-for-byte.
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on any fail.

import { rmSync } from 'node:fs'
import { bundleAndImport, makeOutdir } from './lib/witness-bundle.mjs'

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}
/** Assert fn throws an RsError with exactly the given .code. */
function throwsCode(fn, code, msg) {
  try {
    fn()
    ok(false, `${msg} (did not throw)`)
  } catch (e) {
    const hit = e && e.name === 'RsError' && e.code === code
    ok(hit, `${msg}${hit ? '' : ` (got ${e?.name}:${e?.code ?? e?.message})`}`)
  }
}

const hex = (u) => Buffer.from(u).toString('hex')

/** Deterministic 32-bit LCG (Numerical Recipes constants): NO Math.random. */
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s
  }
}
/** Deterministic k-of-n index subset via partial Fisher-Yates on the LCG. */
function pickSubset(rand, n, k) {
  const idxs = Array.from({ length: n }, (_, i) => i)
  for (let i = 0; i < k; i++) {
    const j = i + (rand() % (n - i))
    const t = idxs[i]; idxs[i] = idxs[j]; idxs[j] = t
  }
  return idxs.slice(0, k).sort((a, b) => a - b)
}

// ---- determinism goldens (recorded from a green run; cross-build anchors) ----
// encode(bytes 0..63, k=4, n=8): the b64u body of EVERY shard, plus dataHash.
const GOLD_HASH = '_eq5rPNxA2K9JljNyaKej5x1f8-YEWA6jER80dkVEQg'
const GOLD_BODIES = [
  'AAECAwQFBgcICQoLDA0ODw', // idx 0 (systematic)
  'EBESExQVFhcYGRobHB0eHw', // idx 1 (systematic)
  'ICEiIyQlJicoKSorLC0uLw', // idx 2 (systematic)
  'MDEyMzQ1Njc4OTo7PD0-Pw', // idx 3 (systematic)
  '6MioiGhIKAj11bWVdVU1FQ', // idx 4 (parity)
  '0vKSslJyEjLP74-vT28PLw', // idx 5 (parity)
  'nLzc_Bw8XHyBocHhASFBYQ', // idx 6 (parity)
  'pobmxiYGZka7m_vbOxt7Ww', // idx 7 (parity)
]

const ENTRY = `
export * as RS from '@shared/accounts/storage/rs'
export * as P from '@shared/accounts/storage/params'
export * as A from '@shared/accounts'
`
const ENTRY_RS_ONLY = `
export * as RS from '@shared/accounts/storage/rs'
`

async function main() {
  const outdirNode = makeOutdir('accounts-rs-test')
  const outdirBrowser = makeOutdir('accounts-rs-test')
  try {
    console.log('· bundling rs.ts (node + browser) …')
    const M = await bundleAndImport(outdirNode, ENTRY, 'node')
    const B = await bundleAndImport(outdirBrowser, ENTRY_RS_ONLY, 'browser')
    await run(M, B.RS)
  } finally {
    rmSync(outdirNode, { recursive: true, force: true })
    rmSync(outdirBrowser, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M, RSB) {
  const { RS, P, A } = M

  // ============================================================================
  // 1. field sanity. The FIXED recipe is locked
  // ============================================================================
  console.log('\n· GF(2^8)/0x11d field sanity …')
  eq(RS.GF_POLY, 0x11d, 'GF_POLY is 0x11d')
  eq(RS.GF_GENERATOR, 0x02, 'GF_GENERATOR is 0x02')
  eq(RS.generatorOrder(0x02), 255, '0x02 has order 255, generates the whole field')
  // Preserved prework finding, value corrected: 0x03 is NOT a generator of
  // GF(2^8)/0x11d. Its true order is 51 (3 = 2^25, 255/gcd(255,25) = 51), not
  // the 85 the prework note recorded, either way ord(3) != 255, so 0x03 stays
  // FORBIDDEN as the table generator.
  eq(RS.generatorOrder(0x03), 51, '0x03 has order 51, does NOT generate (forbidden as generator)')
  ok(RS.generatorOrder(0x03) !== 255, 'order(0x03) != 255 (the load-bearing half of the finding)')
  eq(RS.generatorOrder(1), 1, 'order(1) = 1')
  eq(RS.gfMul(2, 128), 0x1d, '2 * 128 = x^8 ≡ 0x1d: the 0x11d reduction anchor')
  eq(RS.gfInv(1), 1, 'inv(1) = 1')
  {
    let inverses = 0
    let identity = 0
    for (let a = 1; a <= 255; a++) {
      if (RS.gfMul(a, RS.gfInv(a)) === 1) inverses++
      if (RS.gfMul(a, 1) === a) identity++
    }
    eq(inverses, 255, 'a * inv(a) = 1 for ALL a in [1, 255]')
    eq(identity, 255, 'a * 1 = a for ALL a in [1, 255]')
  }
  eq(RS.gfMul(0, 77), 0, '0 * a = 0')
  eq(RS.gfMul(77, 0), 0, 'a * 0 = 0')
  {
    let comm = true
    for (let a = 0; a <= 255 && comm; a++)
      for (let b = a + 1; b <= 255; b++)
        if (RS.gfMul(a, b) !== RS.gfMul(b, a)) { comm = false; break }
    ok(comm, 'gfMul commutative over ALL 256×256 pairs')
    const rand = lcg(1)
    let distrib = 0
    for (let i = 0; i < 512; i++) {
      const a = rand() & 0xff, b = rand() & 0xff, c = rand() & 0xff
      if (RS.gfMul(a, b ^ c) === (RS.gfMul(a, b) ^ RS.gfMul(a, c))) distrib++
    }
    eq(distrib, 512, 'a*(b^c) = a*b ^ a*c over 512 LCG-seeded triples')
  }
  throwsCode(() => RS.gfInv(0), 'bad-field-element', 'gfInv(0) → bad-field-element')
  throwsCode(() => RS.gfInv(256), 'bad-field-element', 'gfInv(256) → bad-field-element')
  throwsCode(() => RS.gfMul(1.5, 2), 'bad-field-element', 'gfMul(1.5, ·) → bad-field-element')
  throwsCode(() => RS.generatorOrder(0), 'bad-field-element', 'generatorOrder(0) → bad-field-element')

  // ============================================================================
  // 2. coding matrix: [I_k; C] Cauchy block, geometry gates
  // ============================================================================
  console.log('\n· coding matrix …')
  {
    const k = 3, n = 6
    const m = RS.codingMatrix(k, n)
    eq(m.length, n, 'matrix has n rows')
    let ident = true
    for (let i = 0; i < k; i++)
      for (let j = 0; j < k; j++)
        if (m[i][j] !== (i === j ? 1 : 0)) ident = false
    ok(ident, 'top k rows are I_k (systematic)')
    let cauchy = true
    let nonzero = true
    for (let r = 0; r < n - k; r++)
      for (let j = 0; j < k; j++) {
        if (m[k + r][j] !== RS.gfInv((k + r) ^ j)) cauchy = false
        if (m[k + r][j] === 0) nonzero = false
      }
    ok(cauchy, 'parity block is C[r][j] = inv((k+r) XOR j)')
    ok(nonzero, 'every Cauchy entry nonzero (x/y index sets disjoint)')
  }
  throwsCode(() => RS.codingMatrix(0, 5), 'bad-geometry', 'k=0 → bad-geometry')
  throwsCode(() => RS.codingMatrix(5, 3), 'bad-geometry', 'n<k → bad-geometry')
  throwsCode(() => RS.codingMatrix(12, 256), 'bad-geometry', 'n=256 → bad-geometry')
  throwsCode(() => RS.codingMatrix(2.5, 5), 'bad-geometry', 'fractional k → bad-geometry')
  throwsCode(() => RS.encode(new Uint8Array(8), 0, 5), 'bad-geometry', 'encode with k=0 → bad-geometry')

  // ============================================================================
  // 3. true MDS at tractable size, ALL C(6,3) = 20 subsets reconstruct
  // ============================================================================
  console.log('\n· MDS proof: k=3 n=6, all 20 subsets …')
  {
    const blob = Uint8Array.from({ length: 25 }, (_, i) => (i * 7 + 3) & 0xff)
    const shards = RS.encode(blob, 3, 6)
    eq(shards.length, 6, 'encode produced n=6 shards')
    ok(shards.every((s) => s.dataLen === 25 && s.k === 3 && s.n === 6), 'all shards carry the framing (k/n/dataLen)')
    eq(shards[0].dataHash, A.toB64u(A.sha256(blob)), 'dataHash = b64u(sha256(original))')
    eq(shards[0].body, A.toB64u(blob.slice(0, 9)), 'systematic row 0 body = first shardLen bytes of the blob')
    for (let a = 0; a < 6; a++)
      for (let b = a + 1; b < 6; b++)
        for (let c = b + 1; c < 6; c++) {
          const back = RS.reconstruct([shards[a], shards[b], shards[c]])
          ok(hex(back) === hex(blob), `subset {${a},${b},${c}} reconstructs bit-identically`)
        }
  }

  // ============================================================================
  // 4. default geometry k=12 n=40 (PARAMS_A3) over a REAL chain blob
  // ============================================================================
  console.log('\n· default geometry: k=12 n=40 over a real account-chain blob …')
  {
    eq(P.PARAMS_A3.kRec, 12, 'PARAMS_A3.kRec = 12')
    eq(P.PARAMS_A3.nShards, 40, 'PARAMS_A3.nShards = 40')
    const kp = (b) => {
      const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
      const pub = A.ed25519.getPublicKey(priv)
      return { priv, pub, pubB: A.toB64u(pub) }
    }
    const fakeId = (s) => A.toB64u(A.sha256(A.utf8(s)))
    const root = kp(1)
    const devA = kp(50)
    let c = A.createAccountChain({
      rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000,
      device: { pub: devA.pubB, index: 0, label: 'MacBook' },
    })
    c = A.appendPersonal(c, root.priv, root.pubB, 'profile', { fields: { bio: 'erasure-coded and everywhere', country: 'US' } }, 1200)
    c = A.appendPersonal(c, devA.priv, devA.pubB, 'profile', { fields: { flair: 'rook' } }, 1300)
    for (let i = 0; i < 6; i++) c = A.appendWitnessed(c, root.priv, root.pubB, 'revoke', { pub: fakeId(`r${i}`) }, 2000 + i)
    const blob = A.chainToBytes(c)
    ok(blob.length > 1000, `chain blob is a real payload (${blob.length} bytes)`)
    eq(A.verifyChain(A.chainFromBytes(blob)).ok, true, 'source chain verifies ok (sanity)')

    const shards = RS.encode(blob, P.PARAMS_A3.kRec, P.PARAMS_A3.nShards)
    eq(shards.length, 40, 'encode produced 40 shards')
    ok(hex(RS.reconstruct(shards.slice(0, 12))) === hex(blob), 'systematic rows 0..11 alone reconstruct')
    ok(hex(RS.reconstruct(shards.slice(28))) === hex(blob), 'parity rows 28..39 alone reconstruct (full inversion path)')

    // ≥100 deterministically-seeded DISTINCT 12-of-40 subsets, all bit-identical.
    const rand = lcg(0xa3)
    const seen = new Set()
    let matches = 0
    let guard = 0
    while (seen.size < 100 && guard++ < 10_000) {
      const sub = pickSubset(rand, 40, 12)
      const key = sub.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      const back = RS.reconstruct(sub.map((i) => shards[i]))
      if (hex(back) === hex(blob)) matches++
    }
    eq(seen.size, 100, '100 DISTINCT LCG-seeded subsets drawn (drop 28 of 40 each)')
    eq(matches, 100, 'ALL 100 subsets reconstruct bit-identically')

    // the chain survives the trip end to end
    const back = RS.reconstruct(shards.slice(14, 26))
    eq(A.verifyChain(A.chainFromBytes(back)).ok, true, 'reconstructed blob parses + verifies as the same chain')

    // integrity: flipped body byte among the chosen k → dataHash gate rejects
    const flipBody = (s) => {
      const b = A.fromB64u(s.body)
      b[0] ^= 0xff
      return { ...s, body: A.toB64u(b) }
    }
    throwsCode(() => RS.reconstruct([flipBody(shards[3]), ...shards.slice(0, 3), ...shards.slice(4, 12)]),
      'hash-mismatch', 'flipped byte in a SYSTEMATIC shard body → hash-mismatch')
    throwsCode(() => RS.reconstruct([...shards.slice(0, 11), flipBody(shards[20])]),
      'hash-mismatch', 'flipped byte in a PARITY shard body → hash-mismatch')
  }

  // ============================================================================
  // 5. tamper matrix. Typed rejects on the golden k=4 n=8 job
  // ============================================================================
  console.log('\n· tamper matrix (typed RsError codes) …')
  {
    const blob = Uint8Array.from({ length: 64 }, (_, i) => i)
    const shards = RS.encode(blob, 4, 8)
    const fresh = () => shards.map((s) => ({ ...s }))

    let t = fresh(); t[2].dataLen = 63 // ceil(63/4)=16: passes per-shard framing, dies on consistency
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'mixed-framing', 'one shard with forged dataLen → mixed-framing')
    t = fresh().map((s) => ({ ...s, dataLen: 63 })) // ALL forged consistently → only the hash gate is left
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'hash-mismatch', 'ALL shards forged dataLen=63 → hash-mismatch (end-to-end gate)')
    t = fresh(); t[1].k = 5
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'bad-shard', 'one shard with forged k → body/shardLen inconsistency → bad-shard')
    t = fresh(); t[1].n = 9
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'mixed-framing', 'one shard with forged n → mixed-framing')
    t = fresh(); t[3].dataHash = GOLD_HASH.slice(0, -1) + (GOLD_HASH.endsWith('g') ? 'h' : 'g')
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'mixed-framing', 'mixed dataHash → mixed-framing')
    const wrongHash = A.toB64u(A.sha256(A.utf8('not-the-blob')))
    t = fresh().map((s) => ({ ...s, dataHash: wrongHash }))
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'hash-mismatch', 'ALL shards carrying a wrong dataHash → hash-mismatch')
    t = fresh(); t[1] = { ...t[0], idx: 0 } // dupe idx 0, same bytes as shard 0
    ok(hex(RS.reconstruct([t[0], t[1], t[2], t[3], t[4]])) === hex(blob),
      'duplicate idx with IDENTICAL bytes collapses to one and reconstructs')
    t = fresh(); t[1] = { ...t[1], idx: 0 } // dupe idx 0, shard-1 bytes
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'duplicate-shard', 'duplicate idx with DIFFERENT bytes → duplicate-shard')
    t = fresh(); t[2].idx = 8
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'bad-shard', 'idx = n → bad-shard (out of range)')
    t = fresh(); t[2].idx = 1.5
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'bad-shard', 'fractional idx → bad-shard')
    t = fresh(); t[0].v = 2
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'bad-shard', 'unknown shard version → bad-shard')
    t = fresh(); t[0].body = '!!!'
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'bad-shard', 'body not base64url → bad-shard')
    t = fresh(); t[0].body = t[0].body.slice(0, 11)
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'bad-shard', 'truncated body (wrong shardLen) → bad-shard')
    t = fresh(); t[0].dataLen = -1
    throwsCode(() => RS.reconstruct(t.slice(0, 4)), 'bad-shard', 'negative dataLen → bad-shard')
    throwsCode(() => RS.reconstruct(shards.slice(0, 3)), 'insufficient-shards', '3 of k=4 shards → insufficient-shards')
    throwsCode(() => RS.reconstruct([]), 'insufficient-shards', 'empty shard set → insufficient-shards')
    // dupes must not masquerade as coverage: k distinct copies of ONE row
    const clones = [shards[0], { ...shards[0] }, { ...shards[0] }, { ...shards[0] }]
    throwsCode(() => RS.reconstruct(clones), 'insufficient-shards', 'k identical copies of one shard → insufficient-shards')
  }

  // ============================================================================
  // 6. determinism goldens, the cross-build byte anchor
  // ============================================================================
  console.log('\n· determinism goldens (bytes 0..63, k=4, n=8) …')
  {
    const blob = Uint8Array.from({ length: 64 }, (_, i) => i)
    const shards = RS.encode(blob, 4, 8)
    eq(shards[0].dataHash, GOLD_HASH, 'dataHash matches the recorded GOLDEN value')
    for (let i = 0; i < 8; i++)
      eq(shards[i].body, GOLD_BODIES[i], `shard ${i} body matches the recorded GOLDEN b64u`)
    // rebuild purely from the PINNED literals (parity rows only). Proves the
    // committed anchors alone still decode to the original bytes
    const pinned = [4, 5, 6, 7].map((idx) => ({
      v: 1, idx, k: 4, n: 8, dataLen: 64, dataHash: GOLD_HASH, body: GOLD_BODIES[idx],
    }))
    ok(hex(RS.reconstruct(pinned)) === hex(blob), 'pinned parity literals alone reconstruct bytes 0..63')
  }

  // ============================================================================
  // 7. browser parity. Identical bytes from the platform:'browser' bundle
  // ============================================================================
  console.log('\n· node/browser bundle parity …')
  {
    const blob = Uint8Array.from({ length: 64 }, (_, i) => i)
    const nodeShards = RS.encode(blob, 4, 8)
    const browShards = RSB.encode(blob, 4, 8)
    ok(browShards.every((s, i) => s.body === nodeShards[i].body && s.dataHash === nodeShards[i].dataHash),
      'browser bundle emits IDENTICAL shard bytes for the golden job')
    ok(browShards.every((s, i) => s.body === GOLD_BODIES[i]), 'browser shard bodies match the pinned goldens')
    ok(hex(RSB.reconstruct(browShards.slice(4))) === hex(RS.reconstruct(nodeShards.slice(4))),
      'browser reconstruct (parity-only) is byte-identical to node')
    eq(RSB.generatorOrder(0x02), 255, 'browser bundle: order(0x02) = 255')
    eq(RSB.generatorOrder(0x03), 51, 'browser bundle: order(0x03) = 51')
    // a bigger LCG blob through both bundles
    const rand = lcg(77)
    const big = Uint8Array.from({ length: 5000 }, () => rand() & 0xff)
    const nb = RS.encode(big, 12, 40)
    const bb = RSB.encode(big, 12, 40)
    ok(bb.every((s, i) => s.body === nb[i].body), 'browser/node parity holds across all 40 shards of a 5KB LCG blob')
  }

  // ============================================================================
  // 8. edges, empty blob, blob smaller than k
  // ============================================================================
  console.log('\n· edges …')
  {
    const empty = RS.encode(new Uint8Array(0), 3, 5)
    eq(empty.length, 5, 'empty blob still yields n shards (shardLen floor of 1)')
    ok(empty.every((s) => A.fromB64u(s.body).length === 1), 'empty-blob shard bodies are 1 byte (min shardLen)')
    eq(RS.reconstruct(empty.slice(2)).length, 0, 'empty blob reconstructs to 0 bytes (hash of empty verified)')
    const tiny = Uint8Array.from([9, 8, 7, 6, 5])
    const ts = RS.encode(tiny, 12, 40)
    ok(hex(RS.reconstruct(ts.slice(25, 37))) === hex(tiny), '5-byte blob with k=12 round-trips via parity rows')
  }

  // ============================================================================
  // 9. size/perf sanity, ~200KB under 2s
  // ============================================================================
  console.log('\n· perf: ~200KB encode + parity-only reconstruct …')
  {
    const rand = lcg(0xbeef)
    const big = Uint8Array.from({ length: 200_000 }, () => rand() & 0xff)
    const t0 = performance.now()
    const shards = RS.encode(big, 12, 40)
    const back = RS.reconstruct(shards.slice(28)) // all-parity: full inversion path
    const dt = performance.now() - t0
    ok(hex(back) === hex(big), '200KB LCG blob round-trips bit-identically')
    ok(dt < 2000, `encode + reconstruct took ${dt.toFixed(0)}ms (< 2000ms)`)
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
