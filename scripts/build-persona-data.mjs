// Build ALL persona runtime data from resources/personas/research.json:
//
//   1. resources/personas/books.json          per-persona opening books
//        { [personaId]: { [epd]: [uci, ...] } }
//        - EPD keys use chessops makeFen(setup, { epd: true }). EXACTLY the
//          normalization src/main/personas/book.ts applies to incoming FENs.
//        - Only the persona's OWN moves are recorded (white-to-move positions
//          from repertoireWhite lines, black-to-move from repertoireBlack),
//          mirroring scripts/build-persona-books.mjs. Lines MERGE: transposing
//          lines share EPD keys and candidate lists de-duplicate.
//        - Castling is stored as chessops' king-takes-rook UCI (e.g. "e1h1"),
//          same as the previous book build: book.ts consumers already handle it.
//        - An illegal SAN fails the line (reported); the legal prefix is kept,
//          since those positions/moves are still genuine repertoire.
//
//   2. resources/famous/persona-games.json    signature games, validated
//        Same shape as resources/famous/games.json ({ version, games: [...] });
//        loaded and merged by src/main/famous/famous.repo.ts. Ids are
//        "<personaId>-g<N>" with N the 1-based position in research
//        famousGames (stable across content fixes). A game is emitted ONLY if
//        its whole movetext replays legally; pgnMoves stores the canonical SAN
//        sequence produced by the replay. `group` derives from the persona era
//        (Romantic -> romantic, Classical -> classical, everything else -> modern).
//
//   3. resources/personas/personas.json       the runtime persona catalog
//        { version, personas: [...] } consumed by src/main/personas/personas.ts.
//        All descriptive fields come straight from research.json; famousGameIds
//        lists only the games that validated. Photos are NOT stored here. They
//        merge at load time from photos.json (scripts/fetch-persona-photos.mjs).
//
// The script VALIDATES and REPORTS, it never edits content: a bad repertoire
// line or movetext is printed per-item (persona / line / token) for the content
// builder to fix in research.json, and the exit code is 1 when anything failed.
//
// Run: node scripts/build-persona-data.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseSan, makeSan } from 'chessops/san'
import { makeUci } from 'chessops/util'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const RESEARCH = path.join(ROOT, 'resources', 'personas', 'research.json')
const BOOKS_OUT = path.join(ROOT, 'resources', 'personas', 'books.json')
const PERSONAS_OUT = path.join(ROOT, 'resources', 'personas', 'personas.json')
const GAMES_OUT = path.join(ROOT, 'resources', 'famous', 'persona-games.json')

const epdOf = (pos) => makeFen(pos.toSetup(), { epd: true })

