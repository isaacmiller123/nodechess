// A6 M6 / A-FINAL real-relay ACCEPTANCE worker: one peer, in its own worker
// thread (fresh trystero module state ⇒ its own selfId + relay socket, the
// multi-process requirement). This is the §1 acceptance-test peer: it runs the
// app's REAL modules over the REAL trystero + werift transport (localhost Nostr
// relay signaling) and, unlike the M2 matchmaking worker it extends, exercises
// the WHOLE vertical:
//
//   • a FRESH account created from an argon2id identity (deriveIdentity +
//     deriveChild: byte-identical to web/accounts.ts createAccount, minus the
//     IndexedDB keyring), so the account under test is a real §1 root, not a raw
//     test keypair.
//   • createBrowserFabric (Lane A) + startAccountPeerSingleton (Lane B) with the
//     M3 storage-duty STORE gate installed (shard/pointer accept) + the §5 repair
//     loop, EXACTLY as accountNetBoot wires them, so this peer is a real storage
//     carrier, not just a player.
//   • matchmakingStore.startRatedSearch / offerWitnessing (M2 L-mm). Two
//     strangers auto-pair with NO code; a distinct third self-assigns as witness.
//   • createLeaseRunner + createRatedGamePrep (M2 L-lease): the live write lease
//     + the witnessed 'pairing' anchor before move 1.
//   • MpNetSession (Lane C, SIGNED) + startWitnessing (Lane D) over werift.
//   • createSegmentPublisher (Lane E) with the onPublished hook wired to the M5
//     Tier-1 judge (runTier1ForGame over the finished SIGNED transcript) AND the
//     M3 §5 finalSyncOwnChain (erasure-code the whole chain into shard space +
//     pin a self chain-pointer): the same two things accountNetBoot does when a
//     rated segment lands.
//   • a 'viewer' role: a FOURTH fresh account that holds shards and, after the
//     owner goes offline, RECONSTRUCTS the owner's profile/game from shard space
//     through viewAccountForPeer (Lane L-view).
//
// Every module under test is the shipping one; only the game transport is
// injected (the boot uses the browser `mp` singleton over native WebRTC: a bare
// node worker has only werift). Mirrors scripts/smoke/mmPeerWorker.ts.

import { parentPort, workerData } from 'node:worker_threads'
import { joinRoom } from 'trystero'
import { RTCPeerConnection } from 'werift'

