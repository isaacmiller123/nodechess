// Fork proofs (spec §2/§4): two distinct signed witnessed-lane bodies by one
// root sharing one prev are self-authenticating fraud. A proof carries the
// two events plus the root-signed certs proving each signing key belongs to
// the root: verifiable by anyone, with no context beyond the proof itself.
//
// Platform-neutral: no `node:` imports, no DOM globals.

import { isRootSignedCert } from './certs'
import { eventId, verifyEventSig } from './events'
import type { B64u, ForkProof, SignedEvent } from './types'

/**
 * Is `key` provably the root's? Either it IS the root, or one of `certs` is
 * a valid root-signed certificate for it. Returns the proving cert event,
 * 'root', or null.
 */
function keyProven(root: B64u, key: B64u, certs: readonly SignedEvent[]): SignedEvent | 'root' | null {
  if (key === root) return 'root'
  for (const c of certs) {
    const info = isRootSignedCert(root, c)
    if (info && info.pub === key) return c
  }
  return null
}

/**
 * Detect a witnessed-lane fork between two events: same root, lane 'w',
 * same prev (including both-absent, the genesis case), different ids, both
 * signatures valid, both signing keys proven root-or-certified via `certs`.
 * Returns a self-contained ForkProof (carrying only the certs it needs),
 * or null. Never throws.
 */
export function detectFork(a: SignedEvent, b: SignedEvent, certs: readonly SignedEvent[]): ForkProof | null {
  try {
    if (a.body.root !== b.body.root) return null
    if (a.body.lane !== 'w' || b.body.lane !== 'w') return null
    if ((a.body.prev ?? '') !== (b.body.prev ?? '')) return null
    if (eventId(a.body) === eventId(b.body)) return null
    if (!verifyEventSig(a) || !verifyEventSig(b)) return null
    const root = a.body.root
    const provenA = keyProven(root, a.body.key, certs)
    const provenB = keyProven(root, b.body.key, certs)
    if (!provenA || !provenB) return null
    const proofCerts: SignedEvent[] = []
    if (provenA !== 'root') proofCerts.push(provenA)
    if (provenB !== 'root' && provenB !== provenA) proofCerts.push(provenB)
    return { root, a, b, certs: proofCerts }
  } catch {
    return null
  }
}

/** Context-free re-verification of a ForkProof. Never throws. */
export function verifyForkProof(p: ForkProof): boolean {
  try {
    const { root, a, b } = p
    if (a.body.root !== root || b.body.root !== root) return false
    if (a.body.lane !== 'w' || b.body.lane !== 'w') return false
    if ((a.body.prev ?? '') !== (b.body.prev ?? '')) return false
    if (eventId(a.body) === eventId(b.body)) return false
    if (!verifyEventSig(a) || !verifyEventSig(b)) return false
    if (!keyProven(root, a.body.key, p.certs) || !keyProven(root, b.body.key, p.certs)) return false
    return true
  } catch {
    return false
  }
}
