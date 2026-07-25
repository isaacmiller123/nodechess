// A4 checkpoint fold 'a4-v1' (spec §6/§6b/§7, brick 2a), THE deterministic
// per-account derived state: basic structural counters (bit-compatible with
// checkpoint.ts basicFold), per-ladder Glicko-2 ratings, the 1c reputation
// state, the 2b trust-input state, and the reserved A5 ban shape, one
// ChainFold every verifier recomputes identically (checkpoint.ts registry).
//
// STATE (CanonicalObject, integer leaves only): see A4FoldState. `f` +
// `params` self-describe the state: verifiers select the fold by `f`
// (checkpoint.ts) and always know which PARAMS_A4 rule set produced the
// numbers. `rep` / `trust` are the 1c/2b states EMBEDDED VERBATIM, every
// step delegates to repStep/trustInputsStep; this module never reimplements
// (or double-counts) their logic, so the embedded members are byte-identical
// to running those folds standalone over the same event sequence (asserted in
// scripts/test-accounts-ratings.mjs). `bans` holds A5's anticheat SELF-ban
// state (J4, in-chain 'selfban' events ONLY; see banStep + the LadderBan
// contract); fuse/fork bans (and Tier-2 SUPPRESSION records) are
// standalone records checked alongside the chain, never in-chain state.
//
// STEP ORDER (pure, total, never throws, never mutates):
//   1. rep   ← repStep(rep, ev)                (1c, all witnessed conduct)
//   2. trust ← trustInputsStep(trust, ev)      (2b, chain-shape counters)
//   3. n/byType/head/height, the basicFold counters, same shape.
//   4. RATED segments only: the Glicko update (below).
//   5. bans  ← banStep(bans, ev)               (A5, 'selfban' events only).
//
// RATED = type 'segment' (witnessed lane) AND payload parses AND kind+tc both
// present AND timeCategory(tc) ≠ 'Unlimited' AND verifySegmentEvent(ev) ===
// null. That last gate is 2c's ladder binding, STRICT since F1 (A4-01/02/08):
// on a kind/tc-bearing segment the witness terminal signature must cover the
// ATOMIC RatedBinding {kind, tc, players, reason}: rated ⇔ fully bound ⇔
// witness-signed ladder AND color/players AND reason, and any embedded
// oppCkpt must pass verifyEmbeddedOppCkpt (root-bound to opp, sig + cert
// provenance, ≥M distinct prefix-diverse cosigners, all verified). A segment
// failing the gate ('bad-ladder-binding' / 'bad-opp-ckpt' / any other error)
// MUST NOT rate, and since the A4-07/A4-05 fixes it feeds rep and trust
// NOTHING either: repStep and trustInputsStep each run the SAME
// verifySegmentEvent gate internally, so an unverifiable segment moves only
// the basic n/byType counters. (Such a segment cannot exist on a
// verifyChain-accepted chain at all (chain.ts emits 'bad-segment'); the fold
// gates make every layer safe standalone.)
//
// PINNED FOLD INPUTS (§6, the A4-02 close; the trust/rep A4-03/05/14 layer
// split applied to ratings): the FOLD pins the §6 SEEDS (1200/350) for EVERY
// opponent, the embedded oppCkpt's asserted (rating, RD) NEVER reaches the
// in-fold update, and no other payload field (oppProfile, reason, …) can
// either (asserted in the suite). WHY SEEDS AND NOT THE EMBEDDED NUMBERS:
// verifyEmbeddedOppCkpt (the rated gate) proves structure and provenance:
// root-binding, signatures, ≥M distinct prefix-diverse cosigners, but a
// deterministic fold has NO roster, so those cosigners can be 4 freshly
// minted sybil keys: an in-fold read of the asserted numbers lets a
// colluding opponent (or one sybil root) assert ANY rating and ratchet the
// subject's embedded rating arbitrarily (the A4-02 review defect; the 4000
// clamp bounded magnitude, not the ratchet). Worse, such a ratcheted fold is
// still a CORRECTLY-FOLDED chain (the §2/§6 one-level audit finds no fraud),
// so genuinely eligible witnesses would legitimately cosign it and launder
// the fabrication into every downstream read. Seeds-in-fold kills the
// ratchet at the root: a fabricated oppCkpt folds byte-identically to the
// honest no-oppCkpt young-opponent path, so the embedded ladder is a pure
// deterministic FLOOR (roster-independent, A4-04 safe) that an opponent's
// sybil machinery cannot move at all. Roster-VOUCHED opponent strength is a
// read-time judgment: ratingEvidenceOf (below) re-walks the chain through
// this very fold and pins the oppCkpt's embedded (clamped) numbers ONLY for
// segments whose serving witness AND ≥M oppCkpt cosigners the verifier's
// own WitnessEligibility predicate accepts, never embedded in any state.
// A4-02 fidelity CLOSED (A7): the pairing record's roster-aware SERVING
// WITNESS attests the opponent's current vouched rating + §4 head height at
// match time (PairingPayload.witAttest, witness/attest.ts helpers,
// witness-signed, so chain-authoritative); ratingEvidenceOf collects
// sig-valid attests from ELIGIBLE witnesses during the walk and upgrades the
// vouched pin from the embedded floor to the attested number, UPGRADE ONLY
// (the floor stays the sound lower bound), capped at OPP_RATING_CAP_MICRO.
// The same attest's headHeight closes A4-10: verifyEmbeddedOppCkpt bounds
// oppCkpt.through against it (stale/fabricated-past-head ⇒ vouched read
// refused ⇒ seeds). Attest absent (legacy chains) ⇒ the floor remains the
// honest, sound representation. Read-time only: no fold input, no drift.
//
// DUPLICATE-SEGMENT DEDUP (lead-approved, reputation.ts's windowed-pair-map
// discipline): a segment whose game key already appeared in a RATED segment
// within the trailing PARAMS_A4.repPairWindow (200) witnessed events does NOT
// rate, one game key rates at most once per window, closing the replay
// vector (re-appending a won segment to farm rating). The `seen` sub-map
// (game key → witnessed height of the segment that rated) is pruned EAGERLY
// on every step (every a4 step is state-modifying, the counters always
// tick), dropping entries with h < evHeight − repPairWindow, so the map is
// O(window) and its bytes are a pure function of the witnessed event
// sequence. Same no-gap property as reputation.ts: the rule that expires the
// memory IS the window rule. An out-of-window duplicate is DEAD one layer
// down since the A4-11 fix: verifyChain enforces one game key per chain,
// chain-WIDE ('dup-game'), so cross-window replay never reaches a verified
// fold; the windowed rule here is the bounded-state defense-in-depth for
// standalone folding of unverified chains. Only RATED segments insert into
// `seen`: an unrated occurrence (legacy, Unlimited, bad-ladder-binding)
// never blocks a later valid rating of the same game. rep/trust are
// untouched by this rule, they carry their own dedup (rep) or none by
// design (trust).
//
// PLACEMENT (§6): the first placementGames (10) per ladder ride a held-high
// RD floor, after each rated game, while the ladder's game count n <
// placementGames, the STORED rd is max(computedMicro, placementRdFloor·1e6).
// The floor therefore also IS the opponent-facing fold input for the next
// game (own rd input = stored rd; an opponent reading this ladder from a
// checkpoint reads the floored value), one rule, two effects. `placed` flips
// 0→1 exactly when n reaches placementGames, and from that game on the stored
// rd is the raw computed value. RD_MAX interplay: the glicko core clamps
// computed rd to [rdMin, rdMax] = [30, 350] BEFORE the floor, and
// placementRdFloor (300) ≤ rdMax (350), so the floored value stays inside
// [300e6, 350e6], the floor can never push rd past RD_MAX.
//
// Platform-neutral: no `node:` imports, no DOM, no ambient time, no
// Math.exp/log/pow (glicko.ts → detmath).

