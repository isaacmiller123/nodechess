// A4 trust signal (spec §7, brick 2b): the CHAIN-SHAPE trust score T. A pure,
// deterministic fold over a VERIFIED witnessed-lane event sequence plus a pure
// scoring function; both sides recompute anyone's T and verify a pairing was
// legal (mm/pairing.ts). Forensic terms (clock forensics, ACPL fit, engine
// match: Tier-1 judge outputs) re-weight in at A5; at A4 the PARAMS_A4
// trustW* weights cover chain shape only, and they sum to exactly 1_000_000.
//
// ── BODY-ONLY INVARIANT (A4 review fix A4-04: the load-bearing rule) ──────
// The embedded fold state (TrustInputs) depends ONLY on owner-signed event
// BODIES (ev.body + the owner's sig over them). trustInputsStep NEVER reads
// ev.wit. WHY: `wit` attaches OUTSIDE the event hash (types.ts SignedEvent:
// attestations are gathered asynchronously after the event is signed, and
// checkpoint cosignatures accumulate toward M over time), so two honest
// verifiers legitimately hold DIFFERENT wit subsets for the same chain. Any
// fold state that reads wit makes their recomputed states, and therefore the
// a4-v1 checkpoint stateDigest (ratings/fold.ts embeds TrustInputs verbatim).
// Diverge, and chain.ts's checkpoint audit escalates that divergence into a
// slashable 'bad-checkpoint' FRAUD verdict against a fully honest account.
// Body-only ⇒ every verifier folds identical bytes ⇒ one digest, forever.
// (The segment's embedded oppCkpt.wit is NOT ev.wit: it rides INSIDE the
// owner-signed segment payload, so it is covered by the event hash and is
// byte-identical for every verifier.) Wit-invariance of the fold is asserted
// in scripts/test-accounts-trust-mm.mjs (attach/strip arbitrary wit arrays ⇒
// identical state canonicalHash).
//
// Everything wit-derived moved OUT of the fold into TrustEvidence (A4-03):
// a read-time, verifier-side projection computed by trustEvidenceOf(chain,
// eligible?), which cryptographically VERIFIES every attestation signature it
// counts and is NEVER embedded in any checkpoint state. trustT takes it as an
// optional argument; absent evidence degrades honestly (exact neutrals
// documented below), it never forges.
//
// ── ELIGIBILITY, the second half of A4-03/A4-05 ────────────────────────────
// Signature validity ≠ witness ELIGIBILITY: any sybil mints valid-signing
// keys for free, so a term that can RAISE T on valid signatures alone is
// self-mintable (the review's exact attacks: 3 backdated self-signed
// attestations saturate age; N self-cosigned oppCkpts + a self-run wstream
// key mint full-weight diversity: both on verifyChain-OK chains). The §0
// rule is therefore: EVERY score-RAISING wit-derived term is EARNED only
// through attesters/cosigners/witnesses the VERIFIER recognizes as eligible,
// the `eligible: WitnessEligibility` predicate (types.ts), resolved by the
// caller from its own NodeDirectory + §4 floors (witness/eligibility.ts).
// Without the predicate (or for keys it rejects): age has NO basis (0) and
// every diversity proxy is 0. Exactly the fresh-account neutral, so an
// eligibility-blind verifier can never be inflated. ckpt-cosig cleanliness
// is the one wit-derived term that is bounded ABOVE by its absent-evidence
// neutral (1e6): self-minted cosigners can only ever fail to LOWER it, so
// sig-only counting stays safe there and the predicate merely sharpens it.
// The predicate is read-time verifier context and must NEVER reach the fold
// (A4-04): two verifiers with different directories legitimately compute
// different T: weaker-is-safer, exactly like differing wit subsets.
//
// STATE SHAPE CONTRACT (frozen: builder 2a embeds `trust: TrustInputs` in
// the a4-v1 checkpoint fold): TrustInputs is a CanonicalObject whose every
// leaf is a non-negative safe INTEGER. BOUNDED SIZE: the only unbounded-
// looking member is the per-opponent `div` map, and it is windowed to the
// trailing PARAMS_A4.trustDivWindow (=W) witnessed events with DETERMINISTIC
// EAGER PRUNING. Exactly reputation.ts's repPairWindow discipline: every
// state-MODIFYING trustInputsStep first prunes `div` entries with h <
// evHeight − W, so the map holds at most W+1 entries and the state bytes are
// a pure function of the witnessed event sequence (never of when a caller
// happened to fold). Pass-through events (personal lane, unknown or
// irrelevant witnessed types, malformed payloads, segments that fail
// verifySegmentEvent) return the SAME state reference (no prune, no clone)
// so pass-through is trivially byte-stable and pruning stays deterministic.
//
// RELEVANT EVENTS (everything else passes through unchanged):
//  segment: opponent-diversity + cadence counters, ONLY when
//            verifySegmentEvent(ev) === null (the FULL segment.ts gate:
//            event sig, witness terminal sig incl. the A4 rated binding,
//            opp ≠ root, and (when present) verifyEmbeddedOppCkpt; A4
//            review fixes A4-05/A4-06). An unverifiable segment contributes
//            NOTHING (pass-through): on a verifyChain-accepted chain such a
//            segment cannot exist anyway (chain.ts rejects it), so the gate
//            changes no verdict on valid chains while making the fold safe
//            standalone;
//  ckpt:     cadence counters only (payload must satisfy zCheckpointPayload).
//            Cosigner diversity is wit-derived and therefore lives in
//            TrustEvidence now, NOT here (A4-04);
//  genesis: pass-through (the age anchor was wit-derived; it lives in
//            TrustEvidence now).
//
// ── TERM FORMULAS (exact, integer; all sub-terms in micro-units [0, 1e6]) ──
//
// AGE (weight trustWAgeMicro = 0.15). From EVIDENCE, not fold state:
//   trustEvidenceOf scans the chain's FIRST TRUST_AGE_BASIS_EVENTS (3)
//   witnessed events (the chain's birth neighborhood: age measures when the
//   chain was BORN, so an established chain cannot mint a fresh anchor from a
//   later event; K = 3 tolerates an offline-created, unattested genesis whose
//   first witnessed play is the first attested event). Over those events:
//     ageBasisWts  = the minimum wts of any VALID attestation (ed25519 over
//                    canonicalBytes({e: eventId(body), epoch, w, wts}) under
//                    its own `w`. The witness/attest.ts byte contract) whose
//                    signer the verifier's `eligible` predicate ACCEPTS
//                    (A4-03: a valid-but-unrecognized signer counts as
//                    absent: sybil keys anchor nothing);
//     ageAttesters = distinct valid ELIGIBLE attesting keys on the event that
//                    supplied that minimum (the basis event).
//   Then, with atWts the §4 witnessed evaluation time:
//     ageRaw = ageBasisWts unset ? 0
//            : min(1e6, floor(max(0, atWts − ageBasisWts) / TRUST_AGE_MS_PER_MICRO))
//     age    = ageAttesters ≥ TRUST_AGE_DIV_MIN ? ageRaw
//            : min(ageRaw, TRUST_AGE_THIN_CAP_MICRO)
//   The §4 diversity bound (age claims need ≥3 entanglement-distant
//   attesters) is enforced as ≥3 DISTINCT VALID ELIGIBLE signers. Forged
//   (invalid-sig) attestations count as absent, a thin (<3) basis caps age at
//   TRUST_AGE_THIN_CAP_MICRO. Entanglement-distance BETWEEN eligible
//   attesters and the subject sharpens further at A5 (forensic layer); the
//   caller's eligibility predicate already carries the §4 floors.
//   NO PREDICATE ⇒ NO basis ⇒ age = 0: age is EARNED through attestations
//   the verifier can vouch eligible, never presumed (likewise ABSENT
//   EVIDENCE ⇒ age = 0).
//   TRUST_AGE_MS_PER_MICRO = 15_552 ms per micro-unit ⇒ saturates at exactly
//   180 days (15_552_000_000 ms).
//
// OPPONENT DIVERSITY (weight trustWDiversityMicro = 0.30), entanglement-
// weighted per ACCOUNTS-PARAMS §Matchmaking: opponent o contributes
// T_o · min(1, entdist(o)/D₀), saturating log-style count. TWO LAYERS
// (A4-05): the FOLD records each opponent's POTENTIAL proxy `w` (body-only,
// deterministic, below), and the SCORE grants it only up to the verifier's
// ELIGIBILITY-VERIFIED evidence: per opponent the effective proxy is
//     w_eff = min(div[o].w, evidence.oppEligProxy[o] ?? 0)
// where oppEligProxy is trustEvidenceOf's chained per-opponent max of the
// SAME proxy formula recomputed counting ONLY roster-eligible material: a
// segment earns 0 when its wstream witness key is not eligible (a self-run
// witness proves nothing), the FLOOR when it is eligible but no oppCkpt
// rides, and the full proxy only when ≥ ckptM of the oppCkpt's verified
// cosigners are eligible AND that eligible subset spans ≥ 3 distinct key
// prefixes (segment.ts's own diversity bound, re-applied to the recognized
// subset). No predicate / absent evidence ⇒ w_eff = 0 for every opponent.
// Diversity, like age, is EARNED through witnesses the verifier can vouch
// for, so a farm of self-witnessed or self-cosigned games scores a fresh
// account's 0 under EVERY verifier. The fold-side POTENTIAL, both terms
// derived from what the VERIFIED segment itself carries:
//   • opponent-trust proxy T_o ← the segment's EMBEDDED oppCkpt (the §6
//     pinned fold input), consumed ONLY under the verifySegmentEvent gate,
//     which (F1 semantics) runs verifyEmbeddedOppCkpt on any present oppCkpt:
//     root-binding oppCkpt.body.root === p.opp (A4-06: a borrowed checkpoint
//     of some OTHER real account can never proxy for a differently-named
//     opp), event sig + inline-cert provenance, and ≥ PARAMS_A2.ckptM (4)
//     distinct, prefix-diverse cosigner attestations EVERY one carrying a
//     valid signature. Under that gate every entry of oppCkpt.wit is a
//     verified distinct cosigner (one invalid/duplicate entry fails the whole
//     segment), so the cosig sub-term counts wit.length, capped:
//       proxy = min(1e6, TRUST_OPP_CKPT_BASE_MICRO                     [250k]
//                       + TRUST_OPP_COSIG_STEP_MICRO                   [100k]
//                         · min(TRUST_OPP_COSIG_CAP [4], |oppCkpt.wit|)
//                       + floor(TRUST_OPP_HEIGHT_SPAN_MICRO [350k]
//                               · min(oppCkpt.payload.through,
//                                     TRUST_OPP_HEIGHT_SAT [200])
//                               / TRUST_OPP_HEIGHT_SAT))
//     (a verified oppCkpt always has ≥ 4 cosigners, so its cosig component is
//     saturated: proxy ∈ [650k, 1e6], driven by chain depth `through`).
//   • PROXY FLOOR (A4-05): a VERIFIED segment with NO oppCkpt (young/unknown
//     opponent) contributes TRUST_OPP_PROXY_FLOOR_MICRO = 50_000, 1/20 of an
//     established opponent. A real witnessed game against a young opponent is
//     still evidence of play; a FORGED game contributes exactly 0 because the
//     segment itself fails the verifySegmentEvent gate (pass-through). The
//     floor is small enough that fresh no-checkpoint opponents cannot lift T
//     over the island gate at any realistic count (10 fresh opponents ⇒ div
//     58_823 ⇒ T ≈ 567k < 600k gate), and the entanglement discount below
//     still divides repeat play away.
//   • entanglement-distance saturation ← the REPEAT-PLAY discount:
//     entSat(n) = floor(1e6 / n) where n = games vs that opponent counted
//     while its window entry lived. Heavy repeat play against one root is
//     exactly what "closely entangled" means on chain shape; a farm replaying
//     one puppet divides its own contribution away.
//   Per-opponent contribution c_o = floor(w_o · entSat(n_o) / 1e6) with
//   w_o = MAX proxy seen for o inside the window. Sum S = Σ c_o (micro).
//   Saturating count (log-style concave, pure integer):
//     div = floor(1e6 · S / (S + TRUST_DIV_SAT_MICRO))    [TRUST_DIV_SAT = 8]
//   ⇒ 8 fully-weighted distinct opponents ⇒ 500k; 24 ⇒ 750k; →1e6 asymptote.
//
// FORK/CHECKPOINT CLEANLINESS (weight trustWCleanlinessMicro = 0.25). Two
// halves, split by provenance (A4-04):
//   cadence (BODY-ONLY, in the fold): wn = verified segments folded; gSince =
//   segments since the last ckpt; ckLateEv = segments that arrived while
//   gSince > N_CKPT (each overdue game counts once); ckN = ckpt events.
//     cadence = wn === 0 ? 1e6 : floor(1e6 · (wn − ckLateEv) / wn)
//   cosig (WIT-DERIVED, in TrustEvidence): over each ckpt event's VALID
//   cosigner attestations (same verified byte contract as age; the chain
//   root's own key never counts as a cosigner):
//     ckptCosigMicro = ckN === 0 ? 1e6
//                    : floor(1e6 · Σ min(4, validDistinct(ckpt)) / (4 · ckN))
//     clean = floor((cadence + cosig) / 2)
//   ABSENT EVIDENCE ⇒ cosig = TRUST_COSIG_NEUTRAL_MICRO = 1_000_000 (the
//   exact neutral: same presumed-innocent value as a chain with no ckpt
//   events: cosignatures a verifier has not gathered/verified are unknown,
//   not misbehavior; forged cosig attestations count as absent, so they can
//   only LOWER the verified score vs neutral, never raise anything).
//   Presumed-innocent (like 1c's misconduct classes): these measure observed
//   MISBEHAVIOR of the chain shape, so an empty chain starts clean at 1e6 and
//   only late checkpoints / thin verified cosig sets lower it.
//
// COMPLETION HYGIENE (weight trustWCompletionMicro = 0.30): derived from the
// 1c RepState counters at score time (trustT takes `rep`; TrustInputs never
// duplicates 1c's counting):
//     D   = rep.seg + rep.abort + rep.noshow
//     hyg = D === 0 ? 1e6 : floor(1e6 · (rep.seg − rep.drop) / D)
//
// TOTAL:
//     T = floor((trustWAgeMicro·age + trustWDiversityMicro·div
//              + trustWCleanlinessMicro·clean + trustWCompletionMicro·hyg)
//              / 1e6).                     Integer in [0, 1_000_000].
//   Every product ≤ 3e11 and the sum ≤ 1e12: exact in float64. ROUNDING is
//   floor division of non-negative safe integers at every step (Math.floor of
//   an IEEE quotient of integers < 2^53: exact, see reputation.ts's rounding
//   note), never Math.exp/log/pow.
//   Documented baseline: a fresh chain scores exactly 550_000 (age 0 + div 0
//   + clean 1e6 + hyg 1e6): BELOW islandGateMicro (600_000), so brand-new
//   accounts sit inside the island band until age and diversity are earned.
//   The baseline is identical with or without evidence (a fresh chain has no
//   attestations to verify).
//
// Platform-neutral: no `node:` imports, no DOM, no ambient time (atWts is an
// argument), no Math.exp/log/pow.

