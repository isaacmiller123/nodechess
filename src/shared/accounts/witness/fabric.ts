// A2 fabric transport, MockFabric: an in-process implementation of
// FabricEndpoint (types.ts) that wires N nodes over a single shared message bus.
// This is the test substrate for the witness fabric. The mock-pair analogue of
// the games layer's test-mp, so the protocol flows (protocol.ts) and the
// operator peer (server/operator/peer.ts) run against a deterministic, offline,
// in-memory network instead of real WebRTC relays.
//
// Routing: request(to, kind, payload) delivers to the target endpoint's
// onRequest(kind) handler; presence announce broadcasts into a shared directory
// every endpoint observes. Payloads cross the "wire" as canonical bytes
// (parseCanonical(canonicalBytes(x))) so nothing shares a mutable reference and
// a non-canonical payload fails loudly at the boundary. Exactly as a real
// transport would frame them.
//
// Pure + platform-neutral: no `node:` imports, no DOM globals, no Date.now(),
// no Math.random(). Time and identity are the caller's.

import { canonicalBytes, parseCanonical, type CanonicalObject } from '../codec'
import { nodeIdOf } from './distance'
import { verifyPresence } from './presence'
import type {
  FabricEndpoint,
  FabricRequestKind,
  NodeDirectory,
  NodeId,
  SignedPresence,
} from './types'

type Handler = (from: NodeId, payload: CanonicalObject) => Promise<CanonicalObject>

interface Registration {
  nodeId: NodeId
  handlers: Map<FabricRequestKind, Handler>
  closed: boolean
}

/** Deep-clone a canonical object through the codec (simulates the wire frame). */
function wireClone(payload: CanonicalObject): CanonicalObject {
  return parseCanonical(canonicalBytes(payload)) as CanonicalObject
}

/**
 * A shared in-process message bus. Endpoints created off one MockFabric see one
 * another's presence announcements and can request one another by nodeId. The
 * directory is shared (every observer sees the same live set). Real fabrics are
 * observer-local, but a shared view is strictly harder on the protocol (every
 * safety rule is enforced on a record's SIGNATURE SET, never on the directory),
 * so the mock loses no coverage.
 */
export class MockFabric {
  private readonly registry = new Map<NodeId, Registration>()
  private readonly presence = new Map<NodeId, SignedPresence>()
  private readonly staleAfterMs: number

  constructor(opts: { staleAfterMs?: number } = {}) {
    // Default: effectively non-expiring within a suite (time is injected at the
    // liveNodesOf/canonicalWitnessSet layer via nowMs, so staleness is exercised
    // there, not by the transport clock).
    this.staleAfterMs = opts.staleAfterMs ?? Number.MAX_SAFE_INTEGER
  }

  /** Mint an endpoint for `nodeId`. Re-minting the same nodeId REPLACES the
   * registration (a node reconnecting with a fresh handler table); the prior
   * handle becomes stale. Its close() is a no-op (see _close). */
  endpoint(nodeId: NodeId): FabricEndpoint {
    const reg: Registration = { nodeId, handlers: new Map(), closed: false }
    this.registry.set(nodeId, reg)
    return new MockEndpoint(this, reg)
  }

  /** Live nodes count (diagnostic for suites). */
  get size(): number {
    return this.registry.size
  }

  // --- internal wiring (called by MockEndpoint) ---------------------------

  _announce(sp: SignedPresence): void {
    if (!verifyPresence(sp)) return // a bad-signature presence never enters the bus
    const nodeId = nodeIdOf(sp.body.root)
    const prev = this.presence.get(nodeId)
    if (prev && prev.body.ts >= sp.body.ts) return // newest-per-node wins
    this.presence.set(nodeId, sp)
  }

  _directory(): NodeDirectory {
    // A fresh Map view each call so a caller mutating it can't corrupt the bus.
    return { nodes: new Map(this.presence), staleAfterMs: this.staleAfterMs }
  }

  async _request(
    _from: NodeId,
    to: NodeId,
    kind: FabricRequestKind,
    payload: CanonicalObject,
  ): Promise<CanonicalObject> {
    const target = this.registry.get(to)
    if (!target || target.closed) throw new Error(`fabric: no route to ${to}`)
    const handler = target.handlers.get(kind)
    if (!handler) throw new Error(`fabric: ${to} has no handler for '${kind}'`)
    // Frame the request across the wire, run the handler, frame the response.
    const framed = wireClone(payload)
    const res = await handler(_from, framed)
    return wireClone(res)
  }

  _close(reg: Registration): void {
    reg.closed = true
    reg.handlers.clear()
    // Only evict if this reg is still the CURRENT one for the nodeId. Closing a
    // stale handle after the node re-minted must not evict the live registration.
    if (this.registry.get(reg.nodeId) === reg) this.registry.delete(reg.nodeId)
    // Presence is left in the directory to expire naturally by staleness. A
    // node going offline does not instantly vanish from every observer's view.
  }
}

class MockEndpoint implements FabricEndpoint {
  constructor(
    private readonly bus: MockFabric,
    private readonly reg: Registration,
  ) {}

  get nodeId(): NodeId {
    return this.reg.nodeId
  }

  announce(p: SignedPresence): void {
    this.bus._announce(p)
  }

  directory(): NodeDirectory {
    return this.bus._directory()
  }

  request(to: NodeId, kind: FabricRequestKind, payload: CanonicalObject): Promise<CanonicalObject> {
    return this.bus._request(this.reg.nodeId, to, kind, payload)
  }

  onRequest(kind: FabricRequestKind, handler: Handler): void {
    this.reg.handlers.set(kind, handler)
  }

  async close(): Promise<void> {
    this.bus._close(this.reg)
  }
}
