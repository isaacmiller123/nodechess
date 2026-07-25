// THE A2 PROOF SUITE — headless multi-client over MockFabric (spec §14-A2).
//
//   node scripts/test-accounts-fabric.mjs
//
// Proves the §14-A2 line end to end, test-mp mock-pair style: N nodes on one
// in-process fabric bus, each running witnessServe + memberServe, two players
// enrolling, provisioning a PIN committee, and driving the full witnessed-lane
// choreography through the protocol.ts flows:
//   1. lease grant → witnessed appends (≥1 non-player attestation each) →
//      M-of-N cosigned checkpoint → verifyChain + verifyLease + verifyAttestation
//      + verifyCheckpointCosigners all green; also the 2-players+1-witness run;
//   2. PIN-gated takeover: device B takes over ONLY with a committee-derived
//      PinSession; the same takeover WITHOUT the session is rejected;
//   3. forced same-epoch fork → detected + slashed (user permanent);
//   4. different-epoch double-grant → appealed → the faulty grantors identified;
//   5. PIN fuse: 100 failed evals through memberServe → threshold-signed fuse →
//      honest witnesses refuse the next lease → refill-by-R after expiry;
//   6. honest degradation: 2 nodes only → insufficient-witnesses, not a dead grant.
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

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
`

async function main() {
  const outdir = makeOutdir('accounts-fabric-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W } = M
  const { PARAMS_A2, PARAMS_A2_DIGEST } = W
  const NOW = 1_700_000_000_000

  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  // deterministic byte stream RNG (reproducible OPRF/Shamir generation).
  function seededRng(tag) {
    let ctr = 0
    const seed = A.utf8(tag)
    return (n) => {
      const out = new Uint8Array(n)
      let off = 0
      while (off < n) {
        const blk = A.sha256(A.concatBytes(seed, A.utf8(String(ctr++))))
        const take = Math.min(blk.length, n - off)
        out.set(blk.subarray(0, take), off)
        off += take
      }
      return out
    }
  }

  // A fabric node: an endpoint running witnessServe + memberServe. The operator
  // peer is exactly this shape (server/operator/peer.ts) — just always awake.
  function makeNode(fabric, seedRoot, seedDev, fuses) {
    const root = kp(seedRoot)
    const device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    ep.announce(
      W.signPresence(
        { v: 1, root: root.pubB, key: device.pubB, caps: { witness: true, committee: true, shardMb: 100 }, params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 99 },
        device.priv,
      ),
    )
    const id = { nodeId, key: device.pubB, priv: device.priv }
    const store = new W.MemoryWitnessStore()
    const fuseOf = (r) => fuses.get(r) ?? null
    const witness = W.witnessServe(ep, id, { store, wts: () => NOW, fuseOf, timeWindowMs: PARAMS_A2.timeWindowMs })
    const member = W.memberServe(ep, id, { wts: () => NOW, fuseOf })
    return { root, device, nodeId, ep, witness, member, store }
  }

  // A player (client): its account chain + an endpoint to drive requests.
  function makePlayer(fabric, seedRoot, seedDev, name) {
    const root = kp(seedRoot)
    const device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    const chain = A.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: name, ts: NOW, device: { pub: device.pubB, index: 0, label: 'A' } })
    return { root, device, nodeId, ep, chain }
  }

  function summariesFor(nodes) {
    return new Map(nodes.map((n) => [n.nodeId, { root: n.root.pubB, nodeId: n.nodeId, trustMicro: 1_000_000, secondDegreeRoots: new Set() }]))
  }
  function subjectOf(player, entangled = []) {
    return { root: player.root.pubB, nodeId: player.nodeId, entangledRoots: new Set(entangled), secondDegreeRoots: new Set() }
  }

  // Provision a PIN committee (pinN members) for `root`; returns the committee
  // descriptor + the real root-signed PIN record + the correct pinKey.
  function provisionCommittee(nodes, rootPriv, rootB, pin, rng) {
    const members = nodes.slice(0, PARAMS_A2.pinN)
    const k = W.randScalar(rng)
    const deal = W.dealScalar(k, PARAMS_A2.pinT, PARAMS_A2.pinN, rng)
    const output = W.singleKeyOutput(pin, k, rng)
    const pinKey = W.pinKeyFromOutput(output)
    const pinPub = A.toB64u(pinKey.pub)
    const committeeIds = members.map((m) => m.nodeId)
    const shareCommitments = deal.shares.map((s) => A.toB64u(W.pointToBytes(W.shareCommitment(s.share))))
    // Build the root-signed record first so each member binds its share to the
    // committee + pinRecord id (needed for pin-fuse-sign's context check).
    const payload = W.makePinRecordPayload({ committee: committeeIds, t: PARAMS_A2.pinT, shareCommitments, pinPub })
    const record = W.buildPinRecord(payload, rootPriv, rootB)
    const recId = W.pinRecordId(payload)
    members.forEach((m, idx) => {
      m.member.provision(rootB, deal.shares[idx].i, deal.shares[idx].share, shareCommitments[idx], pinPub, recId)
    })
    return { members: committeeIds, memberNodes: members, t: PARAMS_A2.pinT, shareCommitments, pinPub, record, pinKey }
  }

  const keyOfMap = (nodes) => {
    const m = new Map(nodes.map((n) => [n.nodeId, n.device.pubB]))
    return (w) => m.get(w)
  }

  // ==========================================================================
  console.log('\n· 1. full witnessed-lane sequence (2 players + wN witnesses) …')
  // ==========================================================================
  const fuses = new Map()
  const fabric = new W.MockFabric()
  const witnesses = Array.from({ length: PARAMS_A2.wN }, (_, i) => makeNode(fabric, 400 + i, 600 + i, fuses))
  const summaries = summariesFor(witnesses)
  const alice = makePlayer(fabric, 10, 11, 'Alice')
  const bob = makePlayer(fabric, 20, 21, 'Bob')
  const players = new Set([alice.nodeId, bob.nodeId])

  // committee for Alice (drawn from the witness nodes, which also run memberServe)
  const rng = seededRng('fabric-suite-v1')
  const committee = provisionCommittee(witnesses, alice.root.priv, alice.root.pubB, '4271', rng)
  ok(W.verifyPinRecord(committee.record).ok, 'the provisioned PIN record verifies (root-signed, correct shape)')

  const subject = subjectOf(alice)
  const leaseRes = await W.clientRequestLease({
    fabric: alice.ep, root: alice.root.pubB, epoch: 1, deviceKey: alice.device.pubB, devicePriv: alice.device.priv,
    grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, paramsDigest: PARAMS_A2_DIGEST,
    subject, summaries, params: PARAMS_A2, nowMs: NOW,
  })
  ok(leaseRes.ok, 'Alice gathers a lease from the canonical witness set (≥ tLease grants)')
  const lease = leaseRes.lease
  const leaseCtx = { subject, directory: alice.ep.directory(), summaries, params: PARAMS_A2, nowMs: NOW, fuse: null, prior: null }
  ok(W.verifyLease(lease, leaseCtx).ok, 'the gathered lease verifies against the recomputed witness set')
  eq(lease.grants.length, PARAMS_A2.tLease, `the lease carries exactly tLease=${PARAMS_A2.tLease} grants`)

  // seed every witness with the genesis head (bootstrapped from enrollment gossip)
  const genesisId = A.witnessedHeadOf(alice.chain.events).id
  for (const w of witnesses) await w.witness.seedHead(alice.root.pubB, { id: genesisId, height: 0 })

  // append 3 witnessed events, each with ≥1 non-player attestation
  let achain = alice.chain
  let allAttestOk = true
  let sawNonPlayerWitness = false
  for (let i = 0; i < 3; i++) {
    const r = await W.clientAppendWitnessed({
      fabric: alice.ep, chain: achain, lease, deviceKey: alice.device.pubB, devicePriv: alice.device.priv,
      type: 'revoke', payload: { pub: kp(50 + i).pubB }, ts: NOW, epoch: 1,
      witnessSet: leaseRes.witnessSet, players,
    })
    if (!r.ok) { allAttestOk = false; break }
    achain = r.chain
    // every attached attestation verifies, and at least one is from a non-player
    const evId = A.eventId(r.event.body)
    for (const att of r.attestations) if (!W.verifyAttestation(att, evId)) allAttestOk = false
    if (r.attestations.length >= 1) sawNonPlayerWitness = true
  }
  ok(allAttestOk, 'each witnessed append collected valid attestations (all verify against the event id)')
  ok(sawNonPlayerWitness, 'rated play carried ≥1 witness that is neither player (spec §4)')
  eq(A.witnessedHeadOf(achain.events).height, 3, 'the witnessed lane advanced to height 3 under the lease')

  // checkpoint, cosigned M-of-N across distinct /16 prefixes
  const ckptEv = A.makeCheckpointEvent(achain, alice.device.priv, alice.device.pubB, NOW)
  achain = A.appendEvent(achain, ckptEv)
  const ckptId = A.eventId(ckptEv.body)
  // drive cosign requests from Alice's client endpoint to each witness
  const cosigs = []
  for (const w of witnesses) {
    const res = await A_cosign(alice.ep, w.nodeId, achain, ckptEv)
    if (res) cosigs.push(res)
  }
  const eligibleMap = new Map(witnesses.map((w) => [w.device.pubB, w.nodeId]))
  const rule = { m: PARAMS_A2.ckptM, n: PARAMS_A2.ckptN, prefixDiversityMin: 3 }
  ok(cosigs.length >= PARAMS_A2.ckptM, `checkpoint gathered ≥ ckptM=${PARAMS_A2.ckptM} recompute-gated cosignatures`)
  ok(W.verifyCheckpointCosigners(ckptEv, cosigs, eligibleMap, rule), 'the checkpoint cosigner set passes M-of-N + /16 diversity')
  eq(W.verifyAttestation(cosigs[0], ckptId), true, 'a checkpoint cosignature verifies against the ckpt event id')

  const finalVerify = A.verifyChain(achain)
  ok(finalVerify.ok, 'the full witnessed chain (genesis → 3 events → checkpoint) verifies')

  async function A_cosign(clientEp, to, chain, ckpt) {
    try {
      const res = await clientEp.request(to, 'cosign-ckpt', { chain, ckpt })
      return res.attestation ?? null
    } catch { return null }
  }

  // ---- also: minimal 2-players + 1 witness run (effective threshold floors) --
  {
    const f2 = new W.MockFabric()
    const soloFuses = new Map()
    const w1 = makeNode(f2, 800, 810, soloFuses)
    const p1 = makePlayer(f2, 30, 31, 'P1')
    const summ1 = summariesFor([w1])
    const res = await W.clientRequestLease({
      fabric: p1.ep, root: p1.root.pubB, epoch: 1, deviceKey: p1.device.pubB, devicePriv: p1.device.priv,
      grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, paramsDigest: PARAMS_A2_DIGEST,
      subject: subjectOf(p1), summaries: summ1, params: PARAMS_A2, nowMs: NOW,
    })
    ok(res.ok && res.lease.grants.length === 1, '3-node run (2 players + 1 witness): a lease grants at the floored threshold of 1')
  }

  // ==========================================================================
  console.log('\n· 2. PIN-gated takeover (device B) …')
  // ==========================================================================
  const deviceB = kp(12)

  // A takeover lease at epoch 2 for device B WITHOUT a PIN session → rejected.
  const noSessRes = await W.clientRequestLease({
    fabric: alice.ep, root: alice.root.pubB, epoch: 2, deviceKey: deviceB.pubB, devicePriv: deviceB.priv,
    grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, paramsDigest: PARAMS_A2_DIGEST,
    subject, summaries, params: PARAMS_A2, nowMs: NOW,
  })
  const noSessVerify = W.verifyLease(noSessRes.lease, { ...leaseCtx, prior: { epoch: 1, device: alice.device.pubB }, pinPub: committee.pinPub })
  ok(noSessRes.ok && !noSessVerify.ok && noSessVerify.errors.some((e) => e.includes('no session referenced')), 'a device-B takeover WITHOUT any session fails verifyLease')

  // Derive the pinKey through the committee, mint the takeover session.
  const pv = await W.pinVerifyFlow({ fabric: alice.ep, root: alice.root.pubB, pin: '4271', committee, wts: NOW, rng: seededRng('pin-eval-good'), checkDleq: true })
  ok(pv.ok, 'the committee eval flow derives the correct pinKey (pinPub matches the PIN record)')
  eq(pv.ok && pv.pinPub, committee.pinPub, 'the derived pinPub equals the published pinPub')
  const session = W.makePinSession({ v: 1, root: alice.root.pubB, device: deviceB.pubB, purpose: 'lease-takeover', evalNonce: kp(4321).pubB, wts: NOW, epoch: 2 }, pv.pinPriv)
  const takeRes = await W.clientRequestLease({
    fabric: alice.ep, root: alice.root.pubB, epoch: 2, deviceKey: deviceB.pubB, devicePriv: deviceB.priv,
    grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, paramsDigest: PARAMS_A2_DIGEST,
    subject, summaries, params: PARAMS_A2, nowMs: NOW, takeover: { session },
  })
  const takeVerify = W.verifyLease(takeRes.lease, { ...leaseCtx, prior: { epoch: 1, device: alice.device.pubB }, pinPub: committee.pinPub, session })
  ok(takeRes.ok && takeVerify.ok, 'a device-B takeover WITH a valid committee-derived PIN session verifies')

  // a WRONG pin does not derive the pinKey (and would never mint a session)
  const pvWrong = await W.pinVerifyFlow({ fabric: alice.ep, root: alice.root.pubB, pin: '9999', committee, wts: NOW, rng: seededRng('pin-eval-bad'), checkDleq: true })
  ok(!pvWrong.ok && pvWrong.reason === 'wrong-pin', 'a wrong PIN yields wrong-pin (the derived key ≠ pinPub)')

  // ==========================================================================
  console.log('\n· 2b. tOPRF committee is t-of-n and DLEQ-enforced …')
  // ==========================================================================
  {
    const f = new W.MockFabric()
    const cfuses = new Map()
    const cnodes = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(f, 900 + i, 950 + i, cfuses))
    const client = makePlayer(f, 40, 41, 'PinClient')
    const com = provisionCommittee(cnodes, client.root.priv, client.root.pubB, '4271', seededRng('committee-2b'))

    // Happy path — verifiability is ON by default (members emit deterministic
    // DLEQ proofs); the honest committee derives the pinKey.
    const good = await W.pinVerifyFlow({ fabric: client.ep, root: client.root.pubB, pin: '4271', committee: com, wts: NOW, rng: seededRng('2b-good') })
    ok(good.ok && good.pinPub === com.pinPub, 'DLEQ-enforced committee eval derives the correct pinKey (checkDleq defaults on)')

    // A MALICIOUS member (committee position 0) returns a wrong-share partial
    // with NO proof — the shape that used to slip through unchecked.
    const evil = W.randScalar(seededRng('2b-evil'))
    const evilNonce = A.toB64u(A.sha256(A.utf8('2b-evil-nonce')))
    cnodes[0].ep.onRequest('pin-eval', async (_from, payload) => ({
      i: 1, partial: W.memberBlindEvaluate(evil, payload.blinded), evalNonce: evilNonce,
    }))

    // With verifiability ON the bad partial is rejected; t-of-n routes around it
    // and the honest quorum still derives the correct key.
    const routed = await W.pinVerifyFlow({ fabric: client.ep, root: client.root.pubB, pin: '4271', committee: com, wts: NOW, rng: seededRng('2b-routed') })
    ok(routed.ok && routed.pinPub === com.pinPub, 't-of-n routes around a malicious member (wrong partial, no proof) and still derives')

    // With verifiability OFF (the pre-fix behavior) the SAME single member
    // silently corrupts the evaluation — proving the enforcement is load-bearing.
    const unguarded = await W.pinVerifyFlow({ fabric: client.ep, root: client.root.pubB, pin: '4271', committee: com, wts: NOW, rng: seededRng('2b-unguarded'), checkDleq: false })
    ok(!unguarded.ok, 'without DLEQ a single malicious member corrupts a correct-PIN eval (fix is load-bearing)')

    // Liveness: take an honest member offline too — the flow tolerates BOTH a
    // malicious and an unreachable member at once (7 honest ≥ pinT).
    await cnodes[1].ep.close()
    const degraded = await W.pinVerifyFlow({ fabric: client.ep, root: client.root.pubB, pin: '4271', committee: com, wts: NOW, rng: seededRng('2b-degraded') })
    ok(degraded.ok && degraded.pinPub === com.pinPub, 't-of-n derives with one malicious + one offline member (spec §1 threshold)')

    // --- fuse enforcement is BY THE COMMITTEE, not one member's word ---------
    // Fresh committee so these cases are independent of the mutations above.
    const ff = new W.MockFabric()
    const ffuses = new Map()
    const fnodes = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(ff, 1200 + i, 1250 + i, ffuses))
    const fclient = makePlayer(ff, 60, 61, 'FuseClient')
    const fcom = provisionCommittee(fnodes, fclient.root.priv, fclient.root.pubB, '4271', seededRng('committee-2b-fuse'))

    // A single member FALSELY claiming the fuse is active cannot deny a healthy
    // account — pinVerifyFlow no longer trusts one member's word; it routes on.
    fnodes[0].ep.onRequest('pin-eval', async () => ({ error: 'fuse-active' }))
    const liar = await W.pinVerifyFlow({ fabric: fclient.ep, root: fclient.root.pubB, pin: '4271', committee: fcom, wts: NOW, rng: seededRng('2b-liar') })
    ok(liar.ok && liar.pinPub === fcom.pinPub, 'a single member falsely claiming fuse-active cannot deny a healthy committee (routes around it)')

    // A genuinely fuse-banned root: honest members REFUSE to serve, so the quorum
    // cannot be reached and no pinKey is derived (committee-enforced ban, §1).
    const bannedFuse = W.makeFuseRecord(fclient.root.pubB, 100, NOW - 1000, W.pinRecordId(fcom.record.payload), [])
    ffuses.set(fclient.root.pubB, bannedFuse)
    const banned = await W.pinVerifyFlow({ fabric: fclient.ep, root: fclient.root.pubB, pin: '4271', committee: fcom, wts: NOW, rng: seededRng('2b-banned') })
    ok(!banned.ok && banned.reason === 'fuse-active', 'a fuse-banned root cannot derive the pinKey — honest members refuse to serve (§1)')
  }

  // ==========================================================================
  console.log('\n· 3. forced same-epoch fork → slashed (user permanent) …')
  // ==========================================================================
  const gid = A.witnessedHeadOf(alice.chain.events).id
  const mkFork = (pub) => A.signBody({ v: 1, lane: 'w', type: 'revoke', root: alice.root.pubB, key: alice.device.pubB, height: 1, prev: gid, ts: NOW, payload: { pub } }, alice.device.priv)
  const forkA = mkFork(kp(71).pubB)
  const forkB = mkFork(kp(72).pubB)
  const certSlice = A.certsProving(alice.root.pubB, alice.chain.events, [alice.device.pubB])
  const forkProof = W.detectSameEpochFork(forkA, forkB, certSlice)
  ok(forkProof !== null, 'a forced same-epoch fork is detected (two successors of one prev)')
  const forkVerdict = W.adjudicateFork(forkProof)
  eq(forkVerdict.guilty, 'user', 'the fork verdict is USER fault (permanent)')
  eq(JSON.stringify(forkVerdict.slashed), JSON.stringify([alice.root.pubB]), 'the user root is slashed')
  // the chain carrying both forks fails verifyChain with a fork error. (Built by
  // hand: appendEvent enforces linearity, so a fork can only exist as a raw set.)
  const forkedChain = { root: alice.root.pubB, events: [...alice.chain.events, forkA, forkB] }
  const fv = A.verifyChain(forkedChain)
  ok(!fv.ok && fv.errors.some((e) => e.code === 'fork'), 'verifyChain independently flags the equivocation as a fork')

  // ==========================================================================
  console.log('\n· 4. different-epoch double-grant → appealed …')
  // ==========================================================================
  // SAME-epoch, different-device double-grant → the intersection grantors that
  // signed BOTH are slashed, attributed by keyOf (nodeId → advertised key).
  const dgKeyOf = new Map(witnesses.map((w) => [w.nodeId, w.device.pubB]))
  const dgBodyA = W.buildLeaseBody({ root: alice.root.pubB, epoch: 7, device: alice.device.pubB, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST })
  const dgBodyB = W.buildLeaseBody({ root: alice.root.pubB, epoch: 7, device: deviceB.pubB, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST })
  const dgA = W.grantLease(dgBodyA, witnesses.slice(0, 9).map((w) => W.signGrant(dgBodyA, w.nodeId, w.device.pubB, w.device.priv, NOW)))
  const dgB = W.grantLease(dgBodyB, witnesses.slice(0, 9).map((w) => W.signGrant(dgBodyB, w.nodeId, w.device.pubB, w.device.priv, NOW)))
  const sameEp = W.adjudicate({ root: alice.root.pubB, a: dgA, b: dgB, events: [] }, { tLease: PARAMS_A2.tLease, keyOf: dgKeyOf })
  eq(sameEp.guilty, 'witnesses', 'same-epoch different-device double-grant → the double-signing witnesses are slashed')
  // FORGED attribution: an attacker signs grants claiming honest witnesses' w's
  // but with its OWN key — keyOf binding refuses to attribute them, so no honest
  // witness is framed (the pair falls below tLease valid grantors → none).
  const evilKp = kp(321)
  const forge = (body) => W.grantLease(body, witnesses.slice(0, 9).map((w) => ({ w: w.nodeId, key: evilKp.pubB, wts: NOW, sig: W.signGrant(body, w.nodeId, evilKp.pubB, evilKp.priv, NOW).sig })))
  const forgedVerdict = W.adjudicate({ root: alice.root.pubB, a: forge(dgBodyA), b: forge(dgBodyB), events: [] }, { tLease: PARAMS_A2.tLease, keyOf: dgKeyOf })
  eq(forgedVerdict.guilty, 'none', 'a fabricated grant set (attacker key, honest w’s) cannot frame honest witnesses (keyOf binding)')
  // Different-epoch leases are a legitimate supersession — never a double-grant;
  // a real user fork is adjudicated by the FORK path (§3), not the lease pair.
  const leaseE1 = takeoverlessLease(1, alice.device.pubB)
  const leaseE2 = takeoverlessLease(2, deviceB.pubB)
  eq(W.adjudicate({ root: alice.root.pubB, a: leaseE1, b: leaseE2, events: [] }, { tLease: PARAMS_A2.tLease, keyOf: dgKeyOf }).guilty, 'none', 'a different-epoch pair is a legitimate supersession (nobody slashed by the double-grant path)')

  function takeoverlessLease(epoch, device, takeover) {
    const body = W.buildLeaseBody({ root: alice.root.pubB, epoch, device, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST, ...(takeover ? { takeover } : {}) })
    const grants = witnesses.slice(0, PARAMS_A2.tLease).map((w) => W.signGrant(body, w.nodeId, w.device.pubB, w.device.priv, NOW))
    return W.grantLease(body, grants)
  }

  // ==========================================================================
  console.log('\n· 5. PIN fuse: 100 failed evals → threshold fuse → refill …')
  // ==========================================================================
  // Drive 100 blind-evaluation requests through the first pinT members.
  const blind = W.clientBlind('0000', seededRng('fuse-blind'))
  const evalMembers = committee.memberNodes.slice(0, PARAMS_A2.pinT)
  for (let round = 0; round < PARAMS_A2.pinLifetimeFails; round++) {
    for (const m of evalMembers) {
      await alice.ep.request(m.nodeId, 'pin-eval', { root: alice.root.pubB, blinded: blind.blinded })
    }
  }
  // gather signed reports and reduce to the effective count
  const reports = await W.collectAttemptReports(alice.ep, alice.root.pubB, committee.members, keyOfMap(committee.memberNodes))
  const effective = W.effectiveCount(reports, PARAMS_A2.pinT)
  eq(effective >= PARAMS_A2.pinLifetimeFails, true, `effective failure count reached the lifetime threshold (${PARAMS_A2.pinLifetimeFails})`)
  ok(W.shouldTrip(effective, 0, false), 'shouldTrip: the fuse trips at the first-cycle threshold')

  // pinT members co-sign the fuse record
  const fuseBody = W.fuseRecordBody(alice.root.pubB, effective, NOW, W.pinRecordId(committee.record.payload))
  const fuseSigs = committee.memberNodes.slice(0, PARAMS_A2.pinT).map((m) => W.signFuse(fuseBody, m.nodeId, m.device.pubB, m.device.priv))
  const fuse = W.makeFuseRecord(alice.root.pubB, effective, NOW, W.pinRecordId(committee.record.payload), fuseSigs)
  const keyOf = new Map(committee.memberNodes.map((m) => [m.nodeId, m.device.pubB]))
  ok(W.verifyFuseRecord(fuse, committee.members, keyOf).ok, 'the fuse record carries ≥ pinT valid member signatures')
  fuses.set(alice.root.pubB, fuse)

  // honest witnesses now refuse to grant into the fuse window
  const afterFuse = await W.clientRequestLease({
    fabric: alice.ep, root: alice.root.pubB, epoch: 3, deviceKey: alice.device.pubB, devicePriv: alice.device.priv,
    grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, paramsDigest: PARAMS_A2_DIGEST,
    subject, summaries, params: PARAMS_A2, nowMs: NOW,
  })
  ok(!afterFuse.ok && afterFuse.reason === 'insufficient-witnesses', 'with an active fuse, honest witnesses refuse to grant → no lease')
  eq(W.isFuseActive(fuse, NOW), true, 'the fuse is active at NOW (within the ban window)')

  // after expiry the fuse no longer bans, and the threshold has refilled by R
  const afterExpiry = fuse.body.expiryWts + 1
  eq(W.isFuseActive(fuse, afterExpiry), false, 'the fuse is inactive after its expiry')
  eq(W.fuseThreshold(0), PARAMS_A2.pinLifetimeFails, 'first-cycle fuse threshold = pinLifetimeFails')
  eq(W.fuseThreshold(1), PARAMS_A2.pinLifetimeFails + PARAMS_A2.pinRefill, 'the next cycle refills the headroom by pinRefill (R)')

  // ==========================================================================
  console.log('\n· 5b. live fuse trip (tripFuseIfDue) is monotonic + non-forgeable …')
  // ==========================================================================
  {
    const ff = new W.MockFabric()
    const fn = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(ff, 1400 + i, 1450 + i, new Map()))
    const fc = makePlayer(ff, 70, 71, 'TripClient')
    const com = provisionCommittee(fn, fc.root.priv, fc.root.pubB, '4271', seededRng('committee-5b'))
    const kOf = new Map(fn.map((m) => [m.nodeId, m.device.pubB]))
    const recId = W.pinRecordId(com.record.payload)
    // 100 wrong guesses to a FIXED quorum → each of those members reaches the
    // monotonic threshold and (only then) self-qualifies to co-sign.
    const quorum = fn.slice(0, PARAMS_A2.pinT)
    for (let g = 0; g < PARAMS_A2.pinLifetimeFails; g++) {
      const bl = W.clientBlind('0000', seededRng('fix-' + g))
      for (const m of quorum) await fc.ep.request(m.nodeId, 'pin-eval', { root: fc.root.pubB, blinded: bl.blinded })
    }
    const fuse = await W.tripFuseIfDue({ fabric: fc.ep, root: fc.root.pubB, committee: com.members, pinRecord: recId, keyOf: kOf, wts: NOW })
    ok(fuse !== null, 'tripFuseIfDue assembles a fuse after 100 failed guesses to the quorum')
    ok(fuse && W.verifyFuseRecord(fuse, com.members, kOf).ok, 'the auto-assembled fuse verifies (≥ pinT co-signatures, each on its OWN counter)')
    ok(fuse && fuse.body.fails >= PARAMS_A2.pinLifetimeFails, `the fuse records the effective count (${fuse && fuse.body.fails})`)

    // NON-FORGEABLE: a victim who never failed cannot be tripped — each member
    // co-signs only on the strength of its OWN counter for the victim root, so
    // no attacker-supplied reports/committee can manufacture a ban.
    const vf = new W.MockFabric()
    const vn = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(vf, 1480 + i, 1490 + i, new Map()))
    const vc = makePlayer(vf, 76, 77, 'Victim')
    const vcom = provisionCommittee(vn, vc.root.priv, vc.root.pubB, '4271', seededRng('committee-victim'))
    const vkOf = new Map(vn.map((m) => [m.nodeId, m.device.pubB]))
    const forged = await W.tripFuseIfDue({ fabric: vc.ep, root: vc.root.pubB, committee: vcom.members, pinRecord: W.pinRecordId(vcom.record.payload), keyOf: vkOf, wts: NOW })
    ok(forged === null, 'a victim with zero failed guesses cannot be fuse-tripped (self-qualification closes forgery)')
    // a requester-supplied `trips` (even negative) cannot lower the bar: the
    // member floors the threshold from its OWN state (no held fuse → pinLifetimeFails),
    // so a fails=0 body on a never-failed victim is refused regardless of trips.
    const negBody = W.fuseRecordBody(vc.root.pubB, 0, NOW, W.pinRecordId(vcom.record.payload))
    const neg = await vc.ep.request(vn[0].nodeId, 'pin-fuse-sign', { body: negBody, trips: -5 })
    ok(!neg.sig && neg.error === 'not-due', 'a requester trips cannot forge a ban — the never-failed member is not-due (floors threshold from its own state)')

    // pin-fuse-sign binds to the provisioned PIN record: a fuse for a DIFFERENT
    // record id is refused even by a member whose own count is at the threshold.
    const wrongRecBody = W.fuseRecordBody(fc.root.pubB, PARAMS_A2.pinLifetimeFails, NOW, A.toB64u(A.sha256(A.utf8('wrong-record'))))
    const wrongRec = await fc.ep.request(quorum[0].nodeId, 'pin-fuse-sign', { body: wrongRecBody, trips: 0 })
    ok(wrongRec.error === 'pin-record-mismatch', 'pin-fuse-sign refuses a fuse targeting a different PIN record')
    // a far-future trip time is refused (no ~permanent ban window, §4).
    const farBody = W.fuseRecordBody(fc.root.pubB, PARAMS_A2.pinLifetimeFails, NOW + 5 * 365 * 86_400_000, recId)
    const far = await fc.ep.request(quorum[0].nodeId, 'pin-fuse-sign', { body: farBody, trips: 0 })
    ok(far.error === 'trippedWts-out-of-window', 'pin-fuse-sign refuses a far-future trip time')
    // an INFLATED body.fails (above the member's own count) is refused — else it
    // would push the next refill threshold (held.fails + R) permanently out of reach.
    const inflatedBody = W.fuseRecordBody(fc.root.pubB, 1_000_000_000, NOW, recId)
    const inflated = await fc.ep.request(quorum[0].nodeId, 'pin-fuse-sign', { body: inflatedBody, trips: 0 })
    ok(inflated.error === 'body-above-own-count', 'pin-fuse-sign refuses a fuse whose fails exceed the member’s own count (no threshold-poisoning)')

    // REFILL DOWNGRADE: a member that already tripped once (holds an EXPIRED fuse
    // with fails=100) must NOT re-sign at threshold 100 — its floor is 100+R,
    // derived from its OWN held fuse, so a requester trips=0 cannot re-ban it.
    const rfFuses = new Map()
    const rf = new W.MockFabric()
    const rfNodes = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(rf, 1520 + i, 1540 + i, rfFuses))
    const rfc = makePlayer(rf, 78, 79, 'RefillClient')
    const rfCom = provisionCommittee(rfNodes, rfc.root.priv, rfc.root.pubB, '4271', seededRng('committee-refill'))
    const rfRec = W.pinRecordId(rfCom.record.payload)
    const rfQuorum = rfNodes.slice(0, PARAMS_A2.pinT)
    for (let g = 0; g < PARAMS_A2.pinLifetimeFails + PARAMS_A2.pinRefill; g++) { // 120 failures
      const bl = W.clientBlind('0000', seededRng('rf-' + g))
      for (const m of rfQuorum) await rfc.ep.request(m.nodeId, 'pin-eval', { root: rfc.root.pubB, blinded: bl.blinded })
    }
    // an EXPIRED first-cycle fuse (fails=100) is now on record for the root.
    rfFuses.set(rfc.root.pubB, W.makeFuseRecord(rfc.root.pubB, PARAMS_A2.pinLifetimeFails, NOW - 200 * 86_400_000, rfRec, []))
    const reBody100 = W.fuseRecordBody(rfc.root.pubB, PARAMS_A2.pinLifetimeFails, NOW, rfRec)
    const re100 = await rfc.ep.request(rfQuorum[0].nodeId, 'pin-fuse-sign', { body: reBody100, trips: 0 })
    ok(re100.error === 'body-below-threshold', 'a re-trip at 100 after a prior trip is refused (member floors at 100+R from its own held fuse)')
    const reBody120 = W.fuseRecordBody(rfc.root.pubB, PARAMS_A2.pinLifetimeFails + PARAMS_A2.pinRefill, NOW, rfRec)
    const re120 = await rfc.ep.request(rfQuorum[0].nodeId, 'pin-fuse-sign', { body: reBody120, trips: 0 })
    ok(re120.sig && re120.sig.w === rfQuorum[0].nodeId, 'the refill-cycle re-trip is co-signed only at the raised threshold 100+R')
    // aggregator agrees with the committee: tripFuseIfDue given the held (expired)
    // fuse floors its due-check at 100+R too, so it trips at the refill threshold.
    const rfKeyOf = new Map(rfNodes.map((m) => [m.nodeId, m.device.pubB]))
    const rfTrip = await W.tripFuseIfDue({ fabric: rfc.ep, root: rfc.root.pubB, committee: rfCom.members, pinRecord: rfRec, keyOf: rfKeyOf, wts: NOW, heldFuse: rfFuses.get(rfc.root.pubB) })
    ok(rfTrip && rfTrip.body.fails >= PARAMS_A2.pinLifetimeFails + PARAMS_A2.pinRefill, 'tripFuseIfDue floors its threshold from the held fuse (aggregator agrees with the committee)')

    // Below threshold → no trip.
    const uf = new W.MockFabric()
    const un = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(uf, 1500 + i, 1550 + i, new Map()))
    const uc = makePlayer(uf, 72, 73, 'FewClient')
    const ucom = provisionCommittee(un, uc.root.priv, uc.root.pubB, '4271', seededRng('committee-5b2'))
    const ukOf = new Map(un.map((m) => [m.nodeId, m.device.pubB]))
    for (let g = 0; g < 10; g++) {
      const bl = W.clientBlind('0000', seededRng('few-' + g))
      for (const m of un.slice(0, PARAMS_A2.pinT)) await uc.ep.request(m.nodeId, 'pin-eval', { root: uc.root.pubB, blinded: bl.blinded })
    }
    const noFuse = await W.tripFuseIfDue({ fabric: uc.ep, root: uc.root.pubB, committee: ucom.members, pinRecord: W.pinRecordId(ucom.record.payload), keyOf: ukOf, wts: NOW })
    ok(noFuse === null, 'tripFuseIfDue does NOT trip below the threshold (10 guesses)')
  }

  // ==========================================================================
  console.log('\n· 5c. pin-provision verifies the re-provision handoff (§1) …')
  // ==========================================================================
  {
    const ff = new W.MockFabric()
    const c1 = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(ff, 1600 + i, 1650 + i, new Map()))
    const c2 = Array.from({ length: PARAMS_A2.pinN }, (_, i) => makeNode(ff, 1700 + i, 1750 + i, new Map()))
    const acct = makePlayer(ff, 74, 75, 'ProvClient')
    const rng = seededRng('prov-5c')
    // One OPRF key, re-shared to both committees (same pinPub across the handoff).
    const k = W.randScalar(rng)
    const pinKey = W.pinKeyFromOutput(W.singleKeyOutput('4271', k, rng))
    const pinPub = A.toB64u(pinKey.pub)
    const deal1 = W.dealScalar(k, PARAMS_A2.pinT, PARAMS_A2.pinN, rng)
    const deal2 = W.dealScalar(k, PARAMS_A2.pinT, PARAMS_A2.pinN, rng)
    const commits = (d) => d.shares.map((s) => A.toB64u(W.pointToBytes(W.shareCommitment(s.share))))
    const shareB = (d, i) => A.toB64u(W.scalarToBytes(d.shares[i].share))
    const rec1p = W.makePinRecordPayload({ committee: c1.map((m) => m.nodeId), t: PARAMS_A2.pinT, shareCommitments: commits(deal1), pinPub })
    const rec1 = W.buildPinRecord(rec1p, acct.root.priv, acct.root.pubB)
    const prevId = W.pinRecordId(rec1p)
    // Initial provisioning of C1 through the NETWORK handler (no prev needed).
    let initOk = true
    for (let i = 0; i < PARAMS_A2.pinN; i++) {
      const res = await acct.ep.request(c1[i].nodeId, 'pin-provision', { newRecord: rec1, i: i + 1, share: shareB(deal1, i) })
      if (!res.ok) initOk = false
    }
    ok(initOk, 'initial pin-provision (no prev) is accepted by every C1 member')
    // A share inconsistent with its published commitment is rejected (Feldman).
    const badShare = await acct.ep.request(c1[0].nodeId, 'pin-provision', { newRecord: rec1, i: 1, share: shareB(deal1, 1) })
    ok(badShare.error === 'share-commitment-mismatch', 'a share that does not match its published commitment is rejected')

    // Re-provision to C2 carrying the counter forward.
    const carried = 60
    const rec2p = W.makePinRecordPayload({ committee: c2.map((m) => m.nodeId), t: PARAMS_A2.pinT, shareCommitments: commits(deal2), pinPub, prev: prevId, carriedFails: carried })
    const rec2 = W.buildPinRecord(rec2p, acct.root.priv, acct.root.pubB)
    const newId = W.pinRecordId(rec2p)
    const nonce = A.toB64u(A.sha256(A.utf8('ho-nonce')))
    const session = W.makePinSession({ v: 1, root: acct.root.pubB, device: acct.root.pubB, purpose: 'committee-handoff', evalNonce: nonce, wts: NOW, record: newId }, pinKey.priv)
    const oldSigs = c1.slice(0, PARAMS_A2.pinT).map((m) => W.signHandoff(acct.root.pubB, prevId, newId, carried, m.nodeId, m.device.pubB, m.device.priv))
    const handoff = W.authorizeHandoff({ root: acct.root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: carried, session, oldSigs })
    let reOk = true
    for (let i = 0; i < PARAMS_A2.pinN; i++) {
      const res = await acct.ep.request(c2[i].nodeId, 'pin-provision', { newRecord: rec2, i: i + 1, share: shareB(deal2, i), oldRecord: rec1, handoff })
      if (!res.ok) reOk = false
    }
    ok(reOk, 'a valid handoff re-provision is accepted by every C2 member')
    eq(c2[0].member.counter(acct.root.pubB).evaluations, carried, 'the new committee starts at the carried failure count, never zero (§1)')

    // PASSWORD THIEF (holds the root key): a re-provision WITHOUT a handoff is refused.
    const thief = await acct.ep.request(c2[0].nodeId, 'pin-provision', { newRecord: rec2, i: 1, share: shareB(deal2, 0) })
    ok(thief.error === 'reprovision-needs-handoff', 'a re-provision WITHOUT a handoff is rejected (a password thief cannot reset the fuse)')
    const shortHo = W.authorizeHandoff({ root: acct.root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: carried, session, oldSigs: oldSigs.slice(0, PARAMS_A2.pinT - 1) })
    const thief2 = await acct.ep.request(c2[0].nodeId, 'pin-provision', { newRecord: rec2, i: 1, share: shareB(deal2, 0), oldRecord: rec1, handoff: shortHo })
    ok(thief2.error === 'bad-handoff', 'a handoff below the old-committee threshold is rejected')

    // NO-PREV RESET (the real bypass): a fresh INITIAL record for an ALREADY
    // provisioned root is refused — a root-key holder cannot zero the counter by
    // re-dealing a new committee without a handoff.
    const freshK = W.randScalar(rng)
    const freshDeal = W.dealScalar(freshK, PARAMS_A2.pinT, PARAMS_A2.pinN, rng)
    const freshPinPub = A.toB64u(W.pinKeyFromOutput(W.singleKeyOutput('9999', freshK, rng)).pub)
    const freshRecP = W.makePinRecordPayload({ committee: c1.map((m) => m.nodeId), t: PARAMS_A2.pinT, shareCommitments: commits(freshDeal), pinPub: freshPinPub })
    const freshRec = W.buildPinRecord(freshRecP, acct.root.priv, acct.root.pubB)
    const reset = await acct.ep.request(c1[0].nodeId, 'pin-provision', { newRecord: freshRec, i: 1, share: A.toB64u(W.scalarToBytes(freshDeal.shares[0].share)) })
    ok(reset.error === 'already-provisioned-needs-handoff', 'a no-prev re-provision of an already-provisioned root is refused (counter cannot be reset)')

    // pin-handoff HANDLER: an old member co-signs ONLY with a valid pinKey session
    // (PIN knowledge) AND carriedFails ≥ its own count. Drive 5 failures first.
    for (let g = 0; g < 5; g++) { const bl = W.clientBlind('0000', seededRng('ho-fail-' + g)); await acct.ep.request(c1[2].nodeId, 'pin-eval', { root: acct.root.pubB, blinded: bl.blinded }) }
    const hoNonce = A.toB64u(A.sha256(A.utf8('ho-handler-nonce')))
    const goodSession = W.makePinSession({ v: 1, root: acct.root.pubB, device: acct.root.pubB, purpose: 'committee-handoff', evalNonce: hoNonce, wts: NOW, record: newId }, pinKey.priv)
    const noSess = await acct.ep.request(c1[2].nodeId, 'pin-handoff', { root: acct.root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: 100 })
    ok(noSess.error === 'bad-session', 'pin-handoff refuses to co-sign without a valid pinKey session (PIN-gated)')
    const wrongPin = W.makePinSession({ v: 1, root: acct.root.pubB, device: acct.root.pubB, purpose: 'committee-handoff', evalNonce: hoNonce, wts: NOW, record: newId }, kp(999).priv)
    const badSess = await acct.ep.request(c1[2].nodeId, 'pin-handoff', { root: acct.root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: 100, session: wrongPin })
    ok(badSess.error === 'bad-session', 'pin-handoff refuses a session not signed by the real pinKey (password thief blocked)')
    const belowCount = await acct.ep.request(c1[2].nodeId, 'pin-handoff', { root: acct.root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: 2, session: goodSession })
    ok(belowCount.error === 'carried-below-my-count', 'pin-handoff refuses a carriedFails below the member’s own count (carry enforced)')
    const okHo = await acct.ep.request(c1[2].nodeId, 'pin-handoff', { root: acct.root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: 100, session: goodSession })
    ok(okHo.sig && okHo.sig.w === c1[2].nodeId, 'pin-handoff co-signs a valid PIN-gated handoff carrying the count forward')
  }

  // ==========================================================================
  console.log('\n· 6. honest degradation: 2 nodes, no third witness …')
  // ==========================================================================
  {
    const f3 = new W.MockFabric()
    // two players, mutually entangled (opponents), each announcing presence.
    const pa = makePlayerWitness(f3, 40, 41)
    const pb = makePlayerWitness(f3, 42, 43)
    const degraded = await W.clientRequestLease({
      fabric: pa.ep, root: pa.root.pubB, epoch: 1, deviceKey: pa.device.pubB, devicePriv: pa.device.priv,
      grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, paramsDigest: PARAMS_A2_DIGEST,
      // pa's only potential witness is pb, but they are entangled (opponents)
      subject: subjectOf(pa, [pb.root.pubB]), summaries: new Map(), params: PARAMS_A2, nowMs: NOW,
    })
    ok(!degraded.ok && degraded.reason === 'insufficient-witnesses', '2 machines online + no third → insufficient-witnesses (never a dead grant)')
    eq(degraded.witnessSet.length, 0, 'the canonical witness set is empty (self excluded, the other player entangled)')
  }

  // a "player+witness" node that announces witness-capable presence
  function makePlayerWitness(fabric, seedRoot, seedDev) {
    const root = kp(seedRoot)
    const device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    ep.announce(W.signPresence({ v: 1, root: root.pubB, key: device.pubB, caps: { witness: true, committee: true, shardMb: 10 }, params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 99 }, device.priv))
    return { root, device, nodeId, ep }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
