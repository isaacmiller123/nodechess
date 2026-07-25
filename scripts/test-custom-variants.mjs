// Headless test for the Variant Lab: custom-variant kernel module
// (src/renderer/src/games/customVariants.ts), the registry dynamic seam, and
// the editor's pure ini generator (features/games/editor/{model,templates}.ts).
//
//   node scripts/test-custom-variants.mjs
//
// Same harness pattern as test-ffish-games.mjs: esbuild-bundles the modules
// for bare node (Vite-only '?url' import stays external), feeds ffish.wasm
// bytes via preloadFfish({ wasmBinary }). Covers: the 7 templates load through
// the REAL engine (30-pawns legal-move sanity, amazon Q+N knight jumps +
// fool's-mate checkmate, atomic explosion, tiny 6x6, placement drops, grand),
// friendly errors for invalid ini, dynamic registry register/replace/
// unregister, model<->ini round-trips and the kernel contract.
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

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'custom-variants-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
writeFileSync(
  entry,
  `export * from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/customVariants.ts'))}\n` +
    `export { preloadFfish, isFfishReady, getFfish } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/ffish.ts'))}\n` +
    `export { getGame, isRegisteredGame, listGames, listDynamicGames } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/games/registry.ts'))}\n` +
    `export * as model from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/features/games/editor/model.ts'))}\n` +
    `export { TEMPLATES, templateById } from ${JSON.stringify(resolve(ROOT, 'src/renderer/src/features/games/editor/templates.ts'))}\n`
)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  external: ['*?url'],
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const wasmCopy = resolve(tmp, 'ffish.wasm')
copyFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm'), wasmCopy)

const mod = await import(pathToFileURL(outfile).href)
const {
  preloadFfish,
  validateCustomVariantIni,
  registerCustomVariant,
  unregisterCustomVariant,
  customKindOf,
  parseIniHead,
  getGame,
  isRegisteredGame,
  listGames,
  listDynamicGames,
  model,
  TEMPLATES,
  templateById
} = mod

const iniOf = (tplId) => model.generateIni(templateById(tplId).model)
const defOf = (tplId, id) => {
  const tpl = templateById(tplId)
  return {
    id,
    name: tpl.model.name,
    description: tpl.model.description,
    iniText: model.generateIni(tpl.model),
    boardFiles: tpl.model.files,
    boardRanks: tpl.model.ranks
  }
}

