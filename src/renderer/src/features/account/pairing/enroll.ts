/**
 * What actually happens to the account when a pairing is approved, on both
 * sides of the channel.
 *
 * ON THE DEVICE THAT HOLDS THE ACCOUNT: mint a root-signed certificate for the
 * public key the other device generated, append it to the account's own history
 * and verify the whole thing before saving. That is spec §1's device enrollment
 * verbatim ("enrollment is a personal-lane root-signed certificate, valid
 * offline"), and it is the same act src/web/accounts.ts already performs when a
 * recovery phrase brings the account onto a new machine. Nothing new is
 * invented here: the certificate takes the next free device slot, so the two
 * machines never share a key and either can be removed on its own.
 *
 * ON THE NEW DEVICE: check everything, then keep two things. The account's
 * verified history goes to the shared keyring exactly where a password sign-in
 * would have put it, and a small private record holds the key this device made
 * for itself. That key is a CHILD key: the root can retire it with one signed
 * event, which is precisely the property that makes it safe to keep on a device
 * you might lose. The seed and the recovery phrase are not here and never were.
 *
 * WHY THE CHILD KEY IS GENERATED RATHER THAN DERIVED. Every other device key in
 * this app comes from SLIP-0010 hardened derivation off the seed. A device that
 * is being paired has no seed, by design, so it cannot walk that tree. It does
 * not need to: §1 is explicit that child public keys are not publicly derivable
 * from a root public key and that every child is introduced by a certificate
 * instead. The certificate still carries (purpose, index), so the key sits in
 * the same place in the same scheme; only the private half was made locally and
 * has never left the device that made it.
 */

import {
  KEY_PURPOSE,
  appendEvent,
  appendPersonal,
  certSetFrom,
  ed25519,
  eventId,
  fromB64u,
  makeCertEvent,
  makeRevokeEvent,
  normalizeUsername,
  tagOf,
  toB64u,
  verifyChain,
  type CanonicalObject,
  type Chain,
  type SignedEvent,
  type StoredAccount,
} from '@shared/accounts'
import { keyring } from '../../../../../web/accounts'

// ---------------------------------------------------------------------------
// The key the new device makes for itself
// ---------------------------------------------------------------------------

export interface DeviceKey {
  priv: Uint8Array
  pub: string
}

/**
 * A fresh ed25519 keypair from the platform's CSPRNG. Any 32 random bytes is a
 * valid ed25519 secret key, so this needs no library ceremony; what it does
 * need is real randomness, and a browser without a CSPRNG gets a throw rather
 * than a guessable account key.
 */
export function newDeviceKey(): DeviceKey {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c || typeof c.getRandomValues !== 'function')
    throw new Error('this browser has no secure random number generator')
  const priv = c.getRandomValues(new Uint8Array(32))
  return { priv, pub: toB64u(ed25519.getPublicKey(priv)) }
}

// ---------------------------------------------------------------------------
// Account holder side
// ---------------------------------------------------------------------------

/** The lowest device slot this account has not certified yet. */
export function nextDeviceIndex(root: string, chain: Chain): number {
  const used = new Set(
    certSetFrom(root, chain.events)
      .filter((c) => c.purpose === KEY_PURPOSE.device)
      .map((c) => c.index),
  )
  let i = 0
  while (used.has(i)) i++
  return i
}

export interface CertifyResult {
  chain: Chain
  index: number
  certEvent: string
}

/**
 * Certify `childPub` as a device of this account. Verifies the resulting
 * history before it is handed back, so a certificate that would have broken the
 * chain never reaches storage or the other device.
 */
export function certifyDevice(
  chain: Chain,
  rootPriv: Uint8Array,
  root: string,
  childPub: string,
  label: string,
  now: number,
): CertifyResult {
  const index = nextDeviceIndex(root, chain)
  const ev = makeCertEvent(rootPriv, root, chain, {
    childPub,
    purpose: KEY_PURPOSE.device,
    index,
    label: label.slice(0, 64),
    ts: now,
  })
  const next = appendEvent(chain, ev)
  const vr = verifyChain(next)
  if (!vr.ok) throw new Error(`adding the device broke the account history: ${vr.errors[0]?.code}`)
  return { chain: next, index, certEvent: eventId(ev.body) }
}

/**
 * Retire a device key (spec §1 revocation). Signed by whoever is signing on
 * this device: the root when the account was opened with a password or phrase,
 * the certified device key when it was opened by pairing. Verified before it is
 * returned, same as the certificate above.
 */
export function revokeDevice(
  chain: Chain,
  priv: Uint8Array,
  key: string,
  pub: string,
  now: number,
): Chain {
  const ev = makeRevokeEvent(priv, key, chain, { pub, ts: now })
  const next = appendEvent(chain, ev)
  const vr = verifyChain(next)
  if (!vr.ok)
    throw new Error(`removing the device broke the account history: ${vr.errors[0]?.code}`)
  return next
}

