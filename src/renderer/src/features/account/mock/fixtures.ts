/**
 * Sample data for the accounts UI preview (A-UI). Deliberately static.
 *
 * A6 WIRING STATUS: identity, chain, profile, ladders, reputation, standing,
 * devices and recovery export are REAL (mock/store.ts over src/web/accounts.ts
 * + ../store/derive.ts). What is LEFT here is only what a live surface still
 * reads: own account, PIN status, mailbox, recent games and other profiles.
 * Every such surface mounts ./FixturePreviewBadge.tsx behind an explicit
 * DEV_FIXTURE gate, so it labels itself as sample data in the UI and
 * `grep DEV_FIXTURE` across features/account lists every fixture surface.
 *
 * Fixtures for a surface that no longer renders them are DELETED, not parked:
 * an unreferenced sample constant is one careless import away from putting
 * invented numbers on screen, which this app does not do.
 *
 * Shapes follow ./types (which mirror src/shared/accounts). Timestamps are
 * absolute unix ms near MOCK_NOW so relative-time copy stays stable in tests.
 */

/**
 * TRUE while the network-dependent surfaces render sample data (spec quality
 * gate: no dead buttons. Fixture surfaces degrade visibly, never pretend to
 * be live). The mechanism: each fixture-rendering component gates on this
 * flag and mounts ./FixturePreviewBadge.tsx, which states "Sample data:
 * awaiting network transport" in place. Grep for DEV_FIXTURE to find every
 * fixture surface; flips off with the overlay/witness transport work.
 * Typed `boolean` (not a literal) so the gates stay live conditionals.
 */
export const DEV_FIXTURE: boolean = true

import { displayState } from '@shared/accounts/ratings/display'
import type {
  LadderKey,
  UiGameRow,
  UiLadder,
  UiMailItem,
  UiOwnAccount,
  UiPinStatus,
  UiProfile,
  UiReputation
} from './types'

/** "Now" for the preview: 2026-07-15T00:00Z. All fixture times are relative. */
export const MOCK_NOW = 1784073600000

const DAY = 86_400_000
const HOUR = 3_600_000

/** Fabricate a 43-char base64url-looking string (32-byte value) from a seed. */
export function fakeB64u(seed: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let h = 2166136261
  let out = ''
  for (let i = 0; i < 43; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i % seed.length) ^ i, 16777619)
    out += alphabet[(h >>> 8) & 63]
  }
  return out
}

/** Shorten a b64u for display: first 8 chars + ellipsis. */
export function shortB64u(v: string): string {
  return `${v.slice(0, 8)}…`
}

/**
 * Build a UiLadder whose §6 `display` object IS the output of the SHARED
 * displayState() over the ladder's protocol state (A4-28). Fixtures never
 * author a display state, so no fixture can contradict the PARAMS_A4 reveal
 * thresholds (revealThreshold: 120/100/80/40), placement/provisional/ranked
 * and the `of` counts all come from the authority. `rating`/`rd` are display
 * Elo, stored micro (×10⁶); hidden ladders still carry a protocol rating so
 * the §6 bracket projection (mm/pairing bracketOf) has a real input.
 */
function uiLadder(
  key: LadderKey,
  games: number,
  rating: number,
  rd: number,
  history?: number[]
): UiLadder {
  const state = { n: games, r: rating * 1_000_000, rd: rd * 1_000_000 }
  return {
    key,
    state,
    display: displayState(state, key),
    games,
    ...(history ? { history } : {})
  }
}

// ---------------------------------------------------------------------------
// Own account
// ---------------------------------------------------------------------------

const OWN_LADDERS: UiLadder[] = [
  // 62 games < revealBullet (120) ⇒ derived provisional 62/120.
  uiLadder('Bullet', 62, 1444, 118),
  // ≥ revealBlitz (100) ⇒ derived ranked.
  uiLadder('Blitz', 214, 1478, 62, [1391, 1402, 1398, 1424, 1440, 1431, 1455, 1449, 1462, 1478]),
  // ≥ revealRapid (80) ⇒ derived ranked.
  uiLadder('Rapid', 118, 1521, 88, [1440, 1462, 1477, 1470, 1494, 1502, 1489, 1510, 1516, 1521]),
  // < placementGames (10) ⇒ derived placement 4/10.
  uiLadder('Classical', 4, 1200, 322)
]

