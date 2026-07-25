// A6 M2 real-relay SMOKE worker: one peer, in its own worker thread (fresh
// trystero module state ⇒ its own selfId + relay socket, the multi-process
// requirement). Runs the app's REAL M2 modules over the REAL trystero + werift
// transport (pointed at a localhost Nostr relay, since public relays rate-limit
// a bare-node mesh) to prove the MATCHMAKING → game handoff end-to-end:
//
//   • createBrowserFabric (Lane A) with an INJECTED werift+relay trystero room.
//   • startAccountPeerSingleton (Lane B): overlay + witnessServe/memberServe +
//     signed presence over that fabric (the witness candidate directory).
//   • matchmakingStore.startRatedSearch / offerWitnessing (M2 L-mm) over a REAL
//     werift+relay trystero POOL room: two strangers auto-pair with NO code
//     exchanged; a distinct third peer self-assigns as the witness.
//   • createLeaseRunner + createRatedGamePrep (M2 L-lease): before move 1 each
//     player acquires the live write lease at a monotonic epoch AND anchors the
//     REAL witnessed 'pairing' event in its own chain (§3/§4/§8).
//   • MpNetSession (Lane C, SIGNED) over a werift+relay game transport, driven by
//     the matchmaking handoff (openRoom = host/white, joinRoom = guest/black).
//   • startWitnessing (witnessController → Lane D) over the same transport.
//   • createSegmentPublisher (Lane E): the countersigned rated segment lands at
//     the SAME lease epoch as the pairing; the a4 fold moves both ladders.
//
// The handoffs mirror accountNetBoot.ts's configureMatchmaking exactly, with the
// game transport INJECTED (the boot uses the browser `mp` singleton over native
// WebRTC; here we drive an MpNetSession over werift, the only transport a bare
// node worker has). Every M2 module under test is identical to the shipping one.

import { parentPort, workerData } from 'node:worker_threads'
import { joinRoom } from 'trystero'
import { RTCPeerConnection } from 'werift'

import { createAccountChain, ed25519, toB64u, verifyChain, witnessedHeadOf } from '@shared/accounts'
import { sha256, utf8 } from '@shared/accounts/hash'
import { nodeIdOf } from '@shared/accounts/witness'
import { verifySegmentEvent } from '@shared/accounts/segment'
import { normalizeRoomCode } from '@shared/mp/wire'
import type { Chain, SignedEvent } from '@shared/accounts/types'

import {
  MpNetSession,
  type MpTransport,
  type MpTransportFactory,
  type MpTransportListeners,
  type MpWitnessMsg,
} from '@renderer/features/play/online/mpSession'
import { createBrowserFabric, FABRIC_APP_ID, FABRIC_ROOM_DEFAULT, type FabricRoom } from '@renderer/features/account/net/browserFabric'
import { startAccountPeerSingleton, getAccountPeer } from '@renderer/features/account/net/peerService'
import { createLeaseRunner, type LeaseRunner } from '@renderer/features/account/net/leaseRunner'
import {
  createRatedGamePrep,
  createSegmentPublisher,
  installPreGameServing,
  type ChainHolder,
  type DeviceSigning,
  type RatedGameStart,
} from '@renderer/features/account/net/segmentPublisher'
import { startWitnessing } from '@renderer/features/account/net/witnessController'
import {
  configureMatchmaking,
  createTrysteroMatchPool,
  ladderIdOf,
  matchmakingStore,
  poolRoomId,
  MM_DEFAULT_TC,
  MM_KIND,
  type MatchAssignment,
  type MatchPool,
} from '@renderer/features/account/net/matchmaking'
import type { WitnessRunnerHandle } from '@renderer/features/account/net/witnessRunner'
import { requestPreGameSnapshot, verifyPairingEvent } from '@renderer/features/account/net/preGame'
import { pairViewOf } from '@shared/accounts/ratings/display'
import { foldChainA4 } from '@renderer/features/account/store/derive'

