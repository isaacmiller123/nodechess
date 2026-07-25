// Headless test for the A2 witness fabric-core modules
// (src/shared/accounts/witness/distance|presence|eligibility|attest|cache.ts).
//
//   node scripts/test-accounts-witness.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-chain.mjs), imports them from a temp
// dir, and drives every rule in witness/types.ts' doc comments:
//   · key-distance determinism + a golden closest-set / canonical-witness-set
//     vector over a fixed 20-node fixture;
//   · NodeDirectory staleness + newest-wins + bad-signature drop;
//   · the §4 eligibility matrix (each floor rejects; the small-population
//     relaxation returns all eligible; entanglement + shared-partner math);
//   · the witness admission matrix (no/expired/mismatched lease → refuse;
//     fuse → refuse; head mismatch → refuse-with-head; equivocation → fork;
//     happy path → an attestation that verifies);
//   · checkpoint cosign (recompute gates a bad checkpoint; the /16 diversity
//     bound rejects same-prefix cosigners; the ckptM threshold).
//
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).
// Keys are RAW fixed 32-byte seeds → ed25519 keypairs (no derive.ts).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = resolve(ROOT, 'src/shared/accounts').replace(/\\/g, '/')

// ---- tiny check kit ---------------------------------------------------------
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

// ---- golden vectors (recorded from a green run; determinism anchors) --------
// The canonical witness set (wN=16 closest eligible nodeIds) of the fixed
// 20-node fixture below, subject seed 200. Any change to nodeId derivation,
// XOR distance, tie-break, or eligibility floors breaks this on every platform.
const GOLDEN_WITNESS_SET = [
  'n175Sq63Ql283f0v9H9G4bR_L3qzYo-DafgiHPAFOQ8', 'km-3ZQcGpslaTYq7NYUVkfyMM-r758SSj8KwKiTsm3E',
  'yUXL8qVgIAIUHi-50XBU1soGmVHfc_SdH4rKh_mHj2A', '2YU474mF_kE-s1AEeeWtCZSgiNiWKUg2m2CH9gxLahk',
  '1uB9XaEsQ-8PuPuhk9n9Q7aa4MjGvlwqKJbIEcOsbpI', '13Pm12p0Cs5sDLoDkOPm-cqY46kMfQ6v37w22Kh2mlY',
  '-3qlK1bTg2mkhLPsvcxV-bsCDKzOIbT2NIRoAMxNDTk', 'AfP7BwWNfRu91gYCYJz4oVn6yggHHgmSxOMzYiJpxoQ',
  'G-YGiZeebov934idC5dQxJlVqtAJ4GLQB5-C4zQtDPw', 'GACrV3B7Z7faWDWg0mjZV3v9gJ0PMWMi9_pC5y4q1nc',
  'KCHr74ITkgAcfrpWkAWoZVsPJ1y-hcIa34VUpWA8uH0', 'JPbtasv-EAnAMNfKVnwzykgwkRSYI2tVYabIKr7F3ig',
  'JGF0-BRuvhKwDhNb_z-vbe_MJHiVFxsqHjN7grhMTDw', 'XtuQI3VGebH5ibsPJ1TdZB81NVUSVAGGJos8uGJ7AKY',
  'XcAwFr4FF9QUxCiZb8-8srQFwjo96tbQkoP1juuxDfA', 'bIUCa2ouCLbOvitXiDF9WyZ1DaqiQyQv69XJRQL_x-8',
]

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-witness-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  console.log('· bundling src/shared/accounts + witness fabric-core …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as events from '${SRC}/events.ts'`,
      `export * as chain from '${SRC}/chain.ts'`,
      `export * as ckpt from '${SRC}/checkpoint.ts'`,
      `export * as certs from '${SRC}/certs.ts'`,
      `export * as wparams from '${SRC}/witness/params.ts'`,
      `export * as distance from '${SRC}/witness/distance.ts'`,
      `export * as presence from '${SRC}/witness/presence.ts'`,
      `export * as elig from '${SRC}/witness/eligibility.ts'`,
      `export * as attest from '${SRC}/witness/attest.ts'`,
      `export * as cache from '${SRC}/witness/cache.ts'`,
      `export * as lease from '${SRC}/witness/lease.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, 'witness.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  const M = await import(pathToFileURL(outfile).href)
  const { codec, hash, events, chain, ckpt, wparams, distance, presence, elig, attest, cache, lease: leaseMod } = M
  const { PARAMS_A2, PARAMS_A2_DIGEST } = wparams

  // ---- fixed raw keypairs ----------------------------------------------------
  const seed = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seed(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const NOW = 1_700_000_000_000

  // 20-node fixture: node i has root seed 20+i, device seed 120+i.
  const nodes = Array.from({ length: 20 }, (_, i) => {
    const root = kp(20 + i)
    const device = kp(120 + i)
    const nodeId = distance.nodeIdOf(root.pub)
    const body = {
      v: 1,
      root: root.pubB,
      key: device.pubB,
      caps: { witness: true, committee: false, shardMb: 50 },
      params: PARAMS_A2_DIGEST,
      ts: NOW,
      uptimePct: 99,
    }
    const sp = presence.signPresence(body, device.priv)
    return { i, root, device, nodeId, sp }
  })
  const subjectKp = kp(200)
  const subjectNodeId = distance.nodeIdOf(subjectKp.pub)
  const subject = {
    root: subjectKp.pubB,
    nodeId: subjectNodeId,
    entangledRoots: new Set(),
    secondDegreeRoots: new Set(),
  }
  const summaries = new Map(
    nodes.map((n) => [
      n.nodeId,
      { root: n.root.pubB, nodeId: n.nodeId, trustMicro: 1_000_000, secondDegreeRoots: new Set() },
    ]),
  )

  // ==========================================================================
  console.log('\n· 1. key-distance determinism + golden closest set …')
  // ==========================================================================
  eq(distance.nodeIdOf(nodes[0].root.pub), distance.nodeIdOf(nodes[0].root.pubB),
    'nodeIdOf accepts raw bytes or b64u root, identical result')
  eq(distance.nodeIdOf(nodes[0].root.pub).length, 43, 'nodeId is a 32-byte b64u (43 chars)')
  // XOR distance is symmetric and self-zero.
  eq(distance.xorDistance(subjectNodeId, subjectNodeId), 0n, 'xorDistance(a,a) = 0')
  eq(
    distance.xorDistance(nodes[0].nodeId, nodes[1].nodeId),
    distance.xorDistance(nodes[1].nodeId, nodes[0].nodeId),
    'xorDistance is symmetric',
  )
  const rows = nodes.map((n) => ({ nodeId: n.nodeId }))
  const closest = distance.closestEligible(subjectNodeId, rows, () => true, PARAMS_A2.wN)
  eq(closest.length, PARAMS_A2.wN, `closestEligible returns wN=${PARAMS_A2.wN} nodeIds`)
  // determinism: recompute → identical order
  const closest2 = distance.closestEligible(subjectNodeId, [...rows].reverse(), () => true, PARAMS_A2.wN)
  eq(JSON.stringify(closest), JSON.stringify(closest2), 'closestEligible is order-independent + deterministic')
  // sorted strictly ascending by XOR distance
  let sortedOk = true
  for (let j = 1; j < closest.length; j++)
    if (distance.xorDistance(subjectNodeId, closest[j - 1]) > distance.xorDistance(subjectNodeId, closest[j]))
      sortedOk = false
  ok(sortedOk, 'closest set is ascending by XOR distance to the subject')
  // the closest 16 are genuinely the nearest (no excluded node is nearer than the farthest chosen)
  const chosenSet = new Set(closest)
  const farthest = distance.xorDistance(subjectNodeId, closest[closest.length - 1])
  let minimalOk = true
  for (const n of nodes)
    if (!chosenSet.has(n.nodeId) && distance.xorDistance(subjectNodeId, n.nodeId) < farthest) minimalOk = false
  ok(minimalOk, 'no excluded node is nearer than the farthest chosen witness')
  // duplicate nodeIds collapse
  const dupRows = [...rows, { nodeId: nodes[0].nodeId }]
  eq(distance.closestEligible(subjectNodeId, dupRows, () => true, 20).length, 20, 'duplicate nodeIds collapse')

  // ==========================================================================
  console.log('\n· 2. NodeDirectory: staleness, newest-wins, bad-sig drop …')
  // ==========================================================================
  eq(presence.verifyPresence(nodes[0].sp), true, 'verifyPresence accepts a well-signed record')
  const badSig = { body: nodes[0].sp.body, sig: nodes[1].sp.sig }
  eq(presence.verifyPresence(badSig), false, 'verifyPresence rejects a wrong signature')
  const malformed = { body: { ...nodes[0].sp.body, uptimePct: 150 }, sig: nodes[0].sp.sig }
  eq(presence.verifyPresence(malformed), false, 'verifyPresence rejects a malformed body (uptime > 100)')

  const dir = presence.makeDirectory(60_000)
  let ingested = 0
  for (const n of nodes) if (dir.ingest(n.sp, NOW)) ingested++
  eq(ingested, 20, 'ingest admits all 20 well-signed live records')
  eq(dir.ingest(badSig, NOW), false, 'ingest drops a bad-signature record')
  // stale-at-ingest
  const staleBody = { ...nodes[0].sp.body, root: kp(60).pubB, key: kp(160).pubB, ts: NOW - 60_001 }
  const staleSp = presence.signPresence(staleBody, kp(160).priv)
  eq(dir.ingest(staleSp, NOW), false, 'ingest drops a record already stale at nowMs')
  // newest-wins
  const older = presence.signPresence({ ...nodes[0].sp.body, ts: NOW - 1_000 }, nodes[0].device.priv)
  eq(dir.ingest(older, NOW), false, 'ingest rejects an older record for a known node (newest wins)')
  const newer = presence.signPresence({ ...nodes[0].sp.body, ts: NOW + 1_000 }, nodes[0].device.priv)
  eq(dir.ingest(newer, NOW), true, 'ingest accepts a newer record for a known node')
  eq(dir.directory.nodes.get(nodes[0].nodeId).body.ts, NOW + 1_000, 'the newest record is retained')
  // liveNodes staleness at read time
  eq(dir.liveNodes(NOW).length, 20, 'liveNodes returns all live records')
  eq(dir.liveNodes(NOW + 60_000).length >= 19, true, 'records exactly at the staleness edge stay live')
  eq(dir.liveNodes(NOW + 120_000).length, 0, 'liveNodes drops everything well past staleAfterMs')

  // ==========================================================================
  console.log('\n· 3. eligibility matrix (§4 floors) …')
  // ==========================================================================
  const cand = (over = {}, chainOver = {}) => ({
    presence: presence.signPresence({ ...nodes[5].sp.body, ...over }, nodes[5].device.priv),
    chainSummary: { root: nodes[5].root.pubB, nodeId: nodes[5].nodeId, trustMicro: 1_000_000, secondDegreeRoots: new Set(), ...chainOver },
  })
  const reasons = (c, subj = subject, o = {}) => elig.isEligible(c, subj, PARAMS_A2, NOW, o).reasons
  ok(elig.isEligible(cand(), subject, PARAMS_A2, NOW).ok, 'a fully-qualified candidate is eligible')
  ok(reasons(cand({}, { trustMicro: 0 })).includes('trust-below-floor'), 'trust below floor rejects')
  ok(reasons(cand({ uptimePct: 50 })).includes('uptime-below-floor'), 'uptime below floor rejects')
  ok(reasons(cand({ caps: { witness: false, committee: true, shardMb: 0 } })).includes('no-witness-cap'), 'a non-witness node is ineligible')
  ok(reasons(cand({ ts: NOW + PARAMS_A2.timeWindowMs + 1 })).includes('presence-future'), 'presence from beyond the clock window rejects')
  // self
  const selfCand = cand({}, { root: subject.root })
  ok(reasons(selfCand).includes('self'), 'a node cannot witness itself')
  // entanglement
  const entSubject = { ...subject, entangledRoots: new Set([nodes[5].root.pubB]) }
  ok(reasons(cand(), entSubject).includes('entangled'), 'an entanglement-adjacent node is ineligible')
  // shared-partner overlap math (denom 10): 1/10 = 10% ok, 2/10 = 20% rejects (>= max)
  const spSubject = { ...subject, secondDegreeRoots: new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) }
  ok(!reasons(cand({}, { secondDegreeRoots: new Set(['a']) }), spSubject).includes('shared-partner-overlap'), 'shared-partner 10% (< 20%) is allowed')
  ok(reasons(cand({}, { secondDegreeRoots: new Set(['a', 'b']) }), spSubject).includes('shared-partner-overlap'), 'shared-partner 20% (= floor) rejects')
  // relaxation drops soft floors only
  ok(elig.isEligible(cand({ uptimePct: 10 }, { trustMicro: 0 }), subject, PARAMS_A2, NOW, { relax: true }).ok, 'relax mode drops the trust + uptime floors')
  ok(!elig.isEligible(cand(), entSubject, PARAMS_A2, NOW, { relax: true }).ok, 'relax mode still enforces entanglement distance')

  // ==========================================================================
  console.log('\n· 4. canonical witness set + small-population relaxation …')
  // ==========================================================================
  const wset = elig.canonicalWitnessSet(subject, dir.directory, summaries, PARAMS_A2, NOW)
  eq(wset.length, PARAMS_A2.wN, `canonicalWitnessSet returns wN=${PARAMS_A2.wN} at full population`)
  // with everyone fully eligible, the set is exactly the key-distance closest set
  const closestFromDir = distance.closestEligible(subjectNodeId, nodes.map((n) => ({ nodeId: n.nodeId })), () => true, PARAMS_A2.wN)
  eq(JSON.stringify(wset), JSON.stringify(closestFromDir), 'the witness set equals the closest-eligible key-distance set')
  // GOLDEN
  if (GOLDEN_WITNESS_SET[0] !== 'placeholder')
    eq(JSON.stringify(wset), JSON.stringify(GOLDEN_WITNESS_SET), 'canonical witness set matches the recorded golden vector')
  else console.log('  · (golden not yet recorded) witness set =', JSON.stringify(wset))

  // small population: 3 untrusted live nodes → none fully eligible → relaxation returns all 3
  const tinyDir = presence.makeDirectory(60_000)
  const tinyNodes = [kp(2), kp(3), kp(4)].map((root, i) => {
    const device = kp(50 + i)
    const body = { v: 1, root: root.pubB, key: device.pubB, caps: { witness: true, committee: false, shardMb: 5 }, params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 10 }
    return { root, device, nodeId: distance.nodeIdOf(root.pub), sp: presence.signPresence(body, device.priv) }
  })
  for (const n of tinyNodes) tinyDir.ingest(n.sp, NOW)
  // no summaries → default (trust 0), uptime 10 → all fail full floors
  const tinySet = elig.canonicalWitnessSet(subject, tinyDir.directory, new Map(), PARAMS_A2, NOW)
  eq(tinySet.length, 3, 'small-population relaxation returns all eligible (< wN)')
  // an entangled node is still excluded under relaxation
  const entTinySubject = { ...subject, entangledRoots: new Set([tinyNodes[0].root.pubB]) }
  eq(elig.canonicalWitnessSet(entTinySubject, tinyDir.directory, new Map(), PARAMS_A2, NOW).length, 2, 'relaxation still excludes an entangled node')

  // ==========================================================================
  console.log('\n· 5. witness admission matrix …')
  // ==========================================================================
  const wKp = kp(80) // the witness doing the admitting
  const acctRoot = kp(1)
  const dev = kp(50) // the lease-holding device
  const rootB = acctRoot.pubB
  let c = chain.createAccountChain({ rootPriv: acctRoot.priv, rootPub: acctRoot.pub, displayName: 'Isaac', ts: NOW, device: { pub: dev.pubB, index: 0, label: 'Mac' } })
  const genesisId = events.witnessedHeadOf(c.events).id
  // a height-1 witnessed event signed by the lease device
  const mkWitnessed = (payloadPub, ts = NOW, key = dev.pubB, priv = dev.priv, prev = genesisId, height = 1) => {
    const body = { v: 1, lane: 'w', type: 'revoke', root: rootB, key, height, prev, ts, payload: { pub: payloadPub } }
    return events.signBody(body, priv)
  }
  const ev1 = mkWitnessed(kp(70).pubB)
  const ev1Id = events.eventId(ev1.body)
  // admitEvent now enforces the context-free floor (≥1 valid grant signature), so
  // the unit lease carries one real grant over its body.
  const leaseBody = { v: 1, root: rootB, epoch: 1, device: dev.pubB, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST }
  const grantor = kp(90)
  const grantorNode = distance.nodeIdOf(grantor.pub)
  const lease = { body: leaseBody, grants: [leaseMod.signGrant(leaseBody, grantorNode, grantor.pubB, grantor.priv, NOW)] }
  const head0 = { id: genesisId, height: 0, epoch: 1 }
  const P = { timeWindowMs: PARAMS_A2.timeWindowMs }
  const admit = (over) => attest.admitEvent({ event: ev1, lease, fuse: null, cachedHead: head0, witnessKey: wKp.pubB, witnessPriv: wKp.priv, wts: NOW, params: P, ...over })
  // a lease with NO valid grant signature is refused (fabricated-lease floor).
  eq(admit({ lease: { body: leaseBody, grants: [] } }).reason, 'lease-no-valid-grant', 'a lease with no valid grant signature is refused (context-free floor)')

  const happy = admit({})
  ok(happy.ok, 'happy path: a valid event under a live lease at the head is admitted')
  ok(happy.ok && attest.verifyAttestation(happy.attestation, ev1Id), 'the produced attestation verifies against the event id')
  ok(happy.ok && !attest.verifyAttestation(happy.attestation, genesisId), 'the attestation does not verify against a different event id')
  eq(happy.ok && happy.attestation.epoch, 1, 'attestation carries the lease epoch')
  eq(happy.ok && happy.attestation.w, wKp.pubB, 'attestation carries the witness key')
  eq(happy.ok && happy.attestation.wts, NOW, "attestation carries the WITNESS's clock")
  // makeAttestation determinism
  const remade = attest.makeAttestation(ev1Id, 1, wKp.pubB, wKp.priv, NOW)
  eq(happy.ok && happy.attestation.sig, remade.sig, 'makeAttestation is deterministic (identical signature)')

  eq(admit({ lease: null }).reason, 'no-lease', 'no lease → refuse')
  eq(admit({ lease: { ...lease, body: { ...lease.body, device: kp(99).pubB } } }).reason, 'lease-device-mismatch', 'lease for another device → refuse')
  eq(admit({ lease: { ...lease, body: { ...lease.body, root: kp(98).pubB } } }).reason, 'lease-root-mismatch', 'lease for another root → refuse')
  eq(admit({ wts: NOW + PARAMS_A2.leaseTtlMs }).reason, 'lease-expired', 'expired lease → refuse')
  eq(admit({ cachedHead: { ...head0, epoch: 3 } }).reason, 'stale-epoch', 'lease epoch below the cached epoch → refuse')
  const fuse = { body: { v: 1, root: rootB, fails: 100, trippedWts: NOW - 1000, expiryWts: NOW + 1_000_000, pinRecord: ev1Id, params: PARAMS_A2_DIGEST }, sigs: [] }
  eq(admit({ fuse }).reason, 'fuse-tripped', 'an unexpired fuse → refuse')
  ok(admit({ fuse: { ...fuse, body: { ...fuse.body, expiryWts: NOW - 1 } } }).ok, 'an EXPIRED fuse does not block admission')
  // head mismatch (wrong prev at the next height)
  const evWrongPrev = mkWitnessed(kp(71).pubB, NOW, dev.pubB, dev.priv, kp(72).pubB, 1)
  const rWrong = attest.admitEvent({ event: evWrongPrev, lease, fuse: null, cachedHead: head0, witnessKey: wKp.pubB, witnessPriv: wKp.priv, wts: NOW, params: P })
  eq(rWrong.reason, 'head-mismatch', 'an event whose prev is not the cached head → refuse')
  ok(rWrong.ok === false && rWrong.myHead && rWrong.myHead.id === genesisId, 'a head-mismatch refusal carries the witness head (refuse-with-head)')
  // gap
  const evGap = mkWitnessed(kp(73).pubB, NOW, dev.pubB, dev.priv, genesisId, 5)
  eq(attest.admitEvent({ event: evGap, lease, fuse: null, cachedHead: head0, witnessKey: wKp.pubB, witnessPriv: wKp.priv, wts: NOW, params: P }).reason, 'head-mismatch', 'a height gap → refuse-with-head')
  // fork: two distinct events at the SAME height as the cached head
  const headAt1 = { id: ev1Id, height: 1, epoch: 1 }
  const ev1b = mkWitnessed(kp(74).pubB) // different payload → different id, same height 1, same prev
  const rFork = attest.admitEvent({ event: ev1b, lease, fuse: null, cachedHead: headAt1, witnessKey: wKp.pubB, witnessPriv: wKp.priv, wts: NOW, params: P })
  eq(rFork.reason, 'fork', 'a second distinct event at the head height → fork detected')
  // idempotent re-attest of the exact head
  ok(attest.admitEvent({ event: ev1, lease, fuse: null, cachedHead: headAt1, witnessKey: wKp.pubB, witnessPriv: wKp.priv, wts: NOW, params: P }).ok, 're-presenting the exact head is idempotently admitted')
  // clock window
  eq(admit({ wts: NOW + PARAMS_A2.timeWindowMs + 1 }).reason, 'clock-out-of-window', "witness clock outside ±window of the event's ts → refuse")
  // bad event signature
  const evBad = { body: ev1.body, sig: nodes[0].sp.sig }
  eq(admit({ event: evBad }).reason, 'bad-event-sig', 'an event with a bad self-signature → refuse')
  // personal-lane event is not witnessable
  const pEv = events.signBody({ v: 1, lane: 'p', type: 'profile', root: rootB, key: dev.pubB, height: 0, ts: NOW, payload: { fields: { bio: 'x' } } }, dev.priv)
  eq(admit({ event: pEv }).reason, 'not-witnessed-lane', 'a personal-lane event is refused')

  // ==========================================================================
  console.log('\n· 6. checkpoint cosign (recompute + diversity + threshold) …')
  // ==========================================================================
  // build a chain with a handful of witnessed events, then a checkpoint
  let cc = c
  for (let k = 0; k < 4; k++) cc = chain.appendWitnessed(cc, acctRoot.priv, rootB, 'revoke', { pub: kp(30 + k).pubB }, NOW + k)
  const ckptEv = ckpt.makeCheckpointEvent(cc, acctRoot.priv, rootB, NOW + 100)
  cc = chain.appendEvent(cc, ckptEv)
  const ckptId = events.eventId(ckptEv.body)
  const co = attest.cosignCheckpoint(ckptEv, cc, wKp.pubB, wKp.priv, NOW + 100)
  ok(co && attest.verifyAttestation(co, ckptId), 'cosignCheckpoint signs a valid checkpoint after recomputing the fold')
  // a forged fold (correct-looking digest, wrong state) is refused
  const badCkpt = structuredClone(ckptEv)
  badCkpt.body.payload.state.n = badCkpt.body.payload.state.n + 1
  badCkpt.body.payload.stateDigest = hash.toB64u(codec.canonicalHash(badCkpt.body.payload.state))
  eq(attest.cosignCheckpoint(badCkpt, cc, wKp.pubB, wKp.priv, NOW + 100), null, 'cosignCheckpoint refuses a checkpoint whose fold does not recompute')

  // verifyCheckpointCosigners: build 4 witness keypairs + a key→nodeId map
  const cosigners = Array.from({ length: 4 }, (_, i) => kp(90 + i))
  const rule = { m: PARAMS_A2.ckptM, n: PARAMS_A2.ckptN, prefixDiversityMin: 3 }
  const attFor = (w) => attest.makeAttestation(ckptId, 0, w.pubB, w.priv, NOW)
  // craft nodeIds: distinct /16 prefixes for the passing case
  const nid = (b0, b1, tail) => hash.toB64u(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? b0 : j === 1 ? b1 : (tail + j) & 0xff)))
  const diverseMap = new Map(cosigners.map((w, i) => [w.pubB, nid(i, i * 7 + 1, i)]))
  const diverseAtts = cosigners.map(attFor)
  ok(attest.verifyCheckpointCosigners(ckptEv, diverseAtts, diverseMap, rule), '4 distinct eligible cosigners across 4 /16 prefixes pass')
  // same-prefix: all four nodeIds share the top 2 bytes → 1 bucket < 3
  const samePrefixMap = new Map(cosigners.map((w, i) => [w.pubB, nid(0, 0, i)]))
  ok(!attest.verifyCheckpointCosigners(ckptEv, diverseAtts, samePrefixMap, rule), 'four cosigners sharing one /16 prefix fail the diversity bound')
  // below threshold: only 3 attestations
  ok(!attest.verifyCheckpointCosigners(ckptEv, diverseAtts.slice(0, 3), diverseMap, rule), `fewer than ckptM=${rule.m} cosigners fail the threshold`)
  // a signer not in the eligible set is ignored
  const stranger = kp(77)
  ok(!attest.verifyCheckpointCosigners(ckptEv, [...diverseAtts.slice(0, 3), attFor(stranger)], diverseMap, rule), 'an ineligible signer does not count toward the threshold')
  // a bad-signature attestation is ignored
  const forgedAtt = { ...diverseAtts[3], sig: diverseAtts[0].sig }
  ok(!attest.verifyCheckpointCosigners(ckptEv, [...diverseAtts.slice(0, 3), forgedAtt], diverseMap, rule), 'an attestation with a bad signature does not count')
  // two keys mapping to the same node dedup to one cosigner
  const dupNodeMap = new Map([[cosigners[0].pubB, nid(1, 1, 1)], [cosigners[1].pubB, nid(1, 1, 1)], [cosigners[2].pubB, nid(2, 2, 2)], [cosigners[3].pubB, nid(3, 3, 3)]])
  const dupAtts = [attFor(cosigners[0]), attFor(cosigners[1]), attFor(cosigners[2])]
  ok(!attest.verifyCheckpointCosigners(ckptEv, dupAtts, dupNodeMap, rule), 'two keys on one node count as a single cosigner (dedup by nodeId)')

  // ==========================================================================
  console.log('\n· 7. witness cache helpers …')
  // ==========================================================================
  const store = new cache.MemoryWitnessStore()
  const e0 = cache.updateHeadFromEvent(null, rootB, ev1, 1)
  eq(e0.witnessedHeight, 1, 'updateHeadFromEvent records the height')
  eq(e0.witnessedHead, ev1Id, 'updateHeadFromEvent records the head id')
  eq(e0.lastEpoch, 1, 'updateHeadFromEvent records the epoch')
  await store.put(e0)
  const got = await store.get(rootB)
  eq(got.witnessedHead, ev1Id, 'MemoryWitnessStore persists + returns the entry')
  // never regress height
  const older2 = cache.updateHeadFromEvent(e0, rootB, ev1, 1) // same height → head unchanged
  eq(older2.witnessedHeight, 1, 'updateHeadFromEvent never regresses the head height')
  const forked = cache.recordFork(e0, rootB)
  eq(forked.forkProofSeen, true, 'recordFork latches forkProofSeen')
  eq((await store.get('nope')), null, 'MemoryWitnessStore.get returns null for an unknown root')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
