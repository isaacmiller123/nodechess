// A7 social transport: the §10 EDGE-STRENGTH FOLD. One deterministic integer
// in [0, 1_000_000] (micro-units) expressing how established a SENDER is
// toward a RECIPIENT, derived exclusively from PUBLIC SIGNED DATA (the two
// parties' verified chains, §0: never asserted, always re-derivable, bit-
// identically). This is the mailbox relay's `meta.edgeMicro` input (spec §10:
// "prioritizing senders with an existing entanglement/trust/reputation edge,
// so a sybil flood can't evict requests from established roots before the
// offline recipient next syncs"; social/mailbox.ts AdmitMeta names this module
// as "the caller's fold").
//
// FORMULA (integer math, exact):
//   edge = min(1e6,  friend + entangle + trustEarned·120000/1e6
//                                      + repEarned·80000/100)
//   friend    = 600_000 iff the §3 MUTUAL READ holds (social/friends.ts
//               areFriends over BOTH verified chains. Each side's latest edge
//               state for the other is a verified countersigned add). One-sided
//               or unverifiable material contributes 0: a stale replayed
//               countersignature or a missing counterparty chain must never
//               mint priority (§0, fail toward no-forgery).
//   entangle  = 50_000 · min(4, distinct witnessed games vs THIS recipient)
//               counted from the sender's own VERIFIED chain ('segment' events
//               naming the recipient as opp: verifyChain already enforced
//               verifySegmentEvent + dup-game, so each counted game is a real
//               §3 countersigned entanglement).
//   trustEarned = max(0, T_sender − T_baseline): the §7 trust score
//               (mm/trust.ts trustT over the verified chain's fold + the
//               verifier's OWN evidence) MINUS the score an EMPTY chain gets
//               from the same formula at the same atWts.
//   repEarned = max(0, rep_sender − rep_baseline): §6b conduct score
//               (ratings/reputation.ts repScore) minus the empty-chain score.
//
// WHY THE BASELINE SUBTRACTION (the load-bearing A7 decision, spec-silent on
// the exact fold, decided fail-closed per the owner directives): trustT and
// repScore are presumed-innocent. An EMPTY chain scores well above zero
// (completion/cleanliness neutrals, conduct subscores start at 100). Feeding
// the raw scores in would hand every fresh sybil a free nonzero edge, and a
// flood of them could then outrank an established-but-poorly-conducted real
// account: breaking the §10 invariant the mailbox eviction rule anchors on
// (strictly-greater edge evicts). Subtracting the deterministic empty-chain
// baseline makes the presumed-innocent portion contribute EXACTLY ZERO, so:
//   · a fresh root (verified genesis-only chain, no witnessed evidence, no
//     edge with the recipient) derives edge = 0 exactly: structurally, not
//     empirically;
//   · every term above 0 is EARNED through witnessed, signed, third-party-
//     verifiable material (a friend countersignature, countersigned game
//     segments, eligibility-verified witness attestations);
//   · the mailbox invariant holds by construction: 0 is never strictly
//     greater than an established sender's ≥ 50_000.
// Honest boundary, stated plainly: an account whose conduct fell BELOW the
// fresh baseline clamps to 0 earned: worse-than-fresh history earns no
// priority, it is never punished below a sybil (no negative edges).
//
// Determinism rules (suite-load-bearing): platform-neutral (no `node:`
// imports, no DOM globals), no Date.now / Math.random / timers, `atWts` is
// the caller's witnessed-time input (§4). Integer math only; every product
// stays far inside 2^53. Fail-closed and total: bad shapes, unverifiable
// chains, wrong roots, and internal throws all yield 0 (no priority), never
// an exception into the relay.

import { verifyChain } from '../chain'
import { repEvidenceOf, repInit, repScore, repStep } from '../ratings/reputation'
import { trustEvidenceOf, trustInputsInit, trustInputsStep, trustT } from '../mm/trust'
import { areFriends, friendsOf } from './friends'
import type { SegmentPayload } from '../storage/types'
import type { B64u, Chain, SignedEvent, WitnessEligibility } from '../types'

