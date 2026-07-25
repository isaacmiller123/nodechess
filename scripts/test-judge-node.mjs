// Headless test for the Node judge-WASM harness (server/judge/nodeEngine.ts +
// server/judge/contentHash.ts: phase A2 "Node harness for the pinned judge
// WASM", spec §11). This is the operator-peer / A5 prerequisite: prove the
// pinned single-thread Stockfish WASM runs UNDER NODE, deterministically, at
// fixed node counts.
//
//   node scripts/test-judge-node.mjs
//   CAPTURE=1 node scripts/test-judge-node.mjs   # print goldens, skip asserts
//
// Bundles the server/judge TS on the fly with esbuild (platform node), imports
// it from a temp dir, and drives:
//   (1) load the WASM under node, run a fixed-node MultiPV search, parse it;
//   (2) DETERMINISM GATE: same FEN + same fixed nodes yields BIT-IDENTICAL
//       search output across (a) two fresh instances, (b) a warm instance after
//       analysing OTHER positions first (ucinewgame + Clear Hash between, spec
//       §8 "replay-after-warmup identical"), (c) recorded golden vectors for
//       three fixed FENs at a fixed node count (future-run / cross-machine gate);
//   (3) the content-hash constant matches the shipped wasm AND equals the
//       digest-attested PARAMS_A5.judgeWasmSha256 (A5-12: single pin; node
//       gate, web gate and the params echo can never silently diverge).
//
// Style: failures counter, section banners, per-assert one-line, exit(failures?1:0).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
// A5-31: the J6 browser ENGINE gate re-judges this 3-position SUBSET (not the
// frozen 9-set); imported here so the subset-boundary section can pin the
// coverage split executably, with the fixture as the single source of the set.
import { JUDGE_PARITY_POSITIONS } from './lib/accounts-fixture.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const JUDGE = resolve(ROOT, 'server/judge').replace(/\\/g, '/')
const WEBJUDGE = resolve(ROOT, 'src/web/engines').replace(/\\/g, '/')
const ENGINE_JS = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.js')
const ENGINE_WASM = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.wasm')
const CAPTURE = !!process.env.CAPTURE

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
function section(t) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}
async function rejects(p, msg) {
  try {
    await p
    ok(false, `${msg} (did not reject)`)
  } catch {
    ok(true, msg)
  }
}
/** Race a promise against a hang-guard so a regressed (hanging) path FAILS
 *  loudly with a TIMEOUT:<label> rejection instead of stalling the suite. The
 *  guard timer is kept REF'd (and cleared the instant `p` settles) so a real
 *  hang fires the timeout. An unref'd timer would let node exit prematurely. */
function withTimeout(p, ms, label) {
  let t
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`TIMEOUT:${label}`)), ms)
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(t))
}

// ---- fixtures ---------------------------------------------------------------
const N = 100000 // fixed node cap: modest so the suite runs well under a minute
const MPV = 3
const HASH = 16

// Deterministic-surface canonicalization of an AnalysisResult: search-determined
// fields only (NO time/nps: those never enter AnalysisLine). This is the exact
// byte surface the determinism gate compares and freezes as goldens.
function canon(r) {
  const lines = r.lines.map((l) => {
    const score = l.mate !== undefined ? `mate ${l.mate}` : `cp ${l.scoreCp}`
    const bound = l.bound ? ` ${l.bound}bound` : ''
    return `mpv${l.multipv} d${l.depth} sd${l.seldepth} ${score}${bound} nodes${l.nodes} pv ${l.pv.join(' ')}`
  })
  lines.push(`bestmove ${r.bestmove}${r.ponder ? ` ponder ${r.ponder}` : ''}`)
  return lines.join('\n')
}

const FENS = {
  sicilian: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
  kiwipete: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  endgame: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
}

// Golden canonical outputs at (nodes=N, MultiPV=MPV, Hash=HASH). Recorded from a
// green run of the pinned WASM (content hash below); a future run on any machine
// that produces different bits fails this gate (spec §8 determinism claim).
const GOLDENS = {
  sicilian:
    'mpv1 d13 sd21 cp 37 upperbound nodes100098 pv g1f3 e7e6\n' +
    'mpv2 d12 sd21 cp 33 nodes100098 pv d2d4 c5d4 g1f3 b8c6 f3d4 g8f6 b1c3 e7e6 d4c6 b7c6 e4e5 f6d5 c3e4 d8c7 d1h5 f8e7 f1d3\n' +
    'mpv3 d12 sd19 cp 32 nodes100098 pv b1c3 b8c6 g1e2 e7e6 d2d4 c5d4 e2d4 f8e7 c1e3 g8f6 f1d3 e8g8\n' +
    'bestmove g1f3 ponder e7e6',
  kiwipete:
    'mpv1 d11 sd20 cp -139 upperbound nodes100006 pv e2a6 h3g2\n' +
    'mpv2 d10 sd15 cp -163 nodes100006 pv d5e6 a6e2 c3e2 e7e6 d2f4 c7c5 e1g1 d7d6 e5d3 f6e4\n' +
    'mpv3 d10 sd15 cp -262 nodes100006 pv c3b5 a6b5 e2b5 e6d5 e5c6 e7e4 e1d1 d7c6 b5c6 e8f8 c6a8 b6a8\n' +
    'bestmove e2a6 ponder h3g2',
  endgame:
    'mpv1 d12 sd27 cp 87 upperbound nodes100070 pv b4f4 h4g3\n' +
    'mpv2 d11 sd19 cp 37 nodes100070 pv e2e3 h5c5 b4f4 h4g3 a5a6 g3g2 e3e4 g2g3 f4f5 g3g4\n' +
    'mpv3 d11 sd23 cp 16 nodes100070 pv b4c4 h5c5 c4f4 h4g3 f4f3 g3g2 a5a6 c5c2 f3f7 g2g3 e2e4 c2c5\n' +
    'bestmove b4f4 ponder h4g3',
}
// Frozen INDEPENDENT record of the §8 pin (deliberately this file's own
// literal, golden-style): contentHash.ts derives its constant from
// PARAMS_A5.judgeWasmSha256 (A5-12), so these goldens transitively pin the
// digest-attested params value too: a re-pin must consciously touch BOTH
// params.ts and this freeze.
const GOLDEN_WASM_SHA256 = 'a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1'
const GOLDEN_WASM_BYTES = 7295411

