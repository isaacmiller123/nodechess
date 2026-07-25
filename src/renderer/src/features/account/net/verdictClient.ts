// A6 M5 (lane L-t2), LIVE ANTICHEAT Tier-2: the deterministic escalation
// trigger → Tier-2 deep analysis → 5σ conviction → self-ban appended BEFORE any
// further witnessed event → verdict rows published/adopted over the running
// AccountPeer overlay (spec §8 escalation/conviction, §9 ban term).
//
// The whole Tier-2 substrate is ALREADY BUILT + tested and this module
// REIMPLEMENTS NONE OF IT: it COMPOSES it onto a live overlay node, exactly as
// shardDuty.ts composes the §5 storage substrate and pinClient.ts composes the
// §1 committee substrate:
//
//   · judge/tier2.ts:     escalationDue (the deterministic §8 trigger + the 5σ
//                         conviction report), makeTier2Verdict (reproducible
//                         signed verdict), makeSelfBanPayload / selfBanExpiryWts
//                         (§8 deadline / §9 term), selfBanDueNow (the gate).
//   · judge/embed.ts:     banDeadline (the conviction-anchored §8 deadline min),
//                         suppressionScan (the read-time chain-side auditor),
//                         publishVerdictRow / adoptVerdictRowJudge (A5-33 bind).
//   · judge/transport.ts, the A3-overlay WRITE/READ index for verdict rows:
//                         makeVerdictStoreValidator (+ merge), publishVerdicts,
//                         fetchVerdictRow, verdictEvidence (adopt → §8 scan →
//                         the injected pairingLegal/displayState ban input).
//
// The renderer-hosted layers here are:
//   1. makeVerdictDutyGate:   the overlay STORE-ACCEPT gate for kind-'record'
//      verdict rows (transport's makeVerdictStoreValidator), composed over the
//      M3 storage gate so ONE validator/merge gates every kind. The lead hands
//      {validator, merge} to startAccountPeer (see notesForLead).
//   2. assessEscalation:      run the deterministic trigger on OUR OWN
//      chain-derived rated-game window (the L-t1 judgeRunner/fold seam supplies
//      the games + Tier1Records + closed-window zs); classify honest / escalate
//      (3σ, deeper analysis only) / convicted (5σ, the ban anchor).
//   3. buildConvictionVerdict + buildSelfBan: on OUR 5σ conviction, the
//      reproducible verdict record over the convicting window + the §8/§9
//      self-ban payload that references its digest.
//   4. publishVerdictRows / fetchAndAdoptVerdicts / fetchBanEvidence. The live
//      overlay put/get: publish OUR conviction under the accused key; adopt +
//      re-verify OTHERS' rows (judge-anchor-pinned); run suppressionScan on a
//      subject's chain to surface the injected ban evidence.
//   5. createVerdictClient.   An app-lifetime controller the lead starts on
//      sign-in: it self-audits our ladders, publishes+self-bans on conviction,
//      and: critically: GATES every further witnessed append behind the §8
//      self-ban (guardBeforeWitnessed), degrading honestly when the ban cannot
//      yet be witnessed. The un-fixtured FairPlayTab/SelfBanDialog (lane L-ui)
//      read its honest state.
//
// Honest degradation (spec C-8/§0): every scarcity, signed out, no peer, no
// reachable carrier, no lease to witness the self-ban, is a typed NO-OP, never
// a crash and NEVER a false ban (a 3σ escalation obliges deeper analysis, never
// a self-ban; only the deterministic 5σ conviction ever grounds one, A5-21).
//
// PLATFORM-SPECIFIC renderer hosting (it drives a live OverlayNode); every byte
// is A5/A7 crypto from @shared, so src/shared/accounts stays pure. Clocks, the
// overlay node, the chain-derived window inputs, the signer, and the witnessed
// self-ban APPEND are all INJECTED, so the whole path runs headless over a
// MockFabric fleet (scripts/test-accounts-verdict-client.mjs) exactly as it runs
// in the browser.

