// A7 brick 2, Tier-2 VERDICT-ROW TRANSPORT over the A3 overlay: the
// fuse-record/pointers publish pattern (storage/pointers.ts: make → check →
// merge → store-validator → publish/enumerate) applied to the verdict rows
// tier2.ts/embed.ts left "embedder work". This module owns:
//
//   WRITE side, publishVerdicts: embed.publishVerdictRow's {key, row} pair
//     → a real overlay put under tier2VerdictKey(accusedRoot), guarded by a
//     STORE GATE (makeVerdictStoreValidator) verifying everything verifiable
//     WITHOUT window inputs: schema, sizes, the PARAMS_A5 pin, the lifetime
//     receipt, the suppression claim's necessary condition, the record
//     signature, commend-pattern key provenance, and the key binding, and a
//     deterministic MERGE (makeVerdictMerge) that accumulates rows across
//     publishers, bounded by ADOPT_ROW_MAX semantics.
//
//   READ side, fetchVerdictRow → verdictEvidence: fetch the merged row,
//     adopt it through embed.adoptVerdictRowJudge (the A5-33 judge-anchors
//     pin, NEVER weakened here: the ban path adopts ONLY records computed
//     under TIER2_ANCHORS_JUDGE, each fully re-verified from caller-supplied
//     window inputs), run embed.suppressionScan on the caller's VERIFIED
//     chain for every adopted CONVICTION-bearing record, and surface the
//     result as INJECTED evidence for ratings/display.ts displayState /
//     pairViewOf and mm/pairing.ts pairingLegal (their additive `ban` /
//     `banUntilWts` parameters: explicit arguments, never ambient state).
//
// ─── VALUE-KIND DECISION (registered for the lead) ─────────────────────────
// overlay/types.ts ValueKind is 'pointers'|'events'|'shard'|'record' and this
// lane may not extend it. Verdict rows therefore ride kind 'record',
// SHAPE-DISCRIMINATED: a value {v:1, verdicts:[...]} is treated as a verdict
// row by this layer's gate + merge (every record key-bound to its target, so
// junk cannot squat under a foreign key); any other 'record' value falls
// through to `base` untouched. When a dedicated 'verdicts' ValueKind lands
// (an ADDITIVE overlay change, lead-owned), only the kind test below moves.
//
// ─── THE ANTI-SUPPRESSION MERGE ORDER (spec-silent → decided fail-closed,
//     documented per the A7 owner directives) ───────────────────────────────
// The row is a capped union (dedup by record hash) in a TOTAL deterministic
// order, set-deterministic like the pointer cap fold: same record set ⇒ the
// same row bytes in every arrival order, so every carrier and every getMerged
// reader converge. The order is built from what a junk flood cannot freely
// dominate, most-protected first:
//   1. CLASS: conviction-shaped records (a full-reganK window whose CLAIMED
//      zMicro meets zThresholdMicro, or a lifetime receipt that RECOMPUTES to
//      conviction: exactly verifyTier2Verdict's two conviction arms, and for
//      kind 'suppression' the gate already refused anything else) before all
//      sub-conviction records. Junk that does not IMPERSONATE a 5σ conviction
//      can therefore NEVER displace conviction evidence, whatever its volume;
//      junk that does impersonate one is a SIGNED, permanently attributable
//      false-accusation artifact naming the accused (its signer is burned;
//      adoption always fails, §0 holds, but the signature survives as
//      misbehavior evidence).
//   2. FAIR SHARE per signer (the pointers rank2 rule): within a class, each
//      signer's records are indexed 0,1,2,… (its own order below) and round r
//      of every signer outranks round r+1 of any signer. ONE signer (the
//      realistic flood: the cheater's own device) can never crowd other
//      signers' round-0 records out, however many records it mints.
//   3. Judge-anchored records (body.anchors = TIER2_ANCHORS_JUDGE digest, the
//      only bundle the ban path adopts) before foreign-anchored ones; final
//      tie-break: record hash byte order (total order ⇒ byte-determinism).
// A signer's OWN records order by (anchorRank, ladder, window, kind, recId).
// Deterministic, so its round-0 pick is stable.
// RESIDUAL (documented, priced, non-destructive, Round-A adjudication of
// flag [d]): a MAINTAINED set of >ADOPT_ROW_MAX DISTINCT sybil signers, each
// minting a conviction-impersonating record (conviction class + judgeAnchored
// are body-claimable, round 0 is one-record-per-signer, recId is grindable via
// verdictWts), can crowd BOTH genuine judge records out of the top-ADOPT_ROW_MAX
// STORED row. §0 is intact: this can neither FORGE (adoption re-verifies every
// record from the reader's own window inputs: §0 absolute; an impersonator
// never adopts) NOR ERASE the conviction (it stays recomputable by anyone from
// chain bytes + Tier1Records, which entanglement makes unerasable). But the
// honest characterization is SUSTAINED denial of the STORED row's portability
// to fetch-only readers, not a transient "delay": the merge is a pure rank of
// the stored SET with no expiry, and recId is a canonical hash of the record,
// so an honest judge RE-PUBLISHING the SAME record yields the SAME recId and
// deterministically re-loses the same tie-break: re-publish is NOT a fix.
// Row portability returns only when carriers' stored rows expire, or when a
// serious §0 verifier RECOMPUTES the conviction from chain bytes rather than
// trusting a fetched row (the authoritative §8 path is independent of this
// transport row). Price: per-record attributable defamation signatures naming
// the accused (nil for a cheater flooding their OWN slot with burner keys).
// Round-B mitigation TRACKED (not landed here; needs a rank input sybils
// cannot mint, e.g. carrier-side per-signer admission pricing or reserving
// merged-row capacity for the accused's own on-chain selfban / for signers
// entangled with the accused). Fail-toward-no-forgery.
//
// Platform-neutral + deterministic (house rules): no `node:` imports, no DOM,
// no ambient time or randomness; integer math; builders throw typed errors,
// verifiers/gates/merges fail closed and never throw into the overlay.
//
// TWIN-SCHEMA NOTE: zVerdictRecord below structurally mirrors tier2.ts's
// PRIVATE record schema (zTier2VerdictBody/zTier2VerdictRecord; deliberately
// not exported there; the display.ts/pairing.ts twin-shape precedent). Do not
// let them drift: the transport suite feeds real makeTier2Verdict outputs
// through this gate, so any drift breaks it loudly.

