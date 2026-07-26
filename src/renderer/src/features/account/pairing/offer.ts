/**
 * The pairing offer: exactly what a sign-in QR code carries, and nothing else.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. A code on a screen is readable by any
 * camera in the room, by a screenshot, by a photo posted later. So the code
 * carries NO key material of any kind: no seed, no recovery phrase, no root
 * private key, not even the account's public identity. It carries a rendezvous
 * (where to meet) and a shared channel secret (how to speak privately there),
 * both random, both short lived, both single use.
 *
 * Reading the code buys an attacker one thing: the ability to walk up to the
 * meeting point and ask. Asking is not getting. The account holder still has to
 * look at a name and a fingerprint and say yes, and that human check is what
 * this whole feature rests on (spec §1: enrollment is a ROOT-SIGNED
 * certificate, minted by the device that holds the root key, for a public key
 * the other device generated and never sent anywhere else).
 *
 * Platform-neutral: no DOM, no clock. The caller passes `now` so the whole
 * module is testable and so expiry is decided at one seam.
 */

import { fromB64u, sha256, toB64u, toBase32, utf8 } from '@shared/accounts'

/** Kind tag. Present so a scanner that meets a Wi-Fi or URL QR code can say
 *  "that is not a sign-in code" instead of failing with a parse error. */
export const OFFER_KIND = 'nodechess-pair'

/** Payload version. A future shape bumps this and old clients fail closed. */
export const OFFER_VERSION = 1

/**
 * How long an offer lives. Short on purpose: the two devices are in the same
 * room and the human is looking at both of them, so three minutes is generous
 * for the flow and mean for a photograph passed on later.
 */
export const OFFER_TTL_MS = 3 * 60 * 1000

/** Bytes of rendezvous id and of channel secret. 16 and 32 from the CSPRNG. */
const SID_BYTES = 16
const SECRET_BYTES = 32

/** The offer as it lives in memory on both devices. */
export interface PairingOffer {
  /** Rendezvous id. Public by construction (it IS the meeting point). */
  sid: string
  /** Channel secret. Encrypts the rendezvous handshake between the two. */
  secret: string
  /** Absolute expiry, from the clock of the device that minted the offer. */
  exp: number
}

/** The wire form: what gets drawn as modules. Keys are one letter to keep the
 *  code small enough to scan comfortably from a phone screen at arm's length. */
interface OfferWire {
  v: number
  k: string
  sid: string
  s: string
  exp: number
}

/** Cryptographically random bytes, or a throw. Never a Math.random fallback:
 *  a predictable channel secret is a silently broken channel. */
function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c || typeof c.getRandomValues !== 'function')
    throw new Error('this browser has no secure random number generator')
  return c.getRandomValues(new Uint8Array(n))
}

/** Mint a fresh single-use offer. `now` is the minting device's clock. */
export function mintOffer(now: number, ttlMs: number = OFFER_TTL_MS): PairingOffer {
  return {
    sid: toB64u(randomBytes(SID_BYTES)),
    secret: toB64u(randomBytes(SECRET_BYTES)),
    exp: now + ttlMs,
  }
}

/** The exact text the QR encodes (and the text the paste fallback accepts). */
export function encodeOffer(offer: PairingOffer): string {
  const wire: OfferWire = {
    v: OFFER_VERSION,
    k: OFFER_KIND,
    sid: offer.sid,
    s: offer.secret,
    exp: offer.exp,
  }
  return JSON.stringify(wire)
}

export type OfferProblem = 'not-a-code' | 'wrong-version' | 'malformed' | 'expired'

export type OfferParse =
  | { ok: true; offer: PairingOffer }
  | { ok: false; problem: OfferProblem }

/** Player-facing sentence for each way a scanned code can fail. No mechanism. */
export function offerProblemMessage(problem: OfferProblem): string {
  switch (problem) {
    case 'not-a-code':
      return 'That is a QR code, but not a nodechess sign-in code. On your other device, open Account and choose Add a device.'
    case 'wrong-version':
      return 'That sign-in code was made by a different version of nodechess. Update both devices and try again.'
    case 'malformed':
      return 'That sign-in code is damaged. Show a fresh one on your other device.'
    case 'expired':
      return 'That sign-in code has expired. Show a fresh one on your other device and scan again.'
  }
}

function isB64uOfLength(s: unknown, bytes: number): s is string {
  if (typeof s !== 'string' || s.length === 0) return false
  try {
    return fromB64u(s).length === bytes
  } catch {
    return false
  }
}

/**
 * Parse and validate scanned text. FAIL CLOSED at every step: anything that is
 * not exactly a live, well-formed offer comes back as a problem with a sentence
 * attached, never as a half-usable offer. Expiry is checked here against the
 * SCANNING device's clock; the offering device checks it again against its own,
 * which is the authoritative one because it minted the number.
 */
export function parseOffer(text: string, now: number): OfferParse {
  let raw: unknown
  try {
    raw = JSON.parse(text.trim())
  } catch {
    return { ok: false, problem: 'not-a-code' }
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, problem: 'not-a-code' }
  const w = raw as Partial<OfferWire>
  if (w.k !== OFFER_KIND) return { ok: false, problem: 'not-a-code' }
  if (w.v !== OFFER_VERSION) return { ok: false, problem: 'wrong-version' }
  if (!isB64uOfLength(w.sid, SID_BYTES)) return { ok: false, problem: 'malformed' }
  if (!isB64uOfLength(w.s, SECRET_BYTES)) return { ok: false, problem: 'malformed' }
  if (typeof w.exp !== 'number' || !Number.isFinite(w.exp)) return { ok: false, problem: 'malformed' }
  if (w.exp <= now) return { ok: false, problem: 'expired' }
  return { ok: true, offer: { sid: w.sid, secret: w.s, exp: w.exp } }
}

/**
 * The eight characters both devices show so the human can tell whether the two
 * screens are talking to each other. Derived from the rendezvous AND the key
 * being enrolled, so it is specific to this one pairing: a code photographed
 * and replayed at a different rendezvous cannot reproduce it, and a second
 * device racing into the same rendezvous produces a visibly different one.
 *
 * Crockford-free plain base32, grouped 4 and 4, because it is read aloud off
 * one screen and compared against another.
 */
export function pairingFingerprint(sid: string, devicePub: string): string {
  const digest = sha256(utf8(`nodechess-pair-fp:v1|${sid}|${devicePub}`))
  const chars = toBase32(digest).slice(0, 8).toUpperCase()
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

/** Seconds left on an offer, floored at zero. For the countdown. */
export function secondsLeft(offer: PairingOffer, now: number): number {
  return Math.max(0, Math.ceil((offer.exp - now) / 1000))
}

/** "2:41" / "0:09". The countdown next to a live code. */
export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
