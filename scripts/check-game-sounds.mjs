// check-game-sounds.mjs: listen-check gate for the generated game sounds.
//
//   node scripts/check-game-sounds.mjs
//
// Parses every WAV under src/renderer/src/assets/sounds/games/ and prints a
// table of duration / peak / RMS / size. FAILS (exit 1) when any file:
//   * clips or peaks above −1 dBFS,
//   * exceeds the 120 KiB per-file budget,
//   * is not 16-bit mono PCM at 44.1 kHz,
//   * or is effectively silent (peak below −40 dBFS; a broken render).
// Run after scripts/gen-game-sounds.mjs.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.resolve(__dirname, '../src/renderer/src/assets/sounds/games')

const MAX_PEAK_DBFS = -1
const MIN_PEAK_DBFS = -40
const MAX_BYTES = 120 * 1024

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      }
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size)
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk')
  return { fmt, data }
}

const dbfs = (x) => (x <= 0 ? -Infinity : 20 * Math.log10(x))

async function main() {
  const names = (await readdir(DIR)).filter((f) => f.endsWith('.wav')).sort()
  if (names.length === 0) {
    console.error(`no WAVs in ${DIR}, run: node scripts/gen-game-sounds.mjs`)
    process.exitCode = 1
    return
  }
  const rows = []
  const problems = []
  for (const name of names) {
    const raw = await readFile(path.join(DIR, name))
    let fmt, data
    try {
      ;({ fmt, data } = parseWav(raw))
    } catch (err) {
      problems.push(`${name}: ${err.message}`)
      continue
    }
    if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || fmt.sampleRate !== 44100) {
      problems.push(`${name}: expected 16-bit mono PCM @44100, got fmt=${fmt.format} ch=${fmt.channels} ${fmt.bits}bit @${fmt.sampleRate}`)
    }
    const n = Math.floor(data.length / 2)
    let peak = 0
    let sumSq = 0
    let clipped = 0
    for (let i = 0; i < n; i++) {
      const s = data.readInt16LE(i * 2) / 32768
      const a = Math.abs(s)
      if (a > peak) peak = a
      if (a >= 32767 / 32768) clipped++
      sumSq += s * s
    }
    const durMs = (n / fmt.sampleRate) * 1000
    const peakDb = dbfs(peak)
    const rmsDb = dbfs(Math.sqrt(sumSq / Math.max(n, 1)))
    rows.push({
      file: name,
      'dur ms': durMs.toFixed(0),
      'peak dBFS': peakDb.toFixed(2),
      'rms dBFS': rmsDb.toFixed(1),
      KiB: (raw.length / 1024).toFixed(1)
    })
    if (clipped > 0) problems.push(`${name}: ${clipped} clipped sample(s)`)
    if (peakDb > MAX_PEAK_DBFS) problems.push(`${name}: peak ${peakDb.toFixed(2)} dBFS above ${MAX_PEAK_DBFS} dBFS ceiling`)
    if (peakDb < MIN_PEAK_DBFS) problems.push(`${name}: peak ${peakDb.toFixed(2)} dBFS. Effectively silent`)
    if (raw.length > MAX_BYTES) problems.push(`${name}: ${(raw.length / 1024).toFixed(1)} KiB over the 120 KiB budget`)
  }
  console.table(rows)
  if (problems.length > 0) {
    console.error('FAIL:')
    for (const p of problems) console.error('  - ' + p)
    process.exitCode = 1
  } else {
    console.log(`OK: ${rows.length} files, all peaks ≤ ${MAX_PEAK_DBFS} dBFS, all ≤ 120 KiB.`)
  }
}

main().catch((err) => {
  console.error('check-game-sounds failed:', err)
  process.exitCode = 1
})
