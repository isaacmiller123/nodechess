// THE A6 M2 LEASE + PAIRING PROOF — the live write-lease lifecycle (spec §4) and
// the REAL witnessed 'pairing' record (spec §3/§8) that arms the witness's rated
// gate, headless over MockFabric. This is the L-lease lane's acceptance test: the
// slice of the §1 acceptance test that proves single-writer discipline + pairing
// anchoring at the smallest scale, with injected fakes instead of real relays
// (the lead's playwright smoke is the real-relay half).
//
//   node scripts/test-accounts-lease-runner.mjs
//
// The cast (all on ONE in-process MockFabric bus, test-accounts-lease style):
//   • host / guest accounts — fresh decentralized accounts, signed in
//   • host device A / device B — TWO devices of the SAME account (one root)
//   • 16 witness nodes — a full canonical set (tLease = 9), NEITHER player
//
// The proofs:
//   1. a T_lease lease HELD AT ONE EPOCH — leaseRunner gathers ≥ tLease grants at
//      epoch 1, verifyLease green; heartbeat renews the SAME epoch (a same-device
//      re-grant, still green); acquire is idempotent while held.
//   2. a SECOND device is refused 'playing-elsewhere' — device B, seeing device A
//      authored the live head, refuses to grab a conflicting lease; a PIN-gated
//      takeover then advances the epoch and verifyLease admits it (expiry frees
//      takeover).
//   3. a forced same-epoch double-write is SLASHABLE — two same-epoch leases to
//      different devices adjudicate to the witness intersection; two witnessed
//      successors of one prev adjudicate to the user (slash.ts, both shapes).
//   4. the REAL 'pairing' event VERIFIES + ANCHORS IN BOTH CHAINS — host + guest
//      each anchor a witnessed 'pairing' under their lease; verifyChain green on
//      both; the two payloads arm the WitnessCore rated gate (and its absence /
//      contradiction poisons the follower).
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