import { z } from 'zod'
import { isRootSignedCert } from '../certs'
import {
  canonicalBytes,
  canonicalHash,
  compareKeys,
  type CanonicalObject,
  type CanonicalValue,
} from '../codec'
import { zB64u32, zB64u64 } from '../events'
import { toB64u, verifySigB64u } from '../hash'
import type { B64u, SignedEvent } from '../types'
import type { MergeFn } from '../overlay/node'
import type { OverlayNode, StoreValidator, ValueKind } from '../overlay/types'
import { TIER2_ANCHORS_JUDGE } from './anchors'
import {
  ADOPT_ROW_MAX,
  adoptVerdictRowJudge,
  publishVerdictRow,
  suppressionScan,
  type AdoptVerdictRow,
  type SuppressionScan,
} from './embed'
import { PARAMS_A5, PARAMS_A5_DIGEST } from './params'
import {
  LIFETIME_WINDOWS_MAX,
  lifetimeVerdict,
  tier2AnchorsDigest,
  tier2VerdictKey,
  WINDOW_ENTRIES_MAX,
  WINDOW_Z_CAP_MICRO,
  windowSalt,
  zSaltReveal,
  type SaltReveal,
  type Tier2VerdictRecord,
  type WindowEntry,
} from './tier2'

// ---------------------------------------------------------------------------
// Bounds (deterministic hygiene caps: validity rules, not revisable params)
// ---------------------------------------------------------------------------

/** Canonical-byte ceiling for ONE verdict record. Generous for the largest
 * legitimate record (a full LIFETIME_WINDOWS_MAX windowZs claim ≈ ~100 KB +
 * games/tier1/certs); closes byte-floods via padded records. */
export const VERDICT_MAX_BYTES = 256 * 1024

/** Stored-row canonical-byte budget (record bytes summed in the merge cap;
 * whole-row bytes at the store gate). Fits hundreds of typical window
 * verdicts or a handful of max-size lifetime claims. */
export const VERDICT_ROW_MAX_BYTES = 2 * 1024 * 1024

/** The judge anchor-bundle digest (A5-33): ranking prefers records the ban
 * path can actually adopt. Derived once. Pure and deterministic. */
const JUDGE_ANCHORS_DIGEST: B64u = tier2AnchorsDigest(TIER2_ANCHORS_JUDGE)

// ---------------------------------------------------------------------------
// Boundary schemas (twin of tier2.ts's private record schema, header note)
// ---------------------------------------------------------------------------

const zGameKey = z.string().min(1).max(128)

const zVerdictBody = z
  .strictObject({
    v: z.literal(1),
    kind: z.enum(['verdict', 'suppression']),
    root: zB64u32,
    ladder: z.string().min(1).max(64),
    window: z.int().min(0),
    zMicro: z.int(),
    games: z.array(zGameKey).min(1).max(WINDOW_ENTRIES_MAX),
    tier1: z.array(zB64u32).min(1).max(WINDOW_ENTRIES_MAX),
    anchors: zB64u32,
    params: zB64u32,
    verdictWts: z.int().min(0),
    deadlineEvent: zB64u32.optional(),
    lifetime: z
      .strictObject({
        zLifeMicro: z.int(),
        windows: z.int().min(1),
        windowZs: z
          .array(z.int().min(-WINDOW_Z_CAP_MICRO).max(WINDOW_Z_CAP_MICRO))
          .min(1)
          .max(LIFETIME_WINDOWS_MAX),
      })
      .optional(),
  })
  .refine((b) => b.games.length === b.tier1.length, { message: 'games/tier1 must be parallel' })
  .refine((b) => (b.kind === 'suppression') === (b.deadlineEvent !== undefined), {
    message: "deadlineEvent is required for 'suppression' and forbidden otherwise",
  })
  .refine((b) => b.lifetime === undefined || b.lifetime.windows === b.lifetime.windowZs.length, {
    message: 'lifetime.windows must equal lifetime.windowZs.length',
  })
  .refine(
    (b) =>
      b.lifetime === undefined ||
      b.kind !== 'verdict' ||
      (b.lifetime.windows === b.window + 1 && b.lifetime.windowZs[b.window] === b.zMicro),
    { message: "a 'verdict' lifetime claim must be evaluated AT the record's window" },
  )

const zVerdictRecord = z.strictObject({
  body: zVerdictBody,
  signer: zB64u32,
  key: zB64u32,
  sig: zB64u64,
  certs: z.array(z.unknown()).max(8).optional(),
})

/** The stored row shape at tier2VerdictKey(root): tier2.ts Tier2VerdictRow,
 * shape-parsed here at every untrusted boundary. */
const zVerdictRowShape = z.strictObject({
  v: z.literal(1),
  verdicts: z.array(z.unknown()).min(1),
})