import { canonicalBytes, type CanonicalObject } from '../codec'
import { eventId, zCheckpointPayload } from '../events'
import { verifySigB64u } from '../hash'
import type { RepState } from '../ratings/reputation'
import { PARAMS_A4 } from '../ratings/params'
import { OPP_CKPT_PREFIX_DIVERSITY_MIN, verifySegmentEvent } from '../segment'
import type { SegmentPayload } from '../storage/types'
import { PARAMS_A2 } from '../witness/params'
import {
  N_CKPT,
  type B64u,
  type Chain,
  type EventId,
  type SignedEvent,
  type WitnessAttestation,
  type WitnessEligibility,
} from '../types'

// ---------------------------------------------------------------------------
// Constants (documented in the header; exported for the suite)
// ---------------------------------------------------------------------------

/** Age saturation: 1 micro-unit per this many ms ⇒ full at exactly 180 days. */
export const TRUST_AGE_MS_PER_MICRO = 15_552
/** Distinct VALID attesting witnesses needed on the age basis for full age
 * credit (§4 diversity-bound witnessed time). */
export const TRUST_AGE_DIV_MIN = 3
/** Age cap when the basis was thin (< TRUST_AGE_DIV_MIN valid attesters) or
 * evidence is absent (then age is 0, trivially under the cap). */
