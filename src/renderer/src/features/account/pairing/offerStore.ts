/**
 * The account holder's side of a pairing: show a code, answer one request, and
 * be dead afterwards.
 *
 * THE APPROVAL IS THE SECURITY. A scanned code gets a device as far as this
 * store and no further. What it can do here is announce a public key and a
 * label; what it cannot do is make the decision. The human sees the label and a
 * fingerprint, compares that fingerprint against the one on the other device's
 * screen, and says yes or no. Only a yes causes a signature.
 *
 * SINGLE USE AND SHORT LIVED, both enforced here rather than hoped for. The
 * moment an offer is answered, either way, it is consumed: any later request on
 * the same rendezvous is refused with a reason, never quietly ignored, so the
 * other end can say something true. Expiry is enforced against THIS device's
 * clock, which is the one that minted the number.
 *
 * House store pattern (features/play/online/onlineStore.ts): module scope,
 * bridged into React with useSyncExternalStore, so a pairing in progress
 * survives a re-render and cannot be started twice.
 */

import { useSyncExternalStore } from 'react'
import type { JsonValue } from 'trystero'
import { fromB64u, normalizeUsername, tagOf, type Chain } from '@shared/accounts'
import {
  loadOwnChain,
  rootSigningKey,
  shortDeviceLabel,
  keyring,
} from '../../../../../web/accounts'
import { certifyDevice } from './enroll'
import {
  OFFER_TTL_MS,
  mintOffer,
  pairingFingerprint,
  type PairingOffer,
} from './offer'
import {
  joinPairingRoom,
  type GrantRefusal,
  type HelloMessage,
  type PairingRoom,
} from './transport'

export type OfferPhase =
  | 'idle'
  /** A live code is on screen and nobody has asked yet. */
  | 'showing'
  /** A device has asked. The human decides. */
  | 'asking'
  /** Signing and sending. */
  | 'granting'
  /** Done: that device is signed in. */
  | 'granted'
  /** We said no. */
  | 'declined'
  /** Nobody used the code in time. */
  | 'expired'
  /** Something failed, with a sentence. */
  | 'error'

/** The request awaiting a human. */
export interface PendingRequest {
  pub: string
  label: string
  /** The eight characters the other device is showing right now. */
  fingerprint: string
}

export interface OfferState {
  phase: OfferPhase
  /** The live offer, or null. `encodeOffer` turns it into the code text. */
  offer: PairingOffer | null
  request: PendingRequest | null
  /** Label of the device that was signed in (phase 'granted'). */
  grantedLabel: string | null
  error: string | null
  /** Seconds until the code stops working. Recomputed by the countdown tick. */
  secondsLeft: number
}

const EMPTY: OfferState = {
  phase: 'idle',
  offer: null,
  request: null,
  grantedLabel: null,
  error: null,
  secondsLeft: 0,
}

let state: OfferState = EMPTY
const listeners = new Set<() => void>()

