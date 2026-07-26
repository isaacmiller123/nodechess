/**
 * The new device's side of a pairing: point a camera at a code, ask, wait for a
 * human on the other device to say yes, and become signed in.
 *
 * WHAT THIS DEVICE SENDS IS A PUBLIC KEY. It makes a fresh keypair the moment a
 * code is read, keeps the private half, and puts only the public half on the
 * channel. Nothing it sends could sign anything, and nothing it receives is
 * believed until it verifies from the account's own genesis (enroll.ts,
 * adoptGrant). The failure of every check is a refusal with a sentence, never a
 * partial sign-in.
 *
 * THE FINGERPRINT ON SCREEN IS FOR THE HUMAN. Eight characters derived from the
 * rendezvous and the key being offered, shown here while the other device shows
 * the same eight. Two screens that disagree mean the code was scanned by
 * something else, and the answer is no.
 *
 * The camera is released on every exit: success, failure, cancel, unmount.
 */

import { useSyncExternalStore } from 'react'
import { shortDeviceLabel } from '../../../../../web/accounts'
import {
  adoptGrant,
  newDeviceKey,
  type AdoptedAccount,
  type DeviceKey,
} from './enroll'
import {
  offerProblemMessage,
  pairingFingerprint,
  parseOffer,
  type PairingOffer,
} from './offer'
import {
  cameraProblemMessage,
  startScanner,
  type CameraProblem,
  type ScannerHandle,
} from './scanner'
import { joinPairingRoom, refusalMessage, type PairingRoom } from './transport'

export type ClaimPhase =
  | 'idle'
  /** The camera is opening or running. */
  | 'scanning'
  /** A code was read; reaching the other device. */
  | 'connecting'
  /** The request is delivered; the other device's human is deciding. */
  | 'waiting'
  /** Checking and storing what arrived. */
  | 'installing'
  /** Signed in. */
  | 'done'
  /** Stopped, with a sentence. */
  | 'failed'

export interface ClaimState {
  phase: ClaimPhase
  /** True once frames are arriving, so the UI can stop saying "starting". */
  cameraLive: boolean
  /** The eight characters to compare against the other device's screen. */
  fingerprint: string | null
  /** Signed-in handle, once done. */
  handle: string | null
  error: string | null
  /** Set when the other device is taking a while to answer. */
  slow: boolean
  secondsLeft: number
}

const EMPTY: ClaimState = {
  phase: 'idle',
  cameraLive: false,
  fingerprint: null,
  handle: null,
  error: null,
  slow: false,
  secondsLeft: 0,
}

let state: ClaimState = EMPTY
const listeners = new Set<() => void>()