import type { CanonicalObject } from '../codec'
import { eventId, zPairingPayload, zSegmentPayload, zSelfBanPayload } from '../events'
import { trustInputsInit, trustInputsStep, type TrustInputs } from '../mm/trust'
import { OPP_CKPT_PREFIX_DIVERSITY_MIN, verifyEmbeddedOppCkpt, verifySegmentEvent } from '../segment'
import { verifyPairingAttest, type PairingWitAttest } from '../witness/pairattest'
import type { SegmentPayload } from '../storage/types'
import { PARAMS_A2 } from '../witness/params'
import type {
  B64u,
  Chain,
  ChainFold,
  SignedEvent,
  WitnessAttestation,
  WitnessEligibility,
} from '../types'
import { glickoUpdateMicro } from './glicko'
import { ladderId, timeCategory } from './ladders'
import { PARAMS_A5 } from '../judge/params'
import { PARAMS_A4, PARAMS_A4_DIGEST } from './params'
import { repInit, repStep, type RepState } from './reputation'

export const A4_FOLD_ID = 'a4-v1'

/** One ladder's stored state, micro-unit integers (×10⁶) throughout. */
export interface LadderState extends CanonicalObject {
  /** Rating, micro-Elo. */
  r: number
  /** Rating deviation, micro (placement-floored while n < placementGames). */
  rd: number
  /** Volatility, micro. */
  vol: number
  /** Rated games folded into this ladder. */
  n: number
  /** 1 once n ≥ placementGames, else 0. */
  placed: number
}

