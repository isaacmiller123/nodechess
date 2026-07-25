#!/usr/bin/env node
// Headless test for GameSpec.notate: per-kind notation goldens
// (src/renderer/src/games/* + kernel.ts notateGame).
//
//   node scripts/test-notation.mjs
//
// The kernel contract (kernel.ts GameSpec.notate): notation for the move
// ABOUT to be played from a state; absent notate = the codec string already
// IS the standard notation (checkers PDN, othello 'd3', hex 'c7', morris
// 'd2-d3xg7', ttt 'b2'). Per kind we freeze ≥3-move goldens including
// captures / promotions / drops / passes:
//   - chessops family: real SAN via chessops (castling 'O-O', 'exd5',
//     'a8=Q', crazyhouse pawn drop '@e5', atomic 'Nxf7#');
//   - ffish family + custom variants: real SAN via ffish board.sanMove
//     (xiangqi 'Cxe7+', shogi 'Bxc3=H' promo + 'P@c1' drop, makruk 'cxb3=M',
//     janggi pass codec e9e9 = 'Ke9': a literal same-square king move);
//   - go/gomoku: color-prefixed uppercase vertices 'B D4' / 'W Q16', bare
//     'pass'; go handicap games open with a WHITE-prefixed move;
//   - connect4: landing square 'd4' (codec is the bare column digit);
//   - identity-codec kinds: notate stays ABSENT and notateGame echoes.
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
function eqArr(actual, expected, msg) {
  ok(
    Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => v === expected[i]),
    `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`
  )
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'notation-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  [
    `export { notateGame } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/kernel.ts'))}`,
    `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/chessVariants.ts'))}`,
    `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffishVariants.ts'))}`,
    `export { preloadFfish } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffish.ts'))}`,
    `export { registerCustomVariant } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/customVariants.ts'))}`,
    `export { GO_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/go.ts'))}`,
    `export { GOMOKU_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/gomoku.ts'))}`,
    `export { AMERICAN_CHECKERS_SPEC, INTL_CHECKERS_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/checkers.ts'))}`,
    `export { OTHELLO_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/othello.ts'))}`,
    `export { CONNECT4_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/connect4.ts'))}`,
    `export { HEX_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/hex.ts'))}`,
    `export { MORRIS_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/morris.ts'))}`,
    `export { TICTACTOE_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/tictactoe.ts'))}`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  // games/ffish.ts resolves the WASM asset via a Vite '?url' import; headless
  // bundles keep it external (never executed in node; we pass wasmBinary).
  external: ['*?url'],
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
copyFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm'), resolve(tmp, 'ffish.wasm'))
const m = await import(pathToFileURL(outfile).href)
const { notateGame } = m

function playAll(sp, state, moves) {
  for (const mv of moves) {
    const next = sp.play(state, mv)
    if (!next) throw new Error(`scripted move rejected: ${mv} after [${state.moves.join(' ')}]`)
    state = next
  }
  return state
}

/** Golden helper: notateGame over a scripted line from a given start state. */
function golden(sp, start, moves, expected, msg) {
  playAll(sp, start, moves) // proves the whole line is legal
  eqArr(notateGame(sp, start, moves), expected, msg)
}

