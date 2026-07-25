// A6 L3. The A5→A6 EMBEDDER SEAMS of the Tier-2 judge (tier2.ts): the pure
// caller-side helpers the A5 review deferred (A5-17/A5-18 residual wiring,
// A5-20/A5-21 deadline min, A5-33 adopt binding). This module IMPORTS from
// tier2.ts and never re-implements it. Platform-neutral (§0/§8 doctrine): no
// `node:` imports, no DOM, no ambient time or randomness; integers and
// strings only, floor semantics, bit-identical results everywhere.
// Fail-closed: builders/derivations throw EmbedInputError; the adopt path is
// a VERIFIER (typed result, never throws).
//
// The four seams, and the exact deferred duty each closes:
//
// (a) banDeadline: A5-20/A5-21 residual ("the caller-side deadline min at
//     the conviction line remains A6 embedder work"). escalationDue reports
//     BOTH conviction firings losslessly (trailing-K `conviction.atIndex`
//     and the lifetime prefix `conviction.lifetime.windows = W`) because it
//     never sees the salted partition and so cannot order them; only the
//     partition-holding caller can name the lifetime firing's chain ordinal
//     b(W)−1. banDeadline takes that caller-supplied resolver and anchors
//     the §8 self-ban deadline on the EARLIEST conviction firing by chain
//     ordinal. CONVICTION-ANCHORED ONLY (A5-21, owner decision 2026-07-22:
//     "an honest player is never banned"): the 3σ escalation firings
//     (`atIndex`/`lifetime` on the verdict itself) NEVER produce a deadline.
//     An escalation-only verdict yields null, and a claimed "conviction"
//     whose z sits below zThresholdMicro is refused as malformed (no
//     false-fraud path can be minted through this helper).
//
// (b) consensusSaltOpts + windowAnchor. The A5-17/A5-18 embedder wiring.
//     tier2.ts keeps salt verification thin: deriving the canonical witness
//     set needs a directory snapshot, and deriving the post-game anchor
//     needs the chain. Both embedder context. consensusSaltOpts builds the
//     ONLY SaltVerifyOpts the consensus/verdict path may use: the canonical
//     witnessSet pin (A5-18: the salt becomes a unique function of (root,
//     ladder, window, witnessSet), grind-proof) with requireAnchor
//     hard-wired true (A5-17: an anchorless, predictable-before reveal is
//     rejected). windowAnchor derives the anchor input per the A5-17
//     contract: a domain-separated digest of the rated-game key at chain
//     ordinal w·K−1 of the ladder's rated-game list: the LATEST ordinal
//     guaranteed < b(w) for every off(w) ∈ [0, K), so non-circular, fixed
//     only after that game is chained, and recomputable-after by anyone
//     holding the chain. (The remaining witness-node SIGNING-TIME discipline
//     is witness-side behavior, ratified-deferred, not expressible in this
//     platform-neutral core.)
//
// (c) suppressionScan. The read-time auditor flow of tier2.ts's
//     architectural rule (b): suppression (CONVICTION fired on-chain with no
//     timely selfban) is established by an auditor scanning CHAIN BYTES, and
//     the scan here is the chain-side absence check the verdict verifier
//     delegates ("no selfban precedes deadlineEvent: the auditor's
//     chain-bytes duty"). Given the accused's events in chain order and the
//     conviction-completing game, the §8 rule is exact: the NEXT witnessed-
//     lane event after that game must be the compliant selfban; the first
//     OTHER witnessed-lane event is the deadlineEvent a suppression record
//     names. Personal-lane events never count (§8 obliges the witnessed
//     lane); a schema-valid selfban for a DIFFERENT ladder is skipped, not a
//     violation: two ladders convicting near-simultaneously force the
//     honest client to append its selfbans in SOME order, and condemning the
//     second obligation for the first's selfban would ban-trap a compliant
//     client (§0 forbids). Upfront full-domain validation (the ratified
//     A5-21 rule): every event is shape-checked before any scanning, so
//     throw behavior is input-shape-determined, never scan-depth-determined.
//
// (d) publishVerdictRow / adoptVerdictRow: the A5-33 binding rule for the
//     ban path, made structural. Publish binds a verdictRow to its
//     deterministic shard-space key tier2VerdictKey(accusedRoot) as a
//     {key, row} storage pair (the fuse-record/pointers pattern: overlay
//     transport stays A3 storage). Adopt is the verify side phones use on a
//     network-fetched row: EVERY record is re-verified against caller-
//     supplied window inputs via verifyTier2Verdict before acceptance.
//     Nothing is ever adopted unverified (missing inputs reject, §0), and
//     every record's `anchors` digest must name the required bundle.
//     adoptVerdictRowJudge pins that bundle to anchors.ts
//     TIER2_ANCHORS_JUDGE (A5-33: the ONLY set that may feed T / the ban
//     path); the anchors-injected core stays exported so historic receipts
//     remain re-verifiable under the exact bundle they were computed with
//     (tier2.ts header contract).

