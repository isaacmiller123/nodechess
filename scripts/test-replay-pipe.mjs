// Headless test for the archive → replay data pipe
// (src/renderer/src/features/library/replayData.ts over src/shared/gameArchive.ts
// and the game registry).
//
//   node scripts/test-replay-pipe.mjs
//
// esbuild-bundles the replay module + registry for bare node (ffish WASM bytes
// injected via preloadFfish({ wasmBinary }) for the xiangqi leg). Coverage:
//   1. synthesized games across families (chessops variant, go w/ options +
//      handicap, othello, checkers, xiangqi): envelope-encode → parse →
//      buildReplay — every move replays legally (spec.play validates each
//      position), states/notation counts match the move count;
//   2. stored notation (meta.notated) is preferred verbatim; missing notation
//      falls back to spec.notate / codec echo;
//   3. the LEGACY generic tag format (onlineStore.genericArchive) parses and
//      replays, result token stripped;
//   4. corrupt archives: illegal move mid-list truncates to the legal prefix
//      (never throws), chess PGN text and junk parse to null;
//   5. turnAt honors spec.turn (go handicap → white opens) and parity fallback.
//
// Final line: 'ALL GREEN — N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
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
  ok(
    Object.is(actual, expected),
    `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`
  )
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'replay-pipe-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/features/library/replayData.ts'))}`,
    `export { encodeGameArchive, parseGameArchive } from ${JSON.stringify(resolve(ROOT, 'src/shared/gameArchive.ts'))}`,
    `export { getGame, isRegisteredGame } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/registry.ts'))}`,
    `export { preloadFfish } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffish.ts'))}`
  ].join('\n')
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['*?url'],
  loader: { '.css': 'empty' },
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
const {
  parseReplayArchive,
  buildReplay,
  notationFor,
  turnAt,
  encodeGameArchive,
  getGame,
  preloadFfish
} = mod

// ffish leg (xiangqi) needs the WASM bytes in bare node.
const wasm = readFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm'))
await preloadFfish({ wasmBinary: wasm })

/** Synthesize a legal N-ply game for a kind by always playing the FIRST legal
 *  move — every registered spec supports this without knowing its codec. */
function synthesize(spec, options, plies) {
  let s = spec.init(options)
  const start = s
  const moves = []
  for (let i = 0; i < plies; i++) {
    const legal = spec.legalMoves(s)
    if (legal.length === 0) break
    const mv = legal[0]
    const next = spec.play(s, mv)
    if (!next) throw new Error(`synthesize(${spec.kind}): spec rejected its own legal move ${mv}`)
    moves.push(mv)
    s = next
  }
  return { start, moves }
}

/** Envelope text the save path writes (result fixed — irrelevant to replay). */
function envelopeOf(kind, moves, meta) {
  return encodeGameArchive({
    v: 1,
    kind,
    moves,
    result: '1-0',
    ...(meta !== undefined ? { meta } : {})
  })
}

