// A4 seam 1: committee failure-counter ANTI-SPREADING (spec §1 "honest
// members gossip counts"; A2->A3 residual seam 1, closed in A4 brick 1b).
//
// A2's effectiveCount is the t-th-largest of per-member LOCAL counters. An
// attacker who spreads guesses across rotating quorums (t−1 fixed "hot"
// members + one rotating slot) keeps the t-th-largest at ~1/(n−t+1) of the
// true guess count, stretching the 100-guess lifetime budget ~4×. The close:
// members publish SIGNED, MONOTONIC, GEN-TAGGED per-member counter reports;
// peers pull + merge them (fabric 'pin-counter-sync' records under the account
// key), and every count-bearing decision (fuse self-qualification, handoff
// carry floor, the trip aggregator) is computed over the CONVERGED merged
// report set with a spread-resistant statistic:
//
//   S = max( t-th-largest(fails),  ceil(trimmedSum / (2t − n)) )
//
// where trimmedSum drops the (n − t) LARGEST reported values (missing reports
// count 0). Why this is both spread-resistant and Byzantine-bounded:
//  - every real guess evaluation increments ≥ t member counters, of which at
//    most (n − t) can be trimmed away, so trimmedSum ≥ (t − (n−t))·G, i.e.
//    S ≥ G: no quorum-rotation schedule can hold the converged count below
//    the true guess count G. (Fixed-quorum and hot+rotate schedules give
//    S = G exactly; even spreading OVERSHOOTS: spreading is self-defeating.)
//  - ≤ (n − t) malicious members inflating their reports are exactly the
//    values the trim drops, so unbounded report forgery cannot poison the
//    recorded count (and with it the next cycle's refill threshold); residual
//    inflation is bounded by the largest honestly-observed count.
//  - a report is only as good as its SIGNATURE (member's advertised key) +
//    MONOTONICITY: (gen, fails) may only grow; a member caught signing a
//    regressing pair has produced self-authenticating misbehavior evidence
//    (CounterRegression: both signed reports, portable).
//
// Pure verifiers/reducers only. The wire choreography lives in protocol.ts.
// Platform-neutral: no `node:` imports, no DOM globals, no ambient clocks.

import { z } from 'zod'
import { canonicalBytes, type CanonicalObject } from '../codec'
import { ed25519, toB64u, verifySigB64u as verifySig } from '../hash'
import { zB64u32, zB64u64 } from '../events'
import type { B64u, EventId } from '../types'
import type { NodeId } from './types'

// ---------------------------------------------------------------------------
// Report shape (standalone signed record, NOT a chain event)
// ---------------------------------------------------------------------------

/** Upper bound on a report's fails. Keeps sums in safe-integer range and
 * refuses absurd forgeries at the schema boundary. */
export const COUNTER_FAILS_MAX = 1_000_000_000_000

export interface PinCounterReportBody extends CanonicalObject {
  v: 1
  /** Account root the counter is for. */
  root: B64u
  /** Reporting committee member. */
  w: NodeId
  /** PIN record id the member is provisioned under (context, informative). */
  rec: EventId
  /** Member's provision generation for this root: 0 at first enrollment, +1
   * per accepted handoff re-provision. Reports order by (gen, fails). */
  gen: number
  /** evaluations served − successes proven (the member's monotonic count). */
  fails: number
  /** Member clock at signing (staleness/ordering diagnostic, not authority). */
  asOfWts: number
}

export interface SignedCounterReport {
  body: PinCounterReportBody
  /** ed25519 by the member's advertised signing key over canonicalBytes(body). */
  sig: B64u
}

export const zCounterReportBody = z.strictObject({
  v: z.literal(1),
  root: zB64u32,
  w: zB64u32,
  rec: zB64u32,
  gen: z.int().min(0).max(1_000_000),
  fails: z.int().min(0).max(COUNTER_FAILS_MAX),
  asOfWts: z.int().min(0),
})

export const zCounterReport = z.strictObject({
  body: zCounterReportBody,
  sig: zB64u64,
})

export interface CounterReportInit {
  root: B64u
  w: NodeId
  rec: EventId
  gen: number
  fails: number
  asOfWts: number
}

/** Sign this member's current count into a portable, monotonic report. */
export function signCounterReport(
  body: CounterReportInit,
  memberKey: B64u,
  priv: Uint8Array,
): SignedCounterReport {
  if (toB64u(ed25519.getPublicKey(priv)) !== memberKey)
    throw new Error('signCounterReport: priv does not match memberKey')
  const full: PinCounterReportBody = {
    v: 1,
    root: body.root,
    w: body.w,
    rec: body.rec,
    gen: body.gen,
    fails: body.fails,
    asOfWts: body.asOfWts,
  }
  const parsed = zCounterReportBody.safeParse(full)
  if (!parsed.success) throw new Error(`signCounterReport: invalid body: ${parsed.error.issues[0]?.code}`)
  return { body: full, sig: toB64u(ed25519.sign(canonicalBytes(full), priv)) }
}

