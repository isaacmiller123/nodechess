// THE A3 OVERLAY SUITE: Kademlia routing over MockFabric (spec §5, C-11).
//
//   node scripts/test-accounts-overlay.mjs
//
// Proves the overlay brick end to end, fabric-suite style: 64 in-process nodes
// with REAL ed25519 identities on one MockFabric bus, presence-announced and
// bootstrapped, then:
//   0. k-bucket admission law (anti-eclipse: full bucket never evicts a live
//      long-standing contact: ping the LRS candidate, keep-old/replace-dead);
//   1. bootstrap: every table nonempty + every self-lookup converged;
//   2. correctness (LOAD-BEARING): 20 deterministic targets → lookup returns
//      EXACTLY the true k-closest live nodeIds (vs closestEligible ground truth);
//   3. efficiency: median rounds ≤ ceil(log2 64)+2; rpcs bounded (numbers logged);
//   4. put/get roundtrip under kind 'record' + getMerged union via injected merge;
//   5. STORE validation: default validator refuses non-'record'; refuse-all → 0;
//   6. anti-eclipse end to end: a malicious responder's 16 fabricated contacts
//      never enter the table and the lookup still returns the true closest;
//   7. churn: 20/64 nodes die → same targets still resolve the true k-closest
//      of the survivors, dead contacts evicted;
//   8. determinism: identical fresh topologies → identical results + rpc counts;
//   9. browser parity: kbucket+distance core bundled platform:'browser' produces
//      the identical decision digest, and carries zero node built-ins.
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on any fail.

import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundleAndImport, makeOutdir } from './lib/witness-bundle.mjs'
import { findNodeBuiltinRefs, readBundle } from './lib/accounts-fixture.mjs'

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export { PARAMS_A3, PARAMS_A3_DIGEST } from '@shared/accounts/storage/params'
`

// The decision core alone (kbucket + distance underneath): bundled twice,
// platform node vs browser, driven through one scripted insert/closest
// sequence; the digests must match byte-for-byte.
const PARITY_ENTRY = `
import {
  bucketIndexOf,
  closestContacts,
  insertContact,
  newRoutingTable,
  removeContact,
  replaceContact,
  touchContact,
} from '@shared/accounts/overlay/kbucket'
import { sha256, toB64u, utf8 } from '@shared/accounts/hash'

