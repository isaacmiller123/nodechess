// A6 M1 — LEAD INTEGRATION: run a live witness for one online game (spec §3/§4).
//
// The witness BODY (Lane D `witnessRunner`) joins a game room as the third,
// non-playing peer, drives a `WitnessCore` over the host's mirrored stream, and
// broadcasts wclk/wend back to both players. THIS controller is the app-facing
// lifecycle around it: it supplies the live game transport (`createRtcTransport`)
// and this device's signing identity, and — the piece that makes the players'
// witnessed APPENDS actually land — on the witnessed terminal it seeds each
// player's current head into this peer's `witnessServe` attest cache, so the
// peer can hand each player the NON-PLAYER attestation their `clientAppendWitnessed`
// requires (spec §4). The head is learned from that player's OWN signed pre-game
// snapshot over the fabric — a signed head, never an unverified claim.
//
// M1 DEV FLOW (A6 milestone M1, lane D): the room code + participants are
// handed in out of band (a manual dev handoff, or the always-on operator peer
// running the same `witnessServe` — server/operator/peer.ts). Full auto-assignment
// from the matchmaking pool is M2. Casual play is NEVER blocked on witness
// availability: this is opt-in, only for a rated game whose players both signed in.
//
// Renderer-hosted next to the `mp` singleton (it owns a live transport); the
// transport + peer + clock are INJECTED so it is headless-testable and consumes
// only the lanes' exports — `src/shared/accounts` stays pure.

import { nodeIdOf } from '@shared/accounts/witness'
import { sha256, toB64u, utf8 } from '@shared/accounts/hash'
import type { B64u, PairingPayload } from '@shared/accounts/types'
import type { MpTransportFactory } from '../../play/online/mpSession'
import { pairingAnchorsFor, requestPreGameSnapshot, type PairingTerms } from './preGame'
import type { AccountPeer } from './peerService'
import {
  witnessRunner,
  type WitnessRunnerGameInit,
  type WitnessRunnerHandle,
} from './witnessRunner'
import type { DeviceSigning } from './segmentPublisher'

export interface WitnessControllerDeps {
  /** The live account peer (getAccountPeer): its `witnessServe` grants the lease
   *  + non-player attestation, and its fabric fetches the players' snapshots. */
  getPeer: () => AccountPeer | null
  /** This device's signing identity (accounts.deviceSigningKey) — the witness
   *  signs wclk/wend + the witnessed-result record with it. */
  signing: () => DeviceSigning | null
  /** The live game transport factory (prod: createRtcTransport). Injected so a
   *  headless harness can pass a mock room. */
  makeTransport: MpTransportFactory
  /** The witness's own wall clock (ms). Default Date.now. */
  now?: () => number
  /** Diagnostics sink. */
  log?: (msg: string) => void
}

/**
 * Start witnessing `roomCode` for one rated game. Returns the runner handle
 * (`.stop()` leaves the room), or null when this instance can't witness (signed
 * out / no peer). Never throws; never blocks or affects any other game.
 *
 * `gameInit` is the caller's out-of-band knowledge of the game (per Lane D):
 * both players' `{root, device-key}` in `participants`, and for a RATED game the
 * ladder binding `kind`/`tc` + `pairing:'embedder-verified'` (WitnessCore refuses
 * to serve a rated game without pairing anchors).
 */
