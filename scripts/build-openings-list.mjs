// Build the browsable openings dataset for the renderer (the Openings explorer
// list). Unlike build-openings.mjs (which emits an EPD->{eco,name} map for live
// board labelling), this keeps the full named line as SAN so each opening can be
// listed, searched and replayed move-by-move.
//
// Source: lichess-org/chess-openings TSVs. Each row is `eco<TAB>name<TAB>pgn`
// where pgn is numbered SAN movetext (e.g. "1. e4 e5 2. Nf3"). CC0 licensed, so
// the generated JSON is committed to the repo (no network at app runtime).
//
// Output: src/renderer/src/features/openings/openings-db.json
//   [{ eco, name, san: string[] }, ...]  (sorted by name)
//
// Run once:  node scripts/build-openings-list.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSan, makeSan } from 'chessops/san'
import { Chess } from 'chessops/chess'

const VOLUMES = ['a', 'b', 'c', 'd', 'e']
const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_FILE = join(
  __dirname,
  '..',
  'src',
  'renderer',
  'src',
  'features',
  'openings',
  'openings-db.json'
)

async function fetchTsv(vol) {
  const url = `${BASE}/${vol}.tsv`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status} ${res.statusText}`)
  return res.text()
}

/** Strip move numbers ("1." / "12...") from numbered SAN movetext -> SAN tokens. */
function sanTokens(pgn) {
  return pgn
    .split(/\s+/)
    .map((t) => t.replace(/^\d+\.+/, '')) // "1.e4" -> "e4", "1." -> ""
    .filter((t) => t && !/^\d+$/.test(t) && t !== '*')
}

async function main() {
  const out = []
  let rows = 0
  let skipped = 0

  for (const vol of VOLUMES) {
    const tsv = await fetchTsv(vol)
    for (const line of tsv.split('\n')) {
      if (!line) continue
      const [eco, name, pgn] = line.split('\t')
      if (eco === 'eco' || !eco || !name || !pgn) continue // header / malformed
      rows++

      // Replay to validate + canonicalise SAN (disambiguation, check marks).
      const pos = Chess.default()
      const san = []
      let bad = false
      for (const tok of sanTokens(pgn)) {
        const move = parseSan(pos, tok)
        if (!move) {
          bad = true
          break
        }
        san.push(makeSan(pos, move))
        pos.play(move)
      }
      if (bad || san.length === 0) {
        skipped++
        continue
      }
      out.push({ eco, name, san })
    }
    console.log(`  ${vol}.tsv processed`)
  }

  out.sort((a, b) => a.name.localeCompare(b.name) || a.eco.localeCompare(b.eco))

  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(out), 'utf-8')

  console.log(`rows read:    ${rows}`)
  console.log(`rows skipped: ${skipped}`)
  console.log(`openings:     ${out.length}`)
  console.log(`written to:   ${OUT_FILE}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
