// The operator's always-awake peer (spec §11 two integrations + §4 C-10).
// node-only (server/**), OUTSIDE src/shared so it may use node APIs. It is just
// another eligible node under the §4 rules: it runs witnessServe + memberServe,
// holds ZERO authority, and is removable. Its only privilege is being awake, so
// the 2-user rated-play window is negligible (never truth, never data).
//
// Two integrations (§11), both behind the platform-neutral FabricEndpoint so
// MockFabric (suites) and TrysteroFabric (production) are swappable:
//   (a) TrysteroFabric: a FabricEndpoint over trystero with werift's
//       RTCPeerConnection as the Node WebRTC polyfill (passive, always-on),
//   (b) the pinned canonical judge, held as the shared JudgeEngine adapter
//       (server/judge/nodeAdapter.ts over the A2 harness), constructed +
//       content-hash-verified at startup as witness-of-last-resort. Tier-2 duty
//       drives this handle ONLY through judgeGame (spec §8: ONE canonical judge
//       surface): never the raw A2 analyseFixedNodes protocol, whose
//       per-position TT clear + parse rules are a different bit surface. A2
//       wired it; running Tier-2 is A5 (mounted at A6).
//
// This module is NOT mounted into server/index.ts's main flow (that lands in
// A6/A-final). It exports startOperatorPeer() + the TrysteroFabric factory; the
// offline smoke (scripts/operator-smoke.mjs) drives it against a MockFabric so
// CI never touches a real relay.

import {
  MemoryWitnessStore,
  PARAMS_A2,
  PARAMS_A2_DIGEST,
  memberServe,
  nodeIdOf,
  signPresence,
  verifyPresence,
  witnessServe,
  type FabricEndpoint,
  type FuseRecord,
  type MemberServeHandle,
  type NodeId,
  type PresenceBody,
  type SignedPresence,
  type WitnessServeHandle,
} from '@shared/accounts/witness'
import type { B64u } from '@shared/accounts'
import type { JudgeEngine } from '@shared/accounts/judge'
import { newNodeJudgeEngine } from '../judge/nodeAdapter.js'

/** The operator peer's own identity. A normal account's root + device keypair. */
export interface OperatorIdentity {
  /** Account root pubkey (b64u). nodeId = sha256(root). */
  rootPub: B64u
  nodeId: NodeId
  /** Device signing key advertised in presence + used to attest/grant/evaluate. */
  deviceKey: B64u
  devicePriv: Uint8Array
}

export interface JudgeConfig {
  /** Default true: construct + content-hash-verify the pinned judge at startup.
   * A resolution failure degrades to "no live judge" (the peer still witnesses). */
  enabled?: boolean
  enginePath?: string
  wasmPath?: string
}

export interface StartOperatorPeerOpts {
  appId: string
  dataDir: string
  identity: OperatorIdentity
  /** Injected transport. Omit to build a TrysteroFabric (production). The
   * offline smoke passes a MockFabric endpoint so CI stays deterministic. */
  fabric?: FabricEndpoint
  /** Room password for the TrysteroFabric (ignored when `fabric` is injected). */
  password?: string
  /** Fabric room id (TrysteroFabric only). */
  roomId?: string
  /** Clock reading (ms). Defaults to Date.now (node-only, outside src/shared). */
  wts?: () => number
  /** Presence staleness horizon advertised to observers (TrysteroFabric). */
  staleAfterMs?: number
  /** Shared fuse view the peer consults before granting/evaluating. */
  fuseOf?: (root: B64u) => FuseRecord | null
  judge?: JudgeConfig
}

export interface OperatorPeer {
  readonly nodeId: NodeId
  readonly fabric: FabricEndpoint
  readonly witness: WitnessServeHandle
  readonly member: MemberServeHandle
  /** The last-resort Tier-2 capability as the CANONICAL judge surface (spec
   * §8): the shared JudgeEngine adapter, to be driven ONLY through judgeGame.
   * Deliberately NOT the raw A2 JudgeInstance: its analyseFixedNodes protocol
   * (per-position TT clear, divergent parse rules) cannot reproduce the
   * judgeOutputDigest canonical verifiers compute over a multi-position game. */
  readonly judge?: JudgeEngine
  /** (Re)broadcast the peer's presence into the fabric. */
  announce(nowMs?: number): void
  stop(): Promise<void>
}

