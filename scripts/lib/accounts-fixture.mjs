// Shared fixture for the web-accounts determinism suites
// (scripts/test-web-accounts.mjs: the node oracle, and
// scripts/test-web-accounts-browser.mjs: the real-browser gate, spec §14 A1
// "browser worst-case exercised in CI for at least chain verification").
//
// ONE fixture source, bundled per-platform, so node and browser run the
// byte-identical flow: derive the KAT identity (argon2id + SLIP-0010),
// replicate the chain suite's golden fixture chain from fixed raw seeds,
// build a second chain from the DERIVED identity keys, verify both, and emit
// every digest as a string. The suites assert field-by-field equality across
// platforms AND against the recorded goldens below.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Goldens
// ---------------------------------------------------------------------------

export const GOLDENS = {
  // frozen-at-genesis parameter digest (params.ts, asserted by both stage-1
  // suites). Changed once pre-ship when PARAMS_V1 gained the pwNorm row.
  // Nothing had shipped, so v1 grew the row instead of minting v2.
  paramsDigest: 'ZDoblqaVf5z1zL8IvmWK2sdZK29JTNWZpY38XuDBZdk',
  // argon2id KAT from scripts/test-accounts-core.mjs:
  //   deriveSeed('TestUser', 'correct horse battery staple')
  // UNCHANGED by pwNorm: NFKD of a pure-ASCII password is the identity.
  seedHex: 'fa3616fce3505728af8fa08f8e38286d85a34b773e8075332844c9f20d11cd4a',
  tag: '7U2MY',
  // happy-path chain goldens from scripts/test-accounts-chain.mjs (the fixture
  // below replicates buildBase() bit-for-bit from the same raw seeds/ts)
  chainVerifyDigest: '9X73ZssMl6BygmtesggEAp91sSDKfWM1ngaMG4-fCWM',
  chainFileSha256: 'ZJm5bqJwj7RrgksYMvwxH20nzLvUATaFPmOwr6koQSc',
  // identity-derived chain (argon2 seed → device children → chain), recorded
  // from a green run of this suite. Freezes derivation→chain end to end
  identityChainVerifyDigest: 'iNi_HEWRboKox2BbKvDh4ToNf09PFWrq4XzdD35cB_s',
  identityChainFileSha256: 'E8V34SGrs_459L3osc6DQvqkNtT2ryE4z1nsi_k7POU',
  // unicode display-name end to end: name 'Zoë' (also derived from NFD input),
  // password 'pâsswörd' (NFC and NFD spellings both) → one account, one chain
  unicodeSeedHex: '9757e060b372fe9359e6748db32c311427b4eee5c782278b1bba402d18f9ee8b',
  unicodeTag: 'B6DXR',
  unicodeChainVerifyDigest: '4F2tiaKCfqncx9nsaQRYryB3dZ5w2qeXwveH1rA8ni0',
  unicodeChainFileSha256: 'rIWyvV5p5oaXywHJAYQzw1_4nqWOAuZMnZ4FXHw_I-8',
  // A3/A4 parity goldens (recorded from a green node run 2026-07-21):
  // detmath float64 bit-grid, RS 12/40 encode+reconstruct, overlay k-bucket
  // routing math, PARAMS_A4, and the a4-v1 fold state over a rated fixture
  // chain. Any cross-engine drift in fold math breaks these on every platform
  // at once.
  detmathDigest: 'Kg04Z3nIWG8Z8KdGjr4T28hE2hOKXH_TvipB_UT3VsY',
  rsDigest: 'l2fPSGaIE8syY2qBD52eVQx7pESkEE7k5iBFJiL-V9Q',
  routingDigest: 'hgWvggwlRxuOVpWVT1yQxPJjXHSHnPsMsWxA_OikT0M',
  a4ParamsDigest: 'y99AjAdObDkadHPTKacPt2KUOmUciH6S7vgPbLVnFzM',
  // Re-recorded for fix-brick F1 (A4-01/02/08): the rated fixture's witness
  // now signs the FULL binding (kind/tc/players/reason), which changes the
  // segment event bytes and therefore the folded state hash. Re-recorded
  // again for F2 (A4-13/14): RepState gained the commendTw counter + the
  // pend pending-rematch map, and pair entries carry the PAIR_BOUND flag,
  // same fixture chain, new embedded rep-state bytes. Re-recorded for A5 J5
  // (A4-12): RepState gained the `unsettled` counter + the `ob` open-pairing-
  // obligation map: same fixture chain, new embedded rep-state bytes.
  // Re-recorded for the A4-14 eligibility split: RepState gained the `com`
  // commend-decay map. Same fixture chain, new embedded rep-state bytes.
  a4StateHash: '3nEnAH0Zy8owAdxpEWsH-0Pr8AYG2Vpa0yy7bDtHiz8',
}

