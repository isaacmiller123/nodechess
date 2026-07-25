// Headless test for the A4 ratings brick (src/shared/accounts/ratings/
// {ladders,glicko,fold,display}.ts + checkpoint.ts pluggable folds. Phase A4
// brick 2a, re-fixtured by fix-brick F2 for the A4 review: A4-01/02/09/11/19).
//
//   node scripts/test-accounts-ratings.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-chain.mjs) and drives the §6 rules on
// REAL CRYPTO END-TO-END: every rated fixture's witness signs the FULL F1
// RatedBinding {kind, tc, players, reason}, every embedded opponent
// checkpoint carries 4 real prefix-diverse cosigner attestations (passes
// verifyEmbeddedOppCkpt), game keys are unique per chain, and golden chains
// assert verifyChain(...).ok. Coverage: exact-integer time categories +
// ladder ids + reveal thresholds, golden glicko vectors, golden fold vectors
// (fixed chains → exact state bytes), the A4-02 pinned-input rule (the fold
// pins SEEDS for every opponent; roster-vouched reads live in
// ratingEvidenceOf, where the magnitude clamp now applies) + the section-10
// sybil-ratchet PIN, the A4-19 negatives (color-flip forgery, fabricated
// oppCkpt cosigners: excluded EVERYWHERE + chain-level 'bad-segment'),
// placement floor, skip rules, windowed dedup + the A4-11 chain-level
// 'dup-game' replay death, display-state boundaries, checkpoint integration
// (incl. the A4-10 a4-v1 auto-select), determinism, and rep/trust composition
// fidelity vs the standalone 1c/2b folds.
//
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).
// Keys are RAW fixed 32-byte seeds → ed25519 keypairs (no derive.ts).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = resolve(ROOT, 'src/shared/accounts').replace(/\\/g, '/')
const MAIN = resolve(ROOT, 'src/main').replace(/\\/g, '/')

// ---- tiny check kit ---------------------------------------------------------
let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}
/** Relative-error check (for the float cross-check only; never for state). */
function close(a, b, relTol, msg) {
  const rel = Math.abs(a - b) / Math.max(1, Math.abs(b))
  ok(rel <= relTol, `${msg}${rel <= relTol ? '' : ` (rel err ${rel})`}`)
}
function hasCode(vr, code, msg) {
  const got = vr.errors.map((e) => e.code)
  ok(!vr.ok && got.includes(code), `${msg}${got.includes(code) ? '' : ` (got ${JSON.stringify(got)})`}`)
}

// ---- golden vectors (recorded from a green run; determinism anchors) ---------
// Exact micro outputs of glickoUpdateMicro on the fixed inputs below. Any
// change to detmath, the glicko port, or the micro rounding breaks these on
// every platform at once. UNCHANGED by F2 (the math is untouched).
const GOLDEN_GLICKO = {
  seedWin: { ratingMicro: 1362310894, rdMicro: 290318964, volMicro: 60000 },
  drawUp: { ratingMicro: 1355229693, rdMicro: 285183664, volMicro: 60000 },
  lossDown: { ratingMicro: 1037689106, rdMicro: 290318964, volMicro: 60000 },
  noGames: { ratingMicro: 1200000000, rdMicro: 350000000, volMicro: 60000 },
  multi: { ratingMicro: 1545143006, rdMicro: 86385762, volMicro: 61305 },
}
// canonicalHash (b64u) of the a4-v1 fold state over the fixed golden chain.
// (Re-frozen by F2: fixtures sign the full F1 binding + real oppCkpt cosigs,
// and RepState gained commendTw/pend + the PAIR_BOUND/PAIR_EST flags.
// Re-frozen by A5 J5: RepState gained the `unsettled` counter + the `ob`
// open-pairing-obligation map: same fixture chains, new embedded rep bytes.
// Re-frozen by the A4-14 eligibility split: RepState gained the `com`
// commend-decay map (commendTw now folds the decayed floor tier only).
// Same fixture chains, new embedded rep bytes.
// Re-frozen by the A4-02 close: the fold pins the §6 SEEDS for every
// opponent: the golden chain's g3 segment embeds a 1600/80 oppCkpt whose
// numbers no longer reach the in-fold update (roster-vouched reads moved to
// ratingEvidenceOf): same fixture chains, new embedded ladder bytes.)
const GOLDEN_FOLD_HASH = 'rZRJa27vcHtTRylaoMXWrLJdRnz4YI8uQMrZhmVEx9o'
// canonicalHash (b64u) of the placement chain's fold state after 10 games.
// (NB: depends on the suite's deterministic shared ts sequence; adding a
// ts-consuming fixture BEFORE section 5 legitimately re-records this.)
const GOLDEN_PLACEMENT_HASH = 'LObyT9AIXAtkip36hI-IvMvkz9lRBuhwVGvdMMTwj2c'

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-ratings-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function bundle(outdir, name) {
  const entry = resolve(outdir, `${name}.ts`)
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as events from '${SRC}/events.ts'`,
      `export * as chain from '${SRC}/chain.ts'`,
      `export * as ckpt from '${SRC}/checkpoint.ts'`,
      `export * as seg from '${SRC}/segment.ts'`,
      `export * as watt from '${SRC}/witness/attest.ts'`,
      `export * as a4 from '${SRC}/ratings/params.ts'`,
      `export * as ladders from '${SRC}/ratings/ladders.ts'`,
      `export * as glicko from '${SRC}/ratings/glicko.ts'`,
      `export * as fold from '${SRC}/ratings/fold.ts'`,
      `export * as display from '${SRC}/ratings/display.ts'`,
      `export * as rep from '${SRC}/ratings/reputation.ts'`,
      `export * as trust from '${SRC}/mm/trust.ts'`,
      `export * as mm from '${SRC}/mm/pairing.ts'`,
      `export * as ratingsBarrel from '${SRC}/ratings/index.ts'`,
      `export * as refGlicko from '${MAIN}/rating/glicko2.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, `${name}.mjs`)
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  return import(pathToFileURL(outfile).href)
}