import type { B64u, SelfBanPayload, SignedEvent } from '@shared/accounts/types'
import type { MergeFn, OverlayNode, OverlayNodeExt, StoreValidator } from '@shared/accounts/overlay'
import {
  PARAMS_A5,
  TIER2_ANCHORS_JUDGE,
  adoptVerdictRowJudge,
  banDeadline,
  escalationDue,
  makeSelfBanPayload,
  makeTier2Verdict,
  selfBanDueNow,
  selfBanExpiryWts,
  suppressionScan,
  tier2VerdictDigest,
  tier2VerdictKey,
  type AdoptVerdictRow,
  type BanDeadline,
  type EscalationVerdict,
  type LadderGameRef,
  type SuppressionScan,
  type Tier1Record,
  type Tier2Anchors,
  type Tier2VerdictRecord,
  type WindowEntry,
} from '@shared/accounts/judge'
import {
  fetchVerdictRow,
  makeVerdictStoreValidator,
  publishVerdicts,
  verdictEvidence,
  type VerdictEvidence,
  type VerdictReadNode,
} from '@shared/accounts/judge/transport'

// ---------------------------------------------------------------------------
// 1. The overlay STORE-ACCEPT gate (compose transport's gate onto the peer)
// ---------------------------------------------------------------------------

export interface VerdictDutyGateOpts {
  /** Fallback validator for values this layer does not own (kinds other than a
   *  verdict-row-shaped 'record'). Default: the overlay's own record-only gate.
   *  In prod: the M3 makeStorageDutyGate().validator, so ONE composed validator
   *  gates shard/events/pointers/record. */
  base?: StoreValidator
  /** Fallback merge for non-verdict values. Default: replace. In prod: the M3
   *  storage merge, so verdict rows union while pointers/events keep theirs. */
  baseMerge?: MergeFn
  /** Per-record / row byte + count overrides (transport defaults otherwise). */
  maxBytes?: number
  rowMaxBytes?: number
  capPerRow?: number
}

/** The installed verdict store gate: the composed validator + merge to hand
 *  startAccountPeer. */
export interface VerdictDutyGate {
  /** Pass as startAccountPeer `validator`. */
  validator: StoreValidator
  /** Pass as startAccountPeer `overlay.merge`. */
  merge: MergeFn
}

/**
 * Build the overlay's verdict-row STORE gate by wrapping transport.ts's frozen
 * makeVerdictStoreValidator (the fuse-record/pointers publish pattern applied to
 * verdict rows): a kind-'record' value shaped like a verdict row is accepted
 * only when every record passes the full context-free verification AND binds to
 * tier2VerdictKey(accusedRoot) === target; non-verdict values fall through to
 * `base`. Nothing here reimplements a verifier: it wires the one the transport
 * suite already proved, composing it over the M3 storage gate so the peer runs
 * ONE validator/merge for every kind (see notesForLead).
 */
export function makeVerdictDutyGate(opts: VerdictDutyGateOpts = {}): VerdictDutyGate {
  const gate = makeVerdictStoreValidator({
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.baseMerge !== undefined ? { baseMerge: opts.baseMerge } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.rowMaxBytes !== undefined ? { rowMaxBytes: opts.rowMaxBytes } : {}),
    ...(opts.capPerRow !== undefined ? { capPerRow: opts.capPerRow } : {}),
  })
  return { validator: gate.validator, merge: gate.merge }
}

// ---------------------------------------------------------------------------
// 2. The accused-side self-audit: the deterministic escalation trigger (§8)
// ---------------------------------------------------------------------------

/**
 * One ladder's chain-derived Tier-2 window inputs: the L-t1 judgeRunner / a4
 * fold seam (INJECTED, never derived here). `games` is the ladder's
 * chain-ordered rated-game list with the accused's color + strength (elo/RD)
 * ENTERING each game; `records` are the Tier-1 outputs judgeRunner produced for
 * every rated game (§8: Tier-1 runs on all of them, so a compliant chain has
 * them by construction). `closedWindowZs` (the ladder's closed SALTED windows'
 * zMicro, chain order, from verified salt reveals) arms the J7 lifetime arm.
 */
