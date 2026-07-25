// Headless test for the UCI ↔ chessgroundx key boundary
// (src/renderer/src/games/boards/cgKeys.ts + the ChessFamilyBoard move codec).
//
// chessgroundx Key ranks are SINGLE characters. Rank 10 is ':' (key 'a:'),
// 11..16 are ';' '<' '=' '>' '?' '@', while kernel/ffish UCI spells the same
// square 'a10'. Casting UCI squares to cg.Key broke every rank-10 lookup:
// xiangqi/janggi BLACK back-rank pieces had no dests (unmovable) and board
// handling of engine moves touching rank 10 failed. This suite pins:
//
//   uciSquareToKey / keyToUciSquare   goldens + full a1..p16 round-trip
//   parseMove / destsOf / lastMoveOf  (ChessFamilyBoard exports) rank-10
//                                     goldens incl. drops + promo suffixes
//   xiangqi + janggi via ffish        after one opening move, the black
//                                     rank-10 origins appear in the dests map
//                                     under their cg keys ('a:' …), the
//                                     after-handler candidate filter finds the
//                                     kernel move from cg (orig, dest), and a
//                                     two-digit engine-style reply round-trips
//                                     through spec.play + lastMoveOf.
//
//   node scripts/test-cg-keys.mjs
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- tiny assert kit --------------------------------------------------------
let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}
function eqArr(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'cg-keys-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export { uciSquareToKey, keyToUciSquare } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/boards/cgKeys.ts'))}\n` +
    `export { parseMove, destsOf, lastMoveOf } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/boards/ChessFamilyBoard.tsx'))}\n` +
    `export { FFISH_VARIANT_SPECS } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffishVariants.ts'))}\n` +
    `export { preloadFfish } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffish.ts'))}\n`
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  external: ['*?url'],
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const wasmCopy = resolve(tmp, 'ffish.wasm')
copyFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm'), wasmCopy)

const mod = await import(pathToFileURL(outfile).href)
const { uciSquareToKey, keyToUciSquare, parseMove, destsOf, lastMoveOf, FFISH_VARIANT_SPECS, preloadFfish } = mod

