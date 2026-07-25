#!/usr/bin/env node
// A5 J6. Calibration corpus generator: honest known-strength games AND the
// seeded cheater-bot families, all judged through the REAL judge core at the
// Tier-1 config, emitting full canonical Tier1Records (spec §14-A5 proof:
// "seeded cheater bots convicted within the K-window; honest holdout never
// flagged"; §7(a) empty-margin obligation).
//
// GAME GENERATION reuses scripts/lib/game-gen.mjs verbatim for honest play
// (native UCI_Elo ≥ 1320, production weak pick model below, random 6-ply
// book, self/cross1/cross2 schedule). Cheater games mirror playGame()'s loop
// (same adjudication, same book) with the SUBJECT side's move source swapped:
//
//   --family honest   both sides play at their band (the calibration corpus:
//                     per-band engine-match anchors + σ_match / σ_acpl and
//                     the honest-holdout z distribution come from these rows)
//   --family full     subject plays the judge's rank-1 move EVERY own ply
//                     (fresh judgeGame() per position at judgeConfigForTier(1).
//                     The assistance IS the pinned judge engine)
//   --family half     subject consults the judge on every 2nd own ply
//                     (deterministic alternation ≈ 50% assistance)
//   --family thresh   THRESHOLD-ε: assistance METERED against the measured
//                     baseline to sit just under the deterministic escalation
//                     trigger (PARAMS_A5.zEscalateMicro over a reganK window).
//                     The assist probability p is solved from the corpus's
//                     OWN measured honest/full statistics (see meterThresh()
//                     below) unless --assist-micro pins it explicitly.
//
// Book plies are never assisted (an opening book is not engine assistance);
// the subject's non-assisted moves play at its native band strength. The
// subject color alternates per game so color advantage nulls out.
//
// ANALYSIS: every finished game is judged with judgeGame() over the pinned-
// WASM Node adapter at judgeConfigForTier(1). Positions are every fenBefore
// (plies 0..n−1, NO terminal tail: exactly the production Tier-1 surface,
// tier1.ts rejects judged plies beyond the transcript), and folded into a
// canonical Tier1Record (ladder 'calib', firstMover 'w', flat 0ms clocks:
// clock forensics is not a z input; acpl/match are what this corpus
// calibrates). Rows are one JSON object PER GAME (both sides' signals live in
// the record), appended to scripts/data/judge-calib-corpus.jsonl:
//
//   { v: 1, family, gameKey, whiteElo, blackElo, subject: 'w'|'b'|null,
//     assistProbMicro, assistPlan: [ply...], resultWhite2 (2×result: 0|1|2),
//     ending, nPlies, moves: [uci...], fens: [fenBefore...],
//     judgeNodes, judgeMultiPv, judgeParams, ts, rec: Tier1Record }
//
// Usage:
//   node scripts/gen-cheater-corpus.mjs --family honest [--self 7] [--cross1 4]
//        [--cross2 3] [--bands 400,...,2700] [--fresh]
//   node scripts/gen-cheater-corpus.mjs --family full|half [--games 30] [--elo 1500]
//   node scripts/gen-cheater-corpus.mjs --family thresh [--games 30] [--elo 1500]
//        [--target-z-micro 2600000 | --assist-micro N]
//   common: [--concurrency 4] [--movetime 120] [--max-plies 160]
//        [--out scripts/data/judge-calib-corpus.jsonl] [--engine path]
//        [--tag runTag]  (gameKey run tag: jc-<family>-<tag>-<i>; defaults to
//        a fresh base36 timestamp: pin it to make an APPEND run's keys
//        reproducible/identifiable; appends never touch existing rows)
//
// Runtime: a judged position ≈ 200k nodes of single-thread WASM; a game costs
// (assisted plies + all plies) positions. Budget with --games / the schedule.

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { appendFileSync, writeFileSync, mkdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Chess } from 'chessops'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { Uci, defaultEnginePath } from './lib/uci.mjs'
import { NATIVE_FLOOR, BOOK_PLIES, playGame, buildSchedule, configurePlayer, playerMove, randomOpening } from './lib/game-gen.mjs'

// ---- CLI ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
function flag(name, def) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const has = (name) => argv.includes(`--${name}`)

