// A6 M3, Lane L-view: the LIVE reconstruction viewing client (spec §5 viewing
// flow, §2 checkpoint verification, §11 platform budgets).
//
// Given a target account ROOT, this resolves the account over the live
// AccountPeer overlay (ONE authenticated-pointer lookup, then the shard layer)
// entirely through the FROZEN §5 substrate (storage/viewer.ts `resolveProfile` +
// `historyFromView`; storage/pointers.ts + shards.ts underneath). It reimplements
// NO crypto and NO reconstruction: every acceptance decision stays inside the
// pure verifiers, which are byte-identical on node and in the browser (§0: the
// overlay only moves bytes; authority comes from owner signatures + witness
// attestations). This module is the thin renderer glue that:
//
//   1. builds the §2 checkpoint-cosigner eligibility join from the LIVE presence
//      directory (so the newest M-of-N checkpoint is verified, not merely shown),
//   2. injects the wall clock + the §2 spot-check draw (the substrate has no
//      ambient Date.now / Math.random: determinism preserved),
//   3. calls `resolveProfile` and `historyFromView`, NEVER throwing on hostile or
//      absent data: a target with fewer than K_rec reachable shard rows surfaces
//      TYPED temporary unavailability that heals via runRepair (spec C-8), never a
//      crash and never a fabricated profile, and
//   4. maps the verified `ResolvedProfile` onto the UI shapes the profile page
//      already renders: ladders / reputation / standing come from the SHARED
//      folds (store/derive.ts) over the reconstructed chain, or, on the floor
//      path, from the M-of-N-cosigned checkpoint state (the §6 pinned surface),
//      or an honest "unavailable" when neither survived.
//
// Renderer-hosted (it drives a live overlay); it is React-free and takes the
// AccountPeer as a value, so the whole decision path bundles + runs headless in
// scripts/test-accounts-viewer-client.mjs exactly as it runs in the browser.

import { eventId, type B64u, type Chain } from '@shared/accounts'
import {
  PARAMS_A2,
  liveNodesOf,
  nodeIdOf,
  type CheckpointCosigRule,
  type NodeDirectory,
  type NodeId,
} from '@shared/accounts/witness'
import {
  PARAMS_A3,
  historyFromView,
  resolveProfile,
  type HistoryPager,
  type PointerReadNode,
  type ResolvedProfile,
  type ShardReadReason,
  type VerifyShardOpts,
} from '@shared/accounts/storage'
import { tableSize } from '@shared/accounts/overlay'
import { displayState } from '@shared/accounts/ratings/display'
import { timeCategory } from '@shared/accounts/ratings/ladders'
import type { A4FoldState } from '@shared/accounts/ratings/fold'
import type { CanonicalObject, CanonicalValue } from '@shared/accounts/codec'
import type { SegmentPayload } from '@shared/accounts/storage/types'
import {
  deriveLadders,
  deriveProfile,
  deriveReputation,
  deriveStanding,
  foldChainA4,
  type ChainDerived,
} from '../store/derive'
import type {
  LadderKey,
  UiGameRow,
  UiLadder,
  UiProfile,
  UiReconstruction,
  UiReputation,
  UiStanding,
} from '../mock/types'
import type { AccountPeer } from './peerService'

// ---------------------------------------------------------------------------
// Viewer hygiene defaults (processing knobs, not revisable protocol params)
// ---------------------------------------------------------------------------

/** §2 spot-check probability the live viewer draws against per resolve. The
 * substrate ALSO forces a spot-check whenever cosigner diversity is lacking or
 * unknown, so this only governs the extra random deep re-derivation on an
 * otherwise-diverse checkpoint: cheap in JS, and it fails toward auditing. */
export const VIEWER_SPOT_CHECK_P = 0.2

/** §2 checkpoint /16-prefix diversity floor (witness/types.ts contract: "≥ 3
 * distinct /16 nodeId prefixes"). No exported constant carries it, so it is
 * pinned here and overridable via ResolveAccountOpts.cosigRule. */
export const VIEWER_CKPT_PREFIX_DIVERSITY_MIN = 3

