// THE A6-M3 LANE (L-duty + L-store) SUITE: LIVE STORAGE DUTY over a MockFabric
// multi-carrier fleet (spec §5 three retention layers / publish-on-write /
// authenticated pointers / repair; §11 per-platform budgets). Modules:
//   src/renderer/src/features/account/net/shardDuty.ts
//   src/renderer/src/features/account/net/kvStore.ts
//
//   node scripts/test-accounts-shard-duty.mjs
//
// shardDuty COMPOSES the frozen §5 substrate (storage/{rs,shards,pointers,viewer})
// onto a live overlay. It reimplements no crypto, so this suite proves the
// WIRING end to end, fabric-suite style, exactly as it runs in the browser:
//   1. gate: makeStorageDutyGate composes the shard + pointer store validators.
//      It accepts a valid shard row at its own key, refuses a foreign-key /
//      poisoned row, refuses an off-duty shard pointer, budgets by §11 capacity,
//      and its subjects() is the repair worklist.
//   2. THE M3 ACCEPTANCE SLICE (live): an owner writes a witnessed chain,
//      publishes-on-write + final-syncs it to distance-assigned carriers over
//      the LIVE overlay, publishes the authenticated pointers, then GOES OFFLINE
//      FOREVER, and a fresh viewer reconstructs profile + newest checkpoint +
//      head + full history from shard space, BIT-FAITHFUL, owner gone.
//   3. honest degradation (C-8): carriers churn until live rows fall below
//      K_rec → the viewer reports TYPED temporary unavailability (never a crash,
//      never a fake profile; the pointer floor still pins the head) → runShardRepair
//      re-encodes + redistributes → full width HEALS → the viewer reconstructs
//      again. Eviction = churn = healed.
//   4. kvStore §11 budget: LRU eviction over the platform floor, get-as-use,
//      exact byte accounting, the per-platform budget map, unbounded back-compat.
//
// House style: esbuild-bundle on the fly (alias @shared; net modules by abs
// path), one-line asserts, exit(1) on any fail. Test identities are RAW fixed
// 32-byte seeds → ed25519 (never argon2).

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
export * as S from '@shared/accounts/storage'
export * as SEG from '@shared/accounts/segment'
export { PARAMS_A3, PARAMS_A3_DIGEST } from '@shared/accounts/storage/params'
export * as D from '${NET}/shardDuty'
export * as KV from '${NET}/kvStore'
`

async function main() {
  const outdir = makeOutdir('accounts-shard-duty-test')
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
  const { A, W, O, S, SEG, D, KV, PARAMS_A3, PARAMS_A3_DIGEST } = M
  const b64 = A.toB64u
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const idLike = (tag) => b64(seed32(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: b64(pub) }
  }
  const canon = (v) => b64(A.canonicalHash(v))
  const shaB = (bytes) => b64(A.sha256(bytes))
  const mint = (body, priv) => ({ body, sig: b64(A.ed25519.sign(A.canonicalBytes(body), priv)) })
  const clone = (x) => structuredClone(x)

  const NOW0 = 1_750_000_000_000
  let now = NOW0

  // 8 witnesses ground to DISTINCT /16 nodeId prefixes (M-of-N ckpt diversity).
  const wits = []
  for (let i = 0; wits.length < 8 && i < 400; i++) {
    const kp = kpOf('sd-wit-' + i)
    const nodeId = W.nodeIdOf(kp.pub)
    const pfx = W.prefixBucket(nodeId, 16)
    if (!wits.some((w) => w.pfx === pfx)) wits.push({ ...kp, nodeId, pfx })
  }
  ok(wits.length === 8, 'fixture: 8 witnesses with distinct /16 prefixes')
  const eligible = new Map(wits.map((w) => [w.pubB, w.nodeId]))
  const RULE = { m: 4, n: 8, prefixDiversityMin: 3 }

  const attOf = (ev, w, wts) => ({ ...ev, wit: [W.makeAttestation(A.eventId(ev.body), 1, w.pubB, w.priv, wts)] })
  const attachLast = (chain, w, wts) => {
    const last = chain.events[chain.events.length - 1]
    return { root: chain.root, events: [...chain.events.slice(0, -1), attOf(last, w, wts)] }
  }

  const GEO = { k: 3, n: 9 } // suite geometry: any 3 of 9 reconstruct
  const CAP = 48

  // --- the owner's chain: genesis + profile + 12 device-signed games + 2 ckpts -
  const owner = kpOf('sd-owner-root')
  const dev = kpOf('sd-owner-dev')
  const signing = { root: owner.pubB, key: dev.pubB, priv: dev.priv }
  let chain = A.createAccountChain({
    rootPriv: owner.priv, rootPub: owner.pub, displayName: 'Shard Duty Subject', ts: NOW0,
    device: { pub: dev.pubB, index: 0 },
  })
  chain = { root: chain.root, events: [attOf(chain.events[0], wits[0], NOW0 + 5), ...chain.events.slice(1)] }
  chain = A.appendPersonal(chain, dev.priv, dev.pubB, 'profile', { fields: { bio: 'first bio', country: 'NO' } }, NOW0 + 100)
  chain = A.appendPersonal(chain, dev.priv, dev.pubB, 'profile', { fields: { bio: 'reconstructed from live shards', flair: 'phoenix' } }, NOW0 + 200)
  let t = NOW0 + 1000
  const segEvOfGame = []
  for (let g = 1; g <= 12; g++) {
    const w = wits[g % 8]
    const game = idLike('sd-game-' + g)
    const transcript = SEG.transcriptDigest(game, [], g % 3 ? '1-0' : '1/2-1/2', 'resign')
    const payload = SEG.makeSegmentPayload({
      game, opp: kpOf('sd-opp-' + g).pubB, color: g % 2 ? 'b' : 'w', result: g % 3 ? '1-0' : '1/2-1/2', reason: 'resign', moves: [],
      heads: { w: { head: idLike('sd-hw-' + g), height: 0 }, b: { head: idLike('sd-hb-' + g), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, game, g % 3 ? '1-0' : '1/2-1/2', 0, transcript),
      oppProfile: { name: 'Opp ' + g },
    })
    t += 60_000
    chain = attachLast(A.appendWitnessed(chain, dev.priv, dev.pubB, 'segment', payload, t), w, t + 500)
    segEvOfGame.push(chain.events[chain.events.length - 1])
    if (g % 6 === 0) {
      const ck = A.makeCheckpointEvent(chain, dev.priv, dev.pubB, t + 700)
      const atts = wits.slice(0, 5).map((cw, i) => W.cosignCheckpoint(ck, chain, cw.pubB, cw.priv, t + 700 + i))
      chain = A.appendEvent(chain, { body: ck.body, sig: ck.sig, wit: atts })
    }
  }
  const vrOrig = A.verifyChain(chain)
  ok(vrOrig.ok, 'the owner chain fully verifies (fixture sanity)')
  const headEv = chain.events.filter((e) => e.body.lane === 'w').reduce((a, e) => (e.body.height > a.body.height ? e : a))
  ok(headEv.body.type === 'ckpt' && headEv.body.key === dev.pubB, 'the head is a device-signed cosigned checkpoint (finalSync-signable)')
  const certsX = A.certsProving(owner.pubB, chain.events, [dev.pubB])
  const chainBytes = A.chainToBytes(chain)
  const witnessedAll = chain.events.filter((e) => e.body.lane === 'w')
  now = t + 1_000_000

  // ==========================================================================
  console.log('\n· 1. makeStorageDutyGate, the composed overlay store-accept gate …')
  // ==========================================================================
  {
    const gkp = kpOf('sd-gate-carrier')
    const gnid = W.nodeIdOf(gkp.pub)
    const gfab = new W.MockFabric({ staleAfterMs: 3 * 3_600_000 })
    const gep = gfab.endpoint(gnid)
    gep.announce(W.signPresence({ v: 1, root: gkp.pubB, key: gkp.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: PARAMS_A3_DIGEST, ts: now, uptimePct: 99 }, gkp.priv))
    const gate = D.makeStorageDutyGate({ shardMb: 50, directory: () => gep.directory(), nowMs: () => now, capPerKey: CAP, verify: GEO })
    ok(typeof gate.validator === 'function' && typeof gate.merge === 'function', 'the gate exposes a composed validator + merge for createOverlayNode')
    eq(gate.usedBytes(), 0, 'a fresh gate has used 0 bytes')
    eq(gate.subjects().length, 0, 'a fresh gate holds rows for no subjects')

    // A real shard envelope of the owner's chain (suite geometry).
    const hdr = S.cutSnapshot(chain, headEv, certsX, dev.priv, GEO)
    const envs = S.shardJob(hdr, chainBytes)
    const subjNid = W.nodeIdOf(owner.pub)
    const key3 = S.shardKey(subjNid, 3)
    ok(gate.validator(gnid, key3, 'shard', envs[3]), 'accepts a valid shard row stored at its own shardKey(subject, idx)')
    ok(gate.usedBytes() > 0 && gate.subjects().length === 1 && gate.subjects()[0] === subjNid, 'accounting: usedBytes advances and subjects() lists the subject (the repair worklist)')
    ok(!gate.validator(gnid, S.shardKey(subjNid, 4), 'shard', envs[3]), 'refuses a shard row stored under the WRONG idx key (would poison a foreign slot)')
    const poison = clone(envs[5]); poison.shard.body = b64(new Uint8Array(A.fromB64u(poison.shard.body).length)) // zeroed body ≠ committed bodyHash
    ok(!gate.validator(gnid, S.shardKey(subjNid, 5), 'shard', poison), 'refuses a body-flipped shard row (per-row bodyHash commitment)')
    ok(gate.validator(gnid, idLike('sd-gen-rec'), 'record', { v: 1, x: 1 }), 'the composed base still accepts the overlay generic record class (composition preserves the default gate)')

    // A budgeted gate refuses over its advertised capacity (honest degradation).
    const oneEnvBytes = A.canonicalBytes(envs[0]).length
    const tiny = D.makeStorageDutyGate({ shardMb: 50, budgetBytes: oneEnvBytes + 1, directory: () => gep.directory(), nowMs: () => now, verify: GEO })
    ok(tiny.validator(gnid, S.shardKey(subjNid, 0), 'shard', envs[0]), 'a budgeted gate accepts the first row within budget')
    ok(!tiny.validator(gnid, S.shardKey(subjNid, 1), 'shard', envs[1]), 'a budgeted gate REFUSES the row that would exceed the advertised §11 capacity (honest, not a crash)')
    await gep.close()
  }

  // ==========================================================================
  console.log('\n· 2. THE M3 ACCEPTANCE SLICE. Publish → owner offline → reconstruct …')
  // ==========================================================================
  const fabric = new W.MockFabric({ staleAfterMs: 3 * 3_600_000 })
  const subjNid = W.nodeIdOf(owner.pub)
  const alive = new Set()
  function mkNode(tag, rootKp, keyKp, shardMb, replicateK) {
    const nodeId = W.nodeIdOf(rootKp.pub)
    const ep = fabric.endpoint(nodeId)
    const sp = () => W.signPresence(
      { v: 1, root: rootKp.pubB, key: keyKp.pubB, caps: { witness: true, committee: true, shardMb }, params: PARAMS_A3_DIGEST, ts: now, uptimePct: 99 },
      keyKp.priv,
    )
    ep.announce(sp())
    const gate = D.makeStorageDutyGate({ shardMb, directory: () => ep.directory(), nowMs: () => now, capPerKey: CAP, verify: GEO })
    const node = O.createOverlayNode(ep, { root: rootKp.pubB, key: keyKp.pubB }, {
      nowMs: () => now, validator: gate.validator, merge: gate.merge, ...(replicateK ? { replicateK } : {}),
    })
    const rec = { tag, root: rootKp, key: keyKp, nodeId, ep, node, gate, announce: () => ep.announce(sp()) }
    alive.add(rec)
    return rec
  }
  const kill = async (rec) => { alive.delete(rec); await rec.node.close(); await rec.ep.close() }

  const CARRIERS = 24
  const carriers = Array.from({ length: CARRIERS }, (_, i) => mkNode('carrier-' + i, kpOf('sd-carrier-' + i), kpOf('sd-carrier-' + i), 50, 3))
  // The owner is a PHONE: advertises no shard capacity (shardMb 0 → refuses its
  // OWN rows), and finalSyncs with a NARROW replicateK so each row lands on only
  // 1-2 carriers: the thin spread over a wide fleet makes churn (and the
  // below-K_rec collapse) deterministically controllable.
  let ownerNode = mkNode('owner', owner, dev, 0, 2)
  const seedsFor = (i) =>
    [0, 1, 2, 5, 8, 11, 13]
      .map((d) => carriers[(i + d) % CARRIERS])
      .map((c) => c.ep.directory().nodes.get(c.nodeId))
      .filter(Boolean)
  for (let i = 0; i < CARRIERS; i++) await carriers[i].node.bootstrap(seedsFor(i))
  await ownerNode.node.bootstrap(seedsFor(0))

  // publish-on-write: replicate the witnessed lane (the guaranteed floor).
  let evStored = 0
  for (const ev of witnessedAll) evStored += await D.publishWitnessedWrite(ownerNode.node, signing, chain, ev)
  ok(evStored > 0, `publish-on-write replicated the witnessed events onto the fleet (${evStored} stores)`)

  // final sync: shard the full chain to shard space + a self chain pointer.
  const fs = await D.finalSyncOwnChain(ownerNode.node, signing, chain, { ...GEO, nowMs: now })
  ok(fs.ok, 'finalSyncOwnChain succeeded (device-signed head is finalSync-signable)')
  eq(fs.header.n, GEO.n, `finalSync cut the ${GEO.n}-shard geometry`)
  eq(fs.liveRows, GEO.n, 'every shard row landed on ≥1 carrier (owner refused its own: the network IS the storage)')
  ok(fs.chainPointerStored > 0, 'the self chain pointer (embedded head proof) landed: it pins the head even owner-gone')

  const rowKeys = Array.from({ length: GEO.n }, (_, i) => S.shardKey(subjNid, i))
  const holdersOfRow = (idx) => [...alive].filter((n) => n.node.localGet(rowKeys[idx], 'shard') !== null)
  const liveRowCount = () => rowKeys.reduce((acc, _, i) => acc + (holdersOfRow(i).length > 0 ? 1 : 0), 0)
  eq(liveRowCount(), GEO.n, 'all shard rows live in shard space after final sync')

  // carriers publish authenticated shard pointers for the rows they are on duty for.
  let shardPtrs = 0
  for (const c of carriers) {
    shardPtrs += await D.publishHeldShardPointers(c.node, { root: c.root.pubB, key: c.root.pubB, priv: c.root.priv }, { root: c.root.pubB, events: [] }, {
      directory: c.ep.directory(), nowMs: now, subjects: c.gate.subjects(), verify: GEO,
    })
  }
  ok(shardPtrs > 0, `duty carriers published authenticated shard pointers (${shardPtrs} rows enumerable)`)

  // An entanglement partner (opp of game 1) publishes a 'segment' pointer under
  // the owner's key from the owner's OWN segment event that names them (§5).
  const opp1 = mkNode('opp1', kpOf('sd-opp-1'), kpOf('sd-opp-1'), 50, 3)
  await opp1.node.bootstrap(seedsFor(4))
  const segPtr = await D.publishSegmentPointerFor(
    opp1.node, { root: opp1.root.pubB, key: opp1.root.pubB, priv: opp1.root.priv }, { root: opp1.root.pubB, events: [] },
    { subject: owner.pubB, event: segEvOfGame[0], certs: certsX, nowMs: now },
  )
  ok(segPtr > 0, 'a real entanglement partner published a segment pointer under the owner key (publishSegmentPointerFor)')

  // A poisoning attacker: replaying the owner's OWN segment event (which names a
  // real opponent, not the attacker) as "I hold a segment of X" must land NOWHERE.
  // The naming rule (segment.opp === holder) is re-checked at every gate.
  {
    const atk = mkNode('attacker', kpOf('sd-atk'), kpOf('sd-atk'), 50, 3)
    await atk.node.bootstrap(seedsFor(3))
    const stolen = { v: 1, subject: owner.pubB, holder: atk.root.pubB, key: atk.root.pubB, kind: 'segment', hash: A.eventId(segEvOfGame[0].body), ts: now, proof: { event: segEvOfGame[0], certs: certsX }, holderCerts: [] }
    eq(await atk.node.put(S.pointerKeyOfRoot(owner.pubB), 'pointers', { v: 1, ptrs: [mint(stolen, atk.root.priv)] }), 0,
      'a stranger replaying the subject’s segment proof stores NOWHERE (every gate re-checks opp === holder)')
    await kill(atk)
  }

  // THE OWNER LEAVES FOREVER.
  await kill(ownerNode)
  ownerNode = null
  eq(liveRowCount(), GEO.n, 'shard space is intact without the owner')

  // A FRESH viewer reconstructs from shard space alone.
  const viewer = mkNode('viewer', kpOf('sd-viewer'), kpOf('sd-viewer'), 50, 3)
  await viewer.node.bootstrap(seedsFor(6))
  const resolveOpts = () => ({ directory: viewer.ep.directory(), nowMs: now, cosig: { eligible, rule: RULE }, spot: { p: 1, roll: 0 }, shard: GEO })
  // Re-seed the viewer's routing table from the CURRENT live fleet. After heavy
  // churn its table is full of dead contacts; a live viewer re-bootstraps as the
  // topology changes (the browser does this on its presence heartbeat).
  const reseedViewer = () => viewer.node.bootstrap([...alive].filter((n) => n !== viewer).map((n) => n.ep.directory().nodes.get(n.nodeId)).filter(Boolean))
  const view = await S.resolveProfile(viewer.node, owner.pubB, resolveOpts())
  eq(view.status, 'expected', 'resolve status: expected (full chain via the live shard layer, owner gone)')
  ok(view.chain !== undefined, 'the full chain reconstructed from shard space')
  eq(shaB(A.chainToBytes(view.chain)), shaB(chainBytes), 'THE M3 PROOF: the reconstructed chain is BIT-FAITHFUL to the original bytes')
  eq(view.head?.id, A.eventId(headEv.body), 'the pinned head is the countersigned original')
  eq(view.ckpt?.id, A.eventId(headEv.body), 'the newest checkpoint is surfaced (it IS the head event)')
  eq(view.ckptInfo?.mOfN, true, 'the checkpoint carries a valid M-of-N cosigner set (A4 pinned input)')
  eq(view.ckptInfo?.verified, 'deep', 'the drawn spot-check re-derived the checkpoint from genesis')
  eq(canon(view.profile), canon(vrOrig.profile), "the profile fold matches the original chain's own fold")
  eq(view.profile.bio, 'reconstructed from live shards', 'LWW profile: the final bio won')
  eq(view.name, 'Shard Duty Subject', 'the genesis display name surfaced')
  eq(view.segments.length, 12, 'all 12 game segments recovered')
  eq(view.sources.viaChain, true, 'sources: reconstruction rode the chain layer')
  ok(view.sources.pointers >= 1, 'sources: the authenticated pointer index enumerated')

  // lazy history pages over the reconstructed view.
  const pager = S.historyFromView(view)
  let pagedGames = 0
  let pagesOk = true
  for (let i = 0; i < pager.pageCount; i++) {
    const p = await pager.page(i)
    if (p.ok) pagedGames += p.games
    else pagesOk = false
  }
  ok(pagesOk, 'every lazy history page verifies against the pinned head')
  eq(pagedGames, 12, 'the pages deliver all 12 games exactly once')

  // ==========================================================================
  console.log('\n· 3. honest degradation (C-8): below K_rec → unavailability → runRepair HEALS …')
  // ==========================================================================
  // Snapshot every row envelope for the rejoin (downtime, not loss).
  const diskRows = new Map()
  for (let idx = 0; idx < GEO.n; idx++) {
    const h = holdersOfRow(idx)[0]
    if (h) diskRows.set(idx, clone(h.node.localGet(rowKeys[idx], 'shard')))
  }

  // --- 3a. partial churn (≥ K_rec live): the viewer still reconstructs --------
  const killable = carriers.filter((c) => alive.has(c)).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))
  let ki = 0
  while (liveRowCount() === GEO.n && ki < killable.length) await kill(killable[ki++]) // drop ≥1 row
  const partialLive = liveRowCount()
  ok(partialLive >= GEO.k && partialLive < GEO.n, `partial churn: live rows fell to ${partialLive} (≥ K_rec=${GEO.k}, < ${GEO.n})`)
  now += 60_000
  for (const n of alive) n.announce()
  const viewP = await S.resolveProfile(viewer.node, owner.pubB, resolveOpts())
  eq(viewP.status, 'expected', 'partial churn: any K_rec rows still reconstruct the full chain (erasure tolerance)')
  eq(shaB(A.chainToBytes(viewP.chain)), shaB(chainBytes), '…bit-faithful from the surviving rows')

  // --- 3b. runShardRepair re-encodes + redistributes the lost rows -----------
  const joiners = Array.from({ length: 6 }, (_, i) => mkNode('joiner-' + i, kpOf('sd-join-' + i), kpOf('sd-join-' + i), 50, 6))
  for (const j of joiners) await j.node.bootstrap([...alive].filter((n) => n !== j).slice(0, 7).map((n) => n.ep.directory().nodes.get(n.nodeId)))
  now += 60_000
  for (const n of alive) n.announce()
  const repairer = [...alive].find((n) => n.gate.subjects().includes(subjNid))
  ok(repairer !== undefined, 'a surviving on-duty carrier exists to run the repair tick')
  const actions = await D.runShardRepair({ node: repairer.node, directory: repairer.ep.directory(), subjects: repairer.gate.subjects(), nowMs: now, repair: { ...GEO, dutyK: PARAMS_A3.dutyK } })
  const act = actions.find((a) => a.subject === subjNid)
  ok(act && (act.outcome === 'healed' || act.outcome === 'healthy'), `runShardRepair scanned the subject and healed/was-healthy (${act?.outcome})`)
  eq(liveRowCount(), GEO.n, 'runShardRepair redistributed the lost rows, full width restored (churn = healed)')
  const viewH = await S.resolveProfile(viewer.node, owner.pubB, resolveOpts())
  eq(viewH.status, 'expected', 'after repair the viewer reconstructs at full width')
  eq(shaB(A.chainToBytes(viewH.chain)), shaB(chainBytes), '…still bit-faithful')

  // --- 3c. drop BELOW K_rec: honest typed unavailability, never a fake profile.
  // The lightweight authenticated pointer index (at pointerKey(owner), a DIFFERENT
  // neighborhood than the shardKeys) is far more durable than the heavy shard
  // rows, so preserve ONE pointer holder (the one carrying the fewest shard
  // rows) and kill the rest: shard space collapses below K_rec while the pointer
  // floor (embedded head proof) survives. That is the realistic degraded case.
  const ptrKey = S.pointerKeyOfRoot(owner.pubB)
  const isPtrHolder = (n) => n.node.localGet(ptrKey, 'pointers') !== null
  const shardRowsHeld = (n) => rowKeys.reduce((acc, k) => acc + (n.node.localGet(k, 'shard') !== null ? 1 : 0), 0)
  const ptrHolders = [...alive].filter((n) => n !== viewer && isPtrHolder(n)).sort((a, b) => shardRowsHeld(a) - shardRowsHeld(b))
  ok(ptrHolders.length > 0, 'sanity: the authenticated pointer index has surviving holders')
  const keep = ptrHolders[0]
  for (const n of [...alive]) if (n !== viewer && n !== keep) await kill(n)
  const deadLive = liveRowCount()
  ok(deadLive < GEO.k, `shard space collapsed to ${deadLive} live rows. Below K_rec=${GEO.k} (only the pointer floor survives)`)
  now += 60_000
  for (const n of alive) n.announce()
  await reseedViewer()
  const viewD = await S.resolveProfile(viewer.node, owner.pubB, resolveOpts())
  eq(viewD.status, 'floor', 'below K_rec: resolve DEGRADES to the guaranteed floor (never wrong/partial bytes)')
  ok(viewD.chain === undefined, 'no chain is served on the floor (honest, not a fabricated profile)')
  ok(viewD.shardReport.reason === 'below-k' || viewD.shardReport.reason === 'no-rows', `the failure is TYPED temporary unavailability (${viewD.shardReport.reason})`)
  eq(viewD.head?.id, A.eventId(headEv.body), 'the countersigned head STILL pins on the floor (the surviving pointer’s embedded head proof)')

  // --- 3d. carriers RETURN (downtime, not loss) → reconstruction HEALS --------
  now += 60_000
  const revived = []
  for (let idx = 0; idx < GEO.n && liveRowCount() < GEO.k + 1; idx++) {
    if (!diskRows.has(idx)) continue
    const rk = kpOf('sd-revive-' + idx)
    const rj = mkNode('revive-' + idx, rk, rk, 50, 4)
    await rj.node.bootstrap([...alive].filter((n) => n !== rj).slice(0, 7).map((n) => n.ep.directory().nodes.get(n.nodeId)))
    // The returning carrier re-offers its disk rows through its OWN gate (re-verified).
    for (let j = 0; j < GEO.n; j++) if (diskRows.has(j)) rj.node.localPut(rowKeys[j], 'shard', diskRows.get(j))
    revived.push(rj)
  }
  now += 60_000
  for (const n of alive) n.announce()
  await reseedViewer()
  ok(liveRowCount() >= GEO.k, `returning carriers restored live rows to ${liveRowCount()} (≥ K_rec)`)
  const viewR = await S.resolveProfile(viewer.node, owner.pubB, resolveOpts())
  eq(viewR.status, 'expected', 'HEALED: once ≥ K_rec rows return, reconstruction succeeds again. Unavailability was TEMPORARY')
  eq(shaB(A.chainToBytes(viewR.chain)), shaB(chainBytes), 'FINAL: bit-faithful after die → floor → return, NEVER silent loss')

  // ==========================================================================
  console.log('\n· 4. kvStore, the §11 per-platform budget with LRU eviction …')
  // ==========================================================================
  {
    eq(KV.budgetBytesForPlatform('desktop'), PARAMS_A3.budgetDesktopMb * 1024 * 1024, 'desktop budget = 200 MB (§11)')
    eq(KV.budgetBytesForPlatform('desktop-browser'), PARAMS_A3.budgetBrowserMb * 1024 * 1024, 'desktop-browser budget = 50 MB (§11, with persist())')
    eq(KV.budgetBytesForPlatform('mobile'), PARAMS_A3.budgetMobileMb * 1024 * 1024, 'mobile budget = 15 MB (§11)')

    // Equal-size values; budget holds exactly 3 → the 4th evicts the LRU (oldest).
    const val = (tag) => ({ v: 1, blob: tag.repeat(20) })
    const oneBytes = A.canonicalBytes(val('aa')).length
    const evicted = []
    const store = KV.createMemoryKvStore({ budgetBytes: oneBytes * 3, onEvict: (k) => evicted.push(k) })
    await store.put('k|a', val('aa'))
    await store.put('k|b', val('bb'))
    await store.put('k|c', val('cc'))
    eq(await store.count(), 3, 'three values fit within the budget')
    ok((await store.bytes()) <= oneBytes * 3, 'bytes() is within the budget (exact §11 accounting)')
    await store.put('k|d', val('dd')) // over budget → evict LRU
    eq(evicted.join(','), 'k|a', 'the LEAST-recently-used key was evicted (onEvict fired)')
    eq(await store.has('k|a'), false, 'the evicted key is gone (eviction = churn; the shard layer re-replicates)')
    ok((await store.has('k|d')) && (await store.has('k|c')) && (await store.has('k|b')), 'the newest three survive')
    ok((await store.bytes()) <= oneBytes * 3, 'the store stays within budget after eviction')

    // get counts as a USE: touching 'k|b' spares it from the next eviction.
    await store.get('k|b')
    await store.put('k|e', val('ee')) // evicts the now-LRU 'k|c', not the touched 'k|b'
    eq(evicted[evicted.length - 1], 'k|c', 'a read makes a key most-recently-used (get-as-use protects it from eviction)')
    ok(await store.has('k|b'), 'the read-touched key survived the eviction')

    // Unbounded (no budget) is byte-identical back-compat: nothing is ever evicted.
    const unb = KV.createMemoryKvStore()
    let wantBytes = 0
    for (let i = 0; i < 50; i++) {
      const v = { v: 1, blob: 'x'.repeat(40), i }
      wantBytes += A.canonicalBytes(v).length
      await unb.put('u|' + i, v)
    }
    eq(await unb.count(), 50, 'an unbounded store never evicts (default back-compat)')
    eq(await unb.bytes(), wantBytes, 'unbounded bytes() sums every value exactly')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