/** Is this 'record' value shaped like a verdict row? (The kind-discrimination
 * test. Header VALUE-KIND DECISION.) */
export function isVerdictRowShaped(value: unknown): boolean {
  return zVerdictRowShape.safeParse(value).success
}

// ---------------------------------------------------------------------------
// Context-free record verification (the store gate's whole authority)
// ---------------------------------------------------------------------------

export type VerdictRecVerdict =
  | 'ok'
  | 'bad-record' // not shaped like a Tier2VerdictRecord (or verifier-internal throw)
  | 'oversize' // canonical bytes exceed the per-record ceiling
  | 'bad-params' // params digest does not name PARAMS_A5_DIGEST (never adoptable)
  | 'bad-lifetime' // lifetime receipt does not recompute from its own windowZs
  | 'bad-suppression' // suppression claim fails the conviction's necessary condition
  | 'bad-sig' // record signature by `key` does not verify
  | 'uncertified-key' // key/signer/certs violate the commend-pattern provenance
  | 'wrong-key' // record not bound to the target key (tier2VerdictKey(root) ≠ target)

/** What 'ok' verification yields: everything the merge ranks by. */
export interface CheckedVerdictRec {
  rec: Tier2VerdictRecord
  /** b64u(canonicalHash(record)). Dedupe identity + final tie-break. */
  recId: B64u
  /** Canonical record bytes (the merge's byte-budget unit). */
  bytes: number
  /** Header CLASS rank: true = conviction-shaped (rank 0). */
  conviction: boolean
  /** body.anchors names the judge bundle (rank within class). */
  judgeAnchored: boolean
}

export interface VerdictRecCheck {
  verdict: VerdictRecVerdict
  info?: CheckedVerdictRec
}

export interface VerdictCheckOpts {
  /** Per-record byte ceiling override; default VERDICT_MAX_BYTES. */
  maxBytes?: number
}

/** The two conviction arms, on the record's OWN claims. Exactly the shape
 * verifyTier2Verdict recomputes (window: a FULL reganK window meeting
 * zThresholdMicro; lifetime: lifetimeVerdict(windowZs).convicted). The window
 * zMicro is a CLAIM here (entries live with the adopter); the lifetime arm is
 * a context-free receipt (checked separately at the gate). */
function convictionShaped(b: Tier2VerdictRecord['body']): boolean {
  if (b.games.length === PARAMS_A5.reganK && b.zMicro >= PARAMS_A5.zThresholdMicro) return true
  if (b.lifetime === undefined) return false
  // Post-schema, windowZs is bounds-checked so lifetimeVerdict cannot throw
  // (the same guarantee tier2.ts's verifier relies on).
  return lifetimeVerdict(b.lifetime.windowZs).convicted
}

/**
 * The WINDOW conviction arm, CHAIN-RE-VERIFIED: the ONLY arm that may ground
 * a transport-injected ban (verdictEvidence).
 *
 * Applied to a record AFTER adoptVerdictRowJudge, b.zMicro IS the value
 * verifyTier2Verdict recomputed from the READER's OWN window entries (any
 * mismatch was rejected at adopt), so a full reganK window at/above threshold
 * is a 5σ conviction proven over the reader's chain bytes, never a claim.
 *
 * The LIFETIME arm is deliberately EXCLUDED here (it is NOT a substitute
 * conviction for the ban path): its windowZs are the record author's CLAIMS,
 * and neither the store gate nor adopt ever recomputes them against the
 * reader's chain: the auditor supplies entries for the ONE named window only,
 * so the fabricated prior-window zs are never checked. Treating a convicting
 * lifetime receipt as ban-grounding is exactly the §0 catastrophe: an honest
 * player whose real window is honest (window arm below threshold) but who
 * carries an attacker-fabricated `lifetime` would be permanently banned by
 * every verifier from network bytes alone. Until an auditor discharges the
 * windowZs chain-check (per-window reconstruction from the accused's chain;
 * caller wiring, brick 3/4), the lifetime arm grounds NO ban here: fail toward
 * no-forgery (§0), 5σ-window-conviction-only (A5-21). A record adopted purely
 * on its lifetime arm still travels and still adopts; it simply injects no ban.
 */
function windowConvictionProven(b: Tier2VerdictRecord['body']): boolean {
  return b.games.length === PARAMS_A5.reganK && b.zMicro >= PARAMS_A5.zThresholdMicro
}

/**
 * Verify ONE record as far as store-time context allows (header WRITE side):
 * shape, size, the PARAMS_A5 pin, the lifetime receipt, the suppression
 * claim's necessary condition, the record signature, and commend-pattern key
 * provenance (certs are inline, so provenance is fully context-free). What
 * this deliberately CANNOT verify, that zMicro recomputes from the window's
 * real entries, is exactly what adoption verifies on every reader (§0:
 * storing confers nothing; embed.adoptVerdictRow re-verifies everything).
 * `target` present ⇒ the key binding is checked too. Never throws.
 */
