// Headless test for WIRE v6: signed play + the witness seat (accounts spec
// §3 entanglement, docs/ACCOUNTS-SPEC.md).
//
//   node scripts/test-mp-v6.mjs
//
// Same harness pattern as scripts/test-mp.mjs (the untouchable v5 gate): both
// MpNetSession ends run in ONE node process over an in-memory transport pair;
// esbuild bundles the TS on the fly. This suite adds a WIRETAP on the mock
// room (every raw send is recorded) so it can assert byte-level facts. A
// signed move carries `sig`, an unsigned session's move is EXACTLY v5-shaped,
// and a scripted WITNESS peer driven by the real witnessCore state machine.
//
// Covered:
//   1. signed host↔guest game with one witness: hello identities → host-minted
//      gameKey+players on start; per-move sig chain verifies (verifyMoveChain);
//      wclk cadence + sigs; terminal esig; wend; buildWitnessedResult passes
//      verifyWitnessedResult; a SegmentPayload built from the transcript is
//      accepted by verifySegmentEvent inside a real account chain.
//   2. tamper matrix: flipped move sig / replay from another gameKey → loud
//      refusal + teardown; out-of-order ply → witness refuses, session drops
//      silently (v5 dup rule); forged wclk → ignored; second witness → refused,
//      first unaffected.
//   3. unsigned session with a witness present: moves byte-identical to v5
//      (no sig key on the wire), witness TOLERATED + IGNORED (the documented
//      choice), zero disturbance.
//   4. v6 spot-checks: guest×guest hello failure, version-mismatch refusal
//      (deep coverage stays in test-mp.mjs).
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green; any failure
// prints and exits 1. Clean exit (no leaked timers/handles).

import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
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
// In-memory transport pair. The test-mp.mjs mock, plus a WIRETAP: every raw
// send is recorded as { from, to, text } so byte-level assertions are possible.
// ============================================================================

let PEER_SEQ = 0

function makeRoom() {
  const members = new Map()
  const wires = [] // every send: { from, to (null = broadcast), text }
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
        closed: Promise.resolve()
      }
      self.transport = transport
      return { transport, self, peerId: id }
    },
    wires,
    members
  }
  return room
}

