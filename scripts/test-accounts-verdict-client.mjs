// THE A6-M5 LANE (L-t2) SUITE: LIVE TIER-2 ANTICHEAT over a MockFabric overlay
// (spec §8 escalation/conviction, §9 ban term). Module:
//   src/renderer/src/features/account/net/verdictClient.ts
//
//   node scripts/test-accounts-verdict-client.mjs
//
// verdictClient COMPOSES the frozen Tier-2 substrate (judge/{tier2,embed,
// transport}.ts: all proven in test-accounts-tier2/embed/verdict-transport)
// onto a LIVE AccountPeer overlay; it reimplements no crypto, so this suite
// proves the WIRING end to end, fabric-suite style, exactly as it runs in the
// browser:
//   1. assessEscalation. The deterministic §8 trigger on OUR own chain-derived
//      window: a blatant window CONVICTS (5σ, deadline resolved), an honest
//      window is clear, a metering window ESCALATES (3σ) but is NEVER convicted
//      (A5-21: escalation obliges deeper analysis, never a ban);
//   2. the reproducible conviction verdict + the §8/§9 self-ban payload, and the
//      selfBanBlocksWitnessed gate (a conviction owes the self-ban BEFORE any
//      further witnessed event; escalation/honest never do);
//   3. THE LIVE SLICE: over a 16-node MockFabric overlay with the verdict store
//      gate installed, the accused self-audits → publishes its conviction row →
//      a peer fetches (getMerged) + adopts (A5-33 judge-pinned, re-verified from
//      its OWN window inputs); an HONEST window publishes NOTHING;
//   4. suppressionScan / verdictEvidence over the live overlay: a kept-playing
//      accused is SUPPRESSED (permanent ban injected), a compliant self-ban
//      discharges (no ban), a not-yet-due accused is pending;
//   5. createVerdictClient: the controller self-audits, publishes + self-bans
//      on conviction, and GATES a further witnessed append behind the §8
//      self-ban (guardBeforeWitnessed), degrading honestly when the ban cannot
//      be witnessed; an honest/escalated account never blocks and never bans.
//
// House style: esbuild-bundle on the fly (alias @shared; net module by abs
// path), one-line asserts, exit(1) on any fail. Test identities are RAW fixed
// 32-byte seeds → ed25519 (never argon2).

import { resolve } from 'node:path'
import { rmSync } from 'node:fs'
import { bundleAndImport, makeOutdir, ROOT } from './lib/witness-bundle.mjs'

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

