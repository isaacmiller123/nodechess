// A4 reputation fold (spec §6b): the deterministic conduct-standing fold over
// witnessed-lane events, per PARAMS_A4 [SIGN-OFF] weights. Composes into the
// 2a a4-v1 checkpoint fold as `rep: RepState` behind the exact state-shape
// contract below. Fully public, visible from game 1 (no hiding: hiding is a
// §6 RATING rule; conduct always renders).
//
// STATE SHAPE CONTRACT (wave-2 checkpoint fold): RepState is a CanonicalObject
// whose every leaf value is a non-negative safe INTEGER, plain counters plus
// four windowed maps: the `pair` entry map (keyed by "<game>:<opp>", both
// 43-char b64u, ':' is outside the b64u alphabet so the key is unambiguous;
// each entry is {h: segment witnessed height, f: PAIR_* bitmask}), the
// `pend` pending-rematch map (same key shape for the CLAIMED rematch game;
// value = the claim's witnessed height, A4-13), the `ob` open-pairing-
// obligation map (same key shape; value = the pairing's witnessed height,
// A5 J5), and the `com` per-opponent commend-decay map (keyed by the opp
// root; each entry {h: last counted commend height, k: counted commends from
// that opp while the entry lived}, A4-14 entanglement decay). No floats, no
// strings-as-values, no derived quantities: every rate and weight is applied
// inside repScore, in integer arithmetic. canonicalBytes sorts object keys,
// so insertion order can never reach the state bytes.
//
// WITNESS AUTHENTICATION (A4 review fix A4-07): stepSegment counts a segment
// ONLY when verifySegmentEvent(ev) === null, the FULL standalone segment.ts
// gate: event signature, witness terminal signature (including the atomic F1
// RatedBinding {kind, tc, players, reason} on any kind/tc-bearing segment),
// opp ≠ root, and verifyEmbeddedOppCkpt on any present oppCkpt. A segment
// that fails the gate feeds NOTHING (pass-through, same reference). On a
// verifyChain-accepted chain such a segment cannot exist (chain.ts emits
// 'bad-segment'), so the gate changes no verdict on valid chains while making
// the fold safe standalone. Consequence (the A4-08 fold-side consumption): on
// every counted RATED segment the (result, color, opp, reason) quadruple is
// witness-authenticated. The binding derives players from (root, opp, color)
// and the witness signed players + reason, so the misconduct axes below fold
// witness-signed facts, never self-asserted text.
//
// LEGACY SEGMENTS (documented decision): a kind/tc-LESS segment whose legacy
// wstream signature verifies (a real pre-A4 witnessed game: the witness
// signed only {g, result, plies, transcript}) counts toward `seg` (the
// completion denominator: the game demonstrably happened under a witness) but
// NEVER toward the misconduct axes (drop/toLoss/rsLoss: its reason and color
// are UNBOUND, so classifying them would fold self-asserted values; presumed-
// innocent neutral, consistent with the fold's misconduct philosophy) and
// NEVER toward the merit axes (its `opp` is unbound: a real legacy game
// relabeled onto a sybil opp must not unlock commend/rematch credit). In the
// pair map this is the PAIR_BOUND flag: only bound (witness-authenticated)
// segments set it, and commends/rematch references require it.
//
// WINDOWED COMPACTION (PARAMS_A4.repPairWindow = W): a commend or
// rematch-accept may only reference a segment whose witnessed height is
// within W events of the referencing event's height (evHeight − segHeight ≤
// W; exactly W is valid). Every state-MODIFYING repStep prunes `pair` AND
// `pend` entries with h < evHeight − W before applying the event, so RepState
// memory is O(W), never O(games), bounded checkpoint state. The rule that
// expires the memory IS the rule that expires validity: a reference to a
// pruned entry is by construction outside the window, so the lookup miss
// rejects it exactly where the window rule would. There is NO gap where a
// pruned entry lets a duplicate or late commend through. (Consequence: the
// ≤1-per-(opp,game) / ≤1-per-(prior,opp) dedup guarantees are per-WINDOW:
// a re-sent commend after the window is STILL ignored, not because the dedup
// bit survives but because its segment reference fails the window rule. A
// re-appended SEGMENT after the window is rejected one layer down: verifyChain
// forbids a repeated game key chain-wide, 'dup-game', A4-11.)
// A4-11 RECYCLE BOUNDARY, stated for the record: segment replay (any window)
// dies at the chain layer ('dup-game'); opp-relabel recycling died with F1
// (the witness signs players-by-color on every bound segment, and unbound
// segments feed no axis a relabel could farm); commend/rematch-countersig
// replay dies here (commendBytes/rematchBytes carry no height, but counting
// requires the in-window BOUND segment reference, and the game key can never
// re-enter the chain). No known residual recycle vector remains.
// Pass-through events (personal lane, unknown types, malformed or rejected
// payloads) return the state UNCHANGED (same reference, no prune), so the
// pass-through contract stays exact and pruning stays deterministic: which
// entries are present is a pure function of the witnessed event sequence.
//
// FOLD ORDER: witnessed-lane events in chain (height) order, the order
// verifyChain walks and checkpoints cover. Personal-lane events and unknown/
// irrelevant witnessed types pass through UNCHANGED (same object reference).
// repStep is pure and total: it never throws on any input event (malformed
// payloads are silently ignored; the chain-verification layer, not the fold,
// is where malformation is an error), and the same (state, event) always
// yields the same state bytes.
//
// INPUT SEMANTICS (docs/ACCOUNTS-SPEC.md §6b + types.ts contracts):
//  segment:   one witnessed game, counted ONLY under the A4-07 gate above.
//             Counted once per (game, opp); a duplicate (game, opp) segment
//             is ignored. On BOUND segments `reason` classifies it:
//               drop      ('disconnect' | 'abandon'): counted against the
//                         subject only when the SUBJECT lost (result vs
//                         color): winning because the opponent vanished is
//                         not the subject's misconduct;
//               timeout   ('flag' | 'timeout'): a completed game, tracked
//                         (subject losses only) for the timeout-vs-resign
//                         distinction;
//               resign    ('resign'): subject losses tracked as the graceful
//                         complement of timeout;
//               completed (anything else: 'checkmate', 'stalemate',
//                         'agreement', …); unknown reasons classify as
//                         completed (a witnessed result IS a finished game).
//             LEGACY (unbound) segments count `seg` only (header decision).
//             A counted BOUND segment for (game, opp) also SETTLES an
//             in-window pending rematch claim for that exact pair (below).
//  conduct:   witnessed conduct facts (subject-appended):
//               abort          → abort counter (the completion class);
//               noshow         → noshow counter;
//               rematch-accept → A4-13, counts ONLY when ALL of:
//                 (a) verifyRematchAccept proves the COUNTERPARTY's inner
//                     signature over rematchBytes({prior, game, from: opp,
//                     to: root}) + inline certs (conduct.ts), a unilateral
//                     self-claim never counts;
//                 (b) a BOUND segment for (prior, opp) is already in-chain
//                     within the window, at most once per (prior, opp) per
//                     window (PAIR_REMATCH), and prior ≠ game;
//                 (c) the rematch game itself APPEARS: if a BOUND segment for
//                     (game, opp) is already in-window the claim counts
//                     immediately; otherwise it is recorded PENDING (`pend`,
//                     keyed "<game>:<opp>" → claim height) and counts when
//                     that segment lands within W events of the claim. A
//                     pending claim whose game never arrives in-window counts
//                     NOTHING (the prune erases it). A real witnessed
//                     rematch backs every rematch point.
//  pairing:   A5 J5 (review deferral A4-12; spec §3/§8): the witnessed match-
//             time record BOTH players append for the same game key BEFORE
//             the first move (anchoring contract: ratings/conduct.ts). In
//             THIS fold a schema-valid pairing with opp ≠ root OPENS a
//             windowed obligation (`ob`, keyed "<game>:<opp>" → pairing
//             height) that a later record for the same (game, opp) must
//             SETTLE: a counted BOUND segment (any result, the game
//             demonstrably finished under a witness) or an abort/noshow
//             conduct event (the recorded non-game). Settling is NEUTRAL:
//             no counter moves for the pairing itself, ever.
//
//             THE DEADLINE (the §8 self-ban pattern, chosen deliberately):
//             §8 defines the only suppression-provable deadline shape this
//             system has, "append the obligated record BEFORE any further
//             witnessed-lane event", and A4-12's hook restates it for
//             pairings ("no matching segment/conduct event before the
//             subject's next witnessed event ⇒ suppression"). So the rule
//             here is the NEXT-EVENT rule, not a grace window: every state-
//             MODIFYING repStep first resolves the open-obligation map:
//             the entry the event itself settles (in-window) is removed
//             silently; EVERY other open entry is condemned (`unsettled`+1
//             each, entry removed). Why next-event and not window-exit: a
//             deadline the subject can push W events into the future is not
//             a deadline (a suppressor would bank W events of clean-looking
//             play per hidden loss), and the compliant client always HAS the
//             settling record available before it appends anything else (the
//             segment after a finished game, the abort/noshow otherwise), so
//             the strict rule never condemns compliance. The repPairWindow
//             prune still applies as the outer bound: an obligation that is
//             out-of-window when its would-be settling event arrives (only
//             reachable by riding ignored events, below) is condemned, not
//             settled. The window that expires pend/pair memory expires
//             settlement validity too, and either path resolves the entry
//             exactly once (no double count: condemned entries leave `ob`).
//
//             FOLD-LEVEL PRECISION, stated honestly: the fold's deadline
//             fires on the next event the FOLD ACTS ON (a state-modifying
//             segment/conduct/commend/pairing step). Events the fold ignores
//             (pins, personal lane, unknown types, malformed payloads,
//             rate-limited duplicates) keep the exact pass-through contract
//             (same reference, no prune, no condemnation), so an open
//             obligation can ride through them un-condemned until the next
//             counted event (or forever, if the chain simply stops: a fold
//             cannot condemn what has not happened: no wall clock, the rule
//             is a pure function of the event sequence). The raw §8 deadline
//             ("ANY further witnessed-lane event") is the AUDIT layer's to
//             prove exactly; this fold is its deterministic, conservative
//             in-chain enforcement: it counts every violation at the first
//             scoring-relevant opportunity, exactly once.
//
//             Rules of the map: duplicate pairing for an in-window open
//             (game, opp) → ignored (pass-through, one obligation per pair
//             per window); pairing whose (game, opp) already has an
//             in-window BOUND segment → ignored (the game already happened;
//             an after-the-fact pairing re-obligates nothing); opp === root
//             → ignored; malformed → ignored (the fold never throws). A
//             LEGACY segment settles NOTHING (its opp is witness-unbound:
//             the same reason it feeds no merit/misconduct axis) and, being
//             a counted event, condemns open obligations like any other.
//             Under the next-event rule `ob` holds at most ONE entry (every
//             counted event resolves all prior entries; only a pairing adds
//             one), trivially O(window).
//
//             CROSS-CHAIN NOTE (documented, not folded): the pairing lands
//             in BOTH chains, so a subject whose OPPONENT's chain carries a
//             pairing that the subject's own chain lacks has suppressed a
//             witnessed-lane event, evidence of exactly the same class as
//             a chain missing a witness-adjudicated segment it should
//             contain (§3), slashable like §8 suppression. DETECTING it
//             requires the counterparty's chain and is therefore the audit/
//             gossip layer's job (enforcement parity with segment
//             suppression); this one-chain fold handles the in-chain case
//             (the pairing IS present and unsettled) only.
//
//             SCORING (`unsettled`, do-not-invent-weights rule): an
//             unsettled obligation is abandonment-class misconduct. It is
//             folded into the EXISTING noshow term with the per-event weight
//             of a recorded noshow (formula below). No new PARAMS_A4 weight
//             row exists or is needed. Consequence, priced deliberately:
//             suppressing the settling record costs exactly what honestly
//             recording the noshow costs (the suppressor gains nothing
//             here), while the segment (a real result) or abort each cost
//             their own axes; the DETERRENT for deliberate suppression is
//             the audit layer's §8-class permanent-distrust consequence, not
//             this conduct score: the fold's job is that omission is never
//             FREE and never mints above-neutral standing.
//  commend:   counts ONLY when a BOUND segment for (game, opp) is already
//             in-chain within the reference window, at most once per
//             (opp, game) per window, and verifyCommend proves the inner
//             signature + inline certs (ratings/conduct.ts). Invalid
//             sig/certs ⇒ silently ignored; the fold never throws.
//             ENTANGLEMENT WEIGHT (A4-14, §6b "rate-limited by the
//             entanglement so it can't be farmed" / ACCOUNTS-PARAMS line
//             104), in TWO layers matching the trust fold's A4-05 split:
//
//             (1) IN-FOLD (body-only, deterministic, embedded state): every
//             counted commend folds at the FLOOR tier with PER-OPPONENT
//             DECAY: the k-th counted commend from the same opp within the
//             trailing repPairWindow adds floor(REP_COMMEND_FLOOR_TW / k)
//             twentieths (1, 0, 0, …; the same entSat(n)=1/n discipline as
//             the trust fold's repeat-play discount: heavy repeat commends
//             from one root ARE close entanglement on chain shape). The
//             per-opp counter is the windowed `com` map, pruned like `pend`.
//             The fold NEVER grants the established (full) tier: whether the
//             embedded oppCkpt's cosigners are ELIGIBLE witnesses is
//             verifier-local knowledge that must not reach embedded state
//             (A4-04), and an est tier granted on signature validity alone
//             was self-mintable (the A4-14 sybil residue). PAIR_EST still
//             marks the CLAIM (segment embedded a verifyEmbeddedOppCkpt-
//             passing checkpoint) for read-time surfaces; it carries no
//             weight by itself anymore.
//
//             (2) READ-TIME (repEvidenceOf, never embedded): the verifier
//             re-walks the chain THROUGH repStep itself (zero drift: a
//             commend earns evidence exactly iff the fold counted it) and
//             grants the est-tier bonus floor(REP_COMMEND_FULL_TW / k) −
//             floor(REP_COMMEND_FLOOR_TW / k) only when the referenced
//             segment's oppCkpt had ≥ ckptM cosigners the verifier's
//             WitnessEligibility predicate accepts (spanning ≥ 3 key
//             prefixes) AND an eligible wstream witness, the same
//             eligibility rule as mm/trust.ts's diversity evidence. repScore
//             takes the resulting RepEvidence as an optional argument.
//             Without evidence every commend is worth at most the decayed
//             floor: a sybil farm (self-minted cosigners) scores the floor
//             under EVERY verifier (eligibility-blind or not), while real
//             established goodwill earns full weight from any verifier that
//             can vouch for the cosigners (exact math below).
//             A4-21 (CLOSED, A7): the same walk consumes an optional
//             CommendRevocationView ((opp root, key) → revocation wts |
//             undefined, built by the caller from reconstructed counterparty
//             chains, §4 witnessed time). A counted commend whose signing
//             key the view reports revoked is DISCOUNTED at read time unless
//             the commend's witnessed time provably precedes the revocation
//             wts: it earns no est-tier bonus AND its folded floor twentieths
//             accumulate in RepEvidence.commendTwRevoked, which repScore
//             subtracts (clamped ≥ 0) from the embedded commendTw. Read-time
//             ONLY: repStep and the checkpoint-embedded RepState are
//             byte-identical with or without any view (digest-pinned in
//             scripts/test-accounts-reputation.mjs).
//
// SCORE FORMULA (repScore, exact, integer): six sub-scores, each an integer
// in [0,100], combined with the PARAMS_A4 micro-unit weights (which sum to
// exactly 1_000_000):
//
//   completion = (seg + abort) === 0 ? 100 : floor(100·seg / (seg + abort))
//   disconnect = seg === 0            ? 100 : floor(100·(seg − drop) / seg)
//   toResign   = (toLoss + rsLoss)===0? 100 : floor(100·rsLoss / (toLoss + rsLoss))
//   noshowSub  = D === 0              ? 100 : floor(100·(D − noshow − unsettled) / D)
//                where D = seg + abort + noshow + unsettled
//                (A5 J5: an unsettled pairing obligation enters the noshow
//                axis with EXACTLY a recorded noshow's per-event weight
//                (same denominator slot, same numerator deduction), mapping
//                the new counter onto the existing PARAMS_A4 noshow weight
//                instead of minting a new row)
//   rematchSub = min(100, 20·rematch)                 (REP_REMATCH_STEP)
//   commendSub = seg === 0 ? 0
//              : min(100, floor(400·tw / (20·seg)))
//                with tw = commendTw + (evidence?.commendTwBonus ?? 0)
//                (REP_COMMEND_SCALE · tw / (REP_COMMEND_FULL_TW · seg); with
//                 every commend eligibility-verified full-weight and from a
//                 distinct opp, tw = 20·commend and the curve is EXACTLY the
//                 pre-A4-14 min(100, floor(400·commend/seg)); a 25%
//                 full-weight commend rate saturates. WITHOUT evidence tw =
//                 commendTw ≤ commend (decayed floor tier): a farm of any
//                 size caps commendSub at 20 (+3 score points), i.e. it
//                 cannot saturate under any verifier)
//
//   score = floor((wCompletion·completion + wDisconnect·disconnect
//                + wTimeoutResign·toResign + wNoshow·noshowSub
//                + wRematch·rematchSub + wCommend·commendSub) / 1_000_000)
//
// ROUNDING: floor division at every step (sub-scores AND the final sum),
// computed as Math.floor(a/b) on non-negative integers. This is EXACT floor
// division here, hence bit-deterministic across engines: IEEE-754 division is
// correctly rounded, numerators are < 2^53 with relative error ≤ 2^-52, and a
// non-integer exact quotient p/q sits ≥ 1/q away from any integer with
// q ≤ ~2^40: the rounding error can never carry the value across an integer
// boundary. No Math.exp/log/pow anywhere.
//
// NEUTRAL START: a fresh account (no games) scores
//   0.35·100 + 0.25·100 + 0.10·100 + 0.10·100 + 0.05·0 + 0.15·0 = 80 (tier 2).
// Justification: the four misconduct classes (completion, disconnect,
// timeout-vs-resign, noshow) are presumed-innocent: with zero evidence their
// failure rates are 0, so they start at 100 and only misconduct lowers them.
// The two merit classes (rematch, commend) are EARNED: they start at 0 and
// only countersigned/witnessed goodwill raises them. So every account is
// visible and in good standing from game 1 (§6b: no hiding), but the top
// badge tier (90+) is reachable only through demonstrated sportsmanship, and
// a fresh reroll can never outrank an account with an earned record.
//
// Platform-neutral: no `node:` imports, no DOM globals, no ambient time.

