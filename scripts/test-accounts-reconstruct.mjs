// THE A3 RECONSTRUCTION SUITE — brick 5 + THE A3 ACCEPTANCE PROOF (spec §5
// viewing flow / §2 checkpoint rules / §14-A3 acceptance scenario; module:
// src/shared/accounts/storage/viewer.ts; docs/ACCOUNTS-SPEC.md).
//
//   node scripts/test-accounts-reconstruct.mjs
//
// Proves the brick end to end, fabric-suite style:
//   U. unit matrix (pure viewer core): verified-freshest head selection (an
//      unattested or merely-claimed-newer head never pins); §2 checkpoint
//      selection — a fabricated-prior fold that passes the incremental step is
//      caught by the spot-check / forced by lacking cosigner diversity, and
//      honest fallback + M-of-N preference hold; lazy history pages verified
//      against the pinned head — a tampered mid-chain event breaks its page
//      with a typed failure, never wrong bytes; holder summaries verified
//      element-by-element; freshest-holder ranking ignores poisoned pointers
//      and caps lying timestamps; the shard read serves the freshest
//      reconstructible snapshot and STILL pins the newest observed head when
//      forced onto an older one.
//   P. THE A3 PROOF (§5 acceptance scenario, locked): a subject with 1,000
//      witnessed games and 50 M-of-N-cosigned checkpoints, 300 opponents on a
//      real overlay carrying shards + entanglement segments, publish-on-write
//      + finalSync complete, THE OWNER'S NODE LEAVES FOREVER, and a fresh
//      viewer resolves the subject: profile + newest checkpoint + head + the
//      FULL 1,000-game history reconstruct BIT-FAITHFUL to the original chain
//      bytes, in chess.com-profile time.
//   D. the degraded case: enough carriers die that live shard rows fall below
//      K_rec=12 → reconstruction honestly reports temporary unavailability
//      (the pointer floor still serves); a carrier returns → exactly K_rec
//      rows reconstruct bit-identically; new nodes join and runRepair
//      re-encodes + redistributes → full width heals; the failure mode is
//      temporary unavailability that HEALS, never silent loss.
//   B. browser parity: the viewer decision core bundled platform:'browser'
//      produces the identical decision digest and carries zero node built-ins.
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

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as S from '@shared/accounts/storage'
export * as SEG from '@shared/accounts/segment'
`

// The viewer decision core — bundled twice (platform node vs browser), driven
// through one scripted select/spot-check/page/summary sequence; the digests
// must match byte-for-byte (verifiers byte-deterministic in a browser bundle)
// and the browser bundle must carry zero node built-ins.
const PARITY_ENTRY = `
import {
  appendEvent, appendPersonal, appendWitnessed, canonicalHash, createAccountChain, eventId,
  makeCheckpointEvent, verifyChain,
} from '@shared/accounts'
import { ed25519, sha256, toB64u, utf8 } from '@shared/accounts/hash'
import { makeAttestation, cosignCheckpoint, nodeIdOf } from '@shared/accounts/witness'
import {
  buildHolderSummary, foldProfileLww, openHistory, selectCheckpoint, selectHead,
  verifyHolderSummary,
} from '@shared/accounts/storage'