try {
  // ---- pure model layer -------------------------------------------------------
  console.log('model (pure)')
  eq(model.classicBackRank(8).join(''), 'rnbqkbnr', 'classicBackRank(8) is the classic order')
  eq(model.classicBackRank(6).join(''), 'rnqknr', 'classicBackRank(6) is Los Alamos')
  const big = model.classicArmies(12, 10)
  const bigFen = model.boardToFenBody(big, 12, 10)
  ok(bigFen.split('/').length === 10, 'boardToFenBody: 10 ranks emitted for a 12x10 board')
  ok(bigFen.includes('12'), 'boardToFenBody: multi-digit empty runs (12) emitted')
  const reparsed = model.parseFenBoard(bigFen, 12, 10)
  ok(
    reparsed !== null && model.boardToFenBody(reparsed, 12, 10) === bigFen,
    'parseFenBoard round-trips multi-digit FEN bodies'
  )
  eq(model.parseFenBoard('8/8/8', 8, 8), null, 'parseFenBoard rejects wrong rank counts')

  const std = templateById('standard').model
  ok(model.startFenOf(std).includes(' w KQkq - 0 1'), 'standard start: full castling rights derived')
  const noCastle = { ...std, castling: false }
  ok(model.startFenOf(noCastle).includes(' w - - 0 1'), 'castling off: rights collapse to -')

  eq(TEMPLATES.length, 7, 'seven templates ship')
  for (const tpl of TEMPLATES) {
    const ini = model.generateIni(tpl.model)
    const head = parseIniHead(ini)
    ok(
      head !== null && head.hasKeys && head.parent === tpl.model.parent,
      `template ${tpl.id}: ini has a keyed [name:${tpl.model.parent}] section`
    )
    const rebuilt = model.modelFromIni(ini, {
      name: tpl.model.name,
      description: tpl.model.description,
      files: tpl.model.files,
      ranks: tpl.model.ranks
    })
    ok(rebuilt !== null && rebuilt.exact, `template ${tpl.id}: generated ini round-trips exactly`)
    ok(
      model.generateIni(rebuilt.model) === ini,
      `template ${tpl.id}: model → ini → model → ini is a fixed point`
    )
  }

  // ---- engine validation ------------------------------------------------------
  console.log('engine validation')
  await preloadFfish({ wasmBinary: readFileSync(wasmCopy) })
  ok(true, 'ffish preloaded from wasm bytes')

  // 30 pawns army
  const armyIni = iniOf('pawn-army')
  const armyFenLine = /startFen = (.*)/.exec(armyIni)[1]
  eq((armyFenLine.split(' ')[0].match(/P/g) || []).length, 30, '30 Pawns Army: exactly thirty white pawns')
  ok(armyFenLine.split(' ')[0].includes('K'), '30 Pawns Army: white king present')
  const armyCheck = validateCustomVariantIni(armyIni)
  ok(armyCheck.ok, '30 Pawns Army: ini loads through the engine')
  ok(
    armyCheck.moveCount >= 5 && armyCheck.moveCount <= 40,
    `30 Pawns Army: legal move count sane (${armyCheck.moveCount})`
  )

  const stdCheck = validateCustomVariantIni(iniOf('standard'))
  ok(stdCheck.ok && stdCheck.moveCount === 20, 'Standard template: exactly 20 legal first moves')

  const tinyCheck = validateCustomVariantIni(iniOf('tiny'))
  ok(tinyCheck.ok && tinyCheck.moveCount === 10, 'Tiny 6x6: Los Alamos start has 10 legal moves')

  const grandCheck = validateCustomVariantIni(iniOf('grand'))
  ok(grandCheck.ok && grandCheck.moveCount >= 40, `Grand 10x10: loads with a big move list (${grandCheck.moveCount})`)

  const setupCheck = validateCustomVariantIni(iniOf('setup'))
  ok(setupCheck.ok && setupCheck.startFen.includes('['), 'Setup Chess: placement pockets in the start FEN')

  // ---- friendly errors ----------------------------------------------------------
  console.log('friendly errors')
  const empty = validateCustomVariantIni('   ')
  ok(!empty.ok && /empty/i.test(empty.error), 'empty ini → friendly "empty" error')
  const noSection = validateCustomVariantIni('maxRank = 9\n')
  ok(!noSection.ok && /\[variant\] section/i.test(noSection.error), 'missing section header → friendly error')
  const emptyBody = validateCustomVariantIni('[foo:chess]\n# just a comment\n')
  ok(!emptyBody.ok && /no rule lines/i.test(emptyBody.error), 'keyless section → friendly error (engine-crash guard)')
  const badParent = validateCustomVariantIni('[foo:doesnotexist]\nstartFen = 4k3/8/8/8/8/8/8/4K3 w - - 0 1\n')
  ok(!badParent.ok && /parent/i.test(badParent.error), 'unknown parent → friendly error naming the parent')
  const bigBoard = validateCustomVariantIni('[foo:chess]\nmaxFile = 20\n')
  ok(!bigBoard.ok && /out of range/i.test(bigBoard.error), 'maxFile beyond engine limits → friendly range error')
  const noMoves = validateCustomVariantIni(
    '[foo:chess]\nstartFen = k7/2Q5/8/8/8/8/8/K7 b - - 0 1\n'
  )
  ok(!noMoves.ok && /no legal moves/i.test(noMoves.error), 'stalemated start position → friendly zero-moves error')

  // ---- amazon: Q+N behavior end to end -----------------------------------------
  console.log('amazon (Q+N)')
  const amazonEntry = await registerCustomVariant(defOf('amazon', 'amazon-test'))
  const asp = amazonEntry.spec
  eq(asp.kind, 'custom-amazon-test', 'amazon: dynamic kind is custom-<id>')
  eq(asp.family, 'chess', 'amazon: chess family')
  const lone = asp.init({ fen: '4k3/8/8/8/3A4/8/8/4K3 w - - 0 1' })
  const loneMoves = asp.legalMoves(lone)
  for (const jump of ['d4e6', 'd4c6', 'd4b5', 'd4f5']) {
    ok(loneMoves.includes(jump), `amazon: knight-jump ${jump} is legal`)
  }
  ok(loneMoves.includes('d4d8') && loneMoves.includes('d4h8'), 'amazon: queen slides are legal too')
  // The fool's mate REFUTATION is the signature Q+N proof: after ...Ah4+ the
  // only legal reply is white's own amazon knight-JUMPING from d1 to f2 to
  // block. A move no queen could make.
  let ag = asp.init()
  for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    const next = asp.play(ag, m)
    ok(next !== null, `amazon fool's-mate line: ${m} accepted`)
    ag = next
  }
  ok(asp.result(ag) === null, "amazon: fool's mate is NOT mate here (the defense exists)")
  eq(asp.legalMoves(ag).join(' '), 'd1f2', 'amazon: the only defense is the amazon knight-jump block d1f2')
  // Terminal result: a clean back-rank mate delivered by the amazon.
  const brStart = asp.init({ fen: '6k1/5ppp/8/8/8/8/8/4A2K w - - 0 1' })
  const brEnd = asp.play(brStart, 'e1e8')
  ok(brEnd !== null, 'amazon back-rank: Ae8 plays')
  const ares = asp.result(brEnd)
  ok(
    ares !== null && ares.score === '1-0' && ares.winner === 'white' && ares.reason === 'checkmate',
    'amazon back-rank: white wins by checkmate'
  )
  eq(asp.legalMoves(brEnd).length, 0, 'amazon: no legal moves after mate')

  // ---- nuke: atomic explosion ----------------------------------------------------
  console.log('nuke (atomic parent)')
  const nukeEntry = await registerCustomVariant(defOf('nuke', 'nuke-test'))
  const nsp = nukeEntry.spec
  let ng = nsp.init()
  const nukeMeta = nsp.moveMeta(
    (ng = nsp.play(nsp.play(ng, 'e2e4'), 'd7d5')),
    'e4d5'
  )
  ok(nukeMeta.capture === true, 'nuke: exd5 is a capture')
  ng = nsp.play(ng, 'e4d5')
  ok(ng !== null, 'nuke: exd5 plays')
  ok(
    ng.fen.startsWith('rnbqkbnr/ppp1pppp/8/8/8/8/PPPP1PPP/RNBQKBNR'),
    'nuke: BOTH pawns vanish. The capture exploded'
  )

  // ---- setup: placement drops -----------------------------------------------------
  console.log('setup (placement parent)')
  const setupEntry = await registerCustomVariant(defOf('setup', 'setup-test'))
  const ssp = setupEntry.spec
  const sg = ssp.init()
  const sMoves = ssp.legalMoves(sg)
  ok(sMoves.length === 40 && sMoves.every((m) => m.includes('@')), 'setup: start phase is 40 drops')
  const dropped = ssp.play(sg, 'K@e1')
  ok(dropped !== null && dropped.moves.at(-1) === 'K@e1', 'setup: king drop plays verbatim')

  // ---- tiny 6x6 board shape --------------------------------------------------------
  const tinyEntry = await registerCustomVariant(defOf('tiny', 'tiny-test'))
  ok(
    tinyEntry.spec.board.files === 6 && tinyEntry.spec.board.ranks === 6,
    'tiny: spec board is 6x6'
  )
  eq(tinyEntry.spec.legalMoves(tinyEntry.spec.init()).length, 10, 'tiny: 10 legal moves at start')

  // ---- registry dynamic seam --------------------------------------------------------
  console.log('registry dynamic seam')
  const kind = customKindOf('amazon-test')
  ok(isRegisteredGame(kind), 'dynamic kind resolves via isRegisteredGame')
  ok(getGame(kind) === amazonEntry, 'getGame falls back to the dynamic map')
  ok(getGame('chess') !== undefined, 'static registry untouched (chess still resolves)')
  ok(!listGames().some((e) => e.spec.kind === kind), 'listGames stays static-only')
  ok(listDynamicGames().some((e) => e.spec.kind === kind), 'listDynamicGames exposes the entry')
  eq(amazonEntry.botProviderId, 'fairy-stockfish', 'dynamic entries carry the fairy-stockfish bot id')
  ok(amazonEntry.requiresPreload === true, 'dynamic entries require preload')

  // re-registration replaces the live rules (fresh runtime variant each time)
  const v2 = defOf('standard', 'amazon-test')
  v2.iniText = v2.iniText.replace(
    /startFen = .*/,
    'startFen = rnbqkbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKBNR w KQkq - 0 1'
  )
  const replaced = await registerCustomVariant(v2)
  ok(getGame(kind) === replaced, 'same-id re-registration replaces the entry')
  ok(
    replaced.spec.init().fen.includes('PPPPPPP1'),
    're-registration takes rule edits (fresh runtime variant name)'
  )
  unregisterCustomVariant('amazon-test')
  ok(!isRegisteredGame(kind) && getGame(kind) === undefined, 'unregister removes the dynamic entry')

  // ---- kernel contract ---------------------------------------------------------------
  console.log('kernel contract')
  const base = nsp.init()
  nsp.play(base, 'e2e4')
  eq(base.moves.length, 0, 'play() never mutates the input state')
  eq(nsp.play(base, 'zzzz'), null, 'garbage move → null')
  eq(nsp.play(base, 'e2e5'), null, 'illegal move → null')
  eq(nsp.serializeOptions({ fen: 'x' }), '{"fen":"x"}', 'serializeOptions is stable JSON')
  let fenErr = null
  try {
    nsp.init({ fen: 'garbage' })
  } catch (err) {
    fenErr = err
  }
  ok(fenErr instanceof Error && /invalid/i.test(fenErr.message), 'init with a bad FEN throws a clear error')

  console.log(`\nALL GREEN: ${passed} assertions`)
} catch (err) {
  console.error(`\n${err.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