import type { CanonicalObject } from '../codec'
import { zCommendPayload, zConductPayload, zPairingPayload } from '../events'
import { OPP_CKPT_PREFIX_DIVERSITY_MIN, verifySegmentEvent } from '../segment'
import type { SegmentPayload } from '../storage/types'
import type { B64u, Chain, SignedEvent, WitnessAttestation, WitnessEligibility } from '../types'
import { PARAMS_A2 } from '../witness/params'
import { verifyCommend, verifyRematchAccept } from './conduct'
import { PARAMS_A4 } from './params'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Reputation fold state, integer leaves only (see contract above). */
export interface RepState extends CanonicalObject {
  v: 1
  /** Verified segments folded (first per (game, opp)), A4-07 gate. */
  seg: number
  /** Subject losses whose witness-BOUND reason classified as drop
   * (disconnect/abandon). Legacy segments never count here. */
  drop: number
  /** Subject losses on the clock ('flag'/'timeout'), bound segments only. */
  toLoss: number
  /** Subject losses by resignation, bound segments only. */
  rsLoss: number
  /** 'abort' conduct events. */
  abort: number
  /** 'noshow' conduct events. */
  noshow: number
  /** A5 J5 (A4-12): pairing obligations condemned at the next-event deadline.
   * Abandonment-class, folded into the noshow score term (header). */
  unsettled: number
  /** Counted rematch-accepts (A4-13: countersigned + in-window bound prior +
   * the rematch game's own segment arrived, ≤1 per (prior, opp)). */
  rematch: number
  /** Counted commendations (verified, in-window bound segment, ≤1 per
   * (opp, game)), the raw count; the score uses commendTw (+ evidence). */
  commend: number
  /** IN-FOLD commend credit in TWENTIETHS (A4-14): each counted commend adds
   * the entanglement-DECAYED floor tier floor(REP_COMMEND_FLOOR_TW / k), k =
   * counted commends from that opp in-window (`com`). The established-tier
   * remainder is EARNED at read time through repEvidenceOf (eligibility-
   * verified cosigners), never folded (header layer split). */
  commendTw: number
  /** "<game>:<opp>" → {h: segment witnessed height, f: PAIR_* bitmask}.
   * Entries older than PARAMS_A4.repPairWindow (relative to the current
   * event's height) are pruned by every state-modifying step, O(window). */
  pair: { [key: string]: PairEntry }
  /** Pending rematch claims (A4-13): "<claimed-game>:<opp>" → claim witnessed
   * height. Settled (removed) by the arrival of a BOUND verified segment for
   * that pair; pruned exactly like `pair`, O(window). */
  pend: { [key: string]: number }
  /** A5 J5: OPEN pairing obligations, "<game>:<opp>" → pairing witnessed
   * height. Every state-modifying step resolves the whole map (settled or
   * condemned; the next-event deadline, header), so it holds at most one
   * entry; the repPairWindow rule bounds settlement validity like pend. */
  ob: { [key: string]: number }
  /** A4-14 entanglement decay: opp root → {h: last counted commend height,
   * k: counted commends from that opp while the entry lived}. Windowed and
   * pruned exactly like `pend`, O(window). */
  com: { [opp: string]: ComEntry }
}