// ---------------------------------------------------------------------------
// workerData: role + relay + identity seed + game parameters
// ---------------------------------------------------------------------------
interface PeerInit {
  role: 'searcher' | 'witness'
  relayUrl: string
  seed: number
  tc: { initialMs: number; incrementMs: number }
  /** Searcher: wait this long after boot before startRatedSearch, so the fabric
   *  + pool meshes with the (already-present) witness settle first. The offer is
   *  a one-shot broadcast, so the witness must be connected before it is sent. */
  warmupMs?: number
}
const init = workerData as PeerInit
const post = (m: unknown): void => parentPort!.postMessage(m)
const log = (msg: string): void => post({ type: 'log', role: init.role, seed: init.seed, msg })
const BLITZ_BASE = { baseMs: init.tc.initialMs, incMs: init.tc.incrementMs }
const KIND = MM_KIND
const LADDER = 'Blitz' as const
const LADDER_ID = ladderIdOf(LADDER)
const SEED_MICRO = 1200 * 1_000_000
const RD_MICRO = 350 * 1_000_000
/** The guest waits this long after accepting the offer before joining, so the
 *  witness seats first (the host mirrors 'start' once, on the guest's hello, and
 *  never resends it to a late-seated witness). Mirrors accountNetBoot's delay. */
const WITNESS_SEAT_DELAY_MS = 9_000
/** After 'start', let the game-room mesh (esp. witness↔guest) settle before the
 *  game runs to its one-shot terminal wend broadcast. */
const GAME_MESH_SETTLE_MS = 5_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Deterministic identity (raw keypairs, like the M1 smoke), root ≠ device
// ---------------------------------------------------------------------------
const kp = (b: number): { priv: Uint8Array; pub: Uint8Array; pubB: string } => {
  const priv = Uint8Array.from({ length: 32 }, (_, i) => (b * 7 + i) & 0xff)
  const pub = ed25519.getPublicKey(priv)
  return { priv, pub, pubB: toB64u(pub) }
}
const rootKp = kp(init.seed)
const devKp = kp(init.seed + 100)
const signing: DeviceSigning = { root: rootKp.pubB, key: devKp.pubB, priv: devKp.priv }
const chain0: Chain = createAccountChain({
  rootPriv: rootKp.priv,
  rootPub: rootKp.pub,
  displayName: `${init.role}-${init.seed}`,
  ts: Date.now(),
  device: { pub: devKp.pubB, index: 0, label: 'smoke device' },
})
let ownChain: Chain = chain0
const chainHolder: ChainHolder = { get: () => ownChain, set: (c) => { ownChain = c } }

// ---------------------------------------------------------------------------
// Real trystero+werift transports pointed at the local relay
// ---------------------------------------------------------------------------
const relayCfg = { urls: [init.relayUrl], redundancy: 1 }
const baseRtc = {
  rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  rtcConfig: { iceServers: [] as RTCIceServer[] },
  relayConfig: relayCfg,
}

/** A werift+relay game transport: the rtcTransport.ts adapter, verbatim shape
 *  (identical to the M1 smoke's gameTransport). */
const gameTransport: MpTransportFactory = (roomCode, listeners: MpTransportListeners): MpTransport => {
  const canonical = normalizeRoomCode(roomCode) ?? roomCode
  const room = joinRoom({ appId: 'chess-sharp-mp-v3', password: 'chs-' + canonical, ...baseRtc }, canonical)
  const msg = (room as unknown as FabricRoom).makeAction('m', {}) as unknown as {
    send: (t: string, o?: { target?: string }) => Promise<void> | void
    onMessage: ((d: unknown, c: { peerId: string }) => void) | null
  }
  msg.onMessage = (data, ctx): void => { if (typeof data === 'string') listeners.onMessage(data, ctx.peerId) }
  ;(room as unknown as { onPeerJoin: (id: string) => void }).onPeerJoin = (id): void => listeners.onPeerJoin(id)
  ;(room as unknown as { onPeerLeave: (id: string) => void }).onPeerLeave = (id): void => listeners.onPeerLeave(id)
  let resolveClosed = (): void => {}
  const closed = new Promise<void>((res) => { resolveClosed = res })
  return {
    send(text: string, toPeer?: string): void {
      try {
        const p = toPeer ? msg.send(text, { target: toPeer }) : msg.send(text)
        void Promise.resolve(p).catch((e) => listeners.onSendError?.(e))
      } catch (e) { listeners.onSendError?.(e) }
    },
    stopRelayPoll() {},
    closed,
    close(): void {
      try { void Promise.resolve((room as unknown as { leave: () => unknown }).leave()).catch(() => {}).finally(resolveClosed) } catch { resolveClosed() }
    },
  }
}

