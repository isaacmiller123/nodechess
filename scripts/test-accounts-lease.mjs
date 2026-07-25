// Headless unit suite for the A2 write-lease layer
// (src/shared/accounts/witness/wtime.ts | lease.ts | slash.ts).
//
//   node scripts/test-accounts-lease.mjs
//
// Drives every rule in the §4 write-lease contract as pure-function units:
//   · witnessedTime: integer median, out-of-window survivors, diversity bound;
//   · verifyLease: threshold, witness-set membership, key binding, grant-sig,
//     clock window, expiry, epoch monotonicity, PIN-gated takeover, fuse block,
//     and the small-population (C-10) effective-threshold floor;
//   · slash.adjudicate: same-epoch fork (user), same-epoch different-device
//     double-grant (intersection witnesses, keyOf-attributed), same-device
//     renewal + ALL different-epoch pairs (none — supersession, forks go through
//     adjudicateFork), fabricated-grant framing rejected, and below-threshold (none).
//
// House style: esbuild-bundle the TS on the fly, one-line per assert, exit(1) on
// any failure. Keys are raw fixed 32-byte seeds → ed25519 (no derive.ts).

import { rmSync } from 'node:fs'
import { bundleAndImport, makeOutdir, SRC_ACCOUNTS } from './lib/witness-bundle.mjs'

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const ENTRY = [
  `export * as codec from '${SRC_ACCOUNTS}/codec.ts'`,
  `export * as hash from '${SRC_ACCOUNTS}/hash.ts'`,
  `export * as events from '${SRC_ACCOUNTS}/events.ts'`,
  `export * as chain from '${SRC_ACCOUNTS}/chain.ts'`,
  `export * as certs from '${SRC_ACCOUNTS}/certs.ts'`,
  `export * as wparams from '${SRC_ACCOUNTS}/witness/params.ts'`,
  `export * as distance from '${SRC_ACCOUNTS}/witness/distance.ts'`,
  `export * as presence from '${SRC_ACCOUNTS}/witness/presence.ts'`,
  `export * as wtime from '${SRC_ACCOUNTS}/witness/wtime.ts'`,
  `export * as lease from '${SRC_ACCOUNTS}/witness/lease.ts'`,
  `export * as slash from '${SRC_ACCOUNTS}/witness/slash.ts'`,
  `export * as pin from '${SRC_ACCOUNTS}/witness/pin.ts'`,
].join('\n')