/** One pair-map entry: the referenced segment's witnessed height + flags. */
export interface PairEntry extends CanonicalObject {
  h: number
  f: number
}

/** One commend-decay entry (A4-14): last counted commend height + in-window
 * counted commends from that opponent. */
export interface ComEntry extends CanonicalObject {
  h: number
  k: number
}

/** pair bit: a segment for (game, opp) is in-chain. */
export const PAIR_SEG = 1
/** pair bit: a commend for (game, opp) has been counted. */
export const PAIR_COMMEND = 2
/** pair bit: a rematch-accept naming this (prior-game, opp) has been counted
 * or registered pending, the ≤1-per-(prior, opp) rule. */
export const PAIR_REMATCH = 4
/** pair bit: the segment is BOUND; its witness signature covers the F1
 * RatedBinding (kind/tc/players/reason), so reason, color and opp are
 * witness-authenticated. Legacy segments lack it; merit references and
 * misconduct classification require it (header decision). */
export const PAIR_BOUND = 8
/** pair bit: the segment carried a verifyEmbeddedOppCkpt-proven opponent
 * checkpoint, an established-opponent CLAIM. Weightless by itself since the
 * A4-14 eligibility split (the fold cannot judge cosigner eligibility,
 * A4-04); the est tier is earned at read time via repEvidenceOf. */