export const TRUST_AGE_THIN_CAP_MICRO = 250_000
/** K: only the chain's first K witnessed events can anchor age (see header). */
export const TRUST_AGE_BASIS_EVENTS = 3
/** Opponent-trust proxy: base credit for a VERIFIED embedded checkpoint. */
export const TRUST_OPP_CKPT_BASE_MICRO = 250_000
/** Opponent-trust proxy: credit per verified oppCkpt cosigner (capped). */
export const TRUST_OPP_COSIG_STEP_MICRO = 100_000
/** Cosigner-count cap (the M of the M-of-N cosign rule, ACCOUNTS-PARAMS §Witness). */
export const TRUST_OPP_COSIG_CAP = 4
/** Opponent-trust proxy: span awarded for chain depth (oppCkpt `through`). */
export const TRUST_OPP_HEIGHT_SPAN_MICRO = 350_000
/** Chain depth (witnessed events) at which the height component saturates. */
export const TRUST_OPP_HEIGHT_SAT = 200
/** Proxy for a VERIFIED segment with no oppCkpt: a young/unknown opponent
 * (A4-05 floor: 1/20 of an established opponent, see header). */
export const TRUST_OPP_PROXY_FLOOR_MICRO = 50_000
/** Diversity saturation: micro-sum at the half-way point (= 8 full opponents). */
export const TRUST_DIV_SAT_MICRO = 8_000_000
/** Neutral cosig-cleanliness when no TrustEvidence is supplied (header). */
export const TRUST_COSIG_NEUTRAL_MICRO = 1_000_000

