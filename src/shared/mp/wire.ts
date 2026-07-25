// Internet-multiplayer wire protocol (v3): message schemas, the version hello,
// wire-level heartbeat, and the room-code codec. ISOMORPHIC by design, ZERO node
// imports (no 'node:os', no Buffer) so this module bundles into the renderer AND
// runs unchanged under bare node for tests. The transport lives in the renderer
// (WebRTC via trystero); this file only knows how to (de)serialize and validate.
//
// v3 (docs/MP-V3-SPEC.md §1) over v2:
//   - hello carries `role` (host|guest). A guest that hears hello{role:'guest'}
//     knows nobody is hosting and fails fast (kills the guest×guest deadlock),
//     and an optional `name` (the player's display name).
//   - ALL in-game messages carry the host-owned `gameId` (monotonic per session,
//     starts 1). Receivers DROP any in-game message whose gameId ≠ the current
//     game, so late/duplicate traffic from a prior game can't corrupt state.
//   - `move` also carries a 0-based `ply` (receivers drop out-of-order/dupes).
//   - flags are their own `flag` message (no longer smuggled as a resign), the
//     first-move grace is enforced by `abort`, board-terminal endings ride a
//     `gameOver`, draws gain a `drawDecline`, rematch gains a `rematchDecline`,
//     and reconnect adds `resumeReq`/`resync`. ping/pong carry a timestamp for
//     RTT-based lag compensation.

import { z } from 'zod'
import type { MpGameConfig } from '@shared/types'

// ---- Version hello -----------------------------------------------------------
// First message a peer sends once the data channel opens, BOTH directions. A peer
// whose `v` doesn't match PROTOCOL_VERSION is refused with a wire 'error' and the
// session is torn down. Bump this on ANY wire-incompatible change below.

// v4 (docs/GAMES-PLATFORM-SPEC.md §Wire-v4) over v3: game-agnostic online.
//   - MpGameConfig gains `game?: { kind, options }` (absent = chess).
//   - move strings are game-defined codecs: uci-regex → non-empty string ≤ 64
//     chars. Legality is validated by the game kernel on the HOST before a move
//     is committed/relayed (authority unchanged). The wire only bounds size.
//   - resync additionally carries the game config so a resumed guest can rebuild
//     a non-chess game. v3 peers are refused politely by the hello version gate.
//
// v5 over v4: Japanese byo-yomi (go quality-of-life).
//   - MpGameConfig.tc gains optional `byoyomi { periods, periodMs }`.
//   - move/clock/flag/resync gain an optional per-side `byo` snapshot
//     ({ periodsLeft, inByo } each) riding beside clockMs: with byo-yomi the
//     clockMs NUMBER means "current period remaining" once a side is inByo, so
//     the clock semantics themselves changed → v4 peers must be refused (the
//     hello version gate already does). Absent tc.byoyomi keeps every message
//     byte-identical to v4.
//
// v6 over v5: signed play + the witness seat (docs/ACCOUNTS-SPEC.md §3).
//   - `role` gains 'witness': a third, non-playing peer that follows the game
//     and countersigns the move stream. The session admits exactly ONE.
//   - hello gains OPTIONAL identity fields `root`/`key` (account root + device
//     signing key, b64u). Both sides sending identity = signed play.
//   - start/rematchStart/resync gain OPTIONAL `gameKey` + `players` (roots by
//     color): the host-minted global game key every signature covers
//     (accounts segment.ts gameKey), binding sigs to THIS game so nothing is
//     replayable into another.
//   - move gains an OPTIONAL `sig`: ed25519 by the mover over segment.ts
//     moveSigBytes(gameKey, ply, uci, clockMs, prevSig): the per-move chain.
//   - gameOver/resign/flag gain an OPTIONAL `esig`: the sender's terminal
//     countersignature over segment.ts witnessEndBytes.
//   - NEW witness→player messages `wclk`/`wend` carry the witness's periodic
//     clock countersignature and terminal stream signature.
//   The wire only BOUNDS these shapes (b64u lengths, string caps); signature
//   verification lives in the sessions (mpSession/witnessCore). Every addition
//   is optional, so an unsigned session's messages stay byte-identical to v5,
//   but signed clock semantics ride on hello identity, so v5 peers are refused
//   by the hello version gate as usual.
export const PROTOCOL_VERSION = 6