import { eventId, zSelfBanPayload } from '../events'
import { concatBytes, sha256, toB64u, utf8 } from '../hash'
import type { B64u, EventId, SelfBanPayload, SignedEvent } from '../types'
import type { NodeId } from '../witness/types'
import { TIER2_ANCHORS_JUDGE } from './anchors'
import { PARAMS_A5 } from './params'
import {
  LIFETIME_WINDOWS_MAX,
  tier2AnchorsDigest,
  tier2VerdictKey,
  verdictRow,
  verifyTier2Verdict,
  type EscalationVerdict,
  type SaltVerifyOpts,
  type Tier2Anchors,
  type Tier2VerdictRecord,
  type Tier2VerdictRow,
  type WindowEntry,
} from './tier2'

// ---------------------------------------------------------------------------
// Errors + tiny helpers
// ---------------------------------------------------------------------------

/** Malformed embedder-seam input. Fail-closed: derivations throw this; the
 * adopt verifier never throws (typed result). */
export class EmbedInputError extends Error {
  override readonly name = 'EmbedInputError'
}

// Explicitly typed CONST (not just the arrow's return type) so TS applies
// never-call reachability analysis after `bad(...)` statements.
const bad: (msg: string) => never = (msg) => {
  throw new EmbedInputError(msg)
}

/** Non-negative safe integer (rejects -0). */
function isNonNegInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0)
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

// ---------------------------------------------------------------------------
// (a) banDeadline: the §8 deadline anchor (conviction-only, min by ordinal)
// ---------------------------------------------------------------------------

/** The resolved §8 self-ban deadline anchor: the conviction-completing
 * game's CHAIN ORDINAL in the ladder's rated-game list. The compliant
 * client's next witnessed-lane event after this game must be the selfban;
 * the ban expiry anchors on this game's witnessed time (selfBanExpiryWts). */
export interface BanDeadline {
  /** Ordinal (index into the ladder's chain-ordered rated-game list) of the
   * conviction-completing game: games[atIndex] for the trailing-K arm,
   * b(W)−1 (caller-resolved) for the lifetime arm. */
  ordinal: number
  /** Which conviction arm fired earliest in chain order. */
  source: 'trailingK' | 'lifetime'
  /** trailingK only: the completing game's key (from the verdict). */
  game?: string
  /** lifetime only: the convicting closed-window count W. */
  lifetimeWindows?: number
}

