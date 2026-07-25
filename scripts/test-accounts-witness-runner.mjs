// Headless 3-session harness for the A6 M1 WITNESS RUNNER BODY (Lane D):
// src/renderer/src/features/account/net/witnessRunner.ts.
//
//   node scripts/test-accounts-witness-runner.mjs
//
// Same in-process mock-room transport as scripts/test-mp-v6.mjs (the v6 witness
// gate): two REAL MpNetSession ends (host + guest, both `signing`) plus a REAL
// `witnessRunner` joined to the same room as the third peer. Unlike test-mp-v6
// (which hand-pumps a scripted WitnessCore), this drives the runner BODY: it
// joins, announces `hello{role:'witness'}`, mirrors the host stream into a
// WitnessCore, and BROADCASTS wclk/wend back to both players itself.
//
// Identities use root ≠ device-key (unlike test-mp-v6's root===key idents) so
// the runner's device-key resolution (participants + observed host hello) is
// genuinely exercised: the mirrored start carries only ROOTS.
//
// Covered:
//   1. RATED game: seat + follow (kind/tc + pairing='embedder-verified'), wclk
//      cadence + sig, BOTH players surface the wclk (broadcast + both-verify),
//      wend signed WITH the rated binding verifies, buildWitnessedResult carries
//      kind/tc + verifies. (Also empirically documents the mpSession rated-wend
//      surfacing gap. See notesForLead.)
//   2. UNRATED signed game: BOTH players surface the wend via onWitnessStream
//      (the literal "witness emits a valid wend both players verify"), and
//      buildWitnessedResult is well-formed.
//   3. Observed flag (rage-quit) driven through the runner's tick(): a valid
//      'flag' wend + witnessed result from the witness's own countersigned clocks.
//   4. Casual/unsigned play is UNAFFECTED: an unsigned host never seats the
//      runner, never mirrors, so the runner produces nothing and the game flows.
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green; any failure prints
// and exits 1. Clean exit (no leaked timers/handles).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = resolve(ROOT, 'src').replace(/\\/g, '/')

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

// ============================================================================
// In-memory transport pair + a scripted extra peer (from test-mp-v6.mjs). Every
// join returns an MpTransport; broadcast = send(text) with no target.
// ============================================================================
let PEER_SEQ = 0
function makeRoom() {
  const members = new Map()
  const wires = []
  const deliver = (fn) => setTimeout(fn, 0)
  const room = {
    join(listeners, { peerId } = {}) {
      const id = peerId ?? `peer${++PEER_SEQ}`
      const self = { peerId: id, listeners, closed: false }
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
          wires.push({ from: id, to: toPeer ?? null, text })
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
        stopRelayPoll() {},
        close() {
          if (self.closed) return
          self.closed = true
          members.delete(id)
          for (const [, other] of members) {
            if (other.closed) continue
            deliver(() => !other.closed && other.listeners.onPeerLeave(id))
          }
        },
        closed: Promise.resolve(),
      }
      self.transport = transport
      return { transport, self, peerId: id }
    },
    wires,
    members,
  }
  return room
}
function makeMockPair() {
  const room = makeRoom()
  const mkFactory = () => (_roomCode, listeners) => room.join(listeners).transport
  return {
    hostFactory: mkFactory(),
    guestFactory: mkFactory(),
    /** Join a raw scripted peer (used for the unsigned-move relay assertion). */
    injectPeer() {
      const received = []
      const joined = room.join({
        onMessage: (text, from) => received.push({ text, from }),
        onPeerJoin: () => {},
        onPeerLeave: () => {},
        onSendError: () => {},
      })
      return { received, peerId: joined.peerId, transport: joined.transport, leave: () => joined.transport.close() }
    },
    /** The witness's transport factory. Joins the SAME room as host/guest. */
    witnessFactory: (_roomCode, listeners) => room.join(listeners).transport,
    room,
  }
}
function tap(session) {
  const events = []
  session.onEvent((ev) => events.push(ev))
  return events
}