export interface LadderAudit {
  /** The accused/subject account root (OURS, for a self-audit). */
  root: B64u
  /** Ladder id (§6, e.g. 'chess:Blitz'). */
  ladder: string
  games: readonly LadderGameRef[]
  records: ReadonlyMap<string, Tier1Record>
  /** Closed salted windows' zMicro (chain order). Enables the lifetime arm. */
  closedWindowZs?: readonly number[]
  /** The partition-holding caller's map from a convicting closed-window count W
   *  to the chain ordinal b(W)−1 (banDeadline's lifetime-arm resolver). Required
   *  only when the lifetime arm convicts. */
  resolveLifetimeOrdinal?: (windows: number) => number
  /** Anchor bundle; default TIER2_ANCHORS_JUDGE (the only Tier-2/T bundle). */
  anchors?: Tier2Anchors
}

/** honest = no trigger; escalate = 3σ (deeper analysis obliged, NEVER a ban:
 *  A5-21); convicted = 5σ (the §8 self-ban / suppression anchor). */
export type Disposition = 'honest' | 'escalate' | 'convicted'

export interface EscalationAssessment {
  ladder: string
  /** The raw deterministic verdict (both arms surfaced losslessly). */
  verdict: EscalationVerdict
  disposition: Disposition
  /** Present iff convicted: the conviction-anchored §8 deadline (the EARLIEST
   *  conviction firing by chain ordinal). null for honest / escalate. */
  deadline: BanDeadline | null
}

/**
 * Run the deterministic, protocol-defined §8 escalation trigger on OUR OWN
 * chain-derived ladder window (escalationDue): fires at the earliest trailing-K
 * aggregate ≥ 3σ (escalation) and, independently, the earliest lifetime prefix
 * that escalates; each arm is ALSO scanned for the 5σ conviction line. On a
 * conviction, banDeadline resolves the §8 deadline anchor (the earliest firing
 * by chain ordinal: conviction-anchored ONLY, so an escalation-only verdict
 * never yields a deadline). Deterministic given (chain bytes, Tier1Records, salt
 * reveals). Throws only on a MALFORMED window (escalationDue/banDeadline fail
 * closed: an unjudged rated game is itself non-compliance, §8).
 */
export function assessEscalation(audit: LadderAudit): EscalationAssessment {
  const anchors = audit.anchors ?? TIER2_ANCHORS_JUDGE
  const verdict = escalationDue(audit.games, audit.records, anchors, audit.closedWindowZs)
  if (verdict.conviction !== undefined) {
    const resolve =
      audit.resolveLifetimeOrdinal ??
      ((): number => {
        throw new Error(
          'verdictClient: a lifetime-arm conviction needs audit.resolveLifetimeOrdinal (the partition ordinal b(W)−1)',
        )
      })
    const deadline = banDeadline(verdict, resolve)
    return { ladder: audit.ladder, verdict, disposition: 'convicted', deadline }
  }
  return { ladder: audit.ladder, verdict, disposition: verdict.due ? 'escalate' : 'honest', deadline: null }
}

/** THE §8 gate condition, as a pure predicate (selfBanDueNow): once a conviction
 *  has fired on our chain and no self-ban for it has been appended, our NEXT
 *  witnessed-lane event MUST be the self-ban. Appending ANY other witnessed
 *  event first is exactly what a suppression record proves. Escalation alone
 *  (3σ) never returns true (an honest player is never banned; A5-21). */
export function selfBanBlocksWitnessed(assessment: EscalationAssessment, selfBanAppended: boolean): boolean {
  return selfBanDueNow({ escalation: assessment.verdict, selfBanAppended })
}

// ---------------------------------------------------------------------------
// 3. The reproducible conviction verdict + the §8/§9 self-ban
// ---------------------------------------------------------------------------

/** The computing party's signer (commend-pattern): the account root, or a child
 *  key proven by inline root-signed certs. For a SELF-audit signer.root === the
 *  accused root; the live peer signs with its DEVICE key + chain certs. */
export interface VerdictSigner {
  root: B64u
  key: B64u
  priv: Uint8Array
  /** Root-signed cert events proving `key` (present iff key ≠ root). */
  certs?: readonly SignedEvent[]
}

/** The convicting window sliced out for the verdict record. */
export interface ConvictionWindow {
  /** Metadata window index (informational: never verification-load-bearing).
   *  For a trailing-K conviction, floor(ordinal / reganK). */
  window: number
  /** The window's entries (the reganK games ending at the conviction ordinal). */
  entries: WindowEntry[]
  /** Optional lifetime windowZs (attach on a lifetime-arm conviction). */
  lifetimeWindowZs?: readonly number[]
}