/** The a4-v1 fold state (see header contract). */
export interface A4FoldState extends CanonicalObject {
  f: typeof A4_FOLD_ID
  /** PARAMS_A4_DIGEST: which rule set produced these numbers. */
  params: string
  /** Witnessed events folded (basicFold-compatible counters). */
  n: number
  byType: { [t: string]: number }
  head?: string
  height?: number
  /** ladderId → ladder state. Unlimited/unbound segments never appear. */
  ladders: { [id: string]: LadderState }
  /** game key → witnessed height of the segment that RATED under it, windowed
   * to the trailing repPairWindow events (header dedup rule), O(window). */
  seen: { [game: string]: number }
  /** 1c reputation state, embedded verbatim. */
  rep: RepState
  /** 2b trust-input state, embedded verbatim. */
  trust: TrustInputs
  /** A5 anticheat self-ban state (J4): ladderId → the active in-chain
   * 'selfban' for that ladder. Folds ONLY in-chain selfban events (the
   * lead-decided architectural rule: the escalation trigger and verdicts
   * need the judge engine, which no synchronous fold step can run:
   * suppression is a read-time SUPPRESSION record, judge/tier2.ts, injected
   * like fuse records, never folded). MONOTONIC max per ladder, a later
   * selfban may only EXTEND `until`, never shorten it (A5-22), and `until`
   * is DERIVED from the selfban event's witnessed time + the §9 term, never
   * the self-asserted payload expiryWts; malformed payloads are ignored;
   * expiry is a READ-time comparison (`until` vs the caller's atWts, folds
   * have no clock). A selfban folds ONLY for a ladder the account has rated
   * state for (a key of `ladders`), the convicting ladder always is, since a
   * Tier-2 conviction needs a full reganK window there and §8 orders the
   * selfban after it, so |bans| ≤ |ladders| and the map cannot be bloated by
   * free selfban events carrying fabricated ladder strings (A5-38). */
  bans: { [ladder: string]: LadderBan }
}

/** One ladder's active self-ban (integers/strings only, cjson-v1). */
export interface LadderBan extends CanonicalObject {
  /** Ban expiry (§8/§9): DERIVED as the convicting selfban EVENT's witnessed
   * time + selfBanDays (never the self-asserted payload expiryWts) and
   * folded monotonically (a later selfban can only extend it, never shorten). */
  until: number
  /** Convicting (salted) K-window index. */
  window: number
  /** tier2VerdictDigest of the reproducible Tier-2 verdict record. */
  verdict: string
}

/** Seed ladder (§6: every ladder starts 1200 / RD 350 / vol 0.06). */
export function ladderInit(): LadderState {
  return {
    r: PARAMS_A4.seedRating * 1_000_000,
    rd: PARAMS_A4.seedRd * 1_000_000,
    vol: PARAMS_A4.seedVolMicro,
    n: 0,
    placed: 0,
  }
}

// ---------------------------------------------------------------------------
// Pinned opponent read (§6)
// ---------------------------------------------------------------------------

interface PinnedOpponent {
  ratingMicro: number
  rdMicro: number
}

function seedsOpponent(): PinnedOpponent {
  return { ratingMicro: PARAMS_A4.seedRating * 1_000_000, rdMicro: PARAMS_A4.seedRd * 1_000_000 }
}

/** Magnitude cap on a VOUCHED opponent-rating read (micro): 4000 display Elo.
 * No legitimate ladder reaches it (A4 review, A4-02 sanity clamp). Applies
 * in vouchedOpponentRead (the read-time evidence layer); the FOLD itself
 * pins seeds and needs no clamp (header A4-02 rule). */
export const OPP_RATING_CAP_MICRO = 4_000_000_000