const FAMILY = flag('family', null)
if (!['honest', 'full', 'half', 'thresh'].includes(FAMILY)) {
  console.error('usage: gen-cheater-corpus.mjs --family honest|full|half|thresh [...]')
  process.exit(1)
}
const SELF_GAMES = Number(flag('self', '7'))
const CROSS1_GAMES = Number(flag('cross1', '4'))
const CROSS2_GAMES = Number(flag('cross2', '3'))
const BANDS = flag('bands', '400,600,800,1000,1200,1320,1500,1700,1900,2100,2300,2500,2700')
  .split(',')
  .map(Number)
const GAMES = Number(flag('games', '30'))
const SUBJECT_ELO = Number(flag('elo', '1500'))
const OPP_ELO = Number(flag('opp-elo', String(SUBJECT_ELO)))
const CONCURRENCY = Number(flag('concurrency', '4'))
const MOVETIME = Number(flag('movetime', '120'))
const MAX_PLIES = Number(flag('max-plies', '160'))
const TARGET_Z_MICRO = Number(flag('target-z-micro', '2600000'))
const ASSIST_MICRO_FLAG = flag('assist-micro', null)
const LADDER = flag('ladder', 'calib')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = flag('engine', defaultEnginePath(repoRoot))
const OUT = path.resolve(repoRoot, flag('out', 'scripts/data/judge-calib-corpus.jsonl'))

// The pinned judge WASM build (content-hash-gated by the adapter itself).
const JUDGE_ENGINE_JS = path.resolve(repoRoot, 'node_modules/stockfish/bin/stockfish-18-lite-single.js')
const JUDGE_ENGINE_WASM = path.resolve(repoRoot, 'node_modules/stockfish/bin/stockfish-18-lite-single.wasm')

// ---- Bundle the REAL judge core + Node adapter (gen-judge-corpus pattern) -----------

const cacheRoot = path.resolve(repoRoot, 'node_modules/.cache/cheater-corpus')
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
const { core, adapter } = await bundle(
  [
    `export * as core from '${SHARED_JUDGE}/index.ts'`,
    `export * as adapter from '${SERVER_JUDGE}/nodeAdapter.ts'`
  ].join('\n'),
  'judge'
)

const T1 = core.judgeConfigForTier(1)
const JUDGE_PARAMS = core.PARAMS_A5_DIGEST

// ---- Threshold-ε metering against the MEASURED baseline -----------------------------
//
// Per-game standardized deviation (tier2.ts gameDevMicro, in σ units):
//   dev = (devAcpl + devMatch) / 2
// For a subject at band E with assist probability p (assist ⇒ ≈ the FULL
// bot's per-move behavior), acpl/match interpolate linearly in p between the
// measured honest and full family means, so
//   dev(p) ≈ devHonest + p · (devFull − devHonest)
// The trailing-K trigger fires at z = dev·√K ≥ zEscalate; to sit just UNDER
// the frontier we target z = TARGET_Z_MICRO (default 2.6 < 3.0), i.e.
//   devT = targetZ / √K,   p = (devT − devH) / (devF − devH)
// with every statistic measured from THIS corpus's honest + full rows (the
// oracle a real metering cheater has, §7 threat model).
function meterThresh(rows) {
  const K = core.PARAMS_A5.reganK
  const honest = subjectSides(rows, 'honest')
  const full = subjectSides(rows, 'full')
  if (honest.length < 30 || full.length < 5) {
    throw new Error(
      `thresh metering needs honest (${honest.length} ≥ 30) and full (${full.length} ≥ 5) rows in ${OUT}. Run those families first`
    )
  }
  // Honest per-band expectations at the subject band (measured baseline).
  const band = honest.filter((s) => s.elo === SUBJECT_ELO)
  if (band.length < 10) throw new Error(`thresh metering: only ${band.length} honest rows at band ${SUBJECT_ELO} (need ≥ 10)`)
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  const std = (xs) => {
    const m = mean(xs)
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / xs.length)
  }
  const eAcpl = mean(band.map((s) => s.acplMicro))
  const eMatch = mean(band.map((s) => s.matchMicro))
  // σ about the per-band mean over ALL honest rows (residuals vs own band).
  const byBand = new Map()
  for (const s of honest) {
    if (!byBand.has(s.elo)) byBand.set(s.elo, [])
    byBand.get(s.elo).push(s)
  }
  const acplResid = []
  const matchResid = []
  for (const [, ss] of byBand) {
    const ma = mean(ss.map((s) => s.acplMicro))
    const mm = mean(ss.map((s) => s.matchMicro))
    for (const s of ss) {
      acplResid.push(s.acplMicro - ma)
      matchResid.push(s.matchMicro - mm)
    }
  }
  const sAcpl = std(acplResid)
  const sMatch = std(matchResid)
  const dev = (s) => ((eAcpl - s.acplMicro) / sAcpl + (s.matchMicro - eMatch) / sMatch) / 2
  const devH = mean(band.map(dev))
  const devF = mean(full.map(dev))
  const devT = TARGET_Z_MICRO / 1e6 / Math.sqrt(K)
  const p = Math.max(0, Math.min(1, (devT - devH) / (devF - devH)))
  console.log(
    `thresh metering: E[acpl]=${(eAcpl / 1e6).toFixed(1)}cp E[match]=${(eMatch / 1e6).toFixed(3)} ` +
      `σ_acpl=${(sAcpl / 1e6).toFixed(1)}cp σ_match=${(sMatch / 1e6).toFixed(3)} | ` +
      `devHonest=${devH.toFixed(3)}σ devFull=${devF.toFixed(3)}σ target=${devT.toFixed(3)}σ/game ⇒ p=${p.toFixed(4)}`
  )
  return Math.round(p * 1e6)
}