// ---- A5 J1 fixtures: the canonical judged-game protocol ---------------------
// Fixed 9-position judged set (opening / middlegame / endgame / mate-in-N /
// forced single reply), exercised as FEN+moves. This exact set at the TRUE
// PARAMS_A5 Tier-1 config is the NODE cross-run / cross-machine parity anchor:
// its digest is FROZEN below (GOLDEN_T1_DIGEST) and pins all nine positions on
// node. NOTE: J6's browser ENGINE gate does NOT reproduce this frozen digest.
// It re-judges only a 3-position SUBSET (JUDGE_PARITY_POSITIONS in
// scripts/lib/accounts-fixture.mjs; plies 4/20/60) and asserts LIVE
// browser==node digest parity for that subset (local-only, skipped under CI).
// So plies 6/16/40/50 and the Réti mate-in-2 (ply 70) + K<multiPv single-reply
// (ply 80) paths are pinned on NODE only. The subset boundary is made
// executable below (see the 'A5-31 J6 browser-parity subset boundary' section).
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const JUDGE_POSITIONS = [
  // opening, via the `position fen ... moves ...` path
  { ply: 4, fen: START_FEN, moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6'] },
  { ply: 6, fen: START_FEN, moves: ['d2d4', 'g8f6', 'c2c4', 'e7e6', 'b1c3', 'f8b4'] },
  // middlegame: closed Ruy by moves, and kiwipete by FEN
  {
    ply: 16,
    fen: START_FEN,
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'd7d6', 'c2c3', 'e8g8'],
  },
  { ply: 20, fen: FENS.kiwipete },
  // endgames
  { ply: 40, fen: FENS.endgame },
  { ply: 50, fen: '8/8/4k3/8/8/4K3/4P3/8 w - - 0 1' },
  // mate-in-1 (Re8#). Exercises the distinct mate encoding at rank 1
  { ply: 60, fen: '1k6/ppp5/8/8/8/8/8/K3R3 w - - 0 1' },
  // Réti's mate-in-2 (Qd8+! Bxd8 Re8#). A deeper forced mate among cp ranks
  { ply: 70, fen: 'r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 1 0' },
  // in check with exactly ONE legal reply (Kxe2). K < multiPv contiguity path
  { ply: 80, fen: '4k3/8/8/8/8/8/4q3/4K3 w - - 0 1' },
]