/**
 * THE §8 self-ban deadline anchor (A5-20/A5-21 residual closed): the minimum
 * BY CHAIN ORDINAL over the CONVICTION firings of an escalationDue verdict.
 * `resolveLifetimeOrdinal` is the partition-holding caller's map from a
 * convicting closed-window count W to the chain ordinal of the game closing
 * window W−1: b(W)−1 of the salted partition (windowStart(W, offsetOf) − 1).
 * The piece tier2.ts structurally cannot compute (it never sees the
 * partition); it is only invoked when the lifetime arm actually convicted,
 * and its answer is integrity-checked against the partition geometry
 * b(W)−1 ∈ [W·K−1, (W+1)·K−2] (header §BOUNDARY JITTER). An out-of-range
 * resolver is a broken caller and fails closed rather than mint a wrong
 * deadline.
 *
 * CONVICTION-ANCHORED ONLY (A5-21): a verdict without a `conviction` report
 * (including a 3σ escalation-only firing) returns null: NO deadline, no
 * ban obligation, ever (escalation obliges only the deeper analysis; an
 * honest player is never banned). Fail-closed (EmbedInputError) on every
 * malformed shape, including a claimed conviction whose z sits below
 * PARAMS_A5.zThresholdMicro: this helper refuses to anchor a ban on
 * sub-5σ evidence no matter what the caller asserts (§0 no-false-fraud).
 */
export function banDeadline(
  escalation: EscalationVerdict,
  resolveLifetimeOrdinal: (windows: number) => number,
): BanDeadline | null {
  if (!isPlainObject(escalation)) bad('banDeadline: escalation is not an object')
  if (typeof escalation.due !== 'boolean') bad('banDeadline: escalation.due is not a boolean')
  if (typeof resolveLifetimeOrdinal !== 'function') bad('banDeadline: resolveLifetimeOrdinal is not a function')
  const c = escalation.conviction
  // A5-21: no conviction ⇒ no deadline. This covers due:false AND the 3σ
  // escalation-only verdict: escalation firings never produce a deadline.
  if (c === undefined) return null
  if (!isPlainObject(c)) bad('banDeadline: conviction is not an object')
  if (escalation.due !== true)
    bad('banDeadline: conviction present on a not-due verdict, structurally impossible (conviction ⇒ escalation)')
  const K = PARAMS_A5.reganK
  // Trailing-K arm: all three fields travel together (escalationDue contract).
  let trailing: { ordinal: number; game: string } | null = null
  if (c.atIndex !== undefined || c.game !== undefined || c.zMicro !== undefined) {
    const atIndex = c.atIndex
    const game = c.game
    const zMicro = c.zMicro
    if (!isNonNegInt(atIndex) || atIndex < K - 1)
      bad(`banDeadline: conviction.atIndex must be a safe integer ≥ ${K - 1} (a trailing-K window completes there)`)
    if (typeof game !== 'string' || game.length === 0 || game.length > 128)
      bad('banDeadline: conviction.game must be a 1..128-char game key')
    if (typeof zMicro !== 'number' || !Number.isSafeInteger(zMicro) || zMicro < PARAMS_A5.zThresholdMicro)
      bad(
        `banDeadline: conviction.zMicro below zThresholdMicro ${PARAMS_A5.zThresholdMicro}. Refusing to anchor a ban on sub-conviction evidence (A5-21/§0)`,
      )
    trailing = { ordinal: atIndex, game }
  }
  // Lifetime arm: resolve W → b(W)−1 via the caller, then bound-check.
  let lifetime: { ordinal: number; windows: number } | null = null
  if (c.lifetime !== undefined) {
    const l = c.lifetime
    if (!isPlainObject(l)) bad('banDeadline: conviction.lifetime is not an object')
    if (!isNonNegInt(l.windows) || l.windows < 1 || l.windows > LIFETIME_WINDOWS_MAX)
      bad(`banDeadline: conviction.lifetime.windows must be an integer in [1, ${LIFETIME_WINDOWS_MAX}]`)
    if (typeof l.zLifeMicro !== 'number' || !Number.isSafeInteger(l.zLifeMicro) || l.zLifeMicro < PARAMS_A5.zThresholdMicro)
      bad(
        `banDeadline: conviction.lifetime.zLifeMicro below zThresholdMicro ${PARAMS_A5.zThresholdMicro}. Refusing to anchor a ban on sub-conviction evidence (A5-21/§0)`,
      )
    let r: number
    try {
      r = resolveLifetimeOrdinal(l.windows)
    } catch {
      bad('banDeadline: resolveLifetimeOrdinal threw')
    }
    const lo = l.windows * K - 1
    const hi = (l.windows + 1) * K - 2
    if (!isNonNegInt(r!) || r! < lo || r! > hi)
      bad(
        `banDeadline: resolveLifetimeOrdinal(${l.windows}) = ${String(r!)} outside the partition bound [${lo}, ${hi}] (b(W)−1 geometry)`,
      )
    lifetime = { ordinal: r!, windows: l.windows }
  }
  if (trailing === null && lifetime === null) bad('banDeadline: conviction carries neither arm')
  // Min by chain ordinal; a tie is the same game. Report the arm that
  // carries the game key.
  if (trailing !== null && (lifetime === null || trailing.ordinal <= lifetime.ordinal))
    return { ordinal: trailing.ordinal, source: 'trailingK', game: trailing.game }
  const l = lifetime as { ordinal: number; windows: number }
  return { ordinal: l.ordinal, source: 'lifetime', lifetimeWindows: l.windows }
}

