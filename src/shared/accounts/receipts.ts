// Service receipts — a counterparty-signed record of work actually delivered.
//
// A node that serves a shard read, accepts a shard store, relays mail or answers
// a pointer lookup can ask the node it served to sign for it. The receipt is
// signed by the RECEIVER, never the performer, which is the entire security
// property: a node cannot mint evidence of its own usefulness, only collect it
// from the peers it genuinely helped.
//
// This is a seam, not a system. Nothing consumes receipts yet. It exists because
// the alternative measure of contribution — counting nodes — is worthless the
// moment identities are cheap to create, and identities here are free by design.
// Work delivered is Sybil-resistant for the same reason node count is not: a
// thousand fake nodes that serve nothing accumulate nothing.
//
// Platform-neutral, pure, allocation-light: no `node:` imports, no DOM globals,
// no clock (callers pass `ts`, per the library's clock-free contract).

import { z } from 'zod'
import { canonicalBytes, type CanonicalObject } from './codec'
import { ed25519, toB64u, verifySigB64u as verifySig } from './hash'
import { zB64u32 } from './events'
import type { B64u } from './types'

/** What a receipt can attest to. Every kind is a measurable transfer, never a
 *  judgment — there is deliberately no 'was helpful' or 'behaved well'. */
export const SERVICE_KINDS = ['shard-read', 'shard-store', 'mail-relay', 'pointer-read'] as const
export type ServiceKind = (typeof SERVICE_KINDS)[number]

export interface ServiceReceiptBody extends CanonicalObject {
  v: 1
  /** nodeId of the node that PERFORMED the service. */
  server: B64u
  /** Root of the account that RECEIVED it — and therefore signs. */
  client: B64u
  kind: ServiceKind
  /** Bytes transferred. Non-negative, integral, and bounded so a single receipt
   *  can never claim an absurd quantity that later accounting must special-case. */
  bytes: number
  /** Client's clock at signing. Receipts are evidence, not ordering. */
  ts: number
}

export interface ServiceReceipt {
  body: ServiceReceiptBody
  /** Client's signing key (certified in the client's own chain). */
  key: B64u
  /** ed25519 by `key` over canonicalBytes(body). */
  sig: B64u
}

/** One receipt may not claim more than this. 64 MiB is far above any single
 *  legitimate transfer (a shard is orders of magnitude smaller), so the bound
 *  costs nothing honest while keeping totals from being one forged receipt away
 *  from meaningless. */
export const MAX_RECEIPT_BYTES = 64 * 1024 * 1024

export const zServiceReceiptBody = z.strictObject({
  v: z.literal(1),
  server: zB64u32,
  client: zB64u32,
  kind: z.enum(SERVICE_KINDS),
  bytes: z.int().min(0).max(MAX_RECEIPT_BYTES),
  ts: z.int().min(0),
})

/**
 * Sign a receipt as the CLIENT — the node that received the service. `priv` must
 * be the private half of `key`; the caller's own chain is what proves `key`
 * belongs to `body.client`, exactly as it does for every other signed record.
 */
export function signServiceReceipt(
  body: ServiceReceiptBody,
  key: B64u,
  priv: Uint8Array,
): ServiceReceipt {
  const parsed = zServiceReceiptBody.safeParse(body)
  if (!parsed.success)
    throw new Error(`signServiceReceipt: invalid body: ${parsed.error.issues[0]?.code}`)
  if (toB64u(ed25519.getPublicKey(priv)) !== key)
    throw new Error('signServiceReceipt: priv does not match key')
  return { body, key, sig: toB64u(ed25519.sign(canonicalBytes(body), priv)) }
}

/**
 * Structural + signature check. Deliberately does NOT check that `key` is
 * certified under `body.client` — that needs a chain view, and every consumer
 * that cares already holds one (certsProving). Verifying here would either
 * duplicate that logic or invite a caller to think this alone is sufficient.
 */
export function verifyServiceReceipt(receipt: ServiceReceipt): boolean {
  const parsed = zServiceReceiptBody.safeParse(receipt.body)
  if (!parsed.success) return false
  // A node cannot serve itself into a pile of receipts.
  if (receipt.body.server === receipt.body.client) return false
  return verifySig(receipt.sig, canonicalBytes(receipt.body), receipt.key)
}

/**
 * Total bytes a set of receipts credits to `server`, counting each receipt at
 * most once. Invalid receipts and receipts for other servers contribute zero —
 * a hostile bundle can only ever reduce its own total, never inflate it.
 *
 * Dedupe is by (client, kind, ts, bytes): replaying one receipt a thousand times
 * is the obvious cheap attack, and it is the only one this function can defend
 * against on its own.
 */
export function creditedBytes(server: B64u, receipts: readonly ServiceReceipt[]): number {
  const seen = new Set<string>()
  let total = 0
  for (const r of receipts) {
    if (r.body.server !== server) continue
    if (!verifyServiceReceipt(r)) continue
    const id = `${r.body.client}|${r.body.kind}|${r.body.ts}|${r.body.bytes}`
    if (seen.has(id)) continue
    seen.add(id)
    total += r.body.bytes
  }
  return total
}
