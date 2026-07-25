#!/usr/bin/env node
// Headless stress-test of the bot time manager (src/renderer/src/features/play/
// botTime.ts — the PURE CORE section). esbuild-bundles the real module, then
// simulates hundreds of games per {time control} x {clock personality} cohort
// with synthetic per-move probe signals, and asserts the clock behavior the
// feature promises:
//   * clocks never go negative (a flag is a clean stop at 0),
//   * total spend is sanely proportional to the available budget
//     (and blitzer < steady < tanker per control),
//   * the tanker flags in SOME 1+0 games; the blitzer ~never flags at 5+5,
//   * think time correlates strongly with the complexity multiplier,
//   * instant-class (forced) moves stay under 2s.
//
// Usage: node scripts/sim-bot-time.mjs [--seed N] [--games N]

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(ROOT, 'src/renderer/src/features/play/botTime.ts')
const OUT_DIR = path.join(ROOT, 'node_modules/.cache/nodechess-sim')
const OUT = path.join(OUT_DIR, 'botTime.bundle.mjs')

const args = process.argv.slice(2)
function argOf(flag, fallback) {
  const i = args.indexOf(flag)
  if (i !== -1 && args[i + 1] !== undefined) return Number(args[i + 1])
  return fallback
}
const SEED = argOf('--seed', 20260702)
const GAMES = argOf('--games', 240) // per cohort (>= 200 per the spec)

// ---- Bundle the real botTime.ts and import its core -------------------------

mkdirSync(OUT_DIR, { recursive: true })
await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: OUT,
  logLevel: 'silent'
})
const bt = await import(pathToFileURL(OUT).href)
const { TIME_PERSONALITIES, complexityMultiplier, expectedMovesLeft, planThink, isPanic } = bt

// ---- Deterministic RNG (mulberry32) -----------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(rng) {
  const u1 = Math.max(rng(), 1e-12)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng())
}

// ---- Synthetic per-move probe signals ---------------------------------------

function syntheticSignals(rng) {
  return {
    gapCp: Math.min(600, Math.round(-100 * Math.log(Math.max(1e-12, 1 - rng())))), // exp-ish: many clear-best positions
    unstable: rng() < 0.15,
    bestCp: Math.round(gauss(rng) * 200),
    surprise: rng() < 0.1
  }
}

// ---- One simulated game (the bot side's clock only) --------------------------

const CONTROLS = [
  { id: '3+0', baseMs: 180_000, incMs: 0 },
  { id: '5+5', baseMs: 300_000, incMs: 5_000 },
  { id: '1+0', baseMs: 60_000, incMs: 0 }
]
const STYLES = ['blitzer', 'steady', 'tanker']

function playGame(control, personality, rng) {
  const botMoves = 35 + Math.floor(rng() * 56) // 35..90 bot moves if it lasts
  const bookLen = 4 + Math.floor(rng() * 7) // 4..10 theory moves
  let remaining = control.baseMs
  let spent = 0
  let flagged = false
  let minRemaining = remaining
  let movesCompleted = 0
  const moves = [] // per-move records

  for (let i = 1; i <= botMoves; i++) {
    const phase = Math.max(0, Math.min(1, 1 - (i - 1) / 55 + (rng() - 0.5) * 0.06))
    let cls = 'normal'
    let complexity = 1
    if (i <= bookLen) cls = 'book'
    else if (rng() < 0.12) cls = 'instant'
    if (cls === 'normal') complexity = complexityMultiplier(syntheticSignals(rng))

    // Base budget recomputed here (same formula) so the correlation check can
    // normalize spend by it.
    const tBase = remaining / expectedMovesLeft(i, phase) + 0.8 * control.incMs

    const plan = planThink({
      remainingMs: remaining,
      incrementMs: control.incMs,
      moveNumber: i,
      materialPhase: phase,
      personality,
      cls,
      complexity,
      rng
    })

    const spend = plan.totalMs
    if (spend >= remaining) {
      // The clock hits zero mid-think: clean flag, clock clamps at 0.
      spent += remaining
      remaining = 0
      minRemaining = 0
      flagged = true
      break
    }
    remaining -= spend
    spent += spend
    movesCompleted++
    minRemaining = Math.min(minRemaining, remaining)
    moves.push({ cls: plan.cls, panic: plan.panic, complexity: plan.complexity, spend, tBase })
    remaining += control.incMs // increment lands after completing the move
  }

  return { flagged, spent, movesCompleted, minRemaining, moves, botMoves }
}