/** How many freshest game segments the head card renders inline; the FULL
 * history lazy-pages through the returned HistoryPager (~2 KB/game, §5). */
export const VIEWER_GAMES_PREVIEW = 24

const EMPTY_HISTORIES: ChainDerived['histories'] = { Bullet: [], Blitz: [], Rapid: [], Classical: [] }
const LADDER_ICON_KEYS: readonly LadderKey[] = ['Bullet', 'Blitz', 'Rapid', 'Classical']

// ---------------------------------------------------------------------------
// Target identity
// ---------------------------------------------------------------------------

/** Does `s` look like an account ROOT pubkey (43-char base64url, no pad)?
 * Distinguishes a real reconstruction target (paste/open a root) from a fixture
 * display handle like `mira#T8FQ2` (which carries a `#`). */
export function isAccountRoot(s: string): boolean {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s)
}

// ---------------------------------------------------------------------------
// §2 checkpoint-cosigner eligibility from the live directory
// ---------------------------------------------------------------------------

/** The canonical §2 checkpoint-cosigner rule (m/n from PARAMS_A2, /16 diversity
 * floor from the witness/types.ts contract), with optional overrides. */
export function checkpointCosigRule(overrides: Partial<CheckpointCosigRule> = {}): CheckpointCosigRule {
  return {
    m: overrides.m ?? PARAMS_A2.ckptM,
    n: overrides.n ?? PARAMS_A2.ckptN,
    prefixDiversityMin: overrides.prefixDiversityMin ?? VIEWER_CKPT_PREFIX_DIVERSITY_MIN,
  }
}

/**
 * Build the eligible-witness join `resolveProfile` needs to verify a
 * checkpoint's M-of-N cosigner set (§2c): witness signing key → nodeId, over
 * every LIVE, witness-capable presence in the fabric directory. WITHOUT this
 * join the viewer cannot confirm diversity and fails toward auditing (mOfN
 * unknown, spot-check forced): honest, but it never renders "M-of-N cosigned".
 * The eligibility is a live-directory snapshot (C-3), never authority: it only
 * decides which cosignatures COUNT toward the threshold the owner already signed
 * the checkpoint under.
 */
export function buildEligibleWitnesses(directory: NodeDirectory, nowMs: number): Map<B64u, NodeId> {
  const eligible = new Map<B64u, NodeId>()
  for (const sp of liveNodesOf(directory, nowMs)) {
    if (!sp.body.caps.witness) continue
    // The cosigning key is the presence's device signing key (att.w); its nodeId
    // anchors the /16-prefix diversity bound.
    eligible.set(sp.body.key, nodeIdOf(sp.body.root))
  }
  return eligible
}

// ---------------------------------------------------------------------------
// resolveAccountView: the live §5 resolve, honest and crash-proof
// ---------------------------------------------------------------------------

export interface ResolveAccountOpts {
  /** Live presence directory (peer.fabric.directory()). Feeds shard-duty
   * pointer verification AND the checkpoint eligibility join. */
  directory?: NodeDirectory
  /** Wall clock (ms). Default Date.now (renderer glue may use it). */
  nowMs?: number
  /** Injected RNG for the §2 spot-check draw. Default Math.random. */
  rng?: () => number
  /** Spot-check probability. Default VIEWER_SPOT_CHECK_P. */
  spotCheckP?: number
  /** Checkpoint-cosigner rule overrides. Default the canonical rule. */
  cosigRule?: Partial<CheckpointCosigRule>
  /** Explicit eligibility join (suite / override). Default: from `directory`. */
  eligible?: ReadonlyMap<B64u, NodeId>
  /** Verified holder summaries pre-fetched by the embedder (A6 fast-path seam).
   * Re-verified inside resolveProfile; junk contributes nothing. */
  summaries?: readonly unknown[]
  /** Freshest-holder page size (§5). Default PARAMS_A3.viewerHoldersMax. */
  holdersMax?: number
  /** Shard-header geometry override (suites). Default production 40/12. */
  shard?: VerifyShardOpts
}