/** The account fabric room over werift+relay, injected into createBrowserFabric. */
function makeFabric(): ReturnType<typeof createBrowserFabric> {
  const room = joinRoom({ appId: FABRIC_APP_ID, password: 'chs-accts-fabric-smoke', ...baseRtc }, FABRIC_ROOM_DEFAULT)
  return createBrowserFabric({ nodeId: nodeIdOf(signing.root), room: room as unknown as FabricRoom })
}

/** Wrap a MatchPool so OUR OWN publish never wakes OUR OWN subscribers. Only a
 *  REMOTE message does (mirrors accountNetBoot.nonReentrantPool). Without it the
 *  live search self-publishes → notify → poll → publish → … forever. */
function nonReentrantPool(inner: MatchPool): MatchPool {
  let selfPublishing = false
  const subs = new Set<() => void>()
  inner.subscribe(() => { if (!selfPublishing) subs.forEach((f) => f()) })
  return {
    publish(m): void { selfPublishing = true; try { inner.publish(m) } finally { selfPublishing = false } },
    list: () => inner.list(),
    retract: (root) => inner.retract(root),
    subscribe(cb): () => void { subs.add(cb); return () => { subs.delete(cb) } },
    close: () => inner.close(),
  }
}

/** A werift+relay matchmaking POOL room per (kind, ladder), injected into the
 *  real createTrysteroMatchPool: the SAME makeAction(message) contract the
 *  browser fabric uses, so a raw trystero room satisfies it (M1-proven). */
function makePool(kind: string, ladderId: string): MatchPool {
  const room = joinRoom({ appId: FABRIC_APP_ID, password: 'chs-mm-pool-smoke', ...baseRtc }, poolRoomId(kind, ladderId))
  return nonReentrantPool(createTrysteroMatchPool({ kind, ladderId, room: room as unknown as never }))
}

// ---------------------------------------------------------------------------
// M2 lifecycle objects (real modules): lease runner, prep, segment publisher
// ---------------------------------------------------------------------------
let leaseRunner: LeaseRunner | null = null
let ratedGamePrep: ((s: RatedGameStart) => Promise<{ ok: true; epoch: number } | { ok: false; reason: string }>) | null = null
let publish: ((o: SignedOutcome) => void) | null = null
let activeWitness: WitnessRunnerHandle | null = null
let stopOffer: (() => void) | null = null

interface SignedOutcome {
  signed: { gameKey: string; players: { w: string; b: string }; moves: readonly unknown[] }
  witness: { root: string; key: string }
  wend: Extract<MpWitnessMsg, { t: 'wend' }>
  color: 'w' | 'b'
  result: '1-0' | '0-1' | '1/2-1/2'
  reason: string
  kind: string
  tc: { baseMs: number; incMs: number }
  config: unknown
}

/** Seed the players' current heads into THIS peer's witnessServe attest cache so
 *  their pre-game 'pairing' appends get our non-player attestation (mirrors
 *  accountNetBoot.seedWitnessHeads: the built-in seed is gated on a gameKey we
 *  don't have at attach). The head is game-independent; a placeholder game fetches it. */
async function seedWitnessHeads(code: string, participants: ReadonlyArray<{ root: string }>): Promise<void> {
  const peer = getAccountPeer()
  if (!peer) return
  const seedGame = toB64u(sha256(utf8(`mm-witness-seed:${code}`)))
  for (const p of participants) {
    for (let i = 0; i < 10; i++) {
      const snap = await requestPreGameSnapshot({ fabric: peer.fabric, opp: nodeIdOf(p.root), game: seedGame, selfRoot: signing.root, expectOppRoot: p.root })
      if (snap.ok) {
        await peer.witness.seedHead(p.root, { id: snap.snapshot.body.head, height: snap.snapshot.body.height })
        log(`seeded head for ${p.root.slice(0, 8)}… @ height ${snap.snapshot.body.height}`)
        break
      }
      await sleep(1_000)
    }
  }
}