// ---- Stats helpers -----------------------------------------------------------

function pearson(xs, ys) {
  const n = xs.length
  if (n < 3) return NaN
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  return sxy / Math.sqrt(sxx * syy)
}

/** Average ranks (ties get the mean rank). */
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const out = new Array(xs.length)
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[idx[k][1]] = r
    i = j + 1
  }
  return out
}

/** Spearman rank correlation — the right tool for a monotone relation with
 *  log-normal human noise and a complexity-gated tank tail (nonlinear but
 *  order-preserving; linear Pearson under-reads it by construction). */
function spearman(xs, ys) {
  return pearson(ranks(xs), ranks(ys))
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a')
const secs = (ms) => (ms / 1000).toFixed(2) + 's'

// ---- Run all cohorts ----------------------------------------------------------

let failures = 0
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures++
}

console.log(`sim-bot-time: ${GAMES} games x ${CONTROLS.length} controls x ${STYLES.length} styles (seed ${SEED})`)
console.log('')

const cohorts = []
for (const control of CONTROLS) {
  for (const style of STYLES) {
    const rng = mulberry32(SEED ^ (control.baseMs + control.incMs) ^ (style.length * 7919))
    const personality = TIME_PERSONALITIES[style]
    const games = []
    for (let g = 0; g < GAMES; g++) games.push(playGame(control, personality, rng))

    const flags = games.filter((g) => g.flagged).length
    const minRemaining = Math.min(...games.map((g) => g.minRemaining))
    const usedFracs = games.map((g) => g.spent / (control.baseMs + control.incMs * g.movesCompleted))
    const meanUsedFrac = usedFracs.reduce((a, b) => a + b, 0) / usedFracs.length
    const allMoves = games.flatMap((g) => g.moves)
    const meanSpend = allMoves.reduce((a, m) => a + m.spend, 0) / Math.max(1, allMoves.length)

    const normal = allMoves.filter((m) => m.cls === 'normal')
    const corrRaw = pearson(
      normal.map((m) => m.complexity),
      normal.map((m) => m.spend)
    )
    const corrNorm = pearson(
      normal.map((m) => m.complexity),
      normal.map((m) => m.spend / m.tBase)
    )
    const corrRank = spearman(
      normal.map((m) => m.complexity),
      normal.map((m) => m.spend / m.tBase)
    )

    const instant = allMoves.filter((m) => m.cls === 'instant')
    const book = allMoves.filter((m) => m.cls === 'book')
    const panic = allMoves.filter((m) => m.cls === 'panic')
    const maxInstant = instant.length ? Math.max(...instant.map((m) => m.spend)) : 0
    const maxSpend = allMoves.length ? Math.max(...allMoves.map((m) => m.spend)) : 0

    cohorts.push({
      control: control.id,
      style,
      flags,
      flagPct: (100 * flags) / GAMES,
      minRemaining,
      meanUsedFrac,
      meanSpend,
      corrRaw,
      corrNorm,
      corrRank,
      maxInstant,
      maxSpend,
      counts: { normal: normal.length, instant: instant.length, book: book.length, panic: panic.length },
      bookRange: book.length ? [Math.min(...book.map((m) => m.spend)), Math.max(...book.map((m) => m.spend))] : null,
      panicRange: panic.length ? [Math.min(...panic.map((m) => m.spend)), Math.max(...panic.map((m) => m.spend))] : null
    })
  }
}

// ---- Report -------------------------------------------------------------------

console.log(
  'cohort        flags     minRem  used%   spend/mv  r(raw)  r(/base)  rho(rank)  maxInstant  maxSpend'
)
for (const c of cohorts) {
  console.log(
    `${c.control.padEnd(5)} ${c.style.padEnd(7)} ${String(c.flags).padStart(3)} (${fmt(c.flagPct, 1).padStart(5)}%)` +
      `  ${String(c.minRemaining).padStart(6)}  ${fmt(100 * c.meanUsedFrac, 1).padStart(5)}%` +
      `  ${secs(c.meanSpend).padStart(8)}  ${fmt(c.corrRaw).padStart(6)}  ${fmt(c.corrNorm).padStart(8)}  ${fmt(c.corrRank).padStart(9)}` +
      `  ${secs(c.maxInstant).padStart(10)}  ${secs(c.maxSpend).padStart(8)}`
  )
}
console.log('')
console.log('move-class mix + fixed-band ranges (first cohort of each control):')
for (const c of cohorts.filter((c) => c.style === 'steady')) {
  console.log(
    `  ${c.control} steady: normal=${c.counts.normal} instant=${c.counts.instant} book=${c.counts.book} panic=${c.counts.panic}` +
      (c.bookRange ? `  book ${secs(c.bookRange[0])}-${secs(c.bookRange[1])}` : '') +
      (c.panicRange ? `  panic ${secs(c.panicRange[0])}-${secs(c.panicRange[1])}` : '')
  )
}
console.log('')

