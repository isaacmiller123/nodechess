// Headless test for the internet-multiplayer session/authority logic
// (src/renderer/src/features/play/online/mpSession.ts, the PURE module, v3).
//
//   node scripts/test-mp.mjs
//
// Multiplayer is WebRTC-in-the-renderer via trystero, and MpNetSession is
// transport-agnostic: it drives an INJECTED MpTransport. So we esbuild-bundle
// mpSession.ts to a scratch ESM file (which strips the TS types and proves the
// module is electron/node/trystero-free), then run BOTH ends. A HOST session and
// a GUEST session: inside ONE node process, joined by an in-memory transport
// pair. No network, no sockets, deterministic.
//
// The transport pair mirrors trystero semantics: string payloads, a `toPeer`
// targeted-send arg, async delivery (setTimeout 0 macrotask so peer-join lands
// AFTER the joining session's own `await makeTransport()` continuation), and
// onPeerJoin / onPeerLeave firing on the OTHER transports when a member is
// created / closed. The v3 mock adds four capabilities the audit needs:
//   - peer RE-JOIN with the SAME peerId (trystero re-pairs a returning peer;
//     drives the ghost-rebond/resume path, T2/D9),
//   - an injected bare third peer (host-busy / game-in-progress rejection),
//   - send-error injection on demand (T6 → suspend path),
//   - controllable message delivery: hold/flush/reorder/drop the delivery queue
//     so we can force out-of-order plies, cross-game staleness, and a lossy link.
//
// Timing: the multi-second watchdog windows (discovery 30s, handshake 15s, first-
// move abort 30s, heartbeat 5s, peer-silence 15s, reconnect grace 20–60s) are
// shrunk to a few ms per suite via the module's documented test-only override
// (__setMpTimingForTests) so we exercise every timer for real, deterministically,
// without ever sleeping tens of seconds. Production defaults are untouched.
//
// We assert on events emitted by BOTH real MpNetSession objects, so the v3 wire
// protocol is exercised for real in both directions. Every §2 rule is covered.
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green; any failure prints
// and exits 1. The process must exit cleanly (no leaked timers/handles).

