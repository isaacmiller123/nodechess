// Headless test for the online store (src/renderer/src/features/play/online/
// onlineStore.ts: the app-lifetime home of a live internet game, the B1 fix).
//
//   node scripts/test-mp-store.mjs
//
// The store is a PLAIN module singleton with NO React imports, so it runs
// unchanged in bare node. Its only runtime coupling to the session is
//   import { mp } from './mpClient'
// which pulls the real trystero-backed singleton. For this test we esbuild-bundle
// onlineStore.ts with that ONE import redirected (via an esbuild resolve plugin)
// to a MOCK mpClient we write here. The mock's `mp` records every action call and
// lets the test PUSH any §8 MpEvent into the store's event pump, so we can drive
// every event→state transition deterministically and assert the resulting
// snapshot (getState()) without a network or a session.
//
// The store's other runtime imports (chess helpers via chessops, treeToPgn) bundle
// straight through; the type-only imports (SoundName, TreeNode, GameViewBanner) are
// erased by esbuild. window.api is absent in bare node. The store guards its
// save() call, so persistence is a no-op we OBSERVE via the mock instead: we stub
// globalThis.window.api.games.save to record saved games and assert save-once /
// no-save-on-abort semantics.
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green; any failure prints
// and exits 1. Clean exit (no leaked handles).

