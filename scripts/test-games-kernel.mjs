// Headless test for the game kernel + chess-variant wave
// (src/renderer/src/games/{kernel,chessVariants,registry}.ts).
//
//   node scripts/test-games-kernel.mjs
//
// esbuild-bundles the games tree for bare node (type-only renderer imports are
// erased; the placeholder .tsx renderer is only dynamically imported and never
// invoked). Per variant we assert: legal move count at the start position, a
// short scripted game reaching the variant's DISTINCTIVE end (atomic explosion,
// third check, racing-kings goal, antichess last-piece win, KOTH center,
// horde destruction, fool's-mate checkmate), and illegal move → null.
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
const tmp = mkdtempSync(resolve(tmpdir(), 'games-kernel-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/chessVariants.ts'))}\n` +
    `export { getGame, listGames, isRegisteredGame } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/registry.ts'))}\n`
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
  // board renderers reachable from registry.ts pull in CSS (e.g. shudan's
  // goban.css via games/boards/GoBoard.tsx). Drop it for headless node
  loader: { '.css': 'empty' },
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
const { CHESS_VARIANT_SPECS, scharnaglArrangement, chess960Fen, getGame, listGames, isRegisteredGame } = mod

const spec = (kind) => CHESS_VARIANT_SPECS[kind]
function playAll(sp, state, moves) {
  for (const m of moves) {
    const next = sp.play(state, m)
    if (!next) throw new Error(`scripted move rejected: ${m} after [${state.moves.join(' ')}]`)
    state = next
  }
  return state
}

