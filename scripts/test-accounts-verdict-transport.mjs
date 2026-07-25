// THE A7 VERDICT-TRANSPORT SUITE. Brick 2 (Tier-2 verdict rows over the A3
// overlay: src/shared/accounts/judge/transport.ts).
//
//   node scripts/test-accounts-verdict-transport.mjs
//
// Proves the brick end to end, fabric-suite style:
//   1. store-gate unit matrix: real makeTier2Verdict records pass the
//      context-free gate (twin-schema drift alarm); malformed / oversize /
//      params-pin / lifetime-receipt / suppression-claim / signature /
//      provenance / key-binding failures each hit their typed verdict;
//   2. merge determinism + anti-suppression order: byte-identical rows in
//      every arrival order, dedup, conviction-class rank (sub-conviction junk
//      can never evict conviction evidence), per-signer fair share (one
//      flooding signer cannot evict another signer's round-0 record),
//      junk-replace protection, byte-budget skip-and-continue;
//   3. MOCK-PAIR end to end over a 16-node MockFabric overlay with the gate
//      installed: judge publishes verdict+suppression → peer fetches
//      (getMerged), adopts through the A5-33 judge-pinned path, runs the §8
//      suppressionScan on the accused's verified chain, and reaches the SAME
//      displayState as the judge; pairingLegal refuses the banned ladder.
//      Invariants as asserts: 5σ-conviction-only (an adopted 3σ escalation
//      record yields NO ban), §0 no-false-fraud (a compliant selfban
//      discharges regardless of junk, including an ADOPTED hostile
//      suppression record), junk floods (malformed at the gate; well-formed
//      sub-conviction; conviction-impersonating sybils) can neither suppress
//      the genuine row nor forge evidence; 'pending' injects nothing;
//   4. browser parity: the transport decision core bundled platform:'browser'
//      produces the identical decision digest and carries zero node builtins.
//
// House style: esbuild-bundle on the fly (alias @shared → src/shared),
// one-line asserts, exit(1) on any failure. Test identities are RAW fixed
// 32-byte seeds → ed25519 (never argon2).