export const PAIR_EST = 16

/** Rematch merit ramp: each counted rematch-accept is worth 20/100, cap 100. */
export const REP_REMATCH_STEP = 20
/** Commend merit ramp numerator: commendSub = min(100, floor(400·tw /
 * (20·seg))), a 25% FULL-WEIGHT commend rate (1 in 4 games from
 * eligibility-verified established opponents) is maximal sportsmanship
 * evidence. */
export const REP_COMMEND_SCALE = 400
/** Commend weight (twentieths) for an eligibility-VERIFIED established pair,
 * granted only through repEvidenceOf (read time), decayed per-opponent:
 * the k-th in-window commend from one opp earns floor(20 / k). */
export const REP_COMMEND_FULL_TW = 20
/** IN-FOLD commend weight (twentieths), the floor every counted commend
 * folds at, decayed per-opponent: floor(1 / k) (1, 0, 0, …). 1/20 of
 * established, the A4-14 sybil-farm discount. */
export const REP_COMMEND_FLOOR_TW = 1

function pairKey(game: string, opp: string): string {
  return `${game}:${opp}`
}

/**
 * Prune `pair` entries whose segment height is below `minH` (= event height −
 * repPairWindow). Called by every state-modifying step, so an entry that
 * survives in the returned map is BY CONSTRUCTION within the window of the
 * current event; the window-validity check and the memory bound are one rule.
 */
function prunePair(pair: { [key: string]: PairEntry }, minH: number): { [key: string]: PairEntry } {
  const out: { [key: string]: PairEntry } = {}
  for (const k of Object.keys(pair)) {
    const e = pair[k]
    if (e.h >= minH) out[k] = e
  }
  return out
}