// ---------------------------------------------------------------------------
// State (BODY-ONLY: see the A4-04 invariant in the header)
// ---------------------------------------------------------------------------

/** One windowed per-opponent entry: last-seen height, games counted while the
 * entry lived, best opponent-trust proxy seen (all integers). */
export interface DivEntry extends CanonicalObject {
  h: number
  n: number
  w: number
}

/** Trust fold state. Integer leaves only, window-bounded, derived from
 * owner-signed event bodies ONLY (never ev.wit, A4-04). */
export interface TrustInputs extends CanonicalObject {
  v: 1
  /** Verified segments folded (cadence denominator). */
  wn: number
  /** Segments since the last ckpt event. */
  gSince: number
  /** Ckpt events folded. */
  ckN: number
  /** Segments that arrived while gSince > N_CKPT (cadence violations). */
  ckLateEv: number
  /** Windowed per-opponent map, keyed by opponent root (b64u). */
  div: { [opp: string]: DivEntry }
}

export function trustInputsInit(): TrustInputs {
  return { v: 1, wn: 0, gSince: 0, ckN: 0, ckLateEv: 0, div: {} }
}

// ---------------------------------------------------------------------------
// Verified read-time evidence (A4-03: NEVER embedded in fold state)
// ---------------------------------------------------------------------------

