// THE A3 AUTHENTICATED-POINTERS SUITE: brick 4 (spec §5 "authenticated
// pointer records / closes index poisoning"; docs/ACCOUNTS-SPEC.md).
//
//   node scripts/test-accounts-pointers.mjs
//
// Proves the pointer brick end to end, fabric-suite style:
//   0. determinism goldens: pointerKey derivation (domain-separated, one key
//      per subject), builder byte-determinism;
//   1. accept matrix: 'segment' (root- and device-signed holders), 'chain',
//      'shard' (duty-ranked under a caller-supplied directory), effTs capping;
//   2. forgery matrix (exact verdicts): unsigned/self-minted/no-proof records,
//      entanglement proofs replayed for a different segment/subject/holder,
//      unattested + tampered + uncertified proofs, off-duty shard claims,
//      wrong-params/mismatched headers, zod/malformed input;
//   3. store gate: full verification + key binding, all-or-nothing rows,
//      non-'pointers' kinds fall through to base;
//   4. cap-overflow flood: deterministic per-key cap. Honest segment/shard
//      pointers survive a sybil chain-pointer flood in EVERY arrival order,
//      attacker excess truncated, merged rows byte-deterministic;
//   5. end-to-end overlay round-trip: publish → enumerate → verified contact
//      sheet over a 20-node MockFabric overlay with composed shard+pointer
//      gates; forged pointers land nowhere and rank nowhere.
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on fail.
// Test identities are RAW fixed 32-byte seeds → ed25519 (never argon2).

import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundleAndImport, makeOutdir, ROOT } from './lib/witness-bundle.mjs'
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
function throws(fn, msg) {
  try { fn(); ok(false, `${msg} (did not throw)`) } catch { ok(true, msg) }
}

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as S from '@shared/accounts/storage'
export * as SEG from '@shared/accounts/segment'
`

// Golden pointer key for the fixed seed 'ptr-gold-subject': byte-determinism
// anchor across node + browser bundles (recorded from a green run; any change
// to the tag, hashing, or b64u breaks this everywhere at once).
const GOLDEN_POINTER_KEY = 'KMDHDnp6FhxhOqCD3eFx3IAMm5eBPn0LfbGHZlHTCOw'

// The pointer decision core bundled twice (platform node vs browser) and driven
// through one scripted mint/verify/fold/sheet sequence. The transcripts must
// match byte-for-byte (the "verifiers byte-deterministic in a browser bundle"
// hard rule), and the browser bundle must carry zero node built-ins.
const PARITY_ENTRY = `
import {
  appendWitnessed, canonicalBytes, certsProving, chainToBytes, createAccountChain, ed25519, eventId, sha256, toB64u, utf8,
} from '@shared/accounts'
import { makeAttestation, nodeIdOf, signPresence } from '@shared/accounts/witness'
import { makeSegmentPayload, signWitnessEnd, transcriptDigest } from '@shared/accounts/segment'
import {
  PARAMS_A3_DIGEST, buildContactSheet, cutSnapshot, dutyCarriers, makeChainPointer, makePointerMerge,
  makeSegmentPointer, makeShardPointer, pointerKey, verifyPointer,
} from '@shared/accounts/storage'