/**
 * Boot the operator peer: verify the judge binary is the pinned blob, register
 * the witness + member handlers on the fabric, and announce presence. Returns a
 * handle the host can stop. The peer never gates on the judge: a missing/
 * mismatched engine only costs the last-resort Tier-2 capability, never its
 * witness/committee duties.
 */
export async function startOperatorPeer(opts: StartOperatorPeerOpts): Promise<OperatorPeer> {
  const wts = opts.wts ?? (() => Date.now())
  const fuseOf = opts.fuseOf ?? (() => null)

  const fabric = opts.fabric ?? (await createTrysteroFabric(opts))

  // (b) Judge: the canonical §8 surface, newNodeJudgeEngine content-hash-gates
  // (typed JudgeWasmHashError, no opt-out) BEFORE spawning, and the wrapped
  // newInstance re-verifies at spawn. Best-effort. The peer witnesses
  // regardless (spec §11: witness-of-last-resort, not a hard dependency).
  let judge: JudgeEngine | undefined
  const jc = opts.judge ?? {}
  if (jc.enabled !== false) {
    try {
      judge = await newNodeJudgeEngine({
        ...(jc.enginePath ? { enginePath: jc.enginePath } : {}),
        ...(jc.wasmPath ? { wasmPath: jc.wasmPath } : {}),
      })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[operator] judge unavailable, continuing witness-only: ${(e as Error).message}`)
      judge = undefined
    }
  }

  const id = { nodeId: opts.identity.nodeId, key: opts.identity.deviceKey, priv: opts.identity.devicePriv }

  const store = new MemoryWitnessStore()
  const witness = witnessServe(fabric, id, {
    store,
    wts,
    fuseOf,
    timeWindowMs: PARAMS_A2.timeWindowMs,
  })
  const member = memberServe(fabric, id, { wts, fuseOf })

  const announce = (nowMs = wts()): void => {
    const body: PresenceBody = {
      v: 1,
      root: opts.identity.rootPub,
      key: opts.identity.deviceKey,
      caps: { witness: true, committee: true, shardMb: 256 },
      params: PARAMS_A2_DIGEST,
      ts: nowMs,
      uptimePct: 100,
    }
    const sp: SignedPresence = signPresence(body, opts.identity.devicePriv)
    fabric.announce(sp)
  }
  announce()

  return {
    nodeId: opts.identity.nodeId,
    fabric,
    witness,
    member,
    judge,
    announce,
    async stop() {
      if (judge) await judge.close().catch(() => {})
      await fabric.close()
    },
  }
}

// ---------------------------------------------------------------------------
// (a) TrysteroFabric: thin FabricEndpoint over trystero + werift.
// ---------------------------------------------------------------------------

// Loosely typed on purpose: trystero's public types reference DOM globals
// (RTCPeerConnection, MediaStream) that tsconfig.server (lib ES2022, no DOM)
// does not carry. The FabricEndpoint boundary below is the type-safe surface;
// the trystero internals stay `any` so no DOM type leaks into server code, and
// the imports are dynamic so the offline smoke (MockFabric) never loads them.

const FABRIC_ROOM_DEFAULT = 'accounts-fabric-v1'
const REQUEST_NS = 'fabreq' // one request namespace; the kind rides in the frame
const ANNOUNCE_NS = 'presence'

/**
 * Build a passive (always-on witness) TrysteroFabric. Peers are addressed by
 * their trystero peerId; a nodeId→peerId map is learned from presence
 * announcements. Full key-distance routing is A3's overlay. Here the operator
 * simply serves whoever reaches it, which is exactly the witness-of-last-resort
 * role. Never invoked by CI (the smoke injects a MockFabric).
 */
export async function createTrysteroFabric(opts: StartOperatorPeerOpts): Promise<FabricEndpoint> {
  const trystero = (await import('trystero')) as unknown as {
    joinRoom: (config: Record<string, unknown>, roomId: string) => TrysteroRoom
  }
  const werift = (await import('werift')) as unknown as { RTCPeerConnection: unknown }

  const roomId = opts.roomId ?? FABRIC_ROOM_DEFAULT
  const room = trystero.joinRoom(
    {
      appId: opts.appId,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      passive: true, // always-on witness: accept peers, never initiate churn
      rtcPolyfill: werift.RTCPeerConnection,
    },
    roomId,
  )

  const selfNodeId = opts.identity.nodeId
  const staleAfterMs = opts.staleAfterMs ?? PARAMS_A2.leaseTtlMs * 4
  const handlers = new Map<string, (from: NodeId, payload: unknown) => Promise<unknown>>()
  const presence = new Map<NodeId, SignedPresence>()
  const peerOfNode = new Map<NodeId, string>()

  // Presence gossip (trystero 0.25 message action): learn nodeId→peerId and
  // populate the directory. makeAction returns an object; onMessage(data, ctx).
  const presenceAction = room.makeAction(ANNOUNCE_NS, {
    kind: 'message',
    onMessage: (data: unknown, ctx: { peerId: string }) => {
      // verifyPresence lives in shared and runs inside ingestPresence.
      void ingestPresence(presence, peerOfNode, data as SignedPresence, ctx.peerId)
    },
  })

  // Single request channel (trystero 0.25 request action); the FabricRequestKind
  // rides inside the frame. onRequest returns the response value directly.
  const requestAction = room.makeAction(REQUEST_NS, {
    kind: 'request',
    onRequest: async (data: unknown, ctx: { peerId: string }) => {
      const frame = data as { kind: string; payload: unknown }
      const h = handlers.get(frame.kind)
      const from = nodeOfPeer(peerOfNode, ctx.peerId) ?? ctx.peerId
      if (!h) return { error: `no handler for '${frame.kind}'` }
      return h(from as NodeId, frame.payload)
    },
  })

  return {
    nodeId: selfNodeId,
    announce(sp: SignedPresence): void {
      const nid = deriveNodeId(sp)
      presence.set(nid, sp)
      void presenceAction.send(sp as unknown as Record<string, unknown>) // no target ⇒ broadcast
    },
    directory() {
      return { nodes: new Map(presence), staleAfterMs }
    },
    async request(to, kind, payload) {
      const peerId = peerOfNode.get(to)
      if (peerId === undefined) throw new Error(`trystero-fabric: no peer for node ${to}`)
      const res = await requestAction.request({ kind, payload } as unknown as Record<string, unknown>, { target: peerId })
      return res as never
    },
    onRequest(kind, handler) {
      handlers.set(kind, handler as unknown as (from: NodeId, payload: unknown) => Promise<unknown>)
    },
    async close() {
      await room.leave()
    },
  }
}

/** The trystero 0.25 Room surface this glue uses (subset, loosely typed). A
 * message action broadcasts (no target); a request action does request/response. */
interface TrysteroRoom {
  makeAction(
    ns: string,
    config: Record<string, unknown>,
  ): {
    send: (data: Record<string, unknown>, opts?: { target?: string }) => Promise<void>
    request: (data: Record<string, unknown>, opts: { target: string }) => Promise<unknown>
  }
  leave(): Promise<void>
}

function deriveNodeId(sp: SignedPresence): NodeId {
  return nodeIdOf(sp.body.root)
}
async function ingestPresence(
  presence: Map<NodeId, SignedPresence>,
  peerOfNode: Map<NodeId, string>,
  sp: SignedPresence,
  peerId: string,
): Promise<void> {
  if (!verifyPresence(sp)) return
  const nid = nodeIdOf(sp.body.root)
  const prev = presence.get(nid)
  if (prev && prev.body.ts >= sp.body.ts) return
  presence.set(nid, sp)
  peerOfNode.set(nid, peerId)
}
function nodeOfPeer(peerOfNode: Map<NodeId, string>, peerId: string): NodeId | undefined {
  for (const [nid, pid] of peerOfNode) if (pid === peerId) return nid
  return undefined
}
