// A2 coordination parameters (docs/ACCOUNTS-PARAMS.md §Witness fabric / §PIN).
// UNLIKE PARAMS_V1 these are NOT frozen-at-genesis: they govern ephemeral
// coordination (leases, committees, eligibility: C-3 state), so they can be
// revised. Records that depend on them embed PARAMS_A2_DIGEST so a verifier
// always knows which rule set admitted a record.
import { canonicalHash, type CanonicalObject } from '../codec'
import { toB64u } from '../hash'

export const PARAMS_A2 = {
  v: 1,
  // Witness fabric (§4)
  wN: 16, // canonical witness-set size (key-distance closest eligible)
  tLease: 9, // lease threshold. Strict majority of wN: two live leases impossible
  ckptM: 4, // checkpoint cosigners required...
  ckptN: 8, // ...drawn from the nearest N eligible
  leaseTtlMs: 120_000,
  leaseHeartbeatMs: 20_000,
  // Witnessed time (§4)
  timeWindowMs: 90_000, // attestation must sit within ±window of cosigner median
  timeDiversityMin: 3, // age/ban/staleness claims need ≥3 entanglement-distant attesters
  // Eligibility floors (§4). Trust floor is fixed-point micro-units (0.5)
  eligTrustMicro: 500_000,
  eligUptimePct: 95,
  eligEntanglementFreeDays: 90, // no direct game/friend edge with subject in this window
  eligSharedPartnerPctMax: 20,
  // PIN committee (§1)
  pinT: 6,
  pinN: 9,
  pinLifetimeFails: 100,
  pinRefill: 20,
  pinBanDays: 90,
} as const satisfies CanonicalObject

export const PARAMS_A2_DIGEST: string = toB64u(canonicalHash(PARAMS_A2))