function toEntry(g: LadderGameRef, records: ReadonlyMap<string, Tier1Record>): WindowEntry {
  const rec = records.get(g.game)
  if (rec === undefined)
    throw new Error(`verdictClient: no Tier1Record for rated game ${JSON.stringify(g.game)} (unjudged is non-compliant, §8)`)
  return g.rdMicro === undefined
    ? { rec, side: g.side, elo: g.elo }
    : { rec, side: g.side, elo: g.elo, rdMicro: g.rdMicro }
}

/**
 * Slice the convicting window out of the audit for the verdict record. A
 * trailing-K conviction at chain ordinal `deadline.ordinal` names the full
 * reganK window ending there (games[ordinal−K+1 .. ordinal]), exactly the
 * window escalationDue aggregated. The lifetime arm names a SALTED window
 * (ordinal b(W)−1) whose entries the partition-holding embedder must supply; we
 * fail closed rather than guess it (the trailing-K arm is the primary path and
 * the acceptance-test slice).
 */
export function convictionWindow(audit: LadderAudit, deadline: BanDeadline): ConvictionWindow {
  if (deadline.source !== 'trailingK')
    throw new Error(
      'verdictClient: a lifetime-arm conviction verdict needs the salted-window entries from the partition holder (supply via the embedder seam)',
    )
  const K = PARAMS_A5.reganK
  const end = deadline.ordinal + 1
  const start = end - K
  if (start < 0 || end > audit.games.length)
    throw new Error(`verdictClient: conviction ordinal ${deadline.ordinal} is out of the ladder's ${audit.games.length}-game range`)
  return { window: Math.floor(deadline.ordinal / K), entries: audit.games.slice(start, end).map((g) => toEntry(g, audit.records)) }
}

export interface BuildVerdictOpts {
  accusedRoot: B64u
  ladder: string
  window: ConvictionWindow
  signer: VerdictSigner
  /** The computing party's witnessed-time claim (ranking/expiry math upstream). */
  verdictWts: number
  /** 'verdict' (default) or 'suppression' (needs deadlineEvent + a fired
   *  conviction. The builder refuses a sub-5σ suppression). */
  kind?: 'verdict' | 'suppression'
  /** SUPPRESSION only: the first witnessed-lane event after the completing game. */
  deadlineEvent?: B64u
  anchors?: Tier2Anchors
}

/**
 * Build the reproducible, signed conviction verdict record (makeTier2Verdict):
 * zMicro/games/tier1 are DERIVED from the window entries, never asserted, and
 * the built record always passes verifyTier2Verdict against those inputs. For a
 * genuine 5σ window the record classes as conviction-shaped, so the ban path
 * (verdictEvidence) can act on it once an adopter re-verifies it from the
 * accused's OWN chain bytes. Builder: throws (Tier2InputError) on misuse.
 */
export function buildConvictionVerdict(o: BuildVerdictOpts): Tier2VerdictRecord {
  return makeTier2Verdict({
    kind: o.kind ?? 'verdict',
    root: o.accusedRoot,
    ladder: o.ladder,
    window: o.window.window,
    entries: o.window.entries,
    anchors: o.anchors ?? TIER2_ANCHORS_JUDGE,
    verdictWts: o.verdictWts,
    ...(o.window.lifetimeWindowZs !== undefined ? { lifetimeWindowZs: o.window.lifetimeWindowZs } : {}),
    ...(o.deadlineEvent !== undefined ? { deadlineEvent: o.deadlineEvent } : {}),
    signer: o.signer.root,
    key: o.signer.key,
    priv: o.signer.priv,
    ...(o.signer.certs !== undefined ? { certs: o.signer.certs } : {}),
  })
}

/** The §8/§9 self-ban the compliant client appends: the schema-validated
 *  witnessed-lane payload (makeSelfBanPayload) + the referenced verdict digest +
 *  the §9 expiry anchored on the conviction's witnessed time. */
export interface SelfBanBuild {
  payload: SelfBanPayload
  verdictDigest: B64u
  expiryWts: number
}