/**
 * READ-TIME reader (never called by the fold, header A4-02 rule): opponent
 * (rating, RD) from the segment's embedded oppCkpt, ONLY when its embedded
 * state is a4-v1 and carries `lid` with well-formed non-negative safe
 * integers; every other shape reads the seeds. Total: never throws on any
 * input.
 *
 * The checkpoint EVENT is already verifyEmbeddedOppCkpt-proven by the rated
 * gate (opponent-root-bound, valid signature + cert provenance, ≥M distinct
 * prefix-diverse verified cosigners), and the CALLER (vouchedOpponent) has
 * additionally established roster ELIGIBILITY of the serving witness and ≥M
 * cosigners. This reader only interprets the embedded STATE. MAGNITUDE
 * SANITY CLAMP (A4-02): a well-formed read is clamped to the legal Glicko
 * input range: r into [0, OPP_RATING_CAP_MICRO], rd into [rdMin, rdMax]·1e6,
 * so even a fraudulent-but-eligible-cosigned embedded state (slashable
 * §2/§6 fraud, detected by the one-level audit) cannot in the meantime
 * inject a 10^9-Elo phantom into an honest player's vouched read. CLAMP,
 * not reject: the game verifiably happened against a checkpoint-proven
 * opponent, so it reads at the nearest legal value; structurally MALFORMED
 * values (non-integers, negative rd) still read the seeds.
 */
function vouchedOpponentRead(oppCkpt: SignedEvent | undefined, lid: string): PinnedOpponent {
  if (oppCkpt === undefined) return seedsOpponent() // young opponent
  const payload = oppCkpt.body?.payload as { state?: unknown } | undefined
  const st = payload?.state
  if (typeof st !== 'object' || st === null || Array.isArray(st)) return seedsOpponent()
  const s = st as { f?: unknown; ladders?: unknown }
  if (s.f !== A4_FOLD_ID) return seedsOpponent() // basic-v1 / foreign fold
  const ladders = s.ladders
  if (typeof ladders !== 'object' || ladders === null || Array.isArray(ladders)) return seedsOpponent()
  if (!Object.prototype.hasOwnProperty.call(ladders, lid)) return seedsOpponent() // no such ladder
  const l = (ladders as { [k: string]: unknown })[lid]
  if (typeof l !== 'object' || l === null) return seedsOpponent()
  const r = (l as { r?: unknown }).r
  const rd = (l as { rd?: unknown }).rd
  if (!Number.isSafeInteger(r) || !Number.isSafeInteger(rd) || (rd as number) < 0)
    return seedsOpponent()
  // Magnitude sanity clamp (doc above): r into [0, cap], rd into [rdMin, rdMax].
  return {
    ratingMicro: Math.min(Math.max(r as number, 0), OPP_RATING_CAP_MICRO),
    rdMicro: Math.min(
      Math.max(rd as number, PARAMS_A4.rdMin * 1_000_000),
      PARAMS_A4.rdMax * 1_000_000,
    ),
  }
}

// ---------------------------------------------------------------------------
// The rated-segment sub-step
// ---------------------------------------------------------------------------

/** Subject's score from result + played color: 1 / 0.5 / 0.
 *
 * SIGNATURE-BOUND INPUTS (A4-01, F1 semantics): this is only ever called
 * under the rated gate (verifySegmentEvent === null on a kind/tc-bearing
 * segment), whose atomic RatedBinding makes the witness terminal signature
 * cover players-by-color derived from (root, opp, color) alongside `result`.
 * So BOTH inputs here are witness-authenticated: a flipped `color` (or a
 * swapped `opp`) changes the derived players map, breaks the binding, and the
 * segment fails 'bad-ladder-binding' before this function is reached, a
 * witnessed loss can no longer be relabeled a rated win. */
function subjectScore(result: '1-0' | '0-1' | '1/2-1/2', color: 'w' | 'b'): number {
  if (result === '1/2-1/2') return 0.5
  return (result === '1-0') === (color === 'w') ? 1 : 0
}

/** Prune `seen` entries with h < minH, the eager window rule (header). */
function pruneSeen(seen: { [game: string]: number }, minH: number): { [game: string]: number } {
  const out: { [game: string]: number } = {}
  for (const k of Object.keys(seen)) {
    if (seen[k] >= minH) out[k] = seen[k]
  }
  return out
}

/**
 * Apply the Glicko update for a RATED segment (header gate); returns the new
 * ladders map + the game key to record in `seen`, or null when the segment
 * does not rate (skip rules / bad-ladder-binding / in-window duplicate /
 * malformed). `seen` must already be pruned to this event's window, so a
 * surviving entry is BY CONSTRUCTION in-window. Total: never throws.
 */