try {
  // ---- chessops family: real SAN --------------------------------------------
  console.log('chess (chessops SAN)')
  const chess = m.CHESS_VARIANT_SPECS.chess
  golden(
    chess,
    chess.init(),
    ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'g1f3', 'd5e5', 'f1e2', 'e5g5', 'e1h1', 'g5g2'],
    ['e4', 'd5', 'exd5', 'Qxd5', 'Nf3', 'Qe5+', 'Be2', 'Qg5', 'O-O', 'Qxg2+'],
    'chess: SAN incl. captures, check suffix and king-takes-rook O-O'
  )
  golden(chess, chess.init({ fen: '8/P6k/8/8/8/8/7K/8 w - - 0 1' }), ['a7a8q'], ['a8=Q'], 'chess: promotion a8=Q')
  const s0 = chess.init()
  eq(chess.notate(s0, 'zzzz'), 'zzzz', 'chess: garbage move echoes verbatim (never throws)')
  eq(chess.notate(s0, 'e2e5'), 'e2e5', 'chess: illegal move echoes verbatim')

  console.log('chess960')
  const c960 = m.CHESS_VARIANT_SPECS.chess960
  const std960 = playAll(c960, c960.init({ positionNumber: 518 }), ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'])
  eq(c960.notate(std960, 'e1h1'), 'O-O', 'chess960: canonical king-takes-rook castling notates O-O')

  console.log('crazyhouse')
  const zh = m.CHESS_VARIANT_SPECS.crazyhouse
  golden(
    zh,
    zh.init(),
    ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'g1f3', 'd5e4', 'f1e2', 'P@e5'],
    ['e4', 'd5', 'exd5', 'Qxd5', 'Nf3', 'Qe4+', 'Be2', '@e5'],
    'crazyhouse: SAN incl. the pawn drop @e5 (piece drops keep their letter)'
  )

  console.log('atomic')
  const atomic = m.CHESS_VARIANT_SPECS.atomic
  golden(
    atomic,
    atomic.init(),
    ['g1f3', 'h7h6', 'f3e5', 'h6h5', 'e5f7'],
    ['Nf3', 'h6', 'Ne5', 'h5', 'Nxf7#'],
    'atomic: variant-ending explosion gets the mate suffix'
  )

  // ---- ffish family: real SAN via board.sanMove ------------------------------
  await m.preloadFfish({ wasmBinary: readFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm')) })

  console.log('xiangqi')
  const xq = m.FFISH_VARIANT_SPECS.xiangqi
  golden(
    xq,
    xq.init(),
    ['h3e3', 'h8e8', 'e3e7'],
    ['Che3', 'Che8', 'Cxe7+'],
    'xiangqi: cannon SAN incl. file disambiguation and capture-check'
  )
  eq(xq.notate(xq.init(), 'zzzz'), 'zzzz', 'xiangqi: garbage move echoes verbatim')

  console.log('shogi')
  const sh = m.FFISH_VARIANT_SPECS.shogi
  // Prefix of test-ffish-games.mjs's frozen terminal line: reaches a position
  // with a promoting capture (d4c3+ = Bxc3=H) and then a pawn drop in hand.
  const SHOGI_LINE = (
    'd1d2 g9g8 a3a4 h7h6 d2e2 a9a8 g3g4 a7a6 f1f2 b8e8 f2f1 g8h7 f3f4 d9d8 a1a2 h7g6 ' +
    'b1a3 a6a5 e1f2 e8f8 f2g2 f8e8 c1d2 g6h5 b2a1 e9f8 a4a5 a8a7 g2g3 h5i6 i3i4 b7b6 ' +
    'h2f2 g7g6 f2h2 h8d4 g3f3 f9g8 a1b2 f8g9 h2f2 g9f9 g4g5'
  ).split(' ')
  const shPromo = playAll(sh, sh.init(), SHOGI_LINE)
  eq(sh.notate(shPromo, 'd4c3+'), 'Bxc3=H', 'shogi: promoting capture notates Bxc3=H')
  const shDrop = playAll(sh, shPromo, ['d4c3+', 'f1g2', 'i6h5'])
  eq(sh.notate(shDrop, 'P@c1'), 'P@c1', 'shogi: pawn drop notates P@c1')
  golden(sh, sh.init(), ['f3f4', 'f7f6', 'g3g4'], ['Pf4', 'Pf6', 'Pg4'], 'shogi: quiet opening SAN')

  console.log('janggi')
  const jg = m.FFISH_VARIANT_SPECS.janggi
  golden(jg, jg.init(), ['i4i5', 'i7h7', 'i5h5'], ['Pi5', 'Pih7', 'Ph5'], 'janggi: pawn SAN incl. disambiguation')
  const jgPass = playAll(jg, jg.init(), ['h1i3', 'a10a8', 'i4i5'])
  ok(jg.legalMoves(jgPass).includes('e9e9'), 'janggi: pass codec e9e9 is legal')
  eq(jg.notate(jgPass, 'e9e9'), 'Ke9', 'janggi: pass (same-square king move) notates Ke9')

  console.log('makruk')
  const mk = m.FFISH_VARIANT_SPECS.makruk
  const MAKRUK_LINE = (
    'c1d2 h6h5 f3f4 h8h7 d1c1 a8a7 g1f3 a7d7 f1e2 c6c5 e1f2 f6f5 f3h4 f8e7 h1g1 d6d5 ' +
    'f2e1 d7d6 c1c2 c5c4 c2d1 a6a5 d3d4'
  ).split(' ')
  const mkS = playAll(mk, mk.init(), MAKRUK_LINE)
  eq(mk.notate(mkS, 'c4b3m'), 'cxb3=M', 'makruk: capturing promotion c4b3m notates cxb3=M')
  golden(mk, mk.init(), ['h1h2', 'h8h7', 'h2d2'], ['Rh2', 'Rh7', 'Rd2'], 'makruk: rook opening SAN')

  console.log('placement')
  const pl = m.FFISH_VARIANT_SPECS.placement
  golden(
    pl,
    pl.init(),
    ['N@b1', 'N@b8', 'R@e1'],
    ['N@b1', 'N@b8', 'R@e1'],
    'placement: setup drops notate as drops'
  )

  console.log('custom variant (Variant Lab)')
  const customEntry = await m.registerCustomVariant({
    id: 'nota-test',
    name: 'Notation Test',
    description: '',
    iniText: '[notatest:chess]\npromotionPieceTypes = q\n',
    boardFiles: 8,
    boardRanks: 8
  })
  const cv = customEntry.spec
  golden(cv, cv.init(), ['e2e4', 'd7d5', 'e4d5'], ['e4', 'd5', 'exd5'], 'custom: ffish SAN incl. capture')

  // ---- go / gomoku: color-prefixed vertices ----------------------------------
  console.log('go')
  const go = m.GO_SPEC
  golden(
    go,
    go.init({ size: 9 }),
    ['d4', 'g6', 'pass'],
    ['B D4', 'W G6', 'pass'],
    "go: 'B D4' / 'W G6' color prefixes; pass stays bare"
  )
  const goH = go.init({ size: 9, handicap: 2 })
  const goHMove = go.legalMoves(goH).find((v) => v !== 'pass')
  ok(
    go.notate(goH, goHMove).startsWith('W '),
    'go: handicap game opens with a WHITE-prefixed notation (turn-aware)'
  )

  console.log('gomoku')
  const gm = m.GOMOKU_SPEC
  golden(
    gm,
    gm.init(),
    ['h8', 'h9', 'j8'],
    ['B H8', 'W H9', 'B J8'],
    "gomoku: go-style prefixes (column letters skip 'i')"
  )

  // ---- connect4: landing square ----------------------------------------------
  console.log('connect4')
  const c4 = m.CONNECT4_SPEC
  golden(
    c4,
    c4.init(),
    ['4', '4', '5', '4'],
    ['d1', 'd2', 'e1', 'd3'],
    'connect4: bare column codec notates as the landing square'
  )
  eq(c4.notate(c4.init(), '9'), '9', 'connect4: garbage column echoes verbatim')

  // ---- identity-codec kinds: notate absent, codec IS the notation -------------
  console.log('identity codecs (checkers PDN, othello, hex, morris, ttt)')
  const identity = (sp, moves, msg, init) => {
    ok(sp.notate === undefined, `${sp.kind}: notate absent. Codec is the notation`)
    const start = sp.init(init)
    playAll(sp, start, moves)
    eqArr(notateGame(sp, start, moves), moves, msg)
  }
  identity(
    m.AMERICAN_CHECKERS_SPEC,
    ['11-15', '22-18', '15x22', '25x18'],
    'checkers: PDN quiet moves + capture chain echo verbatim'
  )
  identity(
    m.INTL_CHECKERS_SPEC,
    ['32-28', '19-23', '28x19', '14x23'],
    'checkers-intl: FMJD numbering + captures echo verbatim'
  )
  identity(m.OTHELLO_SPEC, ['d3', 'c3', 'c4'], 'othello: placement squares echo verbatim')
  identity(m.HEX_SPEC, ['c2', 'swap', 'f6'], 'hex: cells + pie-rule swap echo verbatim', { swap: true })
  identity(m.TICTACTOE_SPEC, ['b2', 'a1', 'c3'], 'tictactoe: cells echo verbatim')
  {
    const morris = m.MORRIS_SPEC
    ok(morris.notate === undefined, 'morris: notate absent. Codec is the notation')
    const start = morris.init()
    const line = ['a1', 'b2', 'd1', 'd2']
    const s = playAll(morris, start, line)
    ok(morris.legalMoves(s).includes('g1xd2'), 'morris: mill-completing placement requires capture suffix')
    const full = [...line, 'g1xd2']
    playAll(morris, start, full)
    eqArr(notateGame(morris, start, full), full, 'morris: placements + mill capture echo verbatim')
  }

  // ---- notateGame defensiveness ----------------------------------------------
  console.log('notateGame (kernel replay helper)')
  eqArr(
    notateGame(chess, chess.init(), ['e2e4', 'zzzz', 'e7e5']),
    ['e4', 'zzzz', 'e7e5'],
    'notateGame: replay stops at the first illegal move and echoes the rest'
  )
  eqArr(notateGame(chess, chess.init(), []), [], 'notateGame: empty game notates to empty')

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