import {
  chainToBytes,
  createAccountChain,
  deriveChild,
  deriveIdentity,
  KEY_PURPOSE,
  toB64u,
  verifyChain,
  witnessedHeadOf,
} from '@shared/accounts'
import { sha256, utf8 } from '@shared/accounts/hash'
import { nodeIdOf } from '@shared/accounts/witness'
import { verifySegmentEvent } from '@shared/accounts/segment'
import { PARAMS_A5 } from '@shared/accounts/judge'
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
import { startAccountPeerSingleton, stopAccountPeerSingleton, getAccountPeer } from '@renderer/features/account/net/peerService'
import { createLeaseRunner, type LeaseRunner } from '@renderer/features/account/net/leaseRunner'
import {
  createRatedGamePrep,
  createSegmentPublisher,
  installPreGameServing,
  type ChainHolder,
  type DeviceSigning,
  type PublishedSegment,
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
import { makeStorageDutyGate, finalSyncOwnChain, startShardRepairLoop, type StorageDutyGate } from '@renderer/features/account/net/shardDuty'
import { runTier1ForGame, type Tier1GameView } from '@renderer/features/account/net/judgeRunner'
import { viewAccountForPeer } from '@renderer/features/account/net/viewerClient'
import type { WitnessRunnerHandle } from '@renderer/features/account/net/witnessRunner'
import { requestPreGameSnapshot, verifyPairingEvent } from '@renderer/features/account/net/preGame'
import { pairViewOf } from '@shared/accounts/ratings/display'
import { foldChainA4 } from '@renderer/features/account/store/derive'

// ---------------------------------------------------------------------------
// workerData: role + relay + FRESH argon2id account credentials + parameters
// ---------------------------------------------------------------------------
interface PeerInit {
  role: 'searcher' | 'witness' | 'viewer'
  relayUrl: string
  /** argon2id account name (fresh account under test). */
  name: string
  /** argon2id password. */
  password: string
  tc: { initialMs: number; incrementMs: number }
  /** Searcher: wait this long after boot before startRatedSearch (see mmPeerWorker). */
  warmupMs?: number
  /** Real STUN/TURN set (public-relay run); empty/absent ⇒ localhost host candidates only. */
  iceServers?: RTCIceServer[]
  /** Multiple signaling relays (public run). Spreads load like production trystero. */
  relayUrls?: string[]
  /** Force ICE through TURN only (iceTransportPolicy:'relay'): forbids localhost
   *  host candidates so ALL media transits a real public TURN server, the genuine
   *  cross-NAT/separate-machines proof from one box. */
  iceRelayOnly?: boolean
}
const init = workerData as PeerInit
const post = (m: unknown): void => parentPort!.postMessage(m)
const log = (msg: string): void => post({ type: 'log', role: init.role, name: init.name, msg })
const BLITZ_BASE = { baseMs: init.tc.initialMs, incMs: init.tc.incrementMs }
const KIND = MM_KIND
const LADDER = 'Blitz' as const
const LADDER_ID = ladderIdOf(LADDER)
const SEED_MICRO = 1200 * 1_000_000
const RD_MICRO = 350 * 1_000_000
const SHARD_MB = 200 // advertise real storage capacity so this peer carries shard rows (§11)
const WITNESS_SEAT_DELAY_MS = 9_000
const GAME_MESH_SETTLE_MS = 5_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const b64 = (bytes: Uint8Array): string => toB64u(bytes)
const chainHash = (c: Chain): string => b64(sha256(chainToBytes(c)))

// ---------------------------------------------------------------------------
// FRESH argon2id identity (deriveIdentity → SLIP-0010 root + device child).
// The exact derivation web/accounts.ts createAccount runs. Populated in main()
// before boot (deriveIdentity is async: argon2id memory-hard KDF).
// ---------------------------------------------------------------------------
let signing: DeviceSigning
let identityMeta: { root: string; tag: string; foldedName: string; displayName: string }
let ownChain: Chain
let chain0: Chain
const chainHolder: ChainHolder = { get: () => ownChain, set: (c) => { ownChain = c } }

async function deriveFreshAccount(): Promise<void> {
  const identity = await deriveIdentity(init.name, init.password)
  const device = deriveChild(identity.seed, KEY_PURPOSE.device, 0)
  signing = { root: toB64u(identity.rootPub), key: toB64u(device.pub), priv: device.priv }
  identityMeta = { root: signing.root, tag: identity.tag, foldedName: identity.foldedName, displayName: identity.displayName }
  chain0 = createAccountChain({
    rootPriv: identity.rootPriv,
    rootPub: identity.rootPub,
    displayName: identity.displayName,
    ts: Date.now(),
    device: { pub: signing.key, index: 0, label: 'smoke device' },
  })
  ownChain = chain0
}

// ---------------------------------------------------------------------------
// Real trystero+werift transports pointed at the local relay (verbatim mmPeer)
// ---------------------------------------------------------------------------
const relayUrlList = init.relayUrls && init.relayUrls.length > 0 ? init.relayUrls : [init.relayUrl]
const relayCfg = { urls: relayUrlList, redundancy: relayUrlList.length }
const baseRtc = {
  rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  rtcConfig: {
    iceServers: (init.iceServers ?? []) as RTCIceServer[],
    ...(init.iceRelayOnly ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
  },
  relayConfig: relayCfg,
}

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

function makeFabric(): ReturnType<typeof createBrowserFabric> {
  const room = joinRoom({ appId: FABRIC_APP_ID, password: 'chs-accts-fabric-smoke', ...baseRtc }, FABRIC_ROOM_DEFAULT)
  return createBrowserFabric({ nodeId: nodeIdOf(signing.root), room: room as unknown as FabricRoom })
}

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

function makePool(kind: string, ladderId: string): MatchPool {
  const room = joinRoom({ appId: FABRIC_APP_ID, password: 'chs-mm-pool-smoke', ...baseRtc }, poolRoomId(kind, ladderId))
  return nonReentrantPool(createTrysteroMatchPool({ kind, ladderId, room: room as unknown as never }))
}

// ---------------------------------------------------------------------------
// M2/M3/M5 lifecycle objects (real modules)
// ---------------------------------------------------------------------------
let leaseRunner: LeaseRunner | null = null
let ratedGamePrep: ((s: RatedGameStart) => Promise<{ ok: true; epoch: number } | { ok: false; reason: string }>) | null = null
let publish: ((o: SignedOutcome) => void) | null = null
let activeWitness: WitnessRunnerHandle | null = null
let stopOffer: (() => void) | null = null
let storageGate: StorageDutyGate | null = null
let stopRepair: (() => void) | null = null

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

// A spec-faithful UCI double for JudgeEngine (verbatim from
// test-accounts-judge-runner): answers the `isready` barrier with `readyok`; on
// `go` emits multiPv info lines (ranks 1..multiPv) + a bestmove. Ignores the FEN.
// The transcript pipeline + record math are what run, and the SAME deterministic
// lines per position give the SAME Tier1Record on BOTH players' independent passes
// (the §8 cross-instance parity property). The real pinned-WASM judge's
// determinism is separately proven by test-accounts-judge-runner §7 / test-judge-node.
const JUDGE_RANKS = ['e2e4', 'd2d4', 'g1f3', 'b1c3', 'c2c4', 'g1e2']
function makeFakeJudgeEngine(multiPv = PARAMS_A5.t1MultiPv): unknown {
  const cbs = new Set<(line: string) => void>()
  let closed = false
  const emit = (line: string): void => { queueMicrotask(() => { if (!closed) for (const cb of [...cbs]) cb(line) }) }
  return {
    send(cmd: string): void {
      if (closed) throw new Error('fake judge engine is closed')
      if (cmd === 'isready') { emit('readyok'); return }
      if (cmd.startsWith('go')) {
        for (let r = 1; r <= multiPv; r++)
          emit(`info depth 12 seldepth 15 multipv ${r} score cp ${40 - r * 2} nodes 1000 pv ${JUDGE_RANKS[r - 1]}`)
        emit(`bestmove ${JUDGE_RANKS[0]}`)
      }
    },
    onLine(cb: (line: string) => void): () => void { cbs.add(cb); return () => cbs.delete(cb) },
    async close(): Promise<void> { closed = true },
  }
}
const fakeJudgeFactory = (): Promise<unknown> => Promise.resolve(makeFakeJudgeEngine())

/** onPublished (the accountNetBoot post-segment path, faithfully): run the M5
 *  Tier-1 judge over the finished SIGNED transcript, then M3 finalSync the whole
 *  chain into shard space so a viewer can reconstruct with us offline. Reports
 *  both to the parent. Never throws (a degraded step is an honest no-op). */
async function onSegmentPublished(res: PublishedSegment): Promise<void> {
  // --- M5 Tier-1 judge over the just-finished signed game ---
  try {
    const view: Tier1GameView = {
      gameKey: res.game.game,
      players: res.game.players,
      kind: res.game.kind,
      tc: res.game.tc,
      moves: res.game.moves,
    }
    const jr = await runTier1ForGame(view, { newJudgeEngine: fakeJudgeFactory as never })
    post({
      type: 'judge',
      role: init.role,
      ok: jr.ok,
      game: jr.ok ? jr.record.game : null,
      ladder: jr.ok ? jr.record.ladder : null,
      tier1Digest: jr.ok ? jr.tier1Digest : null,
      judgeDigest: jr.ok ? jr.judgeDigest : null,
      wScored: jr.ok ? jr.record.w.scored : -1,
      bScored: jr.ok ? jr.record.b.scored : -1,
      reason: jr.ok ? null : jr.reason,
    })
    log(`[judge] tier-1 ${jr.ok ? `record over game ${res.game.game.slice(0, 8)}… (ladder ${jr.record.ladder})` : `no-op: ${jr.reason}`}`)
  } catch (e) {
    post({ type: 'judge', role: init.role, ok: false, reason: `threw: ${String(e)}` })
  }
  // --- M3 §5 final sync: erasure-code our chain into shard space + chain pointer ---
  try {
    const peer = getAccountPeer()
    if (peer) {
      // Refresh the Kademlia routing table from the now-populated directory BEFORE
      // sharding: this peer bootstrapped when few others were online (the witness
      // alone), so without this the put's "closest" set collapses toward self and
      // the rows never replicate off-owner. All carriers are live now, so this is
      // fast + lets the shard STOREs reach the distance-assigned duty carriers.
      try { await peer.bootstrap() } catch { /* honest. A partial refresh still spreads */ }
      const fs = await finalSyncOwnChain(peer.overlay, signing, chainHolder.get())
      post({
        type: 'synced',
        role: init.role,
        ok: fs.ok,
        liveRows: fs.ok ? fs.liveRows : 0,
        chainPointer: fs.ok ? fs.chainPointerStored : 0,
        reason: fs.ok ? null : fs.reason,
      })
      log(`[storage] final sync ${fs.ok ? `${fs.liveRows} rows live, chain-pointer ${fs.chainPointerStored}` : `skipped: ${fs.reason}`}`)
    }
  } catch (e) {
    post({ type: 'synced', role: init.role, ok: false, reason: `threw: ${String(e)}` })
  }
  post({ type: 'chainHash', role: init.role, root: signing.root, hash: chainHash(chainHolder.get()) })
}

/** Seed the players' current heads into THIS peer's witnessServe attest cache
 *  (verbatim mmPeerWorker.seedWitnessHeads). */
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
  // M3 §5: build the overlay STORE-ACCEPT gate over THIS fabric's live directory
  // BEFORE the peer, so its composed validator (shard capacity + pointer duty) +
  // merge gate every store the overlay makes, EXACTLY accountNetBoot's wiring.
  const gate = makeStorageDutyGate({
    shardMb: SHARD_MB,
    directory: () => fabric.directory(),
    nowMs: () => Date.now(),
  })
  storageGate = gate
  // The viewer is a STORAGE carrier + reconstructor, NOT a witness. Advertise
  // witness:false so assignWitnesses (which draws from the directory's
  // witness-capable presences) never picks it, keeping the eligible witness set
  // to the one dedicated witness peer (the M2 single-witness topology).
  const caps = init.role === 'viewer' ? { shardMb: SHARD_MB, witness: false } : { shardMb: SHARD_MB }
  const peer = await startAccountPeerSingleton({
    identity: { root: signing.root, key: signing.key, priv: signing.priv },
    fabric,
    caps,
    validator: gate.validator,
    overlay: { merge: gate.merge },
    announceIntervalMs: 1_000,
  })
  installPreGameServing({ peer, chain: chainHolder, signing, profile: () => ({ name: identityMeta.displayName }) })

  // M3 §5: the background repair loop (eviction=churn=healed) over the live overlay.
  stopRepair = startShardRepairLoop({
    node: peer.overlay,
    gate,
    directory: () => peer.fabric.directory(),
    nowMs: () => Date.now(),
  })

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
    onPublished: (res) => { void onSegmentPublished(res) },
    log: (m) => log(`[publisher] ${m}`),
  })

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
        void seedWitnessHeads(a.code, a.participants)
        stopOffer?.()
        stopOffer = null
      }
    },
    log: (m) => log(`[mm] ${m}`),
  })

  post({ type: 'ready', role: init.role, name: init.name, root: signing.root, key: signing.key, tag: identityMeta.tag, foldedName: identityMeta.foldedName, displayName: identityMeta.displayName, nodeId: peer.nodeId })
}

