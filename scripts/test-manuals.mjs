// Headless test for the authored game manuals (resources/manuals/*.md +
// index.json), docs/GAMES-PLATFORM-SPEC.md §Library UI (manuals).
//
//   node scripts/test-manuals.mjs
//
// Checks, per manual: index entry <-> file 1:1, required sections present
// (## The rules / Reading the board / Three principles / A classic pattern
// or trap: chess960 predates the template and is exempt), word count in
// the authored 550–1100 band, and EVERY ```position payload is
// syntactically valid for its game:
//   - chess family  -> parsed by the landed GameSpec adapters
//                      (chessVariants.ts init({fen}), esbuild-bundled)
//   - ffish family  -> accepted by ffish-es6 (Board round-trip on the
//                      board field of the FEN)
//   - grid family   -> `key: value` lines with coordinate/number tokens
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const MANUALS = resolve(ROOT, 'resources/manuals')

// ---- tiny assert kit --------------------------------------------------------
let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}

// ---- bundle the chess-family specs (validates chess FEN payloads) -----------
const tmp = mkdtempSync(resolve(tmpdir(), 'manuals-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/chessVariants.ts'))}\n`
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
const { CHESS_VARIANT_SPECS } = await import(pathToFileURL(outfile).href)

// ---- ffish (validates xiangqi/shogi/janggi/makruk/placement payloads) -------
const require = createRequire(import.meta.url)
const ffishPath = require.resolve('ffish-es6')
const ffishWasm = readFileSync(resolve(dirname(ffishPath), 'ffish.wasm'))
const ffishModule = (await import(pathToFileURL(ffishPath).href)).default
const ffish = await ffishModule({ wasmBinary: ffishWasm })

// ---- payload validators ------------------------------------------------------
const CHESS_FAMILY = new Set([
  'chess', 'chess960', 'crazyhouse', 'atomic', 'antichess',
  'kingofthehill', 'threecheck', 'horde', 'racingkings'
])
const FFISH_FAMILY = new Set(['xiangqi', 'shogi', 'janggi', 'makruk', 'placement'])

function validateChessFen(kind, fen) {
  const spec = CHESS_VARIANT_SPECS[kind]
  if (!spec) return `no spec for ${kind}`
  try {
    const s = spec.init({ fen })
    return s && typeof s.fen === 'string' ? null : 'init returned no state'
  } catch (err) {
    return String(err?.message ?? err)
  }
}

function validateFfishFen(kind, fen) {
  let board
  try {
    board = new ffish.Board(kind, fen)
    // ffish silently falls back on garbage input; require board-field round-trip.
    const same = board.fen().split(' ')[0] === fen.split(' ')[0]
    return same ? null : `board field round-trip mismatch (got ${board.fen()})`
  } catch (err) {
    return String(err?.message ?? err)
  } finally {
    if (board) board.delete()
  }
}

// grid payloads: first line optional `size: <n>x<m>`, then `key: token token...`
const GRID_LINE = /^[a-z][a-z0-9-]*:\s+\S(.*\S)?$/
const GRID_TOKEN = /^([a-o](\d|1[0-5])|\d{1,2}|black|white|pass)$/
function validateGridPayload(payload) {
  const lines = payload.trim().split('\n').map((l) => l.trim())
  if (lines.length === 0) return 'empty payload'
  for (const line of lines) {
    if (!GRID_LINE.test(line)) return `bad line: ${line}`
    const [key, rest] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]
    if (key === 'size') {
      if (!/^\d{1,2}x\d{1,2}$/.test(rest)) return `bad size: ${rest}`
      continue
    }
    for (const tok of rest.split(/\s+/)) {
      if (!GRID_TOKEN.test(tok)) return `bad token '${tok}' in line: ${line}`
    }
  }
  return null
}

function extractPositions(md) {
  const out = []
  const re = /```position\n([\s\S]*?)```/g
  let m
  while ((m = re.exec(md)) !== null) out.push(m[1].trim())
  return out
}

const REQUIRED_SECTIONS = [
  '## The rules',
  '## Reading the board',
  '## Three principles',
  '## A classic pattern or trap'
]

// ---- run ----------------------------------------------------------------------
try {
  const index = JSON.parse(readFileSync(resolve(MANUALS, 'index.json'), 'utf8'))
  ok(Array.isArray(index) && index.length > 0, 'index.json parses to a non-empty array')
  ok(
    index.every(
      (e) =>
        typeof e.kind === 'string' &&
        typeof e.title === 'string' &&
        Number.isInteger(e.readingMinutes) &&
        e.readingMinutes > 0
    ),
    'index entries all have {kind, title, readingMinutes}'
  )
  const kinds = index.map((e) => e.kind)
  ok(new Set(kinds).size === kinds.length, 'index kinds are unique')

  const files = readdirSync(MANUALS).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
  ok(
    files.every((f) => kinds.includes(f)) && kinds.every((k) => files.includes(k)),
    `index <-> files are 1:1 (${files.length} manuals)`
  )
  ok(index.length === 23, 'all 23 library kinds have a manual')

  for (const { kind, title } of index) {
    console.log(kind)
    const md = readFileSync(resolve(MANUALS, `${kind}.md`), 'utf8')
    ok(md.startsWith('# '), `${kind}: has an H1 title`)
    const words = md.split(/\s+/).filter(Boolean).length
    if (kind !== 'chess960') {
      for (const section of REQUIRED_SECTIONS) {
        ok(md.includes(`\n${section}\n`), `${kind}: section "${section.slice(3)}"`)
      }
      ok(words >= 550 && words <= 1100, `${kind}: word count in band (${words})`)
    }
    ok(title.length > 0 && title.length <= 40, `${kind}: index title sane`)

    const positions = extractPositions(md)
    for (const [i, payload] of positions.entries()) {
      let err
      if (CHESS_FAMILY.has(kind)) err = validateChessFen(kind, payload)
      else if (FFISH_FAMILY.has(kind)) err = validateFfishFen(kind, payload)
      else err = validateGridPayload(payload)
      ok(err === null, `${kind}: position ${i + 1} valid${err ? `, ${err}` : ''}`)
    }
    if (kind !== 'chess960') {
      ok(positions.length >= 1, `${kind}: at least one position diagram (${positions.length})`)
    }
  }

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