const roleSchema = z.enum(['host', 'guest', 'witness'])

// v6 signature-material bounds. Deliberately REDECLARED here rather than
// imported from src/shared/accounts (events.ts zB64u32/zB64u64). The mp wire
// stays standalone (zod + shared types only) so it keeps bundling anywhere
// without dragging the accounts layer in. Shapes must stay in lockstep.
const B64U_RE = /^[A-Za-z0-9_-]+$/
/** b64u of 32 bytes (roots, keys, game keys, digests): exactly 43 chars. */
const b64u32Schema = z.string().length(43).regex(B64U_RE)
/** b64u of 64 bytes (ed25519 signatures): exactly 86 chars. */
const b64u64Schema = z.string().length(86).regex(B64U_RE)
/** Player account roots by color (rides beside gameKey on start/resync). */
const playersSchema = z.object({ w: b64u32Schema, b: b64u32Schema }).strict()

export const helloMsgSchema = z
  .object({
    t: z.literal('hello'),
    /** Protocol version must equal PROTOCOL_VERSION on both sides. */
    v: z.number().int(),
    /** Sender's role. A guest hearing hello{role:'guest'} fails fast: that code
     *  has no host (kills the guest×guest deadlock, MP-V3 §1/T5). */
    role: roleSchema,
    /** Sender's trimmed display name (≤24 chars, control chars stripped). */
    name: z.string().optional(),
    /** App version string, informational only (never gates compatibility). */
    app: z.string().optional(),
    /** v6: sender's account root (b64u). Present ⇒ the sender offers signed
     *  play (players) or names its signing identity (witness). */
    root: b64u32Schema.optional(),
    /** v6: sender's device signing key (b64u). What its move/stream sigs
     *  verify against. Rides with `root`; absent = unsigned, exactly v5. */
    key: b64u32Schema.optional()
  })
  .strict()
export type HelloMsg = z.infer<typeof helloMsgSchema>

/** Longest display name we put on the wire; longer names are truncated. */
export const MAX_NAME_LEN = 24

/** Sanitize a raw display name for the wire: strip control chars, collapse
 *  whitespace, trim, clamp to MAX_NAME_LEN. Returns undefined when nothing
 *  usable remains (so hello omits `name` rather than sending ''). */
export function sanitizeName(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
  return cleaned.length > 0 ? cleaned : undefined
}

/** The hello THIS build sends, carrying our role + optional display name.
 *  v6: `identity` rides as the optional root/key pair when the sender offers
 *  signed play (players) or names its signing key (witness). */
export function makeHello(
  role: 'host' | 'guest' | 'witness',
  name?: string,
  appVersion?: string,
  identity?: { root: string; key: string }
): HelloMsg {
  const clean = sanitizeName(name)
  return {
    t: 'hello',
    v: PROTOCOL_VERSION,
    role,
    ...(clean ? { name: clean } : {}),
    ...(appVersion ? { app: appVersion } : {}),
    ...(identity ? { root: identity.root, key: identity.key } : {})
  }
}

// ---- Game config / message schemas --------------------------------------------
// Mirrors the shared MpGameConfig / MpEvent contract (src/shared/types.ts).
// Everything on the wire is one JSON-encoded WireMsg per data-channel message.

