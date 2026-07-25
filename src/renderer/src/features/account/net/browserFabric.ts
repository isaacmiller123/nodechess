// A6 M1 Lane A — the browser accounts fabric: a FabricEndpoint (spec §4,
// src/shared/accounts/witness/types.ts:325) over trystero + NATIVE WebRTC. This
// is the app's LIVE accounts transport on ALL THREE platforms — the Electron
// desktop renderer, the web build, and the phone browser all boot the same
// renderer, whose Chromium/WebView carries a native RTCPeerConnection, so no
// werift polyfill is ever needed in the app itself.
//
// It is `createTrysteroFabric` (server/operator/peer.ts:192-261) ported MINUS
// two operator-only lines from its joinRoom config:
//   1. `rtcPolyfill: werift.RTCPeerConnection` (peer.ts:204) — the renderer has
//      native WebRTC; werift is a Node-only polyfill.
//   2. `passive: true` (peer.ts:203) — the operator is an always-on witness that
//      never initiates churn; a browser CLIENT must be ACTIVE to reach peers,
//      opponents, and witnesses (the proven live mp path, rtcTransport.ts, is
//      likewise not passive). `passive` is left configurable, defaulting false.
// Everything else is verbatim: the presence-gossip message action, the single
// framed request action ({kind,payload}), and the nodeId->peerId map learned
// from VERIFIED presence (peer.ts:279-291).
//
// The frame/dispatch logic takes the trystero room as an INJECTED constructor
// param so it is unit-testable headless (a fake room; no real relay). Real relay
// reachability is proven in the lead's playwright smoke.
//
// Platform-specific + renderer-hosted (app-lifetime, next to the mp singleton);
// src/shared/accounts stays pure. Transport-only: it moves canonical bytes; the
// overlay/protocol layers own ALL validation (types.ts:322).

import { joinRoom } from 'trystero'
import type { CanonicalObject } from '@shared/accounts'
import {
  PARAMS_A2,
  nodeIdOf,
  verifyPresence,
  type FabricEndpoint,
  type FabricRequestKind,
  type NodeDirectory,
  type NodeId,
  type SignedPresence,
} from '@shared/accounts/witness'
import { resolveIceServers } from './iceConfig'
import { resolveNostrRelays } from './relayConfig'

/** trystero app namespace for the accounts fabric — distinct from the mp game
 *  rooms (rtcTransport.ts APP_ID 'chess-sharp-mp-v3'). The operator peer must
 *  join with the SAME appId + roomId (+ password) to share this fabric; export
 *  the defaults so the lead can pass them to startOperatorPeer (M2/ops).
 *  Pre-rebrand spelling on both, and for the same reason as APP_ID: the string
 *  is the rendezvous, so a rename splits the fabric in two. Version it (`-v2`)
 *  when the fabric protocol itself changes. */
export const FABRIC_APP_ID = 'chess-sharp-accounts-fabric-v1'
export const FABRIC_ROOM_DEFAULT = 'accounts-fabric-v1'
const REQUEST_NS = 'fabreq' // one request namespace; the kind rides in the frame
const ANNOUNCE_NS = 'presence'

type PeerCtx = { peerId: string }

/** A trystero message action (presence gossip): fire-and-forget, no target =>
 *  broadcast. A structural subset of trystero's MessageAction. */
interface FabricMessageAction {
  send(data: CanonicalObject, opts?: { target?: string | string[] | null }): Promise<void> | void
}
/** A trystero request action (framed request/response over the data channel). A
 *  structural subset of trystero's RequestAction. */
interface FabricRequestAction {
  request(data: CanonicalObject, opts: { target: string }): Promise<unknown>
}

/**
 * The minimal trystero Room surface `createBrowserFabric` uses — declared
 * structurally (a subset of trystero's `Room`) so a headless fake room can be
 * injected in unit tests and a real `joinRoom()` result is assignable to it.
 */
export interface FabricRoom {
  makeAction(
    ns: string,
    config: { kind?: 'message'; onMessage?: (data: unknown, ctx: PeerCtx) => void },
  ): FabricMessageAction
  makeAction(
    ns: string,
    config: {
      kind: 'request'
      onRequest?: (data: unknown, ctx: PeerCtx) => unknown | Promise<unknown>
    },
  ): FabricRequestAction
  leave(): Promise<void>
}

export interface BrowserFabricOpts {
  /** This endpoint's nodeId (= sha256(rootPub), distance.ts nodeIdOf) —
   *  FabricEndpoint.nodeId. */
  nodeId: NodeId
  /** trystero app namespace (default FABRIC_APP_ID). Must match the operator
   *  peer's appId to share the fabric. Ignored when `room` is injected. */
  appId?: string
  /** Fabric room id (default FABRIC_ROOM_DEFAULT). Ignored when `room` is
   *  injected. */
  roomId?: string
  /** Optional room password — E2E-encrypts trystero session descriptions.
   *  Ignored when `room` is injected. */
  password?: string
  /** Presence staleness horizon advertised in directory() (default
   *  PARAMS_A2.leaseTtlMs * 4, matching the operator peer). */
  staleAfterMs?: number
  /** ICE servers for the native RTCPeerConnection (default resolveIceServers();
   *  C-11 env/operator-fallback aware). Ignored when `room` is injected. */
  iceServers?: readonly RTCIceServer[]
  /** Passive = accept peers, never initiate (the operator's always-on-witness
   *  posture). Defaults FALSE for a browser client, which must actively reach
   *  peers/witnesses. Ignored when `room` is injected. */
  passive?: boolean
  /** Injected trystero room — omit in production (built via joinRoom with
   *  native WebRTC). Unit tests inject a fake so the frame/dispatch logic runs
   *  headless with no relay. */
  room?: FabricRoom
}

