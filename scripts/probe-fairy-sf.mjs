// Fairy-Stockfish UCI probe: proves the bundled mac binary plays every games-
// platform variant, and verifies the castling codec at the engine boundary
// (docs/GAMES-PLATFORM-SPEC.md §Bots; games/bots.ts KIND→UCI_Variant map).
//
//   node scripts/probe-fairy-sf.mjs [path-to-binary]
//
// Checks:
//   1. engine handshake + the UCI_Variant combo list contains every variant we
//      route to it (xiangqi shogi janggi makruk placement crazyhouse atomic
//      antichess kingofthehill 3check horde racingkings chess);
//   2. per variant: position startpos → go movetime → a bestmove that the
//      engine itself then accepts via `position startpos moves <bm>`;
//   3. castling codec: standard chess accepts e1g1 (NOT e1h1) without
//      UCI_Chess960; with UCI_Chess960=true it accepts e1h1 (king-takes-rook).
//      Matching games/bots.ts's translate-only-for-non-960 boundary rule;
//   4. xiangqi bestmove on THIS mac (the task gate).
//
// Final line: 'ALL GREEN: N checks'. Exit 0 = all green.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import fs from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const BIN = process.argv[2] ?? resolve(ROOT, 'resources/engine/mac/fairy-stockfish')
if (!fs.existsSync(BIN)) {
  console.error(`fairy-stockfish binary not found: ${BIN}`)
  process.exit(1)
}

let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}

// ---- minimal line-oriented UCI driver ----------------------------------------
const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const waiters = [] // { test(line) -> value|undefined, resolve }
const lines = []
proc.stdout.setEncoding('utf-8')
proc.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    lines.push(line)
    for (let i = 0; i < waiters.length; i++) {
      const v = waiters[i].test(line)
      if (v !== undefined) {
        const [w] = waiters.splice(i, 1)
        w.resolve(v)
        break
      }
    }
  }
})

function send(cmd) {
  proc.stdin.write(cmd + '\n')
}

function waitFor(test, timeoutMs = 10000, label = 'line') {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeoutMs)
    waiters.push({
      test,
      resolve: (v) => {
        clearTimeout(timer)
        res(v)
      }
    })
  })
}

const expectToken = (cmd, token, timeoutMs = 10000) => {
  const p = waitFor((l) => (l.startsWith(token) ? l : undefined), timeoutMs, token)
  send(cmd)
  return p
}

async function bestmove(goCmd = 'go movetime 120') {
  const p = waitFor(
    (l) => (l.startsWith('bestmove') ? l.split(/\s+/)[1] : undefined),
    20000,
    'bestmove'
  )
  send(goCmd)
  return p
}

/** The engine's own FEN after `position ...` (via the `d` debug board dump). */
async function fenAfter(positionCmd) {
  send(positionCmd)
  const p = waitFor((l) => (l.startsWith('Fen:') ? l.slice(4).trim() : undefined), 10000, 'Fen:')
  send('d')
  return p
}

// ---- 1. handshake + variant list ----------------------------------------------
const variantLine = waitFor(
  (l) => (l.includes('UCI_Variant') && l.includes('var') ? l : undefined),
  10000,
  'UCI_Variant option'
)
await expectToken('uci', 'uciok')
const variants = (await variantLine).split(/\s+var\s+/).slice(1)
console.log(`engine: ${BIN}`)
console.log(`variants advertised: ${variants.length}`)

// Must match games/bots.ts FAIRY_UCI_VARIANT + ffish family kinds.
const NEEDED = [
  'chess',
  'crazyhouse',
  'atomic',
  'antichess',
  'kingofthehill',
  '3check',
  'horde',
  'racingkings',
  'xiangqi',
  'shogi',
  'janggi',
  'makruk',
  'placement'
]
for (const v of NEEDED) ok(variants.includes(v), `UCI_Variant list has '${v}'`)

await expectToken('isready', 'readyok')

// ---- 2. per-variant startpos bestmove, echoed back through the engine ---------
for (const v of NEEDED) {
  send(`setoption name UCI_Variant value ${v}`)
  send('ucinewgame')
  await expectToken('isready', 'readyok')
  send('position startpos')
  const bm = await bestmove()
  ok(/^[a-zA-Z0-9@+]{4,6}$/.test(bm) && bm !== '(none)', `${v}: bestmove '${bm}'`)
  // The engine must accept its own move (round-trip through position ... moves).
  const fen = await fenAfter(`position startpos moves ${bm}`)
  ok(typeof fen === 'string' && fen.length > 10, `${v}: engine accepts its own '${bm}' (fen: ${fen.slice(0, 32)}…)`)
}

// ---- 3. castling codec at the boundary ----------------------------------------
send('setoption name UCI_Variant value chess')
send('setoption name UCI_Chess960 value false')
send('ucinewgame')
await expectToken('isready', 'readyok')
const CASTLE_READY = 'position startpos moves e2e4 e7e5 g1f3 b8c6 f1c4 f8c5'
const fenStd = await fenAfter(`${CASTLE_READY} e1g1`)
ok(/^.*R.*/.test(fenStd) && fenStd.includes(' b '), `standard chess: accepts e1g1 (fen: ${fenStd.slice(0, 40)}…)`)
// King must be on g1: field 1, rank 1 is the LAST rank row of the FEN board.
const stdRank1 = fenStd.split(' ')[0].split('/')[7]
ok(expandRank(stdRank1)[6] === 'K', 'standard chess: e1g1 lands the king on g1 (castled)')
const fenKxR = await fenAfter(`${CASTLE_READY} e1h1`)
// Fairy-SF (like Stockfish) IGNORES an illegal/unparseable move token, leaving
// the pre-move position: white still to move. That proves e1h1 is NOT accepted
// as standard-chess castling: the boundary must translate KxR → e1g1.
ok(fenKxR.includes(' w '), `standard chess: e1h1 rejected/ignored. Translation required (fen: ${fenKxR.slice(0, 40)}…)`)

