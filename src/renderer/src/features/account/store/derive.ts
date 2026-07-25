/**
 * Chain → UI derivations for the accounts store (A6 wiring, lane 4).
 *
 * Every value here is a PURE fold over the signed chain (§0: recomputable,
 * never asserted): ladders come from the shared a4Fold, reputation from the
 * §6b rep fold embedded in it, standing from the fold's ban map, profile
 * fields from personal-lane 'profile' records, devices from cert/revoke
 * events. No React, no DOM, no ambient clock: callers pass `atWts`
 * explicitly, so the whole module runs headless under the wiring suite
 * (scripts/test-web-accounts-wiring.mjs) exactly as it runs in the browser.
 */

import {
  canonicalHash,
  eventId,
  toB64u,
  witnessedHeadOf,
  type B64u,
  type Chain,
  type SignedEvent,
} from '@shared/accounts'
import { displayState } from '@shared/accounts/ratings/display'
import { profileView } from '@shared/accounts/social'
import { a4Fold, ladderInit, type A4FoldState } from '@shared/accounts/ratings/fold'
import { repScore, repTier } from '@shared/accounts/ratings/reputation'
import type {
  LadderKey,
  UiChainEvent,
  UiDevice,
  UiLadder,
  UiOwnAccount,
  UiReputation,
  UiStanding,
} from '../mock/types'

/** The shipped game registry kind (test-accounts-ratings convention): every
 * segment the client produces rates in a `chess:<TimeCategory>` ladder. */
export const GAME_KIND = 'chess'

export const LADDER_KEYS: readonly LadderKey[] = ['Bullet', 'Blitz', 'Rapid', 'Classical']

/** Flair fallback for a chain with no profile records yet. */
const DEFAULT_FLAIR = '♟'

// ---------------------------------------------------------------------------
// The a4 fold over a stored chain
// ---------------------------------------------------------------------------

export interface ChainDerived {
  fold: A4FoldState
  /** Display-Elo sparkline points per category, oldest → newest (one per
   * rated segment that moved the ladder). */
  histories: Record<LadderKey, number[]>
}

/** Witnessed-lane events in height order. The fold's canonical input. */
function witnessedInOrder(chain: Chain): SignedEvent[] {
  return chain.events.filter((e) => e.body.lane === 'w').sort((a, b) => a.body.height - b.body.height)
}

/** Run the shared a4 fold over the chain, capturing per-ladder rating
 * trajectories as segments land (for the profile sparklines). */
export function foldChainA4(chain: Chain): ChainDerived {
  let state = a4Fold.init(chain.root)
  const histories: Record<LadderKey, number[]> = {
    Bullet: [],
    Blitz: [],
    Rapid: [],
    Classical: [],
  }
  for (const ev of witnessedInOrder(chain)) {
    const prev = state
    state = a4Fold.step(state, ev)
    for (const key of LADDER_KEYS) {
      const id = `${GAME_KIND}:${key}`
      const now = state.ladders[id]
      if (now && now.n !== (prev.ladders[id]?.n ?? 0)) {
        histories[key].push(Math.floor(now.r / 1_000_000))
      }
    }
  }
  return { fold: state, histories }
}

/** b64u(canonicalHash(foldState)). The REAL fold digest for the chain view. */
export function foldDigestOf(fold: A4FoldState): B64u {
  return toB64u(canonicalHash(fold))
}

// ---------------------------------------------------------------------------
// Ladders (§6) / reputation (§6b) / standing (§9)
// ---------------------------------------------------------------------------

/** UiLadder rows for the four shipped categories. `atWts` is the caller's
 * evaluation instant (ban rendering). Never read from a clock here. */
export function deriveLadders(d: ChainDerived, atWts: number): UiLadder[] {
  return LADDER_KEYS.map((key) => {
    const id = `${GAME_KIND}:${key}`
    const ls = d.fold.ladders[id] ?? ladderInit()
    const state = { n: ls.n, r: ls.r, rd: ls.rd }
    const display = displayState(state, key, d.fold.bans[id], atWts)
    const hist = d.histories[key]
    return {
      key,
      state,
      display,
      games: ls.n,
      // Contract (mock/types UiLadder): history only once ranked.
      ...(display.state === 'ranked' && hist.length > 0 ? { history: hist.slice(-10) } : {}),
    }
  })
}

