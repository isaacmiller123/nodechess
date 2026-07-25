// Headless test for the Variant Lab board's OWN move/square codec
// (src/renderer/src/features/games/editor/CustomBoard.tsx pure exports) on the
// boards where two-digit ranks and j–l files actually occur: grand chess
// (10×10, black back rank ON rank 10) and a painted 12×10 custom variant.
//
// CustomBoard is SEPARATE from ChessFamilyBoard/cgKeys. It renders its own
// grid and speaks full UCI square names ('a10'), so the chessgroundx ':'-rank
// bug class cannot hit it, but a 4-char/single-digit assumption in its regex
// or click codec would reproduce the same user-facing symptom (unmovable
// rank-10 pieces, dead j/k/l files). This suite pins, against the REAL engine:
//
//   parseMove          goldens: rank-10 from/to/both, j–l files, promotion
//                      suffixes into rank 10, drops on rank 10, rejects
//   squareName         click codec ↔ parseMove round-trip over every cell
//   grand (ffish)      EVERY legal move parses at plies 0..N of a live line;
//                      black rank-10 origins are clickable (from === 'x10');
//                      a rank-10 promotion move parses with its suffix
//   12×10 painted      registers + EVERY legal move parses; l-file moves
//                      grouped under squareName(11, ·)
//
//   node scripts/test-custom-board-keys.mjs
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
function eqObj(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'custom-board-keys-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export { parseMove, squareName } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/features/games/editor/CustomBoard.tsx'))}\n` +
    `export { registerCustomVariant, unregisterCustomVariant } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/customVariants.ts'))}\n` +
    `export { preloadFfish } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffish.ts'))}\n` +
    `export * as model from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/features/games/editor/model.ts'))}\n` +
    `export { templateById } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/features/games/editor/templates.ts'))}\n`
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  external: ['*?url'],
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const wasmCopy = resolve(tmp, 'ffish.wasm')
copyFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm'), wasmCopy)

const mod = await import(pathToFileURL(outfile).href)
const {
  parseMove,
  squareName,
  registerCustomVariant,
  unregisterCustomVariant,
  preloadFfish,
  model,
  templateById
} = mod

/** Every move a position offers must survive the board's codec. A single
 *  unparseable move is an invisible/unmovable piece in the Lab. */
function assertAllParse(moves, files, ranks, label) {
  const onBoard = (sq) => {
    const file = sq.charCodeAt(0) - 97
    const rank = Number(sq.slice(1)) - 1
    return file >= 0 && file < files && rank >= 0 && rank < ranks
  }
  for (const raw of moves) {
    const p = parseMove(raw)
    if (!p) throw new Error(`ASSERT FAILED: ${label}: legal move ${JSON.stringify(raw)} does not parse`)
    const squares = p.drop ? [p.drop.to] : [p.from, p.to]
    for (const sq of squares) {
      if (!onBoard(sq)) throw new Error(`ASSERT FAILED: ${label}: ${raw} → square ${sq} is off the ${files}×${ranks} board`)
    }
  }
  passed++
  console.log(`  ✓ ${label}: all ${moves.length} legal moves parse onto the ${files}×${ranks} board`)
}

