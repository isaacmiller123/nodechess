// THE A6-M1 LANE B SUITE: account peer service + overlay bootstrap +
// persistent KV, headless over MockFabric (spec §2.2, §4, §5, §11).
//
//   node scripts/test-accounts-peer.mjs
//
// peerService is fabric-agnostic: the same lifecycle that runs over Lane A's
// browser fabric in production runs here over an in-process MockFabric bus, so
// the whole per-client node stack is proven deterministic and offline. Sections:
//   1. 3 peers on one bus: nodeId = sha256(root), signed presence with §11 caps,
//      bootstrap → nonempty tables, overlay-find-node answered, MUTUAL
//      reachability (every peer resolves every other), params digest;
//   2. per-platform caps (§11 desktop 200 / desktop-browser 50 / mobile 15),
//      caps override, the kv handle threads through, no-navigator fallback;
//   3. stop(): closing a peer evicts it from a survivor's routing table;
//   4. the app-lifetime singleton (idempotent start, get, stop clears);
//   5. kvStore: canonical round-trip + fidelity, boundary rejection, prefix
//      scans, byte accounting, overwrite, memory-fallback factory.
//
// House style: esbuild-bundle on the fly (alias @shared; net modules by abs
// path), one-line asserts, exit(1) on any fail.

import { resolve } from 'node:path'
import { rmSync } from 'node:fs'
import { bundleAndImport, makeOutdir, ROOT } from './lib/witness-bundle.mjs'

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const NET = resolve(ROOT, 'src/renderer/src/features/account/net').replace(/\\/g, '/')

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export { PARAMS_A2_DIGEST } from '@shared/accounts/witness'
export { PARAMS_A3 } from '@shared/accounts/storage/params'
export * as P from '${NET}/peerService'
export * as KV from '${NET}/kvStore'
`

async function main() {
  const outdir = makeOutdir('accounts-peer-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W, O, PARAMS_A2_DIGEST, PARAMS_A3, P, KV } = M
  const NOW = 1_750_000_000_000
  const canon = (v) => (v === null ? 'null' : A.toB64u(A.canonicalHash(v)))

  const kpOf = (tag) => {
    const priv = A.sha256(A.utf8(tag))
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  /** A signed-in device identity + its derived nodeId (peerService input shape). */
  const makeIdentity = (tag) => {
    const rootKp = kpOf('peer-root-' + tag)
    const devKp = kpOf('peer-dev-' + tag)
    const nodeId = W.nodeIdOf(rootKp.pubB)
    return { tag, rootKp, devKp, nodeId, identity: { root: rootKp.pubB, key: devKp.pubB, priv: devKp.priv } }
  }

  // ==========================================================================
  console.log('\n· 1. three peers on one MockFabric bus …')
  // ==========================================================================
  const bus = new W.MockFabric()
  const specs = ['A', 'B', 'C'].map(makeIdentity)
  const peers = []
  for (const s of specs) {
    const ep = bus.endpoint(s.nodeId)
    // autoBootstrap:false so all three announce BEFORE any bootstraps (else the
    // first peer would bootstrap into an empty directory). Mirrors how the
    // lead announces the fleet, then converges it.
    const peer = await P.startAccountPeer({
      identity: s.identity,
      fabric: ep,
      now: () => NOW,
      platform: 'desktop-browser',
      autoBootstrap: false,
    })
    peers.push(peer)
  }

  // nodeId derivation matches nodeIdOf; the injected endpoint matches.
  let idsOk = true
  let fabricOk = true
  for (let i = 0; i < 3; i++) {
    if (peers[i].nodeId !== W.nodeIdOf(specs[i].identity.root)) idsOk = false
    if (peers[i].fabric.nodeId !== peers[i].nodeId) fabricOk = false
  }
  ok(idsOk, 'every peer.nodeId === sha256(root) (nodeIdOf), derived from the signed-in identity')
  ok(fabricOk, 'the injected fabric endpoint nodeId matches the derived nodeId')

  // A mismatched endpoint is refused (identity binding is mandatory). Runs on a
  // throwaway bus: minting an endpoint for a nodeId REPLACES its registration,
  // so this must never touch the shared bus’s live peers.
  let mismatchThrew = false
  try {
    const busX = new W.MockFabric()
    await P.startAccountPeer({ identity: specs[0].identity, fabric: busX.endpoint(specs[1].nodeId), now: () => NOW })
  } catch {
    mismatchThrew = true
  }
  ok(mismatchThrew, 'startAccountPeer refuses a fabric whose nodeId ≠ sha256(root)')

  // Presence: all three announced into the shared directory, each signature-valid.
  const dir = peers[0].fabric.directory()
  eq(dir.nodes.size, 3, 'all three peers announced signed presence into the fabric directory')
  let presenceOk = true
  let capsOk = true
  let paramsOk = true
  for (const s of specs) {
    const sp = dir.nodes.get(s.nodeId)
    if (!sp || !W.verifyPresence(sp)) presenceOk = false
    if (!sp || sp.body.key !== s.identity.key) presenceOk = false
    if (!sp || !sp.body.caps.witness || !sp.body.caps.committee || sp.body.caps.shardMb !== PARAMS_A3.budgetBrowserMb)
      capsOk = false
    if (!sp || sp.body.params !== PARAMS_A2_DIGEST) paramsOk = false
  }
  ok(presenceOk, 'each announced presence verifies (signed by the device key advertised in body.key)')
  ok(capsOk, `each peer advertises §11 caps {witness:true, committee:true, shardMb:${PARAMS_A3.budgetBrowserMb}} (desktop-browser)`)
  ok(paramsOk, 'each presence carries params = PARAMS_A2_DIGEST (coordinates with the operator peer)')

  // Bootstrap the fleet, then converge.
  for (const p of peers) await p.bootstrap()
  ok(peers.every((p) => O.tableSize(p.overlay.table) > 0), 'after bootstrap every routing table is nonempty')

  // The overlay-find-node handler answers (the client is itself reachable/routing).
  const fnRes = await peers[0].fabric.request(peers[1].nodeId, 'overlay-find-node', {
    v: 1,
    target: peers[2].nodeId,
  })
  ok(
    fnRes && fnRes.v === 1 && Array.isArray(fnRes.contacts) && fnRes.contacts.length >= 1 && typeof fnRes.contacts[0].nodeId === 'string',
    'a raw overlay-find-node RPC is answered with the responder’s k-closest contacts',
  )

  // MUTUAL reachability: every peer resolves every other via the overlay.
  let mutual = true
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      if (i === j) continue
      const res = (await peers[i].overlay.lookup(peers[j].nodeId)).map((c) => c.nodeId)
      if (!res.includes(peers[j].nodeId)) mutual = false
    }
  ok(mutual, 'every peer resolves every other peer’s nodeId through the live overlay (mutually reachable)')

  // bootstrap is safe to re-run as the directory fills.
  await peers[0].bootstrap()
  ok(O.tableSize(peers[0].overlay.table) > 0, 're-running bootstrap on a live peer is safe (idempotent seed)')

  // ==========================================================================
  console.log('\n· 2. per-platform caps (§11) + kv handle …')
  // ==========================================================================
  eq(P.defaultCapsFor('desktop').shardMb, PARAMS_A3.budgetDesktopMb, `desktop caps advertise ${PARAMS_A3.budgetDesktopMb} MB`)
  eq(P.defaultCapsFor('desktop-browser').shardMb, PARAMS_A3.budgetBrowserMb, `desktop-browser caps advertise ${PARAMS_A3.budgetBrowserMb} MB`)
  eq(P.defaultCapsFor('mobile').shardMb, PARAMS_A3.budgetMobileMb, `mobile caps advertise ${PARAMS_A3.budgetMobileMb} MB`)
  ok(P.defaultCapsFor('mobile').witness && P.defaultCapsFor('mobile').committee, 'every platform advertises witness + committee capability')
  eq(P.detectPlatform(), 'desktop-browser', 'detectPlatform() falls back to desktop-browser with no navigator (headless)')

  {
    const b2 = new W.MockFabric()
    const s = makeIdentity('mobile')
    const kv = KV.createMemoryKvStore()
    const peer = await P.startAccountPeer({
      identity: s.identity,
      fabric: b2.endpoint(s.nodeId),
      now: () => NOW,
      platform: 'mobile',
      kv,
    })
    const sp = peer.fabric.directory().nodes.get(s.nodeId)
    eq(sp.body.caps.shardMb, PARAMS_A3.budgetMobileMb, 'a mobile peer announces the mobile shard budget')
    ok(peer.kv === kv, 'the persistent kv store threads through onto peer.kv (M3 wiring hook)')
    await peer.stop()

    const s2 = makeIdentity('desk')
    const peer2 = await P.startAccountPeer({
      identity: s2.identity,
      fabric: b2.endpoint(s2.nodeId),
      now: () => NOW,
      platform: 'desktop',
      caps: { shardMb: 999 },
    })
    const sp2 = peer2.fabric.directory().nodes.get(s2.nodeId)
    eq(sp2.body.caps.shardMb, 999, 'an explicit caps.shardMb override wins over the platform default')
    await peer2.stop()
  }

  // ==========================================================================
  console.log('\n· 3. stop() → eviction from a survivor’s table …')
  // ==========================================================================
  {
    const before = (await peers[1].overlay.lookup(peers[0].nodeId)).map((c) => c.nodeId)
    ok(before.includes(peers[0].nodeId), 'peer B resolves peer A before A stops')
    await peers[0].stop() // ownsFabric default true → closes A’s endpoint
    const after = (await peers[1].overlay.lookup(peers[0].nodeId)).map((c) => c.nodeId)
    ok(!after.includes(peers[0].nodeId), 'after A.stop() a survivor no longer resolves A (unreachable → evicted)')
    await peers[1].stop()
    await peers[2].stop()
    ok(true, 'stop() on every peer resolves cleanly')
  }

  // ==========================================================================
  console.log('\n· 4. app-lifetime singleton …')
  // ==========================================================================
  {
    const b3 = new W.MockFabric()
    const s = makeIdentity('singleton')
    eq(P.getAccountPeer(), null, 'no singleton before start')
    const p1 = await P.startAccountPeerSingleton({ identity: s.identity, fabric: b3.endpoint(s.nodeId), now: () => NOW })
    const p2 = await P.startAccountPeerSingleton({ identity: s.identity, fabric: b3.endpoint(s.nodeId), now: () => NOW })
    ok(p1 === p2, 'a second start returns the SAME live peer (idempotent)')
    ok(P.getAccountPeer() === p1, 'getAccountPeer() returns the live singleton')
    await P.stopAccountPeerSingleton()
    eq(P.getAccountPeer(), null, 'stopAccountPeerSingleton() clears the singleton (sign-out)')
    // restartable after stop
    const p3 = await P.startAccountPeerSingleton({ identity: s.identity, fabric: b3.endpoint(s.nodeId), now: () => NOW })
    ok(p3 !== p1 && P.getAccountPeer() === p3, 'the singleton is restartable after a stop (fresh sign-in)')
    await P.stopAccountPeerSingleton()
  }

  // ==========================================================================
  console.log('\n· 5. kvStore, canonical persistence adapter …')
  // ==========================================================================
  {
    const mem = await KV.openKvStore({ forceMemory: true })
    eq(mem.backend, 'memory', 'forceMemory → memory backend')
    eq(mem.persisted, false, 'the memory backend never claims durable storage')
    const fallback = await KV.openKvStore()
    eq(fallback.backend, 'memory', 'no IndexedDB in node → openKvStore falls back to memory (honest degradation)')
    let idbThrew = false
    try {
      await KV.openIndexedDbKvStore({ indexedDB: undefined })
    } catch {
      idbThrew = true
    }
    ok(idbThrew, 'openIndexedDbKvStore throws when no IndexedDB is reachable (the factory owns the fallback)')

    const store = KV.createMemoryKvStore()
    await store.put('k1', { v: 1, x: 5, name: 'z' })
    eq(canon(await store.get('k1')), canon({ v: 1, x: 5, name: 'z' }), 'put/get round-trips a CanonicalObject byte-exactly')
    await store.put('k2', { z: 3, a: 1, m: 2 })
    eq(canon(await store.get('k2')), canon({ a: 1, m: 2, z: 3 }), 'the stored value is canonical regardless of input key order')
    eq(await store.get('missing'), null, 'get of an absent key is null')

    let putThrew = false
    try {
      await store.put('bad', { x: 1.5 })
    } catch {
      putThrew = true
    }
    ok(putThrew, 'put REJECTS a non-canonical value (fractional number) at the boundary, junk never persists')
    eq(await store.has('bad'), false, '…and the rejected key was never written')

    ok(await store.has('k1'), 'has() true for a present key')
    await store.delete('k1')
    eq(await store.has('k1'), false, 'delete() removes the key')
    eq(await store.get('k1'), null, 'get() after delete is null')

    const s2 = KV.createMemoryKvStore()
    await s2.put('shard|b', { v: 2 })
    await s2.put('shard|a', { v: 1 })
    await s2.put('ptr|a', { v: 3 })
    eq((await s2.keys('shard|')).join(','), 'shard|a,shard|b', 'keys(prefix) returns only prefixed keys, ascending')
    eq((await s2.keys()).length, 3, 'keys() returns every key')
    eq(await s2.count('shard|'), 2, 'count(prefix) counts prefixed keys')
    eq(await s2.count(), 3, 'count() counts all keys')
    const es = await s2.entries('shard|')
    ok(
      es.length === 2 && es[0].key === 'shard|a' && canon(es[0].value) === canon({ v: 1 }),
      'entries(prefix) returns prefixed key/value pairs, ascending, values decoded',
    )
    const wantBytes =
      A.canonicalBytes({ v: 1 }).length + A.canonicalBytes({ v: 2 }).length + A.canonicalBytes({ v: 3 }).length
    eq(await s2.bytes(), wantBytes, 'bytes() sums canonical value byte lengths (§11 budget accounting)')
    await s2.put('ptr|a', { v: 9 })
    eq(canon(await s2.get('ptr|a')), canon({ v: 9 }), 'put overwrites a key in place')
    eq(await s2.count(), 3, 'overwrite does not change the count')
    await s2.clear()
    eq(await s2.count(), 0, 'clear() empties the store')
    await s2.close()
    ok(true, 'close() resolves cleanly')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