export function checkVerdictRecord(
  rec: unknown,
  opts: VerdictCheckOpts = {},
  target?: B64u,
): VerdictRecCheck {
  try {
    if (!zVerdictRecord.safeParse(rec).success) return { verdict: 'bad-record' }
    const r = rec as Tier2VerdictRecord
    const b = r.body

    // Byte ceiling FIRST (cheapest way to bound all later work).
    let bodyBytes: Uint8Array
    let recBytes: Uint8Array
    try {
      bodyBytes = canonicalBytes(b as unknown as CanonicalValue)
      recBytes = canonicalBytes(r as unknown as CanonicalValue)
    } catch {
      return { verdict: 'bad-record' }
    }
    if (recBytes.length > (opts.maxBytes ?? VERDICT_MAX_BYTES)) return { verdict: 'oversize' }

    // Necessary conditions of EVER adopting (verifyTier2Verdict mirrors).
    // A record failing any of these is dead weight no reader can ever use.
    if (b.params !== PARAMS_A5_DIGEST) return { verdict: 'bad-params' }
    if (b.lifetime !== undefined && lifetimeVerdict(b.lifetime.windowZs).zLifeMicro !== b.lifetime.zLifeMicro)
      return { verdict: 'bad-lifetime' }
    if (b.kind === 'suppression' && !convictionShaped(b)) return { verdict: 'bad-suppression' }

    // Signature + commend-pattern provenance (conduct.ts rules, context-free:
    // certs ride inline and are ROOT-signed by the signer).
    if (!verifySigB64u(r.sig, bodyBytes, r.key)) return { verdict: 'bad-sig' }
    if (r.key === r.signer) {
      if (r.certs !== undefined) return { verdict: 'uncertified-key' } // certs must be absent
    } else {
      const certs = r.certs
      if (certs === undefined || certs.length === 0) return { verdict: 'uncertified-key' }
      let proven = false
      for (const c of certs) {
        const info = isRootSignedCert(r.signer, c as SignedEvent)
        if (info !== null && info.pub === r.key) {
          proven = true
          break
        }
      }
      if (!proven) return { verdict: 'uncertified-key' }
    }

    // Key binding: the row slot is the ACCUSED's, derived. Never claimed.
    if (target !== undefined && tier2VerdictKey(b.root) !== target) return { verdict: 'wrong-key' }

    return {
      verdict: 'ok',
      info: {
        rec: r,
        recId: toB64u(canonicalHash(r as unknown as CanonicalObject)),
        bytes: recBytes.length,
        conviction: convictionShaped(b),
        judgeAnchored: b.anchors === JUDGE_ANCHORS_DIGEST,
      },
    }
  } catch {
    return { verdict: 'bad-record' } // verifiers fail closed, never throw
  }
}

/** Verdict-only convenience over checkVerdictRecord. */
export function verifyVerdictRecord(rec: unknown, opts: VerdictCheckOpts = {}, target?: B64u): VerdictRecVerdict {
  return checkVerdictRecord(rec, opts, target).verdict
}

// ---------------------------------------------------------------------------
// Deterministic merge (capped union: header ANTI-SUPPRESSION ORDER)
// ---------------------------------------------------------------------------

export interface VerdictMergeOpts {
  /** Stored-row record cap; default embed.ADOPT_ROW_MAX (transport stays
   * consistent with the adopt path's deterministic first-N prefix rule: a
   * merged row is always fully within the examined prefix). */
  capPerRow?: number
  /** Record-byte budget for the stored row; default VERDICT_ROW_MAX_BYTES. */
  rowMaxBytes?: number
  /** Per-record ceiling; default VERDICT_MAX_BYTES. */
  maxBytes?: number
  /** Fallback for non-verdict-shaped 'record' values and every other kind.
   * Default: replace (the overlay's own default merge). */
  base?: MergeFn
}

const asValue = (v: unknown): CanonicalObject => v as CanonicalObject
const baseReplace: MergeFn = (_prev, next) => next

/** Shape-parse a row into candidate records (individually schema-shaped ONLY.
 * Verification is the caller's). Rows beyond `cap` records are sliced to
 * the first `cap` (the adopt path's deterministic-prefix rule: row order is
 * part of the published bytes, so every honest party examines the same
 * prefix; this also CPU-bounds hostile rows fed raw into getMerged folds). */
function rowRecords(value: unknown, cap: number): unknown[] {
  if (!isVerdictRowShaped(value)) return []
  const raw = (value as { verdicts: unknown[] }).verdicts
  return raw.length > cap ? raw.slice(0, cap) : raw
}

interface RankEntry extends CheckedVerdictRec {
  /** Per-signer fair-share round within the class (header rule 2). */
  round: number
}

/** The total deterministic order (header): class → per-signer round →
 * judge-anchor rank → record id. Pure function of the record SET. */
function orderVerdictEntries(list: CheckedVerdictRec[]): RankEntry[] {
  const ranked: RankEntry[] = []
  for (const convictionClass of [true, false]) {
    const bySigner = new Map<B64u, CheckedVerdictRec[]>()
    for (const e of list) {
      if (e.conviction !== convictionClass) continue
      const arr = bySigner.get(e.rec.signer) ?? []
      arr.push(e)
      bySigner.set(e.rec.signer, arr)
    }
    for (const arr of bySigner.values()) {
      // A signer's own deterministic order decides which record takes its
      // round-0 slot: judge-anchored first, then (ladder, window, kind, id).
      arr.sort(
        (a, b) =>
          Number(b.judgeAnchored) - Number(a.judgeAnchored) ||
          (a.rec.body.ladder < b.rec.body.ladder ? -1 : a.rec.body.ladder > b.rec.body.ladder ? 1 : 0) ||
          a.rec.body.window - b.rec.body.window ||
          (a.rec.body.kind === b.rec.body.kind ? 0 : a.rec.body.kind === 'suppression' ? -1 : 1) ||
          compareKeys(a.recId, b.recId),
      )
      arr.forEach((e, i) => ranked.push({ ...e, round: i }))
    }
  }
  ranked.sort(
    (a, b) =>
      Number(b.conviction) - Number(a.conviction) ||
      a.round - b.round ||
      Number(b.judgeAnchored) - Number(a.judgeAnchored) ||
      compareKeys(a.recId, b.recId),
  )
  return ranked
}

