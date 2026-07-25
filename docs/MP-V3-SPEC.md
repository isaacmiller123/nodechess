# Online Multiplayer v3 — binding spec

Authoritative design for the online-multiplayer hardening pass (2026-07). Written from the
45-defect audit (lifecycle L1-14, clocks D1-11, transport T1-9, lichess-parity MP-01..11) plus
live two-window repro evidence. Builders conform to this exactly; deviations need lead approval.

## The four user bugs this kills

- **B1** navigating anywhere unmounts OnlineTab which calls `mp.leave()` — live game destroyed
  (L2). All game state is component-local so even remount can't recover (MP-01).
- **B2** clocks only repaint on 'move' events; no local countdown; your OWN move never updates
  your clock; the guest never receives clock acks at all (D5/L9).
- **B3** "random resigns" = three real mechanisms: clock starts at HANDSHAKE so idle time burns
  white before move 1 (D1, measured 20.07s/60s); flag-falls are sent as `resign` on the wire
  (D2); and `leave()` clears the singleton's listeners so any Cancel→re-host runs a live,
  flag-timered game the UI is deaf to (L1, repro-confirmed).
- **B4** polish gaps: no names, no draw decline, force-start rematch, no reconnect grace, no
  abort, resignation-flavored timeout copy, silent errors (MP-05..11, L10-12).

## 1. Wire protocol v3 (`src/shared/mp/wire.ts`) — PROTOCOL_VERSION = 3

All in-game messages carry `gameId` (host-owned, monotonically increasing per session, starts 1;
sent in start/rematchStart). Receivers DROP any in-game message whose gameId ≠ current (D8).
`move` also carries `ply` (0-based; receivers drop duplicates/out-of-order, i.e. ply ≠ expected).

| msg | fields | notes |
|---|---|---|
| hello | v, role: 'host'\|'guest', name? | role fixes guest×guest deadlock (T5): guest receiving hello{role:'guest'} fails with "that code has no host". name = trimmed settings.username, ≤24 chars, control chars stripped (MP-09). |
| start | gameId, yourColor, config, name? | host→guest. name = host's. |
| move | gameId, ply, uci, clockMs | either direction; clockMs authoritative only host→guest. |
| clock | gameId, clockMs, toMove | host→guest ack after committing a guest move (D5), and re-sync every 5s while a clock runs. |
| flag | gameId, by, clockMs | time-out; REPLACES resign-for-flag (D2). clockMs has loser at 0. |
| abort | gameId, reason: 'no-first-move'\|'manual' | no result recorded (D1/MP-03). |
| gameOver | gameId, result: '1-0'\|'0-1'\|'1/2-1/2', reason | board-terminal endings confirmed cross-side (D7). |
| resign | gameId, by | ONLY genuine resignations. |
| drawOffer / drawDecline / drawAccept | gameId | decline added (MP-08). |
| rematchOffer / rematchDecline | — | symmetric for both roles (MP-07/L11). |
| rematchStart | gameId, yourColor | host sends ONLY on mutual offers. |
| resumeReq | gameId, havePly | rejoining peer asks to resume (T2/MP-06). |
| resync | gameId, moves: uci[], clockMs, toMove, yourColor | host→peer full authoritative snapshot. |
| ping / pong | t: senderMonoMs (ping), t echoed (pong) | timestamped for RTT → lag comp (D11). |
| bye, error | unchanged | |

## 2. Session rules (`mpSession.ts` rework)

**Time base (D3):** all elapsed measurement uses `performance.now()` (monotonic; excludes mac
sleep — a sleeping host charges no one). `Date.now()` only for absolute logging. Flag watchdog
callbacks NEVER trust timer punctuality: on fire, recompute remaining from the monotonic base;
if > 0, re-arm for the residual.

**First-move rules (D1/MP-03, verified lichess/scalachess):** clocks are IDLE at start
(turnStartedAt unset, no flag watchdog). White's first move debits 0 and credits NO increment;
committing it starts black's clock. From black's move 1 onward, normal Fischer debit+increment.
Abort watchdog replaces the pre-move flag: no white move within 30s of start, or no black reply
within 30s of white's move 1 → send+emit `abort{reason:'no-first-move'}`, no result, nothing
saved. Manual abort: either side may abort while plyCount < 2 (`mp.abort()`).

**Flag (D2):** flagLoss sends+emits `flag{by, clockMs}` (loser zeroed). The UI/store adjudicates
the lichess insufficient-material rule: if the NON-flagged side has insufficient mating material
(chessops helpers), the result is a draw ("time out — insufficient material"), else win on time.
Both stores run the same rule on the same position, so results agree.

**Lag compensation (D11):** ping carries sender mono-ms; pong echoes it → rolling RTT estimate.
Host forgives min(rtt/2, 250ms) on each guest move debit. Flag condition `remaining < 0` after
forgiveness; boundary re-verified via the watchdog re-check.