// ---------------------------------------------------------------------------
// (b) consensusSaltOpts + windowAnchor: the A5-17/A5-18 consensus wiring
// ---------------------------------------------------------------------------

/** Domain separator of the A5-17 post-game anchor. Fixed forever (the same
 * immutability class as SALT_BODY_TAG: structural derivation). */
export const ANCHOR_TAG = 'cs:a6:t2anchor:v1'

/**
 * The SaltVerifyOpts the CONSENSUS/VERDICT path MUST use (tier2.ts header:
 * "the CONSENSUS/verdict path MUST supply witnessSet" + "requireAnchor gates
 * it ON for the consensus/verdict path"): the canonical witnessSet pin
 * (A5-18: the salt becomes a unique, grind-proof function of (root, ladder,
 * window, witnessSet)) with requireAnchor hard-wired true (A5-17. An
 * anchorless, predictable-before reveal is rejected). Deriving the canonical
 * witness set from a directory snapshot remains the caller's duty; this
 * helper makes the two flags impossible to forget or misconfigure.
 * Fail-closed on a malformed set (empty, oversize, duplicate, or non-NodeId
 * members): a consensus path fed a broken set must not silently degrade to
 * the reveal-defined legacy salt.
 */
export function consensusSaltOpts(witnessSet: readonly NodeId[], tLease?: number): SaltVerifyOpts {
  if (!Array.isArray(witnessSet)) bad('consensusSaltOpts: witnessSet is not an array')
  if (witnessSet.length === 0 || witnessSet.length > 64)
    bad('consensusSaltOpts: witnessSet must carry 1..64 members')
  const seen = new Set<string>()
  for (const w of witnessSet) {
    if (typeof w !== 'string' || w.length !== 43)
      bad('consensusSaltOpts: witnessSet member is not a 32-byte b64u NodeId')
    if (seen.has(w)) bad(`consensusSaltOpts: duplicate witnessSet member ${w}`)
    seen.add(w)
  }
  if (tLease !== undefined && (!isNonNegInt(tLease) || tLease === 0))
    bad('consensusSaltOpts: tLease must be a positive safe integer when supplied')
  return {
    ...(tLease !== undefined ? { tLease } : {}),
    witnessSet: [...witnessSet],
    requireAnchor: true,
  }
}

/**
 * The A5-17 post-game anchor for window w, derived from the ladder's
 * chain-ordered rated-game key list (fold.ts's rated gate defines
 * membership, ordinals 0,1,2,… in witnessed chain order): a domain-separated
 * sha256 of the game key at ordinal w·K−1. Per the tier2.ts contract, the
 * LATEST ordinal guaranteed < b(w) for every off(w) ∈ [0, K), so the value
 * is non-circular (never inside window w), fixed only AFTER that game is
 * chained (§7b unpredictable-before), and exactly recomputable by anyone
 * holding the chain (recomputable-after). Feed the result to signSaltGrant /
 * SaltReveal.anchor; verify the published reveal's anchor equals this
 * derivation: that equality IS the "anchor ties to the true chain ordinal"
 * auditor duty tier2.ts delegates.
 *
 * Fail-closed: windowIndex must be ≥ 1 (window 0 has no jittered boundary,
 * b(0) = 0 needs no salt and ordinal −1 does not exist), and the anchor game
 * must already be chained (list long enough). Deriving an anchor for games
 * not yet played is exactly the §7b hole this closes.
 */