try {
  // ---- codec goldens ---------------------------------------------------------
  console.log('cgKeys codec goldens')
  eq(uciSquareToKey('a1'), 'a1', "a1 → 'a1' (single-digit ranks unchanged)")
  eq(uciSquareToKey('e5'), 'e5', "e5 → 'e5'")
  eq(uciSquareToKey('a9'), 'a9', "a9 → 'a9'")
  eq(uciSquareToKey('a10'), 'a:', "a10 → 'a:' (rank 10 is ':')")
  eq(uciSquareToKey('b10'), 'b:', "b10 → 'b:'")
  eq(uciSquareToKey('i10'), 'i:', "i10 → 'i:' (xiangqi/janggi far corner)")
  eq(uciSquareToKey('l10'), 'l:', "l10 → 'l:' (fairy-sf largeboard max)")
  eq(uciSquareToKey('a11'), 'a;', "a11 → 'a;'")
  eq(uciSquareToKey('a16'), 'a@', "a16 → 'a@'")
  eq(uciSquareToKey('p16'), 'p@', "p16 → 'p@' (chessgroundx max)")
  for (const bad of ['a0', 'a17', 'q1', 'a1a2', '', 'P@a1', '10a']) {
    eq(uciSquareToKey(bad), null, `${JSON.stringify(bad)} → null (out of range / not a square)`)
  }
  eq(keyToUciSquare('a:'), 'a10', "'a:' → a10")
  eq(keyToUciSquare('i:'), 'i10', "'i:' → i10")
  eq(keyToUciSquare('e5'), 'e5', "'e5' → e5")
  eq(keyToUciSquare('p@'), 'p16', "'p@' → p16")
  {
    let trips = 0
    for (let f = 0; f < 16; f++) {
      for (let r = 1; r <= 16; r++) {
        const sq = `${String.fromCharCode(97 + f)}${r}`
        const key = uciSquareToKey(sq)
        if (key !== null && keyToUciSquare(key) === sq && (r < 10 ? key === sq : key !== sq)) trips++
      }
    }
    eq(trips, 256, 'full a1..p16 round-trip (keys differ from UCI exactly on ranks 10+)')
  }

  // ---- ChessFamilyBoard move codec --------------------------------------------
  console.log('ChessFamilyBoard parseMove / destsOf / lastMoveOf')
  eqArr(parseMove('a10a8'), { orig: 'a:', dest: 'a8', suffix: '' }, "parseMove('a10a8') → orig 'a:' dest 'a8'")
  eqArr(parseMove('a1a10'), { orig: 'a1', dest: 'a:', suffix: '' }, "parseMove('a1a10') → dest 'a:'")
  eqArr(parseMove('h1g3'), { orig: 'h1', dest: 'g3', suffix: '' }, "parseMove('h1g3') plain move")
  eqArr(parseMove('e7e8q'), { orig: 'e7', dest: 'e8', suffix: 'q' }, "parseMove('e7e8q') promotion suffix")
  eqArr(parseMove('d4c3+'), { orig: 'd4', dest: 'c3', suffix: '+' }, "parseMove('d4c3+') shogi promote suffix")
  eqArr(parseMove('c4b3m'), { orig: 'c4', dest: 'b3', suffix: 'm' }, "parseMove('c4b3m') makruk met suffix")
  eqArr(parseMove('P@c1'), { orig: 'P@', dest: 'c1', suffix: '' }, "parseMove('P@c1') drop")
  eqArr(parseMove('R@e10'), { orig: 'R@', dest: 'e:', suffix: '' }, "parseMove('R@e10') drop dest on rank 10 → 'e:'")
  eq(parseMove('xyz'), null, "parseMove('xyz') → null")
  eq(parseMove('a17a1'), null, "parseMove('a17a1') → null (rank out of range)")
  eqArr(lastMoveOf(['h3f3', 'a10a8']), ['a:', 'a8'], 'lastMoveOf rank-10 move → cg keys')
  eqArr(lastMoveOf(['R@e10']), ['e:'], 'lastMoveOf rank-10 drop → [dest key]')
  eq(lastMoveOf(['e9e9']), undefined, 'lastMoveOf janggi pass (same square) → undefined')
  {
    const d = destsOf(['a10a9', 'a10a8', 'h3f3', 'P@e10'])
    eqArr(d.get('a:'), ['a9', 'a8'], "destsOf groups rank-10 origin under 'a:'")
    eqArr(d.get('h3'), ['f3'], 'destsOf plain origin unchanged')
    eqArr(d.get('P@'), ['e:'], "destsOf drop origin 'P@' → rank-10 dest key")
    ok([...d.keys()].every((k) => !k.includes('10')), 'no raw two-digit UCI squares leak into the dests map')
  }

  // ---- live xiangqi/janggi dests through ffish --------------------------------
  console.log('xiangqi: black back-rank pieces get dests (the user-facing bug)')
  await preloadFfish({ wasmBinary: readFileSync(wasmCopy) })
  const xq = FFISH_VARIANT_SPECS['xiangqi']
  const s0 = xq.init()
  const s1 = xq.play(s0, 'h3f3') // one red move → black to move
  ok(s1 !== null, 'red opening move h3f3 accepted')
  const legal = xq.legalMoves(s1)
  ok(legal.includes('a10a9') && legal.includes('b10c8'), 'ffish emits two-digit rank-10 UCI (a10a9, b10c8)')
  const dests = destsOf(legal)
  ok((dests.get('a:') ?? []).includes('a9'), "black chariot a10: dests under key 'a:' include a9")
  ok((dests.get('b:') ?? []).includes('c8'), "black horse b10: dests under key 'b:' include c8")
  ok((dests.get('i:') ?? []).includes('i9'), "black chariot i10: dests under key 'i:' include i9")
  {
    const rank10Origins = [...dests.keys()].filter((k) => k.length === 2 && k[1] === ':')
    ok(rank10Origins.length >= 3, `black back rank contributes ≥3 origins (got ${rank10Origins.length})`)
    ok([...dests.keys()].every((k) => k.length === 2 || k.endsWith('@')), 'every dests origin is a 2-char cg key or a drop orig')
  }
  // after-handler simulation: chessground hands back cg keys; the candidate
  // filter must find the kernel move and spec.play must accept it.
  const candidates = legal.filter((m) => {
    const p = parseMove(m)
    return p !== null && p.orig === 'a:' && p.dest === 'a9'
  })
  eqArr(candidates, ['a10a9'], "after('a:','a9') candidate filter finds kernel move a10a9")
  const s2 = xq.play(s1, candidates[0])
  ok(s2 !== null, 'candidate move accepted by spec.play')
  eqArr(lastMoveOf(s2.moves), ['a:', 'a9'], 'lastMove highlight for the rank-10 move uses cg keys')

  console.log('janggi: engine-style two-digit reply renders through the codec')
  const jg = FFISH_VARIANT_SPECS['janggi']
  const j1 = jg.play(jg.init(), 'h1i3')
  ok(j1 !== null, 'janggi white opening h1i3 accepted')
  const jLegal = jg.legalMoves(j1)
  ok(jLegal.includes('a10a8'), 'janggi black has a10a8')
  ok((destsOf(jLegal).get('a:') ?? []).includes('a8'), "janggi dests: key 'a:' includes a8")
  const j2 = jg.play(j1, 'a10a8') // ffish/fairy-sf bot reply shape
  ok(j2 !== null, 'two-digit engine reply a10a8 accepted by spec.play')
  eqArr(lastMoveOf(j2.moves), ['a:', 'a8'], 'janggi lastMove for engine reply → cg keys')

  console.log(`\nALL GREEN: ${passed} assertions`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