export const mpTimeControlSchema = z
  .object({
    // 0 == untimed/unlimited (no clock at all); otherwise a real starting budget.
    // (With byoyomi present, initialMs 0 is a REAL control: straight to period 1.)
    initialMs: z.number().int().min(0),
    incrementMs: z.number().int().min(0),
    // v5: Japanese byo-yomi (absent = plain Fischer, byte-identical to v4).
    byoyomi: z
      .object({
        periods: z.number().int().min(1).max(30),
        periodMs: z.number().int().min(1_000)
      })
      .strict()
      .optional()
  })
  .strict()

/** v4: which game a session plays. `kind` is a registry key ('chess' default);
 *  `options` is an opaque, game-defined JSON blob (validated by the game's own
 *  kernel init, not by the wire). Absent `game` on the config means chess.
 *  `firstMover` is which color moves FIRST (black in go/gomoku/othello/
 *  checkers); absent = white: chess configs stay byte-identical to pre-
 *  firstMover builds, so the wire stays v4. */
export const mpGameSelectorSchema = z
  .object({
    kind: z.string().min(1).max(64),
    // Opaque per-game options; must survive JSON round-trip untouched. unknown()
    // accepts anything INCLUDING absent, mirrors `options?: unknown`.
    options: z.unknown().optional(),
    firstMover: z.enum(['white', 'black']).optional()
  })
  .strict()

export const mpGameConfigSchema = z
  .object({
    tc: mpTimeControlSchema,
    hostColor: z.enum(['white', 'black', 'random']),
    game: mpGameSelectorSchema.optional()
  })
  .strict()
// Compile-time check: the zod schema stays in lockstep with the shared type.
type _AssertMpGameConfig = z.infer<typeof mpGameConfigSchema> extends MpGameConfig ? true : never
const _assertMpGameConfig: _AssertMpGameConfig = true
void _assertMpGameConfig

const colorSchema = z.enum(['white', 'black'])
const clocksSchema = z.object({ white: z.number(), black: z.number() }).strict()

/** v5: per-side byo-yomi snapshot riding beside clockMs when the config has
 *  byo-yomi. `periodsLeft` INCLUDES the running period; once `inByo` the side's
 *  clockMs number is current-period remaining (main-time remaining before). */
const byoSideSchema = z.object({ periodsLeft: z.number().int().min(0), inByo: z.boolean() }).strict()
export const byoSchema = z.object({ white: byoSideSchema, black: byoSideSchema }).strict()

/** v4 move string: a game-defined canonical move codec (chess: UCI like 'e2e4'/
 *  'e7e8q'; go: 'pd4'/'pass'; …). The wire only bounds it (non-empty, ≤64 chars);
 *  LEGALITY is enforced by the host-side game kernel before commit/relay. The
 *  field keeps its historical name `uci` on the wire for schema stability. */
export const moveStrSchema = z.string().min(1).max(64)