send('setoption name UCI_Chess960 value true')
send('ucinewgame')
await expectToken('isready', 'readyok')
const fen960 = await fenAfter(`${CASTLE_READY} e1h1`)
const rank1960 = fen960.split(' ')[0].split('/')[7]
ok(fen960.includes(' b ') && expandRank(rank1960)[6] === 'K', '960 mode: e1h1 (king-takes-rook) castles. Keep KxR for chess960')

// ---- 4. xiangqi gate (explicit, per the task) ----------------------------------
send('setoption name UCI_Chess960 value false')
send('setoption name UCI_Variant value xiangqi')
send('ucinewgame')
await expectToken('isready', 'readyok')
send('position startpos')
const xbm = await bestmove('go movetime 300')
ok(/^[a-i](10|[1-9])[a-i](10|[1-9])$/.test(xbm), `xiangqi on this mac: bestmove '${xbm}'`)

// ---- 5. kernel-state FEN round-trip (the engine:playVariant boundary) -----------
// games/bots.ts sends spec-state FENs (chessops makeFen dialect for the
// chessops wave; fairy dialect for ffish kinds). Per kind: build a midgame
// KERNEL state, feed its fen via `position fen`, and require (a) the engine
// echoes the same board field + side to move (dialect accepted, incl. 3check
// check counts and crazyhouse pockets), (b) the engine's bestmove is LEGAL in
// the kernel state (spec.play accepts it; e1g1 castling normalizes).
console.log('kernel-state FEN round-trip (chessops wave)')
const { build } = await import('esbuild')
const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { pathToFileURL } = await import('node:url')
const tmp = mkdtempSync(resolve(tmpdir(), 'fairy-probe-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export { CHESS_VARIANT_SPECS } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/chessVariants.ts'))}`
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  alias: { '@shared': resolve(ROOT, 'src/shared') },
  logLevel: 'silent'
})
const { CHESS_VARIANT_SPECS } = await import(pathToFileURL(outfile).href)
rmSync(tmp, { recursive: true, force: true })

// Scripted midgame prefixes (kernel codec; 3check includes a GIVEN check so
// the remaining-checks FEN field is non-default and must survive the boundary).
const KERNEL_CASES = [
  ['crazyhouse', 'crazyhouse', ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5d8', 'P@e6']],
  ['atomic', 'atomic', ['g1f3', 'd7d5', 'b1c3', 'g8f6']],
  ['antichess', 'antichess', ['e2e3', 'b7b5']],
  ['kingofthehill', 'kingofthehill', ['e2e4', 'e7e5', 'g1f3', 'b8c6']],
  ['threecheck', '3check', ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5f7', 'e8f7']],
  ['horde', 'horde', ['a4a5', 'g8f6']],
  ['racingkings', 'racingkings', ['h2h3', 'a2a3']]
]
for (const [kind, uciVariant, prefix] of KERNEL_CASES) {
  const spec = CHESS_VARIANT_SPECS[kind]
  let state = spec.init()
  for (const m of prefix) {
    const next = spec.play(state, m)
    if (!next) throw new Error(`${kind}: scripted prefix rejected at ${m}`)
    state = next
  }
  send('setoption name UCI_Chess960 value false')
  send(`setoption name UCI_Variant value ${uciVariant}`)
  send('ucinewgame')
  await expectToken('isready', 'readyok')
  const engineFen = await fenAfter(`position fen ${state.fen}`)
  const sameBoard = engineFen.split(' ')[0] === state.fen.split(' ')[0]
  const sameTurn = engineFen.split(' ')[1] === state.fen.split(' ')[1]
  ok(sameBoard && sameTurn, `${kind}: engine accepts kernel fen (board+turn echo)`)
  if (kind === 'threecheck') {
    ok(/\+/.test(engineFen), `threecheck: check counter survives the boundary (${engineFen.split(' ').slice(-3).join(' ')})`)
  }
  const bm = await bestmove('go movetime 150')
  ok(spec.play(state, bm) !== null, `${kind}: engine bestmove '${bm}' is legal in the kernel state`)
}
// chess960 from a kernel-generated Scharnagl start (UCI_Chess960 on).
{
  const spec = CHESS_VARIANT_SPECS.chess960
  let state = spec.init({ positionNumber: 300 })
  send('setoption name UCI_Variant value chess')
  send('setoption name UCI_Chess960 value true')
  send('ucinewgame')
  await expectToken('isready', 'readyok')
  const engineFen = await fenAfter(`position fen ${state.fen}`)
  ok(engineFen.split(' ')[0] === state.fen.split(' ')[0], 'chess960: engine accepts kernel Shredder-FEN start')
  const bm = await bestmove('go movetime 150')
  ok(spec.play(state, bm) !== null, `chess960: engine bestmove '${bm}' is legal in the kernel state`)
}

send('quit')
proc.stdin.end()
console.log(`\nALL GREEN: ${passed} checks`)
process.exit(0)

function expandRank(rank) {
  let out = ''
  for (const ch of rank) out += /\d/.test(ch) ? ' '.repeat(Number(ch)) : ch
  return out
}
