// Headless test for the go + gomoku GameSpecs
// (src/renderer/src/games/{go,gomoku}.ts + registry entries).
//
//   node scripts/test-go.mjs
//
// esbuild-bundles the games tree for bare node (tenuki is CJS and bundles
// cleanly; without a DOM element it uses its NullRenderer). Covers: captures
// (single + group), ko forbidden (and superko-legal recapture later), suicide
// forbidden, pass-pass → scoring phase → finalized area score of constructed
// 9x9 positions with known scores (all-alive AND with a dead-stone mark), and
// gomoku five-detection (rows/columns/both diagonals/overline) + draw on a
// full board.
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
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'games-go-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/go.ts'))}\n` +
    `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/gomoku.ts'))}\n` +
    `export { getGame, isRegisteredGame } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/registry.ts'))}\n`
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  // games/ffish.ts resolves the WASM asset via a Vite '?url' import; headless
  // bundles keep it external (never executed in node; tests pass wasmBinary).
  external: ['*?url'],
  loader: { '.css': 'empty' },
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
const {
  GO_SPEC: go,
  GOMOKU_SPEC: gomoku,
  GOMOKU_CENTER,
  HANDICAP_KOMI,
  handicapPlacement,
  vertexToPoint,
  pointToVertex,
  signMapOf,
  gomokuSignMapOf,
  capturesOf,
  turnOf,
  deadStonesOf,
  getGame,
  isRegisteredGame
} = mod

function playAll(sp, state, moves) {
  for (const m of moves) {
    const next = sp.play(state, m)
    if (!next) throw new Error(`scripted move rejected: ${m} after [${state.moves.join(' ')}]`)
    state = next
  }
  return state
}
// sign at a codec vertex, from the Shudan sign map (1 black, -1 white, 0 empty)
function signAt(s, vertex, map = signMapOf(s)) {
  const p = vertexToPoint(vertex, s.size)
  return map[p.y][p.x]
}

