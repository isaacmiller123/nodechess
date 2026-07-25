// Identity derivation (spec §1, params: docs/ACCOUNTS-PARAMS.md).
//   password + username → argon2id seed → SLIP-0010 ed25519 root + hardened children.
// Everything here is deterministic and platform-neutral: no `node:` imports,
// no DOM globals, no clocks, no randomness. All parameters come from PARAMS_V1
// (FROZEN-AT-GENESIS): never re-literal them.
import { argon2id } from 'hash-wasm'
import { concatBytes, ed25519, hmacSha512, sha256, utf8 } from './hash'
import { PARAMS_V1 } from './params'
import { tagOf } from './identity'
import { NAME_MAX, NAME_MIN, type Identity, type KeyPurpose, type NormalizedName } from './types'

// ---------------------------------------------------------------------------
// Username normalization (FROZEN-AT-GENESIS: nfkc-trim-casefold-v1)
// ---------------------------------------------------------------------------

export type NameErrorReason =
  | 'empty' // nothing left after normalization/strip/trim
  | 'too-short' // folded form < NAME_MIN chars
  | 'too-long' // folded form > NAME_MAX chars
  | 'hash-char' // '#' anywhere: it delimits the tag in name#TAG
  | 'not-printable' // control/format/line-sep chars survive the strip

export class NameError extends Error {
  constructor(
    readonly reason: NameErrorReason,
    message: string,
  ) {
    super(`invalid username: ${message}`)
    this.name = 'NameError'
  }
}

/** Zero-width chars stripped before validation (U+200B..U+200D, U+FEFF). */
const ZERO_WIDTH_RE = /[\u200b-\u200d\ufeff]/g
/** C0 + DEL + C1 control chars, stripped before validation. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
/** Anything non-printable that survives the strip is rejected (Cc/Cf/Zl/Zp),
 * plus lone surrogates (Cs): TextEncoder would silently substitute U+FFFD,
 * letting distinct names collide onto one salt. */
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u

/**
 * NFKC → strip zero-width + control chars → trim → validate 3–24 printable
 * chars, no '#'. `display` keeps the user's casing; `folded` is the
 * case-folded form that feeds salt derivation. Throws NameError.
 */
export function normalizeUsername(raw: string): NormalizedName {
  const display = raw
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .trim()
  if (display.length === 0) throw new NameError('empty', 'empty after normalization')
  if (display.includes('#')) throw new NameError('hash-char', "'#' is reserved for the tag")
  if (NON_PRINTABLE_RE.test(display))
    throw new NameError('not-printable', 'contains non-printable characters')
  const folded = display.toLowerCase()
  // Both forms must satisfy the 3-24 bound: the genesis payload schema (zName)
  // validates the DISPLAY form, and case-folding can change length (İ → i̇),
  // so checking only one form lets accounts derive keys but fail chain creation.
  if (display.length < NAME_MIN || folded.length < NAME_MIN)
    throw new NameError('too-short', `must be at least ${NAME_MIN} characters`)
  if (display.length > NAME_MAX || folded.length > NAME_MAX)
    throw new NameError('too-long', `must be at most ${NAME_MAX} characters`)
  return { folded, display }
}

// ---------------------------------------------------------------------------
// Seed derivation (argon2id, FROZEN-AT-GENESIS params)
// ---------------------------------------------------------------------------

/**
 * argon2id(password, salt = sha256(utf8(foldedUsername))) → 32-byte seed.
 * Accepts a raw or normalized name; normalization is applied here so every
 * caller derives identical bytes for 'Isaac' / 'isaac' / 'ＩSAAC'.
 *
 * The password is NFKD-normalized (PARAMS_V1.pwNorm, FROZEN-AT-GENESIS; the
 * BIP39 precedent): visually identical passwords typed through NFC- vs
 * NFD-emitting input pipelines must derive the same key, because with no
 * recovery (C-5) a mismatch is silent permanent lockout.
 */
export async function deriveSeed(name: string | NormalizedName, password: string): Promise<Uint8Array> {
  const folded = typeof name === 'string' ? normalizeUsername(name).folded : name.folded
  const a = PARAMS_V1.argon2
  return argon2id({
    password: password.normalize('NFKD'),
    salt: sha256(utf8(folded)),
    memorySize: a.memKib,
    iterations: a.iters,
    parallelism: a.parallelism,
    hashLength: a.outLen,
    outputType: 'binary',
  })
}

// ---------------------------------------------------------------------------
// SLIP-0010 ed25519 (hardened-only: ed25519 has no public derivation)
// ---------------------------------------------------------------------------

export interface Slip10Node {
  priv: Uint8Array // 32 bytes (IL)
  chainCode: Uint8Array // 32 bytes (IR)
}

const HARDENED = 0x80000000

/** ser32(index), 4-byte big-endian. */
function ser32(index: number): Uint8Array {
  const out = new Uint8Array(4)
  out[0] = (index >>> 24) & 0xff
  out[1] = (index >>> 16) & 0xff
  out[2] = (index >>> 8) & 0xff
  out[3] = index & 0xff
  return out
}

/** Master node: I = HMAC-SHA512(key = 'ed25519 seed', data = seed). */
export function slip10Master(seed: Uint8Array): Slip10Node {
  const i = hmacSha512(utf8('ed25519 seed'), seed)
  return { priv: i.slice(0, 32), chainCode: i.slice(32) }
}

/**
 * Hardened child: I = HMAC-SHA512(chainCode, 0x00 || priv || ser32(index + 2^31)).
 * `index` is the plain (unhardened) index; hardening is applied here.
 */
export function slip10Child(node: Slip10Node, index: number): Slip10Node {
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED)
    throw new RangeError(`slip10 child index out of range: ${index}`)
  const data = concatBytes(new Uint8Array([0]), node.priv, ser32(index + HARDENED))
  const i = hmacSha512(node.chainCode, data)
  return { priv: i.slice(0, 32), chainCode: i.slice(32) }
}

/** Child keypair at path m/purpose'/index'. */
export function deriveChild(
  seed: Uint8Array,
  purpose: KeyPurpose,
  index: number,
): { priv: Uint8Array; pub: Uint8Array } {
  const node = slip10Child(slip10Child(slip10Master(seed), purpose), index)
  return { priv: node.priv, pub: ed25519.getPublicKey(node.priv) }
}

// ---------------------------------------------------------------------------
// Full identity
// ---------------------------------------------------------------------------

/** name + password → seed → SLIP-0010 master → root keypair + tag. */
export async function deriveIdentity(name: string, password: string): Promise<Identity> {
  const norm = normalizeUsername(name)
  const seed = await deriveSeed(norm, password)
  const master = slip10Master(seed)
  const rootPriv = master.priv
  const rootPub = ed25519.getPublicKey(rootPriv)
  return {
    seed,
    rootPriv,
    rootPub,
    tag: tagOf(rootPub),
    foldedName: norm.folded,
    displayName: norm.display,
  }
}
