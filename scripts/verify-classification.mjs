// Classification verification harness (REVIEW-SPEC scenarios).
//
//   node scripts/verify-classification.mjs
//
// Bundles src/main/analysis/accuracy.ts with esbuild (pure module; chessops only)
// and runs curated scenarios through classifyBadge, asserting the chess.com-model
// labels: Best vs Brilliant vs Great, Miss, Book/Forced priority, band thresholds,
// mate-transition table, and the blunder caps. Exit 1 on any mismatch.
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'clsver-'))
const out = path.join(dir, 'accuracy.mjs')
execSync(
  `npx esbuild src/main/analysis/accuracy.ts --bundle --platform=node --format=esm --outfile=${out}`,
  { stdio: 'pipe' }
)
const A = await import(pathToFileURL(out).href)

// Quiet reference position (after 1.e4 e5 2.Nf3): many legal moves, nothing hanging.
const QUIET = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'
// White to move, quiet: initial position.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
// Forced: Black king a8, White Kc6 + Rb1. The ONLY legal move is Ka8-a7.
const FORCED = 'k7/8/2K5/8/8/8/8/1R6 b - - 0 1'
// Brilliant stage: Re1-e8 offers the rook to Rf8 (attacked, undefended), pretend
// the engine says it is best and still winning (back-rank ideas).
const SAC_BEFORE = '5rk1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1'
const SAC_AFTER = '4Rrk1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1'
// Hung-queen grab: Rd1xd5 wins a queen; the rook is NOT attacked afterwards.
const GRAB_BEFORE = '6k1/8/8/3q4/8/8/8/3R2K1 w - - 0 1'
const GRAB_AFTER = '6k1/8/8/3R4/8/8/8/6K1 b - - 0 1'
// After 2...Nc6 in the Ruy order. A real openings-book position for inBook=true.
const cp = (v) => ({ cp: v, mate: null })
const mate = (n) => ({ cp: null, mate: n })
const fenAfterOf = (fen, uci) => {
  // tiny helper via the bundled chessops re-exports is overkill; scenarios that
  // need a real fenAfter provide it explicitly.
  return fen
}

/** Base input: quiet best-ish move Ng1f3 from the start position. */
function base(over = {}) {
  return {
    fenBefore: START,
    fenAfter: QUIET, // only board-tested for Brilliant/Great gates; quiet is safe
    playedUci: 'g1f3',
    playedSan: 'Nf3',
    isBest: false,
    bestEval: cp(30),
    playedEval: cp(30),
    secondEval: cp(10),
    inBook: false,
    prevOppFinalBadge: null,
    ...over
  }
}

const CASES = [
  ['Best: played the engine move', base({ isBest: true }), 'Best'],
  ['Book: theory move, checked before Best', base({ isBest: true, inBook: true }), 'Book'],
  ['Forced: only one legal move', base({ fenBefore: FORCED, playedUci: 'a8a7', playedSan: 'Ka7', bestEval: cp(-500), playedEval: cp(-500) }), 'Forced'],
  [
    'Brilliant: best-move rook offer, holding, not already crushing',
    base({
      fenBefore: SAC_BEFORE,
      fenAfter: SAC_AFTER,
      playedUci: 'e1e8',
      playedSan: 'Re8',
      isBest: true,
      bestEval: cp(450),
      playedEval: cp(450),
      secondEval: cp(40)
    }),
    'Brilliant'
  ],
  [
    'Brilliant: rook sac that FORCES mate (second line merely equal)',
    base({
      fenBefore: SAC_BEFORE,
      fenAfter: SAC_AFTER,
      playedUci: 'e1e8',
      playedSan: 'Re8',
      isBest: true,
      bestEval: mate(4),
      playedEval: mate(4),
      secondEval: cp(50)
    }),
    'Brilliant'
  ],
  [
    'NOT Brilliant when BOTH lines force mate (mating anyway)',
    base({
      fenBefore: SAC_BEFORE,
      fenAfter: SAC_AFTER,
      playedUci: 'e1e8',
      playedSan: 'Re8',
      isBest: true,
      bestEval: mate(4),
      playedEval: mate(4),
      secondEval: mate(6)
    }),
    'Best'
  ],
  [
    'NOT Brilliant when the 2nd line is also crushing (winning anyways)',
    base({
      fenBefore: SAC_BEFORE,
      fenAfter: SAC_AFTER,
      playedUci: 'e1e8',
      playedSan: 'Re8',
      isBest: true,
      bestEval: cp(900),
      playedEval: cp(900),
      secondEval: cp(750)
    }),
    'Best'
  ],
  [
    'NOT Brilliant: taking a hung queen (nothing sacrificed)',
    base({
      fenBefore: GRAB_BEFORE,
      fenAfter: GRAB_AFTER,
      playedUci: 'd1d5',
      playedSan: 'Rxd5',
      isBest: true,
      bestEval: cp(850),
      playedEval: cp(850),
      secondEval: cp(-100)
    }),
    'Best'
  ],
  [
    'Great: only good move that punishes the opponent blunder',
    base({
      isBest: true,
      bestEval: cp(200),
      playedEval: cp(200),
      secondEval: cp(-160), // ~ -13 win pts vs +9: gap >> 12
      prevOppFinalBadge: 'Blunder'
    }),
    'Great'
  ],
  [
    'NOT Great without a preceding opponent blunder',
    base({ isBest: true, bestEval: cp(200), playedEval: cp(200), secondEval: cp(-160) }),
    'Best'
  ],
  [
    'Miss: forced mate available, played a still-equal move',
    base({ bestEval: mate(3), playedEval: cp(50), secondEval: null }),
    'Miss'
  ],
  [
    'Blunder, not Miss, when the move also collapses the position',
    base({ bestEval: mate(3), playedEval: cp(-400), secondEval: null }),
    'Blunder'
  ],
  ['Excellent: tiny slip (~1.8 win pts)', base({ bestEval: cp(0), playedEval: cp(-20) }), 'Excellent'],
  ['Good: small slip (~4.1 win pts)', base({ bestEval: cp(0), playedEval: cp(-45) }), 'Good'],
  ['Inaccuracy: ~5.5 win pts', base({ bestEval: cp(0), playedEval: cp(-60) }), 'Inaccuracy'],
  ['Mistake: ~10.9 win pts', base({ bestEval: cp(0), playedEval: cp(-120) }), 'Mistake'],
  ['Blunder: ~28 win pts', base({ bestEval: cp(0), playedEval: cp(-350) }), 'Blunder'],
  [
    'Mate table: had mate, now getting mated -> Blunder',
    base({ bestEval: mate(2), playedEval: mate(-3) }),
    'Blunder'
  ],
  [
    'Mate table: allowed a mate from a cp position -> Blunder',
    base({ bestEval: cp(100), playedEval: mate(-1) }),
    'Blunder'
  ],
  [
    'Blunder cap C1: still completely winning after the "blunder" -> Good',
    base({ bestEval: cp(2500), playedEval: cp(800) }), // 100 -> ~90.6 win, drop > 20 but capped? 800cp = 90.5 >= 90
    'Good'
  ]
]

let bad = 0
console.log('case'.padEnd(62), 'expected'.padEnd(11), 'got')
for (const [name, input, expected] of CASES) {
  let got
  try {
    got = A.classifyBadge(input).badge
  } catch (e) {
    got = `ERROR: ${e.message}`
  }
  const ok = got === expected
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} ${name}`.padEnd(62), String(expected).padEnd(11), got)
}
console.log(bad ? `\n${bad}/${CASES.length} FAILED` : `\nALL ${CASES.length} PASS`)
process.exit(bad ? 1 : 0)
