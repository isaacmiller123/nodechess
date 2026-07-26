/**
 * UI-facing shapes for the decentralized-accounts surfaces.
 *
 * Binding design: docs/ACCOUNTS-SPEC.md. These mirror the real data layer in
 * src/shared/accounts where one exists (StoredAccount, SignedEvent, FuseRecord,
 * Lease, …) but are flattened for rendering. Every Ui* value a surface renders
 * is a pure fold over public signed data (§0): the signed-in account folds from
 * the stored chain (../store/derive.ts), another player's profile folds from
 * what the resolve returned (../net/viewerClient.ts). Nothing rendered is ever
 * asserted state, and a shape with no live producer does not belong here.
 */

import type { DisplayState } from '@shared/accounts/ratings/display'

/** base64url-no-pad string (32-byte values are 43 chars, 64-byte sigs 86). */
export type B64u = string

/** LadderKey doubles as the shared RatedCategory (ratings/ladders.ts). */
export type LadderKey = 'Bullet' | 'Blitz' | 'Rapid' | 'Classical'

/**
 * §6 rating display states: THE SHARED UNION, re-exported verbatim from
 * ratings/display.ts (twin of mm/pairing.ts DisplayState) so no UI shape can
 * drift from the authority. Nothing hand-authors these: every `display` value
 * is the output of the shared displayState() over the ladder's protocol state,
 * so no surface can contradict the reveal thresholds (PARAMS_A4 120/100/80/40
 * via revealThreshold()).
 */
export type RatingDisplay = DisplayState

/** Protocol ladder numbers (fold.ts LadderState projection, micro-units). */
export interface UiLadderState {
  /** Witnessed rated games on this ladder. */
  n: number
  /** Rating in micro-Elo (×10⁶). Present even while hidden (§6 C-4: hiding
   * is a rendering rule; the bracket projection quantizes this). */
  r: number
  /** Rating deviation in micro-Elo (×10⁶). */
  rd: number
}

export interface UiLadder {
  key: LadderKey
  /** The protocol numbers every derived surface value folds from. */
  state: UiLadderState
  /** ALWAYS displayState(state, key). Derived, never authored. */
  display: RatingDisplay
  /** Convenience mirror of state.n. */
  games: number
  /** Sparkline points oldest→newest. Only present once ranked. */
  history?: number[]
}

/** §6b: public conduct standing, distinct from rating and from trust. */
export interface UiReputation {
  /** 0–100 conduct score from the reputation fold. */
  score: number
  tier: 'Exemplary' | 'Solid' | 'Mixed' | 'Poor'
  /** Fold components, for the breakdown list. */
  components: { label: string; value: string; positive: boolean }[]
  commendations: number
}

/** §9 ban taxonomy. Everything cites a public signed record, never a blocklist. */
export type UiStanding =
  | { state: 'good' }
  | { state: 'pin-fuse'; expiresWts: number; record: string }
  | { state: 'self-ban'; expiresWts: number; record: string }
  | { state: 'fork-permanent'; record: string }

/** §1 device enrollment via root-signed key certificates. */
export interface UiDevice {
  pub: B64u
  index: number
  label: string
  enrolledTs: number
  /** Witness-countersigned at first witnessed contact (PIN-gated). */
  witnessed: boolean
  thisDevice: boolean
  revoked?: boolean
}

/** §2 chain viewer row. `type` is a display string (A6 adds types beyond A1's). */
export interface UiChainEvent {
  id: B64u
  lane: 'w' | 'p'
  type: string
  height: number
  ts: number
  summary: string
  /** Witness attestation count on witnessed-lane events. */
  witnesses?: number
  /** Present on ckpt events. */
  ckpt?: { verified: 'incremental' | 'deep'; cosigners: number; of: number }
}

export interface UiGameRow {
  id: string
  opponent: string
  ladder: LadderKey
  result: '1-0' | '0-1' | '1/2-1/2'
  userColor: 'w' | 'b'
  ts: number
  /** Witnessed and countersigned into both chains (§3). */
  witnessed: boolean
}


export interface UiReconstruction {
  /** Whether the viewing flow needs shard reconstruction (owner offline). */
  ownerOnline: boolean
  hops: number
  pointerCount: number
  pointersIgnored: number
  holdersOnline: number
  shardsHave: number
  shardsNeed: number
  shardsTotal: number
  spotChecked: boolean
  /**
   * viewer.ts resolveProfile `status` carrier: 'expected' (a verified chain is
   * present) or 'floor' (fewer than K_rec shard rows, no chain linkage: the
   * degraded C-12 view; §12: degraded, self-healing, never silent).
   */
  path: 'expected' | 'floor'
  /**
   * viewer.ts resolveProfile `revocationContested` carrier (C-12): a
   * device-signed revocation was honored on device-attested evidence only, so
   * the view may be hiding one device's honest recent content. Must render as
   * a visible degradation. Never a silently complete view.
   */
  revocationContested: boolean
}

export interface UiProfile {
  handle: string
  displayName: string
  tag: string
  rootPub: B64u
  bio: string
  country: string
  flair: string
  /** Witnessed timestamps (diversity-bound, §4). */
  createdWts: number
  lastWitnessedWts: number
  /** Empty when the resolve recovered no rated state at all: unknown, which is
   *  not the same as "has never played" and never renders as it. */
  ladders: UiLadder[]
  /** null when no fold surface survived: unknown conduct, never a score of 0. */
  reputation: UiReputation | null
  standing: UiStanding
  /** null when nothing counted the edges (the reconstruction does not read the
   *  social lane). Unknown, never 0. */
  friendsCount: number | null
  games: UiGameRow[]
  reconstruction: UiReconstruction
  /**
   * Latest checkpoint the fast path verified (§2). `mOfN` carries viewer.ts
   * selectCheckpoint's cosigner-threshold verdict: false means the surfaced
   * checkpoint sits BELOW the M-of-N cosigner threshold (the honest fallback
   * selectCheckpoint returns when no cosigned checkpoint exists) and must
   * render as a degradation chip, never as a fully-attested checkpoint.
   */
  checkpoint: {
    height: number
    cosigners: number
    of: number
    verified: 'incremental' | 'deep'
    mOfN: boolean
  }
}

/** The signed-in account, as the keyring + chain folds would present it. */
export interface UiOwnAccount {
  handle: string
  displayName: string
  foldedName: string
  tag: string
  rootPub: B64u
  createdWts: number
  ladders: UiLadder[]
  reputation: UiReputation
  standing: UiStanding
  profile: { bio: string; country: string; flair: string; avatar: string }
  chainHeight: number
  chainEvents: number
}