// ---------------------------------------------------------------------------
// The fixture entry (TypeScript, bundled with alias @shared → src/shared)
// ---------------------------------------------------------------------------

export const FIXTURE_ENTRY_TS = `
import * as A from '@shared/accounts'
import * as RT from '@shared/accounts/ratings'
import * as RS from '@shared/accounts/storage/rs'
import * as KB from '@shared/accounts/overlay/kbucket'
import * as SEG from '@shared/accounts/segment'

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

const digestOf = (s: string): string => A.toB64u(A.sha256(A.utf8(s)))

/** float64 bit pattern as hex, byte-parity, not toString rounding. */
const f64hex = (x: number): string => {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, x)
  return hex(new Uint8Array(buf))
}

/** A4 detmath parity: dexp/dln bit patterns over dyadic-step grids (exact
 * input doubles) + special values. One digest, frozen as a golden. */
function detmathDigest(): string {
  const parts: string[] = []
  for (let i = 0; i < 256; i++) {
    parts.push(f64hex(RT.dexp((i - 128) * 0.3125)))       // [-40, 39.6875]
    parts.push(f64hex(RT.dln((i + 1) * 0.6875)))          // (0.6875, 176]
  }
  for (const x of [709.75, -745.25, 1e-12, 1e12]) parts.push(f64hex(RT.dexp(x)), f64hex(RT.dln(Math.abs(x))))
  return digestOf(parts.join(','))
}

/** A3 RS parity: deterministic LCG blob → encode 12/40 → keep a fixed
 * 12-row subset → reconstruct byte-identical. */
function rsFixture(): { rsDigest: string; rsRoundtripOk: boolean } {
  const data = new Uint8Array(4096)
  let s = 12345
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    data[i] = s & 0xff
  }
  const shards = RS.encode(data, 12, 40)
  const keepRows = [1, 4, 7, 9, 13, 17, 21, 25, 29, 33, 36, 39]
  const rec = RS.reconstruct(shards.filter((sh) => keepRows.includes(sh.idx)))
  const rsRoundtripOk = rec.length === data.length && rec.every((b, i) => b === data[i])
  return { rsDigest: digestOf(hex(rec.subarray(0, 64)) + '|' + shards.map((sh) => sh.body).join(',')), rsRoundtripOk }
}

/** A3 overlay routing parity: fixed contact set → bucket indexes + closest-K
 * ordering (the overlay's deterministic routing math). */
function routingDigest(): string {
  const self = digestOf('overlay-self')
  const table = KB.newRoutingTable(self)
  const parts: string[] = []
  for (let i = 0; i < 64; i++) {
    const nodeId = digestOf('n' + i)
    const kb = KB.bucketIndexOf(self, nodeId)
    const outcome = KB.insertContact(table, { nodeId, root: nodeId, key: nodeId, lastSeenMs: 1000 + i }, kb)
    parts.push(nodeId + ':' + kb + ':' + String(outcome))
  }
  const closest = KB.closestContacts(table, digestOf('overlay-target'), 16)
  return digestOf(parts.join(',') + '|' + closest.map((c) => c.nodeId).join(','))
}

/** A4 fold parity: a chain with two rated (ladder-bound) segments + a conduct
 * event, checkpointed under the a4-v1 fold, verified end to end. */
function buildA4Fixture(): { a4VerifyOk: boolean; a4CkptDeepOk: boolean; a4StateHash: string } {
  const seed = (b: number) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b: number) => {
    const priv = seed(b)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  const root = kp(7)
  const opp = kp(200)
  const wit = kp(160)
  const rootB = root.pubB
  const T = 1700000100000
  const tc = { baseMs: 180000, incMs: 2000 } // Blitz under PARAMS_A4 integer thresholds
  let c = A.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Rated', ts: T })
  const mkSeg = (n: number, res: '1-0' | '0-1') => {
    const g = SEG.gameKey({ v: 1, t: 'game-key', w: rootB, b: opp.pubB, nonce: digestOf('nonce' + n), ts: T + n })
    const tr = SEG.transcriptDigest(g, [], res, 'resign')
    // A4 review (A4-01/A4-08): rated segments require the FULL witness
    // binding: kind/tc + players-by-color + reason (atomic; partial bindings
    // are 'bad-ladder-binding' under verifySegmentEvent).
    const ws = SEG.signWitnessEnd(wit.priv, wit.pubB, g, res, 0, tr, {
      kind: 'chess', tc, players: { w: rootB, b: opp.pubB }, reason: 'resign',
    })
    return SEG.makeSegmentPayload({
      game: g, opp: opp.pubB, color: 'w', result: res, reason: 'resign', moves: [],
      heads: { w: { head: g, height: n }, b: { head: g, height: n } },
      wstream: ws, oppProfile: { name: 'Opp' }, kind: 'chess', tc,
    }) as unknown as Record<string, unknown>
  }
  c = A.appendWitnessed(c, root.priv, rootB, 'segment', mkSeg(1, '1-0') as any, T + 1000)
  c = A.appendWitnessed(c, root.priv, rootB, 'segment', mkSeg(2, '0-1') as any, T + 2000)
  c = A.appendWitnessed(c, root.priv, rootB, 'conduct', { kind: 'abort', game: digestOf('g3'), opp: opp.pubB } as any, T + 3000)
  const ck = A.makeCheckpointEvent(c, root.priv, rootB, T + 4000, RT.a4Fold as any)
  c = A.appendEvent(c, ck)
  return {
    a4VerifyOk: A.verifyChain(c).ok,
    a4CkptDeepOk: A.verifyCheckpointDeep(c, ck),
    a4StateHash: A.toB64u(A.canonicalHash((ck.body.payload as any).state)),
  }
}

/** Replicates scripts/test-accounts-chain.mjs buildBase() exactly. */
function buildGoldenChain() {
  const seed = (b: number) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b: number) => {
    const priv = seed(b)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  const root = kp(1)
  const devA = kp(50)
  const devB = kp(90)
  const rootB = root.pubB
  let c = A.createAccountChain({
    rootPriv: root.priv,
    rootPub: root.pub,
    displayName: 'Isaac',
    ts: 1000,
    device: { pub: devA.pubB, index: 0, label: 'MacBook' },
  })
  c = A.appendEvent(
    c,
    A.makeCertEvent(root.priv, rootB, c, { childPub: devB.pubB, purpose: 0, index: 1, label: 'Work PC', ts: 1100 }),
  )
  c = A.appendPersonal(c, root.priv, rootB, 'profile', { fields: { bio: 'hi there', country: 'US' } }, 1200)
  c = A.appendPersonal(c, devA.priv, devA.pubB, 'profile', { fields: { flair: 'knight' } }, 1300)
  c = A.appendEvent(c, A.makeRevokeEvent(root.priv, rootB, c, { pub: devB.pubB, ts: 1400 }))
  c = A.appendPersonal(c, devB.priv, devB.pubB, 'profile', { fields: { bio: 'EVIL' } }, 1500)
  c = A.appendEvent(c, A.makeCheckpointEvent(c, root.priv, rootB, 1600))
  return c
}

/** A second chain built from the DERIVED identity's real keys, fixed ts. */
function buildIdentityChain(identity: A.Identity) {
  const T = 1700000000000
  const rootB = A.toB64u(identity.rootPub)
  const d0 = A.deriveChild(identity.seed, A.KEY_PURPOSE.device, 0)
  const d1 = A.deriveChild(identity.seed, A.KEY_PURPOSE.device, 1)
  let c = A.createAccountChain({
    rootPriv: identity.rootPriv,
    rootPub: identity.rootPub,
    displayName: identity.displayName,
    ts: T,
    device: { pub: A.toB64u(d0.pub), index: 0, label: 'CI fixture' },
  })
  c = A.appendEvent(
    c,
    A.makeCertEvent(identity.rootPriv, rootB, c, { childPub: A.toB64u(d1.pub), purpose: A.KEY_PURPOSE.device, index: 1, ts: T + 1000 }),
  )
  c = A.appendPersonal(c, d0.priv, A.toB64u(d0.pub), 'profile', { fields: { bio: 'bit-determinism or bust', country: 'NZ' } }, T + 2000)
  c = A.appendEvent(c, A.makeCheckpointEvent(c, identity.rootPriv, rootB, T + 3000))
  return c
}

export interface FixtureResult {
  paramsDigest: string
  seedHex: string
  tag: string
  rootPubHex: string
  chainBytesB64u: string
  chainFileSha256: string
  verifyDigest: string
  verifyOk: boolean
  identityChainBytesB64u: string
  identityChainFileSha256: string
  identityVerifyDigest: string
  identityVerifyOk: boolean
  unicodeFoldedName: string
  unicodeSeedHex: string
  unicodeNfdSeedHex: string
  unicodeTag: string
  unicodeChainFileSha256: string
  unicodeVerifyDigest: string
  unicodeVerifyOk: boolean
  // A3/A4 parity (detmath grid bits, RS reconstruct, overlay routing math,
  // a4-v1 fold state over a rated chain)
  detmathDigest: string
  rsDigest: string
  rsRoundtripOk: boolean
  routingDigest: string
  a4ParamsDigest: string
  a4VerifyOk: boolean
  a4CkptDeepOk: boolean
  a4StateHash: string
}

export async function runFixture(): Promise<FixtureResult> {
  const identity = await A.deriveIdentity('TestUser', 'correct horse battery staple')

  const golden = buildGoldenChain()
  const goldenBytes = A.chainToBytes(golden)
  const goldenVerify = A.verifyChain(golden)

  const idChain = buildIdentityChain(identity)
  const idBytes = A.chainToBytes(idChain)
  const idVerify = A.verifyChain(idChain)

  // Unicode display-name end to end (pwNorm nfkd-v1 + name nfkc fold): the
  // NFC and NFD spellings of BOTH the name and the password must land on one
  // account and one canonical chain.
  const uni = await A.deriveIdentity('Zo\\u00eb', 'p\\u00e2ssw\\u00f6rd') // NFC name + NFC pw
  const uniNfd = await A.deriveIdentity('Zoe\\u0308', 'pa\\u0302sswo\\u0308rd') // NFD name + NFD pw
  const uniChain = buildIdentityChain(uni)
  const uniBytes = A.chainToBytes(uniChain)
  const uniVerify = A.verifyChain(uniChain)

  return {
    paramsDigest: A.PARAMS_V1_DIGEST,
    seedHex: hex(identity.seed),
    tag: identity.tag,
    rootPubHex: hex(identity.rootPub),
    chainBytesB64u: A.toB64u(goldenBytes),
    chainFileSha256: A.toB64u(A.sha256(goldenBytes)),
    verifyDigest: goldenVerify.digest,
    verifyOk: goldenVerify.ok,
    identityChainBytesB64u: A.toB64u(idBytes),
    identityChainFileSha256: A.toB64u(A.sha256(idBytes)),
    identityVerifyDigest: idVerify.digest,
    identityVerifyOk: idVerify.ok,
    unicodeFoldedName: uni.foldedName,
    unicodeSeedHex: hex(uni.seed),
    unicodeNfdSeedHex: hex(uniNfd.seed),
    unicodeTag: uni.tag,
    unicodeChainFileSha256: A.toB64u(A.sha256(uniBytes)),
    unicodeVerifyDigest: uniVerify.digest,
    unicodeVerifyOk: uniVerify.ok,
    detmathDigest: detmathDigest(),
    ...rsFixture(),
    routingDigest: routingDigest(),
    a4ParamsDigest: RT.PARAMS_A4_DIGEST,
    ...buildA4Fixture(),
  }
}
`

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

