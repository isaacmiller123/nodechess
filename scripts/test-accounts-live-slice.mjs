// THE A6 M1 SLICE PROOF: one signed, witnessed, RATED game lands in BOTH
// players' chains, headless over MockFabric (spec §3 entanglement, §4 write
// lease, §6 ladders). This is Lane E's acceptance test: the vertical slice of
// the §1 acceptance test at the smallest scale, with injected fakes instead of
// real relays (the lead's playwright smoke is the real-relay half).
//
//   node scripts/test-accounts-live-slice.mjs
//
// The cast (all on ONE in-process MockFabric bus, test-accounts-fabric style):
//   • host  (white): a fresh decentralized account, signed in
//   • guest (black): a fresh decentralized account, signed in
//   • witness:        a third machine running witnessServe (NEITHER player)
//
// The flow, end to end, exactly as the live app will run it:
//   1. host + guest each publish a SIGNED pre-game snapshot; each verifies the
//      other's over the fabric `pregame-snapshot` channel (preGame.ts). Two
//      FRESH accounts ⇒ each snapshot correctly OMITS its checkpoint (§6 young
//      -opponent seeds path).
//   2. a real WitnessCore (the pure §3 brain) follows the signed move chain and
//      signs the terminal stream, the `wstream` both players embed.
//   3. each player runs buildAndPublishSegment (segmentWriter.ts): gather a
//      write lease from the canonical witness set (1-witness ⇒ threshold floors
//      to 1), append the `segment` under it with the witness's non-player
//      attestation, re-fold.
//   4. PROOF: both chains carry MATCHING rated segments; verifySegmentEvent ===
//      null on both; verifyChain green on both; the a4 fold moves BOTH ladders
//      off the 1200 seed (winner up, loser down).
//
// Plus the honest-degradation + tamper boundaries: no reachable witness ⇒
// 'insufficient-witnesses' (never a dead grant, C-10); a flipped/mis-keyed
// snapshot signature is refused; a segment whose opp snapshot names the wrong
// root is refused.
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on any fail.

import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT, bundleAndImport, makeOutdir } from './lib/witness-bundle.mjs'

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const SRC = resolve(ROOT, 'src').replace(/\\/g, '/')

