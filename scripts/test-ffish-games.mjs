// Headless test for the ffish family wave: GameSpec adapters over ffish-es6
// (src/renderer/src/games/{ffish,ffishVariants}.ts + registry entries).
//
//   node scripts/test-ffish-games.mjs
//
// esbuild-bundles the games tree for bare node (the Vite-only
// 'ffish-es6/ffish.wasm?url' import stays external. Never executed here) and
// copies ffish.wasm next to the bundle; the loader gets the bytes via
// preloadFfish({ wasmBinary }). Per game we assert: preload gating (clear
// throw before ready), legal-move count at the start position, a scripted
// opening, illegal/garbage moves → null, capture/promotion/pass moveMeta, and
// a full quick game (legal sequence found via ffish playouts, then hardcoded)
// to a terminal result.
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

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'ffish-games-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffishVariants.ts'))}\n` +
    `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffish.ts'))}\n` +
    `export { getGame, listGames, isRegisteredGame } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/registry.ts'))}\n`
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
// prove the copied-asset pattern: wasm travels next to the bundle
const wasmCopy = resolve(tmp, 'ffish.wasm')
copyFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm'), wasmCopy)

const mod = await import(pathToFileURL(outfile).href)
const { FFISH_VARIANT_SPECS, preloadFfish, isFfishReady, getGame, isRegisteredGame } = mod

const KINDS = ['xiangqi', 'shogi', 'janggi', 'makruk', 'placement']
const spec = (kind) => FFISH_VARIANT_SPECS[kind]
function playAll(sp, state, moves) {
  for (const m of moves) {
    const next = sp.play(state, m)
    if (!next) throw new Error(`scripted move rejected: ${m} after [${state.moves.join(' ')}]`)
    state = next
  }
  return state
}

// Full quick games to a terminal result: legal sequences found with ffish
// (seeded mate-in-1-preferring playouts), then frozen here for determinism.
const TERMINAL_LINES = {
  xiangqi:
    'h3f3 h8h7 f3f7 b8g8 h1g3 g8e8 i1i2 e8d8 f7f5 d8d7 f5f2 h10i8 f2f7 a7a6 f7f8 d10e9 ' +
    'i2g2 d7d4 b3b6 d4d8 f8f5 e9f8 b6e6 d8e8 f5g5 g7g6 b1c3 g6g5 d1e2 c10a8 e2f3 i10i9 ' +
    'c3d1 a8c6 g2i2 i9g9 g4g5 a10a9 e6i6 h7g7 g3h5 a9e9 h5i7 b10a8 f3e2 g7g1',
  shogi:
    'd1d2 g9g8 a3a4 h7h6 d2e2 a9a8 g3g4 a7a6 f1f2 b8e8 f2f1 g8h7 f3f4 d9d8 a1a2 h7g6 ' +
    'b1a3 a6a5 e1f2 e8f8 f2g2 f8e8 c1d2 g6h5 b2a1 e9f8 a4a5 a8a7 g2g3 h5i6 i3i4 b7b6 ' +
    'h2f2 g7g6 f2h2 h8d4 g3f3 f9g8 a1b2 f8g9 h2f2 g9f9 g4g5 d4c3+ f1g2 i6h5 P@c1 P@a6 ' +
    'e2e1 d8c8 f3g3 h5g4 g3g4 f9g9 S@d8 c3d2 c1c2 e8e9 e1e2 S@g7 e3e4 h6h5 g2g3 g9f8 ' +
    'd8e7+ f8e7 b2a1 e7d6 f2f3 d2f4 g4h5 P@e3 P@f6 f4g5 h5i5 g7h6',
  janggi: 'h1i3 a10a8 i4i5 e9e9 e2e2',
  makruk:
    'c1d2 h6h5 f3f4 h8h7 d1c1 a8a7 g1f3 a7d7 f1e2 c6c5 e1f2 f6f5 f3h4 f8e7 h1g1 d6d5 ' +
    'f2e1 d7d6 c1c2 c5c4 c2d1 a6a5 d3d4 c4b3m a3a4 e8f7 a1a3 d8c7 d1c1 g8f6 g1g2 b8d7 ' +
    'e3e4 h7g7 e4e5 g6g5 c1b2 e7d8 c3c4 f7f8 e5f6m f8e8 f6g5 d7e5 d2e3 d5c4 e2f3 e8e7 ' +
    'f3e2 d6d7 b2c1 c4c3m e2d1 e5d3',
  placement:
    'N@b1 N@b8 R@e1 Q@c8 K@a1 R@d8 B@d1 K@h8 N@c1 N@e8 Q@f1 R@g8 B@g1 B@f8 R@h1 B@a8 ' +
    'a2a4 e8d6 c2c3 d6c4 h2h3 c4a5 d2d4 b8c6 c1a2 d8e8 c3c4 g7g6 e2e3 c6e5 d4d5 d7d6 ' +
    'd1c2 f7f5 f2f3 c8d8 g1h2 f8g7 e1d1 e5d7 b1a3 d7c5 h2f4 g6g5 c2d3 g7e5 d1e1 h7h5 ' +
    'a3b5 b7b6 d3f5 g5g4 b5c7 c5d7 h3h4 d7b8 f5b1 a5b3'
}