/** Same tokenizer as famous.repo.ts: strip move numbers + result tokens. */
function tokenizeMoves(movetext) {
  return movetext
    .replace(/\d+\.(\.\.)?/g, ' ')
    .replace(/\b(?:1-0|0-1|1\/2-1\/2|\*)\b/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function eraToGroup(era) {
  const e = String(era ?? '').toLowerCase()
  if (e === 'romantic') return 'romantic'
  if (e === 'classical') return 'classical'
  return 'modern'
}

const VALID_RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*'])
/** Clock personalities (Persona.timeStyle in shared/types.ts / botTime.ts). */
const VALID_TIME_STYLES = new Set(['blitzer', 'steady', 'tanker'])

// ---- Load research ----------------------------------------------------------

const research = JSON.parse(fs.readFileSync(RESEARCH, 'utf-8'))
if (!Array.isArray(research)) {
  console.error('research.json is not an array')
  process.exit(1)
}

const report = []
let lineFails = 0
let gameFails = 0
let totalLines = 0
let totalGames = 0

// ---- 1. Opening books -------------------------------------------------------

const books = {}
for (const p of research) {
  const book = {}
  const add = (epd, uci) => {
    const arr = (book[epd] ||= [])
    if (!arr.includes(uci)) arr.push(uci)
  }
  for (const [color, key] of [
    ['white', 'repertoireWhite'],
    ['black', 'repertoireBlack']
  ]) {
    const lines = Array.isArray(p[key]) ? p[key] : []
    lines.forEach((line, i) => {
      totalLines++
      const label = `${p.id} book ${color[0].toUpperCase()}${i + 1}`
      const pos = Chess.default()
      const sans = String(line).trim().split(/\s+/).filter(Boolean)
      let bad = null
      for (let t = 0; t < sans.length; t++) {
        const move = parseSan(pos, sans[t])
        if (!move) {
          bad = { t, san: sans[t], fen: makeFen(pos.toSetup()) }
          break
        }
        if (pos.turn === color) add(epdOf(pos), makeUci(move))
        pos.play(move)
      }
      if (bad) {
        lineFails++
        report.push(
          `FAIL ${label}: illegal/ambiguous SAN '${bad.san}' at token ${bad.t + 1}/${sans.length} (fen: ${bad.fen}). Legal prefix kept in book`
        )
      } else {
        report.push(`ok   ${label}: ${sans.length} plies`)
      }
    })
  }
  books[p.id] = book
}

// ---- 2. Famous games --------------------------------------------------------

const games = []
const famousIdsByPersona = {}
for (const p of research) {
  famousIdsByPersona[p.id] = []
  const list = Array.isArray(p.famousGames) ? p.famousGames : []
  list.forEach((g, i) => {
    totalGames++
    const id = `${p.id}-g${i + 1}` // positional: stable while content is fixed
    const label = `${p.id} game ${id} (${g.white} vs ${g.black}, ${g.year})`
    const sans = tokenizeMoves(String(g.movetext ?? ''))
    if (sans.length === 0) {
      gameFails++
      report.push(`FAIL ${label}: empty movetext`)
      return
    }
    const pos = Chess.default()
    const canonical = []
    let bad = null
    for (let t = 0; t < sans.length; t++) {
      const move = parseSan(pos, sans[t])
      if (!move) {
        bad = { t, san: sans[t], fen: makeFen(pos.toSetup()) }
        break
      }
      canonical.push(makeSan(pos, move))
      pos.play(move)
    }
    if (bad) {
      gameFails++
      report.push(
        `FAIL ${label}: illegal/ambiguous SAN '${bad.san}' at ply ${bad.t + 1}/${sans.length} (fen: ${bad.fen}), game NOT emitted`
      )
      return
    }
    const result = VALID_RESULTS.has(g.result) ? g.result : '*'
    if (!VALID_RESULTS.has(g.result)) {
      report.push(`warn ${label}: result '${g.result}' not a PGN result: stored as '*'`)
    }
    games.push({
      id,
      white: String(g.white ?? '?'),
      black: String(g.black ?? '?'),
      event: String(g.event ?? '?'),
      year: Number(g.year) || 0,
      result,
      group: eraToGroup(p.era),
      significance: typeof g.significance === 'string' ? g.significance : undefined,
      pgnMoves: canonical.join(' ')
    })
    famousIdsByPersona[p.id].push(id)
    report.push(`ok   ${label}: ${canonical.length} plies, result ${result}`)
  })
}

// ---- 3. Persona catalog -----------------------------------------------------

const personas = research.map((p) => {
  // Clock personality for the bot time manager. Missing is fine (renderer falls
  // back to botTime's by-id map / 'steady'), but a typo should be caught here.
  if (p.timeStyle != null && !VALID_TIME_STYLES.has(p.timeStyle)) {
    report.push(`warn ${p.id}: timeStyle '${p.timeStyle}' not one of blitzer/steady/tanker, omitted`)
  }
  return {
    id: p.id,
    name: p.name,
    era: p.era ?? '',
    peakElo: p.peakElo,
    style: {
      aggression: p.style?.aggression ?? 0.5,
      risk: p.style?.risk ?? 0.5,
      prefersAttack: p.style?.prefersAttack ?? false,
      prefersSolid: p.style?.prefersSolid ?? false
    },
    bio: p.bio ?? '',
    title: p.title ?? null,
    country: p.country ?? null,
    years: p.years ?? null,
    peakYear: p.peakYear ?? null,
    modernElo: p.modernElo ?? null,
    modernEloNote: p.modernEloNote ?? null,
    styleDesc: p.styleDesc ?? null,
    famousGameIds: famousIdsByPersona[p.id] ?? [],
    // JSON.stringify drops undefined. Personas without a style ship none.
    timeStyle: VALID_TIME_STYLES.has(p.timeStyle) ? p.timeStyle : undefined
  }
})

// ---- Write outputs ----------------------------------------------------------

fs.mkdirSync(path.dirname(BOOKS_OUT), { recursive: true })
fs.mkdirSync(path.dirname(GAMES_OUT), { recursive: true })
fs.writeFileSync(BOOKS_OUT, JSON.stringify(books))
fs.writeFileSync(
  GAMES_OUT,
  JSON.stringify(
    {
      version: 1,
      note: 'GENERATED by scripts/build-persona-data.mjs from resources/personas/research.json. Do not hand-edit. Public-domain move records (SAN); ids are "<personaId>-gN", referenced by Persona.famousGameIds.',
      games
    },
    null,
    2
  )
)
fs.writeFileSync(
  PERSONAS_OUT,
  JSON.stringify(
    {
      version: 1,
      note: 'GENERATED by scripts/build-persona-data.mjs from research.json. Do not hand-edit; edit research.json and re-run. Photos merge at load time from photos.json.',
      personas
    },
    null,
    2
  )
)

// ---- Report -----------------------------------------------------------------

console.log('== build-persona-data validation report ==')
for (const r of report) console.log('  ' + r)

const bookPositions = Object.values(books).reduce((n, b) => n + Object.keys(b).length, 0)
console.log('')
console.log(`personas:        ${personas.length} -> ${path.relative(ROOT, PERSONAS_OUT)}`)
console.log(
  `book lines:      ${totalLines - lineFails}/${totalLines} valid (${lineFails} FAILED) | ${bookPositions} book positions -> ${path.relative(ROOT, BOOKS_OUT)}`
)
console.log(
  `famous games:    ${totalGames - gameFails}/${totalGames} valid (${gameFails} FAILED) -> ${path.relative(ROOT, GAMES_OUT)}`
)
if (lineFails + gameFails > 0) {
  console.log('\nFAILURES above must be fixed in research.json (content builder), then re-run.')
  process.exitCode = 1
}