async function boot(): Promise<void> {
  const fabric = makeFabric()
  const peer = await startAccountPeerSingleton({
    identity: { root: signing.root, key: signing.key, priv: signing.priv },
    fabric,
    // Fast presence heartbeat so a late-joining peer learns our nodeId→peerId
    // quickly over the real fabric (the smoke can't wait the 60s app cadence).
    announceIntervalMs: 1_000,
  })
  installPreGameServing({ peer, chain: chainHolder, signing, profile: () => ({ name: `${init.role}-${init.seed}` }) })

  leaseRunner = createLeaseRunner({
    fabric: peer.fabric,
    identity: { root: signing.root, key: signing.key, priv: signing.priv },
    chain: () => chainHolder.get(),
  })
  ratedGamePrep = createRatedGamePrep({
    getPeer: getAccountPeer,
    chain: chainHolder,
    signing: () => signing,
    getLeaseRunner: () => leaseRunner,
    saveChain: async (_root, c) => { ownChain = c },
    log: (m) => log(`[prep] ${m}`),
  })
  publish = createSegmentPublisher({
    getPeer: getAccountPeer,
    chain: chainHolder,
    signing: () => signing,
    getLeaseRunner: () => leaseRunner,
    saveChain: async (_root, c) => { ownChain = c },
    log: (m) => log(`[publisher] ${m}`),
  })

  // Wire the matchmaking handoff EXACTLY as accountNetBoot.ts does, with the game
  // transport injected (the boot uses the browser mp singleton; a node worker has
  // only werift). getPeer / signing / poolFactory are injected because this worker
  // uses raw keypairs + a werift pool room (not web/accounts + the trystero default).
  configureMatchmaking({
    getPeer: () => {
      const p = getAccountPeer()
      return p ? { root: p.root, key: p.key, fabric: p.fabric } : null
    },
    signing: () => ({ root: signing.root, key: signing.key, priv: signing.priv }),
    poolFactory: (kind, ladderId) => makePool(kind, ladderId),
    openRoom: async (a: MatchAssignment): Promise<string | null> => beginHostGame(a),
    joinRoom: (a: MatchAssignment): void => beginGuestGame(a),
    startWitness: (a): void => {
      const handle = startWitnessing(
        a.code,
        { participants: a.participants, kind: a.kind, tc: a.tc, pairing: 'embedder-verified' },
        { getPeer: getAccountPeer, signing: () => signing, makeTransport: gameTransport, log: (m) => log(`[witness] ${m}`) },
      )
      if (handle) {
        activeWitness = handle
        post({ type: 'witnessing', role: init.role, code: a.code, host: a.host, guest: a.guest })
        log(`witness attached to room ${a.code} (neither player)`)
        // Seed the players' current heads so their pre-game 'pairing' appends get
        // this non-player witness's attestation (gameKey unknown at attach ⇒ the
        // built-in pre-game seed is skipped; the head is game-independent).
        void seedWitnessHeads(a.code, a.participants)
        // Leave the matchmaking pool now the game is struck. A bare-node werift
        // mesh strains under fabric+pool+game rooms; dropping the pool for the game
        // duration keeps it at 2 rooms (like the reliable M1 smoke).
        stopOffer?.()
        stopOffer = null
      }
    },
    log: (m) => log(`[mm] ${m}`),
  })

  post({ type: 'ready', role: init.role, seed: init.seed, root: signing.root, key: signing.key, nodeId: peer.nodeId })
}

// ---------------------------------------------------------------------------
// The rated match handoff: drive the SIGNED game + the M2 prep + the segment
// ---------------------------------------------------------------------------
const hostCfg = (): { tc: { initialMs: number; incrementMs: number }; hostColor: 'white' } => ({
  tc: { initialMs: init.tc.initialMs, incrementMs: init.tc.incrementMs },
  hostColor: 'white',
})

