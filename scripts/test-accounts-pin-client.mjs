// THE A6-M4 LANE L-pin SUITE: the LIVE tOPRF PIN committee over the account
// peer overlay (src/renderer/src/features/account/net/pinClient.ts, spec §1),
// headless over an in-process MockFabric committee.
//
//   node scripts/test-accounts-pin-client.mjs
//
// pinClient is fabric-agnostic: the same orchestration that runs over Lane A's
// browser fabric in production runs here over a MockFabric bus of real account
// peers (each `memberServe` registered by peerService, exactly as in prod). The
// crypto is the tested shared substrate. This suite proves the WIRING:
//   1. draw a distance-ranked pinN-of committee from live presence;
//   2. provision Shamir shares to it + root-sign the PIN record (verifies);
//   3. verify a correct PIN via the threshold OPRF (net-zero counter);
//   4. a WRONG-PIN streak increments the replicated committee counter and, at the
//      lifetime cap (not before), trips a threshold-signed fuse that verifies;
//   5. a fuse-banned root is REFUSED witnessed-zone entry (honest members refuse
//      to serve: the committee enforces the ban, not one client-side gate);
//   6. the UI-facing controller: provision → 'set', wrong bumps the meter,
//      correct passes, a loaded fuse → 'banned'; honest degradation with < pinN
//      committee-capable machines and with no controller live (no fixtures).
//
// House style: esbuild-bundle on the fly (alias @shared; net modules by abs
// path), one-line asserts, exit(1) on any fail.

import { resolve } from 'node:path'
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { bundleAndImport, makeOutdir, ROOT } from './lib/witness-bundle.mjs'

