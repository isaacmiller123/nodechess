// Known-strength engine-vs-engine GAME GENERATION machinery, extracted
// verbatim (refactor-lite) from scripts/gen-elo-corpus.mjs so the judge-config
// corpus harness (scripts/gen-judge-corpus.mjs) reuses the exact same games
// pipeline without drift. Behavior is IDENTICAL to the original in-file code;
// the former module constants (MOVETIME, MAX_PLIES, BOOK_PLIES) became opts.
//
//  - bands >= NATIVE_FLOOR (1320): native UCI_LimitStrength/UCI_Elo, go
//    movetime (the app's 1320+ bot path);
//  - bands < 1320: the production sub-floor pick model (scripts/lib/
//    weak-model.mjs: mirror of engine.ipc.ts), full-strength engine, short
//    MultiPV depth search + softmax/blunder pick;
//  - random 6-ply "book" opening (uniform among depth-8 candidates within
//    60cp of best) via a full-strength opening engine;
//  - self/cross1/cross2 pairing schedule with edge-band self-play bonus.

import { Chess } from 'chessops'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { weakDepth, weakMultiPv, pickWeakMove } from './weak-model.mjs'

/** Native UCI_LimitStrength floor: below this the weak pick model plays. */
export const NATIVE_FLOOR = 1320

/** Default random-opening length (plies). */
export const BOOK_PLIES = 6

/** Configure a player engine for its band before a game. */
export async function configurePlayer(eng, elo) {
  if (elo >= NATIVE_FLOOR) {
    eng.setOption('UCI_LimitStrength', 'true')
    eng.setOption('UCI_Elo', elo)
  } else {
    // Weak path plays FULL-strength short searches; the pick model weakens choice.
    eng.setOption('UCI_LimitStrength', 'false')
    eng.setOption('Skill Level', 20)
  }
  eng.send('ucinewgame')
  await eng.ready()
}

/** One player move; returns { uci, cp } with cp side-to-move POV (clamped). */
export async function playerMove(eng, elo, fen, fullmove, movetime) {
  if (elo >= NATIVE_FLOOR) {
    const { move, cp } = await eng.bestMove(fen, { movetime })
    return { uci: move, cp }
  }
  const { cands, best } = await eng.searchMultiPv(fen, weakDepth(elo), weakMultiPv(elo))
  if (best === '(none)' || !best) return { uci: null, cp: 0 }
  const uci = cands.length ? pickWeakMove(cands, elo, fullmove, false) : best
  const cp = cands.find((c) => c.uci === uci)?.cp ?? cands[0]?.cp ?? 0
  return { uci, cp }
}

/** Random-but-sane opening: uniform among candidates within 60cp of best (depth 8). */
export async function randomOpening(eng, pos, plies) {
  const out = []
  for (let i = 0; i < plies; i++) {
    const fen = makeFen(pos.toSetup())
    const { lines } = await eng.analyze(fen, 8, 6)
    const cands = [...lines.values()]
      .filter((l) => l.pv.length > 0)
      .map((l) => ({ uci: l.pv[0], cp: l.mate != null ? (l.mate > 0 ? 10000 : -10000) : l.cp }))
    if (cands.length === 0) break
    const best = Math.max(...cands.map((c) => c.cp))
    const ok = cands.filter((c) => best - c.cp <= 60)
    const pick = ok[Math.floor(Math.random() * ok.length)]
    const mv = parseUci(pick.uci)
    if (!mv || !pos.isLegal(mv)) break
    const fenBefore = fen
    pos.play(mv)
    out.push({ uci: pick.uci, fenBefore, fenAfter: makeFen(pos.toSetup()), mateDelivered: false })
  }
  return out
}

/**
 * Plays one game whiteElo vs blackElo. Returns { plies, resultWhite, ending }
 * with resultWhite in {1, 0.5, 0} and ending one of
 * mate|stalemate|draw|50move|adjudicated|plycap.
 * `openingEng` is any full-strength engine with .analyze() (the random book).
 * opts: { movetime, maxPlies, bookPlies }.
 */