// ---------------------------------------------------------------------------
// The rated match handoff (verbatim mmPeerWorker)
// ---------------------------------------------------------------------------
const hostCfg = (): { tc: { initialMs: number; incrementMs: number }; hostColor: 'white' } => ({
  tc: { initialMs: init.tc.initialMs, incrementMs: init.tc.incrementMs },
  hostColor: 'white',
})

async function beginHostGame(a: MatchAssignment): Promise<string | null> {
  const session = new MpNetSession(gameTransport, { signing })
  session.configureSigning({ ...signing, oppRoot: a.opponent.root })
  const { code } = await session.host(hostCfg(), `host-${identityMeta.tag}`)
  log(`hosting room ${code} for ${a.opponent.root.slice(0, 8)}… (white)`)
  void driveGame(session, a).catch((err) => post({ type: 'error', role: init.role, msg: `host game: ${String(err?.stack ?? err)}` }))
  return code
}

function beginGuestGame(a: MatchAssignment): void {
  const session = new MpNetSession(gameTransport, { signing })
  session.configureSigning({ ...signing, oppRoot: a.opponent.root })
  void (async () => {
    await sleep(WITNESS_SEAT_DELAY_MS)
    log(`joining room ${a.code} vs ${a.opponent.root.slice(0, 8)}… (black)`)
    const res = await session.join(a.code, `guest-${identityMeta.tag}`)
    if (!res.ok) throw new Error(`join failed: ${res.error}`)
    await driveGame(session, a)
  })().catch((err) => post({ type: 'error', role: init.role, msg: `guest game: ${String(err?.stack ?? err)}` }))
}