export const wireMsgSchema = z.discriminatedUnion('t', [
  helloMsgSchema,
  // host -> guest: colors resolved, game on. `yourColor` is the GUEST's color;
  // `gameId` opens this game (1, then +1 per rematch); `name` is the host's.
  z
    .object({
      t: z.literal('start'),
      gameId: z.number().int(),
      yourColor: colorSchema,
      config: mpGameConfigSchema,
      name: z.string().optional(),
      // v6: host-minted global game key + player roots by color (signed play
      // only: segment.ts gameKey binds every signature to THIS game). Absent
      // = unsigned, byte-identical to v5.
      gameKey: b64u32Schema.optional(),
      players: playersSchema.optional()
    })
    .strict(),
  // either direction: the sender's move (uci) at a given 0-based ply + the
  // sender's clocks after it. clockMs is authoritative only host -> guest.
  // v5: `byo` rides along whenever the config has byo-yomi (host-authoritative).
  // v6: `sig` = the mover's ed25519 over segment.ts moveSigBytes(gameKey, ply,
  // uci, clockMs, prevSig): the per-move chain (signed play only).
  z
    .object({
      t: z.literal('move'),
      gameId: z.number().int(),
      ply: z.number().int().min(0),
      uci: moveStrSchema,
      clockMs: clocksSchema,
      byo: byoSchema.optional(),
      sig: b64u64Schema.optional()
    })
    .strict(),
  // host -> guest: authoritative clock ack after committing a guest move, and a
  // periodic re-sync while a clock runs. toMove = whose clock is now ticking.
  z
    .object({
      t: z.literal('clock'),
      gameId: z.number().int(),
      clockMs: clocksSchema,
      toMove: colorSchema,
      byo: byoSchema.optional()
    })
    .strict(),
  // time-out. REPLACES resign-for-flag. clockMs has the loser (`by`) at 0
  // (with byo-yomi, the loser's periodsLeft is 0 too). v6: `esig` = the
  // sender's terminal countersignature over segment.ts witnessEndBytes.
  z
    .object({
      t: z.literal('flag'),
      gameId: z.number().int(),
      by: colorSchema,
      clockMs: clocksSchema,
      byo: byoSchema.optional(),
      esig: b64u64Schema.optional()
    })
    .strict(),
  // first-move grace expired or a player aborted; no result is recorded.
  z
    .object({
      t: z.literal('abort'),
      gameId: z.number().int(),
      reason: z.enum(['no-first-move', 'manual'])
    })
    .strict(),
  // board-terminal ending (checkmate/stalemate/insufficient/…), confirmed both sides.
  // v6: `esig` = the sender's terminal countersignature (witnessEndBytes).
  z
    .object({
      t: z.literal('gameOver'),
      gameId: z.number().int(),
      result: z.enum(['1-0', '0-1', '1/2-1/2']),
      reason: z.string(),
      esig: b64u64Schema.optional()
    })
    .strict(),
  // genuine resignation only. v6: `esig` = the resigner's terminal counter-
  // signature over segment.ts witnessEndBytes (absent = unsigned, exactly v5).
  z
    .object({
      t: z.literal('resign'),
      gameId: z.number().int(),
      by: colorSchema,
      esig: b64u64Schema.optional()
    })
    .strict(),
  z.object({ t: z.literal('drawOffer'), gameId: z.number().int() }).strict(),
  z.object({ t: z.literal('drawDecline'), gameId: z.number().int() }).strict(),
  z.object({ t: z.literal('drawAccept'), gameId: z.number().int() }).strict(),
  // rematch is symmetric: either side offers; the host starts on mutual offers.
  z.object({ t: z.literal('rematchOffer') }).strict(),
  z.object({ t: z.literal('rematchDecline') }).strict(),
  // host -> guest on mutual rematch; `yourColor` is again the GUEST's (swapped) color.
  // v6: a signed rematch mints a FRESH gameKey (same players, new nonce).
  z
    .object({
      t: z.literal('rematchStart'),
      gameId: z.number().int(),
      yourColor: colorSchema,
      gameKey: b64u32Schema.optional(),
      players: playersSchema.optional()
    })
    .strict(),
  // reconnect: a rejoining peer asks the host to resume from the ply it has.
  z.object({ t: z.literal('resumeReq'), gameId: z.number().int(), havePly: z.number().int().min(0) }).strict(),
  // host -> peer: full authoritative snapshot to rebuild the live game after a rebond.
  z
    .object({
      t: z.literal('resync'),
      gameId: z.number().int(),
      moves: z.array(moveStrSchema),
      clockMs: clocksSchema,
      toMove: colorSchema,
      yourColor: colorSchema,
      // v4: the game config rides along so a resumed guest can rebuild any game
      // (optional so a config-less resync still parses; chess needs no rebuild).
      config: mpGameConfigSchema.optional(),
      // v5: byo-yomi state survives a reconnect (periods consumed stay consumed).
      byo: byoSchema.optional(),
      // v6: the game key + player roots survive a reconnect too (signed play).
      gameKey: b64u32Schema.optional(),
      players: playersSchema.optional()
    })
    .strict(),
  // v6 witness -> players: periodic countersignature over the interleaved
  // clock stream: the witness's ed25519 over segment.ts witnessClockBytes
  // (gameKey, ply, clockMs, wts) at its own clock reading `wts` (unix ms).
  z
    .object({
      t: z.literal('wclk'),
      gameId: z.number().int(),
      ply: z.number().int().min(0),
      clockMs: clocksSchema,
      wts: z.number().int().min(0),
      sig: b64u64Schema
    })
    .strict(),
  // v6 witness -> players: terminal stream signature. The witness's ed25519
  // over segment.ts witnessEndBytes(gameKey, result, plies, transcript). This
  // is exactly what SegmentPayload.wstream carries into BOTH players' chains.
  z
    .object({
      t: z.literal('wend'),
      gameId: z.number().int(),
      result: z.enum(['1-0', '0-1', '1/2-1/2']),
      reason: z.string().min(1).max(64),
      plies: z.number().int().min(0).max(4096),
      transcript: b64u32Schema,
      sig: b64u64Schema
    })
    .strict(),
  // graceful goodbye before leaving the room.
  z.object({ t: z.literal('bye') }).strict(),
  z.object({ t: z.literal('error'), message: z.string() }).strict(),
  // wire-level heartbeat: liveness rides on these, sent every few seconds once
  // handshaked. `t` echoes the sender's monotonic clock (ms) so a pong lets the
  // sender measure RTT for lag compensation (D11). Field is a plain number.
  z.object({ t: z.literal('ping'), ts: z.number() }).strict(),
  z.object({ t: z.literal('pong'), ts: z.number() }).strict()
])
export type WireMsg = z.infer<typeof wireMsgSchema>