async function beginHostGame(a: MatchAssignment): Promise<string | null> {
  const session = new MpNetSession(gameTransport, { signing })
  session.configureSigning({ ...signing, oppRoot: a.opponent.root })
  const { code } = await session.host(hostCfg(), `host-${init.seed}`)
  log(`hosting room ${code} for ${a.opponent.root.slice(0, 8)}… (white)`)
  void driveGame(session, a).catch((err) => post({ type: 'error', role: init.role, msg: `host game: ${String(err?.stack ?? err)}` }))
  return code
}

function beginGuestGame(a: MatchAssignment): void {
  const session = new MpNetSession(gameTransport, { signing })
  session.configureSigning({ ...signing, oppRoot: a.opponent.root })
  void (async () => {
    // Let the assigned witness attach + take its seat BEFORE we join: the host
    // mirrors the signed 'start' exactly once (on our hello) and never resends it
    // to a witness seated later, so a late witness never countersigns.
    await sleep(WITNESS_SEAT_DELAY_MS)
    log(`joining room ${a.code} vs ${a.opponent.root.slice(0, 8)}… (black)`)
    const res = await session.join(a.code, `guest-${init.seed}`)
    if (!res.ok) throw new Error(`join failed: ${res.error}`)
    await driveGame(session, a)
  })().catch((err) => post({ type: 'error', role: init.role, msg: `guest game: ${String(err?.stack ?? err)}` }))
}

/** Run one struck rated game to a published segment: wait for the signed start,
 *  run the M2 pre-game prep (lease + pairing anchor), play the scripted game by
 *  color, assemble the outcome, publish the segment, and report. */
async function driveGame(session: MpNetSession, a: MatchAssignment): Promise<void> {
  const color = a.color // host='w', guest='b' (the matchmaker's assignment)
  const events: { type: string; [k: string]: unknown }[] = []
  let lastWend: Extract<MpWitnessMsg, { t: 'wend' }> | null = null
  let terminal = false
  let cfg: unknown = null
  session.onEvent((ev) => { events.push(ev as never); if ((ev as { type: string }).type === 'start') cfg = (ev as { config: unknown }).config })
  session.onWitnessStream((m) => {
    log(`witness stream rx: ${m.t}${m.t === 'wclk' ? ` (ply ${m.ply})` : ''}`)
    if (m.t === 'wend') { lastWend = m; tryPublish() }
  })

  const tryPublish = (): void => {
    if (!terminal || !lastWend || !cfg || !publish) return
    const signed = session.getSignedGame()
    const witness = session.getWitnessIdentity()
    if (!signed || !witness) return
    publish({ signed, witness, wend: lastWend, color, result: lastWend.result, reason: lastWend.reason, kind: KIND, tc: BLITZ_BASE, config: cfg })
  }

  const waitEvent = async (pred: (e: { type: string; [k: string]: unknown }) => boolean, ms = 30_000): Promise<void> => {
    const deadline = Date.now() + ms
    for (;;) {
      const i = events.findIndex(pred)
      if (i >= 0) { events.splice(i, 1); return }
      if (Date.now() > deadline) throw new Error(`${init.role}: timeout waiting for a game event`)
      await sleep(50)
    }
  }

  await waitEvent((e) => e.type === 'start', 60_000)
  log(`signed game started (${color})`)
  // Leave the matchmaking pool now the match is struck (offer long since published/
  // accepted). Frees WebRTC for the game + fabric rooms (bare-node werift is
  // strained by 3 simultaneous meshes; this drops the game phase to 2, like M1).
  matchmakingStore.cancelRatedSearch()

  // --- M2 PRE-GAME PREP: acquire the live lease + anchor the witnessed pairing.
  const signed = session.getSignedGame()
  if (!signed) throw new Error('game never became signed (opponent did not offer identity)')
  const prepStart: RatedGameStart = { game: signed.gameKey, players: signed.players, color, kind: KIND, tc: BLITZ_BASE, atWts: a.atWts }
  const prep = await prepWithRetries(prepStart)
  post({ type: 'prep', role: init.role, ok: prep.ok, epoch: prep.ok ? prep.epoch : null, reason: prep.ok ? null : prep.reason })
  if (!prep.ok) throw new Error(`rated prep failed after retries: ${prep.reason}`)
  log(`rated prep OK: lease epoch ${prep.epoch}, witnessed pairing anchored`)

  // Let ALL game-room WebRTC connections (esp. witness↔guest, which formed last)
  // solidify + the witness seat settle before the game progresses to the one-shot
  // terminal wend: over a real mesh the last-formed pair can otherwise miss the
  // single wend broadcast (there is no re-request path). A settle beats that race.
  await sleep(GAME_MESH_SETTLE_MS)

  // --- play the scripted game by COLOR (black resigns ⇒ white wins 1-0) --------
  if (color === 'w') {
    await session.sendMove('e2e4')
    await waitEvent((e) => e.type === 'move' && e.uci === 'e7e5')
    await session.sendMove('g1f3')
    await waitEvent((e) => e.type === 'move' && e.uci === 'b8c6')
    await waitEvent((e) => e.type === 'resign' || e.type === 'gameOver', 30_000)
  } else {
    await waitEvent((e) => e.type === 'move' && e.uci === 'e2e4')
    await session.sendMove('e7e5')
    await waitEvent((e) => e.type === 'move' && e.uci === 'g1f3')
    await session.sendMove('b8c6')
    await sleep(1_500)
    await session.resign()
    await waitEvent((e) => e.type === 'resign' || e.type === 'gameOver', 30_000)
  }
  terminal = true
  log(`reached terminal (${color}); wend in hand: ${lastWend ? 'yes' : 'NOT YET'}`)
  tryPublish()
  await reportResult(color, signed, prep.ok ? prep.epoch : null)
}

