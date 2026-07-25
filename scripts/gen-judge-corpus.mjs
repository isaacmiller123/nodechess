#!/usr/bin/env node
// Judge-config Elo-corpus generator, A5 brick J3 (spec §8 Tier-1: "the estElo
// anchor fit must be re-run against a corpus analyzed at the judge's fixed-node
// config"; the shipped depth-12 MultiPV-2 fit does not transfer).
//
// GAME GENERATION is identical to scripts/gen-elo-corpus.mjs (shared machinery
// in scripts/lib/game-gen.mjs): engine-vs-engine at KNOWN strengths with the
// bundled native Stockfish: native UCI_Elo movetime play >= 1320, the
// production sub-floor pick model below, random 6-ply book, self/cross1/cross2
// schedule.
//
// The ANALYSIS side is the REAL JUDGE CORE, not the review pipeline: each
// finished game is judged through src/shared/accounts/judge judgeGame() over
// the Node adapter (server/judge/nodeAdapter.ts; pinned WASM behind the
// content-hash gate) at judgeConfigForTier(1): per-position `go nodes 200000`,
// MultiPV 4, Hash 16, single thread, ucinewgame + TT clear per judged game.
// Positions are every fenBefore of the game in transcript order, plus the
// final fenAfter when it is not terminal (so the last move has an after-eval).
//
// acpl/accuracy are then DERIVED FROM THE JudgeOutput with review-math parity
// (src/main/analysis/accuracy.ts, esbuild-bundled): per ply, best eval = the
// rank-1 judge line (mover POV); played eval = the matching MultiPV line if
// the played move is among the judged candidates (canonical-UCI compare),
// else the NEXT judged position's rank-1 eval negated to the mover's POV;
// delivered checkmate => mate 1; terminal non-mate tail => cp 0 (review's
// missing-line convention). Mate -> +/-1000 cpLoss mapping and the
// winPercent -> moveAccuracy -> gameAccuracy / acpl folds are the exact
// shipped math.
//
// Emits JSONL rows (2 per game, one per side) APPENDED to
// scripts/data/judge-elo-corpus.jsonl: the gen-elo-corpus row schema with the
// judge config stamp instead of analysisDepth:
//   { trueElo, oppElo, accuracy, acpl, nMoves, result, color, kind, plies,
//     ending, judgeNodes, judgeMultiPv, judgeParams: PARAMS_A5_DIGEST,
//     gameKey, ts }
//
// Usage:
//   node scripts/gen-judge-corpus.mjs [--self 7] [--cross1 4] [--cross2 3]
//        [--bands 400,...,2700] [--concurrency 4] [--movetime 120]
//        [--max-plies 160] [--out scripts/data/judge-elo-corpus.jsonl]
//        [--fresh] [--engine path]
//
// Runtime guide: a game is ~5-10s to play and ~30-60s to judge (the judge WASM
// is single-thread at 200k nodes/position). Use --self 1 --cross1 0 --cross2 0
// --bands 800,1500 for a smoke pass; scale the schedule to your wall budget.

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { appendFileSync, writeFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Chess } from 'chessops'
import { parseFen } from 'chessops/fen'
import { Uci, defaultEnginePath } from './lib/uci.mjs'
import { NATIVE_FLOOR, BOOK_PLIES, playGame, buildSchedule } from './lib/game-gen.mjs'

// ---- CLI ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
function flag(name, def) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const has = (name) => argv.includes(`--${name}`)

const SELF_GAMES = Number(flag('self', '7'))
const CROSS1_GAMES = Number(flag('cross1', '4'))
const CROSS2_GAMES = Number(flag('cross2', '3'))
const BANDS = flag('bands', '400,600,800,1000,1200,1320,1500,1700,1900,2100,2300,2500,2700')
  .split(',')
  .map(Number)
const CONCURRENCY = Number(flag('concurrency', '4'))
const MOVETIME = Number(flag('movetime', '120'))
const MAX_PLIES = Number(flag('max-plies', '160'))

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = flag('engine', defaultEnginePath(repoRoot))
const OUT = path.resolve(repoRoot, flag('out', 'scripts/data/judge-elo-corpus.jsonl'))

