// A4 brick 1b: the four A2→A3 residual witness seams, forced shut
// (the four A2→A3 residual seams, A4 brick 1b).
//
//   node scripts/test-accounts-seams.mjs
//
// Multi-node MockFabric scenarios that FORCE each previously-open hole:
//   1. counter ANTI-SPREADING: a hot+rotate quorum spread holds the legacy
//      t-th-largest at 1/4 of the true guess count; the converged signed-report
//      statistic recovers the TRUE count, the fuse trips at it, forged/inflated
//      reports are signature/trim-bounded, regressions yield evidence, and a
//      re-provisioned committee cannot reset the carried count;
//   2. FULL canonical-set lease verification at attest (WitnessDeps.verifyLease
//      via makeChainLeaseCheck): sub-threshold and non-canonical-set leases are
//      refused once chain facts are present, still floor-accepted without them;
//   3. chain-authoritative PIN anchoring: a handoff against a STALE/foreign
//      pin record is refused once the chain anchors ('pin' events, gen+1 per
//      handoff); the A2 co-signature gate remains the labeled live fallback;
//   4. authenticated device ownership at lease grant: an uncertified or
//      revoked device key is refused a grant; a certified one passes
//      ('chain-verified'); no chain ⇒ the labeled 'attributed' A2 path.
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
  const outdir = makeOutdir('accounts-seams-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W } = M
  const { PARAMS_A2, PARAMS_A2_DIGEST } = W
  const NOW = 1_700_000_000_000
  const T = PARAMS_A2.pinT // 6
  const N = PARAMS_A2.pinN // 9

  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
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

  /** A fabric node running witnessServe + memberServe; `extras.witness(ep)` /
   * `extras.member(ep)` inject the A4 seam deps (verifyLease / ownershipOf /
   * anchorOf) exactly where an A3-replicating embedder would. */
  function makeNode(fabric, seedRoot, seedDev, fuses, extras = {}) {
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
    const witness = W.witnessServe(ep, id, { store, wts: () => NOW, fuseOf, timeWindowMs: PARAMS_A2.timeWindowMs, ...(extras.witness ? extras.witness(ep) : {}) })
    const member = W.memberServe(ep, id, { wts: () => NOW, fuseOf, ...(extras.member ? extras.member(ep) : {}) })
    return { root, device, nodeId, ep, witness, member, store }
  }

  function makePlayer(fabric, seedRoot, seedDev, name) {
    const root = kp(seedRoot)
    const device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    const chain = A.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: name, ts: NOW, device: { pub: device.pubB, index: 0, label: 'A' } })
    return { root, device, nodeId, ep, chain }
  }

  const summariesFor = (nodes) =>
    new Map(nodes.map((n) => [n.nodeId, { root: n.root.pubB, nodeId: n.nodeId, trustMicro: 1_000_000, secondDegreeRoots: new Set() }]))
  const subjectOf = (p) => ({ root: p.root.pubB, nodeId: p.nodeId, entangledRoots: new Set(), secondDegreeRoots: new Set() })

  /** Deal + directly provision a committee (with the committee list wired so
   * the members can converge, the A4 opts). Returns the full descriptor. */
  function provisionCommittee(nodes, rootPriv, rootB, pin, rng) {
    const members = nodes.slice(0, N)
    const k = W.randScalar(rng)
    const deal = W.dealScalar(k, T, N, rng)
    const pinKey = W.pinKeyFromOutput(W.singleKeyOutput(pin, k, rng))
    const pinPub = A.toB64u(pinKey.pub)
    const committeeIds = members.map((m) => m.nodeId)
    const shareCommitments = deal.shares.map((s) => A.toB64u(W.pointToBytes(W.shareCommitment(s.share))))
    const payload = W.makePinRecordPayload({ committee: committeeIds, t: T, shareCommitments, pinPub })
    const record = W.buildPinRecord(payload, rootPriv, rootB)
    const recId = W.pinRecordId(payload)
    members.forEach((m, idx) => {
      m.member.provision(rootB, deal.shares[idx].i, deal.shares[idx].share, shareCommitments[idx], pinPub, recId, { committee: committeeIds })
    })
    return { members: committeeIds, memberNodes: members, t: T, shareCommitments, pinPub, payload, record, recId, pinKey, k }
  }

  // ==========================================================================
  console.log('\n· 1. counter anti-spreading: converged reports beat quorum rotation …')
  // ==========================================================================
  {
    const fabric = new W.MockFabric()
    const nodes = Array.from({ length: N }, (_, i) => makeNode(fabric, 2000 + i, 2050 + i, new Map()))
    const victim = makePlayer(fabric, 100, 101, 'Victim')
    const rootB = victim.root.pubB
    const com = provisionCommittee(nodes, victim.root.priv, rootB, '4271', seededRng('seam1'))
    const kOf = new Map(nodes.map((n) => [n.nodeId, n.device.pubB]))

    // Hot+rotate spread: 5 fixed hot members in every quorum, the 6th slot
    // rotates over the remaining 4: the schedule that maximizes the legacy
    // t-th-largest discount. 100 true guesses.
    const G = PARAMS_A2.pinLifetimeFails // 100
    const hot = nodes.slice(0, T - 1)
    const cold = nodes.slice(T - 1)
    for (let g = 0; g < G; g++) {
      const quorum = [...hot, cold[g % cold.length]]
      const bl = W.clientBlind('0000', seededRng('spread-' + g))
      for (const m of quorum) await victim.ep.request(m.nodeId, 'pin-eval', { root: rootB, blinded: bl.blinded })
    }
    eq(W.memberFails(nodes[0].member.counter(rootB)), G, 'a hot member observed all 100 failures locally')
    eq(W.memberFails(nodes[T - 1].member.counter(rootB)), G / 4, 'a rotated member observed only 25 locally (the spread)')

    // THE HOLE (legacy statistic): t-th-largest of local counters = 25. The
    // spread stretched the 100-guess budget 4× under A2's effectiveCount.
    const legacy = await W.collectAttemptReports(victim.ep, rootB, com.members, (w) => kOf.get(w))
    eq(W.effectiveCount(legacy, T), G / 4, `legacy t-th-largest sees only ${G / 4} of ${G} true failures (the spread hole)`)

    // THE CLOSE: one gossip round converges a spread-blinded member to the TRUE count.
    eq(nodes[T - 1].member.convergedCount(rootB), G / 4, 'before gossip a rotated member still sees 25')
    const conv = await nodes[T - 1].member.syncCounters(rootB)
    eq(conv, G, 'after one pin-counter-sync round the converged count equals the TRUE guess count (100)')
    eq(nodes[T - 1].member.counterReports(rootB).length, N - 1, 'the member holds a verified signed report from every peer')

    // The fuse now trips at the true count: the merged report set rides the
    // trip flow, so even never-synced members self-qualify on the converged view.
    const fuse = await W.tripFuseIfDue({ fabric: victim.ep, root: rootB, committee: com.members, pinRecord: com.recId, keyOf: kOf, wts: NOW })
    ok(fuse !== null, 'tripFuseIfDue trips the fuse despite the quorum-rotation spread')
    ok(fuse && fuse.body.fails === G, `the fuse records the TRUE count (${fuse && fuse.body.fails})`)
    ok(fuse && W.verifyFuseRecord(fuse, com.members, kOf).ok, 'the assembled fuse verifies (≥ pinT co-signatures, each on a converged count)')

    // FORGED reports (attacker key claiming member w's) merge to NOTHING: a
    // fresh victim with a clean committee cannot be tripped by fabricated data.
    const vf = new W.MockFabric()
    const vnodes = Array.from({ length: N }, (_, i) => makeNode(vf, 2100 + i, 2150 + i, new Map()))
    const clean = makePlayer(vf, 104, 105, 'Clean')
    const vcom = provisionCommittee(vnodes, clean.root.priv, clean.root.pubB, '4271', seededRng('seam1-clean'))
    const vkOf = new Map(vnodes.map((n) => [n.nodeId, n.device.pubB]))
    const evil = kp(4242)
    const forged = vcom.members.map((w) =>
      W.signCounterReport({ root: clean.root.pubB, w, rec: vcom.recId, gen: 0, fails: 1_000_000, asOfWts: NOW }, evil.pubB, evil.priv))
    const noTrip = await W.tripFuseIfDue({ fabric: clean.ep, root: clean.root.pubB, committee: vcom.members, pinRecord: vcom.recId, keyOf: vkOf, wts: NOW, reports: forged })
    ok(noTrip === null, 'reports signed by a non-member key are worthless: a clean account cannot be fuse-tripped')

    // A single MALICIOUS member's inflated (real-signature) report is
    // trim-bounded: it cannot poison the converged count without ≥ n−t peers.
    const inflated = W.signCounterReport(
      { root: rootB, w: nodes[1].nodeId, rec: com.recId, gen: 0, fails: 1_000_000_000, asOfWts: NOW + 1 },
      nodes[1].device.pubB, nodes[1].device.priv)
    await victim.ep.request(nodes[0].nodeId, 'pin-counter-sync', { root: rootB, reports: [inflated] })
    const bounded = nodes[0].member.convergedCount(rootB)
    ok(bounded <= 2 * G, `one inflated report is trimmed. Converged count stays bounded by honest observations (${bounded})`)

    // Monotonicity: a member signing a REGRESSING pair is misbehavior evidence.
    const rA = W.signCounterReport({ root: rootB, w: nodes[2].nodeId, rec: com.recId, gen: 0, fails: 50, asOfWts: NOW }, nodes[2].device.pubB, nodes[2].device.priv)
    const rB = W.signCounterReport({ root: rootB, w: nodes[2].nodeId, rec: com.recId, gen: 0, fails: 10, asOfWts: NOW + 5000 }, nodes[2].device.pubB, nodes[2].device.priv)
    const mres = W.mergeCounterReports(new Map(), [rA, rB])
    eq(mres.regressions.length, 1, 'a signed regressing pair is detected at merge')
    ok(mres.regressions[0].later.body.fails === 10 && mres.regressions[0].earlier.body.fails === 50, 'the evidence carries both signed reports (portable misbehavior proof)')
    ok(mres.merged.get(nodes[2].nodeId).body.fails === 50, 'the monotonic maximum wins the merge, the regression never lowers the count')
    await victim.ep.request(nodes[3].nodeId, 'pin-counter-sync', { root: rootB, reports: [rA, rB] })
    eq(nodes[3].member.counterEvidence(rootB).length, 1, 'a live member retains regression evidence from a sync exchange')

    // RE-PROVISION CANNOT RESET (the §1 carry, now spread-proof): a rotated old
    // member (locally at 25) refuses to co-sign a handoff carrying less than
    // the CONVERGED 100; at 100 it signs; the new committee starts at 100.
    const rng2 = seededRng('seam1-handoff')
    const deal2 = W.dealScalar(com.k, T, N, rng2)
    const c2nodes = [nodes[T - 1], ...Array.from({ length: N - 1 }, (_, i) => makeNode(fabric, 2200 + i, 2250 + i, new Map()))]
    const commits2 = deal2.shares.map((s) => A.toB64u(W.pointToBytes(W.shareCommitment(s.share))))
    const rec2p = W.makePinRecordPayload({ committee: c2nodes.map((m) => m.nodeId), t: T, shareCommitments: commits2, pinPub: com.pinPub, prev: com.recId, carriedFails: G })
    const rec2 = W.buildPinRecord(rec2p, victim.root.priv, rootB)
    const rec2Id = W.pinRecordId(rec2p)
    const nonce = A.toB64u(A.sha256(A.utf8('seam1-nonce')))
    const session = W.makePinSession({ v: 1, root: rootB, device: rootB, purpose: 'committee-handoff', evalNonce: nonce, wts: NOW, record: rec2Id }, com.pinKey.priv)
    const lowMember = nodes[T - 1] // local count 25, converged 100
    const below = await victim.ep.request(lowMember.nodeId, 'pin-handoff', { root: rootB, prevPinRecord: com.recId, newPinRecord: rec2Id, carriedFails: G / 4, session })
    eq(below.error, 'carried-below-my-count', 'a spread-blinded old member REFUSES a carry at its low local count (converged floor holds)')
    const atConv = await victim.ep.request(lowMember.nodeId, 'pin-handoff', { root: rootB, prevPinRecord: com.recId, newPinRecord: rec2Id, carriedFails: G, session })
    ok(atConv.sig && atConv.sig.w === lowMember.nodeId, 'the same member co-signs when the carry equals the converged count')
    const oldSigs = nodes.slice(0, T).map((m) => W.signHandoff(rootB, com.recId, rec2Id, G, m.nodeId, m.device.pubB, m.device.priv))
    const handoff = W.authorizeHandoff({ root: rootB, prevPinRecord: com.recId, newPinRecord: rec2Id, carriedFails: G, session, oldSigs })
    let reOk = true
    for (let i = 0; i < N; i++) {
      const res = await victim.ep.request(c2nodes[i].nodeId, 'pin-provision', { newRecord: rec2, i: i + 1, share: A.toB64u(W.scalarToBytes(deal2.shares[i].share)), oldRecord: com.record, handoff })
      if (!res.ok) reOk = false
    }
    ok(reOk, 'the full handoff re-provision is accepted by every new-committee member')
    eq(c2nodes[1].member.counter(rootB).evaluations, G, 'a FRESH new-committee member starts at the true carried count. The spread cannot be laundered out by re-provisioning')
    // gen-tagging: the overlapping member re-provisioned at gen 1; a fresh peer
    // learns that from its signed report.
    await c2nodes[1].member.syncCounters(rootB)
    const overlapRep = c2nodes[1].member.counterReports(rootB).find((r) => r.body.w === c2nodes[0].nodeId)
    ok(overlapRep && overlapRep.body.gen === 1 && overlapRep.body.fails >= G, 'an overlapping member reports at gen 1 with the carried count (gen-tagged monotonicity)')
  }

  // ==========================================================================
  console.log('\n· 2. full canonical-set lease verification at attest …')
  // ==========================================================================
  {
    const fabric = new W.MockFabric()
    const fuses = new Map()
    const alice = makePlayer(fabric, 110, 111, 'Alice')
    const rootB = alice.root.pubB
    let witnesses
    const factsOf = (root) => {
      if (root !== rootB || !witnesses) return null
      return { subject: subjectOf(alice), summaries: summariesFor(witnesses) }
    }
    // w0 holds Alice's chain facts (A3 replication) → the FULL check is wired;
    // the other witnesses run the bare A2 floor.
    witnesses = Array.from({ length: PARAMS_A2.wN }, (_, i) =>
      makeNode(fabric, 2400 + i, 2450 + i, fuses, i === 0 ? {
        witness: (ep) => ({
          verifyLease: W.makeChainLeaseCheck({
            factsOf,
            directory: () => ep.directory(),
            params: PARAMS_A2,
            nowMs: () => NOW,
            fuseOf: (r) => fuses.get(r) ?? null,
          }),
        }),
      } : {}))
    const [w0, w1] = witnesses
    const genesisHead = A.witnessedHeadOf(alice.chain.events)
    for (const w of witnesses) await w.witness.seedHead(rootB, { id: genesisHead.id, height: 0 })

    // Leases are granted to the ROOT key as device (so chain events are
    // root-signed: scenario 3 appends a root-signed 'pin' anchor here too).
    const summaries = summariesFor(witnesses)
    const full = await W.clientRequestLease({
      fabric: alice.ep, root: rootB, epoch: 1, deviceKey: rootB, devicePriv: alice.root.priv,
      grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, paramsDigest: PARAMS_A2_DIGEST,
      subject: subjectOf(alice), summaries, params: PARAMS_A2, nowMs: NOW,
    })
    ok(full.ok && full.lease.grants.length === PARAMS_A2.tLease, 'a full canonical lease gathers tLease grants')

    // A SUB-THRESHOLD lease: ONE real canonical grantor. Passes the A2
    // context-free ≥1-grant floor, fails the full threshold check.
    const subBody = W.buildLeaseBody({ root: rootB, epoch: 1, device: rootB, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST })
    const subLease = W.grantLease(subBody, [W.signGrant(subBody, w1.nodeId, w1.device.pubB, w1.device.priv, NOW)])
    // A NON-CANONICAL-SET lease: tLease valid signatures from rogue nodes that
    // are in NOBODY's directory. Also ≥1-grant-floor-passing.
    const rogues = Array.from({ length: PARAMS_A2.tLease }, (_, i) => kp(3000 + i))
    const rogueLease = W.grantLease(subBody, rogues.map((r) => W.signGrant(subBody, W.nodeIdOf(r.pub), r.pubB, r.priv, NOW)))

    const mkEvent = (height, prev, payload) =>
      A.signBody({ v: 1, lane: 'w', type: 'revoke', root: rootB, key: rootB, height, prev, ts: NOW, payload }, alice.root.priv)
    const ev1 = mkEvent(1, genesisHead.id, { pub: kp(3100).pubB })

    const subRes = await alice.ep.request(w0.nodeId, 'attest', { event: ev1, lease: subLease })
    eq(subRes.error, 'lease-invalid', 'with chain facts, a witness REFUSES a sub-threshold lease at attest')
    const rogueRes = await alice.ep.request(w0.nodeId, 'attest', { event: ev1, lease: rogueLease })
    eq(rogueRes.error, 'lease-invalid', 'with chain facts, a witness REFUSES a lease granted outside the canonical set')
    const fullRes = await alice.ep.request(w0.nodeId, 'attest', { event: ev1, lease: full.lease })
    ok(fullRes.attestation && W.verifyAttestation(fullRes.attestation, A.eventId(ev1.body)), 'the same witness attests the same event under the FULL canonical lease')

    // Honest degradation UNCHANGED: a facts-less witness floor-accepts the
    // sub-threshold lease (context-free ≥1 valid grant).
    const floorRes = await alice.ep.request(w1.nodeId, 'attest', { event: ev1, lease: subLease })
    ok(floorRes.attestation && W.verifyAttestation(floorRes.attestation, A.eventId(ev1.body)), 'a witness WITHOUT chain facts still floor-accepts a ≥1-grant lease (honest degradation)')
    // ... and a facts-holding witness treats a FOREIGN root exactly the same way.
    const checkNoFacts = W.makeChainLeaseCheck({ factsOf: () => null, directory: () => w0.ep.directory(), params: PARAMS_A2, nowMs: () => NOW })
    eq(checkNoFacts(subLease), true, 'makeChainLeaseCheck degrades to the floor (true) for roots with no facts')

    // Epoch monotonicity vs the cached head rides the same hook.
    const checkEpoch = W.makeChainLeaseCheck({ factsOf, directory: () => w0.ep.directory(), params: PARAMS_A2, nowMs: () => NOW, epochOf: () => 5 })
    eq(checkEpoch(full.lease), false, 'a lease at an epoch below the cached head is refused by the full check')
    const zeroGrant = W.grantLease(subBody, [])
    eq(W.makeChainLeaseCheck({ factsOf, directory: () => w0.ep.directory(), params: PARAMS_A2, nowMs: () => NOW })(zeroGrant), false, 'a grantless lease fails the full check outright')

    // The wave-0 'pin' witnessed event type rides the LIVE append flow: the
    // anchor event gathers real attestations and the chain still verifies.
    let chain = A.appendEvent(alice.chain, { ...ev1, wit: [fullRes.attestation] })
    const anchorDigest = A.toB64u(A.sha256(A.utf8('some-pin-record')))
    const pinAppend = await W.clientAppendWitnessed({
      fabric: alice.ep, chain, lease: full.lease, deviceKey: rootB, devicePriv: alice.root.priv,
      type: 'pin', payload: { record: anchorDigest, gen: 0 }, ts: NOW, epoch: 1,
      witnessSet: full.witnessSet, players: new Set([alice.nodeId]),
    })
    ok(pinAppend.ok, "a 'pin' anchor event appends through the witnessed-lane flow with live attestations")
    ok(pinAppend.ok && A.verifyChain(pinAppend.chain).ok, 'the chain carrying the witnessed pin anchor fully verifies')
    const liveAnchor = W.newestPinAnchor(rootB, pinAppend.chain.events)
    ok(liveAnchor && liveAnchor.record === anchorDigest && liveAnchor.gen === 0, 'newestPinAnchor reads the witnessed anchor back')
  }

  // ==========================================================================
  console.log('\n· 3. chain-authoritative PIN-record anchoring for handoff …')
  // ==========================================================================
  {
    const fabric = new W.MockFabric()
    const acct = makePlayer(fabric, 120, 121, 'Anchored')
    const rootB = acct.root.pubB
    // The replica the members resolve: scenario stand-in for the A3
    // viewer/overlay resolution (verifiedPinAnchor gates on verifyChain either way).
    const replica = { chain: acct.chain }
    const anchorOf = (root) => (root === rootB ? W.verifiedPinAnchor(replica.chain) : null)
    const withAnchor = { member: () => ({ anchorOf }) }
    const c1 = Array.from({ length: N }, (_, i) => makeNode(fabric, 2600 + i, 2650 + i, new Map(), withAnchor))
    const c2 = Array.from({ length: N }, (_, i) => makeNode(fabric, 2700 + i, 2750 + i, new Map(), withAnchor))
    const noChainNode = makeNode(fabric, 2790, 2791, new Map()) // no anchorOf: the A2 fallback member

    const rng = seededRng('seam3')
    const k = W.randScalar(rng)
    const pinKey = W.pinKeyFromOutput(W.singleKeyOutput('4271', k, rng))
    const pinPub = A.toB64u(pinKey.pub)
    const deal = (tag) => W.dealScalar(k, T, N, seededRng('seam3-' + tag))
    const commits = (d) => d.shares.map((s) => A.toB64u(W.pointToBytes(W.shareCommitment(s.share))))
    const shareB = (d, i) => A.toB64u(W.scalarToBytes(d.shares[i].share))

    const deal1 = deal('c1')
    const rec1p = W.makePinRecordPayload({ committee: c1.map((m) => m.nodeId), t: T, shareCommitments: commits(deal1), pinPub })
    const rec1 = W.buildPinRecord(rec1p, acct.root.priv, rootB)
    const rec1Id = W.pinRecordId(rec1p)

    // Initial provision BEFORE any anchor exists → the initial path.
    const init = await acct.ep.request(c1[0].nodeId, 'pin-provision', { newRecord: rec1, i: 1, share: shareB(deal1, 0) })
    ok(init.ok && init.path === 'initial', 'first-ever provision (no chain anchor yet) is admitted on the initial path')
    for (let i = 1; i < N; i++) await acct.ep.request(c1[i].nodeId, 'pin-provision', { newRecord: rec1, i: i + 1, share: shareB(deal1, i) })

    // Anchor gen 0 in the owner's chain.
    replica.chain = W.appendPinAnchor(replica.chain, acct.root.priv, rec1p, NOW + 1)
    const a0 = W.verifiedPinAnchor(replica.chain)
    ok(a0 && a0.record === rec1Id && a0.gen === 0, 'the appended anchor (gen 0) reads back from the VERIFIED chain')

    // With an anchor on-chain, an initial-shaped record is refused EVEN at a
    // fresh member holding no local share: the root-key thief's reset dies here.
    const kThief = W.randScalar(seededRng('seam3-thief'))
    const dThief = W.dealScalar(kThief, T, N, seededRng('seam3-thief-deal'))
    const thiefPub = A.toB64u(W.pinKeyFromOutput(W.singleKeyOutput('9999', kThief, seededRng('seam3-thief-out'))).pub)
    const thiefRec = W.buildPinRecord(
      W.makePinRecordPayload({ committee: c2.map((m) => m.nodeId), t: T, shareCommitments: commits(dThief), pinPub: thiefPub }),
      acct.root.priv, rootB)
    const reset = await acct.ep.request(c2[0].nodeId, 'pin-provision', { newRecord: thiefRec, i: 1, share: A.toB64u(W.scalarToBytes(dThief.shares[0].share)) })
    eq(reset.error, 'chain-anchored-needs-handoff', 'an initial-shaped provision at a FRESH member is refused once the chain anchors a committee')

    // Legit handoff C1 → C2 (old record IS the anchored one) → chain-anchored path.
    const deal2 = deal('c2')
    const rec2p = W.makePinRecordPayload({ committee: c2.map((m) => m.nodeId), t: T, shareCommitments: commits(deal2), pinPub, prev: rec1Id, carriedFails: 0 })
    const rec2 = W.buildPinRecord(rec2p, acct.root.priv, rootB)
    const rec2Id = W.pinRecordId(rec2p)
    const sess2 = W.makePinSession({ v: 1, root: rootB, device: rootB, purpose: 'committee-handoff', evalNonce: A.toB64u(A.sha256(A.utf8('s3-n2'))), wts: NOW, record: rec2Id }, pinKey.priv)
    const oldSigs2 = c1.slice(0, T).map((m) => W.signHandoff(rootB, rec1Id, rec2Id, 0, m.nodeId, m.device.pubB, m.device.priv))
    const ho2 = W.authorizeHandoff({ root: rootB, prevPinRecord: rec1Id, newPinRecord: rec2Id, carriedFails: 0, session: sess2, oldSigs: oldSigs2 })
    const prov2 = await acct.ep.request(c2[0].nodeId, 'pin-provision', { newRecord: rec2, i: 1, share: shareB(deal2, 0), oldRecord: rec1, handoff: ho2 })
    ok(prov2.ok && prov2.path === 'chain-anchored', 'a handoff whose old record matches the chain anchor is admitted on the CHAIN-ANCHORED path')
    for (let i = 1; i < N; i++) await acct.ep.request(c2[i].nodeId, 'pin-provision', { newRecord: rec2, i: i + 1, share: shareB(deal2, i), oldRecord: rec1, handoff: ho2 })

    // Handoff appends gen+1.
    replica.chain = W.appendPinAnchor(replica.chain, acct.root.priv, rec2p, NOW + 2)
    const a1 = W.verifiedPinAnchor(replica.chain)
    ok(a1 && a1.record === rec2Id && a1.gen === 1, 'the handoff anchor appends at gen+1 and becomes the newest')
    eq(W.nextAnchorGen(rootB, replica.chain.events), 2, 'nextAnchorGen advances past the newest anchor')

    // STALE-RECORD ATTACK: a thief re-plays the CAPTURED rec1 (once real, now
    // superseded) to authorize a re-provision: with the pinKey and enough old
    // co-signatures, the A2 gate would pass. The anchor kills it.
    const deal3 = deal('c3')
    const c3members = [...c2.slice(0, N - 1), noChainNode] // fallback member holds the last slot
    const rec3p = W.makePinRecordPayload({ committee: c3members.map((m) => m.nodeId), t: T, shareCommitments: commits(deal3), pinPub, prev: rec1Id, carriedFails: 0 })
    const rec3 = W.buildPinRecord(rec3p, acct.root.priv, rootB)
    const rec3Id = W.pinRecordId(rec3p)
    const sess3 = W.makePinSession({ v: 1, root: rootB, device: rootB, purpose: 'committee-handoff', evalNonce: A.toB64u(A.sha256(A.utf8('s3-n3'))), wts: NOW, record: rec3Id }, pinKey.priv)
    const oldSigs3 = c1.slice(0, T).map((m) => W.signHandoff(rootB, rec1Id, rec3Id, 0, m.nodeId, m.device.pubB, m.device.priv))
    const ho3 = W.authorizeHandoff({ root: rootB, prevPinRecord: rec1Id, newPinRecord: rec3Id, carriedFails: 0, session: sess3, oldSigs: oldSigs3 })
    const stale = await acct.ep.request(c2[1].nodeId, 'pin-provision', { newRecord: rec3, i: 2, share: shareB(deal3, 1), oldRecord: rec1, handoff: ho3 })
    eq(stale.error, 'stale-old-record', 'a handoff built on the STALE captured record is refused once the chain anchors the current one')

    // The A2 co-signature gate remains the LIVE fallback where no chain is
    // resolvable, and the admission says which path let it in.
    noChainNode.member.provision(rootB, 2, deal2.shares[1].share, commits(deal2)[1], pinPub, rec2Id, { committee: c2.map((m) => m.nodeId) })
    const fb = await acct.ep.request(noChainNode.nodeId, 'pin-provision', { newRecord: rec3, i: N, share: shareB(deal3, N - 1), oldRecord: rec1, handoff: ho3 })
    ok(fb.ok && fb.path === 'cosig-fallback', 'with NO resolvable chain the pinKey-gated co-signature gate admits, LABELED cosig-fallback (honest surfacing)')

    // Pure-check coverage: a FOREIGN record digest never matches the anchor.
    const foreign = W.checkHandoffAnchor(rec1, { record: rec3Id, gen: 7, height: 9 })
    ok(!foreign.ok && foreign.reason === 'stale-old-record', 'checkHandoffAnchor refuses a record that is not the anchored one')
    ok(W.checkHandoffAnchor(rec1, null).ok && W.checkHandoffAnchor(rec1, null).path === 'cosig-fallback', 'checkHandoffAnchor labels the no-chain fallback')
    // An unverifiable chain anchors nothing (fail closed).
    const broken = { root: rootB, events: replica.chain.events.slice(1) }
    eq(W.verifiedPinAnchor(broken), null, 'a chain that fails verification anchors NOTHING (fail closed)')
  }

  // ==========================================================================
  console.log('\n· 4. authenticated device ownership at lease grant …')
  // ==========================================================================
  {
    const fabric = new W.MockFabric()
    const fuses = new Map()
    const owner = makePlayer(fabric, 130, 131, 'Owner') // devA certified at creation
    const rootB = owner.root.pubB
    const devA = owner.device
    const devB = kp(133) // never certified
    const devC = kp(135) // certified, then revoked

    let chain = owner.chain
    chain = A.appendEvent(chain, A.makeCertEvent(owner.root.priv, rootB, chain, { childPub: devC.pubB, purpose: 0, index: 1, ts: NOW + 1 }))
    chain = A.appendEvent(chain, A.makeRevokeEvent(owner.root.priv, rootB, chain, { pub: devC.pubB, ts: NOW + 2 }))
    ok(A.verifyChain(chain).ok, 'the owner chain (cert devA, cert+revoke devC) verifies')

    const replicas = new Map([[rootB, chain]])
    const ownershipOf = (root) => {
      const c = replicas.get(root)
      return c ? W.deviceOwnershipFromChain(c) : null
    }
    const wAuth = makeNode(fabric, 2800, 2801, fuses, { witness: () => ({ ownershipOf }) })
    const wBare = makeNode(fabric, 2810, 2811, fuses) // no ownershipOf: pure A2

    const body = (device) => ({ leaseBody: W.buildLeaseBody({ root: rootB, epoch: 1, device, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST }) })

    const gA = await owner.ep.request(wAuth.nodeId, 'lease-grant', body(devA.pubB))
    ok(gA.grant && gA.path === 'chain-verified', 'a CERTIFIED unrevoked device is granted, path chain-verified')
    const gRoot = await owner.ep.request(wAuth.nodeId, 'lease-grant', body(rootB))
    ok(gRoot.grant && gRoot.path === 'chain-verified', 'the root key itself is granted (it owns itself)')
    const gB = await owner.ep.request(wAuth.nodeId, 'lease-grant', body(devB.pubB))
    eq(gB.error, 'device-uncertified', 'an UNCERTIFIED device key is refused a grant (no more blind-signing)')
    ok(gB.grant === undefined, 'the refusal carries no grant signature')
    const gC = await owner.ep.request(wAuth.nodeId, 'lease-grant', body(devC.pubB))
    eq(gC.error, 'device-revoked', 'a REVOKED device key is refused: revocation wins over its certificate (§1)')

    // No chain facts (foreign root / bare witness) ⇒ the A2 attribution-only
    // grant remains, labeled. Never a silent blind-sign upgrade.
    const other = makePlayer(fabric, 140, 141, 'Foreign')
    const gF = await other.ep.request(wAuth.nodeId, 'lease-grant', { leaseBody: W.buildLeaseBody({ root: other.root.pubB, epoch: 1, device: other.device.pubB, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST }) })
    ok(gF.grant && gF.path === 'attributed', 'a root with no replicated chain gets the A2 grant, LABELED attributed')
    const gBare = await owner.ep.request(wBare.nodeId, 'lease-grant', body(devB.pubB))
    ok(gBare.grant && gBare.path === 'attributed', 'a witness without the ownership hook behaves exactly as A2, and says so (attributed)')

    // The fuse still outranks everything at the grant gate.
    fuses.set(rootB, W.makeFuseRecord(rootB, 100, NOW - 1000, A.toB64u(A.sha256(A.utf8('rec'))), []))
    const gFuse = await owner.ep.request(wAuth.nodeId, 'lease-grant', body(devA.pubB))
    eq(gFuse.error, 'fuse-active', 'an active fuse refuses the grant before any ownership question')
    fuses.delete(rootB)

    // Fail-closed derivation: a broken replica proves nothing.
    eq(W.deviceOwnershipFromChain({ root: rootB, events: chain.events.slice(1) }), null, 'a chain that fails verification yields NO ownership facts (fail closed)')
    const own = W.deviceOwnershipFromChain(chain)
    ok(own && own.active.has(devA.pubB) && own.revoked.has(devC.pubB) && !own.certified.has(devB.pubB), 'deviceOwnershipFromChain derives certified/active/revoked exactly from the verified chain')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
