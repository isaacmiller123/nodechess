/**
 * The channel the two devices meet on.
 *
 * Same transport the account fabric already uses (trystero over WebRTC with a
 * relay fallback, net/browserFabric.ts), but a room of its own: the rendezvous
 * id from the code is the room id, and the channel secret from the code is the
 * room password, which encrypts the session descriptions that pass through the
 * signaling relay. So the relay carries no readable handshake, the data channel
 * is DTLS end to end, and the only party who can join is one that saw the code.
 *
 * WHICH IS NOT THE SAME AS BEING TRUSTED. Anyone who photographs the code can
 * join this room too. That is why the room does nothing but carry an offer of a
 * public key to the account holder, who then looks at a human-readable
 * fingerprint and decides. This module is transport and framing only; every
 * decision that matters lives in offerStore.ts and claimStore.ts.
 *
 * No account state, no keys, no storage: import it and it moves two message
 * shapes between two peers.
 */

import { joinRoom, type JsonValue, type Room } from 'trystero'
import { resolveIceServers } from '../net/iceConfig'
import { resolveNostrRelays } from '../net/relayConfig'
import type { PairingOffer } from './offer'

/** Distinct from the fabric app id and from the mp game rooms: pairing peers
 *  must never land in the same rendezvous namespace as play or witnessing. */
export const PAIRING_APP_ID = 'chess-sharp-pairing-v1'

const HELLO_NS = 'pairhello'
const GRANT_NS = 'pairgrant'

/** New device to account holder: "this is the key I made, and what I am." */
export interface HelloMessage {
  v: 1
  /** The new device's freshly generated PUBLIC key. Base64url. */
  pub: string
  /** Human label for the approval prompt: "Chrome on Android". */
  label: string
}

/** Account holder to new device: the answer, either way. */
export type GrantMessage =
  | {
      v: 1
      ok: true
      /** The account's public root, its signed name, and its tag. */
      root: string
      name: string
      tag: string
      /** Device slot this key was certified into. */
      index: number
      /** The whole account history, including the certificate just signed. */
      chain: JsonValue
    }
  | { v: 1; ok: false; reason: GrantRefusal }

export type GrantRefusal = 'declined' | 'expired' | 'used' | 'failed'

/** Player-facing sentence for a refusal arriving at the new device. */
export function refusalMessage(reason: GrantRefusal): string {
  switch (reason) {
    case 'declined':
      return 'Your other device said no, so this device was not signed in.'
    case 'expired':
      return 'The sign-in code ran out before this was approved. Show a fresh code and scan again.'
    case 'used':
      return 'That sign-in code had already been used. Show a fresh one on your other device.'
    case 'failed':
      return 'Your other device could not finish signing this one in. Try again.'
  }
}

export interface PairingRoomHandlers {
  /** A peer said hello. `peerId` is who to answer. */
  onHello?: (hello: HelloMessage, peerId: string) => void
  /** The answer came back. */
  onGrant?: (grant: GrantMessage) => void
  /** Someone arrived on the channel. */
  onPeerJoin?: (peerId: string) => void
  /** The rendezvous itself could not be reached (no relay, no network). */
  onJoinError?: (detail: string) => void
}

export interface PairingRoom {
  /** Broadcast (the account holder is the only other peer we expect). */
  sendHello(hello: HelloMessage): Promise<void>
  sendGrant(grant: GrantMessage, peerId: string): Promise<void>
  leave(): Promise<void>
}

/** Reject anything that is not exactly a hello before it reaches a decision. */
function asHello(data: unknown): HelloMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Partial<HelloMessage>
  if (m.v !== 1) return null
  if (typeof m.pub !== 'string' || m.pub.length === 0 || m.pub.length > 100) return null
  if (typeof m.label !== 'string') return null
  // The label is drawn in an approval prompt, so cap it here rather than
  // trusting a peer not to send a paragraph.
  return { v: 1, pub: m.pub, label: m.label.slice(0, 64) }
}

/** Same, for the answer. An unparseable grant is treated as no grant at all. */
function asGrant(data: unknown): GrantMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const m = data as { v?: unknown; ok?: unknown; reason?: unknown }
  if (m.v !== 1) return null
  if (m.ok === false) {
    const reason = m.reason
    const known: GrantRefusal[] = ['declined', 'expired', 'used', 'failed']
    return {
      v: 1,
      ok: false,
      reason: known.includes(reason as GrantRefusal) ? (reason as GrantRefusal) : 'failed',
    }
  }
  if (m.ok !== true) return null
  const g = data as Partial<Extract<GrantMessage, { ok: true }>>
  if (typeof g.root !== 'string' || typeof g.name !== 'string' || typeof g.tag !== 'string')
    return null
  if (typeof g.index !== 'number' || !Number.isInteger(g.index) || g.index < 0) return null
  if (typeof g.chain !== 'object' || g.chain === null) return null
  return {
    v: 1,
    ok: true,
    root: g.root,
    name: g.name,
    tag: g.tag,
    index: g.index,
    chain: g.chain,
  }
}

/**
 * Join the rendezvous the offer names. Synchronous, like the fabric's own room
 * construction: WebRTC is native in every context this app runs in, so there is
 * no polyfill to await.
 */
export function joinPairingRoom(offer: PairingOffer, handlers: PairingRoomHandlers): PairingRoom {
  const relayConfig = resolveNostrRelays()
  const room: Room = joinRoom(
    {
      appId: PAIRING_APP_ID,
      password: offer.secret,
      ...(relayConfig ? { relayConfig } : {}),
      rtcConfig: { iceServers: [...resolveIceServers()] },
    },
    offer.sid,
    {
      onJoinError: (details) => handlers.onJoinError?.(details.error),
    },
  )

  const hello = room.makeAction<JsonValue>(HELLO_NS, {
    onMessage: (data, ctx) => {
      const parsed = asHello(data)
      if (parsed) handlers.onHello?.(parsed, ctx.peerId)
    },
  })
  const grant = room.makeAction<JsonValue>(GRANT_NS, {
    onMessage: (data) => {
      const parsed = asGrant(data)
      if (parsed) handlers.onGrant?.(parsed)
    },
  })
  room.onPeerJoin = (peerId) => handlers.onPeerJoin?.(peerId)

  return {
    sendHello: (msg) => Promise.resolve(hello.send(msg as unknown as JsonValue)),
    sendGrant: (msg, peerId) =>
      Promise.resolve(grant.send(msg as unknown as JsonValue, { target: peerId })),
    leave: () => room.leave(),
  }
}