import { rmSync } from 'node:fs'
import { bundleAndImport, makeOutdir } from './lib/witness-bundle.mjs'
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
export * as J from '@shared/accounts/judge'
export * as T from '@shared/accounts/judge/transport'
export * as D from '@shared/accounts/ratings/display'
export * as MM from '@shared/accounts/mm/pairing'
export { PARAMS_A3, PARAMS_A3_DIGEST } from '@shared/accounts/storage/params'
`

async function main() {
  const outdir = makeOutdir('accounts-verdict-transport-test')
  const outNode = makeOutdir('accounts-vt-parity-node')
  const outBrowser = makeOutdir('accounts-vt-parity-browser')
  try {
    const M = await bundleAndImport(outdir, ENTRY)
    await run(M, outNode, outBrowser)
  } finally {
    for (const d of [outdir, outNode, outBrowser]) rmSync(d, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M, outNode, outBrowser) {
  const { A, W, O, J, T, D, MM, PARAMS_A3, PARAMS_A3_DIGEST } = M
  const NOW = 1_760_000_000_000
  const b64 = A.toB64u
  const b64h = (v) => b64(A.canonicalHash(v))
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    return { priv, pubB: b64(A.ed25519.getPublicKey(priv)) }
  }
  const recIdOf = (rec) => b64h(rec)
  const K = J.PARAMS_A5.reganK
  const THR = J.PARAMS_A5.zThresholdMicro
  const ESC = J.PARAMS_A5.zEscalateMicro
  const JA = J.TIER2_ANCHORS_JUDGE
  const JA_DIGEST = J.tier2AnchorsDigest(JA)
  const LAD = 'chess:Blitz'

  // ---- fixtures ------------------------------------------------------------
  const judge = kpOf('vt-judge')
  const side = (acplMicro, matchMicro, scored = 30) => ({
    scored, unscored: 0, acplMicro, matched: 0, matchMicro, clockFitMicro: 500_000, clockN: scored,
  })
  const mkRec = (game, acplMicro, matchMicro) => ({
    v: 1, game, ladder: LAD, judge: b64h({ j: game }), params: J.PARAMS_A5_DIGEST,
    w: side(acplMicro, matchMicro), b: side(55_000_000, 400_000),
  })
  const entriesOf = (prefix, acplMicro, matchMicro) =>
    Array.from({ length: K }, (_, i) => ({ rec: mkRec(`${prefix}-${i}`, acplMicro, matchMicro), side: 'w', elo: 1500 }))
  const blatant = (prefix) => entriesOf(prefix, 2_000_000, 980_000) // z ≥ 5σ under TIER2_ANCHORS_JUDGE
  const honest = (prefix) => entriesOf(prefix, 61_000_000, 843_000) // z ≈ 0
  const escal = (prefix) => entriesOf(prefix, 40_000_000, 900_000) // 3σ ≤ z < 5σ

  // Fixture sanity gates (the invariant asserts below depend on these bands).
  const zB = J.aggregateZMicro(blatant('zb'), JA).zMicro
  const zH = J.aggregateZMicro(honest('zh'), JA).zMicro
  const zE = J.aggregateZMicro(escal('ze'), JA).zMicro
  console.log('· fixture z bands under TIER2_ANCHORS_JUDGE …')
  ok(zB >= THR, `blatant window convicts under the judge bundle (z ${zB} ≥ ${THR})`)
  ok(zH < ESC, `honest window stays below escalation (z ${zH} < ${ESC})`)
  ok(zE >= ESC && zE < THR, `escalation window sits in [3σ, 5σ) (z ${zE})`)

  const mkVerdict = (o) =>
    J.makeTier2Verdict({
      anchors: JA, verdictWts: 5_000, signer: judge.pubB, key: judge.pubB, priv: judge.priv, ...o,
    })
  // Hand-built conviction-IMPERSONATING record (makeTier2Verdict refuses to
  // fabricate these. The whole point): valid sig, judge-anchor digest, full-K
  // games, z claim ≥ 5σ, but no real evidence behind it.
  const mkImpersonator = (root, signerKp, window, prefix, games) => {
    const body = {
      v: 1, kind: 'verdict', root, ladder: LAD, window, zMicro: 6_000_000,
      games: games ?? Array.from({ length: K }, (_, g) => `${prefix}-${g}`),
      tier1: Array.from({ length: K }, (_, g) => b64h({ t: prefix, g })),
      anchors: JA_DIGEST, params: J.PARAMS_A5_DIGEST, verdictWts: 1,
    }
    return { body, signer: signerKp.pubB, key: signerKp.pubB, sig: b64(A.ed25519.sign(A.canonicalBytes(body), signerKp.priv)) }
  }

  // Accused chains (hand-built, chain-shaped for suppressionScan; the scan
  // consumes the reader's ALREADY-VERIFIED chain; sigs are not its business).
  const mkChain = (root) => {
    let h = 0
    const ev = (lane, type, payload) => ({
      body: { v: 1, lane, type, root, key: root, height: h++, ts: 1_000 + h, payload },
      sig: 'unchecked-by-scan',
    })
    return {
      seg: (game) => ev('w', 'segment', { game }),
      sb: (ladder) => ev('w', 'selfban', { kind: 'anticheat', ladder, window: 3, expiryWts: 9_000_000, verdict: b64h({ d: 'v' }) }),
      prof: () => ev('p', 'profile', { fields: {} }),
    }
  }
  const eid = (ev) => A.eventId(ev.body)

  // ==========================================================================
  console.log('\n· 1. store-gate unit matrix (context-free verification) …')
  // ==========================================================================
  const ROOT_S = b64h({ r: 'accused-suppressed' })
  const keyS = J.tier2VerdictKey(ROOT_S)
  const convS = blatant('cheat')
  const recConv = mkVerdict({ kind: 'verdict', root: ROOT_S, ladder: LAD, window: 3, entries: convS })

  {
    const c = T.checkVerdictRecord(recConv)
    eq(c.verdict, 'ok', 'a real makeTier2Verdict record passes the gate (twin-schema drift alarm)')
    eq(c.info?.conviction, true, 'a full-K ≥5σ record classes as conviction-shaped')
    eq(c.info?.judgeAnchored, true, 'judge-anchor digest recognized (A5-33 rank input)')
    ok(c.info?.bytes > 0 && c.info?.recId.length === 43, 'gate reports record bytes + canonical record id')
    eq(T.checkVerdictRecord(recConv, {}, keyS).verdict, 'ok', 'key binding accepts the ACCUSED root slot')
    eq(T.checkVerdictRecord(recConv, {}, J.tier2VerdictKey(b64h({ r: 'other' }))).verdict, 'wrong-key', 'a foreign target key is refused (records cannot squat under another subject)')
  }
  {
    const dull = mkVerdict({ kind: 'verdict', root: ROOT_S, ladder: LAD, window: 9, entries: honest('dull') })
    const c = T.checkVerdictRecord(dull)
    eq(c.verdict, 'ok', 'an honest sub-conviction verdict record passes the gate too')
    eq(c.info?.conviction, false, '… and classes as NON-conviction (junk class in the merge order)')
  }
  eq(T.verifyVerdictRecord({ ...recConv, body: { ...recConv.body, zMicro: recConv.body.zMicro + 1 } }), 'bad-sig', 'tampered zMicro breaks the record signature')
  eq(T.verifyVerdictRecord({ ...recConv, sig: 'B' + recConv.sig.slice(1) }), 'bad-sig', 'flipped signature refused')
  eq(T.verifyVerdictRecord({ ...recConv, body: { ...recConv.body, params: b64h({ p: 'foreign' }) } }), 'bad-params', 'foreign params digest refused BEFORE signature work (never adoptable)')
  {
    const child = kpOf('vt-child')
    eq(T.verifyVerdictRecord({ ...recConv, key: child.pubB, sig: b64(A.ed25519.sign(A.canonicalBytes(recConv.body), child.priv)) }), 'uncertified-key', 'child key without signer certs refused (commend-pattern provenance)')
    eq(T.verifyVerdictRecord({ ...recConv, certs: [{ junk: 1 }] }), 'uncertified-key', 'certs present when key === signer refused')
  }
  {
    const life = mkVerdict({
      kind: 'verdict', root: ROOT_S, ladder: LAD, window: 3, entries: convS,
      lifetimeWindowZs: [1_000_000, 2_000_000, 1_500_000, recConv.body.zMicro],
    })
    eq(T.verifyVerdictRecord(life), 'ok', 'a real lifetime claim passes (receipt recomputes)')
    eq(T.verifyVerdictRecord({ ...life, body: { ...life.body, lifetime: { ...life.body.lifetime, zLifeMicro: life.body.lifetime.zLifeMicro + 1 } } }), 'bad-lifetime', 'a lifetime claim that does not recompute from its own windowZs is refused at the gate')
  }
  {
    const sybil = kpOf('vt-supp-forger')
    const body = {
      v: 1, kind: 'suppression', root: ROOT_S, ladder: LAD, window: 3, zMicro: 4_000_000,
      games: Array.from({ length: K }, (_, g) => `sf-${g}`), tier1: Array.from({ length: K }, (_, g) => b64h({ sf: g })),
      anchors: JA_DIGEST, params: J.PARAMS_A5_DIGEST, verdictWts: 1, deadlineEvent: b64h({ e: 1 }),
    }
    const rec = { body, signer: sybil.pubB, key: sybil.pubB, sig: b64(A.ed25519.sign(A.canonicalBytes(body), sybil.priv)) }
    eq(T.verifyVerdictRecord(rec), 'bad-suppression', 'a suppression whose own claim is sub-5σ is refused (A5-21: escalation can never ground suppression)')
    const short = { ...body, zMicro: 6_000_000, games: body.games.slice(0, 10), tier1: body.tier1.slice(0, 10) }
    const rec2 = { body: short, signer: sybil.pubB, key: sybil.pubB, sig: b64(A.ed25519.sign(A.canonicalBytes(short), sybil.priv)) }
    eq(T.verifyVerdictRecord(rec2), 'bad-suppression', 'a suppression claiming a partial window is refused (no single game, or ten, convicts)')
  }
  eq(T.verifyVerdictRecord(recConv, { maxBytes: 64 }), 'oversize', 'per-record byte ceiling enforced')
  for (const junk of [null, 'x', {}, { body: {}, signer: 'x', key: 'x', sig: 'x' }, { ...recConv, extra: 1 }]) {
    eq(T.verifyVerdictRecord(junk), 'bad-record', `malformed record ${JSON.stringify(junk)?.slice(0, 40)} refused, never thrown`)
  }
  ok(T.isVerdictRowShaped({ v: 1, verdicts: [1] }) && !T.isVerdictRowShaped({ v: 1, verdicts: [] }) && !T.isVerdictRowShaped({ v: 1, ptrs: [] }), 'row-shape discrimination (kind-record decision) behaves')

  // ==========================================================================
  console.log('\n· 2. merge determinism + the anti-suppression order …')
  // ==========================================================================
  const recSupp = (() => {
    const ch = mkChain(ROOT_S)
    const events = [ch.seg('cheat-28'), ch.seg('cheat-29'), ch.seg('after-1'), ch.seg('after-2')]
    const scan = J.suppressionScan(events, 'cheat-29', LAD)
    eq(scan.kind, 'suppressed', 'fixture: the accused kept playing past the conviction game, §8 scan yields the deadline')
    return { events, rec: mkVerdict({ kind: 'suppression', root: ROOT_S, ladder: LAD, window: 3, entries: convS, deadlineEvent: scan.deadlineEvent }) }
  })()
  const chainS = recSupp.events
  const sybils = Array.from({ length: 8 }, (_, i) => kpOf(`vt-syb-${i}`))
  const junkOf = (i) => {
    const s = sybils[i % sybils.length]
    return J.makeTier2Verdict({
      kind: 'verdict', root: ROOT_S, ladder: LAD, window: 200 + i, entries: honest(`junk-${i}`),
      anchors: JA, verdictWts: 100, signer: s.pubB, key: s.pubB, priv: s.priv,
    })
  }
  {
    const merge = T.makeVerdictMerge({ capPerRow: 3 })
    const imp = mkImpersonator(ROOT_S, sybils[0], 500, 'imp-m')
    const junk = [junkOf(0), junkOf(1), junkOf(2), junkOf(3)]
    const rowOf = (...recs) => ({ v: 1, verdicts: recs })
    const orders = [
      [rowOf(...junk), rowOf(recConv, recSupp.rec), rowOf(imp)],
      [rowOf(imp), rowOf(...junk), rowOf(recConv, recSupp.rec)],
      [rowOf(recConv), rowOf(imp, recSupp.rec), rowOf(...junk)],
    ]
    const hashes = orders.map((batches) => {
      let acc = null
      for (const b of batches) acc = merge(acc, b, 'record', keyS)
      return b64h(acc)
    })
    ok(hashes[0] === hashes[1] && hashes[1] === hashes[2], 'merged row is byte-identical in every arrival order (set-deterministic fold)')
    let acc = null
    for (const b of orders[0]) acc = merge(acc, b, 'record', keyS)
    eq(acc.verdicts.length, 3, 'cap enforced (3)')
    const ids = acc.verdicts.map(recIdOf)
    ok(ids.includes(recIdOf(recConv)) && ids.includes(recIdOf(recSupp.rec)), 'BOTH genuine conviction records survive every order. Sub-conviction junk can never evict conviction evidence (class rank)')
    ok(ids.includes(recIdOf(imp)), '… the third slot goes to the remaining conviction-CLASS record, never to sub-conviction junk')
    const again = merge(acc, rowOf(recConv, ...junk), 'record', keyS)
    eq(b64h(again), b64h(acc), 're-offering held records + junk is a no-op (dedup by record hash)')
  }
  {
    // Fair share: one signer floods 6 conviction-impersonators; another
    // signer's single genuine conviction record survives at cap 2.
    const merge = T.makeVerdictMerge({ capPerRow: 2 })
    const flooder = kpOf('vt-flooder')
    const flood = Array.from({ length: 6 }, (_, i) => mkImpersonator(ROOT_S, flooder, 600 + i, `fl-${i}`))
    let acc = null
    acc = merge(acc, { v: 1, verdicts: flood }, 'record', keyS)
    acc = merge(acc, { v: 1, verdicts: [recConv] }, 'record', keyS)
    const ids = acc.verdicts.map(recIdOf)
    eq(acc.verdicts.length, 2, 'cap 2 enforced under a 6-record single-signer flood')
    ok(ids.includes(recIdOf(recConv)), "the OTHER signer's genuine conviction record survives (per-signer fair share: round 0 beats the flooder's rounds 1+)")
    // and in the reverse arrival order too
    let acc2 = null
    acc2 = merge(acc2, { v: 1, verdicts: [recConv] }, 'record', keyS)
    acc2 = merge(acc2, { v: 1, verdicts: flood }, 'record', keyS)
    eq(b64h(acc2), b64h(acc), '… identically in the reverse arrival order')
  }
  {
    const merge = T.makeVerdictMerge()
    const row = merge(null, { v: 1, verdicts: [recConv] }, 'record', keyS)
    // Junk-replace protection is now STRUCTURAL: prev's own records re-bind
    // through the fold, so a non-row value keeps the row BYTE-identical (was a
    // shape-based prev-shortcut that returned prev by reference. The shortcut
    // is gone because it shadowed co-installed layers; byte-identity is the
    // real contract).
    eq(b64h(merge(row, { v: 1, x: 1 }, 'record', keyS)), b64h(row), 'a stored verdict row is protected from junk-replace (prev records re-bind → row byte-identical)')
    const junkVal = { v: 1, x: 2 }
    eq(merge(null, junkVal, 'record', b64h({ k: 'elsewhere' })), junkVal, 'a non-verdict record value binds nothing → delegated to base untouched (no manufactured empty verdict row that could shadow a co-installed layer)')
    // KEY-DOMAIN DISCIPLINE: a row offered under a FOREIGN key binds no record,
    // so the fold DELEGATES to base (standalone = replace). It never claims-
    // and-empties the value into a self-recognized {verdicts:[]} row (the
    // composition break this fold now avoids; the composed case is asserted in
    // the social-transport suite).
    const foreignKey = J.tier2VerdictKey(b64h({ r: 'other' }))
    eq(b64h(merge(null, { v: 1, verdicts: [recConv] }, 'record', foreignKey)), b64h({ v: 1, verdicts: [recConv] }), 'a row under a foreign key binds nothing → delegated to base unchanged (never claimed-and-emptied)')
    // Binding by EXCLUSION: a record naming a DIFFERENT accused, folded at THIS
    // subject's key alongside a bound one, is dropped. Only the bound record
    // joins the row.
    const recOther = mkVerdict({ kind: 'verdict', root: b64h({ r: 'other-accused' }), ladder: LAD, window: 3, entries: blatant('other') })
    const mixed = merge(null, { v: 1, verdicts: [recConv, recOther] }, 'record', keyS)
    eq(mixed.verdicts.length, 1, 'a foreign-subject record is excluded by the key binding in the fold (only the bound record joins the row)')
    eq(recIdOf(mixed.verdicts[0]), recIdOf(recConv), '… and it is the one record that binds to this slot')
    const shard = { v: 1, anything: true }
    eq(merge(row, shard, 'shard', keyS), shard, 'other kinds delegate to the base merge (replace)')
  }
  {
    const bytesOf = (rec) => A.canonicalBytes(rec).length
    const budget = bytesOf(recSupp.rec) + 8 // room for the round-0 pick only
    const merge = T.makeVerdictMerge({ capPerRow: 10, rowMaxBytes: budget })
    const acc = merge(null, { v: 1, verdicts: [recConv, recSupp.rec] }, 'record', keyS)
    eq(acc.verdicts.length, 1, 'byte budget binds (one record fits)')
    eq(recIdOf(acc.verdicts[0]), recIdOf(recSupp.rec), "… keeping the signer's round-0 pick (suppression before verdict in a signer's own order)")
  }

  // ==========================================================================
  console.log('\n· 3. MOCK-PAIR end to end: 16-node overlay, judge publishes, peer adopts …')
  // ==========================================================================
  const fabric = new W.MockFabric()
  const mkNode = (tag) => {
    const root = kpOf(`vt-ov-root-${tag}`)
    const dev = kpOf(`vt-ov-dev-${tag}`)
    const nodeId = W.nodeIdOf(root.pubB)
    const ep = fabric.endpoint(nodeId)
    ep.announce(W.signPresence(
      { v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
      dev.priv,
    ))
    const gate = T.makeVerdictStoreValidator()
    const node = O.createOverlayNode(ep, { root: root.pubB, key: dev.pubB }, { nowMs: () => NOW, validator: gate.validator, merge: gate.merge })
    return { root, dev, nodeId, ep, node }
  }
  const nodes = Array.from({ length: 16 }, (_, i) => mkNode(`n${i}`))
  for (const n of nodes) await n.node.bootstrap()
  const JN = nodes[0] // the judge
  const PN = nodes[9] // the adopting peer
  const AN = nodes[13] // the attacker

  const entriesForS = (rec) => (rec.body.window === 3 && rec.body.ladder === LAD ? convS : null)

  // -- publish + fetch + adopt + scan → the SAME displayState on both sides --
  const stored = await T.publishVerdicts(JN.node, [recConv, recSupp.rec])
  eq(stored, PARAMS_A3.replicateK, `publish lands on all replicateK=${PARAMS_A3.replicateK} carriers (gates accept the genuine row)`)
  const localPub = J.publishVerdictRow([recConv, recSupp.rec])
  const fetched = await T.fetchVerdictRow(PN.node, ROOT_S)
  eq(fetched.key, localPub.key, 'fetch derives the same deterministic slot (tier2VerdictKey of the accused)')
  ok(fetched.row !== null && fetched.row.verdicts.length === 2, 'peer fetches the merged row over the network (both records)')

  const evJ = T.verdictEvidence({ subjectRoot: ROOT_S, key: localPub.key, row: localPub.row, entriesFor: entriesForS, chainEvents: chainS })
  const evP = T.verdictEvidence({ subjectRoot: ROOT_S, key: fetched.key, row: fetched.row, entriesFor: entriesForS, chainEvents: chainS })
  eq(evP.adopt.ok, true, 'peer adopt: every fetched record re-verified from the PEER’s own window inputs (A5-33 judge-pinned)')
  eq(evP.adopt.adopted.length, 2, '… both records adopted')
  eq(evP.ladders[LAD]?.suppressed, true, 'peer’s OWN §8 scan proves the suppression (conviction fired, no timely selfban)')
  eq(evP.ladders[LAD]?.ban?.until, Number.MAX_SAFE_INTEGER, 'suppression ⇒ PERMANENT distrust (§9) as the injected ban evidence')
  {
    const suppEntry = evP.ladders[LAD].records.find((r) => r.rec.body.kind === 'suppression')
    eq(suppEntry?.claimConfirmed, true, 'the adopted suppression record’s deadlineEvent is REPRODUCED by the peer’s own scan')
    eq(suppEntry?.scan.kind, 'suppressed', '… and the scan result is surfaced alongside the record')
    eq(suppEntry?.convictionGame, 'cheat-29', '… anchored on the window-completing game')
  }
  const ladderState = { n: 999, r: 1_500_000_000, rd: 60_000_000 }
  const dJ = D.displayState(ladderState, 'Blitz', T.banEvidenceOf(evJ, LAD), NOW)
  const dP = D.displayState(ladderState, 'Blitz', T.banEvidenceOf(evP, LAD), NOW)
  eq(JSON.stringify(dP), JSON.stringify(dJ), 'MOCK-PAIR: the peer reaches the SAME displayState as the judge from network bytes alone')
  eq(dP.state, 'banned', '… and it is the banned state, rendered to every viewer')
  {
    const accusedView = D.pairViewOf(ROOT_S, LAD, ladderState, 900_000, 'Blitz', T.banEvidenceOf(evP, LAD), NOW)
    const honestView = D.pairViewOf(b64h({ r: 'honest-opp' }), LAD, { n: 999, r: 1_520_000_000, rd: 55_000_000 }, 1_000_000, 'Blitz', undefined, NOW)
    eq(MM.pairingLegal(accusedView, honestView, NOW).reason, 'banned', 'pairingLegal refuses the suppressed ladder on the injected evidence')
    eq(MM.pairingLegal(honestView, accusedView, NOW).reason, 'banned', '… symmetrically')
    eq(MM.pairingLegal(honestView, D.pairViewOf(b64h({ r: 'honest-2' }), LAD, ladderState, 950_000, 'Blitz', undefined, NOW), NOW).legal, true, 'control: two honest views still pair')
    eq(JSON.stringify(T.mergedBan({ until: 5 }, T.banEvidenceOf(evP, LAD))), JSON.stringify({ until: Number.MAX_SAFE_INTEGER }), 'mergedBan composes fold selfban state with injected evidence by monotonic max')
    eq(T.mergedBan(undefined, undefined), undefined, 'mergedBan of nothing is nothing')
  }

  // -- junk floods over the network cannot suppress, malformed dies at gate --
  console.log('\n· 3b. floods: malformed refused at the gate; junk cannot suppress; forgeries cannot ban …')
  eq(await AN.node.put(keyS, 'record', { v: 1, verdicts: [{ junk: true }] }), 0, 'a malformed row is refused by EVERY carrier gate (0 true stores)')
  eq(await AN.node.put(keyS, 'record', { v: 1, verdicts: [{ ...recConv, sig: 'B' + recConv.sig.slice(1) }] }), 0, 'a bad-signature row is refused network-wide')
  eq(await AN.node.put(J.tier2VerdictKey(b64h({ r: 'elsewhere' })), 'record', { v: 1, verdicts: [recConv] }), 0, 'a genuine record offered under the WRONG subject key is refused network-wide (slot binding)')
  {
    const junk60 = Array.from({ length: 60 }, (_, i) => junkOf(i))
    const impSybils = Array.from({ length: 200 }, (_, i) => kpOf(`vt-imp-${i}`))
    const imp200 = impSybils.map((s, i) => mkImpersonator(ROOT_S, s, 1_000 + i, `imp-${i}`))
    ok((await T.publishVerdicts(AN.node, junk60)) > 0, 'well-formed sub-conviction junk IS storable (verification is the adopter’s, §0)')
    ok((await T.publishVerdicts(AN.node, imp200.slice(0, 128))) > 0, 'conviction-impersonating sybil flood stores too …')
    ok((await T.publishVerdicts(AN.node, imp200.slice(128))) > 0, '… (second batch)')
    const flooded = await T.fetchVerdictRow(PN.node, ROOT_S)
    eq(flooded.row.verdicts.length, J.ADOPT_ROW_MAX, `the merged row is capped at ADOPT_ROW_MAX=${J.ADOPT_ROW_MAX}, bounded storage, adopt-prefix consistent`)
    const ids = new Set(flooded.row.verdicts.map(recIdOf))
    ok(ids.has(recIdOf(recConv)) && ids.has(recIdOf(recSupp.rec)), 'ADVERSARIAL MERGE CANNOT SUPPRESS: both genuine conviction records survive the 260-record flood (class rank + fair share)')
    const evF = T.verdictEvidence({ subjectRoot: ROOT_S, key: flooded.key, row: flooded.row, entriesFor: entriesForS, chainEvents: chainS })
    eq(evF.adopt.ok, false, 'the flood is visible as typed per-record adopt errors …')
    eq(evF.adopt.adopted.length, 2, '… but ONLY the two genuine records adopt (impersonators fail their receipts)')
    eq(evF.ladders[LAD]?.ban?.until, Number.MAX_SAFE_INTEGER, '… and the ban evidence is UNCHANGED by the flood')
    eq(JSON.stringify(D.displayState(ladderState, 'Blitz', T.banEvidenceOf(evF, LAD), NOW)), JSON.stringify(dJ), '… so the peer still reaches the judge’s displayState (junk-flood cannot suppress END TO END)')
  }

  // -- §0: a compliant selfban discharges, junk in the row notwithstanding --
  console.log('\n· 3c. §0 no-false-fraud: the compliant client (and the pending one, and the 3σ one) …')
  {
    const ROOT_C = b64h({ r: 'accused-compliant' })
    const convC = blatant('cc')
    const ch = mkChain(ROOT_C)
    const sbEv = ch.sb(LAD)
    const post = ch.seg('cc-30')
    const chainC = [ch.seg('cc-28'), ch.seg('cc-29'), sbEv, post]
    const recConvC = mkVerdict({ kind: 'verdict', root: ROOT_C, ladder: LAD, window: 5, entries: convC })
    // The HOSTILE adopted suppression: a real 5σ window (public data) plus a
    // FALSE deadline claim naming the post-selfban segment. It verifies and
    // adopts, and must still ban nobody.
    const attacker = kpOf('vt-hostile-auditor')
    const recSuppHostile = J.makeTier2Verdict({
      kind: 'suppression', root: ROOT_C, ladder: LAD, window: 5, entries: convC,
      anchors: JA, verdictWts: 6_000, deadlineEvent: eid(post), signer: attacker.pubB, key: attacker.pubB, priv: attacker.priv,
    })
    await T.publishVerdicts(JN.node, [recConvC])
    await T.publishVerdicts(AN.node, [recSuppHostile])
    const f = await T.fetchVerdictRow(PN.node, ROOT_C)
    eq(f.row.verdicts.length, 2, 'both records (genuine verdict + hostile suppression) travel')
    const entriesForC = (rec) => (rec.body.window === 5 && rec.body.ladder === LAD ? convC : null)
    const evC = T.verdictEvidence({ subjectRoot: ROOT_C, key: f.key, row: f.row, entriesFor: entriesForC, chainEvents: chainC })
    eq(evC.adopt.ok, true, 'the hostile suppression record ADOPTS (its window evidence is real; receipts cannot refuse it)')
    eq(evC.ladders[LAD]?.suppressed, false, '§0: the reader’s OWN scan finds the COMPLIANT selfban, no suppression, junk in the row notwithstanding')
    eq(T.banEvidenceOf(evC, LAD), undefined, '… so transport injects NO ban (the fold’s banStep owns the served 90d term)')
    const suppEntry = evC.ladders[LAD].records.find((r) => r.rec.body.kind === 'suppression')
    eq(suppEntry?.claimConfirmed, false, '… the hostile record’s deadline claim is exposed as UNCONFIRMED')
    eq(suppEntry?.scan.kind, 'compliant', '… by the compliant scan')
    eq(suppEntry?.scan.selfBanEvent, eid(sbEv), '… naming the discharging selfban event')
    eq(D.displayState(ladderState, 'Blitz', T.banEvidenceOf(evC, LAD), NOW).state, 'ranked', '… and the compliant client renders ranked (an honest player is never banned)')
  }
  {
    const ROOT_P = b64h({ r: 'accused-pending' })
    const convP = blatant('pp')
    const ch = mkChain(ROOT_P)
    const chainP = [ch.seg('pp-28'), ch.seg('pp-29'), ch.prof()] // personal lane only after the game
    const recConvP = mkVerdict({ kind: 'verdict', root: ROOT_P, ladder: LAD, window: 7, entries: convP })
    await T.publishVerdicts(JN.node, [recConvP])
    const f = await T.fetchVerdictRow(PN.node, ROOT_P)
    const evP2 = T.verdictEvidence({ subjectRoot: ROOT_P, key: f.key, row: f.row, entriesFor: (rec) => (rec.body.window === 7 ? convP : null), chainEvents: chainP })
    eq(evP2.ladders[LAD]?.suppressed, false, 'deadline not yet passed ⇒ nothing provable')
    eq(evP2.ladders[LAD]?.records[0]?.scan.kind, 'pending', '… scan reports pending (personal-lane events never count, §8)')
    eq(T.banEvidenceOf(evP2, LAD), undefined, '… and injects nothing')
  }
  {
    const ROOT_E = b64h({ r: 'accused-escalated' })
    const escE = escal('esc')
    const ch = mkChain(ROOT_E)
    const chainE = [ch.seg('esc-29'), ch.seg('esc-after')] // kept playing. Would be suppression IF this were a conviction
    const recEsc = mkVerdict({ kind: 'verdict', root: ROOT_E, ladder: LAD, window: 2, entries: escE })
    await T.publishVerdicts(JN.node, [recEsc])
    const f = await T.fetchVerdictRow(PN.node, ROOT_E)
    const evE = T.verdictEvidence({ subjectRoot: ROOT_E, key: f.key, row: f.row, entriesFor: (rec) => (rec.body.window === 2 ? escE : null), chainEvents: chainE })
    eq(evE.adopt.ok, true, 'a genuine 3σ escalation record adopts fine …')
    eq(Object.keys(evE.ladders).length, 0, '… but NEVER reaches the ban path (A5-21: 5σ-conviction-only, escalation obliges analysis, never a ban)')
    eq(D.displayState(ladderState, 'Blitz', T.banEvidenceOf(evE, LAD), NOW).state, 'ranked', '… so the escalated-but-unconvicted player renders ranked')
  }
  {
    const ROOT_F = b64h({ r: 'accused-forged' })
    const honestF = honest('ff')
    const ch = mkChain(ROOT_F)
    const chainF = [ch.seg('ff-29')]
    // Forge with the REAL game keys and REAL tier1 digests. Everything but
    // the z claim, so rejection is specifically the zMicro receipt.
    const forger = kpOf('vt-forger')
    const body = {
      v: 1, kind: 'verdict', root: ROOT_F, ladder: LAD, window: 3, zMicro: 6_000_000,
      games: honestF.map((e) => e.rec.game), tier1: honestF.map((e) => J.tier1Digest(e.rec)),
      anchors: JA_DIGEST, params: J.PARAMS_A5_DIGEST, verdictWts: 1,
    }
    const forged = { body, signer: forger.pubB, key: forger.pubB, sig: b64(A.ed25519.sign(A.canonicalBytes(body), forger.priv)) }
    ok((await T.publishVerdicts(AN.node, [forged])) > 0, 'the forged 5σ claim stores (carriers cannot know: §0 puts the duty on adopters)')
    const f = await T.fetchVerdictRow(PN.node, ROOT_F)
    const evF2 = T.verdictEvidence({ subjectRoot: ROOT_F, key: f.key, row: f.row, entriesFor: (rec) => (rec.body.window === 3 ? honestF : null), chainEvents: chainF })
    eq(evF2.adopt.adopted.length, 0, 'ADVERSARIAL MERGE CANNOT FORGE: the honest player’s real inputs refute the z claim. Nothing adopts')
    ok(evF2.adopt.errors.some((e) => e.includes('zMicro does not recompute')), '… rejected specifically by the zMicro receipt')
    eq(Object.keys(evF2.ladders).length, 0, '… no ban path input exists')
    eq(D.displayState(ladderState, 'Blitz', T.banEvidenceOf(evF2, LAD), NOW).state, 'ranked', '… the honest player stays ranked (§0 no-false-fraud, end to end)')
  }
  {
    // Read-side determinism: two peers, same bytes, same evidence.
    const f1 = await T.fetchVerdictRow(nodes[5].node, ROOT_S)
    const f2 = await T.fetchVerdictRow(nodes[11].node, ROOT_S)
    eq(b64h(f1.row), b64h(f2.row), 'two different peers fetch byte-identical merged rows')
  }

  // ==========================================================================
  console.log('\n· 4. browser parity (decision core) …')
  // ==========================================================================
  const mNode = await bundleAndImport(outNode, PARITY_ENTRY, 'node')
  const mBrowser = await bundleAndImport(outBrowser, PARITY_ENTRY, 'browser')
  const dNodeP = mNode.runVerdictTransportParity()
  const dBrowserP = mBrowser.runVerdictTransportParity()
  eq(dBrowserP, dNodeP, 'node and browser bundles produce the identical transport decision digest')
  const browserBundle = readBundle(`${outBrowser}/bundle.mjs`)
  eq(findNodeBuiltinRefs(browserBundle).length, 0, 'the browser transport bundle carries zero node built-ins')
}

// The transport decision core (gate verdicts + merge order) bundled twice.
// Platform node vs browser: through one scripted sequence; the digests must
// match byte-for-byte and the browser bundle must carry zero node built-ins.
const PARITY_ENTRY = `
import { canonicalBytes, canonicalHash, ed25519, sha256, toB64u, utf8 } from '@shared/accounts'
import {
  PARAMS_A5_DIGEST, TIER2_ANCHORS_JUDGE, makeTier2Verdict, tier2AnchorsDigest, tier2VerdictKey,
} from '@shared/accounts/judge'
import {
  checkVerdictRecord, isVerdictRowShaped, makeVerdictMerge,
} from '@shared/accounts/judge/transport'

