// A2 fabric-core: witness eligibility floors + the canonical witness set
// (spec §4, ACCOUNTS-PARAMS §Witness). Eligibility is judged by the OBSERVER
// from public floors + the subject's chain; a node's own presence is trusted
// only for its signature. Pure + deterministic. Platform-neutral.
//
// The §4 floors, from PARAMS_A2:
//   trust        ≥ eligTrustMicro   (0.5 in micro-units; A4 computes trust:
//                                     here it is an INPUT, default 0)
//   uptime       ≥ eligUptimePct    (95% trailing 30d, from the presence record)
//   entanglement candidate.root NOT in subject.entangledRoots (no direct
//                game/friend edge in the trailing window: closes sock-puppet
//                witnessing)
//   shared-partner overlap  |cand.2nd ∩ subj.2nd| / |subj.2nd| < eligSharedPartnerPctMax
//
// Plus structural gates that never relax: a node cannot witness itself, must
// advertise the witness capability, and cannot advertise presence from beyond
// the clock window (anti age/staleness forgery, §4 witnessed-time diversity).
//
// Small-population relaxation (spec §4: "at populations too small to fill W_n,
// any eligible node serves"): the SOFT floors (trust, uptime) drop so a fresh,
// untrusted node CAN witness at tiny scale, but the anti-sock-puppet gates
// (entanglement, shared-partner, self) stay, and M-of-N + diversity still bound
// what any single witness can attest. The operator peer is just another
// eligible node under exactly these rules (§4 C-10), no special case here.

import type { B64u } from '../types'
import { closestEligible, nodeIdOf } from './distance'
import { liveNodesOf } from './presence'
import type { NodeDirectory, NodeId, SignedPresence, SubjectSummary } from './types'

/** Chain-derived facts about a candidate needed to judge eligibility. */
export interface ChainSummary {
  root: B64u
  nodeId: NodeId
  /** A4-computed own-trust in fixed-point micro-units. Absent ⇒ 0 (untrusted). */
  trustMicro?: number
  /** Roots of the candidate's opponents' opponents (shared-partner overlap). */
  secondDegreeRoots: Set<string>
}

/** A candidate = its live presence record + its chain-derived summary. */
export interface CandidateSummary {
  presence: SignedPresence
  chainSummary: ChainSummary
}

/** The PARAMS_A2 subset the eligibility math reads (PARAMS_A2 satisfies it). */
export interface EligibilityParams {
  eligTrustMicro: number
  eligUptimePct: number
  eligSharedPartnerPctMax: number
  timeWindowMs: number
  wN: number
}

export interface EligibilityOpts {
  /** Small-population mode: drop the soft floors (trust, uptime). */
  relax?: boolean
}

/**
 * Judge one candidate against the §4 floors for `subject`. Returns every
 * failing floor's reason (empty ⇒ eligible). `nowMs` gates presence that
 * claims a timestamp beyond the clock window (a node cannot stay "fresh" from
 * the future). All comparisons are integer (shared-partner overlap uses
 * cross-multiplication, never a float ratio) so the verdict is bit-identical
 * across engines.
 */
export function isEligible(
  candidate: CandidateSummary,
  subject: SubjectSummary,
  params: EligibilityParams,
  nowMs: number,
  opts: EligibilityOpts = {},
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  const cs = candidate.chainSummary
  const pb = candidate.presence.body

  // --- structural gates (never relax) ---
  if (cs.root === subject.root) reasons.push('self')
  if (!pb.caps.witness) reasons.push('no-witness-cap')
  if (pb.ts - nowMs > params.timeWindowMs) reasons.push('presence-future')
  if (subject.entangledRoots.has(cs.root)) reasons.push('entangled')
  {
    const denom = subject.secondDegreeRoots.size
    if (denom > 0) {
      let inter = 0
      for (const r of cs.secondDegreeRoots) if (subject.secondDegreeRoots.has(r)) inter++
      // overlap% ≥ max  ⇔  inter*100 ≥ max*denom   (integer, deterministic)
      if (inter * 100 >= params.eligSharedPartnerPctMax * denom) reasons.push('shared-partner-overlap')
    }
  }

  // --- soft floors (relax at tiny populations) ---
  if (!opts.relax) {
    if ((cs.trustMicro ?? 0) < params.eligTrustMicro) reasons.push('trust-below-floor')
    if (pb.uptimePct < params.eligUptimePct) reasons.push('uptime-below-floor')
  }

  return { ok: reasons.length === 0, reasons }
}

/** Row carried through closestEligible: its nodeId + the candidate to judge. */
interface Row {
  nodeId: NodeId
  cand: CandidateSummary
}

/** A default chain summary for a live node we hold no chain facts about:
 * untrusted (trust 0), no known second-degree partners. It can only ever be
 * relaxed-eligible (the soft floors reject it at scale). */
function defaultSummary(sp: SignedPresence, nodeId: NodeId): ChainSummary {
  return { root: sp.body.root, nodeId, trustMicro: 0, secondDegreeRoots: new Set<string>() }
}

/**
 * The canonical witness set for `subject`: the wN closest ELIGIBLE live nodes
 * by key-distance. `summaries` supplies chain-derived facts keyed by nodeId;
 * live nodes without a summary are treated as untrusted defaults. The nodeId of
 * each candidate is recomputed from its presence root (never trusted from the
 * summary) so a record cannot claim a distance it does not own.
 *
 * If fewer than wN nodes pass the full floors, the small-population relaxation
 * applies (soft floors drop) and the wN closest RELAXED-eligible nodes are
 * returned, "all eligible" when still fewer than wN.
 */
export function canonicalWitnessSet(
  subject: SubjectSummary,
  directory: NodeDirectory,
  summaries: ReadonlyMap<NodeId, ChainSummary>,
  params: EligibilityParams,
  nowMs: number,
): NodeId[] {
  const rows: Row[] = liveNodesOf(directory, nowMs).map((sp) => {
    const nodeId = nodeIdOf(sp.body.root)
    const cs = summaries.get(nodeId) ?? defaultSummary(sp, nodeId)
    return { nodeId, cand: { presence: sp, chainSummary: cs } }
  })

  const full = (r: Row): boolean => isEligible(r.cand, subject, params, nowMs).ok
  const chosen = closestEligible(subject.nodeId, rows, full, params.wN)
  if (chosen.length >= params.wN) return chosen

  // Small-population relaxation. Soft floors drop, anti-sock-puppet gates stay.
  const relaxed = (r: Row): boolean => isEligible(r.cand, subject, params, nowMs, { relax: true }).ok
  return closestEligible(subject.nodeId, rows, relaxed, params.wN)
}