try {
  // ---- 1. envelope → parse → replay across families -------------------------
  console.log('envelope → replay across families')
  const legs = [
    { kind: 'atomic', options: undefined, plies: 10 },
    { kind: 'kingofthehill', options: undefined, plies: 8 },
    { kind: 'go', options: { size: 9, komi: 5.5 }, plies: 12 },
    { kind: 'othello', options: undefined, plies: 10 },
    { kind: 'checkers', options: undefined, plies: 8 },
    { kind: 'xiangqi', options: undefined, plies: 8 }
  ]
  for (const leg of legs) {
    const spec = getGame(leg.kind).spec
    const { moves } = synthesize(spec, leg.options, leg.plies)
    ok(moves.length > 0, `${leg.kind}: synthesized ${moves.length} plies`)
    const text = envelopeOf(leg.kind, moves, leg.options !== undefined ? { options: leg.options } : undefined)
    const parsed = parseReplayArchive(text, leg.kind)
    ok(parsed !== null && parsed.format === 'envelope', `${leg.kind}: envelope parses`)
    eq(parsed.kind, leg.kind, `${leg.kind}: kind round-trips`)
    const replay = buildReplay(spec, parsed)
    eq(replay.truncated, false, `${leg.kind}: full replay (no truncation)`)
    eq(replay.moves.length, moves.length, `${leg.kind}: every move replayed`)
    eq(replay.states.length, moves.length + 1, `${leg.kind}: one state per ply`)
    eq(replay.notated.length, moves.length, `${leg.kind}: notation aligns with moves`)
    ok(
      replay.notated.every((n) => typeof n === 'string' && n.length > 0),
      `${leg.kind}: every ply has non-empty notation`
    )
    // Each replayed position accepted the recorded move — additionally assert
    // the final state's own history matches (specs carry `moves`).
    const finalMoves = replay.states[replay.states.length - 1].moves
    eq(finalMoves.length, moves.length, `${leg.kind}: final state history length matches`)
  }

  // Chess-family notation is REAL notation (SAN-shaped, not the raw codec):
  const atomicSpec = getGame('atomic').spec
  const { moves: atomicMoves } = synthesize(atomicSpec, undefined, 6)
  const atomicReplay = buildReplay(atomicSpec, parseReplayArchive(envelopeOf('atomic', atomicMoves)))
  ok(
    atomicReplay.notated.some((n, i) => n !== atomicMoves[i]),
    'atomic: notation differs from raw UCI (spec.notate active)'
  )

  // ---- 2. stored notation preferred / fallback -------------------------------
  console.log('meta.notated preference')
  const goSpec = getGame('go').spec
  const { moves: goMoves } = synthesize(goSpec, { size: 9 }, 4)
  const stored = goMoves.map((_, i) => `N${i}`)
  const withStored = buildReplay(
    goSpec,
    parseReplayArchive(envelopeOf('go', goMoves, { options: { size: 9 }, notated: stored }))
  )
  eq(withStored.notated.join(' '), stored.join(' '), 'aligned meta.notated used verbatim')
  const misaligned = buildReplay(
    goSpec,
    parseReplayArchive(envelopeOf('go', goMoves, { options: { size: 9 }, notated: ['x'] }))
  )
  eq(misaligned.notated.length, goMoves.length, 'misaligned meta.notated falls back to live notation')
  ok(misaligned.notated[0] !== 'x', 'fallback ignores the misaligned stored entry')

  // ---- 3. legacy generic tag format ------------------------------------------
  console.log('legacy generic archive')
  const legacyText = [
    '[Event "Online game"]',
    '[Site "nodechess"]',
    '[Date "2026.07.01"]',
    '[White "Alice"]',
    '[Black "Bob"]',
    '[Result "0-1"]',
    '[Variant "go"]',
    '',
    `${goMoves.join(' ')} 0-1`,
    ''
  ].join('\n')
  const legacy = parseReplayArchive(legacyText, 'go')
  ok(legacy !== null && legacy.format === 'legacy', 'legacy text parses')
  eq(legacy.kind, 'go', 'legacy kind from [Variant]')
  eq(legacy.moves.length, goMoves.length, 'legacy result token stripped from moves')
  eq(legacy.white, 'Alice', 'legacy White tag surfaced')
  eq(legacy.result, '0-1', 'legacy Result tag surfaced')
  // Legacy rows carry no options — the 19x19 default must still replay 9x9-legal
  // vertices (synthesized on 9x9, all inside 19x19).
  const legacyReplay = buildReplay(goSpec, legacy)
  eq(legacyReplay.truncated, false, 'legacy go game replays on default options')

  // ---- 4. corrupt archives degrade, never throw -------------------------------
  console.log('corruption handling')
  const badMoves = [...atomicMoves.slice(0, 3), 'a1a1', ...atomicMoves.slice(3)]
  const badReplay = buildReplay(atomicSpec, parseReplayArchive(envelopeOf('atomic', badMoves)))
  eq(badReplay.truncated, true, 'illegal move mid-list truncates')
  eq(badReplay.moves.length, 3, 'truncation keeps the legal prefix')
  eq(
    parseReplayArchive('[Event "x"]\n\n1. e4 e5 2. Nf3 *', 'chess'),
    null,
    'chess PGN (no Variant tag, chess kind) parses to null'
  )
  eq(parseReplayArchive('total junk', undefined), null, 'junk parses to null')
  eq(parseReplayArchive('{"v":99,"kind":"go","moves":[]}', 'go'), null, 'future envelope version rejected')

  // ---- 5. turn seam ------------------------------------------------------------
  console.log('turnAt')
  const goEven = goSpec.init({ size: 9 })
  eq(turnAt(goSpec, goEven, 0), 'black', 'go even game: black opens')
  const goHandi = goSpec.init({ size: 9, handicap: 2 })
  eq(turnAt(goSpec, goHandi, 0), 'white', 'go handicap ≥ 2: white opens (spec.turn)')
  const othSpec = getGame('othello').spec
  const othStart = othSpec.init()
  eq(turnAt(othSpec, othStart, 0), othSpec.players[0], 'parity fallback follows players[0]')
  eq(
    notationFor(othSpec, othStart, othSpec.legalMoves(othStart)[0]).length > 0,
    true,
    'notationFor never returns empty'
  )

  console.log(`\nALL GREEN — ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
}