// ---------------------------------------------------------------------------
// Weights (micro-units; the four caps sum to exactly 1_000_000)
// ---------------------------------------------------------------------------

/** The §3 mutual witnessed friend edge: the strongest possible standing. */
export const EDGE_FRIEND_MICRO = 600_000
/** Per distinct witnessed game vs the recipient (sender's verified chain). */
export const EDGE_ENTANGLE_PER_GAME_MICRO = 50_000
/** Games counted toward the entanglement term (4 · 50_000 = 200_000 cap). */
export const EDGE_ENTANGLE_GAMES_CAP = 4
/** Scale of the EARNED trust delta (T − empty-chain baseline, both ∈ [0,1e6]). */
export const EDGE_TRUST_SCALE_MICRO = 120_000
/** Scale of the EARNED reputation delta (score − empty-chain baseline, 0–100). */
export const EDGE_REP_SCALE_MICRO = 80_000

const idiv = (a: number, b: number): number => Math.floor(a / b)

// ---------------------------------------------------------------------------
// Pure combiner over already-derived integer parts
// ---------------------------------------------------------------------------

/** The verified facts the fold combines. Callers derive these from PUBLIC
 * SIGNED DATA only (edgeMicroOfChains below is the canonical deriver); this
 * split exists so suites can pin the arithmetic against hand-built parts. */
export interface EdgeParts {
  /** §3 mutual read holds across BOTH verified chains. */
  friendMutual: boolean
  /** Distinct witnessed games sender↔recipient in the sender's verified chain. */
  entangledGames: number
  /** Sender trust T (micro, [0,1e6]) from the verifier's own fold+evidence. */
  trustMicro: number
  /** trustT of an EMPTY chain under the same formula at the same atWts. */
  trustBaselineMicro: number
  /** Sender §6b conduct score [0,100] from the verifier's own fold+evidence. */
  repScore: number
  /** repScore of an EMPTY chain under the same formula. */
  repBaselineScore: number
}

/**
 * Combine verified parts into the edge integer. Pure, total, deterministic.
 * Any non-safe-integer / out-of-range part fails CLOSED to that term = 0
 * (never a throw, never a negative, never > 1e6).
 */
export function edgeStrengthMicro(parts: EdgeParts): number {
  let sum = 0
  if (parts.friendMutual === true) sum += EDGE_FRIEND_MICRO
  if (Number.isSafeInteger(parts.entangledGames) && parts.entangledGames > 0)
    sum += EDGE_ENTANGLE_PER_GAME_MICRO * Math.min(EDGE_ENTANGLE_GAMES_CAP, parts.entangledGames)
  if (
    Number.isSafeInteger(parts.trustMicro) &&
    Number.isSafeInteger(parts.trustBaselineMicro) &&
    parts.trustMicro >= 0 &&
    parts.trustMicro <= 1_000_000 &&
    parts.trustBaselineMicro >= 0 &&
    parts.trustBaselineMicro <= 1_000_000
  ) {
    const earned = Math.max(0, parts.trustMicro - parts.trustBaselineMicro)
    sum += idiv(earned * EDGE_TRUST_SCALE_MICRO, 1_000_000)
  }
  if (
    Number.isSafeInteger(parts.repScore) &&
    Number.isSafeInteger(parts.repBaselineScore) &&
    parts.repScore >= 0 &&
    parts.repScore <= 100 &&
    parts.repBaselineScore >= 0 &&
    parts.repBaselineScore <= 100
  ) {
    const earned = Math.max(0, parts.repScore - parts.repBaselineScore)
    sum += idiv(earned * EDGE_REP_SCALE_MICRO, 100)
  }
  return Math.min(1_000_000, Math.max(0, sum))
}

// ---------------------------------------------------------------------------
// The canonical deriver: verified chains → parts → edge
// ---------------------------------------------------------------------------

