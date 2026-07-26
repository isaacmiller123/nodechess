// THE A6-M3 LANE L-view SUITE: the LIVE reconstruction viewing client, headless
// over MockFabric (spec §5 viewing flow, §2 checkpoint verification, §11 budgets;
// module: src/renderer/src/features/account/net/viewerClient.ts, which COMPOSES
// the frozen storage/viewer.ts substrate (resolveProfile + openHistory) and
// maps the verified view onto the profile-page UI shapes via store/derive.ts).
//
//   node scripts/test-accounts-viewer-client.mjs
//
// viewerClient is fabric-agnostic: the same resolve/map/history path that runs
// over Lane A's browser fabric in production runs here over an in-process
// MockFabric overlay, so the whole decision path is proven deterministic and
// offline. Sections:
//   1. pure units: isAccountRoot; checkpointCosigRule; buildEligibleWitnesses
//      over a live presence directory; gameRowsFromEvents; the empty-floor view.
//   2. THE PROOF: a subject with 24 witnessed games + 3 M-of-N-cosigned
//      checkpoints on a real overlay of holders (opponents publish segment
//      pointers, a friend a full-chain pointer, the duty carriers hold shards);
//      THE OWNER LEAVES; viewerClient resolves the subject over the viewer's
//      overlay → the full chain reconstructs BIT-FAITHFUL, the UiProfile maps
//      the real fold (name/bio/ladders/reputation/games/checkpoint), and the
//      lazy history pager delivers every game verified against the pinned head.
//   3. DEGRADED (§5/C-8). Carriers die below K_rec: viewerClient surfaces TYPED
//      temporary unavailability (status 'floor', honest report), NEVER a crash
//      and NEVER a fabricated profile; the mappers stay total; an injected
//      verified holder summary restores the profile fold on the floor; then the
//      carriers RETURN and reconstruction HEALS bit-faithful. Unavailability
//      was temporary.
//
// House style: esbuild-bundle on the fly (alias @shared; the renderer net module
// by abs path), one-line asserts, exit(1) on any fail.

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
const STORE = resolve(ROOT, 'src/renderer/src/features/account/store').replace(/\\/g, '/')

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as S from '@shared/accounts/storage'
export * as SEG from '@shared/accounts/segment'
export * as V from '${NET}/viewerClient'
export * as D from '${STORE}/derive'
`

async function main() {
  const outdir = makeOutdir('accounts-viewer-client-test')
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
  const { A, W, O, S, SEG, V, D } = M
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

  const NOW0 = 1_750_000_000_000
  let now = NOW0

  // 8 witnesses ground to DISTINCT /16 nodeId prefixes (M-of-N diversity, §2).
  const wits = []
  for (let i = 0; wits.length < 8 && i < 400; i++) {
    const kp = kpOf('vc-wit-' + i)
    const nodeId = W.nodeIdOf(kp.pub)
    const pfx = W.prefixBucket(nodeId, 16)
    if (!wits.some((w) => w.pfx === pfx)) wits.push({ ...kp, nodeId, pfx })
  }
  ok(wits.length === 8 && new Set(wits.map((w) => w.pfx)).size === 8, 'fixture: 8 witnesses with 8 distinct /16 prefixes')
  const RULE = { m: 4, n: 8, prefixDiversityMin: 3 }
  const attOf = (ev, w, wts) => ({ ...ev, wit: [W.makeAttestation(A.eventId(ev.body), 1, w.pubB, w.priv, wts)] })
  const attachLast = (chain, w, wts) => {
    const last = chain.events[chain.events.length - 1]
    return { root: chain.root, events: [...chain.events.slice(0, -1), attOf(last, w, wts)] }
  }

  // ==========================================================================
  console.log('\n· 1. pure units, root shape, cosig rule, eligibility, mappers …')
  // ==========================================================================
  {
    const realRoot = kpOf('vc-shape').pubB
    ok(V.isAccountRoot(realRoot), 'isAccountRoot accepts a 43-char b64u account root')
    ok(!V.isAccountRoot('mira#T8FQ2'), 'isAccountRoot rejects a fixture display handle (has #)')
    ok(!V.isAccountRoot(''), 'isAccountRoot rejects empty')
    ok(!V.isAccountRoot(realRoot + 'A'), 'isAccountRoot rejects an over-length key')

    const rule = V.checkpointCosigRule()
    eq(rule.m, W.PARAMS_A2.ckptM, 'checkpointCosigRule.m defaults to PARAMS_A2.ckptM')
    eq(rule.n, W.PARAMS_A2.ckptN, 'checkpointCosigRule.n defaults to PARAMS_A2.ckptN')
    ok(rule.prefixDiversityMin >= 3, 'checkpointCosigRule pins the /16 diversity floor (≥3)')
    eq(V.checkpointCosigRule({ m: 2 }).m, 2, 'checkpointCosigRule honors overrides')

    // buildEligibleWitnesses over a live presence directory: only WITNESS-capable
    // live presences enter, mapped signing-key → nodeId.
    const bus = new W.MockFabric({ staleAfterMs: 3_600_000 })
    const mkPresence = (kp, witness) =>
      W.signPresence(
        { v: 1, root: kp.pubB, key: kp.pubB, caps: { witness, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: now, uptimePct: 99 },
        kp.priv,
      )
    const wA = kpOf('vc-elig-a')
    const wB = kpOf('vc-elig-b')
    const nonWit = kpOf('vc-elig-c')
    bus.endpoint(W.nodeIdOf(wA.pub)).announce(mkPresence(wA, true))
    bus.endpoint(W.nodeIdOf(wB.pub)).announce(mkPresence(wB, true))
    bus.endpoint(W.nodeIdOf(nonWit.pub)).announce(mkPresence(nonWit, false))
    const elig = V.buildEligibleWitnesses(bus.endpoint(W.nodeIdOf(wA.pub)).directory(), now)
    eq(elig.size, 2, 'buildEligibleWitnesses admits exactly the witness-capable presences')
    eq(elig.get(wA.pubB), W.nodeIdOf(wA.pub), '…mapping each witness signing key to its nodeId')
    ok(!elig.has(nonWit.pubB), '…and excludes a presence that does not advertise the witness cap')

    // empty floor view + summary are total and honest.
    const ef = V.emptyFloorView(realRoot)
    eq(ef.status, 'floor', 'emptyFloorView is a floor view')
    eq(ef.segments.length, 0, 'emptyFloorView carries no segments')
    const av = V.summarizeAvailability(ef)
    ok(!av.available && av.reason === 'no-pointers', 'summarizeAvailability of the empty view is honestly unavailable (no-pointers)')
    const uiEmpty = V.viewToUiProfile(ef, { atWts: now })
    eq(uiEmpty.displayName, 'Unknown account', 'viewToUiProfile of an empty view is total (Unknown account, no throw)')
    eq(uiEmpty.games.length, 0, '…with no fabricated games')
    eq(uiEmpty.ladders.length, 0, '…and NO ladders: nothing recovered is not a fresh account')
    eq(uiEmpty.reputation, null, '…and no reputation: unknown conduct is never a score of 0')
    eq(uiEmpty.friendsCount, null, '…and no friend count: nothing counted the edges')
    ok(V.openAccountHistory(ef) === null, 'openAccountHistory is null when no head pinned (honest unavailability)')
  }

  // ==========================================================================
  console.log('\n· 2. THE PROOF: 24 games, owner gone, viewerClient reconstructs …')
  // ==========================================================================
  const subj = kpOf('vc-subject-root')
  const subDev = kpOf('vc-subject-dev')
  const NOPP = 14
  const opps = Array.from({ length: NOPP }, (_, i) => kpOf('vc-opp-' + i))
  const TC = { baseMs: 180_000, incMs: 0 } // a Blitz-ish clock so the a4 fold rates the games

  let chain = A.createAccountChain({
    rootPriv: subj.priv, rootPub: subj.pub, displayName: 'Reconstruct Subject', ts: NOW0,
    device: { pub: subDev.pubB, index: 0 },
  })
  chain = { root: chain.root, events: [attOf(chain.events[0], wits[0], NOW0 + 5), ...chain.events.slice(1)] }
  chain = A.appendPersonal(chain, subDev.priv, subDev.pubB, 'profile', { fields: { bio: 'first bio', country: 'NO' } }, NOW0 + 100)
  chain = A.appendPersonal(chain, subDev.priv, subDev.pubB, 'profile', { fields: { bio: 'They reconstructed me from shards.', flair: 'phoenix' } }, NOW0 + 200)

  const NGAMES = 24
  let t = NOW0 + 1000
  const wtsOfGame = []
  const segEvOfGame = []
  for (let g = 0; g < NGAMES; g++) {
    const w = wits[g % 8]
    const opp = opps[g % NOPP]
    const game = idLike('vc-game-' + g)
    const result = g % 3 ? '1-0' : '1/2-1/2'
    const color = g % 2 ? 'b' : 'w'
    const reason = 'resign'
    const transcript = SEG.transcriptDigest(game, [], result, reason)
    // A4 rated binding (§6): the witness terminal signature must cover kind/tc/
    // players/reason, players derived from (root, opp, color) exactly as
    // verifySegmentEvent reconstructs them: else 'bad-ladder-binding'.
    const players = color === 'w' ? { w: subj.pubB, b: opp.pubB } : { w: opp.pubB, b: subj.pubB }
    const binding = { kind: 'chess', tc: TC, players, reason }
    const payload = SEG.makeSegmentPayload({
      game, opp: opp.pubB, color, result, reason, moves: [],
      heads: { w: { head: idLike('vc-hw-' + g), height: 0 }, b: { head: idLike('vc-hb-' + g), height: 0 } },
      wstream: SEG.signWitnessEnd(w.priv, w.pubB, game, result, 0, transcript, binding),
      oppProfile: { name: 'Opp ' + (g % NOPP) }, kind: 'chess', tc: TC,
    })
    t += 60_000
    chain = attachLast(A.appendWitnessed(chain, subDev.priv, subDev.pubB, 'segment', payload, t), w, t + 500)
    wtsOfGame.push(t + 500)
    segEvOfGame.push(chain.events[chain.events.length - 1])
    if ((g + 1) % 8 === 0) {
      const ck = A.makeCheckpointEvent(chain, subDev.priv, subDev.pubB, t + 700)
      const atts = wits.slice(0, 5).map((cw, i) => W.cosignCheckpoint(ck, chain, cw.pubB, cw.priv, t + 700 + i))
      chain = A.appendEvent(chain, { body: ck.body, sig: ck.sig, wit: atts })
    }
  }
  const vrOrig = A.verifyChain(chain)
  ok(vrOrig.ok, 'the original 24-game chain fully verifies (fixture sanity)')
  const headEv = chain.events.reduce((best, e) => (e.body.lane === 'w' && (!best || e.body.height > best.body.height) ? e : best), null)
  const certsX = A.certsProving(subj.pubB, chain.events, [subDev.pubB])
  const chainBytes = A.chainToBytes(chain)
  const witnessedAll = chain.events.filter((e) => e.body.lane === 'w')
  const newestCkpt = chain.events.filter((e) => e.body.type === 'ckpt').reduce((b, e) => (!b || e.body.height > b.body.height ? e : b), null)

  // --- the network: NOPP opponent nodes + the subject + the 8 witness presences.
  const fabric = new W.MockFabric({ staleAfterMs: 3 * 3_600_000 })
  const CAP = 48
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

  // Announce the 8 witnesses as presence-only entries so the viewer's
  // directory-built eligibility (buildEligibleWitnesses) can confirm the
  // checkpoint's M-of-N cosigner set end-to-end.
  const witEps = wits.map((w) => {
    const ep = fabric.endpoint(w.nodeId)
    ep.announce(W.signPresence(
      { v: 1, root: w.pubB, key: w.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: now, uptimePct: 99 },
      w.priv,
    ))
    return ep
  })

  const oppNodes = opps.map((kp, i) => mkNode('opp-' + i, kp, kp))
  const subjectNode = mkNode('subject', subj, subDev, 0) // a phone: advertises no shard capacity
  const seedsFor = (i) => [0, 1, 2, 3, 5, 8, 11, 13].map((d) => oppNodes[(i + d) % NOPP].presence)
  for (let i = 0; i < oppNodes.length; i++) await oppNodes[i].node.bootstrap(seedsFor(i))
  await subjectNode.node.bootstrap(seedsFor(0))
  const subjectNodeId = W.nodeIdOf(subj.pub)

  // --- publish-on-write + pointers + final sync ---
  const storedEvents = await S.publishWitnessedEvents(subjectNode.node, subj.pubB, witnessedAll, certsX)
  ok(storedEvents > 0, 'publish-on-write landed the witnessed events on the closest carriers')
  const blobHash = shaB(chainBytes)
  // The freshest entanglement partners publish segment pointers. opp i's NEWEST
  // game is the largest g < NGAMES with g % NOPP === i (so the embedded segment's
  // payload.opp === holder: the anti-poisoning naming rule makeSegmentPointer enforces).
  for (let i = 0; i < NOPP; i++) {
    const g = i + NOPP < NGAMES ? i + NOPP : i
    await S.publishPointer(oppNodes[i].node, S.makeSegmentPointer({
      subject: subj.pubB, holder: opps[i].pubB, key: opps[i].pubB, priv: opps[i].priv,
      ts: wtsOfGame[g] + 1000, event: segEvOfGame[g], certs: certsX,
    }))
  }
  // A friend replicates the full chain.
  const friend = oppNodes[0]
  await S.publishPointer(friend.node, S.makeChainPointer({
    subject: subj.pubB, holder: opps[0].pubB, key: opps[0].pubB, priv: opps[0].priv,
    ts: wtsOfGame[NGAMES - 1] + 2000, event: headEv, certs: certsX, blobHash,
  }))
  const fs = await S.finalSync(subjectNode.node, chain, headEv, certsX, subDev.priv)
  eq(fs.header.n, 40, 'finalSync cuts the production N_shards=40 geometry')
  eq(fs.header.k, 12, '…with K_rec=12')

  const rowKeys = Array.from({ length: 40 }, (_, i) => S.shardKey(subjectNodeId, i))
  const holdersOfRow = (idx) => [...alive].filter((n) => n.node.localGet(rowKeys[idx], 'shard') !== null)
  const liveRowCount = () => rowKeys.reduce((acc, _, i) => acc + (holdersOfRow(i).length > 0 ? 1 : 0), 0)
  eq(liveRowCount(), 40, 'all 40 shard rows are live in shard space after the final sync')

  // --- snapshot the whole subject-relevant store per carrier (for the heal) ---
  const snapshots = []
  for (const n of alive) {
    if (n === subjectNode) continue
    const shards = []
    for (let i = 0; i < 40; i++) {
      const env = n.node.localGet(rowKeys[i], 'shard')
      if (env) shards.push({ idx: i, env: structuredClone(env) })
    }
    const pointers = n.node.localGet(S.pointerKeyOfRoot(subj.pubB), 'pointers')
    const events = n.node.localGet(subjectNodeId, 'events')
    snapshots.push({
      rootKp: n.root, keyKp: n.key,
      shards,
      pointers: pointers ? structuredClone(pointers) : null,
      events: events ? structuredClone(events) : null,
    })
  }

  // --- THE OWNER'S NODE LEAVES FOREVER ---
  await kill(subjectNode)
  ok(liveRowCount() === 40, 'shard space is intact without the owner (the network IS the storage)')

  // --- a FRESH viewer joins and reconstructs THROUGH viewerClient ---
  const viewerKp = kpOf('vc-viewer')
  const viewer = mkNode('viewer', viewerKp, viewerKp)
  await viewer.node.bootstrap(seedsFor(2))
  const view = await V.resolveAccountView(viewer.node, subj.pubB, {
    directory: viewer.ep.directory(), nowMs: now, rng: () => 0, // roll 0 < p → force the §2 spot-check
  })

  eq(view.status, 'expected', 'viewerClient resolve status: expected (full chain via the shard layer)')
  ok(view.chain !== undefined, 'the full chain reconstructed from shard space')
  eq(shaB(A.chainToBytes(view.chain)), shaB(chainBytes), 'THE PROOF: the reconstructed chain is BIT-FAITHFUL to the original bytes')
  eq(view.head?.id, A.eventId(headEv.body), 'the pinned head is the countersigned original')
  eq(view.ckptInfo?.mOfN, true, `the checkpoint carries a valid ${RULE.m}-of-${RULE.n} cosigner set (directory-built eligibility)`)
  ok(view.ckptInfo?.verified === 'deep', 'the forced spot-check re-derived the checkpoint from genesis')
  eq(canon(view.profile), canon(vrOrig.profile), "the profile fold matches the original chain's own fold")
  eq(view.segments.length, NGAMES, `ALL ${NGAMES} game segments recovered`)

  const avail = V.summarizeAvailability(view)
  ok(avail.available && avail.status === 'expected' && avail.mOfN, 'summarizeAvailability: available, expected, M-of-N confirmed')

  // --- the UI projection (what ProfilePage renders) is the real fold ---
  const ui = V.viewToUiProfile(view, { atWts: now })
  eq(ui.displayName, 'Reconstruct Subject', 'viewToUiProfile: the genesis display name surfaced')
  eq(ui.rootPub, subj.pubB, 'viewToUiProfile: the target root is carried verbatim')
  eq(ui.bio, 'They reconstructed me from shards.', 'viewToUiProfile: the LWW profile bio won (real fold)')
  eq(ui.country, 'NO', 'viewToUiProfile: the folded country field surfaced')
  eq(ui.reconstruction.path, 'expected', 'viewToUiProfile: reconstruction path expected')
  ok(!ui.reconstruction.revocationContested, 'viewToUiProfile: no revocation contest on a clean chain')
  eq(ui.checkpoint.mOfN, true, 'viewToUiProfile: the checkpoint renders as M-of-N cosigned')
  eq(ui.checkpoint.height, newestCkpt.body.height, 'viewToUiProfile: the checkpoint height is the real checkpoint event height')
  eq(ui.games.length, Math.min(NGAMES, V.VIEWER_GAMES_PREVIEW), 'viewToUiProfile: the head-card game preview is capped')
  ok(ui.games.every((g) => g.witnessed), 'viewToUiProfile: every previewed game is witnessed (attested segment)')
  // the ladders are EXACTLY the shared a4 fold over the reconstructed chain
  // (store/derive.ts), not a fabrication. The same fold the owner's own client runs.
  const foldLadders = D.deriveLadders(D.foldChainA4(view.chain), now)
  eq(canon(ui.ladders.map((l) => [l.key, l.state])), canon(foldLadders.map((l) => [l.key, l.state])), 'viewToUiProfile: ladders EXACTLY equal the shared a4 fold over the reconstructed chain')
  eq(ui.ladders.find((l) => l.key === 'Blitz').games, NGAMES, `viewToUiProfile: the a4 fold rated all ${NGAMES} Blitz games (ladders come from the real fold)`)

  // --- lazy history pages over the reconstructed view (openHistory) ---
  const pager = V.openAccountHistory(view)
  ok(pager !== null, 'openAccountHistory returns a pager anchored at the pinned head')
  let pagedGames = 0
  let pagesOk = true
  for (let i = 0; i < pager.pageCount; i++) {
    const p = await pager.page(i)
    if (p.ok) pagedGames += p.games
    else pagesOk = false
  }
  ok(pagesOk, 'every lazy page verifies against the pinned head')
  eq(pagedGames, NGAMES, `the pages deliver all ${NGAMES} games exactly once`)

  // ==========================================================================
  console.log('\n· 3. DEGRADED (§5/C-8), below K_rec → honest unavailability → HEAL …')
  // ==========================================================================
  // Kill EVERY carrier for the subject (small network → all-or-nothing rows):
  // the viewer must degrade honestly, never crash, never fabricate.
  for (const n of [...alive]) if (n !== viewer) await kill(n)
  eq(liveRowCount(), 0, 'every carrier died, no shard rows reachable')

  const down = await V.resolveAccountView(viewer.node, subj.pubB, { directory: viewer.ep.directory(), nowMs: now })
  eq(down.status, 'floor', 'below K_rec: viewerClient degrades to the floor (never wrong bytes)')
  ok(down.chain === undefined, 'no chain is served on the floor')
  const downAv = V.summarizeAvailability(down)
  ok(!downAv.available, 'summarizeAvailability: honestly UNAVAILABLE (nothing verified reached us)')
  ok(downAv.reason === 'no-pointers' || downAv.reason === 'no-rows', `…with a TYPED temporary-unavailability reason (${downAv.reason})`)
  eq(downAv.liveRows, 0, '…reporting 0 live shard rows honestly')
  // the mappers stay TOTAL on the degraded view. No crash, no fabricated profile
  const downUi = V.viewToUiProfile(down, { atWts: now })
  eq(downUi.displayName, 'Unknown account', 'viewToUiProfile stays total on the degraded view (no throw, no fake name)')
  eq(downUi.games.length, 0, '…and invents no games')
  ok(downUi.reconstruction.path === 'floor', '…flagging the floor path honestly')

  // The §5 guaranteed floor / A6 fast-path seam: a verified holder summary (the
  // friend still holds the chain) restores the profile surface even while the
  // shard layer is unreachable. The view never pretends the chain came back.
  const floorWithSummary = await V.resolveAccountView(viewer.node, subj.pubB, {
    directory: viewer.ep.directory(), nowMs: now, summaries: [S.buildHolderSummary(chain)],
  })
  eq(canon(floorWithSummary.profile), canon(vrOrig.profile), 'an injected verified holder summary restores the profile fold on the floor')
  eq(floorWithSummary.status, 'floor', '…without ever pretending the chain reconstructed')
  ok(V.summarizeAvailability(floorWithSummary).available, '…and the view is available again (the head pins from the summary)')

  // --- HEAL: the carriers RETURN (downtime, not loss) → bit-faithful again ---
  now += 1_800_000
  for (const snap of snapshots) {
    const rj = mkNode('rejoin-' + snap.rootKp.pubB.slice(0, 6), snap.rootKp, snap.keyKp)
    await rj.node.bootstrap([...alive].filter((n) => n !== rj).slice(0, 8).map((n) => n.presence))
    for (const { idx, env } of snap.shards) rj.node.localPut(rowKeys[idx], 'shard', env)
    if (snap.pointers) rj.node.localPut(S.pointerKeyOfRoot(subj.pubB), 'pointers', snap.pointers)
    if (snap.events) rj.node.localPut(subjectNodeId, 'events', snap.events)
  }
  ok(liveRowCount() >= 12, 'the returning carriers restore ≥ K_rec shard rows')
  const healed = await V.resolveAccountView(viewer.node, subj.pubB, { directory: viewer.ep.directory(), nowMs: now, rng: () => 0 })
  eq(healed.status, 'expected', 'after the carriers return, reconstruction succeeds again')
  eq(shaB(A.chainToBytes(healed.chain)), shaB(chainBytes), 'HEALED: bit-faithful after die → floor → return. The unavailability was TEMPORARY')
  eq(V.viewToUiProfile(healed, { atWts: now }).bio, 'They reconstructed me from shards.', 'the healed UiProfile carries the real folded profile again')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