const nodeSha256 = (buf) => createHash('sha256').update(buf).digest()

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
export * as W from '@shared/accounts/witness'
export * as H from '@shared/accounts/hash'
export * as P from '${NET}/peerService'
export * as PC from '${NET}/pinClient'
`

async function main() {
  const outdir = makeOutdir('accounts-pin-client-test')
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
  const { W, H, P, PC } = M
  const NOW = 1_750_000_000_000
  const PARAMS = W.PARAMS_A2

  // ---- seeded rng: sha256(seed || counter) stream (reproducible) --------------
  function seededRng(seedStr) {
    let ctr = 0
    const seed = H.utf8(seedStr)
    let buf = new Uint8Array(0)
    const refill = () => {
      const c = new Uint8Array(4)
      new DataView(c.buffer).setUint32(0, ctr++, false)
      const chunk = nodeSha256(Buffer.concat([Buffer.from(seed), Buffer.from(c)]))
      buf = new Uint8Array([...buf, ...chunk])
    }
    return (n) => {
      while (buf.length < n) refill()
      const out = buf.slice(0, n)
      buf = buf.slice(n)
      return out
    }
  }

  const kpOf = (tag) => {
    const priv = H.sha256(H.utf8(tag))
    const pub = H.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: H.toB64u(pub) }
  }
  const makeIdentity = (tag) => {
    const rootKp = kpOf('pin-root-' + tag)
    const devKp = kpOf('pin-dev-' + tag)
    const nodeId = W.nodeIdOf(rootKp.pubB)
    return { tag, rootKp, devKp, nodeId, identity: { root: rootKp.pubB, key: devKp.pubB, priv: devKp.priv } }
  }

  // A shared fuse view: memberServe consults it before serving pin-eval, so a
  // fuse-banned root is refused BY THE COMMITTEE (spec §1), not one member's
  // word. Empty until a fuse is genuinely tripped + published.
  const fuseStore = new Map()
  const fuseOf = (root) => fuseStore.get(root) ?? null

  const bus = new W.MockFabric()

  // Mint pinN committee-member peers (each runs memberServe via peerService).
  const memberSpecs = Array.from({ length: PARAMS.pinN }, (_, i) => makeIdentity('member-' + i))
  const memberPeers = []
  for (const s of memberSpecs) {
    memberPeers.push(
      await P.startAccountPeer({
        identity: s.identity,
        fabric: bus.endpoint(s.nodeId),
        now: () => NOW,
        platform: 'desktop-browser',
        autoBootstrap: false,
        fuseOf,
      }),
    )
  }

  // The account setting up a PIN: its own peer over the same bus.
  const clientSpec = makeIdentity('client-A')
  const clientPeer = await P.startAccountPeer({
    identity: clientSpec.identity,
    fabric: bus.endpoint(clientSpec.nodeId),
    now: () => NOW,
    platform: 'desktop-browser',
    autoBootstrap: false,
    fuseOf,
  })
  const rootA = clientSpec.identity.root
  const signerA = { root: rootA, rootPriv: clientSpec.rootKp.priv }

  // ==========================================================================
  console.log('\n· 1. draw the committee by key-distance from live presence …')
  // ==========================================================================
  const draw = PC.drawPinCommittee(clientPeer.fabric.directory(), rootA, NOW)
  eq(draw.members.length, PARAMS.pinN, `drew a full ${PARAMS.pinN}-member committee from the directory`)
  ok(draw.enough, 'draw reports enough committee-capable machines reachable')
  ok(!draw.members.includes(clientSpec.nodeId), 'the account never draws ITSELF into its own committee')
  ok(
    draw.members.every((m) => memberSpecs.some((s) => s.nodeId === m)),
    'every drawn seat is a live committee-capable peer',
  )
  ok(
    draw.members.every((m) => draw.keyOf.get(m) === memberSpecs.find((s) => s.nodeId === m).identity.key),
    'each seat binds to its advertised device signing key (from verified presence)',
  )

  // ==========================================================================
  console.log('\n· 2. provision shares + root-sign the PIN record …')
  // ==========================================================================
  const PIN = '2468'
  const WRONG = '1357'
  const prov = await PC.provisionPinCommittee({
    fabric: clientPeer.fabric,
    signer: signerA,
    pin: PIN,
    committee: draw.members,
    rng: seededRng('provision-A'),
  })
  ok(prov.ok, 'provisionPinCommittee succeeds over the live committee')
  eq(prov.provisioned.length, PARAMS.pinN, `all ${PARAMS.pinN} members accepted their share`)
  ok(W.verifyPinRecord(prov.record).ok, 'the provisioned PIN record verifies standalone (root sig + params + shape)')
  eq(prov.record.payload.committee.length, PARAMS.pinN, 'the record commits to the full committee')
  eq(prov.record.payload.t, PARAMS.pinT, `the record threshold is pinT (${PARAMS.pinT})`)
  eq(prov.record.root, rootA, 'the record is signed under the account root')
  const recordA = prov.record

  // A wrong-shaped committee (too small) is refused honestly (no fake provision).
  const short = await PC.provisionPinCommittee({
    fabric: clientPeer.fabric,
    signer: signerA,
    pin: PIN,
    committee: draw.members.slice(0, 5),
    rng: seededRng('provision-short'),
  })
  ok(!short.ok && short.reason === 'committee-incomplete', 'provisioning refuses an under-size committee (honest degradation)')

  // ==========================================================================
  console.log('\n· 3. verify a correct PIN via the threshold OPRF (net-zero) …')
  // ==========================================================================
  const good = await PC.verifyPinAgainstCommittee({
    fabric: clientPeer.fabric,
    root: rootA,
    pin: PIN,
    record: recordA,
    wts: NOW,
    rng: seededRng('verify-good'),
  })
  ok(good.ok, 'the correct PIN verifies against the committee')
  eq(good.pinPub, recordA.payload.pinPub, 'the derived pinPub equals the committee’s published pinPub')

  const keyOfA = draw.keyOf
  const countAfterGood = await PC.readCommitteeCount(clientPeer.fabric, rootA, recordA.payload.committee, keyOfA)
  eq(countAfterGood, 0, 'a proven success leaves the committee counter at 0 (net-zero, C-2)')

  // ==========================================================================
  console.log('\n· 4. a wrong-PIN streak increments the replicated counter …')
  // ==========================================================================
  // Drive 99 wrong attempts; the committee counter must climb to exactly 99 and
  // the fuse must NOT be due yet.
  for (let k = 0; k < PARAMS.pinLifetimeFails - 1; k++) {
    const r = await PC.verifyPinAgainstCommittee({
      fabric: clientPeer.fabric,
      root: rootA,
      pin: WRONG,
      record: recordA,
      wts: NOW,
      rng: seededRng('wrong-' + k),
    })
    if (r.ok || r.reason !== 'wrong-pin') {
      ok(false, `wrong attempt ${k} should report wrong-pin (got ${JSON.stringify(r)})`)
      break
    }
  }
  const count99 = await PC.readCommitteeCount(clientPeer.fabric, rootA, recordA.payload.committee, keyOfA)
  eq(count99, PARAMS.pinLifetimeFails - 1, `after 99 wrong attempts the committee-effective count is ${PARAMS.pinLifetimeFails - 1}`)
  const notDue = await PC.tripFuseIfCapped({ fabric: clientPeer.fabric, root: rootA, record: recordA, keyOf: keyOfA, wts: NOW })
  eq(notDue, null, 'the fuse does NOT trip below the lifetime cap (99 < 100)')

  // ==========================================================================
  console.log('\n· 5. the 100th failure trips a threshold-signed fuse …')
  // ==========================================================================
  const at100 = await PC.verifyPinAgainstCommittee({
    fabric: clientPeer.fabric,
    root: rootA,
    pin: WRONG,
    record: recordA,
    wts: NOW,
    rng: seededRng('wrong-100'),
  })
  ok(!at100.ok && at100.reason === 'wrong-pin', 'the 100th wrong attempt still reports wrong-pin')
  const count100 = await PC.readCommitteeCount(clientPeer.fabric, rootA, recordA.payload.committee, keyOfA)
  eq(count100, PARAMS.pinLifetimeFails, `the committee-effective count reaches the lifetime cap (${PARAMS.pinLifetimeFails})`)

  const fuse = await PC.tripFuseIfCapped({ fabric: clientPeer.fabric, root: rootA, record: recordA, keyOf: keyOfA, wts: NOW })
  ok(fuse !== null, 'tripFuseIfCapped returns a fuse record at the cap')
  ok(W.verifyFuseRecord(fuse, recordA.payload.committee, keyOfA).ok, 'the fuse record verifies (≥ pinT valid committee signatures over the body)')
  eq(fuse.body.fails, PARAMS.pinLifetimeFails, 'the fuse body records exactly the cap count')
  eq(fuse.body.root, rootA, 'the fuse binds to the account root')
  eq(fuse.body.pinRecord, W.pinRecordId(recordA.payload), 'the fuse binds to the account’s current PIN record')
  eq(fuse.body.expiryWts, NOW + PARAMS.pinBanDays * 86_400_000, 'the ban window is pinBanDays wide (witnessed time)')
  ok(W.isFuseActive(fuse, NOW), 'the fuse is active at the trip time')
  const fv = PC.fuseViewOf(fuse)
  ok(fv.signers >= PARAMS.pinT && fv.fails === PARAMS.pinLifetimeFails, 'the UI fuse view carries the real signer count + fail total')

  // ==========================================================================
  console.log('\n· 6. a fuse-banned root is REFUSED witnessed-zone entry …')
  // ==========================================================================
  // Publish the fuse into the shared view the committee consults. Honest
  // members now refuse to serve, so even the CORRECT PIN cannot reach a quorum.
  fuseStore.set(rootA, fuse)
  const banned = await PC.verifyPinAgainstCommittee({
    fabric: clientPeer.fabric,
    root: rootA,
    pin: PIN,
    record: recordA,
    wts: NOW,
    rng: seededRng('verify-banned'),
  })
  ok(!banned.ok && banned.reason === 'fuse-active', 'a fuse-banned root is refused entry: the committee will not serve (correct PIN or not)')
  // The ban is COMMITTEE-enforced: with the fuse lifted, the correct PIN works again.
  fuseStore.delete(rootA)
  const reopened = await PC.verifyPinAgainstCommittee({
    fabric: clientPeer.fabric,
    root: rootA,
    pin: PIN,
    record: recordA,
    wts: NOW,
    rng: seededRng('verify-reopen'),
  })
  ok(reopened.ok, 'lifting the fuse re-opens the committee (the refusal was the live fuse, not a dead gate)')

  // ==========================================================================
  console.log('\n· 7. the UI-facing controller, provision / meter / banned …')
  // ==========================================================================
  // A fresh account B on the same committee bus, driven through the controller.
  const clientSpecB = makeIdentity('client-B')
  const clientPeerB = await P.startAccountPeer({
    identity: clientSpecB.identity,
    fabric: bus.endpoint(clientSpecB.nodeId),
    now: () => NOW,
    platform: 'desktop-browser',
    autoBootstrap: false,
    fuseOf,
  })
  const rootB = clientSpecB.identity.root
  const signerB = { root: rootB, rootPriv: clientSpecB.rootKp.priv }
  const stored = { record: null }
  const ctlB = PC.createPinClient({
    signer: signerB,
    getPeer: () => clientPeerB,
    now: () => NOW,
    rng: seededRng('controller-B'),
    saveRecord: async (_r, rec) => {
      stored.record = rec
    },
    loadRecord: async () => stored.record,
  })
  await ctlB.refresh()
  eq(ctlB.getState().phase, 'unset', 'controller with a reachable committee + no PIN → phase "unset"')
  ok(ctlB.getState().seats.length === PARAMS.pinN, 'the controller surfaces the drawn committee seats (no fixture)')

  const pr = await ctlB.provision('4242')
  ok(pr.ok, 'controller.provision succeeds over the live committee')
  eq(ctlB.getState().phase, 'set', 'after provisioning the controller phase is "set"')
  ok(ctlB.getState().seats.every((s) => s.provisioned), 'every committee seat shows its share placed')
  ok(stored.record !== null, 'the provisioned record was persisted through the saveRecord hook')

  const wrongB = await ctlB.verify('9999', 'device-witness')
  ok(!wrongB.ok && wrongB.reason === 'wrong-pin', 'controller.verify(wrong) reports wrong-pin')
  ok((ctlB.getState().failures ?? 0) >= 1, 'a wrong attempt moves the controller’s live failure meter')
  const goodB = await ctlB.verify('4242', 'device-witness')
  ok(goodB.ok, 'controller.verify(correct) passes and does not trip the fuse')
  eq(ctlB.getState().phase, 'set', 'a correct verify leaves the account in the "set" (open) state')
  ctlB.stop()

  // Banned controller state: reuse account A's REAL tripped fuse via loadFuse.
  fuseStore.set(rootA, fuse)
  const ctlA = PC.createPinClient({
    signer: signerA,
    getPeer: () => clientPeer,
    now: () => NOW,
    rng: seededRng('controller-A'),
    loadRecord: async () => recordA,
    loadFuse: async () => fuse,
  })
  await ctlA.refresh()
  eq(ctlA.getState().phase, 'banned', 'a controller that loads an active fuse reports phase "banned"')
  ok(ctlA.getState().fuse !== null && ctlA.getState().fuse.fails === PARAMS.pinLifetimeFails, 'the banned controller exposes the real fuse view')
  const bannedVerify = await ctlA.verify(PIN, 'lease-takeover')
  ok(!bannedVerify.ok && bannedVerify.reason === 'fuse-active', 'the banned controller refuses a witnessed-zone verify')
  ctlA.stop()
  fuseStore.delete(rootA)

  // ==========================================================================
  console.log('\n· 8. honest degradation, no committee / no controller …')
  // ==========================================================================
  // A bus with too few committee-capable machines → draw is not "enough".
  const tinyBus = new W.MockFabric()
  const tinySpecs = Array.from({ length: 3 }, (_, i) => makeIdentity('tiny-' + i))
  for (const s of tinySpecs) {
    await P.startAccountPeer({ identity: s.identity, fabric: tinyBus.endpoint(s.nodeId), now: () => NOW, autoBootstrap: false })
  }
  const soloSpec = makeIdentity('tiny-solo')
  const soloPeer = await P.startAccountPeer({ identity: soloSpec.identity, fabric: tinyBus.endpoint(soloSpec.nodeId), now: () => NOW, autoBootstrap: false })
  const tinyDraw = PC.drawPinCommittee(soloPeer.fabric.directory(), soloSpec.identity.root, NOW)
  ok(!tinyDraw.enough, 'a tiny population reports NOT enough committee-capable machines (honest wait)')
  const ctlTiny = PC.createPinClient({ signer: { root: soloSpec.identity.root, rootPriv: soloSpec.rootKp.priv }, getPeer: () => soloPeer, now: () => NOW, rng: seededRng('tiny') })
  await ctlTiny.refresh()
  eq(ctlTiny.getState().phase, 'no-committee', 'the controller surfaces "no-committee" rather than a fake committee')
  const tinyProv = await ctlTiny.provision('1122')
  ok(!tinyProv.ok && tinyProv.reason === 'no-committee', 'provisioning is refused with an honest reason, never a dead/fake button')
  ctlTiny.stop()

  // With no singleton live, the UI surface reports the signed-out default (no fixture).
  eq(PC.getPinClient(), null, 'no PIN client singleton before one is started')
  eq(PC.getPinClientState().phase, 'signed-out', 'getPinClientState() defaults to an honest signed-out state (never a fixture)')
  const noOp = await PC.runPinProvision('1234')
  ok(!noOp.ok, 'runPinProvision with no live client fails honestly (no dead button)')

  // The started singleton drives the same reactive surface the dialogs read.
  let notified = 0
  const unsub = PC.subscribePinClient(() => {
    notified++
  })
  // Account B is provisioned and well below the cap → the singleton reflects a
  // live, open "set" committee (account A is already at the cap and would re-trip).
  const handle = PC.startPinClientSingleton({ signer: signerB, getPeer: () => clientPeerB, now: () => NOW, rng: seededRng('singleton'), loadRecord: async () => stored.record })
  ok(PC.getPinClient() === handle, 'startPinClientSingleton installs the live handle')
  await handle.refresh()
  ok(PC.getPinClientState().phase === 'set', 'the singleton state reflects the live committee (provisioned account)')
  ok(notified > 0, 'subscribers are notified as the singleton state changes')
  PC.stopPinClientSingleton()
  eq(PC.getPinClient(), null, 'stopPinClientSingleton clears the singleton (sign-out)')
  unsub()

  // Tidy up the live peers.
  for (const p of memberPeers) await p.stop()
  await clientPeer.stop()
  await clientPeerB.stop()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
