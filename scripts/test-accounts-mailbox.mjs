// Headless test for the A6 social ephemeral modules (src/shared/accounts/
// social/presence.ts + social/mailbox.ts: spec §10, C-3).
//
//   node scripts/test-accounts-mailbox.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-chain.mjs), then drives:
//   · social presence: sign/verify, fail-closed shape/sig matrix, presenceOf
//     (expiry boundaries, skew bound, freshest-wins, tie-break, order
//     independence, deterministic sort);
//   · mailbox: the §10 sentence AS AN EXECUTABLE ASSERT (a sybil flood of N
//     fresh roots cannot evict an established-edge sender's message, and the
//     converse: an established sender always displaces sybil mail), per-sender
//     rate limits, fair-share quotas, deterministic eviction order incl. exact
//     tie-breaks, retention expiry, bounded sender-window memory, drain
//     priority order, fail-closed matrix (same-state-reference checks), and a
//     scripted-sequence re-run asserting bit-identical state hashes.
//
// Synthetic fixtures only: no engine, no network. Fixed raw 32-byte seeds.
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).

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

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-mailbox-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  console.log('· bundling src/shared/accounts/social (presence/mailbox) …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as pres from '${SRC}/social/presence.ts'`,
      `export * as mbox from '${SRC}/social/mailbox.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, 'social.mjs')
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
  const { codec, hash, pres, mbox } = await import(pathToFileURL(outfile).href)

  // ---- fixed raw keypairs ---------------------------------------------------
  const seed = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seed(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const alice = kp(1)
  const bob = kp(40)
  const carol = kp(80)
  const dave = kp(120)
  const eve = kp(160) // the impersonator
  const stateHash = (s) => hash.toB64u(codec.canonicalHash(s))

  // ==========================================================================
  console.log('\n[1] social presence: sign/verify')
  // ==========================================================================
  const pbody = (root, status, ts, ttlMs = 60_000) => ({ v: 1, root, status, ts, ttlMs })
  const spA = pres.signSocialPresence(pbody(alice.pubB, 'online', 1_000_000), alice.priv)
  ok(pres.verifySocialPresence(spA), 'root-signed claim verifies')
  ok(!pres.verifySocialPresence({ ...spA, body: { ...spA.body, status: 'playing' } }), 'tampered body fails')
  const forged = pres.signSocialPresence(pbody(alice.pubB, 'online', 1_000_000), eve.priv)
  ok(!pres.verifySocialPresence(forged), 'claim signed by a different key than body.root fails (no impersonation)')
  ok(!pres.verifySocialPresence(pres.signSocialPresence(pbody(alice.pubB, 'online', 1_000_000, 10 ** 9), alice.priv)), 'ttl above ttlMaxMs fails')
  const badShapes = [
    ['bad status', { ...spA, body: { ...spA.body, status: 'idle' } }],
    ['zero ttl', { ...spA, body: { ...spA.body, ttlMs: 0 } }],
    ['negative ts', { ...spA, body: { ...spA.body, ts: -5 } }],
    ['float ts', { ...spA, body: { ...spA.body, ts: 1.5 } }],
    ['extra field', { ...spA, body: { ...spA.body, rating: 1500 } }],
    ['short root', { ...spA, body: { ...spA.body, root: 'abc' } }],
    ['bad sig chars', { ...spA, sig: '!'.repeat(86) }],
    ['non-object', 42],
  ]
  for (const [name, bad] of badShapes) ok(!pres.verifySocialPresence(bad), `fail-closed shape: ${name}`)

  // ==========================================================================
  console.log('\n[2] social presence, presenceOf aggregation')
  // ==========================================================================
  const T = 1_000_000
  eq(pres.presenceOf([], T).length, 0, 'empty claim set → empty')
  const viewA = pres.presenceOf([spA], T)
  eq(viewA.length, 1, 'live claim appears')
  eq(viewA[0].root, alice.pubB, 'view carries root')
  eq(viewA[0].status, 'online', 'view carries status')
  eq(viewA[0].expiresWts, T + 60_000, 'view expiry = ts + ttl')
  eq(pres.presenceOf([spA], T + 60_000).length, 1, 'claim at exactly ts+ttl is still live')
  eq(pres.presenceOf([spA], T + 60_001).length, 0, 'claim past ts+ttl expires')
  const future = pres.signSocialPresence(pbody(alice.pubB, 'online', T + 120_000), alice.priv)
  eq(pres.presenceOf([future], T).length, 1, 'future claim within skewMax is live')
  const farFuture = pres.signSocialPresence(pbody(alice.pubB, 'online', T + 120_001), alice.priv)
  eq(pres.presenceOf([farFuture], T).length, 0, 'future claim beyond skewMax dropped')
  const spA2 = pres.signSocialPresence(pbody(alice.pubB, 'playing', T + 5000), alice.priv)
  const fresh = pres.presenceOf([spA, spA2], T + 5000)
  eq(fresh.length, 1, 'freshest-wins collapses per root')
  eq(fresh[0].status, 'playing', 'the newer claim wins')
  // exact-ts tie: two distinct valid claims, same root+ts → greater sig wins,
  // independent of input order
  const tieX = pres.signSocialPresence(pbody(alice.pubB, 'online', T, 50_000), alice.priv)
  const tieY = pres.signSocialPresence(pbody(alice.pubB, 'away', T, 50_001), alice.priv)
  const wantWin = codec.compareKeys(tieX.sig, tieY.sig) > 0 ? tieX : tieY
  const t1 = pres.presenceOf([tieX, tieY], T)
  const t2 = pres.presenceOf([tieY, tieX], T)
  eq(t1[0].status, wantWin.body.status, 'equal-ts tie broken by greater sig')
  eq(JSON.stringify(t1), JSON.stringify(t2), 'aggregation independent of input order')
  const spB = pres.signSocialPresence(pbody(bob.pubB, 'away', T), bob.priv)
  const multi = pres.presenceOf([spB, spA, forged, 42], T)
  eq(multi.length, 2, 'invalid claims skipped, valid roots kept')
  ok(codec.compareKeys(multi[0].root, multi[1].root) < 0, 'output sorted by root')
  eq(pres.presenceOf([spA], -1).length, 0, 'negative nowWts fails closed')
  eq(pres.presenceOf([spA], T + 0.5).length, 0, 'non-integer nowWts fails closed')

  // ==========================================================================
  console.log('\n[3] mailbox: init, happy path, fail-closed matrix')
  // ==========================================================================
  // Small test params (functions are parameterized; state pins the digest).
  const P = {
    v: 1,
    rateWindowMs: 1000,
    ratePerWindow: 3,
    boxCap: 4,
    perSenderPerBox: 2,
    recipientsCap: 3,
    sendersCap: 4,
    retentionMs: 10_000,
    payloadMaxChars: 64,
  }
  const env = (from, to, n, sentTs = 500) => ({ v: 1, sender: from.pubB, recipient: to.pubB, kind: 'friend-request', payload: `p${n}`, sentTs })
  const mail = (from, to, n, sentTs) => mbox.signMail(env(from, to, n, sentTs), from.priv)
  const meta = (nowWts, edgeMicro) => ({ nowWts, edgeMicro })

  const s0 = mbox.mailboxInit(P)
  eq(s0.params, mbox.mailboxParamsDigest(P), 'init pins the params digest')
  const m1 = mail(alice, bob, 1)
  const r1 = mbox.mailboxAdmit(s0, m1, meta(100, 250_000), P)
  ok(r1.admitted && !r1.reason, 'happy admit')
  eq(r1.state.boxes[bob.pubB].length, 1, 'stored in the recipient box')
  eq(r1.state.boxes[bob.pubB][0].arrivedWts, 100, 'arrival stamped from meta.nowWts')
  eq(r1.state.boxes[bob.pubB][0].edgeMicro, 250_000, 'edge frozen at admit')
  eq(r1.state.senders[alice.pubB].count, 1, 'sender window charged')
  eq(mbox.mailId(m1.body), r1.state.boxes[bob.pubB][0].id, 'stored id = mailId(envelope)')

  const failCases = [
    ['bad-shape', { ...m1, body: { ...m1.body, kind: '' } }, meta(100, 0)],
    ['bad-shape', { ...m1, body: { ...m1.body, extra: 1 } }, meta(100, 0)],
    ['bad-shape', mail(alice, bob, 'x'.repeat(65)), meta(100, 0)],
    ['bad-meta', m1, meta(100.5, 0)],
    ['bad-meta', m1, meta(100, -1)],
    ['bad-meta', m1, meta(100, 1_000_001)],
    ['bad-meta', m1, { nowWts: 100 }],
    ['bad-sig', { ...m1, body: { ...m1.body, payload: 'tampered' } }, meta(100, 0)],
    ['bad-sig', mbox.signMail(env(alice, bob, 9), eve.priv), meta(100, 0)],
    ['self-mail', mail(alice, alice, 2), meta(100, 0)],
  ]
  for (const [want, badMsg, badMeta] of failCases) {
    const r = mbox.mailboxAdmit(r1.state, badMsg, badMeta, P)
    ok(!r.admitted && r.reason === want && r.state === r1.state, `fail-closed '${want}' rejects with SAME state reference`)
  }
  const rMismatch = mbox.mailboxAdmit(r1.state, mail(alice, bob, 3), meta(100, 0)) // default params vs P-pinned state
  ok(!rMismatch.admitted && rMismatch.reason === 'params-mismatch' && rMismatch.state === r1.state, "fail-closed 'params-mismatch' with SAME state reference")

  // ==========================================================================
  console.log('\n[4] mailbox: dedup + per-sender rate limit')
  // ==========================================================================
  let s = r1.state
  const rDup = mbox.mailboxAdmit(s, m1, meta(150, 250_000), P)
  ok(!rDup.admitted && rDup.reason === 'duplicate', 'replayed envelope rejected as duplicate')
  s = rDup.state
  // dedup did NOT charge the budget: 2 more fresh admits still fit (cap 3)
  const rA = mbox.mailboxAdmit(s, mail(alice, bob, 2), meta(160, 250_000), P)
  const rB = mbox.mailboxAdmit(rA.state, mail(alice, carol, 3), meta(170, 250_000), P)
  ok(rA.admitted && rB.admitted, 'duplicate rejection never burns the sender budget')
  const rC = mbox.mailboxAdmit(rB.state, mail(alice, carol, 4), meta(180, 250_000), P)
  ok(!rC.admitted && rC.reason === 'rate-limited', 'admit #4 in window rate-limited (limit is global across recipients)')
  // window rolls
  const rRoll = mbox.mailboxAdmit(rC.state, mail(alice, carol, 4), meta(100 + P.rateWindowMs, 250_000), P)
  ok(rRoll.admitted, 'window rolls after rateWindowMs: sender admits again')
  eq(rRoll.state.senders[alice.pubB].count, 1, 'rolled window restarts the count')

  // ==========================================================================
  console.log('\n[5] mailbox: fair-share quota + relay capacity')
  // ==========================================================================
  s = mbox.mailboxInit(P)
  s = mbox.mailboxAdmit(s, mail(alice, bob, 1), meta(10, 0), P).state
  s = mbox.mailboxAdmit(s, mail(alice, bob, 2), meta(11, 0), P).state
  const rShare = mbox.mailboxAdmit(s, mail(alice, bob, 3), meta(12, 0), P)
  ok(!rShare.admitted && rShare.reason === 'sender-share', 'per-sender-per-box fair share enforced (box not even full)')
  const rOther = mbox.mailboxAdmit(rShare.state, mail(carol, bob, 1), meta(13, 0), P)
  ok(rOther.admitted, 'another sender still admits to the same box')
  // recipientsCap = 3: boxes bob, carol, dave → a 4th recipient is refused
  s = rOther.state
  s = mbox.mailboxAdmit(s, mail(alice, carol, 5), meta(14, 0), P).state
  s = mbox.mailboxAdmit(s, mail(carol, dave, 6), meta(15, 0), P).state
  eq(Object.keys(s.boxes).length, 3, 'three recipient boxes exist')
  const rFull = mbox.mailboxAdmit(s, mail(carol, eve, 1), meta(16, 0), P)
  ok(!rFull.admitted && rFull.reason === 'relay-full', 'new recipient beyond recipientsCap refused (never evicts another box)')
  ok(mbox.mailboxAdmit(rFull.state, mail(dave, bob, 1), meta(17, 0), P).admitted, 'existing recipient still admittable at relay capacity')

  // ==========================================================================
  console.log('\n[6] mailbox: THE §10 SENTENCE (sybil flood cannot evict established roots)')
  // ==========================================================================
  const EDGE = 500_000
  s = mbox.mailboxInit(P)
  // Fill bob's box to boxCap=4 with two ESTABLISHED senders (2 each; at the fair-share cap).
  const est = [mail(alice, bob, 1), mail(alice, bob, 2), mail(carol, bob, 1), mail(carol, bob, 2)]
  est.forEach((m, i) => {
    s = mbox.mailboxAdmit(s, m, meta(100 + i, EDGE), P).state
  })
  eq(s.boxes[bob.pubB].length, P.boxCap, 'box full of established-edge mail')
  const establishedIds = JSON.stringify(s.boxes[bob.pubB].map((m) => m.id))
  const N = 50
  let allRejected = true
  let anyEvicted = false
  for (let i = 0; i < N; i++) {
    const sybil = kp(200 + i) // N fresh roots, edge 0
    const r = mbox.mailboxAdmit(s, mail(sybil, bob, i), meta(200 + i, 0), P)
    if (r.admitted || r.reason !== 'box-full') allRejected = false
    if (r.evicted) anyEvicted = true
    s = r.state
  }
  ok(allRejected, `§10: every one of ${N} fresh-root flood messages rejected 'box-full'`)
  ok(!anyEvicted, '§10: the flood evicted NOTHING')
  eq(JSON.stringify(s.boxes[bob.pubB].map((m) => m.id)), establishedIds, '§10: established mail untouched, byte-for-byte, before the recipient syncs')
  // Converse: a box full of sybil mail always yields to an established sender.
  let s2 = mbox.mailboxInit(P)
  const sybils = [kp(100), kp(101), kp(102), kp(103)]
  sybils.forEach((sy, i) => {
    s2 = mbox.mailboxAdmit(s2, mail(sy, bob, i), meta(300 + i, 0), P).state
  })
  const rEst = mbox.mailboxAdmit(s2, mail(alice, bob, 7), meta(400, EDGE), P)
  ok(rEst.admitted, 'converse: established sender displaces sybil mail from a full box')
  // deterministic candidate: min edge (all 0) → NEWEST arrival = 303
  eq(rEst.evicted.arrivedWts, 303, 'eviction order: weakest edge, then NEWEST arrival evicted first')
  // Equal-edge newcomer never displaces (first-come wins within a class).
  const rPeer = mbox.mailboxAdmit(s, mail(dave, bob, 1), meta(500, EDGE), P)
  ok(!rPeer.admitted && rPeer.reason === 'box-full', 'equal-edge newcomer rejected, no eviction among equals')
  // Exact tie determinism: equal edge AND equal arrivedWts → greater id evicted.
  let s3 = mbox.mailboxInit(P)
  const tieMsgs = [mail(kp(100), bob, 'a'), mail(kp(101), bob, 'b'), mail(kp(102), bob, 'c'), mail(kp(103), bob, 'd')]
  for (const m of tieMsgs) s3 = mbox.mailboxAdmit(s3, m, meta(600, 0), P).state // all at wts 600
  const ids = tieMsgs.map((m) => mbox.mailId(m.body)).sort(codec.compareKeys)
  const rTie = mbox.mailboxAdmit(s3, mail(alice, bob, 8), meta(601, EDGE), P)
  eq(rTie.evicted.id, ids[ids.length - 1], 'exact tie (edge+arrival) evicts the greater id, fully deterministic')

  // ==========================================================================
  console.log('\n[7] mailbox: retention expiry + bounded sender-window memory')
  // ==========================================================================
  s = mbox.mailboxInit(P)
  s = mbox.mailboxAdmit(s, mail(alice, bob, 1), meta(0, 0), P).state
  const rLate = mbox.mailboxAdmit(s, mail(carol, dave, 1), meta(P.retentionMs - 1, 0), P)
  ok(rLate.state.boxes[bob.pubB]?.length === 1, 'mail at retention−1 still held')
  const rExp = mbox.mailboxAdmit(rLate.state, mail(carol, dave, 2), meta(P.retentionMs, 0), P)
  ok(!(bob.pubB in rExp.state.boxes), 'mail pruned at exactly retentionMs (emptied box removed)')
  // sendersCap = 4: a 5th window evicts the OLDEST winStart (tie → smaller root)
  s = mbox.mailboxInit(P)
  const senders5 = [alice, bob, carol, dave, eve]
  senders5.forEach((from, i) => {
    const to = from === bob ? carol : bob
    s = mbox.mailboxAdmit(s, mail(from, to, 1), meta(700 + i, 0), P).state
  })
  eq(Object.keys(s.senders).length, P.sendersCap, 'sender-window memory bounded at sendersCap')
  ok(!(alice.pubB in s.senders), 'oldest window (min winStartWts) evicted for the new sender')
  ok(eve.pubB in s.senders, 'new sender tracked after rotation')
  // expired windows prune on their own
  const rWinPrune = mbox.mailboxAdmit(s, mail(alice, carol, 2), meta(705 + P.rateWindowMs, 0), P)
  eq(Object.keys(rWinPrune.state.senders).length, 1, 'expired windows pruned: only the fresh admit remains tracked')

  // ==========================================================================
  console.log('\n[8] mailbox: drain (recipient syncs)')
  // ==========================================================================
  s = mbox.mailboxInit(P)
  const dm1 = mail(alice, bob, 1) // edge 0, early
  const dm2 = mail(carol, bob, 1) // edge high, late
  const dm3 = mail(dave, bob, 1) // edge high, early
  s = mbox.mailboxAdmit(s, dm1, meta(10, 0), P).state
  s = mbox.mailboxAdmit(s, dm2, meta(30, EDGE), P).state
  s = mbox.mailboxAdmit(s, dm3, meta(20, EDGE), P).state
  const drained = mbox.mailboxDrain(s, bob.pubB, 40, P)
  eq(drained.msgs.length, 3, 'drain returns the whole box')
  eq(JSON.stringify(drained.msgs.map((m) => m.sender)), JSON.stringify([dave.pubB, carol.pubB, alice.pubB]), 'drain priority: edge DESC, then arrival ASC, established roots first (§10 prioritization)')
  ok(!(bob.pubB in drained.state.boxes), 'drained box cleared')
  eq(mbox.mailboxDrain(drained.state, bob.pubB, 41, P).msgs.length, 0, 'second drain is empty')
  const badDrain = mbox.mailboxDrain(s, 'not-a-root', 40, P)
  ok(badDrain.state === s && badDrain.msgs.length === 0, 'drain fails closed (same reference) on bad recipient')
  const mmDrain = mbox.mailboxDrain(s, bob.pubB, 40) // default params vs P-pinned state
  ok(mmDrain.state === s && mmDrain.msgs.length === 0, 'drain fails closed (same reference) on params mismatch')

  // ==========================================================================
  console.log('\n[9] determinism: scripted sequence re-runs bit-identical')
  // ==========================================================================
  const script = []
  script.push([mail(alice, bob, 1), meta(100, EDGE)])
  script.push([mail(alice, bob, 1), meta(101, EDGE)]) // duplicate
  script.push([mail(carol, bob, 1), meta(102, 0)])
  script.push([mail(carol, bob, 2), meta(103, 0)])
  script.push([mail(carol, bob, 3), meta(104, 0)]) // sender-share
  for (let i = 0; i < 6; i++) script.push([mail(kp(220 + i), bob, i), meta(110 + i, 0)]) // fill + flood
  script.push([mail(dave, bob, 9), meta(130, EDGE)]) // evicts a sybil
  script.push([mail(alice, carol, 9), meta(140, EDGE)])
  script.push([mail(alice, dave, 9), meta(150, EDGE)]) // rate cap reached for alice
  script.push([mail(alice, dave, 10), meta(151, EDGE)]) // rate-limited
  script.push([mail(bob, carol, 1), meta(5000 + P.retentionMs, 0)]) // triggers retention prune
  const runScript = () => {
    let st = mbox.mailboxInit(P)
    const outcomes = []
    for (const [m, mt] of script) {
      const r = mbox.mailboxAdmit(st, m, mt, P)
      outcomes.push(r.admitted ? 'A' : r.reason)
      st = r.state
    }
    return { st, outcomes: outcomes.join(',') }
  }
  const runX = runScript()
  const runY = runScript()
  eq(stateHash(runX.st), stateHash(runY.st), 'same sequence twice → canonicalHash(state) bit-identical')
  eq(runX.outcomes, runY.outcomes, 'same sequence twice → identical outcome trace')
  ok(runX.outcomes.includes('duplicate') && runX.outcomes.includes('sender-share') && runX.outcomes.includes('box-full') && runX.outcomes.includes('rate-limited'), 'the scripted trace exercises every quota path')
  // canonical-serializability of state (the cross-platform bit-identity anchor)
  ok(typeof stateHash(runX.st) === 'string' && stateHash(runX.st).length === 43, 'state is a CanonicalObject (hashable, integers/strings only)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