/**
 * Derive the self-ban payload from a conviction verdict record: verdict =
 * tier2VerdictDigest(body) (the reproducible record published under the accused
 * key), expiryWts = conviction witnessed time + selfBanDays (§9, 90d), ladder =
 * the verdict's ladder. The §8 deadline is enforced by the caller appending
 * this BEFORE any further witnessed event (selfBanBlocksWitnessed); the fold's
 * banStep derives the real §9 term from the selfban EVENT's witnessed ts, so
 * expiryWts here is the honest advisory the payload carries.
 */
export function buildSelfBan(o: { verdict: Tier2VerdictRecord; convictionWts: number; window?: number }): SelfBanBuild {
  const verdictDigest = tier2VerdictDigest(o.verdict.body)
  const expiryWts = selfBanExpiryWts(o.convictionWts)
  const payload = makeSelfBanPayload({
    ladder: o.verdict.body.ladder,
    window: o.window ?? o.verdict.body.window,
    expiryWts,
    verdictDigest,
  })
  return { payload, verdictDigest, expiryWts }
}

// ---------------------------------------------------------------------------
// 4. Publish / adopt / suppression-scan over the LIVE overlay
// ---------------------------------------------------------------------------

/**
 * Publish verdict records into shard space under the ACCUSED's deterministic
 * slot (transport.publishVerdicts → embed.publishVerdictRow builds + key-binds
 * the row, then ONE overlay put offers it to the replicateK closest carriers,
 * each re-verifying through its own gate). Returns the slot key + the number of
 * true stores (0 is honest degradation: no reachable carrier; the conviction
 * stays recomputable from chain bytes regardless). Throws (Tier2InputError) only
 * on builder misuse (empty recs / mixed accused roots).
 */
export async function publishVerdictRows(
  node: OverlayNode,
  recs: readonly Tier2VerdictRecord[],
): Promise<{ key: B64u; stored: number }> {
  const stored = await publishVerdicts(node, recs)
  return { key: tier2VerdictKey(recs[0].body.root), stored }
}

export interface AdoptVerdictsResult {
  key: B64u
  adopt: AdoptVerdictRow
}

/**
 * Fetch a subject's merged verdict row over the live overlay and adopt it
 * through the A5-33 judge-anchor-pinned path (fetchVerdictRow →
 * adoptVerdictRowJudge): EVERY record is re-verified against the caller's own
 * chain-derived window inputs (`entriesFor`. Return null when a window is
 * unavailable and that record is REJECTED, never adopted unverified, §0), and
 * only records computed under TIER2_ANCHORS_JUDGE are accepted. A missing row is
 * a typed no-adopt, never a throw.
 */
export async function fetchAndAdoptVerdicts(o: {
  node: VerdictReadNode
  subjectRoot: B64u
  entriesFor: (rec: Tier2VerdictRecord, index: number) => readonly WindowEntry[] | null
}): Promise<AdoptVerdictsResult> {
  const { key, row } = await fetchVerdictRow(o.node, o.subjectRoot)
  if (row === null) return { key, adopt: { ok: false, errors: ['adopt: no verdict row at the subject slot'], adopted: [] } }
  const adopt = adoptVerdictRowJudge({ subjectRoot: o.subjectRoot, key, row, entriesFor: o.entriesFor })
  return { key, adopt }
}

export interface BanEvidenceResult {
  key: B64u
  /** null when no row exists at the subject slot. */
  evidence: VerdictEvidence | null
}

/**
 * The composed READ path for pairing/display (transport.verdictEvidence):
 * fetch the merged row, adopt it (judge-pinned), and run the §8 suppressionScan
 * on the subject's ALREADY-VERIFIED chain for every adopted 5σ-window-conviction,
 * surfacing the injected `ban` evidence (permanent on a proven suppression,
 * §9) for displayState / pairingLegal. A 3σ escalation record, a sub-conviction
 * record, and a lifetime-only conviction all inject NOTHING (A5-21 + §0: the ban
 * rests on the reader's OWN recomputed window + its own chain-side absence scan,
 * never a fabricated claim). `chainEvents` is the caller's OWN trusted, verified
 * chain, so a malformed one throws (suppressionScan's fail-closed builder rule).
 */
