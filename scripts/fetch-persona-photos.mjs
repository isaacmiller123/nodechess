// Fetch persona portraits from Wikimedia Commons into base64 data-URIs.
//
// Reads resources/personas/research.json (each persona's `photoCommonsFile`,
// e.g. "File:Paul Morphy.jpg") and downloads a 512px-wide render via the
// Special:FilePath redirect endpoint:
//   https://commons.wikimedia.org/wiki/Special:FilePath/<name>?width=512
// (follows redirects; node's global fetch does so by default).
//
// Output: resources/personas/photos.json
//   { [personaId]: { dataUri: "data:image/jpeg;base64,...", attribution: "<name>, via Wikimedia Commons" } }
// which src/main/personas/personas.ts merges into the catalog at load time.
//
// Failures are skipped and logged: the script NEVER crashes and never writes a
// broken file; personas without a photo simply stay photo-less (photo: null).
//
// Run: node scripts/fetch-persona-photos.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const RESEARCH = path.join(ROOT, 'resources', 'personas', 'research.json')
const OUT = path.join(ROOT, 'resources', 'personas', 'photos.json')

const MIME_FALLBACK = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

function commonsUrl(photoCommonsFile) {
  const name = photoCommonsFile.replace(/^File:/i, '')
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=512`
}

async function fetchPhoto(persona) {
  const url = commonsUrl(persona.photoCommonsFile)
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Commons asks automated clients to identify themselves.
      'User-Agent': 'nodechess/0.0.1 (offline desktop chess app; persona portrait fetch)'
    }
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error('empty body')
  const ext = path.extname(persona.photoCommonsFile).toLowerCase()
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || MIME_FALLBACK[ext] || 'image/jpeg'
  if (!mime.startsWith('image/')) throw new Error(`unexpected content-type ${mime}`)
  return {
    dataUri: `data:${mime};base64,${buf.toString('base64')}`,
    attribution: `${persona.name}, via Wikimedia Commons`
  }
}

async function main() {
  let research
  try {
    research = JSON.parse(fs.readFileSync(RESEARCH, 'utf-8'))
  } catch (e) {
    console.error(`Cannot read ${RESEARCH}: ${e.message}`)
    process.exitCode = 1
    return
  }

  // Start from any existing photos.json so re-runs can fill previous gaps
  // without re-downloading everything on failure.
  let out = {}
  try {
    out = JSON.parse(fs.readFileSync(OUT, 'utf-8'))
  } catch {
    /* first run */
  }

  let ok = 0
  let failed = 0
  let skipped = 0
  for (const p of research) {
    if (!p?.id || typeof p.photoCommonsFile !== 'string' || p.photoCommonsFile.length === 0) {
      skipped++
      console.log(`SKIP  ${p?.id ?? '?'}: no photoCommonsFile`)
      continue
    }
    try {
      out[p.id] = await fetchPhoto(p)
      ok++
      const kb = Math.round((out[p.id].dataUri.length * 3) / 4 / 1024)
      console.log(`OK    ${p.id.padEnd(12)} ${p.photoCommonsFile} (~${kb} KB)`)
    } catch (e) {
      failed++
      console.log(`FAIL  ${p.id.padEnd(12)} ${p.photoCommonsFile}, ${e.message}`)
    }
  }

  try {
    fs.writeFileSync(OUT, JSON.stringify(out))
    console.log(`\nphotos.json written: ${Object.keys(out).length} entries (${ok} fetched now, ${failed} failed, ${skipped} skipped)`)
  } catch (e) {
    console.error(`Could not write ${OUT}: ${e.message}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  // Belt & braces: never crash with an unhandled rejection.
  console.error(`Unexpected error: ${e?.message ?? e}`)
  process.exitCode = 1
})
