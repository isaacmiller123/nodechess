// A6 M5 Lane L-t1 PROOF. The Tier-1 anticheat runner (judgeRunner.ts):
// after each rated game, drive the PINNED canonical judge over the signed
// transcript → the canonical JudgeOutput + per-game Tier1Record, feed the trust/
// escalation sink, and (A5-17 signing-time discipline) collect the anchored
// commit-reveal window salt from the canonical witness set.
//
//   node scripts/test-accounts-judge-runner.mjs
//
// The suite is engine-GATED like test-judge-node: the CI-safe sections drive
// runTier1ForGame end-to-end over a FAKE JudgeEngine (a spec-faithful UCI
// double: no WASM), proving the whole transcript→positions→judgeGame→
// tier1Record→sink pipeline + the salt-grant round-trip deterministically. The
// final section re-runs the SAME path over the REAL pinned Node judge WASM (the
// judge-parity binary) and asserts cross-run determinism; it is SKIPPED under CI
// / when the wasm is absent (engine-heavy suites are local-only).
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on any fail.

import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT, bundleAndImport, makeOutdir } from './lib/witness-bundle.mjs'

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`) }

const SRC = resolve(ROOT, 'src').replace(/\\/g, '/')
const SERVER = resolve(ROOT, 'server').replace(/\\/g, '/')
const ENGINE_JS = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.js')
const ENGINE_WASM = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.wasm')

// Bundle the runner (renderer, headless: it imports only @shared + the bare-node
// chess adapter + type-only siblings) alongside the shared substrate, the M1 Lane
// E writer/pregame (for the real-chain rated-game-keys proof), and the Node judge
// adapter (for the local-only engine gate).
const ENTRY = `
export * as jr from '${SRC}/renderer/src/features/account/net/judgeRunner.ts'
export * as core from '@shared/accounts/judge'
export * as W from '@shared/accounts/witness'
export * as A from '@shared/accounts'
export * as seg from '@shared/accounts/segment'
export * as wc from '@shared/mp/witnessCore'
export * as writer from '${SRC}/renderer/src/features/account/net/segmentWriter.ts'
export * as pregame from '${SRC}/renderer/src/features/account/net/preGame.ts'
export * as adapter from '${SERVER}/judge/nodeAdapter.ts'
`

async function main() {
  const outdir = makeOutdir('accounts-judge-runner-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

const NOW = 1_700_000_000_000
const BLITZ = { baseMs: 300_000, incMs: 2_000 } // 5+2 ⇒ Blitz; incMs credited in clock forensics
const LADDER = 'chess:Blitz'
const K = 30 // PARAMS_A5.reganK (asserted below)

// A fixed, fully-legal 10-ply Italian Game transcript (the "fixed transcript"
// the whole suite judges). Clocks are deterministic post-move snapshots.
const UCI = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3', 'd7d6']
function fixedTranscript() {
  return UCI.map((move, i) => ({ ply: i, move, clockMs: { w: 300_000 - i * 1_000, b: 300_000 - i * 900 } }))
}

async function run(M) {
  const { jr, core, W, A, seg, wc, writer, pregame, adapter } = M

  // A spec-faithful UCI double for JudgeEngine: answers the `isready` barrier with
  // `readyok`; on `go` emits multiPv info lines (ranks 1..multiPv) + a bestmove.
  // Ignores the FEN: the transcript pipeline + record math are what's under test,
  // so the SAME deterministic lines per position give a stable, reproducible
  // record without a real search (the engine gate below proves the WASM path).
  const RANKS = ['e2e4', 'd2d4', 'g1f3', 'b1c3', 'c2c4', 'g1e2']
  function makeFakeJudgeEngine(multiPv = core.PARAMS_A5.t1MultiPv) {
    const cbs = new Set()
    let closed = false
    const emit = (line) => queueMicrotask(() => { if (!closed) for (const cb of [...cbs]) cb(line) })
    return {
      send(cmd) {
        if (closed) throw new Error('fake judge engine is closed')
        if (cmd === 'isready') return emit('readyok')
        if (cmd.startsWith('go')) {
          for (let r = 1; r <= multiPv; r++)
            emit(`info depth 12 seldepth 15 multipv ${r} score cp ${40 - r * 2} nodes 1000 pv ${RANKS[r - 1]}`)
          emit(`bestmove ${RANKS[0]}`)
        }
      },
      onLine(cb) { cbs.add(cb); return () => cbs.delete(cb) },
      async close() { closed = true },
    }
  }
  const fakeFactory = () => Promise.resolve(makeFakeJudgeEngine())

  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }

  const HOST = kp(10), GUEST = kp(20)
  const GAME = seg.gameKey({ v: 1, t: 'game-key', w: HOST.pubB, b: GUEST.pubB, nonce: A.toB64u(kp(99).pub), ts: NOW })
  const gameView = { gameKey: GAME, players: { w: HOST.pubB, b: GUEST.pubB }, kind: 'chess', tc: BLITZ, moves: fixedTranscript() }

  // ==========================================================================
  section('0. params sanity (the salt window geometry this suite pins)')
  // ==========================================================================
  eq(core.PARAMS_A5.reganK, K, `PARAMS_A5.reganK === ${K} (the Regan window size)`)
  eq(core.PARAMS_A5.saltScheme, 'lease-threshold-v1', 'salt scheme is lease-threshold-v1')

  // ==========================================================================
  section('1. FEN-before replay + the bare-FEN verdict surface')
  // ==========================================================================
  const fens = jr.replayFensBefore(gameView.moves)
  ok(Array.isArray(fens) && fens.length === UCI.length, `replay produced ${UCI.length} fen-before positions`)
  eq(fens[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'ply 0 fen-before is the initial position')
  // Self-consistency: each next fen is exactly the adapter's replay of the prior.
  let chained = true
  for (let i = 1; i < fens.length; i++) if (jr.replayFensBefore(gameView.moves.slice(0, i))[i - 1] !== fens[i - 1]) chained = false
  ok(chained, 'the replayed fen chain is prefix-consistent (deterministic reconstruction)')
  const positions = core.transcriptToJudgePositions(gameView.moves, (i) => fens[i])
  ok(positions.length === UCI.length && positions.every((p, i) => p.ply === i && p.fen === fens[i] && p.moves === undefined),
    'transcriptToJudgePositions: every ply, bare-FEN, no moves/path field (the A5-01 verdict surface)')
  // An illegal transcript replays to null → honest skip (no partial positions).
  eq(jr.replayFensBefore([{ ply: 0, move: 'e2e5', clockMs: { w: 0, b: 0 } }]), null, 'an illegal move replays to null (fail-closed)')

  // ==========================================================================
  section('2. runTier1ForGame over the fixed transcript (fake engine) → Tier1Record + sink')
  // ==========================================================================
  let sunk = null
  const res = await jr.runTier1ForGame(gameView, { newJudgeEngine: fakeFactory, sink: (s) => { sunk = s } })
  ok(res.ok, 'runTier1ForGame produced a Tier-1 pass over the fixed transcript')
  const rec = res.record
  eq(rec.v, 1, 'record is a v1 Tier1Record')
  eq(rec.game, GAME, 'record names the game key')
  eq(rec.ladder, LADDER, 'record ladder = ladderId(chess, 5+2) = chess:Blitz')
  eq(rec.params, core.PARAMS_A5_DIGEST, 'record params echo names PARAMS_A5_DIGEST')
  eq(rec.judge, res.judgeDigest, 'record.judge === judgeOutputDigest(out)')
  ok(rec.w && rec.b, 'record carries BOTH sides (w + b) forensic signals')
  ok(['scored', 'unscored', 'acplMicro', 'matched', 'matchMicro', 'clockFitMicro', 'clockN'].every((k) => Number.isSafeInteger(rec.w[k])),
    'the white side carries all seven core integer signals')
  eq(res.tier1Digest, core.tier1Digest(rec), 'result.tier1Digest === tier1Digest(record)')
  // the sink fired with the exact signals
  ok(sunk && sunk.gameKey === GAME && sunk.tier1Digest === res.tier1Digest && sunk.record === rec, 'the trust/escalation SINK fired with the game signals')
  eq(res.out.config.nodes, core.PARAMS_A5.t1Nodes, 'the JudgeOutput echoes the true Tier-1 node config (tier1Record-acceptable)')
  eq(res.salt, undefined, 'no salt step supplied ⇒ no window-salt result')

  // ==========================================================================
  section('3. determinism: the SAME transcript ⇒ the SAME record bits')
  // ==========================================================================
  const res2 = await jr.runTier1ForGame(gameView, { newJudgeEngine: fakeFactory })
  eq(res2.tier1Digest, res.tier1Digest, 'a second run reproduces the tier1Digest bit-for-bit')
  eq(res2.judgeDigest, res.judgeDigest, 'a second run reproduces the judgeOutputDigest bit-for-bit')

  // A5-36 optional strength-trajectory slope: present iff a prior acpl window is
  // supplied for that side (else the record is byte-identical to the legacy one).
  const resTraj = await jr.runTier1ForGame(gameView, { newJudgeEngine: fakeFactory, priorAcplMicros: { w: [60_000_000, 55_000_000, 50_000_000] } })
  ok(resTraj.record.w.trajectoryMicro !== undefined, 'priorAcplMicros[w] ⇒ the record persists the A5-36 white trajectory slope')
  eq(resTraj.record.b.trajectoryMicro, undefined, 'the black side (no prior window) omits the trajectory slope (byte-identical legacy)')

  // ==========================================================================
  section('4. honest no-ops (no dead judge): non-chess / unrated / empty / illegal')
  // ==========================================================================
  eq((await jr.runTier1ForGame({ ...gameView, kind: 'go' }, { newJudgeEngine: fakeFactory })).reason, 'not-chess', 'a non-chess kind is an honest no-op')
  eq((await jr.runTier1ForGame({ ...gameView, tc: { baseMs: 0, incMs: 0 } }, { newJudgeEngine: fakeFactory })).reason, 'unrated', 'an Unlimited (unrated) time control is an honest no-op')
  eq((await jr.runTier1ForGame({ ...gameView, moves: [] }, { newJudgeEngine: fakeFactory })).reason, 'empty-transcript', 'an empty transcript is an honest no-op')
  eq((await jr.runTier1ForGame({ ...gameView, moves: [{ ply: 0, move: 'e2e5', clockMs: { w: 0, b: 0 } }] }, { newJudgeEngine: fakeFactory })).reason, 'replay-failed', 'an unreplayable transcript is an honest no-op')

  // ==========================================================================
  section('5. A5-17 window-salt geometry + collectWindowSalt over live witnesses')
  // ==========================================================================
  eq(jr.closedWindowIndex(0), null, 'no rated games ⇒ no window closed')
  eq(jr.closedWindowIndex(K), null, 'window 0 closes but has no jittered boundary / salt (null)')
  eq(jr.closedWindowIndex(K - 1), null, `${K - 1} games ⇒ mid-window, no close`)
  eq(jr.closedWindowIndex(2 * K), 1, `${2 * K} rated games ⇒ window 1 just closed`)
  eq(jr.closedWindowIndex(3 * K), 2, `${3 * K} rated games ⇒ window 2 just closed`)
  eq(jr.closedWindowIndex(2 * K + 1), null, 'a mid-window count crosses no boundary')

  // Three witnesses running the REAL witnessServe salt-grant discipline: each
  // signs window w's grant only when its own chain view shows the window closed
  // (ratedOrdinalOf ≥ (w+1)·K − 1) and the request carries the post-game anchor.
  const fabric = new W.MockFabric()
  const PARAMS_A2_DIGEST = W.PARAMS_A2_DIGEST
  function makeWitness(seedRoot, seedDev, ord) {
    const root = kp(seedRoot), device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    ep.announce(W.signPresence({ v: 1, root: root.pubB, key: device.pubB, caps: { witness: true, committee: true, shardMb: 200 }, params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 99 }, device.priv))
    const store = new W.MemoryWitnessStore()
    W.witnessServe(ep, { nodeId, key: device.pubB, priv: device.priv }, { store, wts: () => NOW, timeWindowMs: W.PARAMS_A2.timeWindowMs, ratedOrdinalOf: async () => ord })
    return { root, device, nodeId, ep }
  }
  // window 1 closes at ordinal (1+1)·K − 1 = 59, so a witness view at ord 59 grants.
  const w1 = makeWitness(30, 31, 59), w2 = makeWitness(40, 41, 59), w3 = makeWitness(50, 51, 59)
  const witnessSet = [w1.nodeId, w2.nodeId, w3.nodeId]
  const subjEp = fabric.endpoint(W.nodeIdOf(HOST.pub))
  // A fabricated ordered rated-game-key list long enough to anchor window 1
  // (windowAnchor reads ordinal 1·K − 1 = 29).
  const ratedKeys = Array.from({ length: 2 * K }, (_, i) => A.toB64u(A.sha256(A.utf8(`rated-game-${i}`))))

  const saltRes = await jr.collectWindowSalt(1, { fabric: subjEp, root: HOST.pubB, ladder: LADDER, witnessSet, ratedGameKeys: ratedKeys })
  ok(saltRes.ok, 'collectWindowSalt(1) assembled a threshold-proving reveal from the witnesses')
  eq(saltRes.window, 1, 'the reveal is for window 1')
  eq(saltRes.anchor, core.windowAnchor(ratedKeys, 1), 'the reveal anchor === windowAnchor(keys, 1) (A5-17 post-game commitment)')
  ok(saltRes.reveal.anchor === saltRes.anchor, 'the assembled reveal carries the anchor')
  ok(typeof saltRes.salt === 'string' && saltRes.salt.length === 43, 'a 32-byte windowSalt was derived (43-char b64u)')
  ok(saltRes.grantors >= 3, 'at least the threshold of distinct grantors signed')
  // independent re-verify under the same consensus opts reproduces the salt
  const reVerify = core.verifySaltReveal(saltRes.reveal, core.consensusSaltOpts(witnessSet))
  ok(reVerify.ok && reVerify.salt === saltRes.salt, 'an independent verifier re-derives the identical salt (parity)')

  // A5-17 discipline enforced: an ANCHORLESS reveal is rejected on the consensus
  // path: a predictable-before salt can never be blessed.
  const anchorless = { ...saltRes.reveal, anchor: undefined }
  ok(!core.verifySaltReveal(anchorless, core.consensusSaltOpts(witnessSet)).ok, 'an anchorless reveal is REJECTED (requireAnchor / §7b unpredictable-before)')

  // Honest degradation (C-10): a witness that never served + a small set where the
  // whole set is the pinned threshold ⇒ no salt (never a fabricated one).
  const noneRes = await jr.collectWindowSalt(1, { fabric: subjEp, root: HOST.pubB, ladder: LADDER, witnessSet: [W.nodeIdOf(kp(77).pub)], ratedGameKeys: ratedKeys })
  eq(noneRes.ok, false, 'no reachable witness ⇒ collectWindowSalt does not fabricate a salt')
  eq(noneRes.reason, 'salt-insufficient-grants', 'the shortfall is named (honest degradation)')
  const partialSet = [w1.nodeId, w2.nodeId, w3.nodeId, W.nodeIdOf(kp(78).pub)] // 4th never grants ⇒ pinned subset incomplete
  const partialRes = await jr.collectWindowSalt(1, { fabric: subjEp, root: HOST.pubB, ladder: LADDER, witnessSet: partialSet, ratedGameKeys: ratedKeys })
  eq(partialRes.ok, false, 'an incomplete canonical threshold subset ⇒ no salt (never a weaker one)')
  ok(partialRes.reason.startsWith('salt-verify'), 'the incomplete-subset failure is a typed verify error')

  // ==========================================================================
  section('6. ratedGameKeysForLadder over a REAL appended rated segment')
  // ==========================================================================
  // Build ONE real signed, witnessed, rated segment (the M1 Lane E path) and
  // prove the runner's rated-game-key extractor reads it exactly like the fold.
  const hostChain = A.createAccountChain({ rootPriv: HOST.priv, rootPub: HOST.pub, displayName: 'Hosty', ts: NOW, device: { pub: kp(11).pubB, index: 0, label: 'd' } })
  eq(jr.ratedGameKeysForLadder(hostChain, LADDER).length, 0, 'a fresh chain has no rated games')

  const hostDev = kp(11)
  const hostSigning = { root: HOST.pubB, key: hostDev.pubB, priv: hostDev.priv }
  // A dedicated fabric + a witness with a seedable handle for the append (lease +
  // attest): seed the host genesis head so the height-1 segment is admitted.
  const seedFabric = new W.MockFabric()
  function makeFullWitness(seedRoot, seedDev) {
    const root = kp(seedRoot), device = kp(seedDev)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = seedFabric.endpoint(nodeId)
    ep.announce(W.signPresence({ v: 1, root: root.pubB, key: device.pubB, caps: { witness: true, committee: true, shardMb: 200 }, params: PARAMS_A2_DIGEST, ts: NOW, uptimePct: 99 }, device.priv))
    const store = new W.MemoryWitnessStore()
    const handle = W.witnessServe(ep, { nodeId, key: device.pubB, priv: device.priv }, { store, wts: () => NOW, timeWindowMs: W.PARAMS_A2.timeWindowMs })
    return { root, device, nodeId, ep, handle }
  }
  const fw = makeFullWitness(60, 61)
  const hostEp = seedFabric.endpoint(W.nodeIdOf(HOST.pub))
  await fw.handle.seedHead(HOST.pubB, { id: A.witnessedHeadOf(hostChain.events).id, height: 0 })

  // A real WitnessCore terminal wstream over a short signed game (host wins on resign).
  const wcore = new wc.WitnessCore({ wpriv: fw.device.priv, wkey: fw.device.pubB, wroot: fw.root.pubB, now: () => NOW })
  wcore.init({ gameId: 1, gameKey: GAME, players: { w: { root: HOST.pubB, key: hostDev.pubB }, b: { root: GUEST.pubB, key: kp(21).pubB } }, firstMover: 'w', kind: 'chess', tc: BLITZ })
  let prev
  for (let i = 0; i < 4; i++) {
    const [priv, uci] = i % 2 === 0 ? [hostDev.priv, UCI[i]] : [kp(21).priv, UCI[i]]
    const m = seg.signMove(priv, GAME, i, uci, { w: 300_000, b: 300_000 }, prev)
    prev = m.sig
    wcore.feed({ t: 'move', gameId: 1, ply: i, uci, clockMs: { white: m.clockMs.w, black: m.clockMs.b }, sig: m.sig })
  }
  const transcript = seg.transcriptDigest(GAME, wcore.moves, '1-0', wc.REASON_RESIGN)
  const loserEsig = seg.signWitnessEnd(kp(21).priv, kp(21).pubB, GAME, '1-0', wcore.moves.length, transcript).sig
  wcore.feed({ t: 'resign', gameId: 1, by: 'black', esig: loserEsig })
  const wstream = wcore.wstream()

  const seg1 = await writer.buildAndPublishSegment({
    fabric: hostEp, chain: hostChain, signing: hostSigning, game: { gameKey: GAME, players: { w: HOST.pubB, b: GUEST.pubB }, moves: wcore.moves },
    color: 'w', result: '1-0', reason: wc.REASON_RESIGN, kind: 'chess', tc: BLITZ,
    wstream: { wkey: fw.device.pubB, sig: wstream.sig },
    opp: { root: GUEST.pubB, head: A.witnessedHeadOf(hostChain.events).id, height: 0, profile: { name: 'Guesty' } },
    wts: NOW,
  })
  ok(seg1.ok, 'a real rated segment was appended (M1 Lane E writer)')
  const keys = jr.ratedGameKeysForLadder(seg1.chain, LADDER)
  eq(keys.length, 1, 'ratedGameKeysForLadder finds exactly the one rated segment')
  eq(keys[0], GAME, 'the extracted rated-game key IS the played game')
  eq(jr.closedWindowIndex(keys.length), null, '1 rated game ⇒ no window closed (salt no-op)')

  // Integrated: runTier1ForGame WITH a salt block on this <2K-game chain ⇒ Tier-1
  // record produced, salt step correctly no-ops (no window closed).
  const integrated = await jr.runTier1ForGame(gameView, {
    newJudgeEngine: fakeFactory,
    salt: { fabric: hostEp, subjectRoot: HOST.pubB, chain: () => seg1.chain, witnessSet: [fw.nodeId] },
  })
  ok(integrated.ok, 'runTier1ForGame with a salt block still produces the Tier-1 record')
  eq(integrated.salt, undefined, 'the salt step no-ops when no window closed (the common per-game case)')

  fw.ep.close(); hostEp.close(); w1.ep.close(); w2.ep.close(); w3.ep.close(); subjEp.close()

  // ==========================================================================
  section('7. engine gate: the REAL pinned judge WASM reproduces the record (local-only)')
  // ==========================================================================
  if (process.env.CI) {
    console.log('  · SKIP under CI (engine-heavy suites are local-only, test-judge-node convention)')
  } else if (!existsSync(ENGINE_WASM)) {
    console.log('  · SKIP (pinned judge wasm not installed)')
  } else {
    // A SHORT transcript keeps the true-config (200k-node) run inside a local
    // budget; two fresh Node-adapter instances must reproduce the SAME record.
    const short = { ...gameView, moves: fixedTranscript().slice(0, 6) }
    const nodeFactory = () => adapter.newNodeJudgeEngine({ enginePath: ENGINE_JS, wasmPath: ENGINE_WASM })
    const r1 = await jr.runTier1ForGame(short, { newJudgeEngine: nodeFactory })
    ok(r1.ok, 'the real pinned judge produced a Tier-1 record over the transcript')
    const r2 = await jr.runTier1ForGame(short, { newJudgeEngine: nodeFactory })
    eq(r2.tier1Digest, r1.tier1Digest, 'two fresh real-WASM runs reproduce the identical tier1Digest (cross-run determinism)')
    eq(r2.judgeDigest, r1.judgeDigest, 'two fresh real-WASM runs reproduce the identical judgeOutputDigest')
    ok(r1.record.w.scored >= 1 && r1.record.b.scored >= 1, 'both sides have scored moves in the real judged record')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