export async function fetchBanEvidence(o: {
  node: VerdictReadNode
  subjectRoot: B64u
  entriesFor: (rec: Tier2VerdictRecord, index: number) => readonly WindowEntry[] | null
  chainEvents: readonly SignedEvent[]
}): Promise<BanEvidenceResult> {
  const { key, row } = await fetchVerdictRow(o.node, o.subjectRoot)
  if (row === null) return { key, evidence: null }
  const evidence = verdictEvidence({
    subjectRoot: o.subjectRoot,
    key,
    row,
    entriesFor: o.entriesFor,
    chainEvents: o.chainEvents,
  })
  return { key, evidence }
}

/** The §8 chain-side absence scan (embed.suppressionScan), thin: given a
 *  subject's verified chain events in chain order, the conviction-completing
 *  game key, and the ladder, decide compliant / pending / suppressed. Signature
 *  + linkage truth is verifyChain's (done before); this owns only the absence
 *  rule. Fail-closed on malformed input. */
export function scanChainForSuppression(
  chainEvents: readonly SignedEvent[],
  convictionGame: string,
  ladder: string,
): SuppressionScan {
  return suppressionScan(chainEvents, convictionGame, ladder)
}

// ---------------------------------------------------------------------------
// 5. The app-lifetime controller (the lead's boot hook + the L-ui state)
// ---------------------------------------------------------------------------

/** The overall account fair-play phase (worst ladder wins for display). */
export type VerdictClientPhase =
  | 'signed-out' // no controller live
  | 'clear' // every audited ladder honest
  | 'flagged' // ≥1 ladder escalated (3σ): deeper analysis only, NEVER a ban
  | 'convicted' // ≥1 ladder convicted (5σ), self-ban not yet witnessed
  | 'self-banned' // the §8 self-ban has been appended for every conviction

export interface LadderVerdictState {
  ladder: string
  disposition: Disposition
  /** Present iff convicted: the §8 deadline anchor. */
  deadline: BanDeadline | null
  /** Whether OUR chain already carries the self-ban for this conviction. */
  selfBanAppended: boolean
  /** True stores of the published conviction row (0 = honest degradation). */
  verdictStored: number
}

export interface VerdictClientState {
  phase: VerdictClientPhase
  ladders: LadderVerdictState[]
  /** Ladders convicted with a self-ban still owed (guardBeforeWitnessed blocks
   *  a further witnessed append while non-empty). */
  banPending: string[]
  busy: 'idle' | 'auditing'
  error: string | null
}

const SIGNED_OUT_STATE: VerdictClientState = {
  phase: 'signed-out',
  ladders: [],
  banPending: [],
  busy: 'idle',
  error: null,
}

export interface SelfAuditReport {
  ladders: LadderVerdictState[]
  /** Ladders convicted with the self-ban NOT yet appended (still blocking). */
  banPending: string[]
}

export interface WitnessedGuard {
  /** True ⇒ a §8 self-ban is owed and could not be witnessed yet; the caller
   *  MUST NOT append any further witnessed event (the rated write honestly
   *  waits, C-10). */
  blocked: boolean
  /** The ladders still owing a self-ban. */
  pending: string[]
}

export interface VerdictClientDeps {
  /** OUR account root. */
  root: B64u
  /** The live overlay node (getAccountPeer().overlay). Null ⇒ no peer up. */
  getNode: () => OverlayNodeExt | null
  /** The computing party's signer (deviceSigningKey + chain certs), or null. */
  signer: () => VerdictSigner | null
  /** The chain-derived Tier-2 window inputs for each of OUR rated ladders. The
   *  L-t1 judgeRunner / a4 fold seam. Empty ⇒ nothing to audit. */
  ladderAudits: () => Promise<readonly LadderAudit[]> | readonly LadderAudit[]
  /** Append the §8 self-ban on the WITNESSED lane (the lead wires
   *  clientAppendWitnessed under the live lease + witness set. Like the segment
   *  publisher). Returns whether it landed; an unwitnessable ban stays owed. */
  appendSelfBan: (build: SelfBanBuild) => Promise<{ ok: boolean; reason?: string }>
  /** Whether OUR chain already carries a self-ban for `ladder` (read from the a4
   *  fold's `bans` state so a restart never re-appends). Default: false. */
  hasSelfBan?: (ladder: string) => boolean
  /** Wall clock (ms) for the verdict/self-ban witnessed-time claims. Default
   *  Date.now (renderer glue is where wall-clock is allowed). */
  now?: () => number
  /** Diagnostics sink. */
  log?: (msg: string) => void
}