/** Same window rule for the pending-rematch map (values are claim heights). */
function prunePend(pend: { [key: string]: number }, minH: number): { [key: string]: number } {
  const out: { [key: string]: number } = {}
  for (const k of Object.keys(pend)) {
    if (pend[k] >= minH) out[k] = pend[k]
  }
  return out
}

/** Same window rule for the commend-decay map (entry heights, A4-14). */
function pruneCom(com: { [opp: string]: ComEntry }, minH: number): { [opp: string]: ComEntry } {
  const out: { [opp: string]: ComEntry } = {}
  for (const k of Object.keys(com)) {
    if (com[k].h >= minH) out[k] = com[k]
  }
  return out
}

/**
 * A5 J5: resolve the open-obligation map at a state-MODIFYING step (the
 * next-event deadline, header): the `settleKey` entry is SETTLED (silently,
 * neutral) when it is still in-window (pairing height ≥ minH); every OTHER
 * open entry (including an out-of-window settleKey entry, whose settlement
 * validity the window rule has expired) is CONDEMNED. Returns the number
 * condemned; the caller writes `ob: {}` (every entry is resolved exactly
 * once: a condemned or settled obligation leaves the map, so it can never
 * be counted twice) plus any entry the event itself opens.
 */
function condemnObligations(ob: { [key: string]: number }, minH: number, settleKey?: string): number {
  let n = 0
  for (const k of Object.keys(ob)) {
    if (k === settleKey && ob[k] >= minH) continue
    n++
  }
  return n
}

export function repInit(): RepState {
  return {
    v: 1,
    seg: 0,
    drop: 0,
    toLoss: 0,
    rsLoss: 0,
    abort: 0,
    noshow: 0,
    unsettled: 0,
    rematch: 0,
    commend: 0,
    commendTw: 0,
    pair: {},
    pend: {},
    ob: {},
    com: {},
  }
}

// ---------------------------------------------------------------------------
// Reason classification
// ---------------------------------------------------------------------------

export type ReasonClass = 'completed' | 'drop' | 'timeout' | 'resign'

/** Exact machine reason strings that classify as a drop / a clock loss. Any
 * other reason (checkmate, stalemate, agreement, unknown future strings) is a
 * completed game, the classifier is total and frozen for determinism. */
export const REASONS_DROP: readonly string[] = ['disconnect', 'abandon']
export const REASONS_TIMEOUT: readonly string[] = ['flag', 'timeout']

export function classifyReason(reason: string): ReasonClass {
  if (REASONS_DROP.includes(reason)) return 'drop'
  if (REASONS_TIMEOUT.includes(reason)) return 'timeout'
  if (reason === 'resign') return 'resign'
  return 'completed'
}

// ---------------------------------------------------------------------------
// The fold step
// ---------------------------------------------------------------------------

/**
 * Fold one witnessed-lane event. Pure and total: never throws, never mutates
 * `s`; events that do not affect reputation (personal lane, unknown types,
 * malformed payloads, rate-limited duplicates, unverifiable commends) return
 * `s` unchanged, the SAME object, so pass-through is trivially byte-stable.
 */
export function repStep(s: RepState, ev: SignedEvent): RepState {
  try {
    const b = ev.body
    if (b.lane !== 'w') return s
    switch (b.type) {
      case 'segment':
        return stepSegment(s, ev)
      case 'conduct':
        return stepConduct(s, ev)
      case 'commend':
        return stepCommend(s, ev)
      case 'pairing':
        return stepPairing(s, ev)
      default:
        return s
    }
  } catch {
    // zod safeParse / the commend verifier can only throw on adversarial
    // payloads engineered to crash deeper layers; the fold fails closed.
    return s
  }
}

function stepSegment(s: RepState, ev: SignedEvent): RepState {
  // A4-07: the FULL standalone segment gate (segment.ts) covers event signature,
  // witness terminal signature (incl. the atomic F1 rated binding), opp ≠
  // root, verifyEmbeddedOppCkpt on any present oppCkpt. Fail ⇒ pass-through:
  // an unverifiable segment feeds NOTHING here (and cannot exist on a
  // verifyChain-accepted chain, chain.ts 'bad-segment').
  if (verifySegmentEvent(ev) !== null) return s
  const p = ev.body.payload as unknown as SegmentPayload // parse guaranteed by the gate
  const minH = ev.body.height - PARAMS_A4.repPairWindow
  const k = pairKey(p.game, p.opp)
  const pair = prunePair(s.pair, minH)
  const cur = pair[k]
  if (cur !== undefined && (cur.f & PAIR_SEG) !== 0) return s // duplicate (game, opp) in-window: count once
  // BOUND ⇔ the wstream signature covered the rated binding (the gate made
  // kind/tc-presence and binding-validity one condition), so on a bound
  // segment (result, color, opp, reason) are all witness-authenticated.
  const bound = p.kind !== undefined || p.tc !== undefined
  const lost =
    bound && ((p.result === '1-0' && p.color === 'b') || (p.result === '0-1' && p.color === 'w'))
  const cls = classifyReason(p.reason)
  // Established (A4-14): a present oppCkpt is verifyEmbeddedOppCkpt-proven
  // under the gate; the opponent is a real, M-of-N-checkpointed account.
  const est = p.oppCkpt !== undefined
  const f =
    (cur?.f ?? 0) | PAIR_SEG | (bound ? PAIR_BOUND : 0) | (est ? PAIR_EST : 0)
  // A4-13 (c): a BOUND segment settles an in-window pending rematch claim for
  // this exact (game, opp); the claimed rematch demonstrably happened.
  const pend = prunePend(s.pend, minH)
  const settled = bound && Object.prototype.hasOwnProperty.call(pend, k)
  if (settled) delete pend[k] // pend is a fresh map from prunePend, local
  // A5 J5: a counted BOUND segment settles the in-window pairing obligation
  // for this exact (game, opp); a LEGACY segment settles nothing (unbound
  // opp), and either way this counted event is the next-event deadline for
  // every other open obligation (header).
  const condemned = condemnObligations(s.ob, minH, bound ? k : undefined)
  return {
    ...s,
    seg: s.seg + 1,
    drop: s.drop + (lost && cls === 'drop' ? 1 : 0),
    toLoss: s.toLoss + (lost && cls === 'timeout' ? 1 : 0),
    rsLoss: s.rsLoss + (lost && cls === 'resign' ? 1 : 0),
    unsettled: s.unsettled + condemned,
    rematch: s.rematch + (settled ? 1 : 0),
    pair: { ...pair, [k]: { h: ev.body.height, f } },
    pend,
    ob: {},
    com: pruneCom(s.com, minH),
  }
}