export function windowAnchor(ratedGameKeys: readonly string[], windowIndex: number): B64u {
  if (!Array.isArray(ratedGameKeys)) bad('windowAnchor: ratedGameKeys is not an array')
  if (!isNonNegInt(windowIndex) || windowIndex < 1)
    bad('windowAnchor: windowIndex must be a safe integer ≥ 1 (window 0 has no jittered boundary)')
  const ordinal = windowIndex * PARAMS_A5.reganK - 1
  if (ordinal >= ratedGameKeys.length)
    bad(
      `windowAnchor: anchor game ordinal ${ordinal} is not chained yet (${ratedGameKeys.length} rated games). The anchor exists only after the games preceding b(w) are played`,
    )
  const key = ratedGameKeys[ordinal]
  if (typeof key !== 'string' || key.length === 0 || key.length > 128)
    bad(`windowAnchor: rated game key at ordinal ${ordinal} is not a 1..128-char string`)
  return toB64u(sha256(concatBytes(utf8(ANCHOR_TAG), utf8(key))))
}

// ---------------------------------------------------------------------------
// (c) suppressionScan: the read-time auditor's chain-side absence check
// ---------------------------------------------------------------------------

export type SuppressionScan =
  /** The next witnessed-lane event after the conviction game is a compliant
   * selfban: the obligation was discharged; no suppression exists. */
  | { kind: 'compliant'; selfBanEvent: EventId; selfBan: SelfBanPayload }
  /** No witnessed-lane event follows the conviction game yet: the deadline
   * has not passed; nothing to prove either way. */
  | { kind: 'pending' }
  /** The first witnessed-lane event after the conviction game is NOT the
   * obliged selfban: deadlineEvent is what a suppression record mints
   * (Tier2VerdictBody.deadlineEvent, kind 'suppression'). */
  | { kind: 'suppressed'; deadlineEvent: EventId; deadlineType: string }

/**
 * The chain-side absence scan a suppression record asserts (tier2.ts:
 * "NO selfban followed before deadlineEvent. The chain-side absence scan is
 * the auditor's, against chain bytes"). Input: the accused's chain events in
 * chain order (from an already-VERIFIED chain: signature/linkage truth is
 * verifyChain's, the same layering as every fold), the conviction-completing
 * game's key (games[conviction.atIndex] for a trailing-K conviction, or the
 * game at the banDeadline-resolved ordinal b(W)−1 for a lifetime one), and
 * the convicted ladder.
 *
 * The §8 rule, exactly (selfBanDueNow doc): after the conviction-completing
 * game's segment, the compliant client's NEXT witnessed-lane event MUST be
 * the selfban. Personal-lane events are ignored (§8 obliges the witnessed
 * lane only). A schema-valid selfban for a DIFFERENT ladder is SKIPPED.
 * Neither compliant nor a violation (near-simultaneous convictions on two
 * ladders force some append order; condemning one obligation for honoring
 * the other would ban-trap a compliant client, which §0 forbids, and the
 * skip yields nothing to a cheater: the deadline still fires on the first
 * consequential event). ANY same-ladder schema-valid anticheat selfban
 * discharges the obligation: its `window` and `expiryWts` values are NEVER
 * compliance criteria (A6 review embed-1, §0): `window` has no
 * protocol-pinned value across the two conviction arms (types.ts calls it
 * the salted window index; a trailing-K conviction has no such index), and
 * `expiryWts` is ADVISORY. The A5-22 fold derives the real §9 term from the
 * selfban EVENT's witnessed ts and ignores the payload field entirely, so
 * condemning a client over an inert number would mint false suppression.
 * Only a MALFORMED payload (schema-invalid) fails to discharge and is itself
 * the deadline event (a compliant client never appends a malformed selfban).
 *
 * deadlineEvent contract note (A6 review embed-4): tier2.ts's "the first
 * witnessed-lane event appended after the completing game" phrasing assumes
 * the single-obligation case. This scan's rule is the §0-consistent
 * generalization: the first NON-EXEMPT witnessed-lane event, where the sole
 * exemption is another ladder's anticheat selfban. Auditors verifying a
 * suppression record's chain-side claims MUST apply the same exemption.
 *
 * Fail-closed (EmbedInputError), with UPFRONT full-domain validation (the
 * ratified A5-21 rule. Throw behavior is input-shape-determined, never
 * scan-depth-determined): every event is shape-checked and the conviction
 * game located across the WHOLE list before any verdict logic runs; a
 * missing or duplicated conviction segment, mixed roots, or any malformed
 * event refuses the scan entirely.
 */
