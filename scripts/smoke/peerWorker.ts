// A6 M1 real-relay SMOKE: one peer, in its own worker thread (fresh trystero
// module state ⇒ its own selfId + relay socket, the multi-process requirement).
// Runs the app's REAL modules over the REAL trystero + werift transport (pointed
// at a localhost Nostr relay, since public relays rate-limit a bare-node mesh):
//
//   • createBrowserFabric (Lane A) with an INJECTED werift+relay trystero room.
//     The FIRST real-transport exercise of the browser fabric's makeAction usage.
//   • startAccountPeerSingleton (Lane B): overlay + witnessServe/memberServe +
//     signed presence over that fabric.
//   • MpNetSession (Lane C, SIGNED) over a werift+relay game transport. The same
//     rtcTransport adapter shape, plus the A6 mpSession rated-wend seam.
//   • startWitnessing (witnessController) → witnessRunner (Lane D).
//   • createSegmentPublisher + installPreGameServing (the lead glue → Lane E).
//
// Roles: 'white' hosts a rated Blitz game, 'black' joins, 'witness' witnesses.
// The parent brokers the room code + step ordering via postMessage; the GAME
// itself flows over the real transport. On terminal each player builds the same
// SignedGameOutcome the store assembles and hands it to the publisher; the result
// (verifyChain / verifySegmentEvent / folded ladder) is posted back for assertion.

import { parentPort, workerData } from 'node:worker_threads'
import { joinRoom } from 'trystero'
import { RTCPeerConnection } from 'werift'

import { createAccountChain, ed25519, toB64u, verifyChain, witnessedHeadOf } from '@shared/accounts'
import { nodeIdOf } from '@shared/accounts/witness'
import { verifySegmentEvent } from '@shared/accounts/segment'
import { normalizeRoomCode } from '@shared/mp/wire'
import type { Chain, SignedEvent } from '@shared/accounts/types'

import { MpNetSession, type MpTransport, type MpTransportFactory, type MpTransportListeners, type MpWitnessMsg } from '@renderer/features/play/online/mpSession'
import { createBrowserFabric, FABRIC_APP_ID, FABRIC_ROOM_DEFAULT, type FabricRoom } from '@renderer/features/account/net/browserFabric'
import { startAccountPeerSingleton, getAccountPeer } from '@renderer/features/account/net/peerService'
import { createSegmentPublisher, installPreGameServing, type ChainHolder, type DeviceSigning } from '@renderer/features/account/net/segmentPublisher'
import { startWitnessing } from '@renderer/features/account/net/witnessController'
import { foldChainA4 } from '@renderer/features/account/store/derive'

// ---------------------------------------------------------------------------
// workerData: role + relay + identities + game parameters
// ---------------------------------------------------------------------------
interface PeerInit {
  role: 'white' | 'black' | 'witness'
  relayUrl: string
  seed: number
  tc: { initialMs: number; incrementMs: number }
}
interface PeersMsg {
  opp?: { root: string; key: string } // players
  players?: { w: { root: string; key: string }; b: { root: string; key: string } } // witness
}
const init = workerData as PeerInit
const post = (m: unknown): void => parentPort!.postMessage(m)
const log = (msg: string): void => post({ type: 'log', role: init.role, msg })
const BLITZ_BASE = { baseMs: init.tc.initialMs, incMs: init.tc.incrementMs }
const KIND = 'chess'

// ---------------------------------------------------------------------------
// Deterministic identity (raw keypairs, like the mock live-slice), root ≠ device
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
  displayName: `${init.role}Player`,
  ts: Date.now(),
  device: { pub: devKp.pubB, index: 0, label: 'smoke device' },
})
let ownChain: Chain = chain0
const chainHolder: ChainHolder = { get: () => ownChain, set: (c) => { ownChain = c } }

// ---------------------------------------------------------------------------
// Real trystero+werift transports pointed at the local relay
// ---------------------------------------------------------------------------
const relayCfg = { urls: [init.relayUrl], redundancy: 1 }
const baseRtc = { rtcPolyfill: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection, rtcConfig: { iceServers: [] as RTCIceServer[] }, relayConfig: relayCfg }

