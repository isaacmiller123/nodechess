#!/usr/bin/env node
// Calibration harness for the sub-1320 weak-bot pick model (spec: docs/
// GAMES-PLATFORM-SPEC.md §Bot side-quests item 1).
//
// For each target band (default 400/600/800/1000/1200) it plays N fast games
// between a candidate weak config and a reference anchor: the SAME Stockfish
// binary at UCI_Elo 1320 (the native floor), searching at a small fixed depth.
// Score% vs the anchor is converted to an implied Elo gap:
//     impliedElo = 1320 + 400*log10(score/(1-score))
// A well-calibrated band should come out near its label, and MUST be
// monotonically ordered (400 << 1200 << 1320).
//
// The pick model + UCI driver live in scripts/lib/weak-model.mjs and
// scripts/lib/uci.mjs (shared with scripts/gen-elo-corpus.mjs); the pick model
// MIRRORS src/main/ipc/engine.ipc.ts: keep in sync when tuning.
//
// Usage:
//   node scripts/calibrate-weak.mjs [--games 40] [--bands 400,600,800,1000,1200]
//        [--models new,old] [--concurrency 4] [--engine path/to/stockfish]
//        [--anchor-depth 8] [--max-plies 180]
//
// Runtime guide: one game is a few seconds (depth<=8 both sides + eval
// adjudication of hopeless positions). 40 games x 5 bands at concurrency 4 is
// roughly 10-20 minutes; use --games 6 for a minutes-long smoke pass.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Chess } from 'chessops'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { Uci, defaultEnginePath } from './lib/uci.mjs'
import { lerpByElo, weakDepth, weakMultiPv, softmaxPick, pickWeakMove } from './lib/weak-model.mjs'

// ---- CLI -------------------------------------------------------------------------

const argv = process.argv.slice(2)
function flag(name, def) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def
}
const GAMES = Number(flag('games', '40'))
const BANDS = flag('bands', '400,600,800,1000,1200').split(',').map(Number)
const MODELS = flag('models', 'new').split(',') // new | old
const CONCURRENCY = Number(flag('concurrency', '4'))
const ANCHOR_DEPTH = Number(flag('anchor-depth', '8'))
const MAX_PLIES = Number(flag('max-plies', '180'))
const ANCHOR_ELO = 1320

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = flag('engine', defaultEnginePath(repoRoot))

// ---- Pick models -------------------------------------------------------------------

/** NEW model: the shared production mirror (scripts/lib/weak-model.mjs). */
const pickNew = (cands, elo, fullmove) => pickWeakMove(cands, elo, fullmove, false)

/** OLD model: the flat softmax + bottom-half blunder this branch replaced. */
function pickOld(cands, elo) {
  const oldTemp = lerpByElo(elo, 100, 650, 1250, 50)
  const oldBlunder = lerpByElo(elo, 100, 0.25, 1300, 0.03)
  if (cands.length >= 2 && Math.random() < oldBlunder) {
    const bottom = cands.slice(Math.ceil(cands.length / 2))
    return bottom[Math.floor(Math.random() * bottom.length)].uci
  }
  // flat softmax (knee -> infinity)
  return softmaxPick(cands, oldTemp, Number.POSITIVE_INFINITY)
}

// ---- One game ---------------------------------------------------------------------

/**
 * Plays one game: weak(model,elo) vs anchor(1320). weakIsWhite alternates.
 * Returns weak bot's score: 1 / 0.5 / 0.
 */
