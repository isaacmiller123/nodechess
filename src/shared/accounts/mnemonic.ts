// Mnemonic + keyfile export: the lifeline (spec §1 recovery = none by
// design, C-5; params: BIP39 24 words encoding the 32-byte argon2id seed).
//
// NOTE this is entropyToMnemonic/mnemonicToEntropy, a bit-exact encoding of
// the seed itself. It is NOT bip39's PBKDF2 seed stretch (mnemonicToSeed):
// the argon2 seed goes in verbatim and comes back verbatim.
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { z } from 'zod'
import { fromB64u, toB64u } from './hash'
import { TAG_LEN, type Identity, type Keyfile } from './types'

const SEED_LEN = 32

function assertSeedLen(seed: Uint8Array, what: string): void {
  if (seed.length !== SEED_LEN) throw new Error(`${what}: expected ${SEED_LEN} bytes, got ${seed.length}`)
}

/** 32-byte seed → 24 english words (BIP39 entropy encoding, checksummed). */
export function seedToMnemonic(seed: Uint8Array): string {
  assertSeedLen(seed, 'seedToMnemonic')
  return entropyToMnemonic(seed, wordlist)
}

/** 24 words → the exact 32-byte seed. Throws on bad words/checksum/length. */
export function mnemonicToSeed(words: string): Uint8Array {
  if (!validateMnemonic(words, wordlist)) throw new Error('mnemonicToSeed: invalid mnemonic')
  const seed = mnemonicToEntropy(words, wordlist)
  assertSeedLen(seed, 'mnemonicToSeed')
  return seed
}

// ---------------------------------------------------------------------------
// Keyfile (plaintext by design: it IS the lifeline; UI copy states it plainly)
//
// `kind` keeps its pre-rebrand spelling: keyfileSchema below matches it as a
// literal, so renaming it would make every keyfile a user has already saved
// fail to import, and a keyfile is the only way back into a lost account.
// Accepting a new spelling means accepting both, not swapping one for the other.
// ---------------------------------------------------------------------------

export function makeKeyfile(identity: Identity): Keyfile {
  assertSeedLen(identity.seed, 'makeKeyfile')
  return {
    v: 1,
    kind: 'chess-sharp-keyfile',
    name: identity.displayName,
    tag: identity.tag,
    seed: toB64u(identity.seed),
  }
}

const keyfileSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal('chess-sharp-keyfile'),
    name: z.string().min(1),
    tag: z.string().regex(new RegExp(`^[A-Z2-7]{${TAG_LEN}}$`)),
    seed: z.string().min(1),
  })
  .strict()

/** Parse + validate a keyfile JSON string. Throws on any deviation. */
export function parseKeyfile(json: string): { seed: Uint8Array; name: string; tag: string } {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('parseKeyfile: not valid JSON')
  }
  const kf = keyfileSchema.parse(raw)
  let seed: Uint8Array
  try {
    seed = fromB64u(kf.seed)
  } catch {
    throw new Error('parseKeyfile: seed is not valid base64url')
  }
  assertSeedLen(seed, 'parseKeyfile')
  return { seed, name: kf.name, tag: kf.tag }
}