try {
  // ---- parseMove goldens -----------------------------------------------------
  console.log('parseMove goldens (rank 10 + j–l files)')
  eqObj(parseMove('a10a9'), { raw: 'a10a9', from: 'a10', to: 'a9', suffix: '' }, "'a10a9' from rank 10")
  eqObj(parseMove('b3b10'), { raw: 'b3b10', from: 'b3', to: 'b10', suffix: '' }, "'b3b10' into rank 10")
  eqObj(parseMove('a10b10'), { raw: 'a10b10', from: 'a10', to: 'b10', suffix: '' }, "'a10b10' along rank 10")
  eqObj(parseMove('a9a10q'), { raw: 'a9a10q', from: 'a9', to: 'a10', suffix: 'q' }, "'a9a10q' promotion into rank 10")
  eqObj(parseMove('j9j10c'), { raw: 'j9j10c', from: 'j9', to: 'j10', suffix: 'c' }, "'j9j10c' j-file chancellor promotion")
  eqObj(parseMove('l1l10'), { raw: 'l1l10', from: 'l1', to: 'l10', suffix: '' }, "'l1l10' l-file (12-wide) full slide")
  eqObj(parseMove('k8j10'), { raw: 'k8j10', from: 'k8', to: 'j10', suffix: '' }, "'k8j10' wide-board knight-ish jump")
  eqObj(parseMove('e7e8+'), { raw: 'e7e8+', from: 'e7', to: 'e8', suffix: '+' }, "'e7e8+' shogi-style suffix")
  eqObj(parseMove('P@e10'), { raw: 'P@e10', drop: { letter: 'P', to: 'e10' } }, "'P@e10' drop on rank 10")
  eqObj(parseMove('Q@l10'), { raw: 'Q@l10', drop: { letter: 'Q', to: 'l10' } }, "'Q@l10' drop on the far corner")
  for (const bad of ['a0a1', 'a11a1', 'a1a11', 'm1m2', 'a10', '10a10a', 'a10a10qq', '']) {
    eq(parseMove(bad), null, `${JSON.stringify(bad)} rejected`)
  }

  // ---- squareName ↔ parseMove round-trip (the click codec) --------------------
  console.log('squareName click codec')
  eq(squareName(0, 9), 'a10', 'squareName(0,9) = a10')
  eq(squareName(11, 9), 'l10', 'squareName(11,9) = l10 (12-wide far corner)')
  eq(squareName(9, 0), 'j1', 'squareName(9,0) = j1 (file beyond i)')
  {
    let trips = 0
    for (let f = 0; f < 12; f++) {
      for (let r = 0; r < 10; r++) {
        const sq = squareName(f, r)
        const p = parseMove(`${sq}${sq === 'a1' ? 'b2' : 'a1'}`)
        if (p && p.from === sq) trips++
      }
    }
    eq(trips, 120, 'every 12×10 cell name round-trips through parseMove as a from-square')
  }

  // ---- live grand chess: rank 10 through the REAL engine ----------------------
  console.log('grand chess (ffish): rank-10 codec end to end')
  await preloadFfish({ wasmBinary: readFileSync(wasmCopy) })
  const grandTpl = templateById('grand')
  const grandDef = {
    id: 'cbk-grand',
    name: grandTpl.model.name,
    description: grandTpl.model.description,
    iniText: model.generateIni(grandTpl.model),
    boardFiles: grandTpl.model.files,
    boardRanks: grandTpl.model.ranks
  }
  const grand = (await registerCustomVariant(grandDef)).spec
  let g = grand.init()
  eq(g.fen.split(' ')[0].split('/').length, 10, 'grand start FEN has 10 rank rows')
  assertAllParse(grand.legalMoves(g), 10, 10, 'grand ply 0')

  // One white move → black's turn: the a10/j10 rooks must be CLICKABLE. Their
  // moves' from must equal the square the click codec produces for that cell.
  g = grand.play(g, 'a3a4')
  ok(g !== null, 'grand: white a3a4 accepted')
  const blackMoves = grand.legalMoves(g)
  assertAllParse(blackMoves, 10, 10, 'grand ply 1 (black, back rank on 10)')
  const fromA10 = blackMoves.filter((m) => parseMove(m)?.from === squareName(0, 9))
  ok(fromA10.length >= 1, `black a10 rook is clickable: ${fromA10.length} moves from squareName(0,9)`)
  ok(fromA10.includes('a10a9'), 'a10a9 grouped under the a10 click origin')
  const rank10Froms = new Set(
    blackMoves.map((m) => parseMove(m)?.from).filter((f) => f && f.endsWith('10'))
  )
  ok(rank10Froms.size >= 1, `black rank-10 origins exist in the dests grouping (${[...rank10Froms].join(' ')})`)
  const g2 = grand.play(g, 'a10a9')
  ok(g2 !== null, 'grand: black rank-10 move a10a9 accepted by spec.play')
  eqObj(
    (() => { const p = parseMove(g2.moves.at(-1)); return { from: p.from, to: p.to } })(),
    { from: 'a10', to: 'a9' },
    'lastMove for the rank-10 move highlights a10 → a9'
  )

  // Promotion INTO rank 10: white pawn on a9, every promotion coda must parse.
  const promoStart = grand.init({ fen: '10/P8k/10/10/10/10/10/10/10/K9 w - - 0 1' })
  const promoMoves = grand.legalMoves(promoStart).filter((m) => parseMove(m)?.to === 'a10')
  ok(promoMoves.length >= 1, `grand: pawn a9 offers ${promoMoves.length} move(s) into a10`)
  assertAllParse(promoMoves, 10, 10, 'grand promotion codas')
  ok(
    promoMoves.every((m) => { const p = parseMove(m); return p.from === 'a9' && p.to === 'a10' }),
    'every promotion coda groups under the same a9 → a10 click pair (promo picker path)'
  )
  unregisterCustomVariant('cbk-grand')

  // ---- 12×10 painted variant: j/k/l files live ---------------------------------
  console.log('12×10 painted variant (files j–l)')
  const wideModel = {
    name: 'Wide Test',
    description: '',
    parent: 'chess',
    files: 12,
    ranks: 10,
    board: model.classicArmies(12, 10),
    royal: 'checkmate',
    castling: false,
    doubleStep: true,
    promotion: ['q', 'r', 'b', 'n']
  }
  const wideDef = {
    id: 'cbk-wide',
    name: wideModel.name,
    description: '',
    iniText: model.generateIni(wideModel),
    boardFiles: 12,
    boardRanks: 10
  }
  const wide = (await registerCustomVariant(wideDef)).spec
  const w0 = wide.init()
  ok(w0.fen.split(' ')[0].split('/').some((row) => row.includes('12')), '12-wide FEN uses multi-digit empty runs')
  const wMoves = wide.legalMoves(w0)
  assertAllParse(wMoves, 12, 10, '12×10 ply 0')
  const lFile = wMoves.filter((m) => parseMove(m)?.from === squareName(11, 1))
  ok(lFile.length >= 1, `l2 pawn is clickable: ${lFile.length} moves from squareName(11,1)`)
  const jKnight = wMoves.some((m) => parseMove(m)?.from === squareName(9, 0) || parseMove(m)?.from === squareName(10, 0))
  ok(jKnight, 'a j/k-file back-rank piece has moves (files beyond i are live)')
  // Black side: rank-10 back rank must be clickable after a white move.
  const w1 = wide.play(w0, wMoves.find((m) => parseMove(m)?.from === squareName(11, 1)))
  ok(w1 !== null, '12×10: white l-file move accepted')
  const wBlack = wide.legalMoves(w1)
  assertAllParse(wBlack, 12, 10, '12×10 ply 1 (black)')
  const blackRank10 = new Set(wBlack.map((m) => parseMove(m)?.from).filter((f) => f && f.endsWith('10')))
  ok(blackRank10.size >= 1, `12×10 black rank-10 origins clickable (${[...blackRank10].slice(0, 4).join(' ')}…)`)
  unregisterCustomVariant('cbk-wide')

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