/**
 * The wit-derived trust evidence, computed by a VERIFIER at read time from
 * the attestations it actually holds, every counted signature checked. Two
 * honest verifiers with different wit subsets may compute different evidence.
 * That is fine here (evidence is a read-side input to trustT, weaker-is-
 * safer) and is exactly why none of this may live in TrustInputs (A4-04:
 * embedded state must be byte-identical for every verifier).
 */
export interface TrustEvidence {
  /** Minimum VALID + ELIGIBLE attestation wts over the chain's first
   * TRUST_AGE_BASIS_EVENTS witnessed events; absent when none qualified
   * (including whenever no eligibility predicate was supplied; A4-03). */
  ageBasisWts?: number
  /** Distinct valid ELIGIBLE attesting keys on the basis event (0 = none). */
  ageAttesters: number
  /** Verified ckpt cosigner-diversity score, micro [0, 1e6] (header formula;
   * TRUST_COSIG_NEUTRAL_MICRO when the chain has no ckpt events). Bounded
   * above by the neutral, so sig-only counting is safe without a predicate;
   * with one, only eligible cosigners count. */
  ckptCosigMicro: number
  /** A4-05: per-opponent ELIGIBILITY-VERIFIED proxy (header formula).
   * Chained over the SAME trustDivWindow discipline as TrustInputs.div, so
   * keys align with the fold's div map when both cover the same chain. The
   * score uses min(div[o].w, oppEligProxy[o] ?? 0). Empty when no
   * eligibility predicate was supplied (nothing is vouched ⇒ nothing earns). */
  oppEligProxy: { [opp: string]: number }
}

/**
 * ed25519 check of one attestation over canonicalBytes({e, epoch, w, wts})
 * under its own `w`. The EXACT byte contract of witness/attest.ts
 * attestBytes/verifyAttestation. Restated locally because importing
 * witness/attest here would close the cycle mm/trust → witness/attest →
 * checkpoint → ratings/fold → mm/trust. Returns the valid entries only;
 * never throws (malformed entries fail closed).
 */
function validAttestations(ev: SignedEvent): { w: B64u; wts: number }[] {
  const wit = (ev as { wit?: unknown }).wit
  if (!Array.isArray(wit) || wit.length === 0) return []
  let id: EventId
  try {
    id = eventId(ev.body)
  } catch {
    return []
  }
  const out: { w: B64u; wts: number }[] = []
  for (const a of wit) {
    if (typeof a !== 'object' || a === null) continue
    const w = (a as { w?: unknown }).w
    const wts = (a as { wts?: unknown }).wts
    const epoch = (a as { epoch?: unknown }).epoch
    const sig = (a as { sig?: unknown }).sig
    if (typeof w !== 'string' || typeof sig !== 'string') continue
    if (typeof wts !== 'number' || !Number.isSafeInteger(wts) || wts < 0) continue
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) continue
    let msg: Uint8Array
    try {
      msg = canonicalBytes({ e: id, epoch, w, wts })
    } catch {
      continue
    }
    if (verifySigB64u(sig, msg, w)) out.push({ w, wts })
  }
  return out
}

/**
 * The eligibility-verified proxy one counted segment earns (header formula,
 * evidence side. The fold-side twin is oppProxyMicro): 0 without a predicate
 * or when the wstream witness key is not eligible; the FLOOR for an eligible-
 * witnessed game with no oppCkpt; the full proxy only when ≥ ckptM of the
 * (already signature-verified, distinct) cosigners are eligible AND the
 * eligible subset spans ≥ OPP_CKPT_PREFIX_DIVERSITY_MIN key prefixes.
 */