/**
 * Bundle the fixture entry for 'node' or 'browser'. format esm both; NOTHING
 * is stubbed or externalized for the browser build. The shared accounts tree
 * must carry zero node built-ins, and esbuild failing to resolve one IS the
 * packaging assertion.
 */
export async function bundleFixture(entryPath, outfile, platform) {
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    format: 'esm',
    platform,
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
}

/** Node-builtin leak scan over bundled JS text (browser bundle must be clean). */
export function findNodeBuiltinRefs(bundleText) {
  const hits = []
  const patterns = [
    /require\(\s*["'](?:node:)?(fs|path|os|crypto|url|util|stream|buffer|child_process|worker_threads|events|http|https|net|tls|zlib)["']\s*\)/g,
    /from\s*["']node:[^"']+["']/g,
    /import\s*\(\s*["']node:[^"']+["']\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(bundleText)) !== null) hits.push(m[0])
  }
  return hits
}

/** The browser fixture page: runs the flow, parks the result on window. */
export const FIXTURE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>accounts fixture</title></head>
<body>
<script type="module">
  import { runFixture } from './fixture.browser.mjs'
  runFixture().then(
    (r) => { window.__result = JSON.stringify(r) },
    (e) => { window.__error = String((e && e.stack) || e) },
  )
</script>
</body>
</html>
`

export function readBundle(path) {
  return readFileSync(path, 'utf8')
}

// ---------------------------------------------------------------------------
// A5 J6. Judge verdict-bit parity fixture (spec §14-A5: "verdicts
// bit-identical across desktop/browser/mobile"). SEPARATE entry from
// FIXTURE_ENTRY_TS so the stage-2 node suite's field count is untouched;
// consumed by scripts/test-web-accounts-browser.mjs only.
// ---------------------------------------------------------------------------

/** Goldens for the judge parity fixture (recorded from a green node run
 * 2026-07-21, after the J6 measured-anchors landing in judge/anchors.ts;
 * paramsDigest + the two digest goldens re-frozen same day after J7's
 * lifetimeScheme row drifted PARAMS_A5_DIGEST: the config echo folds the
 * digest into every JudgeOutput/Tier1Record, so these track it by design).
 * anchorsJudgeDigest re-recorded 2026-07-25: the anchor bundle's `fit`
 * provenance strings were repunctuated, which moves the canonical hash.
 * Every integer in the bundle is unchanged. */
export const JUDGE_GOLDENS = {
  paramsDigest: 'a4eNbkiD7g7LEMr_cSYXFanlYWkEjt67Y6vFOX5VIB8',
  syntheticOutputDigest: 'CXca7BM7agj9x28iaA9krmXIfWuBDgA9NPXGQr28m3A',
  tier1RecordDigest: 'Asbla6XbjafLCwGgZgIx8hS4e5MW_E_tmQYhqOqEyko',
  anchorsJudgeDigest: 'GUh_AkPvDyTirVDPPP6G9FGabDaCnPi5ucfHzsF7Ojc',
  windowVerdictJson:
    '{"zMicro":-60306,"games":31,"scoredGames":30,"convicted":false,"escalate":false}',
}

/**
 * The three J1 golden positions the browser ENGINE parity gate re-judges at
 * the TRUE Tier-1 config (subset of test-judge-node's JUDGE_POSITIONS;
 * moves-path opening, FEN middlegame, mate-in-1; kept to 3 for browser
 * wall-time). The node-side digest is computed LIVE in the same suite run.
 * J1's frozen 9-position golden stays untouched.
 */
export const JUDGE_PARITY_POSITIONS = [
  {
    ply: 4,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: ['e2e4', 'c7c5', 'g1f3', 'd7d6'],
  },
  { ply: 20, fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' },
  { ply: 60, fen: '1k6/ppp5/8/8/8/8/8/K3R3 w - - 0 1' },
]

/** Judge-core parity entry: tier1Record + windowVerdict + anchor digests over
 * FIXED synthetic inputs (no engine: cheap enough for every browser run). */
export const JUDGE_FIXTURE_ENTRY_TS = `
import * as J from '@shared/accounts/judge'
import { canonicalHash } from '@shared/accounts/codec'
import { toB64u } from '@shared/accounts/hash'

const b64 = (v: unknown): string => toB64u(canonicalHash(v as never))

/** Fixed synthetic JudgeOutput: 10 judged plies, cp + mate lines, K<multiPv
 * tail. The full canonical surface without an engine. */
function synthOutput(): J.JudgeOutput {
  const positions = [] as { ply: number; lines: { move: string; cp?: number; mate?: number }[] }[]
  for (let i = 0; i < 10; i++) {
    const lines: { move: string; cp?: number; mate?: number }[] = [
      { move: 'e2e4', cp: 40 - i },
      { move: 'd2d4', cp: 25 - i },
      { move: 'g1f3', cp: 8 - 3 * i },
    ]
    if (i === 7) lines[0] = { move: 'e2e4', mate: 2 }
    if (i !== 9) lines.push({ move: 'b1c3', cp: -5 - 2 * i })
    positions.push({ ply: i, lines })
  }
  return {
    v: 1,
    config: { nodes: J.PARAMS_A5.t1Nodes, multiPv: J.PARAMS_A5.t1MultiPv, hashMb: J.PARAMS_A5.hashMb, params: J.PARAMS_A5_DIGEST },
    positions,
  }
}

const MOVES = Array.from({ length: 10 }, (_, i) => ({
  ply: i,
  move: i % 3 === 0 ? 'e2e4' : i % 3 === 1 ? 'a7a6' : 'h2h4',
  clockMs: { w: 180_000 - 7_000 * i, b: 180_000 - 5_500 * i },
}))

/** Fixed synthetic K-window (30 scored + 1 unscored) over the MEASURED judge
 * anchors: the exact windowVerdict surface the Tier-2 ban trigger runs. */
function synthWindow(): { verdict: J.WindowVerdict } {
  const side = (scored: number, acplMicro: number, matchMicro: number): J.Tier1Side => ({
    scored, unscored: 1, acplMicro, matched: 0, matchMicro, clockFitMicro: 500_000, clockN: scored,
  })
  const mk = (game: string, acplMicro: number, matchMicro: number, scored = 30): J.Tier1Record => ({
    v: 1, game, ladder: 'calib', judge: b64({ j: game }), params: J.PARAMS_A5_DIGEST,
    w: side(scored, acplMicro, matchMicro), b: side(scored, 55_000_000, 700_000),
  })
  const entries: J.WindowEntry[] = []
  for (let i = 0; i < 30; i++) {
    entries.push({ rec: mk('pg-' + i, 30_000_000 + 900_000 * i, 860_000 - 4_000 * i), side: 'w', elo: 1500 })
  }
  entries.push({ rec: mk('pg-un', 0, 0, 0), side: 'w', elo: 1500 })
  return { verdict: J.windowVerdict(entries, J.TIER2_ANCHORS_JUDGE) }
}

export interface JudgeFixtureResult {
  judgeParamsDigest: string
  syntheticOutputDigest: string
  tier1RecordDigest: string
  anchorsJudgeDigest: string
  expectedAcpl1500: number
  expectedMatch1500: number
  windowVerdictJson: string
}

export function runJudgeFixture(): JudgeFixtureResult {
  const out = synthOutput()
  const rec = J.tier1Record('parity-game', 'calib', out, MOVES, 'w')
  return {
    judgeParamsDigest: J.PARAMS_A5_DIGEST,
    syntheticOutputDigest: J.judgeOutputDigest(out),
    tier1RecordDigest: J.tier1Digest(rec),
    anchorsJudgeDigest: J.tier2AnchorsDigest(J.TIER2_ANCHORS_JUDGE),
    expectedAcpl1500: J.expectedAcplMicro(J.TIER2_ANCHORS_JUDGE.acpl, 1500),
    expectedMatch1500: J.expectedMatchMicro(J.TIER2_ANCHORS_JUDGE, 1500),
    windowVerdictJson: JSON.stringify(synthWindow().verdict),
  }
}
`

/** The browser judge-parity page (no engine): parks the result on window. */
export const JUDGE_FIXTURE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>judge parity fixture</title></head>
<body>
<script type="module">
  import { runJudgeFixture } from './judge.browser.mjs'
  try { window.__judgeResult = JSON.stringify(runJudgeFixture()) }
  catch (e) { window.__judgeError = String((e && e.stack) || e) }
</script>
</body>
</html>
`

/** Web ENGINE entry: the REAL web judge adapter (src/web/engines/judge.ts;
 * hash-verified wasm fetch, dedicated worker, bypasses assets.ts selection)
 * driven through judgeGame() at the TRUE Tier-1 config. Browser-only. */
export const JUDGE_ENGINE_ENTRY_TS = `
import { newWebJudgeEngine } from '${ROOT.replace(/\\/g, '/')}/src/web/engines/judge.ts'
import { judgeGame, judgeConfigForTier, judgeOutputDigest, PARAMS_A5_DIGEST } from '@shared/accounts/judge'

const POSITIONS = ${JSON.stringify(JUDGE_PARITY_POSITIONS)}

export async function runJudgeEngine(): Promise<{ digest: string; params: string; positions: number }> {
  const engine = await newWebJudgeEngine()
  try {
    const out = await judgeGame(engine, POSITIONS as never, judgeConfigForTier(1))
    return { digest: judgeOutputDigest(out), params: out.config.params === PARAMS_A5_DIGEST ? 'ok' : out.config.params, positions: out.positions.length }
  } finally {
    await engine.close()
  }
}
`

/** The browser judge-ENGINE page: real wasm judge run at TRUE t1 config. */
export const JUDGE_ENGINE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>judge engine parity</title></head>
<body>
<script type="module">
  import { runJudgeEngine } from './judge-engine.browser.mjs'
  runJudgeEngine().then(
    (r) => { window.__engineResult = JSON.stringify(r) },
    (e) => { window.__engineError = String((e && e.stack) || e) },
  )
</script>
</body>
</html>
`