/**
 * Resolve a subject over the live overlay with the owner possibly gone. Composes
 * the ResolveOpts (directory + clock + checkpoint eligibility + the spot-check
 * draw) and calls the frozen `resolveProfile`. `resolveProfile` is contractually
 * total on hostile/absent data; the try/catch is a belt-and-suspenders guard so
 * a transport that itself throws still degrades to an honest empty floor view
 * instead of crashing the profile page. NEVER throws.
 */
export async function resolveAccountView(
  node: PointerReadNode,
  subjectRoot: B64u,
  opts: ResolveAccountOpts = {},
): Promise<ResolvedProfile> {
  const nowMs = opts.nowMs ?? Date.now()
  const rng = opts.rng ?? Math.random
  const directory = opts.directory
  const eligible = opts.eligible ?? (directory ? buildEligibleWitnesses(directory, nowMs) : undefined)
  const rule = checkpointCosigRule(opts.cosigRule)
  const spot = { p: opts.spotCheckP ?? VIEWER_SPOT_CHECK_P, roll: rng() }

  try {
    return await resolveProfile(node, subjectRoot, {
      // `nowMs` is REQUIRED alongside `directory` (presence staleness): pass both or neither.
      ...(directory ? { directory, nowMs } : {}),
      ...(eligible && eligible.size > 0 ? { cosig: { eligible, rule } } : {}),
      spot,
      ...(opts.summaries ? { summaries: opts.summaries } : {}),
      ...(opts.holdersMax !== undefined ? { holdersMax: opts.holdersMax } : {}),
      ...(opts.shard ? { shard: opts.shard } : {}),
    })
  } catch {
    return emptyFloorView(subjectRoot)
  }
}

/** The honest all-unavailable view: no verified bytes reached us. Shaped exactly
 * like a real ResolvedProfile floor so every downstream mapper is total. */
export function emptyFloorView(subjectRoot: B64u): ResolvedProfile {
  return {
    root: subjectRoot,
    status: 'floor',
    profile: {},
    segments: [],
    holdersRanked: [],
    shardReport: { liveRows: 0, needK: PARAMS_A3.kRec, totalRows: PARAMS_A3.nShards, reason: 'no-rows' },
    certs: [],
    sources: { pointers: 0, holders: 0, shardsUsed: 0, viaChain: false },
  }
}

// ---------------------------------------------------------------------------
// Lazy history pager over the resolved view (~2 KB/game, §5)
// ---------------------------------------------------------------------------

/** The lazy game-history pager anchored at the view's pinned countersigned head:
 * chain events when reconstruction succeeded, else the verified segment floor
 * (missing heights page honestly as 'unavailable'). Null when no head pinned at
 * all (nothing verified). The caller renders that as honest unavailability. */
export function openAccountHistory(view: ResolvedProfile, pageSize?: number): HistoryPager | null {
  return historyFromView(view, pageSize !== undefined ? { pageSize } : {})
}

// ---------------------------------------------------------------------------
// Honest availability summary (the C-8 degradation surface + suite assertions)
// ---------------------------------------------------------------------------

export interface ViewerAvailability {
  /** viewer.ts `status`: 'expected' = full verified chain; 'floor' = survivors' union. */
  status: 'expected' | 'floor'
  /** Something VERIFIED is renderable (a pinned head, a checkpoint, or ≥1 game).
   * false ⇒ honest temporary unavailability (heals via repair). Never a crash,
   * never a fabricated profile. */
  available: boolean
  /** Present when NOTHING reconstructed. Why the shard read came back empty. */
  reason?: ShardReadReason | 'no-pointers'
  /** Verified live shard rows observed for the freshest snapshot. */
  liveRows: number
  needK: number
  totalRows: number
  /** C-12: a device-signed revocation honored on device-attested evidence only.
   * The view may hide one device's recent content, degraded + self-healing. */
  revocationContested: boolean
  /** The surfaced checkpoint reached its M-of-N cosigner threshold (§2). */
  mOfN: boolean
  /** Verified game segments recovered (the guaranteed floor). */
  segments: number
  /** Enumerated authenticated pointers + distinct holders. */
  pointers: number
  holders: number
}

/** The honest availability read of a resolved view. What the reconstruction
 * card + degradation chips render, and what the suite asserts against. */