/**
 * The verdict-row fold (overlay MergeFn), pointers-pattern: union prev ∪ next
 * (dedup by record hash), re-verify every NEWLY-ARRIVED record context-free
 * (prev passed the gate when stored; getMerged folds start from null, so
 * every record a reader accumulates has passed it), enforce the per-subject
 * key binding, order per the header rules, and cap deterministically (record
 * count ≤ capPerRow AND record bytes ≤ rowMaxBytes; a record that would
 * overflow the byte budget is skipped, later smaller records still fit,
 * deterministic skip-and-continue). A stored verdict row is NEVER replaced by
 * a non-verdict 'record' value (prev is protected; an attacker cannot blank
 * a row by writing junk over it). On internal error: prev (fail closed).
 */
export function makeVerdictMerge(o: VerdictMergeOpts = {}): MergeFn {
  const cap = o.capPerRow ?? ADOPT_ROW_MAX
  const rowBudget = o.rowMaxBytes ?? VERDICT_ROW_MAX_BYTES
  const checkOpts: VerdictCheckOpts = { ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}) }
  const base = o.base ?? baseReplace
  return (prev, next, kind, target) => {
    if (kind !== 'record') return base(prev, next, kind, target)
    try {
      // KEY-DOMAIN DISCIPLINE (composition-safe: Round-A finding fix). Verdict
      // rows are shape-discriminated but the STORE KEY is what actually owns a
      // record: a record belongs at `target` only when tier2VerdictKey(root) ===
      // target (checkVerdictRecord's binding check). So this fold NEVER decides
      // ownership by value SHAPE alone; it collects every record that BINDS to
      // `target` from BOTH sides and emits a row ONLY if at least one does.
      //
      // BOTH sides re-check through the same context-free core (a deliberate
      // divergence from the pointers fold, which trusts prev inductively): the
      // row is capped, publishes are rare, and full re-verification keeps the
      // emitted row's invariant one-line: every record passed checkVerdictRecord
      // against THIS target in THIS fold. It also makes genuine-prev protection
      // structural: a stored row's own records re-bind and re-enter the union,
      // so junk written over a real row can never blank it (no shape-based
      // prev-shortcut needed). next-side checking is load-bearing regardless:
      // raw find-value responses fold through here from null in getMerged.
      const seen = new Set<B64u>()
      const union: CheckedVerdictRec[] = []
      for (const value of [prev, next]) {
        if (value === null) continue
        for (const raw of rowRecords(value, cap)) {
          const c = checkVerdictRecord(raw, checkOpts, target)
          if (c.verdict !== 'ok' || !c.info) continue
          if (seen.has(c.info.recId)) continue
          seen.add(c.info.recId)
          union.push(c.info)
        }
      }
      // NOTHING binds to this key ⇒ this is not a verdict slot in THIS fold.
      // DELEGATE to `base` rather than manufacture an empty verdict row: a
      // manufactured {v:1,verdicts:[]} is self-recognized as a verdict row and
      // would shadow a co-installed layer's genuine row (e.g. the composed
      // social-presence gate) for the rest of a getMerged fold. Standalone base
      // = replace; the store validator + adopt still refuse any non-binding row.
      if (union.length === 0) return base(prev, next, kind, target)
      const ranked = orderVerdictEntries(union)
      const kept: Tier2VerdictRecord[] = []
      let bytes = 0
      for (const e of ranked) {
        if (kept.length >= cap) break
        if (bytes + e.bytes > rowBudget) continue // skip, keep scanning (deterministic)
        bytes += e.bytes
        kept.push(e.rec)
      }
      return asValue({ v: 1, verdicts: kept })
    } catch {
      return prev ?? base(prev, next, kind, target) // fail closed; never manufacture a row
    }
  }
}

// ---------------------------------------------------------------------------
// Store gate (installed on the overlay node), the write-time index
// ---------------------------------------------------------------------------

export interface VerdictStoreOpts {
  /** Per-record byte ceiling; default VERDICT_MAX_BYTES. */
  maxBytes?: number
  /** Offered/stored row byte budget; default VERDICT_ROW_MAX_BYTES. */
  rowMaxBytes?: number
  /** Stored-row record cap; default embed.ADOPT_ROW_MAX. */
  capPerRow?: number
  /** Fallback gate for values this layer does not own. Default mirrors the
   * overlay's own default: accept 'record', refuse the rest. Compose with
   * the shard/pointer gates via THEIR `base` hooks to gate every kind. */
  base?: StoreValidator
  /** Fallback merge for non-verdict values (see VerdictMergeOpts.base). */
  baseMerge?: MergeFn
}

export interface VerdictStoreGate {
  validator: StoreValidator
  merge: MergeFn
}

/**
 * Build the verdict layer's STORE gate for one node. A kind-'record' value
 * shaped like a verdict row is accepted only when it is within the row caps
 * and EVERY record in it (1) passes the full context-free verification
 * (checkVerdictRecord: schema, size, params pin, lifetime receipt,
 * suppression claim, signature, key provenance) and (2) is bound to the
 * target key: tier2VerdictKey(record.body.root) === target. All-or-nothing
 * per offered row (an honest publisher's row is entirely its own; junk rides
 * only by DISCARDING the publisher's own put). Non-verdict-shaped 'record'
 * values and all other kinds fall through to `base`. Growth is bounded by the
 * merge's deterministic cap. Refusal is honest degradation (StoreRes
 * stored:false), never an error.
 */