export function suppressionScan(
  chainEvents: readonly SignedEvent[],
  convictionGame: string,
  ladder: string,
): SuppressionScan {
  if (!Array.isArray(chainEvents)) bad('suppressionScan: chainEvents is not an array')
  if (typeof convictionGame !== 'string' || convictionGame.length === 0 || convictionGame.length > 128)
    bad('suppressionScan: convictionGame must be a 1..128-char game key')
  if (typeof ladder !== 'string' || ladder.length === 0 || ladder.length > 64)
    bad('suppressionScan: ladder must be a 1..64-char string')
  // Upfront full-domain validation + conviction-game location (whole list).
  let root: string | null = null
  let convIndex = -1
  for (let i = 0; i < chainEvents.length; i++) {
    const ev = chainEvents[i]
    if (!isPlainObject(ev) || !isPlainObject(ev.body)) bad(`suppressionScan: event[${i}] is malformed`)
    const b = ev.body
    if (b.lane !== 'w' && b.lane !== 'p') bad(`suppressionScan: event[${i}].body.lane must be 'w' | 'p'`)
    if (typeof b.type !== 'string' || b.type.length === 0 || b.type.length > 32)
      bad(`suppressionScan: event[${i}].body.type is not a 1..32-char string`)
    if (typeof b.root !== 'string' || b.root.length !== 43)
      bad(`suppressionScan: event[${i}].body.root is not a 32-byte b64u`)
    if (root === null) root = b.root
    else if (b.root !== root) bad(`suppressionScan: event[${i}] names a different root. One accused chain only`)
    if (!isPlainObject(b.payload)) bad(`suppressionScan: event[${i}].body.payload is not an object`)
    if (b.lane === 'w' && b.type === 'segment' && (b.payload as Record<string, unknown>).game === convictionGame) {
      if (convIndex !== -1)
        bad(`suppressionScan: conviction game appears in two segments (events ${convIndex} and ${i}), malformed chain`)
      convIndex = i
    }
  }
  if (convIndex === -1)
    bad('suppressionScan: the conviction-completing game has no segment on this chain. The scan is undefined without it')
  const id = (ev: SignedEvent): EventId => {
    try {
      return eventId(ev.body)
    } catch {
      return bad('suppressionScan: event body is not canonically hashable')
    }
  }
  // The scan proper: the first witnessed-lane event after the conviction
  // segment decides.
  for (let i = convIndex + 1; i < chainEvents.length; i++) {
    const ev = chainEvents[i]
    const b = ev.body
    if (b.lane !== 'w') continue // personal lane never counts (§8)
    if (b.type === 'selfban') {
      const p = zSelfBanPayload.safeParse(b.payload)
      if (p.success) {
        const sb = p.data as SelfBanPayload
        if (sb.ladder !== ladder) continue // another ladder's obligation. Skip (doc above)
        // embed-1 (§0): a schema-valid same-ladder selfban ALWAYS discharges
        // the obligation: window/expiryWts are never compliance criteria
        // (doc above); the fold imposes the real term regardless.
        return { kind: 'compliant', selfBanEvent: id(ev), selfBan: sb }
      }
      // Malformed selfban payload: never compliant. Falls through to the
      // deadline (a compliant client never appends a malformed selfban).
    }
    return { kind: 'suppressed', deadlineEvent: id(ev), deadlineType: b.type }
  }
  return { kind: 'pending' }
}