function stepConduct(s: RepState, ev: SignedEvent): RepState {
  const res = zConductPayload.safeParse(ev.body.payload)
  if (!res.success) return s
  const p = res.data
  if (p.opp === ev.body.root) return s
  const minH = ev.body.height - PARAMS_A4.repPairWindow
  // A5 J5: an abort/noshow conduct event SETTLES the in-window pairing
  // obligation for its exact (game, opp), which is the recorded non-game, and is
  // the next-event deadline for every other open obligation.
  if (p.kind === 'abort' || p.kind === 'noshow') {
    const condemned = condemnObligations(s.ob, minH, pairKey(p.game, p.opp))
    return {
      ...s,
      abort: s.abort + (p.kind === 'abort' ? 1 : 0),
      noshow: s.noshow + (p.kind === 'noshow' ? 1 : 0),
      unsettled: s.unsettled + condemned,
      pair: prunePair(s.pair, minH),
      pend: prunePend(s.pend, minH),
      ob: {},
      com: pruneCom(s.com, minH),
    }
  }
  // rematch-accept (A4-13). (a) the counterparty countersignature must verify:
  // a unilateral self-claim is pass-through, never counted.
  if (!verifyRematchAccept(ev.body.payload, ev.body.root)) return s
  const prior = p.prior as string // schema-enforced present
  if (p.game === prior) return s // the "rematch" cannot be the prior itself
  // (b) a BOUND segment for (prior, opp) in-chain WITHIN the window
  // (prunePair enforces the window: a surviving entry has e.h ≥ minH), at
  // most once per (prior, opp); PAIR_REMATCH marks counted AND pending
  // claims, so a prior backs at most one claim per window.
  const kPrior = pairKey(prior, p.opp)
  const pair = prunePair(s.pair, minH)
  const pend = prunePend(s.pend, minH)
  const e = pair[kPrior]
  if (e === undefined || (e.f & PAIR_SEG) === 0 || (e.f & PAIR_BOUND) === 0) return s
  if ((e.f & PAIR_REMATCH) !== 0) return s
  // (c) the rematch game itself must appear: count now if its BOUND segment
  // is already in-window, else record the claim PENDING (settled by
  // stepSegment; erased unseen by the window prune).
  const kGame = pairKey(p.game, p.opp)
  const g = pair[kGame]
  const arrived = g !== undefined && (g.f & PAIR_SEG) !== 0 && (g.f & PAIR_BOUND) !== 0
  if (!arrived && Object.prototype.hasOwnProperty.call(pend, kGame)) return s // duplicate pending claim
  return {
    ...s,
    // J5: a counted rematch-accept settles no pairing obligation; it is the
    // next-event deadline for every open one.
    unsettled: s.unsettled + condemnObligations(s.ob, minH),
    rematch: s.rematch + (arrived ? 1 : 0),
    pair: { ...pair, [kPrior]: { h: e.h, f: e.f | PAIR_REMATCH } },
    pend: arrived ? pend : { ...pend, [kGame]: ev.body.height },
    ob: {},
    com: pruneCom(s.com, minH),
  }
}

function stepCommend(s: RepState, ev: SignedEvent): RepState {
  const res = zCommendPayload.safeParse(ev.body.payload)
  if (!res.success) return s
  const p = res.data
  if (p.opp === ev.body.root) return s
  const minH = ev.body.height - PARAMS_A4.repPairWindow
  const k = pairKey(p.game, p.opp)
  const pair = prunePair(s.pair, minH)
  const e = pair[k]
  // No in-window BOUND segment for (game, opp) ⇒ ignored: a legacy segment's
  // opp is witness-unbound, so it can never unlock commend credit (header).
  if (e === undefined || (e.f & PAIR_SEG) === 0 || (e.f & PAIR_BOUND) === 0) return s
  if ((e.f & PAIR_COMMEND) !== 0) return s // ≤1 per (opp, game)
  if (!verifyCommend(ev.body.payload, ev.body.root)) return s // forged ⇒ silently ignored
  // A4-14 entanglement decay (header layer 1): the k-th counted commend from
  // this opp in-window folds floor(REP_COMMEND_FLOOR_TW / k) twentieths;
  // the est tier is read-time evidence (repEvidenceOf), never folded.
  const com = pruneCom(s.com, minH)
  const kCnt = (Object.prototype.hasOwnProperty.call(com, p.opp) ? com[p.opp].k : 0) + 1
  return {
    ...s,
    // J5: a counted commend settles no pairing obligation. It is a next-event deadline.
    unsettled: s.unsettled + condemnObligations(s.ob, minH),
    commend: s.commend + 1,
    commendTw: s.commendTw + idiv(REP_COMMEND_FLOOR_TW, kCnt),
    pair: { ...pair, [k]: { h: e.h, f: e.f | PAIR_COMMEND } },
    pend: prunePend(s.pend, minH),
    ob: {},
    com: { ...com, [p.opp]: { h: ev.body.height, k: kCnt } },
  }
}

/**
 * A5 J5 (A4-12): fold one 'pairing' event, opening the obligation (header
 * anchoring contract + deadline rule). Pass-through (same reference) when:
 * malformed, opp === root, a duplicate of an in-window OPEN obligation for
 * the same (game, opp), or the (game, opp) already has an in-window BOUND
 * segment (the game already happened; an after-the-fact pairing obligates
 * nothing). Otherwise this is a counted witnessed event like any other: it
 * is the next-event deadline for every previously open obligation (a player
 * who pairs a NEW game without having settled the last one is condemned
 * exactly here, the earliest deterministic point), and it opens its own.
 */
