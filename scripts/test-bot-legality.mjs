// Bot-legality sweep: hunts EVERY source of "The bot/engine offered an
// illegal move" toasts (KernelBot.tsx applyMove / VariantBot.tsx applyMove:
// a bot/engine move that spec.play rejects).
//
//   node scripts/test-bot-legality.mjs [inprocess|engine]
//
// Part A (in-process providers; exactly the KernelBot flow):
//   for every kind with an in-process provider (checkers, checkers-intl,
//   othello, connect4, hex, morris, tictactoe, gomoku) play 6 full bot-vs-bot
//   games (L1vL5, L5vL1, L3vL3 x2, L2vL4, L4vL2; capped plies), asking the
//   games/bots.ts provider for each move and applying it through spec.play.
//   Assert spec.play NEVER returns null on a bot offer, and that a live
//   position never has zero legal moves (which would hang KernelBot).
//
// Part B (engine-backed kinds; the engine:playVariant boundary):
//   spawn the LOCAL fairy-stockfish (resources/engine/mac/fairy-stockfish),
//   mirror src/main/ipc/engine.ipc.ts option mapping (UCI_Variant per kind,
//   UCI_Chess960 for chess960, UCI_LimitStrength + UCI_Elo per level,
//   `position fen <state.fen>` + `go movetime 100`) and play 2 quick games per
//   kind (L1vL5, L3vL3), applying every bestmove via spec.play. Also asserts
//   each kernel FEN passes the ipc's VARIANT_FEN_RE schema (a reject there is
//   the "engine failed to move" toast). Catches codec drift: castling
//   e1h1/e1g1, promotion suffixes ('m', '+'), janggi pass, crazyhouse drops.
//
// ENDURANCE mode (BOT_ENDURANCE=1 node scripts/test-bot-legality.mjs):
//   the deep, slow sweep: NOT run in CI (the default sweep above is
//   unchanged). Adds on top of the default Part A/B:
//   - In-process kinds: 10 games each (the 6 CI pairings + L1vL1, L5vL5,
//     L2vL5, L5vL2), same legality asserts; checkers capture-chain depths are
//     tracked and reported.
//   - Engine kinds: ALL 14 chess-family kinds (the 13 fairy kinds + standard
//     chess through the engine:play Stockfish path, including the sub-1320
//     weak-model pick mirrored from scripts/lib/weak-model.mjs). 6 games per
//     kind, ply cap 120, mixed levels incl. L5, ALTERNATING which color the
//     engine plays (engine as BLACK in games 1/3/5: rank-10-heavy replies in
//     xiangqi/janggi); the other color is a seeded random-legal mover standing
//     in for the human. Every engine offer goes through the EXACT ipc option
//     sequence and is applied via spec.play, VariantBot-style; movetime is
//     reduced to 60ms to keep ~84 engine games inside a few minutes.
//   - Hard coverage asserts: xiangqi/janggi engine-as-black games must produce
//     rank-10 engine offers; crazyhouse must produce engine drops; every
//     placement game must produce engine drop-phase offers.
//   - Targeted codec probes: chess960 castling BOTH wings (scripted standard
//     lines + crafted RK5R/R5KR shredder-FEN starts; kernel KxR form AND the
//     engine's standard e1g1 form must apply; engine replies from post-castle
//     FENs must apply) and makruk promotion ('m' suffix, both a kernel-side
//     white and black promotion and engine offers around them).
//
// Failures are COLLECTED (not fail-fast) and printed with full repro (kind,
// game, ply, fen/state, move, history). Final line: 'ALL GREEN: <counts>'.
// Exit 0 = green.

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pickWeakMove, weakDepth, weakMultiPv } from './lib/weak-model.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const MODE = process.argv[2] ?? 'all' // 'inprocess' | 'engine' | 'all'
const ENDURANCE = process.env.BOT_ENDURANCE === '1'

// ---- deterministic RNG (Math.random is monkey-patched per game) --------------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- failure ledger -----------------------------------------------------------
const failures = []
function fail(msg) {
  failures.push(msg)
  console.log(`  ✗ ${msg}`)
}