function oppEligProxyMicro(p: SegmentPayload, eligible: WitnessEligibility | undefined): number {
  if (eligible === undefined) return 0
  if (!eligible(p.wstream.wkey)) return 0
  const c = p.oppCkpt as SignedEvent | undefined
  if (c === undefined) return TRUST_OPP_PROXY_FLOOR_MICRO
  const wit = (c as { wit?: WitnessAttestation[] }).wit
  if (!Array.isArray(wit)) return TRUST_OPP_PROXY_FLOOR_MICRO
  // Under the verifySegmentEvent gate every wit entry is a DISTINCT VALID
  // cosigner: eligibility is the only thing left to judge here.
  const elig = wit.filter((a) => eligible(a.w))
  const prefixes = new Set<string>()
  for (const a of elig) prefixes.add(a.w.slice(0, 2))
  if (elig.length < PARAMS_A2.ckptM || prefixes.size < OPP_CKPT_PREFIX_DIVERSITY_MIN)
    return TRUST_OPP_PROXY_FLOOR_MICRO
  const through = (c.body.payload as { through: number }).through
  const cosig = Math.min(TRUST_OPP_COSIG_CAP, elig.length)
  const height = idiv(
    TRUST_OPP_HEIGHT_SPAN_MICRO * Math.min(through, TRUST_OPP_HEIGHT_SAT),
    TRUST_OPP_HEIGHT_SAT,
  )
  return Math.min(1_000_000, TRUST_OPP_CKPT_BASE_MICRO + TRUST_OPP_COSIG_STEP_MICRO * cosig + height)
}

/**
 * Compute the verified trust evidence for a chain (header formulas): the age
 * basis over the first TRUST_AGE_BASIS_EVENTS witnessed events, the ckpt
 * cosigner-diversity score, and the per-opponent eligibility-verified proxy
 * map: counting ONLY attestations whose signatures verify AND (for every
 * score-RAISING term) whose signer the verifier's `eligible` predicate
 * accepts (A4-03/05: signature validity ≠ eligibility; without the
 * predicate, age has no basis and every diversity proxy is 0; only the
 * neutral-bounded cosig-cleanliness term keeps sig-only counting). Pure and
 * total (never throws); forged attestations count as absent. The proxy map
 * mirrors trustInputsStep's window discipline exactly (prune at height −
 * trustDivWindow on counted segments and valid ckpts; chained per-opponent
 * max while the entry lives), so its keys align with the fold's div map.
 */