**Heartbeat (D4):** every 5s: SEND ping first, then evaluate. Self-stall forgiveness: if our own
tick gap since last fire > 2× cadence, we were suspended — reset lastPeerMsgAt = now, ping, and
do NOT judge the peer this tick. Declare peer-away only after ≥ 15s silence AND two consecutive
failed evaluations.

**Suspend / resume (T2/T3/T4/L6/D9/MP-06):** peer-gone (trystero onPeerLeave OR heartbeat) during
a live undecided game → state `suspended`: emit `peer-away{graceMs}`, PAUSE the authoritative
clock (record suspend mono-time; on resume, shift turnStartedAt), keep the room open, remember
`ghostPeerId`. Grace by speed (timeControlCategory): bullet 20s, blitz 30s, rapid 45s, classical
60s. While suspended: board frozen (store blocks moves), stale traffic from ghostPeerId dropped
by onRaw (T3) EXCEPT hello. Rebond: same peerId re-fires onPeerJoin (trystero re-pairs, T2) or a
hello arrives from it → handshake → host answers resumeReq with `resync` (NOT startGameAsHost —
never wipe a live game, D9); emit `peer-back`. A NEW peerId while suspended gets wire error
"game in progress". Grace expiry → emit `peer-left`; host unbinds; UI offers Claim victory
(records win, reason "opponent left") or Abort. After the game is over, fresh peers may join →
new gameId.

**Handshake watchdog (L8):** host bonds a peer on presence; if no valid hello within 15s, unbond
(peerId = null), emit net info, accept the next peer.

**Board-terminal endings (D7):** store calls `mp.gameEnded(result, reason)` on
checkmate/stalemate/insufficient/etc.; session ends the game, stops clocks, sends `gameOver`.
Receiving gameOver → endGame + emit.

**Draw rules (MP-08):** drawDecline message + event. Host-enforced: no offers before ply 2; after
a decline, the decliner-side cooldown = 20 plies before the same side may re-offer.

**Rematch (MP-07/L11):** symmetric. Any side's Rematch click sends rematchOffer. Host starts
(rematchStart, colors swapped, gameId+1) only when both sides have offered (its own click counts
as its offer). rematchDecline clears both.

**Lifecycle hygiene:** `leave()` MUST NOT clear listeners (L1/T1 — subscription lifetime belongs
to subscribers). `host()`/`join()` begin with `teardownTransport()` (L7). `resetState()` clears
all timers first (D10). Pre-game wire 'error' routes through fail() → transport teardown +
discovery timer cleared (L7). Relay-status 'net' events only while !handshaked (T8).

## 3. Transport (`rtcTransport.ts`)

- `msg.send(...).catch(...)` → new listener `onSendError(err)` — session treats it like
  heartbeat trouble (suspend path), never unhandled rejection (T6).
- `close()`: `room.leave().catch(() => {})`; stop the relay poll; expose `closed: Promise<void>`
  so a same-code rejoin can await settle (T7).
- `stopRelayPoll()` method; session calls it once handshaken (T8).

## 4. Online store (`online/onlineStore.ts` — NEW; the B1 fix)

Plain module singleton (NO React imports — testable in bare node) + a separate
`online/useOnlineGame.ts` hook wrapping `useSyncExternalStore`. The store subscribes to
`mp.onEvent` ONCE at module init, for the app's lifetime. OnlineTab becomes a pure view.
Unmount does NOT touch the session; remount re-attaches to live state (L2/MP-01).

State (single immutable snapshot object; every mutation replaces it and notifies):
```ts
interface OnlineState {
  phase: 'idle' | 'hosting' | 'connecting' | 'game'
  code: string | null
  config: MpGameConfig | null
  gameId: number
  myColor: 'white' | 'black'
  orientation: 'white' | 'black'
  moves: string[]                    // UCIs from startpos
  fen: string                        // derived incrementally (chessops)
  plyCount: number
  clock: { snapshot: { white: number; black: number }; atMono: number;
           running: 'white' | 'black' | null } | null
  banner: GameViewBanner | null      // + reason strings per §5
  drawOffered: boolean; drawSent: boolean; drawBlockedUntilPly: number
  rematchOffered: boolean; rematchSent: boolean
  peerAway: { deadlineMono: number } | null
  peerLeft: boolean
  canAbort: boolean                  // plyCount < 2 && live
  opponentName: string               // default 'Opponent'
  netStage: 'relays' | 'searching' | 'connecting' | null
  relays: { connected: number; total: number } | null
  error: string | null
}
```
Actions (exported on `onlineStore`): `host(cfg)`, `join(code)`, `playMove(uci)` (applies
optimistically, ROLLS BACK if `mp.sendMove` returns ok:false — D6; blocked while peerAway/over),
`resign()`, `offerDraw()`, `acceptDraw()`, `declineDraw()`, `offerRematch()`,
`declineRematch()`, `abort()`, `claimVictory()`, `leave()` (the ONLY caller of mp.leave()),
`flip()`, `dismissError()`, `getState()`, `subscribe(cb)`.