/** Flatten corpus rows to per-subject-side stats {elo, acplMicro, matchMicro}. */
function subjectSides(rows, family) {
  const out = []
  for (const r of rows) {
    if (r.family !== family) continue
    if (family === 'honest') {
      if (r.rec.w.scored >= 1) out.push({ elo: r.whiteElo, acplMicro: r.rec.w.acplMicro, matchMicro: r.rec.w.matchMicro })
      if (r.rec.b.scored >= 1) out.push({ elo: r.blackElo, acplMicro: r.rec.b.acplMicro, matchMicro: r.rec.b.matchMicro })
    } else if (r.subject && r.rec[r.subject].scored >= 1) {
      const s = r.rec[r.subject]
      out.push({ elo: r.subject === 'w' ? r.whiteElo : r.blackElo, acplMicro: s.acplMicro, matchMicro: s.matchMicro })
    }
  }
  return out
}

function readRows() {
  if (!existsSync(OUT)) return []
  return readFileSync(OUT, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// ---- Cheater game loop (playGame mirror with a subject move source) -----------------

/**
 * One cheater game: `subject` ('w'|'b') plays natively at subjectElo except on
 * assisted own plies, where the move is the judge engine's rank-1 line at the
 * TRUE Tier-1 config (fresh judgeGame per position: ucinewgame + TT clear,
 * the canonical assistance oracle). Book plies (opening engine) are never
 * assisted. Returns { plies, resultWhite, ending, assistPlan }.
 */
async function playCheaterGame(subjectEng, oppEng, openingEng, judgeEng, opts) {
  const { subject, subjectElo, oppElo, assistMicro, movetime, maxPlies } = opts
  await configurePlayer(subjectEng, subjectElo)
  await configurePlayer(oppEng, oppElo)

  const pos = Chess.default()
  const plies = await randomOpening(openingEng, pos, BOOK_PLIES)

  let hopelessStreak = 0
  let hopelessSign = 0
  let lastWhiteCp = 0
  let ownMoveIdx = 0
  let acc = 0
  const assistPlan = []

  while (plies.length < maxPlies) {
    if (pos.isEnd()) break
    if (pos.halfmoves >= 100) return { plies, resultWhite: 0.5, ending: '50move', assistPlan }
    const fen = makeFen(pos.toSetup())
    const whiteToMove = pos.turn === 'white'
    const subjectToMove = (subject === 'w') === whiteToMove

    let uci
    let cp
    let assisted = false
    if (subjectToMove) {
      // Deterministic metering accumulator: assist when acc rolls over 1.
      acc += assistMicro / 1e6
      if (acc >= 1 - 1e-9) {
        acc -= 1
        assisted = true
      }
      ownMoveIdx++
    }
    if (assisted) {
      const out = await core.judgeGame(judgeEng, [{ ply: 0, fen }], T1)
      const top = out.positions[0].lines[0]
      uci = top.move
      const raw = top.mate !== undefined ? (top.mate > 0 ? 1000 : -1000) : top.cp
      cp = Math.max(-1000, Math.min(1000, raw))
      assistPlan.push(plies.length)
    } else {
      const [eng, elo] = subjectToMove ? [subjectEng, subjectElo] : [oppEng, oppElo]
      const r = await playerMove(eng, elo, fen, pos.fullmoves, movetime)
      uci = r.uci
      cp = r.cp
    }
    if (!uci || uci === '(none)') break

    // Adjudication bookkeeping: VERBATIM playGame() semantics.
    const whiteCp = whiteToMove ? cp : -cp
    lastWhiteCp = whiteCp
    const sign = whiteCp > 0 ? 1 : -1
    if (Math.abs(whiteCp) >= 800 && (hopelessSign === 0 || sign === hopelessSign)) {
      hopelessStreak++
      hopelessSign = sign
    } else {
      hopelessStreak = 0
      hopelessSign = 0
    }

    const mv = parseUci(uci)
    if (!mv || !pos.isLegal(mv)) throw new Error(`illegal move ${uci} in ${fen}`)
    pos.play(mv)
    plies.push({ uci, fenBefore: fen, fenAfter: makeFen(pos.toSetup()), mateDelivered: pos.isCheckmate() })

    if (hopelessStreak >= 6) {
      return { plies, resultWhite: hopelessSign > 0 ? 1 : 0, ending: 'adjudicated', assistPlan }
    }
  }

  const outcome = pos.outcome()
  if (outcome && outcome.winner) {
    return { plies, resultWhite: outcome.winner === 'white' ? 1 : 0, ending: 'mate', assistPlan }
  }
  if (pos.isEnd()) return { plies, resultWhite: 0.5, ending: 'stalemate', assistPlan }
  const resultWhite = lastWhiteCp >= 250 ? 1 : lastWhiteCp <= -250 ? 0 : 0.5
  return { plies, resultWhite, ending: 'plycap', assistPlan }
}

// ---- Judge + record one finished game ----------------------------------------------

async function recordGame(judgeEng, gameKey, plies) {
  // THE normative Tier-1 surface via the canonical builder (judge.ts
  // transcriptToJudgePositions): every fenBefore, plies 0..n−1, bare FEN, no
  // tail: bit-identical to the inline mapping this corpus was measured on.
  const moves = plies.map((p, i) => ({ ply: i, move: p.uci, clockMs: { w: 0, b: 0 } }))
  const positions = core.transcriptToJudgePositions(moves, (i) => plies[i].fenBefore)
  const out = await core.judgeGame(judgeEng, positions, T1)
  return { out, rec: core.tier1Record(gameKey, LADDER, out, moves, 'w') }
}

// ---- Runner ------------------------------------------------------------------------

async function main() {
  mkdirSync(path.dirname(OUT), { recursive: true })
  if (has('fresh')) writeFileSync(OUT, '')

  // Per-family assist probability (micro).
  let assistMicro = 0
  if (FAMILY === 'full') assistMicro = 1_000_000
  else if (FAMILY === 'half') assistMicro = 500_000
  else if (FAMILY === 'thresh')
    assistMicro = ASSIST_MICRO_FLAG !== null ? Number(ASSIST_MICRO_FLAG) : meterThresh(readRows())

  const schedule =
    FAMILY === 'honest'
      ? buildSchedule(BANDS, SELF_GAMES, CROSS1_GAMES, CROSS2_GAMES)
      : Array.from({ length: GAMES }, (_, i) => (i % 2 === 0 ? [SUBJECT_ELO, OPP_ELO] : [OPP_ELO, SUBJECT_ELO]))

  console.log(`family: ${FAMILY}${FAMILY === 'thresh' || FAMILY === 'half' || FAMILY === 'full' ? ` (assist p=${(assistMicro / 1e6).toFixed(4)})` : ''}`)
  console.log(`play engine:  ${ENGINE}`)
  console.log(`judge engine: ${JUDGE_ENGINE_WASM} (content-hash-gated)`)
  console.log(
    `games: ${schedule.length} | judge nodes ${T1.nodes} MultiPV ${T1.multiPv} Hash ${T1.hashMb} | ` +
      `movetime ${MOVETIME}ms | ladder ${LADDER} | out: ${path.relative(repoRoot, OUT)}`
  )

  let nextGame = 0
  let done = 0
  let failed = 0
  const t0 = Date.now()
  const runTag = flag('tag', Date.now().toString(36))

  async function worker(wid) {
    const subjEng = new Uci(ENGINE)
    const oppEng = new Uci(ENGINE)
    const openingEng = new Uci(ENGINE)
    await subjEng.init()
    await oppEng.init()
    await openingEng.init()
    openingEng.setOption('UCI_LimitStrength', 'false')
    openingEng.setOption('Skill Level', 20)
    openingEng.setOption('Hash', 128)
    const judgeEng = await adapter.newNodeJudgeEngine({
      enginePath: JUDGE_ENGINE_JS,
      wasmPath: JUDGE_ENGINE_WASM
    })

    while (true) {
      const i = nextGame++
      if (i >= schedule.length) break
      const [whiteElo, blackElo] = schedule[i]
      // For cheater families the subject alternates color with the schedule.
      const subject = FAMILY === 'honest' ? null : whiteElo === SUBJECT_ELO && (i % 2 === 0 || blackElo !== SUBJECT_ELO) ? 'w' : 'b'
      let attempts = 0
      for (;;) {
        attempts++
        try {
          const tPlay = Date.now()
          const g =
            FAMILY === 'honest'
              ? {
                  ...(await playGame(subjEng, oppEng, openingEng, whiteElo, blackElo, {
                    movetime: MOVETIME,
                    maxPlies: MAX_PLIES,
                    bookPlies: BOOK_PLIES
                  })),
                  assistPlan: []
                }
              : await playCheaterGame(subjEng, oppEng, openingEng, judgeEng, {
                  subject,
                  subjectElo: SUBJECT_ELO,
                  oppElo: OPP_ELO,
                  assistMicro,
                  movetime: MOVETIME,
                  maxPlies: MAX_PLIES
                })
          if (g.plies.length < 8) throw new Error(`degenerate game (${g.plies.length} plies)`)
          const tJudge = Date.now()
          const gameKey = `jc-${FAMILY}-${runTag}-${i}`
          const { rec } = await recordGame(judgeEng, gameKey, g.plies)
          const tDone = Date.now()
          const row = {
            v: 1,
            family: FAMILY,
            gameKey,
            whiteElo,
            blackElo,
            subject,
            assistProbMicro: assistMicro,
            assistPlan: g.assistPlan,
            resultWhite2: Math.round(g.resultWhite * 2),
            ending: g.ending,
            nPlies: g.plies.length,
            moves: g.plies.map((p) => p.uci),
            fens: g.plies.map((p) => p.fenBefore),
            judgeNodes: T1.nodes,
            judgeMultiPv: T1.multiPv,
            judgeParams: JUDGE_PARAMS,
            ts: Date.now(),
            rec
          }
          appendFileSync(OUT, JSON.stringify(row) + '\n')
          done++
          const el = ((Date.now() - t0) / 1000).toFixed(0)
          const sub = subject ? rec[subject] : rec.w
          process.stderr.write(
            `\r  game ${done}/${schedule.length} (${failed} failed, ${el}s)  ` +
              `last: ${whiteElo}v${blackElo}${subject ? ` subj=${subject}` : ''} ${g.ending} ${g.plies.length}p ` +
              `play ${((tJudge - tPlay) / 1000).toFixed(0)}s judge ${((tDone - tJudge) / 1000).toFixed(0)}s ` +
              `acpl ${(sub.acplMicro / 1e6).toFixed(0)} match ${(sub.matchMicro / 1e6).toFixed(2)}   `
          )
          break
        } catch (e) {
          if (attempts >= 3) {
            failed++
            process.stderr.write(`\n  game ${i} (${whiteElo}v${blackElo}) failed ${attempts}x: ${e.message} (skipped)\n`)
            break
          }
          process.stderr.write(`\n  game ${i} retry ${attempts}: ${e.message}\n`)
        }
      }
    }
    subjEng.quit()
    oppEng.quit()
    openingEng.quit()
    await judgeEng.close()
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, schedule.length) }, (_, w) => worker(w)))
  process.stderr.write('\n')
  printSummary()
}

function printSummary() {
  const rows = readRows()
  const fams = new Map()
  for (const r of rows) {
    if (!fams.has(r.family)) fams.set(r.family, [])
    fams.get(r.family).push(r)
  }
  console.log(`\ncorpus: ${rows.length} game rows (${path.relative(repoRoot, OUT)})`)
  for (const [fam, rs] of fams) {
    const sides = subjectSides(rows, fam)
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
    const score =
      fam === 'honest'
        ? 'n/a'
        : (
            rs.reduce((a, r) => a + (r.subject === 'w' ? r.resultWhite2 : 2 - r.resultWhite2), 0) /
            (2 * rs.length)
          ).toFixed(3)
    console.log(
      `  ${fam.padEnd(7)} games ${String(rs.length).padEnd(4)} sides ${String(sides.length).padEnd(4)} ` +
        `acplMean ${(mean(sides.map((s) => s.acplMicro)) / 1e6).toFixed(1)}cp ` +
        `matchMean ${(mean(sides.map((s) => s.matchMicro)) / 1e6).toFixed(3)} subjScore ${score}`
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
