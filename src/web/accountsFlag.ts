// A-final switch, web side (docs/ACCOUNTS-SPEC.md §14).
//
// THE SWITCH IS SPENT on the web target. The interim server-account client it
// used to gate (authStore.ts -> /api/auth/*) is gone along with the server, so
// the decentralized accounts (src/web/accounts.ts over @shared/accounts) are
// the only account system a browser can reach and nothing in the web app reads
// ACCOUNTS_DECENTRALIZED any more.
//
// The module stays because the flag grammar is SHARED: server/afinal.ts
// resolves the same tokens to 410-gate the retired auth endpoints, and
// scripts/test-afinal-flag.mjs bundles both halves to prove they agree. Keep
// them in lockstep, or delete both together.
//
// The default is ON unconditionally: a build flips OFF only via an explicit
// VITE_ACCOUNTS_DECENTRALIZED=0|false|off at vite build time. An unset or
// unrecognized value stays ON — garbage never silently reverts the flip.

/** Parse one flag token; undefined = unset/unrecognized. Same grammar as
 *  server/afinal.ts parseFlagToken — keep them in lockstep. */
export function parseFlagToken(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return undefined
  const t = raw.trim().toLowerCase()
  if (t === '1' || t === 'true' || t === 'on' || t === 'yes') return true
  if (t === '0' || t === 'false' || t === 'off' || t === 'no') return false
  return undefined
}

/** Pure web-side resolution: default ON, explicit off tokens only. */
export function resolveWebAccountsFlag(raw: unknown): boolean {
  return parseFlagToken(raw) ?? true
}

export type AccountSystem = 'decentralized' | 'interim'

/** The explicit selection the rest of the web surface keys off. */
export function accountSystem(on: boolean): AccountSystem {
  return on ? 'decentralized' : 'interim'
}

// import.meta.env exists under vite (dev + build); the typeof guard keeps
// this module loadable in bare-node suite bundles (engines/assets.ts
// precedent).
const rawEnv: unknown =
  typeof import.meta.env !== 'undefined'
    ? (import.meta.env as Record<string, unknown>).VITE_ACCOUNTS_DECENTRALIZED
    : undefined

/** The single web-side switch (spec §14 A-final). */
export const ACCOUNTS_DECENTRALIZED: boolean = resolveWebAccountsFlag(rawEnv)

/** Which account system this build of the web surface uses. */
export const ACCOUNT_SYSTEM: AccountSystem = accountSystem(ACCOUNTS_DECENTRALIZED)