/**
 * Verify a report from an UNTRUSTED source: strict shape + signature under the
 * member's ADVERTISED key (`keyOf`, from presence/certs: a self-chosen key
 * proves nothing). Pure, never throws.
 */
export function verifyCounterReport(report: unknown, keyOf: (w: NodeId) => B64u | undefined): boolean {
  try {
    if (!zCounterReport.safeParse(report).success) return false
    const r = report as SignedCounterReport
    const key = keyOf(r.body.w)
    if (key === undefined) return false
    return verifySig(r.sig, canonicalBytes(r.body), key)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Merge (monotonic, gen-tagged) + misbehavior evidence
// ---------------------------------------------------------------------------

/** Self-authenticating misbehavior evidence: one member signed a regressing
 * pair: `later` claims a NEWER clock but a lower (gen, fails). Anyone holding
 * both signed reports can verify the regression with the member's key alone. */
export interface CounterRegression {
  w: NodeId
  earlier: SignedCounterReport
  later: SignedCounterReport
}

/** (gen, fails) lexicographic order. The monotonic axis of a member's counter. */
function reportRank(a: PinCounterReportBody, b: PinCounterReportBody): number {
  return a.gen - b.gen || a.fails - b.fails
}

export interface MergeResult {
  /** One report per member. The (gen, fails)-maximal one seen. */
  merged: Map<NodeId, SignedCounterReport>
  /** Regressions detected during THIS merge (evidence pairs). */
  regressions: CounterRegression[]
}

/**
 * Merge verified reports into a held per-member map: per member the
 * (gen, fails)-maximal report wins; a pair where the (gen, fails)-LOWER report
 * carries the STRICTLY NEWER asOfWts is a regression (the member signed a
 * shrinking counter) and is surfaced as evidence. Mutates nothing: returns a
 * fresh map. Reports must be pre-verified (verifyCounterReport).
 */
export function mergeCounterReports(
  held: ReadonlyMap<NodeId, SignedCounterReport>,
  incoming: readonly SignedCounterReport[],
): MergeResult {
  const merged = new Map(held)
  const regressions: CounterRegression[] = []
  for (const r of incoming) {
    const cur = merged.get(r.body.w)
    if (!cur) {
      merged.set(r.body.w, r)
      continue
    }
    const rank = reportRank(r.body, cur.body)
    if (rank > 0) {
      // r supersedes, but if the SUPERSEDED report claimed a newer clock, the
      // member regressed between the two signings.
      if (cur.body.asOfWts > r.body.asOfWts) regressions.push({ w: r.body.w, earlier: r, later: cur })
      merged.set(r.body.w, r)
    } else if (rank < 0) {
      if (r.body.asOfWts > cur.body.asOfWts) regressions.push({ w: r.body.w, earlier: cur, later: r })
      // held report stays (monotonic max).
    }
    // rank 0 (same gen+fails): identical count. Keep held.
  }
  return { merged, regressions }
}

// ---------------------------------------------------------------------------
// The converged statistic
// ---------------------------------------------------------------------------

/**
 * The committee-effective failure count over a CONVERGED merged report set
 * (≤1 report per member, pre-verified): max of the classic t-th-largest and
 * the trimmed-sum estimator (header math). Only reports from `committee`
 * members count; members without a report contribute 0. Deterministic,
 * integer-only. Returns 0 for an empty/foreign report set.
 */
export function convergedEffectiveCount(
  reports: Iterable<SignedCounterReport>,
  committee: readonly NodeId[],
  t: number,
): number {
  const cset = new Set(committee)
  const byMember = new Map<NodeId, number>()
  for (const r of reports) {
    if (!cset.has(r.body.w)) continue
    const cur = byMember.get(r.body.w)
    if (cur === undefined || r.body.fails > cur) byMember.set(r.body.w, r.body.fails)
  }
  const n = committee.length
  // Pad to committee size with zeros (a silent member is a zero report).
  const vals: number[] = [...byMember.values()]
  while (vals.length < n) vals.push(0)
  vals.sort((a, b) => b - a) // descending
  const tth = vals.length >= t && t >= 1 ? vals[t - 1] : 0
  const f = Math.max(0, n - t)
  let trimmedSum = 0
  for (let i = f; i < vals.length; i++) trimmedSum += vals[i]
  const divisor = Math.max(1, t - f) // = 2t − n when the threshold is a majority
  const trimmed = Math.ceil(trimmedSum / divisor)
  return Math.max(tth, trimmed)
}