function checkTerminal(kind, expectedReason) {
  const sp = spec(kind)
  const end = playAll(sp, sp.init(), TERMINAL_LINES[kind].split(' '))
  const res = sp.result(end)
  ok(res !== null, `${kind}: quick full game reaches a terminal result`)
  ok(res.winner === 'black' && res.score === '0-1', `${kind}: terminal result is a black win 0-1`)
  eq(res.reason, expectedReason, `${kind}: terminal reason`)
  eq(sp.legalMoves(end).length, 0, `${kind}: no legal moves at the terminal position`)
}

try {
  // ---- preload gating ---------------------------------------------------------
  console.log('preload gating')
  eq(isFfishReady(), false, 'ffish: not ready before preload')
  let gateErr = null
  try {
    spec('xiangqi').init()
  } catch (err) {
    gateErr = err
  }
  ok(gateErr instanceof Error && /preload/i.test(gateErr.message), 'spec use before preload throws a clear preload error')
  const ffishA = await preloadFfish({ wasmBinary: readFileSync(wasmCopy) })
  const ffishB = await preloadFfish()
  ok(isFfishReady() && ffishA === ffishB, 'preloadFfish: singleton. Second call returns the same module')
  await spec('shogi').preload()
  ok(true, 'spec.preload(): resolves once the module is loaded')

  // ---- registry ----------------------------------------------------------------
  console.log('registry')
  for (const kind of KINDS) {
    const entry = getGame(kind)
    ok(
      entry && entry.spec.kind === kind && entry.spec.family === 'chess',
      `${kind}: registered with kind + chess family`
    )
    ok(
      entry.requiresPreload === true && typeof entry.spec.preload === 'function',
      `${kind}: registry marks requiresPreload + spec exposes preload()`
    )
    eq(entry.botProviderId, 'fairy-stockfish', `${kind}: bot provider = fairy-stockfish`)
    eq(entry.manualId, kind, `${kind}: manual id = kind`)
  }
  ok(isRegisteredGame('xiangqi') && isRegisteredGame('placement'), 'isRegisteredGame covers the ffish kinds')
  ok(
    KINDS.every((k) => spec(k).flipPolicy === 'rotate' && spec(k).clock.supported),
    'all ffish games: flipPolicy rotate + clock supported'
  )

  // ---- xiangqi -------------------------------------------------------------------
  console.log('xiangqi')
  const xq = spec('xiangqi')
  let s = xq.init()
  eq(s.fen, 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1', 'xiangqi: start FEN')
  ok(xq.board.layout === 'intersections' && xq.board.files === 9 && xq.board.ranks === 10, 'xiangqi: 9x10 intersections')
  eq(xq.legalMoves(s).length, 44, 'xiangqi: 44 legal moves at start')
  eq(xq.result(s), null, 'xiangqi: ongoing at start')
  eq(xq.play(s, 'a1a4'), null, 'xiangqi: rook onto own pawn a1a4 → null')
  eq(xq.play(s, 'e2e2'), null, 'xiangqi: same-square pass (janggi-only) → null')
  eq(xq.play(s, 'zzzz'), null, 'xiangqi: garbage move → null')
  const xqOpen = playAll(xq, s, ['h3e3', 'h10g8', 'h1g3', 'b10c8', 'i1h1', 'i10h10'])
  eq(xqOpen.fen, 'r1bakabr1/9/1cn3nc1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C1N2/9/RNBAKABR1 w - - 6 4',
    'xiangqi: central cannon vs screens opening reaches the expected FEN')
  const xqMid = playAll(xq, xq.init(), ['h3e3', 'h10g8'])
  const xqMeta = xq.moveMeta(xqMid, 'e3e7')
  ok(xqMeta.capture === true && xqMeta.sound === 'capture', 'xiangqi: cannon takes the central pawn. Capture meta')
  checkTerminal('xiangqi', 'checkmate')

  // ---- shogi ----------------------------------------------------------------------
  console.log('shogi')
  const sh = spec('shogi')
  s = sh.init()
  ok(s.fen.includes('[]'), 'shogi: start FEN carries empty pockets')
  ok(sh.board.layout === 'cells' && sh.board.files === 9 && sh.board.ranks === 9, 'shogi: 9x9 cells')
  eq(sh.legalMoves(s).length, 30, 'shogi: 30 legal moves at start')
  eq(sh.play(s, 'a3a5'), null, 'shogi: two-square pawn push → null')
  eq(sh.play(s, 'P@e5'), null, 'shogi: pawn drop with empty pocket → null')
  s = playAll(sh, s, ['c3c4', 'g7g6', 'h2g2'])
  const shPromoMeta = sh.moveMeta(s, 'h8b2+')
  ok(shPromoMeta.capture === true && shPromoMeta.sound === 'promote',
    'shogi: Bxb2+ (bishop takes, promotes to horse). Capture + promote meta')
  s = playAll(sh, s, ['h8b2+', 'g2b2'])
  ok(sh.legalMoves(s).includes('B@e5'), 'shogi: after the bishop trade, black can drop B@e5')
  const shDropped = sh.play(s, 'B@e5')
  ok(shDropped !== null && shDropped.moves.at(-1) === 'B@e5', 'shogi: drop plays and records verbatim UCI')
  checkTerminal('shogi', 'checkmate')

  // ---- janggi ------------------------------------------------------------------------
  console.log('janggi')
  const jg = spec('janggi')
  s = jg.init()
  ok(jg.board.layout === 'intersections' && jg.board.files === 9 && jg.board.ranks === 10, 'janggi: 9x10 intersections')
  eq(jg.legalMoves(s).length, 32, 'janggi: 32 legal moves at start (incl. the pass)')
  ok(jg.legalMoves(s).includes('e2e2'), 'janggi: same-square king pass move enumerated')
  const jgPassMeta = jg.moveMeta(s, 'e2e2')
  ok(jgPassMeta.capture === false && jgPassMeta.sound === 'move', 'janggi: pass meta = quiet move')
  eq(jg.play(s, 'e3e3'), null, 'janggi: same-square non-king move → null')
  const jgOpen = playAll(jg, s, ['h1g3', 'h10g8', 'h3e3', 'h8e8'])
  eq(jg.result(jgOpen), null, 'janggi: ongoing after the cannon opening')
  checkTerminal('janggi', 'stalemate') // double-pass end: no moves, no check. Black wins on adjudication

  // ---- makruk ------------------------------------------------------------------------
  console.log('makruk')
  const mk = spec('makruk')
  s = mk.init()
  eq(s.fen, 'rnsmksnr/8/pppppppp/8/8/PPPPPPPP/8/RNSKMSNR w - - 0 1', 'makruk: start FEN (pawns on the 3rd rank)')
  ok(mk.board.layout === 'cells' && mk.board.files === 8 && mk.board.ranks === 8, 'makruk: 8x8 cells')
  eq(mk.legalMoves(s).length, 23, 'makruk: 23 legal moves at start')
  eq(mk.play(s, 'e3e5'), null, 'makruk: two-square pawn push → null')
  const mkOpen = playAll(mk, s, ['e3e4', 'e6e5', 'g1e2', 'b8d7', 'e2d4'])
  const mkCapMeta = mk.moveMeta(mkOpen, 'e5d4')
  ok(mkCapMeta.capture === true && mkCapMeta.sound === 'capture', 'makruk: pawn takes knight. Capture meta')
  const mkLine = TERMINAL_LINES.makruk.split(' ')
  const mkPrePromo = playAll(mk, mk.init(), mkLine.slice(0, 23))
  const mkPromoMeta = mk.moveMeta(mkPrePromo, 'c4b3m')
  ok(mkPromoMeta.capture === true && mkPromoMeta.sound === 'promote',
    'makruk: cxb3=M. Capture + promote meta (met promotion, verbatim m suffix)')
  checkTerminal('makruk', 'checkmate')

  // ---- placement -----------------------------------------------------------------------
  console.log('placement')
  const pl = spec('placement')
  s = pl.init()
  ok(s.fen.includes('[KQRRBBNNkqrrbbnn]'), 'placement: start FEN carries the full placement pockets')
  eq(pl.legalMoves(s).length, 40, 'placement: 40 legal moves at start (5 piece types x 8 squares)')
  ok(pl.legalMoves(s).every((m) => m.includes('@')), 'placement: placement phase is drops only')
  eq(pl.play(s, 'e2e4'), null, 'placement: pawn move before placing pieces → null')
  const plLine = [
    'K@e1', 'K@e8', 'N@b1', 'N@g8', 'B@c1', 'B@f8', 'Q@d1', 'Q@d8',
    'R@a1', 'R@a8', 'B@f1', 'B@c8', 'N@g1', 'N@b8', 'R@h1', 'R@h8',
    'e2e4', 'e7e5', 'g1f3', 'b8c6'
  ]
  const plOpen = playAll(pl, s, plLine)
  ok(plOpen.fen.includes('KQkq'), 'placement: castling rights granted once the back ranks are placed')
  const plCapMeta = pl.moveMeta(plOpen, 'f3e5')
  ok(plCapMeta.capture === true && plCapMeta.sound === 'capture', 'placement: Nxe5. Capture meta')
  checkTerminal('placement', 'checkmate')

  // ---- kernel contract ---------------------------------------------------------------------
  console.log('kernel contract')
  const base = xq.init()
  xq.play(base, 'h3e3')
  eq(base.moves.length, 0, 'kernel: play() never mutates the input state')
  const replay = playAll(xq, xq.init(), ['h3e3', 'h10g8'])
  eq(replay.moves.join(' '), 'h3e3 h10g8', 'kernel: state records verbatim ffish UCI history')
  eq(xq.serializeOptions({ fen: 'x' }), '{"fen":"x"}', 'kernel: serializeOptions is stable JSON')
  let fenErr = null
  try {
    xq.init({ fen: 'garbage' })
  } catch (err) {
    fenErr = err
  }
  ok(fenErr instanceof Error && /invalid xiangqi FEN/.test(fenErr.message), 'init: invalid FEN throws a clear error')

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