/** Decode one raw data-channel payload (a string) into a WireMsg, or null if
 *  malformed. String input only. The transport hands us text. */
export function parseWireMsg(text: string): WireMsg | null {
  if (typeof text !== 'string') return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = wireMsgSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Encode a WireMsg for the wire. */
export function encodeWireMsg(msg: WireMsg): string {
  return JSON.stringify(msg)
}

// ---- Room-code codec -----------------------------------------------------------
// The join code is a random ROOM KEY, not an address: 10 Crockford-base32 chars
// (50 bits of entropy → collision-safe) rendered in two groups, e.g. "A1B2C-D3E4F".
// Crockford's alphabet drops I, L, O, U so codes survive being read aloud;
// normalize forgives case, hyphens/spaces, and the classic O/0, I/L/1 confusions.

const B32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ROOM_CODE_CHARS = 10 // 50 bits / 5 bits-per-char

/** A fresh random room code like "A1B2C-D3E4F". 50 bits from a CSPRNG. */
export function generateRoomCode(): string {
  // Rejection-sample bytes into the 32-symbol alphabet with no modulo bias:
  // any byte >= 256 - (256 % 32) == 256 (never) would bias, so 0..255 → &31 is
  // uniform here (256 is a multiple of 32). One byte per char, one char per 5 bits.
  const bytes = new Uint8Array(ROOM_CODE_CHARS)
  crypto.getRandomValues(bytes)
  let chars = ''
  for (let i = 0; i < ROOM_CODE_CHARS; i++) {
    chars += B32_ALPHABET[bytes[i] & 31]
  }
  return `${chars.slice(0, 5)}-${chars.slice(5)}`
}

/** Canonicalize a user-entered code. Forgiving about case/separators/look-alike
 *  chars; returns 'XXXXX-XXXXX' or null (never throws) when it's not exactly 10
 *  valid base32 chars. */
export function normalizeRoomCode(code: string): string | null {
  const cleaned = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (cleaned.length !== ROOM_CODE_CHARS) return null
  for (const ch of cleaned) {
    if (B32_ALPHABET.indexOf(ch) < 0) return null
  }
  return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`
}
