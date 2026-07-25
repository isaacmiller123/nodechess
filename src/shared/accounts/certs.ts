// Key certificates + revocations (spec §1). Certificates are ALWAYS
// root-signed, personal-lane events: that is what makes their chain
// position immaterial at verification time. Revocations are witnessed-lane
// events, root- or device-signed.
//
// Platform-neutral: no `node:` imports, no DOM globals.

import {
  eventId,
  personalHeadOf,
  signBody,
  verifyEventSig,
  witnessedHeadOf,
  zCertPayload,
  zEventBody,
} from './events'
import { ed25519, toB64u } from './hash'
import type { B64u, CertPayload, Chain, EventBody, EventId, SignedEvent } from './types'

/** A validated certificate extracted from a chain. */
export interface CertInfo {
  pub: B64u
  purpose: number
  index: number
  label?: string
  /** Id of the cert event that introduced this key. */
  certId: EventId
  /** Personal-lane height of that cert event (root's chain). */
  height: number
}

export interface MakeCertOpts {
  childPub: B64u
  purpose: number
  index: number
  label?: string
  ts: number
}

/**
 * Build a personal-lane, ROOT-signed key certificate for `childPub`,
 * linked onto the root key's personal chain in `chainState` (the root's
 * first personal event is height 0, prev absent).
 */
export function makeCertEvent(
  rootPriv: Uint8Array,
  root: B64u,
  chainState: Chain,
  opts: MakeCertOpts,
): SignedEvent {
  if (toB64u(ed25519.getPublicKey(rootPriv)) !== root)
    throw new Error('makeCertEvent: rootPriv does not match root')
  if (chainState.root !== root) throw new Error('makeCertEvent: chain belongs to a different root')
  const head = personalHeadOf(chainState.events, root)
  const payload: CertPayload = { pub: opts.childPub, purpose: opts.purpose, index: opts.index }
  if (opts.label !== undefined) payload.label = opts.label
  const body: EventBody = {
    v: 1,
    lane: 'p',
    type: 'cert',
    root,
    key: root,
    height: head ? head.height + 1 : 0,
    ...(head ? { prev: head.id } : {}),
    ts: opts.ts,
    payload,
  }
  return signBody(body, rootPriv)
}

/**
 * Build a witnessed-lane revocation of `pub`, signed by `key` (the root or
 * any device key: admissibility of the signer is a verification concern).
 */
export function makeRevokeEvent(
  priv: Uint8Array,
  key: B64u,
  chain: Chain,
  opts: { pub: B64u; ts: number },
): SignedEvent {
  if (toB64u(ed25519.getPublicKey(priv)) !== key)
    throw new Error('makeRevokeEvent: priv does not match key')
  const head = witnessedHeadOf(chain.events)
  if (!head) throw new Error('makeRevokeEvent: chain has no witnessed lane (missing genesis)')
  const body: EventBody = {
    v: 1,
    lane: 'w',
    type: 'revoke',
    root: chain.root,
    key,
    height: head.height + 1,
    prev: head.id,
    ts: opts.ts,
    payload: { pub: opts.pub },
  }
  return signBody(body, priv)
}

/**
 * Validate one event as a root-signed certificate for `root`.
 * Returns the extracted CertInfo, or null if it is not a valid cert.
 * Never throws.
 */
export function isRootSignedCert(root: B64u, ev: SignedEvent): CertInfo | null {
  try {
    const b = ev.body
    if (b.type !== 'cert' || b.lane !== 'p' || b.root !== root || b.key !== root) return null
    if (!zEventBody.safeParse(b).success) return null
    const parsed = zCertPayload.safeParse(b.payload)
    if (!parsed.success) return null
    if (parsed.data.pub === root) return null // the root cannot be its own child
    if (!verifyEventSig(ev)) return null
    return {
      pub: parsed.data.pub,
      purpose: parsed.data.purpose,
      index: parsed.data.index,
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      certId: eventId(b),
      height: b.height,
    }
  } catch {
    return null
  }
}

/**
 * Extract the certificate set from an event list: every valid root-signed
 * cert, first-cert-per-pub wins, deterministic (personal height, then id).
 */
export function certSetFrom(root: B64u, events: readonly SignedEvent[]): CertInfo[] {
  const infos: CertInfo[] = []
  for (const ev of events) {
    const info = isRootSignedCert(root, ev)
    if (info) infos.push(info)
  }
  infos.sort((a, b) => a.height - b.height || (a.certId < b.certId ? -1 : a.certId > b.certId ? 1 : 0))
  const byPub = new Map<B64u, CertInfo>()
  for (const info of infos) if (!byPub.has(info.pub)) byPub.set(info.pub, info)
  return [...byPub.values()]
}

/**
 * Pick the cert EVENTS out of `events` that prove each pub in `pubs`
 * (for carrying alongside a fork proof). Root pubs need no cert.
 */
export function certsProving(root: B64u, events: readonly SignedEvent[], pubs: readonly B64u[]): SignedEvent[] {
  const out: SignedEvent[] = []
  const covered = new Set<B64u>()
  for (const pub of pubs) {
    if (pub === root || covered.has(pub)) continue
    for (const ev of events) {
      const info = isRootSignedCert(root, ev)
      if (info && info.pub === pub) {
        out.push(ev)
        covered.add(pub)
        break
      }
    }
  }
  return out
}