async function playGame(weakEng, anchorEng, model, elo, weakIsWhite) {
  const pos = Chess.default()
  let plies = 0
  let hopelessStreak = 0 // consecutive anchor evals >= +8 pawns for one side
  while (plies < MAX_PLIES) {
    if (pos.isEnd()) break
    if (pos.halfmoves >= 100) return 0.5 // 50-move rule
    const fen = makeFen(pos.toSetup())
    const whiteToMove = pos.turn === 'white'
    const weakToMove = whiteToMove === weakIsWhite
    let uci
    if (weakToMove) {
      const { cands, best } = await weakEng.searchMultiPv(fen, weakDepth(elo), weakMultiPv(elo))
      if (best === '(none)' || !best) break
      const fullmove = pos.fullmoves
      uci = cands.length ? (model === 'old' ? pickOld(cands, elo) : pickNew(cands, elo, fullmove)) : best
    } else {
      const { move, cp } = await anchorEng.bestMove(fen, { depth: ANCHOR_DEPTH })
      if (move === '(none)' || !move) break
      uci = move
      // Adjudicate hopeless games early (cp is anchor's side-to-move view).
      if (Math.abs(cp) >= 800) hopelessStreak++
      else hopelessStreak = 0
      if (hopelessStreak >= 3) {
        const anchorWinning = cp > 0
        const weakWins = anchorWinning === false
        return weakWins ? 1 : 0
      }
    }
    const move = parseUci(uci)
    if (!move || !pos.isLegal(move)) {
      throw new Error(`illegal move ${uci} in ${fen}`)
    }
    pos.play(move)
    plies++
  }
  const outcome = pos.outcome()
  if (outcome && outcome.winner) {
    return (outcome.winner === 'white') === weakIsWhite ? 1 : 0
  }
  if (pos.isEnd()) return 0.5 // stalemate / insufficient material
  // Ply cap without adjudication: score by final anchor eval.
  const { cp } = await anchorEng.bestMove(makeFen(pos.toSetup()), { depth: ANCHOR_DEPTH })
  const stmIsWeak = (pos.turn === 'white') === weakIsWhite
  const weakCp = stmIsWeak ? cp : -cp
  return weakCp >= 250 ? 1 : weakCp <= -250 ? 0 : 0.5
}

// ---- Runner -----------------------------------------------------------------------

function impliedElo(score, n) {
  // Clamp so 0% / 100% at small N stays finite (half-a-game correction).
  const s = Math.min(1 - 0.5 / n, Math.max(0.5 / n, score))
  return Math.round(ANCHOR_ELO + 400 * Math.log10(s / (1 - s)))
}

async function runConfig(model, elo) {
  let scoreSum = 0
  let done = 0
  const results = []
  let gameIdx = 0
  async function worker() {
    const weakEng = new Uci(ENGINE)
    const anchorEng = new Uci(ENGINE)
    await weakEng.init()
    await anchorEng.init()
    weakEng.send('setoption name UCI_LimitStrength value false')
    weakEng.send('setoption name Skill Level value 20')
    anchorEng.send('setoption name UCI_LimitStrength value true')
    anchorEng.send(`setoption name UCI_Elo value ${ANCHOR_ELO}`)
    while (true) {
      const i = gameIdx++
      if (i >= GAMES) break
      weakEng.send('ucinewgame')
      anchorEng.send('ucinewgame')
      await weakEng.ready()
      await anchorEng.ready()
      try {
        const s = await playGame(weakEng, anchorEng, model, elo, i % 2 === 0)
        scoreSum += s
        done++
        results.push(s)
        process.stderr.write(
          `\r  [${model} ${elo}] game ${done}/${GAMES}  score so far ${(100 * scoreSum) / done | 0}%   `
        )
      } catch (e) {
        process.stderr.write(`\n  [${model} ${elo}] game ${i} error: ${e.message} (skipped)\n`)
      }
    }
    weakEng.quit()
    anchorEng.quit()
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, GAMES) }, worker))
  process.stderr.write('\n')
  const n = done || 1
  const score = scoreSum / n
  const wins = results.filter((r) => r === 1).length
  const draws = results.filter((r) => r === 0.5).length
  return { model, elo, n: done, score, wins, draws, losses: done - wins - draws, implied: impliedElo(score, n) }
}

async function main() {
  console.log(`engine: ${ENGINE}`)
  console.log(`anchor: UCI_Elo ${ANCHOR_ELO} @ depth ${ANCHOR_DEPTH} | games/config: ${GAMES} | models: ${MODELS.join(',')}`)
  const rows = []
  for (const elo of BANDS) {
    for (const model of MODELS) {
      rows.push(await runConfig(model, elo))
    }
  }
  console.log('\nband   model  games  W-D-L      score%   impliedElo  target  err')
  for (const r of rows) {
    console.log(
      `${String(r.elo).padEnd(6)} ${r.model.padEnd(6)} ${String(r.n).padEnd(6)} ` +
        `${`${r.wins}-${r.draws}-${r.losses}`.padEnd(10)} ${(100 * r.score).toFixed(1).padEnd(8)} ` +
        `${String(r.implied).padEnd(11)} ${String(r.elo).padEnd(7)} ${r.implied - r.elo >= 0 ? '+' : ''}${r.implied - r.elo}`
    )
  }
  console.log(
    '\nNote: at small N the 95% CI is wide (~±100-200 Elo at N=40). Direction and\nmonotonic ordering across bands matter more than absolute values.'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