// ---- bundle the games tree ----------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'bot-legality-'))
const entry = resolve(tmp, 'entry.mjs')
const outfile = resolve(tmp, 'bundle.mjs')
const GAMES = resolve(ROOT, 'src/renderer/src/games')
writeFileSync(
  entry,
  [
    `export { resolveBotProvider, BotUnavailableError } from ${JSON.stringify(resolve(GAMES, 'bots.ts'))}`,
    `export { getGame } from ${JSON.stringify(resolve(GAMES, 'registry.ts'))}`,
    `export { preloadFfish } from ${JSON.stringify(resolve(GAMES, 'ffish.ts'))}`,
    // chessops fen for the engine:play safeFen parity check (endurance mode)
    `export { parseFen, makeFen } from 'chessops/fen'`
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
  nodePaths: [resolve(ROOT, 'node_modules')], // entry sits in tmpdir. Resolve bare imports from the repo
  alias: { '@shared': resolve(ROOT, 'src/shared'), '@': resolve(ROOT, 'src/renderer/src') },
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(outfile).href)
rmSync(tmp, { recursive: true, force: true })
const { resolveBotProvider, getGame, preloadFfish, parseFen, makeFen } = mod
const specOf = (kind) => getGame(kind).spec

const gamesPlayed = new Map() // kind -> games completed
const bump = (kind) => gamesPlayed.set(kind, (gamesPlayed.get(kind) ?? 0) + 1)

// One line of state context small enough to paste into a repro.
function describeState(kind, state) {
  if (typeof state.fen === 'string') return state.fen
  return `moves=[${state.moves.join(' ')}]`
}

// =================================================================================
// Part A, in-process providers (KernelBot flow: provider.move -> spec.play)
// =================================================================================

const PAIRINGS = [
  [1, 5],
  [5, 1],
  [3, 3],
  [3, 3],
  [2, 4],
  [4, 2]
]
// Endurance: 4 extra pairings per kind (10 games). Mirrored extremes stress
// deep checkers-intl captures and morris mill storms at max search level.
const PAIRINGS_ENDURANCE = [...PAIRINGS, [1, 1], [5, 5], [2, 5], [5, 2]]

// kind -> ply cap (cap reached = adjudicated draw, still a valid legality game)
const IN_PROCESS = {
  checkers: 300,
  'checkers-intl': 300,
  othello: 200,
  connect4: 60,
  hex: 130,
  morris: 400,
  tictactoe: 12,
  gomoku: 260
}

// endurance stats: kind -> { maxChain } (checkers capture-chain depth)
const chainStats = new Map()

async function playInProcessGame(kind, pairing, seed) {
  const spec = specOf(kind)
  const provider = resolveBotProvider(kind)
  const cap = IN_PROCESS[kind]
  const origRandom = Math.random
  Math.random = mulberry32(seed)
  try {
    let state = spec.init()
    for (let ply = 0; ply < cap; ply++) {
      if (spec.result(state) !== null) break
      const legal = spec.legalMoves(state)
      if (legal.length === 0) {
        // KernelBot's bot effect never fires on legal.length === 0. A live
        // position with no moves is a hang, so it must be terminal.
        fail(`${kind} [${pairing.join('v')} seed ${seed}] ply ${ply}: live position has ZERO legal moves (KernelBot hang) at ${describeState(kind, state)}`)
        break
      }
      // KernelBot: turn = spec.players[moves.length % 2]
      const level = pairing[state.moves.length % 2]
      let mv
      try {
        mv = await provider.move(state, level)
      } catch (e) {
        fail(`${kind} [${pairing.join('v')} seed ${seed}] ply ${ply} L${level}: provider threw '${e.message}' at ${describeState(kind, state)}`)
        break
      }
      const next = spec.play(state, mv)
      if (!next) {
        fail(`${kind} [${pairing.join('v')} seed ${seed}] ply ${ply} L${level}: ILLEGAL BOT OFFER '${mv}' (legal: ${legal.slice(0, 12).join(',')}${legal.length > 12 ? ',…' : ''}) at ${describeState(kind, state)}`)
        break
      }
      if (kind.startsWith('checkers') && mv.includes('x')) {
        const chain = mv.split('x').length - 1
        const s = chainStats.get(kind) ?? { maxChain: 0 }
        if (chain > s.maxChain) s.maxChain = chain
        chainStats.set(kind, s)
      }
      state = next
    }
    bump(kind)
  } finally {
    Math.random = origRandom
  }
}

if (MODE !== 'engine') {
  const pairingsA = ENDURANCE ? PAIRINGS_ENDURANCE : PAIRINGS
  console.log(`Part A: in-process bot-vs-bot sweep (KernelBot flow${ENDURANCE ? ', ENDURANCE' : ''})`)
  for (const kind of Object.keys(IN_PROCESS)) {
    process.stdout.write(`  ${kind}: `)
    const t0 = Date.now()
    for (let g = 0; g < pairingsA.length; g++) {
      await playInProcessGame(kind, pairingsA[g], 0xb07 + g * 7919 + kind.length * 131)
      process.stdout.write('.')
    }
    const chain = chainStats.get(kind)
    console.log(
      ` ${gamesPlayed.get(kind)} games (${((Date.now() - t0) / 1000).toFixed(1)}s)${chain ? ` maxChain=${chain.maxChain}` : ''}`
    )
  }
}

// =================================================================================
// Part B: engine boundary (mirrors src/main/ipc/engine.ipc.ts playVariant)
// =================================================================================

// engine.ipc.ts FAIRY_UCI_VARIANT (kind -> UCI_Variant; chess960 = chess + 960)
const FAIRY_UCI_VARIANT = {
  chess960: 'chess',
  crazyhouse: 'crazyhouse',
  atomic: 'atomic',
  antichess: 'antichess',
  kingofthehill: 'kingofthehill',
  threecheck: '3check',
  horde: 'horde',
  racingkings: 'racingkings',
  xiangqi: 'xiangqi',
  shogi: 'shogi',
  janggi: 'janggi',
  makruk: 'makruk',
  placement: 'placement'
}
// engine.ipc.ts FAIRY_LEVELS elo column
const FAIRY_ELO = [600, 1000, 1400, 1850, 2300]
// engine.ipc.ts playVariantSchema fen guard. A kernel FEN failing this is the
// "engine failed to move" toast (ipc reject), so assert it per position.
const VARIANT_FEN_RE = /^[A-Za-z0-9/\[\]+~.\- ]{1,160}$/

const ENGINE_PAIRINGS = [
  [1, 5],
  [3, 3]
]
const ENGINE_PLY_CAP = 120

// ---- minimal line-oriented UCI driver (same shape as probe-fairy-sf.mjs) -------
function makeUciClient(bin) {
  const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const waiters = []
  const taps = new Set() // non-consuming line observers (multipv info capture)
  proc.stdout.setEncoding('utf-8')
  proc.stdout.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      for (const tap of taps) tap(line)
      for (let i = 0; i < waiters.length; i++) {
        const v = waiters[i].test(line)
        if (v !== undefined) {
          const [w] = waiters.splice(i, 1)
          w.resolve(v)
          break
        }
      }
    }
  })
  const send = (cmd) => proc.stdin.write(cmd + '\n')
  const waitFor = (test, timeoutMs = 15000, label = 'line') =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeoutMs)
      waiters.push({
        test,
        resolve: (v) => {
          clearTimeout(timer)
          res(v)
        }
      })
    })
  const expectToken = (cmd, token) => {
    const p = waitFor((l) => (l.startsWith(token) ? l : undefined), 15000, token)
    send(cmd)
    return p
  }
  const bestmove = (goCmd) => {
    const p = waitFor((l) => (l.startsWith('bestmove') ? l.split(/\s+/)[1] : undefined), 20000, 'bestmove')
    send(goCmd)
    return p
  }
  // engine.ipc.ts collectCandidates parity: run `go`, keep the LATEST info line
  // per multipv index (pv[0] + side-to-move cp bounded ±1000, mate → ±1000),
  // resolve on bestmove. Used by the endurance chess weak-model path.
  const bestmoveWithInfo = (goCmd) => {
    const lines = new Map()
    const tap = (l) => {
      if (!l.startsWith('info')) return
      const pv = /\bpv (\S+)/.exec(l)
      if (!pv) return
      const idx = Number((/\bmultipv (\d+)/.exec(l) ?? [])[1] ?? 1)
      const score = /\bscore (cp|mate) (-?\d+)/.exec(l)
      const cp = !score
        ? 0
        : score[1] === 'mate'
          ? Number(score[2]) > 0
            ? 1000
            : -1000
          : Math.max(-1000, Math.min(1000, Number(score[2])))
      lines.set(idx, { uci: pv[1], cp })
    }
    taps.add(tap)
    const p = waitFor((l) => (l.startsWith('bestmove') ? l.split(/\s+/)[1] : undefined), 30000, 'bestmove')
    send(goCmd)
    return p
      .then((best) => ({ best, lines }))
      .finally(() => taps.delete(tap))
  }
  const quit = () => {
    send('quit')
    proc.stdin.end()
  }
  return { send, waitFor, expectToken, bestmove, bestmoveWithInfo, quit }
}

