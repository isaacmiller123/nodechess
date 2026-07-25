// Headless test for Replay Theater:
//
//   1. PURE choreography math (src/renderer/src/games/three/theater.ts;
//      three-free by contract): cadence, capture slow-mo / dolly / pull
//      envelopes, orbit keyframes, spherical→cartesian, action-square diffs.
//   2. Smoke: the theater 3D modules IMPORT cleanly in bare node (TheaterRig
//      pulls three + R3F; GameBoard3D re-exports the bridge with the theater
//      seam): the same esbuild+DOM-shim bundling as test-board3d.mjs.
//
//   node scripts/test-theater.mjs
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
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
function close(a, b, eps, msg) {
  ok(Math.abs(a - b) <= eps, `${msg} (${a} ≈ ${b} ±${eps})`)
}

const outDir = mkdtempSync(resolve(tmpdir(), 'theater-test-'))
try {
  // ---- 1. pure choreography (must bundle with ZERO dependencies) -------------
  const pureOut = resolve(outDir, 'theater.mjs')
  const pure = await build({
    entryPoints: [resolve(ROOT, 'src/renderer/src/games/three/theater.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: pureOut,
    logLevel: 'silent',
    metafile: true
  })
  const bundledInputs = Object.keys(pure.metafile.inputs)
  ok(bundledInputs.length === 1, `theater.ts is dependency-free (${bundledInputs.length} input)`)

  const T = await import(pathToFileURL(pureOut).href)

  console.log('cadence')
  ok(T.plyDurationMs(false, 1) === T.BASE_PLY_MS, 'quiet ply at 1× = base cadence')
  ok(T.plyDurationMs(true, 1) > T.plyDurationMs(false, 1), 'capture plies linger longer')
  ok(T.plyDurationMs(false, 3) < T.plyDurationMs(false, 1), 'faster speed shortens the dwell')
  ok(T.plyDurationMs(false, 0.5) === T.BASE_PLY_MS * 2, '½× doubles the dwell')
  ok(T.plyDurationMs(false, 999) === T.plyDurationMs(false, 4), 'speed clamps at 4×')
  ok(T.establishMs(1) === 1500, 'establishing beat at 1×')
  ok(T.establishMs(3) >= 500 && T.establishMs(3) <= T.establishMs(1), 'establish shrinks with speed, floored')

  console.log('slow-mo envelope')
  eq(T.timeScaleAt(500, false, 1), 1, 'quiet moves never slow the clock')
  eq(T.timeScaleAt(Infinity, true, 1), 1, 'no shot yet (∞) = real time')
  eq(T.timeScaleAt(0, true, 1), 1, 'capture: full speed at commit (lead-in)')
  const dip = T.timeScaleAt(T.slowmoWindowMs(1) / 2, true, 1)
  close(dip, T.SLOWMO_SCALE, 0.01, 'capture: mid-window sits at the slow-mo scale')
  eq(T.timeScaleAt(T.slowmoWindowMs(1) + 200, true, 1), 1, 'capture: fully recovered after the window')
  // Monotone in, monotone out (no wobble).
  let last = 1
  let monoIn = true
  for (let t = 0; t <= T.slowmoWindowMs(1) / 2; t += 25) {
    const v = T.timeScaleAt(t, true, 1)
    if (v > last + 1e-9) monoIn = false
    last = v
  }
  ok(monoIn, 'slow-mo ramps down monotonically')
  ok(T.slowmoWindowMs(3) < T.slowmoWindowMs(1), 'window shrinks at faster cadences')
  ok(T.slowmoWindowMs(100) >= 380, 'window floor holds')

  console.log('dolly + pull framing')
  eq(T.dollyAt(400, false, 1), 1, 'quiet moves never dolly')
  const inWin = T.dollyAt(T.slowmoWindowMs(1) * 0.6, true, 1)
  ok(inWin < 1 && inWin >= T.CAPTURE_DOLLY - 0.01, 'capture dollies toward CAPTURE_DOLLY')
  close(T.dollyAt(T.slowmoWindowMs(1) * 3, true, 1), 1, 1e-6, 'dolly recovers to 1 after the shot')
  eq(T.pullAt(Infinity, false, 1), 0, 'no shot = no pull')
  ok(T.pullAt(300, true, 1) > T.pullAt(300, false, 1), 'captures pull the frame harder')
  const dwell = T.plyDurationMs(false, 1)
  ok(T.pullAt(dwell * 2, false, 1) < 0.01, 'pull releases back to center as the shot ages')

  console.log('orbit keyframes')
  const th0 = T.orbitThetaAt(0, false)
  const th10 = T.orbitThetaAt(10, false)
  close(th10 - th0, 10 * T.ORBIT_RATE, 1e-9, 'flat boards orbit at ORBIT_RATE')
  let maxSwing = 0
  for (let p = 0; p < 120; p += 0.25) {
    maxSwing = Math.max(maxSwing, Math.abs(T.orbitThetaAt(p, true) - T.orbitThetaAt(0, true)))
  }
  ok(maxSwing < 1.0, `upright boards swing, never circle (max ${maxSwing.toFixed(2)} rad)`)
  for (let p = 0; p < 60; p += 0.5) {
    const phi = T.orbitPhiAt(p, false)
    if (phi < 0.15 || phi > 1.32) throw new Error(`phi out of bounds at ${p}: ${phi}`)
  }
  passed++
  console.log('  ✓ elevation bob stays inside the clamp')
  ok(T.theaterRadius(19) > T.theaterRadius(8), 'bigger boards seat the camera further back')

  console.log('sphericalToVec')
  eq(T.sphericalToVec(5, Math.PI / 2, 0), { x: 0, y: 5 * Math.cos(Math.PI / 2), z: 5 }, 'phi 90° theta 0 → +z')
  const top = T.sphericalToVec(3, 0, 1.2)
  close(top.y, 3, 1e-9, 'phi 0 → straight up')
  const v = T.sphericalToVec(2, 1, 2)
  close(Math.hypot(v.x, v.y, v.z), 2, 1e-9, 'radius preserved')

  console.log('diffFocus (action square)')
  const P = (file, rank, type = 'p', color = 'white') => ({ file, rank, type, color })
  // Quiet slide e2→e4: destination dominates the centroid.
  const slide = T.diffFocus([P(4, 1)], [P(4, 3)])
  ok(slide.rank > 2.4, `slide focus biases the destination (rank ${slide.rank.toFixed(2)})`)
  eq(slide.file, 4, 'slide focus stays on the file')
  // Capture: occupant changed on the target square.
  const cap = T.diffFocus([P(4, 3), P(3, 4, 'p', 'black')], [P(3, 4, 'p', 'white')])
  ok(cap.file < 4 && cap.rank > 3.4, 'capture focus lands near the taken square')
  // Go placement + capture clear: placement outweighs the vacated stones.
  const goPrev = [P(2, 2, 'stone', 'white')]
  const goNext = [P(2, 3, 'stone', 'black')] // white stone vanished, black placed
  const goF = T.diffFocus(goPrev, goNext)
  ok(goF.rank > 2.5, 'go focus biases the placed stone over the captured one')
  eq(T.diffFocus([P(1, 1)], [P(1, 1)]), null, 'no change = no focus')
  // Othello flip fan: centroid sits between placement and flipped discs.
  const oPrev = [P(3, 3, 'disc', 'black'), P(4, 3, 'disc', 'black')]
  const oNext = [P(3, 3, 'disc', 'white'), P(4, 3, 'disc', 'white'), P(5, 3, 'disc', 'white')]
  const oF = T.diffFocus(oPrev, oNext)
  ok(oF.file > 3.5 && oF.file < 5, 'flip fan centroid inside the fan')
  close(oF.rank, 3, 1e-9, 'flip fan centroid stays on the rank')

  console.log('directive defaults')
  const d = T.defaultDirective()
  eq(d, { shot: null, speed: 1, paused: false, finale: false }, 'defaultDirective shape')
  ok(Array.isArray(T.THEATER_SPEEDS) && T.THEATER_SPEEDS[0].x === 0.5, 'speeds start at ½×')
  ok(T.THEATER_SPEEDS[T.THEATER_SPEEDS.length - 1].x === 3, 'speeds top out at 3×')

  // ---- 2. smoke: theater 3D modules import in bare node ----------------------
  console.log('module smoke (three chunk)')
  const smokeOut = resolve(outDir, 'smoke.mjs')
  await build({
    entryPoints: [resolve(ROOT, 'scripts/lib/theater-smoke-entry.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    outfile: smokeOut,
    logLevel: 'silent',
    external: ['*?url'],
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' },
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [
      {
        // Vite-only import.meta.glob lives in the sound tree; the smoke never
        // renders components, so stub the hook (test-board3d.mjs pattern).
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
  globalThis.window = globalThis
  globalThis.document = {
    createElement: () => ({ getContext: () => null, style: {} }),
    createElementNS: () => ({ style: {} })
  }
  globalThis.navigator ??= { userAgent: 'node' }
  const smoke = await import(pathToFileURL(smokeOut).href)
  ok(typeof smoke.TheaterRig === 'function', 'TheaterRig exports a component')
  ok(typeof smoke.GameBoard3D === 'function', 'GameBoard3D (theater seam) exports a component')
  ok(typeof smoke.occupancyOf === 'function', 'occupancyOf is exported for the theater bridge')
  ok(typeof smoke.Tabletop3D === 'function', 'Tabletop3D still exports with the theater prop')

  console.log(`\nALL GREEN: ${passed} assertions`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