function stepPairing(s: RepState, ev: SignedEvent): RepState {
  const res = zPairingPayload.safeParse(ev.body.payload)
  if (!res.success) return s
  const p = res.data
  if (p.opp === ev.body.root) return s
  const minH = ev.body.height - PARAMS_A4.repPairWindow
  const k = pairKey(p.game, p.opp)
  // Duplicate of an in-window open obligation → ignored (one per pair per
  // window; an OUT-of-window stale entry is instead condemned below and the
  // pairing re-opens, the same per-window dedup semantics as commends).
  if (Object.prototype.hasOwnProperty.call(s.ob, k) && s.ob[k] >= minH) return s
  // Already played in-window (BOUND, witness-authenticated opp) → ignored.
  const played = s.pair[k]
  if (played !== undefined && played.h >= minH && (played.f & PAIR_SEG) !== 0 && (played.f & PAIR_BOUND) !== 0)
    return s
  return {
    ...s,
    unsettled: s.unsettled + condemnObligations(s.ob, minH),
    pair: prunePair(s.pair, minH),
    pend: prunePend(s.pend, minH),
    ob: { [k]: ev.body.height },
    com: pruneCom(s.com, minH),
  }
}

// ---------------------------------------------------------------------------
// Score + tier
// ---------------------------------------------------------------------------

/** Exact floor division of non-negative safe integers (see rounding note in
 * the header; IEEE division cannot cross an integer boundary here). */
function idiv(num: number, den: number): number {
  return Math.floor(num / den)
}

/**
 * The verifier-side read-time reputation evidence (A4-14 layer 2), computed
 * by repEvidenceOf, NEVER embedded in any checkpoint state. Two honest
 * verifiers with different eligibility views legitimately compute different
 * evidence (weaker-is-safer, the mm/trust.ts TrustEvidence regime).
 */
export interface RepEvidence {
  /** Additional commend TWENTIETHS earned by eligibility-VERIFIED established
   * pairs: Σ over counted est-eligible commends of floor(FULL/k) −
   * floor(FLOOR/k). Always ≥ 0; 0 without an eligibility predicate. */
  commendTwBonus: number
  /** A4-21 (CLOSED, A7): folded floor TWENTIETHS to SUBTRACT at read time:
   * Σ over counted commends whose signing key the caller's revocation view
   * reports revoked (and not provably revoked AFTER the commend's witnessed
   * time) of the exact floor(FLOOR/k) the fold credited. Always ≥ 0; 0
   * without a revocation view. repScore applies it clamped: the embedded
   * commendTw never goes negative. */
  commendTwRevoked: number
}

/**
 * A4-21 (CLOSED, A7, the conduct.ts hook): the read-time revocation view.
 * (oppRoot, key) → the WITNESSED time (§4) at which `key` was revoked in the
 * commender's (oppRoot's) own chain, or undefined when the caller's
 * reconstructed view of that chain shows no revocation of `key`. Built from
 * reconstructed counterparty chains (A6 viewer material), NEVER from
 * anything embedded in the subject's chain, which is exactly why this is a
 * read-time parameter and can never reach the fold (A4-04 determinism).
 * Consulted for every counted commend, root-signed or child-signed. A view
 * that cannot vouch either way returns undefined (no discount: absence of
 * evidence is not a revocation; the §0 no-false-fraud side of the boundary).
 */
export type CommendRevocationView = (oppRoot: B64u, key: B64u) => number | undefined

/**
 * Compute the read-time commend evidence for a chain (A4-14): walk the
 * witnessed lane THROUGH repStep itself: an event earns evidence exactly
 * iff the fold counted it (`seg`/`commend` tick), so the fold's gates
 * (verifySegmentEvent, window, dedup, verifyCommend) apply with ZERO rule
 * drift, and grant the established-tier bonus only for commends whose
 * referenced BOUND segment carried an oppCkpt with ≥ ckptM cosigners the
 * `eligible` predicate accepts (spanning ≥ OPP_CKPT_PREFIX_DIVERSITY_MIN
 * key prefixes; every cosigner already signature-verified and distinct under
 * the segment gate) AND an eligible wstream witness, the same eligibility
 * rule as mm/trust.ts's diversity evidence. The per-commend decay divisor k
 * is read from the fold's own `com` map (header layer 1), so bonus + folded
 * floor = floor(REP_COMMEND_FULL_TW / k) for an est-eligible commend. Pure
 * and total (never throws); without a predicate the bonus is 0: the est
 * tier, like trust's age and diversity, is EARNED through witnesses the
 * verifier can vouch for.
 *
 * A4-21 (CLOSED, A7; the seam designated in ratings/conduct.ts): `revoked`
 * is the caller's commender-chain revocation view. For every COUNTED commend
 * the view is consulted with (opp root, signing key); when it reports a
 * revocation, the commend KEEPS its credit only if it provably predates the
 * revocation: Number.isSafeInteger on BOTH witnessed times AND commend wts
 * strictly < revocation wts (a device rotated AFTER signing keeps its honest
 * goodwill, the conduct.ts rationale). Every other view hit is DISCOUNTED,
 * failing toward no-forgery (§0) on the spec-silent edges: equal witnessed
 * times (ordering unprovable) and malformed times both discount. A
 * discounted commend earns no est bonus and its exact folded floor
 * floor(FLOOR/k) accumulates in commendTwRevoked for repScore to subtract.
 * Read-time ONLY: the fold walk itself takes no view; repStep and the
 * checkpoint-embedded state are byte-identical regardless (suite-pinned).
 * Conservative by construction: the revoked commend's `com` decay slot k is
 * NOT re-run (that would rewrite fold arithmetic), so later live commends
 * from the same opp keep their fold-position credit: under-crediting, never
 * over-crediting.
 */