function set(patch: Partial<ClaimState>): void {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

// ---------------------------------------------------------------------------
// Live session
// ---------------------------------------------------------------------------

let scanner: ScannerHandle | null = null
let room: PairingRoom | null = null
let offer: PairingOffer | null = null
let deviceKey: DeviceKey | null = null
let helloTimer: number | null = null
let countdown: number | null = null
let settled = false

/**
 * Where a completed pairing goes. Registered by the accounts UI store so this
 * module never has to import it back (the same injection shape the accounts
 * layer uses for its other cross-layer seams).
 */
type AdoptionSink = (adopted: AdoptedAccount) => Promise<void> | void
let adoptionSink: AdoptionSink | null = null

export function setAdoptionSink(fn: AdoptionSink | null): void {
  adoptionSink = fn
}

function stopTimers(): void {
  if (helloTimer !== null) {
    window.clearInterval(helloTimer)
    helloTimer = null
  }
  if (countdown !== null) {
    window.clearInterval(countdown)
    countdown = null
  }
}

function releaseCamera(): void {
  scanner?.stop()
  scanner = null
}

async function leaveRoom(): Promise<void> {
  const r = room
  room = null
  if (!r) return
  try {
    await r.leave()
  } catch {
    /* nothing depends on a clean close here */
  }
}

/** Stop everything. Called on cancel, on failure, on success and on unmount. */
export function endClaim(): void {
  settled = false
  stopTimers()
  releaseCamera()
  void leaveRoom()
  offer = null
  // The private key of a pairing that never completed has no further use, and
  // holding it after the flow ends is holding key material for nothing.
  deviceKey = null
  set(EMPTY)
}

function fail(message: string): void {
  if (settled) return
  settled = true
  stopTimers()
  releaseCamera()
  void leaveRoom()
  offer = null
  deviceKey = null
  set({ phase: 'failed', error: message, cameraLive: false, slow: false })
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Open the camera and read until a code appears. */
export function startScan(video: HTMLVideoElement): void {
  endClaim()
  set({ phase: 'scanning', cameraLive: false, error: null })
  scanner = startScanner({
    video,
    onLive: () => {
      if (state.phase === 'scanning') set({ cameraLive: true })
    },
    onProblem: (problem: CameraProblem) => fail(cameraProblemMessage(problem)),
    onText: (text) => {
      // One code is all we want. Release the camera before doing anything else
      // so the light goes out the moment the scan lands.
      releaseCamera()
      submitCode(text)
    },
  })
}

/** Stop the camera without ending a pairing already in flight. */
export function stopCamera(): void {
  releaseCamera()
  if (state.phase === 'scanning') set({ phase: 'idle', cameraLive: false })
}

// ---------------------------------------------------------------------------
// Using a code, however it arrived (camera or paste)
// ---------------------------------------------------------------------------

export function submitCode(text: string): void {
  const parsed = parseOffer(text, Date.now())
  if (!parsed.ok) {
    fail(offerProblemMessage(parsed.problem))
    return
  }
  settled = false
  offer = parsed.offer
  let key: DeviceKey
  try {
    key = newDeviceKey()
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return
  }
  deviceKey = key
  set({
    phase: 'connecting',
    cameraLive: false,
    fingerprint: pairingFingerprint(parsed.offer.sid, key.pub),
    error: null,
    slow: false,
    secondsLeft: Math.max(0, Math.ceil((parsed.offer.exp - Date.now()) / 1000)),
  })

  const label = shortDeviceLabel(
    (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '',
  )
  const hello = { v: 1 as const, pub: key.pub, label }

  try {
    room = joinPairingRoom(parsed.offer, {
      onPeerJoin: () => {
        void room?.sendHello(hello)
        if (state.phase === 'connecting') set({ phase: 'waiting' })
      },
      onGrant: (grant) => {
        if (settled) return
        if (!grant.ok) {
          fail(refusalMessage(grant.reason))
          return
        }
        void install(grant)
      },
      onJoinError: (detail) =>
        fail(
          `Could not reach your other device (${detail}). Check that both devices are online, then scan again.`,
        ),
    })
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return
  }

  // Retry the hello while we wait. The other device may still be registering
  // its side of the channel when we first arrive, and a lost hello would
  // otherwise leave both screens waiting on each other.
  helloTimer = window.setInterval(() => {
    if (settled || state.phase === 'installing' || state.phase === 'done') return
    void room?.sendHello(hello)
  }, 2000)

  // The scanning device enforces the same expiry the offering device does. Its
  // clock is not the authority (the offering device minted the number and
  // refuses on its own timer), but a code that has already run out should stop
  // this side too rather than leave a screen waiting on an answer that is never
  // coming.
  countdown = window.setInterval(() => {
    if (!offer || settled) return
    const left = Math.max(0, Math.ceil((offer.exp - Date.now()) / 1000))
    if (left !== state.secondsLeft) set({ secondsLeft: left })
    if (left === 0) fail(offerProblemMessage('expired'))
  }, 250)

  // "Taking a while" is a separate, gentler signal than failure.
  window.setTimeout(() => {
    if (!settled && (state.phase === 'connecting' || state.phase === 'waiting')) set({ slow: true })
  }, 20_000)
}

async function install(grant: {
  root: string
  name: string
  tag: string
  index: number
  chain: unknown
}): Promise<void> {
  if (settled || !deviceKey) return
  settled = true
  stopTimers()
  set({ phase: 'installing' })
  try {
    const adopted = await adoptGrant({
      chain: grant.chain,
      root: grant.root,
      name: grant.name,
      tag: grant.tag,
      index: grant.index,
      device: deviceKey,
      now: Date.now(),
    })
    await adoptionSink?.(adopted)
    set({
      phase: 'done',
      handle: `${adopted.record.displayName}#${adopted.record.tag}`,
      error: null,
    })
  } catch (e) {
    settled = true
    set({
      phase: 'failed',
      error: e instanceof Error ? e.message : String(e),
      cameraLive: false,
    })
  } finally {
    deviceKey = null
    releaseCamera()
    void leaveRoom()
  }
}

// ---------------------------------------------------------------------------
// React bridge
// ---------------------------------------------------------------------------

export const claimStore = {
  getState: (): ClaimState => state,
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

export function useClaimState(): ClaimState {
  return useSyncExternalStore(claimStore.subscribe, claimStore.getState, claimStore.getState)
}
