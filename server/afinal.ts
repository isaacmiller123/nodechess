// A-final switch (docs/ACCOUNTS-SPEC.md §14): ACCOUNTS_DECENTRALIZED.
//
// One explicit, reversible flag decides which account system this server
// speaks. ON = the decentralized accounts are the account system and the
// interim server-account ENDPOINTS (/api/auth/*, server/auth.ts) answer
// 410 Gone "superseded". OFF = the interim system is fully intact, the
// emergency-fallback path. Nothing is deleted either way: server/auth.ts
// stays, and the flip is a restart with a different env.
//
// Resolution (first tier that speaks wins):
//   1. env ACCOUNTS_DECENTRALIZED: '1'/'true'/'on'/'yes' => ON,
//      '0'/'false'/'off'/'no' => OFF (case-insensitive, trimmed). The single
//      explicit switch, and the emergency OFF lever on a shipped build.
//   2. build default __ACCOUNTS_DECENTRALIZED_DEFAULT__, scripts/
//      build-server.mjs injects 'on', so EVERY shipped bundle (dist-server,
//      Docker) defaults to the decentralized path.
//   3. fallback OFF: a bundle without the define. That is exactly the
//      pre-A-final rigs: the existing web suites (test-web-auth/-bridge/
//      -server) esbuild server/index.ts ad hoc with only __WEB_APP_VERSION__
//      defined, and they assert the interim lifecycle. Fallback-OFF keeps
//      every one of them green untouched (quality gate: existing suites stay
//      green) while every real build still defaults ON via tier 2.
//
// Scope of the gate (§14: content plane stays conventionally served):
//   ONLY '/api/auth' and '/api/auth/*' are refused. The bridge
//   (/api/ipc/:channel; puzzle DB, curriculum, famous, personas, i.e. the
//   content plane plus anon persistence) and /api/review/* are untouched, as
//   are statics and /healthz. Existing interim session COOKIES also still
//   resolve on those routes (requireUser is not gated): with the auth
//   endpoints refused no NEW interim session can ever be minted or queried,
//   but flipping ON must never strand an honest user's per-user data behind
//   an unreachable code path: reversibility over purity, spec §0.

import type { FastifyInstance, FastifyReply } from 'fastify'

// Injected by scripts/build-server.mjs; absent in ad-hoc bundles (typeof
// guard below. Same pattern as __WEB_APP_VERSION__ in index.ts).
declare const __ACCOUNTS_DECENTRALIZED_DEFAULT__: string

export type AccountsFlagSource = 'env' | 'build-default' | 'fallback'

export interface AccountsFlag {
  /** true = decentralized accounts; interim /api/auth endpoints refuse 410. */
  on: boolean
  source: AccountsFlagSource
}

/** Parse one flag token; undefined = "this tier does not speak" (unset or
 *  unrecognized: an unrecognized value NEVER silently picks a side). */
export function parseFlagToken(raw: string | undefined): boolean | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim().toLowerCase()
  if (t === '1' || t === 'true' || t === 'on' || t === 'yes') return true
  if (t === '0' || t === 'false' || t === 'off' || t === 'no') return false
  return undefined
}

/** Pure tiered resolution: exported so the suite can exercise the whole
 *  matrix without booting a server. */
export function resolveAccountsFlag(
  envRaw: string | undefined,
  buildRaw: string | undefined
): AccountsFlag {
  const env = parseFlagToken(envRaw)
  if (env !== undefined) return { on: env, source: 'env' }
  const build = parseFlagToken(buildRaw)
  if (build !== undefined) return { on: build, source: 'build-default' }
  return { on: false, source: 'fallback' }
}

/** The runtime resolution index.ts uses (env + build define). */
export function accountsDecentralized(): AccountsFlag {
  const buildRaw =
    typeof __ACCOUNTS_DECENTRALIZED_DEFAULT__ === 'string'
      ? __ACCOUNTS_DECENTRALIZED_DEFAULT__
      : undefined
  return resolveAccountsFlag(process.env.ACCOUNTS_DECENTRALIZED, buildRaw)
}

export const INTERIM_SUPERSEDED_STATUS = 410 // Gone, deliberate, not an error

export const INTERIM_SUPERSEDED_BODY = {
  error: 'interim-accounts-superseded',
  message:
    'Interim server accounts are superseded by decentralized accounts (A-final). ' +
    'Restart the server with ACCOUNTS_DECENTRALIZED=0 to temporarily re-enable them.'
} as const

export interface GateRefusal {
  gated: true
  status: typeof INTERIM_SUPERSEDED_STATUS
  body: typeof INTERIM_SUPERSEDED_BODY
}

/**
 * Pure routing decision: should this request path be refused as a superseded
 * interim-account endpoint? Only the /api/auth namespace is ever gated,
 * '/api/authx' or any content-plane path passes untouched, and nothing is
 * gated when the flag is OFF.
 */
export function gateInterimAuth(on: boolean, urlPath: string): { gated: false } | GateRefusal {
  if (!on) return { gated: false }
  const pathname = urlPath.split('?')[0]
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    return { gated: true, status: INTERIM_SUPERSEDED_STATUS, body: INTERIM_SUPERSEDED_BODY }
  }
  return { gated: false }
}

/**
 * Register the 410 responders for the whole interim-auth namespace (bare path
 * + subtree, mirroring index.ts's coming-online pattern: find-my-way's
 * wildcard does not match the prefix itself). Called INSTEAD of
 * registerAuthRoutes when the flag is ON, and regardless of whether the ipc
 * bridge bundle is present: superseded is superseded, not coming-online.
 */
export function registerInterimAuthGate(app: FastifyInstance): void {
  const refuse = async (req: { url: string }, reply: FastifyReply): Promise<unknown> => {
    const decision = gateInterimAuth(true, req.url)
    // The namespace registration IS the gate; the pure function stays the
    // single source of truth for status + body.
    if (!decision.gated) return reply.code(500).send({ error: 'gate-mismatch' })
    return reply.code(decision.status).send(decision.body)
  }
  app.all('/api/auth', refuse)
  app.all('/api/auth/*', refuse)
}