async function driveGame(session: MpNetSession, a: MatchAssignment): Promise<void> {
  const color = a.color
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
  matchmakingStore.cancelRatedSearch()

  const signed = session.getSignedGame()
  if (!signed) throw new Error('game never became signed (opponent did not offer identity)')
  const prepStart: RatedGameStart = { game: signed.gameKey, players: signed.players, color, kind: KIND, tc: BLITZ_BASE, atWts: a.atWts }
  const prep = await prepWithRetries(prepStart)
  post({ type: 'prep', role: init.role, ok: prep.ok, epoch: prep.ok ? prep.epoch : null, reason: prep.ok ? null : prep.reason })
  if (!prep.ok) throw new Error(`rated prep failed after retries: ${prep.reason}`)
  log(`rated prep OK: lease epoch ${prep.epoch}, witnessed pairing anchored`)

  await sleep(GAME_MESH_SETTLE_MS)

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

async function reportResult(
  color: 'w' | 'b',
  signed: { gameKey: string; players: { w: string; b: string } },
  epoch: number | null,
): Promise<void> {
  const genesisHeight = witnessedHeadOf(chain0.events)?.height ?? 0
  for (let i = 0; i < 160; i++) {
    const head = witnessedHeadOf(ownChain.events)
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
    name: init.name,
    root: signing.root,
    displayName: identityMeta.displayName,
    oppRoot,
    color,
    epoch,
    landed: Boolean(segEvent),
    verifyChainOk: vc.ok,
    segmentVerifyErr: segEvent ? verifySegmentEvent(segEvent) : 'no-segment',
    hasPairing: Boolean(pairingEvent),
    pairingVerified,
    chainHash: chainHash(ownChain),
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
  matchmakingStore.subscribe(() => {
    const s = matchmakingStore.getState()
    post({ type: 'status', role: init.role, phase: s.phase, witnessesReachable: s.witnessesReachable, opponentFound: s.opponentFound })
  })
  void matchmakingStore.startRatedSearch({ ladderKey: LADDER, tc: MM_DEFAULT_TC[LADDER], view })
  log('rated search started (no room code)')
}

// ---------------------------------------------------------------------------
// Viewer: a FOURTH fresh account reconstructs a subject from shard space (§5,
// Lane L-view) with the owner offline. Retries a few times: over a real mesh
// the overlay lookups + repair need a beat to settle after the owner leaves.
// ---------------------------------------------------------------------------
async function doReconstruct(subjectRoot: string, tries = 12, delayMs = 3_000): Promise<void> {
  const peer = getAccountPeer()
  if (!peer) { post({ type: 'reconstructed', role: init.role, status: 'no-peer', available: false }); return }
  // Refresh routing from the CURRENT directory so shard-row lookups reach the live
  // carriers. Safe (no dead-contact stall) because the owner LEFT gracefully. Its
  // onPeerLeave already pruned it from every routing table.
  try { await peer.bootstrap() } catch { /* honest. A stale-seed refresh is non-fatal */ }
  let last: Awaited<ReturnType<typeof viewAccountForPeer>> | null = null
  for (let i = 0; i < tries; i++) {
    try {
      const r = await viewAccountForPeer(peer, subjectRoot, { rng: () => 0 }) // roll 0 forces the §2 spot-check
      last = r
      log(`reconstruct attempt ${i + 1}: status=${r.view.status} available=${r.availability.available} rows=${r.availability.liveRows ?? '?'}`)
      if (r.view.status === 'expected' && r.view.chain) break
    } catch (e) {
      log(`reconstruct attempt ${i + 1} threw: ${String(e)}`)
    }
    if (i < tries - 1) await sleep(delayMs)
  }
  if (!last) { post({ type: 'reconstructed', role: init.role, status: 'error', available: false }); return }
  const view = last.view
  post({
    type: 'reconstructed',
    role: init.role,
    subject: subjectRoot,
    status: view.status,
    hasChain: Boolean(view.chain),
    bitHash: view.chain ? chainHash(view.chain) : null,
    displayName: last.profile.displayName,
    segments: view.segments?.length ?? 0,
    games: last.profile.games?.length ?? 0,
    ladderBlitzGames: last.profile.ladders?.find((l) => l.key === 'Blitz')?.games ?? 0,
    available: last.availability.available,
    reason: last.availability.reason ?? null,
    mOfN: last.availability.mOfN ?? false,
  })
}

// ---------------------------------------------------------------------------
// Casual proof (degradation phase): verbatim mmPeerWorker
// ---------------------------------------------------------------------------
let casualSession: MpNetSession | null = null
async function casualHost(): Promise<void> {
  const session = new MpNetSession(gameTransport)
  casualSession = session
  const started = new Promise<void>((res) => session.onEvent((e) => { if ((e as { type: string }).type === 'start') res() }))
  const { code } = await session.host(hostCfg(), `casual-${identityMeta.tag}`)
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
  const res = await session.join(code, `casual-${identityMeta.tag}`)
  if (!res.ok) throw new Error(`casual join failed: ${res.error}`)
  await started
  await sleep(2_000)
  post({ type: 'casualResult', role: init.role, started: true, plies })
  log('casual game joined + started while rated waits (casual unaffected)')
}

// ---------------------------------------------------------------------------
// Parent → worker control
// ---------------------------------------------------------------------------
parentPort!.on('message', (m: { type: string; code?: string; subjectRoot?: string }) => {
  if (m.type === 'stop') {
    activeWitness?.stop()
    if (activeWitness) post({ type: 'witnessResult', role: init.role, witnessed: Boolean(activeWitness.result()) })
    casualSession?.leave()
    stopRepair?.()
    return
  }
  if (m.type === 'leave') {
    // The owner GOES OFFLINE gracefully (sign-out / close-tab): closing the peer
    // fires onPeerLeave on every other node, so they PRUNE us from their routing
    // tables at once: no dead-contact RPC stalls for the reconstructing viewer.
    // Our shards live on the OTHER carriers; closing us does not remove them.
    stopRepair?.()
    void stopAccountPeerSingleton().then(() => post({ type: 'left', role: init.role, root: signing.root })).catch(() => post({ type: 'left', role: init.role, root: signing.root }))
    return
  }
  if (m.type === 'reconstruct' && m.subjectRoot) void doReconstruct(m.subjectRoot).catch((e) => post({ type: 'error', role: init.role, msg: `reconstruct: ${String(e)}` }))
  if (m.type === 'casualHost') void casualHost().catch((e) => post({ type: 'error', role: init.role, msg: `casualHost: ${String(e)}` }))
  if (m.type === 'casualJoin' && m.code) void casualJoin(m.code).catch((e) => post({ type: 'error', role: init.role, msg: `casualJoin: ${String(e)}` }))
})

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await deriveFreshAccount() // argon2id: the FRESH account under test
  await boot()
  if (init.role === 'searcher') {
    if (init.warmupMs) await sleep(init.warmupMs)
    startSearch()
  } else if (init.role === 'witness') {
    stopOffer = matchmakingStore.offerWitnessing([LADDER])
  }
  // 'viewer' just holds shards + waits for a reconstruct command (a §5 carrier).
}
main().catch((err) => post({ type: 'error', role: init.role, msg: String(err?.stack ?? err) }))