export function makeVerdictStoreValidator(opts: VerdictStoreOpts = {}): VerdictStoreGate {
  const cap = opts.capPerRow ?? ADOPT_ROW_MAX
  const rowBudget = opts.rowMaxBytes ?? VERDICT_ROW_MAX_BYTES
  const checkOpts: VerdictCheckOpts = { ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}) }
  const base: StoreValidator = opts.base ?? ((_f, _t, kind, _v) => kind === 'record')

  const validator: StoreValidator = (from, target, kind, value) => {
    try {
      if (kind !== 'record' || !isVerdictRowShaped(value)) return base(from, target, kind, value)
      const raw = (value as unknown as { verdicts: unknown[] }).verdicts
      if (raw.length > cap) return false
      if (canonicalBytes(value as unknown as CanonicalValue).length > rowBudget) return false
      for (const rec of raw) {
        if (checkVerdictRecord(rec, checkOpts, target).verdict !== 'ok') return false
      }
      return true
    } catch {
      return false // gates fail closed, never throw into the overlay
    }
  }

  return {
    validator,
    merge: makeVerdictMerge({
      capPerRow: cap,
      rowMaxBytes: rowBudget,
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.baseMerge !== undefined ? { base: opts.baseMerge } : {}),
    }),
  }
}

// ---------------------------------------------------------------------------
// A5-18 canonical-reveal publication slot (A7): ONE authoritative SaltReveal
// per (root, ladder, window) in storage. The salt VALUE is already pinned by
// consensusSaltOpts (any valid reveal ⇒ the same salt when the witnessSet is
// supplied), so this slot's whole job is CONVERGENT PUBLICATION: every peer
// deterministically keeps the same single reveal. Canonical pick = the valid,
// key-bound reveal with the lexicographic-least canonical hash. Pure
// function of the record set, no arrival-order dependence. Anchorless
// reveals are refused at the gate (the consensus-path duty; a reveal that
// commits to no post-game entropy has no business in the slot).
// ---------------------------------------------------------------------------

const SALT_REVEAL_KEY_TAG = 'cs:a7:saltreveal:v1'
/** Generous ceiling: 64 grants ≈ 64·~200 canonical bytes + header. */
export const SALT_REVEAL_MAX_BYTES = 32 * 1024

/** The slot key for (root, ladder, window). Domain-separated from every
 * other key family (nodeId/pointer/presence/mailbox/verdict). */
export function saltRevealKey(root: B64u, ladder: string, windowIndex: number): B64u {
  return toB64u(canonicalHash({ t: SALT_REVEAL_KEY_TAG, root, ladder, window: windowIndex }))
}

/** Cheap shape probe (zSaltReveal is the real authority in the gate). */
export function isSaltRevealShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as { v?: unknown; scheme?: unknown; grants?: unknown }
  return v.v === 1 && typeof v.scheme === 'string' && Array.isArray(v.grants)
}

/** Full context-free validity for the slot: schema, key binding, byte cap,
 * anchor present, and the canonical verifier computes a salt from it
 * (windowSalt re-verifies every grant signature over the anchored body).
 * Never throws. */
function saltRevealOk(value: unknown, target: B64u): value is SaltReveal {
  try {
    if (!zSaltReveal.safeParse(value).success) return false
    const r = value as SaltReveal
    if (r.anchor === undefined) return false
    if (saltRevealKey(r.root, r.ladder, r.window) !== target) return false
    if (canonicalBytes(r as unknown as CanonicalObject).length > SALT_REVEAL_MAX_BYTES) return false
    windowSalt(r, { requireAnchor: true })
    return true
  } catch {
    return false
  }
}

export interface SaltRevealGateOpts {
  base?: StoreValidator
  baseMerge?: MergeFn
}

/** The reveal slot's store gate + merge, composable via base hooks exactly
 * like the verdict layer (install order between the two is irrelevant;
 * their key families are disjoint and both delegate non-owned values). */
export function makeSaltRevealGate(opts: SaltRevealGateOpts = {}): VerdictStoreGate {
  const base: StoreValidator = opts.base ?? ((_f, _t, kind, _v) => kind === 'record')
  const baseMerge: MergeFn = opts.baseMerge ?? ((prev, next) => (prev === null ? next : prev))
  const validator: StoreValidator = (from, target, kind, value) => {
    try {
      if (kind !== 'record' || !isSaltRevealShaped(value)) return base(from, target, kind, value)
      return saltRevealOk(value, target)
    } catch {
      return false
    }
  }
  const merge: MergeFn = (prev, next, kind, target) => {
    if (kind !== 'record') return baseMerge(prev, next, kind, target)
    try {
      const candidates: { r: SaltReveal; h: B64u }[] = []
      for (const value of [prev, next]) {
        if (value === null || !isSaltRevealShaped(value)) continue
        if (!saltRevealOk(value, target)) continue
        const r = value as unknown as SaltReveal
        candidates.push({ r, h: toB64u(canonicalHash(r as unknown as CanonicalObject)) })
      }
      // Nothing binds ⇒ not a reveal slot in THIS fold. Delegate, never
      // manufacture (the verdict merge's composition discipline, verbatim).
      if (candidates.length === 0) return baseMerge(prev, next, kind, target)
      candidates.sort((a, b) => compareKeys(a.h, b.h))
      return asValue(candidates[0].r as unknown as CanonicalObject)
    } catch {
      return prev ?? baseMerge(prev, next, kind, target)
    }
  }
  return { validator, merge }
}