// ---------------------------------------------------------------------------
// (d) publishVerdictRow / adoptVerdictRow: storage binding + verified adopt
// ---------------------------------------------------------------------------

/** The {key, row} storage pair verdict records publish as: key is the
 * deterministic shard-space slot under the ACCUSED's key. */
export interface VerdictRowPublish {
  key: B64u
  row: Tier2VerdictRow
}

/**
 * Bind verdict records to their shard-space slot (the fuse-record/pointers
 * pattern): row = verdictRow(recs) (all records must name the same accused
 * root: enforced there), key = tier2VerdictKey(that root). The overlay
 * publish / store-gate / merge transport is A3 storage work, unchanged.
 * Builder: throws (Tier2InputError from the tier2.ts builders) on misuse.
 */
export function publishVerdictRow(recs: readonly Tier2VerdictRecord[]): VerdictRowPublish {
  const row = verdictRow(recs)
  return { key: tier2VerdictKey(row.verdicts[0].body.root), row }
}

/** Max records one adopt call will verify (bounds untrusted-row work). */
export const ADOPT_ROW_MAX = 256

export interface AdoptVerdictRowOpts {
  /** The accused account the row is being adopted FOR. The key binding and
   * every record's body.root are checked against it. */
  subjectRoot: B64u
  /** The storage key the row arrived under. Must equal
   * tier2VerdictKey(subjectRoot) (a row under the wrong slot is rejected). */
  key: B64u
  /** The fetched row (untrusted bytes → parsed JSON). */
  row: unknown
  /** The anchor bundle every record MUST bind to: each record's
   * body.anchors must equal tier2AnchorsDigest(anchors). For the BAN path
   * use adoptVerdictRowJudge (pins TIER2_ANCHORS_JUDGE; A5-33). */
  anchors: Tier2Anchors
  /** The verifier's own window inputs for record i (chain-derived entries,
   * sides/elos + Tier1Records). Return null when unavailable: the record is
   * REJECTED, never adopted unverified (§0). */
  entriesFor: (rec: Tier2VerdictRecord, index: number) => readonly WindowEntry[] | null
}

export interface AdoptVerdictRow {
  /** True iff EVERY record in the row verified and was adopted. */
  ok: boolean
  /** Deterministic, sorted error strings (`adopt:` row-level,
   * `adopt[i]:` per-record). */
  errors: string[]
  /** The fully-verified records, in row order: the only ones a consumer
   * (pairingLegal/displayState injection, selfban verdict reference) may
   * act on. */
  adopted: Tier2VerdictRecord[]
}

/**
 * The verify-side adopt path (tier2.ts: "phones adopt + spot-check
 * network-computed verdicts"). Never throws. A verifier fails closed with
 * typed errors. A record is adopted iff ALL of: the row sits under the
 * subject's deterministic key; the record names the subject root; its
 * `anchors` digest names the supplied bundle (checked BEFORE any input
 * gathering, so a foreign-anchor record is rejected outright: A5-33); the
 * caller supplied the window inputs; and verifyTier2Verdict fully
 * recomputes it from those inputs (shape, params pin, tier1 digests, exact
 * zMicro bits, suppression conviction condition, key provenance,
 * signature). Records failing ANY check are rejected individually; nothing
 * is ever adopted unverified. The chain-side claims (entries really are the
 * named window; no selfban precedes a suppression's deadlineEvent: see
 * suppressionScan) remain the auditor's chain-bytes duties, per the
 * verifier header contract.
 */
