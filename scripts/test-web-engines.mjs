#!/usr/bin/env node
// Web engine layer suite (web port W2, src/web/engines, docs/WEB-PORT-SPEC.md).
//
//   node scripts/test-web-engines.mjs
//
// Headless coverage of everything that doesn't need a browser:
//   1. UCI protocol goldens (parseInfo/parseBestmove/goArgs; desktop parity).
//   2. engine:play level→strategy routing goldens (maia/elo/uciElo/skill/
//      default precedence, the 1320 floor boundary) + fairy level/variant
//      mapping goldens + FEN anti-smuggling guards.
//   3. Sub-1320 weak-play model: numeric parity with scripts/lib/weak-model.mjs
//      (the calibration mirror) across the Elo range, and PICK-FOR-PICK parity
//      under a seeded RNG; plus softmax/blunder behavior sanity.
//   4. WebUciEngine protocol machinery driven by a scripted transport:
//      weakPlay end-to-end over canned MultiPV lines, evalOnce (cp/mate/
//      terminal) semantics.
//   5. Review pipeline over canned evals: Book/Best/Blunder classification,
//      comments, summaries, Elo bands, progress, cancellation; perf.estimate.
//   6. Persona selection math (style scoring, tolerance filter, book lookup)
//      + the real persona catalog/book resources load.
//   7. REAL Fairy-Stockfish WASM under Node (the package runs headless):
//      evalVariant for chess + a variant + a Variant Lab custom ini, and
//      playVariant: through the actual createEngineApi factory.
//
// The chess (stockfish-18-lite) worker builds cannot run under Node. The
// browser-level verification of those is the lead's job per the contract.
// Exit 1 on any failure.

import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'webengines-'))

// ---- Bundle the engine layer (esbuild, test-web-stub.mjs pattern) -----------------

const entry = path.join(dir, 'entry.ts')
writeFileSync(
  entry,
  `
export * as uci from '${repo}/src/web/engines/uci'
export * as weak from '${repo}/src/web/engines/weakPlay'
export * as eapi from '${repo}/src/web/engines/engineApi'
export * as review from '${repo}/src/web/engines/review'
export * as persona from '${repo}/src/web/engines/personaMove'
export { setFairyModuleLoader } from '${repo}/src/web/engines/pools'
export { WebUciEngine } from '${repo}/src/web/engines/WebUciEngine'
export { createEngineApi, createPerfApi } from '${repo}/src/web/engines/index'
`
)

const out = path.join(dir, 'engines.mjs')
execSync(
  `npx esbuild ${entry} --bundle --format=esm --outfile=${out} ` +
    `--platform=node --jsx=automatic --external:*?url --loader:.css=empty ` +
    `--alias:@shared=./src/shared --alias:@=./src/renderer/src`,
  { stdio: 'pipe', cwd: repo }
)

// Browser-ish globals touched lazily by the bundled tree (module eval touches none).
globalThis.window = globalThis
// The factories gate on Worker+WASM support at construction (engineless
// environments must fall into webApi's W1 fallbacks). Node genuinely has
// workers: expose the constructor so section 7 can build the real engine api;
// the chess Worker paths are never exercised here (browser-verified by the lead).
globalThis.Worker = (await import('node:worker_threads')).Worker

const M = await import(pathToFileURL(out).href)
const weakModel = await import(pathToFileURL(path.join(repo, 'scripts/lib/weak-model.mjs')).href)