const REP_TIERS = ['Poor', 'Mixed', 'Solid', 'Exemplary'] as const

/** §6b reputation card from the fold's embedded rep state. Every row is a
 * counter the fold actually keeps, phrased as itself (no invented rates). */
export function deriveReputation(fold: A4FoldState): UiReputation {
  const r = fold.rep
  const score = repScore(r)
  const engagements = r.seg + r.abort
  const noshows = r.noshow + r.unsettled
  return {
    score,
    tier: REP_TIERS[repTier(score)],
    components: [
      { label: 'Completed games', value: `${r.seg} of ${engagements}`, positive: r.abort === 0 },
      { label: 'Disconnect / abandon losses', value: String(r.drop), positive: r.drop === 0 },
      {
        label: 'Timeout vs resignation losses',
        value: `${r.toLoss} · ${r.rsLoss}`,
        positive: r.toLoss <= r.rsLoss,
      },
      { label: 'No-shows / unsettled pairings', value: String(noshows), positive: noshows === 0 },
      { label: 'Rematches accepted', value: String(r.rematch), positive: r.rematch > 0 },
      { label: 'Commendations received', value: String(r.commend), positive: r.commend > 0 },
    ],
    commendations: r.commend,
  }
}

/** §9 standing from the fold's ban map: the longest active self-ban wins;
 * pin-fuse and fork states need witness records this client does not sync
 * yet, so absent an active ban the derivable truth is 'good'. */
export function deriveStanding(fold: A4FoldState, atWts: number): UiStanding {
  let best: { until: number; verdict: string } | null = null
  for (const id of Object.keys(fold.bans)) {
    const ban = fold.bans[id]
    if (ban.until > atWts && (best === null || ban.until > best.until)) {
      best = { until: ban.until, verdict: ban.verdict }
    }
  }
  if (best) return { state: 'self-ban', expiresWts: best.until, record: best.verdict }
  return { state: 'good' }
}

// ---------------------------------------------------------------------------
// Profile fields (personal lane, §10)
// ---------------------------------------------------------------------------

export interface DerivedProfile {
  bio: string
  country: string
  flair: string
  avatar: string
  /** §10 staleness: newest VERIFIED witness-attested time on the chain, or
   * null = no witnessed activity on record. Never a self-claimed timestamp. */
  lastWitnessedActivityWts: number | null
}

/** Personal-lane merge order: mirrors chain.ts mergeCompare (ts, key,
 * height) so every device derives the same last-write-wins result. */
function personalInOrder(chain: Chain, type: string): SignedEvent[] {
  return chain.events
    .filter((e) => e.body.lane === 'p' && e.body.type === type)
    .sort(
      (a, b) =>
        a.body.ts - b.body.ts ||
        (a.body.key < b.body.key ? -1 : a.body.key > b.body.key ? 1 : 0) ||
        a.body.height - b.body.height,
    )
}

/** Fold 'profile' records through the CANONICAL shared fold (A6 review
 * friends-1): social/profile.ts profileView, verifyChain's single LWW merge,
 * including the revoked-key exclusion this file's previous local merge
 * omitted (a chain verifyChain accepts must render the SAME fields every
 * viewer derives). Fail-closed: an unverifiable chain renders the empty
 * profile, never lenient-merged fields. Also carries the §10 staleness
 * value (review complete-1) so the UI can render honest last-witnessed
 * copy instead of a fabricated freshness claim. */
export function deriveProfile(chain: Chain): DerivedProfile {
  const v = profileView(chain)
  const f = (v?.fields ?? {}) as { [k: string]: unknown }
  return {
    bio: typeof f.bio === 'string' ? f.bio : '',
    country: typeof f.country === 'string' ? f.country : '',
    flair: typeof f.flair === 'string' ? f.flair : DEFAULT_FLAIR,
    avatar: typeof f.avatar === 'string' ? f.avatar : '',
    lastWitnessedActivityWts: v?.lastWitnessedActivity ?? null,
  }
}

// ---------------------------------------------------------------------------
// Devices (§1 key certificates)
// ---------------------------------------------------------------------------

/** Device rows from cert (purpose 0) + revoke events. `witnessed` is honest:
 * true only when the cert actually carries witness attestations. */