// Bundle the shared substrate + the two M2 renderer modules under test (both
// import only @shared paths, so they bundle headless).
const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as seg from '@shared/accounts/segment'
export * as wc from '@shared/mp/witnessCore'
export * as conduct from '@shared/accounts/ratings/conduct'
export * as lease from '${SRC}/renderer/src/features/account/net/leaseRunner.ts'
export * as pregame from '${SRC}/renderer/src/features/account/net/preGame.ts'
`

async function main() {
  const outdir = makeOutdir('accounts-lease-runner-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

const BLITZ = { baseMs: 300_000, incMs: 0 } // 5+0
const KIND = 'chess'

async function run(M) {
  const { A, W, seg, wc, lease, pregame } = M
  const { PARAMS_A2, PARAMS_A2_DIGEST } = W
  const NOW = 1_700_000_000_000

  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }

  // A player: a fresh account chain (genesis + device-0 cert) + a fabric endpoint.
  function makePlayer(fabric, seedRoot, seedDev, name) {
    const root = kp(seedRoot)
    const device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    const chain = A.createAccountChain({
      rootPriv: root.priv, rootPub: root.pub, displayName: name, ts: NOW,
      device: { pub: device.pubB, index: 0, label: 'Device A' },
    })
    return { root, device, nodeId, ep, chain, name, signing: { root: root.pubB, key: device.pubB, priv: device.priv } }
  }

  // A witness node running witnessServe (grants leases + serves head + attests),
  // announcing presence with the witness cap + a fully-trusting summary.
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
    const handle = W.witnessServe(ep, { nodeId, key: device.pubB, priv: device.priv }, { store, wts: () => NOW, timeWindowMs: PARAMS_A2.timeWindowMs })
    return { root, device, nodeId, ep, store, handle }
  }

  const fabric = new W.MockFabric()
  const host = makePlayer(fabric, 10, 11, 'Hosty')
  const guest = makePlayer(fabric, 20, 21, 'Guesty')
  // Host device B — a SECOND device of the SAME account (host root), never certified
  // here (it only needs a device signing key to contend for the lease).
  const deviceB = kp(12)

  // 16 fully-eligible witnesses → a real canonical set (tLease = 9).
  const witnesses = Array.from({ length: 16 }, (_, i) => makeWitness(fabric, 200 + i, 300 + i))
  const summaries = new Map(witnesses.map((w) => [w.nodeId, { root: w.root.pubB, nodeId: w.nodeId, trustMicro: 1_000_000, secondDegreeRoots: new Set() }]))
  const keyOf = new Map(witnesses.map((w) => [w.nodeId, w.device.pubB]))
  const directory = () => host.ep.directory()

  const subjectFor = (rootB, nodeId) => ({ root: rootB, nodeId, entangledRoots: new Set(), secondDegreeRoots: new Set() })
  const ctxFor = (rootB, nodeId, extra = {}) => ({ subject: subjectFor(rootB, nodeId), directory: directory(), summaries, params: PARAMS_A2, nowMs: NOW, fuse: null, prior: null, ...extra })

  // The GAME both players will pair for (host-minted, binds both roots + a nonce).
  const GAME = seg.gameKey({ v: 1, t: 'game-key', w: host.root.pubB, b: guest.root.pubB, nonce: kp(99).pubB, ts: NOW })

  const runnerFor = (identity, chainRef) =>
    lease.createLeaseRunner({
      fabric: chainRef.ep,
      identity,
      chain: () => chainRef.chain,
      summaries: () => summaries,
      subject: () => subjectFor(identity.root, W.nodeIdOf(identity.root)),
      now: () => NOW,
      heartbeatMs: 0, // no internal timer — this suite drives heartbeat() explicitly
    })

  // ==========================================================================
  console.log('\n· 1. a T_lease lease held at one epoch (leaseRunner.acquire) …')
  // ==========================================================================
  const runnerA = runnerFor(host.signing, host)
  const acqA = await runnerA.acquire()
  ok(acqA.ok, 'device A acquired the write lease')
  eq(acqA.ok && acqA.epoch, 1, 'a fresh account starts at epoch 1 (the monotonic fence)')
  eq(acqA.ok && acqA.takeover, false, 'the first lease is not a takeover')
  const leaseA = runnerA.currentLease()
  const vA = W.verifyLease(leaseA, ctxFor(host.root.pubB, host.nodeId))
  ok(vA.ok, 'the held lease verifies against the canonical witness set')
  ok(vA.validGrantors.length >= PARAMS_A2.tLease, `the lease carries ≥ tLease (${PARAMS_A2.tLease}) distinct grantors — a real T_lease lease`)
  eq(runnerA.currentEpoch(), 1, 'currentEpoch() reports the held epoch (wired into the segment append)')

  // Heartbeat renews the SAME epoch (a same-device re-grant, still valid).
  const hb = await runnerA.heartbeat()
  ok(hb, 'heartbeat re-gathered grants')
  eq(runnerA.currentEpoch(), 1, 'the heartbeat renewal HOLDS epoch 1 (never advances on its own)')
  const vHb = W.verifyLease(runnerA.currentLease(), ctxFor(host.root.pubB, host.nodeId, { prior: { epoch: 1, device: host.signing.key } }))
  ok(vHb.ok, 'the renewed lease verifies as a same-device heartbeat (prior epoch 1, same device)')

  // Acquire again while held is idempotent (the "held at one epoch" steady state).
  const acqA2 = await runnerA.acquire()
  ok(acqA2.ok && acqA2.epoch === 1, 'acquire() while a live lease is held is idempotent (same epoch)')

  // ==========================================================================
  console.log('\n· 2. device A anchors its pairing, then a SECOND device is refused …')
  // ==========================================================================
  // Seed BOTH players' genesis heads into every witness so the pairing appends
  // are admissible (the M2 witnessController does this from the pre-game snapshots).
  for (const w of witnesses) {
    await w.handle.seedHead(host.root.pubB, { id: A.witnessedHeadOf(host.chain.events).id, height: 0 })
    await w.handle.seedHead(guest.root.pubB, { id: A.witnessedHeadOf(guest.chain.events).id, height: 0 })
  }
  const players = new Set([host.nodeId, guest.nodeId])

  const anchorA = await pregame.anchorPairing({
    fabric: host.ep, chain: host.chain, signing: host.signing, lease: leaseA, witnessSet: acqA.witnessSet,
    game: GAME, opp: guest.root.pubB, kind: KIND, tc: BLITZ, atWts: NOW, players, epoch: 1,
    saveChain: async (_r, c) => { host.chain = c },
  })
  ok(anchorA.ok, 'device A anchored a witnessed pairing under its live lease')
  eq(anchorA.ok && anchorA.event.body.type, 'pairing', "the anchored event is a witnessed 'pairing'")
  ok((anchorA.event?.wit?.length ?? 0) >= 1, 'the pairing carries ≥1 non-player witness attestation (§4)')

  // Device B (SAME root, different device) reads the synced chain: the live head
  // was authored by device A ⇒ playing elsewhere.
  const runnerB = runnerFor({ root: host.root.pubB, key: deviceB.pubB, priv: deviceB.priv }, host)
  const acqB = await runnerB.acquire()
  eq(acqB.ok, false, 'the second device does NOT acquire while another device holds the live lease')
  eq(acqB.ok === false && acqB.reason, 'playing-elsewhere', 'it refuses with "playing elsewhere" (never a fork, spec §4)')
  eq(acqB.ok === false && acqB.heldBy, host.signing.key, 'it names the device currently holding the lease')
  eq(acqB.ok === false && acqB.observedEpoch, 1, 'and the observed live epoch')

  // An UNSYNCED second device — its local chain lacks device A's append, yet the
  // witnesses report epoch 1 ⇒ it cannot prove ownership and DEFERS, never a blind
  // same-epoch grab (the double-grant safety the honest client owes). M3 chain
  // replication resolves this to the clean playing-elsewhere refusal above.
  const staleChain = A.createAccountChain({ rootPriv: host.root.priv, rootPub: host.root.pub, displayName: 'Hosty', ts: NOW, device: { pub: host.device.pubB, index: 0, label: 'A' } })
  const runnerBStale = lease.createLeaseRunner({ fabric: host.ep, identity: { root: host.root.pubB, key: deviceB.pubB, priv: deviceB.priv }, chain: () => staleChain, summaries: () => summaries, subject: () => subjectFor(host.root.pubB, host.nodeId), now: () => NOW, heartbeatMs: 0 })
  const acqBStale = await runnerBStale.acquire()
  eq(acqBStale.ok, false, 'an UNSYNCED second device does not blindly grab a lease')
  eq(acqBStale.ok === false && acqBStale.reason, 'behind', 'it defers as "behind" until it syncs (double-grant safety)')

  // A PIN-gated takeover advances the epoch and is admitted (expiry frees takeover).
  const pin = kp(1234)
  const session = W.makePinSession({ v: 1, root: host.root.pubB, device: deviceB.pubB, purpose: 'lease-takeover', evalNonce: kp(4321).pubB, wts: NOW, epoch: 2 }, pin.priv)
  const acqBTake = await runnerB.acquire({ takeover: { kind: 'pin', session } })
  ok(acqBTake.ok, 'device B acquires via a PIN-gated takeover')
  eq(acqBTake.ok && acqBTake.epoch, 2, 'the takeover advances the epoch (strictly higher, the fencing rule)')
  eq(acqBTake.ok && acqBTake.takeover, true, 'the acquire is flagged as a takeover')
  const vTake = W.verifyLease(runnerB.currentLease(), ctxFor(host.root.pubB, host.nodeId, { prior: { epoch: 1, device: host.signing.key }, pinPub: pin.pubB, session }))
  ok(vTake.ok, 'verifyLease admits the takeover (advanced epoch + a valid PIN-gated session)')
  // The SAME session (bound to epoch 2) cannot be replayed to authorize an epoch-3
  // takeover — the takeover gate runs because the epoch-3 body is a DIFFERENT
  // device than the prior holder, and the session's epoch-bind then rejects it.
  const vReplay = W.verifyLease(
    W.grantLease(W.buildLeaseBody({ root: host.root.pubB, epoch: 3, device: deviceB.pubB, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST, takeover: W.pinSessionId(session) }), []),
    ctxFor(host.root.pubB, host.nodeId, { prior: { epoch: 2, device: host.signing.key }, pinPub: pin.pubB, session }),
  )
  ok(vReplay.errors.some((e) => e.includes('session epoch != lease epoch')), 'a takeover session bound to epoch 2 cannot be replayed at epoch 3')

  // -- ROOT-LANE AUTO-TAKEOVER: signing in on a second device.
  // An account with NO PIN cannot mint a PIN session, so without this lane the
  // second device is refused forever and cross-device play is impossible. The
  // runner mints a root-signed session itself, but ONLY once the holder's lease
  // is plainly dead (headTs older than a full TTL) — a LIVE holder is a real
  // concurrent session and must still be refused.
  const rootMint = async (epoch) => ({
    kind: 'root',
    session: W.makeRootSession(
      { v: 1, root: host.root.pubB, device: deviceB.pubB, purpose: 'lease-takeover', evalNonce: kp(4321).pubB, wts: NOW, epoch },
      host.root.priv,
      host.root.pubB,
    ),
  })
  const runnerBAuto = (nowAt) =>
    lease.createLeaseRunner({
      fabric: host.ep,
      identity: { root: host.root.pubB, key: deviceB.pubB, priv: deviceB.priv },
      chain: () => host.chain,
      summaries: () => summaries,
      subject: () => subjectFor(host.root.pubB, host.nodeId),
      now: () => nowAt,
      heartbeatMs: 0,
      mintTakeover: rootMint,
    })

  // (a) holder still LIVE ⇒ refused, no auto-mint.
  const acqLive = await runnerBAuto(NOW).acquire()
  eq(acqLive.ok === false && acqLive.reason, 'playing-elsewhere', 'a LIVE holder is still refused — auto-takeover never races a real session')

  // (b) holder's lease DEAD (past a full TTL) ⇒ auto-mints and takes the lane.
  const acqStale = await runnerBAuto(NOW + PARAMS_A2.leaseTtlMs + 1).acquire()
  ok(acqStale.ok, 'a second device auto-takes a DEAD lease with a root-signed session (no PIN needed)')
  eq(acqStale.ok && acqStale.takeover, true, 'the auto-acquire is flagged as a takeover')
  ok(acqStale.ok && acqStale.epoch > 1, 'and it advances the epoch past the dead holder')

  // ==========================================================================
  console.log('\n· 3. a forced same-epoch double-write is slashable (witness/slash.ts) …')
  // ==========================================================================
  // (a) DOUBLE-GRANT: force device B to gather a SAME-epoch lease (epoch 1) — the
  // dishonest path an honest leaseRunner refuses above. Two valid leases at one
  // epoch to different devices ⇒ the intersection grantors double-signed.
  const acqBForce = await runnerB.acquire({ forceEpoch: 1 })
  ok(acqBForce.ok, 'device B was FORCED to gather a same-epoch lease (adversarial; honest clients refuse)')
  const dg = { root: host.root.pubB, a: leaseA, b: runnerB.currentLease(), events: [] }
  const verdictDG = W.adjudicate(dg, { tLease: PARAMS_A2.tLease, keyOf })
  eq(verdictDG.guilty, 'witnesses', 'the same-epoch double-grant convicts the WITNESSES (§4)')
  ok(verdictDG.slashed.length >= 1, 'the slashed set is the grantors who signed BOTH leases (non-empty)')

  // (b) FORK (two witnessed appends of one prev): device A writes a SECOND height-1
  // successor of genesis under its lease ⇒ a same-epoch witnessed-lane fork. A
  // fresh genesis chain isolates the fork evidence from the pairing already landed.
  const g0 = A.createAccountChain({ rootPriv: host.root.priv, rootPub: host.root.pub, displayName: 'Hosty', ts: NOW, device: { pub: host.device.pubB, index: 0, label: 'A' } })
  const prev = A.witnessedHeadOf(g0.events).id
  const mkPairEv = (opp) => A.signBody(
    { v: 1, lane: 'w', type: 'pairing', root: host.root.pubB, key: host.device.pubB, height: 1, prev, ts: NOW, payload: M.conduct.makePairingPayload({ game: GAME, opp, kind: KIND, tc: BLITZ, atWts: NOW }) },
    host.device.priv,
  )
  const forkA = mkPairEv(guest.root.pubB)
  const forkB = mkPairEv(kp(77).pubB) // a distinct payload ⇒ distinct id, SAME prev/height
  const certSlice = A.certsProving(host.root.pubB, g0.events, [host.device.pubB])
  const forkProof = W.detectSameEpochFork(forkA, forkB, certSlice)
  ok(forkProof !== null, 'two witnessed successors of one prev produce a self-authenticating fork proof')
  const verdictFork = W.adjudicateFork(forkProof)
  eq(verdictFork.guilty, 'user', 'the same-epoch double-APPEND convicts the USER (permanent fork slash, §4)')
  eq(JSON.stringify(verdictFork.slashed), JSON.stringify([host.root.pubB]), 'the user root is slashed')

  // ==========================================================================
  console.log('\n· 4. the REAL pairing event verifies + anchors in BOTH chains …')
  // ==========================================================================
  // The guest anchors its own pairing under its own lease (the cross-wise anchor).
  const runnerG = runnerFor(guest.signing, guest)
  const acqG = await runnerG.acquire()
  ok(acqG.ok, 'the guest acquired its own write lease')
  const anchorG = await pregame.anchorPairing({
    fabric: guest.ep, chain: guest.chain, signing: guest.signing, lease: runnerG.currentLease(), witnessSet: acqG.witnessSet,
    game: GAME, opp: host.root.pubB, kind: KIND, tc: BLITZ, atWts: NOW, players, epoch: acqG.epoch,
    saveChain: async (_r, c) => { guest.chain = c },
  })
  ok(anchorG.ok, 'the guest anchored its cross-wise witnessed pairing')

  // Both chains verify standalone WITH the appended pairing.
  ok(A.verifyChain(host.chain).ok, 'the HOST chain verifies with the anchored pairing (verifyChain green)')
  ok(A.verifyChain(guest.chain).ok, 'the GUEST chain verifies with the anchored pairing (verifyChain green)')

  // Each anchored pairing cross-checks against the game terms (the embedder's check).
  ok(
    pregame.verifyPairingEvent(anchorA.event, { game: GAME, kind: KIND, tc: BLITZ, self: host.root.pubB, opp: guest.root.pubB }),
    'the host pairing verifies (sig + attestation + game/kind/tc/opp binding)',
  )
  ok(
    pregame.verifyPairingEvent(anchorG.event, { game: GAME, kind: KIND, tc: BLITZ, self: guest.root.pubB, opp: host.root.pubB }),
    'the guest pairing verifies (cross-wise opp binding)',
  )
  ok(!pregame.verifyPairingEvent(anchorA.event, { game: GAME, kind: KIND, tc: BLITZ, self: host.root.pubB, opp: kp(88).pubB }), 'a pairing checked against the WRONG opponent is refused (fail-closed)')

  // The two payloads arm the WitnessCore rated gate (the real {w,b} form, not a flag).
  const anchors = pregame.pairingAnchorsFor({ game: GAME, players: { w: host.root.pubB, b: guest.root.pubB }, kind: KIND, tc: BLITZ, atWts: NOW })
  eq(anchors.w.opp, guest.root.pubB, 'the white anchor names black as opp')
  eq(anchors.b.opp, host.root.pubB, 'the black anchor names white as opp')
  eq(A.toB64u(A.canonicalHash(anchors.w)), A.toB64u(A.canonicalHash(pregame.pairingPayloadOf(anchorA.event))), 'the reconstructed white anchor is byte-identical to the on-chain pairing payload')

  const startMsg = { t: 'start', gameId: 1, yourColor: 'black', config: { tc: { initialMs: BLITZ.baseMs, incrementMs: BLITZ.incMs }, hostColor: 'white', game: { kind: KIND } }, gameKey: GAME, players: { w: host.root.pubB, b: guest.root.pubB } }
  const mkCore = (pairing) => {
    const wt = witnesses[0]
    const core = new wc.WitnessCore({ wpriv: wt.device.priv, wkey: wt.device.pubB, wroot: wt.root.pubB, now: () => NOW })
    core.init({ gameId: 1, gameKey: GAME, players: { w: { root: host.root.pubB, key: host.device.pubB }, b: { root: guest.root.pubB, key: guest.device.pubB } }, firstMover: 'w', kind: KIND, tc: BLITZ, ...(pairing !== undefined ? { pairing } : {}) })
    return core
  }
  eq(mkCore(anchors).feed(startMsg, NOW).ok, true, 'the witness SERVES the rated game when armed with both real pairing anchors')
  const noPairing = mkCore(undefined).feed(startMsg, NOW)
  eq(noPairing.ok, false, 'a rated game with NO pairing anchors is REFUSED (the gate that M1 left blind)')
  ok(String(noPairing.error).includes('pairing anchors'), 'the poison names the missing pairing anchors')
  const badAnchors = { w: M.conduct.makePairingPayload({ game: GAME, opp: kp(66).pubB, kind: KIND, tc: BLITZ, atWts: NOW }), b: anchors.b }
  eq(mkCore(badAnchors).feed(startMsg, NOW).ok, false, 'a pairing anchor naming the wrong opponent poisons the follower')

  // ==========================================================================
  console.log('\n· 5. honest degradation — no reachable witness ⇒ the rated button waits …')
  // ==========================================================================
  const barren = new W.MockFabric()
  const soloEp = barren.endpoint(host.nodeId)
  const runnerBarren = lease.createLeaseRunner({
    fabric: soloEp, identity: host.signing, chain: () => g0,
    summaries: () => new Map(), subject: () => subjectFor(host.root.pubB, host.nodeId), now: () => NOW, heartbeatMs: 0,
  })
  const acqBarren = await runnerBarren.acquire()
  eq(acqBarren.ok, false, 'with no witness reachable the lease is NOT granted')
  eq(acqBarren.ok === false && acqBarren.reason, 'insufficient-witnesses', 'it degrades honestly (C-10) — the rated button waits, casual play unaffected')

  for (const w of witnesses) w.ep.close()
  host.ep.close(); guest.ep.close()
}

main()