let failures = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}${detail !== undefined ? `, ${detail}` : ''}`)
  }
}
function close(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps
}

// ---- 1. UCI protocol goldens -------------------------------------------------------

console.log('\n[1] UCI protocol')
{
  const info = M.uci.parseInfo(
    'info depth 12 seldepth 15 multipv 2 score cp -34 nodes 1234 nps 99 time 77 pv e2e4 e7e5 g1f3'
  )
  check(
    'parseInfo full line',
    info &&
      info.depth === 12 &&
      info.seldepth === 15 &&
      info.multipv === 2 &&
      info.scoreCp === -34 &&
      info.nodes === 1234 &&
      info.nps === 99 &&
      info.timeMs === 77 &&
      info.pv.join(' ') === 'e2e4 e7e5 g1f3'
  )
  const mate = M.uci.parseInfo('info depth 5 score mate -3 pv h7h8q')
  check('parseInfo mate', mate && mate.mate === -3 && mate.scoreCp === undefined)
  check('parseInfo info-string is null', M.uci.parseInfo('info string classical eval') === null)
  const bm = M.uci.parseBestmove('bestmove e2e4 ponder e7e5')
  check('parseBestmove + ponder', bm.bestmove === 'e2e4' && bm.ponder === 'e7e5')
  check('goArgs movetime', M.uci.goArgs({ kind: 'movetime', value: 300 }) === 'movetime 300')
  check('goArgs infinite', M.uci.goArgs({ kind: 'infinite' }) === 'infinite')
}

// ---- 2. Level→strategy + fairy mapping goldens --------------------------------------

console.log('\n[2] engine:play level routing + fairy mapping')
{
  const r = (level) => M.eapi.resolvePlayStrategy(level)
  check('elo 1320 → native uciElo', JSON.stringify(r({ elo: 1320 })) === '{"kind":"uciElo","elo":1320}')
  check('elo 1319 → weak model', JSON.stringify(r({ elo: 1319 })) === '{"kind":"weak","elo":1319,"panic":false}')
  check('elo 600 + panic → weak panic', JSON.stringify(r({ elo: 600, panic: true })) === '{"kind":"weak","elo":600,"panic":true}')
  check('elo 3190 → native', JSON.stringify(r({ elo: 3190 })) === '{"kind":"uciElo","elo":3190}')
  check('legacy uciElo 1500', JSON.stringify(r({ uciElo: 1500 })) === '{"kind":"uciElo","elo":1500}')
  check('legacy skill 7', JSON.stringify(r({ skill: 7 })) === '{"kind":"skill","skill":7}')
  check('no knobs → club default 1500', JSON.stringify(r({})) === '{"kind":"default","elo":1500}')
  check('maia wins over elo', r({ maia: 1500, elo: 2400 }).kind === 'maia')
  check('elo wins over uciElo', JSON.stringify(r({ elo: 900, uciElo: 1500 })) === '{"kind":"weak","elo":900,"panic":false}')
  check('elo out of range throws', (() => { try { r({ elo: 99 }); return false } catch { return true } })())
  check('bad maia throws', (() => { try { r({ maia: 1200 }); return false } catch { return true } })())

  // Fairy level rows must equal the desktop FAIRY_LEVELS / games/bots.ts envelope.
  const goldenLevels = [
    { elo: 600, movetime: 150 },
    { elo: 1000, movetime: 250 },
    { elo: 1400, movetime: 350 },
    { elo: 1850, movetime: 500 },
    { elo: 2300, movetime: 700 }
  ]
  check('FAIRY_LEVELS golden', JSON.stringify(M.eapi.FAIRY_LEVELS) === JSON.stringify(goldenLevels))
  const goldenVariants = {
    chess960: 'chess', crazyhouse: 'crazyhouse', atomic: 'atomic', antichess: 'antichess',
    kingofthehill: 'kingofthehill', threecheck: '3check', horde: 'horde',
    racingkings: 'racingkings', xiangqi: 'xiangqi', shogi: 'shogi', janggi: 'janggi',
    makruk: 'makruk', placement: 'placement'
  }
  check('FAIRY_UCI_VARIANT golden', JSON.stringify(M.eapi.FAIRY_UCI_VARIANT) === JSON.stringify(goldenVariants))

  // FEN guards.
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  check('safeFen normalizes', M.eapi.safeFen(START) === START)
  check('safeFen rejects smuggled newline', (() => { try { M.eapi.safeFen(START + '\nquit'); return false } catch { return true } })())
  check('variant FEN allowlist accepts pockets', M.eapi.VARIANT_FEN_RE.test('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1'))
  check('variant FEN allowlist rejects newline', !M.eapi.VARIANT_FEN_RE.test('8/8 w - - 0 1\nquit'))
  check('INI_SECTION_RE parses derived section', M.eapi.INI_SECTION_RE.exec('# c\n[myvar:chess]\nx = 1')[1] === 'myvar')
}

// ---- 3. Weak-play model parity vs scripts/lib/weak-model.mjs ------------------------

console.log('\n[3] sub-1320 weak-play model parity')
{
  // Numeric parity of every curve across the whole sub-floor range.
  let curvesOk = true
  for (let elo = 100; elo <= 1319; elo += 7) {
    const pairs = [
      [M.weak.weakDepth(elo), weakModel.weakDepth(elo)],
      [M.weak.weakMultiPv(elo), weakModel.weakMultiPv(elo)],
      [M.weak.weakTemperature(elo), weakModel.weakTemperature(elo)],
      [M.weak.gapKnee(elo), weakModel.gapKnee(elo)],
      [M.weak.weakBlunderChance(elo), weakModel.weakBlunderChance(elo)],
      [M.weak.openingFullmoves(elo), weakModel.openingFullmoves(elo)],
      [M.weak.blunderGapWindow(elo)[0], weakModel.blunderGapWindow(elo)[0]],
      [M.weak.blunderGapWindow(elo)[1], weakModel.blunderGapWindow(elo)[1]]
    ]
    for (const [a, b] of pairs) {
      if (!(a === b || close(a, b))) {
        curvesOk = false
        console.error(`   curve mismatch at elo ${elo}: ${a} vs ${b}`)
      }
    }
  }
  check('all curves match the calibration mirror (100..1319)', curvesOk)

  // Seeded-RNG pick parity: same random stream + same candidates must yield the
  // IDENTICAL move from this port and from the calibration mirror.
  const mulberry32 = (seed) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const realRandom = Math.random
  const gen = mulberry32(1234567)
  let parityOk = true
  for (let i = 0; i < 3000; i++) {
    const elo = Math.round(100 + gen() * 1219)
    const fullmove = 1 + Math.floor(gen() * 40)
    const panic = gen() < 0.3
    const n = 3 + Math.floor(gen() * 6)
    let cp = Math.round(-120 + gen() * 300)
    const cands = []
    for (let k = 0; k < n; k++) {
      cands.push({ uci: `m${k}`, cp })
      cp -= Math.round(gen() * 300)
    }
    const seed = Math.floor(gen() * 2 ** 31)
    Math.random = mulberry32(seed)
    const mine = M.weak.pickWeakMove(cands, elo, fullmove, panic)
    Math.random = mulberry32(seed)
    const theirs = weakModel.pickWeakMove(cands, elo, fullmove, panic)
    if (mine !== theirs) {
      parityOk = false
      console.error(`   pick mismatch #${i}: ${mine} vs ${theirs} (elo ${elo} fm ${fullmove} panic ${panic})`)
      if (failures > 5) break
    }
  }
  Math.random = realRandom
  check('pickWeakMove parity over 3000 seeded scenarios', parityOk)

  // Behavior sanity: temperature/blunder shaping.
  const spread = (elo, panic = false) => {
    const cands = [
      { uci: 'best', cp: 50 },
      { uci: 'ok', cp: -30 },
      { uci: 'bad', cp: -250 }
    ]
    const counts = { best: 0, ok: 0, bad: 0 }
    const rng = mulberry32(42)
    for (let i = 0; i < 4000; i++) counts[M.weak.pickWeakMove(cands, elo, 20, panic, rng)]++
    return counts
  }
  const weak100 = spread(100)
  const strong1250 = spread(1250)
  check('Elo 100 wanders off the best move', weak100.best < 2200, JSON.stringify(weak100))
  // At 1250 the calibrated softmax (T=170, knee~292) holds best ~63% of the
  // time against an 80cp-gap rival: assert the band, not a folk expectation.
  check('Elo 1250 leans on the best move', strong1250.best > 2200, JSON.stringify(strong1250))
  check('Elo 100 plays worse moves more often than 1250', weak100.bad > strong1250.bad)
  const panic1000 = spread(1000, true)
  const calm1000 = spread(1000)
  check('panic collapses choice quality', panic1000.best < calm1000.best, `${panic1000.best} !< ${calm1000.best}`)
  check(
    'blunder chance doubles under panic (capped .5)',
    close(Math.min(0.5, M.weak.weakBlunderChance(800) * 2), 0.2) &&
      M.weak.fenFullmove('8/8/8/8/8/8/8/8 w - - 0 23') === 23 &&
      M.weak.fenFullmove('garbage') === 1
  )
  check(
    'lineCp maps mate to ±1000 and clamps',
    M.weak.lineCp({ mate: 3 }) === 1000 &&
      M.weak.lineCp({ mate: -1 }) === -1000 &&
      M.weak.lineCp({ scoreCp: 5000 }) === 1000 &&
      M.weak.lineCp({ scoreCp: -42 }) === -42
  )
}