try {
  // ---- registry -------------------------------------------------------------
  console.log('registry')
  ok(isRegisteredGame('go') && isRegisteredGame('gomoku'), 'go + gomoku registered')
  eq(getGame('go')?.spec.kind, 'go', 'registry: go entry wired to GO_SPEC')
  eq(getGame('go')?.botProviderId, 'katago', 'registry: go bot provider = katago')
  eq(getGame('gomoku')?.botProviderId, 'worker:gomoku', 'registry: gomoku bot provider = worker')

  // ---- go: spec shape + init ------------------------------------------------
  console.log('go: spec + init + codec')
  ok(go.kind === 'go' && go.family === 'go', 'go: kind + family')
  ok(go.players[0] === 'black' && go.flipPolicy === 'none', 'go: black moves first, no OTB flip')
  ok(go.board.layout === 'intersections' && go.clock.byoyomi === true, 'go: intersections board, byo-yomi flagged')
  let s = go.init()
  ok(s.size === 19 && s.komi === 6.5 && s.scoring === 'area', 'go: defaults 19x19, komi 6.5, area')
  eq(s.handicap, 0, 'go: default handicap 0 (even game)')
  eq(
    go.serializeOptions({ size: 9 }),
    '{"size":9,"komi":6.5,"scoring":"area","handicap":0}',
    'go: serializeOptions normalizes defaults'
  )
  s = go.init({ size: 9 })
  eq(s.size, 9, 'go: init size 9')
  eq(turnOf(s), 'black', 'go: black to move at start')
  const startMoves = go.legalMoves(s)
  eq(startMoves.length, 82, 'go: 81 points + pass legal on empty 9x9')
  ok(startMoves.includes('pass') && startMoves.includes('a1') && startMoves.includes('j9'), 'go: codec spans a1..j9 + pass')
  ok(!startMoves.includes('i5'), "go: column letter 'i' skipped")
  eq(go.play(s, 'i5'), null, "go: move with letter 'i' → null")
  eq(go.play(s, 'z9'), null, 'go: off-board vertex → null')
  eq(go.result(s), null, 'go: ongoing at start')
  eq(pointToVertex(vertexToPoint('d4', 9).y, vertexToPoint('d4', 9).x, 9), 'd4', 'go: vertex codec round-trips')
  const occupied = go.play(s, 'e5')
  eq(go.play(occupied, 'e5'), null, 'go: occupied point → null')
  eq(turnOf(occupied), 'white', 'go: turn alternates')
  eq(signAt(occupied, 'e5'), 1, 'go: black stone lands on the sign map')

  // ---- go: captures ---------------------------------------------------------
  console.log('go: captures')
  s = playAll(go, go.init({ size: 9 }), ['a2', 'a1']) // black a2, white a1
  const capMeta = go.moveMeta(s, 'b1')
  ok(capMeta.capture === true && capMeta.sound === 'capture', 'go: b1 meta = capture (corner stone in atari)')
  ok(go.moveMeta(s, 'e5').capture === false, 'go: quiet move meta = no capture')
  s = playAll(go, s, ['b1'])
  eq(signAt(s, 'a1'), 0, 'go: single stone captured off the board')
  eq(capturesOf(s, 'black'), 1, 'go: black capture count = 1')
  // group capture: white a1+b1 group dies when black takes its last liberty
  s = playAll(go, go.init({ size: 9 }), ['a2', 'a1', 'b2', 'b1'])
  eq(go.moveMeta(s, 'c1').capture, true, 'go: c1 meta = capture (two-stone group)')
  s = playAll(go, s, ['c1'])
  ok(signAt(s, 'a1') === 0 && signAt(s, 'b1') === 0, 'go: whole group captured')
  eq(capturesOf(s, 'black'), 2, 'go: black capture count = 2 after group capture')

  // ---- go: suicide ----------------------------------------------------------
  console.log('go: suicide')
  s = playAll(go, go.init({ size: 9 }), ['a2', 'e5', 'b1']) // white to move; a1 is now suicide
  eq(go.play(s, 'a1'), null, 'go: suicide a1 → null')
  ok(!go.legalMoves(s).includes('a1'), 'go: suicide point not enumerated')

  // ---- go: ko ----------------------------------------------------------------
  console.log('go: ko')
  s = playAll(go, go.init({ size: 9 }), [
    'd5', 'f4', 'e4', 'f6', 'e6', 'g5', 'a9', 'e5', // shell built; white takes the ko point
    'f5' // black captures e5, ko
  ])
  eq(signAt(s, 'e5'), 0, 'go: ko capture removes the white stone')
  eq(go.play(s, 'e5'), null, 'go: immediate ko recapture → null')
  ok(!go.legalMoves(s).includes('e5'), 'go: ko point not enumerated')
  s = playAll(go, s, ['j9', 'h9']) // white ko threat elsewhere, black answers
  ok(go.play(s, 'e5') !== null, 'go: ko recapture legal after exchange (superko: new position)')

  // ---- go: handicap (hoshi placement goldens + komi + white-first turn) --------
  console.log('go: handicap')
  // Placement goldens. The standard hoshi tables per size (tenuki order:
  // top-right, bottom-left, bottom-right, top-left, then middles).
  eq(JSON.stringify(handicapPlacement(19, 2)), '["q16","d4"]', 'handicap: 19x19 h2 = q16 d4')
  eq(
    JSON.stringify(handicapPlacement(19, 4)),
    '["q16","d4","q4","d16"]',
    'handicap: 19x19 h4 = the four corner hoshi'
  )
  eq(
    JSON.stringify(handicapPlacement(19, 9)),
    '["q16","d4","q4","d16","d10","q10","k16","k4","k10"]',
    'handicap: 19x19 h9 = all nine hoshi'
  )
  eq(
    JSON.stringify(handicapPlacement(13, 5)),
    '["k10","d4","k4","d10","g7"]',
    'handicap: 13x13 h5 = corners + tengen'
  )
  eq(
    JSON.stringify(handicapPlacement(9, 3)),
    '["g7","c3","g3"]',
    'handicap: 9x9 h3 (2-3-3 offset rule: hoshi on the 3rd line)'
  )
  eq(
    JSON.stringify(handicapPlacement(9, 9)),
    '["g7","c3","g3","c7","c5","g5","e7","e3","e5"]',
    'handicap: 9x9 h9 = all nine points'
  )
  for (const size of [9, 13, 19]) {
    for (let h = 2; h <= 9; h++) {
      const placed = handicapPlacement(size, h)
      eq(placed.length, h, `handicap: ${size}x${size} h${h} places ${h} stones`)
      eq(new Set(placed).size, h, `handicap: ${size}x${size} h${h} points are distinct`)
    }
  }
  eq(handicapPlacement(19, 0).length, 0, 'handicap: 0 places nothing')
  // init(): stones pre-placed for black (tenuki agrees with our table), WHITE
  // moves first, komi auto-drops to the conventional 0.5.
  let hs = go.init({ size: 9, handicap: 4 })
  eq(hs.handicap, 4, 'handicap: state carries the option')
  eq(hs.komi, HANDICAP_KOMI, 'handicap: komi auto-adjusts to 0.5')
  eq(go.init({ size: 9, handicap: 4, komi: 5.5 }).komi, 5.5, 'handicap: explicit komi still wins')
  eq(go.init({ size: 9 }).komi, 6.5, 'handicap: even game keeps full komi')
  eq(turnOf(hs), 'white', 'handicap: WHITE moves first with stones down')
  eq(go.turn(hs), 'white', 'handicap: spec.turn seam agrees (kernel consumers use it)')
  const hMap = signMapOf(hs)
  for (const v of handicapPlacement(9, 4)) {
    eq(signAt(hs, v, hMap), 1, `handicap: black stone pre-placed at ${v} (tenuki table match)`)
  }
  eq(go.legalMoves(hs).length, 82 - 4, 'handicap: pre-placed points are not legal moves')
  ok(!go.legalMoves(hs).includes('g7'), 'handicap: hoshi g7 occupied')
  hs = playAll(go, hs, ['e5'])
  eq(turnOf(hs), 'black', 'handicap: black replies after the white opener')
  eq(signAt(hs, 'e5'), -1, 'handicap: the first move is a WHITE stone')
  eq(go.notate(go.init({ size: 9, handicap: 2 }), 'e5'), 'W E5', 'handicap: first move notates as white')
  eq(
    go.serializeOptions({ size: 9, handicap: 2 }),
    '{"size":9,"komi":0.5,"scoring":"area","handicap":2}',
    'handicap: serializeOptions carries handicap + adjusted komi (wire config)'
  )
  let hThrew = false
  try {
    go.init({ size: 9, handicap: 1 })
  } catch {
    hThrew = true
  }
  ok(hThrew, 'handicap: 1 is rejected (that is just komi, not a placement)')

  // ---- go: pass-pass → scoring phase → finalized area score -------------------
  console.log('go: scoring (all stones alive)')
  // walls: black column e vs white column f on 9x9 → area 45 v 36 (+6.5 komi)
  const wallMoves = []
  for (let r = 1; r <= 9; r++) wallMoves.push(`e${r}`, `f${r}`)
  s = playAll(go, go.init({ size: 9 }), wallMoves)
  eq(go.moveMeta(s, 'pass').sound, 'move', 'go: pass meta = quiet move')
  s = playAll(go, s, ['pass', 'pass'])
  ok(go.isScoringPhase(s), 'go: two passes → scoring phase')
  eq(go.result(s), null, 'go: result null while dead-stone marking unresolved')
  eq(go.legalMoves(s).length, 0, 'go: no board moves in scoring phase')
  eq(go.play(s, 'a1'), null, 'go: play after two passes → null')
  const fin = go.finalizeScore(s)
  ok(fin !== null && fin.finalized, 'go: finalizeScore resolves scoring')
  const detail = go.scoreDetail(fin)
  ok(detail.black === 45 && detail.white === 42.5, `go: area score 45 v 36+6.5 komi (got ${detail.black} v ${detail.white})`)
  const res = go.result(fin)
  ok(res && res.winner === 'black' && res.score === '0-1' && res.reason === 'score',
    'go: black wins by 2.5 → 0-1 by score')
  eq(go.finalizeScore(fin), null, 'go: finalizeScore twice → null')
  eq(go.finalizeScore(go.init({ size: 9 })), null, 'go: finalizeScore mid-game → null')

  // ---- go: dead-stone marking seam --------------------------------------------
  console.log('go: scoring (dead-stone marking)')
  // same walls + a lone dead white stone at a1 inside black's area
  s = playAll(go, go.init({ size: 9 }), [
    'e1', 'a1', 'e2', 'f1', 'e3', 'f2', 'e4', 'f3', 'e5', 'f4',
    'e6', 'f5', 'e7', 'f6', 'e8', 'f7', 'e9', 'f8', 'pass', 'f9',
    'pass', 'pass'
  ])
  ok(go.isScoringPhase(s), 'go: scoring phase reached with dead stone on board')
  eq(go.markDead(s, 'c3'), null, 'go: markDead on an empty point → null')
  const allAlive = go.finalizeScore(s)
  const aaDetail = go.scoreDetail(allAlive)
  ok(aaDetail.black === 9 && aaDetail.white === 43.5,
    `go: all-alive → left side is dame, white wins (got ${aaDetail.black} v ${aaDetail.white})`)
  eq(go.result(allAlive)?.winner, 'white', 'go: unmarked dead stone flips the result to white')
  const marked = go.markDead(s, 'a1')
  ok(marked !== null, 'go: markDead(a1) accepted in scoring phase')
  ok(deadStonesOf(marked).includes('a1'), 'go: a1 reported dead')
  const finM = go.finalizeScore(marked)
  const mDetail = go.scoreDetail(finM)
  ok(mDetail.black === 45 && mDetail.white === 42.5,
    `go: a1 dead → black 45 v 42.5 (got ${mDetail.black} v ${mDetail.white})`)
  eq(go.result(finM)?.winner, 'black', 'go: dead mark resolves the game for black')
  eq(go.markDead(go.init({ size: 9 }), 'a1'), null, 'go: markDead mid-game → null')

  // ---- go: immutability --------------------------------------------------------
  const base = go.init({ size: 9 })
  go.play(base, 'd4')
  eq(base.moves.length, 0, 'go: play() never mutates the input state')

  // ---- gomoku: spec + init ------------------------------------------------------
  console.log('gomoku')
  ok(gomoku.kind === 'gomoku' && gomoku.family === 'grid', 'gomoku: kind + family')
  ok(gomoku.board.files === 15 && gomoku.board.layout === 'intersections', 'gomoku: 15x15 intersections')
  eq(gomoku.flipPolicy, 'none', 'gomoku: no OTB flip')
  let g = gomoku.init()
  eq(gomoku.legalMoves(g).length, 225, 'gomoku: 225 legal moves on empty board')
  ok(gomoku.legalMoves(g).includes(GOMOKU_CENTER) && GOMOKU_CENTER === 'h8', 'gomoku: center opening = h8')
  ok(gomoku.legalMoves(g).includes('p15') && !gomoku.legalMoves(g).includes('i8'), "gomoku: codec spans a1..p15, skips 'i'")
  eq(gomoku.play(g, 'i8'), null, "gomoku: letter 'i' → null")
  eq(gomoku.result(g), null, 'gomoku: ongoing at start')
  g = gomoku.play(g, 'h8')
  eq(gomoku.play(g, 'h8'), null, 'gomoku: occupied point → null')
  eq(signAt(g, 'h8', gomokuSignMapOf(g)), 1, 'gomoku: black stone on the sign map')
  eq(gomoku.moveMeta(g, 'h9').sound, 'move', 'gomoku: move meta = quiet move')

  // five detection: rows / columns / both diagonals / overline
  g = playAll(gomoku, gomoku.init(), ['d4', 'd5', 'e4', 'e5', 'f4', 'f5', 'g4', 'g5'])
  eq(gomoku.result(g), null, 'gomoku: four in a row = ongoing')
  g = playAll(gomoku, g, ['h4'])
  let r = gomoku.result(g)
  ok(r && r.winner === 'black' && r.score === '0-1' && r.reason === 'five-in-a-row', 'gomoku: horizontal five → black wins')
  eq(gomoku.legalMoves(g).length, 0, 'gomoku: no legal moves after a win')
  eq(gomoku.play(g, 'a1'), null, 'gomoku: play after win → null')
  g = playAll(gomoku, gomoku.init(), ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4', 'a5'])
  eq(gomoku.result(g)?.winner, 'black', 'gomoku: vertical five → black wins')
  g = playAll(gomoku, gomoku.init(), ['a1', 'h1', 'b2', 'h2', 'c3', 'h3', 'd4', 'h4', 'e5'])
  eq(gomoku.result(g)?.winner, 'black', 'gomoku: ↘ diagonal five → black wins')
  g = playAll(gomoku, gomoku.init(), ['e1', 'h1', 'd2', 'h2', 'c3', 'h3', 'b4', 'h4', 'a5'])
  eq(gomoku.result(g)?.winner, 'black', 'gomoku: ↗ diagonal five → black wins')
  g = playAll(gomoku, gomoku.init(), ['a1', 'c1', 'a3', 'c2', 'a5', 'c3', 'a7', 'c4', 'a9', 'c5'])
  r = gomoku.result(g)
  ok(r && r.winner === 'white' && r.score === '1-0', 'gomoku: white five → 1-0')
  // freestyle overline: a1 b1 c1 _ e1 f1, then d1 makes six-in-a-row → win
  g = playAll(gomoku, gomoku.init(), ['a1', 'o15', 'b1', 'm15', 'c1', 'k15', 'e1', 'o13', 'f1', 'm13'])
  eq(gomoku.result(g), null, 'gomoku: gapped stones = ongoing')
  g = playAll(gomoku, g, ['d1'])
  eq(gomoku.result(g)?.winner, 'black', 'gomoku: overline (six) wins in freestyle')

  // draw on a full board (5x5 via the size option; pattern has no 5-line)
  let threw = false
  try { gomoku.init({ size: 4 }) } catch { threw = true }
  ok(threw, 'gomoku: size < 5 rejected')
  const GRID = [
    'WBWBB', // y=0 (top)
    'WWBWW',
    'BBWBB',
    'WWBWW',
    'BBWBB'
  ]
  const blacks = []
  const whites = []
  GRID.forEach((row, y) => {
    ;[...row].forEach((c, x) => {
      const v = pointToVertex(y, x, 5)
      if (c === 'B') blacks.push(v)
      else whites.push(v)
    })
  })
  eq(blacks.length, 13, 'gomoku: draw pattern has 13 black / 12 white')
  const order = []
  for (let i = 0; i < 13; i++) {
    order.push(blacks[i])
    if (i < 12) order.push(whites[i])
  }
  g = playAll(gomoku, gomoku.init({ size: 5 }), order.slice(0, 24))
  eq(gomoku.result(g), null, 'gomoku: ongoing with one point left')
  g = playAll(gomoku, g, [order[24]])
  r = gomoku.result(g)
  ok(r && r.winner === null && r.score === '1/2-1/2' && r.reason === 'board-full', 'gomoku: full board → draw')

  // immutability
  const gBase = gomoku.init()
  gomoku.play(gBase, 'h8')
  eq(gBase.moves.length, 0, 'gomoku: play() never mutates the input state')

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
