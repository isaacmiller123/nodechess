// Display identity, name#TAG (spec §1). TAG is self-derived from the root
// pubkey fingerprint: no registry, no squatting; collisions disambiguate by
// tag. Platform-neutral, deterministic.
import { sha256, toBase32 } from './hash'
import { NAME_MAX, NAME_MIN, TAG_LEN } from './types'

/** First TAG_LEN chars of base32(sha256(rootPub)), uppercase (e.g. 'K7Q2M'). */
export function tagOf(rootPub: Uint8Array): string {
  return toBase32(sha256(rootPub)).slice(0, TAG_LEN).toUpperCase()
}

/** 'isaac' + 'K7Q2M' → 'isaac#K7Q2M'. */
export function formatHandle(name: string, tag: string): string {
  return `${name}#${tag}`
}

/** RFC 4648 base32 alphabet (what toBase32 emits), TAG_LEN chars, any case in. */
const TAG_RE = new RegExp(`^[A-Za-z2-7]{${TAG_LEN}}$`)

/**
 * Parse 'name#TAG' → { name, tag } (tag canonicalized to uppercase), or null
 * if the shape is invalid: not exactly one '#', name outside 3–24 chars, or
 * tag not TAG_LEN base32 chars. The name is NOT normalized here. Callers
 * feed it to normalizeUsername when they need the folded form.
 */
export function parseHandle(s: string): { name: string; tag: string } | null {
  const i = s.indexOf('#')
  if (i < 0 || s.indexOf('#', i + 1) !== -1) return null
  const name = s.slice(0, i)
  const tag = s.slice(i + 1)
  if (name.length < NAME_MIN || name.length > NAME_MAX) return null
  if (!TAG_RE.test(tag)) return null
  return { name, tag: tag.toUpperCase() }
}