// ============================================================================
// Bundling
// ============================================================================
async function bundle(entryPath, outfile, { platform = 'neutral' } = {}) {
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    format: 'esm',
    platform,
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/witness-runner-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\nALL GREEN: ${passed} assertions`)
  process.exit(0)
}

async function run(outdir) {
  console.log('· bundling mpSession.ts + witnessRunner.ts + shared modules …')
  const sessOut = resolve(outdir, 'mpSession.mjs')
  await bundle(resolve(ROOT, 'src/renderer/src/features/play/online/mpSession.ts'), sessOut)
  const { MpNetSession, __setMpTimingForTests } = await import(pathToFileURL(sessOut).href)
  ok(typeof MpNetSession === 'function', 'mpSession.ts bundled & MpNetSession exported')

  // The lane under test. Type-only imports (mpSession/accounts types) erase, so
  // this bundles light: no trystero, no DOM (proves it is headless-testable).
  const wrOut = resolve(outdir, 'witnessRunner.mjs')
  await bundle(resolve(ROOT, 'src/renderer/src/features/account/net/witnessRunner.ts'), wrOut)
  const wrSrc = (await import('node:fs')).readFileSync(wrOut, 'utf8')
  ok(!/from\s*["']trystero/.test(wrSrc), 'witnessRunner bundle pulls in NO transport (trystero), injected')
  ok(!/from\s*["']node:/.test(wrSrc), 'witnessRunner bundle has no node: import')
  const { witnessRunner } = await import(pathToFileURL(wrOut).href)
  ok(typeof witnessRunner === 'function', 'witnessRunner.ts bundled & witnessRunner exported')

  // Shared assertion helpers (segment/hash/wire/witnessCore).
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as wire from '${SRC}/shared/mp/wire.ts'`,
      `export * as seg from '${SRC}/shared/accounts/segment.ts'`,
      `export * as hash from '${SRC}/shared/accounts/hash.ts'`,
      `export * as wc from '${SRC}/shared/mp/witnessCore.ts'`,
    ].join('\n'),
  )
  const accOut = resolve(outdir, 'acc.mjs')
  await bundle(entry, accOut, { platform: 'node' })
  const { wire, seg, hash, wc } = await import(pathToFileURL(accOut).href)
  eq(wire.PROTOCOL_VERSION, 6, 'PROTOCOL_VERSION is 6 (signed play wire)')

  __setMpTimingForTests({
    DISCOVERY_TIMEOUT_MS: 120,
    HANDSHAKE_WATCHDOG_MS: 120,
    FIRST_MOVE_ABORT_MS: 4000,
    HEARTBEAT_MS: 40,
    PEER_SILENCE_MS: 120,
    MAX_LAG_FORGIVE_MS: 250,
    GRACE_BY_CATEGORY: { Bullet: 200, Blitz: 250, Rapid: 300, Classical: 350, Unlimited: 300 },
  })

  const live = []
  const track = (s) => (live.push(s), s)
  const CFG = (initialMs, incrementMs = 0, hostColor = 'white') => ({ tc: { initialMs, incrementMs }, hostColor })

  // ---- identities: root != device key (proves participant key resolution) ----
  const seedBytes = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b * 7 + i) & 0xff)
  const ident = (b) => {
    const rootPriv = seedBytes(b)
    const root = hash.toB64u(hash.ed25519.getPublicKey(rootPriv))
    const priv = seedBytes(b + 64)
    const key = hash.toB64u(hash.ed25519.getPublicKey(priv))
    return { root, key, priv }
  }
  const HOST_I = ident(1)
  const GUEST_I = ident(2)
  const WIT_I = ident(3)
  ok(HOST_I.root !== HOST_I.key, 'sanity: identity root differs from its device signing key')
  const signingOf = (i) => ({ priv: i.priv, key: i.key, root: i.root })
  const witIdentity = { root: WIT_I.root, key: WIT_I.key, priv: WIT_I.priv }
  const participants = [
    { root: HOST_I.root, key: HOST_I.key },
    { root: GUEST_I.root, key: GUEST_I.key },
  ]

  /** Host + guest (both signing) + a REAL witnessRunner, handshaken to start.
   *  The runner joins BEFORE the guest (host presence-bonds it, then reseats it
   *  as the witness on its hello), exactly the M1 dev flow. */
  async function runTrio(cfg, gameInit) {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory, { signing: signingOf(HOST_I) }))
    const guest = track(new MpNetSession(pair.guestFactory, { signing: signingOf(GUEST_I) }))
    const he = tap(host)
    const ge = tap(guest)
    const hw = []
    const gw = []
    host.onWitnessStream((m) => hw.push(m))
    guest.onWitnessStream((m) => gw.push(m))
    const { code } = await host.host(cfg, 'H')
    const wclock = { t: 1_000_000 }
    const emitted = []
    const witnessed = []
    const errors = []
    const runner = witnessRunner(code, gameInit, witIdentity, {
      makeTransport: pair.witnessFactory,
      now: () => wclock.t,
      tickIntervalMs: 0, // tests drive tick() deterministically
      onWitnessMsg: (m) => emitted.push(m),
      onWitnessed: (r) => witnessed.push(r),
      onError: (e) => errors.push(e),
    })
    await sleep(40) // runner joins, announces, host seats it
    const r = await guest.join(code, 'G')
    eq(r.ok, true, 'guest.join(hosted code) → ok:true')
    const hStart = await waitEvent(he, (e) => e.type === 'start', { label: 'host start' })
    const gStart = await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start' })
    return { pair, host, guest, he, ge, hw, gw, runner, wclock, emitted, witnessed, errors, code, hStart, gStart }
  }

  const stopTrio = (t) => {
    t.runner.stop()
    t.host.leave()
    t.guest.leave()
  }

  const playPlies = async (t, plies) => {
    for (const [who, uci] of plies) {
      t.wclock.t += 1_000
      const s = who === 'host' ? t.host : t.guest
      const other = who === 'host' ? t.ge : t.he
      const res = await s.sendMove(uci)
      eq(res.ok, true, `${who}.sendMove(${uci}) ok`)
      await waitEvent(other, (e) => e.type === 'move' && e.uci === uci, { label: `${uci} relayed` })
    }
    await sleep(30) // let the last mirror delivery + witness feed land
  }

  // ==========================================================================
  // 1. RATED game: seat, follow, wclk cadence, wend WITH binding, record.
  // ==========================================================================
  console.log('\n· rated game: seat + wclk + wend(binding) + witnessed result …')
  const RATED_TC = { baseMs: 180_000, incMs: 0 }
  {
    const t = await runTrio(CFG(180_000, 0, 'white'), {
      participants,
      kind: 'chess',
      tc: RATED_TC,
      pairing: 'embedder-verified',
    })
    eq(t.host.getWitnessIdentity()?.key, WIT_I.key, 'host seated the runner as witness (device key)')
    eq(t.guest.getWitnessIdentity()?.key, WIT_I.key, 'guest seated the runner as witness (device key)')
    const gameKey = t.host.getSignedGame().gameKey

    await playPlies(t, [
      ['host', 'e2e4'],
      ['guest', 'e7e5'],
      ['host', 'g1f3'],
      ['guest', 'b8c6'],
    ])

    // A wclk fires after ply 4 (cadence 4), naming ply 3; its sig verifies.
    const wclk = t.emitted.find((m) => m.t === 'wclk')
    ok(wclk, 'runner emitted a wclk after 4 countersigned plies')
    eq(wclk.ply, 3, 'wclk names the last countersigned ply (3)')
    ok(
      hash.verifySigB64u(
        wclk.sig,
        seg.witnessClockBytes(gameKey, wclk.ply, wc.sigClock(wclk.clockMs), wclk.wts),
        WIT_I.key,
      ),
      'wclk signature verifies over witnessClockBytes',
    )
    // BOTH players surfaced the (verified) wclk. Broadcast + both-seat + both-verify.
    await waitEvent(t.hw, (m) => m.t === 'wclk' && m.ply === 3, { label: 'host surfaced wclk' })
    await waitEvent(t.gw, (m) => m.t === 'wclk' && m.ply === 3, { label: 'guest surfaced wclk' })
    ok(true, 'both players surfaced the wclk via onWitnessStream')

    // Guest (black) resigns → host forwards the countersigned resign → runner ends.
    t.wclock.t += 1_000
    await t.guest.resign()
    await waitEvent(t.he, (e) => e.type === 'resign' && e.by === 'black', { label: 'host resign' })
    await sleep(30)

    const wend = t.emitted.find((m) => m.t === 'wend')
    ok(wend, 'runner emitted a wend on the countersigned resign')
    eq(wend.result, '1-0', 'wend result: black resigned ⇒ 1-0')
    eq(wend.reason, 'resign', 'wend reason is the shared resign convention')
    eq(wend.plies, 4, 'wend covers 4 plies')

    // The rated wend verifies WITH the re-derived binding (kind/tc/players/reason),
    // the exact wstream sig both players' SegmentPayload.wstream carries.
    const res = t.runner.result()
    ok(res, 'runner.result() present after terminal')
    const binding = { kind: 'chess', tc: RATED_TC, players: { w: HOST_I.root, b: GUEST_I.root }, reason: 'resign' }
    ok(
      seg.verifyWitnessEnd(res.wstream, gameKey, '1-0', 4, wend.transcript, binding),
      'rated wend signature verifies over witnessEndBytes WITH the rated binding',
    )
    eq(res.wstream.sig, wend.sig, 'runner.result().wstream.sig equals the broadcast wend sig')
    ok(
      !seg.verifyWitnessEnd(res.wstream, gameKey, '1-0', 4, wend.transcript),
      'and does NOT verify binding-less (rated binding is load-bearing)',
    )

    // buildWitnessedResult carries the ladder binding and verifies.
    ok(seg.verifyWitnessedResult(res.record), 'witnessed result verifies (verifyWitnessedResult)')
    eq(res.record.body.kind, 'chess', 'witnessed result carries the ladder kind')
    eq(res.record.body.tc.baseMs, RATED_TC.baseMs, 'witnessed result carries the ladder tc')
    eq(res.record.body.players.w, HOST_I.root, 'witnessed result names the white root')
    eq(res.record.body.players.b, GUEST_I.root, 'witnessed result names the black root')
    eq(res.record.wkey, WIT_I.key, 'witnessed result signed by the witness device key')
    eq(res.record.wroot, WIT_I.root, 'witnessed result carries the witness account root')
    eq(t.witnessed.length, 1, 'onWitnessed fired exactly once')
    eq(t.errors.length, 0, 'no witness follow errors on the honest rated game')

    // The witness's verified transcript matches the players' signed chains.
    const hostView = t.host.getSignedGame()
    eq(
      seg.verifyMoveChain(hostView.gameKey, hostView.moves, { w: HOST_I.key, b: GUEST_I.key }),
      -1,
      'host signed chain verifies (same transcript the witness followed)',
    )

    // Empirical: the rated wend does NOT currently surface via onWitnessStream
    // (mpSession verifies it binding-less; Lane C gap, see notesForLead). The
    // binding-less wclk DID surface (asserted above), so seating/broadcast work.
    const ratedWendSurfaced = t.hw.some((m) => m.t === 'wend') || t.gw.some((m) => m.t === 'wend')
    console.log(
      `    (info) rated wend surfaced via onWitnessStream: ${ratedWendSurfaced} ` +
        `(mpSession must re-derive the binding for players to collect it)`,
    )
    stopTrio(t)
  }

  // ==========================================================================
  // 2. UNRATED signed game: BOTH players surface the wend (the contract line).
  // ==========================================================================
  console.log('\n· unsigned-ladder signed game: both players verify the wend …')
  {
    const t = await runTrio(CFG(180_000, 0, 'white'), { participants })
    const gameKey = t.host.getSignedGame().gameKey
    await playPlies(t, [
      ['host', 'e2e4'],
      ['guest', 'e7e5'],
    ])
    t.wclock.t += 1_000
    await t.guest.resign()
    await waitEvent(t.he, (e) => e.type === 'resign' && e.by === 'black', { label: 'host resign' })
    await sleep(30)

    const wend = t.emitted.find((m) => m.t === 'wend')
    ok(wend, 'runner emitted a wend (unrated)')
    // Legacy (binding-less) wend: mpSession surfaces it, so BOTH players verify.
    const hWend = await waitEvent(t.hw, (m) => m.t === 'wend', { label: 'host surfaced wend' })
    const gWend = await waitEvent(t.gw, (m) => m.t === 'wend', { label: 'guest surfaced wend' })
    eq(hWend.sig, wend.sig, 'host surfaced the exact wend the runner broadcast')
    eq(gWend.sig, wend.sig, 'guest surfaced the exact wend the runner broadcast')
    ok(true, 'BOTH players verified + surfaced the wend via onWitnessStream')

    const res = t.runner.result()
    ok(seg.verifyWitnessEnd(res.wstream, gameKey, '1-0', 2, wend.transcript), 'unrated wend verifies (legacy bytes)')
    ok(seg.verifyWitnessedResult(res.record), 'unrated witnessed result is well-formed')
    ok(res.record.body.kind === undefined, 'unrated witnessed result carries no ladder kind (byte-legacy)')
    stopTrio(t)
  }

  // ==========================================================================
  // 3. Observed flag (rage-quit) driven through runner.tick().
  // ==========================================================================
  console.log('\n· observed flag via runner.tick(): rage-quit closer …')
  {
    const t = await runTrio(CFG(60_000, 0, 'white'), { participants })
    const gameKey = t.host.getSignedGame().gameKey
    await playPlies(t, [
      ['host', 'e2e4'],
      ['guest', 'e7e5'],
    ])
    // White (to move at ply 2) has ~60s of self-signed budget, last countersigned
    // at witness-time `base` (or earlier). Jump the witness's OWN clock a full
    // 61s past `base` and tick: witnessed time since white's turn began now
    // exceeds its budget ⇒ a flag on white.
    eq(t.emitted.filter((m) => m.t === 'wend').length, 0, 'no wend before the budget lapses')
    const base = t.wclock.t
    t.runner.tick(base + 61_000)
    const wend = t.emitted.find((m) => m.t === 'wend')
    ok(wend, 'runner.tick() past the countersigned budget → wend')
    eq(wend.result, '0-1', 'observed flag: white (to move) loses')
    eq(wend.reason, 'flag', 'observed-flag reason')
    const res = t.runner.result()
    ok(seg.verifyWitnessEnd(res.wstream, gameKey, '0-1', 2, wend.transcript), 'observed-flag wend verifies')
    ok(seg.verifyWitnessedResult(res.record), 'observed-flag witnessed result verifies')
    // Ticking again after terminal is a no-op (single witnessed result).
    t.runner.tick(base + 200_000)
    eq(t.emitted.filter((m) => m.t === 'wend').length, 1, 'tick after terminal is idempotent (one wend)')
    stopTrio(t)
  }

  // ==========================================================================
  // 4. Casual/unsigned play is UNAFFECTED by a witnessRunner in the room.
  // ==========================================================================
  console.log('\n· unsigned play: runner tolerated + ignored, game flows …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory)) // NO signing
    const guest = track(new MpNetSession(pair.guestFactory)) // NO signing
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(CFG(60_000, 0), 'H')
    const emitted = []
    const runner = witnessRunner(
      code,
      { participants },
      witIdentity,
      { makeTransport: pair.witnessFactory, now: () => 5_000_000, tickIntervalMs: 0, onWitnessMsg: (m) => emitted.push(m) },
    )
    await sleep(40)
    await guest.join(code, 'G')
    await waitEvent(he, (e) => e.type === 'start', { label: 'host start (unsigned)' })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start (unsigned)' })
    eq(host.getWitnessIdentity(), null, 'unsigned host never seats the witness (tolerate + ignore)')

    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'unsigned move relayed' })
    // The move on the wire is byte-identical v5 (no sig). The runner never
    // disturbed it, and never received a start (no mirror), so it produced nothing.
    const mvRaw = [...pair.room.wires].reverse().find((w) => wire.parseWireMsg(w.text)?.t === 'move')
    ok(!('sig' in JSON.parse(mvRaw.text)), 'unsigned move stays v5-shaped (no sig) with the runner present')
    await sleep(20)
    eq(runner.result(), null, 'runner produced NO witnessed result for unsigned play')
    eq(emitted.length, 0, 'runner emitted no wclk/wend for unsigned play')
    runner.stop()
    host.leave()
    guest.leave()
  }

  // ---- clean teardown --------------------------------------------------------
  for (const s of live) {
    try {
      s.leave()
    } catch {
      // already closed
    }
  }
  await sleep(20)
}

main().catch((err) => {
  console.error(`\nFAILED: ${err?.stack || err}`)
  process.exit(1)
})