export function summarizeAvailability(view: ResolvedProfile): ViewerAvailability {
  const available = view.status === 'expected' || view.head !== undefined || view.segments.length > 0
  const reason =
    !available ? (view.sources.pointers === 0 ? 'no-pointers' : view.shardReport.reason) : view.shardReport.reason
  return {
    status: view.status,
    available,
    ...(reason !== undefined ? { reason } : {}),
    liveRows: view.shardReport.liveRows,
    needK: view.shardReport.needK,
    totalRows: view.shardReport.totalRows,
    revocationContested: view.revocationContested === true,
    mOfN: view.ckptInfo?.mOfN === true,
    segments: view.segments.length,
    pointers: view.sources.pointers,
    holders: view.sources.holders,
  }
}

// ---------------------------------------------------------------------------
// ResolvedProfile → UI shapes (the profile page renders these verbatim)
// ---------------------------------------------------------------------------

const str = (o: CanonicalObject | undefined, k: string): string => {
  const v = o?.[k]
  return typeof v === 'string' ? v : ''
}

/** A short mono form of a b64u key for opponent/handle display. */
export function shortKey(s: string): string {
  return typeof s === 'string' && s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s
}

/** True when a checkpoint state carries the A4 ladder/rep/ban surface (an
 * `a4-v1` fold), so ladders/reputation/standing can be derived from the
 * checkpoint alone on the floor path (the §6 pinned surface). A young account's
 * first `basic-v1` checkpoint lacks it. Honest seeds then. */
function isA4FoldState(state: CanonicalValue | undefined): state is A4FoldState {
  return (
    typeof state === 'object' &&
    state !== null &&
    'ladders' in state &&
    'rep' in state &&
    'bans' in state
  )
}

/** The best available A4 fold surface for ladders/reputation/standing:
 *  1. the reconstructed chain's own fold (authoritative + sparkline histories),
 *  2. else the M-of-N-cosigned checkpoint state (the §6 pinned surface; works
 *     on the floor path when the chain did not reconstruct),
 *  3. else null (honest: no rating surface is derivable). */
function foldSurfaceOf(view: ResolvedProfile): ChainDerived | null {
  if (view.chain) return foldChainA4(view.chain)
  const state = view.ckptInfo?.state
  if (isA4FoldState(state)) return { fold: state, histories: EMPTY_HISTORIES }
  return null
}

/** Genesis display name + creation time from a reconstructed chain (root-signed
 * genesis only: a device "genesis" cannot set the name; the substrate already
 * enforced this in view.name). */
function genesisOf(chain: Chain | undefined): { name?: string; createdWts: number } {
  const g = chain?.events.find(
    (e) => e.body.lane === 'w' && e.body.type === 'genesis' && e.body.height === 0 && e.body.key === chain.root,
  )
  const name = ((g?.body.payload as { name?: unknown } | undefined)?.name ?? undefined) as string | undefined
  return { ...(typeof name === 'string' ? { name } : {}), createdWts: g?.body.ts ?? 0 }
}

/** Newest verified witnessed timestamp across the view (head, checkpoint, or the
 * freshest recovered segment): the §10 "last witnessed activity" instant, only
 * ever a countersigned time, never a self-claim. */
function newestWitnessedTs(view: ResolvedProfile): number {
  let ts = view.headEvent?.body.ts ?? 0
  for (const e of view.segments) if (e.body.ts > ts) ts = e.body.ts
  if (view.ckptInfo && view.ckptInfo.event.body.ts > ts) ts = view.ckptInfo.event.body.ts
  return ts
}

/** The ladder key a segment rates in (§6), from its embedded time control;
 * Unlimited / pre-A4 segments (no rated ladder) display under Blitz's icon. */
function segmentLadder(payload: SegmentPayload): LadderKey {
  if (!payload.tc) return 'Blitz'
  const cat = timeCategory(payload.tc)
  return cat === 'Unlimited' ? 'Blitz' : cat
}

/** Map verified witnessed 'segment' events to UI game rows, newest first. Used
 * both for the head-card preview and for lazy history paging (the pager returns
 * SignedEvents; this is the shared projection). Non-segment events are skipped. */