/** ratedGamePrep with worker-level retries: over a real WebRTC mesh the assigned
 *  witness may still be connecting/seeding when we first anchor (a transient
 *  'insufficient-witnesses' / 'no-non-player-witness'). createRatedGamePrep only
 *  retries once internally; the smoke retries a few more times so a slow witness
 *  connect never flakes the proof (a HONEST wait, exactly the C-10 posture). */
async function prepWithRetries(
  start: RatedGameStart,
  tries = 24,
  delayMs = 2_000,
): Promise<{ ok: true; epoch: number } | { ok: false; reason: string }> {
  let last: { ok: false; reason: string } = { ok: false, reason: 'no-attempt' }
  for (let i = 0; i < tries; i++) {
    const r = await ratedGamePrep!(start)
    if (r.ok) return r
    last = r
    log(`prep attempt ${i + 1} degraded (${r.reason}); waiting for the witness …`)
    if (i < tries - 1) await sleep(delayMs)
  }
  return last
}

/** Report the final chain state once the segment has landed (or timed out). */
async function reportResult(
  color: 'w' | 'b',
  signed: { gameKey: string; players: { w: string; b: string } },
  epoch: number | null,
): Promise<void> {
  const genesisHeight = witnessedHeadOf(chain0.events)?.height ?? 0
  for (let i = 0; i < 160; i++) {
    const head = witnessedHeadOf(ownChain.events)
    // segment lands two witnessed events past genesis (pairing @1, segment @2).
    if (head && head.height >= genesisHeight + 2) break
    await sleep(250)
  }
  const segEvent = [...ownChain.events].reverse().find((e) => e.body.lane === 'w' && e.body.type === 'segment') as SignedEvent | undefined
  const pairingEvent = ownChain.events.find((e) => e.body.lane === 'w' && e.body.type === 'pairing') as SignedEvent | undefined
  const oppRoot = color === 'w' ? signed.players.b : signed.players.w
  const pairingVerified = pairingEvent
    ? verifyPairingEvent(pairingEvent, { game: signed.gameKey, kind: KIND, tc: BLITZ_BASE, self: signing.root, opp: oppRoot })
    : false
  const vc = verifyChain(ownChain)
  const ladder = foldChainA4(ownChain).fold.ladders[LADDER_ID] ?? null
  const seg = segEvent ? (segEvent.body.payload as Record<string, unknown>) : null
  post({
    type: 'result',
    role: init.role,
    seed: init.seed,
    root: signing.root,
    oppRoot,
    color,
    epoch,
    landed: Boolean(segEvent),
    verifyChainOk: vc.ok,
    segmentVerifyErr: segEvent ? verifySegmentEvent(segEvent) : 'no-segment',
    hasPairing: Boolean(pairingEvent),
    pairingVerified,
    segment: seg
      ? {
          game: seg.game,
          opp: seg.opp,
          color: seg.color,
          kind: seg.kind,
          result: seg.result,
          reason: seg.reason,
          transcript: seg.transcript,
          wstreamSig: (seg.wstream as { sig: string }).sig,
          plies: seg.plies,
        }
      : null,
    ladder: ladder ? { r: ladder.r, n: ladder.n } : null,
    height: witnessedHeadOf(ownChain.events)?.height ?? -1,
  })
}

