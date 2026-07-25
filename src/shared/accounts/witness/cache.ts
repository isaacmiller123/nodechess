// A2 fabric-core. The witness-side cache (spec §4 / types.ts WitnessStore,
// C-1 gossip memory: reconstructible, unauthoritative; losing it is safe, but
// holding it is what gives fork detection memory). Platform-neutral.

import { eventId } from '../events'
import type { B64u, SignedEvent } from '../types'
import type { WitnessCacheEntry, WitnessStore } from './types'

/** In-memory WitnessStore (suites + the default operator-peer store). */
export class MemoryWitnessStore implements WitnessStore {
  private readonly map = new Map<B64u, WitnessCacheEntry>()

  async get(root: B64u): Promise<WitnessCacheEntry | null> {
    return this.map.get(root) ?? null
  }

  async put(e: WitnessCacheEntry): Promise<void> {
    this.map.set(e.root, { ...e })
  }

  async list(): Promise<WitnessCacheEntry[]> {
    // Deterministic order (by root) so a dump is byte-stable.
    return [...this.map.values()]
      .map((e) => ({ ...e }))
      .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
  }
}

/**
 * Advance a cache entry to a newly-admitted witnessed event: records the head
 * id/height and the epoch it was admitted under. Never regresses height (an
 * older or same-height event leaves the head untouched, only refreshing the
 * epoch high-water mark). Pure: returns a new entry; the store persists it.
 */
export function updateHeadFromEvent(
  entry: WitnessCacheEntry | null,
  root: B64u,
  event: SignedEvent,
  epoch?: number,
): WitnessCacheEntry {
  const base: WitnessCacheEntry = entry ? { ...entry } : { root }
  const h = event.body.height
  const nextEpoch =
    epoch === undefined ? base.lastEpoch : Math.max(epoch, base.lastEpoch ?? epoch)
  if (base.witnessedHeight === undefined || h > base.witnessedHeight) {
    base.witnessedHead = eventId(event.body)
    base.witnessedHeight = h
  }
  if (nextEpoch !== undefined) base.lastEpoch = nextEpoch
  return base
}

/**
 * Record that a fork was observed for a root (an equivocation proof was seen).
 * Latches forkProofSeen: never cleared. Pure. The proof itself lives with the
 * transport/slashing layer; the cache only remembers that one exists.
 */
export function recordFork(entry: WitnessCacheEntry | null, root: B64u): WitnessCacheEntry {
  const base: WitnessCacheEntry = entry ? { ...entry } : { root }
  base.forkProofSeen = true
  return base
}