export function gameRowsFromEvents(events: readonly Chain['events'][number][]): UiGameRow[] {
  const rows: UiGameRow[] = []
  for (const e of events) {
    if (e.body.lane !== 'w' || e.body.type !== 'segment') continue
    const p = e.body.payload as unknown as SegmentPayload
    rows.push({
      id: eventId(e.body),
      opponent: shortKey(p.opp),
      ladder: segmentLadder(p),
      result: p.result,
      userColor: p.color,
      ts: e.body.ts,
      witnessed: (e.wit?.length ?? 0) > 0,
    })
  }
  rows.sort((a, b) => b.ts - a.ts)
  return rows
}

/** The freshest `VIEWER_GAMES_PREVIEW` recovered games as UI rows, newest first.
 * Every row is a VERIFIED segment of the subject (resolveProfile admitted it). */
export function gamesFromView(view: ResolvedProfile, limit = VIEWER_GAMES_PREVIEW): UiGameRow[] {
  return gameRowsFromEvents(view.segments).slice(0, limit)
}

/** viewer.ts `status`/`shardReport`/`ckptInfo`/`revocationContested` → the
 * UiReconstruction the staged card + verification strip render. `hops` is the
 * live overlay lookup depth when the caller passes it (cosmetic; the resolve
 * already ran); the rest are the REAL §5 facts. */
export function reconstructionFromView(view: ResolvedProfile, hops = 0): UiReconstruction {
  return {
    // We only reach the live viewer to reconstruct someone who is not hosting
    // themselves right now (owner online → their own store answers).
    ownerOnline: false,
    hops,
    pointerCount: view.sources.pointers,
    // resolveProfile drops poisoned/unproven pointers inside buildContactSheet
    // and does not return the discarded count. Honest 0 rather than a guess.
    pointersIgnored: 0,
    holdersOnline: view.sources.holders,
    shardsHave: view.shardReport.liveRows,
    shardsNeed: view.shardReport.needK,
    shardsTotal: view.shardReport.totalRows,
    spotChecked: view.ckptInfo?.spotChecked === true,
    path: view.status,
    revocationContested: view.revocationContested === true,
  }
}

/** The §2 checkpoint surface for the verification strip. `of` is the eligible-N
 * the M-of-N rule draws from (PARAMS_A2.ckptN); `height` is the checkpoint
 * event's own height. When no checkpoint surfaced, an honest below-threshold
 * zero-state (mOfN:false) rather than a fabricated one. */
export function checkpointFromView(view: ResolvedProfile): UiProfile['checkpoint'] {
  const ck = view.ckptInfo
  if (!ck) return { height: 0, cosigners: 0, of: PARAMS_A2.ckptN, verified: 'incremental', mOfN: false }
  return {
    height: ck.event.body.height,
    cosigners: ck.cosigners,
    of: PARAMS_A2.ckptN,
    verified: ck.verified,
    mOfN: ck.mOfN === true,
  }
}

/** A minimal honest reputation card when no fold surface survived (floor path,
 * no chain and no A4 checkpoint). States the unavailability, invents nothing. */
function unavailableReputation(): UiReputation {
  return {
    score: 0,
    tier: 'Mixed',
    components: [{ label: 'Reputation', value: 'unavailable until the chain reconstructs', positive: false }],
    commendations: 0,
  }
}

/** Seed ladders (§6: 1200 / RD 350) shown when no fold surface survived, the
 * honest "nothing rated recovered yet" state, matching a fresh account. The
 * display state comes from the SHARED displayState() so it can never drift. */
function seedLadders(): UiLadder[] {
  return LADDER_ICON_KEYS.map((key) => {
    const state = { n: 0, r: 1_200_000_000, rd: 350_000_000 }
    return { key, state, display: displayState(state, key), games: 0 }
  })
}

export interface ViewToUiOpts {
  /** Evaluation instant for ban rendering (§9). Default Date.now. */
  atWts?: number
  /** Overlay lookup depth for the reconstruction card (cosmetic). */
  hops?: number
  /** Inline games preview cap. Default VIEWER_GAMES_PREVIEW. */
  gamesLimit?: number
}