export function deriveDevices(chain: Chain, thisDevicePub: B64u): UiDevice[] {
  const revoked = new Set<string>()
  for (const ev of chain.events) {
    if (ev.body.type !== 'revoke') continue
    const p = ev.body.payload as { pub?: unknown }
    if (typeof p.pub === 'string') revoked.add(p.pub)
  }
  const out: UiDevice[] = []
  for (const ev of personalInOrder(chain, 'cert')) {
    const p = ev.body.payload as { pub?: unknown; purpose?: unknown; index?: unknown; label?: unknown }
    if (typeof p.pub !== 'string' || p.purpose !== 0 || typeof p.index !== 'number') continue
    out.push({
      pub: p.pub,
      index: p.index,
      label: typeof p.label === 'string' ? p.label : `Device ${p.index}`,
      enrolledTs: ev.body.ts,
      witnessed: (ev.wit?.length ?? 0) > 0,
      thisDevice: p.pub === thisDevicePub,
      ...(revoked.has(p.pub) ? { revoked: true } : {}),
    })
  }
  return out.sort((a, b) => a.index - b.index)
}

// ---------------------------------------------------------------------------
// Chain viewer rows (§2)
// ---------------------------------------------------------------------------

function summarize(ev: SignedEvent): string {
  const p = ev.body.payload as { [k: string]: unknown }
  switch (ev.body.type) {
    case 'genesis':
      return 'Account created, params digest pinned'
    case 'cert': {
      const label = typeof p.label === 'string' ? `, ${p.label}` : ''
      return p.purpose === 0
        ? `Device ${typeof p.index === 'number' ? p.index : '?'} enrolled (root-signed certificate)${label}`
        : `Key certificate issued${label}`
    }
    case 'revoke':
      return 'Key revoked (root-signed)'
    case 'profile': {
      const fields = typeof p.fields === 'object' && p.fields !== null ? Object.keys(p.fields) : []
      return `Profile updated${fields.length ? `: ${fields.join(', ')}` : ''}`
    }
    case 'ckpt':
      return `Checkpoint through height ${typeof p.through === 'number' ? p.through : '?'}`
    case 'segment':
      return `Rated game segment, ${typeof p.result === 'string' ? p.result : 'recorded'} (countersigned, written into both chains)`
    case 'conduct':
      return `Conduct event: ${typeof p.kind === 'string' ? p.kind : 'recorded'}`
    case 'commend':
      return 'Commendation received'
    case 'pin':
      return 'PIN committee anchor'
    case 'pairing':
      return 'Rated pairing recorded'
    case 'selfban':
      return 'Self-ban (anticheat conviction, §8)'
    default:
      return ev.body.type
  }
}

/** UiChainEvent rows in stored order (viewers sort for display). */
export function deriveChainEvents(chain: Chain): UiChainEvent[] {
  return chain.events.map((ev) => {
    const wit = ev.wit?.length ?? 0
    return {
      id: eventId(ev.body),
      lane: ev.body.lane,
      type: ev.body.type,
      height: ev.body.height,
      ts: ev.body.ts,
      summary: summarize(ev),
      ...(wit > 0 ? { witnesses: wit } : {}),
    }
  })
}

// ---------------------------------------------------------------------------
// The whole own-account projection
// ---------------------------------------------------------------------------

export interface OwnIdentityInputs {
  displayName: string
  foldedName: string
  tag: string
  rootPub: B64u
}

/** Compose the UiOwnAccount every hub surface renders, entirely from the
 * chain + the session's identity strings. Deterministic for a given
 * (chain, inputs, atWts). Asserted by the wiring suite. */
export function deriveOwnAccount(
  inp: OwnIdentityInputs,
  chain: Chain,
  atWts: number,
): UiOwnAccount {
  const d = foldChainA4(chain)
  const profile = deriveProfile(chain)
  const genesis = chain.events.find((e) => e.body.type === 'genesis')
  return {
    handle: `${inp.displayName}#${inp.tag}`,
    displayName: inp.displayName,
    foldedName: inp.foldedName,
    tag: inp.tag,
    rootPub: inp.rootPub,
    createdWts: genesis?.body.ts ?? 0,
    ladders: deriveLadders(d, atWts),
    reputation: deriveReputation(d.fold),
    standing: deriveStanding(d.fold, atWts),
    profile: { bio: profile.bio, country: profile.country, flair: profile.flair, avatar: profile.avatar },
    chainHeight: witnessedHeadOf(chain.events)?.height ?? 0,
    chainEvents: chain.events.length,
  }
}