const OWN_REPUTATION: UiReputation = {
  score: 87,
  tier: 'Solid',
  components: [
    { label: 'Completed games', value: '396 of 398', positive: true },
    { label: 'Disconnect / abandon rate', value: '0.5%', positive: true },
    { label: 'Timeouts vs resignations', value: '3 · resigns lost positions', positive: true },
    { label: 'Rematches accepted', value: '61%', positive: true },
    { label: 'No-shows', value: '2 in 90 days', positive: false },
    { label: 'Commendations received', value: '148 (one per opponent per game)', positive: true }
  ],
  commendations: 148
}

export const OWN_ACCOUNT: UiOwnAccount = {
  handle: 'isaac#K7Q2M',
  displayName: 'isaac',
  foldedName: 'isaac',
  tag: 'K7Q2M',
  rootPub: fakeB64u('isaac-root'),
  createdWts: MOCK_NOW - 312 * DAY,
  ladders: OWN_LADDERS,
  reputation: OWN_REPUTATION,
  standing: { state: 'good' },
  profile: {
    bio: 'Blitz addict. London System apologist. Will accept any rematch.',
    country: 'US',
    flair: '♞',
    avatar: ''
  },
  chainHeight: 1408,
  chainEvents: 1734
}

// ---------------------------------------------------------------------------
// PIN (§1)
// ---------------------------------------------------------------------------

export const PIN_STATUS: UiPinStatus = {
  set: true,
  failures: 7,
  lifetimeCap: 100,
  refill: 20,
  committee: { t: 5, n: 8 },
  fuse: null
}

// ---------------------------------------------------------------------------
// Social (§3 friendships, §10 mailbox)
// ---------------------------------------------------------------------------

export const MAILBOX: UiMailItem[] = [
  {
    id: 'mail-1',
    from: 'oldguard#N2WQ4',
    kind: 'rematch-invite',
    ts: MOCK_NOW - 4 * HOUR,
    priority: 'entangled',
    note: 'Rapid, 10+5: best of three?'
  },
  {
    id: 'mail-2',
    from: 'sable#J6KT9',
    kind: 'friend-request',
    ts: MOCK_NOW - 9 * HOUR,
    priority: 'reputable',
    note: 'Great endgame yesterday.'
  },
  {
    id: 'mail-3',
    from: 'mira#T8FQ2',
    kind: 'commendation',
    ts: MOCK_NOW - 2 * DAY,
    priority: 'entangled'
  },
  {
    id: 'mail-4',
    from: 'zzgrind#X2VB8',
    kind: 'friend-request',
    ts: MOCK_NOW - 30 * HOUR,
    priority: 'new'
  }
]

// ---------------------------------------------------------------------------
// Game history rows
// ---------------------------------------------------------------------------

export const RECENT_GAMES: UiGameRow[] = [
  { id: 'g-1408', opponent: 'kestrel#V9DM3', ladder: 'Blitz', result: '1-0', userColor: 'w', ts: MOCK_NOW - 5 * HOUR, witnessed: true },
  { id: 'g-1407', opponent: 'newbie#F2PLC', ladder: 'Blitz', result: '1-0', userColor: 'b', ts: MOCK_NOW - 6 * HOUR, witnessed: true },
  { id: 'g-1405', opponent: 'oldguard#N2WQ4', ladder: 'Rapid', result: '0-1', userColor: 'w', ts: MOCK_NOW - DAY, witnessed: true },
  { id: 'g-1402', opponent: 'mira#T8FQ2', ladder: 'Blitz', result: '1/2-1/2', userColor: 'b', ts: MOCK_NOW - 3 * DAY + 2 * HOUR, witnessed: true },
  { id: 'g-1401', opponent: 'mira#T8FQ2', ladder: 'Blitz', result: '1-0', userColor: 'w', ts: MOCK_NOW - 3 * DAY, witnessed: true }
]