// ---- Assertions -----------------------------------------------------------------

console.log('assertions:')
const by = (control, style) => cohorts.find((c) => c.control === control && c.style === style)

// 1. Clocks never negative, anywhere.
check(
  cohorts.every((c) => c.minRemaining >= 0),
  'clocks never negative (min remaining >= 0 across all cohorts)'
)

// 2. Total spend sanely proportional to the available budget.
check(
  cohorts.every((c) => c.meanUsedFrac >= 0.15 && c.meanUsedFrac <= 1.0),
  `total spend proportional to budget (mean used 15%..100%; observed ${fmt(100 * Math.min(...cohorts.map((c) => c.meanUsedFrac)), 1)}%..${fmt(100 * Math.max(...cohorts.map((c) => c.meanUsedFrac)), 1)}%)`
)
check(
  CONTROLS.every(({ id }) => by(id, 'blitzer').meanSpend < by(id, 'steady').meanSpend && by(id, 'steady').meanSpend < by(id, 'tanker').meanSpend),
  'personality ordering: blitzer < steady < tanker mean spend per move (every control)'
)

// 3. Flagging behavior.
check(by('1+0', 'tanker').flags >= 3, `tanker flags in SOME 1+0 games (${by('1+0', 'tanker').flags}/${GAMES})`)
check(
  by('5+5', 'blitzer').flags === 0,
  `blitzer ~never flags at 5+5 (${by('5+5', 'blitzer').flags}/${GAMES})`
)

// 4. Complexity drives think time. Primary: Spearman rank correlation of the
// multiplier vs the base-normalized spend (the relation is monotone but
// nonlinear — log-normal noise + the complexity-gated tank tail — so rank
// correlation is the honest "strongly positive" measure). Secondary: linear
// Pearson on the raw spend must still be clearly positive.
check(
  cohorts.every((c) => c.corrRank > 0.6),
  `rank corr(complexity, spend/base) strongly positive in every cohort (min ${fmt(Math.min(...cohorts.map((c) => c.corrRank)))})`
)
check(
  cohorts.every((c) => c.corrRaw > 0.3),
  `linear corr(complexity, raw spend) positive in every cohort (min ${fmt(Math.min(...cohorts.map((c) => c.corrRaw)))})`
)

// 5. Instant-class moves under 2s (spec band is 0.4-1.5s).
check(
  cohorts.every((c) => c.maxInstant < 2000),
  `instant-class moves under 2s (max ${secs(Math.max(...cohorts.map((c) => c.maxInstant)))})`
)

// 6. Ceilings hold: nothing above min(25% snapshot, 90s) — the hard 90s cap.
check(
  cohorts.every((c) => c.maxSpend <= 90_000),
  `hard ceiling respected (max single spend ${secs(Math.max(...cohorts.map((c) => c.maxSpend)))})`
)

// 7. Panic band 0.4-1.2s and panic actually happens where it should (1+0).
const panics = cohorts.filter((c) => c.panicRange)
check(
  panics.every((c) => c.panicRange[0] >= 400 && c.panicRange[1] <= 1200),
  'panic-mode moves inside the 0.4-1.2s band'
)
check(
  STYLES.every((s) => by('1+0', s).counts.panic > 0),
  'panic mode engages at 1+0 for every personality'
)

// Sanity: isPanic matches the spec formula the sim relies on.
check(
  isPanic(14_999, 0) && !isPanic(15_000, 0) && isPanic(39_999, 5_000) && !isPanic(40_000, 5_000),
  'isPanic threshold = max(15s, 8*increment)'
)

console.log('')
if (failures > 0) {
  console.error(`sim-bot-time: ${failures} assertion(s) FAILED`)
  process.exit(1)
}
console.log('sim-bot-time: ALL ASSERTIONS PASSED')