const NET = resolve(ROOT, 'src/renderer/src/features/account/net').replace(/\\/g, '/')

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as J from '@shared/accounts/judge'
export * as T from '@shared/accounts/judge/transport'
export { PARAMS_A3, PARAMS_A3_DIGEST } from '@shared/accounts/storage/params'
export * as VC from '${NET}/verdictClient'
`

async function main() {
  const outdir = makeOutdir('accounts-verdict-client-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W, O, J, T, VC, PARAMS_A3, PARAMS_A3_DIGEST } = M
  const b64 = A.toB64u
  const b64h = (v) => b64(A.canonicalHash(v))
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    return { priv, pubB: b64(A.ed25519.getPublicKey(priv)) }
  }
  const recIdOf = (rec) => b64h(rec)

  const NOW = 1_770_000_000_000
  const K = J.PARAMS_A5.reganK
  const THR = J.PARAMS_A5.zThresholdMicro
  const ESC = J.PARAMS_A5.zEscalateMicro
  const MS_PER_DAY = 86_400_000
  const JA = J.TIER2_ANCHORS_JUDGE
  const LAD = 'chess:Blitz'

  // ---- fixtures: three z-bands under the JUDGE bundle (proven in transport) --
  const side = (acplMicro, matchMicro) => ({
    scored: 30, unscored: 0, acplMicro, matched: 0, matchMicro, clockFitMicro: 500_000, clockN: 30,
  })
  const mkRec = (game, acplMicro, matchMicro) => ({
    v: 1, game, ladder: LAD, judge: b64h({ j: game }), params: J.PARAMS_A5_DIGEST,
    w: side(acplMicro, matchMicro), b: side(55_000_000, 400_000),
  })
  // One ladder's chain-derived window: LadderGameRef[] + the Tier1Record map
  // (the L-t1 judgeRunner / a4 fold seam verdictClient consumes but never derives).
  const makeAudit = (root, prefix, acplMicro, matchMicro, n = K) => {
    const games = []
    const records = new Map()
    for (let i = 0; i < n; i++) {
      const game = `${prefix}-${i}`
      games.push({ game, side: 'w', elo: 1500 })
      records.set(game, mkRec(game, acplMicro, matchMicro))
    }
    return { root, ladder: LAD, games, records }
  }
  const BLATANT = [2_000_000, 980_000] // z ≥ 5σ (conviction)
  const HONEST = [61_000_000, 843_000] // z ≈ 0 (clear)
  const ESCAL = [40_000_000, 900_000] // 3σ ≤ z < 5σ (escalation, never a ban)

  console.log('· fixture z-bands under TIER2_ANCHORS_JUDGE …')
  const zEntries = (acpl, match) => Array.from({ length: K }, (_, i) => ({ rec: mkRec(`zf-${acpl}-${i}`, acpl, match), side: 'w', elo: 1500 }))
  const zB = J.aggregateZMicro(zEntries(...BLATANT), JA).zMicro
  const zH = J.aggregateZMicro(zEntries(...HONEST), JA).zMicro
  const zE = J.aggregateZMicro(zEntries(...ESCAL), JA).zMicro
  ok(zB >= THR, `blatant window convicts (z ${zB} ≥ ${THR})`)
  ok(zH < ESC, `honest window is clear (z ${zH} < ${ESC})`)
  ok(zE >= ESC && zE < THR, `metering window escalates but never convicts (z ${zE} ∈ [${ESC}, ${THR}))`)

  const accused = kpOf('vc-accused')
  const selfSigner = { root: accused.pubB, key: accused.pubB, priv: accused.priv }

  // ==========================================================================
  console.log('\n· 1. assessEscalation, the deterministic §8 trigger (pure) …')
  // ==========================================================================
  const convAudit = makeAudit(accused.pubB, 'cheat', ...BLATANT)
  const honestAudit = makeAudit(accused.pubB, 'fair', ...HONEST)
  const escalAudit = makeAudit(accused.pubB, 'meter', ...ESCAL)

  const aConv = VC.assessEscalation(convAudit)
  eq(aConv.disposition, 'convicted', 'a blatant window is CONVICTED (5σ)')
  ok(aConv.verdict.conviction !== undefined, '… the raw verdict carries the conviction report')
  ok(aConv.deadline !== null && aConv.deadline.source === 'trailingK', '… the §8 deadline is conviction-anchored on the trailing-K arm')
  eq(aConv.deadline.ordinal, K - 1, `… at the completing chain ordinal ${K - 1}`)
  eq(aConv.deadline.game, 'cheat-29', '… naming the conviction-completing game')

  const aHon = VC.assessEscalation(honestAudit)
  eq(aHon.disposition, 'honest', 'an honest window is CLEAR')
  eq(aHon.verdict.due, false, '… the trigger does not fire')
  eq(aHon.deadline, null, '… no deadline, no ban obligation, ever')

  const aEsc = VC.assessEscalation(escalAudit)
  eq(aEsc.disposition, 'escalate', 'a metering window ESCALATES (3σ)')
  eq(aEsc.verdict.due, true, '… the deeper-analysis trigger fires')
  eq(aEsc.verdict.conviction, undefined, '… but there is NO conviction (A5-21: escalation never bans)')
  eq(aEsc.deadline, null, '… so no self-ban deadline is produced')

  // The §8 self-ban gate (selfBanDueNow): only a conviction owes a self-ban.
  ok(VC.selfBanBlocksWitnessed(aConv, false), 'gate: a conviction with no self-ban BLOCKS further witnessed events (§8)')
  ok(!VC.selfBanBlocksWitnessed(aConv, true), 'gate: once the self-ban is appended, it no longer blocks')
  ok(!VC.selfBanBlocksWitnessed(aEsc, false), 'gate: a 3σ escalation NEVER blocks (an honest player is never banned)')
  ok(!VC.selfBanBlocksWitnessed(aHon, false), 'gate: an honest window NEVER blocks')

  // ==========================================================================
  console.log('\n· 2. the reproducible conviction verdict + the §8/§9 self-ban …')
  // ==========================================================================
  const win = VC.convictionWindow(convAudit, aConv.deadline)
  eq(win.entries.length, K, 'convictionWindow slices the full reganK window ending at the conviction ordinal')
  const verdict = VC.buildConvictionVerdict({ accusedRoot: accused.pubB, ladder: LAD, window: win, signer: selfSigner, verdictWts: NOW })
  eq(verdict.body.root, accused.pubB, 'the verdict names the accused root (publishes under its key)')
  eq(verdict.body.games.length, K, '… over a full reganK window (conviction-shaped)')
  ok(verdict.body.zMicro >= THR, `… whose recomputed zMicro convicts (${verdict.body.zMicro} ≥ ${THR})`)
  eq(J.verifyTier2Verdict(verdict, { entries: win.entries, anchors: JA }).ok, true, 'the built verdict is a valid recompute-from-inputs receipt')
  eq(T.verifyVerdictRecord(verdict), 'ok', '… and passes the transport store gate (conviction class)')

  const sb = VC.buildSelfBan({ verdict, convictionWts: NOW, window: win.window })
  eq(sb.payload.kind, 'anticheat', 'the self-ban payload is an anticheat self-ban')
  eq(sb.payload.ladder, LAD, '… on the convicted ladder')
  eq(sb.payload.verdict, J.tier2VerdictDigest(verdict.body), '… referencing the reproducible verdict digest')
  eq(sb.expiryWts, NOW + J.PARAMS_A5.selfBanDays * MS_PER_DAY, `… with a §9 ${J.PARAMS_A5.selfBanDays}-day expiry anchored on the conviction wts`)
  eq(sb.payload.expiryWts, sb.expiryWts, '… carried in the payload')

  // ==========================================================================
  console.log('\n· 3. THE LIVE SLICE. Publish → fetch → adopt over a 16-node overlay …')
  // ==========================================================================
  const fabric = new W.MockFabric()
  const mkNode = (tag, kp = kpOf(`vc-ov-${tag}`)) => {
    const dev = kpOf(`vc-ov-dev-${tag}`)
    const nodeId = W.nodeIdOf(kp.pubB)
    const ep = fabric.endpoint(nodeId)
    ep.announce(W.signPresence(
      { v: 1, root: kp.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
      dev.priv,
    ))
    const gate = VC.makeVerdictDutyGate()
    const node = O.createOverlayNode(ep, { root: kp.pubB, key: dev.pubB }, { nowMs: () => NOW, validator: gate.validator, merge: gate.merge })
    return { kp, dev, nodeId, ep, node }
  }
  // The accused's OWN overlay node (root = accused) + a wide fleet + a peer.
  const accusedNode = mkNode('accused', accused)
  const filler = Array.from({ length: 14 }, (_, i) => mkNode(`n${i}`))
  const peerNode = mkNode('peer')
  const all = [accusedNode, ...filler, peerNode]
  for (const n of all) await n.node.bootstrap()

  // The accused self-publishes its reproducible conviction under its own key.
  const pub = await VC.publishVerdictRows(accusedNode.node, [verdict])
  eq(pub.key, J.tier2VerdictKey(accused.pubB), 'publish targets the accused deterministic slot (tier2VerdictKey)')
  eq(pub.stored, PARAMS_A3.replicateK, `the conviction row lands on all replicateK=${PARAMS_A3.replicateK} carriers (gates accept the genuine row)`)

  // A peer fetches + adopts, re-verifying from ITS OWN window inputs (A5-33).
  const entriesForConv = (rec) => (rec.body.root === accused.pubB && rec.body.ladder === LAD ? win.entries : null)
  const ad = await VC.fetchAndAdoptVerdicts({ node: peerNode.node, subjectRoot: accused.pubB, entriesFor: entriesForConv })
  eq(ad.adopt.ok, true, 'peer adopt: the fetched conviction re-verifies from the peer’s own inputs (judge-pinned)')
  eq(ad.adopt.adopted.length, 1, '… the conviction record is adopted')
  eq(recIdOf(ad.adopt.adopted[0]), recIdOf(verdict), '… byte-identical to the published record')

  // §0: the SAME row refuted by an honest player's real inputs adopts NOTHING.
  const honestEntries = win.entries.map((e) => ({ ...e, rec: mkRec(e.rec.game, ...HONEST) }))
  const adRefute = await VC.fetchAndAdoptVerdicts({ node: peerNode.node, subjectRoot: accused.pubB, entriesFor: () => honestEntries })
  eq(adRefute.adopt.ok, false, '§0: mismatched (honest) inputs refute the z claim. Nothing adopts (no forgery)')
  eq(adRefute.adopt.adopted.length, 0, '… zero records adopted on refutation')

  // An HONEST window is NEVER published: its slot is empty over the network.
  const honestAccused = kpOf('vc-honest-accused')
  const fetchHonest = await VC.fetchAndAdoptVerdicts({ node: peerNode.node, subjectRoot: honestAccused.pubB, entriesFor: () => null })
  eq(fetchHonest.adopt.ok, false, 'an honest account has NO verdict row (nothing was ever published)')
  eq(fetchHonest.adopt.adopted.length, 0, '… honest window ⇒ none, end to end')

  // ==========================================================================
  console.log('\n· 4. suppressionScan / verdictEvidence over the live overlay …')
  // ==========================================================================
  // Synthetic accused chains (chain-shaped for the §8 absence scan; it consumes
  // the reader's ALREADY-VERIFIED chain; sigs are verifyChain's, not the scan's).
  const mkChain = (root) => {
    let h = 0
    const ev = (lane, type, payload) => ({ body: { v: 1, lane, type, root, key: root, height: h++, ts: 1_000 + h, payload }, sig: 'unchecked-by-scan' })
    return {
      seg: (game) => ev('w', 'segment', { game }),
      sb: (ladder) => ev('w', 'selfban', { kind: 'anticheat', ladder, window: win.window, expiryWts: sb.expiryWts, verdict: b64h({ d: 'v' }) }),
      prof: () => ev('p', 'profile', { fields: {} }),
    }
  }
  const eid = (ev) => A.eventId(ev.body)
  const convGame = 'cheat-29'

  // -- direct suppressionScan (the read-time auditor) ------------------------
  {
    const ch = mkChain(accused.pubB)
    const suppressed = [ch.seg('cheat-28'), ch.seg(convGame), ch.seg('after-1')]
    const s1 = VC.scanChainForSuppression(suppressed, convGame, LAD)
    eq(s1.kind, 'suppressed', 'scan: an accused that kept playing past the conviction game is SUPPRESSED')
    const compliant = (() => {
      const c = mkChain(accused.pubB)
      return VC.scanChainForSuppression([c.seg('cheat-28'), c.seg(convGame), c.sb(LAD)], convGame, LAD)
    })()
    eq(compliant.kind, 'compliant', 'scan: an accused whose next witnessed event is the self-ban is COMPLIANT')
    eq(compliant.selfBan.ladder, LAD, '… the discharging self-ban is on the convicted ladder')
    const pending = (() => {
      const c = mkChain(accused.pubB)
      return VC.scanChainForSuppression([c.seg('cheat-28'), c.seg(convGame), c.prof()], convGame, LAD)
    })()
    eq(pending.kind, 'pending', 'scan: a personal-lane-only tail is PENDING (§8 counts only the witnessed lane)')
  }

  // -- verdictEvidence over the overlay: fetch → adopt → §8 scan → ban input --
  {
    // The suppressed accused publishes both a 'verdict' + a 'suppression' record.
    const ch = mkChain(accused.pubB)
    const chainS = [ch.seg('cheat-28'), ch.seg(convGame), ch.seg('after-1'), ch.seg('after-2')]
    const scan = VC.scanChainForSuppression(chainS, convGame, LAD)
    const suppRec = VC.buildConvictionVerdict({
      accusedRoot: accused.pubB, ladder: LAD, window: win, signer: selfSigner, verdictWts: NOW,
      kind: 'suppression', deadlineEvent: scan.deadlineEvent,
    })
    await VC.publishVerdictRows(accusedNode.node, [verdict, suppRec])
    const ev = await VC.fetchBanEvidence({ node: peerNode.node, subjectRoot: accused.pubB, entriesFor: entriesForConv, chainEvents: chainS })
    ok(ev.evidence !== null, 'fetchBanEvidence returns the composed evidence over the overlay')
    eq(ev.evidence.adopt.adopted.length, 2, 'both the verdict + suppression records adopt (judge-pinned)')
    eq(ev.evidence.ladders[LAD]?.suppressed, true, 'the peer’s OWN §8 scan proves the suppression (5σ + chain-side absence)')
    eq(ev.evidence.ladders[LAD]?.ban?.until, Number.MAX_SAFE_INTEGER, 'suppression ⇒ PERMANENT distrust (§9) as the injected pairing/display ban input')
    eq(T.banEvidenceOf(ev.evidence, LAD)?.until, Number.MAX_SAFE_INTEGER, '… surfaced via banEvidenceOf for pairingLegal/displayState')
  }
  {
    // A COMPLIANT accused: real 5σ window, but the next witnessed event IS the
    // self-ban, §0: no suppression, no injected ban (the fold owns the term).
    const compliantAccused = kpOf('vc-compliant')
    const cSigner = { root: compliantAccused.pubB, key: compliantAccused.pubB, priv: compliantAccused.priv }
    const cAudit = makeAudit(compliantAccused.pubB, 'cc', ...BLATANT)
    const cAssess = VC.assessEscalation(cAudit)
    const cWin = VC.convictionWindow(cAudit, cAssess.deadline)
    const cVerdict = VC.buildConvictionVerdict({ accusedRoot: compliantAccused.pubB, ladder: LAD, window: cWin, signer: cSigner, verdictWts: NOW })
    const cCh = mkChain(compliantAccused.pubB)
    const chainC = [cCh.seg('cc-28'), cCh.seg('cc-29'), cCh.sb(LAD), cCh.seg('cc-30')]
    await VC.publishVerdictRows(accusedNode.node, [cVerdict])
    const evC = await VC.fetchBanEvidence({
      node: peerNode.node, subjectRoot: compliantAccused.pubB,
      entriesFor: (rec) => (rec.body.root === compliantAccused.pubB ? cWin.entries : null), chainEvents: chainC,
    })
    eq(evC.evidence.adopt.adopted.length, 1, 'the compliant client’s own conviction adopts (public data)')
    eq(evC.evidence.ladders[LAD]?.suppressed, false, '§0: the reader’s scan finds the COMPLIANT self-ban, no suppression')
    eq(T.banEvidenceOf(evC.evidence, LAD), undefined, '… so transport injects NO ban (an honest self-banned client is not defamed)')
  }

  // ==========================================================================
  console.log('\n· 5. createVerdictClient, the self-audit + §8 witnessed-append gate …')
  // ==========================================================================
  // A mock witnessed self-ban APPEND seam (the lead wires clientAppendWitnessed
  // under the live lease). It records what it was asked to append.
  const mkClient = (audits, appendResult, extra = {}) => {
    const appended = []
    let appendCalls = 0
    const handle = VC.createVerdictClient({
      root: accused.pubB,
      getNode: () => accusedNode.node,
      signer: () => selfSigner,
      ladderAudits: () => audits,
      appendSelfBan: async (build) => {
        appendCalls++
        appended.push(build)
        return appendResult
      },
      now: () => NOW,
      log: () => {},
      ...extra,
    })
    return { handle, appended, calls: () => appendCalls }
  }

  // -- convicted: self-audit publishes + appends the self-ban, then unblocks ---
  {
    const c = mkClient([makeAudit(accused.pubB, 'cheat', ...BLATANT)], { ok: true })
    const report = await c.handle.runSelfAudit()
    eq(report.ladders[0].disposition, 'convicted', 'controller: the blatant ladder is convicted')
    ok(report.ladders[0].verdictStored > 0, '… the conviction row was published over the live overlay')
    eq(report.ladders[0].selfBanAppended, true, '… and the §8 self-ban was appended (witnessed)')
    eq(c.appended.length, 1, 'the append seam was driven exactly once')
    eq(c.appended[0].payload.verdict, J.tier2VerdictDigest(verdict.body), '… with the payload referencing the reproducible verdict digest')
    eq(c.handle.getState().phase, 'self-banned', 'state phase: self-banned (the conviction is discharged)')
    const guard = await c.handle.guardBeforeWitnessed()
    eq(guard.blocked, false, 'guardBeforeWitnessed: a discharged conviction no longer blocks a further witnessed append')
  }

  // -- convicted but the ban can't be witnessed yet ⇒ honest WAIT (C-10) -------
  {
    const c = mkClient([makeAudit(accused.pubB, 'cheat', ...BLATANT)], { ok: false, reason: 'insufficient-witnesses' })
    const guard = await c.handle.guardBeforeWitnessed()
    eq(guard.blocked, true, 'guardBeforeWitnessed: a conviction whose self-ban cannot be witnessed BLOCKS (rated writes wait, C-10)')
    eq(guard.pending[0], LAD, '… naming the ladder still owing a self-ban')
    eq(c.handle.getState().phase, 'convicted', 'state phase: convicted (self-ban owed, not yet witnessed)')
    eq(c.calls(), 1, '… the append was attempted (honest degradation, not a crash)')
  }

  // -- convicted but the chain ALREADY carries the self-ban ⇒ never re-appended -
  {
    const c = mkClient([makeAudit(accused.pubB, 'cheat', ...BLATANT)], { ok: true }, { hasSelfBan: () => true })
    const report = await c.handle.runSelfAudit()
    eq(report.ladders[0].selfBanAppended, true, 'a conviction whose self-ban is already on-chain reads as discharged')
    eq(c.calls(), 0, '… and the append seam is NOT driven again (restart-idempotent, A5-22)')
    eq(report.banPending.length, 0, '… nothing is pending')
  }

  // -- honest: nothing published, nothing appended, never blocks --------------
  {
    const c = mkClient([makeAudit(accused.pubB, 'fair', ...HONEST)], { ok: true })
    const report = await c.handle.runSelfAudit()
    eq(report.ladders[0].disposition, 'honest', 'controller: an honest ladder is clear')
    eq(report.ladders[0].verdictStored, 0, '… nothing was published')
    eq(c.calls(), 0, '… no self-ban appended')
    eq(c.handle.getState().phase, 'clear', 'state phase: clear')
    eq((await c.handle.guardBeforeWitnessed()).blocked, false, 'an honest account never blocks a witnessed append')
  }

  // -- escalated (3σ): flagged for deeper analysis, but NEVER banned ----------
  {
    const c = mkClient([makeAudit(accused.pubB, 'meter', ...ESCAL)], { ok: true })
    const report = await c.handle.runSelfAudit()
    eq(report.ladders[0].disposition, 'escalate', 'controller: a metering ladder is flagged (3σ)')
    eq(c.calls(), 0, '… A5-21: escalation appends NO self-ban (an honest player is never banned)')
    eq(c.handle.getState().phase, 'flagged', 'state phase: flagged (deeper analysis only)')
    eq((await c.handle.guardBeforeWitnessed()).blocked, false, '… and never blocks a witnessed append')
  }

  // -- the singleton surface (honest signed-out default; start/stop) ----------
  {
    eq(VC.getVerdictClientState().phase, 'signed-out', 'the singleton reports an honest signed-out default when none is live')
    eq(VC.getVerdictClient(), null, '… and no handle')
    let notified = 0
    const unsub = VC.subscribeVerdictClient(() => notified++)
    const h = VC.startVerdictClientSingleton({
      root: accused.pubB, getNode: () => accusedNode.node, signer: () => selfSigner,
      ladderAudits: () => [makeAudit(accused.pubB, 'fair', ...HONEST)], appendSelfBan: async () => ({ ok: true }), now: () => NOW, log: () => {},
    })
    ok(VC.getVerdictClient() === h && notified > 0, 'startVerdictClientSingleton installs the handle + notifies subscribers')
    eq(VC.startVerdictClientSingleton({ root: accused.pubB, getNode: () => accusedNode.node, signer: () => selfSigner, ladderAudits: () => [], appendSelfBan: async () => ({ ok: true }) }), h, 'idempotent per root (same handle returned)')
    const guard = await VC.guardWitnessedAppend()
    eq(guard.blocked, false, 'guardWitnessedAppend: the honest singleton never blocks')
    VC.stopVerdictClientSingleton()
    eq(VC.getVerdictClient(), null, 'stop clears the singleton')
    eq((await VC.guardWitnessedAppend()).blocked, false, 'with no live client, the gate never blocks (signed out)')
    unsub()
  }

  for (const n of all) {
    await n.node.close()
    await n.ep.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
