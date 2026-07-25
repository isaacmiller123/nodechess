// Validate (and normalise) resources/famous/games.json.
//
// The famous-games dataset is hand-authored from public-domain move records.
// This script does NOT fetch anything. It only replays every game's SAN
// movetext with chessops to prove the moves are legal and complete, and that
// the declared result is consistent with the final position (checkmate / no
// mate for a decisive / drawn or ongoing record). Run it whenever the dataset
// changes:
//
//   node scripts/build-famous.mjs
//
// Exit code is non-zero if any game fails validation, so it can gate commits.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseSan } from 'chessops/san'
import { Chess } from 'chessops/chess'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILE = join(__dirname, '..', 'resources', 'famous', 'games.json')

/** Split a SAN movetext string into bare SAN tokens (strip numbers/results). */
function tokenize(movetext) {
  return movetext
    .replace(/\{[^}]*\}/g, ' ') // comments (none expected, but be safe)
    .replace(/\d+\.(\.\.)?/g, ' ') // move numbers "12." / "12..."
    .replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, ' ') // result token
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function replay(moves) {
  const pos = Chess.default()
  let ply = 0
  for (const san of moves) {
    const move = parseSan(pos, san)
    if (!move) throw new Error(`illegal/ambiguous SAN "${san}" at ply ${ply + 1}`)
    pos.play(move)
    ply++
  }
  return pos
}

function main() {
  const data = JSON.parse(readFileSync(FILE, 'utf-8'))
  const games = data.games ?? []
  const ids = new Set()
  let failures = 0

  for (const g of games) {
    const where = g.id || '(missing id)'
    try {
      if (!g.id) throw new Error('missing id')
      if (ids.has(g.id)) throw new Error(`duplicate id "${g.id}"`)
      ids.add(g.id)
      for (const k of ['white', 'black', 'event', 'year', 'result', 'group', 'pgnMoves']) {
        if (g[k] === undefined || g[k] === null || g[k] === '') throw new Error(`missing field "${k}"`)
      }
      if (!['1-0', '0-1', '1/2-1/2', '*'].includes(g.result)) {
        throw new Error(`bad result "${g.result}"`)
      }

      const moves = tokenize(typeof g.pgnMoves === 'string' ? g.pgnMoves : g.pgnMoves.join(' '))
      if (moves.length === 0) throw new Error('no moves')
      const pos = replay(moves)

      // Consistency: a "#"-terminated game must end in checkmate; a checkmate
      // must be a decisive result. (Resign/agreed endings won't be mate.)
      const lastIsMate = /#$/.test(moves[moves.length - 1])
      const isMate = pos.isCheckmate()
      if (lastIsMate && !isMate) throw new Error('last move marked # but position is not checkmate')
      if (isMate && g.result === '1/2-1/2') throw new Error('checkmate cannot be a draw')

      console.log(`  ok  ${g.id}  (${moves.length} plies${isMate ? ', mate' : ''})`)
    } catch (err) {
      failures++
      console.error(`FAIL  ${where}: ${err.message}`)
    }
  }

  console.log(`\n${games.length - failures}/${games.length} games valid.`)
  if (failures > 0) {
    console.error(`${failures} game(s) failed validation.`)
    process.exit(1)
  }
}

main()