export function adoptVerdictRow(o: AdoptVerdictRowOpts): AdoptVerdictRow {
  const errors: string[] = []
  const adopted: Tier2VerdictRecord[] = []
  try {
    if (!isPlainObject(o) || typeof o.entriesFor !== 'function')
      return { ok: false, errors: ['adopt: malformed options'], adopted: [] }
    let expectedKey: B64u
    let anchorsDigest: B64u
    try {
      expectedKey = tier2VerdictKey(o.subjectRoot)
    } catch {
      return { ok: false, errors: ['adopt: malformed subjectRoot'], adopted: [] }
    }
    try {
      anchorsDigest = tier2AnchorsDigest(o.anchors)
    } catch {
      return { ok: false, errors: ['adopt: malformed anchors bundle'], adopted: [] }
    }
    if (o.key !== expectedKey)
      return { ok: false, errors: ['adopt: row key is not tier2VerdictKey(subjectRoot), wrong slot'], adopted: [] }
    const row = o.row as Tier2VerdictRow
    if (!isPlainObject(row) || row.v !== 1 || !Array.isArray(row.verdicts) || row.verdicts.length === 0)
      return { ok: false, errors: ['adopt: malformed verdict row'], adopted: [] }
    // A6 review embed-2: an over-cap row must NEVER wholesale-suppress the
    // valid evidence inside it: one shaped junk record past the cap would
    // otherwise erase genuine convictions (per-record isolation is the whole
    // point of this verifier). Deterministic rule: examine exactly the first
    // ADOPT_ROW_MAX records in row order (row order is part of the published
    // bytes, so every honest adopter examines the same prefix); the overflow
    // is reported, never silently dropped.
    const nExamined = Math.min(row.verdicts.length, ADOPT_ROW_MAX)
    if (row.verdicts.length > ADOPT_ROW_MAX)
      errors.push(
        `adopt: row carries ${row.verdicts.length} records. Only the first ${ADOPT_ROW_MAX} are examined (deterministic prefix; overflow rejected, never adopted)`,
      )
    for (let i = 0; i < nExamined; i++) {
      const rec = row.verdicts[i]
      if (!isPlainObject(rec) || !isPlainObject(rec.body)) {
        errors.push(`adopt[${i}]: malformed record`)
        continue
      }
      if (rec.body.root !== o.subjectRoot) {
        errors.push(`adopt[${i}]: record names a different accused root than the subject`)
        continue
      }
      if (rec.body.anchors !== anchorsDigest) {
        errors.push(`adopt[${i}]: anchors digest does not name the required bundle (A5-33 binding)`)
        continue
      }
      let entries: readonly WindowEntry[] | null
      try {
        entries = o.entriesFor(rec, i)
      } catch {
        errors.push(`adopt[${i}]: entriesFor threw`)
        continue
      }
      if (entries === null) {
        errors.push(`adopt[${i}]: window inputs unavailable. Never adopt unverified (§0)`)
        continue
      }
      const v = verifyTier2Verdict(rec, { entries, anchors: o.anchors })
      if (!v.ok) {
        for (const e of v.errors) errors.push(`adopt[${i}]: ${e}`)
        continue
      }
      adopted.push(rec)
    }
    errors.sort()
    return { ok: errors.length === 0, errors, adopted }
  } catch {
    return { ok: false, errors: ['adopt: internal'], adopted: [] } // verifiers fail closed
  }
}

/**
 * The BAN-path adopt (A5-33 made structural): identical to adoptVerdictRow
 * with the anchor bundle PINNED to anchors.ts TIER2_ANCHORS_JUDGE. The only
 * set that may feed T or ground a ban. Any record computed under a different
 * bundle (however internally consistent) is rejected with the A5-33 binding
 * error. Use the injected core only for re-verifying historic receipts under
 * the exact bundle they name (tier2.ts header contract). Never to ban.
 */
export function adoptVerdictRowJudge(o: Omit<AdoptVerdictRowOpts, 'anchors'>): AdoptVerdictRow {
  return adoptVerdictRow({ ...o, anchors: TIER2_ANCHORS_JUDGE })
}