/**
 * Map a verified ResolvedProfile onto the UiProfile the profile page renders.
 * EVERY value is a pure fold over verified data (§0): name from the root-signed
 * genesis, profile fields from the folded personal lane, ladders / reputation /
 * standing from the reconstructed chain's a4 fold or the M-of-N checkpoint's
 * pinned state, games from the verified segment set. Nothing is asserted; the
 * degradations (floor path, below-threshold checkpoint, revocationContested)
 * ride the reconstruction/checkpoint surfaces so the page renders them honestly.
 */
export function viewToUiProfile(view: ResolvedProfile, opts: ViewToUiOpts = {}): UiProfile {
  const atWts = opts.atWts ?? Date.now()
  const gen = genesisOf(view.chain)
  const displayName = view.name ?? gen.name ?? 'Unknown account'
  const tag = view.root.slice(0, 5)
  const surface = foldSurfaceOf(view)

  const ladders = surface ? deriveLadders(surface, atWts) : seedLadders()
  const reputation = surface ? deriveReputation(surface.fold) : unavailableReputation()
  const standing: UiStanding = surface ? deriveStanding(surface.fold, atWts) : { state: 'good' }
  // Profile fields: the reconstructed chain's shared fold when present (matches
  // verifyChain's own merge, incl. revoked-key exclusion), else the floor fold
  // resolveProfile already computed into view.profile.
  const p = view.chain ? deriveProfile(view.chain) : null
  const bio = p ? p.bio : str(view.profile, 'bio')
  const country = p ? p.country : str(view.profile, 'country')
  const flair = (p ? p.flair : str(view.profile, 'flair')) || '♟'

  return {
    handle: `${displayName}#${tag}`,
    displayName,
    tag,
    rootPub: view.root,
    bio,
    country,
    flair,
    createdWts: gen.createdWts,
    lastWitnessedWts: newestWitnessedTs(view),
    ladders,
    reputation,
    standing,
    // Friend edges are the social lane (M4); this reconstruction does not count
    // them. Honest 0 rather than a fabricated total.
    friendsCount: 0,
    games: gamesFromView(view, opts.gamesLimit ?? VIEWER_GAMES_PREVIEW),
    reconstruction: reconstructionFromView(view, opts.hops ?? 0),
    checkpoint: checkpointFromView(view),
  }
}

// ---------------------------------------------------------------------------
// The peer-facing wrapper (what ProfilePage calls)
// ---------------------------------------------------------------------------

export interface ViewerResult {
  /** The raw verified reconstruction (A4 pinned inputs, honest reports). */
  view: ResolvedProfile
  /** The UiProfile the page renders (null only if you asked for raw-only). */
  profile: UiProfile
  /** The lazy history pager (null when no head pinned; honest unavailability). */
  pager: HistoryPager | null
  /** The honest C-8 degradation summary. */
  availability: ViewerAvailability
}

/**
 * Resolve + map a target account for a LIVE AccountPeer: the peer's overlay is
 * the PointerReadNode, its fabric directory feeds pointer/checkpoint
 * verification. This is the single call the profile page makes; it returns the
 * verified view, the UI projection, the history pager, and the honest
 * availability read. Never throwing, degrading to a floor/unavailable surface
 * when fewer than K_rec rows are reachable (heals via runRepair).
 */
export async function viewAccountForPeer(
  peer: AccountPeer,
  subjectRoot: B64u,
  opts: ResolveAccountOpts & ViewToUiOpts = {},
): Promise<ViewerResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const view = await resolveAccountView(peer.overlay, subjectRoot, {
    ...opts,
    directory: peer.fabric.directory(),
    nowMs,
  })
  const hops = peer.overlay.lastLookupStats?.rounds ?? opts.hops ?? 0
  const profile = viewToUiProfile(view, {
    atWts: nowMs,
    hops,
    ...(opts.gamesLimit !== undefined ? { gamesLimit: opts.gamesLimit } : {}),
  })
  return {
    view,
    profile,
    pager: openAccountHistory(view),
    availability: summarizeAvailability(view),
  }
}

// ---------------------------------------------------------------------------
// Live storage / overlay stats (DataTab, real §5/§11 figures from the peer)
// ---------------------------------------------------------------------------

