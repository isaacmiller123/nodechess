// A3 overlay: RPC wire schemas + the safe request/handler boundary
// (overlay/types.ts payload contracts riding witness/types.ts FabricEndpoint).
//
// zod v4 schemas mirror the type contract EXACTLY (z.strictObject / z.int(),
// events.ts idioms). The boundary rules are A2 protocol.ts onSafe's: a
// malformed wire payload gets a typed { error } response, never a throw across
// the fabric; a malformed or error RESPONSE surfaces as a failed reply the
// caller treats like an unreachable contact. Platform-neutral + deterministic:
// no `node:` imports, no DOM globals, no ambient clock or randomness.

import { z } from 'zod'
import type { CanonicalObject } from '../codec'
import { zB64u32 } from '../events'
import type { FabricEndpoint, FabricRequestKind, NodeId } from '../witness/types'

// ---------------------------------------------------------------------------
// Schemas (mirror overlay/types.ts shapes)
// ---------------------------------------------------------------------------

/** Wire-sanity cap on contact lists (kBucket rides PARAMS_A3 = 16; the cap
 * only bounds a malicious responder's memory pressure, never semantics). */
export const WIRE_CONTACTS_MAX = 64

export const zContact = z.strictObject({
  nodeId: zB64u32,
  root: zB64u32,
  key: zB64u32,
  lastSeenMs: z.int().min(0),
})

export const zValueKind = z.enum(['pointers', 'events', 'shard', 'record'])

/** Opaque canonical payload: validated by the STORAGE layer, never here. */
const zOpaqueValue = z.record(z.string(), z.unknown())

export const zFindNodeReq = z.strictObject({
  v: z.literal(1),
  target: zB64u32,
})

export const zFindNodeRes = z.strictObject({
  v: z.literal(1),
  contacts: z.array(zContact).max(WIRE_CONTACTS_MAX),
})

export const zFindValueReq = z.strictObject({
  v: z.literal(1),
  target: zB64u32,
  kind: zValueKind,
})

export const zFindValueRes = z
  .strictObject({
    v: z.literal(1),
    value: zOpaqueValue.optional(),
    contacts: z.array(zContact).max(WIRE_CONTACTS_MAX).optional(),
  })
  .superRefine((r, ctx) => {
    // The contract: value (hit) OR contacts (miss). Never both.
    if (r.value !== undefined && r.contacts !== undefined)
      ctx.addIssue({ code: 'custom', message: 'find-value response carries value OR contacts, never both' })
  })

export const zStoreReq = z.strictObject({
  v: z.literal(1),
  target: zB64u32,
  kind: zValueKind,
  value: zOpaqueValue,
})

export const zStoreRes = z.strictObject({
  v: z.literal(1),
  stored: z.boolean(),
  reason: z.string().max(64).optional(),
})

export const zPingReq = z.strictObject({
  v: z.literal(1),
})

export const zPingRes = z.strictObject({
  v: z.literal(1),
  nodeId: zB64u32,
})

/** The typed error response a handler returns instead of throwing. */
export const zOverlayError = z.strictObject({
  error: z.string().max(64),
})

// ---------------------------------------------------------------------------
// Boundary helpers
// ---------------------------------------------------------------------------

function asMsg<T>(v: T): CanonicalObject {
  return v as unknown as CanonicalObject
}

/**
 * Register an overlay handler behind the uniform boundary guard: the payload
 * is schema-validated (malformed → typed { error }, never a throw across the
 * fabric) and the handler body is fenced (an unexpected throw → typed
 * { error }). `alive` gates a closed node: once it reports false the handler
 * THROWS, so in-flight requesters observe the node as unreachable and evict.
 * The closest thing to handler release the FabricEndpoint contract allows.
 */
export function onOverlay<S extends z.ZodType>(
  fabric: FabricEndpoint,
  kind: FabricRequestKind,
  schema: S,
  handler: (from: NodeId, req: z.output<S>) => Promise<CanonicalObject>,
  alive: () => boolean,
): void {
  fabric.onRequest(kind, async (from, payload) => {
    if (!alive()) throw new Error(`overlay: node closed (${kind})`)
    const parsed = schema.safeParse(payload)
    if (!parsed.success) return asMsg({ error: 'malformed-request' })
    try {
      return await handler(from, parsed.data)
    } catch {
      return asMsg({ error: 'handler-failed' })
    }
  })
}

/** A safe reply: ok with the schema-validated response, or a failure the
 * caller treats as an unreachable/broken contact (transport throw, typed
 * error response, or a malformed response shape). */
export type OverlayReply<T> = { ok: true; res: T } | { ok: false; reason: string }

/**
 * Issue an overlay RPC and validate the reply. NEVER throws: transport errors,
 * typed { error } responses, and malformed responses all come back as
 * { ok: false } so lookup loops can evict and continue deterministically.
 */
export async function overlayRequest<S extends z.ZodType>(
  fabric: FabricEndpoint,
  to: NodeId,
  kind: FabricRequestKind,
  payload: CanonicalObject,
  resSchema: S,
): Promise<OverlayReply<z.output<S>>> {
  let raw: CanonicalObject
  try {
    raw = await fabric.request(to, kind, payload)
  } catch {
    return { ok: false, reason: 'transport' }
  }
  const err = zOverlayError.safeParse(raw)
  if (err.success) return { ok: false, reason: err.data.error }
  const parsed = resSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'malformed-response' }
  return { ok: true, res: parsed.data }
}