export async function playGame(whiteEng, blackEng, openingEng, whiteElo, blackElo, opts) {
  const { movetime, maxPlies, bookPlies = BOOK_PLIES } = opts
  await configurePlayer(whiteEng, whiteElo)
  await configurePlayer(blackEng, blackElo)

  const pos = Chess.default()
  const plies = await randomOpening(openingEng, pos, bookPlies)

  let hopelessStreak = 0
  let hopelessSign = 0
  let lastWhiteCp = 0

  while (plies.length < maxPlies) {
    if (pos.isEnd()) break
    if (pos.halfmoves >= 100) return { plies, resultWhite: 0.5, ending: '50move' }
    const fen = makeFen(pos.toSetup())
    const whiteToMove = pos.turn === 'white'
    const [eng, elo] = whiteToMove ? [whiteEng, whiteElo] : [blackEng, blackElo]
    const { uci, cp } = await playerMove(eng, elo, fen, pos.fullmoves, movetime)
    if (!uci || uci === '(none)') break

    // Adjudication bookkeeping (white-POV eval from the mover's own search).
    const whiteCp = whiteToMove ? cp : -cp
    lastWhiteCp = whiteCp
    const sign = whiteCp > 0 ? 1 : -1
    if (Math.abs(whiteCp) >= 800 && (hopelessSign === 0 || sign === hopelessSign)) {
      hopelessStreak++
      hopelessSign = sign
    } else {
      hopelessStreak = 0
      hopelessSign = 0
    }

    const mv = parseUci(uci)
    if (!mv || !pos.isLegal(mv)) throw new Error(`illegal move ${uci} in ${fen}`)
    pos.play(mv)
    plies.push({
      uci,
      fenBefore: fen,
      fenAfter: makeFen(pos.toSetup()),
      mateDelivered: pos.isCheckmate()
    })

    if (hopelessStreak >= 6) {
      return { plies, resultWhite: hopelessSign > 0 ? 1 : 0, ending: 'adjudicated' }
    }
  }

  const outcome = pos.outcome()
  if (outcome && outcome.winner) {
    return { plies, resultWhite: outcome.winner === 'white' ? 1 : 0, ending: 'mate' }
  }
  if (pos.isEnd()) return { plies, resultWhite: 0.5, ending: 'stalemate' }
  // Ply cap: score by the last seen eval.
  const resultWhite = lastWhiteCp >= 250 ? 1 : lastWhiteCp <= -250 ? 0 : 0.5
  return { plies, resultWhite, ending: 'plycap' }
}

/**
 * Pairing schedule: self-play per band (+2 games at the edge bands) plus
 * cross-pairings at +/-1 and +/-2 ladder steps, shuffled so partial runs still
 * cover all bands roughly evenly.
 */
export function buildSchedule(bands, selfGames, cross1Games, cross2Games) {
  const games = []
  for (let i = 0; i < bands.length; i++) {
    // Edge bands get 2 extra self-play games (they have fewer cross partners).
    const bonus = i === 0 || i === bands.length - 1 ? 2 : 0
    for (let g = 0; g < selfGames + bonus; g++) games.push([bands[i], bands[i]])
    if (i + 1 < bands.length) {
      for (let g = 0; g < cross1Games; g++) {
        games.push(g % 2 === 0 ? [bands[i], bands[i + 1]] : [bands[i + 1], bands[i]])
      }
    }
    if (i + 2 < bands.length) {
      for (let g = 0; g < cross2Games; g++) {
        games.push(g % 2 === 0 ? [bands[i], bands[i + 2]] : [bands[i + 2], bands[i]])
      }
    }
  }
  // Shuffle so partial runs still cover all bands roughly evenly.
  for (let i = games.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[games[i], games[j]] = [games[j], games[i]]
  }
  return games
}