// Bundle the shared substrate + the two Lane E modules + the renderer fold, all
// through the one @shared-aliased esbuild pass (the renderer files import only
// @shared paths + a type-only sibling, so they bundle headless).
const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as seg from '@shared/accounts/segment'
export * as wc from '@shared/mp/witnessCore'
export * as writer from '${SRC}/renderer/src/features/account/net/segmentWriter.ts'
export * as pregame from '${SRC}/renderer/src/features/account/net/preGame.ts'
export * as derive from '${SRC}/renderer/src/features/account/store/derive.ts'
`

async function main() {
  const outdir = makeOutdir('accounts-live-slice-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

const SEED_MICRO = 1200 * 1_000_000 // §6 seed rating in micro-Elo
const BLITZ = { baseMs: 300_000, incMs: 0 } // 5+0 ⇒ estMs 300000 ⇒ Blitz
const LADDER = 'chess:Blitz'

async function run(M) {
  const { A, W, seg, wc, writer, pregame, derive } = M
  const { PARAMS_A2_DIGEST } = W
  const NOW = 1_700_000_000_000

  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  const seedBytes = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b * 7 + i) & 0xff)

  // A player: fresh account chain (genesis + device-0 cert) + a fabric endpoint.
  // Signs moves + its segment with the certified DEVICE key, identifies by ROOT.
  // Exactly the deviceSigningKey() shape Lane C threads into mp.
  function makePlayer(fabric, seedRoot, seedDev, name) {
    const root = kp(seedRoot)
    const device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    const chain = A.createAccountChain({
      rootPriv: root.priv, rootPub: root.pub, displayName: name, ts: NOW,
      device: { pub: device.pubB, index: 0, label: 'Test device' },
    })
    return { root, device, nodeId, ep, chain, name, signing: { root: root.pubB, key: device.pubB, priv: device.priv } }
  }

  // A witness node: an endpoint running witnessServe (grants leases + attests),
  // announcing presence with the witness cap (§4). The operator peer is exactly
  // this, just always awake.
  function makeWitness(fabric, seedRoot, seedDev) {
    const root = kp(seedRoot)
    const device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    ep.announce(
      W.signPresence(
        { v: 1, root: root.pubB, key: device.pubB, caps: { witness: true, committee: true, shardMb: 200 }, params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 99 },
        device.priv,
      ),
    )
    const store = new W.MemoryWitnessStore()
    const handle = W.witnessServe(ep, { nodeId, key: device.pubB, priv: device.priv }, { store, wts: () => NOW, timeWindowMs: W.PARAMS_A2.timeWindowMs })
    return { root, device, nodeId, ep, store, handle }
  }

  // ==========================================================================
  console.log('\n· 1. two fresh signed-in accounts + one witness on the fabric …')
  // ==========================================================================
  const fabric = new W.MockFabric()
  const host = makePlayer(fabric, 10, 11, 'Hosty')
  const guest = makePlayer(fabric, 20, 21, 'Guesty')
  const witness = makeWitness(fabric, 30, 31)
  ok(A.verifyChain(host.chain).ok && A.verifyChain(guest.chain).ok, 'both fresh account chains verify (genesis + device-0 cert)')
  ok(host.nodeId !== witness.nodeId && guest.nodeId !== witness.nodeId, 'the witness is neither player (§4)')

  // The host-minted global game key binds both ROOTS + a host nonce (§3).
  const GAME = seg.gameKey({ v: 1, t: 'game-key', w: host.root.pubB, b: guest.root.pubB, nonce: A.toB64u(seedBytes(99)), ts: NOW })

  // ==========================================================================
  console.log('\n· 2. signed pre-game snapshot exchange over the fabric (preGame.ts) …')
  // ==========================================================================
  // Each player serves its own live snapshot; a fresh account has no checkpoint.
  const providerFor = (p) =>
    pregame.makeSnapshotProvider({
      chain: () => p.chain,
      signing: p.signing,
      profile: () => ({ name: p.name }),
      now: () => NOW,
    })
  pregame.servePreGame(host.ep, providerFor(host))
  pregame.servePreGame(guest.ep, providerFor(guest))

  const hostGetsGuest = await pregame.requestPreGameSnapshot({ fabric: host.ep, opp: guest.nodeId, game: GAME, selfRoot: host.root.pubB, expectOppRoot: guest.root.pubB })
  const guestGetsHost = await pregame.requestPreGameSnapshot({ fabric: guest.ep, opp: host.nodeId, game: GAME, selfRoot: guest.root.pubB, expectOppRoot: host.root.pubB })
  ok(hostGetsGuest.ok, 'host requested + VERIFIED the guest snapshot (sig, game-bound, opp-bound)')
  ok(guestGetsHost.ok, 'guest requested + VERIFIED the host snapshot')
  eq(hostGetsGuest.snapshot.body.root, guest.root.pubB, 'the guest snapshot is rooted at the guest account')
  eq(hostGetsGuest.snapshot.body.opp, host.root.pubB, 'the guest snapshot is aimed back at the host (direction-bound)')
  eq(hostGetsGuest.snapshot.body.ckpt, undefined, 'FRESH opponent ⇒ snapshot OMITS the checkpoint (§6 young-opponent seeds)')
  eq(guestGetsHost.snapshot.body.ckpt, undefined, 'FRESH opponent ⇒ host snapshot also omits the checkpoint')
  eq(hostGetsGuest.snapshot.body.head, A.witnessedHeadOf(guest.chain.events).id, 'the snapshot carries the guest genesis head (§3 both-heads input)')

  // ==========================================================================
  console.log('\n· 3. a real WitnessCore follows the signed game + signs the stream …')
  // ==========================================================================
  const wclock = { t: NOW }
  const wcore = new wc.WitnessCore({ wpriv: witness.device.priv, wkey: witness.device.pubB, wroot: witness.root.pubB, now: () => wclock.t })
  wcore.init({
    gameId: 1,
    gameKey: GAME,
    players: { w: { root: host.root.pubB, key: host.device.pubB }, b: { root: guest.root.pubB, key: guest.device.pubB } },
    firstMover: 'w',
    kind: 'chess',
    tc: BLITZ,
  })
  const script = [ [host.device, 'e2e4'], [guest.device, 'e7e5'], [host.device, 'g1f3'], [guest.device, 'b8c6'] ]
  let prev
  let allFed = true
  for (let i = 0; i < script.length; i++) {
    const [dev, uci] = script[i]
    const m = seg.signMove(dev.priv, GAME, i, uci, { w: 300_000, b: 300_000 }, prev)
    prev = m.sig
    const r = wcore.feed({ t: 'move', gameId: 1, ply: i, uci, clockMs: { white: m.clockMs.w, black: m.clockMs.b }, sig: m.sig })
    if (!r.ok) allFed = false
  }
  ok(allFed, 'the witness verified all 4 interleaved signed plies (per-move sig chain, §3)')
  eq(wcore.moves.length, 4, 'the witness transcript covers all 4 plies')

  // Guest (black) resigns ⇒ 1-0 (host wins). The LOSER countersigns the terminal
  // (the §3 rage-quit pivot); the witness then signs the rated wend.
  const transcript = seg.transcriptDigest(GAME, wcore.moves, '1-0', wc.REASON_RESIGN)
  const loserEsig = seg.signWitnessEnd(guest.device.priv, guest.device.pubB, GAME, '1-0', wcore.moves.length, transcript).sig
  const endRes = wcore.feed({ t: 'resign', gameId: 1, by: 'black', esig: loserEsig })
  ok(endRes.ok && (endRes.emit ?? []).some((m) => m.t === 'wend'), 'the witness emitted a wend on the loser-signed resignation')
  const wstream = wcore.wstream()
  ok(wstream && wstream.wkey === witness.device.pubB, 'the terminal wstream is signed by the seated witness key')
  ok(
    seg.verifyWitnessEnd(wstream, GAME, '1-0', 4, transcript, { kind: 'chess', tc: BLITZ, players: { w: host.root.pubB, b: guest.root.pubB }, reason: wc.REASON_RESIGN }),
    'the wstream signature verifies over the FULL rated binding (kind/tc/players/reason)',
  )

  // The seated witness identity, as Lane C surfaces it from mp.getWitnessIdentity().
  const witId = { root: witness.root.pubB, key: witness.device.pubB }

  // ==========================================================================
  console.log('\n· 4. each player writes + witnesses its own segment (segmentWriter.ts) …')
  // ==========================================================================
  // The witness runner (Lane D) seeds each player's genesis head into its cache
  // from the pre-game heads: simulated here so the witness can admit the append.
  await witness.handle.seedHead(host.root.pubB, { id: A.witnessedHeadOf(host.chain.events).id, height: 0 })
  await witness.handle.seedHead(guest.root.pubB, { id: A.witnessedHeadOf(guest.chain.events).id, height: 0 })

  const saved = new Map()
  const saveChain = async (root, c) => { saved.set(root, c) }
  const gameView = { gameKey: GAME, players: { w: host.root.pubB, b: guest.root.pubB }, moves: wcore.moves }
  const oppView = (snap) => ({ root: snap.body.root, head: snap.body.head, height: snap.body.height, profile: snap.body.profile, ...(snap.body.ckpt !== undefined ? { ckpt: snap.body.ckpt } : {}) })

  const hostRes = await writer.buildAndPublishSegment({
    fabric: host.ep, chain: host.chain, signing: host.signing, game: gameView,
    color: 'w', result: '1-0', reason: wc.REASON_RESIGN, kind: 'chess', tc: BLITZ,
    wstream: { wkey: witId.key, sig: wstream.sig }, opp: oppView(hostGetsGuest.snapshot), wts: NOW, saveChain,
  })
  const guestRes = await writer.buildAndPublishSegment({
    fabric: guest.ep, chain: guest.chain, signing: guest.signing, game: gameView,
    color: 'b', result: '1-0', reason: wc.REASON_RESIGN, kind: 'chess', tc: BLITZ,
    wstream: { wkey: witId.key, sig: wstream.sig }, opp: oppView(guestGetsHost.snapshot), wts: NOW, saveChain,
  })
  ok(hostRes.ok, 'host gathered a lease + appended its witnessed segment')
  ok(guestRes.ok, 'guest gathered a lease + appended its witnessed segment')

  // ==========================================================================
  console.log('\n· 5. THE PROOF: matching rated segments, both verify, both fold …')
  // ==========================================================================
  eq(seg.verifySegmentEvent(hostRes.event), null, "host chain's segment verifies (verifySegmentEvent === null)")
  eq(seg.verifySegmentEvent(guestRes.event), null, "guest chain's segment verifies (verifySegmentEvent === null)")
  ok(A.verifyChain(hostRes.chain).ok, 'the host chain verifies with the appended segment (verifyChain green)')
  ok(A.verifyChain(guestRes.chain).ok, 'the guest chain verifies with the appended segment (verifyChain green)')

  const hp = hostRes.event.body.payload
  const gp = guestRes.event.body.payload
  eq(hp.game, gp.game, 'both segments name the SAME game key')
  eq(hp.game, GAME, 'the segment game key is the host-minted global game key')
  eq(hp.transcript, gp.transcript, 'both segments carry the SAME transcript digest (§3 pairwise countersigning)')
  eq(hp.wstream.sig, gp.wstream.sig, 'both segments embed the SAME witness terminal signature')
  eq(hp.wstream.sig, wstream.sig, 'the embedded wstream IS the WitnessCore terminal signature')
  eq(hp.color, 'w', 'host segment records the white seat'); eq(gp.color, 'b', 'guest segment records the black seat')
  eq(hp.opp, guest.root.pubB, 'host segment names the guest as opponent'); eq(gp.opp, host.root.pubB, 'guest segment names the host as opponent')
  eq(hp.oppCkpt, undefined, 'host segment OMITS oppCkpt (guest was a young opponent ⇒ §6 seeds)')
  eq(gp.oppCkpt, undefined, 'guest segment OMITS oppCkpt (host was a young opponent ⇒ §6 seeds)')

  // The witness's NON-PLAYER attestation rode the append (spec §4).
  const hostAtts = hostRes.event.wit ?? []
  ok(hostAtts.length >= 1 && hostAtts.every((a) => W.verifyAttestation(a, A.eventId(hostRes.event.body))), 'the host segment carries ≥1 valid witness attestation')
  ok((guestRes.event.wit ?? []).length >= 1, 'the guest segment carries ≥1 valid witness attestation')

  // The a4 fold moved BOTH ladders off the 1200 seed. Winner up, loser down.
  const hostBlitz = hostRes.fold.fold.ladders[LADDER]
  const guestBlitz = guestRes.fold.fold.ladders[LADDER]
  ok(hostBlitz && hostBlitz.n === 1, 'host Blitz ladder folded exactly 1 rated game')
  ok(guestBlitz && guestBlitz.n === 1, 'guest Blitz ladder folded exactly 1 rated game')
  ok(hostBlitz.r !== SEED_MICRO, 'host Blitz rating moved OFF the 1200 seed')
  ok(guestBlitz.r !== SEED_MICRO, 'guest Blitz rating moved OFF the 1200 seed')
  ok(hostBlitz.r > SEED_MICRO, 'host (the winner) rating rose above 1200')
  ok(guestBlitz.r < SEED_MICRO, 'guest (the loser) rating fell below 1200')

  // Both re-folds are byte-consistent with an independent re-derive; persistence ran.
  eq(A.toB64u(A.canonicalHash(derive.foldChainA4(hostRes.chain).fold)), A.toB64u(A.canonicalHash(hostRes.fold.fold)), 'the returned host fold equals an independent re-derive')
  ok(saved.get(host.root.pubB) === hostRes.chain && saved.get(guest.root.pubB) === guestRes.chain, 'both chains were persisted through the injected saveChain port')

  // ==========================================================================
  console.log('\n· 6. honest degradation, no reachable witness ⇒ insufficient-witnesses (C-10) …')
  // ==========================================================================
  const barren = new W.MockFabric() // a fabric where NO witness ever announced
  const soloEp = barren.endpoint(host.nodeId)
  const soloChain = A.createAccountChain({ rootPriv: host.root.priv, rootPub: host.root.pub, displayName: 'Hosty', ts: NOW, device: { pub: host.device.pubB, index: 0, label: 'd' } })
  const degraded = await writer.buildAndPublishSegment({
    fabric: soloEp, chain: soloChain, signing: host.signing, game: gameView,
    color: 'w', result: '1-0', reason: wc.REASON_RESIGN, kind: 'chess', tc: BLITZ,
    wstream: { wkey: witId.key, sig: wstream.sig },
    opp: { root: guest.root.pubB, head: A.witnessedHeadOf(guest.chain.events).id, height: 0, profile: { name: 'Guesty' } },
    wts: NOW,
  })
  eq(degraded.ok, false, 'with no witness reachable the writer does NOT append')
  eq(degraded.reason, 'insufficient-witnesses', 'it degrades honestly (never a dead grant), the rated-play boundary')

  // ==========================================================================
  console.log('\n· 7. tamper boundaries, snapshot signature + opp binding …')
  // ==========================================================================
  const goodSnap = pregame.signPreGameSnapshot(
    { game: GAME, root: host.root.pubB, key: host.device.pubB, opp: guest.root.pubB, head: A.witnessedHeadOf(host.chain.events).id, height: 0, profile: { name: 'Hosty' }, ts: NOW },
    host.device.priv,
  )
  ok(pregame.verifyPreGameSnapshot(goodSnap), 'a well-formed snapshot verifies')
  const flipped = { ...goodSnap, sig: (goodSnap.sig[0] === 'A' ? 'B' : 'A') + goodSnap.sig.slice(1) }
  ok(!pregame.verifyPreGameSnapshot(flipped), 'a flipped snapshot signature is refused (fail-closed)')
  const misKeyed = pregame.signPreGameSnapshot(
    { game: GAME, root: host.root.pubB, key: host.device.pubB, opp: guest.root.pubB, head: A.witnessedHeadOf(host.chain.events).id, height: 0, profile: { name: 'Hosty' }, ts: NOW },
    guest.device.priv, // WRONG key signs a body claiming the host device key
  )
  ok(!pregame.verifyPreGameSnapshot(misKeyed), 'a snapshot whose sig does not match its declared key is refused')

  // A snapshot from the wrong opponent root fails the requester's pin.
  const wrongExpect = await pregame.requestPreGameSnapshot({ fabric: host.ep, opp: guest.nodeId, game: GAME, selfRoot: host.root.pubB, expectOppRoot: witness.root.pubB })
  eq(wrongExpect.ok, false, 'a snapshot from an unexpected opponent root is refused')
  eq(wrongExpect.reason, 'opp-mismatch', 'the requester pins the expected opponent root')

  // The segment writer refuses an opp snapshot that does not match the game seat.
  const badOpp = await writer.buildAndPublishSegment({
    fabric: host.ep, chain: host.chain, signing: host.signing, game: gameView,
    color: 'w', result: '1-0', reason: wc.REASON_RESIGN, kind: 'chess', tc: BLITZ,
    wstream: { wkey: witId.key, sig: wstream.sig },
    opp: { root: witness.root.pubB, head: A.witnessedHeadOf(host.chain.events).id, height: 0, profile: { name: 'X' } },
    wts: NOW,
  })
  eq(badOpp.ok, false, 'the writer refuses an opp snapshot whose root is not the game opponent')
  eq(badOpp.reason, 'opp-root-mismatch', 'the mismatch is named precisely')

  witness.ep.close()
  host.ep.close()
  guest.ep.close()
}

main()
