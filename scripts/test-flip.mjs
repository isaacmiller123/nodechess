// Headless regression tests for the OTB board-flip math + policy
// (src/renderer/src/games/boards/orient.ts, games/three/layout.ts and the
// per-game flipPolicy declarations).
//
//   node scripts/test-flip.mjs
//
// Guards the bug class fixed in the OTB flip pass:
//   - checkers square<->row/col mapping round-trips on 8x8 and 10x10;
//   - the orientation view mapping is a true 180° rotation, an involution,
//     and IDENTICAL for square rendering vs piece placement (click mapping
//     stays consistent after a flip);
//   - morris point rotation is a point reflection and a bijection over the
//     24 points;
//   - the 3D layout mirrors worldOf/posAt consistently (round-trip under
//     both orientations) and flips the world for 'black': the camera stays
//     seated, so the mirror IS the flip (CameraRig must not re-apply it);
//   - flipPolicy audit: rotate-kinds rotate, none-kinds NEVER flip.
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
}
function eq(actual, expected, msg) {
  if (!Object.is(actual, expected))
    throw new Error(`ASSERT FAILED: ${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  passed++
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'flip-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/boards/orient.ts'))}`,
    `export { createLayout } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/three/layout.ts'))}`,
    `export { AMERICAN_CHECKERS_SPEC, INTL_CHECKERS_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/checkers.ts'))}`,
    `export { MORRIS_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/morris.ts'))}`,
    `export { GO_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/go.ts'))}`,
    `export { GOMOKU_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/gomoku.ts'))}`,
    `export { OTHELLO_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/othello.ts'))}`,
    `export { HEX_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/hex.ts'))}`,
    `export { CONNECT4_SPEC } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/small/connect4.ts'))}`,
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
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)
const { squareToRC, rcToSquare, viewRC, morXY, MOR_S, createLayout } = m

// ---- checkers square mapping --------------------------------------------------
console.log('checkers square <-> row/col')
for (const n of [8, 10]) {
  const total = (n * n) / 2
  const seen = new Set()
  for (let sq = 1; sq <= total; sq++) {
    const { row, col } = squareToRC(sq, n)
    ok(row >= 0 && row < n && col >= 0 && col < n, `sq ${sq}/${n}: in range`)
    ok((row + col) % 2 === 1, `sq ${sq}/${n}: dark square`)
    eq(rcToSquare(row, col, n), sq, `sq ${sq}/${n}: round-trip`)
    seen.add(`${row},${col}`)
  }
  eq(seen.size, total, `${n}x${n}: all ${total} squares distinct`)
  // light squares are non-squares
  eq(rcToSquare(0, 0, n), null, `${n}x${n}: light square maps to null`)
}

// ---- orientation view mapping --------------------------------------------------
console.log('orientation view mapping (180° rotation, involution, render==click)')
for (const n of [8, 10]) {
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const id = viewRC(r, c, n, false)
      if (!(id.row === r && id.col === c)) throw new Error('identity broken')
      const f = viewRC(r, c, n, true)
      if (!(f.row === n - 1 - r && f.col === n - 1 - c)) throw new Error('not a 180° rotation')
      const back = viewRC(f.row, f.col, n, true)
      if (!(back.row === r && back.col === c)) throw new Error('not an involution')
    }
  }
  passed += 3
  console.log(`  ✓ ${n}x${n}: identity / rotation / involution over all cells`)
  // Render/interaction consistency: a piece drawn at view cell (r,c) must be
  // the piece the click handler resolves at (r,c), for EVERY square, both
  // orientations. (cells: sq = rcToSquare(viewRC(r,c)); pieces: (r,c) =
  // viewRC(squareToRC(sq)): same viewRC, so the composition must be id.)
  for (const flipped of [false, true]) {
    for (let sq = 1; sq <= (n * n) / 2; sq++) {
      const rc = squareToRC(sq, n)
      const view = viewRC(rc.row, rc.col, n, flipped) // where the piece renders
      const clickRC = viewRC(view.row, view.col, n, flipped) // what a click there resolves to
      if (rcToSquare(clickRC.row, clickRC.col, n) !== sq)
        throw new Error(`render/click mismatch sq ${sq} n ${n} flipped ${flipped}`)
    }
    passed++
    console.log(`  ✓ ${n}x${n} flipped=${flipped}: render position == click resolution for every square`)
  }
}

// ---- morris rotation ------------------------------------------------------------
console.log('morris point rotation')
{
  const pts = Array.from({ length: 24 }, (_, i) => morXY(i, false))
  const rot = Array.from({ length: 24 }, (_, i) => morXY(i, true))
  for (let i = 0; i < 24; i++) {
    ok(
      Math.abs(pts[i].x + rot[i].x - MOR_S) < 1e-9 && Math.abs(pts[i].y + rot[i].y - MOR_S) < 1e-9,
      `point ${i}: rotation is a point reflection about the board center`
    )
  }
  const key = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`
  const a = new Set(pts.map(key))
  const b = new Set(rot.map(key))
  eq(a.size, 24, 'all 24 points distinct')
  ok([...a].every((k) => b.has(k)), 'rotation is a bijection onto the same point set')
}

// ---- 3D layout mirror -------------------------------------------------------------
console.log('3D layout world mirror (cells + intersections)')
for (const shape of [
  { layout: 'cells', files: 8, ranks: 8 },
  { layout: 'intersections', files: 9, ranks: 10 }
]) {
  const white = createLayout(shape, 'white')
  const black = createLayout(shape, 'black')
  eq(white.seatYaw, 0, `${shape.layout}: white seatYaw 0`)
  eq(black.seatYaw, Math.PI, `${shape.layout}: black seatYaw π`)
  let mirrored = 0
  for (let f = 0; f < shape.files; f++) {
    for (let r = 0; r < shape.ranks; r++) {
      const w = white.worldOf({ file: f, rank: r })
      const b = black.worldOf({ file: f, rank: r })
      if (Math.abs(w.x + b.x) > 1e-9 || Math.abs(w.z + b.z) > 1e-9)
        throw new Error(`${shape.layout} ${f},${r}: black world is not the x/z mirror`)
      // posAt must invert worldOf under BOTH orientations (click mapping).
      const pw = white.posAt(w)
      const pb = black.posAt(b)
      if (!pw || pw.file !== f || pw.rank !== r) throw new Error(`white posAt round-trip ${f},${r}`)
      if (!pb || pb.file !== f || pb.rank !== r) throw new Error(`black posAt round-trip ${f},${r}`)
      mirrored++
    }
  }
  passed += 2
  console.log(`  ✓ ${shape.layout}: mirror + posAt round-trip over ${mirrored} squares`)
}

// ---- flipPolicy audit ----------------------------------------------------------------
console.log('flipPolicy audit')
eq(m.AMERICAN_CHECKERS_SPEC.flipPolicy, 'rotate', 'checkers rotates')
eq(m.INTL_CHECKERS_SPEC.flipPolicy, 'rotate', 'checkers-intl rotates')
eq(m.MORRIS_SPEC.flipPolicy, 'rotate', 'morris rotates')
for (const [name, spec] of [
  ['go', m.GO_SPEC],
  ['gomoku', m.GOMOKU_SPEC],
  ['othello', m.OTHELLO_SPEC],
  ['hex', m.HEX_SPEC],
  ['connect4', m.CONNECT4_SPEC],
  ['tictactoe', m.TICTACTOE_SPEC]
]) {
  eq(spec.flipPolicy, 'none', `${name} never flips (policy 'none')`)
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\nALL GREEN: ${passed} assertions`)
