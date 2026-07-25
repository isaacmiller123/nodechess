// FROZEN-AT-GENESIS parameter set (docs/ACCOUNTS-PARAMS.md). The digest of
// this object is embedded in every genesis event; verification rules never
// drift under existing chains. Changing ANY value here creates params v2.
// It must never mutate v1.
import { canonicalHash, type CanonicalObject } from './codec'
import { toB64u } from './hash'

export const PARAMS_V1 = {
  v: 1,
  sig: 'ed25519',
  hash: 'sha256',
  codec: 'cjson-v1',
  tagLen: 5,
  norm: 'nfkc-trim-casefold-v1',
  pwNorm: 'nfkd-v1',
  saltRule: 'sha256-folded-username-v1',
  argon2: { algo: 'argon2id', memKib: 65536, iters: 3, parallelism: 1, outLen: 32 },
  kdf: 'slip10-ed25519',
} as const satisfies CanonicalObject

/** b64u(sha256(canonicalBytes(PARAMS_V1))). The value genesis payloads carry. */
export const PARAMS_V1_DIGEST: string = toB64u(canonicalHash(PARAMS_V1))
