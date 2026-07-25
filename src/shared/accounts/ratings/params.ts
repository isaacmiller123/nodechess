// A4 parameters (docs/ACCOUNTS-PARAMS.md §Ratings / §Matchmaking /
// §Social reputation weights). Like PARAMS_A2/A3 these are NOT frozen-at-
// genesis: they govern folds and pairing rules that every verifier recomputes,
// so records that depend on them embed PARAMS_A4_DIGEST — a verifier always
// knows which rule set produced a number. All fractional values are FIXED-POINT
// integers (micro-units, ×10⁶) per the canonical-codec integers-only rule.
// [SIGN-OFF] items carried verbatim from ACCOUNTS-PARAMS.md: reveal thresholds
// 120/100/80/40, reputation fold weights (checkpoint M/N live in PARAMS_A2).
import { canonicalHash, type CanonicalObject } from '../codec'
import { toB64u } from '../hash'

export const PARAMS_A4 = {
  v: 1,

  // --- Ladders & Glicko-2 (§6) --------------------------------------------
  // Seeds mirror the shipped glicko2.ts defaults; micro-units where fractional.
  seedRating: 1200,
  seedRd: 350,
  seedVolMicro: 60_000, // 0.06
  tauMicro: 500_000, // 0.5
  rdMin: 30,
  rdMax: 350,
  placementGames: 10,
  placementRdFloor: 300,
  // TimeCategory in EXACT INTEGER math: estMs = baseMs + incWeight·incMs;
  // < threshold ⇒ category (same semantics as the renderer's float form).
  tcIncWeight: 40,
  tcBulletMaxEstMs: 179_000,
  tcBlitzMaxEstMs: 480_000,
  tcRapidMaxEstMs: 1_500_000,
  // Per-category reveal thresholds (games before a rating renders) [SIGN-OFF].
  revealBullet: 120,
  revealBlitz: 100,
  revealRapid: 80,
  revealClassical: 40,

  // --- Matchmaking (§7) ----------------------------------------------------
  // width(T) = widthMin + widthSpan·(1−T)² Elo, T in micro-units.
  widthMin: 50,
  widthSpan: 450,
  // Island term: cost += islandCoefMicro·|T_a−T_b|·islandScale (Elo-equivalent)
  // when either side's T < islandGateMicro.
  islandCoefMicro: 350_000, // 0.35
  islandGateMicro: 600_000, // 0.6
  islandScale: 500,
  // Spillover brackets: fixed rails, multiples of bracketWidth (…, 800–1600, …).
  bracketWidth: 800,
  // Opponent-diversity window (witnessed-lane heights): the trust fold's
  // per-opponent memory covers the trailing window only (bounded state, like
  // repPairWindow) — recent diversity is the anti-farming signal.
  trustDivWindow: 1000,
  // Trust-term weights (chain-shape, micro-units; forensic terms re-weight at A5).
  trustWAgeMicro: 150_000,
  trustWDiversityMicro: 300_000,
  trustWCleanlinessMicro: 250_000,
  trustWCompletionMicro: 300_000,

  // --- Reputation fold (§6b) [SIGN-OFF weights] ----------------------------
  repWCompletionMicro: 350_000,
  repWDisconnectMicro: 250_000,
  repWTimeoutResignMicro: 100_000,
  repWRematchMicro: 50_000,
  repWNoshowMicro: 100_000,
  repWCommendMicro: 150_000,
  // Badge tiers over the 0–100 score: [0,40) / [40,70) / [70,90) / [90,100].
  repTier1Min: 40,
  repTier2Min: 70,
  repTier3Min: 90,
  // Reference window (witnessed-lane heights): a commend / rematch-accept may
  // only reference a segment whose height is within this many witnessed events
  // of it. Bounds the fold's per-(game,opp) dedup memory so checkpoint state
  // stays O(window), not O(games) — entries older than the window are pruned
  // deterministically by repStep.
  repPairWindow: 200,
} as const satisfies CanonicalObject

export const PARAMS_A4_DIGEST: string = toB64u(canonicalHash(PARAMS_A4))