Store also owns: applying remote moves + terminal detection (→ mp.gameEnded), the
insufficient-material timeout adjudication (§2 Flag), saving finished games exactly once (≥2
plies + real result only; aborted/abandoned-without-claim games are NOT saved), sounds
(move/capture/check via playMove, notify on incoming draw/rematch offers, gameStart/gameEnd,
one-shot low-time), and PGN headers with real player names (MP-09).

**Clock display (B2/D5/MP-02):** store keeps the authoritative snapshot + atMono + running side;
the Clock component ticks itself every 100ms: shown = snapshot[side] − (side === running ?
now − atMono : 0), clamped ≥ 0. Tenths shown under 10s. Low-time threshold
min(60s, max(10s, base/8)) → is-low class + single low-time sound. Snapshot updates on every
move/clock/flag/resync event AND after our own committed move.

## 5. UI (`OnlineTab.tsx` rewrite + App shell)

- **Free navigation** (lichess model): the game runs in the store, so navigating away is SAFE.
  No blocking dialogs on nav. Instead: a floating **return chip** ("⏱ Online game — return",
  live clock) rendered by the app Layout whenever phase === 'game' (or 'hosting') and the Play
  view isn't showing; click → navigate back to Play/Online. Play rail item gets a pulsing dot.
- **Leave friction (L10):** while a live undecided game: NO 'New game' control; Leave button
  opens a confirm ("Leaving forfeits the game") with [Resign & leave] / [Cancel]. Post-banner,
  Leave/'New game' are free.
- **Peer-away strip (MP-06):** "「name」 disconnected — Ns to reconnect…" live countdown; on
  expiry, buttons **Claim victory** / **Abort game**. On peer-back: "「name」 reconnected".
- **Banner reasons (MP-11/MP-05):** 'on time' (flagged side's clock displayed 0.0), 'by
  resignation', 'by agreement', 'opponent left the game' (claimed), 'Game aborted' (neutral, no
  result, not saved), plus board reasons from outcome(). Personalized headline (You won/lost).
- **Draw UX:** Accept + Decline buttons on incoming offers; offer button disabled during
  cooldown with tooltip; "「name」 offers a draw" copy.
- **Rematch UX:** offer sent → "Rematch offered — waiting" + Cancel; incoming → Accept/Decline.
- **Abort:** small Abort control while canAbort.
- **Names:** PlayerChip shows opponentName; saved games + PGN use it.
- **Errors (L12):** in-game errors render in the status strip (never silent); lobby errors keep
  the current alert row.
- Fair-play unchanged: no hints/takebacks online. Board input disabled while peerAway.

## 6. Electron (`src/main/window.ts`)

`backgroundThrottling: false` in webPreferences (repro showed WebRTC exempts us in-game, but
this also protects the lobby/hosting phase which holds no WebRTC connection yet — L4).

## 7. Ownership map

- **builder-core**: wire.ts, mpSession.ts, rtcTransport.ts, shared/types.ts (MpEvent v3 union +
  Api-comment), window.ts.
- **builder-store**: online/onlineStore.ts, online/useOnlineGame.ts, Clock.tsx (ticking +
  tenths + low-time), sound wiring inside the store.
- **builder-ui**: OnlineTab.tsx, online.css, GameView.tsx (online-mode prop gaps: hide New game,
  abort button seam), App.tsx + Layout.tsx + OnlineReturnChip.tsx (return chip + rail dot),
  PlayView.tsx stage wiring (may now read the store directly).
- **builder-tests**: scripts/test-mp.mjs (v3 suite, ≥100 assertions incl. every §2 rule),
  scripts/test-mp-store.mjs (store against a mocked mp), E2E harness upgrade.

## 8. MpEvent v3 (shared/types.ts) — exact union

```ts
export type MpEvent =
  | { type: 'peer-joined' }
  | { type: 'start'; gameId: number; yourColor: MpColor; config: MpGameConfig; opponentName?: string }
  | { type: 'move'; gameId: number; ply: number; uci: string; clockMs: MpClocks }
  | { type: 'clock'; gameId: number; clockMs: MpClocks; toMove: MpColor }
  | { type: 'flag'; gameId: number; by: MpColor; clockMs: MpClocks }
  | { type: 'abort'; gameId: number; reason: 'no-first-move' | 'manual' }
  | { type: 'gameOver'; gameId: number; result: '1-0' | '0-1' | '1/2-1/2'; reason: string }
  | { type: 'drawOffer' } | { type: 'drawDecline' } | { type: 'drawAccept' }
  | { type: 'resign'; by: MpColor }
  | { type: 'rematchOffer' } | { type: 'rematchDecline' }
  | { type: 'rematchStart'; gameId: number; yourColor: MpColor }
  | { type: 'peer-away'; graceMs: number } | { type: 'peer-back' }
  | { type: 'peer-left' }
  | { type: 'net'; state: 'relays' | 'searching' | 'connecting'; relays?: { connected: number; total: number } }
  | { type: 'error'; message: string }
```
(`MpClocks = { white: number; black: number }`, exported.)