export interface LiveStorageStats {
  /** §11 advertised shard budget (peer.caps.shardMb). */
  budgetMb: number
  /** MB actually carried in the persistent store (kv), 0 until duty publishing
   * populates it. The honest live figure, never a fixture. */
  carriedMb: number
  /** Persisted shard rows carried (kv `shard|` keys). */
  shards: number
  /** Persisted authenticated-pointer rows carried (kv `pointer|`/`ptr|` keys). */
  pointers: number
  /** Distinct subject accounts we carry shard rows for. */
  accounts: number
  /** Whether the store claims durable (navigator.storage.persist()) capacity. */
  persisted: boolean
  /** Live overlay peers in this node's routing table. */
  peers: number
  /** Distinct third machines that could witness a game for us right now (§4
   * honest rated-play boundary). Zero ⇒ "rated play waits for a third machine". */
  witnessesReachable: number
}

const MB = 1024 * 1024

/** Read the REAL §5/§11 storage + overlay figures off a live AccountPeer. The
 * advertised budget, what the persistent store carries, overlay reachability,
 * and the honest reachable-witness count. Best-effort + total: a store that
 * cannot report (or is not yet wired to carry shards) yields zeros, never a
 * throw and never a fabricated number. */
export async function readStorageStats(peer: AccountPeer): Promise<LiveStorageStats> {
  const directory = peer.fabric.directory()
  const nowMs = Date.now()
  let witnessesReachable = 0
  for (const sp of liveNodesOf(directory, nowMs)) {
    if (sp.body.caps.witness && sp.body.root !== peer.root) witnessesReachable++
  }

  let carriedMb = 0
  let shards = 0
  let pointers = 0
  let accounts = 0
  const persisted = peer.kv?.persisted === true
  if (peer.kv) {
    try {
      // The overlay store keys values as `<kind>|<target>` (overlay/node.ts), so
      // a kv mirroring it carries `shard|…` / `pointers|…` rows. Subjects served
      // come from the ShardEnvelope's own header.root (the shard key itself is an
      // opaque hash), so this stays correct once shard persistence is wired.
      const [bytes, shardEntries, ptrCount] = await Promise.all([
        peer.kv.bytes(),
        peer.kv.entries('shard|'),
        peer.kv.count('pointers|'),
      ])
      carriedMb = bytes / MB
      shards = shardEntries.length
      pointers = ptrCount
      const subs = new Set<string>()
      for (const e of shardEntries) {
        const root = (e.value as { header?: { root?: unknown } } | undefined)?.header?.root
        if (typeof root === 'string') subs.add(root)
      }
      accounts = subs.size
    } catch {
      // A store that cannot report its contents contributes zeros, honestly.
    }
  }

  return {
    budgetMb: peer.caps.shardMb,
    carriedMb,
    shards,
    pointers,
    accounts,
    persisted,
    peers: tableSize(peer.overlay.table),
    witnessesReachable,
  }
}

/** A signed set of ladder previews for the DataTab witness list (live directory
 * witness-capable presences), each carrying only what a presence honestly
 * advertises: no fabricated distance/uptime. */
export interface LiveWitnessRow {
  nodeId: NodeId
  handle: string
  uptimePct: number
  committee: boolean
  shardMb: number
}

/** The live, witness-capable presences (excluding self) as display rows, the
 * REAL "who could witness / carry for me" set, straight off the directory. */
export function liveWitnessRows(peer: AccountPeer, limit = 8): LiveWitnessRow[] {
  const rows: LiveWitnessRow[] = []
  for (const sp of liveNodesOf(peer.fabric.directory(), Date.now())) {
    if (!sp.body.caps.witness || sp.body.root === peer.root) continue
    rows.push({
      nodeId: nodeIdOf(sp.body.root),
      handle: shortKey(sp.body.root),
      uptimePct: sp.body.uptimePct,
      committee: sp.body.caps.committee,
      shardMb: sp.body.caps.shardMb,
    })
  }
  rows.sort((a, b) => b.uptimePct - a.uptimePct || (a.nodeId < b.nodeId ? -1 : 1))
  return rows.slice(0, limit)
}