// The pinned judge WASM build (content-hash-gated by the adapter itself).
const JUDGE_ENGINE_JS = path.resolve(repoRoot, 'node_modules/stockfish/bin/stockfish-18-lite-single.js')
const JUDGE_ENGINE_WASM = path.resolve(repoRoot, 'node_modules/stockfish/bin/stockfish-18-lite-single.wasm')

// ---- Bundle the REAL review math (accuracy.ts) + the REAL judge core ----------------

const cacheRoot = path.resolve(repoRoot, 'node_modules/.cache/judge-corpus')
mkdirSync(cacheRoot, { recursive: true })
const bundleDir = mkdtempSync(path.join(cacheRoot, 'run-'))
process.on('exit', () => rmSync(bundleDir, { recursive: true, force: true }))

async function bundle(entryContents, outName) {
  const entry = path.join(bundleDir, `${outName}.entry.ts`)
  writeFileSync(entry, entryContents)
  const outfile = path.join(bundleDir, `${outName}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': path.resolve(repoRoot, 'src/shared') },
    absWorkingDir: repoRoot,
    logLevel: 'warning'
  })
  return import(pathToFileURL(outfile).href)
}

const SHARED_JUDGE = path.resolve(repoRoot, 'src/shared/accounts/judge').replace(/\\/g, '/')
const SERVER_JUDGE = path.resolve(repoRoot, 'server/judge').replace(/\\/g, '/')
const A = await bundle(
  `export * from '${path.resolve(repoRoot, 'src/main/analysis/accuracy.ts').replace(/\\/g, '/')}'`,
  'accuracy'
)
const J = await bundle(
  [
    `export * as core from '${SHARED_JUDGE}/index.ts'`,
    `export * as adapter from '${SERVER_JUDGE}/nodeAdapter.ts'`
  ].join('\n'),
  'judge'
)
const { core, adapter } = J

const T1 = core.judgeConfigForTier(1)
const JUDGE_PARAMS = core.PARAMS_A5_DIGEST

// ---- Judge-output -> per-side accuracy/acpl (review-math parity) --------------------

/** JudgeLine -> review-style eval { cp, mate } (mover POV, exactly one set). */
const lineEval = (l) => (l.mate !== undefined ? { cp: null, mate: l.mate } : { cp: l.cp, mate: null })
const negateEval = (e) => ({
  cp: e.cp != null ? -e.cp : null,
  mate: e.mate != null ? -e.mate : null
})
/** review.ts mateToCpSide parity (mate 0 = already mated = losing extreme). */
const mateToCpSide = (mate) => (mate === 0 ? -1000 : Math.sign(mate) * 1000)

/** Build the judged-position list for a game: every fenBefore + non-terminal tail. */
function judgePositions(plies) {
  const positions = plies.map((p, i) => ({ ply: i, fen: p.fenBefore }))
  const lastAfter = plies[plies.length - 1].fenAfter
  const pos = Chess.fromSetup(parseFen(lastAfter).unwrap()).unwrap()
  if (!pos.isEnd()) positions.push({ ply: plies.length, fen: lastAfter })
  return positions
}

/**
 * Derive per-side { accuracy, acpl, nMoves } from the canonical JudgeOutput
 * (same rounding as review's sideSummary / gen-elo-corpus analyzeGame).
 */
function summarizeJudged(plies, out) {
  const judged = out.positions // judged[i].ply === i, one per ply (+ optional tail)
  const perMove = [] // { color, accuracy, cpLoss, winAfter }
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i]
    const color = p.fenBefore.split(' ')[1] === 'w' ? 'white' : 'black'
    const bestEval = lineEval(judged[i].lines[0]) // rank 1, mover POV

    let playedEval = null
    if (p.mateDelivered) {
      playedEval = { cp: null, mate: 1 }
    } else {
      const playedC = A.canonicalUci(p.fenBefore, p.uci)
      for (const l of judged[i].lines) {
        if (A.canonicalUci(p.fenBefore, l.move) === playedC) {
          playedEval = lineEval(l)
          break
        }
      }
      if (!playedEval) {
        playedEval =
          i + 1 < judged.length
            ? // next judged position is the position AFTER the played move:
              // opponent to move -> negate to the mover's POV.
              negateEval(lineEval(judged[i + 1].lines[0]))
            : // terminal non-mate tail (stalemate/draw): review's missing-line
              // convention (infoToEval(undefined) => cp 0).
              { cp: 0, mate: null }
      }
    }

    const winBefore = A.winPercent(bestEval.cp, bestEval.mate)
    const winAfter = A.winPercent(playedEval.cp, playedEval.mate)
    const accuracy = A.moveAccuracy(winBefore, winAfter)
    const cpBefore = bestEval.mate != null ? mateToCpSide(bestEval.mate) : (bestEval.cp ?? 0)
    const cpAfter = playedEval.mate != null ? mateToCpSide(playedEval.mate) : (playedEval.cp ?? 0)
    const cpLoss = Math.max(0, Math.min(1000, cpBefore - cpAfter))
    perMove.push({ color, accuracy, cpLoss, winAfter })
  }

  // Summaries: review.ts summarize()/sideSummary() parity (as gen-elo-corpus).
  const whitePovWin = []
  const blackPovWin = []
  const acc = { white: [], black: [] }
  const loss = { white: [], black: [] }
  const idx = { white: [], black: [] }
  perMove.forEach((m, i) => {
    const whitePov = m.color === 'white' ? m.winAfter : 100 - m.winAfter
    whitePovWin.push(whitePov)
    blackPovWin.push(100 - whitePov)
    acc[m.color].push(m.accuracy)
    loss[m.color].push(m.cpLoss)
    idx[m.color].push(i)
  })
  const side = (c) => ({
    accuracy:
      Math.round(A.gameAccuracy(acc[c], c === 'white' ? whitePovWin : blackPovWin, idx[c]) * 10) /
      10,
    acpl: Math.round(A.acpl(loss[c])),
    nMoves: acc[c].length
  })
  return { white: side('white'), black: side('black') }
}

// ---- Runner ---------------------------------------------------------------------------

async function main() {
  mkdirSync(path.dirname(OUT), { recursive: true })
  if (has('fresh')) writeFileSync(OUT, '')

  const schedule = buildSchedule(BANDS, SELF_GAMES, CROSS1_GAMES, CROSS2_GAMES)
  console.log(`play engine:  ${ENGINE}`)
  console.log(`judge engine: ${JUDGE_ENGINE_WASM} (content-hash-gated)`)
  console.log(
    `games: ${schedule.length} (self ${SELF_GAMES}/band +2 edge, cross1 ${CROSS1_GAMES}, cross2 ${CROSS2_GAMES}) | ` +
      `judge nodes ${T1.nodes} MultiPV ${T1.multiPv} Hash ${T1.hashMb} | movetime ${MOVETIME}ms | ` +
      `out: ${path.relative(repoRoot, OUT)}`
  )

  let nextGame = 0
  let done = 0
  let failed = 0
  const t0 = Date.now()

  async function worker(wid) {
    const whiteEng = new Uci(ENGINE)
    const blackEng = new Uci(ENGINE)
    const openingEng = new Uci(ENGINE)
    await whiteEng.init()
    await blackEng.init()
    await openingEng.init()
    // Opening-book engine mirrors gen-elo-corpus's analyzer setup (full strength).
    openingEng.setOption('UCI_LimitStrength', 'false')
    openingEng.setOption('Skill Level', 20)
    openingEng.setOption('Hash', 128)
    // The judge-dedicated instance (pinned WASM, hash-gated at spawn).
    const judgeEng = await adapter.newNodeJudgeEngine({
      enginePath: JUDGE_ENGINE_JS,
      wasmPath: JUDGE_ENGINE_WASM
    })

    while (true) {
      const i = nextGame++
      if (i >= schedule.length) break
      const [whiteElo, blackElo] = schedule[i]
      try {
        const tPlay = Date.now()
        const { plies, resultWhite, ending } = await playGame(
          whiteEng,
          blackEng,
          openingEng,
          whiteElo,
          blackElo,
          { movetime: MOVETIME, maxPlies: MAX_PLIES, bookPlies: BOOK_PLIES }
        )
        if (plies.length < 8) throw new Error(`degenerate game (${plies.length} plies)`)
        const tJudge = Date.now()
        // THE judge: per-game ucinewgame + TT clear, fixed nodes, MultiPV 4.
        const out = await core.judgeGame(judgeEng, judgePositions(plies), T1)
        const s = summarizeJudged(plies, out)
        const tDone = Date.now()
        const gameKey = `jg${Date.now().toString(36)}-${wid}-${i}`
        const ts = Date.now()
        const base = {
          result: resultWhite,
          plies: plies.length,
          ending,
          judgeNodes: T1.nodes,
          judgeMultiPv: T1.multiPv,
          judgeParams: JUDGE_PARAMS,
          gameKey,
          ts
        }
        const rows = [
          {
            trueElo: whiteElo,
            oppElo: blackElo,
            ...s.white,
            ...base,
            color: 'white',
            kind: whiteElo >= NATIVE_FLOOR ? 'native' : 'weak'
          },
          {
            trueElo: blackElo,
            oppElo: whiteElo,
            ...s.black,
            ...base,
            result: 1 - resultWhite,
            color: 'black',
            kind: blackElo >= NATIVE_FLOOR ? 'native' : 'weak'
          }
        ]
        appendFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
        done++
        const el = ((Date.now() - t0) / 1000).toFixed(0)
        process.stderr.write(
          `\r  game ${done}/${schedule.length} done (${failed} failed, ${el}s)  ` +
            `last: ${whiteElo}v${blackElo} ${ending} ${plies.length}p ` +
            `play ${((tJudge - tPlay) / 1000).toFixed(0)}s judge ${((tDone - tJudge) / 1000).toFixed(0)}s ` +
            `wAcc ${s.white.accuracy} bAcc ${s.black.accuracy}   `
        )
      } catch (e) {
        failed++
        process.stderr.write(`\n  game ${i} (${whiteElo}v${blackElo}) error: ${e.message} (skipped)\n`)
      }
    }
    whiteEng.quit()
    blackEng.quit()
    openingEng.quit()
    await judgeEng.close()
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, schedule.length) }, (_, w) => worker(w))
  )
  process.stderr.write('\n')
  printSummary()
}

function printSummary() {
  if (!existsSync(OUT)) return
  const rows = readFileSync(OUT, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const byBand = new Map()
  for (const r of rows) {
    if (!byBand.has(r.trueElo)) byBand.set(r.trueElo, [])
    byBand.get(r.trueElo).push(r)
  }
  const stats = (xs) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length)
    return { mean, std }
  }
  console.log(`\ncorpus: ${rows.length} rows total (${path.relative(repoRoot, OUT)})`)
  console.log('band   n     accMean accStd  acplMean  movesMean  score%')
  for (const band of [...byBand.keys()].sort((a, b) => a - b)) {
    const rs = byBand.get(band)
    const a = stats(rs.map((r) => r.accuracy))
    const c = stats(rs.map((r) => r.acpl))
    const m = stats(rs.map((r) => r.nMoves))
    const sc = (100 * rs.reduce((x, r) => x + r.result, 0)) / rs.length
    console.log(
      `${String(band).padEnd(6)} ${String(rs.length).padEnd(5)} ` +
        `${a.mean.toFixed(1).padEnd(7)} ${a.std.toFixed(1).padEnd(7)} ` +
        `${c.mean.toFixed(0).padEnd(9)} ${m.mean.toFixed(0).padEnd(10)} ${sc.toFixed(0)}`
    )
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