async function main() {
  const outdir = makeOutdir('accounts-lease-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { hash, events, chain, certs, wparams, distance, presence, wtime, lease, slash, pin } = M
  const { PARAMS_A2, PARAMS_A2_DIGEST } = wparams
  const NOW = 1_700_000_000_000

  const seed = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seed(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }

  // ==========================================================================
  console.log('\n· 1. witnessedTime: median, survivors, diversity …')
  // ==========================================================================
  eq(wtime.medianInt([5]), 5, 'medianInt of one value')
  eq(wtime.medianInt([3, 1, 2]), 2, 'medianInt odd count = central order statistic')
  eq(wtime.medianInt([10, 20, 30, 40]), 25, 'medianInt even count floors the mean of the two central')
  eq(wtime.medianInt([10, 21, 30, 41]), 25, 'medianInt even floors (25.5 → 25)')

  const tsParams = { timeWindowMs: PARAMS_A2.timeWindowMs, timeDiversityMin: PARAMS_A2.timeDiversityMin }
  const samp = (w, dt) => ({ w, wts: NOW + dt })
  const wt = wtime.witnessedTime([samp('a', 0), samp('b', 1000), samp('c', -1000)], tsParams)
  eq(wt.medianWts, NOW, 'witnessedTime median over the deduped set')
  eq(wt.attesters.length, 3, 'all in-window samples survive')
  eq(wt.diversityOk, true, '3 in-window survivors satisfy timeDiversityMin=3 (default distant)')
  // an out-of-window sample invalidates only itself
  const wt2 = wtime.witnessedTime(
    [samp('a', 0), samp('b', 1000), samp('c', PARAMS_A2.timeWindowMs + 5000)],
    tsParams,
  )
  eq(wt2.attesters.length, 2, 'the out-of-window attester is dropped from the survivor set')
  eq(wt2.diversityOk, false, 'only 2 survivors → diversity (need 3) fails')
  // dedup by nodeId
  const wt3 = wtime.witnessedTime([samp('a', 0), samp('a', 9_000_000), samp('b', 0)], tsParams)
  eq(wt3.attesters.length, 2, 'duplicate nodeId contributes a single reading (first wins)')
  // distant predicate gates diversity
  const wt4 = wtime.witnessedTime([samp('a', 0), samp('b', 0), samp('c', 0)], tsParams, {
    distant: (w) => w !== 'a',
  })
  eq(wt4.diversityOk, false, 'with only 2 entanglement-distant survivors, diversity fails')
  eq(wtime.witnessedTime([], tsParams), null, 'no samples → null')

  // ==========================================================================
  console.log('\n· 2. lease: build / sign / verify happy path …')
  // ==========================================================================
  // subject account
  const subjKp = kp(1)
  const subjectRoot = subjKp.pubB
  const subject = {
    root: subjectRoot,
    nodeId: distance.nodeIdOf(subjKp.pub),
    entangledRoots: new Set(),
    secondDegreeRoots: new Set(),
  }
  const deviceA = kp(50)
  const deviceB = kp(90)

  // 16 witness nodes announcing presence, all fully trusted/eligible.
  const dir = presence.makeDirectory(600_000)
  const summaries = new Map()
  const witnesses = Array.from({ length: 16 }, (_, i) => {
    const root = kp(200 + i)
    const device = kp(300 + i)
    const nodeId = distance.nodeIdOf(root.pub)
    const body = {
      v: 1, root: root.pubB, key: device.pubB,
      caps: { witness: true, committee: true, shardMb: 100 },
      params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 99,
    }
    const sp = presence.signPresence(body, device.priv)
    dir.ingest(sp, NOW)
    summaries.set(nodeId, { root: root.pubB, nodeId, trustMicro: 1_000_000, secondDegreeRoots: new Set() })
    return { root, device, nodeId }
  })

  const params = PARAMS_A2
  const body = lease.buildLeaseBody({
    root: subjectRoot, epoch: 1, device: deviceA.pubB,
    grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST,
  })
  const bodyHash = lease.leaseBodyHash(body)
  // every witness is fully eligible, so the canonical set is exactly these 16.
  const setIds = new Set(witnesses.map((w) => w.nodeId))
  const grantOf = (w) => lease.signGrant(body, w.nodeId, w.device.pubB, w.device.priv, NOW)
  const nineGrants = witnesses.slice(0, 9).map(grantOf)
  eq(lease.verifyGrantSig(nineGrants[0], bodyHash), true, 'a well-formed grant signature verifies')
  const good = lease.grantLease(body, nineGrants)
  const ctx = { subject, directory: dir.directory, summaries, params, nowMs: NOW, fuse: null, prior: null }
  const v = lease.verifyLease(good, ctx)
  ok(v.ok, `a lease with tLease=${PARAMS_A2.tLease} valid grantors verifies`)
  eq(v.validGrantors.length >= PARAMS_A2.tLease, true, 'the verifier counts ≥ tLease distinct grantors')
  // grantors are a subset of the recomputed witness set
  ok(v.validGrantors.every((w) => setIds.has(w)), 'all counted grantors are in the canonical witness set')

  // ==========================================================================
  console.log('\n· 3. lease: rejection matrix …')
  // ==========================================================================
  eq(lease.verifyLease(lease.grantLease(body, nineGrants.slice(0, 8)), ctx).ok, false, '8 grants (< tLease) → invalid')
  // grantor not in the witness set
  const stranger = kp(999)
  const strangerGrant = lease.signGrant(body, distance.nodeIdOf(stranger.pub), kp(998).pubB, kp(998).priv, NOW)
  const withStranger = lease.grantLease(body, [...nineGrants.slice(0, 8), strangerGrant])
  ok(lease.verifyLease(withStranger, ctx).errors.some((e) => e.includes('not in the canonical witness set')), 'a grantor outside the set is rejected')
  // key mismatch: sign with a device key that is not the advertised one
  const w0 = witnesses[0]
  const wrongKeyGrant = lease.signGrant(body, w0.nodeId, kp(777).pubB, kp(777).priv, NOW)
  const withWrongKey = lease.grantLease(body, [wrongKeyGrant, ...nineGrants.slice(1, 9)])
  ok(lease.verifyLease(withWrongKey, ctx).errors.some((e) => e.includes('advertised presence key')), 'a grant signed by a non-advertised key is rejected')
  // bad grant signature
  const tampered = { ...nineGrants[0], sig: nineGrants[1].sig }
  const withTampered = lease.grantLease(body, [tampered, ...nineGrants.slice(1, 9)])
  ok(lease.verifyLease(withTampered, ctx).errors.some((e) => e.includes('bad grant signature')), 'a tampered grant signature is rejected')
  // grantedWts outside the clock window
  const skewBody = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceA.pubB), grantedWts: NOW + PARAMS_A2.timeWindowMs + 5000 })
  const skewGrants = witnesses.slice(0, 9).map((w) => lease.signGrant(skewBody, w.nodeId, w.device.pubB, w.device.priv, NOW))
  ok(lease.verifyLease(lease.grantLease(skewBody, skewGrants), ctx).errors.some((e) => e.includes('clock window')), 'grantedWts outside the grantor-median window is rejected')
  // expired
  eq(lease.verifyLease(good, { ...ctx, nowMs: NOW + PARAMS_A2.leaseTtlMs + 1 }).errors.some((e) => e === 'lease: expired'), true, 'a lease past grantedWts+ttl is expired')

  // ==========================================================================
  console.log('\n· 4. lease: epoch monotonicity + PIN-gated takeover …')
  // ==========================================================================
  // pinKey (a raw ed25519 keypair standing in for the OPRF-derived pinKey).
  const pinKp = kp(1234)
  const pinPub = pinKp.pubB
  const mkSession = (device, purpose = 'lease-takeover', root = subjectRoot, epoch = 2) =>
    pin.makePinSession({ v: 1, root, device, purpose, evalNonce: kp(4321).pubB, wts: NOW, epoch }, pinKp.priv)

  // same-device renewal at same epoch: allowed
  const renew = lease.grantLease(body, nineGrants)
  eq(lease.verifyLease(renew, { ...ctx, prior: { epoch: 1, device: deviceA.pubB } }).ok, true, 'same-device re-grant at the same epoch (heartbeat) is valid')
  // epoch regress: rejected
  const bodyE0 = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceA.pubB), epoch: 1 })
  const grantsE0 = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyE0, w.nodeId, w.device.pubB, w.device.priv, NOW))
  ok(lease.verifyLease(lease.grantLease(bodyE0, grantsE0), { ...ctx, prior: { epoch: 2, device: deviceA.pubB } }).errors.some((e) => e.includes('epoch regressed')), 'an epoch below the prior lease is rejected')

  // takeover by device B at epoch 2 WITHOUT a session → rejected
  const bodyTakeNoSess = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 2 })
  const grantsTakeNo = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyTakeNoSess, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const takeNo = lease.verifyLease(lease.grantLease(bodyTakeNoSess, grantsTakeNo), { ...ctx, prior: { epoch: 1, device: deviceA.pubB }, pinPub })
  ok(!takeNo.ok && takeNo.errors.some((e) => e.includes('no session referenced')), 'a takeover by a different device WITHOUT any session is rejected')

  // takeover WITH a valid session → accepted
  const session = mkSession(deviceB.pubB)
  const bodyTake = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 2, takeover: lease.pinSessionId(session) })
  const grantsTake = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyTake, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const take = lease.verifyLease(lease.grantLease(bodyTake, grantsTake), { ...ctx, prior: { epoch: 1, device: deviceA.pubB }, pinPub, session })
  ok(take.ok, 'a takeover by a different device WITH a valid PIN session is accepted')
  // epoch-replay: the SAME session (bound to epoch 2) cannot authorize an epoch-3 takeover.
  const bodyReplay = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 3, takeover: lease.pinSessionId(session) })
  const grantsReplay = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyReplay, w.nodeId, w.device.pubB, w.device.priv, NOW))
  ok(lease.verifyLease(lease.grantLease(bodyReplay, grantsReplay), { ...ctx, prior: { epoch: 2, device: deviceA.pubB }, pinPub, session }).errors.some((e) => e.includes('session epoch != lease epoch')), 'a takeover session bound to epoch 2 cannot be replayed at epoch 3')
  // wrong purpose session → rejected
  const badPurpose = mkSession(deviceB.pubB, 'committee-handoff')
  const bodyBadP = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 2, takeover: lease.pinSessionId(badPurpose) })
  const grantsBadP = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyBadP, w.nodeId, w.device.pubB, w.device.priv, NOW))
  ok(lease.verifyLease(lease.grantLease(bodyBadP, grantsBadP), { ...ctx, prior: { epoch: 1, device: deviceA.pubB }, pinPub, session: badPurpose }).errors.some((e) => e.includes('purpose is not lease-takeover')), 'a takeover session with the wrong purpose is rejected')

  // -- ROOT LANE: accounts with NO PIN record (ctx.pinPub absent).
  // Without this lane a PIN-less account can never reach a second device, and a
  // PIN cannot be provisioned without a live committee — the two deadlocked.
  const takeoverCtx = { ...ctx, prior: { epoch: 1, device: deviceA.pubB } }
  const mkRootSession = (device, epoch = 2, root = subjectRoot, priv = subjKp.priv) =>
    pin.makeRootSession({ v: 1, root, device, purpose: 'lease-takeover', evalNonce: kp(4321).pubB, wts: NOW, epoch }, priv, root)

  const rootSession = mkRootSession(deviceB.pubB)
  const bodyRootTake = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 2, takeover: lease.rootSessionId(rootSession) })
  const grantsRootTake = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyRootTake, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const rootTake = lease.verifyLease(lease.grantLease(bodyRootTake, grantsRootTake), { ...takeoverCtx, rootSession })
  ok(rootTake.ok, 'no-PIN account: a takeover WITH a valid root session is accepted')

  // The lane is chosen by the SUBJECT's signed state, not the claimant: an
  // account that HAS a pinPub cannot be downgraded by presenting a root session.
  const downgrade = lease.verifyLease(lease.grantLease(bodyRootTake, grantsRootTake), { ...takeoverCtx, pinPub, rootSession })
  ok(!downgrade.ok && downgrade.errors.some((e) => e.includes('referenced PIN session not presented')), 'a PIN-anchored account cannot be downgraded to the root lane')

  // An attacker's own valid root session cannot authorize the subject's lease:
  // it is signed under the attacker's root, so it fails both the root-match and
  // the signature check. (makeRootSession refuses to mint a session whose body
  // root disagrees with the signing key, so a forgery must come from elsewhere.)
  const attacker = kp(999)
  const attackerSession = mkRootSession(deviceB.pubB, 2, attacker.pubB, attacker.priv)
  const bodyForged = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 2, takeover: lease.rootSessionId(attackerSession) })
  const grantsForged = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyForged, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const forged = lease.verifyLease(lease.grantLease(bodyForged, grantsForged), { ...takeoverCtx, rootSession: attackerSession })
  ok(!forged.ok && forged.errors.some((e) => e.includes('session root != lease root')), "another account's root session cannot authorize this lease")

  // Epoch-replay binding holds on the root lane too.
  const bodyRootReplay = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 3, takeover: lease.rootSessionId(rootSession) })
  const grantsRootReplay = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyRootReplay, w.nodeId, w.device.pubB, w.device.priv, NOW))
  ok(lease.verifyLease(lease.grantLease(bodyRootReplay, grantsRootReplay), { ...ctx, prior: { epoch: 2, device: deviceA.pubB }, rootSession }).errors.some((e) => e.includes('session epoch != lease epoch')), 'root-lane session bound to epoch 2 cannot be replayed at epoch 3')

  // ==========================================================================
  console.log('\n· 5. lease: fuse block + small-population floor …')
  // ==========================================================================
  const fuseBody = { v: 1, root: subjectRoot, fails: 100, trippedWts: NOW - 1000, expiryWts: NOW + 1_000_000, pinRecord: bodyHash, params: PARAMS_A2_DIGEST }
  const fuse = { body: fuseBody, sigs: [] }
  ok(lease.verifyLease(good, { ...ctx, fuse }).errors.some((e) => e.includes('active fuse')), 'granting into an active fuse window is rejected')
  ok(lease.verifyLease(good, { ...ctx, fuse: { ...fuse, body: { ...fuseBody, expiryWts: NOW - 1 } } }).ok, 'an EXPIRED fuse does not block the lease')

  // small population: 1 lone witness → effective threshold floors to 1.
  const tinyDir = presence.makeDirectory(600_000)
  const loneRoot = kp(700), loneDev = kp(710)
  const loneNode = distance.nodeIdOf(loneRoot.pub)
  tinyDir.ingest(presence.signPresence({ v: 1, root: loneRoot.pubB, key: loneDev.pubB, caps: { witness: true, committee: true, shardMb: 5 }, params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 10 }, loneDev.priv), NOW)
  const tinyBody = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceA.pubB), epoch: 1 })
  const loneGrant = lease.signGrant(tinyBody, loneNode, loneDev.pubB, loneDev.priv, NOW)
  const tinyCtx = { subject, directory: tinyDir.directory, summaries: new Map(), params, nowMs: NOW, fuse: null, prior: null }
  const tinyV = lease.verifyLease(lease.grantLease(tinyBody, [loneGrant]), tinyCtx)
  ok(tinyV.ok, 'at 1-witness population the effective threshold floors to 1 (C-10: no dead button)')

  // ==========================================================================
  console.log('\n· 6. slash: adjudication verdicts …')
  // ==========================================================================
  // A real account chain for the fork case (device A certified).
  let c = chain.createAccountChain({ rootPriv: subjKp.priv, rootPub: subjKp.pub, displayName: 'Subj', ts: NOW, device: { pub: deviceA.pubB, index: 0, label: 'A' } })
  const genesisId = events.witnessedHeadOf(c.events).id
  const mkW = (payloadPub) => events.signBody({ v: 1, lane: 'w', type: 'revoke', root: subjectRoot, key: deviceA.pubB, height: 1, prev: genesisId, ts: NOW, payload: { pub: payloadPub } }, deviceA.priv)
  const fA = mkW(kp(61).pubB)
  const fB = mkW(kp(62).pubB) // distinct payload → distinct id, same prev/height
  const certSlice = certs.certsProving(subjectRoot, c.events, [deviceA.pubB])
  const proof = slash.detectSameEpochFork(fA, fB, certSlice)
  ok(proof !== null, 'detectSameEpochFork produces a self-authenticating proof for two successors of one prev')
  const forkVerdict = slash.adjudicateFork(proof)
  eq(forkVerdict.guilty, 'user', 'same-epoch fork: the user is guilty')
  eq(JSON.stringify(forkVerdict.slashed), JSON.stringify([subjectRoot]), 'same-epoch fork slashes the user root')

  // adjudicate binds each grantor to its advertised key (keyOf) before slashing.
  const slashKeyOf = new Map(witnesses.map((w) => [w.nodeId, w.device.pubB]))
  // double-grant, SAME epoch → intersection witnesses.
  const bodyX = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceA.pubB), epoch: 5 })
  const bodyY = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 5 }) // same epoch, different device → distinct body
  const grantsX = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyX, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const grantsY = witnesses.slice(2, 11).map((w) => lease.signGrant(bodyY, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const dg = { root: subjectRoot, a: lease.grantLease(bodyX, grantsX), b: lease.grantLease(bodyY, grantsY), events: [] }
  const sameEpVerdict = slash.adjudicate(dg, { tLease: PARAMS_A2.tLease, keyOf: slashKeyOf })
  eq(sameEpVerdict.guilty, 'witnesses', 'same-epoch double-grant: witnesses are guilty')
  // intersection = witnesses 2..8 (indices 2..8 signed both) → 7 nodes
  const expectInter = witnesses.slice(2, 9).map((w) => w.nodeId).sort()
  eq(JSON.stringify(sameEpVerdict.slashed), JSON.stringify(expectInter), 'the slashed set is exactly the grantors who signed BOTH leases')
  // same epoch + SAME device (heartbeat renewal, different grantedWts) → NOT a
  // double-grant; honest grantors must NOT be slashed.
  const bodyRenew = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceA.pubB), epoch: 5, grantedWts: NOW + 1000 })
  const grantsRenew = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyRenew, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const renewVerdict = slash.adjudicate({ root: subjectRoot, a: lease.grantLease(bodyX, grantsX), b: lease.grantLease(bodyRenew, grantsRenew), events: [] }, { tLease: PARAMS_A2.tLease, keyOf: slashKeyOf })
  eq(renewVerdict.guilty, 'none', 'same-epoch SAME-device renewal is not a double-grant (no honest grantor is slashed)')

  // Different-epoch lease pairs are NOT a double-grant — a later epoch legitimately
  // supersedes an earlier one. The double-grant path returns 'none' regardless of
  // device or of any (unverifiable) events handed to it; a REAL witnessed fork is
  // adjudicated separately by detectSameEpochFork/adjudicateFork on the signed
  // events (tested via the fork path). This closes the fabricated-events slash.
  const forkEv = (pub) => events.signBody({ v: 1, lane: 'w', type: 'revoke', root: subjectRoot, key: deviceA.pubB, height: 1, prev: genesisId, ts: NOW, payload: { pub } }, deviceA.priv)
  const fabricatedEvents = [forkEv(kp(91).pubB), forkEv(kp(92).pubB)]
  const bodyLate = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceB.pubB), epoch: 6 })
  const grantsLate = witnesses.slice(4, 13).map((w) => lease.signGrant(bodyLate, w.nodeId, w.device.pubB, w.device.priv, NOW))
  const dg2 = { root: subjectRoot, a: lease.grantLease(bodyX, grantsX), b: lease.grantLease(bodyLate, grantsLate), events: fabricatedEvents }
  eq(slash.adjudicate(dg2, { tLease: PARAMS_A2.tLease, keyOf: slashKeyOf }).guilty, 'none', 'a different-epoch pair is a legitimate supersession, not a double-grant — even with (unverified) events attached')
  eq(slash.adjudicate({ ...dg2, events: [] }, { tLease: PARAMS_A2.tLease, keyOf: slashKeyOf }).guilty, 'none', 'different-epoch pair with no events: still none')
  // different-epoch SAME device (crash-recovery re-fence) → also none.
  const bodyBump = lease.buildLeaseBody({ ...bodyOpts(subjectRoot, deviceA.pubB), epoch: 6 })
  const grantsBump = witnesses.slice(0, 9).map((w) => lease.signGrant(bodyBump, w.nodeId, w.device.pubB, w.device.priv, NOW))
  eq(slash.adjudicate({ root: subjectRoot, a: lease.grantLease(bodyX, grantsX), b: lease.grantLease(bodyBump, grantsBump), events: [] }, { tLease: PARAMS_A2.tLease, keyOf: slashKeyOf }).guilty, 'none', 'different-epoch SAME-device re-fence slashes no honest grantor')

  // below threshold → none
  const dg4 = { root: subjectRoot, a: lease.grantLease(bodyX, grantsX.slice(0, 5)), b: lease.grantLease(bodyY, grantsY), events: [] }
  eq(slash.adjudicate(dg4, { tLease: PARAMS_A2.tLease, keyOf: slashKeyOf }).guilty, 'none', 'a lease below tLease valid grants yields no verdict')

  // helper closes over lease
  function bodyOpts(root, device) {
    return { root, epoch: 1, device, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