/** A werift+relay game transport. The rtcTransport.ts adapter, verbatim shape. */
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Boot: start the account peer + (players) install pre-game serving + publisher
// ---------------------------------------------------------------------------
let publish: ((o: SignedOutcome) => void) | null = null

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

async function boot(): Promise<void> {
  const fabric = makeFabric()
  const peer = await startAccountPeerSingleton({
    identity: { root: signing.root, key: signing.key, priv: signing.priv },
    fabric,
    // Fast presence heartbeat so a late-joining peer learns our nodeId→peerId
    // quickly over the real fabric (the smoke can't wait the 60s app cadence).
    announceIntervalMs: 1_000,
  })
  installPreGameServing({ peer, chain: chainHolder, signing, profile: () => ({ name: `${init.role}Player` }) })

  publish = createSegmentPublisher({
    getPeer: getAccountPeer,
    chain: chainHolder,
    signing: () => signing,
    saveChain: async (_root, c) => { ownChain = c },
    log: (m) => log(`[publisher] ${m}`),
  })
  post({ type: 'ready', role: init.role, root: signing.root, key: signing.key, nodeId: peer.nodeId })
}

// ---------------------------------------------------------------------------
// Player: drive the SIGNED rated game + assemble the outcome for the publisher
// ---------------------------------------------------------------------------
function assembleAndPublish(mp: MpNetSession, color: 'w' | 'b', wend: Extract<MpWitnessMsg, { t: 'wend' }>, cfg: unknown): boolean {
  const signed = mp.getSignedGame()
  const witness = mp.getWitnessIdentity()
  if (!signed || !witness || !publish) return false
  publish({
    signed: signed as SignedOutcome['signed'],
    witness,
    wend,
    color,
    result: wend.result,
    reason: wend.reason,
    kind: KIND,
    tc: BLITZ_BASE,
    config: cfg,
  })
  return true
}

/** Report the final chain state once the segment has landed (or timed out). */
async function reportResult(): Promise<void> {
  // Wait (bounded) for the publisher to advance the chain past genesis.
  const genesisHeight = witnessedHeadOf(chain0.events)?.height ?? 0
  for (let i = 0; i < 120; i++) {
    const head = witnessedHeadOf(ownChain.events)
    if (head && head.height > genesisHeight) break
    await sleep(250)
  }
  const segEvent = [...ownChain.events].reverse().find((e) => e.body.lane === 'w' && e.body.type === 'segment') as SignedEvent | undefined
  const vc = verifyChain(ownChain)
  const fold = foldChainA4(ownChain).fold
  const ladder = fold.ladders['chess:Blitz'] ?? null
  const seg = segEvent ? (segEvent.body.payload as Record<string, unknown>) : null
  post({
    type: 'result',
    role: init.role,
    root: signing.root,
    landed: Boolean(segEvent),
    verifyChainOk: vc.ok,
    segmentVerifyErr: segEvent ? verifySegmentEvent(segEvent) : 'no-segment',
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
          wstreamWkey: (seg.wstream as { wkey: string }).wkey,
          plies: seg.plies,
        }
      : null,
    ladder: ladder ? { key: 'chess:Blitz', r: ladder.r, n: ladder.n } : null,
    height: witnessedHeadOf(ownChain.events)?.height ?? -1,
  })
}