if (MODE !== 'inprocess') {
  const BIN = resolve(ROOT, 'resources/engine/mac/fairy-stockfish')
  if (!existsSync(BIN)) {
    console.error(`fairy-stockfish binary not found: ${BIN}`)
    process.exit(1)
  }
  console.log(`Part B: engine boundary sweep (fairy-stockfish, ${ENDURANCE ? 'ENDURANCE' : 'movetime 100'})`)

  // ffish kinds need the WASM rules loaded (spec.preload path in VariantBot).
  await preloadFfish({ wasmBinary: readFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm')) })

  const fairy = makeUciClient(BIN)
  await fairy.expectToken('uci', 'uciok')
  fairy.send('setoption name Threads value 1')
  fairy.send('setoption name Hash value 64')
  await fairy.expectToken('isready', 'readyok')

  // FairyPool.get(variant, chess960): re-target + ucinewgame per request.
  async function fairyTarget(kind) {
    fairy.send(`setoption name UCI_Variant value ${FAIRY_UCI_VARIANT[kind]}`)
    fairy.send(`setoption name UCI_Chess960 value ${kind === 'chess960'}`)
    fairy.send('ucinewgame')
    await fairy.expectToken('isready', 'readyok')
  }

  // engine.ipc playVariant: strength options, position by bare fen, movetime.
  // (UciEngine.search also pins MultiPV 1 for bestMove: mirrored here.)
  function fairyOffer(kind, fen, level, movetime) {
    fairy.send('setoption name MultiPV value 1')
    fairy.send('setoption name UCI_LimitStrength value true')
    fairy.send(`setoption name UCI_Elo value ${FAIRY_ELO[level - 1]}`)
    fairy.send(`position fen ${fen}`)
    return fairy.bestmove(`go movetime ${movetime}`)
  }

  async function playEngineGame(kind, pairing, gameIdx) {
    const spec = specOf(kind)
    await fairyTarget(kind)

    let state = spec.init(kind === 'chess960' ? { positionNumber: gameIdx === 0 ? 300 : 777 } : undefined)
    for (let ply = 0; ply < ENGINE_PLY_CAP; ply++) {
      if (spec.result(state) !== null) break
      const legal = spec.legalMoves(state)
      if (legal.length === 0) {
        fail(`${kind} [engine ${pairing.join('v')} g${gameIdx}] ply ${ply}: live position has ZERO legal moves at ${state.fen}`)
        break
      }
      if (!VARIANT_FEN_RE.test(state.fen)) {
        fail(`${kind} [engine ${pairing.join('v')} g${gameIdx}] ply ${ply}: kernel fen FAILS ipc VARIANT_FEN_RE (engine:playVariant would reject): '${state.fen}'`)
        break
      }
      // VariantBot turn: fen field 1 ('b' = black), else move parity.
      const fenTurn = state.fen.split(' ')[1]
      const level = pairing[fenTurn === 'b' ? 1 : 0]
      fairy.send('setoption name UCI_LimitStrength value true')
      fairy.send(`setoption name UCI_Elo value ${FAIRY_ELO[level - 1]}`)
      fairy.send(`position fen ${state.fen}`)
      let bm
      try {
        bm = await fairy.bestmove('go movetime 100')
      } catch (e) {
        fail(`${kind} [engine ${pairing.join('v')} g${gameIdx}] ply ${ply}: ${e.message} at ${state.fen}`)
        break
      }
      if (!bm || bm === '(none)' || bm === '0000') {
        // games/bots.ts assertPlayableMove throws on these -> "engine failed
        // to move" toast. Only OK if the spec ALSO thinks the game is over.
        fail(`${kind} [engine ${pairing.join('v')} g${gameIdx}] ply ${ply}: engine returned '${bm}' on a LIVE kernel position (${legal.length} legal: ${legal.slice(0, 8).join(',')}) at ${state.fen}`)
        break
      }
      const next = spec.play(state, bm)
      if (!next) {
        fail(`${kind} [engine ${pairing.join('v')} g${gameIdx}] ply ${ply}: ILLEGAL ENGINE OFFER '${bm}' (legal: ${legal.slice(0, 12).join(',')}${legal.length > 12 ? ',…' : ''}) at ${state.fen}`)
        break
      }
      state = next
    }
    bump(kind)
  }

  if (!ENDURANCE) {
    for (const kind of Object.keys(FAIRY_UCI_VARIANT)) {
      process.stdout.write(`  ${kind}: `)
      const t0 = Date.now()
      for (let g = 0; g < ENGINE_PAIRINGS.length; g++) {
        await playEngineGame(kind, ENGINE_PAIRINGS[g], g)
        process.stdout.write('.')
      }
      console.log(` ${gamesPlayed.get(kind)} games (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    }
  } else {
    // ===========================================================================
    // ENDURANCE engine sweep: all 14 chess-family kinds, 6 games each, mixed
    // levels incl. L5, alternating engine color vs a seeded random-legal mover.
    // ===========================================================================
    const SF_BIN = resolve(ROOT, 'resources/engine/mac/stockfish')
    if (!existsSync(SF_BIN)) {
      console.error(`stockfish binary not found: ${SF_BIN}`)
      process.exit(1)
    }
    const sf = makeUciClient(SF_BIN)
    await sf.expectToken('uci', 'uciok')
    sf.send('setoption name Threads value 1')
    sf.send('setoption name Hash value 64')
    await sf.expectToken('isready', 'readyok')

    // games/bots.ts CHESS_LEVEL_ELO / CHESS_LEVEL_MOVETIME (stockfishProvider)
    const CHESS_LEVEL_ELO = [600, 1000, 1400, 1850, 2300]
    const CHESS_LEVEL_MOVETIME = [150, 250, 350, 500, 700]
    const ENGINE_ELO_FLOOR = 1320 // shared/types.ts
    // Engine level per game g (L5 twice; once each color) + engine color:
    // engine plays WHITE in even games, BLACK in odd games.
    const END_LEVELS = [5, 5, 3, 1, 2, 4]
    const END_MOVETIME = 60 // reduced from FAIRY_LEVELS movetimes: 84 games must stay snappy
    const C960_POS = [300, 777, 42, 518, 111, 899]
    const ENGINE_KINDS = ['chess', ...Object.keys(FAIRY_UCI_VARIANT)]

    // per-kind offer stats (reported at the end; some are hard-asserted)
    const stats = new Map()
    const statOf = (kind) => {
      let s = stats.get(kind)
      if (!s) {
        s = { offers: 0, drops: 0, promos: 0, castles: 0, rank10Black: 0, blackGames: 0 }
        stats.set(kind, s)
      }
      return s
    }

    // engine:play parity (engine.ipc.ts): weak-model pick below the 1320 floor
    // (full-strength MultiPV depth search + scripts/lib/weak-model.mjs pick),
    // native UCI_LimitStrength/UCI_Elo + movetime at/above it.
    async function chessOffer(fen, level) {
      const elo = CHESS_LEVEL_ELO[level - 1]
      if (elo < ENGINE_ELO_FLOOR) {
        sf.send('setoption name UCI_LimitStrength value false')
        sf.send('setoption name Skill Level value 20')
        sf.send(`setoption name MultiPV value ${weakMultiPv(elo)}`)
        sf.send(`position fen ${fen}`)
        const { best, lines } = await sf.bestmoveWithInfo(`go depth ${weakDepth(elo)}`)
        const cands = [...lines.values()].filter((c) => c.uci)
        if (cands.length === 0) return best
        cands.sort((a, b) => b.cp - a.cp)
        const fullmove = Number(fen.split(' ')[5])
        return pickWeakMove(cands, elo, Number.isFinite(fullmove) && fullmove >= 1 ? fullmove : 1, false)
      }
      sf.send('setoption name MultiPV value 1')
      sf.send('setoption name UCI_LimitStrength value true')
      sf.send(`setoption name UCI_Elo value ${elo}`)
      sf.send(`position fen ${fen}`)
      return sf.bestmove(`go movetime ${Math.min(END_MOVETIME, CHESS_LEVEL_MOVETIME[level - 1])}`)
    }

    async function playEnduranceGame(kind, g) {
      const spec = specOf(kind)
      const engineWhite = g % 2 === 0
      const level = END_LEVELS[g]
      const rng = mulberry32(0xe4d + g * 104729 + kind.length * 337)
      const st = statOf(kind)
      if (!engineWhite) st.blackGames++
      const tag = `${kind} [endurance g${g} L${level} engine=${engineWhite ? 'white' : 'black'}]`
      if (kind === 'chess') {
        sf.send('ucinewgame')
        await sf.expectToken('isready', 'readyok')
      } else {
        await fairyTarget(kind)
      }
      let gameDrops = 0
      let state = spec.init(kind === 'chess960' ? { positionNumber: C960_POS[g] } : undefined)
      for (let ply = 0; ply < ENGINE_PLY_CAP; ply++) {
        if (spec.result(state) !== null) break
        const legal = spec.legalMoves(state)
        if (legal.length === 0) {
          fail(`${tag} ply ${ply}: live position has ZERO legal moves at ${state.fen} history=[${state.moves.join(' ')}]`)
          break
        }
        const whiteToMove = state.fen.split(' ')[1] !== 'b'
        if (whiteToMove !== engineWhite) {
          // The "human": a seeded random pick from the spec's OWN legal list.
          // A reject here is a spec self-consistency bug. Fail loudly too.
          const mv = legal[Math.floor(rng() * legal.length)]
          const next = spec.play(state, mv)
          if (!next) {
            fail(`${tag} ply ${ply}: spec REJECTED its own enumerated legal move '${mv}' at ${state.fen} history=[${state.moves.join(' ')}]`)
            break
          }
          state = next
          continue
        }
        // ENGINE OFFER: exact ipc request path per kind.
        let mv
        try {
          if (kind === 'chess') {
            // engine:play safeFen: chessops parse + re-serialize; a parse error
            // here is the "engine failed to move" toast.
            const setup = parseFen(state.fen)
            if (setup.isErr) {
              fail(`${tag} ply ${ply}: kernel fen FAILS engine:play safeFen (chessops parse): '${state.fen}' history=[${state.moves.join(' ')}]`)
              break
            }
            mv = await chessOffer(makeFen(setup.value), level)
          } else {
            if (!VARIANT_FEN_RE.test(state.fen)) {
              fail(`${tag} ply ${ply}: kernel fen FAILS ipc VARIANT_FEN_RE: '${state.fen}' history=[${state.moves.join(' ')}]`)
              break
            }
            mv = await fairyOffer(kind, state.fen, level, END_MOVETIME)
          }
        } catch (e) {
          fail(`${tag} ply ${ply}: ${e.message} at ${state.fen}`)
          break
        }
        if (!mv || mv === '(none)' || mv === '0000') {
          fail(`${tag} ply ${ply}: engine returned '${mv}' on a LIVE kernel position (${legal.length} legal: ${legal.slice(0, 8).join(',')}) at ${state.fen} history=[${state.moves.join(' ')}]`)
          break
        }
        st.offers++
        if (mv.includes('@')) {
          st.drops++
          gameDrops++
        }
        if (!engineWhite && mv.includes('10')) st.rank10Black++
        const meta = spec.moveMeta(state, mv)
        if (meta.sound === 'promote') st.promos++
        if (meta.sound === 'castle') st.castles++
        const next = spec.play(state, mv)
        if (!next) {
          fail(`${tag} ply ${ply}: ILLEGAL ENGINE OFFER '${mv}' (legal: ${legal.slice(0, 12).join(',')}${legal.length > 12 ? ',…' : ''}) at ${state.fen} history=[${state.moves.join(' ')}]`)
          break
        }
        state = next
      }
      // Placement: the whole 16-ply drop phase runs first, so the engine's side
      // of it MUST have produced drop offers in every game.
      if (kind === 'placement' && gameDrops === 0) {
        fail(`${tag}: no engine drop offers in the placement drop phase (history=[${state.moves.join(' ')}])`)
      }
      bump(kind)
    }

    for (const kind of ENGINE_KINDS) {
      process.stdout.write(`  ${kind}: `)
      const t0 = Date.now()
      for (let g = 0; g < END_LEVELS.length; g++) {
        await playEnduranceGame(kind, g)
        process.stdout.write('.')
      }
      const s = statOf(kind)
      console.log(
        ` ${gamesPlayed.get(kind)} games (${((Date.now() - t0) / 1000).toFixed(1)}s) offers=${s.offers} drops=${s.drops} promos=${s.promos} castles=${s.castles} rank10Black=${s.rank10Black}`
      )
    }

    // ---- coverage asserts (the bug class that shipped: engine-as-black rank-10) --
    for (const kind of ['xiangqi', 'janggi']) {
      const s = statOf(kind)
      if (s.rank10Black === 0) {
        fail(`${kind}: engine played BLACK in ${s.blackGames} games but offered ZERO rank-10 moves, rank-10 replies not exercised`)
      }
    }
    if (statOf('crazyhouse').drops === 0) {
      fail(`crazyhouse: zero engine drop offers across 6 games. Drop codec not exercised`)
    }

    // ---- targeted probe: chess960 castling BOTH wings ---------------------------
    // Kernel canonical castling is king-takes-rook UCI; a non-960 engine (the
    // chess kind's Stockfish) emits standard e1g1: BOTH must apply. After the
    // kernel applies a castle, the post-castle FEN goes to Fairy-SF (960 mode)
    // and its reply must apply.
    console.log('  probe: chess960 castling (both wings, KxR + standard forms)')
    {
      const spec = specOf('chess960')
      const STD_FORM = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' }
      const CASES = [
        { name: '518-kingside', init: { positionNumber: 518 }, line: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f1c4', 'f8c5'] },
        { name: '518-queenside', init: { positionNumber: 518 }, line: ['d2d4', 'd7d5', 'b1c3', 'b8c6', 'c1f4', 'c8f5', 'd1d2', 'd8d7'] },
        { name: '960-RK5R', init: { fen: 'rk5r/pppppppp/8/8/8/8/PPPPPPPP/RK5R w HAha - 0 1' }, line: [] },
        { name: '960-R5KR', init: { fen: 'r5kr/pppppppp/8/8/8/8/PPPPPPPP/R5KR w HAha - 0 1' }, line: [] }
      ]
      await fairyTarget('chess960')
      let wingK = 0
      let wingQ = 0
      for (const c of CASES) {
        let s = spec.init(c.init)
        let broke = false
        for (const m of c.line) {
          const n = spec.play(s, m)
          if (!n) {
            fail(`castle probe ${c.name}: scripted move '${m}' rejected at ${s.fen}`)
            broke = true
            break
          }
          s = n
        }
        if (broke) continue
        const castles = spec.legalMoves(s).filter((m) => spec.moveMeta(s, m).sound === 'castle')
        if (castles.length === 0) {
          fail(`castle probe ${c.name}: no castling moves in legalMoves at ${s.fen}`)
          continue
        }
        for (const mv of castles) {
          const wing = mv.charCodeAt(2) >= mv.charCodeAt(0) ? 'K' : 'Q'
          const next = spec.play(s, mv)
          if (!next) {
            fail(`castle probe ${c.name}: kernel castle '${mv}' REJECTED by spec.play at ${s.fen}`)
            continue
          }
          if (wing === 'K') wingK++
          else wingQ++
          // Standard-form parity (what the chess kind's non-960 engine emits).
          const std = STD_FORM[mv]
          if (std && !spec.play(s, std)) {
            fail(`castle probe ${c.name}: standard-form castle '${std}' (engine notation for '${mv}') REJECTED at ${s.fen}`)
          }
          // Engine reply from the post-castle position must apply.
          if (spec.result(next) === null) {
            const reply = await fairyOffer('chess960', next.fen, 5, 80)
            if (!reply || reply === '(none)' || reply === '0000' || !spec.play(next, reply)) {
              fail(`castle probe ${c.name}: engine reply '${reply}' ILLEGAL after '${mv}' at ${next.fen}`)
            }
          }
        }
      }
      if (wingK === 0) fail('castle probe: KINGSIDE castling never exercised')
      if (wingQ === 0) fail('castle probe: QUEENSIDE castling never exercised')
    }

    // ---- targeted probe: makruk promotion ('m' suffix), both colors -------------
    console.log("  probe: makruk promotion ('m' suffix, kernel + engine)")
    {
      const spec = specOf('makruk')
      await fairyTarget('makruk')
      const FEN = '1r6/3k4/8/4P3/4p3/8/8/1R2K3 w - - 0 1' // validateFen === 1
      let s
      try {
        s = spec.init({ fen: FEN })
      } catch (e) {
        s = null
        fail(`makruk probe: spec.init rejected promo fen '${FEN}': ${e.message}`)
      }
      if (s) {
        // Kernel-side white promotion.
        if (!spec.legalMoves(s).includes('e5e6m')) {
          fail(`makruk probe: 'e5e6m' missing from legalMoves at ${s.fen} (got ${spec.legalMoves(s).join(',')})`)
        }
        const promoted = spec.play(s, 'e5e6m')
        if (!promoted) {
          fail(`makruk probe: kernel promotion 'e5e6m' REJECTED by spec.play at ${s.fen}`)
        } else {
          // Engine reply from the post-promotion position must apply.
          if (spec.result(promoted) === null) {
            const reply = await fairyOffer('makruk', promoted.fen, 5, 200)
            if (!reply || reply === '(none)' || reply === '0000' || !spec.play(promoted, reply)) {
              fail(`makruk probe: engine reply '${reply}' ILLEGAL after 'e5e6m' at ${promoted.fen}`)
            }
          }
        }
        // Engine offer from the PRE-promotion position must apply (and is very
        // likely the promotion itself at L5).
        const offer = await fairyOffer('makruk', s.fen, 5, 200)
        if (!offer || offer === '(none)' || offer === '0000' || !spec.play(s, offer)) {
          fail(`makruk probe: engine offer '${offer}' ILLEGAL at pre-promotion ${s.fen}`)
        }
        // Kernel-side BLACK promotion: sidestep the promoting square, then the
        // black e4 pawn promotes on rank 3 ('e4e3m').
        const s2 = spec.play(s, 'e1e2')
        if (s2) {
          if (!spec.legalMoves(s2).includes('e4e3m')) {
            fail(`makruk probe: black promotion 'e4e3m' missing from legalMoves at ${s2.fen}`)
          } else if (!spec.play(s2, 'e4e3m')) {
            fail(`makruk probe: black promotion 'e4e3m' REJECTED by spec.play at ${s2.fen}`)
          }
          // Engine as BLACK from the pre-promotion position must apply.
          const bOffer = await fairyOffer('makruk', s2.fen, 5, 200)
          if (!bOffer || bOffer === '(none)' || bOffer === '0000' || !spec.play(s2, bOffer)) {
            fail(`makruk probe: engine BLACK offer '${bOffer}' ILLEGAL at ${s2.fen}`)
          }
        }
      }
    }

    sf.quit()
  }

  fairy.quit()
}

// =================================================================================
// Report
// =================================================================================
const counts = [...gamesPlayed.entries()].map(([k, n]) => `${k}=${n}`).join(' ')
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURE(S):`)
  for (const f of failures) console.log(`  - ${f}`)
  console.log(`\ngames: ${counts}`)
  process.exit(1)
}
console.log(`\nALL GREEN, games: ${counts}`)
process.exit(0)