export function runPointerParityScript(): string {
  const seed = (t: string) => sha256(utf8(t))
  const kp = (t: string) => {
    const priv = seed(t)
    const pub = ed25519.getPublicKey(priv)
    return { priv, pub, pubB: toB64u(pub) }
  }
  const idLike = (t: string) => toB64u(seed(t))
  const T0 = 1_750_000_000_000
  const WTS = T0 + 5_000
  const NOW = T0 + 10_000
  const GEO = { k: 2, n: 4 }
  const log: string[] = []

  const wit = kp('ptr-witness')
  const rootX = kp('ptr-subject-root')
  const devX = kp('ptr-subject-dev')
  const o1 = kp('ptr-opp-1')
  const attacker = kp('ptr-attacker')
  const game = idLike('ptr-parity-game')
  const transcript = transcriptDigest(game, [], '1-0', 'resign')
  const payload = makeSegmentPayload({
    game, opp: o1.pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
    heads: { w: { head: idLike('phw'), height: 0 }, b: { head: idLike('phb'), height: 0 } },
    wstream: signWitnessEnd(wit.priv, wit.pubB, game, '1-0', 0, transcript),
    oppProfile: { name: 'Opp One' },
  })
  let chain = createAccountChain({
    rootPriv: rootX.priv, rootPub: rootX.pub, displayName: 'SubjectX', ts: T0,
    device: { pub: devX.pubB, index: 0 },
  })
  chain = appendWitnessed(chain, devX.priv, devX.pubB, 'segment', payload, T0 + 1000)
  const raw = chain.events[chain.events.length - 1]
  const segw = { ...raw, wit: [makeAttestation(eventId(raw.body), 0, wit.pubB, wit.priv, WTS)] }
  chain = { root: chain.root, events: [...chain.events.slice(0, -1), segw] }
  const certs = certsProving(rootX.pubB, chain.events, [devX.pubB])
  const subjectNodeId = nodeIdOf(rootX.pubB)

  log.push('key:' + pointerKey(nodeIdOf(kp('ptr-gold-subject').pubB)))

  const ptr = makeSegmentPointer({
    subject: rootX.pubB, holder: o1.pubB, key: o1.pubB, priv: o1.priv, ts: WTS + 500,
    event: segw, certs,
  })
  log.push('seg:' + ptr.sig)
  log.push('v-ok:' + verifyPointer(ptr))
  log.push('v-sig:' + verifyPointer({ body: ptr.body, sig: 'B' + ptr.sig.slice(1) }))
  const stolen = { ...ptr.body, holder: attacker.pubB, key: attacker.pubB }
  log.push('v-stolen:' + verifyPointer({ body: stolen, sig: toB64u(ed25519.sign(canonicalBytes(stolen as any), attacker.priv)) }))

  const dirNodes = Array.from({ length: 4 }, (_, i) => {
    const root = kp('ptr-parity-dir-' + i)
    const dev = kp('ptr-parity-dev-' + i)
    return {
      root,
      nodeId: nodeIdOf(root.pubB),
      sp: signPresence(
        { v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
        dev.priv,
      ),
    }
  })
  const dir = { nodes: new Map(dirNodes.map((n) => [n.nodeId, n.sp])), staleAfterMs: 3_600_000 }
  const header = cutSnapshot(chain, segw, certs, devX.priv, GEO)
  const carriers = dutyCarriers(subjectNodeId, 0, dir, { nowMs: NOW })
  log.push('duty:' + carriers.join(','))
  const carrier = dirNodes.find((n) => n.nodeId === carriers[0])!
  const shardPtr = makeShardPointer({
    subject: rootX.pubB, holder: carrier.root.pubB, key: carrier.root.pubB, priv: carrier.root.priv,
    ts: WTS + 800, header, idx: 0, verify: GEO, directory: dir, nowMs: NOW,
  })
  log.push('shard:' + shardPtr.sig)

  const blobHash = toB64u(sha256(chainToBytes(chain)))
  const sybils = Array.from({ length: 5 }, (_, i) => {
    const s = kp('ptr-parity-sybil-' + i)
    return makeChainPointer({
      subject: rootX.pubB, holder: s.pubB, key: s.pubB, priv: s.priv, ts: WTS + 100_000 + i,
      event: segw, certs, blobHash,
    })
  })
  const merge = makePointerMerge({ capPerKey: 4, shard: GEO })
  const target = pointerKey(subjectNodeId)
  let acc: any = null
  for (const row of [sybils.slice(0, 3), [ptr, shardPtr], sybils.slice(3)])
    acc = merge(acc, { v: 1, ptrs: row } as any, 'pointers', target)
  log.push('fold:' + acc.ptrs.map((p: any) => p.body.kind + '/' + p.sig.slice(0, 12)).join(','))

  const sheet = buildContactSheet(rootX.pubB, acc, { directory: dir, nowMs: NOW, shard: GEO })
  log.push('sheet-seg:' + sheet.segments.map((s) => s.holder).join(','))
  log.push('sheet-shard0:' + (sheet.shards.get(0) ?? []).map((s) => s.nodeId).join(','))
  return log.join('|')
}
`

async function main() {
  const outdir = makeOutdir('accounts-pointers-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W, O, S, SEG } = M
  const b64 = A.toB64u
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const idLike = (tag) => b64(seed32(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: b64(pub) }
  }
  const canon = (v) => b64(A.canonicalHash(v))
  const mint = (body, priv) => ({ body, sig: b64(A.ed25519.sign(A.canonicalBytes(body), priv)) })
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)

  const T0 = 1_750_000_000_000
  const WTS = T0 + 5_000
  const NOW = T0 + 10_000
  const GEO = { k: 2, n: 4 } // small suite geometry (params digest stays default)

  // ==========================================================================
  console.log('\n· fixture: subject X with witnessed segment chain …')
  // ==========================================================================
  const wit = kpOf('ptr-witness')
  const attOf = (ev) => W.makeAttestation(A.eventId(ev.body), 0, wit.pubB, wit.priv, WTS)
  const withWit = (ev) => ({ ...ev, wit: [attOf(ev)] })

  const rootX = kpOf('ptr-subject-root')
  const devX = kpOf('ptr-subject-dev')
  const o1 = kpOf('ptr-opp-1')
  const o2 = kpOf('ptr-opp-2')
  const o2dev = kpOf('ptr-opp-2-dev')
  const friend = kpOf('ptr-friend')
  const attacker = kpOf('ptr-attacker')

  const segPayload = (tag, opp, oppName) => {
    const game = idLike('ptr-game-' + tag)
    const transcript = SEG.transcriptDigest(game, [], '1-0', 'resign')
    return SEG.makeSegmentPayload({
      game, opp, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike('hw-' + tag), height: 0 }, b: { head: idLike('hb-' + tag), height: 0 } },
      wstream: SEG.signWitnessEnd(wit.priv, wit.pubB, game, '1-0', 0, transcript),
      oppProfile: { name: oppName },
    })
  }

  let chainX = A.createAccountChain({
    rootPriv: rootX.priv, rootPub: rootX.pub, displayName: 'SubjectX', ts: T0,
    device: { pub: devX.pubB, index: 0 },
  })
  const attachWit = (ch) => {
    const last = ch.events[ch.events.length - 1]
    return { root: ch.root, events: [...ch.events.slice(0, -1), withWit(last)] }
  }
  chainX = attachWit(A.appendWitnessed(chainX, devX.priv, devX.pubB, 'segment', segPayload('1', o1.pubB, 'Opp One'), T0 + 1000))
  const seg1w = chainX.events[chainX.events.length - 1]
  chainX = attachWit(A.appendWitnessed(chainX, devX.priv, devX.pubB, 'segment', segPayload('2', o2.pubB, 'Opp Two'), T0 + 2000))
  const seg2w = chainX.events[chainX.events.length - 1]
  const certsX = A.certsProving(rootX.pubB, chainX.events, [devX.pubB])
  const subjectNodeId = W.nodeIdOf(rootX.pubB)
  ok(certsX.length === 1, 'fixture: cert set proves the subject device key')
  ok((seg1w.wit ?? []).length === 1 && (seg2w.wit ?? []).length === 1, 'fixture: both segment events carry a witness attestation')

  // Opponent 2's own chain (for a device-signed HOLDER key path).
  const o2chain = A.createAccountChain({
    rootPriv: o2.priv, rootPub: A.ed25519.getPublicKey(o2.priv), displayName: 'OppTwo', ts: T0,
    device: { pub: o2dev.pubB, index: 0 },
  })
  const o2certs = A.certsProving(o2.pubB, o2chain.events, [o2dev.pubB])

  // Directory of 16 capacity-advertising nodes for duty ranking.
  const dirNodes = Array.from({ length: 16 }, (_, i) => {
    const root = kpOf('ptr-dir-root-' + i)
    const dev = kpOf('ptr-dir-dev-' + i)
    const sp = W.signPresence(
      { v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
      dev.priv,
    )
    return { root, dev, nodeId: W.nodeIdOf(root.pubB), sp }
  })
  const dir = { nodes: new Map(dirNodes.map((n) => [n.nodeId, n.sp])), staleAfterMs: 3_600_000 }
  const byNodeId = new Map(dirNodes.map((n) => [n.nodeId, n]))

  const header = S.cutSnapshot(chainX, seg2w, certsX, devX.priv, GEO)
  eq(S.verifySnapshotHeader(header, GEO), 'ok', 'fixture: cut snapshot header verifies standalone')
  const carriers0 = S.dutyCarriers(subjectNodeId, 0, dir, { nowMs: NOW })
  eq(carriers0.length, S.PARAMS_A3.dutyK, `fixture: dutyCarriers ranks dutyK=${S.PARAMS_A3.dutyK} carriers for row 0`)
  const carrier = byNodeId.get(carriers0[0])
  const offDuty = dirNodes.find((n) => !carriers0.includes(n.nodeId))

  // ==========================================================================
  console.log('\n· 0. determinism goldens …')
  // ==========================================================================
  {
    // Static guard: the pointer module is platform-neutral + byte-deterministic
    // (no ambient time / randomness / timers / node builtins): the browser
    // parity digest exercises one scripted path, so it cannot catch a regression
    // in an unexercised branch; this source-regex guard covers every branch.
    const src = readFileSync(resolve(ROOT, 'src/shared/accounts/storage/pointers.ts'), 'utf8')
    ok(!/\bDate\.now\s*\(|\bMath\.random\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|\bperformance\.now\s*\(/.test(src),
      'pointers.ts calls no ambient time, randomness, or timers (clocks are the caller’s)')
    ok(!/from 'node:|from "node:/.test(src), 'pointers.ts imports no node: builtins (platform-neutral)')

    const gs = kpOf('ptr-gold-subject')
    const pk = S.pointerKey(W.nodeIdOf(gs.pubB))
    eq(pk, GOLDEN_POINTER_KEY, 'pointerKey(fixed seed) matches the recorded golden')
    eq(S.pointerKeyOfRoot(gs.pubB), pk, 'pointerKeyOfRoot derives the identical key from the root form')
    ok(pk !== W.nodeIdOf(gs.pubB), 'pointer key is domain-separated from the subject nodeId (events key)')
    ok(pk !== S.shardKey(W.nodeIdOf(gs.pubB), 0), 'pointer key is domain-separated from every shard key')
    throws(() => S.pointerKey('short'), 'pointerKey throws on a non-32-byte subject (builders throw)')
  }

  // ==========================================================================
  console.log("\n· 1. accept matrix: 'segment' / 'chain' / 'shard' …")
  // ==========================================================================
  const ptrO1 = S.makeSegmentPointer({
    subject: rootX.pubB, holder: o1.pubB, key: o1.pubB, priv: o1.priv, ts: WTS + 500,
    event: seg1w, certs: certsX,
  })
  eq(S.verifyPointer(ptrO1), 'ok', "segment pointer by the NAMED opponent (root-signed) verifies 'ok'")
  eq(ptrO1.body.hash, A.eventId(seg1w.body), 'segment pointer hash = the subject segment event id')

  const ptrO2 = S.makeSegmentPointer({
    subject: rootX.pubB, holder: o2.pubB, key: o2dev.pubB, priv: o2dev.priv, ts: WTS + 700,
    event: seg2w, certs: certsX, holderCerts: o2certs,
  })
  eq(S.verifyPointer(ptrO2), 'ok', "segment pointer signed by a CERTIFIED holder device key verifies 'ok'")

  const blobHash = b64(A.sha256(A.chainToBytes(chainX)))
  const ptrChain = S.makeChainPointer({
    subject: rootX.pubB, holder: friend.pubB, key: friend.pubB, priv: friend.priv, ts: WTS + 900,
    event: seg2w, certs: certsX, blobHash,
  })
  eq(S.verifyPointer(ptrChain), 'ok', "chain pointer embedding the subject's countersigned head verifies 'ok'")

  const ptrShard = S.makeShardPointer({
    subject: rootX.pubB, holder: carrier.root.pubB, key: carrier.root.pubB, priv: carrier.root.priv,
    ts: WTS + 800, header, idx: 0, verify: GEO, directory: dir, nowMs: NOW,
  })
  eq(S.verifyPointer(ptrShard, { directory: dir, nowMs: NOW, shard: GEO }), 'ok', "shard pointer by the closest duty carrier verifies 'ok' under the directory snapshot")
  eq(ptrShard.body.hash, header.blobHash, 'shard pointer hash = the job blobHash')

  {
    const c = S.checkPointer(ptrO1)
    ok(c.info && c.info.proofWts === seg1w.body.ts, 'checkPointer surfaces AUTHORITY-BOUNDED recency: the attestation wts CLAMPED at the proof event’s owner-signed ts')
    ok(c.info && c.info.effTs === WTS + 500, 'a modest holder ts within skew is used as-is for ranking')
    const liar = S.makeSegmentPointer({
      subject: rootX.pubB, holder: o1.pubB, key: o1.pubB, priv: o1.priv, ts: WTS + 40 * 86_400_000,
      event: seg1w, certs: certsX,
    })
    const cl = S.checkPointer(liar)
    ok(cl.info && cl.info.effTs === seg1w.body.ts + S.POINTER_TS_SKEW_MS, 'a lying holder ts is CAPPED at proofWts + skew, where proofWts is the OWNER-signed proof ts (ts is ranking-only, never authority)')
  }

  // ==========================================================================
  console.log('\n· 2. forgery matrix (exact verdicts) …')
  // ==========================================================================
  eq(S.verifyPointer(42), 'bad-record', 'non-object → bad-record')
  eq(S.verifyPointer(null), 'bad-record', 'null → bad-record')
  eq(S.verifyPointer({ body: { v: 1 }, sig: 'x' }, {}), 'bad-record', 'missing fields → bad-record')
  eq(S.verifyPointer({ ...ptrO1, extra: 1 }), 'bad-record', 'extra top-level field → bad-record (strict shapes)')
  eq(S.verifyPointer({ body: { ...ptrO1.body, ts: 1.5 }, sig: ptrO1.sig }), 'bad-record', 'float ts → bad-record (zod int)')
  eq(S.verifyPointer({ body: { ...ptrO1.body, idx: -1 }, sig: ptrO1.sig }), 'bad-record', 'negative idx → bad-record')
  eq(S.verifyPointer(ptrO1, { maxBytes: 64 }), 'oversize', 'byte ceiling enforced → oversize')
  eq(S.verifyPointer({ body: ptrO1.body, sig: flip(ptrO1.sig) }), 'bad-sig', 'flipped signature → bad-sig')
  eq(S.verifyPointer({ body: ptrO1.body, sig: ptrChain.sig }), 'bad-sig', "someone else's signature → bad-sig")

  {
    const body = { ...ptrO1.body, key: o2dev.pubB, holderCerts: [] }
    eq(S.verifyPointer(mint(body, o2dev.priv)), 'uncertified-key', 'holder key without a cert proof → uncertified-key')
    const forgedCert = A.certsProving(attacker.pubB, A.createAccountChain({
      rootPriv: attacker.priv, rootPub: A.ed25519.getPublicKey(attacker.priv), displayName: 'Attacker', ts: T0,
      device: { pub: o2dev.pubB, index: 0 },
    }).events, [o2dev.pubB])
    const body2 = { ...ptrO1.body, key: o2dev.pubB, holderCerts: forgedCert }
    eq(S.verifyPointer(mint(body2, o2dev.priv)), 'uncertified-key', "a cert signed by a FOREIGN root proves nothing → uncertified-key")
  }

  {
    const noProof = { ...ptrO1.body, proof: {} }
    eq(S.verifyPointer(mint(noProof, o1.priv)), 'wrong-proof', 'self-minted pointer with NO embedded proof → wrong-proof')
    const mixed = { ...ptrO1.body, proof: { event: seg1w, certs: certsX, header } }
    eq(S.verifyPointer(mint(mixed, o1.priv)), 'wrong-proof', 'segment pointer smuggling a shard header → wrong-proof')
    const segIdx = { ...ptrO1.body, idx: 0 }
    eq(S.verifyPointer(mint(segIdx, o1.priv)), 'wrong-proof', 'segment pointer carrying a shard idx → wrong-proof')
    const shardNoIdx = { ...ptrShard.body }
    delete shardNoIdx.idx
    eq(S.verifyPointer(mint(shardNoIdx, carrier.root.priv), { directory: dir, nowMs: NOW, shard: GEO }), 'wrong-proof', 'shard pointer without idx → wrong-proof')
  }

  {
    const wrongSubject = { ...ptrO1.body, subject: o2.pubB }
    eq(S.verifyPointer(mint(wrongSubject, o1.priv)), 'subject-mismatch', "X's segment event replayed under a DIFFERENT subject → subject-mismatch")
    const stolen = { ...ptrO1.body, holder: attacker.pubB, key: attacker.pubB }
    eq(S.verifyPointer(mint(stolen, attacker.priv)), 'holder-mismatch', "a stranger replaying X's segment event (which names o1) → holder-mismatch")
    const wrongHash = { ...ptrO1.body, hash: A.eventId(seg2w.body) }
    eq(S.verifyPointer(mint(wrongHash, o1.priv)), 'hash-mismatch', 'entanglement proof replayed for a DIFFERENT segment hash → hash-mismatch')
  }

  {
    const bare = { ...seg1w }
    delete bare.wit
    const unattested = { ...ptrO1.body, proof: { event: bare, certs: certsX } }
    eq(S.verifyPointer(mint(unattested, o1.priv)), 'bad-proof', 'segment event WITHOUT witness attestation → bad-proof (countersigned means attested)')
    const rebound = { ...seg1w, wit: [attOf(seg2w)] }
    const wrongBind = { ...ptrO1.body, proof: { event: rebound, certs: certsX } }
    eq(S.verifyPointer(mint(wrongBind, o1.priv)), 'bad-proof', "an attestation bound to a DIFFERENT event id → bad-proof")
    const tampered = { ...ptrO1.body, proof: { event: { ...seg1w, sig: flip(seg1w.sig) }, certs: certsX } }
    eq(S.verifyPointer(mint(tampered, o1.priv)), 'bad-proof', 'tampered subject event signature → bad-proof')
    const noCerts = { ...ptrO1.body, proof: { event: seg1w } }
    eq(S.verifyPointer(mint(noCerts, o1.priv)), 'bad-proof', "device-signed subject event without the cert proof → bad-proof")
  }

  {
    const personal = { ...ptrChain.body, proof: { event: certsX[0], certs: certsX } }
    eq(S.verifyPointer(mint(personal, friend.priv)), 'bad-proof', 'a personal-lane event as a chain proof → bad-proof (witnessed lane only)')
    const foreign = { ...ptrChain.body, subject: o2.pubB }
    eq(S.verifyPointer(mint(foreign, friend.priv)), 'subject-mismatch', "chain proof rooted in a different subject → subject-mismatch")
  }

  {
    const vops = { directory: dir, nowMs: NOW, shard: GEO }
    const offBody = { ...ptrShard.body, holder: offDuty.root.pubB, key: offDuty.root.pubB }
    eq(S.verifyPointer(mint(offBody, offDuty.root.priv), vops), 'holder-mismatch', 'assignment proof where the carrier is NOT among duty carriers → holder-mismatch')
    eq(S.verifyPointer(ptrShard, { shard: GEO }), 'holder-mismatch', 'shard pointer without a directory snapshot fails CLOSED → holder-mismatch')
    const fakeParams = S.cutSnapshot(chainX, seg2w, certsX, devX.priv, { ...GEO, params: idLike('fake-params') })
    const wrongParams = { ...ptrShard.body, proof: { header: fakeParams } }
    eq(S.verifyPointer(mint(wrongParams, carrier.root.priv), vops), 'bad-proof', 'header under a FOREIGN params digest → bad-proof (rule-set pin)')
    const wrongGeo = S.cutSnapshot(chainX, seg2w, certsX, devX.priv, { k: 3, n: 5 })
    const geoBody = { ...ptrShard.body, proof: { header: wrongGeo } }
    eq(S.verifyPointer(mint(geoBody, carrier.root.priv), vops), 'bad-proof', 'header under a foreign k/n geometry → bad-proof')
    const badHash = { ...ptrShard.body, hash: idLike('not-the-blob') }
    eq(S.verifyPointer(mint(badHash, carrier.root.priv), vops), 'hash-mismatch', 'shard pointer hash ≠ header blobHash (mismatched envelope) → hash-mismatch')
    const badIdx = { ...ptrShard.body, idx: 7 }
    eq(S.verifyPointer(mint(badIdx, carrier.root.priv), vops), 'wrong-proof', 'idx outside the job geometry → wrong-proof')
    const tamperedHead = { ...header, head: { ...header.head, sig: flip(header.head.sig) } }
    const tamperedBody = { ...ptrShard.body, proof: { header: tamperedHead } }
    eq(S.verifyPointer(mint(tamperedBody, carrier.root.priv), vops), 'bad-proof', 'tampered head signature inside the header → bad-proof')
  }

  throws(() => S.makeSegmentPointer({
    subject: rootX.pubB, holder: attacker.pubB, key: attacker.pubB, priv: attacker.priv, ts: NOW,
    event: seg1w, certs: certsX,
  }), 'the builder itself throws on a record that would not verify (misuse is loud)')

  // ==========================================================================
  console.log('\n· 3. store gate: verification + key binding, all-or-nothing …')
  // ==========================================================================
  const target = S.pointerKeyOfRoot(rootX.pubB)
  const gate = S.makePointerStoreValidator({ directory: () => dir, nowMs: () => NOW, shard: GEO, capPerKey: 8 })
  const from = dirNodes[0].nodeId
  ok(gate.validator(from, target, 'pointers', { v: 1, ptrs: [ptrO1, ptrShard] }), 'a fully-valid row is accepted under the subject pointer key')
  ok(!gate.validator(from, subjectNodeId, 'pointers', { v: 1, ptrs: [ptrO1] }), 'the SAME row under the wrong key (subject nodeId) is refused, key binding')
  ok(!gate.validator(from, target, 'pointers', { v: 1, ptrs: [ptrO1, { body: ptrO1.body, sig: flip(ptrO1.sig) }] }), 'one bad record poisons the row → all-or-nothing refusal')
  ok(!gate.validator(from, target, 'pointers', { v: 1, ptrs: [] }), 'an empty row is refused')
  ok(!gate.validator(from, target, 'pointers', { v: 1, ptrs: Array(9).fill(ptrO1) }), 'a row larger than capPerKey is refused outright')
  ok(!gate.validator(from, target, 'pointers', { v: 2, ptrs: [ptrO1] }), 'a foreign row version is refused')
  ok(gate.validator(from, target, 'record', { v: 1 }), "kind 'record' falls through to the default base (accepted)")
  ok(!gate.validator(from, target, 'shard', { v: 1 }), "kind 'shard' falls through to the default base (refused, compose with the shard gate)")

  // ==========================================================================
  console.log('\n· 4. cap-overflow flood: honest pointers survive deterministically …')
  // ==========================================================================
  {
    const CAP = 8
    const merge = S.makePointerMerge({ capPerKey: CAP, shard: GEO })
    const honest = [ptrO1, ptrO2, ptrShard, ptrChain]
    // 10 sybil holders each minting a VALID chain pointer from the PUBLIC head.
    const sybils = Array.from({ length: 10 }, (_, i) => {
      const kp = kpOf('ptr-sybil-' + i)
      return S.makeChainPointer({
        subject: rootX.pubB, holder: kp.pubB, key: kp.pubB, priv: kp.priv,
        ts: WTS + 100_000 + i, event: seg2w, certs: certsX, blobHash,
      })
    })
    const foldRows = (rows) => rows.reduce((acc, row) => merge(acc, { v: 1, ptrs: row }, 'pointers', target), null)
    const idsOf = (row) => new Set(row.ptrs.map((p) => canon(p)))

    const floodFirst = foldRows([sybils.slice(0, 5), sybils.slice(5), honest])
    const floodLast = foldRows([honest, sybils.slice(0, 5), sybils.slice(5)])
    eq(floodFirst.ptrs.length, CAP, `the merged row clamps exactly at capPerKey=${CAP} under a 14-record load`)
    for (const [name, row] of [['flood-first', floodFirst], ['flood-last', floodLast]]) {
      const ids = idsOf(row)
      ok([ptrO1, ptrO2, ptrShard].every((p) => ids.has(canon(p))), `${name}: EVERY honest segment+shard pointer survives the sybil chain flood (proof-ranked cap)`)
    }
    eq(canon(floodFirst), canon(floodLast), 'the capped row is IDENTICAL regardless of arrival order (deterministic union+cap)')
    const again = foldRows([sybils.slice(0, 5), sybils.slice(5), honest])
    eq(canon(again), canon(floodFirst), 'replaying the identical sequence reproduces byte-identical rows')

    const junk = { body: ptrO1.body, sig: flip(ptrO1.sig) }
    const withJunk = merge(floodFirst, { v: 1, ptrs: [junk] }, 'pointers', target)
    eq(canon(withJunk), canon(floodFirst), 'a hostile fold row of invalid records contributes NOTHING (read-side getMerged safety)')
    const foreign = merge(null, { v: 1, ptrs: [mint({ ...ptrO1.body, subject: o2.pubB }, o1.priv)] }, 'pointers', target)
    eq(foreign.ptrs.length, 0, 'a record bound to a FOREIGN subject key contributes nothing to this key')
    const events = merge(null, { v: 1, events: [] }, 'events', target)
    ok(events !== null, "non-'pointers' kinds delegate to storageMerge (composed storage fold)")

    // A carrier re-publishing (same header, fresh ts) must not crowd the row's
    // OTHER true carrier out of a tight cap: unique holders rank first.
    const carrier2 = byNodeId.get(carriers0[1])
    const ptrShardB = S.makeShardPointer({
      subject: rootX.pubB, holder: carrier.root.pubB, key: carrier.root.pubB, priv: carrier.root.priv,
      ts: WTS + 900, header, idx: 0, verify: GEO, directory: dir, nowMs: NOW,
    })
    const ptrShard2 = S.makeShardPointer({
      subject: rootX.pubB, holder: carrier2.root.pubB, key: carrier2.root.pubB, priv: carrier2.root.priv,
      ts: WTS + 850, header, idx: 0, verify: GEO, directory: dir, nowMs: NOW,
    })
    const tight = S.makePointerMerge({ capPerKey: 2, shard: GEO })
    const dupAcc = tight(null, { v: 1, ptrs: [ptrShard, ptrShardB] }, 'pointers', target)
    const dupRow = tight(dupAcc, { v: 1, ptrs: [ptrShard2] }, 'pointers', target)
    const dupHolders = new Set(dupRow.ptrs.map((p) => p.body.holder))
    ok(dupHolders.has(carrier.root.pubB) && dupHolders.has(carrier2.root.pubB), 'both DISTINCT carriers survive a tight cap; the duplicate re-publish is what gets truncated')

    // Defect F/H: the OTHER flood direction. A SINGLE real entanglement partner
    // minting cap-many ts-VARIANTS of its ONE segment pointer. Segments outrank
    // shard/chain (kindRank), so pre-fix the variants filled the whole cap and
    // evicted every honest shard+chain pointer. The (holder,hash) dedup collapses
    // them to one, so shard+chain survive.
    {
      const CAP2 = 8
      const mergeV = S.makePointerMerge({ capPerKey: CAP2, shard: GEO })
      const variants = Array.from({ length: CAP2 + 4 }, (_, i) => S.makeSegmentPointer({
        subject: rootX.pubB, holder: o1.pubB, key: o1.pubB, priv: o1.priv, ts: WTS + 500 + i,
        event: seg1w, certs: certsX,
      }))
      ok(variants.every((v) => S.verifyPointer(v) === 'ok'), 'each ts-variant of the ONE segment proof independently verifies (ts is a free field)')
      eq(new Set(variants.map((v) => canon(v))).size, variants.length, '…and each is a DISTINCT record (distinct recId)')
      const acc = [variants.slice(0, CAP2), [ptrShard, ptrChain], variants.slice(CAP2)]
        .reduce((a, r) => mergeV(a, { v: 1, ptrs: r }, 'pointers', target), null)
      const ids = new Set(acc.ptrs.map((p) => canon(p)))
      ok(ids.has(canon(ptrShard)), 'the honest SHARD pointer survives a single partner’s segment ts-variant flood (defect F)')
      ok(ids.has(canon(ptrChain)), 'the honest CHAIN pointer survives it too')
      eq(acc.ptrs.filter((p) => p.body.kind === 'segment' && p.body.holder === o1.pubB).length, 1,
        "the partner's cap-many ts-variants of ONE proof collapse to a SINGLE entry (dedup by holder+hash)")
    }

    const SKEW = S.POINTER_TS_SKEW_MS
    // A genuinely NEWER entanglement of the subject: owner-signed at a far-later
    // ts, freshly attested: real recency, not a re-countersigned old event.
    const freshTs = T0 + 5 * SKEW
    const builtFresh = A.appendWitnessed(chainX, devX.priv, devX.pubB, 'segment', segPayload('fresh', friend.pubB, 'Friend'), freshTs)
    const segFreshRaw = builtFresh.events[builtFresh.events.length - 1]
    const segFresh = { ...segFreshRaw, wit: [W.makeAttestation(A.eventId(segFreshRaw.body), 0, wit.pubB, wit.priv, freshTs + 10)] }

    // Defect G: cap eviction ranks by the AUTHORITY-BOUNDED effTs, never the raw
    // holder-claimed ts, so a huge lying ts on an OLD proof cannot win a scarce
    // retention slot over a holder whose PROOF is genuinely fresher (a newer
    // owner-signed head, not just a fresher countersignature on the same head).
    {
      const honest = S.makeChainPointer({
        subject: rootX.pubB, holder: friend.pubB, key: friend.pubB, priv: friend.priv,
        ts: freshTs + 100, event: segFresh, certs: certsX, blobHash,
      })
      const liarKp = kpOf('ptr-ts-liar')
      const liar = S.makeChainPointer({
        subject: rootX.pubB, holder: liarKp.pubB, key: liarKp.pubB, priv: liarKp.priv,
        ts: WTS + 100 * SKEW, event: seg2w, certs: certsX, blobHash, // huge lying ts on an OLDER proof
      })
      ok(liar.body.ts > honest.body.ts, 'sanity: the liar DOES claim a larger raw ts (raw ranking would pick it)')
      ok(S.checkPointer(honest).info.effTs > S.checkPointer(liar).info.effTs, "…yet the liar's effTs is CAPPED at its OLD proof's owner-signed ts + skew, below the genuinely-newer honest holder (authority-bounded recency)")
      const tightChain = S.makePointerMerge({ capPerKey: 1, shard: GEO })
      const row = tightChain(tightChain(null, { v: 1, ptrs: [liar] }, 'pointers', target), { v: 1, ptrs: [honest] }, 'pointers', target)
      eq(row.ptrs.length, 1, 'a tight cap keeps one chain pointer')
      eq(canon(row.ptrs[0]), canon(honest), 'the genuinely-fresher holder survives. The fold ranks by authority-bounded effTs, not the raw ts lie (defect G)')
    }

    // ROUND 2, proofWts is authority-bounded: a holder INJECTS a self-signed
    // attestation with a huge wts into proof.event.wit (covered by neither the
    // event id nor its signature), trying to lift the effTs ceiling. The clamp at
    // the OWNER-signed event ts denies the lift: an injected attestation from a
    // throwaway (non-witness) key confers NO extra ranking recency.
    {
      const attackerKp = kpOf('ptr-inject-atk')
      const throwaway = kpOf('ptr-inject-witness') // a throwaway key, NOT an eligible witness
      const bigWts = WTS + 1000 * SKEW
      const injectedEv = { ...seg2w, wit: [seg2w.wit[0], W.makeAttestation(A.eventId(seg2w.body), 0, throwaway.pubB, throwaway.priv, bigWts)] }
      const mk = (ev) => S.makeChainPointer({ subject: rootX.pubB, holder: attackerKp.pubB, key: attackerKp.pubB, priv: attackerKp.priv, ts: bigWts, event: ev, certs: certsX, blobHash })
      const injected = mk(injectedEv)
      const plain = mk(seg2w) // the SAME pointer, real attestation only
      ok(W.verifyAttestation(injectedEv.wit[1], A.eventId(seg2w.body)), 'sanity: the injected throwaway-key attestation DOES pass verifyAttestation (there is no eligibility gate there)')
      eq(S.verifyPointer(injected), 'ok', 'the injected-attestation pointer still verifies (a fabricated attestation is not itself a record forgery)')
      eq(S.checkPointer(injected).info.effTs, S.checkPointer(plain).info.effTs, 'the injected huge-wts attestation confers NO effTs lift: recency is clamped at the owner-signed proof ts, never the holder-attachable wit')
      eq(S.checkPointer(injected).info.effTs, seg2w.body.ts + SKEW, '…and that ceiling is the OWNER-signed proof ts + skew (authority-bounded)')
      ok(S.checkPointer(injected).info.effTs < bigWts, 'the attacker-chosen ts is DENIED: effTs is far below it (defeats the injected-attestation lift)')
    }

    // ROUND 2: chain-pointer dedup keys on the OWNER-signed proof event id, NOT
    // the holder-chosen blobHash (unverified at pointer-verify time). So ONE
    // holder cannot mint many chain pointers with distinct fake hashes and occupy
    // many slots: its variants of one head collapse to a single entry.
    {
      const CAP3 = 10
      const mergeC = S.makePointerMerge({ capPerKey: CAP3, shard: GEO })
      const sybil = kpOf('ptr-chain-hashsybil')
      const variants = Array.from({ length: 20 }, (_, i) => S.makeChainPointer({
        subject: rootX.pubB, holder: sybil.pubB, key: sybil.pubB, priv: sybil.priv,
        ts: WTS + 1000 + i, event: seg2w, certs: certsX, blobHash: idLike('fake-blob-' + i), // arbitrary holder-chosen hash
      }))
      ok(variants.every((v) => S.verifyPointer(v) === 'ok'), 'each distinct-hash chain pointer independently verifies (blobHash is unverified at pointer-verify time; bound only at fetch)')
      eq(new Set(variants.map((v) => canon(v))).size, variants.length, '…and each is a DISTINCT record (distinct fake hash → distinct recId)')
      const acc = variants.reduce((a, v) => mergeC(a, { v: 1, ptrs: [v] }, 'pointers', target), null)
      eq(acc.ptrs.filter((p) => p.body.kind === 'chain' && p.body.holder === sybil.pubB).length, 1,
        "ONE holder's chain pointers over the SAME head collapse to a SINGLE slot. Distinct fake hashes cannot pad the index (dedup by proof event id, not holder-chosen blobHash)")
    }
  }

  // ==========================================================================
  console.log('\n· 5. end-to-end: publish → enumerate → verified contact sheet …')
  // ==========================================================================
  {
    const fabric = new W.MockFabric()
    const mkNode = (tag) => {
      const root = kpOf('ptr-ov-root-' + tag)
      const dev = kpOf('ptr-ov-dev-' + tag)
      const nodeId = W.nodeIdOf(root.pub)
      const ep = fabric.endpoint(nodeId)
      ep.announce(W.signPresence(
        { v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
        dev.priv,
      ))
      const pointerGate = S.makePointerStoreValidator({ directory: () => ep.directory(), nowMs: () => NOW, shard: GEO })
      const shardGate = S.makeShardStoreValidator({ shardMb: 50, verify: GEO, base: pointerGate.validator })
      const node = O.createOverlayNode(ep, { root: root.pubB, key: dev.pubB }, {
        nowMs: () => NOW, validator: shardGate.validator, merge: pointerGate.merge,
      })
      return { root, dev, nodeId, ep, node }
    }
    const nodes = Array.from({ length: 20 }, (_, i) => mkNode(i))
    for (const n of nodes) await n.node.bootstrap()
    const netDir = nodes[0].ep.directory()
    const byId = new Map(nodes.map((n) => [n.nodeId, n]))

    // The overlay population IS the duty directory: recompute X's carriers.
    const netCarriers0 = S.dutyCarriers(subjectNodeId, 0, netDir, { nowMs: NOW })
    const netCarrier = byId.get(netCarriers0[0])
    ok(netCarrier !== undefined, 'the closest duty carrier for (X, row 0) is a live overlay node')
    const netShardPtr = S.makeShardPointer({
      subject: rootX.pubB, holder: netCarrier.root.pubB, key: netCarrier.root.pubB, priv: netCarrier.root.priv,
      ts: WTS + 800, header, idx: 0, verify: GEO, directory: netDir, nowMs: NOW,
    })

    const stored1 = await S.publishPointer(nodes[0].node, ptrO1)
    const stored2 = await S.publishPointers(nodes[3].node, [ptrO2, ptrChain, netShardPtr])
    eq(stored1, S.PARAMS_A3.replicateK, `publishPointer lands on all replicateK=${S.PARAMS_A3.replicateK} closest nodes`)
    eq(stored2, S.PARAMS_A3.replicateK, 'publishPointers batches one put per subject and every store re-verifies + accepts')

    const forged = mint({ ...ptrO1.body, holder: attacker.pubB, key: attacker.pubB }, attacker.priv)
    const storedForged = await nodes[5].node.put(target, 'pointers', { v: 1, ptrs: [forged] })
    eq(storedForged, 0, 'a forged pointer row is refused by EVERY node gate (put counts zero true stores)')

    const raw = await S.enumeratePointers(nodes[7].node, rootX.pubB)
    eq(raw.length, 4, 'enumeratePointers folds the holders into the full 4-record set (one O(1) lookup)')

    const sheet = await S.enumerateContactSheet(nodes[7].node, rootX.pubB, { directory: netDir, nowMs: NOW, shard: GEO })
    eq(sheet.segments.length, 2, 'contact sheet: exactly the two REAL entanglement partners are enumerated')
    ok(sheet.segments.some((s) => s.holder === o1.pubB) && sheet.segments.some((s) => s.holder === o2.pubB), 'contact sheet: both named opponents present as segment holders')
    eq(sheet.segments[0].holder, o2.pubB, 'contact sheet: segments rank freshest-first by capped effTs')
    eq(sheet.chains.length, 1, 'contact sheet: the friend chain replica is listed')
    eq(sheet.chains[0].holder, friend.pubB, 'contact sheet: chain holder is the friend')
    const row0 = sheet.shards.get(0)
    ok(row0 && row0.length >= 1 && row0[0].nodeId === netCarrier.nodeId, 'contact sheet: shard row 0 lists the closest duty carrier first (objective XOR rank)')
    ok([...sheet.shards.values()].every((arr) => arr.length <= S.PARAMS_A3.dutyK), 'contact sheet: at most dutyK carriers per shard row (structural cap)')
    ok(!sheet.segments.some((s) => s.holder === attacker.pubB) && !sheet.chains.some((s) => s.holder === attacker.pubB), 'the attacker appears NOWHERE in the sheet (ignored, never ranked)')

    // A viewer with NO directory still gets the entanglement layers (fail closed on shard).
    const noDir = await S.enumerateContactSheet(nodes[9].node, rootX.pubB, {})
    eq(noDir.segments.length, 2, 'a directory-less viewer still enumerates the entanglement partners')
    eq(noDir.shards.size, 0, 'a directory-less viewer ranks NO shard claims (duty unverifiable ⇒ fail closed)')

    for (const n of nodes) { await n.node.close(); await n.ep.close() }
  }

  // ==========================================================================
  console.log('\n· 6. browser parity: pointer decision core …')
  // ==========================================================================
  {
    const outNode = makeOutdir('accounts-pointers-parity-node')
    const outBrowser = makeOutdir('accounts-pointers-parity-browser')
    try {
      const coreNode = await bundleAndImport(outNode, PARITY_ENTRY, 'node')
      const coreBrowser = await bundleAndImport(outBrowser, PARITY_ENTRY, 'browser')
      const logNode = coreNode.runPointerParityScript()
      const logBrowser = coreBrowser.runPointerParityScript()
      eq(b64(A.sha256(A.utf8(logNode))), b64(A.sha256(A.utf8(logBrowser))), 'node and browser bundles produce the identical mint/verify/fold/sheet transcript')
      ok(logNode.includes('key:' + GOLDEN_POINTER_KEY), 'the parity transcript pins the same pointerKey golden')
      ok(logNode.includes('v-ok:ok') && logNode.includes('v-sig:bad-sig') && logNode.includes('v-stolen:holder-mismatch'), 'parity transcript verdicts are the expected ones (ok / bad-sig / holder-mismatch)')
      const refs = findNodeBuiltinRefs(readBundle(resolve(outBrowser, 'bundle.mjs')))
      eq(refs.length, 0, 'the browser bundle of the pointer core carries zero node built-ins')
    } finally {
      for (const d of [outNode, outBrowser]) rmSync(d, { recursive: true, force: true })
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