export function runKbucketScript(): string {
  const id = (tag: string): string => toB64u(sha256(utf8(tag)))
  const contactOf = (nid: string, ts: number) => ({ nodeId: nid, root: nid, key: nid, lastSeenMs: ts })
  const self = id('kb-parity-self')
  const table = newRoutingTable(self)
  const log: string[] = []
  for (let i = 0; i < 200; i++) {
    const nid = id('kb-parity-' + i)
    const out = insertContact(table, contactOf(nid, i), 4)
    if (out.kind === 'full') {
      // deterministic ping fate: even i → candidate alive (keep old), odd → dead (replace)
      if (i % 2 === 0) {
        touchContact(table, out.evictionCandidate.nodeId, 1000 + i)
        log.push(i + ':full-keep:' + out.evictionCandidate.nodeId)
      } else {
        replaceContact(table, out.evictionCandidate.nodeId, contactOf(nid, i), 4)
        log.push(i + ':full-replace:' + out.evictionCandidate.nodeId)
      }
    } else {
      log.push(i + ':' + out.kind + ':' + bucketIndexOf(self, nid))
    }
    if (i % 17 === 0) log.push(i + ':rm:' + removeContact(table, id('kb-parity-' + (i >> 1))))
  }
  for (let t = 0; t < 8; t++) {
    const target = id('kb-parity-target-' + t)
    log.push('closest' + t + ':' + closestContacts(table, target, 16).map((c) => c.nodeId).join(','))
  }
  return toB64u(sha256(utf8(JSON.stringify(log))))
}
`

async function main() {
  const outdir = makeOutdir('accounts-overlay-test')
  const outNode = makeOutdir('accounts-overlay-parity-node')
  const outBrowser = makeOutdir('accounts-overlay-parity-browser')
  try {
    await run(await bundleAndImport(outdir, ENTRY), outNode, outBrowser)
  } finally {
    for (const d of [outdir, outNode, outBrowser]) rmSync(d, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M, outNode, outBrowser) {
  const { A, W, O, PARAMS_A3, PARAMS_A3_DIGEST } = M
  const NOW = 1_750_000_000_000
  const K = PARAMS_A3.kBucket // 16: bucket size AND the k of "k closest"

  const b64 = A.toB64u
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  const canon = (v) => (v === null ? 'null' : b64(A.canonicalHash(v)))
  const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  const trueClosest = (target, ids, k) =>
    W.closestEligible(target, ids.map((nodeId) => ({ nodeId })), () => true, k)
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

  /** A fabric node: real ed25519 root+device, signed presence, overlay node. */
  function makeOverlayNode(fabric, tag, extra = {}) {
    const root = kpOf('ov-root-' + tag)
    const dev = kpOf('ov-dev-' + tag)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    ep.announce(W.signPresence(
      { v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
      dev.priv,
    ))
    const node = O.createOverlayNode(ep, { root: root.pubB, key: dev.pubB }, { nowMs: () => NOW, ...extra })
    return { root, dev, nodeId, ep, node }
  }

  // Pointer-set-union-shaped merge (the storage layer's semantics live there;
  // here it just proves the injected fold reaches both store and getMerged).
  const unionMerge = (prev, next) => {
    if (prev && Array.isArray(prev.items) && Array.isArray(next.items))
      return { v: 1, items: [...new Set([...prev.items, ...next.items])].sort((a, b) => a - b) }
    return next
  }

  // ==========================================================================
  console.log('\n· 0. k-bucket admission law (anti-eclipse) …')
  // ==========================================================================
  {
    const selfId = b64(seed32('kbu-self'))
    const t = O.newRoutingTable(selfId)
    const inB0 = []
    for (let i = 0; inB0.length < 18 && i < 500; i++) {
      const nid = b64(seed32('kbu-c-' + i))
      if (O.bucketIndexOf(selfId, nid) === 0) inB0.push(nid)
    }
    const contactOf = (nid, ts) => ({ nodeId: nid, root: nid, key: nid, lastSeenMs: ts })
    let inserted = 0
    for (let i = 0; i < K; i++) if (O.insertContact(t, contactOf(inB0[i], i), K).kind === 'inserted') inserted++
    eq(inserted, K, `a bucket admits kBucket=${K} contacts`)
    const full = O.insertContact(t, contactOf(inB0[16], 100), K)
    ok(full.kind === 'full' && full.evictionCandidate.nodeId === inB0[0], 'a full bucket returns the LRS contact as eviction candidate, newcomer NOT admitted')
    ok(!O.allContacts(t).some((c) => c.nodeId === inB0[16]), 'the newcomer stayed OUT of the table (no silent displacement of a long-standing contact)')
    O.touchContact(t, inB0[0], 200) // eviction ping answered → keep old
    const full2 = O.insertContact(t, contactOf(inB0[16], 300), K)
    ok(full2.kind === 'full' && full2.evictionCandidate.nodeId === inB0[1], 'after a live-ping touch the old contact is retained; the candidate advances to the next LRS')
    ok(O.replaceContact(t, inB0[1], contactOf(inB0[16], 400), K), 'a DEAD LRS contact is replaced by the newcomer (ping failed)')
    const ids0 = O.allContacts(t).map((c) => c.nodeId)
    ok(!ids0.includes(inB0[1]) && ids0.includes(inB0[16]), 'replace dropped the dead contact and admitted the newcomer')
    eq(O.insertContact(t, contactOf(inB0[2], 500), K).kind, 'updated', 're-inserting a tabled contact updates it in place (moves to bucket tail)')
  }

  // ==========================================================================
  console.log('\n· 1. 64-node network: announce, bootstrap, self-lookup …')
  // ==========================================================================
  const fabric = new W.MockFabric()
  const nodes = Array.from({ length: 64 }, (_, i) => makeOverlayNode(fabric, 'main-' + i, { merge: unionMerge }))
  const allIds = nodes.map((n) => n.nodeId)
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  for (const n of nodes) await n.node.bootstrap()
  ok(nodes.every((n) => O.tableSize(n.node.table) > 0), 'after bootstrap every routing table is nonempty')
  let selfConverged = true
  for (const n of nodes) {
    const res = (await n.node.lookup(n.nodeId)).map((c) => c.nodeId)
    if (!sameIds(res, trueClosest(n.nodeId, allIds, K))) selfConverged = false
  }
  ok(selfConverged, 'every self-lookup converged to the true k-closest set around its own id')

  // ==========================================================================
  console.log('\n· 2. lookup correctness, 20 deterministic targets (LOAD-BEARING) …')
  // ==========================================================================
  const targets = Array.from({ length: 20 }, (_, i) => b64(seed32('ov-target-' + i)))
  const lookupStats = []
  for (let i = 0; i < targets.length; i++) {
    const q = nodes[(i * 7) % 64]
    const res = (await q.node.lookup(targets[i])).map((c) => c.nodeId)
    ok(sameIds(res, trueClosest(targets[i], allIds, K)), `lookup ${i} returns EXACTLY the true k-closest live nodeIds`)
    lookupStats.push({ ...q.node.lastLookupStats })
  }

  // ==========================================================================
  console.log('\n· 3. lookup efficiency …')
  // ==========================================================================
  const medRounds = median(lookupStats.map((s) => s.rounds))
  const medRpcs = median(lookupStats.map((s) => s.rpcs))
  const maxRpcs = Math.max(...lookupStats.map((s) => s.rpcs))
  // Observed on this fixed topology: median rounds 2, median rpcs 16, max
  // rpcs 16: comfortably under the ~N/2 ceiling asserted below. (Churn-phase
  // walks that hit failures switch to drain mode and cost up to ~population
  // rpcs; the bounds here cover the failure-free common path only.)
  console.log(`    (20 lookups over N=64: median rounds ${medRounds}, median rpcs ${medRpcs}, max rpcs ${maxRpcs})`)
  ok(medRounds <= Math.ceil(Math.log2(64)) + 2, `median lookup rounds ${medRounds} ≤ ceil(log2 N)+2 = ${Math.ceil(Math.log2(64)) + 2}`)
  ok(medRpcs <= 40, `median lookup rpcs bounded (${medRpcs} ≤ 40)`)
  ok(maxRpcs <= 64, `max lookup rpcs bounded by the population (${maxRpcs} ≤ 64)`)

  // ==========================================================================
  console.log("\n· 4. put/get roundtrip (kind 'record') + getMerged union …")
  // ==========================================================================
  const rtTargets = Array.from({ length: 10 }, (_, i) => b64(seed32('ov-rt-' + i)))
  let allPutFull = true
  let allGetExact = true
  for (let i = 0; i < 10; i++) {
    const value = { v: 1, n: i, tag: 'rt' }
    const stored = await nodes[i].node.put(rtTargets[i], 'record', value)
    if (stored !== PARAMS_A3.replicateK) allPutFull = false
    const got = await nodes[(i + 31) % 64].node.get(rtTargets[i], 'record')
    if (canon(got) !== canon(value)) allGetExact = false
  }
  ok(allPutFull, `put lands on all replicateK=${PARAMS_A3.replicateK} closest nodes (default validator accepts kind 'record')`)
  ok(allGetExact, 'get retrieves every stored record byte-exactly from an arbitrary node (first-hit short-circuit)')
  const closestHolder = byId.get(trueClosest(rtTargets[0], allIds, 1)[0])
  ok(closestHolder.node.localGet(rtTargets[0], 'record') !== null, 'the XOR-closest node to the key is among the holders (publish lands by key duty)')

  const mt = b64(seed32('ov-merged-target'))
  const reader = nodes[0]
  const holders = trueClosest(mt, allIds, K).filter((id) => id !== reader.nodeId).slice(0, 5)
  const planted = holders.map((id, j) => byId.get(id).node.localPut(mt, 'record', { v: 1, items: [j * 2, j * 2 + 1] }))
  ok(planted.every(Boolean), 'localPut plants distinct fragments on 5 of the k-closest holders (storage-layer seam)')
  const merged = await reader.node.getMerged(mt, 'record')
  ok(merged !== null && Array.isArray(merged.items) && merged.items.join(',') === '0,1,2,3,4,5,6,7,8,9',
    'getMerged unions the fragments held across the k-closest set through the injected merge')

  // ==========================================================================
  console.log('\n· 5. STORE validation gates …')
  // ==========================================================================
  const badKind = await nodes[3].node.put(b64(seed32('ov-badkind')), 'pointers', { v: 1, x: 1 })
  eq(badKind, 0, "the default validator refuses kind 'pointers' network-wide → put counts zero true stores")
  {
    const rf = new W.MockFabric()
    const refusers = Array.from({ length: 6 }, (_, i) => makeOverlayNode(rf, 'refuse-' + i, { validator: () => false }))
    for (const n of refusers) await n.node.bootstrap()
    const refused = await refusers[0].node.put(b64(seed32('ov-refused')), 'record', { v: 1 })
    eq(refused, 0, 'a custom refuse-all validator yields put = 0 (refusal is honest degradation, never an error)')
    ok(!refusers[1].node.localPut(b64(seed32('ov-local')), 'record', { v: 1 }), 'localPut rides the same validator gate')
  }
  ok(!nodes[2].node.localPut('not-a-32-byte-key', 'record', { v: 1 }), 'localPut refuses a target that is not a 32-byte b64u key')

  // ==========================================================================
  console.log('\n· 6. anti-eclipse: fabricated FIND_NODE contacts stay hints …')
  // ==========================================================================
  {
    const af = new W.MockFabric()
    const anodes = Array.from({ length: 24 }, (_, i) => makeOverlayNode(af, 'ae-' + i, {}))
    for (const n of anodes) await n.node.bootstrap()
    const mal = makeOverlayNode(af, 'ae-mal', {})
    await mal.node.bootstrap()
    // 16 unroutable nodeIds hugging the victim target (= the attacker's own id,
    // so the honest lookup is guaranteed to route through it).
    const victimTarget = mal.nodeId
    const tb = A.fromB64u(victimTarget)
    const fabricated = Array.from({ length: 16 }, (_, i) => {
      const bytes = Uint8Array.from(tb)
      bytes[31] ^= i + 1
      return b64(bytes)
    })
    mal.ep.onRequest('overlay-find-node', async () => ({
      v: 1,
      contacts: fabricated.map((nid) => ({ nodeId: nid, root: nid, key: nid, lastSeenMs: NOW })),
    }))
    const honest = makeOverlayNode(af, 'ae-honest', {})
    await honest.node.bootstrap()
    const res = (await honest.node.lookup(victimTarget)).map((c) => c.nodeId)
    const population = [...anodes.map((n) => n.nodeId), mal.nodeId, honest.nodeId]
    ok(sameIds(res, trueClosest(victimTarget, population, K)), 'the lookup routed through the eclipse attacker still returns the true k-closest live set (fabricated contacts die on direct contact)')
    const tabled = O.allContacts(honest.node.table).map((c) => c.nodeId)
    ok(fabricated.every((f) => !tabled.includes(f)), 'none of the 16 fabricated contacts entered the honest routing table (FIND_NODE responses are ROUTING HINTS only)')
    ok(tabled.includes(mal.nodeId), 'the attacker itself IS tabled (it answered a direct RPC). Hints, not peers, are quarantined')
  }

  // ==========================================================================
  console.log('\n· 6b. forged-root hint: a real nodeId bound to a FORGED root is dropped …')
  // ==========================================================================
  // The subtler eclipse than §6: the hint carries a REAL, reachable nodeId but
  // a root that does NOT hash to it (nodeId = sha256(rootPub), §4). A direct
  // exchange only re-confirms the transport nodeId: the root/key ride from the
  // (malicious) hint, so the binding must be checked at ingest, else lookup()
  // hands the pointer/duty layer an attacker-chosen root bound to a live node.
  {
    const bf = new W.MockFabric()
    const mal = makeOverlayNode(bf, 'fr-mal', {})
    const V = makeOverlayNode(bf, 'fr-victim', {})
    await mal.node.bootstrap()
    await V.node.bootstrap()
    // A forged root (a valid pubkey) whose nodeId != the target it is bound to.
    const forged = kpOf('fr-forged-root')
    // H2: a reachable, UN-ANNOUNCED node with a CORRECT binding. The positive
    // control proving the filter admits honest hints, not everything.
    const h2Root = kpOf('fr-H2-root')
    const h2Dev = kpOf('fr-H2-dev')
    const h2Id = W.nodeIdOf(h2Root.pub)
    const h2Ep = bf.endpoint(h2Id)
    const h2Node = O.createOverlayNode(h2Ep, { root: h2Root.pubB, key: h2Dev.pubB }, { nowMs: () => NOW })
    await h2Node.bootstrap()
    // A forged nodeId distinct from H2's, so the drop (forged) and the admit
    // (H2, correctly bound) are independent slots in the same response.
    const forgedId = (() => { const b = A.fromB64u(V.nodeId); b[0] ^= 0x5a; return b64(b) })()
    mal.ep.onRequest('overlay-find-node', async () => ({
      v: 1,
      contacts: [
        { nodeId: forgedId, root: forged.pubB, key: forged.pubB, lastSeenMs: NOW }, // nodeIdOf(forged)!==forgedId → dropped
        { nodeId: h2Id, root: h2Root.pubB, key: h2Dev.pubB, lastSeenMs: NOW }, // correctly bound → admitted after probe
      ],
    }))
    ok(W.nodeIdOf(forged.pub) !== forgedId, 'sanity: forged root does not hash to its claimed forged nodeId')
    await V.node.lookup(h2Id)
    const tabled = O.allContacts(V.node.table)
    ok(tabled.some((c) => c.nodeId === h2Id && c.root === h2Root.pubB), 'positive control: the correctly-bound hint IS admitted (binding filter is discriminating, not blanket-dropping)')
    ok(!tabled.some((c) => c.nodeId === forgedId), 'the forged-root hint never entered the routing table')
    ok(!tabled.some((c) => c.root === forged.pubB), 'no tabled contact carries the forged root')
    ok(tabled.every((c) => W.nodeIdOf(c.root) === c.nodeId), 'binding invariant holds for EVERY tabled contact: nodeId === sha256(root)')
    const vres = await V.node.lookup(forgedId)
    ok(vres.every((c) => W.nodeIdOf(c.root) === c.nodeId), 'lookup() never returns a contact violating the binding invariant')
    ok(!vres.some((c) => c.root === forged.pubB), 'lookup() for the forged nodeId never surfaces the forged root')
    await h2Node.close()
    await h2Ep.close()
  }

  // ==========================================================================
  console.log('\n· 6c. hint-book bound: a padder cannot inflate `known` past knownCap …')
  // ==========================================================================
  // A malicious responder pads every FIND_NODE reply with binding-valid junk
  // (nodeIdOf(root)===nodeId, cheap: no key/reachability). Without the cap the
  // victim's `known` (and thus drain-mode probe count + memory) grows 1:1 with
  // injected volume. With the FIFO knownCap it is bounded to a constant.
  {
    const cf = new W.MockFabric()
    const CAP = 20
    // ≥ K real nodes so they fill the victim's k-closest window; the far junk
    // (maximal distance) then never enters that window, so it is never probed
    // (never cleaned) and genuinely accumulates in `known`. Exercising the cap.
    const reals = Array.from({ length: 24 }, (_, i) => makeOverlayNode(cf, 'hb-' + i, {}))
    for (const n of reals) await n.node.bootstrap()
    // The padder answers find-node with 64 fresh binding-valid junk contacts.
    const padder = makeOverlayNode(cf, 'hb-padder', {})
    await padder.node.bootstrap()
    // 50 binding-valid junk contacts GROUND far from the padder's own nodeId (top
    // byte = complement of the padder's), so a lookup(padder) never puts them in
    // its k-closest window: they are never probed, never cleaned, and therefore
    // ACCUMULATE in `known`, exercising the cap (not the probe-and-evict path).
    const farTop = A.fromB64u(padder.nodeId)[0] ^ 0xff
    const junk = []
    for (let i = 0; junk.length < 50; i++) {
      const rb = seed32('hb-junk-' + i)
      const nid = W.nodeIdOf(rb) // binding-valid: nodeId === sha256(root)
      if (A.fromB64u(nid)[0] === farTop) junk.push({ nodeId: nid, root: b64(rb), key: b64(rb), lastSeenMs: NOW })
    }
    padder.ep.onRequest('overlay-find-node', async () => ({ v: 1, contacts: junk }))
    // Victim with a small knownCap; route many lookups through the padder so it
    // is offered far more binding-valid junk than the cap.
    const victim = makeOverlayNode(cf, 'hb-victim', { knownCap: CAP })
    await victim.node.bootstrap()
    let peakKnown = 0
    for (let i = 0; i < 10; i++) {
      await victim.node.lookup(padder.nodeId) // each offers the 50 far junk again
      peakKnown = Math.max(peakKnown, victim.node.knownSize)
    }
    // The core anti-DoS invariant: memory is bounded, `known` NEVER exceeds the
    // cap even as unprobed far junk accumulates (peak reaches the cap, proving it
    // clamps rather than the junk simply being small).
    ok(peakKnown === CAP, `\`known\` clamps exactly at knownCap (peak ${peakKnown} === ${CAP}) as 50 far junk accumulate`)
    // And drain cost stays bounded by a constant, not by the injected volume:
    // kill a real node the victim knows, then a lookup whose probe fails drains.
    await reals[0].node.close()
    await reals[0].ep.close()
    await victim.node.lookup(reals[0].nodeId)
    const drainRpcs = victim.node.lastLookupStats.rpcs
    ok(drainRpcs <= CAP + 4 * K, `drain probe count is bounded by the cap+table (${drainRpcs} rpcs), never the unbounded volume the padder would offer`)
  }

  // ==========================================================================
  console.log('\n· 7. churn: 20 of 64 nodes die …')
  // ==========================================================================
  const closedIdx = Array.from({ length: 20 }, (_, i) => 40 + i)
  const closedIds = new Set(closedIdx.map((i) => nodes[i].nodeId))
  const querier = nodes[7]
  const deadTabledBefore = O.allContacts(querier.node.table).filter((c) => closedIds.has(c.nodeId)).length
  for (const i of closedIdx) {
    await nodes[i].node.close()
    await nodes[i].ep.close()
  }
  const survivors = allIds.filter((id) => !closedIds.has(id))
  for (let i = 0; i < targets.length; i++) {
    const res = (await querier.node.lookup(targets[i])).map((c) => c.nodeId)
    ok(sameIds(res, trueClosest(targets[i], survivors, K)), `churn lookup ${i} returns EXACTLY the true k-closest of the survivors`)
  }
  const deadTabledAfter = O.allContacts(querier.node.table).filter((c) => closedIds.has(c.nodeId)).length
  ok(deadTabledBefore > 0 && deadTabledAfter < deadTabledBefore, `failed contacts were evicted from the routing table (${deadTabledBefore} dead tabled before → ${deadTabledAfter} after)`)

  // ==========================================================================
  console.log('\n· 8. determinism: identical fresh topologies …')
  // ==========================================================================
  async function buildTopo(n) {
    const f = new W.MockFabric()
    const ns = Array.from({ length: n }, (_, i) => makeOverlayNode(f, 'det-' + i, {}))
    for (const x of ns) await x.node.bootstrap()
    return ns
  }
  const t1 = await buildTopo(24)
  const t2 = await buildTopo(24)
  const dTarget = b64(seed32('det-target'))
  const r1 = (await t1[5].node.lookup(dTarget)).map((c) => c.nodeId)
  const s1 = { ...t1[5].node.lastLookupStats }
  const r2 = (await t2[5].node.lookup(dTarget)).map((c) => c.nodeId)
  const s2 = { ...t2[5].node.lastLookupStats }
  ok(sameIds(r1, r2), 'the same lookup on an identical fresh topology returns an identical result array')
  ok(s1.rpcs === s2.rpcs && s1.rounds === s2.rounds, `…and an identical walk: ${s1.rpcs} rpcs / ${s1.rounds} rounds in both runs`)

  // ==========================================================================
  console.log('\n· 9. browser parity: kbucket decision core …')
  // ==========================================================================
  const coreNode = await bundleAndImport(outNode, PARITY_ENTRY, 'node')
  const coreBrowser = await bundleAndImport(outBrowser, PARITY_ENTRY, 'browser')
  const digestNode = coreNode.runKbucketScript()
  const digestBrowser = coreBrowser.runKbucketScript()
  eq(digestNode, digestBrowser, 'node and browser bundles produce the identical decision digest over one scripted insert/closest sequence')
  const refs = findNodeBuiltinRefs(readBundle(resolve(outBrowser, 'bundle.mjs')))
  eq(refs.length, 0, 'the browser bundle of the overlay core carries zero node built-ins')
}

main().catch((e) => { console.error(e); process.exit(1) })