/**
 * Build a browser-hosted FabricEndpoint. Peers are addressed by trystero
 * peerId; a nodeId->peerId map is learned from verified presence gossip. Full
 * key-distance routing is the A3 overlay layered ON TOP of this transport — the
 * fabric here only moves canonical bytes by nodeId.
 *
 * Synchronous: native WebRTC needs no async polyfill load, so `joinRoom` is
 * called inline. Tests inject `opts.room` and never touch a relay.
 */
export function createBrowserFabric(opts: BrowserFabricOpts): FabricEndpoint {
  const selfNodeId = opts.nodeId
  const staleAfterMs = opts.staleAfterMs ?? PARAMS_A2.leaseTtlMs * 4
  const room = opts.room ?? joinBrowserRoom(opts)

  const handlers = new Map<
    FabricRequestKind,
    (from: NodeId, payload: CanonicalObject) => Promise<CanonicalObject>
  >()
  const presence = new Map<NodeId, SignedPresence>()
  const peerOfNode = new Map<NodeId, string>()

  // Presence gossip (trystero message action) — learn nodeId->peerId and
  // populate the directory. verifyPresence runs inside ingestPresence.
  const presenceAction = room.makeAction(ANNOUNCE_NS, {
    kind: 'message',
    onMessage: (data: unknown, ctx: PeerCtx) =>
      ingestPresence(presence, peerOfNode, data as SignedPresence, ctx.peerId),
  })

  // Single request channel (trystero request action); the FabricRequestKind
  // rides inside the frame. onRequest returns the response value directly.
  const requestAction = room.makeAction(REQUEST_NS, {
    kind: 'request',
    onRequest: async (data: unknown, ctx: PeerCtx) => {
      const frame = data as { kind: FabricRequestKind; payload: CanonicalObject }
      const h = handlers.get(frame.kind)
      const from = nodeOfPeer(peerOfNode, ctx.peerId) ?? (ctx.peerId as NodeId)
      if (!h) return { error: `no handler for '${frame.kind}'` }
      return h(from, frame.payload)
    },
  })

  return {
    nodeId: selfNodeId,
    announce(sp: SignedPresence): void {
      // Own presence is recorded locally (self is trusted) AND broadcast.
      presence.set(nodeIdOf(sp.body.root), sp)
      void presenceAction.send(sp as unknown as CanonicalObject) // no target => broadcast
    },
    directory(): NodeDirectory {
      // A fresh Map view each call so a caller mutating it can't corrupt the map.
      return { nodes: new Map(presence), staleAfterMs }
    },
    async request(
      to: NodeId,
      kind: FabricRequestKind,
      payload: CanonicalObject,
    ): Promise<CanonicalObject> {
      const peerId = peerOfNode.get(to)
      if (peerId === undefined) throw new Error(`browser-fabric: no peer for node ${to}`)
      const res = await requestAction.request({ kind, payload }, { target: peerId })
      return res as CanonicalObject
    },
    onRequest(
      kind: FabricRequestKind,
      handler: (from: NodeId, payload: CanonicalObject) => Promise<CanonicalObject>,
    ): void {
      handlers.set(kind, handler)
    },
    async close(): Promise<void> {
      await room.leave()
    },
  }
}

/**
 * Build the real trystero room over native WebRTC — createTrysteroFabric's room
 * construction (peer.ts:199-207) MINUS `rtcPolyfill` and `passive:true` (see the
 * file header). Only reached in production; tests inject `opts.room`.
 */
function joinBrowserRoom(opts: BrowserFabricOpts): FabricRoom {
  const iceServers = opts.iceServers ?? resolveIceServers()
  // RELAY-SEAM: OUR Nostr signaling relays when VITE_NOSTR_RELAYS is set; null ⇒
  // no relayConfig ⇒ the trystero fork defaults (byte-identical to before).
  const relayConfig = resolveNostrRelays()
  const room = joinRoom(
    {
      appId: opts.appId ?? FABRIC_APP_ID,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      ...(opts.passive ? { passive: true } : {}),
      ...(relayConfig ? { relayConfig } : {}),
      rtcConfig: { iceServers: [...iceServers] },
    },
    opts.roomId ?? FABRIC_ROOM_DEFAULT,
  )
  return room as unknown as FabricRoom
}

/** Ingest a gossiped presence record: verify its signature, keep newest-per-node,
 *  and learn its nodeId->peerId (peer.ts:279-291). Never throws — a malformed or
 *  bad-signature record is dropped by verifyPresence before any field access. */
function ingestPresence(
  presence: Map<NodeId, SignedPresence>,
  peerOfNode: Map<NodeId, string>,
  sp: SignedPresence,
  peerId: string,
): void {
  if (!verifyPresence(sp)) return
  const nid = nodeIdOf(sp.body.root)
  const prev = presence.get(nid)
  if (prev && prev.body.ts >= sp.body.ts) return
  presence.set(nid, sp)
  peerOfNode.set(nid, peerId)
}

/** Reverse the nodeId->peerId map so an inbound request can be attributed to the
 *  sender's nodeId (peer.ts:292-295). */
function nodeOfPeer(peerOfNode: Map<NodeId, string>, peerId: string): NodeId | undefined {
  for (const [nid, pid] of peerOfNode) if (pid === peerId) return nid
  return undefined
}