export interface EdgeFromChainsOpts {
  /** Sender root (the party asking for mailbox priority). */
  sender: B64u
  /** Recipient root (whose box the mail targets). */
  recipient: B64u
  /** The sender's chain as reconstructed by the RELAY (null = unknown). */
  senderChain: Chain | null
  /** The recipient's chain as reconstructed by the RELAY (null = unknown). */
  recipientChain: Chain | null
  /** Witnessed time (§4) the trust age term is evaluated at. The caller's
   * clock discipline (the relay passes the same nowWts it stamps admission
   * with, so the frozen edge and arrival time share one instant). */
  atWts: number
  /** The RELAY's own witness-eligibility predicate (A4-03/05): trust age /
   * diversity and the reputation est-tier are EARNED through witnesses this
   * verifier can vouch for. Absent ⇒ those evidence terms are 0. Strictly
   * less priority, never more (fail closed). */
  eligible?: WitnessEligibility
}

/**
 * Derive the sender→recipient edge from verified chains. The §10 fold the
 * relay wires into mailboxAdmit's meta.edgeMicro. Total and fail-closed:
 * returns 0 (no priority) on any of. Bad atWts, sender === recipient, a
 * missing/mismatched/unverifiable SENDER chain (every term needs it), or an
 * internal throw. A missing or unverifiable RECIPIENT chain zeroes only the
 * mutual-friend term (the sender's own chain still proves entanglement,
 * trust, and reputation).
 */
export function edgeMicroOfChains(o: EdgeFromChainsOpts): number {
  try {
    if (!Number.isSafeInteger(o.atWts) || o.atWts < 0) return 0
    if (typeof o.sender !== 'string' || typeof o.recipient !== 'string') return 0
    if (o.sender === o.recipient) return 0
    const sc = o.senderChain
    if (sc === null || sc.root !== o.sender || !verifyChain(sc).ok) return 0

    // Witnessed lane, height order: the same walk every A4 fold uses.
    const w = sc.events
      .filter((e) => e.body.lane === 'w')
      .sort((a, b) => a.body.height - b.body.height)

    // §3 mutual read (both chains or nothing).
    let friendMutual = false
    const rc = o.recipientChain
    if (rc !== null && rc.root === o.recipient && verifyChain(rc).ok) {
      friendMutual = areFriends(friendsOf(o.sender, sc.events), friendsOf(o.recipient, rc.events))
    }

    // Distinct witnessed games vs the recipient. verifyChain enforced
    // verifySegmentEvent + dup-game on every counted event, so payloads
    // conform and game keys are unique; the dedup set is belt to that.
    const games = new Set<string>()
    for (const ev of w) {
      if (ev.body.type !== 'segment') continue
      const p = ev.body.payload as unknown as SegmentPayload
      if (p.opp === o.recipient && typeof p.game === 'string') games.add(p.game)
    }

    // Trust + reputation folds over the verified chain, plus this verifier's
    // OWN evidence (never anything self-asserted by the sender: §0).
    let inputs = trustInputsInit()
    let rep = repInit()
    for (const ev of w) {
      inputs = trustInputsStep(inputs, ev)
      rep = repStep(rep, ev as SignedEvent)
    }
    const tMicro = trustT(inputs, rep, o.atWts, trustEvidenceOf(sc, o.eligible))
    const score = repScore(rep, repEvidenceOf(sc, o.eligible))

    // Empty-chain baselines under the SAME formulas at the SAME instant (see
    // header: the presumed-innocent portion must contribute exactly zero).
    const tBase = trustT(trustInputsInit(), repInit(), o.atWts)
    const repBase = repScore(repInit())

    return edgeStrengthMicro({
      friendMutual,
      entangledGames: games.size,
      trustMicro: tMicro,
      trustBaselineMicro: tBase,
      repScore: score,
      repBaselineScore: repBase,
    })
  } catch {
    return 0 // fail closed: no derivable public basis ⇒ no priority
  }
}
