// fetch-puzzles.mjs: download the raw Lichess puzzle dump for the local build.
//
// Pulls the public CC0 puzzle database (`lichess_db_puzzle.csv.zst`, ~300 MB)
// from database.lichess.org into data/raw/, which scripts/build_puzzles_db.py
// then turns into resources/data/puzzles.sqlite. Stdlib Node only (global fetch),
// streamed and atomic (*.part -> rename), so a cancelled download never leaves a
// corrupt file. OS-agnostic: identical on Windows, macOS, and Linux.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst'
const OUT_DIR = path.join(ROOT, 'data', 'raw')
const OUT = path.join(OUT_DIR, 'lichess_db_puzzle.csv.zst')

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const tmp = `${OUT}.part`
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })

  console.log(`downloading ${URL}`)
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0

  let received = 0
  let lastPct = -1
  const source = Readable.fromWeb(res.body)
  source.on('data', (chunk) => {
    received += chunk.length
    if (total) {
      const pct = Math.floor((received / total) * 100)
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct
        process.stdout.write(`  ${pct}% (${(received / 1e6).toFixed(0)} MB)\r`)
      }
    }
  })

  await pipeline(source, fs.createWriteStream(tmp))
  fs.rmSync(OUT, { force: true })
  fs.renameSync(tmp, OUT)
  console.log(`\nsaved -> ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(0)} MB)`)
  console.log('next: npm run build:puzzles')
}

main().catch((err) => {
  console.error(`fetch-puzzles failed: ${err.message}`)
  process.exit(1)
})