import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs'

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
function approx(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b}±${tol})`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait until `pred` finds a matching event in `events`, remove & return it. */
function waitEvent(events, pred, { timeout = 3000, label = 'event' } = {}) {
  return new Promise((res, rej) => {
    const deadline = Date.now() + timeout
    const tick = () => {
      const idx = events.findIndex(pred)
      if (idx >= 0) return res(events.splice(idx, 1)[0])
      if (Date.now() > deadline) return rej(new Error(`timeout waiting for ${label}`))
      setTimeout(tick, 3)
    }
    tick()
  })
}
/** Assert NO event matching `pred` appears within `ms` (negative test). */
async function assertNoEvent(events, pred, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (events.findIndex(pred) >= 0) throw new Error(`ASSERT FAILED: unexpected ${label}`)
    await sleep(3)
  }
  passed++
  console.log(`  ✓ no ${label} (as expected)`)
}

// ============================================================================
// In-memory transport pair: a faithful stand-in for the trystero room.
// ============================================================================
//
// A single "room" object holds every transport that has joined it (keyed by a
// peerId). Sending to a target routes to that transport; broadcasting fans out.
// Creating a transport fires onPeerJoin on every peer already present (and about
// the newcomer on each of them); closing fires onPeerLeave symmetrically.
// Delivery is async (setTimeout 0). Relay status can be pushed manually.
//
// v3 extras:
//   - join({ peerId }) lets a caller REUSE a peerId so a returning peer re-pairs
//     with the same id (trystero behavior; drives the ghost-rebond path).
//   - controllable delivery: room.hold() buffers all future deliveries;
//     room.flush() / room.flushReversed() / room.dropNext() drain or drop them.
//   - a transport can be told to FAIL its next send (onSendError injection).

let PEER_SEQ = 0

function makeRoom() {
  const members = new Map() // peerId -> self
  let held = null // when set (array), deliveries queue here instead of firing

  /** Schedule a delivery: fire on a macrotask, unless we're holding, then queue. */
  const deliver = (fn) => {
    if (held) held.push(fn)
    else setTimeout(fn, 0)
  }

  const room = {
    /** Join the room; returns { transport, self, peerId }. Pass { peerId } to
     *  REUSE an id (a returning peer trystero re-pairs with the same id). */
    join(listeners, { peerId } = {}) {
      const id = peerId ?? `peer${++PEER_SEQ}`
      const self = { peerId: id, listeners, closed: false, failNextSend: false }
      // Tell existing members about the newcomer, and vice-versa (macrotask so a
      // join lands after the joiner's own `await makeTransport()` continuation).
      for (const [otherId, other] of members) {
        if (other.closed) continue
        deliver(() => !other.closed && other.listeners.onPeerJoin(id))
        deliver(() => !self.closed && self.listeners.onPeerJoin(otherId))
      }
      members.set(id, self)
      const transport = {
        send(text, toPeer) {
          if (self.closed) return
          if (typeof text !== 'string') throw new Error('transport.send got non-string')
          if (self.failNextSend) {
            self.failNextSend = false
            // Model rtcTransport's onSendError path: a dead/closed channel.
            self.listeners.onSendError?.(new Error('mock send failure'))
            return
          }
          if (toPeer) {
            const dst = members.get(toPeer)
            if (dst && !dst.closed) deliver(() => !dst.closed && dst.listeners.onMessage(text, id))
          } else {
            for (const [otherId, other] of members) {
              if (otherId === id || other.closed) continue
              deliver(() => !other.closed && other.listeners.onMessage(text, id))
            }
          }
        },
        stopRelayPoll() {
          self.relayStopped = true
        },
        close() {
          if (self.closed) return
          self.closed = true
          members.delete(id)
          for (const [, other] of members) {
            if (other.closed) continue
            deliver(() => !other.closed && other.listeners.onPeerLeave(id))
          }
        },
        // `closed` promise so a same-code rejoin can await settle (T7).
        closed: Promise.resolve()
      }
      self.transport = transport
      self.pushRelay = (c, t) => listeners.onRelayStatus && listeners.onRelayStatus(c, t)
      return { transport, self, peerId: id }
    },
    /** Buffer all future deliveries until flush/drop. */
    hold() {
      if (!held) held = []
    },
    /** Deliver everything buffered (in FIFO order) and resume live delivery. */
    flush() {
      const q = held || []
      held = null
      for (const fn of q) setTimeout(fn, 0)
    },
    /** Deliver buffered events in REVERSE order (force out-of-order arrival). */
    flushReversed() {
      const q = (held || []).slice().reverse()
      held = null
      for (const fn of q) setTimeout(fn, 0)
    },
    /** Drop the oldest buffered delivery (simulate a lost packet). */
    dropNext() {
      if (held && held.length) held.shift()
    },
    heldCount: () => (held ? held.length : 0),
    members
  }
  return room
}

/**
 * A pair of MpTransportFactory functions bound to a fresh shared room. Also
 * exposes the raw room so a suite can inject a third peer, hold/flush delivery,
 * or make a session's next send fail.
 */
function makeMockPair() {
  const room = makeRoom()
  const created = [] // every { self } we make, for relay pushes + send-fail control
  const mkFactory = () => (roomCode, listeners) => {
    const { transport, self } = room.join(listeners)
    created.push(self)
    return transport
  }
  return {
    hostFactory: mkFactory(),
    guestFactory: mkFactory(),
    /** Join an extra bare peer; returns { received[], peerId, leave() }. Pass an
     *  id to reuse it (returning ghost). */
    injectPeer({ peerId } = {}) {
      const received = []
      const { transport, peerId: id } = room.join(
        {
          onMessage: (text, from) => received.push({ text, from }),
          onPeerJoin: () => {},
          onPeerLeave: () => {},
          onSendError: () => {}
        },
        { peerId }
      )
      return { received, peerId: id, transport, leave: () => transport.close() }
    },
    /** Force the NEXT send from the given session slot to error (T6). Slot 0 =
     *  host, slot 1 = guest by join order. */
    failNextSend(slot) {
      const self = created[slot]
      if (self) self.failNextSend = true
    },
    created,
    pushRelayToAll: (c, t) => created.forEach((s) => s.pushRelay && s.pushRelay(c, t)),
    room
  }
}

// Collect a session's events into an array.
function tap(session) {
  const events = []
  session.onEvent((ev) => events.push(ev))
  return events
}

// ============================================================================
// Bundling
// ============================================================================
async function bundleTo(entry, outfile) {
  await build({
    entryPoints: [resolve(ROOT, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    // mpSession imports @shared/mp/wire and @shared/types; map the alias so
    // esbuild resolves them. zod (pulled in by wire.ts) is bundled in.
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning'
  })
  return readFileSync(outfile, 'utf8')
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/mp-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))

  // ---- bundle mpSession + wire ----
  console.log('· bundling mpSession.ts + wire.ts …')
  const sessOut = resolve(outdir, 'mpSession.mjs')
  const src = await bundleTo('src/renderer/src/features/play/online/mpSession.ts', sessOut)
  ok(!/from\s*["']electron["']/.test(src), 'mpSession bundle has no electron import')
  ok(
    !/require\(\s*["']trystero/.test(src) && !/from\s*["']trystero/.test(src),
    'mpSession bundle has no trystero import'
  )
  ok(!/require\(\s*["']node:/.test(src) && !/from\s*["']node:/.test(src), 'mpSession bundle has no node: import')
  const mod = await import(pathToFileURL(sessOut).href)
  const { MpNetSession, __setMpTimingForTests } = mod
  ok(typeof MpNetSession === 'function', 'mpSession.ts bundled & MpNetSession exported')
  ok(typeof __setMpTimingForTests === 'function', '__setMpTimingForTests test-hook exported')

  const wireOut = resolve(outdir, 'wire.mjs')
  await bundleTo('src/shared/mp/wire.ts', wireOut)
  const wire = await import(pathToFileURL(wireOut).href)

  // Shrink every watchdog window so timers fire in ms, not tens of seconds.
  // (Production defaults live in mpSession.ts; this is the documented test hook.)
  // The abort watchdog fires on REAL elapsed time (not the injected monotonic
  // clock), so its default must be comfortably longer than any single suite's
  // real-world move latency. Otherwise it would spuriously abort mid-play. The
  // two dedicated abort-window suites shrink it locally to a few ms.
  const TIMING = {
    DISCOVERY_TIMEOUT_MS: 120,
    HANDSHAKE_WATCHDOG_MS: 120,
    FIRST_MOVE_ABORT_MS: 4000,
    HEARTBEAT_MS: 40,
    PEER_SILENCE_MS: 120,
    MAX_LAG_FORGIVE_MS: 250,
    GRACE_BY_CATEGORY: { Bullet: 200, Blitz: 250, Rapid: 300, Classical: 350, Unlimited: 300 }
  }
  __setMpTimingForTests(TIMING)
  /** Temporarily shrink the abort window for a suite that must trip it fast. */
  const withAbortWindow = (ms, fn) => {
    __setMpTimingForTests({ FIRST_MOVE_ABORT_MS: ms })
    return Promise.resolve(fn()).finally(() => __setMpTimingForTests({ FIRST_MOVE_ABORT_MS: TIMING.FIRST_MOVE_ABORT_MS }))
  }

  // A controllable monotonic clock so clock-math tests don't depend on real time.
  // Each session gets its own; both usually share one so host/guest agree.
  function makeClock(start = 10_000) {
    let t = start
    return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) }
  }

  // Track sessions so a failure mid-suite still tears everything down.
  const live = []
  const track = (s) => (live.push(s), s)

  // Standard configs.
  const CFG = (initialMs, incrementMs = 0, hostColor = 'white') => ({
    tc: { initialMs, incrementMs },
    hostColor
  })

  // ==========================================================================
  // Helper: host + guest, handshake to 'start'. Returns everything wired up.
  // A shared injectable clock keeps host/guest clock math deterministic.
  // ==========================================================================
  async function connectPair(cfg, { clock, hostName, guestName } = {}) {
    const pair = makeMockPair()
    const opts = clock ? { now: clock.now } : {}
    const host = track(new MpNetSession(pair.hostFactory, opts))
    const guest = track(new MpNetSession(pair.guestFactory, opts))
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(cfg, hostName)
    const r = await guest.join(code, guestName)
    eq(r.ok, true, 'guest.join(hosted code) → ok:true')
    const hStart = await waitEvent(he, (e) => e.type === 'start', { label: 'host start' })
    const gStart = await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start' })
    return { pair, host, guest, he, ge, code, hStart, gStart }
  }

  // ==========================================================================
  // 1. Room code + normalize + hello name sanitize
  // ==========================================================================
  console.log('\n· room code + normalize + name sanitize …')
  const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const { code } = await host.host(CFG(60_000, 1_000))
    ok(CROCKFORD.test(code), `host() returned a Crockford XXXXX-XXXXX code: ${code}`)
    ok(!/[ILOU]/.test(code.replace('-', '')), 'code avoids the ambiguous I/L/O/U letters')
    host.leave()
  }
  {
    const seen = new Set()
    let allWellFormed = true
    for (let i = 0; i < 100; i++) {
      const c = wire.generateRoomCode()
      if (!CROCKFORD.test(c)) allWellFormed = false
      seen.add(c)
    }
    ok(allWellFormed, '100 generated codes are all well-formed Crockford XXXXX-XXXXX')
    eq(seen.size, 100, '100 generated codes are all unique')
  }
  const canonical = wire.generateRoomCode()
  const bare = canonical.replace('-', '')
  eq(wire.normalizeRoomCode(bare.toLowerCase()), canonical, 'normalize: lowercase, no hyphen → canonical')
  eq(wire.normalizeRoomCode(` ${bare.slice(0, 5)} - ${bare.slice(5)} `), canonical, 'normalize: stray spaces/hyphens stripped')
  eq(wire.normalizeRoomCode('oIl00-00000'), '01100-00000', 'normalize: o→0, i/l→1')
  eq(wire.normalizeRoomCode('short'), null, 'normalize: too short → null')
  eq(wire.normalizeRoomCode('UUUUU-UUUUU'), null, 'normalize: U not in alphabet → null')
  // Name sanitize (MP-09): control chars stripped, whitespace collapsed, ≤24.
  eq(wire.sanitizeName('  Bobby   Fischer  '), 'Bobby Fischer', 'sanitizeName trims + collapses whitespace')
  eq(wire.sanitizeName('a\x00b\x1fc\x7f'), 'abc', 'sanitizeName strips control chars')
  eq(wire.sanitizeName('x'.repeat(40)).length, 24, 'sanitizeName clamps to MAX_NAME_LEN (24)')
  eq(wire.sanitizeName('   '), undefined, 'sanitizeName → undefined when nothing usable remains')
  // hello role guest×guest failure is exercised in §16.

  // Guest join() rejects a bad code WITHOUT touching the transport.
  {
    let touched = false
    const guest = track(new MpNetSession(() => { touched = true; throw new Error('nope') }))
    const r = await guest.join('!!!!!-@@@@@')
    eq(r.ok, false, 'join(bad code) → ok:false')
    ok(!!r.error, 'join(bad code) → has an error message')
    ok(!touched, 'join(bad code) never creates a transport')
    guest.leave()
  }

  // ==========================================================================
  // 2. Handshake + colors + names on start (white / black / random)
  // ==========================================================================
  console.log('\n· handshake + colors + names …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const guest = track(new MpNetSession(pair.guestFactory))
    const hLog = []
    host.onEvent((ev) => hLog.push(ev))
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(CFG(60_000, 1_000), 'Alice')
    await guest.join(code, 'Bob')
    const hStart = await waitEvent(he, (e) => e.type === 'start', { label: 'host start' })
    const gStart = await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start' })
    eq(hStart.yourColor, 'white', 'host start: host is white')
    eq(gStart.yourColor, 'black', 'guest start: guest is black')
    eq(hStart.gameId, 1, 'first game gameId is 1')
    eq(gStart.gameId, 1, 'guest adopts gameId 1')
    eq(hStart.config.tc.initialMs, 60_000, 'host start carries the time control')
    eq(gStart.config.tc.incrementMs, 1_000, 'guest start carries the increment')
    eq(hStart.opponentName, 'Bob', 'host start carries guest name (opponentName)')
    eq(gStart.opponentName, 'Alice', 'guest start carries host name (opponentName)')
    const pjIdx = hLog.findIndex((e) => e.type === 'peer-joined')
    const startIdx = hLog.findIndex((e) => e.type === 'start')
    ok(pjIdx >= 0 && pjIdx < startIdx, 'host peer-joined precedes start')
    host.leave(); guest.leave()
  }
  {
    const { host, guest, hStart, gStart } = await connectPair(CFG(60_000, 0, 'black'))
    eq(hStart.yourColor, 'black', 'host start: host is black')
    eq(gStart.yourColor, 'white', 'guest start: guest is white')
    host.leave(); guest.leave()
  }
  {
    let sawWhite = false, sawBlack = false
    for (let i = 0; i < 20; i++) {
      const { host, guest, hStart, gStart } = await connectPair(CFG(60_000, 0, 'random'))
      ok(hStart.yourColor !== gStart.yourColor, `random trial #${i}: colors opposite`)
      if (hStart.yourColor === 'white') sawWhite = true
      else sawBlack = true
      host.leave(); guest.leave()
    }
    ok(sawWhite && sawBlack, 'random hostColor yields both white and black hosts across trials')
  }

  // ==========================================================================
  // 3. First-move grace (D1/MP-03): white move1 debits 0 / no increment; black
  //    clock starts after; black move1 is normal Fischer.
  // ==========================================================================
  console.log('\n· first-move grace (white move1 free, black clock starts after) …')
  {
    const INITIAL = 60_000, INC = 1_000
    const clock = makeClock()
    const { host, guest, he, ge } = await connectPair(CFG(INITIAL, INC), { clock })

    // Before any move both clocks IDLE at INITIAL. Idle 5s of monotonic time:
    // NO debit should accrue to white (turnStartedAt unset).
    clock.advance(5_000)
    // White's first move (host is white). Debits 0, NO increment.
    const r1 = await host.sendMove('e2e4')
    eq(r1.ok, true, 'white first move ok')
    const gm1 = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'guest sees e2e4' })
    eq(gm1.clockMs.white, INITIAL, 'white move1 debits 0 (clock unchanged)')
    ok(gm1.clockMs.white <= INITIAL, 'white move1 credits NO increment (no gain over INITIAL)')
    eq(gm1.clockMs.black, INITIAL, 'black clock still full after white move1')

    // Now black's clock is running. Black thinks 800ms then replies. Normal
    // Fischer debit + increment on black.
    clock.advance(800)
    const r2 = await guest.sendMove('e7e5')
    eq(r2.ok, true, 'black first move ok')
    const hm2 = await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'host sees e7e5' })
    const blackSpent = INITIAL + INC - hm2.clockMs.black
    approx(blackSpent, 800, 30, 'black move1 debits its think time (Fischer)')
    ok(hm2.clockMs.black > INITIAL - 800 && hm2.clockMs.black <= INITIAL + INC, 'black clock got the increment')
    eq(hm2.clockMs.white, INITIAL, 'white clock still INITIAL after black move1 (white never ran yet)')

    // White's move 2 now debits normally (white's clock has been running since e7e5).
    clock.advance(1_200)
    await host.sendMove('g1f3')
    const gm3 = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'g1f3', { label: 'guest sees g1f3' })
    const whiteSpent = INITIAL + INC - gm3.clockMs.white
    approx(whiteSpent, 1_200, 30, 'white move2 debits its think time (clock now running)')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 4. Abort watchdogs. BOTH windows.
  //    (a) no white move within grace → abort no-first-move (both sides).
  //    (b) white moves, no black reply within grace → abort (both sides).
  //    (c) manual abort only while plyCount < 2; refused at ply ≥ 2.
  //    (d) watchdog re-arm when it fires early (residual still > 0).
  // ==========================================================================
  console.log('\n· abort watchdog window A (no white move) …')
  await withAbortWindow(150, async () => {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    const ha = await waitEvent(he, (e) => e.type === 'abort', { label: 'host abort A', timeout: 1500 })
    const ga = await waitEvent(ge, (e) => e.type === 'abort', { label: 'guest abort A', timeout: 1500 })
    eq(ha.reason, 'no-first-move', 'host: abort reason no-first-move (window A)')
    eq(ga.reason, 'no-first-move', 'guest: abort reason no-first-move (window A)')
    eq((await host.sendMove('e2e4')).ok, false, 'move after abort refused')
    host.leave(); guest.leave()
  })
  console.log('\n· abort watchdog window B (white moved, no black reply) …')
  await withAbortWindow(150, async () => {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    await host.sendMove('e2e4') // white moves in time; re-arms the abort for black
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'guest e2e4 (window B setup)' })
    // Now black must reply within grace; it never does → abort.
    const ha = await waitEvent(he, (e) => e.type === 'abort', { label: 'host abort B', timeout: 1500 })
    const ga = await waitEvent(ge, (e) => e.type === 'abort', { label: 'guest abort B', timeout: 1500 })
    eq(ha.reason, 'no-first-move', 'host: abort reason no-first-move (window B)')
    eq(ga.reason, 'no-first-move', 'guest: abort reason no-first-move (window B)')
    host.leave(); guest.leave()
  })
  console.log('\n· manual abort ply<2 only …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    // Abort at ply 0 works.
    const a0 = await host.abort()
    eq(a0.ok, true, 'manual abort at ply 0 ok')
    const ha = await waitEvent(he, (e) => e.type === 'abort' && e.reason === 'manual', { label: 'host manual abort' })
    await waitEvent(ge, (e) => e.type === 'abort' && e.reason === 'manual', { label: 'guest manual abort' })
    ok(ha.reason === 'manual', 'manual abort carries reason manual')
    host.leave(); guest.leave()
  }
  {
    const { host, guest, he } = await connectPair(CFG(60_000, 0))
    await host.sendMove('e2e4')
    await waitEvent(he, () => false, {}).catch(() => {}) // (no-op; keep style)
    // Wait for guest to be at ply1, then black replies → ply 2.
    await sleep(20)
    await guest.sendMove('e7e5')
    await sleep(30)
    // Now plyCount is 2 on the host → manual abort refused.
    const a2 = await host.abort()
    eq(a2.ok, false, 'manual abort refused once plyCount ≥ 2')
    host.leave(); guest.leave()
  }
  console.log('\n· flag watchdog re-arm on early fire (residual > 0) …')
  {
    // The flag watchdog, on fire, recomputes remaining from the monotonic base
    // and re-arms if remaining > 0 (D3: never trust timer punctuality). We prove
    // it by FREEZING the injected monotonic clock so, from the session's view,
    // the on-move side never actually loses time. Every real-timer fire sees a
    // positive residual and must re-arm rather than flag. Only once we ADVANCE
    // the monotonic clock past the budget does a subsequent fire flag.
    //
    // We must be PAST the first-move phase first (both sides moved → ply 2 → the
    // abort watchdog is cleared), otherwise the abort watchdog would end the game
    // on frozen time. So: white e2e4 (frozen), advance a hair so black's clock
    // isn't already 0, black e7e5, then FREEZE with white on move and a running
    // clock, and test white's flag re-arm.
    const clock = makeClock()
    const { host, guest, he, ge } = await connectPair(CFG(400, 0), { clock })
    await host.sendMove('e2e4') // white move1 free → black running
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'e2e4 (rearm)' })
    clock.advance(50) // black spends 50ms
    await guest.sendMove('e7e5') // black replies → ply 2, abort watchdog cleared, white running
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'e7e5 (rearm)' })
    // White (host) is now on move with ~400ms and a FROZEN clock. Over real time,
    // the flag timer keeps firing early (residual 400 > 0) and re-arming. Never
    // flagging: because the monotonic base doesn't move.
    await assertNoEvent(he, (e) => e.type === 'flag', 300, 'flag while injected clock frozen (watchdog re-arms)')
    // Advance the monotonic clock past white's budget; the next re-armed fire
    // (within one flag-cycle) now sees remaining < 0 and flags white.
    clock.advance(600)
    const hf = await waitEvent(he, (e) => e.type === 'flag', { label: 'host flag after real timeout', timeout: 2000 })
    eq(hf.by, 'white', 'flag by white once its monotonic budget truly expires (post re-arm)')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 5. Flag emits 'flag' (NOT resign) with the loser zeroed, on both sides.
  // ==========================================================================
  console.log('\n· flag emits flag (not resign), loser zeroed, both sides …')
  {
    // Get PAST the first-move phase (both sides move → ply 2 → the abort watchdog
    // is cleared) so the flag watchdog (not the abort watchdog) is what fires.
    // Then let white (on move) run out: it flags, sending+emitting `flag` (never
    // `resign`) with white zeroed, on BOTH sides.
    const clock = makeClock()
    const { host, guest, he, ge } = await connectPair(CFG(300, 0), { clock })
    await host.sendMove('e2e4') // white move1 free → black running
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'guest e2e4' })
    clock.advance(50) // black uses 50ms
    await guest.sendMove('e7e5') // black replies → ply 2; white now running with ~300ms
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'host e7e5' })
    // White never moves; advance monotonic clock past its budget → white flags.
    clock.advance(400)
    const hf = await waitEvent(he, (e) => e.type === 'flag', { label: 'host flag', timeout: 1500 })
    const gf = await waitEvent(ge, (e) => e.type === 'flag', { label: 'guest flag', timeout: 1500 })
    eq(hf.by, 'white', 'host: flag.by is the loser (white)')
    eq(gf.by, 'white', 'guest: flag.by is the loser (white)')
    eq(hf.clockMs.white, 0, 'host: flagged side (white) zeroed in flag.clockMs')
    eq(gf.clockMs.white, 0, 'guest: flagged side (white) zeroed in flag.clockMs')
    // Never a resign for a flag.
    await assertNoEvent(he, (e) => e.type === 'resign', 40, 'resign event on a flag (must be none)')
    eq((await host.sendMove('g1f3')).ok, false, 'move after flag refused')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 6. Moves relay both ways with authoritative clocks + increment.
  //    Out-of-turn guest move dropped. Untimed game.
  // ==========================================================================
  console.log('\n· moves + host-authoritative clocks (60s+1s, injected clock) …')
  {
    const INITIAL = 60_000, INC = 1_000, THINK = 500
    const clock = makeClock()
    const { host, guest, he, ge } = await connectPair(CFG(INITIAL, INC), { clock })
    let lastWhite = INITIAL, lastBlack = INITIAL
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6']
    for (let i = 0; i < moves.length; i++) {
      const uci = moves[i]
      const hostToMove = i % 2 === 0
      clock.advance(THINK)
      if (hostToMove) {
        eq((await host.sendMove(uci)).ok, true, `host.sendMove(${uci}) ok`)
        const gm = await waitEvent(ge, (e) => e.type === 'move' && e.uci === uci, { label: `guest sees ${uci}` })
        if (i === 0) {
          eq(gm.clockMs.white, INITIAL, 'white move1 free (no debit)')
        } else {
          const spent = lastWhite + INC - gm.clockMs.white
          approx(spent, THINK, 30, `white debit ≈ think on ${uci}`)
          eq(gm.clockMs.black, lastBlack, `black clock unchanged on white move ${uci}`)
        }
        lastWhite = gm.clockMs.white
      } else {
        eq((await guest.sendMove(uci)).ok, true, `guest.sendMove(${uci}) ok`)
        const hm = await waitEvent(he, (e) => e.type === 'move' && e.uci === uci, { label: `host sees ${uci}` })
        const spent = lastBlack + INC - hm.clockMs.black
        approx(spent, THINK, 30, `black debit ≈ think on ${uci}`)
        eq(hm.clockMs.white, lastWhite, `white clock unchanged on black move ${uci}`)
        lastBlack = hm.clockMs.black
        // The host also acks the guest move with a 'clock' event to the guest.
        const gc = await waitEvent(ge, (e) => e.type === 'clock', { label: `guest clock ack for ${uci}` })
        eq(gc.clockMs.black, hm.clockMs.black, 'guest clock ack carries authoritative black clock')
      }
    }
    // out-of-turn guest move dropped (white to move now).
    await guest.sendMove('a7a6')
    await assertNoEvent(he, (e) => e.type === 'move' && e.uci === 'a7a6', 80, 'host move from out-of-turn guest')
    host.leave(); guest.leave()
  }
  console.log('\n· untimed game (initialMs 0) …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(0, 0))
    await host.sendMove('e2e4')
    const gm = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'untimed move' })
    eq(gm.clockMs.white, 0, 'untimed: clocks stay 0')
    await guest.sendMove('e7e5')
    const hm = await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'untimed guest move' })
    eq(hm.clockMs.black, 0, 'untimed: guest move relayed with 0 clocks')
    await guest.sendMove('a7a6')
    await assertNoEvent(he, (e) => e.type === 'move' && e.uci === 'a7a6', 60, 'untimed out-of-turn move')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 7. RTT lag compensation bounds (D11): a guest move is forgiven min(rtt/2,250).
  // ==========================================================================
  console.log('\n· RTT lag compensation bounds (guest debit forgiven) …')
  {
    // With NO measured rtt (rtt=0) forgiveness is 0. With a large rtt the host
    // forgives at most MAX_LAG_FORGIVE_MS of the guest's debit. We drive both.
    const INITIAL = 60_000
    const clock = makeClock()
    const { host, guest, he, ge } = await connectPair(CFG(INITIAL, 0), { clock })
    // Get to black's turn (white move1 free).
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'e2e4' })
    // Baseline (rtt≈0): black thinks 1000ms → ~1000ms debited.
    clock.advance(1_000)
    await guest.sendMove('e7e5')
    const hm = await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'black e7e5' })
    const debitNoRtt = INITIAL - hm.clockMs.black
    approx(debitNoRtt, 1_000, 40, 'no-RTT guest debit ≈ raw think time')
    host.leave(); guest.leave()
  }
  {
    // Now with an inflated RTT: the host forgives min(rtt/2, 250ms) of a guest
    // move's debit. We set the host's rtt estimate DIRECTLY by feeding it a `pong`
    // whose echoed timestamp is backdated (onPong computes rtt = now − ts) so
    // no clock advance (which would itself burn the on-move clock) is needed.
    const INITIAL = 60_000
    const clock = makeClock()
    const { host, guest, he, ge, pair } = await connectPair(CFG(INITIAL, 0), { clock })
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'e2e4 (lag)' })
    // Pin the host's RTT via the dedicated test seam. (RTT is measured with REAL
    // monotonic time since the Windows-CI fix: injected-clock tricks and crafted
    // pongs can no longer influence it, and real heartbeat pongs would EMA-decay
    // any transient value; the pin freezes it at exactly 800.)
    host.__setRttForTests(800)
    // Black thinks exactly 1000ms of monotonic time, then moves. The host debits
    // 1000 − forgiveness. With rtt≈800 the cap (250ms) applies, so debit ≈ 750.
    clock.advance(1_000)
    await guest.sendMove('e7e5')
    const hm = await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'black e7e5 (lag)' })
    const debit = INITIAL - hm.clockMs.black
    ok(debit < 1_000, `some lag was forgiven (${debit.toFixed(0)}ms < 1000ms)`)
    ok(debit >= 1_000 - TIMING.MAX_LAG_FORGIVE_MS - 30, `forgiveness never exceeds the cap (${debit.toFixed(0)}ms ≥ ~750ms)`)
    approx(debit, 1_000 - TIMING.MAX_LAG_FORGIVE_MS, 40, `lag-compensated debit ≈ think − cap (${debit.toFixed(0)}ms)`)
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 8. gameId filtering (D8): a stale-game resign is dropped; ply dup / OOO drop.
  // ==========================================================================
  console.log('\n· gameId filtering (stale-game resign dropped) …')
  {
    const { host, guest, he, pair } = await connectPair(CFG(60_000, 0))
    // The current gameId is 1. Inject a resign addressed to gameId 99 from the
    // guest's transport (slot 1 by join order); the host must DROP it.
    const gm = [...pair.room.members.values()][1]
    gm.transport.send(JSON.stringify({ t: 'resign', gameId: 99, by: 'black' }))
    await assertNoEvent(he, (e) => e.type === 'resign', 80, 'stale-gameId resign (dropped)')
    // A correct-gameId resign still works.
    gm.transport.send(JSON.stringify({ t: 'resign', gameId: 1, by: 'black' }))
    await waitEvent(he, (e) => e.type === 'resign' && e.by === 'black', { label: 'current-gameId resign delivered' })
    ok(true, 'current-gameId resign is honored')
    host.leave(); guest.leave()
  }
  console.log('\n· ply dup / out-of-order move dropped …')
  {
    const { host, guest, he, ge, pair } = await connectPair(CFG(60_000, 0))
    // White (host) opens; the guest applies it. The NEXT expected inbound ply on
    // the host is 1 (black's reply).
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'e2e4' })
    const gm = [...pair.room.members.values()][1]
    // A move at the WRONG ply (0, already consumed) must be dropped by the host.
    gm.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 0, uci: 'e7e5', clockMs: { white: 60000, black: 60000 } }))
    await assertNoEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', 80, 'duplicate/old ply move (dropped)')
    // A move at a FUTURE ply (5) is also dropped (out of order).
    gm.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 5, uci: 'd7d5', clockMs: { white: 60000, black: 60000 } }))
    await assertNoEvent(he, (e) => e.type === 'move' && e.uci === 'd7d5', 80, 'future-ply move (dropped)')
    // The correct ply (1) is accepted.
    gm.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 1, uci: 'c7c5', clockMs: { white: 60000, black: 60000 } }))
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'c7c5', { label: 'correct-ply move accepted' })
    ok(true, 'correct-ply move is accepted after dropping bad plies')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 9. Draw semantics: offer + accept; move clears offer; offer-back = accept;
  //    decline + ply gate + 20-ply cooldown.
  // ==========================================================================
  console.log('\n· draw offer gate (< ply 2 refused) + accept …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    // Before ply 2 (no moves), offers are refused by the offer gate.
    eq((await guest.offerDraw()).ok, false, 'draw offer before ply 2 refused')
    // Play two plies so offers become legal.
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'e2e4' })
    await guest.sendMove('e7e5')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'e7e5' })
    // Now the guest may offer.
    eq((await guest.offerDraw()).ok, true, 'draw offer at ply 2 ok')
    await waitEvent(he, (e) => e.type === 'drawOffer', { label: 'host drawOffer' })
    eq((await host.acceptDraw()).ok, true, 'host.acceptDraw() ok')
    await waitEvent(he, (e) => e.type === 'drawAccept', { label: 'host drawAccept' })
    await waitEvent(ge, (e) => e.type === 'drawAccept', { label: 'guest drawAccept' })
    eq((await host.sendMove('g1f3')).ok, false, 'move after draw refused')
    host.leave(); guest.leave()
  }
  console.log('\n· draw offer answered by a move (offer cleared) …')
  {
    const { host, guest, he } = await connectPair(CFG(60_000, 0))
    await host.sendMove('e2e4')
    await sleep(20)
    await guest.sendMove('e7e5')
    await sleep(20)
    await guest.offerDraw()
    await waitEvent(he, (e) => e.type === 'drawOffer', { label: 'host sees guest offer' })
    const mv = await host.sendMove('g1f3')
    eq(mv.ok, true, 'host answers the offer with a move')
    eq((await host.acceptDraw()).ok, false, 'acceptDraw after answering with a move is a no-op')
    host.leave(); guest.leave()
  }
  console.log('\n· offer-back = accept …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    await host.sendMove('e2e4'); await sleep(20)
    await guest.sendMove('e7e5'); await sleep(20)
    await host.offerDraw()
    await waitEvent(ge, (e) => e.type === 'drawOffer', { label: 'guest sees host offer' })
    eq((await guest.offerDraw()).ok, true, 'guest offer-back returns ok')
    await waitEvent(he, (e) => e.type === 'drawAccept', { label: 'host drawAccept via offer-back' })
    await waitEvent(ge, (e) => e.type === 'drawAccept', { label: 'guest drawAccept via offer-back' })
    host.leave(); guest.leave()
  }
  console.log('\n· draw decline + 20-ply cooldown …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    // Get to a deep-enough ply that a +20 cooldown is testable but reachable.
    // Play 4 plies (ply count 4). Guest offers; host declines → guest (black) is
    // blocked from re-offering until ply 4 + 20 = 24.
    const opening = ['e2e4', 'e7e5', 'g1f3', 'b8c6']
    for (let i = 0; i < opening.length; i++) {
      const u = opening[i]
      if (i % 2 === 0) { await host.sendMove(u); await waitEvent(ge, (e) => e.type === 'move' && e.uci === u, { label: u }) }
      else { await guest.sendMove(u); await waitEvent(he, (e) => e.type === 'move' && e.uci === u, { label: u }) }
    }
    eq((await guest.offerDraw()).ok, true, 'guest offers a draw at ply 4')
    await waitEvent(he, (e) => e.type === 'drawOffer', { label: 'host sees offer to decline' })
    eq((await host.declineDraw()).ok, true, 'host.declineDraw() ok')
    await waitEvent(he, (e) => e.type === 'drawDecline', { label: 'host local drawDecline' })
    await waitEvent(ge, (e) => e.type === 'drawDecline', { label: 'guest sees drawDecline' })
    // Guest re-offers immediately: host must DROP it (cooldown), no drawOffer.
    await guest.offerDraw()
    await assertNoEvent(he, (e) => e.type === 'drawOffer', 100, 'guest re-offer within cooldown (dropped by host gate)')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 10. Resign → 'resign' (not flag) with the resigner as by, both sides.
  // ==========================================================================
  console.log('\n· resign surfaces on both sides …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    // Make it a real game (≥ moves). Resign is legal any time in-game.
    await host.sendMove('e2e4'); await sleep(15)
    eq((await guest.resign()).ok, true, 'guest.resign() ok')
    const gr = await waitEvent(ge, (e) => e.type === 'resign', { label: 'guest local resign' })
    const hr = await waitEvent(he, (e) => e.type === 'resign', { label: 'host sees resign' })
    eq(gr.by, 'black', 'resigning guest is black')
    eq(hr.by, 'black', 'host sees the guest (black) resigned')
    eq((await host.sendMove('g1f3')).ok, false, 'move after resign refused')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 11. gameEnded (board-terminal) stops clocks + relays gameOver both sides.
  // ==========================================================================
  console.log('\n· gameEnded relays gameOver + stops clocks …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    await host.sendMove('e2e4'); await sleep(15)
    await guest.sendMove('e7e5'); await sleep(15)
    // Store would call this on checkmate/stalemate; drive it directly.
    const r = await host.gameEnded('1-0', 'checkmate')
    eq(r.ok, true, 'host.gameEnded ok')
    const ho = await waitEvent(he, (e) => e.type === 'gameOver', { label: 'host gameOver' })
    const go = await waitEvent(ge, (e) => e.type === 'gameOver', { label: 'guest gameOver' })
    eq(ho.result, '1-0', 'host gameOver result 1-0')
    eq(go.result, '1-0', 'guest gameOver result 1-0')
    eq(go.reason, 'checkmate', 'guest gameOver reason relayed')
    eq((await host.sendMove('g1f3')).ok, false, 'move after gameOver refused')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 12. Rematch symmetric: single-side offer does NOT start; mutual starts,
  //     colors swap, gameId increments.
  // ==========================================================================
  console.log('\n· rematch symmetric (single side no-op; mutual swaps + gameId+1) …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 1_000))
    await host.resign()
    await waitEvent(he, (e) => e.type === 'resign', { label: 'pre-rematch resign' })
    await waitEvent(ge, (e) => e.type === 'resign', { label: 'pre-rematch resign guest' })
    // Only the HOST offers a rematch: it must NOT start (waiting on the guest).
    await host.offerRematch()
    await waitEvent(ge, (e) => e.type === 'rematchOffer', { label: 'guest sees host offer' })
    await assertNoEvent(he, (e) => e.type === 'rematchStart', 100, 'rematchStart on a single-side offer (must be none)')
    // Guest offers too → mutual → host starts.
    await guest.offerRematch()
    const hre = await waitEvent(he, (e) => e.type === 'rematchStart', { label: 'host rematchStart' })
    const gre = await waitEvent(ge, (e) => e.type === 'rematchStart', { label: 'guest rematchStart' })
    eq(hre.yourColor, 'black', 'rematch: host now black (swapped)')
    eq(gre.yourColor, 'white', 'rematch: guest now white (swapped)')
    eq(hre.gameId, 2, 'rematch gameId incremented to 2')
    eq(gre.gameId, 2, 'guest adopts rematch gameId 2')
    // New game live: guest is white → host (black) cannot move first.
    eq((await host.sendMove('e2e4')).ok, false, 'rematch: host (black) cannot move first')
    host.leave(); guest.leave()
  }
  console.log('\n· rematch mutual when GUEST offers first …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    await guest.resign()
    await waitEvent(he, (e) => e.type === 'resign', { label: 'resign' })
    await waitEvent(ge, (e) => e.type === 'resign', { label: 'resign g' })
    // Guest offers first (symmetric): host must not start yet.
    await guest.offerRematch()
    await waitEvent(he, (e) => e.type === 'rematchOffer', { label: 'host sees guest offer' })
    await assertNoEvent(he, (e) => e.type === 'rematchStart', 80, 'no start on guest-only offer')
    // Host offers → mutual → start.
    await host.offerRematch()
    await waitEvent(he, (e) => e.type === 'rematchStart', { label: 'host rematchStart (guest-first)' })
    await waitEvent(ge, (e) => e.type === 'rematchStart', { label: 'guest rematchStart (guest-first)' })
    ok(true, 'guest-first mutual rematch starts')
    host.leave(); guest.leave()
  }
  console.log('\n· rematch decline clears both offers …')
  {
    const { host, guest, he, ge } = await connectPair(CFG(60_000, 0))
    await host.resign()
    await waitEvent(he, (e) => e.type === 'resign', { label: 'resign' })
    await waitEvent(ge, (e) => e.type === 'resign', { label: 'resign g' })
    await host.offerRematch()
    await waitEvent(ge, (e) => e.type === 'rematchOffer', { label: 'guest sees offer' })
    await guest.declineRematch()
    await waitEvent(ge, (e) => e.type === 'rematchDecline', { label: 'guest local decline' })
    await waitEvent(he, (e) => e.type === 'rematchDecline', { label: 'host sees decline' })
    // Now the host offering again should NOT auto-start (guest offer cleared).
    await host.offerRematch()
    await assertNoEvent(he, (e) => e.type === 'rematchStart', 80, 'no start after decline reset both offers')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 13. THE L1 REGRESSION: listeners survive leave(); host→leave→host delivers
  //     events to a subscription taken BEFORE the first leave.
  // ==========================================================================
  console.log('\n· L1: listeners survive leave(); host→leave→host still delivers …')
  {
    // One host session (mirrors the app's `mp` singleton) reused across a
    // host→leave→host cycle. A single subscription taken up front must keep
    // receiving events after leave() + re-host + a new guest joining.
    const room = makeRoom()
    const created = []
    const factory = (code, listeners) => { const { transport, self } = room.join(listeners); created.push(self); return transport }
    const host = track(new MpNetSession(factory))
    const allHostEvents = []
    host.onEvent((ev) => allHostEvents.push(ev)) // subscribed ONCE, before any leave
    const { code: code1 } = await host.host(CFG(60_000, 0))
    void code1
    host.leave() // L1: this must NOT clear the subscription
    // Re-host on the SAME session; a fresh guest joins the new code.
    const { code: code2 } = await host.host(CFG(60_000, 0))
    const guest = track(new MpNetSession(factory))
    const ge = tap(guest)
    await guest.join(code2)
    // The pre-leave subscription must see the new game's 'start'.
    await waitEvent(allHostEvents, (e) => e.type === 'start', { label: 'host start after re-host (L1)', timeout: 2000 })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start after re-host' })
    ok(true, 'L1 fixed: the up-front subscription still receives events after leave()+re-host')
    // And the re-hosted game actually works end-to-end.
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'move on re-hosted game' })
    ok(true, 'L1 fixed: re-hosted game relays moves to the guest')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 14. Handshake watchdog (L8): host bonds a silent peer, unbonds after the
  //     window, accepts the NEXT peer.
  // ==========================================================================
  console.log('\n· handshake watchdog unbonds a silent peer, next peer accepted …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const he = tap(host)
    await host.host(CFG(60_000, 0))
    // A bare peer joins but NEVER sends a hello (silent). The host bonds it, then
    // the handshake watchdog fires (120ms) → unbond → 'net searching'.
    const silent = pair.injectPeer()
    await waitEvent(he, (e) => e.type === 'net' && e.state === 'searching', { label: 'host unbonds silent peer', timeout: 1000 })
    ok(true, 'host unbonded the silent peer after the handshake window (L8)')
    // Now a REAL guest joins and completes the handshake → start.
    const guest = track(new MpNetSession(pair.guestFactory))
    const ge = tap(guest)
    // Need the guest to reach the same room. Re-derive the code from the host.
    // (The host is still hosting; use a fresh pair-bound guest via the same room.)
    const { transport: gtrans } = pair.room.join({
      onMessage: (text, from) => {
        const m = wire.parseWireMsg(text)
        if (m && m.t === 'hello') {
          // Answer the host's hello with a valid guest hello to complete handshake.
          gtrans.send(JSON.stringify(wire.makeHello('guest', 'LateGuest')), from)
        }
      },
      onPeerJoin: () => {},
      onPeerLeave: () => {}
    })
    void guest; void ge
    await waitEvent(he, (e) => e.type === 'start', { label: 'host start with the next peer', timeout: 1500 })
    ok(true, 'host accepted the next peer after unbonding the silent one')
    silent.leave(); gtrans.close()
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 15. Suspend / resume (T2/T3/T4/L6/D9/MP-06). The big one.
  //   peer-leave → suspend (clock paused; NO debit over the pause) → same-peer
  //   rebond → resync (moves + clocks match) → new-peer-during-suspend refused →
  //   grace expiry peer-left + claimVictory gameOver.
  // ==========================================================================
  console.log('\n· suspend pauses clocks (no debit over a 300ms pause) …')
  {
    const INITIAL = 60_000
    const clock = makeClock()
    // Build a host + a guest we can leave and RE-JOIN with the same peerId.
    const room = makeRoom()
    const created = []
    const factory = (code, listeners) => { const { transport, self } = room.join(listeners); created.push(self); return transport }
    const host = track(new MpNetSession(factory, { now: clock.now }))
    const he = tap(host)
    const { code } = await host.host(CFG(INITIAL, 0))
    // Guest joins via a controllable bare member so we can drop + rejoin its id.
    // On a REBOND (resuming=true) it answers the host's hello and then asks for a
    // resync (resumeReq) exactly like a real guest session would (D9). It tracks
    // its own ply from the moves it has seen so havePly is honest.
    let guestId = null
    const guestInbox = []
    let guestHavePly = 0
    const mkGuestMember = (reuseId, resuming) => {
      const member = room.join(
        {
          onMessage: (text, from) => {
            const m = wire.parseWireMsg(text)
            if (!m) return
            guestInbox.push(m)
            if (m.t === 'hello') {
              member.transport.send(JSON.stringify(wire.makeHello('guest', 'Ghost')), from)
              // A rejoining guest asks the host to resume from where it left off.
              if (resuming) {
                member.transport.send(JSON.stringify({ t: 'resumeReq', gameId: 1, havePly: guestHavePly }), from)
              }
            }
            if (m.t === 'move') guestHavePly = m.ply + 1
          },
          onPeerJoin: () => {},
          onPeerLeave: () => {}
        },
        reuseId ? { peerId: reuseId } : {}
      )
      return member
    }
    let guestMember = mkGuestMember()
    guestId = guestMember.peerId
    await waitEvent(he, (e) => e.type === 'start', { label: 'host start (suspend suite)' })
    // White (host) opens so the clock is running on black; then black replies so
    // both have moved and white's clock is running.
    await host.sendMove('e2e4')
    await sleep(20)
    // Black replies via a raw move at ply 1.
    guestMember.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: INITIAL, black: INITIAL } }))
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'host sees e7e5' })
    // White's clock is now running. Drop the guest → suspend. We verify the
    // paused-time-not-debited property from the resync clocks below.
    guestMember.transport.close() // peer-leave → suspend
    const away = await waitEvent(he, (e) => e.type === 'peer-away', { label: 'host peer-away', timeout: 1500 })
    ok(away.graceMs > 0, 'peer-away carries a positive grace window')
    // Advance the monotonic clock 300ms DURING the pause. Because the clock is
    // paused, this time must NOT be debited to white when we resume.
    clock.advance(300)
    // Rebond with the SAME peerId → resume, then a hello completes the handshake,
    // guest asks resumeReq, host answers resync.
    guestMember = mkGuestMember(guestId, true)
    // The rebond onPeerJoin fires; then the host greets and the guest hello lands.
    await waitEvent(he, (e) => e.type === 'peer-back', { label: 'host peer-back', timeout: 1500 })
    ok(true, 'same-peer rebond emits peer-back')
    // The guest should receive a resync from the host after its resumeReq.
    const resync = await waitEvent(guestInbox, (m) => m.t === 'resync', { label: 'guest resync', timeout: 1500 })
    eq(resync.moves.length, 2, 'resync carries the full move list (2 plies)')
    eq(resync.moves[0], 'e2e4', 'resync move[0] is e2e4')
    eq(resync.moves[1], 'e7e5', 'resync move[1] is e7e5')
    eq(resync.yourColor, 'black', 'resync tells the guest its color (black)')
    // The paused 300ms must not have burned white's clock: white in the resync is
    // still ~INITIAL (only the pre-pause running time, which was ~0 here).
    ok(resync.clockMs.white >= INITIAL - 50, 'clock NOT debited over the suspend pause (white ≈ INITIAL)')
    host.leave(); guestMember.transport.close()
  }
  console.log('\n· new peer during suspend is refused (game in progress) …')
  {
    const room = makeRoom()
    const created = []
    const factory = (code, listeners) => { const { transport, self } = room.join(listeners); created.push(self); return transport }
    const host = track(new MpNetSession(factory))
    const he = tap(host)
    await host.host(CFG(60_000, 0))
    // A guest joins + handshakes.
    const guestInbox = []
    const guest = room.join({
      onMessage: (text, from) => {
        const m = wire.parseWireMsg(text); if (!m) return; guestInbox.push(m)
        if (m.t === 'hello') guest.transport.send(JSON.stringify(wire.makeHello('guest', 'G')), from)
      },
      onPeerJoin: () => {}, onPeerLeave: () => {}
    })
    await waitEvent(he, (e) => e.type === 'start', { label: 'start (new-peer-during-suspend)' })
    await host.sendMove('e2e4')
    await sleep(15)
    guest.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60000, black: 60000 } }))
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'e7e5' })
    guest.transport.close() // suspend
    await waitEvent(he, (e) => e.type === 'peer-away', { label: 'peer-away' })
    // A brand-NEW peer (different id) tries to join while suspended → refused with
    // a wire 'error' "game in progress" (the seat is taken by the ghost).
    const intruderInbox = [] // parsed WireMsgs
    const intruder = room.join({
      onMessage: (text) => { const m = wire.parseWireMsg(text); if (m) intruderInbox.push(m) },
      onPeerJoin: () => {}, onPeerLeave: () => {}
    })
    await waitEvent(intruderInbox, (m) => m.t === 'error' && /in progress/i.test(m.message), {
      label: 'intruder game-in-progress error',
      timeout: 1500
    })
    ok(true, 'a NEW peer during suspend is refused with "game in progress"')
    intruder.transport.close(); guest.transport.close(); host.leave()
  }
  console.log('\n· grace expiry → peer-left → claimVictory gameOver …')
  {
    const room = makeRoom()
    const created = []
    const factory = (code, listeners) => { const { transport, self } = room.join(listeners); created.push(self); return transport }
    const host = track(new MpNetSession(factory))
    const he = tap(host)
    await host.host(CFG(60_000, 0)) // Unlimited? no: 60s = Rapid grace 300ms here
    const guest = room.join({
      onMessage: (text, from) => { const m = wire.parseWireMsg(text); if (m && m.t === 'hello') guest.transport.send(JSON.stringify(wire.makeHello('guest', 'G')), from) },
      onPeerJoin: () => {}, onPeerLeave: () => {}
    })
    await waitEvent(he, (e) => e.type === 'start', { label: 'start (grace expiry)' })
    await host.sendMove('e2e4'); await sleep(15)
    guest.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60000, black: 60000 } }))
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'e7e5' })
    guest.transport.close()
    await waitEvent(he, (e) => e.type === 'peer-away', { label: 'peer-away (grace expiry)' })
    // Let the grace timer (300ms for 60s Rapid here) expire without a rebond.
    const left = await waitEvent(he, (e) => e.type === 'peer-left', { label: 'host peer-left after grace', timeout: 2000 })
    void left
    // The still-present host claims victory → gameOver reason 'opponent left'.
    const cv = await host.claimVictory()
    eq(cv.ok, true, 'claimVictory ok after peer-left')
    const go = await waitEvent(he, (e) => e.type === 'gameOver', { label: 'host gameOver (claim)' })
    eq(go.result, '1-0', 'claimVictory: host (white) records a win')
    eq(go.reason, 'opponent left', 'claimVictory reason is "opponent left"')
    host.leave()
  }

  // ==========================================================================
  // 16. hello role guest×guest failure (T5).
  // ==========================================================================
  console.log('\n· hello role guest×guest → friendly failure …')
  {
    const room = makeRoom()
    const created = []
    const factory = (code, listeners) => { const { transport, self } = room.join(listeners); created.push(self); return transport }
    const guest = track(new MpNetSession(factory))
    const ge = tap(guest)
    await guest.join(wire.generateRoomCode())
    // Another party in the room is ALSO a guest: it answers the guest's hello with
    // a guest-role hello → the joining guest must fail ("that code has no host").
    const otherGuest = room.join({
      onMessage: (text, from) => { const m = wire.parseWireMsg(text); if (m && m.t === 'hello') otherGuest.transport.send(JSON.stringify(wire.makeHello('guest', 'Other')), from) },
      onPeerJoin: () => {}, onPeerLeave: () => {}
    })
    const err = await waitEvent(ge, (e) => e.type === 'error', { label: 'guest×guest error', timeout: 1500 })
    ok(/no host/i.test(err.message), 'guest hearing hello{role:guest} fails with "no host"')
    otherGuest.transport.close(); guest.leave()
  }

  // ==========================================================================
  // 17. Heartbeat self-stall forgiveness (D4): a long tick gap must NOT declare
  //     the peer away (we were suspended, not them).
  // ==========================================================================
  console.log('\n· heartbeat self-stall forgiveness (long tick gap not judged) …')
  {
    // Use an injected clock we can JUMP forward to fake a frozen process. After a
    // huge gap the tick's self-stall branch resets lastPeerMsgAt and does NOT
    // enter suspend, so no peer-away fires from the stall itself.
    const clock = makeClock()
    const { host, guest, he } = await connectPair(CFG(60_000, 0), { clock })
    // Get a live game so the heartbeat is running and eligible to judge.
    await host.sendMove('e2e4'); await sleep(20)
    // Freeze the peer (no traffic) AND jump our own clock far forward: the tick
    // gap (now − lastTickAt) exceeds 2× cadence, so self-stall forgiveness applies.
    clock.advance(10_000)
    await sleep(120) // allow a couple of heartbeat ticks under the shrunk cadence
    await assertNoEvent(he, (e) => e.type === 'peer-away', 60, 'peer-away from a self-stall (must be forgiven)')
    host.leave(); guest.leave()
  }
  console.log('\n· heartbeat DOES declare peer-away on true silence …')
  {
    // Contrast: real one-sided silence (peer stops answering but our clock ticks
    // normally) DOES trip peer-away after the silence window + two strikes.
    const room = makeRoom()
    const created = []
    const factory = (code, listeners) => { const { transport, self } = room.join(listeners); created.push(self); return transport }
    const host = track(new MpNetSession(factory))
    const he = tap(host)
    await host.host(CFG(60_000, 0))
    // A guest that handshakes but then goes SILENT (ignores pings, no pong).
    const guest = room.join({
      onMessage: (text, from) => {
        const m = wire.parseWireMsg(text)
        if (m && m.t === 'hello') guest.transport.send(JSON.stringify(wire.makeHello('guest', 'G')), from)
        // Deliberately do NOT answer pings → the host hears silence.
      },
      onPeerJoin: () => {}, onPeerLeave: () => {}
    })
    await waitEvent(he, (e) => e.type === 'start', { label: 'start (silence)' })
    await host.sendMove('e2e4'); await sleep(15)
    guest.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60000, black: 60000 } }))
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'e7e5 (silence)' })
    // Now the guest answers nothing. With PEER_SILENCE 120ms + two strikes at 40ms
    // cadence, the host should declare peer-away within ~1s.
    const away = await waitEvent(he, (e) => e.type === 'peer-away', { label: 'peer-away on true silence', timeout: 2000 })
    ok(away.graceMs > 0, 'true silence → peer-away with a grace window')
    guest.transport.close(); host.leave()
  }

  // ==========================================================================
  // 18. Send-error injection (T6) → suspend path, no unhandled rejection.
  // ==========================================================================
  console.log('\n· send-error → suspend (T6) …')
  {
    const pair = makeMockPair()
    const clock = makeClock()
    const host = track(new MpNetSession(pair.hostFactory, { now: clock.now }))
    const guest = track(new MpNetSession(pair.guestFactory, { now: clock.now }))
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(CFG(60_000, 0))
    await guest.join(code)
    await waitEvent(he, (e) => e.type === 'start', { label: 'start (send-error)' })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start (send-error)' })
    await host.sendMove('e2e4'); await sleep(15)
    await guest.sendMove('e7e5')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'e7e5 (send-error)' })
    // Force the host's NEXT send (slot 0) to fail → onSendError → suspend path.
    pair.failNextSend(0)
    await host.sendMove('g1f3') // triggers a send that fails
    const away = await waitEvent(he, (e) => e.type === 'peer-away', { label: 'host peer-away from send error', timeout: 1500 })
    ok(away.graceMs > 0, 'a failed send enters the suspend/away path (T6), no unhandled rejection')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 19. Controllable delivery: out-of-order + lossy link handled gracefully.
  // ==========================================================================
  console.log('\n· controllable delivery: reordered relay still consistent …')
  {
    const pair = makeMockPair()
    const { host, guest, he, ge } = await (async () => {
      const h = track(new MpNetSession(pair.hostFactory))
      const g = track(new MpNetSession(pair.guestFactory))
      const hev = tap(h), gev = tap(g)
      const { code } = await h.host(CFG(60_000, 0))
      await g.join(code)
      await waitEvent(hev, (e) => e.type === 'start', { label: 'start (delivery)' })
      await waitEvent(gev, (e) => e.type === 'start', { label: 'guest start (delivery)' })
      return { host: h, guest: g, he: hev, ge: gev }
    })()
    // White plays two moves in quick succession while delivery is HELD, then we
    // flush REVERSED: the guest must drop the out-of-order first arrival and only
    // accept plies in order, so it never diverges.
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'e2e4 (delivery)' })
    await guest.sendMove('e7e5')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'e7e5 (delivery)' })
    // Now hold, queue two host moves, flush reversed.
    pair.room.hold()
    await host.sendMove('g1f3')
    await host.sendMove('h1g1').catch(() => {}) // illegal-ordered on host? it's white again only after black; this is out of turn → ok:false, no send
    pair.room.flushReversed()
    // The guest accepts g1f3 (ply 2) in order; any stray earlier/later ply is dropped.
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'g1f3', { label: 'g1f3 after reversed flush' })
    ok(true, 'reordered delivery: guest applies plies strictly in order')
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 20. peer-left on plain transport onPeerLeave (pre/post game) + leave hygiene.
  // ==========================================================================
  console.log('\n· peer-left on transport leave (post-game) + leave() idempotent …')
  {
    const { host, guest, he } = await connectPair(CFG(60_000, 0))
    // End the game first so leaving is a clean peer-left (not a suspend).
    await host.resign()
    await waitEvent(he, (e) => e.type === 'resign', { label: 'resign before leave' })
    guest.leave()
    await waitEvent(he, (e) => e.type === 'peer-left', { label: 'host peer-left post-game', timeout: 1500 })
    ok(true, 'post-game guest leave → host peer-left')
    host.leave(); host.leave() // idempotent
    guest.leave()
    ok(true, 'leave() is idempotent (double-leave did not throw)')
  }

  // ==========================================================================
  // 21. Discovery timeout fires (shrunk) + leave() cancels it.
  // ==========================================================================
  console.log('\n· discovery timeout fires + leave() cancels it …')
  {
    const deadFactory = () => ({ send() {}, close() {}, closed: Promise.resolve() })
    const guest = new MpNetSession(deadFactory)
    const ge = tap(guest)
    const r = await guest.join(wire.generateRoomCode())
    eq(r.ok, true, 'join() resolves ok even with a silent transport')
    const err = await waitEvent(ge, (e) => e.type === 'error', { label: 'discovery timeout error', timeout: 1500 })
    ok(/Nobody's hosting/i.test(err.message), 'discovery timeout → friendly "nobody hosting" error')
    guest.leave()
    const guest2 = new MpNetSession(deadFactory)
    const ge2 = tap(guest2)
    await guest2.join(wire.generateRoomCode())
    guest2.leave()
    await assertNoEvent(ge2, (e) => e.type === 'error', 200, 'error after leave() cancels the discovery timer')
  }

  // ==========================================================================
  // 22. Malformed + version mismatch (kept from v2, still valid on v3).
  // ==========================================================================
  console.log('\n· malformed message → error, session survives …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const guest = track(new MpNetSession(pair.guestFactory))
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(CFG(60_000, 0))
    await guest.join(code)
    await waitEvent(he, (e) => e.type === 'start', { label: 'start (malformed)' })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start (malformed)' })
    const guestSlot = [...pair.room.members.values()][1]
    guestSlot.transport.send('this is not json {{{')
    await waitEvent(he, (e) => e.type === 'error' && /malformed/i.test(e.message), { label: 'host malformed error' })
    ok(true, 'malformed traffic → host error event')
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'move after malformed' })
    ok(true, 'session survived the malformed message')
    host.leave(); guest.leave()
  }
  console.log('\n· version-mismatch hello → error + teardown …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const he = tap(host)
    await host.host(CFG(60_000, 0))
    const badInbox = []
    const badMember = pair.room.join({
      onMessage: (text) => { const p = wire.parseWireMsg(text); if (p) badInbox.push(p) },
      onPeerJoin: () => {}, onPeerLeave: () => {}
    })
    await waitEvent(badInbox, (m) => m.t === 'hello', { label: 'host hello to bad guest' })
    // A REAL previous build: wire v4 (games platform, pre-byo-yomi). The hello
    // gate must refuse any peer whose version ≠ PROTOCOL_VERSION. Bumped to 6
    // with wire v6 (the `witness` role + per-move signature chaining, A3); the
    // unsigned v5 flow this suite exercises is byte-identical, only the version
    // integer moved (v4→v5 updated this exact pin the same way).
    eq(wire.PROTOCOL_VERSION, 6, 'PROTOCOL_VERSION is 6 (signed-play wire, A3)')
    badMember.transport.send(JSON.stringify({ t: 'hello', v: 4, role: 'guest' }))
    await waitEvent(he, (e) => e.type === 'error' && /version/i.test(e.message), { label: 'host version-mismatch error' })
    ok(true, 'host rejects a v4 peer with a version-mismatch error')
    await waitEvent(badInbox, (m) => m.t === 'error' && /version/i.test(m.message), { label: 'bad guest version error msg' })
    ok(true, 'the v4 peer is told about the version mismatch')
    badMember.transport.close(); host.leave()
  }

  // ==========================================================================
  // 23. Third peer → 'host is busy', game undisturbed.
  // ==========================================================================
  console.log('\n· third peer gets "host is busy", game undisturbed …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const guest = track(new MpNetSession(pair.guestFactory))
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(CFG(60_000, 0))
    await guest.join(code)
    await waitEvent(he, (e) => e.type === 'start', { label: 'start (third)' })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start (third)' })
    const third = pair.injectPeer()
    await waitEvent(third.received, (m) => {
      const parsed = wire.parseWireMsg(m.text)
      return parsed && parsed.t === 'error' && parsed.message === 'host is busy'
    }, { label: 'third peer busy error' })
    ok(true, 'third peer received a targeted "host is busy" error')
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'game still live after intruder' })
    ok(true, 'game undisturbed by the third peer')
    third.leave(); host.leave(); guest.leave()
  }

  // ==========================================================================
  // 24. BLACK-FIRST games (go/gomoku/othello/checkers move order, wire v4).
  //     THE ply-0 deadlock regression: the session used to hardcode
  //     toMove='white' at beginGame and ply%2 white/black parity, so every
  //     black-first online game deadlocked at ply 0 (the kernel said black to
  //     move, the session said white. Neither side could send). The first
  //     mover now TRAVELS IN THE CONFIG (config.game.firstMover); assert:
  //       (a) the ply-0 BLACK move relays + emits on both sides, with the
  //           guest as black AND the host as black;
  //       (b) first-move grace: BLACK's move 1 debits 0 / no increment and
  //           STARTS WHITE's clock;
  //       (c) the abort watchdog fires when the BLACK first-mover never moves
  //           (and window B: black opened, white never replied);
  //       (d) chess default (no firstMover) is unchanged: white-first.
  // ==========================================================================
  const GOMOKU = (initialMs, incrementMs = 0, hostColor = 'white') => ({
    tc: { initialMs, incrementMs },
    hostColor,
    game: { kind: 'gomoku', firstMover: 'black' }
  })
  console.log('\n· black-first (a): guest-as-black opens at ply 0 …')
  {
    const { host, guest, he, ge } = await connectPair(GOMOKU(60_000))
    // Host is white, guest is black, the FIRST MOVER. Its ply-0 move must
    // commit + relay (this exact path used to hard-deadlock).
    eq((await host.sendMove('a1')).ok, false, 'black-first: white (host) cannot open at ply 0')
    eq((await guest.sendMove('h8')).ok, true, 'black-first: guest-as-black opens at ply 0')
    const hm = await waitEvent(he, (e) => e.type === 'move' && e.uci === 'h8', { label: 'host sees the black ply-0 move' })
    eq(hm.ply, 0, 'black opening move committed at ply 0')
    const gc = await waitEvent(ge, (e) => e.type === 'clock', { label: 'guest clock ack for the ply-0 move' })
    eq(gc.toMove, 'white', 'after black move 1 it is WHITE to move')
    // Alternation continues both ways (guest-side parity keys off firstMover).
    eq((await host.sendMove('a1')).ok, true, 'white replies at ply 1')
    const gm = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'a1', { label: 'guest sees the white reply' })
    eq(gm.ply, 1, 'white reply lands at ply 1')
    eq((await guest.sendMove('h9')).ok, true, 'black moves again at ply 2')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'h9', { label: 'host sees the black ply-2 move' })
    host.leave(); guest.leave()
  }
  console.log("\n· black-first (a'+b): host-as-black opens; grace frees black move 1, starts WHITE's clock …")
  {
    const INITIAL = 60_000, INC = 1_000
    const clock = makeClock()
    const { host, guest, he, ge } = await connectPair(GOMOKU(INITIAL, INC, 'black'), { clock })
    // Host is black, the first mover. Clocks IDLE before the opening move:
    // 5s of idle monotonic time must debit NOBODY.
    clock.advance(5_000)
    eq((await guest.sendMove('a1')).ok, false, 'black-first: white (guest) cannot open at ply 0')
    eq((await host.sendMove('h8')).ok, true, 'host-as-black opens at ply 0')
    const gm1 = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'h8', { label: 'guest sees h8' })
    eq(gm1.clockMs.black, INITIAL, "black move 1 debits 0 (first-move grace) and credits NO increment")
    eq(gm1.clockMs.white, INITIAL, 'white clock still full after black move 1')
    // WHITE's clock started with black's move 1: think 800ms → Fischer debit + inc.
    clock.advance(800)
    eq((await guest.sendMove('a1')).ok, true, 'white replies at ply 1')
    const hm2 = await waitEvent(he, (e) => e.type === 'move' && e.uci === 'a1', { label: 'host sees a1' })
    const whiteSpent = INITIAL + INC - hm2.clockMs.white
    approx(whiteSpent, 800, 30, "WHITE's clock started after black's move 1 (debit ≈ think)")
    eq(hm2.clockMs.black, INITIAL, "black clock unchanged during white's move 1")
    // Black's move 2 debits normally. The grace was move 1 only.
    clock.advance(1_200)
    eq((await host.sendMove('f8')).ok, true, 'black moves at ply 2')
    const gm3 = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'f8', { label: 'guest sees f8' })
    const blackSpent = INITIAL + INC - gm3.clockMs.black
    approx(blackSpent, 1_200, 30, 'black move 2 debits its think time (grace was move 1 only)')
    host.leave(); guest.leave()
  }
  console.log('\n· black-first (c): abort watchdog when BLACK never opens …')
  await withAbortWindow(150, async () => {
    const { host, guest, he, ge } = await connectPair(GOMOKU(60_000))
    // Guest is black (first mover) and never moves → no-first-move abort, both sides.
    const ha = await waitEvent(he, (e) => e.type === 'abort', { label: 'host abort (black never opened)', timeout: 1500 })
    const ga = await waitEvent(ge, (e) => e.type === 'abort', { label: 'guest abort (black never opened)', timeout: 1500 })
    eq(ha.reason, 'no-first-move', 'host: black-first abort reason no-first-move')
    eq(ga.reason, 'no-first-move', 'guest: black-first abort reason no-first-move')
    eq((await guest.sendMove('h8')).ok, false, 'move after black-first abort refused')
    host.leave(); guest.leave()
  })
  console.log("\n· black-first (c'): abort window B. Black opened, WHITE never replies …")
  await withAbortWindow(150, async () => {
    const { host, guest, he, ge } = await connectPair(GOMOKU(60_000))
    await guest.sendMove('h8') // black opens in time; re-arms the abort for white
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'h8', { label: 'h8 (black-first window B setup)' })
    const ha = await waitEvent(he, (e) => e.type === 'abort', { label: 'host abort B (white silent)', timeout: 1500 })
    eq(ha.reason, 'no-first-move', 'white-never-replied abort reason no-first-move')
    await waitEvent(ge, (e) => e.type === 'abort', { label: 'guest abort B (white silent)', timeout: 1500 })
    host.leave(); guest.leave()
  })
  console.log('\n· black-first (d): chess default (no firstMover) unchanged …')
  {
    const { host, guest, ge } = await connectPair(CFG(60_000, 0))
    eq((await guest.sendMove('e7e5')).ok, false, 'chess: black still cannot open at ply 0')
    eq((await host.sendMove('e2e4')).ok, true, 'chess: white still opens at ply 0')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'chess white-first move still relays' })
    host.leave(); guest.leave()
  }

  // ==========================================================================
  // 25. BYO-YOMI (wire v5). Japanese overtime for go. The host's clock math:
  //     main time debits as usual; the think that exhausts main SPILLS into
  //     period 1; a move within the current period RESETS it to full (never
  //     banked); a lapsed period is CONSUMED; the LAST period lapsing flags.
  //     The per-side {periodsLeft, inByo} snapshot rides every move/clock/flag/
  //     resync so the guest mirrors authority without doing math.
  // ==========================================================================
  const GO_BYO = (initialMs, periods, periodMs, hostColor = 'white') => ({
    tc: { initialMs, incrementMs: 0, byoyomi: { periods, periodMs } },
    hostColor,
    game: { kind: 'go', firstMover: 'black' }
  })
  console.log('\n· byo-yomi: main→period entry, reset-on-move, period consumption …')
  {
    const clock = makeClock()
    // Black-first go control: 1s main + 3×1s byo-yomi. HOST plays black so the
    // host-authoritative math runs on the side we drive through byo-yomi.
    const { host, guest, he, ge, gStart } = await connectPair(GO_BYO(1_000, 3, 1_000, 'black'), { clock })
    eq(gStart.config.tc.byoyomi.periods, 3, 'start config carries byoyomi.periods (schema v5)')
    eq(gStart.config.tc.byoyomi.periodMs, 1_000, 'start config carries byoyomi.periodMs')
    // Black (host) opens. First-move grace, no debit, byo snapshot rides along.
    eq((await host.sendMove('d4')).ok, true, 'byo: black opens at ply 0')
    const gm1 = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'd4', { label: 'guest sees d4' })
    ok(gm1.byo && gm1.byo.black.inByo === false && gm1.byo.black.periodsLeft === 3,
      'move events carry the byo snapshot (black on main time, 3 periods ahead)')
    // White (guest) replies within main time: plain main debit (approx; the
    // host forgives rtt/2 of a guest move), no byo change.
    clock.advance(500)
    await guest.sendMove('q16')
    const hm1 = await waitEvent(he, (e) => e.type === 'move' && e.uci === 'q16', { label: 'host sees q16' })
    approx(hm1.clockMs.white, 500, 30, 'white main debited normally while on main time')
    eq(hm1.byo.white.inByo, false, 'white still on main time')
    // BLACK think 1.8s: main 1000 exhausted, 800ms spills into period 1 (200ms
    // left when the move lands) → the move RESETS the period to full 1000, all
    // 3 periods still in hand (a period lapses only when fully spent).
    clock.advance(1_800)
    eq((await host.sendMove('q4')).ok, true, 'byo: black moves after main ran out (inside period 1)')
    const gm2 = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'q4', { label: 'guest sees q4' })
    eq(gm2.byo.black.inByo, true, 'black entered byo-yomi when main lapsed mid-think')
    eq(gm2.byo.black.periodsLeft, 3, 'move within period 1: no period consumed')
    eq(gm2.clockMs.black, 1_000, 'move within a period RESETS it to the full period')
    // White replies quickly to hand the turn back.
    clock.advance(100)
    await guest.sendMove('d16')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'd16', { label: 'host sees d16' })
    // BLACK think 2.4s in byo-yomi: burns the current period (1s) + one more
    // (1s) → 2 periods consumed, move lands 600ms into the LAST period → reset.
    clock.advance(2_400)
    eq((await host.sendMove('c3')).ok, true, 'byo: black survives on its last period')
    const gm3 = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'c3', { label: 'guest sees c3' })
    eq(gm3.byo.black.periodsLeft, 1, 'two lapsed periods consumed (3 → 1)')
    eq(gm3.clockMs.black, 1_000, 'the surviving move still resets the (last) period')
    // The guest's mirrored clock ack agrees (host→guest authority).
    host.leave(); guest.leave()
  }
  console.log('\n· byo-yomi: main 0 = straight to period 1; flag when the LAST period lapses …')
  {
    const clock = makeClock()
    // 0 main + 2×1s: both sides START in byo-yomi (a real, common go control).
    const { host, guest, he, ge } = await connectPair(GO_BYO(0, 2, 1_000), { clock })
    // Guest is black (first mover): opening move keeps the first-move grace.
    eq((await guest.sendMove('d4')).ok, true, 'byo: black (guest) opens at ply 0')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'd4', { label: 'host sees d4 (flag suite)' })
    // White (host) replies 300ms into its first period → reset to full.
    clock.advance(300)
    eq((await host.sendMove('q16')).ok, true, 'white replies inside period 1')
    const gm = await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'q16', { label: 'guest sees q16 (flag suite)' })
    eq(gm.byo.white.inByo, true, 'main 0 + byo-yomi: white starts IN byo-yomi')
    eq(gm.clockMs.white, 1_000, 'white reply reset its period to full')
    // BLACK now on move with 2×1s in hand and never moves. Advance past its
    // whole budget (2s); the host's re-armed flag watchdog rules the flag.
    clock.advance(2_500)
    const hf = await waitEvent(he, (e) => e.type === 'flag', { label: 'host flag (last period)', timeout: 4000 })
    const gf = await waitEvent(ge, (e) => e.type === 'flag', { label: 'guest flag (last period)', timeout: 4000 })
    eq(hf.by, 'black', 'flag falls on black when its LAST period lapses')
    eq(hf.clockMs.black, 0, 'flagged side zeroed')
    eq(hf.byo.black.periodsLeft, 0, 'flagged side has 0 periods left')
    eq(gf.byo.black.periodsLeft, 0, 'guest mirrors the exhausted byo snapshot')
    eq((await guest.sendMove('k10')).ok, false, 'move after byo-yomi flag refused')
    host.leave(); guest.leave()
  }
  console.log('\n· byo-yomi: suspend fold burns periods; resync carries byo state …')
  {
    const clock = makeClock()
    const room = makeRoom()
    const factory = (code, listeners) => room.join(listeners).transport
    const host = track(new MpNetSession(factory, { now: clock.now }))
    const he = tap(host)
    // White-first for simplicity: host (white) 1s main + 3×1s byo.
    await host.host({ tc: { initialMs: 1_000, incrementMs: 0, byoyomi: { periods: 3, periodMs: 1_000 } }, hostColor: 'white' })
    let guestId = null
    const guestInbox = []
    const mkGuestMember = (reuseId, resuming) => {
      const member = room.join(
        {
          onMessage: (text, from) => {
            const m = wire.parseWireMsg(text)
            if (!m) return
            guestInbox.push(m)
            if (m.t === 'hello') {
              member.transport.send(JSON.stringify(wire.makeHello('guest', 'ByoGhost')), from)
              if (resuming) member.transport.send(JSON.stringify({ t: 'resumeReq', gameId: 1, havePly: 2 }), from)
            }
          },
          onPeerJoin: () => {}, onPeerLeave: () => {}
        },
        reuseId ? { peerId: reuseId } : {}
      )
      return member
    }
    let guestMember = mkGuestMember()
    guestId = guestMember.peerId
    await waitEvent(he, (e) => e.type === 'start', { label: 'start (byo resync suite)' })
    await host.sendMove('e2e4') // white move 1 free → black clock runs
    await sleep(20)
    // Black replies instantly (raw, ply 1). Black main untouched at 1000.
    guestMember.transport.send(JSON.stringify({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 1000, black: 1000 } }))
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'host sees e7e5 (byo resync)' })
    // WHITE burns into byo-yomi: think 1.8s → main 1000 lapses, 800 into period
    // 1, move lands → reset. periodsLeft 3, inByo true.
    clock.advance(1_800)
    eq((await host.sendMove('g1f3')).ok, true, 'white moves from inside period 1')
    // Black on move; it silently burns 2.2s, then the transport drops → the
    // suspend FOLD must cross the main→byo boundary and consume the lapsed
    // period (2200 = 1000 main + 1000 period + 200 into the next).
    clock.advance(2_200)
    guestMember.transport.close()
    await waitEvent(he, (e) => e.type === 'peer-away', { label: 'peer-away (byo resync)', timeout: 1500 })
    // Rebond with the same peerId → resume → resync answers the resumeReq.
    guestMember = mkGuestMember(guestId, true)
    await waitEvent(he, (e) => e.type === 'peer-back', { label: 'peer-back (byo resync)', timeout: 1500 })
    const resync = await waitEvent(guestInbox, (m) => m.t === 'resync', { label: 'resync (byo)', timeout: 1500 })
    ok(resync.byo, 'resync carries the byo snapshot')
    eq(resync.byo.white.inByo, true, 'resync: white is in byo-yomi')
    eq(resync.byo.white.periodsLeft, 3, 'resync: white kept its 3 periods (reset on move)')
    eq(resync.clockMs.white, 1_000, 'resync: white period was reset by its move')
    eq(resync.byo.black.inByo, true, 'resync: the suspend fold pushed black into byo-yomi')
    eq(resync.byo.black.periodsLeft, 2, 'resync: the lapsed period stayed consumed across the fold')
    eq(resync.clockMs.black, 800, 'resync: black has 800ms left of its current period')
    host.leave(); guestMember.transport.close()
  }
  console.log('\n· byo-yomi absent: v4-shaped messages stay byte-identical …')
  {
    const { host, guest, he, pair } = await connectPair(CFG(60_000, 0))
    // Sniff the raw wire: a plain-Fischer game's move message must carry NO
    // `byo` key at all (schema-optional field truly absent, not null).
    const guestSlot = [...pair.room.members.values()][1]
    const seen = []
    const origOnMessage = guestSlot.listeners.onMessage
    guestSlot.listeners.onMessage = (text, from) => { seen.push(text); origOnMessage(text, from) }
    await host.sendMove('e2e4')
    for (let i = 0; i < 200 && !seen.some((t) => t.includes('"t":"move"')); i++) await sleep(5)
    const rawMove = seen.find((t) => t.includes('"t":"move"'))
    ok(rawMove && !rawMove.includes('byo'), 'no byo key on the wire without tc.byoyomi (v4-shaped)')
    host.leave(); guest.leave()
  }

  // ---- teardown -----------------------------------------------------------
  for (const s of live) { try { s.leave() } catch {} }
  rmSync(outdir, { recursive: true, force: true })
  console.log(`\nALL GREEN: ${passed} assertions`)
}

main().then(
  () => {
    setTimeout(() => process.exit(0), 50).unref()
  },
  (err) => {
    console.error(`\n❌ ${err.stack || err}`)
    process.exit(1)
  }
)