export function runVerdictTransportParity(): string {
  const b64h = (v: unknown) => toB64u(canonicalHash(v as never))
  const seed = (t: string) => sha256(utf8(t))
  const kp = (t: string) => {
    const priv = seed(t)
    return { priv, pubB: toB64u(ed25519.getPublicKey(priv)) }
  }
  const log: string[] = []
  const ROOT = b64h({ r: 'vt-parity-accused' })
  const KEY = tier2VerdictKey(ROOT)
  const LAD = 'chess:Blitz'
  const side = (acplMicro: number, matchMicro: number) => ({
    scored: 30, unscored: 0, acplMicro, matched: 0, matchMicro, clockFitMicro: 500_000, clockN: 30,
  })
  const entries = (prefix: string, acpl: number, match: number) =>
    Array.from({ length: 30 }, (_, i) => ({
      rec: {
        v: 1 as const, game: prefix + '-' + i, ladder: LAD, judge: b64h({ j: prefix + i }),
        params: PARAMS_A5_DIGEST, w: side(acpl, match), b: side(55_000_000, 400_000),
      },
      side: 'w' as const, elo: 1500,
    }))
  const judge = kp('vt-parity-judge')
  const conv = makeTier2Verdict({
    kind: 'verdict', root: ROOT, ladder: LAD, window: 3, entries: entries('pc', 2_000_000, 980_000),
    anchors: TIER2_ANCHORS_JUDGE, verdictWts: 5_000, signer: judge.pubB, key: judge.pubB, priv: judge.priv,
  })
  const dull = makeTier2Verdict({
    kind: 'verdict', root: ROOT, ladder: LAD, window: 9, entries: entries('pd', 61_000_000, 843_000),
    anchors: TIER2_ANCHORS_JUDGE, verdictWts: 5_000, signer: judge.pubB, key: judge.pubB, priv: judge.priv,
  })
  const sybil = kp('vt-parity-sybil')
  const impBody = {
    v: 1, kind: 'verdict', root: ROOT, ladder: LAD, window: 77, zMicro: 6_000_000,
    games: Array.from({ length: 30 }, (_, g) => 'pi-' + g),
    tier1: Array.from({ length: 30 }, (_, g) => b64h({ t: g })),
    anchors: tier2AnchorsDigest(TIER2_ANCHORS_JUDGE), params: PARAMS_A5_DIGEST, verdictWts: 1,
  }
  const imp = {
    body: impBody, signer: sybil.pubB, key: sybil.pubB,
    sig: toB64u(ed25519.sign(canonicalBytes(impBody as never), sybil.priv)),
  }
  for (const [tag, rec] of [
    ['conv', conv], ['dull', dull], ['imp', imp],
    ['tampered', { ...conv, body: { ...conv.body, zMicro: conv.body.zMicro + 1 } }],
    ['junk', { junk: true }],
  ] as const) {
    const c = checkVerdictRecord(rec)
    log.push(tag + ':' + c.verdict + ':' + (c.info ? (c.info.conviction ? 'C' : 'c') + (c.info.judgeAnchored ? 'J' : 'j') : '-'))
  }
  log.push('rowshape:' + isVerdictRowShaped({ v: 1, verdicts: [1] }) + ':' + isVerdictRowShaped({ v: 1, verdicts: [] }))
  const merge = makeVerdictMerge({ capPerRow: 2 })
  const rowOf = (...recs: unknown[]) => ({ v: 1, verdicts: recs }) as never
  const batches = [rowOf(conv), rowOf(dull, imp), rowOf(imp, conv, dull)]
  const permHashes: string[] = []
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
    let acc: never | null = null
    for (const i of order) acc = merge(acc, batches[i], 'record', KEY) as never
    permHashes.push(b64h(acc))
  }
  log.push('perm:' + permHashes.join(','))
  return toB64u(sha256(utf8(JSON.stringify(log))))
}
`

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