try {
  const KINDS = [
    'chess', 'chess960', 'crazyhouse', 'atomic', 'antichess',
    'kingofthehill', 'threecheck', 'horde', 'racingkings'
  ]

  // ---- kernel shape / registry ---------------------------------------------
  console.log('kernel + registry')
  for (const kind of KINDS) {
    const sp = spec(kind)
    ok(sp && sp.kind === kind && sp.family === 'chess', `${kind}: spec registered with kind+family`)
  }
  ok(KINDS.every((k) => spec(k).flipPolicy === 'rotate'), 'all variants: flipPolicy rotate (OTB)')
  ok(
    KINDS.every((k) => {
      const b = spec(k).board
      return b.layout === 'cells' && b.files === 8 && b.ranks === 8
    }),
    'all variants: 8x8 cells board'
  )
  ok(listGames().length >= 9, 'registry lists at least the 9 chess-family games (P2 kinds may add more)')
  ok(KINDS.every((k) => getGame(k)?.spec.kind === k), 'registry: kind → entry.spec.kind for all 9')
  eq(getGame('chess').botProviderId, 'stockfish', 'registry: chess bot provider = stockfish')
  ok(
    KINDS.filter((k) => k !== 'chess').every((k) => getGame(k).botProviderId === 'fairy-stockfish'),
    'registry: variants bot provider = fairy-stockfish'
  )
  ok(KINDS.every((k) => getGame(k).manualId === k), 'registry: manual id = kind')
  ok(isRegisteredGame('atomic') && !isRegisteredGame('not-a-game'), 'registry: isRegisteredGame guards unknown kinds')

  // ---- chess ----------------------------------------------------------------
  console.log('chess')
  const chess = spec('chess')
  let s = chess.init()
  eq(chess.legalMoves(s).length, 20, 'chess: 20 legal moves at start')
  eq(chess.result(s), null, 'chess: ongoing at start')
  eq(chess.play(s, 'e2e5'), null, 'chess: illegal pawn jump e2e5 → null')
  eq(chess.play(s, 'zzzz'), null, 'chess: garbage move → null')
  const foolsMate = playAll(chess, s, ['f2f3', 'e7e5', 'g2g4', 'd8h4'])
  const fmRes = chess.result(foolsMate)
  ok(fmRes && fmRes.winner === 'black' && fmRes.score === '0-1' && fmRes.reason === 'checkmate',
    "chess: fool's mate → 0-1 by checkmate")
  eq(chess.legalMoves(foolsMate).length, 0, 'chess: no legal moves after mate')
  s = playAll(chess, chess.init(), ['e2e4', 'd7d5'])
  const capMeta = chess.moveMeta(s, 'e4d5')
  ok(capMeta.capture === true && capMeta.sound === 'capture', 'chess: exd5 meta = capture')
  const checkState = playAll(chess, chess.init(), ['f2f3', 'e7e5', 'g2g4'])
  eq(chess.moveMeta(checkState, 'd8h4').sound, 'check', 'chess: mating move meta sound = check')
  const italian = playAll(chess, chess.init(), ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'])
  eq(chess.moveMeta(italian, 'e1g1').sound, 'castle', 'chess: O-O meta sound = castle')
  const castled = chess.play(italian, 'e1g1')
  ok(castled !== null && castled.fen.includes('RK1'), 'chess: standard-UCI castling e1g1 accepted (normalized)')
  ok(chess.legalMoves(italian).includes('e1h1'), 'chess: canonical castling move e1h1 enumerated')

  // ---- chess960 ---------------------------------------------------------------
  console.log('chess960')
  const c960 = spec('chess960')
  eq(scharnaglArrangement(518), 'RNBQKBNR', 'chess960: Scharnagl 518 = standard arrangement')
  eq(scharnaglArrangement(0), 'BBQNNRKR', 'chess960: Scharnagl 0 = BBQNNRKR')
  const std960 = c960.init({ positionNumber: 518 })
  ok(std960.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'), 'chess960: pos 518 = standard start FEN')
  eq(c960.legalMoves(std960).length, 20, 'chess960: 20 legal moves from pos 518')
  eq(c960.init({ seed: 42 }).fen, c960.init({ seed: 42 }).fen, 'chess960: same seed → same start')
  ok(chess960Fen(1) !== chess960Fen(2), 'chess960: distinct position numbers → distinct FENs')
  const r960 = c960.init()
  ok(c960.legalMoves(r960).length > 0 && c960.result(r960) === null, 'chess960: random init playable + ongoing')
  const pre960 = playAll(c960, std960, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'])
  ok(c960.legalMoves(pre960).includes('e1h1'), 'chess960: king-takes-rook castling enumerated')

  // ---- crazyhouse -------------------------------------------------------------
  console.log('crazyhouse')
  const zh = spec('crazyhouse')
  s = zh.init()
  eq(zh.legalMoves(s).length, 20, 'crazyhouse: 20 legal moves at start')
  s = playAll(zh, s, ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'g1f3'])
  ok(s.fen.includes('[Pp]') || s.fen.includes('[pP]'), 'crazyhouse: both pockets hold a pawn after trades')
  const zhMoves = zh.legalMoves(s)
  ok(zhMoves.includes('P@e4'), 'crazyhouse: pawn drop P@e4 enumerated')
  ok(!zhMoves.includes('P@e1'), 'crazyhouse: backrank pawn drop not enumerated')
  eq(zh.play(s, 'P@e1'), null, 'crazyhouse: backrank pawn drop → null')
  const zhMeta = zh.moveMeta(s, 'P@e4')
  ok(zhMeta.capture === false && zhMeta.sound === 'move', 'crazyhouse: drop meta = quiet move')
  const dropped = zh.play(s, 'P@e4')
  ok(dropped !== null && dropped.moves.at(-1) === 'P@e4', 'crazyhouse: drop plays and records UCI')

  // ---- atomic -----------------------------------------------------------------
  console.log('atomic')
  const atomic = spec('atomic')
  s = atomic.init()
  eq(atomic.legalMoves(s).length, 20, 'atomic: 20 legal moves at start')
  s = playAll(atomic, s, ['g1f3', 'h7h6', 'f3e5', 'h6h5'])
  eq(atomic.result(s), null, 'atomic: ongoing before the sac')
  eq(atomic.moveMeta(s, 'e5f7').capture, true, 'atomic: Nxf7 meta capture')
  s = playAll(atomic, s, ['e5f7'])
  const atomicRes = atomic.result(s)
  ok(atomicRes && atomicRes.winner === 'white' && atomicRes.reason === 'variant',
    'atomic: Nxf7 explodes the king → white wins by variant end')

  // ---- antichess --------------------------------------------------------------
  console.log('antichess')
  const anti = spec('antichess')
  s = anti.init()
  eq(anti.legalMoves(s).length, 20, 'antichess: 20 legal moves at start')
  s = playAll(anti, s, ['e2e3', 'b7b5'])
  const forced = anti.legalMoves(s)
  eq(forced.length, 1, 'antichess: capture available → exactly one legal move')
  eq(forced[0], 'f1b5', 'antichess: the forced capture is Bxb5')
  eq(anti.play(s, 'd2d4'), null, 'antichess: non-capture while capture exists → null')
  s = anti.init({ fen: '8/8/8/8/8/8/1r6/K7 w - - 0 1' })
  eq(anti.legalMoves(s).join(','), 'a1b2', 'antichess: lone king must capture the rook')
  s = playAll(anti, s, ['a1b2'])
  const antiRes = anti.result(s)
  ok(antiRes && antiRes.winner === 'black' && antiRes.score === '0-1' && antiRes.reason === 'variant',
    'antichess: black lost every piece → black WINS')

  // ---- king of the hill ---------------------------------------------------------
  console.log('kingofthehill')
  const koth = spec('kingofthehill')
  s = koth.init()
  eq(koth.legalMoves(s).length, 20, 'kingofthehill: 20 legal moves at start')
  s = playAll(koth, s, ['e2e4', 'a7a6', 'e1e2', 'a6a5', 'e2e3', 'a5a4'])
  eq(koth.result(s), null, 'kingofthehill: ongoing one step from the hill')
  s = playAll(koth, s, ['e3d4'])
  const kothRes = koth.result(s)
  ok(kothRes && kothRes.winner === 'white' && kothRes.reason === 'variant',
    'kingofthehill: king reaches d4 → white wins')

  // ---- three-check ---------------------------------------------------------------
  console.log('threecheck')
  const t3 = spec('threecheck')
  s = t3.init()
  eq(t3.legalMoves(s).length, 20, 'threecheck: 20 legal moves at start')
  // Qh5+ (1), Qxg6+ (2) sacrificing the queen, then Bb5+ (3) once ...d5 opens the diagonal.
  s = playAll(t3, s, ['e2e4', 'f7f6', 'd1h5', 'g7g6', 'h5g6', 'h7g6', 'a2a3', 'd7d5'])
  eq(t3.result(s), null, 'threecheck: ongoing after two checks')
  s = playAll(t3, s, ['f1b5'])
  const t3Res = t3.result(s)
  ok(t3Res && t3Res.winner === 'white' && t3Res.reason === 'variant',
    'threecheck: third check → white wins')

  // ---- horde ---------------------------------------------------------------------
  console.log('horde')
  const horde = spec('horde')
  s = horde.init()
  eq(horde.legalMoves(s).length, 8, 'horde: 8 legal moves at start (rank-4/5 pawns)')
  eq(horde.result(s), null, 'horde: kingless white side is a valid ongoing game')
  s = horde.init({ fen: '4k3/8/8/8/3Pr3/8/8/8 b - - 0 1' })
  s = playAll(horde, s, ['e4d4'])
  const hordeRes = horde.result(s)
  ok(hordeRes && hordeRes.winner === 'black' && hordeRes.reason === 'variant',
    'horde: last horde pawn captured → black wins')

  // ---- racing kings ----------------------------------------------------------------
  console.log('racingkings')
  const rk = spec('racingkings')
  s = rk.init()
  eq(rk.legalMoves(s).length, 21, 'racingkings: 21 legal moves at start (checking moves excluded)')
  eq(rk.play(s, 'e2c3'), null, 'racingkings: Nc3 would give check → null')
  // Black's knights block the c1–h6 (Ne3) and c2–h7 (Ne4) diagonals so the
  // white king can run the h-file without ever stepping into an attack.
  s = playAll(rk, s, ['h2h3', 'd1e3', 'h3h4', 'a2a3', 'h4h5', 'a3a2', 'h5h6', 'd2e4', 'h6h7', 'a2a3'])
  eq(rk.result(s), null, 'racingkings: ongoing one step from the goal')
  s = playAll(rk, s, ['h7h8'])
  const rkRes = rk.result(s)
  ok(rkRes && rkRes.winner === 'white' && rkRes.reason === 'variant',
    'racingkings: king reaches the eighth rank first → white wins')

  // ---- immutability ------------------------------------------------------------------
  const base = chess.init()
  chess.play(base, 'e2e4')
  eq(base.moves.length, 0, 'kernel: play() never mutates the input state')
  eq(chess.serializeOptions({ fen: 'x' }), '{"fen":"x"}', 'kernel: serializeOptions is stable JSON')

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
