// Accounts crypto primitives: the ONE place ed25519/sha are wired.
// Everything here must behave bit-identically in node, the desktop renderer,
// the web bundle, and workers. No `node:` imports, no DOM globals.
import * as ed from '@noble/ed25519'
import { hashes } from '@noble/ed25519'
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { base32, base64urlnopad } from '@scure/base'

// @noble/ed25519 v3 sync API needs sha512 wired once, before first use.
hashes.sha512 = nobleSha512

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data)
export const sha512 = (data: Uint8Array): Uint8Array => nobleSha512(data)
export const hmacSha512 = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  hmac(nobleSha512, key, data)

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// Bytes-in-JSON convention: base64url, no padding (RFC 4648 §5).
export const toB64u = (b: Uint8Array): string => base64urlnopad.encode(b)
export const fromB64u = (s: string): Uint8Array => base64urlnopad.decode(s)

// TAG alphabet: RFC 4648 base32, uppercase, unpadded.
export const toBase32 = (b: Uint8Array): string => base32.encode(b).replace(/=+$/, '')

export const ed25519 = {
  getPublicKey: (priv: Uint8Array): Uint8Array => ed.getPublicKey(priv),
  sign: (msg: Uint8Array, priv: Uint8Array): Uint8Array => ed.sign(msg, priv),
  verify: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean => {
    try {
      return ed.verify(sig, msg, pub)
    } catch {
      return false
    }
  },
}

/** Detached ed25519 verify over base64url-encoded signature + pubkey; never
 * throws (a bad encoding or bad signature returns false). One place for the
 * b64u decode + verify the fabric and chain repeat everywhere a signature is
 * carried as base64url strings. */
export function verifySigB64u(sig: string, msg: Uint8Array, pub: string): boolean {
  try {
    return ed25519.verify(fromB64u(sig), msg, fromB64u(pub))
  } catch {
    return false
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}