// ---------------------------------------------------------------------------
// New device side: the record that keeps this device signed in
// ---------------------------------------------------------------------------

/**
 * Namespaced beside the keyring's own records (`acct.v1.`), because it belongs
 * to the same account storage and should be cleared by the same hands.
 */
const PAIRED_KEY = 'acct.v1.paired'

/**
 * What a paired device keeps. The private key here is a CHILD key: it signs
 * this device's own records and proves this device to the network, and the
 * account's root key can retire it at any moment from the device that holds the
 * root. It is not the account. The seed is not in this record and cannot be
 * reconstructed from it.
 */
export interface PairedRecord {
  v: 1
  root: string
  foldedName: string
  displayName: string
  tag: string
  deviceIndex: number
  devicePub: string
  devicePrivB64u: string
  certEvent: string
  pairedAt: number
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    // Storage access can throw outright in a locked-down context.
    return null
  }
}

/** The stored record, or null. A damaged record reads as no record. */
export function loadPairedRecord(): PairedRecord | null {
  const s = storage()
  if (!s) return null
  let raw: string | null
  try {
    raw = s.getItem(PAIRED_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const r = JSON.parse(raw) as Partial<PairedRecord>
    if (r.v !== 1) return null
    for (const k of ['root', 'foldedName', 'displayName', 'tag', 'devicePub', 'devicePrivB64u', 'certEvent'] as const)
      if (typeof r[k] !== 'string') return null
    if (typeof r.deviceIndex !== 'number' || typeof r.pairedAt !== 'number') return null
    return r as PairedRecord
  } catch {
    return null
  }
}

function savePairedRecord(r: PairedRecord): void {
  const s = storage()
  if (!s) throw new Error('this browser will not let nodechess remember anything on this device')
  s.setItem(PAIRED_KEY, JSON.stringify(r))
}

/** Forget the paired device. The account history stays: signing out has never
 *  destroyed the self-carried file, and this is a sign-out. */
export function clearPairedRecord(): void {
  const s = storage()
  if (!s) return
  try {
    s.removeItem(PAIRED_KEY)
  } catch {
    /* nothing to do and nothing to say: the session is ending regardless */
  }
}

/** The paired device's signing material, or null when nothing is paired. */
export function pairedSigningKey(): { root: string; key: string; priv: Uint8Array } | null {
  const r = loadPairedRecord()
  if (!r) return null
  try {
    const priv = fromB64u(r.devicePrivB64u)
    // Fail closed on a record whose halves disagree rather than handing back a
    // key that could never verify.
    if (toB64u(ed25519.getPublicKey(priv)) !== r.devicePub) return null
    return { root: r.root, key: r.devicePub, priv }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// New device side: accepting what arrived
// ---------------------------------------------------------------------------

export type AdoptProblem =
  | 'not-an-account'
  | 'unverified'
  | 'wrong-account'
  | 'not-certified'
  | 'revoked'
  | 'storage'

export function adoptProblemMessage(problem: AdoptProblem): string {
  switch (problem) {
    case 'not-an-account':
      return 'What arrived from your other device is not a nodechess account. Nothing was signed in.'
    case 'unverified':
      return 'The account history that arrived does not check out, so this device was not signed in. Try again from your other device.'
    case 'wrong-account':
      return 'The account that arrived does not match what your other device said it was sending. Nothing was signed in.'
    case 'not-certified':
      return 'Your other device did not finish approving this one. Nothing was signed in.'
    case 'revoked':
      return 'This device was removed from the account before it finished signing in.'
    case 'storage':
      return 'This browser will not let nodechess store anything, so it cannot stay signed in. Private windows often block this.'
  }
}

export class AdoptError extends Error {
  constructor(readonly problem: AdoptProblem) {
    super(adoptProblemMessage(problem))
    this.name = 'AdoptError'
  }
}

/** The chain as it arrives over the channel: opaque until it verifies. */
function asChain(value: unknown): Chain | null {
  if (typeof value !== 'object' || value === null) return null
  const c = value as { root?: unknown; events?: unknown }
  if (typeof c.root !== 'string' || !Array.isArray(c.events)) return null
  return { root: c.root, events: c.events as SignedEvent[] }
}

/** Was `pub` retired somewhere in this history? */
function isRevoked(chain: Chain, pub: string): boolean {
  for (const ev of chain.events) {
    if (ev.body.type !== 'revoke') continue
    if ((ev.body.payload as { pub?: unknown }).pub === pub) return true
  }
  return false
}

/** The genesis-signed display name, which is the ONLY name worth believing. */
function genesisNameOf(chain: Chain): string | null {
  const g = chain.events.find((e) => e.body.lane === 'w' && e.body.type === 'genesis')
  const n = g ? (g.body.payload as { name?: unknown }).name : undefined
  return typeof n === 'string' ? n : null
}

export interface AdoptedAccount {
  record: PairedRecord
  chain: Chain
}

export interface AdoptInput {
  chain: unknown
  root: string
  name: string
  tag: string
  index: number
  device: DeviceKey
  now: number
}

/**
 * Take what the account holder sent and turn it into a signed-in device, or
 * refuse. Every check below is a reason to refuse, in the order that costs
 * least: shape, then the account's own verification from genesis, then that the
 * names and tag are the ones the signed history actually carries rather than
 * the ones the sender claimed, then that this device's key is certified in it
 * and has not already been retired.
 *
 * The tag is recomputed from the root key, not read off the message. A sender
 * who could pick the tag could dress one account up as another in the picker.
 */
export async function adoptGrant(input: AdoptInput): Promise<AdoptedAccount> {
  const chain = asChain(input.chain)
  if (!chain) throw new AdoptError('not-an-account')
  if (chain.root !== input.root) throw new AdoptError('wrong-account')
  if (!verifyChain(chain).ok) throw new AdoptError('unverified')

  const signedName = genesisNameOf(chain)
  if (signedName === null) throw new AdoptError('not-an-account')
  const norm = normalizeUsername(signedName)
  if (norm.display !== input.name) throw new AdoptError('wrong-account')

  let tag: string
  try {
    tag = tagOf(fromB64u(chain.root))
  } catch {
    throw new AdoptError('not-an-account')
  }
  if (tag !== input.tag) throw new AdoptError('wrong-account')

  const cert = certSetFrom(chain.root, chain.events).find((c) => c.pub === input.device.pub)
  if (!cert || cert.purpose !== KEY_PURPOSE.device) throw new AdoptError('not-certified')
  if (isRevoked(chain, input.device.pub)) throw new AdoptError('revoked')

  const account: StoredAccount = {
    v: 1,
    foldedName: norm.folded,
    displayName: norm.display,
    tag,
    rootPub: chain.root,
    device: { index: cert.index, pub: input.device.pub, certEvent: cert.certId },
  }
  const record: PairedRecord = {
    v: 1,
    root: chain.root,
    foldedName: norm.folded,
    displayName: norm.display,
    tag,
    deviceIndex: cert.index,
    devicePub: input.device.pub,
    devicePrivB64u: toB64u(input.device.priv),
    certEvent: cert.certId,
    pairedAt: input.now,
  }

  // History first, then the keyring record, then the key this device signs
  // with: the same ordering src/web/accounts.ts uses, for the same reason. A
  // half-written pairing must leave the account retryable rather than leaving
  // a device that believes it is signed in to a history it does not have.
  try {
    await keyring().saveChain(chain.root, chain)
    await keyring().saveAccount(account)
  } catch {
    throw new AdoptError('storage')
  }
  try {
    savePairedRecord(record)
  } catch {
    throw new AdoptError('storage')
  }
  return { record, chain }
}

/**
 * Bring a previously paired device back at boot. Fail-closed at every step, the
 * same rule resumeSession follows: a record whose key halves disagree, whose
 * history is missing, does not verify, or no longer certifies this device is
 * simply not a session. Such a record is cleared, because a device that has
 * been removed from the account should say so by being signed out.
 */
export async function resumePaired(): Promise<AdoptedAccount | null> {
  const record = loadPairedRecord()
  if (!record) return null
  const signing = pairedSigningKey()
  if (!signing) {
    clearPairedRecord()
    return null
  }
  let chain: Chain | null = null
  try {
    chain = await keyring().loadChain(record.root)
  } catch {
    return null // storage hiccup: keep the record, try again next boot
  }
  if (!chain || chain.root !== record.root) return null
  if (!verifyChain(chain).ok) return null
  const cert = certSetFrom(chain.root, chain.events).find((c) => c.pub === record.devicePub)
  if (!cert || isRevoked(chain, record.devicePub)) {
    clearPairedRecord()
    return null
  }
  return { record, chain }
}

/**
 * Append a signed personal-lane record with this device's certified key. The
 * paired device's own edit path: it cannot sign as the root, and does not need
 * to, because the certificate is exactly what lets its own key speak for the
 * account on the personal lane (§2).
 */
export async function appendPairedPersonal(
  type: 'profile',
  payload: CanonicalObject,
  now: number,
): Promise<Chain> {
  const signing = pairedSigningKey()
  if (!signing) throw new Error('this device is not signed in')
  const chain = await keyring().loadChain(signing.root)
  if (!chain) throw new Error('the account history is not on this device')
  const next = appendPersonal(chain, signing.priv, signing.key, type, payload, now)
  const vr = verifyChain(next)
  if (!vr.ok) throw new Error(`that change did not verify: ${vr.errors[0]?.code}`)
  await keyring().saveChain(next.root, next)
  return next
}