export interface VerdictClientHandle {
  readonly root: B64u
  getState(): VerdictClientState
  subscribe(fn: () => void): () => void
  /** Self-audit every ladder: publish + self-ban on a fresh conviction. */
  runSelfAudit(): Promise<SelfAuditReport>
  /** THE §8 GATE the boot calls BEFORE any further witnessed append: runs a
   *  self-audit, appends any owed self-ban FIRST, and reports whether a further
   *  witnessed event is still blocked (an unwitnessable ban). */
  guardBeforeWitnessed(): Promise<WitnessedGuard>
  /** Fetch + adopt + suppression-scan another account's row (pairing gate). */
  banEvidenceFor(o: {
    subjectRoot: B64u
    entriesFor: (rec: Tier2VerdictRecord, index: number) => readonly WindowEntry[] | null
    chainEvents: readonly SignedEvent[]
  }): Promise<BanEvidenceResult>
  stop(): void
}

function phaseOf(ladders: readonly LadderVerdictState[]): VerdictClientPhase {
  if (ladders.length === 0) return 'clear'
  let anyConvicted = false
  let anyPending = false
  let anyEscalate = false
  for (const l of ladders) {
    if (l.disposition === 'convicted') {
      anyConvicted = true
      if (!l.selfBanAppended) anyPending = true
    } else if (l.disposition === 'escalate') anyEscalate = true
  }
  if (anyPending) return 'convicted'
  if (anyConvicted) return 'self-banned'
  if (anyEscalate) return 'flagged'
  return 'clear'
}

/**
 * Build a live Tier-2 verdict controller for one signed-in account. It never
 * fabricates a ban: only the deterministic 5σ conviction of OUR own judged
 * window ever appends a self-ban, and every scarcity (no peer, no reachable
 * carrier, no lease to witness the ban) degrades to an honest owed-but-waiting
 * state rather than a crash or a false accusation.
 */
