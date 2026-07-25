// Headless test for the games-platform bot providers (games/bots.ts +
// games/gomokuBot.ts + games/small/bots.ts wrappers + checkers providers).
//
//   node scripts/test-bots.mjs
//
// esbuild-bundles the games tree (same pattern as scripts/test-games-kernel.mjs;
// board renderers are only dynamically imported and never invoked; the engine
// providers only touch window.api inside move(), which this suite never calls
// for chess-family kinds). Covers:
//   1. resolveBotProvider: every registered kind resolves; levels === 5;
//      describe() returns non-empty strings for levels 1..5;
//   2. every IN-PROCESS provider (othello, connect4, hex, morris, tictactoe,
//      gomoku, checkers, checkers-intl) returns a spec-legal move at every
//      level on 3 random midgame states (validated via spec.legalMoves);
//   3. gomoku opens in the center; go provider is the KataGo stub (clear error);
//   4. level5 > level1 quick sanity matches for othello + connect4;
//   5. intl draughts level-5 move stays interactive (< 8s).
//
// The Fairy-Stockfish side of §Bots is proven by scripts/probe-fairy-sf.mjs
// (engine handshake, all 13 variants, castling codec, xiangqi gate).
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- tiny assert kit --------------------------------------------------------
let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}

// Deterministic RNG so "random midgame states" are reproducible run-to-run.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'games-bots-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
const GAMES = resolve(ROOT, 'src/renderer/src/games')
writeFileSync(
  entry,
  [
    `export { resolveBotProvider, BotUnavailableError, BOT_LEVEL_NAMES } from ${JSON.stringify(resolve(GAMES, 'bots.ts'))}`,
    `export { GOMOKU_BOT } from ${JSON.stringify(resolve(GAMES, 'gomokuBot.ts'))}`,
    `export { getGame } from ${JSON.stringify(resolve(GAMES, 'registry.ts'))}`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['*?url'],
  loader: { '.css': 'empty' },
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
const { resolveBotProvider, BotUnavailableError, BOT_LEVEL_NAMES, getGame } = mod

const specOf = (kind) => getGame(kind).spec

/** Play `plies` random legal moves from init (backing off if the game ends). */
function randomMidgame(spec, plies, rand, options) {
  let state = spec.init(options)
  for (let i = 0; i < plies; i++) {
    const moves = spec.legalMoves(state)
    if (moves.length === 0 || spec.result(state) !== null) break
    const next = spec.play(state, moves[Math.floor(rand() * moves.length)])
    if (!next) throw new Error('random midgame: spec rejected its own legal move')
    // Never hand a terminal state to a bot: stop one ply early if this ended it.
    if (spec.result(next) !== null || spec.legalMoves(next).length === 0) break
    state = next
  }
  return state
}

/** Bot-vs-bot match through the provider interface; returns score for `hi`. */
async function playMatch(kind, hi, lo, hiPlaysFirst, maxPlies = 300) {
  const spec = specOf(kind)
  const provider = resolveBotProvider(kind)
  let state = spec.init()
  for (let ply = 0; ply < maxPlies; ply++) {
    const res = spec.result(state)
    if (res !== null) {
      // players[0] moves first: map score onto the first mover's perspective.
      const firstMoverWins =
        (res.winner === spec.players[0] && true) || (res.winner === null ? null : false)
      if (firstMoverWins === null) return 0.5
      const hiIsFirst = hiPlaysFirst
      return firstMoverWins === hiIsFirst ? 1 : 0
    }
    const moverIsFirst = ply % 2 === 0
    const level = moverIsFirst === hiPlaysFirst ? hi : lo
    const mv = await provider.move(state, level)
    const next = spec.play(state, mv)
    if (!next) throw new Error(`${kind}: provider level ${level} returned illegal '${mv}'`)
    state = next
  }
  return 0.5 // adjudicate marathon as a draw
}

try {
  // ---- 1. resolution + describe strings -------------------------------------
  console.log('resolution + describe')
  ok(BOT_LEVEL_NAMES.length === 5, 'BOT_LEVEL_NAMES has 5 entries')
  const ALL_KINDS = [
    'chess', 'chess960', 'crazyhouse', 'atomic', 'antichess', 'kingofthehill',
    'threecheck', 'horde', 'racingkings', 'xiangqi', 'shogi', 'janggi', 'makruk',
    'placement', 'go', 'gomoku', 'othello', 'connect4', 'hex', 'morris',
    'tictactoe', 'checkers', 'checkers-intl'
  ]
  for (const kind of ALL_KINDS) {
    const p = resolveBotProvider(kind)
    const described = [1, 2, 3, 4, 5].every(
      (l) => typeof p.describe(l) === 'string' && p.describe(l).length > 0
    )
    ok(p.levels === 5 && described, `${kind}: provider resolves, 5 levels, describe 1..5`)
  }
  ok(resolveBotProvider('othello') === resolveBotProvider('othello'), 'providers are cached per kind')

  // ---- 2. legality on random midgame states, every level --------------------
  console.log('in-process providers: legality at every level x 3 midgame states')
  // kind -> plies of random prefix (enough to be genuinely "midgame" per game)
  const IN_PROCESS = {
    othello: 12,
    connect4: 8,
    hex: 10,
    morris: 10,
    tictactoe: 3,
    gomoku: 8,
    checkers: 10,
    'checkers-intl': 10
  }
  const rand = mulberry32(20260706)
  for (const [kind, plies] of Object.entries(IN_PROCESS)) {
    const spec = specOf(kind)
    const provider = resolveBotProvider(kind)
    for (let g = 0; g < 3; g++) {
      const state = randomMidgame(spec, plies, rand)
      const legal = new Set(spec.legalMoves(state))
      ok(legal.size > 0, `${kind} state ${g + 1}: midgame has legal moves`)
      for (let level = 1; level <= 5; level++) {
        const mv = await provider.move(state, level)
        ok(legal.has(mv), `${kind} state ${g + 1} L${level}: '${mv}' is legal`)
      }
    }
  }

  // ---- 3. gomoku center opening + katago stub --------------------------------
  console.log('gomoku opening + katago stub')
  {
    const spec = specOf('gomoku')
    const provider = resolveBotProvider('gomoku')
    for (const level of [1, 3, 5]) {
      const mv = await provider.move(spec.init(), level)
      ok(mv === 'h8', `gomoku L${level}: opens in the center (h8), got '${mv}'`)
    }
    const go = resolveBotProvider('go')
    let threw = null
    try {
      await go.move(specOf('go').init(), 3)
    } catch (e) {
      threw = e
    }
    ok(
      threw instanceof BotUnavailableError && /KataGo/.test(threw.message),
      `go: stub rejects with BotUnavailableError mentioning KataGo ('${threw?.message}')`
    )
  }

  // ---- 4. level 5 > level 1 quick sanity (othello + connect4) ---------------
  // Level-1 bots pick via noisyArgmax(Math.random), so unseeded matches flake
  // (~few % of runs L5 drops half a point). Seed Math.random for this section
  // only, keeping it the deterministic regression check the header promises.
  console.log('level 5 beats level 1 (2 games each, alternating first move)')
  {
    const origRandom = Math.random
    Math.random = mulberry32(0xc4c4)
    try {
      for (const kind of ['othello', 'connect4']) {
        let score = 0
        score += await playMatch(kind, 5, 1, true)
        score += await playMatch(kind, 5, 1, false)
        ok(score >= 1.5, `${kind}: level 5 scores ${score}/2 vs level 1`)
      }
    } finally {
      Math.random = origRandom
    }
  }

  // ---- 5. intl draughts top level stays interactive ---------------------------
  console.log('intl draughts responsiveness')
  {
    const spec = specOf('checkers-intl')
    const provider = resolveBotProvider('checkers-intl')
    const state = randomMidgame(spec, 12, rand)
    const t0 = Date.now()
    const mv = await provider.move(state, 5)
    const ms = Date.now() - t0
    ok(
      spec.legalMoves(state).includes(mv) && ms < 8000,
      `checkers-intl L5: legal move in ${ms}ms (< 8000ms)`
    )
  }

  console.log(`\nALL GREEN: ${passed} assertions`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
} catch (err) {
  console.error(`\n${err?.stack ?? err}`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}
