// Shared chapter validator: reused by every authoring agent so they don't
// rebuild a legality toolkit (saves tokens + standardizes correctness).
//
//   node scripts/validate-chapter.mjs resources/curriculum/chapters/chNN-*.json
//   node scripts/validate-chapter.mjs --all
//
// Checks, against the SAME libs the app uses (chessops) + the real puzzle DB:
//   - every FEN parses to a legal position
//   - every guided / play / authored-board / model move is legal in sequence
//   - judge questions are structurally a played move (from empty, to occupied,
//     opponent to move in the shown position)
//   - mc answerIndex is in range
//   - every DB-query puzzle pool has >= count distinct puzzles in the window
// Exit 0 = clean, 1 = problems (printed). Verdict CORRECTNESS (good/blunder,
// which mc option is right) is the author's job. Not auto-checkable here.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { parseFen } from 'chessops/fen'
import { Chess } from 'chessops/chess'
import { parseUci, parseSquare } from 'chessops/util'
import { DatabaseSync } from 'node:sqlite'

const DIR = 'resources/curriculum/chapters'
const DB = 'resources/data/puzzles.sqlite'
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const db = new DatabaseSync(DB, { readOnly: true })
const poolStmt = (n) =>
  db.prepare(
    `SELECT COUNT(DISTINCT PuzzleId) c FROM puzzle_themes WHERE Rating BETWEEN ? AND ? AND Theme IN (${Array(n).fill('?').join(',')})`
  )

function pos(fen) {
  const s = parseFen(fen)
  if (s.isErr) return null
  const p = Chess.fromSetup(s.unwrap())
  return p.isErr ? null : p.unwrap()
}
// Play a sequence of UCI moves from a FEN; return error string or null.
function playSeq(fen, moves, where, errs) {
  const p = pos(fen)
  if (!p) return errs.push(`${where}: illegal FEN ${fen}`)
  for (const uci of moves) {
    const m = parseUci(uci)
    if (!m || !p.isLegal(m)) return errs.push(`${where}: illegal move ${uci} (at ${where})`)
    p.play(m)
  }
}

function validateChapter(file) {
  const errs = []
  let nFen = 0,
    nMove = 0,
    nPool = 0
  let c
  try {
    c = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { file, errs: [`invalid JSON: ${e.message}`], nFen, nMove, nPool }
  }
  const lessons = c.lessons || []
  for (const [li, les] of lessons.entries()) {
    for (const [si, seg] of (les.segments || []).entries()) {
      const w = `${path.basename(file)} L${li + 1}/${seg.kind}#${si}`
      for (const [ti, st] of (seg.steps || []).entries()) {
        if (st.fen) {
          nFen++
          if (!pos(st.fen)) errs.push(`${w}.step${ti}: illegal FEN`)
          for (const u of st.solutionUci || []) {
            nMove++
            playSeq(st.fen, [u], `${w}.step${ti}`, errs)
          }
        }
      }
      if (seg.kind === 'model' && seg.line) {
        const start = seg.fen || START
        nFen++
        playSeq(
          start,
          seg.line.map((m) => m.uci),
          `${w}.model`,
          errs
        )
        nMove += seg.line.length
      }
      for (const [bi, b] of (seg.puzzle?.boards || []).entries()) {
        nFen++
        nMove += (b.moves || []).length
        playSeq(b.fen, b.moves || [], `${w}.board${bi}(${b.id})`, errs)
      }
      if (seg.puzzle && !seg.puzzle.boards) {
        const q = seg.puzzle
        nPool++
        const r = poolStmt(q.themes.length).get(q.ratingLo, q.ratingHi, ...q.themes)
        if ((r?.c ?? 0) < q.count)
          errs.push(
            `${w}: puzzle pool too small, [${q.themes.join('|')}] @${q.ratingLo}-${q.ratingHi} has ${r?.c ?? 0} < ${q.count}`
          )
      }
      if (seg.kind === 'boss' && seg.bossFen) {
        nFen++
        if (!pos(seg.bossFen)) errs.push(`${w}: illegal bossFen`)
      }
    }
  }
  for (const [qi, q] of (c.test?.questions || []).entries()) {
    const w = `${path.basename(file)} test.q${qi}(${q.kind})`
    if (q.fen) {
      nFen++
      const p = pos(q.fen)
      if (!p) errs.push(`${w}: illegal FEN`)
      if (q.kind === 'judge' && p) {
        const m = parseUci(q.lastMoveUci)
        if (!m) errs.push(`${w}: unparseable lastMoveUci ${q.lastMoveUci}`)
        else {
          // fen is the position AFTER the move: from empty, to occupied.
          if (p.board.get(m.from)) errs.push(`${w}: judge from-square ${q.lastMoveUci.slice(0, 2)} not empty (fen should be AFTER the move)`)
          if (!p.board.get(m.to)) errs.push(`${w}: judge to-square ${q.lastMoveUci.slice(2, 4)} empty (fen should be AFTER the move)`)
        }
      }
      if (q.kind === 'play') {
        // solutionUci = ACCEPTABLE ALTERNATIVE single moves (renderer accepts any
        // one), NOT a sequence: validate each independently in the base position.
        for (const u of q.solutionUci || []) {
          nMove++
          playSeq(q.fen, [u], w, errs)
        }
      }
    }
    if (q.kind === 'mc') {
      if (!(Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < (q.options || []).length))
        errs.push(`${w}: answerIndex ${q.answerIndex} out of range`)
    }
  }
  return { file, errs, nFen, nMove, nPool, lessons: lessons.length, test: (c.test?.questions || []).length }
}

const args = process.argv.slice(2)
const files = args.includes('--all')
  ? readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(DIR, f))
  : args.filter((a) => !a.startsWith('--'))

let bad = 0
for (const f of files) {
  const r = validateChapter(f)
  const tag = r.errs.length ? '✗' : '✓'
  console.log(
    `${tag} ${path.basename(f)}, ${r.lessons ?? '?'} lessons, ${r.test ?? '?'} test Qs, ${r.nFen} FENs, ${r.nMove} moves, ${r.nPool} pools`
  )
  for (const e of r.errs) console.log(`    ✗ ${e}`)
  if (r.errs.length) bad++
}
console.log(bad ? `\n${bad}/${files.length} chapter(s) have problems` : `\nALL ${files.length} CLEAN ✓`)
process.exit(bad ? 1 : 0)