function ratedLadders(
  state: A4FoldState,
  seen: { [game: string]: number },
  ev: SignedEvent,
): { ladders: { [id: string]: LadderState }; game: string } | null {
  try {
    if (ev.body.lane !== 'w' || ev.body.type !== 'segment') return null
    const res = zSegmentPayload.safeParse(ev.body.payload)
    if (!res.success) return null
    const p = res.data
    if (p.kind === undefined || p.tc === undefined) return null // unbound = legacy/unrated
    if (timeCategory(p.tc) === 'Unlimited') return null // §6: unlimited is unrated
    if (Object.prototype.hasOwnProperty.call(seen, p.game)) return null // in-window duplicate: rates once
    if (verifySegmentEvent(ev) !== null) return null // incl. 'bad-ladder-binding'
    const lid = ladderId(p.kind, p.tc)
    const own = Object.prototype.hasOwnProperty.call(state.ladders, lid)
      ? state.ladders[lid]
      : ladderInit()
    // A4-02 (header PINNED FOLD INPUTS): the fold pins the §6 SEEDS for EVERY
    // opponent, a deterministic fold has no roster, so the embedded oppCkpt's
    // asserted numbers (sybil-cosignable for free) must never reach the
    // update. Roster-vouched strength is ratingEvidenceOf's read-time grant.
    const opp = seedsOpponent()
    const up = glickoUpdateMicro(
      { ratingMicro: own.r, rdMicro: own.rd, volMicro: own.vol },
      [{ ratingMicro: opp.ratingMicro, rdMicro: opp.rdMicro, score: subjectScore(p.result, p.color) }],
    )
    const n = own.n + 1
    const placed = n >= PARAMS_A4.placementGames ? 1 : 0
    const rd = placed === 1 ? up.rdMicro : Math.max(up.rdMicro, PARAMS_A4.placementRdFloor * 1_000_000)
    return {
      ladders: { ...state.ladders, [lid]: { r: up.ratingMicro, rd, vol: up.volMicro, n, placed } },
      game: p.game,
    }
  } catch {
    // Adversarial payloads engineered to crash deeper layers, the rating
    // sub-step fails closed (segment skipped; rep/trust/counters unaffected).
    return null
  }
}

// ---------------------------------------------------------------------------
// The self-ban sub-step (A5 J4, header `bans` contract)
// ---------------------------------------------------------------------------

/** Milliseconds per day, the §9 self-ban term unit (mirrors witness/pin.ts
 * and judge/tier2.ts; a physical constant, not a tunable). */
const MS_PER_DAY = 86_400_000

/**
 * Fold one event into the bans map: a witnessed-lane 'selfban' whose payload
 * parses under zSelfBanPayload AND names a ladder the account has rated state
 * for installs/extends that ladder's entry. The expiry is DERIVED (event
 * witnessed time + the §9 term), never the self-asserted payload expiryWts,
 * and folds MONOTONICALLY, a later selfban may only push `until` LATER (max),
 * so a convict cannot shorten/erase an active ban with a second selfban
 * (A5-22). Everything else returns the map UNCHANGED (same reference, state
 * bytes cannot drift for ban-free chains). Malformed selfban payloads (and
 * non-integer event times) are ignored (total, never throws).
 *
 * BOUNDED STATE (A5-38): a selfban installs a NEW entry only for a ladder
 * present in `ladders`, one the account has actually rated a game in.
 * zSelfBanPayload.ladder is any 1..64-char string and verifyChain has no
 * per-selfban rule, so WITHOUT this gate an account grows `bans` one entry per
 * distinct fabricated ladder string, unbounded, and embedded verbatim in
 * every a4-v1 checkpoint that viewers recompute and carry. The convicting
 * ladder is always in `ladders` for a compliant self-ban (a Tier-2 conviction
 * needs a full reganK-game window on that ladder, and §8 orders the selfban
 * after the window-completing rated game), so the gate drops no legitimate
 * ban; it ties |bans| ≤ |ladders|, making a ban entry cost one WITNESSED rated
 * game (verifySegmentEvent + an M-of-N-cosigned oppCkpt), the same bound
 * `ladders` already carries. A selfban naming an unplayed ladder is
 * meaningless (no rated state there to gate) and is ignored like any other
 * non-folding event.
 */