// ---- 4. WebUciEngine machinery over a scripted transport ----------------------------

console.log('\n[4] WebUciEngine + weakPlay/evalOnce over a scripted transport')

/** A scripted engine transport: answers the uci/isready handshake and plays
 *  back canned line arrays per `go`, so the full listener/stop/bestmove
 *  discipline runs without any WASM. */
function scriptedTransport(script) {
  let onLine = () => {}
  let searchIdx = 0
  let searching = false
  const emit = (lines) => setTimeout(() => lines.forEach((l) => onLine(l)), 0)
  return {
    send(cmd) {
      if (cmd === 'uci') emit(['id name scripted', 'uciok'])
      else if (cmd === 'isready') emit(['readyok'])
      else if (cmd.startsWith('go')) {
        searching = true
        const step = script[Math.min(searchIdx, script.length - 1)]
        searchIdx++
        emit([...step.lines, `bestmove ${step.bestmove}`])
        searching = false
      } else if (cmd === 'stop' && searching) {
        emit(['bestmove 0000'])
        searching = false
      }
    },
    onLine(cb) { onLine = cb },
    onError() {},
    terminate() {}
  }
}

{
  // weakPlay end-to-end: candidates arrive via multipv info lines; at Elo 1250
  // with a huge gap the pick must be the engine's best line.
  const eng = new M.WebUciEngine(
    scriptedTransport([
      {
        lines: [
          'info depth 7 multipv 1 score cp 200 pv e2e4 e7e5',
          'info depth 7 multipv 2 score cp -800 pv a2a3 e7e5',
          'info depth 7 multipv 3 score mate -2 pv h2h4 d8h4'
        ],
        bestmove: 'e2e4'
      }
    ])
  )
  await eng.start()
  const bm = await M.weak.weakPlay(eng, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 25', 1250, false, 200)
  check('weakPlay picks from engine candidates', ['e2e4', 'a2a3', 'h2h4'].includes(bm.bestmove))
  check('weakPlay at 1250 with 1000cp gaps stays on best', bm.bestmove === 'e2e4', bm.bestmove)
  eng.quit()
}
{
  // evalOnce: cp line, then a mate line on the second search, terminal on third.
  const eng = new M.WebUciEngine(
    scriptedTransport([
      { lines: ['info depth 10 score cp -73 pv e7e5'], bestmove: 'e7e5' },
      { lines: ['info depth 10 score cp 20 pv e2e4', 'info depth 12 score mate 2 pv d1h5'], bestmove: 'd1h5' },
      { lines: [], bestmove: '(none)' }
    ])
  )
  await eng.start()
  const r1 = await M.eapi.evalOnce(eng, '8/8 w - - 0 1', 100)
  const r2 = await M.eapi.evalOnce(eng, '8/8 w - - 0 1', 100)
  const r3 = await M.eapi.evalOnce(eng, '8/8 w - - 0 1', 100)
  check('evalOnce cp result', JSON.stringify(r1) === '{"cp":-73}')
  check('evalOnce keeps LAST scored line (mate)', JSON.stringify(r2) === '{"mate":2}')
  check('evalOnce terminal → {}', JSON.stringify(r3) === '{}')
  eng.quit()
}

// ---- 5. Review pipeline over canned evals -------------------------------------------

console.log('\n[5] review pipeline (canned evals)')
{
  const pgn = '[Event "t"]\n\n1. e4 e5 2. Bc4 b5 *'
  const moves = M.review.movesFromPgn(pgn)
  check('movesFromPgn extracts the mainline', moves.length === 4 && moves[3].san === 'b5')
  check('reviewDepthFor scaling', M.review.reviewDepthFor(30) === 20 && M.review.reviewDepthFor(60) === 18 && M.review.reviewDepthFor(200) === 16)

  // Scripted analyze: consumed in call order (ply1..4 at multipv 2, then the
  // played-move search of ply 4's after-position at multipv 1).
  const responses = [
    { expectMpv: 2, lines: { 1: { scoreCp: 30, pv: ['e2e4'] }, 2: { scoreCp: 20, pv: ['d2d4'] } } },
    { expectMpv: 2, lines: { 1: { scoreCp: -20, pv: ['e7e5'] }, 2: { scoreCp: -25, pv: ['c7c5'] } } },
    { expectMpv: 2, lines: { 1: { scoreCp: 40, pv: ['g1f3', 'b8c6'] }, 2: { scoreCp: 35, pv: ['f1c4', 'g8f6'] } } },
    { expectMpv: 2, lines: { 1: { scoreCp: -35, pv: ['g8f6'] }, 2: { scoreCp: -40, pv: ['b8c6'] } } },
    { expectMpv: 1, lines: { 1: { scoreCp: 320, pv: ['c4b5', 'c7c6'] } } }
  ]
  let call = 0
  const analyze = async (_fen, _depth, multipv) => {
    const r = responses[call]
    if (!r) throw new Error(`unexpected analyze call #${call}`)
    call++
    if (multipv !== r.expectMpv) throw new Error(`call ${call}: multipv ${multipv} != ${r.expectMpv}`)
    return { lines: new Map(Object.entries(r.lines).map(([k, v]) => [Number(k), v])) }
  }

  const progress = []
  const review = await M.review.reviewGame({
    moves,
    gameId: 7,
    analyze,
    isBook: () => progress.length < 2, // first two plies are "theory"
    onProgress: (ply, total) => progress.push([ply, total])
  })

  check('all five canned searches consumed', call === 5)
  check('progress fired per ply', JSON.stringify(progress) === '[[1,4],[2,4],[3,4],[4,4]]')
  check('default depth for 4 plies is 20', review.depth === 20)
  const badges = review.moveEvals.map((m) => m.badge)
  check('badges: Book, Book, Best(co-best PV2), Blunder', JSON.stringify(badges) === '["Book","Book","Best","Blunder"]', JSON.stringify(badges))
  const verdicts = review.moveEvals.map((m) => m.verdict)
  check('verdicts derive from badges', JSON.stringify(verdicts) === '["ok","ok","ok","blunder"]')
  check('white side summary', review.white.moves === 2 && review.white.blunders === 0 && review.white.best === 2)
  check('black side summary', review.black.moves === 2 && review.black.blunders === 1 && review.black.best === 1)
  const b = review.moveEvals[3]
  check('blunder eval negated to mover POV', b.playedEval.cp === -320)
  check('blunder comment carries the refutation', b.comment.includes('blunder') && b.comment.includes('Bxb5'), b.comment)
  check('bestSan resolved', b.bestSan === 'Nf6')
  check('cpLoss capped mover-POV drop', b.cpLoss === 285)
  check('critical flags the blunder only', review.moveEvals.filter((m) => m.critical).length === 1 && b.critical)
  check('white accuracy > black accuracy', review.white.accuracy > review.black.accuracy)
  check('elo bands are estimates', review.whiteElo.kind === 'estimate' && review.whiteElo.low < review.whiteElo.high)
  check('white outrates black', review.whiteElo.est > review.blackElo.est)
  check('gameId echoed', review.gameId === 7 && review.totalPlies === 4)

  // Cancellation: abort during ply 1's search → the loop must reject before
  // launching another search.
  const abort = new AbortController()
  let cancelCalls = 0
  const cancelled = await M.review
    .reviewGame({
      moves,
      analyze: async () => {
        cancelCalls++
        abort.abort()
        return { lines: new Map([[1, { scoreCp: 0, pv: ['e2e4'] }]]) }
      },
      isBook: () => false,
      signal: abort.signal
    })
    .then(
      () => null,
      (e) => e.message
    )
  check('abort rejects with "review cancelled"', cancelled === 'review cancelled')
  check('abort stops after the in-flight search', cancelCalls === 1)

  // perf.estimate over the store seam.
  const store = {
    saved: null,
    async save(gameId, r) { this.saved = { gameId, r }; return { reviewId: gameId } },
    async load(gameId) {
      if (gameId !== 7) return { review: null, moveEvals: [] }
      return { review, moveEvals: review.moveEvals }
    }
  }
  const perf = M.createPerfApi(store)
  const direct = await perf.estimate({ accuracy: 92 })
  const weakDirect = await perf.estimate({ accuracy: 60 })
  check('perf.estimate(accuracy) returns a band', direct.est > weakDirect.est && direct.low < direct.est && direct.est < direct.high)
  const byGame = await perf.estimate({ gameId: 7 })
  check('perf.estimate(gameId) uses the stored review', Number.isFinite(byGame.est) && byGame.accuracy === review.white.accuracy)
  const missing = await perf.estimate({ gameId: 999 }).then(() => null, (e) => e.message)
  check('perf.estimate missing review throws', missing === 'perf:estimate: no cached review for game 999')
  const neither = await perf.estimate({}).then(() => null, (e) => e.message)
  check('perf.estimate requires gameId or accuracy', neither === 'perf:estimate requires gameId or accuracy')
}

// ---- 6. Persona selection math -------------------------------------------------------

console.log('\n[6] persona selection')
{
  check('clampElo band', M.persona.clampElo(1000) === 1320 && M.persona.clampElo(2900) === 2900 && M.persona.clampElo(9000) === 3190)
  check('defaultDepth scales 8..16', M.persona.defaultDepth(1320) === 8 && M.persona.defaultDepth(3190) === 16)

  // Position after 1.e4 f5: Qh5+ is a real check; exf5 is a capture.
  const fen = 'rnbqkbnr/ppppp1pp/8/5p2/4P3/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 2'
  const tQ = M.persona.classifyMove(fen, 'd1h5')
  check('classifyMove: Qh5+ is check + king-zone', tQ.isCheck && tQ.attacksKingZone && !tQ.isCapture)
  const tC = M.persona.classifyMove(fen, 'e4f5')
  check('classifyMove: exf5 is a capture', tC.isCapture && !tC.isCheck)
  check('classifyMove: illegal move → neutral', JSON.stringify(M.persona.classifyMove(fen, 'a1a8')) === JSON.stringify({ isCapture: false, isCheck: false, isPromotion: false, immediateSacPawns: 0, attacksKingZone: false }))

  const candidates = [
    { uci: 'e4f5', cp: 60, mate: null, rank: 1, pv: ['e4f5'] },
    { uci: 'b1c3', cp: 50, mate: null, rank: 2, pv: ['b1c3'] },
    { uci: 'd1h5', cp: 15, mate: null, rank: 3, pv: ['d1h5'] }
  ]
  const tal = { aggression: 0.9, risk: 0.9, prefersAttack: true, prefersSolid: false }
  const petrosian = { aggression: 0.1, risk: 0.2, prefersAttack: false, prefersSolid: true }
  const talPick = M.persona.pickStyledMove(tal, fen, candidates, 'e4f5')
  const petPick = M.persona.pickStyledMove(petrosian, fen, candidates, 'e4f5')
  check('aggressive persona trades eval for the check', talPick.bestmove === 'd1h5', talPick.bestmove)
  check('solid persona keeps the top line (tolerance excludes the check)', petPick.bestmove === 'e4f5', petPick.bestmove)
  check('tolerance widens with style', close(M.persona.evalTolerancePawns(tal), 1.1) && close(M.persona.evalTolerancePawns(petrosian), 0.4))
  check('empty candidates → engine bestmove', M.persona.pickStyledMove(tal, fen, [], 'g1f3').bestmove === 'g1f3')

  // The real committed resources load and are selector-usable.
  const catalog = await M.persona.loadPersonaCatalog()
  check('persona catalog loads (>= 8 personas)', catalog.size >= 8, `size ${catalog.size}`)
  const anyBad = [...catalog.values()].some(
    (p) => typeof p.peakElo !== 'number' || p.style.aggression < 0 || p.style.aggression > 1 || p.style.risk < 0 || p.style.risk > 1
  )
  check('every persona has sane style numbers', !anyBad)

  // Book lookup: pure, EPD-keyed.
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  const startEpd = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'
  check('pickBookMove hits by EPD', M.persona.pickBookMove({ [startEpd]: ['e2e4'] }, START) === 'e2e4')
  check('pickBookMove misses out of book', M.persona.pickBookMove({ [startEpd]: ['e2e4'] }, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1') === null)
}

// ---- 7. REAL Fairy-Stockfish WASM under Node -----------------------------------------

console.log('\n[7] Fairy-Stockfish WASM (real engine, Node)')
{
  const fairyPkg = path.join(repo, 'node_modules/fairy-stockfish-nnue.wasm')
  let fairyModuleRef = null
  M.setFairyModuleLoader(async () => {
    const factory = require(path.join(fairyPkg, 'stockfish.js'))
    const mod = await factory({
      wasmBinary: readFileSync(path.join(fairyPkg, 'stockfish.wasm')),
      locateFile: (f) => path.join(fairyPkg, f)
    })
    fairyModuleRef = mod
    return mod
  })

  const inis = new Map([['testvar', '[testvar:chess]\n']])
  const api = M.createEngineApi({ getCustomVariantIni: async (id) => inis.get(id) ?? null })

  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  try {
    const chessEval = await api.evalVariant({ kind: 'chess', fen: START, movetimeMs: 200 })
    check('evalVariant chess returns a score', typeof chessEval.cp === 'number' || typeof chessEval.mate === 'number', JSON.stringify(chessEval))

    const atomicEval = await api.evalVariant({ kind: 'atomic', fen: START, movetimeMs: 200 })
    check('evalVariant atomic (variant retarget) returns a score', typeof atomicEval.cp === 'number' || typeof atomicEval.mate === 'number', JSON.stringify(atomicEval))

    const customEval = await api.evalVariant({ kind: 'custom-testvar', fen: START, movetimeMs: 200 })
    check('evalVariant custom ini (VariantPath via FS) returns a score', typeof customEval.cp === 'number' || typeof customEval.mate === 'number', JSON.stringify(customEval))

    const unknownCustom = await api.evalVariant({ kind: 'custom-nope', fen: START }).then(() => null, (e) => e.message)
    check('evalVariant unknown custom throws', unknownCustom === "evalVariant: unknown custom variant 'nope'")
    const unknownKind = await api.evalVariant({ kind: 'go19', fen: START }).then(() => null, (e) => e.message)
    check('evalVariant unsupported kind throws', unknownKind === "evalVariant: unsupported kind 'go19'")

    const zhFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1'
    const zhMove = await api.playVariant({ kind: 'crazyhouse', fen: zhFen, level: 2, movetimeMs: 150 })
    check('playVariant crazyhouse returns a move', typeof zhMove.bestmove === 'string' && zhMove.bestmove.length >= 4, JSON.stringify(zhMove))

    const kothMove = await api.playVariant({ kind: 'kingofthehill', fen: START, level: 1, movetimeMs: 100 })
    check('playVariant kingofthehill returns a move', typeof kothMove.bestmove === 'string' && kothMove.bestmove.length >= 4, JSON.stringify(kothMove))

    const badLevel = await api.playVariant({ kind: 'atomic', fen: START, level: 9 }).then(() => null, (e) => e.message)
    check('playVariant level out of range throws', badLevel === 'engine: level out of range')
  } catch (err) {
    failures++
    console.error('FAIL  fairy wasm integration:', err)
  }

  // playGo / estimateGo: honest desktop-only BotUnavailableError.
  const goErr = await api.playGo({ size: 9, komi: 5.5, moves: [], level: 1 }).then(() => null, (e) => e)
  check(
    'playGo rejects with BotUnavailableError + web copy',
    goErr && goErr.name === 'BotUnavailableError' && goErr.message === 'Go bots are coming to the web, available today in the desktop app.',
    goErr && `${goErr.name}: ${goErr.message}`
  )
  const estErr = await api.estimateGo({ size: 9, komi: 5.5, moves: [] }).then(() => null, (e) => e)
  check('estimateGo rejects with BotUnavailableError', estErr && estErr.name === 'BotUnavailableError')

  // onLine/onBestmove subscriptions detach cleanly (no engine needed).
  const un = api.onLine(() => {})
  const un2 = api.onBestmove(() => {})
  check('onLine/onBestmove return unsubscribers', typeof un === 'function' && typeof un2 === 'function' && (un(), un2(), true))

  fairyModuleRef?.terminate?.()
}

console.log(failures === 0 ? '\nAll web-engine checks passed.' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
