// Headless test for the GameBoardProps → Tabletop3D bridge's pure move/state
// mapping (src/renderer/src/games/three/GameBoard3D.tsx exports):
//
//   chessOccupancy   FEN board field → white-frame occupancy
//   checkersPosOf / checkersSquareOf   PDN/FMJD codec squares ↔ board pos
//   chessDragMove    drag gesture → legal UCI (promotion auto-queen, castling
//                    gesture → king-takes-rook codec move)
//   checkersDragMove drag gesture → codec move by first/last square
//   placementMove    click → go vertex / othello square / connect4 column
//   reconcile        stable piece identities across state diffs (slide /
//                    capture / promotion / othello flip-in-place)
//
// The module pulls three.js + R3F. Esbuild bundles it for bare node with a
// tiny DOM shim; components are never invoked (pure function exports only).
//
//   node scripts/test-board3d.mjs
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}
function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (${JSON.stringify(a)} === ${JSON.stringify(b)})`)
}

const outDir = mkdtempSync(resolve(tmpdir(), 'board3d-test-'))
const outFile = resolve(outDir, 'bridge.mjs')
try {
  await build({
    entryPoints: [resolve(ROOT, 'src/renderer/src/games/three/GameBoard3D.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    outfile: outFile,
    logLevel: 'silent',
    external: ['*?url'],
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' },
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [
      {
        // The sound tree uses Vite-only import.meta.glob; the bridge only
        // calls useBoardSound inside components (never invoked here). Stub it.
        name: 'stub-sound',
        setup(b) {
          b.onResolve({ filter: /useBoardSound$/ }, (args) => ({
            path: args.path,
            namespace: 'sound-stub'
          }))
          b.onLoad({ filter: /.*/, namespace: 'sound-stub' }, () => ({
            contents: 'export function useBoardSound() {}',
            loader: 'js'
          }))
        }
      }
    ]
  })

  // Minimal DOM shim: module-scope code in the three tree only touches these.
  globalThis.window = globalThis
  globalThis.document = {
    createElement: () => ({ getContext: () => null, style: {} }),
    createElementNS: () => ({ style: {} })
  }
  globalThis.navigator ??= { userAgent: 'node' }

  const m = await import(pathToFileURL(outFile).href)
  const {
    chessOccupancy,
    checkersPosOf,
    checkersSquareOf,
    chessDragMove,
    checkersDragMove,
    placementMove,
    reconcile
  } = m

  // ---- chessOccupancy --------------------------------------------------------
  console.log('chessOccupancy')
  const start = chessOccupancy('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', 8)
  ok(start.length === 32, 'start position has 32 pieces')
  const e1 = start.find((p) => p.file === 4 && p.rank === 0)
  eq({ t: e1.type, c: e1.color }, { t: 'k', c: 'white' }, 'white king on e1')
  const e8 = start.find((p) => p.file === 4 && p.rank === 7)
  eq({ t: e8.type, c: e8.color }, { t: 'k', c: 'black' }, 'black king on e8')
  ok(
    start.filter((p) => p.rank === 1).every((p) => p.type === 'p' && p.color === 'white'),
    'rank 2 all white pawns'
  )
  // Crazyhouse markers: promoted '~' skipped, bracket pocket ignored.
  const zh = chessOccupancy('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN~R[QP]', 8)
  ok(zh.length === 32, 'crazyhouse ~ marker + [pocket] tolerated')
  // Fairy '+' promoted-piece PREFIX (shogi/ffish FENs spell a promoted pawn
  // '+P'): the marker must be skipped, not read as a piece named '+' that
  // shifts every later piece on its rank.
  const sh = chessOccupancy('+P8/9/9/9/9/9/9/9/9', 9)
  ok(sh.length === 1, `shogi '+P' reads as ONE piece (got ${sh.length})`)
  eq(
    { f: sh[0]?.file, r: sh[0]?.rank, t: sh[0]?.type, c: sh[0]?.color },
    { f: 0, r: 8, t: 'p', c: 'white' },
    "'+P' occupies file 0 as a white pawn-type piece"
  )
  // 10-rank FEN (xiangqi): rank-10 pieces land on rank index 9.
  const xq = chessOccupancy('rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR', 10)
  ok(xq.length === 32, 'xiangqi start FEN: 32 pieces across 10 ranks')
  const a10occ = xq.find((p) => p.file === 0 && p.rank === 9)
  eq({ t: a10occ?.type, c: a10occ?.color }, { t: 'r', c: 'black' }, 'black chariot on a10 (rank index 9)')

  // ---- checkers codec mapping ------------------------------------------------
  console.log('checkers codec')
  for (const n of [8, 10]) {
    const squares = (n * n) / 2
    let round = true
    for (let s = 1; s <= squares; s++) {
      const pos = checkersPosOf(s, n)
      if (checkersSquareOf(pos, n) !== s) round = false
    }
    ok(round, `${n}×${n}: pos↔square roundtrip for all ${squares} squares`)
  }
  ok(checkersSquareOf({ file: 0, rank: 7 }, 8) === null, 'light square maps to null')
  // Square 1 sits on the top row (rank n-1). The black side as numbered.
  ok(checkersPosOf(1, 8).rank === 7, 'square 1 on the top row (8×8)')

  // ---- chessDragMove ---------------------------------------------------------
  console.log('chessDragMove')
  const occ = chessOccupancy('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR', 8)
  eq(
    chessDragMove(['e2e4', 'e2e3'], occ, { file: 4, rank: 1 }, { file: 4, rank: 3 }),
    'e2e4',
    'exact UCI drag'
  )
  eq(
    chessDragMove(['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n'], [], { file: 0, rank: 6 }, { file: 0, rank: 7 }),
    'a7a8q',
    'promotion auto-queens'
  )
  // Castling gesture: king e1 dragged two squares toward h1 maps onto the
  // king-takes-rook codec move e1h1 (chess960-style codec).
  const castleOcc = [
    { file: 4, rank: 0, type: 'k', color: 'white' },
    { file: 7, rank: 0, type: 'r', color: 'white' }
  ]
  eq(
    chessDragMove(['e1h1', 'e1d1'], castleOcc, { file: 4, rank: 0 }, { file: 6, rank: 0 }),
    'e1h1',
    'king two-square gesture → king-takes-rook castle'
  )
  ok(
    chessDragMove(['e2e4'], occ, { file: 4, rank: 1 }, { file: 4, rank: 4 }) === null,
    'illegal drag → null'
  )
  // Rank-10 drags emit two-digit UCI (sqName must never truncate rank 10).
  eq(
    chessDragMove(['a10a9'], [], { file: 0, rank: 9 }, { file: 0, rank: 8 }),
    'a10a9',
    'rank-10 drag → two-digit UCI a10a9'
  )
  eq(
    chessDragMove(['b3b10'], [], { file: 1, rank: 2 }, { file: 1, rank: 9 }),
    'b3b10',
    'drag INTO rank 10 → b3b10'
  )

  // ---- checkersDragMove ------------------------------------------------------
  console.log('checkersDragMove')
  eq(
    checkersDragMove(['11-15', '11-16'], 8, checkersPosOf(11, 8), checkersPosOf(15, 8)),
    '11-15',
    'plain step by first/last square'
  )
  eq(
    checkersDragMove(['11x18x25'], 8, checkersPosOf(11, 8), checkersPosOf(25, 8)),
    '11x18x25',
    'multi-jump drag start → landing'
  )
  ok(
    checkersDragMove(['11-15'], 8, checkersPosOf(11, 8), checkersPosOf(16, 8)) === null,
    'non-matching drag → null'
  )

  // ---- placementMove ---------------------------------------------------------
  console.log('placementMove')
  // Go vertex letters skip 'i': file 0/rank 18 (top-left from white frame) = a19.
  eq(placementMove('go', { file: 0, rank: 18 }, 19), 'a19', 'go a19 corner')
  eq(placementMove('go', { file: 9, rank: 9 }, 19), 'k10', 'go tengen k10 (skips i)')
  eq(placementMove('othello', { file: 3, rank: 2 }, 8), 'd3', 'othello square name')
  eq(placementMove('connect4', { file: 6, rank: 0 }, 7), '7', 'connect4 column digit')

  // ---- reconcile -------------------------------------------------------------
  console.log('reconcile')
  let n = 0
  const nextId = () => `t${++n}`
  const P = (file, rank, color, type, id) => ({ id, pos: { file, rank }, type, color })

  // Slide keeps identity.
  const prev1 = [P(4, 1, 'white', 'p', 'a'), P(4, 6, 'black', 'p', 'b')]
  const occ1 = [
    { file: 4, rank: 3, type: 'p', color: 'white' },
    { file: 4, rank: 6, type: 'p', color: 'black' }
  ]
  const out1 = reconcile(prev1, occ1, false, nextId)
  eq(out1.find((p) => p.id === 'a').pos, { file: 4, rank: 3 }, 'moved piece keeps its id')
  ok(out1.find((p) => p.id === 'b'), 'unmoved piece keeps its id')

  // Capture drops the captured id (ghost source) and the capturer moves in.
  const prev2 = [P(4, 3, 'white', 'p', 'w'), P(3, 4, 'black', 'p', 'x')]
  const occ2 = [{ file: 3, rank: 4, type: 'p', color: 'white' }]
  const out2 = reconcile(prev2, occ2, false, nextId)
  ok(out2.length === 1 && out2[0].id === 'w', 'capturer takes the square, victim id gone')

  // Promotion: same color claims the pool piece even with a new type.
  const prev3 = [P(0, 6, 'white', 'p', 'pr')]
  const occ3 = [{ file: 0, rank: 7, type: 'q', color: 'white' }]
  const out3 = reconcile(prev3, occ3, false, nextId)
  ok(out3[0].id === 'pr' && out3[0].type === 'q', 'promotion keeps id, swaps type')

  // Othello flip-in-place: same square, color change, id preserved.
  const prev4 = [P(2, 2, 'black', 'disc', 'f')]
  const occ4 = [{ file: 2, rank: 2, type: 'disc', color: 'white' }]
  const out4 = reconcile(prev4, occ4, true, nextId)
  ok(out4[0].id === 'f' && out4[0].color === 'white', 'flip-in-place keeps id, swaps color')
  const out4strict = reconcile(prev4, occ4, false, nextId)
  ok(out4strict[0].id !== 'f', 'without flip-in-place a color change is a fresh piece')

  // Fresh spawn gets a new id (go stone placement).
  const out5 = reconcile([], [{ file: 9, rank: 9, type: 'stone', color: 'black' }], false, nextId)
  ok(out5.length === 1 && out5[0].id.startsWith('t'), 'spawned piece gets a fresh id')

  console.log(`\nALL GREEN: ${passed} assertions`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