function banStep(
  bans: { [ladder: string]: LadderBan },
  ev: SignedEvent,
  ladders: { [id: string]: LadderState },
): { [ladder: string]: LadderBan } {
  try {
    if (ev.body.lane !== 'w' || ev.body.type !== 'selfban') return bans
    const res = zSelfBanPayload.safeParse(ev.body.payload)
    if (!res.success) return bans
    const p = res.data
    // A5-38 (bounded state): fold a selfban ONLY for a ladder the account has
    // rated state for (a key of `ladders`); see the fn header. A fabricated /
    // unplayed ladder string never enters `bans`, so the map is bounded by the
    // (witness-bound) `ladders` domain, never by the free selfban-event count.
    if (!Object.prototype.hasOwnProperty.call(ladders, p.ladder)) return bans
    // §8/§9 + §0 (A5-22): DERIVE the expiry from the selfban EVENT's witnessed
    // time (ev.body.ts, diversity-bound §4, witness-clock-checked in
    // attest.ts, and ≥ the §8 CONVICTION (A5-21) since the compliant client
    // appends the selfban right after the conviction-completing game) +
    // selfBanDays. NEVER
    // the payload's freely-chosen expiryWts (zSelfBanPayload leaves it
    // unconstrained), so a {expiryWts:0} selfban can no longer zero a ban.
    const ts = ev.body.ts
    if (!Number.isSafeInteger(ts) || ts < 0) return bans // fail closed
    const until = ts + PARAMS_A5.selfBanDays * MS_PER_DAY
    // MONOTONIC (max, first-wins on tie): a later selfban may only EXTEND an
    // active ban, never shorten it, the un-ban attack (a second selfban with
    // a smaller/earlier expiry) is a no-op. until/window/verdict move together
    // (they name one convicting selfban).
    const prev = bans[p.ladder]
    if (prev !== undefined && prev.until >= until) return bans
    return { ...bans, [p.ladder]: { until, window: p.window, verdict: p.verdict } }
  } catch {
    return bans // fail closed: an adversarial payload never crashes the fold
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

export const a4Fold: ChainFold<A4FoldState> = {
  id: A4_FOLD_ID,
  init: (_root: B64u): A4FoldState => ({
    f: A4_FOLD_ID,
    params: PARAMS_A4_DIGEST,
    n: 0,
    byType: {},
    ladders: {},
    seen: {},
    rep: repInit(),
    trust: trustInputsInit(),
    bans: {},
  }),
  step: (state: A4FoldState, ev: SignedEvent): A4FoldState => {
    const t = ev.body.type
    // Every a4 step modifies state (the counters always tick), so the seen
    // window is pruned eagerly on every step, header dedup rule.
    const seen = pruneSeen(state.seen, ev.body.height - PARAMS_A4.repPairWindow)
    const rated = ratedLadders(state, seen, ev)
    return {
      ...state, // carries f / params
      n: state.n + 1,
      byType: { ...state.byType, [t]: (state.byType[t] ?? 0) + 1 },
      head: eventId(ev.body),
      height: ev.body.height,
      ladders: rated !== null ? rated.ladders : state.ladders,
      seen: rated !== null ? { ...seen, [rated.game]: ev.body.height } : seen,
      rep: repStep(state.rep, ev),
      trust: trustInputsStep(state.trust, ev),
      // `state.ladders` is the PRE-step ladders; a selfban event never updates
      // ladders (rated===null for non-segments) so this equals the post-step
      // ladders, and for a segment banStep short-circuits on type before using
      // it, so the pre-step map is always the right membership set (A5-38).
      bans: banStep(state.bans, ev, state.ladders),
    }
  },
}

// ---------------------------------------------------------------------------
// Verified read-time rating evidence (A4-02, NEVER embedded in fold state)
// ---------------------------------------------------------------------------

/**
 * The verifier-side, roster-VOUCHED rating projection (A4-02 layer 2, the
 * mm/trust.ts TrustEvidence / ratings/reputation.ts RepEvidence regime).
 * NEVER embedded in any checkpoint state: two honest verifiers with
 * different eligibility views legitimately compute different vouched ladders
 * (weaker-is-safer), which is exactly why none of this may reach the fold
 * (A4-04, embedded state must be byte-identical for every verifier).
 */
export interface RatingEvidence {
  /** ladderId → the VOUCHED ladder state: the same Glicko walk as the fold
   * over the SAME rated-segment set, with each opponent pinned at the
   * oppCkpt's embedded (clamped) numbers when the verifier's roster vouches
   * the segment, at the §6 seeds otherwise. With no predicate this is
   * byte-identical to the fold's own `ladders` (asserted in the suite). */
  ladders: { [id: string]: LadderState }
}

/**
 * The roster-vouched opponent pin for ONE rated segment (A4-02): the
 * embedded oppCkpt's (clamped) numbers ONLY when ALL of:
 *  - an eligibility predicate was supplied (no roster ⇒ nothing is vouched);
 *  - the segment's serving witness key is eligible (a self-run wstream
 *    witness proves nothing, the mm/trust.ts A4-05 rule);
 *  - ≥ PARAMS_A2.ckptM of the oppCkpt's cosigners are eligible, spanning
 *    ≥ OPP_CKPT_PREFIX_DIVERSITY_MIN distinct 2-char key prefixes
 *    (segment.ts's diversity bound re-applied to the RECOGNIZED subset,
 *    the exact repEvidenceOf/oppEligProxyMicro est rule);
 * and the §6 seeds otherwise. Only reachable under the rated gate, so
 * every wit entry is already a distinct signature-VERIFIED cosigner
 * (verifyEmbeddedOppCkpt); eligibility is the only judgment left. What a
 * vouched read supplies is the opponent's embedded FLOOR ladder, itself
 * seed-pinned by this fold (header A4-02 rule), so a vouched pin is
 * un-ratchetable by the OPPONENT's own sybil machinery too: eligible
 * cosigners attest a faithfully-folded state, and the faithful state cannot
 * carry a fabricated number. (Fidelity deferral + A5 hook: header.)
 */
function vouchedOpponent(
  p: SegmentPayload,
  lid: string,
  eligible: WitnessEligibility | undefined,
  owner: B64u,
  attest?: PairingWitAttest,
): PinnedOpponent {
  if (eligible === undefined) return seedsOpponent()
  const c = p.oppCkpt as SignedEvent | undefined
  if (c === undefined) {
    // Young opponent: seeds, UNLESS the serving witness attested a rating at
    // match time (A4-02 closure): witness-signed ⇒ chain-authoritative, and
    // an attested number can only UPGRADE (seeds are the floor here).
    if (attest === undefined) return seedsOpponent()
    const seeds = seedsOpponent()
    return {
      ...seeds,
      ratingMicro: Math.min(
        Math.max(attest.ratingMicro, seeds.ratingMicro),
        OPP_RATING_CAP_MICRO,
      ),
    }
  }
  if (!eligible(p.wstream.wkey)) return seedsOpponent()
  const wit = (c as { wit?: WitnessAttestation[] }).wit
  if (!Array.isArray(wit)) return seedsOpponent()
  const elig = wit.filter((a) => eligible(a.w))
  const prefixes = new Set<string>()
  for (const a of elig) prefixes.add(a.w.slice(0, 2))
  if (elig.length < PARAMS_A2.ckptM || prefixes.size < OPP_CKPT_PREFIX_DIVERSITY_MIN)
    return seedsOpponent()
  // A4-10 closure (A7): with a witness-attested head height, a checkpoint
  // claiming to fold past the attested head is stale-or-fabricated; refuse
  // the vouched read entirely (seeds, the sound floor).
  if (attest !== undefined && !verifyEmbeddedOppCkpt(p, owner, attest.headHeight))
    return seedsOpponent()
  const floor = vouchedOpponentRead(c, lid)
  if (attest === undefined) return floor
  // A4-02 closure (A7): upgrade the vouched pin from the embedded floor to
  // the witness-attested number, upgrade ONLY (the floor stays the sound
  // lower bound; an attest below it never downgrades), capped like every
  // opponent input.
  return {
    ...floor,
    ratingMicro: Math.min(Math.max(attest.ratingMicro, floor.ratingMicro), OPP_RATING_CAP_MICRO),
  }
}

/**
 * Compute the read-time VOUCHED ladders for a chain (A4-02): re-walk the
 * witnessed lane THROUGH a4Fold.step itself: a segment earns a vouched
 * update exactly iff the fold rated it (its game key lands in `seen` at this
 * event's height), so the fold's gates (verifySegmentEvent incl. the F1
 * binding and verifyEmbeddedOppCkpt, Unlimited skip, windowed dedup) apply
 * with ZERO rule drift, and maintain a parallel ladder map whose per-game
 * opponent pin is vouchedOpponent's roster judgment. Placement floor,
 * placed-flip and RD handling mirror the fold's rated sub-step exactly.
 *
 * Pure and total (never throws; adversarial payloads fail closed exactly
 * where the fold does). `eligible` absent ⇒ every pin is the seeds ⇒ the
 * result is BYTE-IDENTICAL to the fold's embedded `ladders` (the zero-drift
 * invariant, asserted in scripts/test-accounts-ratings.mjs), an
 * eligibility-blind verifier reads exactly the deterministic floor, and a
 * sybil-cosigned oppCkpt earns seeds under EVERY verifier (its fresh keys
 * are in no honest roster). Like trustEvidenceOf/repEvidenceOf this is the
 * designated read-side source: display and pairing surfaces consume THESE
 * ladders (display.ts pairViewOf doc), never a raw claim.
 */
export function ratingEvidenceOf(chain: Chain, eligible?: WitnessEligibility): RatingEvidence {
  const w = chain.events
    .filter((e) => e.body.lane === 'w')
    .sort((a, b) => a.body.height - b.body.height)
  let s = a4Fold.init(chain.root)
  let ladders: { [id: string]: LadderState } = {}
  // A7: per-game verified pairing attests (A4-02/A4-10). Collected from
  // 'pairing' events earlier in the walk (§7: the pairing is witnessed into
  // the chain BEFORE the game); only sig-valid attests from ELIGIBLE
  // witnesses enter, read-time roster judgment, exactly the vouched-pin
  // discipline. One game key ⇒ one pairing (chain-wide dup rules); first wins.
  const attests: { [game: string]: PairingWitAttest } = {}
  for (const ev of w) {
    const s2 = a4Fold.step(s, ev)
    try {
      if (ev.body.type === 'pairing' && eligible !== undefined) {
        const res = zPairingPayload.safeParse(ev.body.payload)
        if (res.success) {
          const pp = ev.body.payload as unknown as {
            game: B64u
            opp: B64u
            witAttest?: PairingWitAttest
          }
          const att = pp.witAttest
          if (
            att !== undefined &&
            !Object.prototype.hasOwnProperty.call(attests, pp.game) &&
            eligible(att.w) &&
            verifyPairingAttest(att, pp.game, pp.opp)
          )
            attests[pp.game] = att
        }
      }
      if (ev.body.type === 'segment') {
        // safeParse is the SHAPE gate only; read the RAW payload (the
        // trust.ts stepSegment discipline), zod re-encoding must never drop
        // non-schema attachments like the oppCkpt's `wit` cosigner list.
        const res = zSegmentPayload.safeParse(ev.body.payload)
        if (res.success) {
          const p = ev.body.payload as unknown as SegmentPayload
          // Rated exactly now ⇔ the fold recorded this game key at THIS
          // event's height (heights are strictly increasing along the walk,
          // so an older entry can never alias the current height).
          if (
            p.kind !== undefined &&
            p.tc !== undefined &&
            Object.prototype.hasOwnProperty.call(s2.seen, p.game) &&
            s2.seen[p.game] === ev.body.height
          ) {
            const lid = ladderId(p.kind, p.tc)
            const own = Object.prototype.hasOwnProperty.call(ladders, lid)
              ? ladders[lid]
              : ladderInit()
            const opp = vouchedOpponent(
              p,
              lid,
              eligible,
              chain.root,
              Object.prototype.hasOwnProperty.call(attests, p.game) ? attests[p.game] : undefined,
            )
            const up = glickoUpdateMicro(
              { ratingMicro: own.r, rdMicro: own.rd, volMicro: own.vol },
              [
                {
                  ratingMicro: opp.ratingMicro,
                  rdMicro: opp.rdMicro,
                  score: subjectScore(p.result, p.color),
                },
              ],
            )
            const n = own.n + 1
            const placed = n >= PARAMS_A4.placementGames ? 1 : 0
            const rd =
              placed === 1
                ? up.rdMicro
                : Math.max(up.rdMicro, PARAMS_A4.placementRdFloor * 1_000_000)
            ladders = { ...ladders, [lid]: { r: up.ratingMicro, rd, vol: up.volMicro, n, placed } }
          }
        }
      }
    } catch {
      // Total like the fold: an adversarial payload never crashes the
      // evidence walk, the vouched map simply does not advance (the fold's
      // own rated sub-step failed closed on the same input).
    }
    s = s2
  }
  return { ladders }
}
