// A6 M4 (Lane L-ui): the LIVE account-network status bridge for the hub UI.
//
// The account hub's non-chain surfaces (identity presence, the PIN committee
// panel, the in-game witness/rated chrome) need to know ONE honest thing at a
// glance: is this signed-in client actually on the overlay right now, and what
// third machines can it reach? That is a pure read over the live AccountPeer's
// presence directory (spec §4/§11): never a fixture. This module turns that
// read into a small reactive store (house useSyncExternalStore pattern, same as
// mock/store.ts / onlineStore.ts) so every hub surface degrades HONESTLY:
// "offline", "connecting", "online · N peers", "waiting for a committee".
//
// It is READ-ONLY: it does not announce presence, provision a committee, or
// touch the fabric: the AccountPeer (peerService, started by accountNetBoot on
// sign-in) owns all of that. This bridge only observes getAccountPeer() and
// summarizes its directory, so it can never collide with the peer's own
// announce heartbeat or the social/pin transports. It self-starts by polling
// the peer singleton (the DataTab/ProfilePage convention), and additionally
// exposes pokeAccountNetStatus() for the boot layer to nudge on a peer
// transition for an instant flip (see notesForLead; no accountNetBoot edit is
// required for correctness, only latency).

import { useSyncExternalStore } from 'react'
import { getAccountPeer, type AccountPeer } from './peerService'

/** Overlay presence, honestly staged. */
export type NetPresence =
  | 'offline' // no live peer: signed out, or the peer has not come up yet
  | 'connecting' // peer up, but no other node is reachable yet (bootstrapping)
  | 'online' // peer up AND at least one other node reachable

/** A pure summary of the live overlay from ONE observer's directory (§4): what
 * this client can currently see. Every field is derived from signed presence
 * records: nothing here is asserted, and a divergent directory degrades only
 * liveness, never safety (NodeDirectory contract). */
export interface AccountNetStatus {
  /** Whether a live AccountPeer is up (signed in + peer started). */
  peerLive: boolean
  /** This node's overlay id (sha256(root)), or null when no peer is up. */
  nodeId: string | null
  presence: NetPresence
  /** Live nodes reachable over the presence directory, excluding self. */
  peersReachable: number
  /** Reachable third machines that advertise the witness cap (excluding self),
   * the §4 rated-play boundary. Zero ⇒ rated play honestly waits. */
  witnessesReachable: number
  /** Reachable nodes that advertise the PIN-committee cap (excluding self). */
  committeeReachable: number
  /** Convenience: at least one eligible witness is reachable right now. A
   * *sufficient* condition for rated play to be offered honestly (final
   * eligibility is judged at assignment, DataTab's note). */
  ratedAvailable: boolean
}

/** The honest signed-out / no-peer status: a shared constant so getSnapshot()
 * returns a stable reference until a peer comes up (useSyncExternalStore). */
export const OFFLINE_STATUS: AccountNetStatus = {
  peerLive: false,
  nodeId: null,
  presence: 'offline',
  peersReachable: 0,
  witnessesReachable: 0,
  committeeReachable: 0,
  ratedAvailable: false,
}

/**
 * PURE summarizer: the whole logic, decoupled from the singleton + timers so
 * it is unit-testable headless over a MockFabric-backed peer (the lane suite).
 * `nowMs` is injectable for deterministic staleness tests; production passes the
 * wall clock (this renderer layer is where Date.now() is allowed). A node is
 * counted only while its signed presence is fresh (within the directory's
 * staleAfterMs), so a peer that went dark drops out on the next poll.
 */
export function summarizeNetStatus(
  peer: AccountPeer | null,
  nowMs: number = Date.now(),
): AccountNetStatus {
  if (!peer) return OFFLINE_STATUS
  const dir = peer.fabric.directory()
  let peersReachable = 0
  let witnessesReachable = 0
  let committeeReachable = 0
  for (const sp of dir.nodes.values()) {
    if (sp.body.root === peer.root) continue // never count self
    if (nowMs - sp.body.ts > dir.staleAfterMs) continue // stale ⇒ offline (§4)
    peersReachable++
    if (sp.body.caps.witness) witnessesReachable++
    if (sp.body.caps.committee) committeeReachable++
  }
  return {
    peerLive: true,
    nodeId: peer.nodeId,
    presence: peersReachable > 0 ? 'online' : 'connecting',
    peersReachable,
    witnessesReachable,
    committeeReachable,
    ratedAvailable: witnessesReachable > 0,
  }
}

function eqStatus(a: AccountNetStatus, b: AccountNetStatus): boolean {
  return (
    a.peerLive === b.peerLive &&
    a.nodeId === b.nodeId &&
    a.presence === b.presence &&
    a.peersReachable === b.peersReachable &&
    a.witnessesReachable === b.witnessesReachable &&
    a.committeeReachable === b.committeeReachable &&
    a.ratedAvailable === b.ratedAvailable
  )
}

// ---------------------------------------------------------------------------
// Reactive store (ref-counted poll; one timer while any surface is mounted)
// ---------------------------------------------------------------------------

const POLL_MS = 2500

let snapshot: AccountNetStatus = OFFLINE_STATUS
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

/** Recompute snapshot from the live peer; return whether it actually changed.
 * Only reassigns on a real change so getSnapshot returns a stable reference
 * between changes (required by useSyncExternalStore). Does NOT notify. */
function refreshSnapshot(): boolean {
  const next = summarizeNetStatus(getAccountPeer())
  if (eqStatus(next, snapshot)) return false
  snapshot = next
  return true
}

/** Refresh and notify subscribers on a real change (the poll + poke path). */
function recompute(): void {
  if (refreshSnapshot()) for (const fn of listeners) fn()
}

function ensureTimer(): void {
  if (timer !== undefined || listeners.size === 0) return
  // Seed the snapshot for the just-subscribed consumer WITHOUT notifying:
  // useSyncExternalStore reads getSnapshot right after subscribe returns, so a
  // synchronous notify inside subscribe is both unnecessary and best avoided.
  refreshSnapshot()
  timer = setInterval(recompute, POLL_MS)
}

function maybeStopTimer(): void {
  if (listeners.size > 0 || timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  ensureTimer()
  return () => {
    listeners.delete(fn)
    maybeStopTimer()
  }
}

/** The current live status (stable reference between changes). */
export function getAccountNetStatus(): AccountNetStatus {
  return snapshot
}

/**
 * Nudge an immediate recompute. The OPTIONAL accountNetBoot lead hook: call it
 * from reconcilePeer right after the peer comes up / goes down so the hub flips
 * without waiting for the next poll. Safe to call anytime (no-op when nothing
 * changed); the poll is the correctness floor, this is only latency.
 */
export function pokeAccountNetStatus(): void {
  recompute()
}

/** React bridge: house useSyncExternalStore convention. Mounting the first
 * consumer starts the poll; unmounting the last stops it. */
export function useAccountNetStatus(): AccountNetStatus {
  return useSyncExternalStore(subscribe, getAccountNetStatus, getAccountNetStatus)
}