// ---------------------------------------------------------------------------
// The rated search / witness offer + live matchmaking status stream
// ---------------------------------------------------------------------------
function startSearch(): void {
  const view = pairViewOf(signing.root, LADDER_ID, { n: 0, r: SEED_MICRO, rd: RD_MICRO }, 0, LADDER)
  // Stream live matchmaking status to the parent (the honest lobby signal).
  matchmakingStore.subscribe(() => {
    const s = matchmakingStore.getState()
    post({ type: 'status', role: init.role, phase: s.phase, witnessesReachable: s.witnessesReachable, opponentFound: s.opponentFound })
  })
  void matchmakingStore.startRatedSearch({ ladderKey: LADDER, tc: MM_DEFAULT_TC[LADDER], view })
  log('rated search started (no room code)')
}

// ---------------------------------------------------------------------------
// Casual proof (degradation phase): host/join an UNSIGNED game over the same
// transport while the rated search HONESTLY WAITS. Casual is byte-identical v5.
// ---------------------------------------------------------------------------
let casualSession: MpNetSession | null = null
async function casualHost(): Promise<void> {
  const session = new MpNetSession(gameTransport) // NO signing ⇒ casual/unsigned
  casualSession = session
  const started = new Promise<void>((res) => session.onEvent((e) => { if ((e as { type: string }).type === 'start') res() }))
  const { code } = await session.host(hostCfg(), `casual-${init.seed}`)
  post({ type: 'casualCode', role: init.role, code })
  await started
  await session.sendMove('e2e4')
  post({ type: 'casualResult', role: init.role, started: true })
  log('casual game started + first move sent while rated waits (casual unaffected)')
}
async function casualJoin(code: string): Promise<void> {
  const session = new MpNetSession(gameTransport)
  casualSession = session
  let plies = 0
  const started = new Promise<void>((res) => session.onEvent((e) => {
    const t = (e as { type: string }).type
    if (t === 'start') res()
    if (t === 'move') plies++
  }))
  const res = await session.join(code, `casual-${init.seed}`)
  if (!res.ok) throw new Error(`casual join failed: ${res.error}`)
  await started
  await sleep(2_000) // let white's first move arrive
  post({ type: 'casualResult', role: init.role, started: true, plies })
  log('casual game joined + started while rated waits (casual unaffected)')
}

// ---------------------------------------------------------------------------
// Parent → worker control
// ---------------------------------------------------------------------------
parentPort!.on('message', (m: { type: string; code?: string }) => {
  if (m.type === 'stop') {
    activeWitness?.stop()
    if (activeWitness) post({ type: 'witnessResult', role: init.role, witnessed: Boolean(activeWitness.result()) })
    casualSession?.leave()
    return
  }
  if (m.type === 'casualHost') void casualHost().catch((e) => post({ type: 'error', role: init.role, msg: `casualHost: ${String(e)}` }))
  if (m.type === 'casualJoin' && m.code) void casualJoin(m.code).catch((e) => post({ type: 'error', role: init.role, msg: `casualJoin: ${String(e)}` }))
})

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await boot()
  if (init.role === 'searcher') {
    // Warm up the meshes (fabric + pool) with the already-present witness before
    // seeking: the host's offer is a one-shot broadcast (see PeerInit.warmupMs).
    if (init.warmupMs) await sleep(init.warmupMs)
    startSearch()
  } else {
    stopOffer = matchmakingStore.offerWitnessing([LADDER]) // idle/operator witness posture
  }
}
main().catch((err) => post({ type: 'error', role: init.role, msg: String(err?.stack ?? err) }))