function set(patch: Partial<OfferState>): void {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Live session (outside the state object: none of it is renderable)
// ---------------------------------------------------------------------------

let room: PairingRoom | null = null
let live: PairingOffer | null = null
/** Answered already, either way: every later request is refused with 'used'. */
let consumed = false
let tick: number | null = null
/** Requests already seen, so a peer that repeats its hello does not reopen a
 *  decision the human has already made. */
const seenPubs = new Set<string>()

function stopTick(): void {
  if (tick !== null) {
    window.clearInterval(tick)
    tick = null
  }
}

async function leaveRoom(): Promise<void> {
  const r = room
  room = null
  if (!r) return
  try {
    await r.leave()
  } catch {
    /* a room that will not close is dropped; nothing depends on it */
  }
}

/** Tear the whole thing down. Safe to call from any phase, more than once. */
export function endOffer(): void {
  stopTick()
  live = null
  consumed = false
  seenPubs.clear()
  void leaveRoom()
  set(EMPTY)
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * Mint a code and start listening. Requires a device that actually holds the
 * account's root key: certificates are root-signed by definition (§1), so a
 * device that was itself paired cannot enrol another one and says so instead of
 * offering a code that could never be honoured.
 */
export function startOffer(): void {
  endOffer()
  const signer = rootSigningKey()
  if (!signer) {
    set({
      phase: 'error',
      error:
        'This device cannot add another one. Adding a device needs the device you first made the account on, or your recovery phrase.',
    })
    return
  }
  let offer: PairingOffer
  try {
    offer = mintOffer(Date.now(), OFFER_TTL_MS)
  } catch (e) {
    set({ phase: 'error', error: errMsg(e) })
    return
  }
  live = offer
  set({
    phase: 'showing',
    offer,
    request: null,
    grantedLabel: null,
    error: null,
    secondsLeft: Math.ceil(OFFER_TTL_MS / 1000),
  })

  try {
    room = joinPairingRoom(offer, {
      onHello: (hello, peerId) => void handleHello(hello, peerId),
      onJoinError: (detail) => {
        // Only worth saying while nothing has happened yet: a relay wobble
        // after the two peers found each other is not the player's problem.
        if (state.phase === 'showing')
          set({
            phase: 'error',
            error: `Could not open a channel for the other device to reach this one (${detail}). Check this device is online and try again.`,
          })
      },
    })
  } catch (e) {
    set({ phase: 'error', error: errMsg(e) })
    return
  }

  tick = window.setInterval(() => {
    if (!live) return
    const left = Math.max(0, Math.ceil((live.exp - Date.now()) / 1000))
    if (left !== state.secondsLeft) set({ secondsLeft: left })
    if (left === 0) {
      stopTick()
      // The code is dead but the room stays for a moment, so a device that is
      // mid-scan gets told why rather than waiting on silence.
      if (!consumed && (state.phase === 'showing' || state.phase === 'asking'))
        set({ phase: 'expired', request: null })
      window.setTimeout(() => {
        if (state.phase === 'expired') void leaveRoom()
      }, 30_000)
    }
  }, 250)
}

function expired(): boolean {
  return live === null || Date.now() >= live.exp
}

async function refuse(peerId: string, reason: GrantRefusal): Promise<void> {
  try {
    await room?.sendGrant({ v: 1, ok: false, reason }, peerId)
  } catch {
    /* the other end is gone; its own timer will tell it so */
  }
}

/** Who we are answering. Held outside state so a re-render cannot lose it. */
let pendingPeer: string | null = null
let pendingPub: string | null = null

async function handleHello(hello: HelloMessage, peerId: string): Promise<void> {
  if (consumed) {
    await refuse(peerId, 'used')
    return
  }
  if (expired()) {
    await refuse(peerId, 'expired')
    return
  }
  // A repeat of a request already on screen is the other device retrying,
  // which is normal while the human is still reading. Answering it again would
  // replace the prompt underneath their finger.
  if (state.phase === 'asking' && pendingPub === hello.pub) return
  if (state.phase !== 'showing') {
    // A different device racing into the same rendezvous while one request is
    // already up. Refuse it outright: one code, one device.
    if (hello.pub !== pendingPub) await refuse(peerId, 'used')
    return
  }
  if (seenPubs.has(hello.pub)) return
  seenPubs.add(hello.pub)
  pendingPeer = peerId
  pendingPub = hello.pub
  set({
    phase: 'asking',
    request: {
      pub: hello.pub,
      label: hello.label || 'Another device',
      fingerprint: pairingFingerprint(live!.sid, hello.pub),
    },
  })
}

/** No. The code dies with the answer. */
export function declineRequest(): void {
  const peerId = pendingPeer
  consumed = true
  pendingPeer = null
  pendingPub = null
  set({ phase: 'declined', request: null })
  if (peerId) void refuse(peerId, 'declined')
}

/**
 * Yes. Sign the certificate, save the account's own history first, then send.
 * Saving before sending is deliberate: the device list on THIS machine must
 * never lag behind a key that is already out there, and a send that fails
 * leaves a device the human can still see and remove.
 */
export async function approveRequest(): Promise<void> {
  const req = state.request
  const peerId = pendingPeer
  if (!req || !peerId || state.phase !== 'asking') return
  if (expired()) {
    consumed = true
    set({ phase: 'expired', request: null })
    await refuse(peerId, 'expired')
    return
  }
  const signer = rootSigningKey()
  if (!signer) {
    set({ phase: 'error', error: 'This device is no longer signed in.', request: null })
    await refuse(peerId, 'failed')
    return
  }
  consumed = true
  set({ phase: 'granting' })

  let chain: Chain
  let index: number
  try {
    const own = await loadOwnChain()
    const result = certifyDevice(own, signer.rootPriv, signer.root, req.pub, req.label, Date.now())
    chain = result.chain
    index = result.index
    await keyring().saveChain(chain.root, chain)
  } catch (e) {
    set({ phase: 'error', error: errMsg(e), request: null })
    await refuse(peerId, 'failed')
    return
  }

  const account = identityOf(chain)
  if (!account) {
    set({
      phase: 'error',
      error: 'This account has no signed history to send. Sign in again and try once more.',
      request: null,
    })
    await refuse(peerId, 'failed')
    return
  }
  try {
    await room?.sendGrant(
      {
        v: 1,
        ok: true,
        root: chain.root,
        name: account.displayName,
        tag: account.tag,
        index,
        chain: chain as unknown as JsonValue,
      },
      peerId,
    )
  } catch (e) {
    set({
      phase: 'error',
      error: `That device is now on your account, but the message did not reach it (${errMsg(e)}). Remove it below and try again.`,
      request: null,
    })
    return
  }
  pendingPeer = null
  pendingPub = null
  set({ phase: 'granted', grantedLabel: req.label, request: null })
}

/**
 * The name and tag we announce alongside the history. Both are read out of the
 * history itself (the signed genesis name, the tag recomputed from the root
 * key) rather than off a stored record, because those are the two values the
 * receiving device recomputes and checks. Sending anything else would be
 * sending a claim it is right to reject.
 */
function identityOf(chain: Chain): { displayName: string; tag: string } | null {
  const g = chain.events.find((e) => e.body.lane === 'w' && e.body.type === 'genesis')
  const name = g ? (g.body.payload as { name?: unknown }).name : undefined
  if (typeof name !== 'string') return null
  try {
    return { displayName: normalizeUsername(name).display, tag: tagOf(fromB64u(chain.root)) }
  } catch {
    return null
  }
}

/** The label this device would show to the other one. */
export function ownDeviceLabel(): string {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator
  return shortDeviceLabel(nav?.userAgent ?? '')
}

// ---------------------------------------------------------------------------
// React bridge
// ---------------------------------------------------------------------------

export const offerStore = {
  getState: (): OfferState => state,
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

export function useOfferState(): OfferState {
  return useSyncExternalStore(offerStore.subscribe, offerStore.getState, offerStore.getState)
}
