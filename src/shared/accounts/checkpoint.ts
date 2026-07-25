// Checkpoints (spec §2): self-verifying, never trusted. The A1 fold is
// structural ('basic-v1'); A4 adds the ratings/trust fold ('a4-v1',
// ratings/fold.ts) behind the same ChainFold interface. A checkpoint embeds
// the prior checkpoint's id, the height it covers through, the fold state at
// that height, and the state's canonical digest, so it is incrementally
// verifiable in ONE step (recompute the fold over (prevCkpt.through, through]
// from the prior embedded state) and deeply verifiable from genesis.
//
// PLUGGABLE FOLDS (A4): verification selects the fold from the EMBEDDED
// state's `f` field: absent means 'basic-v1' (every pre-A4 state; behavior
// bit-identical to A1), any unknown or non-string id FAILS CLOSED (verify →
// false: an asserted state under a fold this verifier cannot recompute is
// never accepted, §2 "nothing on any path accepts an asserted number without
// a verification rule attached"). Incremental verification additionally
// demands the PREVIOUS checkpoint embed the SAME fold id. A fold-id
// transition (e.g. an account's first a4-v1 checkpoint after a basic-v1
// history) is not one-step-verifiable by construction; verifiers fall back
// to verifyCheckpointDeep, which recomputes the embedded state's fold from
// genesis. NOTE: chain.ts verifyChain's in-chain checkpoint audit still
// recomputes basic-v1 only (chain.ts is outside brick 2a); a4-v1 checkpoints
// are verified through the functions below.
//
// Platform-neutral: no `node:` imports, no DOM globals.

import { canonicalHash, compareKeys, type CanonicalObject, type CanonicalValue } from './codec'
import { eventId, signBody, zCheckpointPayload } from './events'
import { toB64u } from './hash'
import { a4Fold } from './ratings/fold'
import {
  N_CKPT,
  type B64u,
  type Chain,
  type ChainFold,
  type CheckpointPayload,
  type EventBody,
  type EventId,
  type SignedEvent,
} from './types'

// ---------------------------------------------------------------------------
// The A1 structural fold
// ---------------------------------------------------------------------------

/** Canonical-safe structural fold state: counts, head id, head height. */
export interface BasicFoldState extends CanonicalObject {
  /** Witnessed events folded so far. */
  n: number
  /** Per-type event counts. */
  byType: { [t: string]: number }
  /** Head id at this state. Absent only before genesis. */
  head?: string
  /** Head height at this state. Absent only before genesis. */
  height?: number
}

export const basicFold: ChainFold<BasicFoldState> = {
  id: 'basic-v1',
  init: (_root: B64u): BasicFoldState => ({ n: 0, byType: {} }),
  step: (state: BasicFoldState, event: SignedEvent): BasicFoldState => {
    const t = event.body.type
    return {
      n: state.n + 1,
      byType: { ...state.byType, [t]: (state.byType[t] ?? 0) + 1 },
      head: eventId(event.body),
      height: event.body.height,
    }
  },
}

// ---------------------------------------------------------------------------
// Fold registry (pluggable folds, header contract)
// ---------------------------------------------------------------------------

/** Any fold, viewed through the canonical-state interface the registry and
 * the verifiers need. ChainFold's method-syntax members are bivariant, so
 * concrete folds (ChainFold<BasicFoldState>, ChainFold<A4FoldState>) assign
 * directly. */
export type AnyChainFold = ChainFold<CanonicalObject>

const FOLDS: { readonly [id: string]: AnyChainFold } = {
  [basicFold.id]: basicFold,
  [a4Fold.id]: a4Fold,
}

/** The registered fold for `id`, or undefined (callers fail closed). */
export function foldById(id: string): AnyChainFold | undefined {
  return Object.prototype.hasOwnProperty.call(FOLDS, id) ? FOLDS[id] : undefined
}

/** Fold id embedded in a checkpoint state: `f` when a string, 'basic-v1'
 * when absent (pre-A4 states), null when malformed (fail closed). Exported
 * for chain.ts's in-chain checkpoint audit: the two verifiers must select
 * folds by ONE rule. */
