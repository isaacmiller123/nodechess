// A2 fabric-core: witnessed time (spec §4). A witnessed timestamp for an
// event/record is the MEDIAN of the attesting nodes' independently observed
// clock readings, valid iff every SURVIVING attester sits within timeWindowMs
// of that median; claims bearing on account age, ban expiry, or staleness
// additionally require ≥ timeDiversityMin attesters that are entanglement-distant
// from the subject (a self-adjacent witness cannot mint accepted time).
//
// Pure + deterministic: cjson-v1 is integer-only, so the median of an even count
// FLOORS the mean of the two central order statistics. No float ever enters a
// verified value. Platform-neutral: no `node:` imports, no DOM globals.

import type { NodeId, WitnessedTime } from './types'

/**
 * Integer median of a value set (cjson-v1 has no floats). Odd count → the
 * central order statistic; even count → floor((lo+hi)/2) of the two central
 * ones. Throws on an empty set (callers guard). Deterministic: sorts a copy.
 */
export function medianInt(values: readonly number[]): number {
  if (values.length === 0) throw new Error('medianInt: empty set')
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  if (s.length % 2 === 1) return s[mid]
  return Math.floor((s[mid - 1] + s[mid]) / 2)
}

/** One node's independently observed clock reading, keyed by its nodeId. */
export interface TimeSample {
  w: NodeId
  wts: number
}

export interface WitnessedTimeParams {
  timeWindowMs: number
  /** ≥ this many entanglement-distant survivors are needed for diversityOk. */
  timeDiversityMin: number
}

export interface WitnessedTimeOpts {
  /** True iff the attester is entanglement-distant from the subject (§4). When
   * omitted every survivor counts toward diversity (a plain timestamp needs no
   * age/ban diversity. Only the caller that reads diversityOk enforces it). */
  distant?: (w: NodeId) => boolean
}

/**
 * Compute the witnessed timestamp of a set of clock samples:
 *  1. dedup by nodeId (one node contributes one reading: first occurrence wins),
 *  2. take the integer median over the deduped set (the anchor),
 *  3. SURVIVORS = deduped samples within ±timeWindowMs of that median (out-of-
 *     window attesters invalidate only themselves; they leave the median, which
 *     was taken over the full deduped set, untouched),
 *  4. diversityOk iff ≥ timeDiversityMin survivors are entanglement-distant.
 * Returns null when there are no samples. Pure and deterministic.
 */
export function witnessedTime(
  samples: readonly TimeSample[],
  params: WitnessedTimeParams,
  opts: WitnessedTimeOpts = {},
): WitnessedTime | null {
  // 1. dedup by nodeId, first occurrence wins (deterministic order preserved).
  const seen = new Set<NodeId>()
  const deduped: TimeSample[] = []
  for (const s of samples) {
    if (seen.has(s.w)) continue
    seen.add(s.w)
    deduped.push(s)
  }
  if (deduped.length === 0) return null

  // 2. median over the full deduped set.
  const medianWts = medianInt(deduped.map((s) => s.wts))

  // 3. survivors within the window; sorted by nodeId for a byte-stable result.
  const survivors = deduped
    .filter((s) => Math.abs(s.wts - medianWts) <= params.timeWindowMs)
    .sort((a, b) => (a.w < b.w ? -1 : a.w > b.w ? 1 : 0))

  // 4. entanglement-distant diversity among survivors.
  const distant = opts.distant ?? (() => true)
  const distinctDistant = survivors.filter((s) => distant(s.w)).length

  return {
    medianWts,
    attesters: survivors.map((s) => s.w),
    diversityOk: distinctDistant >= params.timeDiversityMin,
  }
}