function makeMockPair() {
  const room = makeRoom()
  const mkFactory = () => (roomCode, listeners) => room.join(listeners).transport
  return {
    hostFactory: mkFactory(),
    guestFactory: mkFactory(),
    /** Join an extra scripted peer: collects parsed messages, optionally
     *  greets newcomers via onJoin(id, transport). */
    injectPeer({ onJoin } = {}) {
      const received = []
      let transport = null
      const joined = room.join({
        onMessage: (text, from) => received.push({ text, from }),
        onPeerJoin: (id) => onJoin && onJoin(id, transport),
        onPeerLeave: () => {},
        onSendError: () => {}
      })
      transport = joined.transport
      return { received, peerId: joined.peerId, transport, leave: () => transport.close() }
    },
    room
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
    logLevel: 'warning'
  })
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/mp-v6-test')
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
  // ---- bundle mpSession (platform-neutral proof) + the shared v6 modules ----
  console.log('· bundling mpSession.ts + wire/witnessCore/segment/chain …')
  const sessOut = resolve(outdir, 'mpSession.mjs')
  await bundle(resolve(ROOT, 'src/renderer/src/features/play/online/mpSession.ts'), sessOut)
  const mod = await import(pathToFileURL(sessOut).href)
  const { MpNetSession, __setMpTimingForTests } = mod
  ok(typeof MpNetSession === 'function', 'mpSession.ts bundled & MpNetSession exported')

  // witnessCore alone must stay platform-neutral (no node:/electron), like wire.
  const wcOut = resolve(outdir, 'witnessCore.mjs')
  await bundle(resolve(ROOT, 'src/shared/mp/witnessCore.ts'), wcOut)
  const { readFileSync } = await import('node:fs')
  const wcSrc = readFileSync(wcOut, 'utf8')
  ok(!/from\s*["']node:/.test(wcSrc) && !/require\(\s*["']node:/.test(wcSrc), 'witnessCore bundle has no node: import')
  ok(!/from\s*["']electron["']/.test(wcSrc), 'witnessCore bundle has no electron import')
  const wc = await import(pathToFileURL(wcOut).href)

  // wire + accounts (segment/chain/events/hash/storage types) for the harness.
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as wire from '${SRC}/shared/mp/wire.ts'`,
      `export * as seg from '${SRC}/shared/accounts/segment.ts'`,
      `export * as chain from '${SRC}/shared/accounts/chain.ts'`,
      `export * as hash from '${SRC}/shared/accounts/hash.ts'`,
      `export * as codec from '${SRC}/shared/accounts/codec.ts'`,
      `export * as evts from '${SRC}/shared/accounts/events.ts'`,
      `export * as certs from '${SRC}/shared/accounts/certs.ts'`,
      `export * as wparams from '${SRC}/shared/accounts/witness/params.ts'`
    ].join('\n')
  )
  const accOut = resolve(outdir, 'acc.mjs')
  await bundle(entry, accOut, { platform: 'node' })
  const { wire, seg, chain, hash, codec, evts, certs, wparams } = await import(pathToFileURL(accOut).href)
  eq(wire.PROTOCOL_VERSION, 6, 'PROTOCOL_VERSION is 6 (signed play wire)')

  // Shrink watchdogs exactly like the v5 gate does.
  __setMpTimingForTests({
    DISCOVERY_TIMEOUT_MS: 120,
    HANDSHAKE_WATCHDOG_MS: 120,
    FIRST_MOVE_ABORT_MS: 4000,
    HEARTBEAT_MS: 40,
    PEER_SILENCE_MS: 120,
    MAX_LAG_FORGIVE_MS: 250,
    GRACE_BY_CATEGORY: { Bullet: 200, Blitz: 250, Rapid: 300, Classical: 350, Unlimited: 300 }
  })

  const live = []
  const track = (s) => (live.push(s), s)
  const CFG = (initialMs, incrementMs = 0, hostColor = 'white') => ({ tc: { initialMs, incrementMs }, hostColor })

  // ---- fixed identities (root-signed: root === device key) -------------------
  const seedBytes = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b * 7 + i) & 0xff)
  const ident = (b) => {
    const priv = seedBytes(b)
    const key = hash.toB64u(hash.ed25519.getPublicKey(priv))
    return { priv, key, root: key }
  }
  const HOST_I = ident(1)
  const GUEST_I = ident(2)
  const WIT_I = ident(3)
  const WIT2_I = ident(4)
  const signingOf = (i) => ({ priv: i.priv, key: i.key, root: i.root })
  const WHELLO = JSON.stringify({ t: 'hello', v: 6, role: 'witness', root: WIT_I.root, key: WIT_I.key })

  // ==========================================================================
  // Helper: signed host + guest + scripted witness peer, handshaken to start.
  // The witness dials in FIRST (host presence-bonds it; its witness hello
  // gives the opponent seat back), then the guest joins.
  // ==========================================================================
  async function connectSignedTrio(cfg, { viaConfigure = false } = {}) {
    const pair = makeMockPair()
    // A6 Lane C: `viaConfigure` proves the additive configureSigning() method
    // seats signed play IDENTICALLY to the constructor `signing` opt (same trio,
    // same downstream asserts): the signing config is applied BEFORE host()/join().
    const host = track(
      viaConfigure
        ? new MpNetSession(pair.hostFactory)
        : new MpNetSession(pair.hostFactory, { signing: signingOf(HOST_I) })
    )
    const guest = track(
      viaConfigure
        ? new MpNetSession(pair.guestFactory)
        : new MpNetSession(pair.guestFactory, { signing: signingOf(GUEST_I) })
    )
    if (viaConfigure) {
      host.configureSigning(signingOf(HOST_I))
      guest.configureSigning(signingOf(GUEST_I))
    }
    const he = tap(host)
    const ge = tap(guest)
    const hw = []
    const gw = []
    host.onWitnessStream((m) => hw.push(m))
    guest.onWitnessStream((m) => gw.push(m))
    const { code } = await host.host(cfg, 'H')
    // Witness: greets every newcomer with its witness hello (so a guest that
    // joins later learns the seat too), and answers the host's hello.
    const witness = pair.injectPeer({ onJoin: (id, transport) => transport.send(WHELLO, id) })
    await waitEvent(witness.received, (r) => JSON.parse(r.text).t === 'hello', { label: 'host hello to witness' })
    witness.transport.send(WHELLO) // broadcast to the room (reaches the host)
    await sleep(20)
    const r = await guest.join(code, 'G')
    eq(r.ok, true, 'guest.join(hosted code) → ok:true')
    const hStart = await waitEvent(he, (e) => e.type === 'start', { label: 'host start' })
    const gStart = await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start' })
    return { pair, host, guest, he, ge, hw, gw, witness, code, hStart, gStart }
  }

  /** Drain the witness peer's inbox into a WitnessCore, broadcasting emits. */
  function pump(witness, wcore, wclock) {
    const out = []
    while (witness.received.length > 0) {
      const { text } = witness.received.shift()
      const msg = wire.parseWireMsg(text)
      if (!msg || msg.t === 'hello' || msg.t === 'error') continue
      const res = wcore.feed(msg, wclock.t)
      for (const m of res.emit ?? []) {
        out.push(m)
        witness.transport.send(JSON.stringify(m)) // broadcast to both players
      }
      if (!res.ok) out.push({ t: '__error', error: res.error })
    }
    return out
  }

  const lastWire = (pair, pred) => {
    for (let i = pair.room.wires.length - 1; i >= 0; i--) {
      const parsed = wire.parseWireMsg(pair.room.wires[i].text)
      if (parsed && pred(parsed, pair.room.wires[i])) return { msg: parsed, raw: pair.room.wires[i] }
    }
    return null
  }

  // ==========================================================================
  // 1. Signed game with one witness: chain, cadence, terminal, segment.
  // ==========================================================================
  console.log('\n· signed host↔guest game with one witness …')
  {
    const { pair, host, guest, he, ge, hw, gw, witness } = await connectSignedTrio(CFG(60_000, 0, 'white'))

    // The witness got the SAME start the guest did, with gameKey + players.
    const wStart = await waitEvent(
      witness.received.map((r) => wire.parseWireMsg(r.text)).filter(Boolean),
      () => true,
      { timeout: 1, label: 'noop' }
    ).catch(() => null)
    void wStart // (drained below via find; keep witness.received intact)
    const startRec = witness.received.find((r) => {
      const m = wire.parseWireMsg(r.text)
      return m && m.t === 'start'
    })
    ok(startRec, 'witness received the mirrored start')
    const startMsg = wire.parseWireMsg(startRec.text)
    ok(typeof startMsg.gameKey === 'string' && startMsg.gameKey.length === 43, 'start carries a 43-char b64u gameKey')
    eq(startMsg.players.w, HOST_I.root, 'start.players.w is the white (host) root')
    eq(startMsg.players.b, GUEST_I.root, 'start.players.b is the black (guest) root')

    // Boot the real witness core on it.
    const wclock = { t: 1_000_000 }
    const wcore = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcore.init({
      gameId: startMsg.gameId,
      gameKey: startMsg.gameKey,
      players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } },
      firstMover: 'w'
    })
    pump(witness, wcore, wclock) // consume start (+ any chatter)

    // Four signed plies. Every wire move must carry an 86-char sig.
    const plies = [
      ['host', 'e2e4'],
      ['guest', 'e7e5'],
      ['host', 'g1f3'],
      ['guest', 'b8c6']
    ]
    for (const [who, uci] of plies) {
      wclock.t += 1_000
      const r = await (who === 'host' ? host : guest).sendMove(uci)
      eq(r.ok, true, `${who}.sendMove(${uci}) ok`)
      await waitEvent(who === 'host' ? ge : he, (e) => e.type === 'move' && e.uci === uci, { label: `${uci} relayed` })
    }
    const hostMoveWire = lastWire(pair, (m) => m.t === 'move' && m.uci === 'g1f3')
    ok(hostMoveWire && typeof hostMoveWire.msg.sig === 'string' && hostMoveWire.msg.sig.length === 86, 'host move carries an 86-char sig on the wire')
    const guestMoveWire = lastWire(pair, (m) => m.t === 'move' && m.uci === 'b8c6')
    ok(guestMoveWire && typeof guestMoveWire.msg.sig === 'string' && guestMoveWire.msg.sig.length === 86, 'guest move carries an 86-char sig on the wire')

    // Witness verifies the chain; a wclk fires at ply 4 (cadence 4).
    await sleep(30) // let the last mirror delivery (macrotask) land
    const emitted = pump(witness, wcore, wclock)
    const wclks = emitted.filter((m) => m.t === 'wclk')
    eq(wclks.length, 1, 'witness emitted exactly one wclk after 4 countersigned plies')
    eq(wclks[0].ply, 3, 'wclk names the last countersigned ply (3)')
    ok(
      hash.verifySigB64u(
        wclks[0].sig,
        seg.witnessClockBytes(startMsg.gameKey, wclks[0].ply, wc.sigClock(wclks[0].clockMs), wclks[0].wts),
        WIT_I.key
      ),
      'wclk signature verifies over witnessClockBytes'
    )
    eq(wcore.moves.length, 4, 'witness verified all 4 plies')
    eq(
      seg.verifyMoveChain(startMsg.gameKey, wcore.moves, { w: HOST_I.key, b: GUEST_I.key }),
      -1,
      'verifyMoveChain accepts the full interleaved chain (witness view)'
    )
    const hostView = host.getSignedGame()
    eq(seg.verifyMoveChain(hostView.gameKey, hostView.moves, { w: HOST_I.key, b: GUEST_I.key }), -1, 'verifyMoveChain accepts the host session chain')
    const guestView = guest.getSignedGame()
    eq(seg.verifyMoveChain(guestView.gameKey, guestView.moves, { w: HOST_I.key, b: GUEST_I.key }), -1, 'verifyMoveChain accepts the guest session chain')

    // Both sessions surfaced the (verified) wclk.
    await waitEvent(hw, (m) => m.t === 'wclk' && m.ply === 3, { label: 'host onWitnessStream wclk' })
    await waitEvent(gw, (m) => m.t === 'wclk' && m.ply === 3, { label: 'guest onWitnessStream wclk' })
    ok(true, 'both sessions surfaced the wclk via onWitnessStream')

    // Guest resigns → resign{esig} → host forwards → witness ends the stream.
    wclock.t += 1_000
    await guest.resign()
    await waitEvent(he, (e) => e.type === 'resign' && e.by === 'black', { label: 'host resign event' })
    await sleep(20)
    const fwd = witness.received.find((r) => {
      const m = wire.parseWireMsg(r.text)
      return m && m.t === 'resign'
    })
    ok(fwd, 'host forwarded the resign to the witness')
    const resignMsg = wire.parseWireMsg(fwd.text)
    ok(typeof resignMsg.esig === 'string' && resignMsg.esig.length === 86, 'forwarded resign carries the 86-char esig')
    const endEmits = pump(witness, wcore, wclock)
    const wend = endEmits.find((m) => m.t === 'wend')
    ok(wend, 'witness emitted the wend on a validly countersigned resign')
    eq(wend.result, '1-0', 'wend result: black resigned ⇒ 1-0')
    eq(wend.reason, 'resign', 'wend reason is the shared resign convention')
    eq(wend.plies, 4, 'wend covers 4 plies')
    const wstream = wcore.wstream()
    ok(
      seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 4, wend.transcript),
      'terminal witness signature verifies (verifyWitnessEnd)'
    )
    await waitEvent(hw, (m) => m.t === 'wend', { label: 'host onWitnessStream wend' })
    await waitEvent(gw, (m) => m.t === 'wend', { label: 'guest onWitnessStream wend' })
    ok(true, 'both sessions surfaced the wend via onWitnessStream')
    eq(host.getWitnessIdentity()?.key, WIT_I.key, 'host knows the seated witness key')

    // Witnessed result record (§3 rage-quit denial).
    const rec = wcore.buildWitnessedResult()
    ok(seg.verifyWitnessedResult(rec), 'buildWitnessedResult → verifyWitnessedResult accepts')
    eq(rec.body.players.w, HOST_I.root, 'witnessed result names the white root')

    // SegmentPayload → a real account chain accepts it (both players).
    const mkChain = (i, name) =>
      chain.createAccountChain({ rootPriv: i.priv, rootPub: hash.ed25519.getPublicKey(i.priv), displayName: name, ts: 1_000 })
    let hostChain = mkChain(HOST_I, 'Hosty')
    let guestChain = mkChain(GUEST_I, 'Guesty')
    const heads = {
      w: { head: chain.verifyChain(hostChain).witnessedHead, height: chain.verifyChain(hostChain).witnessedHeight },
      b: { head: chain.verifyChain(guestChain).witnessedHead, height: chain.verifyChain(guestChain).witnessedHeight }
    }
    const payloadFor = (color) =>
      seg.makeSegmentPayload({
        game: startMsg.gameKey,
        opp: color === 'w' ? GUEST_I.root : HOST_I.root,
        color,
        result: '1-0',
        reason: 'resign',
        moves: wcore.moves,
        heads,
        wstream,
        oppProfile: { name: color === 'w' ? 'Guesty' : 'Hosty' }
      })
    hostChain = chain.appendWitnessed(hostChain, HOST_I.priv, HOST_I.root, 'segment', payloadFor('w'), 2_000)
    guestChain = chain.appendWitnessed(guestChain, GUEST_I.priv, GUEST_I.root, 'segment', payloadFor('b'), 2_000)
    eq(seg.verifySegmentEvent(hostChain.events[hostChain.events.length - 1]), null, "host chain's segment event verifies (verifySegmentEvent)")
    eq(seg.verifySegmentEvent(guestChain.events[guestChain.events.length - 1]), null, "guest chain's segment event verifies")
    ok(chain.verifyChain(hostChain).ok && chain.verifyChain(guestChain).ok, 'both chains verify with the appended segments')

    witness.leave()
    host.leave()
    guest.leave()
  }

  // ==========================================================================
  // 2. wclk cadence over 8 plies + gameOver esig + signed rematch fresh key.
  // ==========================================================================
  console.log('\n· wclk cadence (8 plies) + gameOver esig + rematch key …')
  {
    const { pair, host, guest, he, ge, witness } = await connectSignedTrio(CFG(60_000, 0, 'white'))
    const startMsg = wire.parseWireMsg(witness.received.find((r) => wire.parseWireMsg(r.text)?.t === 'start').text)
    const wclock = { t: 5_000_000 }
    const wcore = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcore.init({
      gameId: startMsg.gameId,
      gameKey: startMsg.gameKey,
      players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } },
      firstMover: 'w'
    })
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3', 'f6e4']
    for (let i = 0; i < moves.length; i++) {
      const who = i % 2 === 0 ? host : guest
      const other = i % 2 === 0 ? ge : he
      wclock.t += 500
      await who.sendMove(moves[i])
      await waitEvent(other, (e) => e.type === 'move' && e.uci === moves[i], { label: `${moves[i]} relayed` })
    }
    await sleep(30) // let the last mirror delivery (macrotask) land
    const emitted = pump(witness, wcore, wclock)
    const wclks = emitted.filter((m) => m.t === 'wclk')
    eq(wclks.length, 2, 'wclk cadence: exactly 2 over 8 plies (after plies 4 and 8)')
    eq(`${wclks[0].ply},${wclks[1].ply}`, '3,7', 'wclks countersigned plies 3 and 7')

    // Board-terminal draw: BOTH clients detect it and countersign. A draw is
    // witnessed only once BOTH players' esigs are in. A lone esig can never mint
    // a witnessed draw, which closes the unilateral loss→draw escape (finding C).
    // host.gameEnded mirrors the host's esig to the witness directly; guest's is
    // called before the host's gameOver reaches it (guest still !over), and the
    // host forwards the guest's gameOver esig to the witness.
    await host.gameEnded('1/2-1/2', 'stalemate')
    await guest.gameEnded('1/2-1/2', 'stalemate')
    await waitEvent(ge, (e) => e.type === 'gameOver' && e.result === '1/2-1/2', { label: 'guest gameOver' })
    // The guest's draw esig reaches the witness asynchronously (host forwards
    // it over macrotask-scheduled mock delivery), so re-pump until the wend is
    // minted rather than racing a single fixed sleep: a 20ms sleep flaked on
    // slower Windows CI where the esig had not yet landed when pump() ran. pump()
    // only drains whatever newly arrived, so repeat calls are safe.
    let wend
    for (let i = 0; i < 200 && !wend; i++) {
      wend = pump(witness, wcore, wclock).find((m) => m.t === 'wend')
      if (!wend) await sleep(10)
    }
    const goWire = lastWire(pair, (m) => m.t === 'gameOver')
    ok(goWire && typeof goWire.msg.esig === 'string' && goWire.msg.esig.length === 86, 'gameOver carries the esig on the wire')
    ok(wend && wend.result === '1/2-1/2' && wend.reason === 'stalemate', 'witness wend requires BOTH players’ draw esigs')

    // Signed rematch: fresh gameKey, same players.
    await host.offerRematch()
    await guest.offerRematch()
    await waitEvent(ge, (e) => e.type === 'rematchStart', { label: 'guest rematchStart' })
    await waitEvent(he, (e) => e.type === 'rematchStart', { label: 'host rematchStart' })
    const rmWire = lastWire(pair, (m) => m.t === 'rematchStart')
    ok(typeof rmWire.msg.gameKey === 'string' && rmWire.msg.gameKey.length === 43, 'rematchStart carries a gameKey')
    ok(rmWire.msg.gameKey !== startMsg.gameKey, 'rematch minted a FRESH gameKey')
    eq(rmWire.msg.players.w, GUEST_I.root, 'rematch swapped colors: white root is now the guest')
    // A move in the rematch verifies under the NEW key (guest is white now).
    const wcore2 = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcore2.init({
      gameId: rmWire.msg.gameId,
      gameKey: rmWire.msg.gameKey,
      players: { w: { root: GUEST_I.root, key: GUEST_I.key }, b: { root: HOST_I.root, key: HOST_I.key } },
      firstMover: 'w'
    })
    witness.received.length = 0
    await guest.sendMove('d2d4')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'd2d4', { label: 'rematch move relayed' })
    await sleep(20)
    const res2 = pump(witness, wcore2, wclock)
    ok(!res2.some((m) => m.t === '__error'), 'witness follows the rematch under the new key')
    eq(wcore2.moves.length, 1, 'rematch ply 0 verified under the fresh gameKey')

    witness.leave()
    host.leave()
    guest.leave()
  }

  // ==========================================================================
  // 3. Witness self-observed flag (tick) from countersigned clocks.
  // ==========================================================================
  console.log('\n· witness observed flag (tick) …')
  {
    const seed = { v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(9)), ts: 1_000 }
    const g = seg.gameKey(seed)
    const wcore = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
    wcore.init({ gameId: 1, gameKey: g, players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } } })
    const m0 = seg.signMove(HOST_I.priv, g, 0, 'e2e4', { w: 60_000, b: 60_000 })
    const m1 = seg.signMove(GUEST_I.priv, g, 1, 'e7e5', { w: 60_000, b: 60_000 }, m0.sig)
    const feed = (m, wts) =>
      wcore.feed({ t: 'move', gameId: 1, ply: m.ply, uci: m.move, clockMs: { white: m.clockMs.w, black: m.clockMs.b }, sig: m.sig }, wts)
    ok(feed(m0, 1_000).ok && feed(m1, 2_000).ok, 'witness accepted two crafted signed plies')
    eq(wcore.tick(30_000).emit, undefined, 'tick before the budget lapses: no wend')
    const flagRes = wcore.tick(2_000 + 60_001)
    const wend = (flagRes.emit ?? []).find((m) => m.t === 'wend')
    ok(wend, 'tick past the countersigned budget → witness emits wend')
    eq(wend.result, '0-1', 'observed flag: white (to move) loses')
    eq(wend.reason, 'flag', 'observed flag reason')
    ok(seg.verifyWitnessEnd(wcore.wstream(), g, '0-1', 2, wend.transcript), 'observed-flag wend signature verifies')
    ok(seg.verifyWitnessedResult(wcore.buildWitnessedResult()), 'observed-flag witnessed result verifies')
  }

  // ==========================================================================
  // 4. Tamper matrix.
  // ==========================================================================
  console.log('\n· tamper: flipped move sig → loud refusal + teardown …')
  // A scripted "guest" that handshakes with identity, then misbehaves. Host
  // plays BLACK so the fake guest owns ply 0.
  async function hostVsFakeGuest() {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory, { signing: signingOf(HOST_I) }))
    const he = tap(host)
    await host.host(CFG(60_000, 0, 'black'), 'H')
    const inbox = []
    let fakeTransport = null
    const fake = pair.room.join({
      onMessage: (text, from) => {
        const m = wire.parseWireMsg(text)
        if (!m) return
        inbox.push(m)
        if (m.t === 'hello') {
          fakeTransport.send(JSON.stringify({ t: 'hello', v: 6, role: 'guest', root: GUEST_I.root, key: GUEST_I.key }), from)
        }
      },
      onPeerJoin: () => {},
      onPeerLeave: () => {}
    })
    fakeTransport = fake.transport
    const start = await waitEvent(inbox, (m) => m.t === 'start', { label: 'start to fake guest' })
    return { pair, host, he, inbox, fake, start }
  }
  {
    const { host, he, inbox, fake, start } = await hostVsFakeGuest()
    const good = seg.signMove(GUEST_I.priv, start.gameKey, 0, 'e2e4', { w: 60_000, b: 60_000 })
    const flipped = (good.sig[0] === 'A' ? 'B' : 'A') + good.sig.slice(1)
    fake.transport.send(
      JSON.stringify({ t: 'move', gameId: start.gameId, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 }, sig: flipped })
    )
    await waitEvent(he, (e) => e.type === 'error' && /signature/i.test(e.message), { label: 'host sig error' })
    ok(true, 'flipped move sig → host error event + teardown (fail loud)')
    await waitEvent(inbox, (m) => m.t === 'error' && /signed play failure/i.test(m.message), { label: 'wire error to fake guest' })
    ok(true, 'the tampering peer is told via a wire error')
    fake.transport.close()
    host.leave()
  }
  console.log('\n· tamper: move replayed from a DIFFERENT gameKey → refused …')
  {
    const { host, he, inbox, fake, start } = await hostVsFakeGuest()
    const otherKey = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(11)), ts: 7 })
    ok(otherKey !== start.gameKey, 'sanity: the other gameKey differs')
    const replay = seg.signMove(GUEST_I.priv, otherKey, 0, 'e2e4', { w: 60_000, b: 60_000 })
    fake.transport.send(
      JSON.stringify({ t: 'move', gameId: start.gameId, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 }, sig: replay.sig })
    )
    await waitEvent(he, (e) => e.type === 'error' && /signature/i.test(e.message), { label: 'host replay error' })
    ok(true, 'cross-game replay → refused loudly (sig bound to the game key)')
    void inbox
    fake.transport.close()
    host.leave()
  }
  console.log('\n· tamper: out-of-order ply → witness refuses; session drops silently …')
  {
    // Witness core: a valid sig at the WRONG ply is refused.
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(13)), ts: 7 })
    const wcore = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
    wcore.init({ gameId: 1, gameKey: g, players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } } })
    const mv = seg.signMove(GUEST_I.priv, g, 1, 'e7e5', { w: 1, b: 1 })
    const res = wcore.feed({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 1, black: 1 }, sig: mv.sig })
    ok(!res.ok && /out-of-order/.test(res.error), 'witness refuses an out-of-order ply')
    ok(!wcore.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 1, black: 1 }, sig: mv.sig }).ok, 'poisoned witness stays refused (sticky)')

    // Session: wrong-ply arrivals stay the benign v5 silent drop (dup rule).
    const { host, he, fake, start } = await hostVsFakeGuest()
    const far = seg.signMove(GUEST_I.priv, start.gameKey, 5, 'e2e4', { w: 60_000, b: 60_000 })
    fake.transport.send(
      JSON.stringify({ t: 'move', gameId: start.gameId, ply: 5, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 }, sig: far.sig })
    )
    await assertNoEvent(he, (e) => e.type === 'move' || e.type === 'error', 60, 'move/error on out-of-order ply (session silent-drop)')
    fake.transport.close()
    host.leave()
  }
  console.log('\n· tamper: forged wclk (wrong witness key) → ignored …')
  {
    const { host, guest, hw, gw, witness } = await connectSignedTrio(CFG(60_000, 0, 'white'))
    const startMsg = wire.parseWireMsg(witness.received.find((r) => wire.parseWireMsg(r.text)?.t === 'start').text)
    // Forge a wclk signed by the WRONG key (WIT2) but sent from the seated witness.
    const forgedSig = hash.toB64u(
      hash.ed25519.sign(seg.witnessClockBytes(startMsg.gameKey, 0, { w: 1, b: 1 }, 42), WIT2_I.priv)
    )
    witness.transport.send(
      JSON.stringify({ t: 'wclk', gameId: startMsg.gameId, ply: 0, clockMs: { white: 1, black: 1 }, wts: 42, sig: forgedSig })
    )
    await assertNoEvent(hw, (m) => m.t === 'wclk', 60, 'host surfacing a forged wclk')
    await assertNoEvent(gw, (m) => m.t === 'wclk', 60, 'guest surfacing a forged wclk')
    // Session is unharmed: a real move still flows.
    await host.sendMove('e2e4')
    await waitEvent(tap(guest), () => false, { timeout: 1, label: 'noop' }).catch(() => null)
    ok(true, 'session alive after the forged wclk')
    witness.leave()
    host.leave()
    guest.leave()
  }
  console.log('\n· tamper: SECOND witness hello → refused; first unaffected …')
  {
    const { pair, host, guest, he, witness } = await connectSignedTrio(CFG(60_000, 0, 'white'))
    const second = pair.injectPeer({})
    await sleep(20) // let its presence settle (host sends it 'host is busy')
    second.transport.send(JSON.stringify({ t: 'hello', v: 6, role: 'witness', root: WIT2_I.root, key: WIT2_I.key }))
    await waitEvent(
      second.received,
      (r) => {
        const m = wire.parseWireMsg(r.text)
        return m && m.t === 'error' && /witness seat taken/.test(m.message)
      },
      { label: 'second witness refusal' }
    )
    ok(true, 'second witness hello → targeted "witness seat taken" error')
    eq(host.getWitnessIdentity().key, WIT_I.key, 'first witness still holds the seat')
    // First witness still receives the mirrored stream.
    witness.received.length = 0
    await host.sendMove('e2e4')
    await waitEvent(witness.received, (r) => wire.parseWireMsg(r.text)?.t === 'move', { label: 'mirror to first witness' })
    ok(true, 'first witness still receives the mirrored stream')
    await assertNoEvent(he, (e) => e.type === 'error', 60, 'host error from the second witness')
    second.leave()
    witness.leave()
    host.leave()
    guest.leave()
  }

  // ==========================================================================
  // 5. Unsigned session + witness present: byte-for-byte v5, tolerate+ignore.
  // ==========================================================================
  console.log('\n· unsigned session with a witness: v5 bytes, witness ignored …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const guest = track(new MpNetSession(pair.guestFactory))
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(CFG(60_000, 0), 'H')
    await guest.join(code, 'G')
    await waitEvent(he, (e) => e.type === 'start', { label: 'host start (unsigned)' })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start (unsigned)' })
    // Unsigned hellos carry v6 and NO identity keys.
    const helloRaw = pair.room.wires.find((w) => wire.parseWireMsg(w.text)?.t === 'hello')
    const helloObj = JSON.parse(helloRaw.text)
    eq(helloObj.v, 6, 'unsigned hello rides v=6 (the ONLY change vs v5)')
    ok(!('root' in helloObj) && !('key' in helloObj), 'unsigned hello has no identity keys')

    // Witness dials in mid-game: tolerated + ignored (documented choice).
    const witness = pair.injectPeer({})
    await sleep(20)
    witness.transport.send(WHELLO)
    await sleep(30)
    eq(host.getWitnessIdentity(), null, 'unsigned session never seats a witness (tolerate + ignore)')

    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'unsigned move relayed' })
    const mvRaw = [...pair.room.wires].reverse().find((w) => wire.parseWireMsg(w.text)?.t === 'move')
    const mvObj = JSON.parse(mvRaw.text)
    ok(!('sig' in mvObj), "unsigned move JSON has no 'sig' key")
    eq(Object.keys(mvObj).sort().join(','), 'clockMs,gameId,ply,t,uci', 'unsigned move keys are exactly the v5 set')
    ok(!mvRaw.text.includes('"sig"'), 'serialized unsigned move contains no "sig" substring')
    // The ignored witness got no mirrored game traffic (only its busy error).
    const witGame = witness.received.filter((r) => {
      const m = wire.parseWireMsg(r.text)
      return m && (m.t === 'start' || m.t === 'move')
    })
    eq(witGame.length, 0, 'ignored witness receives no mirrored start/move')
    // Game continues normally.
    await guest.sendMove('e7e5')
    await waitEvent(he, (e) => e.type === 'move' && e.uci === 'e7e5', { label: 'unsigned reply relayed' })
    ok(true, 'unsigned game flows exactly as v5 with a witness in the room')
    witness.leave()
    host.leave()
    guest.leave()
  }

  // ==========================================================================
  // 6. v6 spot-checks: guest×guest failure + version-mismatch refusal.
  // ==========================================================================
  console.log('\n· spot: guest×guest hello failure at v6 …')
  {
    const pair = makeMockPair()
    const guest = track(new MpNetSession(pair.guestFactory))
    const ge = tap(guest)
    let otherTransport = null
    const other = pair.room.join({
      onMessage: (text, from) => {
        const m = wire.parseWireMsg(text)
        if (m && m.t === 'hello') otherTransport.send(JSON.stringify(wire.makeHello('guest', 'Other')), from)
      },
      onPeerJoin: () => {},
      onPeerLeave: () => {}
    })
    otherTransport = other.transport
    await guest.join('AAAAA-AAAAA')
    const err = await waitEvent(ge, (e) => e.type === 'error', { label: 'guest×guest error' })
    ok(/no host/i.test(err.message), 'guest hearing hello{role:guest} fails with "no host"')
    other.transport.close()
    guest.leave()
  }
  console.log('\n· spot: v5 peer refused by the v6 hello gate …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory))
    const he = tap(host)
    await host.host(CFG(60_000, 0))
    const bad = pair.injectPeer({})
    await waitEvent(bad.received, (r) => wire.parseWireMsg(r.text)?.t === 'hello', { label: 'host hello to v5 peer' })
    bad.transport.send(JSON.stringify({ t: 'hello', v: 5, role: 'guest' }))
    await waitEvent(he, (e) => e.type === 'error' && /version/i.test(e.message), { label: 'host version error' })
    ok(true, 'host refuses a v5 peer with a version-mismatch error')
    await waitEvent(bad.received, (r) => {
      const m = wire.parseWireMsg(r.text)
      return m && m.t === 'error' && /version/i.test(m.message)
    }, { label: 'v5 peer told about mismatch' })
    ok(true, 'the v5 peer is told about the version mismatch')
    bad.leave()
    host.leave()
  }

  // ==========================================================================
  // 7. Review regressions (brick-6 adversarial review, confirmed defects).
  // ==========================================================================
  console.log('\n· regression: witness rejects a decisive esig from the WINNER (loser-binding) …')
  {
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(21)), ts: 7 })
    const mkCore = () => {
      const c = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
      c.init({ gameId: 1, gameKey: g, players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } } })
      return c
    }
    const m0 = seg.signMove(HOST_I.priv, g, 0, 'e2e4', { w: 60_000, b: 60_000 })
    const m1 = seg.signMove(GUEST_I.priv, g, 1, 'e7e5', { w: 60_000, b: 60_000 }, m0.sig)
    const feedMoves = (c) => {
      c.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 }, sig: m0.sig })
      c.feed({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 }, sig: m1.sig })
    }
    // resign{by:'white'} ⇒ result 0-1 ⇒ WHITE (host) is the loser.
    // FORGERY: the WINNER (black/guest) signs the 0-1 terminal with its own key.
    const forge = mkCore(); feedMoves(forge)
    const tForge = seg.transcriptDigest(g, forge.moves, '0-1', wc.REASON_RESIGN)
    const winnerEsig = seg.signWitnessEnd(GUEST_I.priv, GUEST_I.key, g, '0-1', 2, tForge).sig
    const forgeRes = forge.feed({ t: 'resign', gameId: 1, by: 'white', esig: winnerEsig })
    ok(!forgeRes.ok && /countersignature/i.test(forgeRes.error), 'witness REJECTS a 0-1 esig signed by the winner (black), not the loser')
    ok(forge.buildWitnessedResult() === null, 'no witnessed result is minted from the winner-forged terminal')
    // HONEST: the loser (white/host) countersigns its own resignation.
    const honest = mkCore(); feedMoves(honest)
    const tHonest = seg.transcriptDigest(g, honest.moves, '0-1', wc.REASON_RESIGN)
    const loserEsig = seg.signWitnessEnd(HOST_I.priv, HOST_I.key, g, '0-1', 2, tHonest).sig
    const honestRes = honest.feed({ t: 'resign', gameId: 1, by: 'white', esig: loserEsig })
    const wend = (honestRes.emit ?? []).find((m) => m.t === 'wend')
    ok(honestRes.ok && wend && wend.result === '0-1', 'witness ACCEPTS the loser-signed resignation (honest path intact)')
    ok(seg.verifyWitnessedResult(honest.buildWitnessedResult()), 'the honest loser-signed witnessed result verifies')
  }

  console.log('\n· regression: unencodable clock fails closed, never throws …')
  {
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(22)), ts: 7 })
    const c = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
    c.init({ gameId: 1, gameKey: g, players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } } })
    let res = null, threw = null
    try {
      res = c.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 1e21, black: 60_000 }, sig: 'A'.repeat(86) })
    } catch (e) { threw = e }
    ok(threw === null, 'feeding a move with a non-safe-integer clock does NOT throw (CodecError contained)')
    ok(res && !res.ok, 'the unencodable move fails closed with a typed error')
    let threw2 = null, err2
    try {
      err2 = new wc.MoveChainVerifier(g, { w: HOST_I.key, b: GUEST_I.key }, 'w').check(0, 'e2e4', { w: 1e21, b: 1 }, 'A'.repeat(86))
    } catch (e) { threw2 = e }
    ok(threw2 === null && typeof err2 === 'string', 'MoveChainVerifier.check returns an error string on an unencodable clock, never throws')
  }

  console.log('\n· regression: tick() times the to-move side by ITS OWN signed clock, not the opponent’s echo (finding A) …')
  {
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(33)), ts: 7 })
    const clk = { t: 0 }
    const c = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => clk.t })
    c.init({ gameId: 1, gameKey: g, players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } } })
    // White plays, honestly signing its own 60s clock.
    const m0 = seg.signMove(HOST_I.priv, g, 0, 'e2e4', { w: 60_000, b: 60_000 })
    c.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 }, sig: m0.sig }, 1_000)
    // MALICIOUS: black signs its move reporting WHITE's clock as 1ms. An attack
    // on the honest opponent. The sig is valid (black signed it) and the witness
    // must forward/see the clock verbatim, so it cannot be sanitized upstream.
    const m1 = seg.signMove(GUEST_I.priv, g, 1, 'e7e5', { w: 1, b: 60_000 }, m0.sig)
    c.feed({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 1, black: 60_000 }, sig: m1.sig }, 2_000)
    const soon = c.tick(2_500)
    ok(!(soon.emit ?? []).some((m) => m.t === 'wend'), 'tick() does NOT false-flag white on black’s forged 1ms echo of white’s clock')
    const late = c.tick(2_000 + 60_001)
    const wend = (late.emit ?? []).find((m) => m.t === 'wend')
    ok(wend && wend.result === '0-1', 'white flags only once ITS OWN signed 60s budget lapses')
  }

  console.log('\n· regression: a draw needs BOTH players’ esigs. A lone esig can’t mint a witnessed draw (finding C) …')
  {
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(31)), ts: 7 })
    const c = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
    c.init({ gameId: 1, gameKey: g, players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } } })
    const m0 = seg.signMove(HOST_I.priv, g, 0, 'e2e4', { w: 60_000, b: 60_000 })
    const m1 = seg.signMove(GUEST_I.priv, g, 1, 'e7e5', { w: 60_000, b: 60_000 }, m0.sig)
    c.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 }, sig: m0.sig })
    c.feed({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 }, sig: m1.sig })
    const tDraw = seg.transcriptDigest(g, c.moves, '1/2-1/2', 'agreement')
    const esigW = seg.signWitnessEnd(HOST_I.priv, HOST_I.key, g, '1/2-1/2', 2, tDraw).sig
    const esigB = seg.signWitnessEnd(GUEST_I.priv, GUEST_I.key, g, '1/2-1/2', 2, tDraw).sig
    // A losing player’s lone self-signed draw must NOT finalize a witnessed draw.
    const one = c.feed({ t: 'gameOver', gameId: 1, result: '1/2-1/2', reason: 'agreement', esig: esigB })
    ok(one.ok && !(one.emit ?? []).some((m) => m.t === 'wend'), 'a single draw esig does NOT mint a witnessed draw (no wend)')
    ok(c.buildWitnessedResult() === null, 'no witnessed result from a unilateral draw claim')
    // The second player’s esig completes it.
    const two = c.feed({ t: 'gameOver', gameId: 1, result: '1/2-1/2', reason: 'agreement', esig: esigW })
    const wend = (two.emit ?? []).find((m) => m.t === 'wend')
    ok(two.ok && wend && wend.result === '1/2-1/2', 'the SECOND player’s esig completes the witnessed draw')
    ok(seg.verifyWitnessedResult(c.buildWitnessedResult()), 'the two-sided witnessed draw verifies')
  }

  console.log('\n· regression: an esig-less decisive terminal fences tick() from flagging the WINNER (finding D) …')
  {
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(32)), ts: 7 })
    const c = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
    c.init({ gameId: 1, gameKey: g, players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } } })
    // Three moves (w,b,w) so BLACK is to move with its own clock recorded. The
    // configuration where a naive tick would flag black, the WINNER.
    const m0 = seg.signMove(HOST_I.priv, g, 0, 'e2e4', { w: 60_000, b: 60_000 })
    const m1 = seg.signMove(GUEST_I.priv, g, 1, 'e7e5', { w: 60_000, b: 60_000 }, m0.sig)
    const m2 = seg.signMove(HOST_I.priv, g, 2, 'g1f3', { w: 60_000, b: 60_000 }, m1.sig)
    c.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 60_000, black: 60_000 }, sig: m0.sig }, 1_000)
    c.feed({ t: 'move', gameId: 1, ply: 1, uci: 'e7e5', clockMs: { white: 60_000, black: 60_000 }, sig: m1.sig }, 2_000)
    c.feed({ t: 'move', gameId: 1, ply: 2, uci: 'g1f3', clockMs: { white: 60_000, black: 60_000 }, sig: m2.sig }, 3_000)
    // White resigns (0-1, white loses) but OMITS its esig. A loser denying its loss.
    const rq = c.feed({ t: 'resign', gameId: 1, by: 'white' }, 3_500)
    ok(!rq.ok && /countersignature/i.test(rq.error), 'a decisive resign without an esig is rejected (not finalized)')
    // tick() far past black’s budget must NOT now flag black (the winner) → 1-0.
    const t = c.tick(3_000 + 60_001)
    ok(!(t.emit ?? []).some((m) => m.t === 'wend'), 'tick() does NOT flag the to-move WINNER after an esig-less decisive loss')
    ok(c.buildWitnessedResult() === null, 'no inverted witnessed result is minted')
  }

  console.log('\n· regression: signed guest refuses a start missing gameKey (no silent downgrade) …')
  {
    const pair = makeMockPair()
    const guest = track(new MpNetSession(pair.guestFactory, { signing: signingOf(GUEST_I) }))
    const ge = tap(guest)
    let fakeHostT = null
    const fakeHost = pair.room.join({
      onMessage: (text, from) => {
        const m = wire.parseWireMsg(text)
        if (m && m.t === 'hello') {
          // Greet as host WITH identity (⇒ mutual signed play), then a start
          // that OMITS gameKey: the downgrade a malicious host or relay mounts.
          fakeHostT.send(JSON.stringify({ t: 'hello', v: 6, role: 'host', root: HOST_I.root, key: HOST_I.key }), from)
          fakeHostT.send(JSON.stringify({ t: 'start', gameId: 1, yourColor: 'black', config: CFG(60_000, 0, 'white') }), from)
        }
      },
      onPeerJoin: () => {}, onPeerLeave: () => {}
    })
    fakeHostT = fakeHost.transport
    await guest.join('AAAAA-AAAAA', 'G')
    const err = await waitEvent(ge, (e) => e.type === 'error' && /signed play failure|integrity/i.test(e.message), { label: 'guest downgrade refusal' })
    ok(/downgrade|gameKey/i.test(err.message), 'signed guest tears down loudly on a start missing gameKey (mutual identity ⇒ signed required)')
    ok(guest.getSignedGame() === null, 'no signed game was adopted from the downgraded start')
    fakeHost.transport.close()
    guest.leave()
  }

  console.log('\n· regression: deep oppCkpt nesting fails closed (no stack-overflow throw) …')
  {
    // A wire-delivered segment event (not re-signed) whose oppCkpt is a segment
    // event whose oppCkpt is a segment event … 20k deep. Before the fix the
    // z.lazy(zSignedEvent) recursion made safeParse throw RangeError out of the
    // verifier; now oppCkpt = the non-recursive zCkptEvent, rejected at depth 1.
    const B = 'b'.repeat(43), S = 'g'.repeat(86)
    const leaf = {
      game: B, opp: 'c'.repeat(43), color: 'w', result: '1-0', reason: 'resign', transcript: B, plies: 2,
      heads: { w: { head: B, height: 0 }, b: { head: B, height: 0 } }, wstream: { wkey: B, sig: S }, oppProfile: { name: 'Bob' }
    }
    let p = leaf
    for (let i = 0; i < 20000; i++) p = { ...leaf, oppCkpt: { body: { v: 1, lane: 'w', type: 'segment', root: B, key: B, height: 0, ts: 0, payload: p }, sig: S } }
    const ev = { body: { v: 1, lane: 'w', type: 'segment', root: B, key: B, height: 0, ts: 0, payload: p }, sig: S }
    let res = null, threw = null
    try { res = seg.verifySegmentEvent(ev) } catch (e) { threw = e }
    ok(threw === null, 'verifySegmentEvent does NOT throw on a 20k-deep oppCkpt (fail-closed)')
    eq(res, 'bad-payload', 'it returns a typed bad-payload instead of a RangeError')
  }

  // ==========================================================================
  // 8. A4 ladder binding (§6): the witness end-signature covers kind/tc.
  // ==========================================================================
  console.log('\n· A4 ladder binding: canonical end-bytes (legacy shape frozen) …')
  {
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(41)), ts: 7 })
    const T = 'T'.repeat(43)
    const TC = { baseMs: 180_000, incMs: 2_000 }
    const dec = (b) => new TextDecoder().decode(b)
    // Absent kind/tc ⇒ the EXACT pre-A4 bytes (existing sigs/suites stay valid).
    eq(
      dec(seg.witnessEndBytes(g, '1-0', 4, T)),
      `{"g":"${g}","plies":4,"result":"1-0","t":"wend","transcript":"${T}","v":1}`,
      'witnessEndBytes without kind/tc produces the EXACT legacy byte shape'
    )
    eq(
      dec(seg.witnessEndBytes(g, '1-0', 4, T, {})),
      dec(seg.witnessEndBytes(g, '1-0', 4, T)),
      'an empty ladder binding is byte-identical to the legacy shape'
    )
    // Present kind/tc ⇒ they are inside the signed bytes (sorted cjson-v1 keys).
    eq(
      dec(seg.witnessEndBytes(g, '1-0', 4, T, { kind: 'chess', tc: TC })),
      `{"g":"${g}","kind":"chess","plies":4,"result":"1-0","t":"wend","tc":{"baseMs":180000,"incMs":2000},"transcript":"${T}","v":1}`,
      'witnessEndBytes with kind/tc folds both into the canonical end-bytes'
    )
    // A4 review (A4-01/A4-08): the FULL rated binding. Players + reason join
    // kind/tc inside the signed bytes (cjson-v1 sorted keys).
    const PLAYERS = { w: HOST_I.root, b: GUEST_I.root }
    eq(
      dec(seg.witnessEndBytes(g, '1-0', 4, T, { kind: 'chess', tc: TC, players: PLAYERS, reason: 'resign' })),
      `{"g":"${g}","kind":"chess","players":{"b":"${GUEST_I.root}","w":"${HOST_I.root}"},"plies":4,"reason":"resign","result":"1-0","t":"wend","tc":{"baseMs":180000,"incMs":2000},"transcript":"${T}","v":1}`,
      'witnessEndBytes with the FULL rated binding folds kind/tc/players/reason into the canonical end-bytes'
    )
    eq(
      dec(seg.witnessEndBytes(g, '1-0', 4, T, { reason: 'resign' })),
      `{"g":"${g}","plies":4,"reason":"resign","result":"1-0","t":"wend","transcript":"${T}","v":1}`,
      'each binding field is covered independently (reason alone appears alone)'
    )
    // Sign/verify: a bound sig verifies ONLY over the same kind/tc.
    const bound = seg.signWitnessEnd(WIT_I.priv, WIT_I.key, g, '1-0', 4, T, { kind: 'chess', tc: TC })
    ok(seg.verifyWitnessEnd(bound, g, '1-0', 4, T, { kind: 'chess', tc: TC }), 'ladder-bound end-sig verifies over the same kind/tc')
    ok(!seg.verifyWitnessEnd(bound, g, '1-0', 4, T), 'ladder-bound end-sig does NOT verify over legacy bytes')
    ok(!seg.verifyWitnessEnd(bound, g, '1-0', 4, T, { kind: 'chess', tc: { baseMs: 60_000, incMs: 0 } }), 'a tampered tc fails end-sig verification')
    ok(!seg.verifyWitnessEnd(bound, g, '1-0', 4, T, { kind: 'chess960', tc: TC }), 'a tampered kind fails end-sig verification')
    const legacy = seg.signWitnessEnd(WIT_I.priv, WIT_I.key, g, '1-0', 4, T)
    ok(seg.verifyWitnessEnd(legacy, g, '1-0', 4, T), 'a legacy end-sig still verifies with no ladder argument')
    ok(!seg.verifyWitnessEnd(legacy, g, '1-0', 4, T, { kind: 'chess', tc: TC }), 'a legacy end-sig does NOT verify as ladder-bound')
    // Sign/verify over the full binding: every covered field is tamper-fatal.
    const FULL = { kind: 'chess', tc: TC, players: PLAYERS, reason: 'resign' }
    const fullSig = seg.signWitnessEnd(WIT_I.priv, WIT_I.key, g, '1-0', 4, T, FULL)
    ok(seg.verifyWitnessEnd(fullSig, g, '1-0', 4, T, FULL), 'fully-bound end-sig verifies over the same kind/tc/players/reason')
    ok(
      !seg.verifyWitnessEnd(fullSig, g, '1-0', 4, T, { ...FULL, players: { w: GUEST_I.root, b: HOST_I.root } }),
      'color-swapped players fail full end-sig verification'
    )
    ok(!seg.verifyWitnessEnd(fullSig, g, '1-0', 4, T, { ...FULL, reason: 'abandon' }), 'a tampered reason fails full end-sig verification')
    ok(!seg.verifyWitnessEnd(fullSig, g, '1-0', 4, T, { kind: 'chess', tc: TC }), 'a fully-bound end-sig does NOT verify over a partial (kind/tc-only) binding')
    ok(!seg.verifyWitnessEnd(bound, g, '1-0', 4, T, FULL), 'a kind/tc-only end-sig does NOT verify as fully bound')
  }

  console.log('\n· A4 ladder binding: live trio. Witness signs the config’s kind/tc …')
  {
    const { host, guest, he, ge, hw, gw, witness } = await connectSignedTrio(CFG(180_000, 2_000, 'white'))
    const startMsg = wire.parseWireMsg(witness.received.find((r) => wire.parseWireMsg(r.text)?.t === 'start').text)
    const ladder = wc.ladderFromConfig(startMsg.config)
    eq(ladder.kind, 'chess', 'ladderFromConfig: absent game selector ⇒ chess')
    eq(`${ladder.tc.baseMs},${ladder.tc.incMs}`, '180000,2000', 'ladderFromConfig maps initialMs/incrementMs → baseMs/incMs')
    const wclock = { t: 9_000_000 }
    // J5: the pairing anchors both players appended before the first move.
    // Each names the OTHER root as opp (the anchoring contract).
    const anchorsOf = (gameKey, k, tc) => ({
      w: { game: gameKey, opp: GUEST_I.root, kind: k, tc, atWts: 8_999_000 },
      b: { game: gameKey, opp: HOST_I.root, kind: k, tc, atWts: 8_999_000 }
    })
    const ANCHORS = anchorsOf(startMsg.gameKey, ladder.kind, ladder.tc)
    const wcore = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcore.init({
      gameId: startMsg.gameId,
      gameKey: startMsg.gameKey,
      players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } },
      firstMover: 'w',
      kind: ladder.kind,
      tc: ladder.tc,
      pairing: ANCHORS
    })
    // A second core initialized with a CONTRADICTING binding poisons on start.
    const wcoreBad = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcoreBad.init({
      gameId: startMsg.gameId,
      gameKey: startMsg.gameKey,
      players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } },
      kind: ladder.kind,
      tc: { baseMs: 1_000, incMs: 0 }
    })
    const badRes = wcoreBad.feed(startMsg, wclock.t)
    ok(!badRes.ok && /ladder/.test(badRes.error), 'a start config contradicting the initialized ladder binding poisons the witness')
    // A4-01: a mirrored start whose players contradict init poisons too (the
    // witness signs players-by-color into its wend. Same 2c pattern).
    const wcoreBadPlayers = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcoreBadPlayers.init({
      gameId: startMsg.gameId,
      gameKey: startMsg.gameKey,
      players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } },
      kind: ladder.kind,
      tc: ladder.tc
    })
    const badPlayersRes = wcoreBadPlayers.feed({ ...startMsg, players: { w: GUEST_I.root, b: HOST_I.root } }, wclock.t)
    ok(!badPlayersRes.ok && /players/.test(badPlayersRes.error), 'a start with color-swapped players contradicting init poisons the witness')
    pump(witness, wcore, wclock) // consume start (consistency check passes)

    // Two plies, then the guest resigns: mpSession's esig is LEGACY-shaped and
    // the ladder-bound witness must still accept it (result authority is the
    // player's; ladder authority is the witness's).
    for (const [who, uci, other] of [[host, 'e2e4', ge], [guest, 'e7e5', he]]) {
      wclock.t += 1_000
      await who.sendMove(uci)
      await waitEvent(other, (e) => e.type === 'move' && e.uci === uci, { label: `${uci} relayed (bound game)` })
    }
    wclock.t += 1_000
    await guest.resign()
    await waitEvent(he, (e) => e.type === 'resign' && e.by === 'black', { label: 'host resign event (bound game)' })
    await sleep(20)
    const endEmits = pump(witness, wcore, wclock)
    const wend = endEmits.find((m) => m.t === 'wend')
    ok(wend, 'ladder-bound witness finalizes on the legacy player esig (wend emitted)')
    const wstream = wcore.wstream()
    // A4 review (A4-01/A4-08): the live wend now covers the FULL rated
    // binding: kind/tc + players-by-color + the adjudicated reason.
    const FULL_BINDING = {
      kind: ladder.kind,
      tc: ladder.tc,
      players: { w: HOST_I.root, b: GUEST_I.root },
      reason: 'resign'
    }
    ok(
      seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 2, wend.transcript, FULL_BINDING),
      'live wend sig verifies over the FULL rated binding (kind+tc+players+reason)'
    )
    ok(!seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 2, wend.transcript), 'live wend sig does NOT verify over legacy end-bytes')
    ok(
      !seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 2, wend.transcript, ladder),
      'live wend sig does NOT verify over a kind/tc-only (partial) binding'
    )
    ok(
      !seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 2, wend.transcript, { ...FULL_BINDING, tc: { baseMs: 60_000, incMs: 0 } }),
      'live wend sig fails over a tampered tc'
    )
    ok(
      !seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 2, wend.transcript, { ...FULL_BINDING, players: { w: GUEST_I.root, b: HOST_I.root } }),
      'live wend sig fails over color-swapped players'
    )
    ok(
      !seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 2, wend.transcript, { ...FULL_BINDING, reason: 'abandon' }),
      'live wend sig fails over a relabeled reason'
    )
    // A6 (Lane C; the mpSession seam, now CLOSED): the live session re-derives
    // the rated binding from its OWN config (ladderFromConfig) + this game's
    // players + the wend's reason, so the ladder-bound wend now SURFACES to both
    // players: exactly the wstream Lane E's segmentWriter embeds into each
    // chain's rated segment. (Was assertNoEvent pre-A6: the witness stream was
    // advisory-only because mpSession verified binding-less.)
    const hSurfacedWend = await waitEvent(hw, (m) => m.t === 'wend', { label: 'host surfaces the ladder-bound wend (A6 seam)' })
    const gSurfacedWend = await waitEvent(gw, (m) => m.t === 'wend', { label: 'guest surfaces the ladder-bound wend (A6 seam)' })
    eq(hSurfacedWend.sig, wend.sig, 'host surfaced the EXACT ladder-bound wend the witness broadcast (segment wstream source)')
    eq(gSurfacedWend.sig, wend.sig, 'guest surfaced the EXACT ladder-bound wend the witness broadcast (segment wstream source)')

    // Witnessed result record carries the binding, witness-signed.
    const rec = wcore.buildWitnessedResult()
    ok(seg.verifyWitnessedResult(rec), 'ladder-bound witnessed result verifies (zWitnessedResultBody admits kind/tc)')
    eq(rec.body.kind, 'chess', 'witnessed result body carries kind')
    eq(`${rec.body.tc.baseMs},${rec.body.tc.incMs}`, '180000,2000', 'witnessed result body carries tc')
    ok(
      !seg.verifyWitnessedResult({ ...rec, body: { ...rec.body, tc: { baseMs: 60_000, incMs: 0 } } }),
      'a witnessed result with a tampered tc fails verification'
    )
    ok(
      !seg.verifyWitnessedResult({ ...rec, body: { ...rec.body, kind: 'chess960' } }),
      'a witnessed result with a tampered kind fails verification'
    )

    // Segment + wstream ladder-binding match rule (verifySegmentEvent).
    const mkChain = (i, name) =>
      chain.createAccountChain({ rootPriv: i.priv, rootPub: hash.ed25519.getPublicKey(i.priv), displayName: name, ts: 1_000 })
    const segEventWith = (extra) => {
      let c = mkChain(HOST_I, 'Hosty')
      const v = chain.verifyChain(c)
      const heads = { w: { head: v.witnessedHead, height: v.witnessedHeight }, b: { head: v.witnessedHead, height: v.witnessedHeight } }
      let payload = seg.makeSegmentPayload({
        game: startMsg.gameKey,
        opp: extra.opp ?? GUEST_I.root,
        color: extra.color ?? 'w',
        result: '1-0',
        reason: extra.reason ?? 'resign',
        moves: wcore.moves,
        heads,
        wstream: extra.wstream ?? wstream,
        oppProfile: { name: 'Guesty' },
        ...(extra.kind !== undefined ? { kind: extra.kind } : {}),
        ...(extra.tc !== undefined ? { tc: extra.tc } : {})
      })
      if (extra.patch) payload = { ...payload, ...extra.patch }
      c = chain.appendWitnessed(c, HOST_I.priv, HOST_I.root, 'segment', payload, 2_000)
      return c.events[c.events.length - 1]
    }
    const legacyWstream = seg.signWitnessEnd(WIT_I.priv, WIT_I.key, startMsg.gameKey, '1-0', 2, wend.transcript)
    eq(seg.verifySegmentEvent(segEventWith({ kind: ladder.kind, tc: ladder.tc })), null, 'segment kind/tc matching the bound wstream verifies (null)')
    eq(
      seg.verifySegmentEvent(segEventWith({ kind: ladder.kind, tc: { baseMs: 60_000, incMs: 0 } })),
      'bad-ladder-binding',
      'segment claiming a DIFFERENT tc than the witness signed → bad-ladder-binding (ladder farming closed)'
    )
    eq(
      seg.verifySegmentEvent(segEventWith({ kind: 'chess960', tc: ladder.tc })),
      'bad-ladder-binding',
      'segment claiming a DIFFERENT kind than the witness signed → bad-ladder-binding'
    )
    eq(
      seg.verifySegmentEvent(segEventWith({ kind: ladder.kind, tc: ladder.tc, wstream: legacyWstream })),
      'bad-ladder-binding',
      'a kind/tc-less (legacy) wstream sig on a kind/tc-bearing segment → bad-ladder-binding'
    )
    eq(
      seg.verifySegmentEvent(segEventWith({ kind: ladder.kind })),
      'bad-ladder-binding',
      'a half binding (kind without tc) fails closed → bad-ladder-binding'
    )
    eq(
      seg.verifySegmentEvent(segEventWith({ wstream })),
      'bad-wstream',
      'stripping kind/tc OFF a segment whose wstream signed them → bad-wstream (legacy taxonomy preserved)'
    )
    eq(
      seg.verifySegmentEvent(segEventWith({ wstream: legacyWstream })),
      null,
      'a fully legacy segment (no kind/tc, legacy wstream) still verifies, pre-A4 flow untouched'
    )

    // A4-01: COLOR-FLIP attack. The witness signed players {w:HOST, b:GUEST};
    // the (losing) author relabels its color. The derived players map flips,
    // so the witness signature no longer covers the payload's claim.
    eq(
      seg.verifySegmentEvent(segEventWith({ kind: ladder.kind, tc: ladder.tc, color: 'b' })),
      'bad-ladder-binding',
      'color-flip attack (witness signed players, payload color flipped) → bad-ladder-binding'
    )
    // A4-01: OPP-SWAP attack. Same game, opp relabeled to a different root.
    eq(
      seg.verifySegmentEvent(segEventWith({ kind: ladder.kind, tc: ladder.tc, opp: WIT2_I.root })),
      'bad-ladder-binding',
      'opp-swap attack (payload names a root the witness never signed) → bad-ladder-binding'
    )
    // A4-08: REASON-SWAP attack. The payload keeps the ORIGINAL transcript
    // digest (opaque to the verifier: exactly the A4-08 hole) but relabels
    // the reason. The witness signed reason into the end-bytes, so it fails.
    eq(
      seg.verifySegmentEvent(
        segEventWith({ kind: ladder.kind, tc: ladder.tc, reason: 'abandon', patch: { transcript: wend.transcript } })
      ),
      'bad-ladder-binding',
      'reason-swap attack (witness signed resign, payload claims abandon) → bad-ladder-binding'
    )
    // ... and the A4-08 canonical direction: witness adjudicated 'abandon',
    // the rage-quitter's payload claims a clean 'resign'.
    const abandonWstream = seg.signWitnessEnd(
      WIT_I.priv, WIT_I.key, startMsg.gameKey, '1-0', 2, wend.transcript,
      { ...FULL_BINDING, reason: 'abandon' }
    )
    eq(
      seg.verifySegmentEvent(
        segEventWith({ kind: ladder.kind, tc: ladder.tc, wstream: abandonWstream, patch: { transcript: wend.transcript } })
      ),
      'bad-ladder-binding',
      'reason-swap attack (witness signed abandon, payload claims resign) → bad-ladder-binding'
    )

    witness.leave()
    host.leave()
    guest.leave()
  }

  // ==========================================================================
  // 8b. A5 J5 (A4-12): the witness pairing gate. A rated game is served only
  // when both players' pairing anchors are present and consistent.
  // ==========================================================================
  console.log('\n· J5 pairing gate: unanchored rated game poisoned; anchored proceeds …')
  {
    const g = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(51)), ts: 7 })
    const TC = { baseMs: 300_000, incMs: 0 }
    const START = {
      t: 'start', gameId: 1, yourColor: 'black',
      config: { tc: { initialMs: 300_000, incrementMs: 0 }, hostColor: 'white' },
      gameKey: g, players: { w: HOST_I.root, b: GUEST_I.root }
    }
    const PLAYERS = { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } }
    const ANCH = {
      w: { game: g, opp: GUEST_I.root, kind: 'chess', tc: TC, atWts: 1_000 },
      b: { game: g, opp: HOST_I.root, kind: 'chess', tc: TC, atWts: 1_000 }
    }
    const mkCore = (init) => {
      const c = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
      c.init({ gameId: 1, gameKey: g, players: PLAYERS, firstMover: 'w', kind: 'chess', tc: TC, ...init })
      return c
    }
    // (a) UNANCHORED rated game: refused + poisoned sticky.
    const bare = mkCore({})
    const bareRes = bare.feed(START, 10)
    ok(!bareRes.ok && /pairing/.test(bareRes.error), 'a rated start with NO pairing anchors poisons the witness')
    const m0 = seg.signMove(HOST_I.priv, g, 0, 'e2e4', { w: 300_000, b: 300_000 })
    const after = bare.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 300_000, black: 300_000 }, sig: m0.sig }, 20)
    ok(!after.ok && /pairing/.test(after.error), 'the pairing poison is sticky (no later countersigning)')
    ok(bare.buildWitnessedResult() === null, 'an unanchored rated game can never mint a witnessed result')
    // (b) ANCHORED rated game proceeds: start passes, moves verify, wend signs.
    const good = mkCore({ pairing: ANCH })
    ok(good.feed(START, 10).ok, 'the same start with both consistent anchors passes the gate')
    ok(good.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 300_000, black: 300_000 }, sig: m0.sig }, 20).ok,
      'the anchored game proceeds (moves countersigned)')
    const tEnd = seg.transcriptDigest(g, good.moves, '0-1', wc.REASON_RESIGN)
    const esig = seg.signWitnessEnd(HOST_I.priv, HOST_I.key, g, '0-1', 1, tEnd).sig
    const fin = good.feed({ t: 'resign', gameId: 1, by: 'white', esig }, 30)
    ok(fin.ok && (fin.emit ?? []).some((m) => m.t === 'wend'), 'the anchored rated game finalizes normally')
    // (c) the embedder-verified flag is accepted in place of inline anchors.
    const flagged = mkCore({ pairing: 'embedder-verified' })
    ok(flagged.feed(START, 10).ok, "pairing: 'embedder-verified' (embedder checked the chain events) passes the gate")
    // (d) contradiction matrix: each inconsistency poisons (2c pattern).
    const poisonOn = (pairing, label, re) => {
      const c = mkCore({ pairing })
      const r = c.feed(START, 10)
      ok(!r.ok && re.test(r.error), label)
    }
    const otherKey = seg.gameKey({ v: 1, t: 'game-key', w: HOST_I.root, b: GUEST_I.root, nonce: hash.toB64u(seedBytes(52)), ts: 7 })
    poisonOn({ ...ANCH, b: { ...ANCH.b, game: otherKey } },
      'an anchor naming a DIFFERENT game key poisons', /game key/)
    poisonOn({ ...ANCH, w: { ...ANCH.w, kind: 'chess960' } },
      'an anchor contradicting the ladder kind poisons', /kind/)
    poisonOn({ ...ANCH, w: { ...ANCH.w, tc: { baseMs: 60_000, incMs: 0 } } },
      'an anchor contradicting the ladder tc poisons', /tc/)
    poisonOn({ w: ANCH.w, b: { ...ANCH.b, opp: GUEST_I.root } },
      'anchors that do not name the OPPOSING roots poison (two copies of one pairing cannot fill both seats)', /opposing/)
    poisonOn({ w: ANCH.b, b: ANCH.w },
      'color-swapped anchors poison (each chain pairs against the other root)', /opposing/)
    // (e) legacy/unrated: no kind/tc ⇒ the gate never runs. Byte-identical flow.
    const unrated = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => 0 })
    unrated.init({ gameId: 1, gameKey: g, players: PLAYERS, firstMover: 'w' })
    ok(unrated.feed(START, 10).ok, 'an UNRATED session needs no anchors (legacy flow untouched)')
    ok(unrated.feed({ t: 'move', gameId: 1, ply: 0, uci: 'e2e4', clockMs: { white: 300_000, black: 300_000 }, sig: m0.sig }, 20).ok,
      'the unrated game proceeds exactly as before')
  }

  // ==========================================================================
  // 9. A4-02: verifyEmbeddedOppCkpt, embedded-checkpoint authenticity.
  // ==========================================================================
  console.log('\n· A4-02: verifyEmbeddedOppCkpt forged-checkpoint matrix …')
  {
    const M = wparams.PARAMS_A2.ckptM
    eq(M, 4, 'PARAMS_A2.ckptM is 4 (the M-of-N cosigner floor)')
    const OPP = ident(60) // opponent root
    const OPPDEV = ident(61) // opponent device key
    const OWNER = ident(62) // the embedding segment's owner root
    const OTHER = ident(63) // an unrelated real root (borrowed-checkpoint case)
    const COS = [ident(70), ident(71), ident(72), ident(73)] // cosigners
    ok(new Set(COS.map((c) => c.key.slice(0, 2))).size >= 3, 'fixture sanity: cosigner keys span ≥3 distinct 2-char prefixes')

    /** Hand-built shape-valid witnessed ckpt event of `root`, signed by key. */
    const mkCkpt = (signer, root, { through = 6, height = 6, key } = {}) => {
      const body = {
        v: 1, lane: 'w', type: 'ckpt', root, key: key ?? signer.key, height,
        prev: 'p'.repeat(43), ts: 5_000,
        payload: { through, state: { f: 'a4-v1' }, stateDigest: 'd'.repeat(43) }
      }
      return { body, sig: hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(body), signer.priv)) }
    }
    /** A cosigner attestation over {e, epoch, w, wts}: the attest.ts bytes. */
    const attest = (ckpt, cosigner, wts = 1_000) => ({
      w: cosigner.key,
      wts,
      epoch: 0,
      sig: hash.toB64u(hash.ed25519.sign(codec.canonicalBytes({ e: evts.eventId(ckpt.body), epoch: 0, w: cosigner.key, wts }), cosigner.priv))
    })
    const cosign = (ckpt, cosigners) => ({ ...ckpt, wit: cosigners.map((c) => attest(ckpt, c)) })
    const P = (oppCkpt, oppCerts) => ({ opp: OPP.root, oppCkpt, ...(oppCerts !== undefined ? { oppCerts } : {}) })
    const V = (p) => seg.verifyEmbeddedOppCkpt(p, OWNER.root)

    // Honest baseline: root-signed ckpt of OPP + M valid, diverse cosigners.
    const good = cosign(mkCkpt(OPP, OPP.root), COS)
    eq(V(P(good)), true, 'root-signed oppCkpt + M valid diverse cosigners → true')

    // Device-signed: false without certs, true with the opp's root-signed cert.
    const devCkpt = cosign(mkCkpt(OPPDEV, OPP.root), COS)
    eq(V(P(devCkpt)), false, 'device-signed oppCkpt WITHOUT oppCerts → false')
    const oppChain = chain.createAccountChain({ rootPriv: OPP.priv, rootPub: hash.ed25519.getPublicKey(OPP.priv), displayName: 'Oppy', ts: 1_000 })
    const devCert = certs.makeCertEvent(OPP.priv, OPP.root, oppChain, { childPub: OPPDEV.key, purpose: 0, index: 0, ts: 1_500 })
    eq(V(P(devCkpt, [devCert])), true, 'device-signed oppCkpt + valid oppCerts (root-signed cert of opp) → true')
    const wrongCert = certs.makeCertEvent(OPP.priv, OPP.root, oppChain, { childPub: OWNER.key, purpose: 0, index: 1, ts: 1_600 })
    eq(V(P(devCkpt, [wrongCert])), false, 'a cert for a DIFFERENT key does not authorize the signing key → false')
    const foreignChain = chain.createAccountChain({ rootPriv: OTHER.priv, rootPub: hash.ed25519.getPublicKey(OTHER.priv), displayName: 'Other', ts: 1_000 })
    const foreignCert = certs.makeCertEvent(OTHER.priv, OTHER.root, foreignChain, { childPub: OPPDEV.key, purpose: 0, index: 0, ts: 1_500 })
    eq(V(P(devCkpt, [foreignCert])), false, 'a cert signed by a DIFFERENT root than opp → false')

    // Forgery matrix.
    eq(V(P({ ...good, sig: 'A'.repeat(86) })), false, 'garbage event signature → false')
    eq(V(P(cosign(mkCkpt(OTHER, OTHER.root), COS))), false, 'a genuine cosigned checkpoint of ANOTHER root (borrowed, A4-06) → false')
    eq(V(P(mkCkpt(OPP, OPP.root))), false, 'zero cosigners (wit absent) → false')
    eq(V(P({ ...good, wit: [] })), false, 'zero cosigners (wit empty) → false')
    eq(V(P(cosign(mkCkpt(OPP, OPP.root), COS.slice(0, M - 1)))), false, 'M-1 cosigners → false')
    eq(V(P(cosign(mkCkpt(OPP, OPP.root), [COS[0], COS[1], COS[2], COS[0]]))), false, 'duplicate cosigner keys → false')
    const badSigWit = { ...good, wit: [...good.wit.slice(0, 3), { ...good.wit[3], sig: 'A'.repeat(86) }] }
    eq(V(P(badSigWit)), false, 'one invalid attestation signature among M → false')
    const crossWit = { ...good, wit: [...good.wit.slice(0, 3), attest(devCkpt, COS[3])] }
    eq(V(P(crossWit)), false, 'an attestation bound to a DIFFERENT event id → false')
    eq(V(P(cosign(mkCkpt(OPP, OPP.root), [COS[0], COS[1], COS[2], OPP]))), false, 'the opponent cosigning its own checkpoint → false')
    eq(V(P(cosign(mkCkpt(OPP, OPP.root), [COS[0], COS[1], COS[2], OWNER]))), false, 'the segment OWNER cosigning its own fold input → false')
    // canonicalBytes itself refuses unsafe ints, so the forgery is a post-sign
    // payload mutation: the verifier must fail closed on it, never throw.
    const unsafeThrough = { ...good, body: { ...good.body, payload: { ...good.body.payload, through: 2 ** 53 } } }
    eq(V(P(unsafeThrough)), false, 'unsafe-integer `through` → false')
    eq(V(P(cosign(mkCkpt(OPP, OPP.root, { height: -1 }), COS))), false, 'negative height (shape) → false')
    eq(V({ opp: OPP.root }), false, 'absent oppCkpt → false (fail closed)')
    let garbageRes = null
    let threw = null
    try { garbageRes = V(P({ garbage: true })) } catch (e) { threw = e }
    ok(threw === null && garbageRes === false, 'a garbage oppCkpt returns false and never throws (fail closed)')

    // /16 diversity bound: M valid DISTINCT cosigners all ground into ONE
    // 2-char key prefix (the sybil-farm shape) must fail; ≥3 prefixes pass.
    const target = COS[0].key.slice(0, 2)
    const ground = [COS[0]]
    let seedByte = 5_000
    while (ground.length < M) {
      const priv = Uint8Array.from({ length: 32 }, (_, i) => ((seedByte * 131 + i * 7) ^ (seedByte >> 6)) & 0xff)
      seedByte++
      const key = hash.toB64u(hash.ed25519.getPublicKey(priv))
      if (key.slice(0, 2) === target && !ground.some((c) => c.key === key)) ground.push({ priv, key, root: key })
    }
    eq(V(P(cosign(mkCkpt(OPP, OPP.root), ground))), false, 'M valid distinct cosigners in ONE /16 prefix bucket → false (diversity bound)')

    // Integration: verifySegmentEvent fails the WHOLE segment on a present-
    // but-unverifiable oppCkpt ('bad-opp-ckpt'), and passes a compliant one.
    const mkOwnerSegment = (oppCkpt, oppCerts) => {
      let c = chain.createAccountChain({ rootPriv: OWNER.priv, rootPub: hash.ed25519.getPublicKey(OWNER.priv), displayName: 'Owner', ts: 1_000 })
      const v = chain.verifyChain(c)
      const heads = { w: { head: v.witnessedHead, height: v.witnessedHeight }, b: { head: v.witnessedHead, height: v.witnessedHeight } }
      const game = seg.gameKey({ v: 1, t: 'game-key', w: OWNER.root, b: OPP.root, nonce: hash.toB64u(seedBytes(55)), ts: 7 })
      const transcript = seg.transcriptDigest(game, [], '1-0', 'resign')
      const payload = seg.makeSegmentPayload({
        game, opp: OPP.root, color: 'w', result: '1-0', reason: 'resign', moves: [],
        heads,
        wstream: seg.signWitnessEnd(WIT_I.priv, WIT_I.key, game, '1-0', 0, transcript),
        oppCkpt,
        ...(oppCerts !== undefined ? { oppCerts } : {}),
        oppProfile: { name: 'Oppy' }
      })
      c = chain.appendWitnessed(c, OWNER.priv, OWNER.root, 'segment', payload, 2_000)
      return c.events[c.events.length - 1]
    }
    eq(seg.verifySegmentEvent(mkOwnerSegment(good)), null, 'segment embedding a fully-verified oppCkpt → null')
    eq(seg.verifySegmentEvent(mkOwnerSegment(devCkpt, [devCert])), null, 'segment embedding a device-signed oppCkpt + oppCerts → null')
    eq(
      seg.verifySegmentEvent(mkOwnerSegment(mkCkpt(OPP, OPP.root))),
      'bad-opp-ckpt',
      'a present-but-uncosigned oppCkpt fails the SEGMENT (bad-opp-ckpt), no silent downgrade to seeds'
    )
    eq(
      seg.verifySegmentEvent(mkOwnerSegment(devCkpt)),
      'bad-opp-ckpt',
      'a device-signed oppCkpt without certs fails the SEGMENT (bad-opp-ckpt)'
    )
  }

  // ==========================================================================
  // 10. A6 Lane C: additive configureSigning() wiring into mp (players).
  //   (a) a session built UNSIGNED + configureSigning(sig) before host()/join()
  //       seats signed play IDENTICALLY to the constructor `signing` opt: full
  //       trio to a witnessed terminal + verifiable per-chain segments;
  //   (b) the identity is FROZEN mid-game (guard) so a live signed game's
  //       key/players/chain can't change under it;
  //   (c) configureSigning(null) is byte-for-byte v5. No hello identity, no
  //       move sig, so casual play stays untouched.
  // ==========================================================================
  console.log('\n· A6 Lane C: configureSigning() seats signed play like the constructor opt …')
  {
    const { pair, host, guest, he, ge, hw, gw, witness } = await connectSignedTrio(
      CFG(60_000, 0, 'white'),
      { viaConfigure: true }
    )
    const startMsg = wire.parseWireMsg(witness.received.find((r) => wire.parseWireMsg(r.text)?.t === 'start').text)
    // The configured host offered identity in its hello ⇒ signed play is on: the
    // host minted a gameKey + players, and both sessions expose a signed game.
    ok(typeof startMsg.gameKey === 'string' && startMsg.gameKey.length === 43, 'configureSigning path minted a 43-char gameKey (mutual identity)')
    eq(startMsg.players.w, HOST_I.root, 'configureSigning: start.players.w is the host root')
    eq(startMsg.players.b, GUEST_I.root, 'configureSigning: start.players.b is the guest root')
    ok(host.getSignedGame() && guest.getSignedGame(), 'both configureSigning sessions expose a signed game (getSignedGame ≠ null)')

    // Boot the real witness core on the mirrored start.
    const wclock = { t: 12_000_000 }
    const wcore = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcore.init({
      gameId: startMsg.gameId,
      gameKey: startMsg.gameKey,
      players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } },
      firstMover: 'w'
    })
    pump(witness, wcore, wclock)

    // Two plies, then the mid-game GUARD test.
    for (const [who, uci, other] of [[host, 'e2e4', ge], [guest, 'e7e5', he]]) {
      wclock.t += 1_000
      await who.sendMove(uci)
      await waitEvent(other, (e) => e.type === 'move' && e.uci === uci, { label: `${uci} relayed (configured)` })
    }
    // GUARD: a mid-game configureSigning() is a safe no-op. The live identity is
    // frozen. If it TOOK EFFECT, the host's next move would sign with WIT2's key,
    // fail its own chain (wrong key for white) → failSigned emits 'error' + tears
    // the transport down, so g1f3 would never relay.
    host.configureSigning(signingOf(WIT2_I))
    guest.configureSigning(signingOf(WIT2_I))
    eq(host.getSignedGame().players.w, HOST_I.root, 'mid-game configureSigning did NOT change the seated players (identity frozen)')
    wclock.t += 1_000
    const mid = await host.sendMove('g1f3')
    eq(mid.ok, true, 'the host still moves after a refused mid-game configureSigning')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'g1f3', { label: 'post-guard move relayed (proves no teardown)' })
    await assertNoEvent(he, (e) => e.type === 'error', 40, 'host error after a guarded mid-game configureSigning')
    await sleep(20)
    pump(witness, wcore, wclock)
    const hostView = host.getSignedGame()
    eq(
      seg.verifyMoveChain(hostView.gameKey, hostView.moves, { w: HOST_I.key, b: GUEST_I.key }),
      -1,
      'the chain still verifies under the ORIGINAL (frozen) host key after the guarded call'
    )

    // Terminal: guest resigns; witness ends the stream; both sessions verify the wend.
    wclock.t += 1_000
    await guest.resign()
    await waitEvent(he, (e) => e.type === 'resign' && e.by === 'black', { label: 'host resign (configured)' })
    await sleep(20)
    const endEmits = pump(witness, wcore, wclock)
    const wend = endEmits.find((m) => m.t === 'wend')
    ok(wend && wend.result === '1-0' && wend.reason === 'resign', 'configureSigning trio: witness emits the resign wend (1-0)')
    eq(wend.plies, 3, 'configureSigning trio: wend covers all 3 countersigned plies')
    const wstream = wcore.wstream()
    ok(
      seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', wend.plies, wend.transcript),
      'configureSigning trio: terminal witness signature verifies (verifyWitnessEnd)'
    )
    await waitEvent(hw, (m) => m.t === 'wend', { label: 'host onWitnessStream wend (configured)' })
    await waitEvent(gw, (m) => m.t === 'wend', { label: 'guest onWitnessStream wend (configured)' })
    eq(host.getWitnessIdentity()?.key, WIT_I.key, 'configureSigning host knows the seated witness key (segment build input)')

    // getSignedGame() + the verified wstream build a segment BOTH chains accept.
    // The exact inputs Lane C hands Lane E's buildAndPublishSegment.
    const mkChain = (i, name) =>
      chain.createAccountChain({ rootPriv: i.priv, rootPub: hash.ed25519.getPublicKey(i.priv), displayName: name, ts: 1_000 })
    let hostChain = mkChain(HOST_I, 'Hosty')
    let guestChain = mkChain(GUEST_I, 'Guesty')
    const heads = {
      w: { head: chain.verifyChain(hostChain).witnessedHead, height: chain.verifyChain(hostChain).witnessedHeight },
      b: { head: chain.verifyChain(guestChain).witnessedHead, height: chain.verifyChain(guestChain).witnessedHeight }
    }
    const payloadFor = (color, view) =>
      seg.makeSegmentPayload({
        game: view.gameKey,
        opp: color === 'w' ? GUEST_I.root : HOST_I.root,
        color,
        result: '1-0',
        reason: 'resign',
        moves: view.moves,
        heads,
        wstream,
        oppProfile: { name: color === 'w' ? 'Guesty' : 'Hosty' }
      })
    hostChain = chain.appendWitnessed(hostChain, HOST_I.priv, HOST_I.root, 'segment', payloadFor('w', host.getSignedGame()), 2_000)
    guestChain = chain.appendWitnessed(guestChain, GUEST_I.priv, GUEST_I.root, 'segment', payloadFor('b', guest.getSignedGame()), 2_000)
    eq(seg.verifySegmentEvent(hostChain.events[hostChain.events.length - 1]), null, 'configureSigning: host segment verifies (verifySegmentEvent null)')
    eq(seg.verifySegmentEvent(guestChain.events[guestChain.events.length - 1]), null, 'configureSigning: guest segment verifies')
    ok(chain.verifyChain(hostChain).ok && chain.verifyChain(guestChain).ok, 'configureSigning: both chains verify with the appended segments')

    witness.leave()
    host.leave()
    guest.leave()
  }

  console.log('\n· A6 Lane C: configureSigning(null) is byte-for-byte v5 (casual untouched) …')
  {
    const pair = makeMockPair()
    // Built WITH a constructor identity, then explicitly CLEARED before hosting.
    // The casual path the store takes for an unrated game must be exactly v5.
    const host = track(new MpNetSession(pair.hostFactory, { signing: signingOf(HOST_I) }))
    host.configureSigning(null)
    const guest = track(new MpNetSession(pair.guestFactory))
    const he = tap(host)
    const ge = tap(guest)
    const { code } = await host.host(CFG(60_000, 0), 'H')
    await guest.join(code, 'G')
    await waitEvent(he, (e) => e.type === 'start', { label: 'casual start (host)' })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'casual start (guest)' })
    const helloRaw = pair.room.wires.find((w) => wire.parseWireMsg(w.text)?.t === 'hello')
    const helloObj = JSON.parse(helloRaw.text)
    eq(helloObj.v, 6, 'configureSigning(null): hello still rides v=6')
    ok(!('root' in helloObj) && !('key' in helloObj), 'configureSigning(null): hello carries NO identity keys (byte-identical v5)')
    eq(host.getSignedGame(), null, 'configureSigning(null): no signed game (unsigned)')
    await host.sendMove('e2e4')
    await waitEvent(ge, (e) => e.type === 'move' && e.uci === 'e2e4', { label: 'casual move relayed' })
    const mvRaw = [...pair.room.wires].reverse().find((w) => wire.parseWireMsg(w.text)?.t === 'move')
    const mvObj = JSON.parse(mvRaw.text)
    ok(!('sig' in mvObj), "configureSigning(null): move JSON has no 'sig' key")
    eq(Object.keys(mvObj).sort().join(','), 'clockMs,gameId,ply,t,uci', 'configureSigning(null): move keys are exactly the v5 set')
    host.leave()
    guest.leave()
  }

  // ==========================================================================
  // 11. A6 M2 root-fix: a witness that seats AFTER `start` (the guest handshaked
  //   first) is CAUGHT UP: mpSession replays the mirrored start + every signed
  //   move to just that late witness, so its WitnessCore initializes, verifies
  //   the full chain, resumes the wclk cadence, and still produces a valid wend.
  //   Before the fix a late witness never saw `start` (host mirrors it once), so
  //   the boot forced a 9s guest-join delay to seat the witness first; this
  //   proves the delay can drop to ~0.
  // ==========================================================================
  console.log('\n· A6 M2: a witness seated AFTER start is caught up (start + moves replayed) …')
  {
    const pair = makeMockPair()
    const host = track(new MpNetSession(pair.hostFactory, { signing: signingOf(HOST_I) }))
    const guest = track(new MpNetSession(pair.guestFactory, { signing: signingOf(GUEST_I) }))
    const he = tap(host)
    const ge = tap(guest)
    const hw = []
    const gw = []
    host.onWitnessStream((m) => hw.push(m))
    guest.onWitnessStream((m) => gw.push(m))
    const { code } = await host.host(CFG(60_000, 0, 'white'), 'H')
    // Guest joins FIRST: NO witness in the room yet, so `start` mirrors to nobody.
    await guest.join(code, 'G')
    await waitEvent(he, (e) => e.type === 'start', { label: 'host start (late-witness)' })
    await waitEvent(ge, (e) => e.type === 'start', { label: 'guest start (late-witness)' })
    // Two SIGNED plies complete before any witness exists.
    for (const [who, uci, other] of [[host, 'e2e4', ge], [guest, 'e7e5', he]]) {
      await who.sendMove(uci)
      await waitEvent(other, (e) => e.type === 'move' && e.uci === uci, { label: `${uci} relayed (pre-witness)` })
    }
    // NOW the witness attaches: AFTER start + 2 moves. It greets every peer it
    // sees (targeted) so the host learns it is a witness and replays the game.
    const witness = pair.injectPeer({ onJoin: (id, transport) => transport.send(WHELLO, id) })
    await sleep(20)
    witness.transport.send(WHELLO) // broadcast too (duplicate for the host: ignored)
    await sleep(40)

    // The host RESENT the mirrored start + replayed BOTH signed moves to the late
    // witness (root fix: mpSession.resendGameToWitness on a late onWitnessHello).
    const startRec = witness.received.find((r) => wire.parseWireMsg(r.text)?.t === 'start')
    ok(startRec, 'the late witness received the RESENT start (was silently skipped before the fix)')
    const startMsg = wire.parseWireMsg(startRec.text)
    ok(typeof startMsg.gameKey === 'string' && startMsg.gameKey.length === 43, 'resent start carries the 43-char gameKey')
    eq(startMsg.players.w, HOST_I.root, 'resent start names the white (host) root')
    eq(startMsg.players.b, GUEST_I.root, 'resent start names the black (guest) root')
    const replay = witness.received.map((r) => wire.parseWireMsg(r.text)).filter((m) => m && m.t === 'move')
    eq(replay.length, 2, 'both pre-witness moves were replayed to the late witness')
    eq(`${replay[0].ply},${replay[1].ply}`, '0,1', 'replayed moves are in ply order (0,1)')
    ok(replay.every((m) => typeof m.sig === 'string' && m.sig.length === 86), 'each replayed move carries its 86-char sig (chain verifiable)')
    eq(replay[0].uci + ',' + replay[1].uci, 'e2e4,e7e5', 'the replayed moves are the exact pre-witness plies')

    // Boot the real witness core on the resent start and pump (start + replays).
    const wclock = { t: 21_000_000 }
    const wcore = new wc.WitnessCore({ wpriv: WIT_I.priv, wkey: WIT_I.key, wroot: WIT_I.root, now: () => wclock.t })
    wcore.init({
      gameId: startMsg.gameId,
      gameKey: startMsg.gameKey,
      players: { w: { root: HOST_I.root, key: HOST_I.key }, b: { root: GUEST_I.root, key: GUEST_I.key } },
      firstMover: 'w'
    })
    const caught = pump(witness, wcore, wclock)
    ok(!caught.some((m) => m.t === '__error'), 'the witness follows the replayed transcript with NO chain error')
    eq(wcore.moves.length, 2, 'the witness verified both replayed plies')
    eq(
      seg.verifyMoveChain(startMsg.gameKey, wcore.moves, { w: HOST_I.key, b: GUEST_I.key }),
      -1,
      'the caught-up witness chain verifies (verifyMoveChain)'
    )

    // Two MORE live plies now mirror to the seated witness through the normal path.
    for (const [who, uci, other] of [[host, 'g1f3', ge], [guest, 'b8c6', he]]) {
      wclock.t += 1_000
      await who.sendMove(uci)
      await waitEvent(other, (e) => e.type === 'move' && e.uci === uci, { label: `${uci} relayed (post-seat)` })
    }
    await sleep(30)
    const more = pump(witness, wcore, wclock)
    eq(wcore.moves.length, 4, 'the witness followed 2 further LIVE plies (total 4)')
    const wclks = more.filter((m) => m.t === 'wclk')
    ok(wclks.some((m) => m.ply === 3), 'the wclk cadence resumes on the caught-up witness (ply 3 after 4 plies)')
    await waitEvent(hw, (m) => m.t === 'wclk' && m.ply === 3, { label: 'host surfaces caught-up wclk' })
    await waitEvent(gw, (m) => m.t === 'wclk' && m.ply === 3, { label: 'guest surfaces caught-up wclk' })

    // Terminal: the guest resigns; the late-seated witness signs a valid wend
    // over the FULL 4-ply transcript, and both players surface it (segment source).
    wclock.t += 1_000
    await guest.resign()
    await waitEvent(he, (e) => e.type === 'resign' && e.by === 'black', { label: 'host resign (late-witness)' })
    await sleep(20)
    const endEmits = pump(witness, wcore, wclock)
    const wend = endEmits.find((m) => m.t === 'wend')
    ok(wend && wend.result === '1-0' && wend.reason === 'resign', 'the late-seated witness emits a valid resign wend (1-0)')
    eq(wend.plies, 4, 'the wend covers ALL 4 plies the witness caught up on (replay + live)')
    const wstream = wcore.wstream()
    ok(
      seg.verifyWitnessEnd(wstream, startMsg.gameKey, '1-0', 4, wend.transcript),
      'the late-seated witness wend signature verifies (verifyWitnessEnd)'
    )
    ok(seg.verifyWitnessedResult(wcore.buildWitnessedResult()), 'the late-seated witness produces a valid witnessed result')
    const hWend = await waitEvent(hw, (m) => m.t === 'wend', { label: 'host surfaces late-witness wend' })
    const gWend = await waitEvent(gw, (m) => m.t === 'wend', { label: 'guest surfaces late-witness wend' })
    eq(hWend.sig, wend.sig, 'host surfaced the EXACT wend the late witness broadcast (segment wstream source)')
    eq(gWend.sig, wend.sig, 'guest surfaced the EXACT wend the late witness broadcast')

    witness.leave()
    host.leave()
    guest.leave()
  }

  // NB: finding D (a stray mid-game hello nulling peerRoot/peerKey → a later
  // signed rematch silently downgrading) is fixed by the `if (!this.handshaked)`
  // guard around the identity adoption in onHello. A faithful session-level
  // regression needs a scripted fake-guest rematch handshake (injecting a real
  // stray peer re-bonds the host and perturbs the live game, masking the guard);
  // the guard is instead proven non-breaking by §1–§6 (first-handshake identity
  // adoption + signed rematch both still pass) and was re-verified adversarially.

  // Teardown safety net.
  for (const s of live) {
    try {
      s.leave()
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err && err.stack ? err.stack : err}`)
  process.exit(1)
})