/** Publish a reveal into its slot (replicateK carriers re-gate it). */
export function publishSaltReveal(node: OverlayNode, reveal: SaltReveal): Promise<number> {
  if (!saltRevealOk(reveal, saltRevealKey(reveal.root, reveal.ladder, reveal.window)))
    throw new Error('publishSaltReveal: not a valid anchored reveal')
  return node.put(
    saltRevealKey(reveal.root, reveal.ladder, reveal.window),
    'record',
    asValue(reveal as unknown as CanonicalObject),
  )
}

/** Fetch the canonical reveal for (root, ladder, window); null when absent
 * or invalid. getMerged-first so all carriers' slots fold to the one pick. */
export async function fetchSaltReveal(
  node: VerdictReadNode,
  root: B64u,
  ladder: string,
  windowIndex: number,
): Promise<SaltReveal | null> {
  const key = saltRevealKey(root, ladder, windowIndex)
  const raw = node.getMerged ? await node.getMerged(key, 'record') : await node.get(key, 'record')
  if (raw === null || !isSaltRevealShaped(raw)) return null
  return saltRevealOk(raw, key) ? (raw as unknown as SaltReveal) : null
}

// ---------------------------------------------------------------------------
// Publish / fetch (the WRITE-time index; viewing never searches)
// ---------------------------------------------------------------------------

/**
 * Publish verdict records into the overlay under the ACCUSED's deterministic
 * slot: embed.publishVerdictRow builds + key-binds the row (throwing tier2
 * builder rules: ≥1 record, one accused root), then ONE put offers it to the
 * replicateK closest carriers, each re-verifying through its own gate.
 * Returns the number of true stores.
 */
export function publishVerdicts(node: OverlayNode, recs: readonly Tier2VerdictRecord[]): Promise<number> {
  const { key, row } = publishVerdictRow(recs)
  return node.put(key, 'record', asValue(row))
}

/** Minimal read surface (pointers PointerReadNode twin): any OverlayNode;
 * with getMerged (OverlayNodeExt) the fetch folds ALL carriers' rows. */