// ---------------------------------------------------------------------------
// Other profiles (People → find player). Keyed by handle.
// ---------------------------------------------------------------------------

const RANKED_REP: UiReputation = {
  score: 93,
  tier: 'Exemplary',
  components: [
    { label: 'Completed games', value: '1,204 of 1,209', positive: true },
    { label: 'Disconnect / abandon rate', value: '0.4%', positive: true },
    { label: 'Rematches accepted', value: '74%', positive: true },
    { label: 'Commendations received', value: '511', positive: true }
  ],
  commendations: 511
}

export const PROFILES: Record<string, UiProfile> = {
  'mira#T8FQ2': {
    handle: 'mira#T8FQ2',
    displayName: 'mira',
    tag: 'T8FQ2',
    rootPub: fakeB64u('mira-root'),
    bio: 'Endgames are the only honest part of chess.',
    country: 'NL',
    flair: '♜',
    createdWts: MOCK_NOW - 540 * DAY,
    lastWitnessedWts: MOCK_NOW - 2 * HOUR,
    ladders: [
      uiLadder('Bullet', 640, 1702, 55, [1650, 1671, 1668, 1685, 1679, 1694, 1702]),
      uiLadder('Blitz', 812, 1731, 48, [1690, 1702, 1711, 1705, 1719, 1724, 1731]),
      uiLadder('Rapid', 203, 1688, 71, [1640, 1655, 1661, 1674, 1680, 1688]),
      // 31 games < revealClassical (40) ⇒ derived provisional 31/40.
      uiLadder('Classical', 31, 1573, 150)
    ],
    reputation: RANKED_REP,
    standing: { state: 'good' },
    friendsCount: 37,
    games: RECENT_GAMES.filter((g) => g.opponent === 'mira#T8FQ2').map((g) => ({
      ...g,
      opponent: 'isaac#K7Q2M',
      result: g.result === '1-0' ? '0-1' : g.result === '0-1' ? '1-0' : g.result,
      userColor: g.userColor === 'w' ? 'b' : 'w'
    })),
    reconstruction: {
      ownerOnline: true,
      hops: 3,
      pointerCount: 812,
      pointersIgnored: 3,
      holdersOnline: 5,
      shardsHave: 40,
      shardsNeed: 12,
      shardsTotal: 40,
      spotChecked: false,
      path: 'expected',
      revocationContested: false
    },
    checkpoint: { height: 1640, cosigners: 5, of: 8, verified: 'incremental', mOfN: true }
  },

  // §5 acceptance scenario: 1,000 games, owner gone forever, opponents active.
  'vanished#Q3XR7': {
    handle: 'vanished#Q3XR7',
    displayName: 'vanished',
    tag: 'Q3XR7',
    rootPub: fakeB64u('vanished-root'),
    bio: 'brb',
    country: 'CA',
    flair: '♟',
    createdWts: MOCK_NOW - 1460 * DAY,
    lastWitnessedWts: MOCK_NOW - 1095 * DAY,
    ladders: [
      uiLadder('Bullet', 388, 1544, 350, [1502, 1516, 1531, 1522, 1544]),
      uiLadder('Blitz', 512, 1489, 350, [1450, 1461, 1473, 1480, 1489]),
      uiLadder('Rapid', 100, 1611, 350, [1560, 1577, 1590, 1602, 1611]),
      uiLadder('Classical', 0, 1200, 350)
    ],
    reputation: {
      score: 71,
      tier: 'Solid',
      components: [
        { label: 'Completed games', value: '994 of 1,000', positive: true },
        { label: 'Disconnect / abandon rate', value: '2.1%', positive: false },
        { label: 'Commendations received', value: '203', positive: true }
      ],
      commendations: 203
    },
    standing: { state: 'good' },
    friendsCount: 12,
    games: [
      { id: 'v-1000', opponent: 'oldguard#N2WQ4', ladder: 'Blitz', result: '0-1', userColor: 'w', ts: MOCK_NOW - 1095 * DAY, witnessed: true },
      { id: 'v-999', opponent: 'sable#J6KT9', ladder: 'Bullet', result: '1-0', userColor: 'b', ts: MOCK_NOW - 1095 * DAY - 2 * HOUR, witnessed: true },
      { id: 'v-998', opponent: 'mira#T8FQ2', ladder: 'Rapid', result: '1/2-1/2', userColor: 'w', ts: MOCK_NOW - 1096 * DAY, witnessed: true }
    ],
    reconstruction: {
      ownerOnline: false,
      hops: 4,
      pointerCount: 287,
      pointersIgnored: 11,
      holdersOnline: 3,
      shardsHave: 17,
      shardsNeed: 12,
      shardsTotal: 40,
      spotChecked: true,
      // ≥ K_rec shard rows recovered ⇒ full chain verified: expected path.
      path: 'expected',
      revocationContested: false
    },
    checkpoint: { height: 980, cosigners: 4, of: 8, verified: 'deep', mOfN: true }
  },

  // §8/§9: convicted account serving an anticheat self-ban.
  'hustler#B4NN2': {
    handle: 'hustler#B4NN2',
    displayName: 'hustler',
    tag: 'B4NN2',
    rootPub: fakeB64u('hustler-root'),
    bio: '',
    country: 'GB',
    flair: '♛',
    createdWts: MOCK_NOW - 60 * DAY,
    lastWitnessedWts: MOCK_NOW - 18 * DAY,
    ladders: [
      uiLadder('Bullet', 2, 1236, 331),
      uiLadder('Blitz', 131, 2104, 96, [1712, 1804, 1897, 1966, 2031, 2104]),
      uiLadder('Rapid', 0, 1200, 350),
      uiLadder('Classical', 0, 1200, 350)
    ],
    reputation: {
      score: 34,
      tier: 'Poor',
      components: [
        { label: 'Completed games', value: '127 of 133', positive: true },
        { label: 'Disconnect / abandon rate', value: '4.5%', positive: false },
        { label: 'Timeouts in lost positions', value: '19', positive: false },
        { label: 'Commendations received', value: '3', positive: false }
      ],
      commendations: 3
    },
    standing: {
      state: 'self-ban',
      expiresWts: MOCK_NOW + 72 * DAY,
      record: fakeB64u('hustler-selfban')
    },
    friendsCount: 1,
    games: [
      { id: 'h-131', opponent: 'sable#J6KT9', ladder: 'Blitz', result: '1-0', userColor: 'w', ts: MOCK_NOW - 18 * DAY, witnessed: true },
      { id: 'h-130', opponent: 'kestrel#V9DM3', ladder: 'Blitz', result: '1-0', userColor: 'b', ts: MOCK_NOW - 18 * DAY - 3 * HOUR, witnessed: true }
    ],
    reconstruction: {
      ownerOnline: false,
      hops: 3,
      pointerCount: 133,
      pointersIgnored: 0,
      holdersOnline: 4,
      shardsHave: 40,
      shardsNeed: 12,
      shardsTotal: 40,
      spotChecked: true,
      path: 'expected',
      revocationContested: false
    },
    checkpoint: { height: 128, cosigners: 4, of: 8, verified: 'deep', mOfN: true }
  },

  // §6/§7: fresh account still inside the containment chamber.
  'newbie#F2PLC': {
    handle: 'newbie#F2PLC',
    displayName: 'newbie',
    tag: 'F2PLC',
    rootPub: fakeB64u('newbie-root'),
    bio: 'Just learned the London. Sorry in advance.',
    country: 'DE',
    flair: '♙',
    createdWts: MOCK_NOW - 6 * DAY,
    lastWitnessedWts: MOCK_NOW - 3 * HOUR,
    ladders: [
      uiLadder('Bullet', 0, 1200, 350),
      // Hidden protocol rating 1493 keeps the RatedLobby demo spillover on the
      // SAME bracket rail as the signed-in Blitz 1478 (bracketOf: [800,1600),
      // pairingLegal rule 4; asserted in RatedLobby).
      uiLadder('Blitz', 23, 1493, 241),
      uiLadder('Rapid', 7, 1204, 305),
      uiLadder('Classical', 0, 1200, 350)
    ],
    reputation: {
      score: 78,
      tier: 'Solid',
      components: [
        { label: 'Completed games', value: '30 of 30', positive: true },
        { label: 'Commendations received', value: '9', positive: true }
      ],
      commendations: 9
    },
    standing: { state: 'good' },
    friendsCount: 2,
    games: [
      { id: 'n-30', opponent: 'isaac#K7Q2M', ladder: 'Blitz', result: '0-1', userColor: 'w', ts: MOCK_NOW - 6 * HOUR, witnessed: true }
    ],
    reconstruction: {
      ownerOnline: true,
      hops: 2,
      pointerCount: 30,
      pointersIgnored: 0,
      holdersOnline: 4,
      shardsHave: 40,
      shardsNeed: 12,
      shardsTotal: 40,
      spotChecked: false,
      path: 'expected',
      revocationContested: false
    },
    checkpoint: { height: 20, cosigners: 4, of: 8, verified: 'incremental', mOfN: true }
  },

  // §12 C-12 / §5 floor: fewer than K_rec shard rows, a device-signed
  // revocation honored on device-attested evidence only, and the surfaced
  // checkpoint below the cosigner threshold: the degraded view the spec
  // requires rendered "degraded, self-healing, never silent". Exercises all
  // three A4 degradation carriers (path/revocationContested/mOfN).
  'adrift#P9GH3': {
    handle: 'adrift#P9GH3',
    displayName: 'adrift',
    tag: 'P9GH3',
    rootPub: fakeB64u('adrift-root'),
    bio: 'lost my laptop, back someday',
    country: 'NO',
    flair: '♖',
    createdWts: MOCK_NOW - 800 * DAY,
    lastWitnessedWts: MOCK_NOW - 120 * DAY,
    ladders: [
      uiLadder('Bullet', 154, 1367, 350, [1329, 1341, 1355, 1348, 1367]),
      uiLadder('Blitz', 296, 1421, 350, [1388, 1397, 1410, 1406, 1421]),
      // 51 games < revealRapid (80) ⇒ derived provisional 51/80.
      uiLadder('Rapid', 51, 1466, 210),
      uiLadder('Classical', 0, 1200, 350)
    ],
    reputation: {
      score: 64,
      tier: 'Mixed',
      components: [
        { label: 'Completed games', value: '489 of 501', positive: true },
        { label: 'Disconnect / abandon rate', value: '2.4%', positive: false },
        { label: 'Commendations received', value: '58', positive: true }
      ],
      commendations: 58
    },
    standing: { state: 'good' },
    friendsCount: 5,
    games: [
      { id: 'a-501', opponent: 'oldguard#N2WQ4', ladder: 'Blitz', result: '0-1', userColor: 'b', ts: MOCK_NOW - 120 * DAY, witnessed: true },
      { id: 'a-500', opponent: 'mira#T8FQ2', ladder: 'Bullet', result: '1-0', userColor: 'w', ts: MOCK_NOW - 121 * DAY, witnessed: true }
    ],
    reconstruction: {
      ownerOnline: false,
      hops: 5,
      pointerCount: 96,
      pointersIgnored: 7,
      holdersOnline: 1,
      shardsHave: 9,
      shardsNeed: 12,
      shardsTotal: 40,
      spotChecked: false,
      // < K_rec shard rows ⇒ no verified chain: the C-12 floor path.
      path: 'floor',
      revocationContested: true
    },
    checkpoint: { height: 402, cosigners: 1, of: 8, verified: 'incremental', mOfN: false }
  }
}