export function trustEvidenceOf(chain: Chain, eligible?: WitnessEligibility): TrustEvidence {
  const w = chain.events
    .filter((e) => e.body.lane === 'w')
    .sort((a, b) => a.body.height - b.body.height)
  let ageBasisWts: number | undefined
  let ageAttesters = 0
  if (eligible !== undefined) {
    for (const ev of w.slice(0, TRUST_AGE_BASIS_EVENTS)) {
      const atts = validAttestations(ev).filter((a) => eligible(a.w))
      if (atts.length === 0) continue
      let min = atts[0].wts
      for (const a of atts) if (a.wts < min) min = a.wts
      if (ageBasisWts === undefined || min < ageBasisWts) {
        ageBasisWts = min
        const keys = new Set<string>()
        for (const a of atts) keys.add(a.w)
        ageAttesters = keys.size
      }
    }
  }
  let ckN = 0
  let ckCosSum = 0
  /** Chained eligibility-verified proxy entries (mirror of TrustInputs.div). */
  let elig: { [opp: string]: { h: number; w: number } } = {}
  const pruneElig = (minH: number): void => {
    const out: { [opp: string]: { h: number; w: number } } = {}
    for (const k of Object.keys(elig)) if (elig[k].h >= minH) out[k] = elig[k]
    elig = out
  }
  for (const ev of w) {
    if (ev.body.type === 'ckpt') {
      const keys = new Set<string>()
      // The subject's own root key never counts as a checkpoint cosigner;
      // with a predicate, neither does an ineligible key.
      for (const a of validAttestations(ev))
        if (a.w !== chain.root && (eligible === undefined || eligible(a.w))) keys.add(a.w)
      ckN++
      ckCosSum += Math.min(TRUST_OPP_COSIG_CAP, keys.size)
      // Mirror stepCkpt's prune point (schema-valid ckpts only).
      if (zCheckpointPayload.safeParse(ev.body.payload).success)
        pruneElig(ev.body.height - PARAMS_A4.trustDivWindow)
      continue
    }
    if (ev.body.type !== 'segment') continue
    // Mirror stepSegment's gate + prune point exactly: only a segment the
    // FOLD counts can earn evidence, and pass-through segments prune nothing.
    if (verifySegmentEvent(ev) !== null) continue
    const p = ev.body.payload as unknown as SegmentPayload // parse guaranteed by the gate
    pruneElig(ev.body.height - PARAMS_A4.trustDivWindow)
    const prev = elig[p.opp]
    const proxy = oppEligProxyMicro(p, eligible)
    elig[p.opp] = {
      h: ev.body.height,
      w: Math.max(prev !== undefined ? prev.w : 0, proxy),
    }
  }
  const ckptCosigMicro =
    ckN === 0 ? TRUST_COSIG_NEUTRAL_MICRO : idiv(1_000_000 * ckCosSum, TRUST_OPP_COSIG_CAP * ckN)
  const oppEligProxy: { [opp: string]: number } = {}
  for (const k of Object.keys(elig)) oppEligProxy[k] = elig[k].w
  return {
    ...(ageBasisWts !== undefined ? { ageBasisWts } : {}),
    ageAttesters,
    ckptCosigMicro,
    oppEligProxy,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Exact floor division of non-negative safe integers. */
function idiv(num: number, den: number): number {
  return Math.floor(num / den)
}

/** Prune `div` entries with h < minH. The eager window rule (see header). */
function pruneDiv(div: { [opp: string]: DivEntry }, minH: number): { [opp: string]: DivEntry } {
  const out: { [opp: string]: DivEntry } = {}
  for (const k of Object.keys(div)) {
    const e = div[k]
    if (e.h >= minH) out[k] = e
  }
  return out
}

/**
 * The A4 opponent-trust proxy for a segment that PASSED verifySegmentEvent
 * (see header). Only reachable under that gate, so a present oppCkpt has
 * passed verifyEmbeddedOppCkpt (F1 semantics): root === p.opp, verified event
 * sig, and every wit entry a distinct VALID cosigner: wit.length IS the
 * verified cosigner count (one bad entry would have failed the segment).
 */
function oppProxyMicro(oppCkpt: SignedEvent | undefined): number {
  if (oppCkpt === undefined) return TRUST_OPP_PROXY_FLOOR_MICRO
  const through = (oppCkpt.body.payload as { through: number }).through
  const wit = (oppCkpt as { wit?: unknown[] }).wit
  const cosig = Math.min(TRUST_OPP_COSIG_CAP, Array.isArray(wit) ? wit.length : 0)
  const height = idiv(
    TRUST_OPP_HEIGHT_SPAN_MICRO * Math.min(through, TRUST_OPP_HEIGHT_SAT),
    TRUST_OPP_HEIGHT_SAT,
  )
  return Math.min(1_000_000, TRUST_OPP_CKPT_BASE_MICRO + TRUST_OPP_COSIG_STEP_MICRO * cosig + height)
}

// ---------------------------------------------------------------------------
// The fold step
// ---------------------------------------------------------------------------

/**
 * Fold one event. Pure and total: never throws, never mutates `s`; events
 * that do not affect trust (personal lane, irrelevant/unknown witnessed
 * types, malformed payloads, segments failing verifySegmentEvent) return `s`
 * UNCHANGED: the same object reference. Reads ev.body (+ its owner sig via
 * verifySegmentEvent) ONLY. Never ev.wit (A4-04 body-only invariant).
 */
export function trustInputsStep(s: TrustInputs, ev: SignedEvent): TrustInputs {
  try {
    const b = ev.body
    if (b.lane !== 'w') return s
    switch (b.type) {
      case 'segment':
        return stepSegment(s, ev)
      case 'ckpt':
        return stepCkpt(s, ev)
      default:
        return s
    }
  } catch {
    // Adversarial payloads engineered to crash deeper layers. Fail closed.
    return s
  }
}

function stepSegment(s: TrustInputs, ev: SignedEvent): TrustInputs {
  // The FULL standalone segment gate (A4-05, F1 semantics): event signature,
  // witness terminal signature (incl. the atomic rated binding), opp ≠ root,
  // and verifyEmbeddedOppCkpt on any present oppCkpt (which enforces the
  // A4-06 root-binding oppCkpt.body.root === p.opp). Fail ⇒ pass-through:
  // an unverifiable segment feeds NOTHING here.
  if (verifySegmentEvent(ev) !== null) return s
  const p = ev.body.payload as unknown as SegmentPayload // parse guaranteed by the gate
  const div = pruneDiv(s.div, ev.body.height - PARAMS_A4.trustDivWindow)
  const prev = div[p.opp]
  const proxy = oppProxyMicro(p.oppCkpt as SignedEvent | undefined)
  const entry: DivEntry = {
    h: ev.body.height,
    n: (prev !== undefined ? prev.n : 0) + 1,
    w: Math.max(prev !== undefined ? prev.w : 0, proxy),
  }
  const gSince = s.gSince + 1
  return {
    ...s,
    wn: s.wn + 1,
    gSince,
    ckLateEv: s.ckLateEv + (gSince > N_CKPT ? 1 : 0),
    div: { ...div, [p.opp]: entry },
  }
}

function stepCkpt(s: TrustInputs, ev: SignedEvent): TrustInputs {
  const res = zCheckpointPayload.safeParse(ev.body.payload)
  if (!res.success) return s
  return {
    ...s,
    gSince: 0,
    ckN: s.ckN + 1,
    div: pruneDiv(s.div, ev.body.height - PARAMS_A4.trustDivWindow),
  }
}

// ---------------------------------------------------------------------------
// Terms (each pure, integer, micro-units [0, 1e6]) + the total
// ---------------------------------------------------------------------------

/** AGE term from VERIFIED evidence (header formula). Absent evidence or no
 * verified basis ⇒ 0. Age is earned through valid attestations, never
 * presumed. `atWts` is the §4 witnessed evaluation time. */
export function trustAgeMicro(evidence: TrustEvidence | undefined, atWts: number): number {
  if (evidence === undefined || evidence.ageBasisWts === undefined) return 0
  const ageMs = Math.max(0, atWts - evidence.ageBasisWts)
  const raw = Math.min(1_000_000, idiv(ageMs, TRUST_AGE_MS_PER_MICRO))
  return evidence.ageAttesters >= TRUST_AGE_DIV_MIN ? raw : Math.min(raw, TRUST_AGE_THIN_CAP_MICRO)
}

/** OPPONENT-DIVERSITY term (see header formula). The fold's per-opponent
 * proxy is the POTENTIAL; each opponent scores min(w, evidence-verified
 * proxy). Absent evidence (or a missing per-opponent entry: only reachable
 * when the evidence was computed over a different chain than the fold state,
 * a caller error that must fail SAFE) ⇒ that opponent earns 0 (A4-05:
 * diversity is earned through eligibility-verified witnesses, like age). */
export function trustDiversityMicro(inputs: TrustInputs, evidence?: TrustEvidence): number {
  let sum = 0
  for (const k of Object.keys(inputs.div)) {
    const e = inputs.div[k]
    const vouched =
      evidence !== undefined &&
      typeof evidence.oppEligProxy === 'object' &&
      evidence.oppEligProxy !== null &&
      Object.prototype.hasOwnProperty.call(evidence.oppEligProxy, k)
        ? evidence.oppEligProxy[k]
        : 0
    const w = Math.min(e.w, Math.max(0, vouched))
    sum += idiv(w * idiv(1_000_000, e.n), 1_000_000)
  }
  if (sum === 0) return 0
  return idiv(1_000_000 * sum, sum + TRUST_DIV_SAT_MICRO)
}

/** FORK/CHECKPOINT-CLEANLINESS term: body-only cadence from the fold state +
 * verified cosigner diversity from evidence (header formula). Absent evidence
 * ⇒ cosig = TRUST_COSIG_NEUTRAL_MICRO (1e6, the exact neutral). */
export function trustCleanlinessMicro(inputs: TrustInputs, evidence?: TrustEvidence): number {
  const cadence =
    inputs.wn === 0 ? 1_000_000 : idiv(1_000_000 * (inputs.wn - inputs.ckLateEv), inputs.wn)
  const cosig =
    evidence === undefined
      ? TRUST_COSIG_NEUTRAL_MICRO
      : Math.min(1_000_000, Math.max(0, evidence.ckptCosigMicro))
  return idiv(cadence + cosig, 2)
}

/** COMPLETION-HYGIENE term from the 1c RepState counters (see header formula). */
export function trustCompletionMicro(rep: RepState): number {
  const d = rep.seg + rep.abort + rep.noshow
  if (d === 0) return 1_000_000
  return idiv(1_000_000 * Math.max(0, rep.seg - rep.drop), d)
}

/**
 * The §7 chain-shape trust score T: micro-units, integer in [0, 1_000_000].
 * `atWts` is witnessed time (§4); the caller supplies it: never ambient. For
 * pairing-legality it MUST be the pairing record's witnessed timestamp, the
 * same instant on both sides (mm/pairing.ts pairingLegal, A4-16). `evidence`
 * is the verifier's OWN trustEvidenceOf(chain, eligible) output; absent
 * evidence ⇒ age 0 AND diversity 0 (both EARNED through eligibility-verified
 * witnesses, never presumed: A4-03/05) and cosig-cleanliness neutral
 * (TRUST_COSIG_NEUTRAL_MICRO = 1e6, presumed-innocent). The exact neutrals
 * documented in the header.
 */
export function trustT(
  inputs: TrustInputs,
  rep: RepState,
  atWts: number,
  evidence?: TrustEvidence,
): number {
  const P = PARAMS_A4
  const sum =
    P.trustWAgeMicro * trustAgeMicro(evidence, atWts) +
    P.trustWDiversityMicro * trustDiversityMicro(inputs, evidence) +
    P.trustWCleanlinessMicro * trustCleanlinessMicro(inputs, evidence) +
    P.trustWCompletionMicro * trustCompletionMicro(rep)
  return Math.min(1_000_000, Math.max(0, idiv(sum, 1_000_000)))
}