export function startWitnessing(
  roomCode: string,
  gameInit: WitnessRunnerGameInit,
  deps: WitnessControllerDeps,
): WitnessRunnerHandle | null {
  const log = deps.log ?? ((): void => {})
  const peer = deps.getPeer()
  const signing = deps.signing()
  if (!peer || !signing) {
    log('witness declined: not signed in / no account peer')
    return null
  }

  // M2 PRE-GAME SEED: before either player anchors its witnessed 'pairing' event,
  // seed both players' CURRENT heads into this peer's witnessServe attest cache so
  // the pairing appends (and everything after) get this non-player witness's
  // attestation (spec §4). Each head is read from that player's own SIGNED pre-game
  // snapshot over the fabric — a signed head, never a claim. Best-effort: an
  // unreachable player simply isn't seeded and its append retries. The known roots
  // come from the matchmaker's `participants` (the guest's hello is aimed at the
  // host, not us, so we cannot learn it from the wire alone).
  //
  // The head is GAME-INDEPENDENT (a player's current witnessed head does not
  // depend on which game it is about to play), so we do NOT need this game's
  // host-minted, runtime-random gameKey — which does not exist yet at attach time.
  // A stable per-ROOM placeholder key (derived from the room code) keys the signed
  // snapshot request; its game binding is anti-replay for the snapshot only, never
  // the segment. This is what lets the seed run at ATTACH time so the players'
  // pre-game 'pairing' appends land with attestation (previously the seed was
  // gated on a gameKey the matchmaker never has, so it was silently skipped).
  const knownRoots = (gameInit.participants ?? []).map((p) => p.root)
  if (knownRoots.length > 0) {
    const seedGame = gameInit.gameKey ?? seedGameKeyFor(roomCode)
    void seedHeadsFor(peer, signing.root, seedGame, knownRoots, log).catch((err) =>
      log(`witness pre-game seed error (ignored): ${String(err)}`),
    )
  }

  return witnessRunner(
    roomCode,
    gameInit,
    { root: signing.root, key: signing.key, priv: signing.priv },
    {
      makeTransport: deps.makeTransport,
      ...(deps.now ? { now: deps.now } : {}),
      onWitnessed: (result) => {
        // Terminal re-seed (robustness): the witness's attest cache auto-advances
        // through each attested append, so this is usually a no-op — it heals a
        // witness that missed a pre-game append (e.g. joined late).
        void seedHeadsFor(peer, signing.root, result.gameKey, [result.players.w, result.players.b], log).catch((err) =>
          log(`witness seed error (ignored): ${String(err)}`),
        )
      },
      onError: (e) => log(`witness follow error: ${e}`),
      log,
    },
  )
}

/**
 * Build the REAL `{ w, b }` pairing anchors the WitnessCore gate cross-checks from
 * the match terms the matchmaker already holds (preGame.pairingAnchorsFor) — the
 * M2 replacement for M1's blind 'embedder-verified'. The caller sets this on
 * `WitnessRunnerGameInit.pairing`; the witness then enforces the exact anchors
 * both players committed on-chain (game key, ladder binding, cross-wise opp roots)
 * rather than trusting a flag. Ignored on an unrated game (no kind/tc).
 */
export function buildRatedPairing(terms: PairingTerms): { w: PairingPayload; b: PairingPayload } {
  return pairingAnchorsFor(terms)
}

/** A stable placeholder game key for the pre-game HEAD seed, derived from the
 *  room code. The head is game-independent, so any consistent key is enough to
 *  key the signed pre-game snapshot request (the real host-minted gameKey isn't
 *  known until the game starts). Matches the derivation the ops smoke drivers +
 *  the interim boot workaround use, so the seed behaves identically. */
function seedGameKeyFor(roomCode: string): B64u {
  return toB64u(sha256(utf8(`mm-witness-seed:${roomCode}`)))
}

/**
 * Seed each named player's CURRENT head into this peer's `witnessServe` attest
 * cache so that player's `clientAppendWitnessed` round-trips (its pre-game
 * 'pairing' and post-game 'segment') get this (non-player) witness's attestation
 * (spec §4). Each head is read from that player's own SIGNED pre-game snapshot
 * over the fabric — a signed head, never a claim. Best-effort + idempotent: a
 * player that can't be reached simply isn't seeded (its append then waits and the
 * client retries) — never a throw, never a torn-down game.
 */
async function seedHeadsFor(
  peer: AccountPeer,
  witnessRoot: B64u,
  game: B64u,
  roots: readonly B64u[],
  log: (msg: string) => void,
): Promise<void> {
  for (const root of roots) {
    const snap = await requestPreGameSnapshot({
      fabric: peer.fabric,
      opp: nodeIdOf(root),
      game,
      selfRoot: witnessRoot,
      expectOppRoot: root,
    })
    if (!snap.ok) {
      log(`witness seed skipped for ${root.slice(0, 8)}…: ${snap.reason}`)
      continue
    }
    await peer.witness.seedHead(root, { id: snap.snapshot.body.head, height: snap.snapshot.body.height })
    log(`witness seeded head for ${root.slice(0, 8)}… @ height ${snap.snapshot.body.height}`)
  }
}