async function run(outdir) {
  console.log('· bundling src/shared/accounts (ratings + checkpoint + mm) …')
  const M = await bundle(outdir, 'entry')
  const { codec, hash, events, chain, ckpt, seg, watt, a4, ladders, glicko, fold, display, rep, trust, mm, refGlicko } = M
  const P = a4.PARAMS_A4

  // ---- fixed raw keypairs -----------------------------------------------------
  const seedBytes = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seedBytes(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const me = kp(1)
  const oppA = kp(40)
  const oppB = kp(80)
  const wit = kp(200) // the witness signing wstream terminals
  // 4 REAL oppCkpt cosigner keypairs with pairwise-distinct 2-char b64u key
  // prefixes (⇒ satisfies segment.ts's ≥3 prefix-diversity bound).
  const cosigners = []
  {
    const prefixes = new Set()
    for (let b = 210; cosigners.length < 4 && b < 255; b++) {
      const k = kp(b)
      const pre = k.pubB.slice(0, 2)
      if (prefixes.has(pre)) continue
      prefixes.add(pre)
      cosigners.push(k)
    }
  }
  const meB = me.pubB
  const fakeId = (s) => hash.toB64u(hash.sha256(hash.utf8(s)))
  const clone = (x) => structuredClone(x)
  const stateHash = (s) => hash.toB64u(codec.canonicalHash(s))
  const M6 = 1_000_000

  // ---- fixture helpers --------------------------------------------------------
  let ts = 10_000
  const mkChain = () =>
    chain.createAccountChain({ rootPriv: me.priv, rootPub: me.pub, displayName: 'Isaac', ts: 1000 })
  const BLITZ_TC = { baseMs: 300_000, incMs: 0 } // 5+0
  /** One REAL cosigner attestation over event id (attest.ts byte contract). */
  const mkAtt = (k, id, wts) => ({
    w: k.pubB,
    wts,
    epoch: 0,
    sig: hash.toB64u(hash.ed25519.sign(codec.canonicalBytes({ e: id, epoch: 0, w: k.pubB, wts }), k.priv)),
  })
  /**
   * Append one segment with a REAL witness terminal signature. kind/tc
   * optional (absent = legacy: the witness signs the EXACT legacy bytes).
   * When kind/tc present the witness signs the FULL F1 RatedBinding
   * {kind, tc, players, reason} with players derived from `color`. Overrides:
   *   bind:       sign exactly this binding instead (null ⇒ legacy bytes);
   *   bindColor: sign players for THIS color while the payload claims
   *               `color` (the A4-01/A4-19 color-flip forgery);
   *   wsig:       raw wstream sig override (forged-witness fixtures).
   */
  const addSeg = (c, game, opp, o = {}) => {
    const { color = 'w', result = '1-0', reason = 'checkmate', kind, tc, oppCkpt, oppProfile, bind, bindColor, wsig } = o
    const transcript = fakeId(`t:${game}`)
    const plies = 24
    const trueColor = bindColor ?? color
    const players = trueColor === 'w' ? { w: meB, b: opp } : { w: opp, b: meB }
    const binding =
      bind !== undefined ? bind
      : kind !== undefined || tc !== undefined ? { kind, tc, players, reason } : undefined
    const wstream =
      wsig !== undefined
        ? { wkey: wit.pubB, sig: wsig }
        : seg.signWitnessEnd(wit.priv, wit.pubB, game, result, plies, transcript, binding)
    const payload = {
      game, opp, color, result, reason, transcript, plies,
      heads: { w: { head: fakeId('hw'), height: 3 }, b: { head: fakeId('hb'), height: 5 } },
      wstream,
      ...(oppCkpt !== undefined ? { oppCkpt } : {}),
      oppProfile: oppProfile ?? { name: 'Opponent' },
      ...(kind !== undefined ? { kind } : {}),
      ...(tc !== undefined ? { tc } : {}),
    }
    return chain.appendWitnessed(c, me.priv, meB, 'segment', payload, ts++)
  }
  const witnessedSorted = (c) =>
    c.events.filter((e) => e.body.lane === 'w').sort((x, y) => x.body.height - y.body.height)
  const foldChain = (c) => witnessedSorted(c).reduce((s, e) => fold.a4Fold.step(s, e), fold.a4Fold.init(c.root))
  /** Properly signed opponent ckpt event embedding `state`, with 4 REAL
   * prefix-diverse cosigner attestations (passes verifyEmbeddedOppCkpt).
   * witArr: null ⇒ NO cosigners at all; an array ⇒ attach verbatim. */
  const mkOppCkpt = (opp, state, witArr) => {
    const body = {
      v: 1, lane: 'w', type: 'ckpt', root: opp.pubB, key: opp.pubB,
      height: 7, prev: fakeId('opp-prev'), ts: 5000,
      payload: { through: 6, state, stateDigest: stateHash(state) },
    }
    const ev = events.signBody(body, opp.priv)
    if (witArr === null) return ev
    const id = events.eventId(body)
    return { ...ev, wit: witArr !== undefined ? witArr : cosigners.map((k) => mkAtt(k, id, 900)) }
  }
  const a4OppState = (laddersMap) => ({
    f: 'a4-v1', params: a4.PARAMS_A4_DIGEST, n: 6, byType: { segment: 6 },
    head: fakeId('opp-head'), height: 6, ladders: laddersMap,
    rep: rep.repInit(), trust: trust.trustInputsInit(), bans: {},
  })
  const G = (s) => fakeId(`game-${s}`)
  /** WitnessEligibility predicate accepting exactly these keypairs' pubkeys
   * (the verifier's read-time roster: A4-02/03/05/14). */
  const roster = (...ks) => {
    const set = new Set(ks.map((k) => k.pubB))
    return (w) => set.has(w)
  }

  // ============================================================================
  // 1. ladders: timeCategory / ladderId / revealThreshold (exact integer math)
  // ============================================================================
  console.log('\n· timeCategory boundaries (exact integers) …')
  {
    eq(ladders.timeCategory({ baseMs: 0, incMs: 0 }), 'Unlimited', 'baseMs 0 → Unlimited')
    eq(ladders.timeCategory({ baseMs: 0, incMs: 10_000 }), 'Unlimited', 'baseMs 0 with increment → still Unlimited')
    eq(ladders.timeCategory({ baseMs: 1, incMs: 0 }), 'Bullet', 'baseMs 1 → Bullet (no <=0 sloppiness)')
    eq(ladders.timeCategory({ baseMs: 178_999, incMs: 0 }), 'Bullet', 'estMs 178_999 → Bullet (< 179_000)')
    eq(ladders.timeCategory({ baseMs: 179_000, incMs: 0 }), 'Blitz', 'estMs 179_000 → Blitz (boundary is exclusive)')
    eq(ladders.timeCategory({ baseMs: 479_999, incMs: 0 }), 'Blitz', 'estMs 479_999 → Blitz')
    eq(ladders.timeCategory({ baseMs: 480_000, incMs: 0 }), 'Rapid', 'estMs 480_000 → Rapid')
    eq(ladders.timeCategory({ baseMs: 1_499_999, incMs: 0 }), 'Rapid', 'estMs 1_499_999 → Rapid')
    eq(ladders.timeCategory({ baseMs: 1_500_000, incMs: 0 }), 'Classical', 'estMs 1_500_000 → Classical')
    eq(ladders.timeCategory({ baseMs: 170_000, incMs: 225 }), 'Blitz', 'increment weight 40: 170_000 + 40·225 = 179_000 → Blitz')
    eq(ladders.timeCategory({ baseMs: 170_000, incMs: 224 }), 'Bullet', '170_000 + 40·224 = 178_960 → Bullet')
    // renderer parity spot-checks (timeControl.ts float form, same values)
    eq(ladders.timeCategory({ baseMs: 60_000, incMs: 0 }), 'Bullet', '1+0 is Bullet (renderer parity)')
    eq(ladders.timeCategory({ baseMs: 180_000, incMs: 2_000 }), 'Blitz', '3+2 is Blitz (renderer parity)')
    eq(ladders.timeCategory({ baseMs: 900_000, incMs: 10_000 }), 'Rapid', '15+10 is Rapid (renderer parity)')
    eq(ladders.timeCategory({ baseMs: 1_800_000, incMs: 20_000 }), 'Classical', '30+20 is Classical (renderer parity)')
    eq(ladders.ladderId('chess', BLITZ_TC), 'chess:Blitz', "ladderId = '<kind>:<category>'")
    eq(ladders.ladderId('chess960', { baseMs: 60_000, incMs: 0 }), 'chess960:Bullet', 'ladderId carries the kind verbatim')
    eq(ladders.revealThreshold('Bullet'), 120, 'reveal Bullet = 120')
    eq(ladders.revealThreshold('Blitz'), 100, 'reveal Blitz = 100')
    eq(ladders.revealThreshold('Rapid'), 80, 'reveal Rapid = 80')
    eq(ladders.revealThreshold('Classical'), 40, 'reveal Classical = 40')
  }

  // ============================================================================
  // 2. glicko: golden micro vectors + float cross-check vs the shipped impl
  // ============================================================================
  console.log('\n· glicko micro conversions …')
  {
    eq(glicko.toMicro(0.06), 60_000, 'toMicro(0.06) = 60_000 (round-half-up)')
    eq(glicko.toMicro(1200), 1_200_000_000, 'toMicro(1200) is exact')
    eq(glicko.toMicro(349.9999994), 349_999_999, 'toMicro truncates below the half')
    eq(glicko.toMicro(349.9999996), 350_000_000, 'toMicro rounds up above the half')
    eq(glicko.fromMicro(1_200_000_000), 1200, 'fromMicro is the exact inverse on integers')
    eq(glicko.SCALE, 173.7178, 'SCALE matches the shipped glicko2.ts constant')
  }
  console.log('\n· glicko golden vectors (exact micro outputs) …')
  const seedMicro = { ratingMicro: P.seedRating * M6, rdMicro: P.seedRd * M6, volMicro: P.seedVolMicro }
  const gVectors = {
    seedWin: [seedMicro, [{ ratingMicro: 1_200_000_000, rdMicro: 350_000_000, score: 1 }]],
    drawUp: [seedMicro, [{ ratingMicro: 1_500_000_000, rdMicro: 80_000_000, score: 0.5 }]],
    lossDown: [seedMicro, [{ ratingMicro: 1_200_000_000, rdMicro: 350_000_000, score: 0 }]],
    noGames: [seedMicro, []],
    multi: [
      { ratingMicro: 1_420_000_000, rdMicro: 95_500_000, volMicro: 61_234 },
      [
        { ratingMicro: 1_650_000_000, rdMicro: 62_000_000, score: 1 },
        { ratingMicro: 1_500_000_000, rdMicro: 210_000_000, score: 1 },
        { ratingMicro: 1_780_000_000, rdMicro: 48_000_000, score: 1 },
        { ratingMicro: 1_390_000_000, rdMicro: 130_000_000, score: 0.5 },
        { ratingMicro: 1_700_000_000, rdMicro: 70_000_000, score: 1 },
      ],
    ],
  }
  for (const [name, [p, games]] of Object.entries(gVectors)) {
    const got = glicko.glickoUpdateMicro(p, games)
    const want = GOLDEN_GLICKO?.[name]
    if (!want) {
      console.log(`  · RECORD ${name}: { ratingMicro: ${got.ratingMicro}, rdMicro: ${got.rdMicro}, volMicro: ${got.volMicro} },`)
      ok(false, `golden ${name} not recorded yet`)
      continue
    }
    eq(got.ratingMicro, want.ratingMicro, `golden ${name}: exact ratingMicro`)
    eq(got.rdMicro, want.rdMicro, `golden ${name}: exact rdMicro`)
    eq(got.volMicro, want.volMicro, `golden ${name}: exact volMicro`)
    ok(Number.isSafeInteger(got.ratingMicro) && Number.isSafeInteger(got.rdMicro) && Number.isSafeInteger(got.volMicro),
      `golden ${name}: outputs are safe integers`)
  }
  console.log('\n· glicko float cross-check vs src/main/rating/glicko2.ts (1e-9 relative) …')
  {
    for (const [name, [p, games]] of Object.entries(gVectors)) {
      const pf = { rating: p.ratingMicro / M6, rd: p.rdMicro / M6, vol: p.volMicro / M6 }
      const gf = games.map((o) => ({ rating: o.ratingMicro / M6, rd: o.rdMicro / M6, score: o.score }))
      const det = glicko.glicko2UpdateDet(pf, gf, 0.5)
      const ref = refGlicko.glicko2Update(pf, gf, 0.5)
      close(det.rating, ref.rating, 1e-9, `${name}: det rating ≈ shipped float rating`)
      close(det.rd, ref.rd, 1e-9, `${name}: det rd ≈ shipped float rd`)
      close(det.vol, ref.vol, 1e-9, `${name}: det vol ≈ shipped float vol`)
      // and the micro boundary is EXACTLY toMicro of the det float outputs
      const micro = glicko.glickoUpdateMicro(p, games)
      eq(micro.ratingMicro, glicko.toMicro(det.rating), `${name}: micro rating = toMicro(det float)`)
      eq(micro.rdMicro, glicko.toMicro(det.rd), `${name}: micro rd = toMicro(det float)`)
      eq(micro.volMicro, glicko.toMicro(det.vol), `${name}: micro vol = toMicro(det float)`)
    }
    // RD clamps survive the port
    const grown = refGlicko.glicko2Update({ rating: 1200, rd: 349.999, vol: 0.2 }, [])
    eq(grown.rd, 350, 'shipped impl clamps no-games RD growth at RD_MAX (sanity)')
    const det = glicko.glickoUpdateMicro({ ratingMicro: 1_200_000_000, rdMicro: 349_999_000, volMicro: 200_000 }, [])
    eq(det.rdMicro, 350_000_000, 'det no-games branch clamps at RD_MAX·1e6')
  }

  // ============================================================================
  // 3. the a4-v1 fold: shape, counters, golden state bytes
  // ============================================================================
  console.log('\n· fold init + basic counters …')
  {
    const s0 = fold.a4Fold.init(meB)
    eq(fold.a4Fold.id, 'a4-v1', "fold id is 'a4-v1'")
    eq(s0.f, 'a4-v1', "state.f self-describes the fold")
    eq(s0.params, a4.PARAMS_A4_DIGEST, 'state.params = PARAMS_A4_DIGEST')
    eq(stateHash(s0.rep), stateHash(rep.repInit()), 'init embeds repInit() verbatim')
    eq(stateHash(s0.trust), stateHash(trust.trustInputsInit()), 'init embeds trustInputsInit() verbatim')
    eq(Object.keys(s0.bans).length, 0, 'bans is the reserved empty shape')
    eq(Object.keys(s0.ladders).length, 0, 'no ladders before any rated game')
  }
  console.log('\n· golden fold chain → exact state bytes …')
  let goldenChain
  {
    let c = mkChain()
    c = addSeg(c, G('g1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w' })
    c = addSeg(c, G('g2'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC, result: '0-1', color: 'w', reason: 'resign' })
    c = addSeg(c, G('g3'), oppB.pubB, {
      kind: 'chess', tc: BLITZ_TC, result: '1/2-1/2', color: 'b', reason: 'agreement',
      oppCkpt: mkOppCkpt(oppB, a4OppState({ 'chess:Blitz': { r: 1_600_000_000, rd: 80_000_000, vol: 60_000, n: 150, placed: 1 } })),
    })
    c = addSeg(c, G('g4'), oppB.pubB, { result: '1-0', color: 'w' }) // legacy: no kind/tc. Unrated
    c = addSeg(c, G('g5'), oppA.pubB, { kind: 'chess', tc: { baseMs: 60_000, incMs: 0 }, result: '1-0', color: 'b' }) // Bullet ladder
    c = chain.appendWitnessed(c, me.priv, meB, 'conduct', { kind: 'abort', game: G('a1'), opp: oppA.pubB }, ts++)
    goldenChain = c
    const s = foldChain(c)
    eq(s.n, 7, 'golden fold: 7 witnessed events (genesis + 5 segments + conduct)')
    eq(s.byType.segment, 5, 'golden fold: byType.segment = 5')
    eq(s.byType.conduct, 1, 'golden fold: byType.conduct = 1')
    eq(s.height, 6, 'golden fold: head height 6')
    eq(s.head, events.eventId(witnessedSorted(c)[6].body), 'golden fold: head id is the last witnessed event')
    eq(Object.keys(s.ladders).length, 2, 'golden fold: two ladders (Blitz + Bullet); legacy segment rated none')
    eq(s.ladders['chess:Blitz'].n, 3, 'golden fold: Blitz ladder folded 3 rated games')
    eq(s.ladders['chess:Bullet'].n, 1, 'golden fold: Bullet ladder folded 1 rated game')
    eq(s.rep.seg, 5, 'golden fold: rep counted all 5 VERIFIED segments (incl. the legacy one)')
    eq(s.rep.rsLoss, 1, 'golden fold: rep counted the witness-signed resign loss')
    eq(s.rep.abort, 1, 'golden fold: rep counted the abort')
    eq(s.trust.wn, 5, 'golden fold: trust counted all 5 segments')
    eq(chain.verifyChain(c).ok, true, 'golden chain verifies ok end-to-end (real crypto, F2)')
    const h = stateHash(s)
    if (GOLDEN_FOLD_HASH === null) {
      console.log(`  · RECORD GOLDEN_FOLD_HASH = '${h}'`)
      ok(false, 'golden fold hash not recorded yet')
    } else {
      eq(h, GOLDEN_FOLD_HASH, 'golden fold state hashes to the recorded vector')
    }
    // integers-only contract: every leaf is a safe integer or a string id
    const leavesOk = (v) =>
      typeof v === 'number'
        ? Number.isSafeInteger(v)
        : typeof v === 'string' || (typeof v === 'object' && v !== null && Object.values(v).every(leavesOk))
    ok(leavesOk(s), 'A4FoldState leaves are safe integers / strings only (canonical)')
    ok(codec.canonicalBytes(s).length > 0, 'state is canonical-encodable (no floats, no null)')
  }

  // ============================================================================
  // 4. pinned fold inputs (§6)
  // ============================================================================
  console.log('\n· A4-02: the fold pins SEEDS for every opponent; the vouched read is read-time …')
  {
    const oppLadder = { r: 1_600_000_000, rd: 80_000_000, vol: 60_000, n: 150, placed: 1 }
    const c = addSeg(mkChain(), G('p1'), oppB.pubB, {
      kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w',
      oppCkpt: mkOppCkpt(oppB, a4OppState({ 'chess:Blitz': oppLadder })),
    })
    const s = foldChain(c)
    const expectedSeed = glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: P.seedRating * M6, rdMicro: P.seedRd * M6, score: 1 }])
    eq(s.ladders['chess:Blitz'].r, expectedSeed.ratingMicro,
      'A4-02: the FOLD pins the §6 seeds. The embedded 1600 never reaches the in-fold update')
    eq(s.ladders['chess:Blitz'].rd, Math.max(expectedSeed.rdMicro, P.placementRdFloor * M6), 'stored rd = max(computed, placement floor)')
    eq(chain.verifyChain(c).ok, true, 'the cosigned-oppCkpt chain verifies ok end-to-end')
    // the FOLD is byte-identical to the same game against a no-ckpt opponent
    const cSeed = addSeg(mkChain(), G('p1'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w' })
    eq(stateHash(s.ladders), stateHash(foldChain(cSeed).ladders),
      'A4-02: the cosigned-1600 chain folds ladder-byte-identical to the no-oppCkpt baseline')
    // the READ-TIME vouched rating (A4-02 layer 2): a roster that recognizes
    // the serving witness AND the 4 cosigners grants the 1600/80 pin.
    const honest = roster(wit, ...cosigners)
    const expectedVouched = glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: oppLadder.r, rdMicro: oppLadder.rd, score: 1 }])
    const ev = fold.ratingEvidenceOf(c, honest)
    eq(ev.ladders['chess:Blitz'].r, expectedVouched.ratingMicro,
      'ratingEvidenceOf under a vouching roster reads the opponent 1600/80 (the read is live; at READ time)')
    eq(ev.ladders['chess:Blitz'].rd, Math.max(expectedVouched.rdMicro, P.placementRdFloor * M6),
      'vouched read applies the same placement-floor discipline')
    ok(ev.ladders['chess:Blitz'].r > s.ladders['chess:Blitz'].r,
      'beating a VOUCHED 1600 grants more than the fold floor (fidelity lives at read time)')
    // zero-drift invariant: no roster ⇒ the evidence IS the embedded floor
    eq(stateHash(fold.ratingEvidenceOf(c).ladders), stateHash(s.ladders),
      'ratingEvidenceOf with NO predicate is byte-identical to the fold ladders (zero drift)')
    // M is a floor on the RECOGNIZED subset: 3 of 4 vouched cosigners ⇒ seeds
    eq(stateHash(fold.ratingEvidenceOf(c, roster(wit, ...cosigners.slice(0, 3))).ladders), stateHash(s.ladders),
      'a roster vouching only M−1 cosigners earns the seeds (eligible subset must reach ckptM)')
    // an unrecognized serving witness voids the read (self-run witness ⇒ nothing)
    eq(stateHash(fold.ratingEvidenceOf(c, roster(...cosigners)).ladders), stateHash(s.ladders),
      'a roster not vouching the wstream witness earns the seeds (A4-05 rule applied to ratings)')
  }
  console.log('\n· pinned inputs: seeds for missing / ladderless / malformed oppCkpt. Fold AND vouched read …')
  {
    const expectedSeed = glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: P.seedRating * M6, rdMicro: P.seedRd * M6, score: 1 }])
    const rdWithFloor = Math.max(expectedSeed.rdMicro, P.placementRdFloor * M6)
    const honest = roster(wit, ...cosigners)
    const cases = {
      'no oppCkpt (young opponent)': undefined,
      'a4-v1 oppCkpt WITHOUT this ladder': mkOppCkpt(oppB, a4OppState({ 'chess:Bullet': { r: 2_000_000_000, rd: 40_000_000, vol: 60_000, n: 200, placed: 1 } })),
      'a4-v1 oppCkpt with string-typed r (malformed)': mkOppCkpt(oppB, a4OppState({ 'chess:Blitz': { r: '2000000000', rd: 40_000_000, vol: 60_000, n: 200, placed: 1 } })),
      'a4-v1 oppCkpt with negative rd (malformed)': mkOppCkpt(oppB, a4OppState({ 'chess:Blitz': { r: 2_000_000_000, rd: -1, vol: 60_000, n: 200, placed: 1 } })),
    }
    for (const [name, oppCkpt] of Object.entries(cases)) {
      const c = addSeg(mkChain(), G('p1'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w', oppCkpt })
      const l = foldChain(c).ladders['chess:Blitz']
      ok(l !== undefined && l.r === expectedSeed.ratingMicro && l.rd === rdWithFloor,
        `${name} → fold seeds 1200/350 exactly`)
      // the vouched reader fails closed to seeds on every non-readable shape,
      // even under a fully-vouching roster (the reader's own A4-02 rules)
      const lv = fold.ratingEvidenceOf(c, honest).ladders['chess:Blitz']
      ok(lv !== undefined && lv.r === expectedSeed.ratingMicro && lv.rd === rdWithFloor,
        `${name} → vouched read seeds 1200/350 exactly (reader fail-closed)`)
    }
  }
  console.log('\n· A4-10: fold-id rule. A rated segment may embed a4-v1 checkpoints ONLY …')
  {
    // THE REVIEW VECTOR, now dead: a rated player presenting a STALE
    // pre-rated basic-v1 oppCkpt used to read as a seed-rated (1200/350)
    // opponent in the rating fold AND a full established-opponent proxy in
    // the trust fold, the seed-washing dial. Now the segment itself fails
    // ('bad-opp-ckpt', fail-hard like every embed defect): a rating-young
    // opponent is represented honestly by OMITTING oppCkpt.
    const basicCk = mkOppCkpt(oppB, { n: 6, byType: { segment: 6 }, head: fakeId('h'), height: 6 })
    const cBasic = addSeg(mkChain(), G('fi1'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, oppCkpt: basicCk })
    eq(seg.verifySegmentEvent(witnessedSorted(cBasic)[1]), 'bad-opp-ckpt',
      'A4-10 PIN: basic-v1 (f-less) oppCkpt on a RATED segment → the segment fails (no silent seed-wash)')
    const sBasic = foldChain(cBasic)
    eq(Object.keys(sBasic.ladders).length + sBasic.rep.seg + sBasic.trust.wn, 0,
      '…and it rates NOTHING and feeds NO rep/trust counter')
    hasCode(chain.verifyChain(cBasic), 'bad-segment', '…and verifyChain rejects the whole chain')
    const foreignCk = mkOppCkpt(oppB, { f: 'evil-v9', n: 6 })
    eq(seg.verifySegmentEvent(witnessedSorted(addSeg(mkChain(), G('fi2'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, oppCkpt: foreignCk }))[1]),
      'bad-opp-ckpt', 'a FOREIGN fold id on a rated segment fails the same way (fail closed)')
    // kind-only (half-bound) segments are rated-SHAPED. The rule applies
    const cHalfB = addSeg(mkChain(), G('fi3'), oppB.pubB, { kind: 'chess', oppCkpt: basicCk })
    eq(seg.verifySegmentEvent(witnessedSorted(cHalfB)[1]), 'bad-opp-ckpt',
      'kind-only (rated-shaped) segment + basic-v1 oppCkpt → bad-opp-ckpt too')
    // UNBOUND (legacy/casual) segments stay out of §6 scope: any state shape ok
    const cLegacyCk = addSeg(mkChain(), G('fi4'), oppB.pubB, { oppCkpt: basicCk })
    eq(seg.verifySegmentEvent(witnessedSorted(cLegacyCk)[1]), null,
      'an UNBOUND (legacy) segment may still embed a basic-v1 checkpoint (casual-history opponents are honest)')
    eq(chain.verifyChain(cLegacyCk).ok, true, '…and its chain verifies end-to-end')
    // the a4-v1 twin of the SAME shape passes. The fold id is the exact cut
    const cA4 = addSeg(mkChain(), G('fi5'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, oppCkpt: mkOppCkpt(oppB, { f: 'a4-v1', n: 6 }) })
    eq(seg.verifySegmentEvent(witnessedSorted(cA4)[1]), null,
      'the SAME rated segment with an a4-v1-stated oppCkpt verifies (fold id is the exact discriminator)')
    eq(fold.A4_FOLD_ID, 'a4-v1', "segment.ts's restated fold-id literal matches ratings/fold.ts A4_FOLD_ID")
  }
  console.log('\n· A4-02 magnitude sanity clamp: on the VOUCHED read (the fold always seeds) …')
  {
    const winVs = (r, rd) => glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: r, rdMicro: rd, score: 1 }]).ratingMicro
    const seedWin = winVs(P.seedRating * M6, P.seedRd * M6)
    const honest = roster(wit, ...cosigners)
    const cases = [
      // [name, embedded (r, rd), clamped (r, rd) the VOUCHED read must use]
      ['r = 3e12 (absurd but safe-int)', 3_000_000_000_000, 80_000_000, 4_000_000_000, 80_000_000],
      ['r just past the 4000-Elo cap', 4_000_000_001, 80_000_000, 4_000_000_000, 80_000_000],
      ['negative r', -50_000_000, 80_000_000, 0, 80_000_000],
      ['rd below RD_MIN (5 Elo)', 1_600_000_000, 5_000_000, 1_600_000_000, 30_000_000],
      ['rd above RD_MAX (900 Elo)', 1_600_000_000, 900_000_000, 1_600_000_000, 350_000_000],
    ]
    for (const [name, r, rd, rc, rdc] of cases) {
      const c = addSeg(mkChain(), G('cl1'), oppB.pubB, {
        kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w',
        oppCkpt: mkOppCkpt(oppB, a4OppState({ 'chess:Blitz': { r, rd, vol: 60_000, n: 150, placed: 1 } })),
      })
      eq(foldChain(c).ladders['chess:Blitz'].r, seedWin, `${name} → the FOLD still seeds (embedded numbers never reach it)`)
      eq(fold.ratingEvidenceOf(c, honest).ladders['chess:Blitz'].r, winVs(rc, rdc),
        `${name} → vouched read clamped to (${rc}, ${rdc})`)
    }
    eq(fold.OPP_RATING_CAP_MICRO, 4_000_000_000, 'the exported cap is 4000 Elo in micro')
  }
  console.log('\n· pinned inputs: self-asserted numbers NEVER reach the fold …')
  {
    // identical chains except forged rating claims in every non-oppCkpt spot
    const mk = (forged) => {
      let c = mkChain()
      c = addSeg(c, G('f1'), oppA.pubB, {
        kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w',
        reason: forged ? 'resign rating=2800' : 'resign',
        oppProfile: forged
          ? { name: 'Opponent', bio: 'my rating is 2800, RD 30', flair: '2800' }
          : { name: 'Opponent' },
      })
      return c
    }
    const sPlain = foldChain(mk(false))
    const sForged = foldChain(mk(true))
    eq(stateHash(sForged.ladders), stateHash(sPlain.ladders),
      'forged high self-claimed opponent rating (oppProfile/reason) never moves a ladder')
    eq(stateHash(sForged.trust), stateHash(sPlain.trust), '…nor the trust inputs')
    // and rep differs only via the reason CLASS, which both used ('resign'-prefixed
    // free text is NOT the machine string 'resign': both classify completed)
    eq(sForged.rep.seg, sPlain.rep.seg, '…rep counters agree')
  }

  // ============================================================================
  // 4b. A4-19: the two rating-fold authority breaks, negative coverage
  // ============================================================================
  console.log('\n· A4-19: color-flip forgery is excluded EVERYWHERE …')
  {
    // The review scenario: subject played BLACK and lost (witness signs
    // result '1-0' with players {w: opp, b: me}); the payload claims color
    // 'w' to launder the loss into a rated win.
    const cFlip = addSeg(mkChain(), G('cf1'), oppA.pubB, {
      kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w', bindColor: 'b',
    })
    const evFlip = witnessedSorted(cFlip)[1]
    eq(seg.verifySegmentEvent(evFlip), 'bad-ladder-binding', 'the witness signed players-by-color: the flip breaks the binding')
    const sFlip = foldChain(cFlip)
    eq(Object.keys(sFlip.ladders).length, 0, 'color-flipped segment NEVER rates (rating unmoved)')
    eq(sFlip.rep.seg, 0, '…and feeds NO rep counter (A4-07)')
    eq(sFlip.trust.wn, 0, '…and NO trust counter (A4-05)')
    hasCode(chain.verifyChain(cFlip), 'bad-segment', '…and verifyChain rejects the whole chain (bad-segment)')
    // the honest segment (color matches what the witness signed) rates as a LOSS
    const cHonest = addSeg(mkChain(), G('cf1'), oppA.pubB, {
      kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'b',
    })
    const sHonest = foldChain(cHonest)
    eq(seg.verifySegmentEvent(witnessedSorted(cHonest)[1]), null, 'the honest color verifies')
    ok(sHonest.ladders['chess:Blitz'].r < P.seedRating * M6, '…and rates as the loss it was (rating fell)')
    // the review's EXACT A4-19 vector: witness signed result '0-1' for a
    // subject who played WHITE (lost); the payload sets color 'b' to claim
    // the black win.
    const cFlip2 = addSeg(mkChain(), G('cf3'), oppA.pubB, {
      kind: 'chess', tc: BLITZ_TC, result: '0-1', color: 'b', bindColor: 'w',
    })
    eq(seg.verifySegmentEvent(witnessedSorted(cFlip2)[1]), 'bad-ladder-binding',
      "review A4-19 vector (result '0-1', color flipped to 'b') → bad-ladder-binding")
    const sFlip2 = foldChain(cFlip2)
    eq(Object.keys(sFlip2.ladders).length + sFlip2.rep.seg + sFlip2.trust.wn, 0,
      '…and it moves NOTHING: no ladder, no rep counter, no trust counter')
    hasCode(chain.verifyChain(cFlip2), 'bad-segment', '…and the chain is rejected outright')
    // opp-swap dies the same way (players binds WHICH roots played)
    const cSwap = addSeg(mkChain(), G('cf2'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC })
    const evSwap = clone(witnessedSorted(cSwap)[1])
    evSwap.body.payload.opp = oppB.pubB
    ok(seg.verifySegmentEvent(evSwap) !== null, 'relabeling opp breaks event sig / players binding, never verifies')
  }
  console.log('\n· A4-19: oppCkpt without verifiable M-of-N cosigs never rates …')
  {
    const oppState = a4OppState({ 'chess:Blitz': { r: 1_600_000_000, rd: 80_000_000, vol: 60_000, n: 150, placed: 1 } })
    // (a) the review's exact scenario: fabricated 4-entry wit (garbage sigs,
    // distinct prefix-diverse fake keys)
    const fabricatedWit = Array.from({ length: 4 }, (_, i) => ({
      w: fakeId(`fab-cosigner-${i}`), wts: 900, epoch: 0, sig: 'B'.repeat(86),
    }))
    // (b) no cosigners at all: the pre-F1 suite fixture shape
    const casesBad = {
      'fabricated 4-entry wit (garbage cosig sigs)': mkOppCkpt(oppB, oppState, fabricatedWit),
      'zero cosigners': mkOppCkpt(oppB, oppState, null),
      'M−1 real cosigners (3 of 4)': (() => {
        const body = {
          v: 1, lane: 'w', type: 'ckpt', root: oppB.pubB, key: oppB.pubB,
          height: 7, prev: fakeId('opp-prev'), ts: 5000,
          payload: { through: 6, state: oppState, stateDigest: stateHash(oppState) },
        }
        const ev = events.signBody(body, oppB.priv)
        const id = events.eventId(body)
        return { ...ev, wit: cosigners.slice(0, 3).map((k) => mkAtt(k, id, 900)) }
      })(),
    }
    for (const [name, oppCkpt] of Object.entries(casesBad)) {
      const c = addSeg(mkChain(), G('nc1'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, oppCkpt })
      const ev = witnessedSorted(c)[1]
      eq(seg.verifySegmentEvent(ev), 'bad-opp-ckpt', `${name}: segment fails 'bad-opp-ckpt'`)
      const s = foldChain(c)
      eq(Object.keys(s.ladders).length, 0, `${name}: NOTHING rates`)
      eq(s.rep.seg, 0, `${name}: no rep counter moves`)
      eq(s.trust.wn, 0, `${name}: no trust counter moves`)
      hasCode(chain.verifyChain(c), 'bad-segment', `${name}: verifyChain rejects the chain`)
    }
    // borrowed checkpoint: a REAL cosigned ckpt of oppB embedded for opp = oppA
    const cBorrow = addSeg(mkChain(), G('nc2'), oppA.pubB, {
      kind: 'chess', tc: BLITZ_TC, oppCkpt: mkOppCkpt(oppB, oppState),
    })
    eq(seg.verifySegmentEvent(witnessedSorted(cBorrow)[1]), 'bad-opp-ckpt',
      "a genuinely-cosigned checkpoint of ANOTHER account never proxies (root ≠ opp)")
    eq(Object.keys(foldChain(cBorrow).ladders).length, 0, '…and nothing rates')
    // forged wstream: excluded everywhere too
    const cW = addSeg(mkChain(), G('nc3'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC, wsig: 'A'.repeat(86) })
    const sW = foldChain(cW)
    eq(Object.keys(sW.ladders).length + sW.rep.seg + sW.trust.wn, 0, 'forged wstream sig: excluded from rating, rep AND trust')
  }

  // ============================================================================
  // 5. placement floor + placed→ranked at exactly placementGames
  // ============================================================================
  console.log('\n· placement floor + transition …')
  {
    eq(P.placementGames, 10, 'PARAMS_A4.placementGames is the agreed 10')
    let c = mkChain()
    let manual = fold.ladderInit()
    const floorMicro = P.placementRdFloor * M6
    let flooredGames = 0
    for (let i = 1; i <= 10; i++) {
      c = addSeg(c, G(`pl${i}`), oppA.pubB, { kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w' })
      const up = glicko.glickoUpdateMicro(
        { ratingMicro: manual.r, rdMicro: manual.rd, volMicro: manual.vol },
        [{ ratingMicro: P.seedRating * M6, rdMicro: P.seedRd * M6, score: 1 }],
      )
      const n = manual.n + 1
      const placed = n >= P.placementGames ? 1 : 0
      if (placed === 0 && up.rdMicro < floorMicro) flooredGames++
      manual = { r: up.ratingMicro, rd: placed === 1 ? up.rdMicro : Math.max(up.rdMicro, floorMicro), vol: up.volMicro, n, placed }
      const l = foldChain(c).ladders['chess:Blitz']
      eq(l.r, manual.r, `game ${i}: fold rating matches the manual micro replay`)
      eq(l.rd, manual.rd, `game ${i}: fold rd matches (floor ${placed === 0 ? 'armed' : 'lifted'})`)
      eq(l.n, n, `game ${i}: ladder n = ${n}`)
      eq(l.placed, placed, `game ${i}: placed = ${placed}`)
    }
    ok(flooredGames >= 8, `the floor actually bound (computed rd < 300 on ${flooredGames}/9 placement games)`)
    const s10 = foldChain(c)
    const l10 = s10.ladders['chess:Blitz']
    eq(l10.placed, 1, 'placed flips 0→1 at EXACTLY placementGames')
    ok(l10.rd < floorMicro, 'game 10 stores the raw computed rd (floor lifted, < 300e6)')
    ok(l10.rd >= P.rdMin * M6, 'stored rd respects RD_MIN')
    // floor ≤ RD_MAX interplay: floored values sit inside [300e6, 350e6]
    ok(P.placementRdFloor <= P.rdMax, 'placementRdFloor ≤ rdMax (floor can never exceed RD_MAX)')
    eq(chain.verifyChain(c).ok, true, 'the placement chain verifies ok end-to-end')
    const h = stateHash(s10)
    if (GOLDEN_PLACEMENT_HASH === null) {
      console.log(`  · RECORD GOLDEN_PLACEMENT_HASH = '${h}'`)
      ok(false, 'golden placement hash not recorded yet')
    } else {
      eq(h, GOLDEN_PLACEMENT_HASH, 'placement chain state hashes to the recorded vector')
    }
  }

  // ============================================================================
  // 6. skip rules (rating skips; verified conduct still folds)
  // ============================================================================
  console.log('\n· skip rules …')
  {
    // (a) no kind/tc: LEGACY, wstream-valid
    const cLegacy = addSeg(mkChain(), G('s1'), oppA.pubB, {})
    const sLegacy = foldChain(cLegacy)
    eq(Object.keys(sLegacy.ladders).length, 0, 'segment without kind/tc never rates')
    eq(sLegacy.rep.seg, 1, '…but rep counts the game (legacy: completion only)')
    eq(sLegacy.trust.wn, 1, '…and trust counts the game')
    // (b) Unlimited
    const cUnl = addSeg(mkChain(), G('s2'), oppA.pubB, { kind: 'chess', tc: { baseMs: 0, incMs: 0 } })
    const sUnl = foldChain(cUnl)
    eq(Object.keys(sUnl.ladders).length, 0, 'Unlimited (baseMs 0) never rates: even witness-bound')
    eq(sUnl.rep.seg, 1, '…but rep counts it')
    // (c) bad-ladder-binding: payload claims Blitz, witness signed the LEGACY bytes
    const cBad = addSeg(mkChain(), G('s3'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC, bind: null })
    const evBad = witnessedSorted(cBad)[1]
    eq(seg.verifySegmentEvent(evBad), 'bad-ladder-binding', 'fixture sanity: the segment IS bad-ladder-binding')
    const sBad = foldChain(cBad)
    eq(Object.keys(sBad.ladders).length, 0, 'bad-ladder-binding segment never rates')
    eq(sBad.rep.seg, 0, '…and rep counts NOTHING (A4-07: the F2 change from the old still-feeds-rep decision)')
    eq(sBad.trust.wn, 0, '…and trust counts NOTHING (A4-05)')
    // (d) binding value mismatch: witness signed a DIFFERENT tc (full binding otherwise)
    const cMis = addSeg(mkChain(), G('s4'), oppA.pubB, {
      kind: 'chess', tc: BLITZ_TC,
      bind: { kind: 'chess', tc: { baseMs: 60_000, incMs: 0 }, players: { w: meB, b: oppA.pubB }, reason: 'checkmate' },
    })
    eq(seg.verifySegmentEvent(witnessedSorted(cMis)[1]), 'bad-ladder-binding', 'fixture sanity: tc mismatch is bad-ladder-binding')
    eq(Object.keys(foldChain(cMis).ladders).length, 0, 'witness-signed different tc never rates the claimed ladder')
    // (e) half-binding (kind only, tc absent) never rates (no tc → no category)
    const cHalf = addSeg(mkChain(), G('s5'), oppA.pubB, { kind: 'chess' })
    eq(Object.keys(foldChain(cHalf).ladders).length, 0, 'kind without tc never rates')
  }

  // ============================================================================
  // 6b. duplicate-segment dedup (windowed `seen` map) + A4-11 chain-level death
  // ============================================================================
  console.log('\n· duplicate rated segment: rates once in-window …')
  const W = P.repPairWindow
  {
    eq(W, 200, 'PARAMS_A4.repPairWindow is the agreed 200 (shared with reputation)')
    const c1 = addSeg(mkChain(), G('d1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC }) // h1
    const before = foldChain(c1)
    eq(before.ladders['chess:Blitz'].n, 1, 'first rated segment rates')
    eq(before.seen[G('d1')], 1, 'rated segment records its game key at its witnessed height')
    // (a) same game + same opp replayed at h2
    const cDup = addSeg(c1, G('d1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC }) // h2, dup
    const sDup = foldChain(cDup)
    eq(sDup.ladders['chess:Blitz'].n, 1, 'in-window duplicate does NOT rate (ladder n unmoved)')
    eq(sDup.ladders['chess:Blitz'].r, before.ladders['chess:Blitz'].r, 'rating unmoved by the duplicate')
    eq(sDup.seen[G('d1')], 1, 'seen keeps the ORIGINAL rated height (no refresh by the dup)')
    eq(sDup.rep.seg, 1, 'rep deduped the same (game, opp) by its own rule')
    eq(sDup.trust.wn, 2, 'trust counted both segments (its own rules, no dedup by design)')
    eq(sDup.byType.segment, 2, 'basic counters tick for every segment event')
    hasCode(chain.verifyChain(cDup), 'dup-game', 'A4-11: verifyChain rejects the in-window replay chain-wide (dup-game)')
    // (b) same game key, DIFFERENT opp: rating deduped by GAME KEY; rep counts the new pair
    const cDupOpp = addSeg(c1, G('d1'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC })
    const sDupOpp = foldChain(cDupOpp)
    eq(sDupOpp.ladders['chess:Blitz'].n, 1, 'dedup keys on the game, not (game, opp)')
    eq(sDupOpp.rep.seg, 2, '…while rep counts the distinct (game, opp) pair per its own rule')
    hasCode(chain.verifyChain(cDupOpp), 'dup-game', 'opp-relabel replay is ALSO dup-game at the chain layer')
    // (c) an UNRATED occurrence never inserts into seen
    let cU = addSeg(mkChain(), G('d2'), oppA.pubB, {}) // legacy: unrated
    cU = addSeg(cU, G('d2'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC })
    const sU = foldChain(cU)
    eq(sU.ladders['chess:Blitz'].n, 1, 'an unrated occurrence does not block a later valid rating of the same game')
    eq(sU.seen[G('d2')], 2, 'the RATED occurrence is the one recorded')
    // determinism on a dup-bearing fixture
    eq(stateHash(foldChain(cDup)), stateHash(foldChain(cDup)), 'dup fixture folds to identical state bytes twice')
    // composition fidelity holds on the dup fixture
    const repAlone = witnessedSorted(cDup).reduce((x, e) => rep.repStep(x, e), rep.repInit())
    const trustAlone = witnessedSorted(cDup).reduce((x, e) => trust.trustInputsStep(x, e), trust.trustInputsInit())
    eq(stateHash(sDup.rep), stateHash(repAlone), 'dup fixture: embedded rep ≡ standalone fold')
    eq(stateHash(sDup.trust), stateHash(trustAlone), 'dup fixture: embedded trust ≡ standalone fold')
  }
  console.log('\n· duplicate dedup: window edges + bounded state …')
  {
    let gen = 0
    const padPins = (c, n) => {
      for (let i = 0; i < n; i++)
        c = chain.appendWitnessed(c, me.priv, meB, 'pin', { record: fakeId(`pin${gen}`), gen: gen++ }, ts++)
      return c
    }
    // rated at h1; duplicate at h(1+W): entry h=1 ≥ minH=1 → still remembered → deduped
    let cEdge = addSeg(mkChain(), G('e1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC }) // h1
    cEdge = padPins(cEdge, W - 1) // head h200
    const cEdgeAt = addSeg(cEdge, G('e1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC }) // h201, diff = W
    eq(foldChain(cEdgeAt).ladders['chess:Blitz'].n, 1, 'duplicate at exactly the window edge (diff = W) is still deduped')
    // one past: the FOLD's windowed memory expires, and that is exactly where
    // the chain layer takes over (A4-11): the replay is dup-game fraud.
    const cEdgePast = addSeg(padPins(cEdge, 1), G('e1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC }) // h202, diff = W+1
    const sPast = foldChain(cEdgePast)
    eq(sPast.ladders['chess:Blitz'].n, 2, 'one past the window edge the fold entry is pruned (standalone fold rates)')
    eq(sPast.seen[G('e1')], 202, 'the new rating re-records the game key at the new height')
    hasCode(chain.verifyChain(cEdgePast), 'dup-game',
      'A4-11 CLOSED: the cross-window replay NEVER verifies, verifyChain forbids the game key chain-wide')
    // bounded state: 260 distinct rated games → seen holds exactly W+1 entries
    let cBulk = mkChain()
    for (let i = 1; i <= 260; i++) cBulk = addSeg(cBulk, G(`bulk${i}`), oppA.pubB, { kind: 'chess', tc: BLITZ_TC })
    const sBulk = foldChain(cBulk)
    eq(sBulk.ladders['chess:Blitz'].n, 260, 'all 260 distinct games rated')
    eq(Object.keys(sBulk.seen).length, W + 1, `seen map holds exactly W+1 = ${W + 1} entries after 260 games (O(window), not O(games))`)
    ok(Object.values(sBulk.seen).every((h) => h >= 260 - W), 'every surviving seen entry is in-window of the head')
    eq(chain.verifyChain(cBulk).ok, true, 'the bulk fixture chain verifies ok end-to-end')
  }

  // ============================================================================
  // 7. display states (§6) + pairViewOf into the mm twin
  // ============================================================================
  console.log('\n· displayState boundaries per category …')
  {
    const at = (n, r = 1_534_567_890) => ({ n, r })
    const d0 = display.displayState(at(0), 'Blitz')
    eq(d0.state, 'placement', 'n=0 → placement')
    eq(d0.n, 0, 'placement carries n')
    eq(d0.of, 10, 'placement of = placementGames')
    eq(display.displayState(at(9), 'Blitz').state, 'placement', 'n=9 → placement (last placement game pending)')
    const d10 = display.displayState(at(10), 'Blitz')
    eq(d10.state, 'provisional', 'n=10 → provisional (transition at exactly placementGames)')
    eq(d10.of, 100, 'provisional of = revealThreshold(category)')
    for (const [cat, reveal] of [['Bullet', 120], ['Blitz', 100], ['Rapid', 80], ['Classical', 40]]) {
      eq(display.displayState(at(reveal - 1), cat).state, 'provisional', `${cat}: n=${reveal - 1} → provisional`)
      const d = display.displayState(at(reveal), cat)
      eq(d.state, 'ranked', `${cat}: n=${reveal} → ranked (reveal at exactly the threshold)`)
      eq(d.rating, 1534, `${cat}: ranked rating = floor(micro/1e6) display Elo`)
    }
    eq(display.displayState({ n: 200, r: 1_534_999_999 }, 'Blitz').rating, 1534, 'display rounding: floor, not round')
    eq(display.displayState({ n: 200, r: -500_000 }, 'Blitz').rating, -1, 'display rounding: floor toward −∞')
    eq(display.displayState(fold.ladderInit(), 'Blitz').state, 'placement', 'a fresh ladderInit() renders Placement 0/10')
  }
  console.log('\n· pairViewOf composes the mm PairView shape …')
  {
    // atWts = the pairing record's witnessed timestamp: BOTH sides' tMicro
    // are evaluated at this same instant (A4-16 / display.ts doc convention).
    const AT_WTS = 1_000_000
    const lad = { r: 1_534_567_890, rd: 62_000_000, vol: 60_000, n: 150, placed: 1 }
    const pv = display.pairViewOf(meB, 'chess:Blitz', lad, 900_000, 'Blitz')
    eq(pv.ratingMicro, lad.r, 'pairViewOf: ratingMicro = ladder.r')
    eq(pv.rdMicro, lad.rd, 'pairViewOf: rdMicro = ladder.rd')
    eq(pv.display.state, 'ranked', 'pairViewOf derives the display state')
    // structural-twin proof: the composed view drives mm/pairing directly
    const opp = display.pairViewOf(oppA.pubB, 'chess:Blitz', { ...lad, r: 1_560_000_000 }, 850_000, 'Blitz')
    eq(mm.pairingLegal(pv, opp, AT_WTS).legal, true, 'ranked×ranked 26 Elo apart at high T → legal via mm.pairingLegal(a, b, atWts)')
    eq(mm.pairingLegal(pv, { ...opp, ladderId: 'chess:Bullet' }, AT_WTS).reason, 'ladder-mismatch', 'twin shape carries ladderId into mm rules')
    eq(mm.pairingLegal(pv, opp).reason, 'bad-at-wts', 'a missing atWts fails closed (A4-16: the evaluation instant is protocol input)')
    const prov = display.pairViewOf(oppB.pubB, 'chess:Blitz', { ...lad, n: 50 }, 500_000, 'Blitz')
    eq(prov.display.state, 'provisional', 'provisional view derived')
    eq(mm.spectatorOpponentInfo(prov).kind, 'bracket', 'mm surface rules accept the composed provisional view')
    eq(mm.visibleOpponentInfo(prov, pv).kind, 'unranked-pool', 'a provisional viewer of the composed view sees nothing rating-shaped')
  }

  // ============================================================================
  // 8. checkpoint integration (pluggable folds)
  // ============================================================================
  console.log('\n· checkpoints: a4-v1 incremental + deep …')
  let a4Chain, ckA, ckB
  {
    let c = goldenChain
    ckA = ckpt.makeCheckpointEvent(c, me.priv, meB, ts++, fold.a4Fold)
    eq(ckA.body.payload.state.f, 'a4-v1', 'a4 checkpoint embeds the a4-v1 state')
    ok(ckpt.verifyCheckpointIncremental(c, ckA), 'first a4 checkpoint verifies incrementally (from genesis)')
    ok(ckpt.verifyCheckpointDeep(c, ckA), 'first a4 checkpoint verifies deeply')
    c = chain.appendEvent(c, ckA)
    c = addSeg(c, G('c1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC, result: '0-1', color: 'b' })
    c = addSeg(c, G('c2'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, result: '1/2-1/2', color: 'w', reason: 'agreement' })
    ckB = ckpt.makeCheckpointEvent(c, me.priv, meB, ts++, fold.a4Fold)
    eq(ckB.body.payload.prevCkpt, events.eventId(ckA.body), 'second a4 ckpt chains to the first')
    ok(ckpt.verifyCheckpointIncremental(c, ckB), 'second a4 ckpt verifies incrementally FROM THE EMBEDDED PRIOR STATE')
    ok(ckpt.verifyCheckpointDeep(c, ckB), 'second a4 ckpt verifies deeply')
    a4Chain = c
    eq(chain.verifyChain(chain.appendEvent(c, ckB)).ok, true, 'the a4-checkpointed rated chain verifies ok end-to-end')
    // A4-10 builder side: on a rated chain the DEFAULT fold auto-selects a4-v1
    const auto = ckpt.makeCheckpointEvent(c, me.priv, meB, ts++)
    eq(auto.body.payload.state.f, 'a4-v1', 'makeCheckpointEvent auto-selects a4-v1 on chains with rated segments (A4-10)')
  }
  console.log('\n· checkpoints: tampered a4 state fails …')
  {
    const forged = clone(ckB)
    forged.body.payload.state.ladders['chess:Blitz'].r += 50_000_000 // +50 Elo
    forged.body.payload.stateDigest = stateHash(forged.body.payload.state) // self-consistent digest
    forged.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(forged.body), me.priv))
    ok(!ckpt.verifyCheckpointIncremental(a4Chain, forged), 'self-consistent forged ladder rating → incremental false')
    ok(!ckpt.verifyCheckpointDeep(a4Chain, forged), 'self-consistent forged ladder rating → deep false')
    const forged2 = clone(ckB)
    forged2.body.payload.state.rep = { ...forged2.body.payload.state.rep, commend: 99, commendTw: 1980 }
    forged2.body.payload.stateDigest = stateHash(forged2.body.payload.state)
    forged2.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(forged2.body), me.priv))
    ok(!ckpt.verifyCheckpointIncremental(a4Chain, forged2), 'forged embedded rep state → incremental false')
  }
  console.log('\n· checkpoints: unknown fold id fails CLOSED …')
  {
    const evil = clone(ckB)
    evil.body.payload.state = { ...evil.body.payload.state, f: 'evil-v9' }
    evil.body.payload.stateDigest = stateHash(evil.body.payload.state)
    evil.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(evil.body), me.priv))
    ok(!ckpt.verifyCheckpointIncremental(a4Chain, evil), 'unknown fold id → incremental false (fail closed)')
    ok(!ckpt.verifyCheckpointDeep(a4Chain, evil), 'unknown fold id → deep false (fail closed)')
    const badF = clone(ckB)
    badF.body.payload.state = { ...badF.body.payload.state, f: 7 }
    badF.body.payload.stateDigest = stateHash(badF.body.payload.state)
    badF.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(badF.body), me.priv))
    ok(!ckpt.verifyCheckpointIncremental(a4Chain, badF), 'non-string f → incremental false (fail closed)')
    ok(!ckpt.verifyCheckpointDeep(a4Chain, badF), 'non-string f → deep false (fail closed)')
    eq(ckpt.foldById('basic-v1')?.id, 'basic-v1', 'registry serves basic-v1')
    eq(ckpt.foldById('a4-v1')?.id, 'a4-v1', 'registry serves a4-v1')
    eq(ckpt.foldById('evil-v9'), undefined, 'registry refuses unknown ids')
    eq(ckpt.foldById('hasOwnProperty'), undefined, 'registry is prototype-safe')
  }
  console.log('\n· checkpoints: basic-v1 stays bit-identical + fold transitions …')
  {
    // default fold on an UNRATED chain (legacy segments only). The A1 path.
    // (A rated chain now auto-selects a4-v1 and verifyChain REQUIRES it, so
    // the basic-v1 regression fixture must be rating-free.)
    let c = mkChain()
    c = addSeg(c, G('lg1'), oppA.pubB, {}) // legacy
    c = addSeg(c, G('lg2'), oppB.pubB, {}) // legacy
    c = chain.appendWitnessed(c, me.priv, meB, 'conduct', { kind: 'abort', game: G('lga'), opp: oppA.pubB }, ts++)
    const basic = ckpt.makeCheckpointEvent(c, me.priv, meB, ts++)
    eq(basic.body.payload.state.f, undefined, 'basic-v1 states carry NO f field (pre-A4 bytes unchanged)')
    ok(ckpt.verifyCheckpointIncremental(c, basic), 'default (basic-v1) checkpoint verifies incrementally')
    ok(ckpt.verifyCheckpointDeep(c, basic), 'default (basic-v1) checkpoint verifies deeply')
    const cB = chain.appendEvent(c, basic)
    eq(chain.verifyChain(cB).ok, true, 'a basic-v1 checkpointed legacy chain verifies end-to-end (regression)')
    // fold TRANSITION: the chain's FIRST rated segment lands after a basic-v1
    // ckpt; the next (auto-selected a4-v1) ckpt is not one-step verifiable
    let c2 = cB
    c2 = addSeg(c2, G('tr1'), oppA.pubB, { kind: 'chess', tc: BLITZ_TC })
    const a4After = ckpt.makeCheckpointEvent(c2, me.priv, meB, ts++) // auto-selects a4-v1
    eq(a4After.body.payload.state.f, 'a4-v1', 'the transition checkpoint auto-selected a4-v1 (first rated segment)')
    ok(!ckpt.verifyCheckpointIncremental(c2, a4After), 'basic-v1 → a4-v1 transition: incremental refuses (fold discontinuity)')
    ok(ckpt.verifyCheckpointDeep(c2, a4After), 'basic-v1 → a4-v1 transition: deep verifies (recompute from genesis, the documented upgrade path)')
    eq(chain.verifyChain(chain.appendEvent(c2, a4After)).ok, true, 'the transitioned chain verifies ok end-to-end')
    // ═══ A4-10 GATE PIN (review: "deleting the incremental-path gate lines
    // keeps every suite green", no longer). Build a basic-v1 checkpoint that
    // is DIGEST-VALID over a rated range: fold-downgrade sandbagging. Every
    // verification path must refuse it BECAUSE of the rated-coverage gate.
    // The digest recomputation alone would pass, so these asserts fail the
    // moment the gate lines are reverted.
    const basicOverRated = ckpt.makeCheckpointEvent(c2, me.priv, meB, ts++, ckpt.basicFold)
    eq(basicOverRated.body.payload.state.f, undefined, 'fixture sanity: the sandbag checkpoint embeds a basic-v1 (f-less) state')
    eq(basicOverRated.body.payload.prevCkpt, events.eventId(basic.body),
      'fixture sanity: it chains to the earlier basic ckpt (same fold id, incrementally reachable)')
    ok(!ckpt.verifyCheckpointIncremental(c2, basicOverRated),
      'A4-10 PIN: basic-v1 checkpoint covering rated play → verifyCheckpointIncremental FALSE (the gate, not the digest)')
    ok(!ckpt.verifyCheckpointDeep(c2, basicOverRated),
      'A4-10 PIN: …and verifyCheckpointDeep FALSE (deep-path gate)')
    hasCode(chain.verifyChain(chain.appendEvent(c2, basicOverRated)), 'bad-checkpoint',
      'A4-10 PIN: …and verifyChain flags the chain (bad-checkpoint; fold-downgrade sandbagging is fraud)')
    // contrast at the SAME position: the a4-v1 checkpoint deep-verifies (above),
    // so the refusal is exactly the basic-v1-over-rated rule, nothing else.
    // The gate keys on the FIRST rated height: a basic ckpt covering only the
    // pre-rated prefix stays valid (regression guard for honest history).
    ok(ckpt.verifyCheckpointDeep(c2, basic), 'the ORIGINAL pre-rated basic checkpoint still deep-verifies on the rated chain')
    ok(ckpt.verifyCheckpointIncremental(c2, basic), '…and still incrementally verifies (through < first rated height)')
  }

  // ============================================================================
  // 9. determinism + composition fidelity
  // ============================================================================
  console.log('\n· determinism: twice + across a second esbuild bundle …')
  {
    const h1 = stateHash(foldChain(goldenChain))
    const h2 = stateHash(foldChain(goldenChain))
    eq(h1, h2, 'folding the same chain twice → identical state bytes')
    const M2 = await bundle(outdir, 'entry2')
    const s2 = witnessedSorted(goldenChain).reduce((s, e) => M2.fold.a4Fold.step(s, e), M2.fold.a4Fold.init(goldenChain.root))
    eq(M2.hash.toB64u(M2.codec.canonicalHash(s2)), h1, 'an independent esbuild bundle folds to identical state bytes')
  }
  console.log('\n· composition fidelity: embedded rep/trust ≡ standalone 1c/2b folds …')
  {
    const s = foldChain(a4Chain)
    const repAlone = witnessedSorted(a4Chain).reduce((x, e) => rep.repStep(x, e), rep.repInit())
    const trustAlone = witnessedSorted(a4Chain).reduce((x, e) => trust.trustInputsStep(x, e), trust.trustInputsInit())
    eq(stateHash(s.rep), stateHash(repAlone), 'embedded RepState ≡ standalone reputation fold (byte-identical)')
    eq(stateHash(s.trust), stateHash(trustAlone), 'embedded TrustInputs ≡ standalone trust fold (byte-identical)')
    // and the trust score is derivable from the embedded members alone
    const t = trust.trustT(s.trust, s.rep, 1_000_000_000)
    ok(Number.isSafeInteger(t) && t >= 0 && t <= 1_000_000, 'trustT over the embedded members is a micro integer')
    // step purity: same (state, event) twice → identical bytes; input untouched
    const ev = witnessedSorted(a4Chain)[3]
    const before = stateHash(s)
    const r1 = fold.a4Fold.step(s, ev)
    const r2 = fold.a4Fold.step(s, ev)
    eq(stateHash(r1), stateHash(r2), 'a4 step is pure: same (state, event) → same state bytes')
    eq(stateHash(s), before, 'a4 step never mutates its input state')
    // totality: garbage events pass through the rating sub-step without throwing
    const junk = { body: { v: 1, lane: 'w', type: 'segment', root: meB, key: meB, height: 99, prev: fakeId('x'), ts: 1, payload: { garbage: true } }, sig: 'A'.repeat(86) }
    const rj = fold.a4Fold.step(s, junk)
    eq(Object.keys(rj.ladders).length, Object.keys(s.ladders).length, 'malformed segment payload: counters tick, no rating, no throw')
  }

  // ============================================================================
  // 10. A4-02 PIN. The sybil-cosigned phantom-opponent ratchet is DEAD
  // ============================================================================
  console.log('\n· A4-02 PIN: a self-minted sybil-cosigned oppCkpt moves NOTHING …')
  {
    // The review's exact vector: 4 FRESH keypairs (minted for free, in no
    // honest roster) whose pubkeys land in distinct 2-char b64u prefix
    // buckets, self-signing 4 valid attestations over a colluder-signed
    // checkpoint that asserts Blitz 3200 (rd 40) for the opponent.
    const sybils = []
    {
      const prefixes = new Set()
      for (let b = 90; sybils.length < 4 && b < 200; b++) {
        const k = kp(b)
        const pre = k.pubB.slice(0, 2)
        if (prefixes.has(pre)) continue
        prefixes.add(pre)
        sybils.push(k)
      }
    }
    eq(sybils.length, 4, 'fixture sanity: 4 fresh prefix-diverse sybil keypairs minted')
    ok(sybils.every((s) => !cosigners.some((c) => c.pubB === s.pubB) && s.pubB !== wit.pubB),
      'fixture sanity: no sybil key is in the honest roster')
    const phantom = { r: 3_200_000_000, rd: 40_000_000, vol: 60_000, n: 400, placed: 1 }
    const sybilState = a4OppState({ 'chess:Blitz': phantom })
    const sybBody = {
      v: 1, lane: 'w', type: 'ckpt', root: oppB.pubB, key: oppB.pubB,
      height: 7, prev: fakeId('syb-prev'), ts: 5000,
      payload: { through: 6, state: sybilState, stateDigest: stateHash(sybilState) },
    }
    const sybId = events.eventId(sybBody)
    const sybilCkpt = { ...events.signBody(sybBody, oppB.priv), wit: sybils.map((k) => mkAtt(k, sybId, 900)) }
    const cSybil = addSeg(mkChain(), G('syb1'), oppB.pubB, {
      kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w', oppCkpt: sybilCkpt,
    })
    // identical game WITHOUT any oppCkpt: the honest young-opponent baseline
    const cBase = addSeg(mkChain(), G('syb1'), oppB.pubB, { kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w' })
    // The attack is REACHABLE: structure/provenance checks all pass (a
    // deterministic gate cannot judge eligibility) and the chain verifies.
    eq(seg.verifySegmentEvent(witnessedSorted(cSybil)[1]), null,
      'fixture sanity: the sybil-cosigned segment PASSES verifySegmentEvent (structure is not eligibility)')
    eq(chain.verifyChain(cSybil).ok, true, 'fixture sanity: the sybil chain verifies ok end-to-end')
    // ── THE PIN (fold layer): the fabricated 3200 phantom must move NOTHING.
    // The fold pins seeds for every opponent, so the sybil chain's ladders are
    // BYTE-IDENTICAL to the no-oppCkpt baseline. Reverting the A4-02 fold rule
    // (pinning the embedded numbers again) fails exactly here.
    const sSybil = foldChain(cSybil)
    const sBase = foldChain(cBase)
    eq(stateHash(sSybil.ladders), stateHash(sBase.ladders),
      'A4-02 PIN: sybil-cosigned 3200 oppCkpt folds BYTE-IDENTICAL to the no-oppCkpt seed baseline (no ratchet)')
    const winVsPhantom = glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: phantom.r, rdMicro: phantom.rd, score: 1 }]).ratingMicro
    ok(sSybil.ladders['chess:Blitz'].r < winVsPhantom,
      'A4-02 PIN: the folded rating is strictly below a live 3200-pin win (the fabrication bought nothing)')
    // ── THE PIN (read-time layer): under the honest roster (real witness +
    // real cosigners; the sybil keys are in NOBODY's directory) the vouched
    // rating equals the floor. The sybil cosigners earn no uplift for any
    // verifier. Reverting the eligibility rule in vouchedOpponent fails here.
    const honest = roster(wit, ...cosigners)
    eq(stateHash(fold.ratingEvidenceOf(cSybil, honest).ladders), stateHash(sBase.ladders),
      'A4-02 PIN: the roster-vouched read-time rating REFUSES the sybil cosigners (vouched ≡ floor)')
    eq(stateHash(fold.ratingEvidenceOf(cSybil).ladders), stateHash(sSybil.ladders),
      'no-roster evidence ≡ the embedded floor on the attack chain (zero drift)')
    // determinism (A4-04 safety): embedded state is roster-independent. The
    // same attack chain folds to identical bytes on every walk, so honest
    // verifiers can never split over it.
    eq(stateHash(foldChain(cSybil)), stateHash(sSybil), 'the sybil chain folds to identical embedded bytes on every walk')
    // and the trust layer keeps its own A4-05 discipline on the same chain:
    // under the honest roster the sybil-cosigned checkpoint unlocks NO
    // established-opponent proxy: only the young-opponent floor the real
    // witnessed game earns on its own.
    const tEv = trust.trustEvidenceOf(cSybil, honest)
    eq(tEv.oppEligProxy[oppB.pubB] ?? 0, trust.TRUST_OPP_PROXY_FLOOR_MICRO,
      'cross-check: trustEvidenceOf grants the sybil-backed opponent only the young-opponent FLOOR (no est tier)')
  }

  // ============================================================================
  // A7, A4-02 fidelity + A4-10 freshness CLOSED via the pairing witAttest
  // (placed LAST: consumes ts++, and the golden hashes above must not move)
  // ============================================================================
  console.log('\n· A7: pairing witAttest. Fidelity upgrade (A4-02) + freshness bound (A4-10) …')
  {
    const oppLadder = { r: 1_600_000_000, rd: 80_000_000, vol: 60_000, n: 150, placed: 1 }
    const honest = roster(wit, ...cosigners)
    const game = G('a7p1')
    const mkAttested = (att) => {
      let c = mkChain()
      c = chain.appendWitnessed(c, me.priv, meB, 'pairing',
        { game, opp: oppB.pubB, kind: 'chess', tc: BLITZ_TC, atWts: 9000, ...(att !== undefined ? { witAttest: att } : {}) }, ts++)
      return addSeg(c, game, oppB.pubB, {
        kind: 'chess', tc: BLITZ_TC, result: '1-0', color: 'w',
        oppCkpt: mkOppCkpt(oppB, a4OppState({ 'chess:Blitz': oppLadder })),
      })
    }
    // helpers: the serving witness attests 1800 (above the 1600 floor), head 6 (fresh)
    const att1800 = watt.makePairingAttest(game, oppB.pubB, 1_800_000_000, 6, wit.pubB, wit.priv, 9100)
    ok(watt.verifyPairingAttest(att1800, game, oppB.pubB), 'makePairingAttest → verifyPairingAttest round-trips')
    ok(!watt.verifyPairingAttest(att1800, G('other'), oppB.pubB), 'attest is game-bound (foreign game refused)')
    ok(!watt.verifyPairingAttest({ ...att1800, ratingMicro: 1_900_000_000 }, game, oppB.pubB), 'tampered rating breaks the sig')
    // (1) fidelity upgrade: vouched read now reads the ATTESTED 1800, floor rd
    const cUp = mkAttested(att1800)
    eq(chain.verifyChain(cUp).ok, true, 'the pairing+witAttest chain verifies ok end-to-end (additive schema)')
    const expected1800 = glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: 1_800_000_000, rdMicro: 80_000_000, score: 1 }])
    eq(fold.ratingEvidenceOf(cUp, honest).ladders['chess:Blitz'].r, expected1800.ratingMicro,
      'A4-02 CLOSED: the vouched read upgrades the pin from the 1600 floor to the witness-attested 1800')
    // (2) upgrade ONLY: an attest BELOW the floor keeps the floor
    const attLow = watt.makePairingAttest(game, oppB.pubB, 1_000_000_000, 6, wit.pubB, wit.priv, 9100)
    const expected1600 = glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: 1_600_000_000, rdMicro: 80_000_000, score: 1 }])
    eq(fold.ratingEvidenceOf(mkAttested(attLow), honest).ladders['chess:Blitz'].r, expected1600.ratingMicro,
      'upgrade-only: an attest below the embedded floor never downgrades the pin')
    // (3) forged attest ⇒ floor (sig broken by the payload tamper above)
    eq(fold.ratingEvidenceOf(mkAttested({ ...att1800, ratingMicro: 1_900_000_000 }), honest).ladders['chess:Blitz'].r,
      expected1600.ratingMicro, 'a forged witAttest is ignored, the sound floor pin remains')
    // (4) attest from an INELIGIBLE key ⇒ floor (roster judgment at read time)
    const attSybil = watt.makePairingAttest(game, oppB.pubB, 1_800_000_000, 6, oppB.pubB, oppB.priv, 9100)
    eq(fold.ratingEvidenceOf(mkAttested(attSybil), honest).ladders['chess:Blitz'].r, expected1600.ratingMicro,
      'an attest signed by a non-roster key earns nothing (eligibility is the read-time gate)')
    // (5) A4-10 CLOSED: attested head 5 < oppCkpt.through 6 ⇒ stale ⇒ SEEDS
    const attStale = watt.makePairingAttest(game, oppB.pubB, 1_800_000_000, 5, wit.pubB, wit.priv, 9100)
    const expectedSeed = glicko.glickoUpdateMicro(seedMicro, [{ ratingMicro: P.seedRating * M6, rdMicro: P.seedRd * M6, score: 1 }])
    eq(fold.ratingEvidenceOf(mkAttested(attStale), honest).ladders['chess:Blitz'].r, expectedSeed.ratingMicro,
      'A4-10 CLOSED: an oppCkpt folding PAST the witness-attested head is refused. Vouched read falls to seeds')
    // (6) direct bound: verifyEmbeddedOppCkpt(p, owner, attestedHeadHeight)
    const p = cUp.events.filter((e) => e.body.type === 'segment').at(-1).body.payload
    ok(seg.verifyEmbeddedOppCkpt(p, meB, 6), 'verifyEmbeddedOppCkpt passes at attested head = through')
    ok(!seg.verifyEmbeddedOppCkpt(p, meB, 5), 'verifyEmbeddedOppCkpt refuses through > attested head (A4-10 bound)')
    // (7) zero-drift: the attested chain's EMBEDDED fold is byte-identical to
    // the unattested one (read-time only: no fold input, ever)
    eq(stateHash(foldChain(cUp).ladders), stateHash(foldChain(mkAttested(undefined)).ladders),
      'witAttest never reaches the embedded fold (attested ≡ unattested fold bytes)')
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