export interface VerdictReadNode {
  get(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
  getMerged?(target: B64u, kind: ValueKind): Promise<CanonicalObject | null>
}

/** Fetch a subject's merged verdict row. The row is UNVERIFIED bytes. Feed
 * it to verdictEvidence (judge-pinned adopt) / embed.adoptVerdictRow. */
export async function fetchVerdictRow(
  node: VerdictReadNode,
  subjectRoot: B64u,
): Promise<{ key: B64u; row: CanonicalObject | null }> {
  const key = tier2VerdictKey(subjectRoot)
  const row = node.getMerged ? await node.getMerged(key, 'record') : await node.get(key, 'record')
  return { key, row }
}

// ---------------------------------------------------------------------------
// Read-side evidence (adopt → scan → the injected ban input)
// ---------------------------------------------------------------------------

/** §9 "suppression → permanent": the injected-permanent-ban sentinel, as a
 * safe-integer wts every consumer's `until > atWts` comparison honors
 * forever (displayState / pairViewOf / pairingLegal hasActiveBan). */
export const PERMANENT_BAN_UNTIL_WTS = Number.MAX_SAFE_INTEGER

export interface VerdictScanEntry {
  /** The adopted (fully re-verified) conviction-bearing record. */
  rec: Tier2VerdictRecord
  /** The record's window-completing game the §8 scan anchored on
   * (body.games[last]: the final ordinal of the convicting full window /
   * the lifetime claim's closing window). */
  convictionGame: string
  /** The reader's OWN chain-side §8 scan from that game. */
  scan: SuppressionScan
  /** kind 'suppression' only: the reader's scan reproduced the record's
   * claimed deadlineEvent EXACTLY. An unconfirmed suppression claim is
   * surfaced but NEVER what the ban rests on (the reader's own scan is). */
  claimConfirmed?: boolean
}

export interface LadderVerdictEvidence {
  ladder: string
  /** True iff the reader's own scan proved a §8 suppression for ANY adopted
   * conviction on this ladder (5σ recomputed + chain-side absence; the
   * exact tier2.ts auditor facts). */
  suppressed: boolean
  /** Present iff suppressed: the injected evidence for displayState /
   * pairViewOf (`ban`) and PairView.banUntilWts (`ban.until`). Permanent
   * (§9). A COMPLIANT selfban never appears here. The chain fold's banStep
   * owns the served 90-day term (read it from fold state, not transport). */
  ban?: { until: number }
  /** Every adopted conviction-bearing record + its scan, in adopt order. */
  records: VerdictScanEntry[]
}

export interface VerdictEvidence {
  /** The full judge-pinned adopt result (A5-33). Junk/foreign-anchor records
   * are rejected here with typed errors; only `adopted` fed the scans. */
  adopt: AdoptVerdictRow
  /** Per-ladder evidence, keyed by ladder id (only ladders with ≥1 adopted
   * CONVICTION-bearing record appear. Sub-conviction records never do). */
  ladders: { [ladder: string]: LadderVerdictEvidence }
}

export interface VerdictEvidenceOpts {
  /** The accused account the row was fetched for. */
  subjectRoot: B64u
  /** The storage key the row arrived under (fetchVerdictRow returns it). */
  key: B64u
  /** The fetched row (untrusted bytes → parsed value). */
  row: unknown
  /** The reader's OWN chain-derived window inputs per record (adopt
   * contract: null ⇒ that record is rejected, never adopted unverified). */
  entriesFor: (rec: Tier2VerdictRecord, index: number) => readonly WindowEntry[] | null
  /** The accused's chain events IN CHAIN ORDER from the reader's own
   * ALREADY-VERIFIED chain (verifyChain truth: same layering as every
   * fold). Malformed input THROWS (embed.suppressionScan's fail-closed
   * builder rule): this is the caller's own trusted data, not network junk. */
  chainEvents: readonly SignedEvent[]
}

/**
 * The composed READ path (kickoff brick 2): judge-pinned adopt → §8 chain
 * scan → injected evidence.
 *
 * BAN-PATH INVARIANTS (asserted end-to-end in the transport suite):
 *  · 5σ-WINDOW-CONVICTION-ONLY (A5-21 + §0): only adopted records whose
 *    RE-VERIFIED window carries a conviction. A full reganK window whose
 *    zMicro RECOMPUTED from the reader's own entries meets zThresholdMicro.
 *    Reach the scan (windowConvictionProven). A 3σ escalation-shaped record,
 *    a sub-conviction record, AND a record convicting only on its lifetime
 *    windowZs (author claims this auditor never recomputes against the chain)
 *    all contribute NOTHING here and never yield any ban input. Grounding a
 *    ban on an unrecomputed lifetime receipt would permanently ban an honest
 *    player from fabricated bytes (escalation obliges analysis, never a
 *    deadline; banDeadline / lifetime semantics live untouched in embed.ts).
 *  · §0 NO-FALSE-FRAUD: the ban evidence rests on the READER's OWN facts.
 *    The conviction re-verified from its own window inputs and the §8
 *    absence scan over its own verified chain (embed-1 leniency included: a
 *    compliant same-ladder selfban ALWAYS discharges, junk in the row
 *    notwithstanding, and yields NO evidence here: the fold's banStep owns
 *    the served term). An adopted 'suppression' record whose deadlineEvent
 *    the reader's scan does not reproduce is reported (claimConfirmed:
 *    false) but grounds nothing.
 *  · NO FORGERY: a record that does not fully re-verify from the reader's
 *    own inputs is never adopted, so no flood can mint evidence; scan kind
 *    'pending' (deadline not yet passed) and 'compliant' inject nothing.
 *
 * Suppression ⇒ permanent distrust (§8/§9): ban.until =
 * PERMANENT_BAN_UNTIL_WTS. Thread the result explicitly:
 *   displayState(ladderState, cat, evidence.ban, atWts)   → 'banned'
 *   pairViewOf(..., mergedBan(foldBan, evidence.ban), atWts)
 *   pairingLegal(view, other, atWts)                      → 'banned'.
 * Never ambient state; the evidence parameter is the injection seam.
 */
export function verdictEvidence(o: VerdictEvidenceOpts): VerdictEvidence {
  const adopt = adoptVerdictRowJudge({
    subjectRoot: o.subjectRoot,
    key: o.key,
    row: o.row,
    entriesFor: o.entriesFor,
  })
  const ladders: { [ladder: string]: LadderVerdictEvidence } = {}
  for (const rec of adopt.adopted) {
    const b = rec.body
    // A5-21 + §0: ONLY the CHAIN-RE-VERIFIED window arm may feed the ban path.
    // Post-adopt, b.zMicro IS the value recomputed from THIS reader's own
    // window entries (a mismatch was rejected at adopt), so this is a proven 5σ
    // conviction: never a claim. A sub-conviction record, an escalation, OR a
    // record convicting only on its (unrecomputed) lifetime windowZs all
    // contribute NOTHING here: the lifetime windowZs are author claims this
    // auditor never checks against the chain, so grounding a permanent ban on
    // them would ban an honest player from fabricated bytes (windowConvictionProven).
    if (!windowConvictionProven(b)) continue
    const convictionGame = b.games[b.games.length - 1]
    const scan = suppressionScan(o.chainEvents, convictionGame, b.ladder)
    const entry: VerdictScanEntry = {
      rec,
      convictionGame,
      scan,
      ...(b.kind === 'suppression'
        ? { claimConfirmed: scan.kind === 'suppressed' && scan.deadlineEvent === b.deadlineEvent }
        : {}),
    }
    const l = ladders[b.ladder] ?? { ladder: b.ladder, suppressed: false, records: [] }
    l.records.push(entry)
    if (scan.kind === 'suppressed') {
      l.suppressed = true
      l.ban = { until: PERMANENT_BAN_UNTIL_WTS }
    }
    ladders[b.ladder] = l
  }
  return { adopt, ladders }
}

/** Convenience accessor: the injected ban evidence for one ladder (undefined
 * = transport contributes no ban. Fold state may still carry a selfban). */
export function banEvidenceOf(ev: VerdictEvidence, ladder: string): { until: number } | undefined {
  return Object.prototype.hasOwnProperty.call(ev.ladders, ladder) ? ev.ladders[ladder].ban : undefined
}

/**
 * Compose the fold's in-chain selfban entry with injected suppression
 * evidence into the ONE `ban` argument displayState/pairViewOf take: the
 * later expiry wins (the same monotonic-max rule as the fold's banStep).
 * Malformed entries are ignored (displayState's own tolerance; a malformed
 * ban is no ban, never a crash). */
export function mergedBan(
  foldBan: { until: number } | undefined,
  evidence: { until: number } | undefined,
): { until: number } | undefined {
  const ok = (x: { until: number } | undefined): x is { until: number } =>
    x !== undefined && typeof x.until === 'number' && Number.isSafeInteger(x.until) && x.until >= 0
  const a = ok(foldBan) ? foldBan : undefined
  const b = ok(evidence) ? evidence : undefined
  if (a === undefined) return b === undefined ? undefined : { until: b.until }
  if (b === undefined) return { until: a.until }
  return { until: Math.max(a.until, b.until) }
}