async function runPlayer(): Promise<void> {
  const peers = await waitForPeers()
  const mp = new MpNetSession(gameTransport, { signing })
  // Pin the opponent root (matchmaker-known) so the signed hello binds it.
  mp.configureSigning({ ...signing, oppRoot: peers.opp!.root })
  let lastWend: Extract<MpWitnessMsg, { t: 'wend' }> | null = null
  let terminal = false
  let cfg: unknown = null
  const events: { type: string; [k: string]: unknown }[] = []
  mp.onEvent((ev) => { events.push(ev as never); if ((ev as { type: string }).type === 'start') cfg = (ev as { config: unknown }).config })
  mp.onWitnessStream((m) => { if (m.t === 'wend') { lastWend = m; tryPublish() } })

  const color: 'w' | 'b' = init.role === 'white' ? 'w' : 'b'
  const tryPublish = (): void => {
    if (terminal && lastWend && cfg) assembleAndPublish(mp, color, lastWend, cfg)
  }

  const waitEvent = async (pred: (e: { type: string; [k: string]: unknown }) => boolean, ms = 30_000): Promise<{ type: string; [k: string]: unknown }> => {
    const deadline = Date.now() + ms
    for (;;) {
      const i = events.findIndex(pred)
      if (i >= 0) return events.splice(i, 1)[0]
      if (Date.now() > deadline) throw new Error(`${init.role}: timeout waiting for event`)
      await sleep(50)
    }
  }

  if (init.role === 'white') {
    const cfgObj = { tc: { initialMs: init.tc.initialMs, incrementMs: init.tc.incrementMs }, hostColor: 'white' as const }
    const { code } = await mp.host(cfgObj, 'White')
    post({ type: 'hosted', role: 'white', code })
    await waitEvent((e) => e.type === 'start', 60_000)
    log('white: game started')
    // White plays even plies; wait for black between.
    await mp.sendMove('e2e4')
    await waitEvent((e) => e.type === 'move' && e.uci === 'e7e5')
    await mp.sendMove('g1f3')
    await waitEvent((e) => e.type === 'move' && e.uci === 'b8c6')
    // Black will resign → white receives the resign terminal.
    await waitEvent((e) => e.type === 'resign' || e.type === 'gameOver', 30_000)
    terminal = true
    tryPublish()
  } else {
    // black: parent signals the code to join.
    const code = await waitForCode()
    log(`black: joining ${code}`)
    const res = await mp.join(code, 'Black')
    if (!res.ok) throw new Error(`black join failed: ${res.error}`)
    await waitEvent((e) => e.type === 'start', 60_000)
    log('black: game started')
    await waitEvent((e) => e.type === 'move' && e.uci === 'e2e4')
    await mp.sendMove('e7e5')
    await waitEvent((e) => e.type === 'move' && e.uci === 'g1f3')
    await mp.sendMove('b8c6')
    await sleep(500)
    await mp.resign()
    await waitEvent((e) => e.type === 'resign' || e.type === 'gameOver', 30_000)
    terminal = true
    tryPublish()
  }
  await reportResult()
}

// ---------------------------------------------------------------------------
// Witness: witness the room the parent hands us (M1 dev-flow handoff)
// ---------------------------------------------------------------------------
async function runWitness(): Promise<void> {
  const peers = await waitForPeers()
  const code = await waitForCode()
  log(`witness: witnessing ${code}`)
  const handle = startWitnessing(
    code,
    {
      participants: [
        { root: peers.players!.w.root, key: peers.players!.w.key },
        { root: peers.players!.b.root, key: peers.players!.b.key },
      ],
      kind: KIND,
      tc: BLITZ_BASE,
      pairing: 'embedder-verified',
    },
    { getPeer: getAccountPeer, signing: () => signing, makeTransport: gameTransport, log: (m) => log(`[witness] ${m}`) },
  )
  if (!handle) throw new Error('witness: failed to start (no peer?)')
  // Live until the parent tells us the game is done.
  await waitForStop()
  handle.stop()
  post({ type: 'result', role: 'witness', witnessed: Boolean(handle.result()) })
}

// ---------------------------------------------------------------------------
// Parent → worker control messages
// ---------------------------------------------------------------------------
let codeResolve: ((c: string) => void) | null = null
let stopResolve: (() => void) | null = null
let peersResolve: ((p: PeersMsg) => void) | null = null
const waitForCode = (): Promise<string> => new Promise((res) => { codeResolve = res })
const waitForStop = (): Promise<void> => new Promise((res) => { stopResolve = res })
const waitForPeers = (): Promise<PeersMsg> => new Promise((res) => { peersResolve = res })
parentPort!.on('message', (m: { type: string; code?: string; peers?: PeersMsg }) => {
  if (m.type === 'peers' && m.peers && peersResolve) peersResolve(m.peers)
  if (m.type === 'code' && m.code && codeResolve) codeResolve(m.code)
  if (m.type === 'stop' && stopResolve) stopResolve()
})

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await boot()
  if (init.role === 'witness') await runWitness()
  else await runPlayer()
}
main().catch((err) => post({ type: 'error', role: init.role, msg: String(err?.stack ?? err) }))