export function createVerdictClient(deps: VerdictClientDeps): VerdictClientHandle {
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((): void => {})
  const hasSelfBan = deps.hasSelfBan ?? ((): boolean => false)
  const listeners = new Set<() => void>()
  let state: VerdictClientState = { ...SIGNED_OUT_STATE, phase: 'clear' }
  let stopped = false

  const emit = (patch: Partial<VerdictClientState>): void => {
    state = { ...state, ...patch }
    listeners.forEach((fn) => fn())
  }

  const auditOne = async (audit: LadderAudit, node: OverlayNodeExt | null, signer: VerdictSigner | null): Promise<LadderVerdictState> => {
    let assessment: EscalationAssessment
    try {
      assessment = assessEscalation(audit)
    } catch (e) {
      // A malformed/unjudged window fails closed (§8). Surface it, never crash.
      log(`self-audit ${audit.ladder}: window not evaluable (${e instanceof Error ? e.message : String(e)})`)
      return { ladder: audit.ladder, disposition: 'honest', deadline: null, selfBanAppended: false, verdictStored: 0 }
    }
    if (assessment.disposition !== 'convicted' || assessment.deadline === null)
      return { ladder: audit.ladder, disposition: assessment.disposition, deadline: assessment.deadline, selfBanAppended: false, verdictStored: 0 }

    // 5σ conviction: build the reproducible verdict, publish it, and. Unless a
    // self-ban is already on our chain. Append the §8 self-ban.
    const alreadyBanned = hasSelfBan(audit.ladder)
    let verdictStored = 0
    let selfBanAppended = alreadyBanned
    if (signer && signer.root === audit.root) {
      try {
        const win = convictionWindow(audit, assessment.deadline)
        const verdict = buildConvictionVerdict({
          accusedRoot: audit.root,
          ladder: audit.ladder,
          window: win,
          signer,
          verdictWts: now(),
        })
        if (node) {
          try {
            verdictStored = (await publishVerdictRows(node, [verdict])).stored
          } catch (e) {
            log(`self-audit ${audit.ladder}: verdict publish failed (${e instanceof Error ? e.message : String(e)})`)
          }
        }
        if (!alreadyBanned) {
          const build = buildSelfBan({ verdict, convictionWts: now(), window: win.window })
          const res = await deps.appendSelfBan(build)
          selfBanAppended = res.ok
          if (res.ok) log(`self-audit ${audit.ladder}: §8 self-ban appended (verdict ${build.verdictDigest.slice(0, 10)}…)`)
          else log(`self-audit ${audit.ladder}: self-ban owed but not witnessed (${res.reason ?? 'unavailable'}): witnessed writes wait (C-10)`)
        }
      } catch (e) {
        log(`self-audit ${audit.ladder}: conviction handling failed (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    return { ladder: audit.ladder, disposition: 'convicted', deadline: assessment.deadline, selfBanAppended, verdictStored }
  }

  const runSelfAudit = async (): Promise<SelfAuditReport> => {
    if (stopped) return { ladders: [], banPending: [] }
    const signer = deps.signer()
    const node = deps.getNode()
    emit({ busy: 'auditing', error: null })
    let audits: readonly LadderAudit[]
    try {
      audits = await deps.ladderAudits()
    } catch (e) {
      emit({ busy: 'idle', error: e instanceof Error ? e.message : String(e) })
      return { ladders: state.ladders, banPending: state.banPending }
    }
    const ladders: LadderVerdictState[] = []
    for (const a of audits) ladders.push(await auditOne(a, node, signer))
    const banPending = ladders.filter((l) => l.disposition === 'convicted' && !l.selfBanAppended).map((l) => l.ladder)
    if (!stopped) emit({ phase: phaseOf(ladders), ladders, banPending, busy: 'idle' })
    return { ladders, banPending }
  }

  return {
    root: deps.root,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    runSelfAudit,
    async guardBeforeWitnessed(): Promise<WitnessedGuard> {
      const report = await runSelfAudit()
      return { blocked: report.banPending.length > 0, pending: report.banPending }
    },
    async banEvidenceFor(o): Promise<BanEvidenceResult> {
      const node = deps.getNode()
      if (!node) return { key: tier2VerdictKey(o.subjectRoot), evidence: null }
      return fetchBanEvidence({ node, ...o })
    },
    stop() {
      stopped = true
      listeners.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Singleton + UI subscription surface (started on sign-in by the lead)
// ---------------------------------------------------------------------------

let singleton: VerdictClientHandle | null = null
let unsubSingleton: (() => void) | null = null
const uiListeners = new Set<() => void>()

function notifyUi(): void {
  uiListeners.forEach((fn) => fn())
}

/** Subscribe to the live verdict-client state (works whether or not one is up). */
export function subscribeVerdictClient(fn: () => void): () => void {
  uiListeners.add(fn)
  return () => {
    uiListeners.delete(fn)
  }
}

/** The current verdict-client state: the singleton's, or the honest signed-out
 *  default when none is live (no fixture, ever). */
export function getVerdictClientState(): VerdictClientState {
  return singleton ? singleton.getState() : SIGNED_OUT_STATE
}

/** The live verdict-client handle, or null when signed out / not yet wired. */
export function getVerdictClient(): VerdictClientHandle | null {
  return singleton
}

/**
 * Start the app-lifetime verdict client for the signed-in account (idempotent
 * per root). The lead calls this in the account-peer reconcile once the peer is
 * up. A no-op returning the live handle if one already runs for the same root.
 */
export function startVerdictClientSingleton(deps: VerdictClientDeps): VerdictClientHandle {
  if (singleton && singleton.root === deps.root) return singleton
  stopVerdictClientSingleton()
  const handle = createVerdictClient(deps)
  singleton = handle
  unsubSingleton = handle.subscribe(notifyUi)
  notifyUi()
  return handle
}

/** Stop + clear the singleton (sign-out / account switch). */
export function stopVerdictClientSingleton(): void {
  unsubSingleton?.()
  unsubSingleton = null
  singleton?.stop()
  singleton = null
  notifyUi()
}

/** The §8 guard the boot calls before any further witnessed append: blocks a
 *  further witnessed event while a self-ban is owed (honest wait). No live
 *  client (signed out) ⇒ never blocks. */
export async function guardWitnessedAppend(): Promise<WitnessedGuard> {
  if (!singleton) return { blocked: false, pending: [] }
  return singleton.guardBeforeWitnessed()
}