// FROZEN GOLDEN: judgeOutputDigest of JUDGE_POSITIONS at the TRUE Tier-1
// config (judgeConfigForTier(1): 200_000 nodes, MultiPV 4, Hash 16, per-game
// TT reset). Recorded from a green run of the pinned wasm (content hash
// above); this is the NODE-only cross-run / cross-machine anchor for all nine
// positions. The J6 browser gate does NOT assert this value. It proves LIVE
// browser==node parity over the 3-position JUDGE_PARITY_POSITIONS subset only
// (see the subset-boundary section below). Re-freeze ONLY on a deliberate
// PARAMS_A5 / schema change.
const GOLDEN_T1_DIGEST = 'F7XHAGNBkIR_2l6H7J8-Y2JTOOFj5SBtyYGvPAFIl3s'

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/judge-node-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${
      failures ? `, ${failures} failures` : ''
    }`,
  )
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  console.log('· bundling server/judge (nodeEngine/contentHash) …')
  const entry = resolve(outdir, 'entry.ts')
  const SHARED_JUDGE = resolve(ROOT, 'src/shared/accounts/judge').replace(/\\/g, '/')
  writeFileSync(
    entry,
    [
      `export * as engine from '${JUDGE}/nodeEngine.ts'`,
      `export * as content from '${JUDGE}/contentHash.ts'`,
      `export * as core from '${SHARED_JUDGE}/index.ts'`,
      `export * as adapter from '${JUDGE}/nodeAdapter.ts'`,
      `export * as web from '${WEBJUDGE}/judge.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, 'judge.mjs')
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
  const { engine, content, core, adapter, web } = M

  // Explicit paths: the bundle's default (package) resolution can't see
  // node_modules from a temp dir, so every call is given the real engine/wasm.
  const mk = () => engine.newInstance({ enginePath: ENGINE_JS, wasmPath: ENGINE_WASM })

  // ── (3) content hash ──────────────────────────────────────────────────────
  section('content hash (spec §8 binary pin)')
  const v = content.verifyWasmHash(ENGINE_WASM)
  eq(v.sha256, GOLDEN_WASM_SHA256, 'computed sha256 matches shipped wasm')
  eq(v.bytes, GOLDEN_WASM_BYTES, 'computed byte length matches shipped wasm')
  eq(content.JUDGE_WASM_SHA256, GOLDEN_WASM_SHA256, 'exported JUDGE_WASM_SHA256 constant is correct')
  eq(content.JUDGE_WASM_BYTES, GOLDEN_WASM_BYTES, 'exported JUDGE_WASM_BYTES constant is correct')
  ok(v.ok, 'verifyWasmHash() ok === true for the shipped wasm')
  // A5-12 regression. The two production pins are ONE: contentHash.ts derives
  // JUDGE_WASM_SHA256 from PARAMS_A5.judgeWasmSha256 (the copy folded into
  // PARAMS_A5_DIGEST that every verdict attests). A re-pin that edits the
  // shipped wasm + this file's goldens but not params.ts fails the live check
  // below; a revert to an independent literal in contentHash.ts fails the
  // equality. Both run in CI (build.yml runs this suite).
  eq(
    content.JUDGE_WASM_SHA256,
    core.PARAMS_A5.judgeWasmSha256,
    'A5-12: JUDGE_WASM_SHA256 === PARAMS_A5.judgeWasmSha256 (node pin IS the attested pin)',
  )
  eq(
    v.sha256,
    core.PARAMS_A5.judgeWasmSha256,
    'A5-12: shipped wasm sha256 === PARAMS_A5.judgeWasmSha256 (attested pin matches the real blob)',
  )
  // assertWasmHash throws on a wrong path (uses THIS test file as a decoy blob)
  await rejects(
    Promise.resolve().then(() => content.assertWasmHash(fileURLToPath(import.meta.url))),
    'assertWasmHash throws on a non-matching file',
  )

  // ── (1) load + fixed-node MultiPV search under node ───────────────────────
  section('load + fixed-node search under node')
  const inst = await mk()
  const r0 = await inst.analyseFixedNodes(FENS.sicilian, { nodes: N, multipv: MPV, hashMb: HASH })
  ok(!!r0.bestmove && /^[a-h][1-8][a-h][1-8]/.test(r0.bestmove), `got a legal-shaped bestmove (${r0.bestmove})`)
  eq(r0.lines.length, MPV, `got ${MPV} MultiPV lines`)
  ok(
    r0.lines.every((l) => l.scoreCp !== undefined || l.mate !== undefined),
    'every line carries a cp or mate score',
  )
  ok(
    r0.lines.every((l, i) => l.multipv === i + 1),
    'lines are ranked 1..MultiPV in order',
  )
  ok(r0.lines.every((l) => l.pv.length >= 1), 'every line carries a non-empty pv')

  // hashMb guard (spec §8: Hash ≤ 16MB)
  await rejects(
    inst.analyseFixedNodes(FENS.sicilian, { nodes: N, multipv: MPV, hashMb: 32 }),
    'analyseFixedNodes rejects hashMb > 16',
  )
  await inst.quit()

  // ── (2a) two fresh instances, same input → identical bits ─────────────────
  section('determinism: two fresh instances')
  const a = await mk()
  const ca = canon(await a.analyseFixedNodes(FENS.sicilian, { nodes: N, multipv: MPV, hashMb: HASH }))
  await a.quit()
  const b = await mk()
  const cb = canon(await b.analyseFixedNodes(FENS.sicilian, { nodes: N, multipv: MPV, hashMb: HASH }))
  await b.quit()
  eq(cb, ca, 'fresh-instance A == fresh-instance B (bit-identical)')

  // ── (2b) warm instance, ucinewgame + Clear Hash between → identical ───────
  section('determinism: warm instance (TT-clear replay, spec §8)')
  const w = await mk()
  // pollute the engine with unrelated searches at different nodes/MultiPV first
  await w.analyseFixedNodes(FENS.kiwipete, { nodes: 63211, multipv: 5, hashMb: HASH })
  await w.analyseFixedNodes(FENS.endgame, { nodes: 41000, multipv: 2, hashMb: HASH })
  const cw = canon(await w.analyseFixedNodes(FENS.sicilian, { nodes: N, multipv: MPV, hashMb: HASH }))
  await w.quit()
  eq(cw, ca, 'warm-after-other-positions == fresh (TT cleared, replay identical)')

  // ── (2c) golden vectors for three fixed FENs ──────────────────────────────
  section('determinism: recorded golden vectors')
  for (const name of Object.keys(FENS)) {
    const g = await mk()
    const c = canon(await g.analyseFixedNodes(FENS[name], { nodes: N, multipv: MPV, hashMb: HASH }))
    await g.quit()
    if (CAPTURE) {
      console.log(`\n[GOLDEN ${name}]\n${c}\n`)
      continue
    }
    eq(c, GOLDENS[name], `golden vector "${name}" reproduced bit-for-bit`)
  }

  // ═══ A5 J1: the canonical judged-game protocol ═══════════════════════════
  // TEST-ONLY node trims for the runtime budget: `nodes` ONLY may differ from
  // PARAMS_A5 (multiPv/hashMb/ttReset stay pinned); the FROZEN GOLDEN below
  // runs at the TRUE judgeConfigForTier(1). PARAMS_A5 itself is never changed.
  const TEST_T1 = { tier: 1, nodes: 30000, multiPv: core.PARAMS_A5.t1MultiPv, hashMb: core.PARAMS_A5.hashMb, ttReset: 'per-game' }
  const TEST_T2 = { tier: 2, nodes: 60000, multiPv: core.PARAMS_A5.t2MultiPv, hashMb: core.PARAMS_A5.hashMb, ttReset: 'per-game' }
  const mkJudge = () => adapter.newNodeJudgeEngine({ enginePath: ENGINE_JS, wasmPath: ENGINE_WASM })
  /** raw-UCI arbitrary prior use: pollute an instance outside the judge protocol. */
  const pollute = async (eng) => {
    const best = new Promise((res) => {
      const off = eng.onLine((l) => {
        if (l.startsWith('bestmove')) {
          off()
          res(l)
        }
      })
    })
    eng.send('setoption name MultiPV value 2')
    eng.send(`position fen ${FENS.kiwipete}`)
    eng.send('go nodes 50000')
    await best
  }

  section('J1 judge core: config derivation + digest (pure)')
  const t1 = core.judgeConfigForTier(1)
  const t2 = core.judgeConfigForTier(2)
  eq(t1.nodes, core.PARAMS_A5.t1Nodes, 'tier-1 config nodes = PARAMS_A5.t1Nodes')
  eq(t1.multiPv, core.PARAMS_A5.t1MultiPv, 'tier-1 config multiPv = PARAMS_A5.t1MultiPv')
  eq(t2.nodes, core.PARAMS_A5.t2Nodes, 'tier-2 config nodes = PARAMS_A5.t2Nodes')
  eq(t2.multiPv, core.PARAMS_A5.t2MultiPv, 'tier-2 config multiPv = PARAMS_A5.t2MultiPv')
  ok(t1.hashMb === core.PARAMS_A5.hashMb && t2.hashMb === core.PARAMS_A5.hashMb, 'both tiers pin hashMb = PARAMS_A5.hashMb')
  ok(t1.ttReset === 'per-game' && t2.ttReset === 'per-game', "both tiers pin ttReset = 'per-game'")
  const echoA = { nodes: 1, multiPv: 2, hashMb: 16, params: core.PARAMS_A5_DIGEST }
  const outKeyOrder1 = { v: 1, config: echoA, positions: [{ ply: 0, lines: [{ move: 'e2e4', cp: 30 }] }] }
  const outKeyOrder2 = { positions: [{ lines: [{ cp: 30, move: 'e2e4' }], ply: 0 }], config: { params: core.PARAMS_A5_DIGEST, hashMb: 16, multiPv: 2, nodes: 1 }, v: 1 }
  eq(core.judgeOutputDigest(outKeyOrder1), core.judgeOutputDigest(outKeyOrder2), 'digest is key-order independent (canonical bytes)')
  const outMate = { v: 1, config: echoA, positions: [{ ply: 0, lines: [{ move: 'e2e4', mate: 30 }] }] }
  ok(core.judgeOutputDigest(outKeyOrder1) !== core.judgeOutputDigest(outMate), 'cp 30 and mate 30 encode DISTINCTLY (different digests)')

  // ═══ A5-31: J6 browser-parity SUBSET boundary (pure, no engine) ═══════════
  // Make executable exactly what the J6 browser ENGINE gate proves, so the
  // fixture comments above can never silently over-claim it again. The browser
  // (test-web-accounts-browser.mjs) re-judges only JUDGE_PARITY_POSITIONS. A
  // 3-position SUBSET of the frozen 9-set, and asserts LIVE browser==node
  // parity for it (skipped under CI); it NEVER reproduces the frozen 9-position
  // GOLDEN_T1_DIGEST, which is a NODE-only anchor. A revert of the comments to
  // "browser asserts the SAME 9-position digest" is contradicted by these
  // facts, and any drift that shrinks the node-only coverage fails here too.
  section('A5-31 J6 browser-parity subset boundary (pure)')
  {
    const canonPos = (p) => `${p.ply}|${p.fen}|${(p.moves || []).join(' ')}`
    eq(JUDGE_POSITIONS.length, 9, 'node freezes the FULL 9-position set (GOLDEN_T1_DIGEST anchor)')
    eq(JUDGE_PARITY_POSITIONS.length, 3, 'browser ENGINE gate re-judges only a 3-position subset')
    ok(
      JUDGE_PARITY_POSITIONS.length < JUDGE_POSITIONS.length,
      'browser parity set is a STRICT subset: the browser never covers the full 9',
    )
    // each parity position is byte-identical to its 9-set counterpart (same
    // ply/fen/moves), so the live browser==node comparison judges the SAME
    // inputs the node golden froze: not a re-parameterised look-alike.
    const byPly = new Map(JUDGE_POSITIONS.map((p) => [p.ply, canonPos(p)]))
    for (const p of JUDGE_PARITY_POSITIONS) {
      ok(byPly.get(p.ply) === canonPos(p), `parity ply ${p.ply} is byte-identical to the frozen 9-set entry`)
    }
    // the node-ONLY positions (never exercised through the web adapter) MUST
    // still include the two paths unique to the 9-set the finding flags: Réti
    // mate-in-2 (ply 70) and the K<multiPv single-legal-reply (ply 80).
    const parityPlies = new Set(JUDGE_PARITY_POSITIONS.map((p) => p.ply))
    const nodeOnly = JUDGE_POSITIONS.map((p) => p.ply).filter((x) => !parityPlies.has(x))
    eq(nodeOnly.join(','), '6,16,40,50,70,80', 'node-only plies are exactly {6,16,40,50,70,80}')
    ok(
      nodeOnly.includes(70) && nodeOnly.includes(80),
      'Réti mate-in-2 (70) + K<multiPv single-reply (80) are pinned on NODE only',
    )
  }

  // ═══ A5-23: web adapter fail-closed parity (engine-free, fake Worker) ═════
  // The web adapter (src/web/engines/judge.ts) must fail-closed like the node
  // adapter: close()/worker-death REJECTS an in-flight judgeGame (via onError),
  // and a send() after close THROWS. Never the silent no-op that left the
  // barrier/analyseOne awaiting a `readyok`/`bestmove` forever. Driven through
  // the REAL judgeGame() over a spec-faithful fake Worker (terminate() fires NO
  // events, per the HTML spec), so a revert to the pre-fix close()/send() is
  // caught here without a browser or an engine.
  section('J1 web adapter A5-23: close()/post-close fail-closed (fake Worker)')
  {
    const MPV = core.PARAMS_A5.t1MultiPv
    const CFG = { tier: 1, nodes: 1000, multiPv: MPV, hashMb: core.PARAMS_A5.hashMb, ttReset: 'per-game' }
    const RANK_MOVES = ['e2e4', 'd2d4', 'g1f3', 'b1c3', 'c2c4', 'e2e3']
    const POS = [
      { ply: 0, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
      { ply: 1, fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' },
    ]
    // Spec-faithful UCI worker double: answers the `isready` barrier with
    // `readyok`; on `go` either replies with MultiPV info + bestmove (autoGo) or
    // stays silent to model a search still in flight. terminate() fires nothing.
    const makeFakeWorker = (autoGo) => {
      const w = { onmessage: null, onerror: null, terminated: false, posted: [] }
      let resolveGo
      w.sawGo = new Promise((r) => (resolveGo = r))
      const emit = (line) => { if (w.onmessage) w.onmessage({ data: line }) }
      w.postMessage = (cmd) => {
        w.posted.push(cmd)
        if (cmd === 'isready') {
          queueMicrotask(() => emit('readyok'))
          return
        }
        if (cmd.startsWith('go')) {
          if (resolveGo) { resolveGo(); resolveGo = null }
          if (autoGo)
            queueMicrotask(() => {
              for (let r = 1; r <= MPV; r++)
                emit(`info depth 12 seldepth 15 multipv ${r} score cp ${40 - r} nodes 1000 pv ${RANK_MOVES[r - 1]}`)
              emit(`bestmove ${RANK_MOVES[0]}`)
            })
        }
      }
      w.terminate = () => { w.terminated = true } // HTML spec: terminate fires NO events
      return w
    }

    // (0) positive control: a full judgeGame COMPLETES over the double and a
    // close() afterwards is clean. Proves the harness faithfully drives
    // judgeGame and that the fix leaves the happy path untouched.
    const okWorker = makeFakeWorker(true)
    const okEng = web.makeWorkerJudgeEngine(okWorker, 'blob:fake-ok')
    let out
    try { out = await withTimeout(core.judgeGame(okEng, POS, CFG), 4000, 'happy') } catch (e) { out = e }
    ok(!!out && Array.isArray(out.positions) && out.positions.length === POS.length,
      `fake-worker judgeGame completes (${out && out.positions ? out.positions.length : String(out)} positions)`)
    ok(!!out && Array.isArray(out.positions) && out.positions.every((p) => p.lines.length === MPV),
      'each judged position carries MultiPV lines')
    await okEng.close()
    ok(okWorker.terminated, 'close() terminates the worker')

    // (1) THE regression: close() while a position search is IN FLIGHT must
    // reject the in-flight judgeGame (JudgeEngineError via onError), not hang.
    const flightWorker = makeFakeWorker(false) // never answers `go` → search in flight
    const flightEng = web.makeWorkerJudgeEngine(flightWorker, 'blob:fake-flight')
    const flightP = core.judgeGame(flightEng, POS, CFG)
    await flightWorker.sawGo // judgeGame is now parked in analyseOne awaiting bestmove
    await flightEng.close()
    let flightErr
    try { await withTimeout(flightP, 3000, 'in-flight-close') } catch (e) { flightErr = e }
    ok(flightErr && flightErr.name === 'JudgeEngineError',
      `in-flight judgeGame REJECTS on close(), no hang (${flightErr ? `${flightErr.name}: ${flightErr.message}` : 'RESOLVED'})`)

    // (2) THE regression: judgeGame on an already-closed engine must reject
    // (send() throws), not hang at the first `isready` barrier.
    const closedWorker = makeFakeWorker(true)
    const closedEng = web.makeWorkerJudgeEngine(closedWorker, 'blob:fake-closed')
    await closedEng.close()
    let closedErr
    try { await withTimeout(core.judgeGame(closedEng, POS, CFG), 3000, 'post-close') } catch (e) { closedErr = e }
    ok(closedErr && !/^TIMEOUT:/.test(closedErr.message),
      `judgeGame on a closed engine REJECTS, no hang (${closedErr ? closedErr.message : 'RESOLVED'})`)
    ok(closedErr && /closed/i.test(closedErr.message), 'post-close rejection is the fail-closed send() throw')

    // (3) worker `error` event also fails-closed (parity with node child-crash
    // → onExit → onError): rejects the in-flight judgeGame AND post-death send()
    // throws. Worker.terminate()/death both flow through the same teardown.
    const crashWorker = makeFakeWorker(false)
    const crashEng = web.makeWorkerJudgeEngine(crashWorker, 'blob:fake-crash')
    const crashP = core.judgeGame(crashEng, POS, CFG)
    await crashWorker.sawGo
    if (crashWorker.onerror) crashWorker.onerror({ message: 'boom' })
    let crashErr
    try { await withTimeout(crashP, 3000, 'worker-error') } catch (e) { crashErr = e }
    ok(crashErr && crashErr.name === 'JudgeEngineError',
      `worker error REJECTS the in-flight judgeGame (${crashErr ? `${crashErr.name}: ${crashErr.message}` : 'RESOLVED'})`)
    let sendThrew = false
    try { crashEng.send('isready') } catch { sendThrew = true }
    ok(sendThrew, 'send() after worker death throws (fail-closed, not a silent no-op)')
  }

  // ═══ A5-04: node adapter fail-closed parity (engine-free, fake glue) ═══════
  // The SYMMETRIC half of the A5-23 web section above: the NODE adapter must also
  // make a dead/closed engine REJECT an in-flight judgeGame instead of hanging:
  // inst.onExit (nodeEngine.ts child-exit) → newNodeJudgeEngine onError → judgeGame
  // JudgeEngineError, and a send() after exit THROWS. The finding: no test ever
  // killed a child mid-judgeGame, so this onExit→onError→rejection path had ZERO
  // coverage while the web close() hang (A5-23) shipped; together with the web
  // section above this closes the liveness contract on BOTH adapters.
  //
  // Driven through the REAL newNodeJudgeEngine + REAL judgeGame over a tiny fake
  // UCI glue: a deterministic child that answers only the handshake/`isready`
  // barriers and, on `go`, emits a marker then EITHER auto-replies a full
  // MultiPV+bestmove (after `__autogo__`) or STAYS SILENT to model a search still
  // in flight; `quit` exits 0 (graceful close), `__die__` exits 1 (abrupt crash).
  // It never loads its `.wasm` sibling: that sibling is a copy of the pinned wasm
  // present ONLY so the §8 content-hash gate passes and the real adapter is
  // exercised end to end. No Stockfish runs; nothing is judged. (Counterfactual:
  // an adapter that omits onError makes the in-flight/crash cases HANG, so the
  // withTimeout guard fires and the JudgeEngineError asserts go red.)
  section('J1 node adapter A5-04: dead child mid-judgeGame fails-closed (fake glue)')
  {
    const MPV = core.PARAMS_A5.t1MultiPv
    const CFG = { tier: 1, nodes: 1000, multiPv: MPV, hashMb: core.PARAMS_A5.hashMb, ttReset: 'per-game' }
    const POS = [
      { ply: 0, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
      { ply: 1, fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' },
    ]
    // Fake UCI glue, spawned as `node <this.cjs>` by newInstance. The GO marker is
    // an `info string …` line: ignored by judgeGame's candidate parser, seen only
    // by the test's own onLine so it can tell judgeGame is parked in analyseOne.
    const fakeGlue = resolve(outdir, 'a5_04-fake.cjs')
    writeFileSync(
      fakeGlue,
      [
        `const MOVES = ['e2e4','d2d4','g1f3','b1c3','c2c4','e2e3']`,
        `const MPV = ${MPV}`,
        `let autoGo = false`,
        `process.stdin.setEncoding('utf8')`,
        `let buf = ''`,
        `const say = (s) => process.stdout.write(s + '\\n')`,
        `process.stdin.on('data', (chunk) => {`,
        `  buf += chunk`,
        `  let nl`,
        `  while ((nl = buf.indexOf('\\n')) >= 0) {`,
        `    const line = buf.slice(0, nl).replace(/\\r$/, '').trim(); buf = buf.slice(nl + 1)`,
        `    if (line === 'uci') { say('id name a5_04-fake'); say('uciok') }`,
        `    else if (line === 'isready') say('readyok')`,
        `    else if (line === '__autogo__') autoGo = true`,
        `    else if (line === 'quit') process.exit(0)`,
        `    else if (line === '__die__') process.exit(1)`,
        `    else if (line.startsWith('go')) {`,
        `      say('info string A5_04_GO')`,
        `      if (autoGo) {`,
        `        for (let r = 1; r <= MPV; r++) say('info depth 10 seldepth 12 multipv ' + r + ' score cp ' + (40 - r) + ' nodes 1000 pv ' + MOVES[r - 1])`,
        `        say('bestmove ' + MOVES[0])`,
        `      }`,
        `    }`,
        `  }`,
        `})`,
      ].join('\n'),
    )
    // Sibling wasm = a copy of the pinned bytes, so BOTH §8 gate layers (adapter +
    // newInstance) pass and the REAL newNodeJudgeEngine spawns our fake glue.
    writeFileSync(resolve(outdir, 'a5_04-fake.wasm'), readFileSync(ENGINE_WASM))
    const mkFake = () => adapter.newNodeJudgeEngine({ enginePath: fakeGlue })
    const sawGo = (eng) =>
      new Promise((res) => {
        const off = eng.onLine((l) => {
          if (l.includes('A5_04_GO')) {
            off()
            res()
          }
        })
      })

    // (0) positive control: a full judgeGame COMPLETES over the fake glue and a
    // close() afterwards is clean. Proves the harness faithfully drives the REAL
    // node adapter and leaves the happy path untouched.
    const okEng = await mkFake()
    okEng.send('__autogo__')
    let out
    try { out = await withTimeout(core.judgeGame(okEng, POS, CFG), 6000, 'node-happy') } catch (e) { out = e }
    ok(!!out && Array.isArray(out.positions) && out.positions.length === POS.length,
      `fake-glue judgeGame completes (${out && out.positions ? out.positions.length : String(out)} positions)`)
    ok(!!out && Array.isArray(out.positions) && out.positions.every((p) => p.lines.length === MPV),
      'each judged position carries MultiPV lines')
    await okEng.close()

    // (1) THE regression: close() while a position search is IN FLIGHT must reject
    // the in-flight judgeGame (JudgeEngineError via inst.onExit → onError), not hang.
    const flightEng = await mkFake() // silent on `go` → search in flight
    const flightP = core.judgeGame(flightEng, POS, CFG)
    await withTimeout(sawGo(flightEng), 6000, 'node-sawGo') // parked in analyseOne awaiting bestmove
    await flightEng.close()
    let flightErr
    try { await withTimeout(flightP, 4000, 'node-in-flight-close') } catch (e) { flightErr = e }
    ok(flightErr && flightErr.name === 'JudgeEngineError',
      `in-flight judgeGame REJECTS on close(), no hang (${flightErr ? `${flightErr.name}: ${flightErr.message}` : 'RESOLVED'})`)

    // (2) THE regression: judgeGame on an already-closed engine must reject (send()
    // throws 'judge engine has exited'), not hang at the first `isready` barrier.
    const closedEng = await mkFake()
    await closedEng.close()
    let closedErr
    try { await withTimeout(core.judgeGame(closedEng, POS, CFG), 4000, 'node-post-close') } catch (e) { closedErr = e }
    ok(closedErr && !/^TIMEOUT:/.test(closedErr.message),
      `judgeGame on a closed engine REJECTS, no hang (${closedErr ? closedErr.message : 'RESOLVED'})`)
    ok(closedErr && /exited/i.test(closedErr.message), 'post-close rejection is the fail-closed send() throw')

    // (3) abrupt child crash mid-flight (node analogue of the web worker `error`
    // event): rejects the in-flight judgeGame AND a post-death send() throws.
    const crashEng = await mkFake()
    const crashP = core.judgeGame(crashEng, POS, CFG)
    await withTimeout(sawGo(crashEng), 6000, 'node-sawGo2')
    crashEng.send('__die__') // child exits(1) → inst.onExit → onError → JudgeEngineError
    let crashErr
    try { await withTimeout(crashP, 4000, 'node-crash') } catch (e) { crashErr = e }
    ok(crashErr && crashErr.name === 'JudgeEngineError',
      `child crash REJECTS the in-flight judgeGame (${crashErr ? `${crashErr.name}: ${crashErr.message}` : 'RESOLVED'})`)
    let nodeSendThrew = false
    try { crashEng.send('isready') } catch { nodeSendThrew = true }
    ok(nodeSendThrew, 'send() after child death throws (fail-closed, not a silent no-op)')
  }

  section('J1 determinism: warm replay after arbitrary prior use (TEST t1)')
  const jw = await mkJudge()
  await pollute(jw)
  const w1 = await core.judgeGame(jw, JUDGE_POSITIONS, TEST_T1)
  const w2 = await core.judgeGame(jw, JUDGE_POSITIONS, TEST_T1)
  const dw1 = core.judgeOutputDigest(w1)
  eq(core.judgeOutputDigest(w2), dw1, 'same warm instance, judged twice → identical digest')
  eq(w1.positions.length, JUDGE_POSITIONS.length, `all ${JUDGE_POSITIONS.length} positions judged`)
  ok(w1.positions.every((p, i) => p.ply === JUDGE_POSITIONS[i].ply), 'plies echoed in transcript order')
  ok(
    w1.positions.every((p) =>
      p.lines.every(
        (l) =>
          /^[a-h][1-8][a-h][1-8][nbrq]?$/.test(l.move) &&
          ((Number.isInteger(l.cp) && l.mate === undefined) || (Number.isInteger(l.mate) && l.cp === undefined)),
      ),
    ),
    'every line: UCI move + exactly one integer score (cp XOR mate)',
  )
  eq(w1.positions[6].lines[0].mate, 1, 'mate-in-1 position judged as {mate: 1} at rank 1')
  eq(w1.positions[7].lines[0].mate, 2, 'Réti position judged as {mate: 2} at rank 1 (mate-in-N > 1 path)')
  eq(w1.positions[8].lines.length, 1, 'single-legal-reply position yields exactly 1 rank (K < multiPv)')
  ok(
    w1.config.nodes === TEST_T1.nodes && w1.config.multiPv === TEST_T1.multiPv && w1.config.hashMb === TEST_T1.hashMb,
    'config echo carries the exact nodes/multiPv/hashMb used',
  )
  eq(w1.config.params, core.PARAMS_A5_DIGEST, 'config echo names the rule set (PARAMS_A5_DIGEST)')

  section('J1 determinism: two fresh instances (TEST t1)')
  const jf1 = await mkJudge()
  const df1 = core.judgeOutputDigest(await core.judgeGame(jf1, JUDGE_POSITIONS, TEST_T1))
  await jf1.close()
  const jf2 = await mkJudge()
  const df2 = core.judgeOutputDigest(await core.judgeGame(jf2, JUDGE_POSITIONS, TEST_T1))
  eq(df2, df1, 'fresh instance A == fresh instance B (identical digest)')
  eq(df1, dw1, 'fresh == warm-replay (prior use is fully erased)')

  section('J1 tier separation: t1 vs t2 configs (TEST)')
  const o2 = await core.judgeGame(jf2, JUDGE_POSITIONS, TEST_T2) // reuse = more prior-use coverage
  await jf2.close()
  ok(core.judgeOutputDigest(o2) !== df1, 'tier-1 and tier-2 configs produce DIFFERENT digests')
  eq(o2.config.multiPv, core.PARAMS_A5.t2MultiPv, 'tier-2 config echo carries t2MultiPv')

  section('J1 content-hash gate: verified bytes ARE executed bytes (A5-13)')
  // The gate must hash the EXACT sibling the spawned child self-loads, not a
  // decoupled wasmPath the child never receives. Path targeting + engine-free
  // fail-closed refusals (each throws BEFORE any child spawns).
  eq(
    engine.loadedWasmPath(ENGINE_JS),
    ENGINE_WASM,
    'A5-13: loadedWasmPath(enginePath) === the shipped sibling the child loads',
  )
  ok(
    content.verifyWasmHash(engine.loadedWasmPath(ENGINE_JS)).ok,
    'A5-13: the loaded sibling verifies against the pinned hash (happy path)',
  )
  // Divergent enginePath/wasmPath pair: a glue copy whose OWN sibling is
  // tampered, gated by a PRISTINE wasmPath. Pre-fix the gate hashed the pristine
  // wasmPath (GREEN) while the child would load the tampered sibling and mint
  // un-pinned verdict bits; post-fix it is refused fail-closed before spawn.
  const eng13Js = resolve(outdir, 'eng13.js')
  const eng13Wasm = resolve(outdir, 'eng13.wasm')
  writeFileSync(eng13Js, readFileSync(ENGINE_JS))
  const tamperedSibling = readFileSync(ENGINE_WASM)
  tamperedSibling[Math.floor(tamperedSibling.length / 2)] ^= 0xff
  writeFileSync(eng13Wasm, tamperedSibling)
  try {
    await adapter.newNodeJudgeEngine({ enginePath: eng13Js, wasmPath: ENGINE_WASM })
    ok(false, 'A5-13: divergent pair (tampered sibling + pristine wasmPath) refused (did not reject)')
    ok(false, 'A5-13: typed JudgeWasmPathError')
  } catch (e) {
    ok(true, 'A5-13: divergent pair refused before spawning (was GREEN pre-fix)')
    ok(
      e instanceof engine.JudgeWasmPathError && e.name === 'JudgeWasmPathError',
      `A5-13: typed JudgeWasmPathError (${e.name})`,
    )
  }
  // No wasmPath: the gate still hashes the ACTUAL loaded sibling, so a tampered
  // sibling is caught as a hash mismatch (verified file == executed file).
  try {
    await adapter.newNodeJudgeEngine({ enginePath: eng13Js })
    ok(false, 'A5-13: tampered loaded sibling refused (did not reject)')
    ok(false, 'A5-13: typed JudgeWasmHashError')
  } catch (e) {
    ok(true, 'A5-13: tampered loaded sibling refused before spawning')
    ok(
      e instanceof core.JudgeWasmHashError && e.name === 'JudgeWasmHashError',
      `A5-13: typed JudgeWasmHashError (${e.name})`,
    )
  }
  // A wasmPath that is NOT the loaded sibling is refused even when it points at a
  // real (here tampered) temp file: the gate never silently ignores it.
  const tampered = resolve(outdir, 'tampered.wasm')
  const wasmBytes = readFileSync(ENGINE_WASM)
  wasmBytes[Math.floor(wasmBytes.length / 2)] ^= 0xff
  writeFileSync(tampered, wasmBytes)
  try {
    await adapter.newNodeJudgeEngine({ enginePath: ENGINE_JS, wasmPath: tampered })
    ok(false, 'A5-13: decoupled wasmPath refused (did not reject)')
    ok(false, 'A5-13: typed JudgeWasmPathError')
  } catch (e) {
    ok(true, 'A5-13: decoupled wasmPath refused before spawning')
    ok(
      e instanceof engine.JudgeWasmPathError && e.name === 'JudgeWasmPathError',
      `A5-13: typed JudgeWasmPathError (${e.name})`,
    )
  }

  // ═══ A5-11. The §8 invariant as its OWN named regression: the VERIFIED bytes
  // ARE the EXECUTED bytes. The A5-13 matrix above proves the gate REFUSES a
  // divergent pair; this pins the COUNTERFACTUAL the pre-fix argument-only gate
  // (verifyWasmHash(opts.wasmPath)) missed. That the checked/loaded split is
  // REAL, not a tautology: the pristine wasmPath ARGUMENT (all the old gate ever
  // hashed) verifies CLEAN, while the sibling the spawned `node <glue>` child
  // self-resolves and readFileSync's (loadedWasmPath) is the TAMPERED, un-pinned
  // binary. So pre-fix this exact call minted verdict bits from an un-pinned
  // engine on a green hash check; post-fix it throws before any child exists.
  // Self-contained (own fixtures) + engine-free (both throws precede spawn).
  section('J1 content-hash gate A5-11: verified bytes ARE executed bytes (no engine)')
  {
    const a11Glue = resolve(outdir, 'a5_11-glue.js')
    // the file the spawned child ACTUALLY loads (its own __dirname sibling).
    const a11Loaded = engine.loadedWasmPath(a11Glue)
    writeFileSync(a11Glue, readFileSync(ENGINE_JS))
    const a11Tampered = readFileSync(ENGINE_WASM)
    a11Tampered[Math.floor(a11Tampered.length / 2)] ^= 0xff
    writeFileSync(a11Loaded, a11Tampered)
    eq(a11Loaded, resolve(outdir, 'a5_11-glue.wasm'), 'A5-11: loadedWasmPath is the glue-copy sibling the child self-loads')
    // The split is genuine: verified≠executed by construction.
    ok(content.verifyWasmHash(ENGINE_WASM).ok, 'A5-11: pristine wasmPath ARGUMENT verifies CLEAN (the pre-fix gate saw green)')
    ok(!content.verifyWasmHash(a11Loaded).ok, 'A5-11: the child-self-loaded sibling is UN-PINNED (executed ≠ verified)')
    // Pre-fix the clean argument hashed green and the tampered engine spawned;
    // the fix refuses the checked/loaded split before any child exists.
    try {
      await adapter.newNodeJudgeEngine({ enginePath: a11Glue, wasmPath: ENGINE_WASM })
      ok(false, 'A5-11: clean-argument / tampered-sibling pair refused before spawn (ACCEPTED; would execute un-pinned bytes)')
    } catch (e) {
      ok(
        e instanceof engine.JudgeWasmPathError && e.name === 'JudgeWasmPathError',
        `A5-11: clean-argument / tampered-sibling pair REFUSED before spawn. A clean decoy cannot redirect the pin (${e.name})`,
      )
    }
    // With NO argument the gate trusts nothing external: it hashes the EXECUTED
    // sibling itself, so the tamper surfaces as a hash mismatch on the real bytes.
    // The direct statement that verified bytes are the executed bytes.
    try {
      await adapter.newNodeJudgeEngine({ enginePath: a11Glue })
      ok(false, 'A5-11: no-argument gate hashes the executed sibling (ACCEPTED a tampered sibling)')
    } catch (e) {
      ok(
        e instanceof core.JudgeWasmHashError && e.name === 'JudgeWasmHashError',
        `A5-11: no-argument gate hashes the EXECUTED sibling and catches the tamper (${e.name})`,
      )
    }
  }

  section('J1 FROZEN GOLDEN: Tier-1 digest at TRUE PARAMS_A5 config')
  const jg = await mkJudge()
  const og = await core.judgeGame(jg, JUDGE_POSITIONS, core.judgeConfigForTier(1))
  const dg = core.judgeOutputDigest(og)
  await jg.close()
  await jw.close()
  eq(og.config.nodes, 200000, 'golden ran at the true t1 node count (200000)')
  if (CAPTURE) console.log(`\n[GOLDEN t1 digest]\n${dg}\n`)
  else eq(dg, GOLDEN_T1_DIGEST, 'FROZEN Tier-1 digest reproduced (NODE cross-run/cross-machine anchor; browser parity is the 3-subset live gate)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