import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- tiny assert kit --------------------------------------------------------
let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}
function eq(a, b, msg) {
  ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Let the store's async actions (which await mocked promises) settle. */
const settle = () => sleep(0)

// ---- the mock mpClient source (written to disk, aliased into the bundle) -----
//
// It mirrors the mp API surface the store calls: onEvent(cb) (the store subscribes
// ONCE at construction: we capture that cb), and the action methods. Each action
// records its call and returns a result the test can control (default ok:true).
// A global __MP_MOCK__ handle lets the test push events and read/tune calls.
const MOCK_MPCLIENT = `
const state = {
  cb: null,            // the store's single onEvent subscriber
  calls: [],           // [{ name, args }]
  sendMoveOk: true,    // controls sendMove result (D6 rollback test)
  hostCode: 'ABCDE-FGHJK',
  validator: null      // the store's registered guest-move validator
}
function record(name, args) { state.calls.push({ name, args }) }
export const mp = {
  onEvent(cb) { state.cb = cb; return () => { if (state.cb === cb) state.cb = null } },
  // Wire-v4 host-side legality seam: the store registers its kernel validator at
  // construction; the test invokes it via MOCK.validate to assert HOST rejection
  // of illegal guest moves (session behavior is covered by test-mp.mjs).
  setMoveValidator(fn) { state.validator = fn },
  async host(cfg) { record('host', [cfg]); return { code: state.hostCode } },
  async join(code) { record('join', [code]); return { ok: true } },
  async sendMove(uci) { record('sendMove', [uci]); return { ok: state.sendMoveOk } },
  async resign() { record('resign', []); return { ok: true } },
  async offerDraw() { record('offerDraw', []); return { ok: true } },
  async acceptDraw() { record('acceptDraw', []); return { ok: true } },
  async declineDraw() { record('declineDraw', []); return { ok: true } },
  async offerRematch() { record('offerRematch', []); return { ok: true } },
  async declineRematch() { record('declineRematch', []); return { ok: true } },
  async abort() { record('abort', []); return { ok: true } },
  async claimVictory() { record('claimVictory', []); return { ok: true } },
  async gameEnded(result, reason) { record('gameEnded', [result, reason]); return { ok: true } },
  leave() { record('leave', []) }
}
// Test handle.
globalThis.__MP_MOCK__ = {
  emit(ev) { if (state.cb) state.cb(ev) },
  calls: () => state.calls,
  clearCalls: () => { state.calls.length = 0 },
  countCalls: (name) => state.calls.filter((c) => c.name === name).length,
  lastCall: (name) => [...state.calls].reverse().find((c) => c.name === name),
  validate: (moves, move) => (state.validator ? state.validator(moves, move) : true),
  set sendMoveOk(v) { state.sendMoveOk = v },
  get sendMoveOk() { return state.sendMoveOk }
}
`

// ---- the REAL mpClient shim (section 18: NO mocks) ----------------------------
//
// The mocked `mp` above is exactly why the black-first ply-0 deadlock shipped:
// it answers sendMove ok:true unconditionally, so the SESSION's turn gate was
// never exercised from the store. Section 18 bundles the store a SECOND time
// with mpClient redirected to a REAL MpNetSession driven by an in-memory
// transport room (mirroring scripts/test-mp.mjs). The bundle is then COPIED to
// two files so `import` yields two INDEPENDENT store+session module instances
// (ESM caches per-URL): a true host + guest pair in one process.
const REAL_MPCLIENT = `
import { MpNetSession } from '${resolve(ROOT, 'src/renderer/src/features/play/online/mpSession.ts').replace(/\\/g, '/')}'
// Each module instance takes the next transport factory off the queue the test
// script set up (host bundle imported first, then guest).
export const mp = new MpNetSession(globalThis.__MP_REAL_FACTORIES__.shift())
`

/** Minimal in-memory trystero-alike room for the real-session pair: string
 *  payloads, targeted send, async (macrotask) delivery, join/leave fan-out. */
function makeRoom() {
  let seq = 0
  const members = new Map()
  return {
    join(listeners) {
      const id = `peer${++seq}`
      const self = { id, listeners, closed: false }
      for (const [otherId, other] of members) {
        if (other.closed) continue
        setTimeout(() => !other.closed && other.listeners.onPeerJoin(id), 0)
        setTimeout(() => !self.closed && self.listeners.onPeerJoin(otherId), 0)
      }
      members.set(id, self)
      return {
        send(text, toPeer) {
          if (self.closed) return
          if (toPeer) {
            const dst = members.get(toPeer)
            if (dst && !dst.closed) setTimeout(() => !dst.closed && dst.listeners.onMessage(text, id), 0)
          } else {
            for (const [otherId, other] of members) {
              if (otherId === id || other.closed) continue
              setTimeout(() => !other.closed && other.listeners.onMessage(text, id), 0)
            }
          }
        },
        stopRelayPoll() {},
        close() {
          if (self.closed) return
          self.closed = true
          members.delete(id)
          for (const [, other] of members) {
            if (other.closed) continue
            setTimeout(() => !other.closed && other.listeners.onPeerLeave(id), 0)
          }
        },
        closed: Promise.resolve()
      }
    }
  }
}

// ---- chessops FEN helpers we need locally (to build test positions/UCIs) -----
// The store derives fen incrementally; to assert its board state we compare against
// the same chessops the store uses. We bundle a tiny helper module for that.
const CHESS_HELPERS = `
export { applyMove, turnColor, INITIAL_FEN, outcome } from '${resolve(ROOT, 'src/renderer/src/chess/chess.ts').replace(/\\/g, '/')}'
`

async function bundle(entry, outfile, extraPlugins = []) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    // The store consumes the game-kernel registry (wire v4), whose entries lazy-
    // import board renderers (.tsx/.css) and whose ffish specs resolve WASM via a
    // Vite '?url' import: platform node + automatic JSX + empty CSS + external
    // '?url' make all of that bundle cleanly. None of it EXECUTES here (dynamic
    // imports stay lazy; preload is never called for the kinds under test).
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['*?url'],
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
    plugins: extraPlugins
  })
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/mp-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'store-'))

  // Write the mock mpClient + a chess-helper entry to the scratch dir.
  const mockPath = resolve(outdir, 'mockMpClient.mjs')
  writeFileSync(mockPath, MOCK_MPCLIENT)
  const helperEntry = resolve(outdir, 'helpers.entry.ts')
  writeFileSync(helperEntry, CHESS_HELPERS)

  // Bundle onlineStore.ts, redirecting its `./mpClient` import to our mock via a
  // resolve plugin (the import specifier is relative, so match on the basename).
  // The entry also re-exports preloadFfish from the SAME module graph so the
  // xiangqi section (17) can seed the ffish WASM singleton the store's adapter
  // preload will then find already resolved (bare node has no '?url' path).
  console.log('· bundling onlineStore.ts with a mocked mpClient …')
  const storeEntry = resolve(outdir, 'store.entry.ts')
  writeFileSync(
    storeEntry,
    `export { onlineStore } from '${resolve(ROOT, 'src/renderer/src/features/play/online/onlineStore.ts').replace(/\\/g, '/')}'\n` +
      `export { preloadFfish } from '${resolve(ROOT, 'src/renderer/src/games/ffish.ts').replace(/\\/g, '/')}'\n`
  )
  const storeOut = resolve(outdir, 'onlineStore.mjs')
  const swapMpClient = {
    name: 'swap-mpclient',
    setup(b) {
      b.onResolve({ filter: /(^|\/)mpClient$/ }, () => ({ path: mockPath }))
    }
  }
  await bundle(storeEntry, storeOut, [swapMpClient])

  // Bundle the chess helpers so we can construct UCIs / verify fens like the store.
  const helpersOut = resolve(outdir, 'helpers.mjs')
  await bundle(helperEntry, helpersOut)

  // Real-session variant (section 18): the SAME store entry, mpClient → a REAL
  // MpNetSession over an in-memory room. Bundled once, copied twice so host and
  // guest get independent module instances.
  console.log('· bundling onlineStore.ts with a REAL MpNetSession mpClient …')
  const realMpClientPath = resolve(outdir, 'realMpClient.mjs')
  writeFileSync(realMpClientPath, REAL_MPCLIENT)
  const realOut = resolve(outdir, 'onlineStore.real.mjs')
  const swapReal = {
    name: 'swap-mpclient-real',
    setup(b) {
      b.onResolve({ filter: /(^|\/)mpClient$/ }, () => ({ path: realMpClientPath }))
    }
  }
  await bundle(storeEntry, realOut, [swapReal])
  const realHostOut = resolve(outdir, 'onlineStore.real.host.mjs')
  const realGuestOut = resolve(outdir, 'onlineStore.real.guest.mjs')
  writeFileSync(realHostOut, readFileSync(realOut))
  writeFileSync(realGuestOut, readFileSync(realOut))

  // Observe saves: the store calls window.api.games.save(...) best-effort. Stub it
  // BEFORE importing the store module (its constructor runs on import).
  const saved = []
  globalThis.window = {
    api: { games: { save: async (g) => { saved.push(g); return { ok: true } } } }
  }
  // The window stub makes emscripten (ffish, section 17) think it is in a
  // browser and dereference document.currentScript: give it a null one. The
  // wasm itself arrives via wasmBinary, so no other document/fetch use runs.
  globalThis.document ??= { currentScript: null }
  // A performance.now the store uses for clock timestamps.
  if (typeof globalThis.performance === 'undefined') {
    globalThis.performance = { now: () => Date.now() }
  }

  const { onlineStore, preloadFfish } = await import(pathToFileURL(storeOut).href)
  const helpers = await import(pathToFileURL(helpersOut).href)
  const { applyMove, turnColor, INITIAL_FEN } = helpers

  const MOCK = globalThis.__MP_MOCK__
  ok(typeof onlineStore === 'object', 'onlineStore singleton constructed')
  ok(typeof MOCK === 'object', 'mock mpClient wired in (store subscribed at construction)')

  // ---- helpers --------------------------------------------------------------
  const S = () => onlineStore.getState()
  const emit = (ev) => MOCK.emit(ev)
  const CFG = (initialMs = 60_000, incrementMs = 0, hostColor = 'white') => ({
    tc: { initialMs, incrementMs },
    hostColor
  })
  /** UCI for a legal move from a fen (first legal we care about is explicit). */
  const reset = () => { onlineStore.leave(); MOCK.clearCalls(); saved.length = 0 }

  // Track subscriber notifications to confirm the store notifies on mutation.
  let notifyCount = 0
  const unsub = onlineStore.subscribe(() => { notifyCount++ })

  // ==========================================================================
  // 1. host / join actions drive phase + call the session once.
  // ==========================================================================
  console.log('\n· host()/join() phase + session calls …')
  {
    reset()
    await onlineStore.host(CFG())
    await settle()
    eq(S().phase, 'hosting', 'host() → phase hosting')
    eq(S().code, 'ABCDE-FGHJK', 'host() adopts the code from the session')
    eq(MOCK.countCalls('host'), 1, 'host() calls mp.host exactly once')
  }
  {
    reset()
    await onlineStore.join('ABCDE-FGHJK')
    await settle()
    eq(S().phase, 'connecting', 'join() → phase connecting (awaits start)')
    eq(MOCK.countCalls('join'), 1, 'join() calls mp.join exactly once')
  }

  // ==========================================================================
  // 2. 'net' → netStage/relays; 'start' → game phase with colors + clocks idle.
  // ==========================================================================
  console.log('\n· net + start transitions …')
  {
    reset()
    emit({ type: 'net', state: 'relays', relays: { connected: 1, total: 3 } })
    eq(S().netStage, 'relays', 'net event sets netStage')
    eq(S().relays.connected, 1, 'net event sets relays.connected')
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 1_000), opponentName: 'Bob' })
    eq(S().phase, 'game', 'start → phase game')
    eq(S().gameId, 1, 'start adopts gameId')
    eq(S().myColor, 'white', 'start adopts myColor')
    eq(S().orientation, 'white', 'start orients to myColor')
    eq(S().opponentName, 'Bob', 'start adopts opponentName')
    eq(S().plyCount, 0, 'start resets plyCount to 0')
    eq(S().fen, INITIAL_FEN, 'start resets fen to initial')
    eq(S().canAbort, true, 'start: canAbort true (ply 0 < 2, live)')
    ok(S().clock !== null && S().clock.running === null, 'start: clock present but idle (running null)')
    eq(S().clock.snapshot.white, 60_000, 'start: clock snapshot at initialMs')
  }

  // ==========================================================================
  // 3. playMove optimistic apply + clock flip; remote move applies.
  // ==========================================================================
  console.log('\n· playMove optimistic apply + remote move …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0), opponentName: 'Bob' })
    // Our move (white to move). Optimistic: fen/plyCount advance immediately.
    await onlineStore.playMove('e2e4')
    await settle()
    eq(S().plyCount, 1, 'playMove: plyCount advances optimistically')
    eq(S().moves[0], 'e2e4', 'playMove: uci recorded')
    eq(turnColor(S().fen), 'black', 'playMove: fen now black to move')
    eq(MOCK.countCalls('sendMove'), 1, 'playMove calls mp.sendMove once')
    eq(S().clock.running, 'black', 'playMove: display clock flips to the side now on move (black)')
    eq(S().canAbort, true, 'playMove: still abortable at ply 1')
    // A remote move (black replies). Host relays it with authoritative clocks.
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 59_000 } })
    eq(S().plyCount, 2, 'remote move: plyCount advances')
    eq(S().moves[1], 'e7e5', 'remote move: uci recorded')
    eq(turnColor(S().fen), 'white', 'remote move: back to white to move')
    eq(S().clock.snapshot.black, 59_000, 'remote move: adopts authoritative clock snapshot')
    eq(S().clock.running, 'white', 'remote move: white now running')
    eq(S().canAbort, false, 'remote move: no longer abortable at ply 2')
  }

  // ==========================================================================
  // 4. playMove ROLLS BACK on ok:false (D6).
  // ==========================================================================
  console.log('\n· playMove rollback on ok:false (D6) …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    MOCK.sendMoveOk = false
    const beforeFen = S().fen
    await onlineStore.playMove('e2e4')
    await settle()
    eq(S().plyCount, 0, 'rollback: plyCount restored to 0')
    eq(S().moves.length, 0, 'rollback: moves restored to empty')
    eq(S().fen, beforeFen, 'rollback: fen restored to pre-move')
    MOCK.sendMoveOk = true
  }

  // ==========================================================================
  // 5. Move BLOCKED while peerAway (board frozen), and wrong-turn / dead states.
  // ==========================================================================
  console.log('\n· move blocked while peerAway / not my turn / over …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'peer-away', graceMs: 30_000 })
    ok(S().peerAway !== null, 'peer-away sets peerAway state')
    await onlineStore.playMove('e2e4')
    await settle()
    eq(MOCK.countCalls('sendMove'), 0, 'playMove blocked while peerAway (no sendMove)')
    eq(S().plyCount, 0, 'playMove blocked while peerAway (no optimistic apply)')
    // peer-back clears it.
    emit({ type: 'peer-back' })
    eq(S().peerAway, null, 'peer-back clears peerAway')
  }
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'black', config: CFG(60_000, 0) })
    // It's white to move but we are black → our move is blocked.
    await onlineStore.playMove('e7e5')
    await settle()
    eq(MOCK.countCalls('sendMove'), 0, 'playMove blocked when it is not our turn')
  }

  // ==========================================================================
  // 6. clock event updates the snapshot (host ack after our move; D5).
  // ==========================================================================
  console.log('\n· clock event updates snapshot …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'black', config: CFG(60_000, 0) })
    // White (opponent) opens; we (black) get the move + a clock ack.
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'clock', gameId: 1, clockMs: { white: 59_500, black: 60_000 }, toMove: 'black' })
    eq(S().clock.snapshot.white, 59_500, 'clock event updates white snapshot')
    eq(S().clock.running, 'black', 'clock event sets running side to toMove')
    // A stale-gameId clock is ignored.
    emit({ type: 'clock', gameId: 99, clockMs: { white: 1, black: 1 }, toMove: 'white' })
    eq(S().clock.snapshot.white, 59_500, 'stale-gameId clock ignored')
  }

  // ==========================================================================
  // 7. resign / drawAccept / gameOver / abort banners + save gating.
  // ==========================================================================
  console.log('\n· resign banner (won/lost) + save-once …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    // Opponent (black) resigns → white (us) wins.
    emit({ type: 'resign', by: 'black' })
    ok(S().banner !== null, 'resign raises a banner')
    eq(S().banner.result, '1-0', 'resign by black → result 1-0')
    eq(S().banner.reason, 'by resignation', 'resign banner reason')
    eq(S().banner.outcomeForUser, 'win', 'resign banner: we (white) won')
    eq(saved.length, 1, 'resign (≥2 plies) saves the game exactly once')
    eq(saved[0].result, '1-0', 'saved game carries result')
    // A second terminal event must not double-save.
    emit({ type: 'gameOver', gameId: 1, result: '1-0', reason: 'checkmate' })
    eq(saved.length, 1, 'no double-save after banner already set')
  }
  console.log('\n· draw agreement banner …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'drawAccept' })
    eq(S().banner.result, '1/2-1/2', 'drawAccept → draw result')
    eq(S().banner.reason, 'by agreement', 'drawAccept reason by agreement')
    eq(saved.length, 1, 'drawn game saved')
  }
  console.log('\n· abort: neutral banner, NOT saved …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    // Abort at ply 0 (no moves): neutral banner, no result recorded, NOT saved.
    emit({ type: 'abort', gameId: 1, reason: 'no-first-move' })
    ok(S().banner !== null, 'abort raises a (neutral) banner')
    eq(S().banner.title, 'Game aborted: no first move', 'abort banner titled for no-first-move')
    eq(saved.length, 0, 'aborted game is NOT saved')
  }
  console.log('\n· gameOver (board terminal) banner + save …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'gameOver', gameId: 1, result: '0-1', reason: 'checkmate' })
    eq(S().banner.result, '0-1', 'gameOver adopts result')
    eq(S().banner.reason, 'checkmate', 'gameOver adopts reason')
    eq(S().banner.outcomeForUser, 'loss', 'gameOver 0-1 as white → loss')
    eq(saved.length, 1, 'terminal gameOver saved')
    // A stale-gameId gameOver is ignored.
    reset()
    emit({ type: 'start', gameId: 2, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'gameOver', gameId: 1, result: '1-0', reason: 'x' })
    eq(S().banner, null, 'stale-gameId gameOver ignored (no banner)')
  }

  // ==========================================================================
  // 8. NO save on <2 plies (not a real game).
  // ==========================================================================
  console.log('\n· short game (<2 plies) not saved …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    // Opponent resigns after a single ply → banner but NOT saved (< 2 plies).
    emit({ type: 'resign', by: 'black' })
    ok(S().banner !== null, 'single-ply resign still raises a banner')
    eq(saved.length, 0, 'single-ply game not saved (< 2 plies)')
  }

  // ==========================================================================
  // 9. Flag adjudication: on-time win vs insufficient-material draw.
  // ==========================================================================
  console.log('\n· flag → win on time (sufficient material) …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(15_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 15_000, black: 15_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 15_000, black: 15_000 } })
    // Black flags; white (us) has full material → win on time.
    emit({ type: 'flag', gameId: 1, by: 'black', clockMs: { white: 15_000, black: 0 } })
    eq(S().banner.result, '1-0', 'flag by black, white full material → 1-0')
    eq(S().banner.reason, 'on time', 'flag win reason "on time"')
    eq(S().clock.snapshot.black, 0, 'flagged side clock displayed at 0')
  }
  console.log('\n· flag → insufficient-material DRAW (winner = bare king) …')
  {
    // The store adjudicates a flag against state.fen: if the NON-flagged (winning)
    // side has insufficient mating material, the timeout is a DRAW, not a win
    // (lichess rule). We drive the store's board. By replaying a real, fully-legal
    // 52-ply game (verified: no intermediate terminal position). To a position
    // where WHITE (us) is reduced to a LONE KING while BLACK still holds heavy
    // material (K + Q + R + B + Ns). Final FEN:
    //   2b1k3/1pppn2r/2n5/r4p2/2p5/4q3/2p3p1/6K1 w - - 0 27
    // Now BLACK flags → the winner would be WHITE, but white can never mate, so the
    // store must record a DRAW "time out: insufficient material".
    const LINE = ['h2h4','a7a5','d2d4','a8a7','e2e3','a5a4','a2a3','g7g6','c2c4','e7e6','g2g4','f8a3','b2b3','a3c1','h4h5','g6h5','g1e2','a4b3','d4d5','c1e3','d1c2','h5g4','e2g1','e6d5','a1a5','b3c2','g1e2','d5c4','a5h5','e3f2','e1f2','b8c6','h1h3','g4h3','h5h7','h8h7','f2g1','d8h4','f1g2','h3g2','b1d2','g8e7','d2b1','f7f5','e2g3','h4g3','b1d2','g3c3','d2f1','a7a5','f1e3','c3e3']
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(15_000, 0) })
    // Feed every ply as a remote move (the store applies by ply order regardless of
    // side); this walks its fen to the bare-king endgame without ending the game.
    for (let i = 0; i < LINE.length; i++) {
      emit({ type: 'move', gameId: 1, ply: i, uci: LINE[i], clockMs: { white: 15_000, black: 15_000 } })
    }
    eq(S().plyCount, LINE.length, 'insufficient line: all 52 plies applied to the store board')
    eq(S().banner, null, 'insufficient line: no mid-game terminal banner')
    // Black flags: winner = white, but white is a bare king → DRAW.
    emit({ type: 'flag', gameId: 1, by: 'black', clockMs: { white: 15_000, black: 0 } })
    ok(S().banner !== null, 'flag raises a banner in the insufficient-material case')
    eq(S().banner.result, '1/2-1/2', 'flag with an insufficient-material winner → DRAW')
    eq(S().banner.reason, 'time out: insufficient material', 'draw reason names insufficient material')
    eq(saved.length, 1, 'insufficient-material draw is saved')
  }

  // ==========================================================================
  // 10. peerAway → peerLeft → claimVictory; and claim records a win + saves.
  // ==========================================================================
  console.log('\n· peer-left → claimVictory records a win …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'peer-away', graceMs: 30_000 })
    emit({ type: 'peer-left' })
    eq(S().peerLeft, true, 'peer-left sets peerLeft')
    eq(S().peerAway, null, 'peer-left clears peerAway')
    await onlineStore.claimVictory()
    await settle()
    eq(MOCK.countCalls('claimVictory'), 1, 'claimVictory calls mp.claimVictory')
    eq(S().banner.result, '1-0', 'claimVictory records a win for white (us)')
    eq(S().banner.reason, 'opponent left the game', 'claimVictory banner reason')
    eq(saved.length, 1, 'claimed victory saved')
  }
  console.log('\n· peer-left without claim: NOT saved (abandoned) …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'peer-away', graceMs: 30_000 })
    emit({ type: 'peer-left' })
    // The user just leaves without claiming.
    eq(saved.length, 0, 'abandoned game (no claim) is NOT saved')
  }

  // ==========================================================================
  // 11. Draw / rematch offer flags (incoming/outgoing) + decline clears.
  // ==========================================================================
  console.log('\n· draw + rematch offer flags …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'drawOffer' })
    eq(S().drawOffered, true, 'incoming drawOffer sets drawOffered')
    // We decline → clears + calls mp.declineDraw.
    await onlineStore.declineDraw()
    await settle()
    eq(S().drawOffered, false, 'declineDraw clears drawOffered')
    eq(MOCK.countCalls('declineDraw'), 1, 'declineDraw calls the session')
    // We offer a draw → drawSent + cooldown; session called.
    await onlineStore.offerDraw()
    await settle()
    eq(S().drawSent, true, 'offerDraw sets drawSent')
    eq(MOCK.countCalls('offerDraw'), 1, 'offerDraw calls the session')
    // Opponent declines our offer.
    emit({ type: 'drawDecline' })
    eq(S().drawSent, false, 'incoming drawDecline clears drawSent')
  }
  console.log('\n· rematch offer flags (post-game) …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'resign', by: 'black' }) // game over → rematch meaningful
    emit({ type: 'rematchOffer' })
    eq(S().rematchOffered, true, 'incoming rematchOffer (post-game) sets rematchOffered')
    await onlineStore.offerRematch()
    await settle()
    eq(S().rematchSent, true, 'offerRematch sets rematchSent')
    eq(MOCK.countCalls('offerRematch'), 1, 'offerRematch calls the session')
    // rematchStart resets to a fresh game (swapped colors, gameId+1).
    emit({ type: 'rematchStart', gameId: 2, yourColor: 'black' })
    eq(S().phase, 'game', 'rematchStart → back to game phase')
    eq(S().gameId, 2, 'rematchStart adopts new gameId')
    eq(S().myColor, 'black', 'rematchStart swaps our color')
    eq(S().banner, null, 'rematchStart clears the banner')
    eq(S().plyCount, 0, 'rematchStart resets the board')
  }

  // ==========================================================================
  // 12. gameOver from board-terminal reached by playMove → mp.gameEnded called.
  // ==========================================================================
  console.log('\n· board-terminal via playMove calls mp.gameEnded …')
  {
    reset()
    // Fool's mate: 1.f3 e5 2.g4 Qh4#. We are white and DELIVER the losing position
    // to ourselves by playing into it; the mate is detected after black's Qh4#.
    // Simpler: drive white into a self-checkmate is impossible in 1 move; instead
    // verify gameEnded fires on a REMOTE move that checkmates us. Play the fool's
    // mate with us as WHITE receiving the final black move.
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    await onlineStore.playMove('f2f3'); await settle()
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    await onlineStore.playMove('g2g4'); await settle()
    // Black plays Qh4#, mate on white. The store detects terminal → mp.gameEnded.
    emit({ type: 'move', gameId: 1, ply: 3, uci: 'd8h4', clockMs: { white: 60_000, black: 60_000 } })
    ok(S().banner !== null, 'checkmate raises a banner')
    eq(S().banner.result, '0-1', 'fool\'s mate: black wins (0-1)')
    eq(S().banner.outcomeForUser, 'loss', 'we (white) are mated → loss')
    ok(MOCK.countCalls('gameEnded') >= 1, 'board-terminal calls mp.gameEnded')
    const gc = MOCK.lastCall('gameEnded')
    eq(gc.args[0], '0-1', 'gameEnded relayed the 0-1 result')
    eq(saved.length, 1, 'checkmated game saved')
  }

  // ==========================================================================
  // 13. leave() is the SOLE caller of mp.leave() and resets the store.
  // ==========================================================================
  console.log('\n· leave() sole mp.leave() caller + full reset …')
  {
    reset() // reset itself calls leave once; clear after
    MOCK.clearCalls()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    onlineStore.leave()
    eq(MOCK.countCalls('leave'), 1, 'leave() calls mp.leave exactly once')
    eq(S().phase, 'idle', 'leave() resets phase to idle')
    eq(S().gameId, 0, 'leave() resets gameId')
    eq(S().banner, null, 'leave() clears banner')
    // Confirm NO other action method calls mp.leave under the hood.
    MOCK.clearCalls()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 } })
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 } })
    await onlineStore.resign(); await settle()
    await onlineStore.abort(); await settle()
    await onlineStore.offerDraw(); await settle()
    emit({ type: 'resign', by: 'black' })
    await onlineStore.offerRematch(); await settle()
    eq(MOCK.countCalls('leave'), 0, 'no other action calls mp.leave() implicitly')
  }

  // ==========================================================================
  // 14. error event surfaces in state; dismissError clears.
  // ==========================================================================
  console.log('\n· error event + dismissError …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    emit({ type: 'error', message: 'malformed message from peer' })
    eq(S().error, 'malformed message from peer', 'in-game error surfaces in state')
    eq(S().phase, 'game', 'in-game error keeps the game phase (status strip)')
    onlineStore.dismissError()
    eq(S().error, null, 'dismissError clears the error')
    // A pre-game (lobby) error drops toward idle.
    reset()
    await onlineStore.host(CFG()); await settle()
    emit({ type: 'error', message: 'nobody hosting' })
    eq(S().phase, 'idle', 'lobby error drops phase to idle')
    eq(S().error, 'nobody hosting', 'lobby error surfaces its message')
  }

  // ==========================================================================
  // 15. flip() toggles orientation only.
  // ==========================================================================
  console.log('\n· flip() toggles orientation …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'white', config: CFG(60_000, 0) })
    eq(S().orientation, 'white', 'orientation starts at myColor')
    onlineStore.flip()
    eq(S().orientation, 'black', 'flip() toggles orientation')
    onlineStore.flip()
    eq(S().orientation, 'white', 'flip() toggles back')
  }

  // ==========================================================================
  // 16. Wire v4. A full NON-CHESS game (gomoku) through the kernel adapter:
  //     host with a game kind, kernel state exposure, optimistic play, the
  //     HOST-side validator rejecting an illegal (occupied-cell) guest move,
  //     five-in-a-row terminal → gameEnded + generic (non-PGN) archive.
  // ==========================================================================
  console.log('\n· gomoku (wire v4): host with kind + kernel state …')
  const GOMOKU_CFG = () => ({ ...CFG(60_000, 0), game: { kind: 'gomoku' } })
  {
    reset()
    await onlineStore.host(GOMOKU_CFG())
    await settle()
    eq(S().phase, 'hosting', 'gomoku host() reaches hosting (kernel adapter resolved)')
    eq(MOCK.lastCall('host').args[0].game.kind, 'gomoku', 'host() passes game.kind to the session untouched')

    // Start: we are BLACK. The first mover in gomoku (spec players order).
    emit({ type: 'start', gameId: 1, yourColor: 'black', config: GOMOKU_CFG(), opponentName: 'Wei' })
    eq(S().phase, 'game', 'gomoku start → phase game')
    eq(S().gameKind, 'gomoku', 'store exposes gameKind for the UI board switch')
    eq(S().fen, '', 'gomoku positionKey: empty codec history at start')
    ok(S().boardState !== null && typeof S().boardState === 'object', 'boardState carries the kernel state object')
    eq(S().boardState.size, 15, 'gomoku kernel state: default 15×15 board')
    ok(S().clock !== null && S().clock.running === null, 'gomoku start: clock idle until the first move')
  }
  console.log('\n· gomoku: black (us) marches to five-in-a-row; white replies …')
  {
    // Our stones f8 g8 h8 j8 k8 (go columns skip "i") vs white a1..d1.
    await onlineStore.playMove('h8'); await settle()
    eq(S().plyCount, 1, 'gomoku playMove: optimistic apply advances plyCount')
    eq(S().moves[0], 'h8', 'gomoku playMove: codec move recorded')
    eq(S().clock.running, 'white', 'gomoku playMove: display clock flips to white')
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'a1', clockMs: { white: 59_000, black: 60_000 } })
    eq(S().plyCount, 2, 'gomoku remote move applies through the kernel')
    eq(S().fen, 'h8 a1', 'gomoku positionKey mirrors the codec history')
    await onlineStore.playMove('f8'); await settle()
    emit({ type: 'move', gameId: 1, ply: 3, uci: 'b1', clockMs: { white: 58_000, black: 60_000 } })
    await onlineStore.playMove('g8'); await settle()
    emit({ type: 'move', gameId: 1, ply: 5, uci: 'c1', clockMs: { white: 57_000, black: 60_000 } })
    await onlineStore.playMove('j8'); await settle()
    emit({ type: 'move', gameId: 1, ply: 7, uci: 'd1', clockMs: { white: 56_000, black: 60_000 } })
    eq(S().plyCount, 8, 'gomoku: eight plies applied, no terminal yet')
    eq(S().banner, null, 'gomoku: game still live before the fifth stone')

    // Occupied cell (a1 holds a white stone): the kernel rejects it locally.
    const sendsBefore = MOCK.countCalls('sendMove')
    await onlineStore.playMove('a1'); await settle()
    eq(MOCK.countCalls('sendMove'), sendsBefore, 'occupied-cell move rejected locally (no sendMove)')
    eq(S().plyCount, 8, 'occupied-cell move: no optimistic apply')

    // HOST-side validator (wire v4 legality gate) judges guest moves with the
    // same kernel: occupied cell → reject; a free vertex → accept.
    eq(MOCK.validate(S().moves, 'h8'), false, 'host validator rejects an occupied-cell guest move')
    eq(MOCK.validate(S().moves, 'p12'), true, 'host validator accepts a legal guest move')

    // The winning fifth stone: f8 g8 h8 j8 k8 across rank 8.
    await onlineStore.playMove('k8'); await settle()
    ok(S().banner !== null, 'five-in-a-row raises the banner')
    eq(S().banner.result, '0-1', 'gomoku: black wins → color-anchored 0-1')
    eq(S().banner.reason, 'five-in-a-row', 'gomoku terminal reason from the kernel')
    eq(S().banner.outcomeForUser, 'win', 'we (black) won')
    const ge = MOCK.lastCall('gameEnded')
    ok(ge !== undefined, 'kernel terminal calls mp.gameEnded')
    eq(ge.args[0], '0-1', 'gameEnded relayed the gomoku result')
    eq(saved.length, 1, 'finished gomoku game saved exactly once')
    eq(saved[0].result, '0-1', 'gomoku save carries the result')
    eq(saved[0].opponentKind, 'human', 'gomoku save is a human online game')
    ok(saved[0].pgn.includes('[Variant "gomoku"]'), 'generic archive tags the game kind')
    ok(saved[0].pgn.includes('h8 a1 f8 b1 g8 c1 j8 d1 k8 0-1'), 'generic archive is the wire codec joined + result')
    ok(!saved[0].pgn.includes('1. '), 'non-chess archive is NOT numbered PGN movetext')
  }
  console.log('\n· gomoku: flag = plain loss on time (no insufficient-material rule) …')
  {
    reset()
    emit({ type: 'start', gameId: 1, yourColor: 'black', config: GOMOKU_CFG(), opponentName: 'Wei' })
    await onlineStore.playMove('h8'); await settle()
    emit({ type: 'move', gameId: 1, ply: 1, uci: 'a1', clockMs: { white: 59_000, black: 60_000 } })
    emit({ type: 'flag', gameId: 1, by: 'white', clockMs: { white: 0, black: 60_000 } })
    ok(S().banner !== null, 'gomoku flag raises a banner')
    eq(S().banner.result, '0-1', 'gomoku flag by white → black wins')
    eq(S().banner.reason, 'on time', 'gomoku flag is a plain on-time loss')
    eq(saved.length, 1, 'gomoku flag result saved')
  }

  // ==========================================================================
  // 17. Wire v4. Xiangqi (ffish WASM adapter): the RANK-10 regression path.
  //     v1.1.2's bug class was two-digit-rank squares breaking at a boundary;
  //     this section proves the ONLINE boundary is clean end to end: async
  //     adapter preload during start, a remote 5-char move INTO rank 10, our
  //     6-char move ALONG rank 10 (optimistic apply + sendMove uncut), the
  //     host-side ffish validator judging rank-10 guest moves, a 10-row FEN
  //     positionKey, and the generic archive carrying the codec verbatim.
  // ==========================================================================
  console.log('\n· xiangqi (wire v4 + ffish): rank-10 moves end to end …')
  const XIANGQI_CFG = () => ({ ...CFG(60_000, 0), game: { kind: 'xiangqi' } })
  {
    reset()
    // Seed the ffish singleton with wasm bytes (bare node); the store's
    // adapter.preload() then resolves against the already-loaded module.
    await preloadFfish({ wasmBinary: readFileSync(resolve(ROOT, 'node_modules/ffish-es6/ffish.wasm')) })
    ok(true, 'ffish singleton preloaded from wasm bytes (adapter shares it)')
    await onlineStore.host(XIANGQI_CFG())
    await settle()
    eq(S().phase, 'hosting', 'xiangqi host() reaches hosting (ffish adapter resolved)')

    emit({ type: 'start', gameId: 1, yourColor: 'black', config: XIANGQI_CFG(), opponentName: 'Mei' })
    await settle() // beginGame tails behind adapter.preload().then(…)
    await settle()
    eq(S().phase, 'game', 'xiangqi start → phase game (async preload path)')
    eq(S().gameKind, 'xiangqi', 'store exposes gameKind xiangqi')
    eq(S().fen.split(' ')[0].split('/').length, 10, 'positionKey is a 10-rank xiangqi FEN')

    // Red (remote): cannon takes the b10 horse over the b8 screen. A 5-char
    // wire move whose DESTINATION is rank 10.
    emit({ type: 'move', gameId: 1, ply: 0, uci: 'b3b10', clockMs: { white: 59_000, black: 60_000 } })
    eq(S().plyCount, 1, 'remote b3b10 applied through ffish')
    eq(S().moves[0], 'b3b10', 'rank-10 wire move recorded verbatim')

    // Us (black): chariot a10 takes the cannon on b10. SIX chars, both
    // squares on rank 10 (the exact spelling the old cast bug destroyed).
    await onlineStore.playMove('a10b10'); await settle()
    eq(S().plyCount, 2, 'our a10b10 applied optimistically')
    eq(MOCK.lastCall('sendMove').args[0], 'a10b10', 'sendMove carries the 6-char rank-10 move uncut (≤64 wire cap)')
    ok(S().fen.split(' ')[0].startsWith('1r'), 'fen top row shows the chariot landed on b10 (a10 emptied)')

    // Host-side validator (wire v4 legality gate) with rank-10 guest moves:
    // red's mirror capture is legal; a blocked rank-10 slide and a move by the
    // already-captured cannon are not.
    eq(MOCK.validate(S().moves, 'h3h10'), true, 'validator accepts red h3h10 (cannon × horse on rank 10)')
    eq(MOCK.validate(S().moves, 'a1a10'), false, 'validator rejects a blocked a1a10 slide')
    eq(MOCK.validate(S().moves, 'b3b9'), false, 'validator rejects a move by the captured b3 cannon')

    emit({ type: 'move', gameId: 1, ply: 2, uci: 'h3h10', clockMs: { white: 58_000, black: 59_000 } })
    eq(S().plyCount, 3, 'red h3h10 applied (second rank-10 capture)')

    // Wrap up: red resigns → we (black) win; the generic archive keeps the
    // two-digit codec verbatim.
    emit({ type: 'resign', by: 'white' })
    eq(S().banner.result, '0-1', 'resign by red → black (us) wins')
    eq(S().banner.outcomeForUser, 'win', 'banner outcome: win for us')
    eq(saved.length, 1, 'finished xiangqi game saved exactly once')
    ok(saved[0].pgn.includes('b3b10 a10b10 h3h10'), 'archive carries the rank-10 moves verbatim')
    ok(saved[0].pgn.includes('[Variant "xiangqi"]'), 'archive tagged xiangqi')
  }

  // ==========================================================================
  // 18. REAL-SESSION black-first game (the regression that shipped): two real
  //     onlineStore singletons driving two real MpNetSessions over an
  //     in-memory room: NO mocked mp anywhere on the path. The host UI config
  //     carries NO firstMover (exactly what OnlineTab sends); the store must
  //     stamp it from the registry spec (gomoku players[0] = black), the
  //     joiner must adopt it from `start`, and the guest-as-black FIRST move
  //     at ply 0 must commit on BOTH sides. The exact path that deadlocked
  //     (the mocked sendMove above always answered ok:true, so the session's
  //     turn gate was never exercised from the store).
  // ==========================================================================
  console.log('\n· REAL session (no mocks): black-first gomoku plays through ply 0 …')
  {
    /** Poll until `fn()` is truthy (real wire delivery is async macrotasks). */
    const until = async (fn, label, timeout = 5000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (fn()) { passed++; console.log(`  ✓ ${label}`); return }
        await sleep(5)
      }
      throw new Error(`ASSERT FAILED: timeout waiting for ${label}`)
    }
    const room = makeRoom()
    globalThis.__MP_REAL_FACTORIES__ = [(code, l) => room.join(l), (code, l) => room.join(l)]
    const A = (await import(pathToFileURL(realHostOut).href)).onlineStore // host (white seat)
    const B = (await import(pathToFileURL(realGuestOut).href)).onlineStore // guest (black seat, FIRST MOVER)
    // Host with the UI's config shape: game.kind only, NO firstMover.
    await A.host({ tc: { initialMs: 60_000, incrementMs: 0 }, hostColor: 'white', game: { kind: 'gomoku' } })
    await until(() => A.getState().code, 'real host() yields a room code')
    eq(A.getState().config.game.firstMover, 'black', 'host store stamped firstMover=black from the registry spec')
    await B.join(A.getState().code)
    await until(() => A.getState().phase === 'game' && B.getState().phase === 'game', 'both real stores reach game phase')
    eq(B.getState().myColor, 'black', 'guest seat is black (the first mover)')
    eq(B.getState().config.game.firstMover, 'black', "joiner adopted firstMover from the host's start config")
    // THE regression: the guest (black) opens at ply 0 through the REAL session.
    await B.playMove('h8')
    await until(() => B.getState().plyCount === 1 && B.getState().moves[0] === 'h8', 'guest black ply-0 move sticks (no rollback)')
    await until(() => A.getState().plyCount === 1 && A.getState().moves[0] === 'h8', 'host received + committed the black ply-0 move')
    await until(() => B.getState().clock && B.getState().clock.running === 'white', "black's move 1 starts WHITE's display clock")
    // Alternation continues: white (host) replies, black sees it, black moves on.
    await A.playMove('a1')
    await until(() => B.getState().plyCount === 2 && B.getState().moves[1] === 'a1', 'white reply relays to the guest')
    await B.playMove('f8')
    await until(() => A.getState().plyCount === 3 && A.getState().moves[2] === 'f8', 'black ply-2 move relays to the host (parity stays black-first)')
    eq(A.getState().banner, null, 'real black-first game still live (no spurious end)')
    A.leave()
    B.leave()
  }

  // subscriber sanity: mutations notified.
  ok(notifyCount > 0, `store notified subscribers on mutation (${notifyCount} times)`)
  unsub()

  reset()
  rmSync(outdir, { recursive: true, force: true })
  console.log(`\nALL GREEN: ${passed} assertions`)
}

main().then(
  () => setTimeout(() => process.exit(0), 30).unref(),
  (err) => {
    console.error(`\n❌ ${err.stack || err}`)
    process.exit(1)
  }
)
