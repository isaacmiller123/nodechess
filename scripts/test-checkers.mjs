// Headless test for the checkers wave (src/renderer/src/games/checkers.ts):
// 'checkers' (American, 8x8, rapid-draughts) + 'checkers-intl' (International,
// 10x10, @jortvl/draughts).
//
//   node scripts/test-checkers.mjs
//
// esbuild-bundles the adapter for bare node (like scripts/test-games-kernel.mjs).
// Covers: forced-capture enforcement (both variants), multi-jump chains,
// kinging/crowning, flying-king moves, the MAJORITY-CAPTURE AUDIT of
// @jortvl/draughts (hand-constructed positions: the library must only allow
// sequences capturing the most pieces, quantity rule), Turkish-strike king
// cycles, promotion only at sequence end, draw conventions (WCDF 40-ply,
// FMJD 25-move + threefold) and a scripted full quick game per variant.
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
function eqSet(actual, expected, msg) {
  const a = [...actual].sort().join('|')
  const b = [...expected].sort().join('|')
  ok(a === b, `${msg} (got ${a}, want ${b})`)
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'checkers-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/checkers.ts'))}\n`
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
const { AMERICAN_CHECKERS_SPEC: am, INTL_CHECKERS_SPEC: intl } = await import(
  pathToFileURL(outfile).href
)

function playAll(sp, state, moves) {
  for (const m of moves) {
    const next = sp.play(state, m)
    if (!next) throw new Error(`scripted move rejected: ${m} after [${state.moves.join(' ')}]`)
    state = next
  }
  return state
}

/** Deterministic quick game: always the lexicographically-first legal move. */
function scriptedGame(sp, state, maxPlies) {
  let plies = 0
  while (sp.result(state) === null) {
    if (plies++ > maxPlies) return null
    const moves = sp.legalMoves(state).sort()
    state = sp.play(state, moves[0])
    if (!state) return null
  }
  return state
}

try {
  // =========================================================================
  console.log('spec shapes')
  ok(am.kind === 'checkers' && am.family === 'draughts', 'american: kind checkers, family draughts')
  ok(
    am.board.layout === 'cells' && am.board.files === 8 && am.board.ranks === 8,
    'american: 8x8 cells'
  )
  eq(am.players.join(','), 'black,white', 'american: Black (dark) moves first')
  ok(intl.kind === 'checkers-intl' && intl.family === 'draughts', 'intl: kind checkers-intl, family draughts')
  ok(
    intl.board.layout === 'cells' && intl.board.files === 10 && intl.board.ranks === 10,
    'intl: 10x10 cells'
  )
  eq(intl.players.join(','), 'white,black', 'intl: White moves first (FMJD)')
  ok(am.flipPolicy === 'rotate' && intl.flipPolicy === 'rotate', 'both: OTB flip policy rotate')

  // =========================================================================
  console.log('american: basics')
  let a = am.init()
  const aStart = am.legalMoves(a)
  eq(aStart.length, 7, 'american: 7 legal moves at start')
  ok(aStart.includes('11-15') && aStart.includes('9-13'), 'american: start moves in PDN numbering (11-15, 9-13)')
  ok(aStart.every((m) => m.includes('-')), 'american: all start moves are quiet')
  eq(am.result(a), null, 'american: ongoing at start')
  eq(am.play(a, '11-16zzz'), null, 'american: garbage move → null')
  eq(am.play(a, '9-18'), null, 'american: illegal long slide → null')
  const aBase = a
  a = playAll(am, a, ['11-15'])
  eq(aBase.moves.length, 0, 'american: play() never mutates the input state')
  eq(a.moves.join(' '), '11-15', 'american: codec history recorded')

  console.log('american: forced capture')
  a = playAll(am, am.init(), ['11-15', '22-18'])
  eqSet(am.legalMoves(a), ['15x22'], 'american: capture available → ONLY the capture is legal')
  eq(am.play(a, '9-13'), null, 'american: quiet move while capture exists → null')
  const meta = am.moveMeta(a, '15x22')
  ok(meta.capture === true && meta.sound === 'capture', 'american: jump meta = capture + capture sound')
  a = playAll(am, a, ['15x22'])
  eqSet(am.legalMoves(a), ['25x18', '26x17'], 'american: forced recapture with a choice of two jumps')

  console.log('american: multi-jump chain')
  a = am.init({ blackMen: [11], whiteMen: [15, 22], player: 'black' })
  eqSet(am.legalMoves(a), ['11x18x25'], 'american: double jump enumerated as the full chain 11x18x25 (no partial stop)')
  eq(am.moveMeta(a, '11x18x25').capture, true, 'american: chain meta capture')
  eq(am.play(a, '11x18'), null, 'american: stopping a jump chain early → null')
  a = playAll(am, a, ['11x18x25'])
  eq(a.data.board.light, 0, 'american: both white men removed by the chain')
  const wiped = am.result(a)
  ok(
    wiped && wiped.winner === 'black' && wiped.score === '0-1' && wiped.reason === 'no-moves',
    'american: white wiped out → black wins (no-moves)'
  )
  eq(am.legalMoves(a).length, 0, 'american: no legal moves after the game ends')

  console.log('american: crowning')
  a = am.init({ blackMen: [26], whiteMen: [1], player: 'black' })
  eq(am.moveMeta(a, '26-30').sound, 'promote', 'american: quiet crowning meta sound = promote')
  a = playAll(am, a, ['26-30'])
  ok(a.data.board.king !== 0, 'american: man crowned on the back rank (king bit set)')
  const kingState = am.init({ blackKings: [18], whiteMen: [1], player: 'black' })
  eq(am.legalMoves(kingState).length, 4, 'american: crowned king moves in all four directions')
  const manState = am.init({ blackMen: [18], whiteMen: [1], player: 'black' })
  eq(am.legalMoves(manState).length, 2, 'american: a man only moves forward (two diagonals)')

  console.log('american: endings')
  const drawn = am.init({
    blackKings: [1],
    whiteKings: [32],
    player: 'black',
    stats: { sinceCapture: 40, sinceNonKingAdvance: 40 }
  })
  const drawRes = am.result(drawn)
  ok(
    drawRes && drawRes.winner === null && drawRes.score === '1/2-1/2' && drawRes.reason === '40-move',
    'american: WCDF 40-ply rule → draw'
  )
  const blocked = am.init({ blackMen: [12], whiteMen: [16, 19], player: 'black' })
  const blockedRes = am.result(blocked)
  ok(
    blockedRes && blockedRes.winner === 'white' && blockedRes.score === '1-0' && blockedRes.reason === 'no-moves',
    'american: blocked side to move loses (no-moves)'
  )

  console.log('american: scripted quick game')
  const aFinal = scriptedGame(am, am.init(), 400)
  ok(aFinal !== null, 'american: scripted first-move game terminates within 400 plies')
  ok(am.result(aFinal) !== null && am.legalMoves(aFinal).length === 0, 'american: terminal state is consistent')
  console.log(`    (ended ${am.result(aFinal).score} '${am.result(aFinal).reason}' after ${aFinal.moves.length} plies)`)

  // =========================================================================
  console.log('intl: basics')
  let i = intl.init()
  const iStart = intl.legalMoves(i)
  eq(iStart.length, 9, 'intl: 9 legal moves at start')
  ok(iStart.includes('32-28') && iStart.includes('31-26'), 'intl: start moves in FMJD numbering')
  eq(intl.result(i), null, 'intl: ongoing at start')
  eq(intl.play(i, '32-27zz'), null, 'intl: garbage move → null')
  eq(intl.play(i, '32-22'), null, 'intl: man cannot slide two squares → null')
  const iBase = i
  i = playAll(intl, i, ['32-28'])
  eq(iBase.moves.length, 0, 'intl: play() never mutates the input state')
  ok(intl.legalMoves(i).includes('19-23'), 'intl: black to move after white opens')

  console.log('intl: forced capture')
  i = intl.init({ fen: 'W:W28:B23' })
  eqSet(intl.legalMoves(i), ['28x19'], 'intl: capture available → ONLY the capture is legal')
  eq(intl.play(i, '28-22'), null, 'intl: quiet move while capture exists → null')
  const iMeta = intl.moveMeta(i, '28x19')
  ok(iMeta.capture === true && iMeta.sound === 'capture', 'intl: capture meta = capture + capture sound')

  console.log('intl: MAJORITY-CAPTURE AUDIT (@jortvl/draughts)')
  // White man on 28; capturing 22 takes ONE piece, capturing 23 then 14 takes
  // TWO. FMJD majority rule: only the two-piece sequence is legal.
  i = intl.init({ fen: 'W:W28:B14,22,23' })
  eqSet(intl.legalMoves(i), ['28x19x10'], 'AUDIT: majority capture. Only the 2-piece chain is legal')
  eq(intl.play(i, '28x17'), null, 'AUDIT: the 1-piece capture is rejected')
  i = playAll(intl, i, ['28x19x10'])
  eq(i.fen, 'B:W10:B22', 'AUDIT: exactly the majority pieces (23, 14) are removed')
  // Quantity rule: a king counts the same as a man, 2 men beat 1 king.
  i = intl.init({ fen: 'W:W28:B14,K22,23' })
  eqSet(intl.legalMoves(i), ['28x19x10'], 'AUDIT: quantity rule, 2 men outweigh 1 king')
  // King majority: 3-capture sequences only, never the shorter ones.
  i = intl.init({ fen: 'W:WK35:B8,9,19,30' })
  eqSet(
    intl.legalMoves(i),
    ['35x24x13x4', '35x24x13x2'],
    'AUDIT: flying-king majority. Only the two 3-piece chains are legal'
  )
  i = playAll(intl, i, ['35x24x13x4'])
  eq(i.fen, 'B:WK4:B8', 'AUDIT: king chain removes 30, 19, 9 and keeps the king')

  console.log('intl: flying kings')
  i = intl.init({ fen: 'W:WK46:B28' })
  eqSet(
    intl.legalMoves(i),
    ['46x23', '46x19', '46x14', '46x10', '46x5'],
    'intl: flying king may land on ANY square beyond the captured piece'
  )
  i = playAll(intl, i, ['46x5'])
  eq(i.fen, 'B:WK5:B', 'intl: distant landing applied, capture removed')
  i = intl.init({ fen: 'W:WK46:B5' })
  eq(intl.legalMoves(i).length, 8, 'intl: flying king quiet range covers the whole diagonal')
  ok(intl.legalMoves(i).includes('46-10'), 'intl: long quiet king slide 46-10 enumerated')

  console.log('intl: man rules')
  i = intl.init({ fen: 'W:W23:B29' })
  eqSet(intl.legalMoves(i), ['23x34'], 'intl: men capture BACKWARDS (FMJD)')
  i = intl.init({ fen: 'W:W7:B45' })
  eq(intl.moveMeta(i, '7-1').sound, 'promote', 'intl: promotion move meta sound = promote')
  i = playAll(intl, i, ['7-1'])
  ok(i.fen.startsWith('B:WK1:'), 'intl: man promotes to king on the back row')
  // Promotion ONLY at the end of a capture sequence: 12x3 lands on the back
  // row mid-chain, continues 3x14. The piece must remain a MAN.
  i = intl.init({ fen: 'W:W12:B8,9' })
  eqSet(intl.legalMoves(i), ['12x3x14'], 'intl: pass-through chain enumerated (majority forces both captures)')
  i = playAll(intl, i, ['12x3x14'])
  eq(i.fen, 'B:W14:B', 'intl: NO promotion when a chain only passes through the back row')

  console.log('intl: Turkish-strike king cycle')
  i = intl.init({ fen: 'W:WK43:B12,14,32,34' })
  const cycle = intl.legalMoves(i)
  eq(cycle.length, 6, 'intl: 4-piece diamond gives 6 full cycles')
  ok(cycle.includes('43x25x3x21x43'), 'intl: cycle ending on its own start square enumerated')
  ok(cycle.every((c) => c.split('x').length === 5), 'intl: every cycle captures all four pieces (majority)')
  i = playAll(intl, i, ['43x25x3x21x43'])
  eq(i.fen, 'B:WK43:B', 'intl: cycle removes all four pieces, king back on 43')
  const cycleRes = intl.result(i)
  ok(
    cycleRes && cycleRes.winner === 'white' && cycleRes.score === '1-0' && cycleRes.reason === 'no-moves',
    'intl: black wiped out → white wins (no-moves)'
  )

  console.log('intl: endings & draw conventions')
  const stuck = intl.init({ fen: 'B:W10,14,19:B5' })
  const stuckRes = intl.result(stuck)
  ok(
    stuckRes && stuckRes.winner === 'white' && stuckRes.reason === 'no-moves',
    'intl: blocked side to move loses (no-moves)'
  )
  // 25-move rule (50 king-only capture-free plies).
  i = intl.init({ fen: 'W:WK46:BK5', quietKingPlies: 49 })
  eq(intl.result(i), null, 'intl: 49 quiet king plies → still ongoing')
  i = playAll(intl, i, ['46-41'])
  eq(i.quietKingPlies, 50, 'intl: king move increments the quiet counter')
  const rule25 = intl.result(i)
  ok(
    rule25 && rule25.winner === null && rule25.reason === '25-move',
    'intl: FMJD 25-move rule → draw'
  )
  eq(intl.legalMoves(i).length, 0, 'intl: drawn game exposes no legal moves')
  // man move resets the counter
  i = intl.init({ fen: 'W:WK46,38:BK5', quietKingPlies: 30 })
  i = playAll(intl, i, ['38-32'])
  eq(i.quietKingPlies, 0, 'intl: man move resets the quiet-king counter')
  // threefold repetition (same position, same side to move, third time)
  i = intl.init({ fen: 'W:WK1:BK25' })
  i = playAll(intl, i, ['1-6', '25-30', '6-1', '30-25', '1-6', '25-30', '6-1', '30-25'])
  const rep = intl.result(i)
  ok(rep && rep.winner === null && rep.reason === 'threefold', 'intl: threefold repetition → draw')

  console.log('intl: scripted quick game')
  const iFinal = scriptedGame(intl, intl.init(), 2000)
  ok(iFinal !== null, 'intl: scripted first-move game terminates within 2000 plies')
  ok(intl.result(iFinal) !== null && intl.legalMoves(iFinal).length === 0, 'intl: terminal state is consistent')
  console.log(`    (ended ${intl.result(iFinal).score} '${intl.result(iFinal).reason}' after ${iFinal.moves.length} plies)`)

  // =========================================================================
  console.log('kernel plumbing')
  eq(am.serializeOptions({ blackMen: [11] }), '{"blackMen":[11]}', 'american: serializeOptions stable JSON')
  eq(intl.serializeOptions(null), 'null', 'intl: serializeOptions stable JSON')

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
