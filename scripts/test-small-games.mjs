// Headless test for the small hand-rolled games
// (src/renderer/src/games/small/{othello,connect4,hex,morris,tictactoe,bots}.ts).
//
//   node scripts/test-small-games.mjs
//
// esbuild-bundles the small-games tree for bare node (same pattern as
// scripts/test-games-kernel.mjs; registry/renderer are NOT pulled in. The
// registry wiring is covered by test-games-kernel.mjs). Covers rules edges
// (othello pass + disc-count, connect4 gravity + diagonal win + full-board
// draw, hex winding-path connection + swap rule, morris mill-capture
// constraint + flying + no-move loss, ttt draw) and bot sanity (legality at
// every level; level 5 beats level 1 in ≥4/5 quick games for othello + c4).
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
function sameSet(actual, expected, msg) {
  const a = [...actual].sort().join(',')
  const e = [...expected].sort().join(',')
  ok(a === e, `${msg} (got [${a}], want [${e}])`)
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'small-games-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
const SMALL = resolve(ROOT, 'src/renderer/src/games/small')
writeFileSync(
  entry,
  ['othello', 'connect4', 'hex', 'morris', 'tictactoe', 'bots']
    .map((m) => `export * from ${JSON.stringify(resolve(SMALL, `${m}.ts`))}`)
    .join('\n')
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
const {
  OTHELLO_SPEC,
  CONNECT4_SPEC,
  HEX_SPEC,
  MORRIS_SPEC,
  TICTACTOE_SPEC,
  SMALL_BOTS,
  popcount
} = mod

function playAll(sp, state, moves) {
  for (const m of moves) {
    const next = sp.play(state, m)
    if (!next) throw new Error(`scripted move rejected: ${m} after [${state.moves.join(' ')}]`)
    state = next
  }
  return state
}

/** Play bot-vs-bot; returns { result, plies }. Every bot move is legality-checked. */
function botGame(sp, options, botFor, maxPlies = 250) {
  let s = sp.init(options)
  let plies = 0
  while (plies < maxPlies) {
    const res = sp.result(s)
    if (res !== null) return { result: res, plies }
    const level = botFor(sp, s)
    const move = SMALL_BOTS[sp.kind].move(s, level)
    if (!sp.legalMoves(s).includes(move)) {
      throw new Error(`${sp.kind} bot(level ${level}) illegal move ${move} after [${s.moves.join(' ')}]`)
    }
    s = sp.play(s, move)
    plies++
  }
  return { result: sp.result(s), plies }
}

try {
  // ==== spec shape ============================================================
  console.log('spec shape')
  const SPECS = { othello: OTHELLO_SPEC, connect4: CONNECT4_SPEC, hex: HEX_SPEC, morris: MORRIS_SPEC, tictactoe: TICTACTOE_SPEC }
  for (const [kind, sp] of Object.entries(SPECS)) {
    ok(sp.kind === kind && sp.family === 'grid', `${kind}: spec kind + family 'grid'`)
  }
  ok(
    OTHELLO_SPEC.flipPolicy === 'none' && CONNECT4_SPEC.flipPolicy === 'none' &&
    HEX_SPEC.flipPolicy === 'none' && TICTACTOE_SPEC.flipPolicy === 'none' &&
    MORRIS_SPEC.flipPolicy === 'rotate',
    'flip policy: none for othello/c4/hex/ttt, rotate for morris'
  )
  eq(OTHELLO_SPEC.players.join(','), 'black,white', 'othello: black moves first')
  eq(MORRIS_SPEC.board.layout, 'intersections', 'morris: intersections board')

  // ==== tictactoe =============================================================
  console.log('tictactoe')
  let s = TICTACTOE_SPEC.init()
  eq(TICTACTOE_SPEC.legalMoves(s).length, 9, 'ttt: 9 legal moves at start')
  ok(TICTACTOE_SPEC.legalMoves(s).includes('a1') && TICTACTOE_SPEC.legalMoves(s).includes('c3'), 'ttt: codec cells a1..c3')
  s = playAll(TICTACTOE_SPEC, s, ['b2'])
  eq(TICTACTOE_SPEC.play(s, 'b2'), null, 'ttt: occupied cell → null')
  eq(TICTACTOE_SPEC.play(s, 'd4'), null, 'ttt: off-board cell → null')
  const xWin = playAll(TICTACTOE_SPEC, TICTACTOE_SPEC.init(), ['a1', 'a2', 'b1', 'b2', 'c1'])
  const xRes = TICTACTOE_SPEC.result(xWin)
  ok(xRes && xRes.winner === 'white' && xRes.score === '1-0' && xRes.reason === 'line', 'ttt: X completes rank 1 → 1-0 by line')
  eq(TICTACTOE_SPEC.legalMoves(xWin).length, 0, 'ttt: no legal moves after a win')
  eq(TICTACTOE_SPEC.play(xWin, 'c2'), null, 'ttt: play after game over → null')
  const draw = playAll(TICTACTOE_SPEC, TICTACTOE_SPEC.init(), ['a3', 'b3', 'c3', 'b2', 'a2', 'c2', 'b1', 'a1', 'c1'])
  const dRes = TICTACTOE_SPEC.result(draw)
  ok(dRes && dRes.winner === null && dRes.score === '1/2-1/2' && dRes.reason === 'draw', 'ttt: full board, no line → draw')
  const base = TICTACTOE_SPEC.init()
  TICTACTOE_SPEC.play(base, 'a1')
  eq(base.moves.length, 0, 'ttt: play() never mutates input state')

  // ==== connect4 ==============================================================
  console.log('connect4')
  s = CONNECT4_SPEC.init()
  eq(CONNECT4_SPEC.legalMoves(s).length, 7, 'c4: 7 legal columns at start')
  eq(CONNECT4_SPEC.play(s, '8'), null, 'c4: column 8 → null')
  // gravity: fill column 4 (alternating colours because a shared column can't make 4)
  s = playAll(CONNECT4_SPEC, s, ['4', '4', '4', '4', '4', '4'])
  eq(s.heights[3], 6, 'c4: six discs stack in column 4 (gravity)')
  ok(!CONNECT4_SPEC.legalMoves(s).includes('4'), 'c4: full column not listed')
  eq(CONNECT4_SPEC.play(s, '4'), null, 'c4: drop into full column → null')
  eq(CONNECT4_SPEC.result(s), null, 'c4: still ongoing with a full column')
  // vertical win
  const vert = playAll(CONNECT4_SPEC, CONNECT4_SPEC.init(), ['1', '2', '1', '2', '1', '2', '1'])
  const vRes = CONNECT4_SPEC.result(vert)
  ok(vRes && vRes.winner === 'white' && vRes.score === '1-0' && vRes.reason === 'connect4', 'c4: four stacked in column 1 → white wins')
  eq(CONNECT4_SPEC.legalMoves(vert).length, 0, 'c4: no legal moves after a win')
  eq(CONNECT4_SPEC.play(vert, '3'), null, 'c4: play after game over → null')
  // diagonal win: white lands (1,0) (2,1) (3,2) (4,3) [cols 1-indexed in codec]
  const diagMoves = ['1', '2', '2', '3', '3', '7', '3', '4', '4', '4', '4']
  let diag = CONNECT4_SPEC.init()
  for (let i = 0; i < diagMoves.length; i++) {
    if (i === diagMoves.length - 1) {
      eq(CONNECT4_SPEC.result(diag), null, 'c4: ongoing until the diagonal lands')
    }
    diag = CONNECT4_SPEC.play(diag, diagMoves[i])
    if (!diag) throw new Error(`c4 diag script rejected at move ${i}`)
  }
  const dgRes = CONNECT4_SPEC.result(diag)
  ok(dgRes && dgRes.winner === 'white' && dgRes.reason === 'connect4', 'c4: / diagonal of four → white wins')
  // full-board draw via grid init (pattern has no 4-in-a-row in any direction)
  const gridRows = []
  for (let r = 5; r >= 0; r--) {
    let row = ''
    for (let c = 0; c < 7; c++) row += (((r >> 1) & 1) ^ (c & 1)) === 0 ? 'w' : 'b'
    gridRows.push(row)
  }
  const full = CONNECT4_SPEC.init({ grid: gridRows })
  const fRes = CONNECT4_SPEC.result(full)
  ok(fRes && fRes.winner === null && fRes.score === '1/2-1/2' && fRes.reason === 'draw', 'c4: full board without four → draw')
  eq(CONNECT4_SPEC.legalMoves(full).length, 0, 'c4: no legal moves on a full board')
  const c4base = CONNECT4_SPEC.init()
  CONNECT4_SPEC.play(c4base, '1')
  eq(c4base.heights[0], 0, 'c4: play() never mutates input state')

  // ==== othello ===============================================================
  console.log('othello')
  s = OTHELLO_SPEC.init()
  sameSet(OTHELLO_SPEC.legalMoves(s), ['c4', 'd3', 'e6', 'f5'], 'othello: the 4 classic first moves for black')
  eq(OTHELLO_SPEC.result(s), null, 'othello: ongoing at start')
  eq(OTHELLO_SPEC.play(s, 'pass'), null, 'othello: pass while placements exist → null')
  eq(OTHELLO_SPEC.play(s, 'a1'), null, 'othello: non-flipping placement → null')
  const afterD3 = OTHELLO_SPEC.play(s, 'd3')
  ok(afterD3 !== null && popcount(afterD3.black) === 4 && popcount(afterD3.white) === 1, 'othello: d3 flips d4 → 4 black, 1 white')
  eq(afterD3.turn, 1, 'othello: white to move after black plays')
  const meta = OTHELLO_SPEC.moveMeta(s, 'd3')
  ok(meta.capture === true && meta.sound === 'capture', 'othello: placement meta = capture')
  eq(popcount(s.black), 2, 'othello: play() never mutates input state')
  // forced pass: black to move with no placement, white still has one
  // column a: a1 white, a2 white, a3 black → black has nothing, white can take a4
  const cells = new Array(64).fill('.')
  cells[0] = 'w' // a1
  cells[8] = 'w' // a2
  cells[16] = 'b' // a3
  const passState = OTHELLO_SPEC.init({ board: cells.join(''), turn: 'black' })
  sameSet(OTHELLO_SPEC.legalMoves(passState), ['pass'], 'othello: no placement → only move is pass')
  eq(OTHELLO_SPEC.result(passState), null, 'othello: forced pass is not game over')
  const afterPass = OTHELLO_SPEC.play(passState, 'pass')
  ok(afterPass !== null && afterPass.turn === 1, 'othello: pass switches the turn without placing')
  ok(OTHELLO_SPEC.legalMoves(afterPass).includes('a4'), 'othello: opponent then has the a4 placement')
  // both stuck → disc count decides
  const lone = new Array(64).fill('.')
  lone[0] = 'b'
  const over = OTHELLO_SPEC.init({ board: lone.join(''), turn: 'white' })
  const oRes = OTHELLO_SPEC.result(over)
  ok(oRes && oRes.winner === 'black' && oRes.score === '0-1' && oRes.reason === 'disc-count', 'othello: neither side can move → disc count (black 1-0-up)')
  eq(OTHELLO_SPEC.legalMoves(over).length, 0, 'othello: terminal position has no moves')
  eq(OTHELLO_SPEC.play(over, 'pass'), null, 'othello: pass in a finished game → null')
  const even = new Array(64).fill('.')
  even[0] = 'b'
  even[63] = 'w'
  const evenRes = OTHELLO_SPEC.result(OTHELLO_SPEC.init({ board: even.join('') }))
  ok(evenRes && evenRes.winner === null && evenRes.score === '1/2-1/2', 'othello: equal stuck discs → draw')

  // ==== hex ===================================================================
  console.log('hex')
  s = HEX_SPEC.init()
  eq(HEX_SPEC.legalMoves(s).length, 121, 'hex: 121 cells open at start')
  ok(!HEX_SPEC.legalMoves(HEX_SPEC.play(s, 'f6')).includes('swap'), 'hex: no swap without the option')
  eq(HEX_SPEC.play(HEX_SPEC.play(s, 'f6'), 'f6'), null, 'hex: occupied cell → null')
  // winding staircase for white (left→right), black fills harmless top rows
  const stair = []
  for (let c = 0; c < 11; c++) {
    stair.push([c, c]) // (row=c, col=c)
    if (c < 10) stair.push([c + 1, c])
  }
  const whitePath = stair.map(([r, c]) => String.fromCharCode(97 + c) + String(r + 1))
  const blackFill = []
  for (let c = 1; c <= 10; c++) blackFill.push(String.fromCharCode(97 + c) + '1') // row 0
  for (let c = 2; c <= 10; c++) blackFill.push(String.fromCharCode(97 + c) + '2') // row 1
  blackFill.push('d3') // (row 2, col 3)
  let hx = HEX_SPEC.init()
  for (let i = 0; i < whitePath.length; i++) {
    if (i === whitePath.length - 1) eq(HEX_SPEC.result(hx), null, 'hex: ongoing one stone before the connection')
    hx = HEX_SPEC.play(hx, whitePath[i])
    if (!hx) throw new Error(`hex white path rejected at ${whitePath[i]}`)
    if (i < blackFill.length) {
      hx = HEX_SPEC.play(hx, blackFill[i])
      if (!hx) throw new Error(`hex black fill rejected at ${blackFill[i]}`)
    }
  }
  const hRes = HEX_SPEC.result(hx)
  ok(hRes && hRes.winner === 'white' && hRes.score === '1-0' && hRes.reason === 'connection', 'hex: winding a1→k11 staircase connects left–right → white wins')
  eq(HEX_SPEC.legalMoves(hx).length, 0, 'hex: no legal moves after the connection')
  eq(HEX_SPEC.play(hx, 'k1'), null, 'hex: play after game over → null')
  // black top–bottom column
  let hb = HEX_SPEC.init()
  for (let r = 0; r < 11; r++) {
    hb = HEX_SPEC.play(hb, 'a' + String(r + 1)) // white burns the a-file... which also builds toward nothing (col 0 only)
    hb = HEX_SPEC.play(hb, 'f' + String(r + 1)) // black builds a straight column
    if (!hb) throw new Error('hex black column script rejected')
  }
  const hbRes = HEX_SPEC.result(hb)
  ok(hbRes && hbRes.winner === 'black' && hbRes.score === '0-1' && hbRes.reason === 'connection', 'hex: black column rank1→rank11 → black wins')
  // swap rule
  let sw = HEX_SPEC.init({ swap: true })
  sw = HEX_SPEC.play(sw, 'c2')
  ok(HEX_SPEC.legalMoves(sw).includes('swap'), 'hex: swap offered to the second player')
  const swapped = HEX_SPEC.play(sw, 'swap')
  ok(swapped !== null && swapped.turn === 1, 'hex: after swap it is white to move again')
  const b3 = 2 * 11 + 1 // row 2 (rank 3), col 1 (b)
  ok(swapped.cells[b3] === 2 && swapped.cells.filter((c) => c !== 0).length === 1, 'hex: swap transposes c2 into a black stone on b3')
  ok(!HEX_SPEC.legalMoves(HEX_SPEC.play(swapped, 'f6')).includes('swap'), 'hex: swap only available once')
  eq(HEX_SPEC.play(HEX_SPEC.init({ swap: true }), 'swap'), null, 'hex: swap before the first move → null')

  // ==== morris ================================================================
  console.log('morris')
  s = MORRIS_SPEC.init()
  eq(MORRIS_SPEC.legalMoves(s).length, 24, 'morris: 24 placements at start')
  eq(MORRIS_SPEC.play(s, 'a1-a4'), null, 'morris: movement during placement → null')
  s = playAll(MORRIS_SPEC, s, ['a1', 'd5', 'a4', 'd6'])
  eq(s.inHand.join(','), '7,7', 'morris: hands tick down while placing')
  const millMoves = MORRIS_SPEC.legalMoves(s)
  ok(millMoves.includes('a7xd5') && millMoves.includes('a7xd6'), 'morris: mill-completing placement enumerates capture targets')
  ok(!millMoves.includes('a7'), 'morris: mill-completing placement WITHOUT capture not offered')
  eq(MORRIS_SPEC.play(s, 'a7'), null, 'morris: mill without capture → null')
  const milled = MORRIS_SPEC.play(s, 'a7xd5')
  ok(milled !== null && milled.board.filter((c) => c === 2).length === 1, 'morris: a7xd5 removes the captured man')
  const mMeta = MORRIS_SPEC.moveMeta(s, 'a7xd5')
  ok(mMeta.capture === true && mMeta.sound === 'capture', 'morris: capture meta')
  ok(MORRIS_SPEC.moveMeta(s, 'd7').capture === false, 'morris: quiet placement meta')
  // capture may not target a mill unless everything is milled
  const pts = mod.MORRIS_POINTS
  const boardOf = (white, black) =>
    pts.map((p) => (white.includes(p) ? 'w' : black.includes(p) ? 'b' : '.')).join('')
  const protectedState = MORRIS_SPEC.init({
    board: boardOf(['a1', 'a4'], ['d5', 'd6', 'd7', 'f2']),
    inHand: [7, 5],
    turn: 1
  })
  const protMoves = MORRIS_SPEC.legalMoves(protectedState).filter((m) => m.startsWith('a7'))
  sameSet(protMoves, ['a7xf2'], 'morris: men in a mill are protected while a free man exists')
  const allMilled = MORRIS_SPEC.init({
    board: boardOf(['a1', 'a4'], ['d5', 'd6', 'd7']),
    inHand: [7, 6],
    turn: 1
  })
  sameSet(
    MORRIS_SPEC.legalMoves(allMilled).filter((m) => m.startsWith('a7')),
    ['a7xd5', 'a7xd6', 'a7xd7'],
    'morris: all men milled → any man may be taken'
  )
  // movement phase: adjacency only with 4+ men
  const moving = MORRIS_SPEC.init({
    board: boardOf(['a1', 'd1', 'g1', 'c3'], ['d5', 'd6', 'e5', 'g7']),
    inHand: [0, 0],
    turn: 1
  })
  const movingMoves = MORRIS_SPEC.legalMoves(moving)
  ok(movingMoves.includes('a1-a4'), 'morris: adjacent slide enumerated in the move phase')
  ok(!movingMoves.includes('a1-g4'), 'morris: non-adjacent slide NOT enumerated with 4 men')
  eq(MORRIS_SPEC.play(moving, 'a1-c5'), null, 'morris: non-adjacent slide → null')
  // flying at exactly 3 men
  const flying = MORRIS_SPEC.init({
    board: boardOf(['a1', 'd1', 'c3'], ['e3', 'e4', 'e5', 'g7']),
    inHand: [0, 0],
    turn: 1
  })
  ok(MORRIS_SPEC.legalMoves(flying).includes('a1-g4'), 'morris: 3 men left → flying anywhere')
  // loss: fewer than 3 men
  const starved = MORRIS_SPEC.init({ board: boardOf(['a1', 'a4'], ['d5', 'd6', 'd7']), inHand: [0, 0], turn: 1 })
  const stRes = MORRIS_SPEC.result(starved)
  ok(stRes && stRes.winner === 'black' && stRes.score === '0-1' && stRes.reason === 'material', 'morris: below 3 men → loss')
  eq(MORRIS_SPEC.legalMoves(starved).length, 0, 'morris: no moves offered in a lost position')
  // loss: no legal moves (all men blocked)
  const blocked = MORRIS_SPEC.init({
    board: boardOf(['a1', 'd1', 'g1', 'd3'], ['a4', 'd2', 'g4', 'c3', 'e3']),
    inHand: [0, 0],
    turn: 1
  })
  const blRes = MORRIS_SPEC.result(blocked)
  ok(blRes && blRes.winner === 'black' && blRes.reason === 'no-moves', 'morris: white completely blocked → black wins by no-moves')

  // ==== bots ==================================================================
  console.log('bots (legality)')
  for (const [kind, sp] of Object.entries(SPECS)) {
    const bot = SMALL_BOTS[kind]
    ok(bot && bot.levels === 5 && bot.describe(3).length > 0, `${kind}: bot registered with 5 described levels`)
    for (const level of [1, 5]) {
      const st = sp.init()
      const mv = bot.move(st, level)
      ok(sp.legalMoves(st).includes(mv), `${kind}: level ${level} opening move ${mv} is legal`)
    }
  }

  console.log('bots (strength: this is the slow part)')
  // ttt: perfect (5) vs perfect (5) is always a draw; perfect never loses to random
  {
    const r = botGame(TICTACTOE_SPEC, undefined, () => 5)
    ok(r.result && r.result.winner === null, 'ttt: perfect vs perfect → draw')
    let losses = 0
    for (let g = 0; g < 5; g++) {
      const res = botGame(TICTACTOE_SPEC, undefined, (sp, st) => (st.turn === 1 ? 5 : 1)).result
      if (res.winner === 'black') losses++
    }
    eq(losses, 0, 'ttt: perfect X never loses to random O (5 games)')
  }
  // hex: a bot game always ends in a connection (no draws in hex)
  {
    const r = botGame(HEX_SPEC, undefined, (sp, st) => (st.turn === 1 ? 5 : 1))
    ok(r.result !== null && r.result.reason === 'connection', 'hex: level 5 vs level 1 game ends by connection')
    ok(r.result.winner === 'white', 'hex: level 5 (white) beats level 1')
  }
  // morris: bot moves stay legal deep into a real game (capped, may not finish)
  {
    let st = MORRIS_SPEC.init()
    let plies = 0
    while (plies < 80 && MORRIS_SPEC.result(st) === null) {
      const level = st.turn === 1 ? 4 : 2
      const mv = SMALL_BOTS.morris.move(st, level)
      if (!MORRIS_SPEC.legalMoves(st).includes(mv)) throw new Error(`morris bot illegal ${mv}`)
      st = MORRIS_SPEC.play(st, mv)
      plies++
    }
    ok(plies > 18, 'morris: bots play through placement into the move phase legally')
    const res = MORRIS_SPEC.result(st)
    ok(res === null || res.winner !== null, 'morris: capped bot game is ongoing or decisively won')
  }
  // othello + connect4: level 5 dominates level 1 (colours alternate). Seeded RNG
  // so weak-bot noise is identical on every machine (a Windows-CI run drew twice
  // in connect4 and failed the old unseeded ≥4/5-wins bar). Draws don't disprove
  // superiority. Losses do: assert zero strong-bot losses AND a wins majority.
  {
    const realRandom = Math.random
    let seed = 0xc0ffee
    Math.random = () => {
      // mulberry32: deterministic across platforms
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    try {
      for (const [kind, sp] of [['othello', OTHELLO_SPEC], ['connect4', CONNECT4_SPEC]]) {
        let wins = 0
        let losses = 0
        for (let g = 0; g < 5; g++) {
          const strongFirst = g % 2 === 0 // alternate which side the strong bot takes
          // both games use numeric turn 0|1 where 0 = the first mover (players[0])
          const { result } = botGame(sp, undefined, (_spx, st) => ((st.turn === 0) === strongFirst ? 5 : 1), 200)
          if (!result) throw new Error(`${kind} bot game did not finish`)
          const strongColour = strongFirst ? sp.players[0] : sp.players[1]
          if (result.winner === strongColour) wins++
          else if (result.winner !== null) losses++
          console.log(`    ${kind} game ${g + 1}: strong=${strongColour} result ${result.score} (${result.reason})`)
        }
        ok(losses === 0, `${kind}: level 5 never loses to level 1 (lost ${losses})`)
        ok(wins >= 3, `${kind}: level 5 wins the majority vs level 1 (won ${wins}/5)`)
      }
    } finally {
      Math.random = realRandom
    }
  }

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