export async function runViewerParityScript(): Promise<string> {
  const log: string[] = []
  const seed = (t: string) => sha256(utf8('rcp-' + t))
  const kp = (t: string) => {
    const priv = seed(t)
    const pub = ed25519.getPublicKey(priv)
    return { priv, pub, pubB: toB64u(pub) }
  }
  const idLike = (t: string) => toB64u(seed(t))
  const T0 = 1_750_000_000_000
  const root = kp('root')
  const wit = kp('wit')
  const att = (ev: any, wts: number) => ({ ...ev, wit: [makeAttestation(eventId(ev.body), 1, wit.pubB, wit.priv, wts)] })
  const attachLast = (c: any, wts: number) => ({ root: c.root, events: [...c.events.slice(0, -1), att(c.events[c.events.length - 1], wts)] })

  let c: any = createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Parity Subject', ts: T0 })
  c = { root: c.root, events: [att(c.events[0], T0 + 5)] }
  for (let i = 1; i <= 8; i++) {
    c = attachLast(appendWitnessed(c, root.priv, root.pubB, 'revoke', { pub: idLike('gone-' + i) }, T0 + i * 1000), T0 + i * 1000 + 5)
  }
  const r1 = makeCheckpointEvent(c, root.priv, root.pubB, T0 + 9_000)
  const r1att = cosignCheckpoint(r1, c, wit.pubB, wit.priv, T0 + 9_005)!
  c = appendEvent(c, { body: r1.body, sig: r1.sig, wit: [r1att] })
  for (let i = 10; i <= 13; i++) {
    c = attachLast(appendWitnessed(c, root.priv, root.pubB, 'revoke', { pub: idLike('gone-' + i) }, T0 + i * 1000), T0 + i * 1000 + 5)
  }
  c = appendPersonal(c, root.priv, root.pubB, 'profile', { fields: { bio: 'parity bio', country: 'NO' } }, T0 + 14_000)

  const head = selectHead(c.events)!
  log.push('head:' + head.id + '@' + head.height)
  const sel = selectCheckpoint(c, { spot: { p: 1, roll: 0 } })
  log.push('ckpt:' + (sel ? sel.id + '/' + sel.verified + '/' + sel.cosigners : 'null'))

  const summary = buildHolderSummary(c)
  const vs = verifyHolderSummary(summary, root.pubB)
  log.push('sum:' + vs.ok + '/' + (vs.head ? eventId(vs.head.body) : '-') + '/' + vs.profileEvents.length + '/' + vs.dropped.join('+'))
  log.push('lww:' + toB64u(canonicalHash(foldProfileLww(vs.profileEvents) as any)))

  const vr = verifyChain(c)
  log.push('vr:' + vr.digest)
  const pager = openHistory(root.pubB, { id: head.id, height: head.height }, {
    events: (from: number, to: number) =>
      Promise.resolve(c.events.filter((e: any) => e.body.lane === 'w' && e.body.height >= from && e.body.height <= to)),
  }, { pageSize: 4 })
  log.push('pages:' + pager.pageCount)
  for (let i = 0; i < pager.pageCount; i++) {
    const p = await pager.page(i)
    log.push('p' + i + ':' + (p.ok ? p.from + '-' + p.to + '/' + p.events.map((e: any) => eventId(e.body).slice(0, 6)).join(',') : p.reason))
  }
  log.push('nid:' + nodeIdOf(root.pubB))
  return toB64u(sha256(utf8(JSON.stringify(log))))
}
`

async function main() {
  const outdir = makeOutdir('accounts-reconstruct-test')
  const outNode = makeOutdir('accounts-reconstruct-parity-node')
  const outBrowser = makeOutdir('accounts-reconstruct-parity-browser')
  try {
    await run(await bundleAndImport(outdir, ENTRY), outNode, outBrowser)
  } finally {
    for (const d of [outdir, outNode, outBrowser]) rmSync(d, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M, outNode, outBrowser) {
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
  const shaB = (bytes) => b64(A.sha256(bytes))
  const mint = (body, priv) => ({ body, sig: b64(A.ed25519.sign(A.canonicalBytes(body), priv)) })
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  const clone = (x) => structuredClone(x)
  const stamp = (label, t0) => console.log(`    (${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  const NOW0 = 1_750_000_000_000
  let now = NOW0 // the ONE injected clock every node closes over

  // 8 witnesses ground to DISTINCT /16 nodeId prefixes (M-of-N diversity).
  const wits = []
  for (let i = 0; wits.length < 8 && i < 400; i++) {
    const kp = kpOf('rc-wit-' + i)
    const nodeId = W.nodeIdOf(kp.pub)
    const pfx = W.prefixBucket(nodeId, 16)
    if (!wits.some((w) => w.pfx === pfx)) wits.push({ ...kp, nodeId, pfx })
  }
  ok(wits.length === 8 && new Set(wits.map((w) => w.pfx)).size === 8, 'fixture: 8 witnesses with 8 distinct /16 prefixes')
  const eligible = new Map(wits.map((w) => [w.pubB, w.nodeId]))
  const RULE = { m: 4, n: 8, prefixDiversityMin: 3 }

  // ==========================================================================
  console.log('\n· U0. static determinism guard (viewer.ts platform-neutral) …')
  // ==========================================================================
  {
    // The viewer is platform-neutral + byte-deterministic (no ambient time /
    // randomness / timers / node builtins). The browser parity digest exercises
    // one scripted path, so it cannot catch a regression in an unexercised branch
    // (e.g. a defaulted nowMs) — this source-regex guard covers every branch.
    const src = readFileSync(resolve(ROOT, 'src/shared/accounts/storage/viewer.ts'), 'utf8')
    ok(!/\bDate\.now\s*\(|\bMath\.random\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|\bperformance\.now\s*\(/.test(src),
      'viewer.ts calls no ambient time, randomness, or timers (clocks + spot-check draw are INJECTED)')
    ok(!/from 'node:|from "node:/.test(src), 'viewer.ts imports no node: builtins (platform-neutral)')
  }

  const attOf = (ev, w, wts) => ({ ...ev, wit: [W.makeAttestation(A.eventId(ev.body), 1, w.pubB, w.priv, wts)] })
  const attachLast = (chain, w, wts) => {
    const last = chain.events[chain.events.length - 1]
    return { root: chain.root, events: [...chain.events.slice(0, -1), attOf(last, w, wts)] }
  }

  // ==========================================================================
  console.log('\n· U1. selectHead — verified-freshest, never claimed-freshest …')
  // ==========================================================================
  {
    const r = kpOf('u1-root')
    const w = wits[0]
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-One Subject', ts: NOW0 })
    c = { root: c.root, events: [attOf(c.events[0], w, NOW0 + 5)] }
    for (let i = 1; i <= 5; i++)
      c = attachLast(A.appendWitnessed(c, r.priv, r.pubB, 'revoke', { pub: idLike('u1-' + i) }, NOW0 + i * 1000), w, NOW0 + i * 1000 + 5)
    const events = c.events.filter((e) => e.body.lane === 'w')
    const h5 = events[5]
    const head = S.selectHead(events)
    ok(head !== null && head.height === 5 && head.id === A.eventId(h5.body), 'the attested max-height event pins the head')
    const bare = { body: h5.body, sig: h5.sig } // attestation stripped
    const forged = A.signBody({ ...h5.body, height: 9, prev: A.eventId(events[4].body), ts: h5.body.ts + 1 }, r.priv)
    eq(S.selectHead([...events.slice(0, 5), bare])?.height, 4, 'an UNATTESTED newer event never pins the head (§0: witness countersignature is the authority)')
    eq(S.selectHead([...events, forged])?.height, 5, 'an owner-signed but unattested height-9 claim loses to the verified height-5 head')
    const rebound = { ...h5, wit: [W.makeAttestation(A.eventId(events[4].body), 1, wits[0].pubB, wits[0].priv, NOW0)] }
    eq(S.selectHead([events[0], rebound])?.height, 0, 'an attestation bound to a DIFFERENT event id confers nothing')
    eq(S.selectHead([]), null, 'an empty pool pins nothing (honest null)')
  }

  // ==========================================================================
  console.log('\n· U2. selectCheckpoint — §2 incremental + spot-check + M-of-N …')
  // ==========================================================================
  {
    const r = kpOf('u2-root')
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Two Subject', ts: NOW0 })
    c = { root: c.root, events: [attOf(c.events[0], wits[0], NOW0 + 5)] }
    for (let i = 1; i <= 8; i++)
      c = attachLast(A.appendWitnessed(c, r.priv, r.pubB, 'revoke', { pub: idLike('u2-' + i) }, NOW0 + i * 1000), wits[i % 8], NOW0 + i * 1000 + 5)
    // Honest checkpoint R1 at height 9 (through 8), cosigned by 5 diverse witnesses.
    const r1 = A.makeCheckpointEvent(c, r.priv, r.pubB, NOW0 + 9_000)
    const r1atts = wits.slice(0, 5).map((w, i) => W.cosignCheckpoint(r1, c, w.pubB, w.priv, NOW0 + 9_005 + i))
    ok(r1atts.every((a) => a !== null), 'cosignCheckpoint recomputes the incremental step before signing (5 witnesses cosign R1)')
    c = A.appendEvent(c, { body: r1.body, sig: r1.sig, wit: r1atts })
    for (let i = 10; i <= 13; i++)
      c = attachLast(A.appendWitnessed(c, r.priv, r.pubB, 'revoke', { pub: idLike('u2-' + i) }, NOW0 + i * 1000), wits[i % 8], NOW0 + i * 1000 + 5)

    // THE TRAP (§2): a fabricated PRIOR checkpoint F' whose embedded state is
    // wrong but self-consistent, then B computed by folding FROM that wrong
    // state — B's incremental step verifies; only a deeper re-derivation
    // (the spot-check) exposes the pair.
    const head13 = c.events[c.events.length - 1]
    const wrongState = { n: 999, byType: { fabricated: 999 }, head: idLike('u2-fake-head'), height: 13 }
    const fBody = {
      v: 1, lane: 'w', type: 'ckpt', root: r.pubB, key: r.pubB, height: 14,
      prev: A.eventId(head13.body), ts: NOW0 + 14_000,
      payload: { prevCkpt: A.eventId(r1.body), through: 13, state: wrongState, stateDigest: canon(wrongState) },
    }
    const fPrime = attOf(mint(fBody, r.priv), wits[0], NOW0 + 14_005)
    c = A.appendEvent(c, fPrime)
    for (let i = 15; i <= 18; i++)
      c = attachLast(A.appendWitnessed(c, r.priv, r.pubB, 'revoke', { pub: idLike('u2-' + i) }, NOW0 + i * 1000), wits[i % 8], NOW0 + i * 1000 + 5)
    // Fold WRONG13 over heights 14..18 (F' itself + the four events after it).
    let bState = wrongState
    for (const ev of c.events.filter((e) => e.body.lane === 'w' && e.body.height >= 14 && e.body.height <= 18))
      bState = A.basicFold.step(bState, ev)
    const head18 = c.events[c.events.length - 1]
    const bBody = {
      v: 1, lane: 'w', type: 'ckpt', root: r.pubB, key: r.pubB, height: 19,
      prev: A.eventId(head18.body), ts: NOW0 + 19_000,
      payload: { prevCkpt: A.eventId(fBody), through: 18, state: bState, stateDigest: canon(bState) },
    }
    const bEv = attOf(mint(bBody, r.priv), wits[0], NOW0 + 19_005)
    c = A.appendEvent(c, bEv)

    ok(A.verifyCheckpointIncremental(c, bEv), "sanity: B's incremental step VERIFIES (it honestly folds from the fabricated prior)")
    ok(!A.verifyCheckpointDeep(c, bEv), 'sanity: a genesis re-derivation exposes B (the §2 spot-check target)')

    const spotOn = S.selectCheckpoint(c, { spot: { p: 1, roll: 0 } })
    ok(spotOn !== null && spotOn.id === A.eventId(r1.body) && spotOn.verified === 'deep',
      'spot-check DRAWN: the fabricated-prior pair is rejected and the honest checkpoint surfaces, deep-verified')
    const unknownDiv = S.selectCheckpoint(c, { spot: { p: 0, roll: 0.9 } })
    ok(unknownDiv !== null && unknownDiv.id === A.eventId(r1.body),
      'cosigner diversity UNKNOWN (no eligibility join): the viewer fails toward auditing — spot forced, forgery rejected')
    const fastPath = S.selectCheckpoint(c, { spot: { p: 0, roll: 0.9 }, cosig: { eligible, rule: { m: 1, n: 8, prefixDiversityMin: 1 } } })
    ok(fastPath !== null && fastPath.id === A.eventId(bBody) && fastPath.verified === 'incremental',
      "diverse-enough cosigners + no draw: the incremental fast path alone pins the forgery — EXACTLY the exposure §2's p_spot bounds (documented, not desired)")
    const forcedByDiv = S.selectCheckpoint(c, { spot: { p: 0, roll: 0.9 }, cosig: { eligible, rule: RULE } })
    ok(forcedByDiv !== null && forcedByDiv.id === A.eventId(r1.body) && forcedByDiv.mOfN === true,
      "B's single cosigner LACKS diversity under the M-of-N rule → spot forced → forgery rejected; R1 surfaces with mOfN true")
    eq(forcedByDiv.cosigners, 5, 'the surfaced checkpoint carries its 5 distinct cosigners')
    ok(forcedByDiv.prefixes16 >= RULE.prefixDiversityMin, 'the cosigner /16 prefix diversity is surfaced for A4')
    // A checkpoint with NO valid attestation never surfaces.
    const stripped = { root: c.root, events: c.events.map((e) => (e.body.type === 'ckpt' ? { body: e.body, sig: e.sig } : e)) }
    eq(S.selectCheckpoint(stripped, { spot: { p: 1, roll: 0 } }), null, 'checkpoints without any witness attestation pin nothing (honest null)')
  }

  // ==========================================================================
  console.log('\n· U3. history pages — no page substitution, honest failures …')
  // ==========================================================================
  {
    const r = kpOf('u3-root')
    const dev = kpOf('u3-dev')
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Three Pager', ts: NOW0, device: { pub: dev.pubB, index: 0 } })
    c = { root: c.root, events: [attOf(c.events[0], wits[0], NOW0 + 5), ...c.events.slice(1)] }
    for (let g = 1; g <= 39; g++) {
      const game = idLike('u3-game-' + g)
      const transcript = SEG.transcriptDigest(game, [], '1-0', 'resign')
      const payload = SEG.makeSegmentPayload({
        game, opp: kpOf('u3-opp-' + (g % 4)).pubB, color: g % 2 ? 'b' : 'w', result: '1-0', reason: 'resign', moves: [],
        heads: { w: { head: idLike('u3-hw-' + g), height: 0 }, b: { head: idLike('u3-hb-' + g), height: 0 } },
        wstream: SEG.signWitnessEnd(wits[0].priv, wits[0].pubB, game, '1-0', 0, transcript),
        oppProfile: { name: 'U3 Opp' },
      })
      c = attachLast(A.appendWitnessed(c, dev.priv, dev.pubB, 'segment', payload, NOW0 + g * 1000), wits[g % 8], NOW0 + g * 1000 + 5)
    }
    const wEvents = c.events.filter((e) => e.body.lane === 'w')
    const certs = A.certsProving(r.pubB, c.events, [dev.pubB])
    const head = S.selectHead(wEvents)
    const sourceOf = (events) => ({
      events: (from, to) => Promise.resolve(events.filter((e) => e.body.lane === 'w' && e.body.height >= from && e.body.height <= to)),
    })
    const pager = S.openHistory(r.pubB, { id: head.id, height: head.height }, sourceOf(wEvents), { pageSize: 8, certs })
    eq(pager.pageCount, 5, 'ceil(40/8) = 5 pages over the 40-event lane')
    let games = 0
    let allOk = true
    let ascending = true
    for (let i = 0; i < pager.pageCount; i++) {
      const p = await pager.page(i)
      if (!p.ok) { allOk = false; continue }
      games += p.games
      for (let j = 1; j < p.events.length; j++) if (p.events[j].body.height !== p.events[j - 1].body.height + 1) ascending = false
    }
    ok(allOk, 'every page of the intact history verifies against the pinned head')
    eq(games, 39, 'the pages carry all 39 games exactly once')
    ok(ascending, 'events ride ascending by height within each page')
    const p0 = await pager.page(0)
    ok(p0.ok && p0.to === head.height, 'page 0 is the newest page, ending at the pinned head')
    const pLast = await pager.page(4)
    ok(pLast.ok && pLast.from === 0 && pLast.events[0].body.type === 'genesis', 'the last page bottoms out at the genesis event')
    eq((await pager.page(5)).reason, 'out-of-range', 'a page beyond the count fails typed (out-of-range)')
    eq((await pager.page(-1)).reason, 'out-of-range', 'a negative page fails typed')

    // TAMPERED MID-CHAIN EVENT: height 17 substituted with an attacker-signed
    // variant — its id no longer matches what height 18's prev demands.
    const atk = kpOf('u3-attacker')
    const orig17 = wEvents.find((e) => e.body.height === 17)
    const forged17 = mint({ ...orig17.body, key: atk.pubB, ts: orig17.body.ts + 1 }, atk.priv)
    const tampered = wEvents.map((e) => (e.body.height === 17 ? forged17 : e))
    const tp = S.openHistory(r.pubB, { id: head.id, height: head.height }, sourceOf(tampered), { pageSize: 8, certs })
    ok((await tp.page(0)).ok && (await tp.page(1)).ok, 'pages ABOVE the tamper still verify (anchored from the countersigned head)')
    eq((await tp.page(2)).reason, 'broken-linkage', 'the page holding the substituted event fails typed — NO PAGE SUBSTITUTION, never wrong bytes')
    eq((await tp.page(4)).reason, 'broken-linkage', 'pages BELOW a break cannot be authenticated either (fail closed, not fail open)')
    // Same body, flipped signature: the id still matches, the signature dies.
    const sigFlip = wEvents.map((e) => (e.body.height === 17 ? { body: e.body, sig: flip(e.sig) } : e))
    const sp = S.openHistory(r.pubB, { id: head.id, height: head.height }, sourceOf(sigFlip), { pageSize: 8, certs })
    eq((await sp.page(2)).reason, 'bad-page', 'an id-preserving signature flip fails typed as bad-page')
    // Missing heights: honest unavailability.
    const gappy = wEvents.filter((e) => e.body.height < 8 || e.body.height > 15)
    const gp = S.openHistory(r.pubB, { id: head.id, height: head.height }, sourceOf(gappy), { pageSize: 8, certs })
    ok((await gp.page(0)).ok && (await gp.page(1)).ok, 'pages fully above a gap still verify')
    eq((await gp.page(3)).reason, 'unavailable', 'a page over missing heights reports temporary unavailability (heals when the data returns)')
    // Uncertified device key: certs withheld → bad-page (cert proof is load-bearing).
    const np = S.openHistory(r.pubB, { id: head.id, height: head.height }, sourceOf(wEvents), { pageSize: 8 })
    eq((await np.page(0)).reason, 'bad-page', 'device-signed history without the cert proof fails typed (no unproven keys)')
  }

  // ==========================================================================
  console.log('\n· U4. holder summaries — verified element-by-element …')
  // ==========================================================================
  {
    const r = kpOf('u4-root')
    const dev = kpOf('u4-dev')
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Four Subject', ts: NOW0, device: { pub: dev.pubB, index: 0 } })
    c = { root: c.root, events: [attOf(c.events[0], wits[0], NOW0 + 5), ...c.events.slice(1)] }
    for (let i = 1; i <= 21; i++)
      c = attachLast(A.appendWitnessed(c, dev.priv, dev.pubB, 'revoke', { pub: idLike('u4-' + i) }, NOW0 + i * 1000), wits[i % 8], NOW0 + i * 1000 + 5)
    const ck = A.makeCheckpointEvent(c, dev.priv, dev.pubB, NOW0 + 30_000)
    c = A.appendEvent(c, { body: ck.body, sig: ck.sig, wit: wits.slice(0, 4).map((w, i) => W.cosignCheckpoint(ck, c, w.pubB, w.priv, NOW0 + 30_005 + i)) })
    c = A.appendPersonal(c, dev.priv, dev.pubB, 'profile', { fields: { bio: 'first bio', country: 'NO' } }, NOW0 + 31_000)
    c = A.appendPersonal(c, dev.priv, dev.pubB, 'profile', { fields: { bio: 'final bio', flair: 'knight' } }, NOW0 + 32_000)

    const summary = S.buildHolderSummary(c)
    ok(summary.head !== undefined && summary.ckpt !== undefined && summary.profileEvents.length === 2 && summary.certs.length === 1,
      'buildHolderSummary carries head + newest ckpt + profile events + the cert proof')
    const v = S.verifyHolderSummary(summary, r.pubB)
    ok(v.ok && v.dropped.length === 0 && v.head !== undefined && v.ckpt !== undefined && v.profileEvents.length === 2,
      'a holder-built summary verifies whole (nothing dropped)')
    eq(canon(S.foldProfileLww(v.profileEvents)), canon({ bio: 'final bio', country: 'NO', flair: 'knight' }),
      'the fast-path LWW fold reproduces the last-write profile')
    eq(canon(S.foldProfileLww(v.profileEvents)), canon(A.verifyChain(c).profile),
      "…and matches the chain's own authoritative fold on this history")
    const vt = S.verifyHolderSummary({ ...summary, head: { body: summary.head.body, sig: flip(summary.head.sig) } }, r.pubB)
    ok(vt.ok && vt.head === undefined && vt.dropped.includes('head') && vt.ckpt !== undefined,
      'a tampered head is DROPPED and named; the independently-valid ckpt survives (elements verify on their own merits)')
    eq(S.verifyHolderSummary(summary, kpOf('u4-other').pubB).ok, false, 'a summary bound to a different subject is rejected whole')
    eq(S.verifyHolderSummary({ v: 1 }, r.pubB).ok, false, 'junk is rejected (zod at the boundary)')
    const atk = kpOf('u4-attacker')
    const forgedProfile = mint({ v: 1, lane: 'p', type: 'profile', root: r.pubB, key: atk.pubB, height: 0, ts: NOW0 + 99_000, payload: { fields: { bio: 'ATTACKER BIO' } } }, atk.priv)
    const vf = S.verifyHolderSummary({ ...summary, profileEvents: [...summary.profileEvents, forgedProfile] }, r.pubB)
    ok(vf.ok && vf.profileEvents.length === 2 && vf.dropped.includes('profile'),
      'an uncertified-key profile event is dropped from the fold (a stranger cannot write the subject profile)')
  }

  // ==========================================================================
  console.log('\n· U5. shard read — freshest reconstructible wins; stale never masquerades …')
  // ==========================================================================
  {
    const GEO = { k: 2, n: 4 }
    const r = kpOf('u5-root')
    let c1 = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Five Subject', ts: NOW0 })
    c1 = { root: c1.root, events: [attOf(c1.events[0], wits[0], NOW0 + 5)] }
    c1 = attachLast(A.appendWitnessed(c1, r.priv, r.pubB, 'revoke', { pub: idLike('u5-1') }, NOW0 + 1000), wits[1], NOW0 + 1005)
    const h1 = c1.events[c1.events.length - 1]
    const hdr1 = S.cutSnapshot(c1, h1, [], r.priv, GEO)
    const envs1 = S.shardJob(hdr1, A.chainToBytes(c1))
    let c2 = attachLast(A.appendWitnessed(c1, r.priv, r.pubB, 'revoke', { pub: idLike('u5-2') }, NOW0 + 2000), wits[2], NOW0 + 2005)
    const h2 = c2.events[c2.events.length - 1]
    const hdr2 = S.cutSnapshot(c2, h2, [], r.priv, GEO)
    const envs2 = S.shardJob(hdr2, A.chainToBytes(c2))
    const subjNid = W.nodeIdOf(r.pub)
    const keysOf = (n) => Array.from({ length: n }, (_, i) => S.shardKey(subjNid, i))
    const fakeNode = (byKey) => ({ get: async (target) => byKey.get(target) ?? null })

    // Fresh rows on 2 keys, STALE rows on all 4 — the stale group is LARGER.
    const mixed = new Map()
    const keys = keysOf(4)
    mixed.set(keys[0], envs2[0]); mixed.set(keys[1], envs2[1])
    mixed.set(keys[2], envs1[2]); mixed.set(keys[3], envs1[3])
    const res = await S.readChainFromShards(fakeNode(mixed), r.pubB, GEO)
    ok(res.chain !== undefined && shaB(A.chainToBytes(res.chain)) === shaB(A.chainToBytes(c2)),
      'the FRESHEST reconstructible snapshot wins even when stale rows are equally reachable')
    eq(res.report.height, 2, 'the report pins the reconstructed height')
    // Fresh group below k: honest fallback to the older verified snapshot, but
    // the freshest OBSERVED countersigned head is STILL surfaced.
    const starved = new Map()
    starved.set(keys[0], envs2[0])
    starved.set(keys[1], envs1[1]); starved.set(keys[2], envs1[2]); starved.set(keys[3], envs1[3])
    const res2 = await S.readChainFromShards(fakeNode(starved), r.pubB, GEO)
    ok(res2.chain !== undefined && shaB(A.chainToBytes(res2.chain)) === shaB(A.chainToBytes(c1)),
      'with the fresh group below k the older verified snapshot still serves (temporary staleness, not unavailability)')
    ok(res2.freshestHead !== undefined && res2.freshestHead.body.height === 2,
      'the newest OBSERVED countersigned head is surfaced alongside — stale can never silently masquerade as current')
    eq(S.selectHead([res2.freshestHead]).height, 2, '…and it pins as a verified head fact')
    // Below k everywhere: typed temporary unavailability, no bytes.
    const dead = new Map([[keys[0], envs2[0]]])
    const res3 = await S.readChainFromShards(fakeNode(dead), r.pubB, GEO)
    ok(res3.chain === undefined && res3.report.reason === 'below-k' && res3.report.liveRows === 1,
      'below K_rec live: an honest typed report, never bytes')
    const res4 = await S.readChainFromShards(fakeNode(new Map()), r.pubB, GEO)
    ok(res4.chain === undefined && res4.report.reason === 'no-rows', 'zero rows: typed no-rows report')
    // A poisoned envelope (foreign subject) contributes nothing.
    const foreign = new Map([[keys[0], (() => { const e = clone(envs2[0]); e.header.root = kpOf('u5-other').pubB; return e })()]])
    const res5 = await S.readChainFromShards(fakeNode(foreign), r.pubB, GEO)
    eq(res5.report.reason, 'no-rows', 'an envelope failing verification is ignored (fail closed)')
  }

  // ==========================================================================
  console.log('\n· U6. historyFromView — floor path serves DEVICE-signed history …')
  // ==========================================================================
  {
    // Defect I: on the floor path (no chain) the pager must get its device-key
    // certs from view.certs — otherwise EVERY page of a device-signed account
    // (the standard multi-device shape) fails closed as 'bad-page'.
    const r = kpOf('u6-root')
    const dev = kpOf('u6-dev')
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Six', ts: NOW0, device: { pub: dev.pubB, index: 0 } })
    c = { root: c.root, events: [attOf(c.events[0], wits[0], NOW0 + 5), ...c.events.slice(1)] }
    for (let g = 1; g <= 12; g++) {
      const game = idLike('u6-game-' + g)
      const transcript = SEG.transcriptDigest(game, [], '1-0', 'resign')
      const payload = SEG.makeSegmentPayload({
        game, opp: kpOf('u6-opp-' + g).pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
        heads: { w: { head: idLike('u6-hw-' + g), height: 0 }, b: { head: idLike('u6-hb-' + g), height: 0 } },
        wstream: SEG.signWitnessEnd(wits[0].priv, wits[0].pubB, game, '1-0', 0, transcript),
        oppProfile: { name: 'U6 Opp' },
      })
      c = attachLast(A.appendWitnessed(c, dev.priv, dev.pubB, 'segment', payload, NOW0 + g * 1000), wits[g % 8], NOW0 + g * 1000 + 5)
    }
    const wEvents = c.events.filter((e) => e.body.lane === 'w')
    const segEvents = wEvents.filter((e) => e.body.type === 'segment') // all device-signed
    const head = S.selectHead(wEvents)
    const certs = A.certsProving(r.pubB, c.events, [dev.pubB])
    ok(head.height === 12 && head.event.body.type === 'segment' && head.event.body.key === dev.pubB, 'sanity: the floor head is a device-signed segment')
    // Floor-shaped view (chain undefined): historyFromView reads view.certs.
    const floorView = (viewCerts) => ({
      root: r.pubB, status: 'floor', head: { id: head.id, height: head.height }, headEvent: head.event,
      profile: {}, segments: segEvents, certs: viewCerts, holdersRanked: [],
      shardReport: { liveRows: 0, needK: 12, totalRows: 40 }, sources: { pointers: 0, holders: 0, shardsUsed: 0, viaChain: false },
    })
    const p0 = await S.historyFromView(floorView(certs), { pageSize: 8 }).page(0)
    ok(p0.ok && p0.games === 8, 'floor historyFromView pages the device-signed segments WITH the collected certs (defect I: no false bad-page)')
    eq((await S.historyFromView(floorView([]), { pageSize: 8 }).page(0)).reason, 'bad-page', '…and without the certs it still fails closed — the cert proof is load-bearing')
  }

  // ==========================================================================
  console.log('\n· U7. foldProfileLww — a since-revoked key cannot render its write …')
  // ==========================================================================
  {
    // Defect J: the floor-path profile fold honors revocations exactly as
    // verifyChain does, so a leaked, since-revoked device key cannot render an
    // attacker's profile write on the advisory fast path.
    const r = kpOf('u7-root')
    const dev = kpOf('u7-dev')
    const pBody = (key, ts, bio) => ({ v: 1, lane: 'p', type: 'profile', root: r.pubB, key, height: 0, ts, payload: { fields: { bio } } })
    const honest = mint(pBody(dev.pubB, 100, 'honest bio'), dev.priv)
    const afterRevoke = mint(pBody(dev.pubB, 300, 'ATTACKER BIO'), dev.priv)
    eq(S.foldProfileLww([honest, afterRevoke]).bio, 'ATTACKER BIO', 'without revoke info the later LWW write wins (the leaked key still speaks)')
    const revokedAt = new Map([[dev.pubB, 200]]) // dev revoked at ts 200
    eq(S.foldProfileLww([honest, afterRevoke], revokedAt).bio, 'honest bio', 'a write AFTER the key was revoked is ignored (defect J: a revoked key is not owner authority)')
  }

  // ==========================================================================
  console.log('\n· U8. resolveProfile — a revoked device key is barred from head/segment/profile …')
  // ==========================================================================
  {
    // ROUND 2: the round-1 revocation fix (defect J) protected only the profile
    // FOLD leaf; head/segment/checkpoint selection ignored revocation. On the
    // owner-gone FLOOR path a leaked, SINCE-REVOKED device key (its cert is never
    // deleted) could forge the pinned head and inject a fake game. resolveProfile
    // must honor revocation on ALL witnessed-lane selection — matching verifyChain
    // — AND drive the profile-fold wiring end-to-end (not just the leaf helper).
    const r = kpOf('u8-root')
    const dev = kpOf('u8-dev')
    const w = wits[0]
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Eight', ts: NOW0, device: { pub: dev.pubB, index: 0 } })
    c = { root: c.root, events: [attOf(c.events[0], w, NOW0 + 5), ...c.events.slice(1)] }
    const seg1Payload = SEG.makeSegmentPayload({
      game: idLike('u8-g1'), opp: kpOf('u8-opp1').pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike('u8-hw1'), height: 0 }, b: { head: idLike('u8-hb1'), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, idLike('u8-g1'), '1-0', 0, SEG.transcriptDigest(idLike('u8-g1'), [], '1-0', 'resign')),
      oppProfile: { name: 'U8 Opp One' },
    })
    c = attachLast(A.appendWitnessed(c, dev.priv, dev.pubB, 'segment', seg1Payload, NOW0 + 1000), w, NOW0 + 1005)
    const honestSeg = c.events[c.events.length - 1] // height 1, device-signed, attested
    c = attachLast(A.appendWitnessed(c, r.priv, r.pubB, 'revoke', { pub: dev.pubB }, NOW0 + 2000), w, NOW0 + 2005)
    const revokeEv = c.events[c.events.length - 1] // height 2, ROOT-signed
    const certs = A.certsProving(r.pubB, c.events, [dev.pubB])

    // Attacker holds dev's leaked key: forges a witnessed segment at height 99999
    // signed by dev, self-attested with a THROWAWAY (non-eligible) witness key.
    const atkWit = kpOf('u8-atk-wit')
    const fgPayload = SEG.makeSegmentPayload({
      game: idLike('u8-forge'), opp: kpOf('u8-forge-opp').pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike('u8-fw'), height: 0 }, b: { head: idLike('u8-fb'), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, idLike('u8-forge'), '1-0', 0, SEG.transcriptDigest(idLike('u8-forge'), [], '1-0', 'resign')),
      oppProfile: { name: 'Forged Opp' },
    })
    const fgBody = { v: 1, lane: 'w', type: 'segment', root: r.pubB, key: dev.pubB, height: 99999, prev: A.eventId(revokeEv.body), ts: NOW0 + 9_000_000, payload: fgPayload }
    const forgedSeg = { ...mint(fgBody, dev.priv), wit: [W.makeAttestation(A.eventId(fgBody), 1, atkWit.pubB, atkWit.priv, NOW0 + 9_000_005)] }
    ok(S.verifyWitnessedOf(r.pubB, forgedSeg, certs), 'sanity: the forged revoked-key segment passes context-free verifyWitnessedOf (its still-valid cert proves the key)')

    // A holder summary carrying an honest PRE-revocation profile write AND a
    // revoked-key one (dev after revocation) — exercises the floor-fold wiring.
    const honestProf = mint({ v: 1, lane: 'p', type: 'profile', root: r.pubB, key: dev.pubB, height: 0, ts: NOW0 + 500, payload: { fields: { bio: 'honest bio' } } }, dev.priv)
    const atkProf = mint({ v: 1, lane: 'p', type: 'profile', root: r.pubB, key: dev.pubB, height: 1, prev: A.eventId(honestProf.body), ts: NOW0 + 9_000_000, payload: { fields: { bio: 'REVOKED-KEY BIO' } } }, dev.priv)
    const summary = { v: 1, root: r.pubB, head: honestSeg, profileEvents: [honestProf, atkProf], certs }

    // Floor path: serve ONLY the events row (no shards → the guaranteed floor).
    const subjNid = W.nodeIdOf(r.pub)
    const eventsRow = { v: 1, events: [c.events[0], honestSeg, revokeEv, forgedSeg], certs }
    const fakeNode = {
      get: async (target, kind) => (kind === 'events' && target === subjNid ? eventsRow : null),
      getMerged: async (target, kind) => (kind === 'events' && target === subjNid ? eventsRow : null),
    }
    const view = await S.resolveProfile(fakeNode, r.pubB, { summaries: [summary] })
    eq(view.status, 'floor', 'no shard chain → the guaranteed floor path (the owner-gone degraded case)')
    ok(view.head && view.head.height !== 99999, 'the revoked-key height-99999 forgery does NOT pin the head (head selection honors revocation)')
    eq(view.head.height, 2, '…the pinned head is the honest height-2 revoke event (the newest NON-revoked witnessed event)')
    ok(!view.segments.some((e) => A.eventId(e.body) === A.eventId(forgedSeg.body)), 'the revoked-key forged segment is ABSENT from view.segments (§0: a revoked key cannot inject a game)')
    // ROUND 3: a revoked key's pre-revocation floor segment is height-
    // indistinguishable from a forgery at the same height (an unlinked pool
    // event's claimed height is attacker-chosen), so the FLOOR conservatively
    // drops EVERY revoked-key pool event — NO-FORGE over serving unverifiable
    // bytes (§0). The genuine game is not lost: it rides the VERIFIED chain on
    // the expected path (asserted just below).
    ok(!view.segments.some((e) => A.eventId(e.body) === A.eventId(honestSeg.body)), 'the revoked-key PRE-revocation segment is conservatively dropped on the FLOOR (height-unverifiable; served via the chain instead)')
    eq(view.profile.bio, 'honest bio', 'the floor profile fold ignores the revoked-key write and keeps the pre-revocation one (defect J wiring, THROUGH resolveProfile)')

    // Expected path (shards present): the genuine pre-revocation segment rides
    // the VERIFIED chain — never lost, just not served off the unverifiable floor.
    const GEO8 = { k: 2, n: 4 }
    const hdr8 = S.cutSnapshot(c, revokeEv, certs, r.priv, GEO8)
    const envs8 = S.shardJob(hdr8, A.chainToBytes(c))
    const shardByKey8 = new Map(envs8.map((e, i) => [S.shardKey(subjNid, i), e]))
    const getE = async (t, kind) => (kind === 'shard' ? (shardByKey8.get(t) ?? null) : kind === 'events' && t === subjNid ? eventsRow : null)
    const viewExp = await S.resolveProfile({ get: getE, getMerged: getE }, r.pubB, { shard: GEO8, summaries: [summary] })
    eq(viewExp.status, 'expected', 'with shards the chain reconstructs (expected path)')
    ok(viewExp.segments.some((e) => A.eventId(e.body) === A.eventId(honestSeg.body)), '…and the genuine pre-revocation device segment IS served via the verified chain (never lost — only the floor drops it)')
    ok(!viewExp.segments.some((e) => A.eventId(e.body) === A.eventId(forgedSeg.body)), 'NO-FORGE (expected): the revoked-key forgery stays out of the chain-served segments')
  }

  // ==========================================================================
  console.log('\n· U9. resolveProfile — an unlinked pool revoke can suppress NOTHING …')
  // ==========================================================================
  {
    // ROUND 3: the round-2 fix built its revocation gate from EVERY pool
    // revoke — but pool events are only verifyWitnessedOf-checked (owner sig +
    // ANY attestation + cert-proven key, NOT chain-linked), so a revoke's very
    // presence and claimed body.height/ts are attacker-mintable with any
    // leaked certified key: certs are never deleted, and verifyAttestation has
    // no eligibility gate. BOTH invariants must hold at once: (A) NO-FORGE —
    // a long-revoked device key still cannot forge the head / inject a game /
    // set the name / write the profile (U8, re-pinned here on the EXPECTED
    // path too); (B) NO-SUPPRESS — an attacker-minted revoke NAMING THE
    // VICTIM'S ACTIVE DEVICE (height 0 / ts 0) must not drop honest verified
    // events, downgrade the verified head, or silence the profile, on EITHER
    // path. Only authoritative revokes gate: chain-linked ones (verifyChain
    // admitted them at their real height) and ROOT-signed ones (unforgeable).
    const r = kpOf('u9-root')
    const dOld = kpOf('u9-dev-old') // long-revoked device; its key leaked
    const dAct = kpOf('u9-dev-act') // the victim's ACTIVE device
    const w = wits[0]
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Nine', ts: NOW0, device: { pub: dOld.pubB, index: 0 } })
    c = { root: c.root, events: [attOf(c.events[0], w, NOW0 + 5), ...c.events.slice(1)] }
    c = A.appendPersonal(c, r.priv, r.pubB, 'cert', { pub: dAct.pubB, purpose: 0, index: 1 }, NOW0 + 10)
    c = attachLast(A.appendWitnessed(c, r.priv, r.pubB, 'revoke', { pub: dOld.pubB }, NOW0 + 1000), w, NOW0 + 1005) // h1: dOld revoked — ROOT-signed, IN the chain
    const segPayload = (tag) => SEG.makeSegmentPayload({
      game: idLike(tag), opp: kpOf(tag + '-opp').pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike(tag + '-hw'), height: 0 }, b: { head: idLike(tag + '-hb'), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, idLike(tag), '1-0', 0, SEG.transcriptDigest(idLike(tag), [], '1-0', 'resign')),
      oppProfile: { name: 'U9 Opp' },
    })
    for (let g = 1; g <= 5; g++)
      c = attachLast(A.appendWitnessed(c, dAct.priv, dAct.pubB, 'segment', segPayload('u9-g' + g), NOW0 + (g + 1) * 1000), w, NOW0 + (g + 1) * 1000 + 5)
    const head6 = c.events[c.events.length - 1]
    const vr9 = A.verifyChain(c)
    ok(vr9.ok && vr9.witnessedHeight === 6, 'fixture: the honest chain verifies to height 6 (genesis + revoke(dOld) + 5 dAct games)')
    const certs = A.certsProving(r.pubB, c.events, [dOld.pubB, dAct.pubB])
    const honestSegIds = c.events.filter((e) => e.body.type === 'segment').map((e) => A.eventId(e.body))

    // THE ATTACK — every piece signed with dOld's LEAKED long-revoked key and
    // self-attested by a throwaway witness key (height AND ts attacker-chosen):
    const atkWit = kpOf('u9-atk-wit')
    const forge = (body) => ({ ...mint(body, dOld.priv), wit: [W.makeAttestation(A.eventId(body), 1, atkWit.pubB, atkWit.priv, NOW0 + 9_000_005)] })
    // 1. THE PoC: a revoke naming the ACTIVE device, height 0 / ts 0.
    const forgedRevoke = forge({ v: 1, lane: 'w', type: 'revoke', root: r.pubB, key: dOld.pubB, height: 0, ts: 0, payload: { pub: dAct.pubB } })
    // 2. a non-linking forged game at height 99999 (the U8 shape).
    const forgedSeg = forge({ v: 1, lane: 'w', type: 'segment', root: r.pubB, key: dOld.pubB, height: 99999, prev: A.eventId(head6.body), ts: NOW0 + 9_000_000, payload: segPayload('u9-forge') })
    // 3. a LINKING forged game at height 7 (prev = the real head) — would
    //    structurally extend the reconstructed chain if revocation did not bar it.
    const forgedLink = forge({ v: 1, lane: 'w', type: 'segment', root: r.pubB, key: dOld.pubB, height: 7, prev: A.eventId(head6.body), ts: NOW0 + 9_000_001, payload: segPayload('u9-forge-link') })
    // 4. a device-signed "genesis" carrying an attacker display name.
    const forgedGenesis = forge({ v: 1, lane: 'w', type: 'genesis', root: r.pubB, key: dOld.pubB, height: 0, ts: 0, payload: { params: idLike('u9-fake-params'), name: 'EVIL NAME' } })
    ok(S.verifyWitnessedOf(r.pubB, forgedRevoke, certs), 'sanity: the forged revoke passes context-free verifyWitnessedOf (cert never deleted; throwaway attestation accepted)')

    // The events row an honest node ends up serving (publish-on-write union +
    // the attacker's published row). The REAL store gate accepts it — chain
    // linkage is invisible to acceptEvents; the viewer is the last line.
    const subjNid = W.nodeIdOf(r.pub)
    const wAll = c.events.filter((e) => e.body.lane === 'w')
    const eventsRow = { v: 1, events: [...wAll, forgedRevoke, forgedSeg, forgedLink, forgedGenesis], certs }
    // ROUND 3: the store gate now REFUSES structurally-impossible height-0
    // forgeries (a non-genesis or device-signed event at height 0 — the
    // forgedRevoke / forgedGenesis here), so a leaked key cannot flood the
    // display-name genesis slot. But the viewer must stay robust to a HOSTILE
    // getMerged that bypasses the gate, so the poisoned row is served DIRECTLY
    // below. The structurally-VALID high-height forgeries still pass the gate
    // (chain linkage is invisible to acceptEvents — the viewer is the last line).
    const u9validator = S.makeShardStoreValidator({ shardMb: 1 }).validator
    ok(!u9validator('u9-from', subjNid, 'events', eventsRow),
      'the store gate REFUSES the row carrying height-0 forgeries (non-genesis / device-genesis at height 0)')
    ok(u9validator('u9-from', subjNid, 'events', { v: 1, events: [...wAll, forgedSeg, forgedLink], certs }),
      'the gate ACCEPTS the structurally-valid high-height forgeries (linkage invisible to the gate — the viewer adjudicates)')

    // A summary carrying the ACTIVE device's honest profile write.
    const prof = mint({ v: 1, lane: 'p', type: 'profile', root: r.pubB, key: dAct.pubB, height: 0, ts: NOW0 + 3000, payload: { fields: { bio: 'honest active bio' } } }, dAct.priv)
    const summary = { v: 1, root: r.pubB, profileEvents: [prof], certs }

    // EXPECTED path: the full chain in shard space + the poisoned events row.
    const GEO = { k: 2, n: 4 }
    const hdr9 = S.cutSnapshot(c, head6, certs, dAct.priv, GEO)
    const envs9 = S.shardJob(hdr9, A.chainToBytes(c))
    const shardByKey = new Map(envs9.map((e, i) => [S.shardKey(subjNid, i), e]))
    const serve = (withShards) => {
      const get = async (t, kind) =>
        kind === 'shard' && withShards ? (shardByKey.get(t) ?? null) : kind === 'events' && t === subjNid ? eventsRow : null
      return { get, getMerged: get }
    }
    const viewE = await S.resolveProfile(serve(true), r.pubB, { shard: GEO, summaries: [summary] })
    eq(viewE.status, 'expected', 'the chain reconstructs (expected path) with the poisoned events row present')
    eq(viewE.head?.height, 6, 'NO-SUPPRESS (expected): the attacker-chosen height-0 revoke does NOT downgrade the verified head')
    eq(viewE.head?.id, A.eventId(head6.body), "…the pinned head is the chain's own countersigned head (never below chain.witnessedHead)")
    eq(viewE.segments.length, 5, 'NO-SUPPRESS (expected): all 5 honest verified games survive selection')
    eq(canon(viewE.segments.map((e) => A.eventId(e.body))), canon(honestSegIds), '…exactly the honest game set — nothing dropped, nothing injected')
    eq(A.verifyChain(viewE.chain).witnessedHeight, 6, 'NO-FORGE (expected): the LINKING height-7 forgery by the revoked key did not extend the chain')
    ok(!viewE.segments.some((e) => e.body.key === dOld.pubB), 'NO-FORGE (expected): no revoked-key game rides view.segments')
    eq(viewE.name, 'U-Nine', 'NO-FORGE (expected): the device-signed "genesis" cannot set the display name')
    eq(viewE.profile.bio, 'honest active bio', "the active device's profile write folds on the expected path")
    eq(viewE.revocationContested, undefined, 'ROUND 4: the expected path is never revocation-contested (a verified chain adjudicates every pool revoke)')

    // FLOOR path: the poisoned events row is ALL the viewer has.
    const viewF = await S.resolveProfile(serve(false), r.pubB, { summaries: [summary] })
    eq(viewF.status, 'floor', 'no shards → the guaranteed floor path')
    eq(viewF.head?.height, 6, 'NO-SUPPRESS (floor): the honest attested height-6 head still pins')
    eq(viewF.head?.id, A.eventId(head6.body), '…and it is the honest head event itself')
    eq(viewF.segments.length, 5, 'NO-SUPPRESS (floor): all 5 honest games still ride the floor')
    eq(canon(viewF.segments.map((e) => A.eventId(e.body))), canon(honestSegIds), '…exactly the honest game set on the floor too')
    ok(!viewF.segments.some((e) => e.body.key === dOld.pubB), 'NO-FORGE (floor): the revoked-key games (h7 AND h99999) stay out — the ROOT-signed revoke in the row is honored')
    eq(viewF.name, 'U-Nine', 'NO-FORGE (floor): the display name stays the root-signed genesis name')
    eq(viewF.profile.bio, 'honest active bio', "NO-SUPPRESS (floor): the forged revoke (attacker ts 0) cannot silence the active device's profile write")
    eq(viewF.revocationContested, undefined, 'ROUND 4 (shrink): the forged device revoke by the ROOT-refuted signer is IGNORED, so the floor view is NOT marked contested (no device-attested gate was honored)')
  }

  // ==========================================================================
  console.log('\n· U10. resolveProfile — stale-snapshot fork race / device-signed revoke / height≤rh …')
  // ==========================================================================
  {
    // ROUND 3 (second fix). Three residual vectors the first round-3 fix left
    // open — all pinned end-to-end through the REAL resolveProfile:
    //  (a) NO-SUPPRESS via a stale-snapshot FORK RACE: the reconstructed chain
    //      lags the honest tip (publish-on-write appends without re-sharding),
    //      so a forged device revoke ground to sort below the honest successor
    //      must NOT win the extension race and truncate the honest continuation.
    //  (b) NO-FORGE on the FLOOR path when the leaked key was revoked by a
    //      DEVICE-signed revoke (the cold-root flow), not only a root-signed one.
    //  (c) NO-FORGE: a revoked key must not inject a segment at a claimed height
    //      ≤ its revocation height (an unlinked pool event's height is forgeable).
    const w = wits[0]
    const seg = (tag) => SEG.makeSegmentPayload({
      game: idLike(tag), opp: kpOf(tag + '-opp').pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike(tag + '-hw'), height: 0 }, b: { head: idLike(tag + '-hb'), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, idLike(tag), '1-0', 0, SEG.transcriptDigest(idLike(tag), [], '1-0', 'resign')),
      oppProfile: { name: 'U10 Opp' },
    })
    const forgeBy = (priv, atkWit, body) => ({ ...mint(body, priv), wit: [W.makeAttestation(A.eventId(body), 1, atkWit.pubB, atkWit.priv, NOW0)] })
    const wLane = (c) => c.events.filter((e) => e.body.lane === 'w')

    // ---- (a) STALE-SNAPSHOT FORK RACE (NO-SUPPRESS, expected path) ----------
    {
      const r = kpOf('u10a-root')
      const dOld = kpOf('u10a-old') // leaked key, still ACTIVE — the hardest case (no revoke to gate it)
      const dAct = kpOf('u10a-act')
      const atkWit = kpOf('u10a-atk-wit')
      let snap = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U10a', ts: NOW0, device: { pub: dOld.pubB, index: 0 } })
      snap = { root: snap.root, events: [attOf(snap.events[0], w, NOW0 + 5), ...snap.events.slice(1)] }
      snap = A.appendPersonal(snap, r.priv, r.pubB, 'cert', { pub: dAct.pubB, purpose: 0, index: 1 }, NOW0 + 10)
      const genesisEv = snap.events[0]
      let full = snap
      for (let g = 1; g <= 5; g++)
        full = attachLast(A.appendWitnessed(full, dAct.priv, dAct.pubB, 'segment', seg('u10a-g' + g), NOW0 + g * 1000), w, NOW0 + g * 1000 + 5)
      eq(A.verifyChain(full).witnessedHeight, 5, '(a) fixture: honest tip is height 5')
      const certs = A.certsProving(r.pubB, full.events, [dOld.pubB, dAct.pubB])
      const honestSegIds = full.events.filter((e) => e.body.type === 'segment').map((e) => A.eventId(e.body))
      const honestH1Id = A.eventId(full.events.find((e) => e.body.lane === 'w' && e.body.height === 1).body)
      let forgedRevoke = null
      for (let ts = 0; ts < 200000 && !forgedRevoke; ts++) {
        const body = { v: 1, lane: 'w', type: 'revoke', root: r.pubB, key: dOld.pubB, height: 1, prev: A.eventId(genesisEv.body), ts, payload: { pub: dAct.pubB } }
        if (A.eventId(body) < honestH1Id) forgedRevoke = forgeBy(dOld.priv, atkWit, body)
      }
      ok(forgedRevoke && A.eventId(forgedRevoke.body) < honestH1Id, '(a) fixture: forged revoke id sorts BELOW the honest h1 (would win a naive id race)')
      const subjNid = W.nodeIdOf(r.pub)
      const eventsRow = { v: 1, events: [...wLane(full), forgedRevoke], certs }
      const GEO = { k: 2, n: 4 }
      const hdr = S.cutSnapshot(snap, genesisEv, certs, r.priv, GEO) // shard the STALE height-0 snapshot
      const envs = S.shardJob(hdr, A.chainToBytes(snap))
      const shardByKey = new Map(envs.map((e, i) => [S.shardKey(subjNid, i), e]))
      const get = async (t, kind) => (kind === 'shard' ? (shardByKey.get(t) ?? null) : kind === 'events' && t === subjNid ? eventsRow : null)
      const view = await S.resolveProfile({ get, getMerged: get }, r.pubB, { shard: GEO })
      eq(view.status, 'expected', '(a) the stale snapshot reconstructs (expected path)')
      eq(view.head?.height, 5, '(a) NO-SUPPRESS: the fork-race revoke does NOT downgrade the head below the honest tip 5')
      eq(view.segments.length, 5, '(a) NO-SUPPRESS: all 5 honest games survive (the forged revoke did not truncate the continuation)')
      eq(canon(view.segments.map((e) => A.eventId(e.body))), canon(honestSegIds), '(a) …exactly the honest game set — nothing suppressed')
    }

    // ---- (b) DEVICE-SIGNED REVOKE of a leaked key, FLOOR NO-FORGE -----------
    {
      const r = kpOf('u10b-root')
      const dOld = kpOf('u10b-old')
      const dAct = kpOf('u10b-act')
      const atkWit = kpOf('u10b-atk-wit')
      let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U10b', ts: NOW0, device: { pub: dOld.pubB, index: 0 } })
      c = { root: c.root, events: [attOf(c.events[0], w, NOW0 + 5), ...c.events.slice(1)] }
      c = A.appendPersonal(c, r.priv, r.pubB, 'cert', { pub: dAct.pubB, purpose: 0, index: 1 }, NOW0 + 10)
      c = attachLast(A.appendWitnessed(c, dOld.priv, dOld.pubB, 'segment', seg('u10b-g1'), NOW0 + 1000), w, NOW0 + 1005)
      c = attachLast(A.appendWitnessed(c, dAct.priv, dAct.pubB, 'revoke', { pub: dOld.pubB }, NOW0 + 2000), w, NOW0 + 2005) // DEVICE-signed revoke of dOld
      const revokeEv = c.events[c.events.length - 1]
      ok(revokeEv.body.key === dAct.pubB && revokeEv.body.key !== r.pubB, '(b) fixture: the revoke of dOld is DEVICE-signed (active device), NOT root-signed')
      for (let g = 1; g <= 2; g++)
        c = attachLast(A.appendWitnessed(c, dAct.priv, dAct.pubB, 'segment', seg('u10b-a' + g), NOW0 + (2 + g) * 1000), w, NOW0 + (2 + g) * 1000 + 5)
      const head4 = c.events[c.events.length - 1]
      eq(A.verifyChain(c).witnessedHeight, 4, '(b) fixture: honest head height 4')
      const certs = A.certsProving(r.pubB, c.events, [dOld.pubB, dAct.pubB])
      const forgedSeg = forgeBy(dOld.priv, atkWit, { v: 1, lane: 'w', type: 'segment', root: r.pubB, key: dOld.pubB, height: 99999, prev: A.eventId(head4.body), ts: NOW0 + 9_000_000, payload: seg('u10b-forge') })
      const subjNid = W.nodeIdOf(r.pub)
      const eventsRow = { v: 1, events: [...wLane(c), forgedSeg], certs }
      const get = async (t, kind) => (kind === 'events' && t === subjNid ? eventsRow : null)
      const view = await S.resolveProfile({ get, getMerged: get }, r.pubB, {})
      eq(view.status, 'floor', '(b) floor path (no shards)')
      eq(view.head?.height, 4, '(b) NO-FORGE (floor): a leaked key revoked by a DEVICE-signed revoke does NOT forge the head (honest head 4)')
      ok(!view.segments.some((e) => A.eventId(e.body) === A.eventId(forgedSeg.body)), '(b) NO-FORGE (floor): the revoked-key forgery is barred from segments')
      eq(view.revocationContested, true, '(b) ROUND 4 (C-12 honesty): the floor HONORED a device-signed revoke it cannot chain-verify — the view says so (revocationContested), never silently')
    }

    // ---- (c) REVOKED-KEY SEGMENT AT height ≤ rh (NO-FORGE, both paths) ------
    {
      const r = kpOf('u10c-root')
      const dOld = kpOf('u10c-old')
      const dAct = kpOf('u10c-act')
      const atkWit = kpOf('u10c-atk-wit')
      let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U10c', ts: NOW0, device: { pub: dOld.pubB, index: 0 } })
      c = { root: c.root, events: [attOf(c.events[0], w, NOW0 + 5), ...c.events.slice(1)] }
      c = A.appendPersonal(c, r.priv, r.pubB, 'cert', { pub: dAct.pubB, purpose: 0, index: 1 }, NOW0 + 10)
      c = attachLast(A.appendWitnessed(c, r.priv, r.pubB, 'revoke', { pub: dOld.pubB }, NOW0 + 1000), w, NOW0 + 1005) // h1: revoke(dOld) ROOT-signed ⇒ rh=1
      for (let g = 1; g <= 4; g++)
        c = attachLast(A.appendWitnessed(c, dAct.priv, dAct.pubB, 'segment', seg('u10c-g' + g), NOW0 + (g + 1) * 1000), w, NOW0 + (g + 1) * 1000 + 5)
      const head5 = c.events[c.events.length - 1]
      const certs = A.certsProving(r.pubB, c.events, [dOld.pubB, dAct.pubB])
      const lowBody = { v: 1, lane: 'w', type: 'segment', root: r.pubB, key: dOld.pubB, height: 1, prev: idLike('u10c-any'), ts: NOW0 + 9_000_000, payload: seg('u10c-LOW') }
      const forgedLow = forgeBy(dOld.priv, atkWit, lowBody) // height 1 == rh (≤ rh)
      ok(S.verifyWitnessedOf(r.pubB, forgedLow, certs), '(c) fixture: the height-1 (≤ rh) forgery passes context-free verifyWitnessedOf')
      const subjNid = W.nodeIdOf(r.pub)
      const eventsRow = { v: 1, events: [...wLane(c), forgedLow], certs }
      const GEO = { k: 2, n: 4 }
      const hdr = S.cutSnapshot(c, head5, certs, dAct.priv, GEO)
      const envs = S.shardJob(hdr, A.chainToBytes(c))
      const shardByKey = new Map(envs.map((e, i) => [S.shardKey(subjNid, i), e]))
      const serve = (withShards) => {
        const get = async (t, kind) => (kind === 'shard' && withShards ? (shardByKey.get(t) ?? null) : kind === 'events' && t === subjNid ? eventsRow : null)
        return { get, getMerged: get }
      }
      const viewE = await S.resolveProfile(serve(true), r.pubB, { shard: GEO })
      eq(viewE.status, 'expected', '(c) expected path reconstructs')
      eq(viewE.segments.length, 4, '(c) exactly the 4 honest games')
      ok(!viewE.segments.some((e) => A.eventId(e.body) === A.eventId(forgedLow.body)), '(c) NO-FORGE (expected): the revoked-key height-1 (≤ rh) forgery is NOT injected into view.segments')
      const viewF = await S.resolveProfile(serve(false), r.pubB, {})
      ok(!viewF.segments.some((e) => A.eventId(e.body) === A.eventId(forgedLow.body)), '(c) NO-FORGE (floor): the height-1 (≤ rh) forgery stays out on the floor too')
    }
  }

  // ==========================================================================
  console.log('\n· U11. resolveProfile — the C-12 floor: shrink, gate-both, surface …')
  // ==========================================================================
  {
    // ROUND 4 (final hardening). The floor's device-revocation tension is
    // IRREDUCIBLE (accepted compromise C-12, spec §12): device-to-device
    // revocation is a model feature (certs.ts makeRevokeEvent; verifyChain
    // admits a device-signed revoke at its linked height), so the floor must
    // honor device-signed pool revokes or a device-revoked leaked key could
    // forge freely — yet the same evidence is mintable BY a leaked key against
    // the honest device. Resolution under §0 (paramount): fail toward
    // NO-FORGERY, shrink the collateral, and SURFACE the residual as
    // revocationContested — never silent. Pinned end-to-end here:
    //  (a) the residual PoC: a LONE forged device revoke (its signer's own
    //      revocation not visible on this floor) suppresses the active device
    //      — accepted C-12 residual — but the view MUST carry the honest
    //      signal, and the claim-only revoke must NOT itself pin the head;
    //  (b) MUTUAL/CONTESTED revokes gate BOTH keys: the forged half can never
    //      render (gate-neither would re-admit the leaked key — the round-3
    //      NO-FORGE hole), the honest half's suppression is flagged;
    //  (c) the SAME attack on the EXPECTED path: the verified chain
    //      adjudicates — nothing suppressed, nothing forged, no flag.
    const w = wits[0]
    const seg = (tag) => SEG.makeSegmentPayload({
      game: idLike(tag), opp: kpOf(tag + '-opp').pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike(tag + '-hw'), height: 0 }, b: { head: idLike(tag + '-hb'), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, idLike(tag), '1-0', 0, SEG.transcriptDigest(idLike(tag), [], '1-0', 'resign')),
      oppProfile: { name: 'U11 Opp' },
    })
    const forgeBy = (priv, atkWit, body) => ({ ...mint(body, priv), wit: [W.makeAttestation(A.eventId(body), 1, atkWit.pubB, atkWit.priv, NOW0)] })
    const wLane = (c) => c.events.filter((e) => e.body.lane === 'w')
    const mkAccount = (tag) => {
      const r = kpOf(tag + '-root'); const dOld = kpOf(tag + '-old'); const dAct = kpOf(tag + '-act'); const atkWit = kpOf(tag + '-atk-wit')
      let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Eleven', ts: NOW0, device: { pub: dOld.pubB, index: 0 } })
      c = { root: c.root, events: [attOf(c.events[0], w, NOW0 + 5), ...c.events.slice(1)] }
      c = A.appendPersonal(c, r.priv, r.pubB, 'cert', { pub: dAct.pubB, purpose: 0, index: 1 }, NOW0 + 10)
      return { r, dOld, dAct, atkWit, c }
    }

    // ---- (a) the C-12 residual PoC: lone forged revoke, honestly surfaced ---
    {
      const { r, dOld, dAct, atkWit, c: c0 } = mkAccount('u11a')
      let c = c0
      for (let g = 1; g <= 3; g++)
        c = attachLast(A.appendWitnessed(c, dAct.priv, dAct.pubB, 'segment', seg('u11a-g' + g), NOW0 + g * 1000), w, NOW0 + g * 1000 + 5)
      const certs = A.certsProving(r.pubB, c.events, [dOld.pubB, dAct.pubB])
      // dOld is long-revoked IN REALITY — but that revocation is NOT visible in
      // this pool (sparse floor: the attacker curates what survivors serve), so
      // dOld is evidence-wise indistinguishable from a still-active device
      // performing the legitimate cold-root flow. THAT is the irreducible core.
      const forgedRevoke = forgeBy(dOld.priv, atkWit, { v: 1, lane: 'w', type: 'revoke', root: r.pubB, key: dOld.pubB, height: 500, ts: 0, payload: { pub: dAct.pubB } })
      const subjNid = W.nodeIdOf(r.pub)
      const eventsRow = { v: 1, events: [...wLane(c), forgedRevoke], certs }
      const get = async (t, kind) => (kind === 'events' && t === subjNid ? eventsRow : null)
      const view = await S.resolveProfile({ get, getMerged: get }, r.pubB, {})
      eq(view.status, 'floor', '(a) floor path (no shards)')
      eq(view.revocationContested, true, '(a) C-12 SURFACED: the unverifiable device revoke was honored — the view says revocationContested, NEVER silently complete')
      eq(view.segments.length, 0, "(a) the accepted residual: the active device's games are transiently withheld (fail toward no-forgery; heals when a chain reconstructs)")
      eq(view.head?.height, 0, '(a) the claim-only revoke (height 500) does NOT pin the head — the head falls back to the newest ROOT-signed attested event (the genesis): revocation evidence is gate-only, never content')
      eq(view.name, 'U-Eleven', '(a) the display name (root-signed genesis) is untouched')
    }

    // ---- (b) MUTUAL/CONTESTED: gate BOTH — the forged half cannot render ----
    {
      const { r, dOld, dAct, atkWit, c: c0 } = mkAccount('u11b')
      let c = c0
      c = attachLast(A.appendWitnessed(c, dAct.priv, dAct.pubB, 'revoke', { pub: dOld.pubB }, NOW0 + 1000), w, NOW0 + 1005) // h1: dAct's LEGIT device-signed revoke of dOld (cold-root flow)
      for (let g = 1; g <= 2; g++)
        c = attachLast(A.appendWitnessed(c, dAct.priv, dAct.pubB, 'segment', seg('u11b-g' + g), NOW0 + (g + 1) * 1000), w, NOW0 + (g + 1) * 1000 + 5)
      const head3 = c.events[c.events.length - 1]
      eq(A.verifyChain(c).witnessedHeight, 3, '(b) fixture: honest head height 3 (genesis + device revoke + 2 games)')
      const certs = A.certsProving(r.pubB, c.events, [dOld.pubB, dAct.pubB])
      const honestSegIds = c.events.filter((e) => e.body.type === 'segment').map((e) => A.eventId(e.body))
      // dOld (leaked, DEVICE-revoked — no root-signed revoke of it exists)
      // counter-attacks with a forged revoke of dAct AND a forged game:
      const forgedRevoke = forgeBy(dOld.priv, atkWit, { v: 1, lane: 'w', type: 'revoke', root: r.pubB, key: dOld.pubB, height: 500, ts: 0, payload: { pub: dAct.pubB } })
      const forgedSeg = forgeBy(dOld.priv, atkWit, { v: 1, lane: 'w', type: 'segment', root: r.pubB, key: dOld.pubB, height: 99999, prev: A.eventId(head3.body), ts: NOW0 + 9_000_000, payload: seg('u11b-forge') })
      const subjNid = W.nodeIdOf(r.pub)
      const eventsRow = { v: 1, events: [...wLane(c), forgedRevoke, forgedSeg], certs }
      const GEO = { k: 2, n: 4 }
      const hdr = S.cutSnapshot(c, head3, certs, dAct.priv, GEO)
      const envs = S.shardJob(hdr, A.chainToBytes(c))
      const shardByKey = new Map(envs.map((e, i) => [S.shardKey(subjNid, i), e]))
      const serve = (withShards) => {
        const get = async (t, kind) => (kind === 'shard' && withShards ? (shardByKey.get(t) ?? null) : kind === 'events' && t === subjNid ? eventsRow : null)
        return { get, getMerged: get }
      }
      const viewF = await S.resolveProfile(serve(false), r.pubB, {})
      eq(viewF.status, 'floor', '(b) floor path')
      ok(!viewF.segments.some((e) => A.eventId(e.body) === A.eventId(forgedSeg.body)), "(b) NO-FORGE (floor, CONTESTED): the leaked key's forged game does NOT render — mutual revokes gate BOTH keys (gate-neither would re-admit the forger: the round-3 hole)")
      ok(viewF.head?.height !== 99999, '(b) NO-FORGE (floor, CONTESTED): the forged height-99999 event does NOT pin the head')
      eq(viewF.head?.height, 0, '(b) …the head falls back to the newest ROOT-signed attested event (the genesis) — neither contested device pins it')
      eq(viewF.revocationContested, true, "(b) the contested gating is SURFACED (revocationContested) — the honest half's suppression is the flagged C-12 residual, not silence")
      eq(viewF.segments.length, 0, '(b) …and the honest games are withheld pending chain (the residual the flag names), never rendered alongside a forgery')
      eq(viewF.name, 'U-Eleven', '(b) the display name stays the root-signed genesis name')

      // ---- (c) the SAME attack with the chain present: adjudicated, no flag -
      const viewE = await S.resolveProfile(serve(true), r.pubB, { shard: GEO })
      eq(viewE.status, 'expected', '(c) the chain reconstructs (expected path)')
      eq(viewE.head?.height, 3, '(c) NO-SUPPRESS (expected): the mutual-revoke attack cannot downgrade the verified head (view.head >= chain.witnessedHead)')
      eq(canon(viewE.segments.map((e) => A.eventId(e.body))), canon(honestSegIds), '(c) NO-SUPPRESS (expected): exactly the honest game set — the pool revoke pair dropped nothing')
      ok(!viewE.segments.some((e) => A.eventId(e.body) === A.eventId(forgedSeg.body)), '(c) NO-FORGE (expected): the chain-revoked leaked key still cannot inject a game')
      eq(viewE.revocationContested, undefined, '(c) the expected path carries NO contested flag — the chain adjudicated the revocation at its real linked height')
    }
  }

  // ==========================================================================
  console.log('\n· U12. resolveProfile — a NON-LINKING pool event contributes NO expected-path content …')
  // ==========================================================================
  {
    // ROUND 5 (final). The corrected threat model rounds 1-4 under-scoped:
    // the attacker holds a CERTIFIED, NON-REVOKED device key of the victim
    // (leaked but not yet revoked — cert-proven, so verifyWitnessedOf passes;
    // NOT filtered by notRevoked; untouched by the floor shrink rules). The
    // weapon is a bare NON-LINKING witnessed event at an arbitrary claimed
    // height with a bogus prev and a throwaway self-attestation. On the
    // EXPECTED path (a verified chain reconstructed) such an event must NEVER
    // contribute content (head/segment/checkpoint/name/profile) or outrank
    // the verified chain: pre-fix, headCands and the segment source mixed raw
    // poolAdmitted into chain-derived content — view.head forged to 99999 (an
    // A4 pinned input) and a fabricated game injected. Post-fix: with a chain
    // present, pool events contribute content ONLY from a REAL LINKED
    // position (grounded at the verified chain over hash links with h+1
    // steps — the round-3 fork-stopped honest continuation keeps serving,
    // U10a); the unambiguous continuation is absorbed by extendChainFromPool
    // — which is exactly how a REAL linking publish-on-write segment still
    // appears ((c) below: the fix is not over-broad).
    const r = kpOf('u12-root')
    const dLeak = kpOf('u12-dev') // certified at genesis; NEVER revoked; key leaked
    const atkWit = kpOf('u12-atk-wit')
    const w = wits[0]
    const seg = (tag) => SEG.makeSegmentPayload({
      game: idLike(tag), opp: kpOf(tag + '-opp').pubB, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike(tag + '-hw'), height: 0 }, b: { head: idLike(tag + '-hb'), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, idLike(tag), '1-0', 0, SEG.transcriptDigest(idLike(tag), [], '1-0', 'resign')),
      oppProfile: { name: 'U12 Opp' },
    })
    let c = A.createAccountChain({ rootPriv: r.priv, rootPub: r.pub, displayName: 'U-Twelve', ts: NOW0, device: { pub: dLeak.pubB, index: 0 } })
    c = { root: c.root, events: [attOf(c.events[0], w, NOW0 + 5), ...c.events.slice(1)] }
    for (let g = 1; g <= 3; g++)
      c = attachLast(A.appendWitnessed(c, dLeak.priv, dLeak.pubB, 'segment', seg('u12-g' + g), NOW0 + g * 1000), w, NOW0 + g * 1000 + 5)
    const ck = A.makeCheckpointEvent(c, dLeak.priv, dLeak.pubB, NOW0 + 4000)
    c = A.appendEvent(c, { body: ck.body, sig: ck.sig, wit: wits.slice(0, 5).map((cw, i) => W.cosignCheckpoint(ck, c, cw.pubB, cw.priv, NOW0 + 4005 + i)) })
    c = A.appendPersonal(c, dLeak.priv, dLeak.pubB, 'profile', { fields: { bio: 'u12 honest bio' } }, NOW0 + 5000)
    const wAll = c.events.filter((e) => e.body.lane === 'w')
    const realHead = wAll[wAll.length - 1] // the 5-cosigned ckpt, height 4
    ok(A.verifyChain(c).ok && realHead.body.height === 4 && realHead.body.type === 'ckpt', 'fixture: the honest chain verifies — its head is the cosigned height-4 checkpoint')
    const certs = A.certsProving(r.pubB, c.events, [dLeak.pubB])
    const honestSegIds = c.events.filter((e) => e.body.type === 'segment').map((e) => A.eventId(e.body))

    // THE FORGERIES — every piece signed by dLeak (certified, NON-revoked)
    // at an attacker-chosen height with a bogus prev, self-attested:
    const forge = (body) => ({ ...mint(body, dLeak.priv), wit: [W.makeAttestation(A.eventId(body), 1, atkWit.pubB, atkWit.priv, NOW0 + 9_000_005)] })
    const forgedSeg = forge({ v: 1, lane: 'w', type: 'segment', root: r.pubB, key: dLeak.pubB, height: 99999, prev: idLike('u12-bogus-prev'), ts: NOW0 + 9_000_000, payload: seg('u12-FORGE') })
    const junkState = { n: 1, byType: { forged: 1 }, head: idLike('u12-fake-head'), height: 99997 }
    const forgedCkpt = forge({ v: 1, lane: 'w', type: 'ckpt', root: r.pubB, key: dLeak.pubB, height: 99998, prev: idLike('u12-bogus-prev2'), ts: NOW0 + 9_000_001, payload: { prevCkpt: idLike('u12-bogus-ckpt'), through: 99997, state: junkState, stateDigest: canon(junkState) } })
    const forgedName = forge({ v: 1, lane: 'w', type: 'genesis', root: r.pubB, key: dLeak.pubB, height: 0, ts: 0, payload: { params: idLike('u12-fake-params'), name: 'EVIL U12' } })
    ok(S.verifyWitnessedOf(r.pubB, forgedSeg, certs), 'sanity: the NON-revoked leaked-key forgery passes context-free verifyWitnessedOf (cert-proven key + throwaway attestation — NO linkage check exists there)')
    const summary = { v: 1, root: r.pubB, head: forgedSeg, profileEvents: [], certs }
    ok(S.verifyHolderSummary(summary, r.pubB).head !== undefined, 'sanity: the same forgery rides a VERIFYING holder summary head (both ingress routes feed one pool)')
    const subjNid = W.nodeIdOf(r.pub)
    ok(S.makeShardStoreValidator({ shardMb: 1 }).validator('u12-from', subjNid, 'events', { v: 1, events: [...wAll, forgedSeg, forgedCkpt], certs }),
      'the store gate ACCEPTS the structurally-valid non-linking forgeries (linkage is invisible to acceptEvents — the viewer is the LAST line)')

    // Serve: the full honest chain in shard space + the hostile events row
    // (delivered via a gate-bypassing getMerged, like U9).
    const eventsRow = { v: 1, events: [...wAll, forgedSeg, forgedCkpt, forgedName], certs }
    const GEO = { k: 2, n: 4 }
    const hdr = S.cutSnapshot(c, realHead, certs, dLeak.priv, GEO)
    const envs = S.shardJob(hdr, A.chainToBytes(c))
    const shardByKey = new Map(envs.map((e, i) => [S.shardKey(subjNid, i), e]))
    const serve = (row, withShards = true) => {
      const get = async (t, kind) => (kind === 'shard' && withShards ? (shardByKey.get(t) ?? null) : kind === 'events' && t === subjNid ? row : null)
      return { get, getMerged: get }
    }

    const view = await S.resolveProfile(serve(eventsRow), r.pubB, { shard: GEO, summaries: [summary] })
    eq(view.status, 'expected', 'the chain reconstructs (expected path) with the hostile row + summary present')
    eq(view.head?.height, 4, 'FIX (a): the height-99999 non-linking forgery does NOT pin the head — view.head is the REAL verified chain head')
    eq(view.head?.id, A.eventId(realHead.body), '…pinned to the real countersigned head id')
    eq(canon(view.headEvent), canon(realHead), '…and headEvent IS the real head event (the A4 pinned input is uncorrupted)')
    ok(!view.segments.some((e) => A.eventId(e.body) === A.eventId(forgedSeg.body)), 'FIX (b): the fabricated game is ABSENT from view.segments (a non-linking pool event contributes NO content when a chain is present)')
    eq(canon(view.segments.map((e) => A.eventId(e.body))), canon(honestSegIds), '…exactly the honest game set — nothing injected, nothing dropped')
    eq(view.ckpt?.id, A.eventId(ck.body), 'FIX (d): the checkpoint surface stays the real cosigned checkpoint (the working set was already chain-only — re-pinned against this class)')
    eq(view.name, 'U-Twelve', 'FIX (d): the display name stays the root-signed genesis name')
    eq(view.profile.bio, 'u12 honest bio', "FIX (d): the profile stays the chain's own fold — untouched by the forgeries")
    eq(A.verifyChain(view.chain).witnessedHeight, 4, 'the served chain itself is untouched (nothing non-linking was appended)')

    // (c) NOT OVER-BROAD: a REAL publish-on-write continuation by the SAME
    // device must still appear — extendChainFromPool absorbs it into
    // chain.events, so it rides the CHAIN, never raw poolAdmitted.
    const cLink = attachLast(A.appendWitnessed(c, dLeak.priv, dLeak.pubB, 'segment', seg('u12-link'), NOW0 + 6000), w, NOW0 + 6005)
    const linkSeg = cLink.events[cLink.events.length - 1] // height 5, prev = the real head id — a genuine continuation
    const view2 = await S.resolveProfile(serve({ v: 1, events: [...wAll, linkSeg, forgedSeg, forgedCkpt, forgedName], certs }), r.pubB, { shard: GEO, summaries: [summary] })
    eq(view2.status, 'expected', '(c) expected path again (same sharded snapshot, now-newer events row)')
    ok(view2.segments.some((e) => A.eventId(e.body) === A.eventId(linkSeg.body)), '(c) NOT OVER-BROAD: the genuinely-LINKING height-5 pool segment by the SAME device STILL appears (absorbed by extendChainFromPool — it rides the chain)')
    eq(view2.head?.height, 5, '(c) …and the head advances to the real linked continuation (5) — never to a claimed 99999')
    eq(A.verifyChain(view2.chain).witnessedHeight, 5, '(c) the extension rode the verified chain and the whole still verifies')
    ok(!view2.segments.some((e) => A.eventId(e.body) === A.eventId(forgedSeg.body)), '(c) the non-linking forgery STAYS out even alongside the real continuation')

    // FLOOR framing (unchanged round-4 / C-12 semantics — documented, not
    // desired): with NO chain to check linkage against and NO revocation to
    // honor, verifyWitnessedOf IS the floor's whole admission rule, so the
    // same forgery still pins the pure floor head. THAT residual is exactly
    // what the expected path now closes; it heals when any chain reconstructs.
    const viewF = await S.resolveProfile(serve(eventsRow, false), r.pubB, { summaries: [summary] })
    eq(viewF.status, 'floor', 'floor framing (no shards)')
    eq(viewF.head?.height, 99999, 'FLOOR UNCHANGED (C-12 territory): the certified NON-revoked key’s claimed height still pins the pure floor head — round-4 semantics preserved; the fix touches ONLY the expected path')
    eq(viewF.name, 'U-Twelve', 'FLOOR: the device-signed "genesis" still cannot set the display name (root-signed only)')
  }

  // ==========================================================================
  console.log('\n· P. THE A3 PROOF — 1,000 games, 300 opponents, owner gone forever …')
  // ==========================================================================
  const tBuild = Date.now()
  const subj = kpOf('rc-subject-root')
  const subDev = kpOf('rc-subject-dev')
  const opps = Array.from({ length: 300 }, (_, i) => kpOf('rc-opp-' + i))

  let chain = A.createAccountChain({
    rootPriv: subj.priv, rootPub: subj.pub, displayName: 'Reconstruct Subject', ts: NOW0,
    device: { pub: subDev.pubB, index: 0 },
  })
  chain = { root: chain.root, events: [attOf(chain.events[0], wits[0], NOW0 + 5), ...chain.events.slice(1)] }
  chain = A.appendPersonal(chain, subDev.priv, subDev.pubB, 'profile', { fields: { bio: 'first bio', country: 'NO' } }, NOW0 + 100)
  chain = A.appendPersonal(chain, subDev.priv, subDev.pubB, 'profile', { fields: { bio: 'They reconstructed me from shards.', flair: 'phoenix' } }, NOW0 + 200)

  let t = NOW0 + 1000
  const wtsOfGame = [] // attestation wts per game (pointer ranking input)
  const segEvOfGame = [] // the attested segment event per game
  for (let g = 0; g < 1000; g++) {
    const w = wits[g % 8]
    const opp = opps[g % 300]
    const game = idLike('rc-game-' + g)
    const transcript = SEG.transcriptDigest(game, [], g % 3 ? '1-0' : '1/2-1/2', 'resign')
    const payload = SEG.makeSegmentPayload({
      game, opp: opp.pubB, color: g % 2 ? 'b' : 'w', result: g % 3 ? '1-0' : '1/2-1/2', reason: 'resign', moves: [],
      heads: { w: { head: idLike('rc-hw-' + g), height: 0 }, b: { head: idLike('rc-hb-' + g), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, game, g % 3 ? '1-0' : '1/2-1/2', 0, transcript),
      oppProfile: { name: 'Opp ' + (g % 300) },
    })
    t += 60_000
    chain = attachLast(A.appendWitnessed(chain, subDev.priv, subDev.pubB, 'segment', payload, t), w, t + 500)
    wtsOfGame.push(t + 500)
    segEvOfGame.push(chain.events[chain.events.length - 1])
    if ((g + 1) % 20 === 0) {
      const ck = A.makeCheckpointEvent(chain, subDev.priv, subDev.pubB, t + 700)
      const atts = wits.slice(0, 5).map((cw, i) => W.cosignCheckpoint(ck, chain, cw.pubB, cw.priv, t + 700 + i))
      chain = A.appendEvent(chain, { body: ck.body, sig: ck.sig, wit: atts })
    }
  }
  const vrOrig = A.verifyChain(chain)
  ok(vrOrig.ok, 'the original 1,000-game chain fully verifies (fixture sanity)')
  eq(vrOrig.witnessedHeight, 1050, '1,000 games + 50 checkpoints + genesis → witnessed head height 1050')
  const headEv = chain.events.find((e) => e.body.lane === 'w' && e.body.height === 1050)
  const certsX = A.certsProving(subj.pubB, chain.events, [subDev.pubB])
  const chainBytes = A.chainToBytes(chain)
  const witnessedAll = chain.events.filter((e) => e.body.lane === 'w')
  console.log(`    (chain: ${chain.events.length} events, ${(chainBytes.length / 1024 / 1024).toFixed(2)} MB canonical)`)
  stamp('build 1,000 games + 50 cosigned checkpoints', tBuild)

  // --- the network: 300 opponent nodes + the subject's node -----------------
  const tNet = Date.now()
  const fabric = new W.MockFabric({ staleAfterMs: 3 * 3_600_000 })
  const CAP = 48 // suite seam: stored-pointer cap (structure identical to 128)
  const alive = new Set()
  function mkNode(tag, rootKp, keyKp, shardMb = 50) {
    const nodeId = W.nodeIdOf(rootKp.pub)
    const ep = fabric.endpoint(nodeId)
    const sp = () => W.signPresence(
      { v: 1, root: rootKp.pubB, key: keyKp.pubB, caps: { witness: true, committee: true, shardMb }, params: S.PARAMS_A3_DIGEST, ts: now, uptimePct: 99 },
      keyKp.priv,
    )
    const presence = sp()
    ep.announce(presence)
    const pointerGate = S.makePointerStoreValidator({ directory: () => ep.directory(), nowMs: () => now, capPerKey: CAP })
    const shardGate = S.makeShardStoreValidator({ shardMb, base: pointerGate.validator })
    const node = O.createOverlayNode(ep, { root: rootKp.pubB, key: keyKp.pubB }, {
      nowMs: () => now, validator: shardGate.validator, merge: pointerGate.merge,
    })
    const rec = { tag, root: rootKp, key: keyKp, nodeId, ep, node, gate: shardGate, presence, announce: () => ep.announce(sp()) }
    alive.add(rec)
    return rec
  }
  const kill = async (rec) => { alive.delete(rec); await rec.node.close(); await rec.ep.close() }

  const oppNodes = opps.map((kp, i) => mkNode('opp-' + i, kp, kp))
  let subjectNode = mkNode('subject', subj, subDev, 0) // a phone: advertises no shard capacity
  const seedsFor = (i) => [0, 1, 2, 3, 37, 101, 197, 251].map((d) => oppNodes[(i + d) % 300].presence)
  for (let i = 0; i < oppNodes.length; i++) await oppNodes[i].node.bootstrap(seedsFor(i))
  await subjectNode.node.bootstrap(seedsFor(0))
  const subjectNodeId = W.nodeIdOf(subj.pub)
  stamp('bring up + bootstrap 301 overlay nodes', tNet)

  // --- publish-on-write + pointers + final sync -----------------------------
  const tPub = Date.now()
  const storedEvents = await S.publishWitnessedEvents(subjectNode.node, subj.pubB, witnessedAll, certsX)
  const batches = Math.ceil(witnessedAll.length / S.PARAMS_A3.eventsPageMax)
  eq(storedEvents, batches * S.PARAMS_A3.replicateK, `publish-on-write: ${batches} batched puts each land on all replicateK=${S.PARAMS_A3.replicateK} closest nodes`)

  // 40 freshest entanglement partners publish segment pointers (their newest
  // game with X), one friend publishes a full-chain pointer, and the duty
  // carriers of the first 6 rows publish shard pointers — 47 records, all
  // inside the structural cap so nothing honest is ever truncated.
  const blobHash = shaB(chainBytes)
  for (let i = 0; i < 40; i++) {
    const oi = 60 + i
    const g = 900 + oi // opp oi's newest game
    const ptr = S.makeSegmentPointer({
      subject: subj.pubB, holder: opps[oi].pubB, key: opps[oi].pubB, priv: opps[oi].priv,
      ts: wtsOfGame[g] + 1000, event: segEvOfGame[g], certs: certsX,
    })
    await S.publishPointer(oppNodes[oi].node, ptr)
  }
  const friend = oppNodes[0]
  await S.publishPointer(friend.node, S.makeChainPointer({
    subject: subj.pubB, holder: opps[0].pubB, key: opps[0].pubB, priv: opps[0].priv,
    ts: wtsOfGame[999] + 2000, event: headEv, certs: certsX, blobHash,
  }))
  const fs = await S.finalSync(subjectNode.node, chain, headEv, certsX, subDev.priv)
  eq(fs.header.n, 40, 'finalSync cuts the production N_shards=40 geometry')
  eq(fs.header.k, 12, '…with K_rec=12 (any 12 of 40 reconstruct)')
  ok(fs.perIdx.every((c) => c >= S.PARAMS_A3.replicateK - 1), 'every shard row landed on ≥ replicateK−1 carriers (the zero-capacity subject refuses its own rows)')
  const dirNow = () => oppNodes.find((n) => alive.has(n)).ep.directory()
  const byNodeId = new Map(oppNodes.map((n) => [n.nodeId, n]))
  let shardPtrCount = 0
  for (let idx = 0; idx < 6; idx++) {
    const carrierId = S.dutyCarriers(subjectNodeId, idx, dirNow(), { nowMs: now })[0]
    const carrier = byNodeId.get(carrierId)
    if (!carrier || !alive.has(carrier)) continue
    const ptr = S.makeShardPointer({
      subject: subj.pubB, holder: carrier.root.pubB, key: carrier.root.pubB, priv: carrier.root.priv,
      ts: wtsOfGame[999] + 3000, header: fs.header, idx, directory: dirNow(), nowMs: now,
    })
    shardPtrCount += (await S.publishPointer(carrier.node, ptr)) > 0 ? 1 : 0
  }
  ok(shardPtrCount >= 5, `duty carriers published verified shard pointers (${shardPtrCount} rows)`)

  // A poisoning attacker: self-minted pointers + a stolen-proof replay must
  // land NOWHERE (index poisoning stays closed on the live network).
  const atk = kpOf('rc-attacker')
  const atkNode = mkNode('attacker', atk, atk)
  await atkNode.node.bootstrap(seedsFor(7))
  const stolenBody = { v: 1, subject: subj.pubB, holder: atk.pubB, key: atk.pubB, kind: 'segment', hash: A.eventId(segEvOfGame[999].body), ts: now, proof: { event: segEvOfGame[999], certs: certsX }, holderCerts: [] }
  eq(await atkNode.node.put(S.pointerKeyOfRoot(subj.pubB), 'pointers', { v: 1, ptrs: [mint(stolenBody, atk.priv)] }), 0,
    "a stranger replaying the subject's segment proof stores NOWHERE (every gate re-verifies opp === holder)")

  const rowKeys = Array.from({ length: 40 }, (_, i) => S.shardKey(subjectNodeId, i))
  const holdersOfRow = (idx) => [...alive].filter((n) => n.node.localGet(rowKeys[idx], 'shard') !== null)
  const liveRowCount = () => rowKeys.reduce((acc, _, i) => acc + (holdersOfRow(i).length > 0 ? 1 : 0), 0)
  eq(liveRowCount(), 40, 'all 40 shard rows are live in shard space after the final sync')
  stamp('publish-on-write + pointers + finalSync', tPub)

  // --- THE OWNER'S NODE LEAVES FOREVER --------------------------------------
  await kill(subjectNode)
  subjectNode = null // no residual reads — the store died with the node
  ok(liveRowCount() === 40, 'shard space is intact without the owner (the network IS the storage)')

  // --- a FRESH viewer joins and reconstructs --------------------------------
  const tView = Date.now()
  const viewerKp = kpOf('rc-viewer')
  const viewer = mkNode('viewer', viewerKp, viewerKp)
  await viewer.node.bootstrap(seedsFor(11))
  const view = await S.resolveProfile(viewer.node, subj.pubB, {
    directory: viewer.ep.directory(), nowMs: now, cosig: { eligible, rule: RULE }, spot: { p: 1, roll: 0 },
  })
  stamp('resolveProfile (owner gone)', tView)

  eq(view.status, 'expected', 'resolve status: expected (full chain via the shard layer)')
  ok(view.chain !== undefined, 'the full chain reconstructed from shard space')
  eq(shaB(A.chainToBytes(view.chain)), shaB(chainBytes), 'THE A3 PROOF: the reconstructed chain is BIT-FAITHFUL to the original bytes')
  eq(view.head?.id, A.eventId(headEv.body), 'the pinned head is the countersigned original')
  eq(view.head?.height, 1050, 'head height 1050')
  eq(canon(view.headEvent), canon(headEv), 'the head EVENT itself is surfaced for A4 (with its cosignatures)')
  const newestCkpt = headEv // the 50th checkpoint IS the head event
  eq(view.ckpt?.id, A.eventId(newestCkpt.body), 'the newest checkpoint is surfaced')
  eq(view.ckpt?.through, 1049, 'covering through height 1049')
  eq(view.ckptInfo?.mOfN, true, `the checkpoint carries a valid ${RULE.m}-of-${RULE.n} cosigner set (A4 pinned input)`)
  eq(view.ckptInfo?.cosigners, 5, 'five distinct cosigners verified')
  eq(view.ckptInfo?.verified, 'deep', 'the drawn spot-check re-derived it from genesis')
  ok(view.ckptInfo?.prefixes16 >= RULE.prefixDiversityMin, 'cosigner /16 diversity satisfied and surfaced')
  eq(canon(view.profile), canon(vrOrig.profile), "the profile fold matches the original chain's own fold")
  eq(view.profile.bio, 'They reconstructed me from shards.', 'LWW profile: the final bio won')
  eq(view.name, 'Reconstruct Subject', 'the genesis display name surfaced')
  eq(view.segments.length, 1000, 'ALL 1,000 game segments recovered')
  eq(
    canon(view.segments.map((e) => A.eventId(e.body))),
    canon(chain.events.filter((e) => e.body.type === 'segment').sort((a, b) => a.body.height - b.body.height).map((e) => A.eventId(e.body))),
    'the recovered game set is exactly the original (ids, in height order)',
  )
  eq(view.sources.viaChain, true, 'sources: reconstruction rode the chain layer')
  eq(view.sources.shardsUsed, 40, 'sources: all 40 live rows fed the freshest snapshot group')
  ok(view.sources.pointers >= 41, `sources: the 41 entanglement/chain pointers all enumerate (+${view.sources.pointers - 41} shard pointers still on duty under the viewer's directory)`)
  eq(view.sources.holders, 41, 'sources: 41 distinct entanglement/chain holders')
  eq(view.holdersRanked.length, S.PARAMS_A3.viewerHoldersMax, `the profile fast path ranked the ${S.PARAMS_A3.viewerHoldersMax} freshest holders`)
  eq(view.holdersRanked[0].holder, opps[0].pubB, 'the freshest holder is the friend with the newest verified claim (chain replica)')
  eq(view.holdersRanked[1].holder, opps[99].pubB, 'then the last game’s opponent (verified effTs, not claimed ts)')
  ok(view.holdersRanked.every((h) => h.holder !== atk.pubB), 'the poisoning attacker ranks NOWHERE')
  eq(view.shardReport.liveRows, 40, 'shard report: 40 live rows observed')

  // --- lazy history pages over the reconstructed view -----------------------
  const tPage = Date.now()
  const pager = S.historyFromView(view)
  eq(pager.pageCount, Math.ceil(1051 / S.PARAMS_A3.eventsPageMax), 'history pages ~2KB/game: ceil(1051/32) pages')
  let pagedGames = 0
  let pagesOk = true
  for (let i = 0; i < pager.pageCount; i++) {
    const p = await pager.page(i)
    if (p.ok) pagedGames += p.games
    else pagesOk = false
  }
  ok(pagesOk, 'every lazy page verifies against the pinned head (chain-segment verification per page)')
  eq(pagedGames, 1000, 'the pages deliver all 1,000 games exactly once')
  stamp('page the full history', tPage)

  // ==========================================================================
  console.log('\n· D. degraded: below K_rec → honest unavailability → HEALS …')
  // ==========================================================================
  const tDeg = Date.now()
  now += 1_800_000 // +30min
  for (const n of alive) n.announce()

  // Kill plan (nodes hold MULTIPLE rows, so the choice is over survivors, not
  // rows): pin a deterministic survivor set of shard holders whose combined
  // holdings cover ≤ 11 rows (below K_rec=12), preferring pointer-index
  // holders as survivors; every OTHER shard holder dies, and so does every
  // publish-on-write events holder — the floor must come from the surviving
  // pointer index alone.
  const pointerKeyX = S.pointerKeyOfRoot(subj.pubB)
  const eventsHolders = new Set([...alive].filter((n) => n.node.localGet(subjectNodeId, 'events') !== null))
  const rowsOf = new Map()
  for (let idx = 0; idx < 40; idx++)
    for (const n of holdersOfRow(idx)) rowsOf.set(n, [...(rowsOf.get(n) ?? []), idx])
  const isPtrHolder = (n) => n.node.localGet(pointerKeyX, 'pointers') !== null
  const shardHolders = [...rowsOf.keys()].sort(
    (a, b) => (isPtrHolder(b) ? 1 : 0) - (isPtrHolder(a) ? 1 : 0) || (a.nodeId < b.nodeId ? -1 : 1),
  )
  let covered = new Set()
  const survivors = new Set()
  for (const n of shardHolders) {
    if (eventsHolders.has(n)) continue
    const grown = new Set([...covered, ...rowsOf.get(n)])
    if (grown.size <= 11) { covered = grown; survivors.add(n) }
  }
  for (const n of shardHolders) {
    if (eventsHolders.has(n) || survivors.has(n)) continue
    if (rowsOf.get(n).every((r) => covered.has(r))) survivors.add(n) // redundant copies of kept rows may live
  }
  const keepCount = covered.size
  ok(keepCount >= 3 && keepCount < 12, `survivor pinning covers ${keepCount} rows — below K_rec=12`)
  const kills = new Set([...eventsHolders, ...shardHolders.filter((n) => !survivors.has(n))])
  kills.delete(viewer)
  // The heal-1 plan: carriers of (12 − keepCount) dead rows keep their rows on
  // disk through the outage and will REJOIN. Snapshot their envelopes now.
  const deadRows = Array.from({ length: 40 }, (_, i) => i).filter((i) => !covered.has(i))
  const rejoinPlan = new Map() // rootKp.pubB -> { rootKp, envs: [] }
  {
    let needed = 12 - keepCount
    for (const idx of deadRows) {
      if (needed === 0) break
      const carrier = holdersOfRow(idx).find((n) => kills.has(n))
      if (!carrier) continue
      const entry = rejoinPlan.get(carrier.root.pubB) ?? { rootKp: carrier.root, envs: [] }
      entry.envs.push({ key: rowKeys[idx], env: clone(carrier.node.localGet(rowKeys[idx], 'shard')) })
      rejoinPlan.set(carrier.root.pubB, entry)
      needed--
    }
    eq([...rejoinPlan.values()].reduce((a, e) => a + e.envs.length, 0), 12 - keepCount, `heal-1 plan: ${12 - keepCount} dead-row envelopes ride out the outage on returning carriers' disks`)
  }
  const pointerHolders = [...alive].filter(isPtrHolder)
  ok(pointerHolders.some((n) => !kills.has(n)), 'sanity: the pointer index keeps ≥1 surviving holder')
  for (const n of kills) await kill(n)
  console.log(`    (${kills.size} carriers died; ${alive.size} nodes survive; live rows: ${liveRowCount()})`)
  eq(liveRowCount(), keepCount, `live shard rows fell to ${keepCount} — below K_rec=12`)

  const view2 = await S.resolveProfile(viewer.node, subj.pubB, {
    directory: viewer.ep.directory(), nowMs: now, cosig: { eligible, rule: RULE }, spot: { p: 1, roll: 0 },
  })
  eq(view2.status, 'floor', 'below K_rec: resolve degrades to the guaranteed floor')
  ok(view2.chain === undefined, 'no chain is served (never wrong or partial bytes)')
  eq(view2.shardReport.liveRows, keepCount, `the report carries the observed live rows (${keepCount})`)
  eq(view2.shardReport.reason, 'below-k', 'the failure is TYPED temporary unavailability')
  eq(view2.segments.length, 40, 'the guaranteed floor still serves: the 40 surviving pointer-held segments')
  eq(view2.head?.height, 1050, "the countersigned head STILL pins (the friend's chain pointer proof survives)")
  ok(view2.ckptInfo === undefined, 'no checkpoint is asserted without its verification rule (the floor lacks the fold range — honest absence)')
  ok(view2.sources.viaChain === false && view2.sources.shardsUsed === 0, 'sources reflect the floor honestly')
  ok(view2.certs.length >= 1, 'the floor view carries the collected device certs (so historyFromView can page a device-signed floor — defect I)')

  // The A6 fast-path seam: a holder summary (the friend still holds the chain)
  // restores the profile surface even while the chain layer is unavailable.
  const view2b = await S.resolveProfile(viewer.node, subj.pubB, {
    directory: viewer.ep.directory(), nowMs: now, summaries: [S.buildHolderSummary(chain)],
  })
  eq(canon(view2b.profile), canon(vrOrig.profile), 'an injected verified holder summary restores the profile fold on the floor path')
  eq(view2b.status, 'floor', '…without ever pretending the chain came back')

  // --- heal 1: carriers RETURN (downtime, not loss) -------------------------
  const rejoinedNodes = []
  for (const entry of rejoinPlan.values()) {
    const rj = mkNode('rejoin', entry.rootKp, entry.rootKp)
    await rj.node.bootstrap([...alive].filter((n) => n !== rj).slice(0, 8).map((n) => n.presence))
    for (const { key, env } of entry.envs)
      ok(rj.node.localPut(key, 'shard', env), 'the returning carrier re-offers its disk row through its own gate (re-verified)')
    rejoinedNodes.push(rj)
  }
  eq(liveRowCount(), 12, 'live rows back to exactly K_rec=12')
  const view3 = await S.resolveProfile(viewer.node, subj.pubB, {
    directory: viewer.ep.directory(), nowMs: now, cosig: { eligible, rule: RULE }, spot: { p: 1, roll: 0 },
  })
  eq(view3.status, 'expected', 'at exactly K_rec live rows reconstruction succeeds again')
  eq(shaB(A.chainToBytes(view3.chain)), shaB(chainBytes), 'HEALED: bit-faithful from exactly 12 of 40 rows — unavailability was TEMPORARY')
  eq(view3.ckptInfo?.mOfN, true, 'the M-of-N checkpoint surface is back with the chain')

  // --- heal 2: new nodes join; repair re-encodes + redistributes ------------
  now += 1_800_000
  for (const n of alive) n.announce()
  const joiners = Array.from({ length: 12 }, (_, i) => mkNode('joiner-' + i, kpOf('rc-join-' + i), kpOf('rc-join-' + i)))
  for (const j of joiners) await j.node.bootstrap([...alive].filter((n) => n !== j && !n.tag.startsWith('joiner')).slice(0, 8).map((n) => n.presence))
  const rejoined = rejoinedNodes[0]
  const actions = await S.runRepair({ node: rejoined.node, directory: rejoined.ep.directory(), subjects: [subjectNodeId] }, now)
  eq(actions.length, 1, 'the repair tick scanned the one subject it carries')
  eq(actions[0].outcome, 'healed', 'runRepair: live(12) < kRec+headroom(20) with ≥ kRec survivors → healed')
  eq(actions[0].redistributed.length, 28, 'the 28 dead rows were re-encoded and redistributed')
  ok(actions[0].stored >= 28, 'every redistributed row found live carriers')
  eq(actions[0].headId, fs.header.headId, 'repair preserved the snapshot identity (same countersigned head)')
  eq(liveRowCount(), 40, 'all 40 rows live again — eviction = churn = healed')
  for (const rj of rejoinedNodes) await kill(rj) // even the disk-returning carriers can die again now
  const reLost = 40 - liveRowCount()
  ok(reLost >= 1 && reLost <= 12 - keepCount, `killing the returned carriers re-loses only their unredistributed rows (${reLost})`)
  const repairer2 = [...alive].find((n) => n.gate.subjects().includes(subjectNodeId))
  ok(repairer2 !== undefined, 'sanity: a surviving holder exists to run the next tick')
  const tick2 = await S.runRepair({ node: repairer2.node, directory: repairer2.ep.directory(), subjects: [subjectNodeId] }, now)
  ok(tick2[0].outcome === 'healthy' && tick2[0].live === 40 - reLost && tick2[0].redistributed.length === 0,
    `${40 - reLost} live rows ≥ kRec+headroom(${12 + S.PARAMS_A3.repairHeadroom}): the tick reports healthy and redistributes nothing — repair converges without oscillation (re-sharding fires only when the headroom floor is threatened, ACCOUNTS-PARAMS §Storage)`)

  const viewer4 = mkNode('viewer-final', kpOf('rc-viewer-final'), kpOf('rc-viewer-final'))
  await viewer4.node.bootstrap([...alive].filter((n) => n !== viewer4).slice(0, 8).map((n) => n.presence))
  const view4 = await S.resolveProfile(viewer4.node, subj.pubB, {
    directory: viewer4.ep.directory(), nowMs: now, cosig: { eligible, rule: RULE }, spot: { p: 1, roll: 0 },
  })
  eq(view4.status, 'expected', 'a brand-new viewer after the full churn cycle reconstructs')
  eq(shaB(A.chainToBytes(view4.chain)), shaB(chainBytes), 'FINAL: bit-faithful after die → floor → return → repair — NEVER silent loss')
  eq(view4.segments.length, 1000, 'all 1,000 games — again')
  stamp('degraded + heal cycle', tDeg)

  // ==========================================================================
  console.log('\n· B. browser parity: the viewer decision core …')
  // ==========================================================================
  {
    const coreNode = await bundleAndImport(outNode, PARITY_ENTRY, 'node')
    const coreBrowser = await bundleAndImport(outBrowser, PARITY_ENTRY, 'browser')
    const dNode = await coreNode.runViewerParityScript()
    const dBrowser = await coreBrowser.runViewerParityScript()
    eq(dNode, dBrowser, 'node and browser bundles produce the identical viewer decision digest (head/ckpt/summary/pages)')
    const refs = findNodeBuiltinRefs(readBundle(resolve(outBrowser, 'bundle.mjs')))
    eq(refs.length, 0, 'the browser bundle of the viewer core carries zero node built-ins')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