export function foldIdOfState(state: CanonicalObject): string | null {
  const f = (state as { f?: unknown }).f
  if (f === undefined) return basicFold.id
  return typeof f === 'string' ? f : null
}
const foldIdOf = foldIdOfState

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Witnessed events sorted by (height, id). The fold order. */
function witnessedSorted(chain: Chain): SignedEvent[] {
  return chain.events
    .filter((e) => e.body.lane === 'w')
    .sort((a, b) => a.body.height - b.body.height || compareKeys(eventId(a.body), eventId(b.body)))
}

/** Lowest witnessed height carrying a rated-shaped segment (§6 ladder binding
 * present: kind + running clock), or -1. The A4-10 rule keys on this: a
 * checkpoint covering rated play must embed the a4-v1 fold. Fold-downgrade
 * sandbagging (checkpointing basic-v1 forever to hide ladders/reputation and
 * be rated as a 1200/350 seed) is fraud, not a choice. Mirrors chain.ts. */
function firstRatedHeight(w: readonly SignedEvent[]): number {
  for (const ev of w) {
    if (ev.body.type !== 'segment') continue
    const p = ev.body.payload as { kind?: unknown; tc?: { baseMs?: unknown } }
    if (typeof p.kind === 'string' && typeof p.tc === 'object' && p.tc !== null &&
      typeof p.tc.baseMs === 'number' && p.tc.baseMs > 0)
      return ev.body.height
  }
  return -1
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Build (do not append) a checkpoint event at the current witnessed head:
 * through = head height, state = `fold` (default basic-v1) over heights
 * [0, through], prevCkpt = id of the latest prior ckpt event when one exists.
 * The policy cadence is every N_CKPT witnessed games (see dueForCheckpoint)
 * but this is callable at any point.
 */
export function makeCheckpointEvent(
  chain: Chain,
  priv: Uint8Array,
  key: B64u,
  ts: number,
  fold?: AnyChainFold,
): SignedEvent {
  const w = witnessedSorted(chain)
  const head = w[w.length - 1]
  if (!head) throw new Error('makeCheckpointEvent: chain has no witnessed events')
  // A4 review fix (A4-10), builder side: when the caller does not choose a
  // fold, auto-select a4-v1 for chains with rated segments (the verifiers
  // REQUIRE it; a default basic-v1 checkpoint there would be fraud).
  if (fold === undefined) {
    const a4 = foldById('a4-v1')
    fold = firstRatedHeight(w) !== -1 && a4 ? a4 : basicFold
  }
  let prevCkpt: EventId | undefined
  for (let i = w.length - 1; i >= 0; i--)
    if (w[i].body.type === 'ckpt') {
      prevCkpt = eventId(w[i].body)
      break
    }
  let state = fold.init(chain.root)
  for (const ev of w) state = fold.step(state, ev)
  const payload: CheckpointPayload = {
    ...(prevCkpt !== undefined ? { prevCkpt } : {}),
    through: head.body.height,
    state,
    stateDigest: toB64u(canonicalHash(state)),
  }
  const body: EventBody = {
    v: 1,
    lane: 'w',
    type: 'ckpt',
    root: chain.root,
    key,
    height: head.body.height + 1,
    prev: eventId(head.body),
    ts,
    payload,
  }
  return signBody(body, priv)
}

/**
 * True when N_CKPT witnessed (non-checkpoint) events have accumulated since
 * the last checkpoint's covered height (or since the beginning).
 */
export function dueForCheckpoint(chain: Chain): boolean {
  const w = witnessedSorted(chain)
  let lastThrough = -1
  for (let i = w.length - 1; i >= 0; i--)
    if (w[i].body.type === 'ckpt') {
      const parsed = zCheckpointPayload.safeParse(w[i].body.payload)
      lastThrough = parsed.success ? parsed.data.through : w[i].body.height
      break
    }
  let n = 0
  for (const ev of w) if (ev.body.height > lastThrough && ev.body.type !== 'ckpt') n++
  return n >= N_CKPT
}

// ---------------------------------------------------------------------------
// Verification (never throws: bad input returns false)
// ---------------------------------------------------------------------------

interface ParsedCkpt {
  payload: CheckpointPayload
}

function parseCkpt(chain: Chain, ckptEvent: SignedEvent): ParsedCkpt | null {
  const b = ckptEvent.body
  if (b.type !== 'ckpt' || b.lane !== 'w' || b.root !== chain.root) return null
  const parsed = zCheckpointPayload.safeParse(b.payload)
  if (!parsed.success) return null
  const payload = b.payload as CheckpointPayload
  // (a)+(b) self-consistency: the digest must be OF the embedded state.
  if (toB64u(canonicalHash(payload.state as CanonicalValue)) !== payload.stateDigest) return null
  return { payload }
}

/** Fold `state` over witnessed heights (after, through] under `fold`,
 * demanding contiguity. */
function foldRange(
  chain: Chain,
  fold: AnyChainFold,
  state: CanonicalObject,
  after: number,
  through: number,
): CanonicalObject | null {
  const range = witnessedSorted(chain).filter((e) => e.body.height > after && e.body.height <= through)
  if (range.length !== through - after) return null
  for (let i = 0; i < range.length; i++) if (range[i].body.height !== after + 1 + i) return null
  let s = state
  for (const ev of range) s = fold.step(s, ev)
  return s
}

/**
 * Incremental verification (spec §2: one step): select the fold from the
 * EMBEDDED state's `f` (absent ⇒ basic-v1; unknown/malformed ⇒ false, fail
 * closed), recompute it over (prevCkpt.through, through] starting from the
 * previous checkpoint's EMBEDDED state, which must carry the SAME fold id
 * (header: fold transitions are not one-step-verifiable; use deep), and
 * require the result to hash to stateDigest. Detects both a forged digest
 * and a forged state under a correct digest.
 */
export function verifyCheckpointIncremental(chain: Chain, ckptEvent: SignedEvent): boolean {
  try {
    const parsed = parseCkpt(chain, ckptEvent)
    if (!parsed) return false
    const { payload } = parsed
    const foldId = foldIdOf(payload.state)
    if (foldId === null) return false
    const fold = foldById(foldId)
    if (!fold) return false // unknown fold id. Fail closed
    let start: CanonicalObject
    let after: number
    if (payload.prevCkpt !== undefined) {
      const prevEv = chain.events.find(
        (e) => e.body.lane === 'w' && e.body.type === 'ckpt' && eventId(e.body) === payload.prevCkpt,
      )
      if (!prevEv) return false
      const prev = parseCkpt(chain, prevEv)
      if (!prev) return false
      if (foldIdOf(prev.payload.state) !== foldId) return false // fold transition. Not one-step
      start = prev.payload.state
      after = prev.payload.through
    } else {
      start = fold.init(chain.root)
      after = -1
    }
    if (payload.through <= after) return false
    // A4-10: a basic-v1 checkpoint may not cover rated play (see firstRatedHeight).
    if (foldId === basicFold.id) {
      const rated = firstRatedHeight(witnessedSorted(chain))
      if (rated !== -1 && payload.through >= rated) return false
    }
    const computed = foldRange(chain, fold, start, after, payload.through)
    if (!computed) return false
    return toB64u(canonicalHash(computed)) === payload.stateDigest
  } catch {
    return false
  }
}

/** Deep verification: recompute the embedded state's fold (by its `f`, same
 * selection rule as incremental) from genesis over [0, through]. */
export function verifyCheckpointDeep(chain: Chain, ckptEvent: SignedEvent): boolean {
  try {
    const parsed = parseCkpt(chain, ckptEvent)
    if (!parsed) return false
    const foldId = foldIdOf(parsed.payload.state)
    if (foldId === null) return false
    const fold = foldById(foldId)
    if (!fold) return false // unknown fold id. Fail closed
    // A4-10: a basic-v1 checkpoint may not cover rated play (see firstRatedHeight).
    if (foldId === basicFold.id) {
      const rated = firstRatedHeight(witnessedSorted(chain))
      if (rated !== -1 && parsed.payload.through >= rated) return false
    }
    const computed = foldRange(chain, fold, fold.init(chain.root), -1, parsed.payload.through)
    if (!computed) return false
    return toB64u(canonicalHash(computed)) === parsed.payload.stateDigest
  } catch {
    return false
  }
}