export function repEvidenceOf(
  chain: Chain,
  eligible?: WitnessEligibility,
  revoked?: CommendRevocationView,
): RepEvidence {
  const w = chain.events
    .filter((e) => e.body.lane === 'w')
    .sort((a, b) => a.body.height - b.body.height)
  let s = repInit()
  /** "<game>:<opp>" → {h: segment height, e: est-ELIGIBLE (0/1)} for counted
   * BOUND segments, windowed exactly like the fold's pair map. */
  const est: { [key: string]: { h: number; e: number } } = {}
  let bonus = 0
  let revokedTw = 0
  for (const ev of w) {
    const s2 = repStep(s, ev)
    const b = ev.body
    if (b.type === 'segment' && s2.seg === s.seg + 1) {
      const minH = b.height - PARAMS_A4.repPairWindow
      for (const k of Object.keys(est)) if (est[k].h < minH) delete est[k]
      // Counted ⇒ the verifySegmentEvent gate passed ⇒ the payload parses and
      // any present oppCkpt is verified (distinct valid cosigners).
      const p = b.payload as unknown as SegmentPayload
      const bound = p.kind !== undefined || p.tc !== undefined
      let e = 0
      if (bound && p.oppCkpt !== undefined && eligible !== undefined && eligible(p.wstream.wkey)) {
        const wit = (p.oppCkpt as { wit?: WitnessAttestation[] }).wit
        if (Array.isArray(wit)) {
          const eligCos = wit.filter((a) => eligible(a.w))
          const prefixes = new Set<string>()
          for (const a of eligCos) prefixes.add(a.w.slice(0, 2))
          if (eligCos.length >= PARAMS_A2.ckptM && prefixes.size >= OPP_CKPT_PREFIX_DIVERSITY_MIN)
            e = 1
        }
      }
      if (bound) est[pairKey(p.game, p.opp)] = { h: b.height, e }
    } else if (b.type === 'commend' && s2.commend === s.commend + 1) {
      // Counted ⇒ zCommendPayload parsed inside stepCommend.
      const res = zCommendPayload.safeParse(b.payload)
      if (res.success) {
        const p = res.data
        const kCnt = Object.prototype.hasOwnProperty.call(s2.com, p.opp) ? s2.com[p.opp].k : 0
        // A4-21 (CLOSED, A7): consult the revocation view for this commend's
        // signing key in the COMMENDER's chain. Credit survives only when the
        // commend PROVABLY predates the revocation (both witnessed times
        // well-formed AND commend wts strictly before revocation wts); a view
        // hit with equal or malformed times discounts: fail toward
        // no-forgery (§0) on the unprovable-ordering edges (fn doc).
        const rw = revoked !== undefined ? revoked(p.opp, p.key) : undefined
        const isRevoked =
          rw !== undefined &&
          !(Number.isSafeInteger(rw) && Number.isSafeInteger(b.ts) && b.ts < rw)
        if (isRevoked) {
          // Take back exactly what the fold credited: floor(FLOOR/k) at this
          // commend's own decay slot (the amount stepCommend added).
          if (kCnt >= 1) revokedTw += idiv(REP_COMMEND_FLOOR_TW, kCnt)
        } else {
          const entry = est[pairKey(p.game, p.opp)]
          const minH = b.height - PARAMS_A4.repPairWindow
          if (entry !== undefined && entry.h >= minH && entry.e === 1 && kCnt >= 1)
            bonus += Math.max(
              0,
              idiv(REP_COMMEND_FULL_TW, kCnt) - idiv(REP_COMMEND_FLOOR_TW, kCnt),
            )
        }
      }
    }
    s = s2
  }
  return { commendTwBonus: bonus, commendTwRevoked: revokedTw }
}

/**
 * The §6b conduct score: integer in [0, 100] per the documented formula.
 * `evidence` is the verifier's OWN repEvidenceOf(chain, eligible, revoked)
 * output (A4-14): it ADDS the eligibility-verified established-tier commend
 * credit and SUBTRACTS (clamped at 0, A4-21) the folded floor of commends
 * whose signing key the verifier's revocation view reports revoked. Absent
 * evidence, commends score at the in-fold decayed floor, which no farm can
 * saturate (header math). Both evidence fields are guarded (safe-integer,
 * non-negative), so a hand-built evidence object cannot corrupt the score.
 */
export function repScore(s: RepState, evidence?: RepEvidence): number {
  const P = PARAMS_A4
  const engagements = s.seg + s.abort
  const completion = engagements === 0 ? 100 : idiv(100 * s.seg, engagements)
  const disconnect = s.seg === 0 ? 100 : idiv(100 * (s.seg - s.drop), s.seg)
  const clockLosses = s.toLoss + s.rsLoss
  const toResign = clockLosses === 0 ? 100 : idiv(100 * s.rsLoss, clockLosses)
  // A5 J5: an unsettled pairing obligation weighs exactly like a recorded
  // noshow, same denominator slot, same numerator deduction (header mapping;
  // no new weight row).
  const pairings = s.seg + s.abort + s.noshow + s.unsettled
  const noshowSub =
    pairings === 0 ? 100 : idiv(100 * (pairings - s.noshow - s.unsettled), pairings)
  const rematchSub = Math.min(100, REP_REMATCH_STEP * s.rematch)
  // A4-14: tw = in-fold decayed floor credit + read-time est bonus, in
  // twentieths of a full-weight commend; the denominator carries
  // REP_COMMEND_FULL_TW (header formula). A4-21: the read-time revocation
  // discount subtracts the flagged floor twentieths from the EMBEDDED credit
  // first (clamped ≥ 0: repEvidenceOf can only flag what the fold credited,
  // but a hand-built evidence object must not underflow), and the bonus
  // (granted only to non-discounted commends) is added after.
  const revokedTw =
    evidence !== undefined && Number.isSafeInteger(evidence.commendTwRevoked)
      ? Math.max(0, evidence.commendTwRevoked)
      : 0
  const tw =
    Math.max(0, s.commendTw - revokedTw) +
    (evidence !== undefined && Number.isSafeInteger(evidence.commendTwBonus)
      ? Math.max(0, evidence.commendTwBonus)
      : 0)
  const commendSub =
    s.seg === 0 ? 0 : Math.min(100, idiv(REP_COMMEND_SCALE * tw, REP_COMMEND_FULL_TW * s.seg))
  const sum =
    P.repWCompletionMicro * completion +
    P.repWDisconnectMicro * disconnect +
    P.repWTimeoutResignMicro * toResign +
    P.repWNoshowMicro * noshowSub +
    P.repWRematchMicro * rematchSub +
    P.repWCommendMicro * commendSub
  return idiv(sum, 1_000_000)
}

/** Badge tier over the 0–100 score: [0,40) / [40,70) / [70,90) / [90,100]. */
export function repTier(score: number): 0 | 1 | 2 | 3 {
  if (score >= PARAMS_A4.repTier3Min) return 3
  if (score >= PARAMS_A4.repTier2Min) return 2
  if (score >= PARAMS_A4.repTier1Min) return 1
  return 0
}
