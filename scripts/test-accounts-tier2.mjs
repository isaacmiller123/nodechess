// Headless test for src/shared/accounts/judge/tier2.ts (phase A5 brick J4;
// Tier-2: salted K-windows, Regan aggregation, the deterministic escalation
// trigger, verdict/suppression records, self-ban + fold bans + pairing/
// display ban surfaces).
//
//   node scripts/test-accounts-tier2.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-tier1.mjs). NO live engine: every
// Tier1Record here is a synthetic literal (the estimator consumes recorded
// integer signals: engine work happened upstream in J1/J2). Covers:
//  (a) commit-reveal salt: saltBodyHash golden, lease.ts grantBytes
//      convention parity, windowSalt goldens (recomputable-after: identical
//      re-derivation; unpredictable-before proxy: different windows/grant
//      sets ⇒ different salts ⇒ different partitions), threshold + witness-
//      set rules, tamper rejection,
//  (b) the salted window partition: boundary-jitter geometry (contiguous,
//      exhaustive, sizes in [1, 2K−1]), ordinal↔window roundtrip, slicing,
//      determinism, salt-dependence,
//  (c) the z estimator: expectedMatchMicro interpolation, per-game deviation
//      goldens (innocent/blatant-capped/metered), the ±3σ cap ⇒ structural
//      no-single-game-convicts (1 and 2 games can NEVER convict; 3 can),
//      exact window goldens incl. an innocent set (far below), a blatant set
//      (far above), and a threshold-ε metered set landing between
//      zEscalate and zThreshold (escalate-not-convict), unscored exclusion,
//      fail-closed matrix,
//  (c2) J7 cross-window lifetime accumulation (lifetimeVerdict): golden math
//      (W=1 degeneracy ≡ window z, sustained-2.6σ escalation at W=2 and
//      conviction at W=4, mixed-sign cancellation, floor-toward-−∞),
//      structural window-z bound, determinism, fail-closed matrix,
//  (d) escalationDue: earliest trailing-K firing point golden, under-K and
//      all-innocent negatives, missing-record + upfront full-domain
//      fail-closed (A5-21 ratification); J7 additive closedWindowZs param
//      (lifetime-only firing at the earliest escalating prefix, A5-20
//      both-arms-independent reporting); A5-21 conviction scan (earliest
//      5σ crossing per arm, both-arms conviction, exact-boundary window),
//  (e) verdict records: make/verify/recompute receipts, commend-pattern
//      signer (root + certified child), tamper matrix (zMicro / games /
//      tier1 digests / window / anchors / kind ⇒ verify false), suppression
//      shape rules, J7 lifetime claims (derived-never-asserted, recompute
//      receipt, 'verdict'-kind tie to the record's own window, tamper
//      matrix), tier2VerdictKey/verdictRow,
//  (f) self-ban helpers: schema-validated payload, expiry, due-now rule,
//  (g) fold bans: selfban events fold into a4-v1 bans. Expiry DERIVED from
//      the event ts + §9 term and folded MONOTONICALLY (a convict cannot
//      self-un-ban; A5-22/A5-08), bounded to PLAYED ladders (A5-38),
//      malformed/personal-lane ignored; ban-free chains keep byte-identical
//      state (ratings-suite goldens hold un-refrozen),
//  (h) pairingLegal 'banned' (both directions, symmetry, expiry, unranked
//      pool) and the display/opponent-info 'banned' surfaces.
//
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = resolve(ROOT, 'src/shared/accounts').replace(/\\/g, '/')

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
function throwsT2(fn, msg) {
  try {
    fn()
    ok(false, `${msg} (did not throw)`)
  } catch (e) {
    ok(e?.name === 'Tier2InputError', `${msg} (${e?.name}: ${String(e?.message).slice(0, 90)})`)
  }
}

async function bundleOnce(outdir, tag) {
  const entry = resolve(outdir, `entry-${tag}.ts`)
  // Import through the judge barrel so the index.ts export line is covered.
  writeFileSync(
    entry,
    `export * from '${SRC}/judge/index.ts'\n` +
      `export * as foldMod from '${SRC}/ratings/fold.ts'\n` +
      `export * as displayMod from '${SRC}/ratings/display.ts'\n` +
      `export * as pairingMod from '${SRC}/mm/pairing.ts'\n` +
      `export * as leaseMod from '${SRC}/witness/lease.ts'\n` +
      `export * as certsMod from '${SRC}/certs.ts'\n` +
      `export * as eventsMod from '${SRC}/events.ts'\n` +
      `export * as hashMod from '${SRC}/hash.ts'\n` +
      `export * as codecMod from '${SRC}/codec.ts'\n`,
  )
  const outfile = resolve(outdir, `tier2-${tag}.mjs`)
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

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-tier2-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

// ---- goldens (recorded from a green run 2026-07-21; determinism anchors) ----
// anchorsDigest re-recorded 2026-07-25: the bundle's `fit` provenance strings
// were repunctuated (no em dashes), which moves the canonical hash. Every
// integer in the bundle is unchanged, and both esbuild bundles still agree.
const GOLDEN = {
  anchorsDigest: 'mkAFC0PKOo0ZAAZNfbdsjrReZ089Zpwo31c6dkxUG50',
  saltBodyHashW1: 'EMf1-1qjkbb-VpnC_aTY_sEmtuyQ82P8cTCqJ39-q2Q',
  saltW1: 'UmqAcUJGZjz-2_9q9_REOPCo6gEsFcfBhlhXQxA34nE',
  saltW1A: 'Ikj5Aje9NFc1hiTc64XNY_P7JBFSH3fHQjnQ4d8pgWw', // A5-17 anchored window-1 salt (pinned 2026-07-22)
  saltW2: 'X5qH2s1LylhjC_NoBQWUpcOotBr6fGqsCGNfOqKG6c8',
  saltW3: 'G1i6YVj4I1uouNpNejL-CMshZRtCCn8GMGDjV8ECdxg',
  offW1: 9,
  offW2: 2,
  offW3: 23,
  devInno: -100632,
  devBlat: 3_000_000,
  devMet: 755_618,
  zInno30: -551_207,
  zBlat30: 16_432_353,
  zMet30: 4_138_860,
  zBlat1: 3_000_000,
  zBlat2: 4_243_281,
  zBlat3: 5_196_304,
  escAtIndex: 31,
  escZ: 3_411_623,
  // A5-21: the same 25-inno→blat chain's EARLIEST trailing-K window at the 5σ
  // CONVICTION line (zThresholdMicro). The §8 self-ban anchor (10 blat games).
  convAtIndex: 34,
  convZ: 5_109_979,
  // J7 lifetime goldens, hand-computed: zLife(W) = floor(Σz·1000/isqrt(W·1e6)).
  windowZCap: 23_043_875, // idiv(59·3e6·1000, isqrt(59e6)=7681) + 1
  zLife2x26: 3_677_510, // floor(5.2e9 / isqrt(2e6)=1414)
  zLife3x26: 4_503_464, // floor(7.8e9 / isqrt(3e6)=1732)
  zLife4x26: 5_200_000, // floor(10.4e9 / isqrt(4e6)=2000). Exact
  zLifeMix3: 1_732_101, // floor(3e9 / 1732)
  zLifeMet3: 7_168_926, // floor(3·4_138_860·1000 / 1732)
}

async function run(outdir) {
  console.log('· bundling src/shared/accounts (judge barrel incl. tier2 + fold/pairing/display) …')
  const m = await bundleOnce(outdir, 'a')
  const { foldMod, displayMod, pairingMod, leaseMod, certsMod, eventsMod, hashMod, codecMod } = m
  const { PARAMS_A5, PARAMS_A5_DIGEST } = m
  const K = PARAMS_A5.reganK
  const b64 = (v) => hashMod.toB64u(codecMod.canonicalHash(v))
  const stateHash = (s) => hashMod.toB64u(codecMod.canonicalHash(s))

  // ---- shared fixtures ------------------------------------------------------
  const LAD = 'blitz-300+0'
  const ROOTB = b64({ r: 'accused' })
  const side = (scored, acplMicro, matchMicro) => ({
    scored,
    unscored: 0,
    acplMicro,
    matched: 0,
    matchMicro,
    clockFitMicro: 500_000,
    clockN: scored,
  })
  const mkRec = (game, acplMicro, matchMicro, scored = 30, ladder = LAD) => ({
    v: 1,
    game,
    ladder,
    judge: b64({ j: game }),
    params: PARAMS_A5_DIGEST,
    w: side(scored, acplMicro, matchMicro),
    b: side(scored, 55_000_000, 400_000),
  })
  // SUITE-LOCAL synthetic anchor bundle (the former J4 placeholder values,
  // frozen as a fixture): the estimator is anchor-INJECTED, so this suite
  // exercises the exact arithmetic against fixed knots while the MEASURED
  // judge-config bundle (anchors.ts TIER2_ANCHORS_JUDGE, J6) is covered by
  // scripts/test-judge-calibration.mjs. Do not "update" these values: the
  // z/dev goldens below are bit-frozen against them.
  const A = {
    v: 1,
    acpl: m.TIER1_ANCHORS_PROVISIONAL,
    matchByElo: [
      { elo: 400, matchMicro: 340_000 },
      { elo: 800, matchMicro: 390_000 },
      { elo: 1200, matchMicro: 440_000 },
      { elo: 1600, matchMicro: 500_000 },
      { elo: 2000, matchMicro: 560_000 },
      { elo: 2400, matchMicro: 620_000 },
      { elo: 2700, matchMicro: 660_000 },
    ],
    sigmaMatchMicro: 120_000,
    fit: '[J3-REFIT-PENDING] hand-set match-rate placeholder at (t1Nodes, t1MultiPv). Must not feed T',
  }
  const inno = (i) => ({ rec: mkRec(`inno-${i}`, 52_000_000, 470_000), side: 'w', elo: 1500 })
  const blat = (i) => ({ rec: mkRec(`blat-${i}`, 8_000_000, 900_000), side: 'w', elo: 1500 })
  const met = (i) => ({ rec: mkRec(`met-${i}`, 39_000_000, 578_000), side: 'w', elo: 1500 })
  const w30 = (f) => Array.from({ length: 30 }, (_, i) => f(i))

  // ==== 1. commit-reveal salt ===============================================
  console.log('\n· §7b commit-reveal salt (lease-threshold-v1) …')
  const seeds = [1, 2, 3].map((i) => new Uint8Array(32).fill(i))
  const wkeys = seeds.map((s) => hashMod.toB64u(hashMod.ed25519.getPublicKey(s)))
  const mkReveal = (win, which = [0, 1, 2]) => ({
    v: 1,
    scheme: PARAMS_A5.saltScheme,
    root: ROOTB,
    ladder: LAD,
    window: win,
    grants: which.map((i) => m.signSaltGrant(ROOTB, LAD, win, wkeys[i], wkeys[i], seeds[i], 7_000 + i)),
  })

  eq(m.saltBodyHash(ROOTB, LAD, 1), GOLDEN.saltBodyHashW1, 'saltBodyHash golden (window 1)')
  eq(m.saltBodyHash(ROOTB, LAD, 1), m.saltBodyHash(ROOTB, LAD, 1), 'saltBodyHash deterministic')
  ok(m.saltBodyHash(ROOTB, LAD, 2) !== GOLDEN.saltBodyHashW1, 'different window ⇒ different salt body')
  ok(m.saltBodyHash(ROOTB, 'bullet-60+0', 1) !== GOLDEN.saltBodyHashW1, 'different ladder ⇒ different salt body')
  ok(m.saltBodyHash(b64({ r: 'other' }), LAD, 1) !== GOLDEN.saltBodyHashW1, 'different root ⇒ different salt body')
  throwsT2(() => m.saltBodyHash(ROOTB, '', 1), 'empty ladder refused')
  throwsT2(() => m.saltBodyHash(ROOTB, LAD, -1), 'negative window refused')

  // grant byte convention parity with witness/lease.ts
  const g0 = m.signSaltGrant(ROOTB, LAD, 1, wkeys[0], wkeys[0], seeds[0], 7_000)
  ok(leaseMod.verifyGrantSig(g0, m.saltBodyHash(ROOTB, LAD, 1)), 'salt grant verifies via lease.ts verifyGrantSig (exact grantBytes convention)')
  ok(!leaseMod.verifyGrantSig(g0, m.saltBodyHash(ROOTB, LAD, 2)), 'salt grant does not verify against another window body')

  const r1 = mkReveal(1)
  const salt1 = m.windowSalt(r1, { tLease: 2 })
  eq(hashMod.toB64u(salt1), GOLDEN.saltW1, 'windowSalt golden (window 1)')
  eq(hashMod.toB64u(m.windowSalt(mkReveal(1), { tLease: 2 })), GOLDEN.saltW1, 'recomputable-after: independent re-derivation is bit-identical')
  eq(hashMod.toB64u(m.windowSalt(mkReveal(2), { tLease: 2 })), GOLDEN.saltW2, 'windowSalt golden (window 2)')
  eq(hashMod.toB64u(m.windowSalt(mkReveal(3), { tLease: 2 })), GOLDEN.saltW3, 'windowSalt golden (window 3)')
  ok(GOLDEN.saltW1 !== GOLDEN.saltW2 && GOLDEN.saltW2 !== GOLDEN.saltW3, 'different windows ⇒ different salts')
  ok(
    hashMod.toB64u(m.windowSalt(mkReveal(1, [0, 1]), { tLease: 2 })) !==
      hashMod.toB64u(m.windowSalt(mkReveal(1, [1, 2]), { tLease: 2 })),
    'different grant subsets ⇒ different salts on the reveal-defined (no-witnessSet) fallback, pinned by witnessSet in §1a (A5-18)',
  )
  // grant order in the reveal must NOT matter (canonical sort by w)
  const rShuffled = { ...r1, grants: [r1.grants[2], r1.grants[0], r1.grants[1]] }
  eq(hashMod.toB64u(m.windowSalt(rShuffled, { tLease: 2 })), GOLDEN.saltW1, 'grant order in the reveal is canonicalized (sorted by w)')

  const v1 = m.verifySaltReveal(r1, { tLease: 2 })
  ok(v1.ok && v1.salt === GOLDEN.saltW1, 'verifySaltReveal ok + salt matches windowSalt')
  const tampered = { ...r1, grants: [{ ...r1.grants[0], sig: r1.grants[1].sig }, r1.grants[1], r1.grants[2]] }
  ok(!m.verifySaltReveal(tampered, { tLease: 2 }).ok, 'tampered grant signature ⇒ reveal rejected')
  throwsT2(() => m.windowSalt(tampered, { tLease: 3 }), 'windowSalt throws on an unproven reveal')
  ok(!m.verifySaltReveal(mkReveal(1, [0]), { tLease: 2 }).ok, 'below threshold ⇒ rejected')
  ok(!m.verifySaltReveal({ ...r1, grants: [r1.grants[0], r1.grants[0]] }, { tLease: 2 }).ok, 'duplicate grantor counts ONCE (2 copies ≠ 2 grantors)')
  ok(!m.verifySaltReveal({ ...r1, scheme: 'other-scheme' }, { tLease: 2 }).ok, 'foreign saltScheme rejected')
  const vSet = m.verifySaltReveal(mkReveal(1, [0]), { tLease: 2, witnessSet: [wkeys[0]] })
  ok(vSet.ok, 'witnessSet of 1: effective threshold max(1, min(tLease,1)) = 1 (lease.ts small-population rule)')
  ok(!m.verifySaltReveal(mkReveal(1, [1, 2]), { tLease: 2, witnessSet: [wkeys[0]] }).ok, 'grants outside the witness set never count')
  ok(!m.verifySaltReveal(r1, { tLease: 2, witnessSet: [wkeys[0]] }).ok, 'a reveal carrying ANY out-of-set grant is invalid (strict, exactly verifyLease)')

  const off1 = m.saltOffset(salt1)
  eq(off1, GOLDEN.offW1, 'saltOffset golden (window 1)')
  ok(off1 >= 0 && off1 < K, 'offset in [0, K)')
  eq(m.saltOffset(m.windowSalt(mkReveal(2), { tLease: 2 })), GOLDEN.offW2, 'saltOffset golden (window 2)')
  eq(m.saltOffset(m.windowSalt(mkReveal(3), { tLease: 2 })), GOLDEN.offW3, 'saltOffset golden (window 3)')
  throwsT2(() => m.saltOffset(new Uint8Array(3)), 'short salt refused')

  // ==== 1a. A5-18: witnessSet PINS the salt to the canonical threshold subset
  // The defect: countedGrants counted EVERY verifying in-set grant, so when
  // MORE than threshold canonical witnesses signed, the reveal assembler chose
  // which ≥threshold subset to publish and each subset produced a DIFFERENT
  // salt → a post-hoc boundary grind (§7b) and a cross-auditor partition split
  // (different z_w → divergent J7 lifetimeVerdict). The fix pins the salt to the
  // FULL CANONICAL THRESHOLD SET: the `threshold` smallest-NodeId members of the
  // witnessSet, in fixed order. Any SUPERSET of that set yields the SAME salt; a
  // subset omitting a designated grantor is refused.
  console.log('\n· A5-18: witnessSet pins the salt to the canonical threshold subset …')
  const wseeds = [10, 11, 12, 13, 14, 15].map((i) => new Uint8Array(32).fill(i))
  const wpubs = wseeds.map((s) => hashMod.toB64u(hashMod.ed25519.getPublicKey(s)))
  const WSET = wpubs // canonical witness set, N = 6
  const TL = 4 // grant threshold → designated = the 4 smallest-NodeId of WSET
  const opt18 = { tLease: TL, witnessSet: WSET }
  const grantAt = (win, i) => m.signSaltGrant(ROOTB, LAD, win, wpubs[i], wpubs[i], wseeds[i], 8_000 + i)
  const reveal18 = (win, idxs) => ({
    v: 1, scheme: PARAMS_A5.saltScheme, root: ROOTB, ladder: LAD, window: win,
    grants: idxs.map((i) => grantAt(win, i)),
  })
  const ord18 = [...WSET.keys()].sort((a, b) => codecMod.compareKeys(WSET[a], WSET[b]))
  const desig = ord18.slice(0, TL) // the pinned (designated) grantor indices
  const rest = ord18.slice(TL) // larger-NodeId witnesses (redundant availability)
  ok(rest.length >= 2, 'fixture: N − threshold ≥ 2 supra-threshold witnesses (to exercise grinding)')
  // the canonical designated-only reveal defines the salt
  const sDesig = m.verifySaltReveal(reveal18(5, desig), opt18)
  ok(sDesig.ok, 'the designated threshold subset alone verifies and defines the salt')
  // ANY superset of the designated set yields the IDENTICAL salt (no grind)
  const sAll = m.verifySaltReveal(reveal18(5, [...desig, ...rest]), opt18)
  const sSuper = m.verifySaltReveal(reveal18(5, [...desig, rest[0]]), opt18)
  ok(sAll.ok && sAll.salt === sDesig.salt, 'all N grants ⇒ the SAME salt (extra grants never enter it)')
  ok(sSuper.ok && sSuper.salt === sDesig.salt, 'designated + one extra ⇒ the SAME salt (pinned)')
  // cross-auditor consensus: two honest auditors holding DIFFERENT (both valid)
  // reveals derive the SAME salt → the SAME boundary offset → one partition
  const audA = m.verifySaltReveal(reveal18(5, [...desig, rest[0]]), opt18)
  const audB = m.verifySaltReveal(reveal18(5, [rest[1], ...desig]), opt18)
  ok(audA.ok && audB.ok && audA.salt === audB.salt, 'two honest auditors with DIFFERENT reveals derive the SAME salt')
  eq(
    m.saltOffset(hashMod.fromB64u(audA.salt)),
    m.saltOffset(hashMod.fromB64u(audB.salt)),
    '… hence the SAME saltOffset / window boundary: no cross-auditor partition split (A4-04 class closed)',
  )
  // a ≥threshold subset OMITTING a designated (small-NodeId) grantor is refused:
  // the assembler cannot drop a pinned witness to shift off(w)
  const omitReveal = reveal18(5, [...desig.slice(1), rest[0]]) // size = threshold, but desig[0] absent
  const omit = m.verifySaltReveal(omitReveal, opt18)
  ok(!omit.ok, 'a ≥threshold subset omitting a designated grantor is REFUSED (subset not pinnable)')
  ok(
    omit.errors.some((e) => e.includes('canonical grantor') && e.includes('pinned threshold subset')),
    '… with the deterministic pinned-subset error',
  )
  throwsT2(() => m.windowSalt(omitReveal, opt18), 'windowSalt throws when the pinned subset is incomplete')
  // strict membership still holds under pinning: an out-of-set grant invalidates
  const wOther = hashMod.toB64u(hashMod.ed25519.getPublicKey(new Uint8Array(32).fill(99)))
  const outReveal = { ...reveal18(5, desig), grants: [...reveal18(5, desig).grants, m.signSaltGrant(ROOTB, LAD, 5, wOther, wOther, new Uint8Array(32).fill(99), 9_000)] }
  ok(!m.verifySaltReveal(outReveal, opt18).ok, 'a reveal carrying ANY out-of-set grant is still invalid (strict, exactly verifyLease)')
  // CONTRAST, WITHOUT a witnessSet the salt is reveal-defined (NOT grind-proof):
  // the very subsets that agree above now disagree (the residual the header names)
  const grindA = hashMod.toB64u(m.windowSalt(reveal18(5, [...desig, rest[0]]), { tLease: TL }))
  const grindB = hashMod.toB64u(m.windowSalt(reveal18(5, [...desig, ...rest]), { tLease: TL }))
  ok(grindA !== grindB, 'WITHOUT witnessSet the same window admits DIFFERENT salts per subset (the grind the witnessSet path closes)')

  // ==== 1b. A5-17: post-game anchor makes the frontier uncomputable-before ===
  // The defect: saltBody committed only to {v,t,scheme,root,ladder,window}.
  // Every field fixed at account creation, so windowSalt(w), off(w) and the
  // whole future partition were derivable at t=0 from a threshold of grants
  // (an honest witness could even pre-sign all future windows). §7b requires
  // the frontier to be NOT locally predictable BEFORE the games are played.
  // The fix folds an OPTIONAL post-game `anchor` (a 32-byte commitment to chain
  // state fixed only after the games preceding b(w) are played. The embedder
  // binds the rated-game key at ordinal w·K−1) into the SIGNED salt body, so
  // the witness's message does not exist until that game is chained, and
  // SaltVerifyOpts.requireAnchor makes the consensus/verdict path refuse any
  // anchorless (predictable-before) reveal. RESIDUAL (deferred, cross-lane):
  // witness signing-time discipline + the embedder wiring that derives the
  // anchor from the chain.
  console.log('\n· A5-17: post-game anchor binds the salt to chain fixed only after the games …')
  const ANCHOR = hashMod.toB64u(hashMod.sha256(hashMod.utf8('cs:a5:t2anchor: rated game @ ordinal w·K−1 (x)')))
  const ANCHOR2 = hashMod.toB64u(hashMod.sha256(hashMod.utf8('cs:a5:t2anchor: rated game @ ordinal w·K−1 (y)')))
  const mkRevealA = (win, anchor, which = [0, 1, 2]) => ({
    v: 1, scheme: PARAMS_A5.saltScheme, root: ROOTB, ladder: LAD, window: win, anchor,
    grants: which.map((i) => m.signSaltGrant(ROOTB, LAD, win, wkeys[i], wkeys[i], seeds[i], 7_000 + i, anchor)),
  })
  // the anchor enters the SIGNED salt body → a different body, a different salt
  const bodyA = m.saltBodyHash(ROOTB, LAD, 1, ANCHOR)
  ok(bodyA !== GOLDEN.saltBodyHashW1, 'anchored salt body ≠ the anchorless (t=0-static) body')
  eq(m.saltBodyHash(ROOTB, LAD, 1), GOLDEN.saltBodyHashW1, 'anchorless body byte-identical to the pre-A5-17 golden (legacy path unchanged)')
  eq(m.saltBodyHash(ROOTB, LAD, 1, ANCHOR), bodyA, 'anchored salt body deterministic')
  ok(m.saltBodyHash(ROOTB, LAD, 1, ANCHOR2) !== bodyA, 'a DIFFERENT post-game anchor ⇒ a different body (the frontier is not fixed at t=0)')
  throwsT2(() => m.saltBodyHash(ROOTB, LAD, 1, 'not-a-32-byte-b64u'), 'a malformed anchor is refused')
  const rA = mkRevealA(1, ANCHOR)
  const saltA = hashMod.toB64u(m.windowSalt(rA, { tLease: 2 }))
  eq(saltA, GOLDEN.saltW1A, 'anchored windowSalt golden (window 1)')
  ok(saltA !== GOLDEN.saltW1, 'anchored salt ≠ the anchorless salt (post-game entropy enters via the grant sigs)')
  eq(hashMod.toB64u(m.windowSalt(mkRevealA(1, ANCHOR), { tLease: 2 })), GOLDEN.saltW1A, 'recomputable-after: same anchor ⇒ bit-identical salt')
  const saltA2 = hashMod.toB64u(m.windowSalt(mkRevealA(1, ANCHOR2), { tLease: 2 }))
  ok(saltA2 !== saltA, 'a different post-game anchor ⇒ a different salt (unpredictable before the anchor game is chained)')
  ok(
    m.saltOffset(hashMod.fromB64u(saltA)) !== m.saltOffset(hashMod.fromB64u(saltA2)),
    '… hence a different off(1): the K-window frontier MOVES with post-game chain state, not a line fixed at account creation',
  )
  // the anchor is BOUND into every grant signature: a post-hoc swap invalidates
  const swapped = { ...rA, anchor: ANCHOR2 } // grants signed over ANCHOR; field claims ANCHOR2
  ok(!m.verifySaltReveal(swapped, { tLease: 2 }).ok, 'a post-hoc anchor swap ⇒ every grant fails verifyGrantSig ⇒ reveal rejected (unforgeable)')
  // requireAnchor gate: the consensus/verdict path refuses an anchorless reveal
  const needA = m.verifySaltReveal(mkReveal(1), { tLease: 2, requireAnchor: true })
  ok(!needA.ok, 'requireAnchor: an anchorless (predictable-before) reveal is REFUSED on the consensus path')
  ok(needA.errors.some((e) => e.includes('requireAnchor') && e.includes('unpredictable-before')), '… with the deterministic §7b error')
  ok(m.verifySaltReveal(rA, { tLease: 2, requireAnchor: true }).ok, 'requireAnchor: an anchored reveal verifies')
  throwsT2(() => m.windowSalt(mkReveal(1), { tLease: 2, requireAnchor: true }), 'windowSalt throws on an anchorless reveal when requireAnchor is set')
  // composes with the A5-18 witnessSet pin (grind-proof AND unpredictable-before)
  const anchored18 = {
    ...reveal18(5, desig), anchor: ANCHOR,
    grants: desig.map((i) => m.signSaltGrant(ROOTB, LAD, 5, wpubs[i], wpubs[i], wseeds[i], 8_000 + i, ANCHOR)),
  }
  ok(m.verifySaltReveal(anchored18, { ...opt18, requireAnchor: true }).ok, 'requireAnchor + witnessSet: an anchored, pinned reveal verifies (both defenses compose)')

  // ==== 2. salted window partition ==========================================
  console.log('\n· boundary-jitter window partition …')
  const offs = { 1: GOLDEN.offW1, 2: GOLDEN.offW2, 3: GOLDEN.offW3, 4: 0 }
  const offsetOf = (w) => offs[w] ?? 0
  eq(m.windowStart(0, offsetOf), 0, 'b(0) = 0')
  eq(m.windowStart(1, offsetOf), K + GOLDEN.offW1, 'b(1) = K + off(1)')
  eq(m.windowStart(2, offsetOf), 2 * K + GOLDEN.offW2, 'b(2) = 2K + off(2)')
  const b0 = m.windowBounds(0, offsetOf)
  const b1 = m.windowBounds(1, offsetOf)
  const b2 = m.windowBounds(2, offsetOf)
  eq(b0.end, b1.start, 'windows 0/1 contiguous')
  eq(b1.end, b2.start, 'windows 1/2 contiguous')
  for (const [i, b] of [b0, b1, b2].entries()) {
    const size = b.end - b.start
    ok(size >= 1 && size <= 2 * K - 1, `window ${i} size ${size} ∈ [1, 2K−1]`)
  }
  eq(m.windowIndexOfOrdinal(0, offsetOf), 0, 'ordinal 0 → window 0')
  eq(m.windowIndexOfOrdinal(b1.start - 1, offsetOf), 0, 'last ordinal of window 0')
  eq(m.windowIndexOfOrdinal(b1.start, offsetOf), 1, 'first ordinal of window 1')
  eq(m.windowIndexOfOrdinal(b2.start - 1, offsetOf), 1, 'last ordinal of window 1')
  eq(m.windowIndexOfOrdinal(b2.start, offsetOf), 2, 'first ordinal of window 2')
  // full roundtrip over a span
  let roundtrip = true
  for (let o = 0; o < 4 * K; o++) {
    const w = m.windowIndexOfOrdinal(o, offsetOf)
    const b = m.windowBounds(w, offsetOf)
    if (!(o >= b.start && o < b.end)) roundtrip = false
  }
  ok(roundtrip, `ordinal↔window roundtrip holds over [0, ${4 * K})`)
  const list = Array.from({ length: 70 }, (_, i) => `g${i}`)
  const wg1 = m.windowGames(list, 1, offsetOf)
  eq(wg1.length, b1.end - b1.start, 'windowGames slices the full window 1')
  eq(wg1[0], `g${b1.start}`, 'window 1 starts at b(1)')
  const wg2 = m.windowGames(list, 2, offsetOf)
  eq(wg2.length, 70 - b2.start, 'still-open window 2 returns the partial slice')
  // salt-dependence: a different salt map ⇒ a different partition
  const offsetOfB = (w) => (w === 0 ? 0 : (offs[w] + 1) % K)
  ok(m.windowStart(1, offsetOfB) !== m.windowStart(1, offsetOf), 'different salt ⇒ different boundary (unpredictable-before consequence)')
  throwsT2(() => m.windowStart(1, () => K), 'offsetOf out of range refused')
  throwsT2(() => m.windowStart(1, () => 1.5), 'non-integer offset refused')

  // ==== 3. the z estimator ==================================================
  console.log('\n· Regan-style z estimator …')
  eq(m.tier2AnchorsDigest(A), GOLDEN.anchorsDigest, 'anchors digest golden')
  ok(
    m.TIER2_ANCHORS_JUDGE.v === 1 && !m.TIER2_ANCHORS_JUDGE.fit.includes('PENDING'),
    'the MEASURED anchor bundle (TIER2_ANCHORS_JUDGE) loads via the barrel and is not a pending placeholder',
  )
  eq(m.expectedMatchMicro(A, 1500), 485_000, 'expectedMatchMicro interpolation golden (1500)')
  eq(m.expectedMatchMicro(A, 1400), 470_000, 'expectedMatchMicro interpolation golden (1400)')
  eq(m.expectedMatchMicro(A, 399), 340_000, 'expectedMatchMicro clamps below the first knot')
  eq(m.expectedMatchMicro(A, 2800), 660_000, 'expectedMatchMicro clamps above the last knot')
  eq(m.expectedMatchMicro(A, 1200), 440_000, 'expectedMatchMicro exact at a knot')

  eq(m.isqrt(0), 0, 'isqrt(0) = 0')
  eq(m.isqrt(24), 4, 'isqrt floor on non-squares')
  eq(m.isqrt(25), 5, 'isqrt exact on squares')
  eq(m.isqrt(1_000_000), 1000, 'isqrt(1e6) = 1000')
  eq(m.isqrt(2_000_000), 1414, 'isqrt(2e6) = 1414')
  eq(m.isqrt(30_000_000), 5477, 'isqrt(30e6) = 5477')
  throwsT2(() => m.isqrt(-1), 'isqrt refuses negatives')

  eq(m.gameDevMicro(inno(0), A), GOLDEN.devInno, 'per-game deviation golden: innocent (≈ −0.1σ)')
  eq(m.gameDevMicro(blat(0), A), GOLDEN.devBlat, 'per-game deviation golden: blatant HITS the +3σ cap')
  eq(m.gameDevMicro(met(0), A), GOLDEN.devMet, 'per-game deviation golden: metered (≈ +0.76σ)')
  eq(m.gameDevMicro({ rec: mkRec('worst', 2_000_000_000, 0), side: 'w', elo: 1500 }, A), -3_000_000, 'catastrophic play clamps at −3σ (cap is two-sided)')
  eq(m.gameDevMicro({ rec: mkRec('empty', 0, 0, 0), side: 'w', elo: 1500 }, A), null, 'scored = 0 ⇒ null (no evidence, never “perfect play”)')

  const vInno = m.windowVerdict(w30(inno), A)
  eq(vInno.zMicro, GOLDEN.zInno30, 'innocent 30-game window: exact zMicro (far below)')
  ok(!vInno.convicted && !vInno.escalate, 'innocent window: no conviction, no escalation')
  eq(vInno.scoredGames, 30, 'innocent window: 30 scored games')
  const vBlat = m.windowVerdict(w30(blat), A)
  eq(vBlat.zMicro, GOLDEN.zBlat30, 'blatant 30-game window: exact zMicro (far above)')
  ok(vBlat.convicted && vBlat.escalate, 'blatant window: convicted + escalate')
  const vMet = m.windowVerdict(w30(met), A)
  eq(vMet.zMicro, GOLDEN.zMet30, 'metered 30-game window: exact zMicro')
  ok(vMet.escalate && !vMet.convicted, 'threshold-ε metered window lands between zEscalate and zThreshold: escalate-NOT-convict')
  ok(vMet.zMicro >= PARAMS_A5.zEscalateMicro && vMet.zMicro < PARAMS_A5.zThresholdMicro, 'metered zMicro sits inside [zEscalate, zThreshold)')

  const v1g = m.windowVerdict([blat(0)], A)
  eq(v1g.zMicro, GOLDEN.zBlat1, 'single maximally-blatant game: z = exactly the 3σ cap')
  ok(!v1g.convicted, 'NO SINGLE GAME CONVICTS: structurally impossible (cap)')
  ok(v1g.escalate, 'a single capped game CAN meet the escalation trigger (deeper analysis only)')
  const v2g = m.windowVerdict(w30(blat).slice(0, 2), A)
  eq(v2g.zMicro, GOLDEN.zBlat2, 'two maximally-blatant games: exact zMicro')
  ok(!v2g.convicted, 'two games can never convict either (2·3σ/√2 < 5σ)')
  const v3g = m.windowVerdict(w30(blat).slice(0, 3), A)
  eq(v3g.zMicro, GOLDEN.zBlat3, 'three maximally-blatant games: exact zMicro')
  ok(v3g.convicted, 'three maximally-blatant games are the conviction floor')

  const mixed = [inno(0), { rec: mkRec('un', 0, 0, 0), side: 'w', elo: 1500 }]
  const vMixed = m.windowVerdict(mixed, A)
  eq(vMixed.games, 2, 'unscored game counts in games')
  eq(vMixed.scoredGames, 1, 'unscored game excluded from scoredGames')
  eq(vMixed.zMicro, GOLDEN.devInno, 'n_eff = 1 ⇒ zMicro is the lone scored deviation')
  eq(m.windowVerdict([], A).zMicro, 0, 'empty window ⇒ z = 0')

  throwsT2(() => m.windowVerdict([inno(0), { rec: mkRec('x', 1, 1, 1, 'other-ladder'), side: 'w', elo: 1500 }], A), 'mixed ladders refused')
  throwsT2(() => m.windowVerdict([{ ...inno(0), side: 'x' }], A), 'bad side refused')
  throwsT2(() => m.windowVerdict([{ rec: { ...inno(0).rec, params: 'A'.repeat(43) }, side: 'w', elo: 1500 }], A), 'foreign params digest refused')
  throwsT2(() => m.windowVerdict(Array.from({ length: 2 * K }, (_, i) => inno(i)), A), 'entries beyond WINDOW_ENTRIES_MAX refused')
  throwsT2(() => m.windowVerdict([{ rec: { ...inno(0).rec, w: { ...inno(0).rec.w, matchMicro: 1_000_001 } }, side: 'w', elo: 1500 }], A), 'matchMicro out of range refused')
  throwsT2(() => m.gameDevMicro(inno(0), { ...A, sigmaMatchMicro: 0 }), 'zero sigma refused')

  // ==== 3a. A5-02 regression: RD-aware upper-confidence scoring =============
  // The defect: gameDevMicro scored against the fold's LAGGING point-estimate
  // display rating, so a fresh honest-2700 account climbing from the 1200
  // seed carries the same positive deviation on every window game and
  // aggregates past the §8 escalation trigger. The fix scores at
  // effElo = elo + floor(2·rdMicro/1e6) when the fold RD is supplied;
  // rdMicro ABSENT is byte-identical legacy (all goldens above unaffected).
  console.log('\n· A5-02 regression: rdMicro upper-confidence strength (real TIER2_ANCHORS_JUDGE) …')
  const AJ = m.TIER2_ANCHORS_JUDGE
  // Honest true-2700 signals: the J6 corpus honest-2700 band means the
  // finding reproduced with (acpl 25.22cp, match 0.9388).
  const H_ACPL = 25_222_111
  const H_MATCH = 938_809
  // Deterministic fresh-account climb (the finding's sustained-lag model:
  // display enters game 29 at ~2030 while RD stays placement-high. A young
  // opponent pool carries little rating information, so lag persists exactly
  // while RD is large).
  const eloAt = (i) => (i < 10 ? 1200 + 60 * i : 1800 + 12 * (i - 10))
  const rdAt = (i) => (i === 0 ? 350_000_000 : i < 10 ? 300_000_000 : 300_000_000 - 5_000_000 * (i - 10))
  const climb = (tag, acpl, match, withRd) =>
    Array.from({ length: 30 }, (_, i) => ({
      rec: mkRec(`${tag}-${i}`, acpl, match),
      side: 'w',
      elo: eloAt(i),
      ...(withRd ? { rdMicro: rdAt(i) } : {}),
    }))
  const vHonOld = m.windowVerdict(climb('a502-h-old', H_ACPL, H_MATCH, false), AJ)
  const vHonNew = m.windowVerdict(climb('a502-h-new', H_ACPL, H_MATCH, true), AJ)
  console.log(`    honest true-2700 fresh climb: z(no rd) = ${vHonOld.zMicro}, z(rd) = ${vHonNew.zMicro}`)
  ok(
    vHonOld.zMicro >= PARAMS_A5.zEscalateMicro,
    `rd-ABSENT path reproduces the A5-02 defect: honest fresh climb escalates (z = ${vHonOld.zMicro} ≥ 3e6)`,
  )
  ok(
    vHonNew.zMicro < PARAMS_A5.zEscalateMicro && !vHonNew.escalate && !vHonNew.convicted,
    `rd-PRESENT path: the same honest games stay below the escalation trigger (z = ${vHonNew.zMicro} < 3e6)`,
  )
  // Settled honest account (RD at the floor ≈ 30): z essentially unchanged.
  // The J6-calibrated honest-holdout FPR is preserved (shift is ≤ 0.3σ and
  // DOWNWARD, so it cannot mint new false positives).
  const settled = (tag, rd) =>
    Array.from({ length: 30 }, (_, i) => ({
      rec: mkRec(`${tag}-${i}`, 28_326_545, 924_137),
      side: 'w',
      elo: 2500,
      ...(rd ? { rdMicro: 30_000_000 } : {}),
    }))
  const vSetOld = m.windowVerdict(settled('a502-s-old', false), AJ)
  const vSetNew = m.windowVerdict(settled('a502-s-new', true), AJ)
  console.log(`    settled honest 2500: z(no rd) = ${vSetOld.zMicro}, z(RD 30) = ${vSetNew.zMicro}`)
  ok(
    Math.abs(vSetNew.zMicro - vSetOld.zMicro) <= 300_000 && vSetNew.zMicro <= vSetOld.zMicro,
    `settled account (RD floor 30): |Δz| ≤ 0.3σ and non-positive (${vSetOld.zMicro} → ${vSetNew.zMicro}), calibrated FPR preserved`,
  )
  ok(!vSetNew.escalate && !vSetNew.convicted, 'settled honest account: still no flags with rdMicro supplied')
  // Full-engine cheater (acpl 0, match 1.0) with the SAME high-RD climb must
  // STILL convict within one window: the fix opens no cheating hole.
  const vCheat = m.windowVerdict(climb('a502-c', 0, 1_000_000, true), AJ)
  console.log(`    full-engine cheater, same high RD: z = ${vCheat.zMicro}`)
  ok(
    vCheat.convicted && vCheat.zMicro >= PARAMS_A5.zThresholdMicro,
    `full-engine cheater with the same high RD still CONVICTS in one window (z = ${vCheat.zMicro} ≥ 5e6)`,
  )
  // rdMicro = 0 is byte-identical to the rd-absent path (effElo = elo).
  eq(m.gameDevMicro({ ...inno(0), rdMicro: 0 }, A), GOLDEN.devInno, 'rdMicro = 0 ⇒ byte-identical to the rd-absent deviation golden')
  // escalationDue threads rdMicro from LadderGameRef into the entries.
  const escEntries = climb('a502-e', H_ACPL, H_MATCH, true)
  const escRecs = new Map(escEntries.map((e) => [e.rec.game, e.rec]))
  const escWithRd = escEntries.map((e) => ({ game: e.rec.game, side: e.side, elo: e.elo, rdMicro: e.rdMicro }))
  const escNoRd = escEntries.map((e) => ({ game: e.rec.game, side: e.side, elo: e.elo }))
  eq(m.escalationDue(escWithRd, escRecs, AJ).due, false, 'escalationDue threads rdMicro: honest fresh climb no longer trips the §8 trigger')
  eq(m.escalationDue(escNoRd, escRecs, AJ).due, true, 'same games without rdMicro still trip it (legacy path unchanged when RD is not supplied)')
  // fail-closed on malformed rdMicro
  throwsT2(() => m.gameDevMicro({ ...inno(0), rdMicro: -1 }, A), 'negative rdMicro refused')
  throwsT2(() => m.gameDevMicro({ ...inno(0), rdMicro: 1.5 }, A), 'non-integer rdMicro refused')
  throwsT2(() => m.gameDevMicro({ ...inno(0), rdMicro: 1_000_000_001 }, A), 'rdMicro beyond the validation bound refused')

  // ==== 3b. J7 cross-window lifetime accumulation ===========================
  console.log('\n· lifetime accumulation (z-sum-over-sqrt-windows-v1) …')
  eq(PARAMS_A5.lifetimeScheme, 'z-sum-over-sqrt-windows-v1', 'params pin the lifetime scheme')
  eq(m.WINDOW_Z_CAP_MICRO, GOLDEN.windowZCap, 'structural window-z bound golden (±3σ cap · √WINDOW_ENTRIES_MAX)')
  const lvMet1 = m.lifetimeVerdict([GOLDEN.zMet30])
  eq(lvMet1.zLifeMicro, GOLDEN.zMet30, 'W=1 degeneracy: z_life ≡ the window z bit-for-bit (isqrt(1e6) = 1000)')
  ok(lvMet1.escalate && !lvMet1.convicted, 'W=1 metered: escalate-not-convict. The SAME thresholds, no new dials')
  eq(m.lifetimeVerdict([GOLDEN.zInno30]).zLifeMicro, GOLDEN.zInno30, 'W=1 degeneracy holds for a negative window z')
  const met26 = 2_600_000 // the §7(a) gap: sustained just-under-escalation metering
  const lv2 = m.lifetimeVerdict([met26, met26])
  eq(lv2.zLifeMicro, GOLDEN.zLife2x26, 'sustained 2.6σ, W=2: exact zLifeMicro (hand: floor(5.2e9/1414))')
  ok(lv2.escalate && !lv2.convicted, 'sustained 2.6σ crosses ESCALATION at W=2 (per-window it never would)')
  const lv3 = m.lifetimeVerdict([met26, met26, met26])
  eq(lv3.zLifeMicro, GOLDEN.zLife3x26, 'sustained 2.6σ, W=3: exact zLifeMicro')
  ok(lv3.escalate && !lv3.convicted, 'W=3 still under conviction')
  const lv4 = m.lifetimeVerdict([met26, met26, met26, met26])
  eq(lv4.zLifeMicro, GOLDEN.zLife4x26, 'sustained 2.6σ, W=4: exact zLifeMicro (2.6·√4 = 5.2, exact)')
  ok(lv4.convicted, 'sustained 2.6σ CONVICTS at W=4: the §7(a) closure')
  eq(lv4.windows, 4, 'windows echoes W')
  eq(m.lifetimeVerdict([3_000_000, -3_000_000]).zLifeMicro, 0, 'mixed-sign windows cancel (honest drift does not accumulate)')
  const lvMix = m.lifetimeVerdict([5_000_000, -1_000_000, -1_000_000])
  eq(lvMix.zLifeMicro, GOLDEN.zLifeMix3, 'partial cancellation: exact zLifeMicro')
  ok(!lvMix.escalate, 'one hot window diluted by clean windows: below escalation (no ratchet)')
  eq(m.lifetimeVerdict([-1, -1, -1]).zLifeMicro, -2, 'floor toward −∞ on negative sums (idiv convention)')
  const lv0 = m.lifetimeVerdict([])
  ok(lv0.zLifeMicro === 0 && lv0.windows === 0 && !lv0.escalate && !lv0.convicted, 'no closed windows: empty statistic, no flags')
  eq(m.lifetimeVerdict([GOLDEN.windowZCap]).zLifeMicro, GOLDEN.windowZCap, 'window-z bound is inclusive')
  eq(
    JSON.stringify(m.lifetimeVerdict([met26, met26])),
    JSON.stringify(lv2),
    'lifetimeVerdict is deterministic (same inputs ⇒ same bits)',
  )
  throwsT2(() => m.lifetimeVerdict([1.5]), 'non-integer window z refused')
  throwsT2(() => m.lifetimeVerdict([GOLDEN.windowZCap + 1]), 'window z beyond the structural bound refused')
  throwsT2(() => m.lifetimeVerdict([-GOLDEN.windowZCap - 1]), 'negative bound enforced too')
  throwsT2(() => m.lifetimeVerdict(Array.from({ length: m.LIFETIME_WINDOWS_MAX + 1 }, () => 0)), 'beyond LIFETIME_WINDOWS_MAX refused')
  throwsT2(() => m.lifetimeVerdict('junk'), 'non-array refused')

  // ==== 4. the deterministic escalation trigger =============================
  console.log('\n· escalationDue (trailing-K, protocol-defined) …')
  const games = []
  const records = new Map()
  for (let i = 0; i < 40; i++) {
    const e = i < 25 ? inno(i) : blat(i)
    games.push({ game: e.rec.game, side: 'w', elo: 1500 })
    records.set(e.rec.game, e.rec)
  }
  const esc = m.escalationDue(games, records, A)
  ok(esc.due, 'trigger fires on the 25-innocent → blatant fixture')
  eq(esc.atIndex, GOLDEN.escAtIndex, 'earliest trailing-K firing index golden')
  eq(esc.game, `blat-${GOLDEN.escAtIndex}`, 'the K-window-completing game key (the §8 deadline anchor)')
  eq(esc.zMicro, GOLDEN.escZ, 'trailing-K zMicro at the firing point golden')
  // A5-21: the SAME chain also crosses the 5σ CONVICTION line three windows
  // later: reported independently under `conviction` (the §8 self-ban
  // anchor), while atIndex/zMicro stay the 3σ escalation firing.
  ok(esc.conviction !== undefined, 'A5-21: the blatant chain reaches the 5σ conviction line')
  eq(esc.conviction?.atIndex, GOLDEN.convAtIndex, 'A5-21: earliest CONVICTING trailing-K index golden (34, not the 3σ index 31)')
  eq(esc.conviction?.game, `blat-${GOLDEN.convAtIndex}`, 'A5-21: the conviction-completing game key, THE §8 self-ban deadline anchor')
  eq(esc.conviction?.zMicro, GOLDEN.convZ, 'A5-21: zMicro at the conviction point golden (≥ zThresholdMicro)')
  ok(esc.conviction?.lifetime === undefined, 'A5-21: no lifetime conviction on the 3-arg call')
  const esc2 = m.escalationDue(games, records, A)
  eq(JSON.stringify(esc2), JSON.stringify(esc), 'escalationDue is deterministic (same inputs ⇒ same bits)')
  // A5-21: a chain truncated BEFORE the conviction crossing escalates but
  // carries NO conviction. The [3σ,5σ) band obliges deeper analysis only.
  const escBand = m.escalationDue(games.slice(0, GOLDEN.convAtIndex), records, A)
  ok(escBand.due, 'A5-21: the escalation-band chain (max z 4.54σ < 5σ) still escalates')
  eq(escBand.atIndex, GOLDEN.escAtIndex, 'A5-21: …at the same earliest 3σ firing')
  eq(escBand.conviction, undefined, 'A5-21: …but carries NO conviction. The 5σ line was never crossed')
  eq(m.escalationDue(games.slice(0, K - 1), records, A).due, false, 'fewer than K games ⇒ never due')
  const innoGames = []
  const innoRecs = new Map()
  for (let i = 0; i < 40; i++) {
    const e = inno(i)
    innoGames.push({ game: e.rec.game, side: 'w', elo: 1500 })
    innoRecs.set(e.rec.game, e.rec)
  }
  eq(m.escalationDue(innoGames, innoRecs, A).due, false, 'all-innocent 40 games ⇒ not due')
  throwsT2(() => m.escalationDue(games, innoRecs, A), 'missing Tier1Record fails CLOSED (unjudged rated game = non-compliance)')

  // J7 + A5-20 regression: the closedWindowZs lifetime arm is evaluated
  // INDEPENDENTLY of trailing-K. A trailing-K firing must NOT silently discard
  // an earlier-in-chain-order lifetime firing: doing so anchors the §8
  // self-ban deadline too late (a provable-suppressor / consensus split).
  // Pre-fix this call returned esc verbatim (lifetime dropped); post-fix BOTH
  // arms are surfaced so the partition-holding caller can min by chain ordinal.
  const escBoth = m.escalationDue(games, records, A, [met26, met26])
  eq(escBoth.atIndex, GOLDEN.escAtIndex, 'A5-20: trailing-K anchor still reported when both arms fire')
  eq(escBoth.game, `blat-${GOLDEN.escAtIndex}`, 'A5-20: trailing-K game key preserved')
  eq(escBoth.zMicro, GOLDEN.escZ, 'A5-20: trailing-K zMicro preserved')
  ok(escBoth.lifetime !== undefined, 'A5-20: the earlier lifetime firing is NO LONGER discarded when trailing-K also fires')
  eq(escBoth.lifetime?.windows, 2, 'A5-20: lifetime reports the earliest escalating prefix (W=2)')
  eq(escBoth.lifetime?.zLifeMicro, GOLDEN.zLife2x26, 'A5-20: lifetime carries the exact zLifeMicro at that W')
  ok(esc.lifetime === undefined, 'A5-20: the 3-arg call carries no lifetime key (byte-unchanged legacy path)')
  eq(
    JSON.stringify(m.escalationDue(games, records, A, [met26, met26])),
    JSON.stringify(escBoth),
    'A5-20: both-arms result is deterministic (same inputs ⇒ same bits)',
  )
  // The finding's exact shape: lifetime escalates at W=1 (~one closed window
  // in, BEFORE the trailing-K firing at index 31) yet the pre-fix code
  // returned {due,atIndex:31,lifetime:undefined}, dropping the earlier
  // trigger. Post-fix the W=1 firing is surfaced alongside the trailing-K
  // anchor so the caller anchors the deadline on the earlier (lifetime) game.
  const escEarlyLife = m.escalationDue(games, records, A, [3_000_000])
  ok(escEarlyLife.lifetime !== undefined, 'A5-20: the earlier W=1 lifetime firing is surfaced even though trailing-K fired later')
  eq(escEarlyLife.lifetime?.windows, 1, 'A5-20: the earliest escalating prefix is W=1 (the earlier trigger)')
  eq(escEarlyLife.lifetime?.zLifeMicro, 3_000_000, 'A5-20: W=1 zLifeMicro = the single closed-window z')
  eq(escEarlyLife.atIndex, GOLDEN.escAtIndex, 'A5-20: trailing-K anchor also present (caller mins the two by chain ordinal)')
  const escLife = m.escalationDue(innoGames, innoRecs, A, [met26, met26, 9_000_000])
  ok(escLife.due && escLife.lifetime !== undefined, 'lifetime-only firing: due via closed windows when trailing-K never fires')
  eq(escLife.lifetime?.windows, 2, 'fires at the EARLIEST escalating prefix W (2, not 3)')
  eq(escLife.lifetime?.zLifeMicro, GOLDEN.zLife2x26, 'lifetime firing carries the exact zLifeMicro at that W')
  eq(escLife.atIndex, undefined, 'lifetime firing has no trailing-K anchor (the partition-holding caller maps window→ordinal)')
  // A5-21: the third closed window (9e6) pushes the lifetime statistic over
  // the 5σ conviction line: reported under conviction.lifetime (earliest
  // CONVICTING prefix W=3), while lifetime keeps the earliest ESCALATING
  // prefix (W=2). floor((2.6+2.6+9)e6·1000/isqrt(3e6)=1732) = 8_198_614.
  eq(escLife.conviction?.lifetime?.windows, 3, 'A5-21: earliest lifetime CONVICTION prefix (W=3) reported independently of the W=2 escalation')
  eq(escLife.conviction?.lifetime?.zLifeMicro, 8_198_614, 'A5-21: lifetime conviction zLife golden')
  eq(escLife.conviction?.atIndex, undefined, 'A5-21: no trailing-K conviction on an all-innocent game list')
  // ── A5-21 review pin: the conviction report is LOSSLESS BOTH-ARMS (the
  // A5-20 contract at the conviction line) and EARLIEST-prefix on each arm.
  // Both arms convict here: trailing-K at index 34 AND the metering lifetime
  // at W=4. Neither may suppress the other (mutant M6: guarding the
  // lifetime conviction on trailingKConv === undefined went undetected).
  const escBothConv = m.escalationDue(games, records, A, [met26, met26, met26, met26])
  eq(escBothConv.conviction?.atIndex, GOLDEN.convAtIndex, 'A5-21: both-arms conviction, trailing-K anchor present')
  eq(escBothConv.conviction?.zMicro, GOLDEN.convZ, 'A5-21: both-arms conviction, trailing-K z preserved')
  eq(escBothConv.conviction?.lifetime?.windows, 4, 'A5-21: both-arms conviction. The lifetime conviction is NOT discarded when trailing-K also convicts')
  eq(escBothConv.conviction?.lifetime?.zLifeMicro, GOLDEN.zLife4x26, 'A5-21: both-arms conviction. Lifetime zLife preserved')
  // Earliest CONVICTING prefix, not the last one evaluated (mutant M4:
  // removing the conviction scan's break reported the LAST convicting
  // prefix): with 6 metering windows supplied, W=4 is still the report.
  const escSixWin = m.escalationDue([], new Map(), A, [met26, met26, met26, met26, met26, met26])
  eq(escSixWin.conviction?.lifetime?.windows, 4, 'A5-21: EARLIEST convicting lifetime prefix (W=4) even with 6 closed windows supplied')
  eq(escSixWin.lifetime?.windows, 2, 'A5-21: …and the earliest ESCALATING prefix (W=2) is likewise stable')
  // ── A5-21 exact-boundary window (review finding: the inclusive ≥ at the
  // conviction line had no fixture. An exclusive-comparator regression
  // passed every suite). Crafted 30-game window: 10 blat (+3e6 capped) + 20
  // fills at dev −130_750 (acpl 52_963_763 @ elo 1500 / match 470k) ⇒
  // sumDev = 27_385_000 ⇒ z = floor(27_385_000_000/5477) = EXACTLY 5_000_000.
  const bfill = (i, acpl = 52_963_763, game = `bd-fill-${i}`) => ({ rec: mkRec(game, acpl, 470_000), side: 'w', elo: 1500 })
  const bblat = (i) => ({ rec: mkRec(`bd-blat-${i}`, 8_000_000, 900_000), side: 'w', elo: 1500 })
  const boundaryWin = [...Array.from({ length: 10 }, (_, i) => bblat(i)), ...Array.from({ length: 19 }, (_, i) => bfill(i)), bfill(19)]
  eq(m.aggregateZMicro(boundaryWin, A).zMicro, PARAMS_A5.zThresholdMicro, 'A5-21 boundary: crafted window z is EXACTLY zThresholdMicro (fixture sanity)')
  const boundaryGames = boundaryWin.map((e) => ({ game: e.rec.game, side: e.side, elo: e.elo }))
  const boundaryRecs = new Map(boundaryWin.map((e) => [e.rec.game, e.rec]))
  const escBoundary = m.escalationDue(boundaryGames, boundaryRecs, A)
  eq(escBoundary.conviction?.atIndex, 29, 'A5-21 boundary: the trailing-K conviction scan is INCLUSIVE at zThresholdMicro (≥, not >)')
  eq(escBoundary.conviction?.zMicro, PARAMS_A5.zThresholdMicro, 'A5-21 boundary: conviction z = exactly the threshold')
  eq(escBoundary.atIndex, 29, 'A5-21 boundary: escalation and conviction fire in the SAME first evaluable window (both recorded)')
  // One micro-σ below: swap one fill for dev −130_751 (acpl 52_963_795) ⇒
  // z = 4_999_999: escalates, must NOT convict and must NOT mint suppression.
  const belowWin = [...boundaryWin.slice(0, 29), bfill(19, 52_963_795, 'bd-tune-low')]
  eq(m.aggregateZMicro(belowWin, A).zMicro, PARAMS_A5.zThresholdMicro - 1, 'A5-21 boundary: one-micro-below window z (fixture sanity)')
  const belowGames = belowWin.map((e) => ({ game: e.rec.game, side: e.side, elo: e.elo }))
  const belowRecs = new Map(belowWin.map((e) => [e.rec.game, e.rec]))
  const escBelow = m.escalationDue(belowGames, belowRecs, A)
  eq(escBelow.due, true, 'A5-21 boundary: one micro-σ below still escalates')
  eq(escBelow.conviction, undefined, 'A5-21 boundary: …but does NOT convict (exclusive below the line)')
  // ── A5-21 ratified validation domain: escalationDue is defined only over
  // FULLY-well-formed inputs: a malformed record/window-z ANYWHERE fails
  // closed, even beyond the first escalation crossing (pre-A5-21 the
  // early-break scan silently never examined that region; review finding
  // scan-1 ratified upfront full-domain validation).
  const escalPrefix = games.slice(0, GOLDEN.convAtIndex) // escalates at 31, never convicts
  const badTail = [...escalPrefix, { game: 'blat-34', side: 'w', elo: 1500, rdMicro: -1 }]
  throwsT2(() => m.escalationDue(badTail, records, A), 'A5-21 domain: malformed rdMicro BEYOND the escalation crossing fails closed (was silently unexamined pre-ratification)')
  const foreignRec = { ...records.get('blat-34'), params: 'A'.repeat(43) }
  const foreignRecs = new Map(records)
  foreignRecs.set('blat-34', foreignRec)
  throwsT2(() => m.escalationDue(games.slice(0, GOLDEN.convAtIndex + 1), foreignRecs, A), 'A5-21 domain: foreign-params record beyond the crossing fails closed')
  throwsT2(() => m.escalationDue(innoGames, innoRecs, A, [3_000_000, 1.5]), 'A5-21 domain: malformed closedWindowZs element BEYOND the first escalating prefix fails closed')
  throwsT2(
    () => m.escalationDue(innoGames, innoRecs, A, [3_000_000, ...Array.from({ length: m.LIFETIME_WINDOWS_MAX }, () => 0)]),
    'A5-21 domain: closedWindowZs beyond LIFETIME_WINDOWS_MAX fails closed even when an early prefix already escalated',
  )
  eq(m.escalationDue(innoGames, innoRecs, A, [met26]).due, false, 'one sub-escalation closed window: not due')
  eq(m.escalationDue(innoGames, innoRecs, A, []).due, false, 'no closed windows: not due')
  eq(
    m.escalationDue(games.slice(0, K - 1), records, A, [met26, met26]).due,
    true,
    'lifetime evaluates even when the current game list is under K (closed windows are prior chain facts)',
  )
  eq(
    JSON.stringify(m.escalationDue(innoGames, innoRecs, A, [GOLDEN.zInno30, GOLDEN.zInno30])),
    JSON.stringify({ due: false }),
    'honest closed windows accumulate to nothing (cancellation, no ratchet)',
  )
  throwsT2(() => m.escalationDue(innoGames, innoRecs, A, [1.5]), 'malformed closedWindowZs fails closed')

  // ==== 5. verdict + suppression records ====================================
  console.log('\n· Tier-2 verdict records (sign / verify / recompute receipts) …')
  const auditorPriv = new Uint8Array(32).fill(7)
  const auditor = hashMod.toB64u(hashMod.ed25519.getPublicKey(auditorPriv))
  const metEntries = w30(met)
  const rec = m.makeTier2Verdict({
    kind: 'verdict',
    root: ROOTB,
    ladder: LAD,
    window: 2,
    entries: metEntries,
    anchors: A,
    verdictWts: 1_800_000_000_000,
    signer: auditor,
    key: auditor,
    priv: auditorPriv,
  })
  eq(rec.body.zMicro, GOLDEN.zMet30, 'verdict body zMicro is DERIVED from the entries')
  eq(rec.body.games.length, 30, 'verdict lists all 30 game keys')
  eq(rec.body.tier1.length, 30, 'verdict lists all 30 tier1 digests')
  eq(rec.body.anchors, GOLDEN.anchorsDigest, 'verdict pins the anchors digest')
  eq(rec.body.params, PARAMS_A5_DIGEST, 'verdict pins PARAMS_A5_DIGEST')
  const vOk = m.verifyTier2Verdict(rec, { entries: metEntries, anchors: A })
  ok(vOk.ok, `verifyTier2Verdict ok (${vOk.errors.join('; ') || 'no errors'})`)
  eq(m.tier2VerdictDigest(rec.body), m.tier2VerdictDigest(rec.body), 'verdict digest deterministic')

  // receipts: an INDEPENDENT party recomputing the same window mints the same body
  const otherPriv = new Uint8Array(32).fill(9)
  const other = hashMod.toB64u(hashMod.ed25519.getPublicKey(otherPriv))
  const rec2 = m.makeTier2Verdict({
    kind: 'verdict', root: ROOTB, ladder: LAD, window: 2, entries: metEntries, anchors: A,
    verdictWts: 1_800_000_000_000, signer: other, key: other, priv: otherPriv,
  })
  eq(m.tier2VerdictDigest(rec2.body), m.tier2VerdictDigest(rec.body), 'RECEIPTS: independent recompute ⇒ identical body bits (digest)')
  ok(rec2.sig !== rec.sig, '…while the signatures differ (different computing parties)')

  // commend-pattern child key
  const childPriv = new Uint8Array(32).fill(11)
  const childPub = hashMod.toB64u(hashMod.ed25519.getPublicKey(childPriv))
  const cert = certsMod.makeCertEvent(otherPriv, other, { root: other, events: [] }, { childPub, purpose: 1, index: 0, ts: 5 })
  const recChild = m.makeTier2Verdict({
    kind: 'verdict', root: ROOTB, ladder: LAD, window: 2, entries: metEntries, anchors: A,
    verdictWts: 1_800_000_000_000, signer: other, key: childPub, priv: childPriv, certs: [cert],
  })
  ok(m.verifyTier2Verdict(recChild, { entries: metEntries, anchors: A }).ok, 'child-key verdict with inline root-signed cert verifies (commend pattern)')
  ok(!m.verifyTier2Verdict({ ...recChild, certs: undefined }, { entries: metEntries, anchors: A }).ok, 'child key without certs rejected')
  ok(!m.verifyTier2Verdict({ ...rec, certs: [cert] }, { entries: metEntries, anchors: A }).ok, 'pointless certs on a root-signed record rejected (fail closed)')

  // tamper matrix. Every mutation must flip verify to false
  const mut = (body) => ({ ...rec, body: { ...rec.body, ...body } })
  ok(!m.verifyTier2Verdict(mut({ zMicro: rec.body.zMicro + 1 }), { entries: metEntries, anchors: A }).ok, 'tamper: zMicro+1 ⇒ verify false')
  ok(!m.verifyTier2Verdict(mut({ games: [...rec.body.games.slice(1), 'ghost'] }), { entries: metEntries, anchors: A }).ok, 'tamper: games list ⇒ verify false')
  ok(!m.verifyTier2Verdict(mut({ tier1: [b64({ x: 1 }), ...rec.body.tier1.slice(1)] }), { entries: metEntries, anchors: A }).ok, 'tamper: tier1 digest ⇒ verify false')
  ok(!m.verifyTier2Verdict(mut({ window: 3 }), { entries: metEntries, anchors: A }).ok, 'tamper: window ⇒ verify false (signature breaks)')
  ok(!m.verifyTier2Verdict(mut({ anchors: b64({ a: 1 }) }), { entries: metEntries, anchors: A }).ok, 'tamper: anchors digest ⇒ verify false')
  ok(!m.verifyTier2Verdict(mut({ ladder: 'bullet-60+0' }), { entries: metEntries, anchors: A }).ok, 'tamper: ladder ⇒ verify false')
  ok(!m.verifyTier2Verdict(mut({ kind: 'suppression' }), { entries: metEntries, anchors: A }).ok, 'tamper: kind ⇒ verify false (verdict→suppression is schema-invalid without a deadlineEvent)')
  ok(!m.verifyTier2Verdict({ ...rec, signer: auditor, key: other }, { entries: metEntries, anchors: A }).ok, 'tamper: swapped key ⇒ verify false')
  ok(!m.verifyTier2Verdict(rec, { entries: metEntries.slice(0, 29), anchors: A }).ok, 'inputs mismatch: fewer entries than games ⇒ verify false')
  ok(!m.verifyTier2Verdict(rec, { entries: w30(inno), anchors: A }).ok, 'inputs mismatch: different records ⇒ verify false (z does not recompute)')
  ok(!m.verifyTier2Verdict('junk', { entries: metEntries, anchors: A }).ok, 'non-record input ⇒ verify false, never a throw')

  // suppression variant, A5-21: a suppression asserts the 5σ CONVICTION
  // fired (owner decision 2026-07-22), so the canonical valid fixture is the
  // CONVICTING trailing-K window (index 34, z = 5.11σ), never the merely-
  // escalating one (index 31, z = 3.41σ; kept below as the refusal fixture).
  const deadline = b64({ ev: 'first-witnessed-after' })
  const trailing = games.slice(GOLDEN.escAtIndex - K + 1, GOLDEN.escAtIndex + 1).map((g) => ({ rec: records.get(g.game), side: g.side, elo: g.elo }))
  const convicting = games.slice(GOLDEN.convAtIndex - K + 1, GOLDEN.convAtIndex + 1).map((g) => ({ rec: records.get(g.game), side: g.side, elo: g.elo }))
  const supp = m.makeTier2Verdict({
    kind: 'suppression', root: ROOTB, ladder: LAD, window: GOLDEN.convAtIndex, entries: convicting, anchors: A,
    verdictWts: 1_800_000_000_001, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv,
  })
  eq(supp.body.kind, 'suppression', 'suppression record kind')
  eq(supp.body.deadlineEvent, deadline, 'suppression carries the deadline event')
  eq(supp.body.zMicro, GOLDEN.convZ, 'suppression zMicro = the CONVICTING trailing-K window z (A5-21: ≥ zThresholdMicro)')
  ok(m.verifyTier2Verdict(supp, { entries: convicting, anchors: A }).ok, 'suppression record verifies (same receipt discipline)')
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'suppression', root: ROOTB, ladder: LAD, window: 1, entries: metEntries, anchors: A, verdictWts: 1, signer: auditor, key: auditor, priv: auditorPriv }),
    'suppression without deadlineEvent refused',
  )
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'verdict', root: ROOTB, ladder: LAD, window: 1, entries: metEntries, anchors: A, verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv }),
    'deadlineEvent on a plain verdict refused',
  )

  // J7: lifetime claims on verdict records (derived, receipt-verified)
  const lifeZs = [GOLDEN.zMet30, GOLDEN.zMet30, GOLDEN.zMet30] // closed windows 0..2; this record IS window 2
  const recLife = m.makeTier2Verdict({
    kind: 'verdict', root: ROOTB, ladder: LAD, window: 2, entries: metEntries, anchors: A,
    verdictWts: 1_800_000_000_000, signer: auditor, key: auditor, priv: auditorPriv, lifetimeWindowZs: lifeZs,
  })
  eq(recLife.body.lifetime?.zLifeMicro, GOLDEN.zLifeMet3, 'lifetime zLifeMicro is DERIVED from windowZs (never asserted)')
  eq(recLife.body.lifetime?.windows, 3, 'lifetime windows = window + 1 (evaluated AT this record window)')
  eq(JSON.stringify(recLife.body.lifetime?.windowZs), JSON.stringify(lifeZs), 'lifetime carries the claimed windowZs')
  ok(m.verifyTier2Verdict(recLife, { entries: metEntries, anchors: A }).ok, 'lifetime-bearing verdict verifies (recompute receipt)')
  ok(recLife.body.lifetime.zLifeMicro >= PARAMS_A5.zThresholdMicro, 'three metered windows lifetime-CONVICT while no single window could (the closure, on a record)')
  const recLife2 = m.makeTier2Verdict({
    kind: 'verdict', root: ROOTB, ladder: LAD, window: 2, entries: metEntries, anchors: A,
    verdictWts: 1_800_000_000_000, signer: other, key: other, priv: otherPriv, lifetimeWindowZs: lifeZs,
  })
  eq(m.tier2VerdictDigest(recLife2.body), m.tier2VerdictDigest(recLife.body), 'RECEIPTS: independent lifetime recompute ⇒ identical body bits')
  ok(m.tier2VerdictDigest(recLife.body) !== m.tier2VerdictDigest(rec.body), 'lifetime claim changes the body digest (it is signed evidence, not an annotation)')
  // lifetime tamper matrix: every mutation flips verify to false
  const mutLife = (life) => ({ ...recLife, body: { ...recLife.body, lifetime: { ...recLife.body.lifetime, ...life } } })
  ok(!m.verifyTier2Verdict(mutLife({ zLifeMicro: recLife.body.lifetime.zLifeMicro + 1 }), { entries: metEntries, anchors: A }).ok, 'tamper: lifetime zLifeMicro+1 ⇒ verify false')
  ok(!m.verifyTier2Verdict(mutLife({ windowZs: [GOLDEN.zMet30, GOLDEN.zMet30 + 1, GOLDEN.zMet30] }), { entries: metEntries, anchors: A }).ok, 'tamper: a windowZs entry ⇒ verify false (zLife no longer recomputes)')
  ok(!m.verifyTier2Verdict(mutLife({ windows: 2 }), { entries: metEntries, anchors: A }).ok, 'tamper: windows/windowZs length mismatch ⇒ verify false (schema)')
  ok(!m.verifyTier2Verdict(mutLife({ windowZs: [GOLDEN.zMet30, GOLDEN.zMet30] }), { entries: metEntries, anchors: A }).ok, "tamper: 'verdict' lifetime not evaluated AT this window ⇒ verify false (windows ≠ window+1)")
  ok(!m.verifyTier2Verdict({ ...recLife, body: { ...recLife.body, lifetime: undefined } }, { entries: metEntries, anchors: A }).ok, 'tamper: stripping the lifetime claim ⇒ verify false (signature breaks)')
  ok(!m.verifyTier2Verdict({ ...rec, body: { ...rec.body, lifetime: recLife.body.lifetime } }, { entries: metEntries, anchors: A }).ok, 'tamper: grafting a lifetime claim onto a lifetime-free record ⇒ verify false')
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'verdict', root: ROOTB, ladder: LAD, window: 2, entries: metEntries, anchors: A, verdictWts: 1, signer: auditor, key: auditor, priv: auditorPriv, lifetimeWindowZs: [GOLDEN.zMet30, GOLDEN.zMet30] }),
    "builder refuses a 'verdict' lifetime claim not ending at this window (windows ≠ window+1)",
  )
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'verdict', root: ROOTB, ladder: LAD, window: 2, entries: metEntries, anchors: A, verdictWts: 1, signer: auditor, key: auditor, priv: auditorPriv, lifetimeWindowZs: [GOLDEN.zMet30, GOLDEN.zMet30, GOLDEN.zMet30 + 1] }),
    "builder refuses a 'verdict' lifetime claim whose last window z is not THIS window's zMicro",
  )
  // suppression records may carry lifetime evidence with no window tie (the
  // window path convicts here; sub-conviction lifetime evidence rides along)
  const suppLife = m.makeTier2Verdict({
    kind: 'suppression', root: ROOTB, ladder: LAD, window: GOLDEN.convAtIndex, entries: convicting, anchors: A,
    verdictWts: 1_800_000_000_001, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv,
    lifetimeWindowZs: [met26, met26],
  })
  eq(suppLife.body.lifetime?.zLifeMicro, GOLDEN.zLife2x26, 'suppression lifetime evidence: derived zLifeMicro (no window tie; window is an ordinal here)')
  ok(m.verifyTier2Verdict(suppLife, { entries: convicting, anchors: A }).ok, 'lifetime-bearing suppression verifies')

  // ==== A5-03 + A5-21: suppression must prove the CONVICTION fired ==========
  // (recomputed). A5-03 closed the never-escalated forgery; A5-21 (owner
  // decision 2026-07-22: honest players are never banned) re-anchored the
  // whole obligation on the 5σ conviction line, so the gate now refuses ANY
  // sub-conviction suppression, including genuinely-escalating [3σ,5σ)-band
  // windows. The builder throws on such inputs, so the verifier-side
  // negatives forge hand-signed records (schema-valid, correct
  // digests/params/sig: ONLY the conviction condition is unmet).
  const forgeSupp = (entries, extra = {}) => {
    const body = {
      v: 1,
      kind: 'suppression',
      root: ROOTB,
      ladder: LAD,
      window: 5,
      zMicro: m.aggregateZMicro(entries, A).zMicro,
      games: entries.map((e) => e.rec.game),
      tier1: entries.map((e) => m.tier1Digest(e.rec)),
      anchors: GOLDEN.anchorsDigest,
      params: PARAMS_A5_DIGEST,
      verdictWts: 1,
      deadlineEvent: deadline,
      ...extra,
    }
    const sig = hashMod.toB64u(hashMod.ed25519.sign(codecMod.canonicalBytes(body), auditorPriv))
    return { body, signer: auditor, key: auditor, sig }
  }
  const innoEntries = w30(inno) // honest full-K window, z = -551_207 ≪ 3e6: never escalated
  const suppInno = forgeSupp(innoEntries)
  eq(suppInno.body.zMicro, GOLDEN.zInno30, 'A5-03 fixture: honest 30-entry window z golden (-0.55σ, sub-escalation)')
  const vSuppInno = m.verifyTier2Verdict(suppInno, { entries: innoEntries, anchors: A })
  ok(!vSuppInno.ok, 'A5-03: honest never-escalated 30-entry suppression REJECTED (was accepted pre-fix)')
  ok(
    vSuppInno.errors.some((e) => e.includes('suppression conviction did not fire')),
    'A5-03: rejection carries the typed suppression-conviction error',
  )
  const threeBlat = [blat(0), blat(1), blat(2)] // z = 5_196_304 ≥ 5e6 but NOT a full reganK window
  const supp3 = forgeSupp(threeBlat)
  eq(supp3.body.zMicro, GOLDEN.zBlat3, 'A5-03 fixture: 3-entry hand-picked z golden (above even the 5σ line)')
  ok(
    !m.verifyTier2Verdict(supp3, { entries: threeBlat, anchors: A }).ok,
    'A5-03: 3-entry (≠ reganK) suppression REJECTED even with z ≥ 5σ (trailing-K geometry required)',
  )
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'suppression', root: ROOTB, ladder: LAD, window: 5, entries: innoEntries, anchors: A, verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv }),
    'A5-03: builder throws on a never-escalated suppression window',
  )
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'suppression', root: ROOTB, ladder: LAD, window: 5, entries: threeBlat, anchors: A, verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv }),
    'A5-03: builder throws on a 3-entry suppression window',
  )
  // Genuine conviction still round-trips: `supp` (trailing-K, z = convZ ≥
  // 5e6) re-verified above; re-assert build→verify explicitly.
  ok(m.verifyTier2Verdict(supp, { entries: convicting, anchors: A }).ok, 'A5-03: genuinely-CONVICTING full-K suppression still builds + verifies')
  // ── A5-21 core regression: the [3σ,5σ) ESCALATION BAND never grounds a
  // suppression. `trailing` (the escalation firing, z = 3.41σ) was the VALID
  // suppression fixture before the owner decision: an honest account whose
  // window drifts into the band would have been provably "suppressing" for
  // not self-banning. Both mint paths now refuse it.
  const suppBand = forgeSupp(trailing)
  eq(suppBand.body.zMicro, GOLDEN.escZ, 'A5-21 fixture: the escalation-band window z (3.41σ; escalated, NOT convicted)')
  const vSuppBand = m.verifyTier2Verdict(suppBand, { entries: trailing, anchors: A })
  ok(!vSuppBand.ok, 'A5-21: an escalation-band (3.41σ) full-K suppression is REJECTED. Escalation alone never grounds a ban (was VALID pre-decision)')
  ok(
    vSuppBand.errors.some((e) => e.includes('suppression conviction did not fire')),
    'A5-21: rejection carries the typed suppression-conviction error',
  )
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'suppression', root: ROOTB, ladder: LAD, window: GOLDEN.escAtIndex, entries: trailing, anchors: A, verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv }),
    'A5-21: builder throws on an escalation-band suppression window',
  )
  // Exact-boundary pins on the suppression gates (review finding: the ≥ at
  // zThresholdMicro had no fixture in either gate): the crafted z=5_000_000
  // window mints + verifies; the z=4_999_999 twin is refused on BOTH paths.
  const suppBoundary = m.makeTier2Verdict({
    kind: 'suppression', root: ROOTB, ladder: LAD, window: 29, entries: boundaryWin, anchors: A,
    verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv,
  })
  eq(suppBoundary.body.zMicro, PARAMS_A5.zThresholdMicro, 'A5-21 boundary: a suppression at EXACTLY zThresholdMicro mints (inclusive ≥ in makeTier2Verdict)')
  ok(m.verifyTier2Verdict(suppBoundary, { entries: boundaryWin, anchors: A }).ok, 'A5-21 boundary: …and verifies (inclusive ≥ in verifyTier2Verdict)')
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'suppression', root: ROOTB, ladder: LAD, window: 29, entries: belowWin, anchors: A, verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv }),
    'A5-21 boundary: one micro-σ below the line is REFUSED by the builder',
  )
  const suppBelow = forgeSupp(belowWin)
  ok(!m.verifyTier2Verdict(suppBelow, { entries: belowWin, anchors: A }).ok, 'A5-21 boundary: …and a hand-forged one-micro-below suppression fails verify')
  // Lifetime path: a window that never convicted is a valid suppression IFF
  // the recomputed lifetime statistic CONVICTS (zLife ≥ zThresholdMicro).
  // Sustained metering (four 2.6σ windows, zLife 5.2e6 at W=4) still mints.
  const suppLifeFired = m.makeTier2Verdict({
    kind: 'suppression', root: ROOTB, ladder: LAD, window: 5, entries: innoEntries, anchors: A,
    verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv,
    lifetimeWindowZs: [met26, met26, met26, met26], // zLife = 5_200_000 ≥ 5e6
  })
  eq(suppLifeFired.body.lifetime?.zLifeMicro, GOLDEN.zLife4x26, 'A5-21: the metering lifetime CONVICTS at W=4 (the J7 closure survives the re-anchor)')
  ok(m.verifyTier2Verdict(suppLifeFired, { entries: innoEntries, anchors: A }).ok, 'A5-03: lifetime-fired suppression (window sub-conviction, zLife ≥ 5σ) builds + verifies')
  const suppLifeSub = forgeSupp(innoEntries, { lifetime: { zLifeMicro: met26, windows: 1, windowZs: [met26] } }) // zLife(1) = 2_600_000 < 5e6
  ok(!m.verifyTier2Verdict(suppLifeSub, { entries: innoEntries, anchors: A }).ok, 'A5-03: sub-conviction lifetime claim does NOT satisfy the conviction, rejected')
  const suppLifeBand = forgeSupp(innoEntries, { lifetime: { zLifeMicro: GOLDEN.zLife2x26, windows: 2, windowZs: [met26, met26] } }) // 3.67σ. Escalates, never convicts
  ok(!m.verifyTier2Verdict(suppLifeBand, { entries: innoEntries, anchors: A }).ok, 'A5-21: an ESCALATING (3.67σ) but sub-conviction lifetime claim is likewise REJECTED')
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'suppression', root: ROOTB, ladder: LAD, window: 5, entries: innoEntries, anchors: A, verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv, lifetimeWindowZs: [met26] }),
    'A5-03: builder throws when neither window nor lifetime path convicts',
  )
  throwsT2(
    () => m.makeTier2Verdict({ kind: 'suppression', root: ROOTB, ladder: LAD, window: 5, entries: innoEntries, anchors: A, verdictWts: 1, deadlineEvent: deadline, signer: auditor, key: auditor, priv: auditorPriv, lifetimeWindowZs: [met26, met26] }),
    'A5-21: builder throws on an escalating-but-sub-conviction lifetime suppression',
  )

  // ==== A5-07: suppression `kind` is load-bearing + trailing-K geometry ======
  // A5-07 named the suppression receipt's negative-coverage blind spot. Two
  // gaps it flagged, both closed here:
  //  (1) The sub-conviction suppression rejection is ENFORCED by the A5-03 +
  //      A5-21 gate and exercised just above (suppInno / supp3 / suppBand /
  //      suppLifeSub). What was still unpinned is that `kind` ITSELF is
  //      load-bearing. Not merely the arithmetic: the SAME honest window
  //      (w30(inno), z = −551_207 ≈ −0.55σ: the finding's exact shape) is a
  //      VALID plain 'verdict' yet an INVALID 'suppression'. A verdict only
  //      records the statistic; a suppression additionally asserts the §8
  //      CONVICTION FIRED (A5-21: "provable ONLY relative to the
  //      deterministic conviction"), which this window disproves, so
  //      flipping ONLY the kind flips verify. This locks in the z ≥
  //      zThresholdMicro suppression check against silent regression.
  //  (2) The tamper matrix's header-claimed 'kind ⇒ verify false' case (now in
  //      the matrix above), plus the trailing-K geometry tie (entries.length
  //      === reganK) the suite never asserted.
  console.log('\n· A5-07: suppression `kind` load-bearing + trailing-K geometry …')
  const verdictInno = m.makeTier2Verdict({
    kind: 'verdict', root: ROOTB, ladder: LAD, window: 5, entries: innoEntries, anchors: A,
    verdictWts: 1, signer: auditor, key: auditor, priv: auditorPriv,
  })
  ok(
    m.verifyTier2Verdict(verdictInno, { entries: innoEntries, anchors: A }).ok,
    'A5-07: the honest sub-escalation window is a VALID plain verdict (a verdict only records the statistic)',
  )
  ok(
    !m.verifyTier2Verdict(suppInno, { entries: innoEntries, anchors: A }).ok,
    'A5-07: … the SAME window signed as a SUPPRESSION is REJECTED. Kind is load-bearing (§8 conviction never fired)',
  )
  // `kind` lives INSIDE the signed body: a kind flip that stays schema-legal
  // (drop the deadline so 'verdict' is valid) still breaks the record signature
  // even though the statistic recomputes identically: the rigorous integrity
  // form of the matrix's 'kind ⇒ verify false' (idiom mirrors the lifetime-strip
  // tamper above).
  ok(
    !m.verifyTier2Verdict({ ...supp, body: { ...supp.body, kind: 'verdict', deadlineEvent: undefined } }, { entries: convicting, anchors: A }).ok,
    'A5-07: a schema-legal suppression→verdict kind flip still breaks the signature (kind is signed body, not an annotation)',
  )
  // A valid suppression's entries ARE exactly a trailing-K window. The fixed
  // geometry escalationDue fires on (supp3 above proves a ≠ reganK window is
  // refused even at z ≥ 5σ; these pin the positive side the suite never did).
  eq(convicting.length, K, 'A5-07: a valid suppression carries exactly a trailing-K window (entries.length === reganK)')
  eq(supp.body.games.length, K, 'A5-07: … and the suppression record lists all K game keys')

  // publishing key + row
  const vk = m.tier2VerdictKey(ROOTB)
  eq(vk.length, 43, 'tier2VerdictKey is a 32-byte b64u key')
  eq(m.tier2VerdictKey(ROOTB), vk, 'tier2VerdictKey deterministic')
  ok(m.tier2VerdictKey(other) !== vk, 'different subject ⇒ different key')
  const row = m.verdictRow([rec, supp])
  eq(row.verdicts.length, 2, 'verdictRow bundles records')
  throwsT2(() => m.verdictRow([rec, { ...rec, body: { ...rec.body, root: other } }]), 'verdictRow refuses mixed accused roots')

  // ==== 6. self-ban helpers =================================================
  console.log('\n· self-ban helpers (§8 deadline / §9 term) …')
  eq(m.selfBanExpiryWts(0), PARAMS_A5.selfBanDays * 86_400_000, 'selfBanExpiryWts = trigger + 90d')
  eq(m.selfBanExpiryWts(1_000), 1_000 + 7_776_000_000, 'selfBanExpiryWts offsets the trigger wts')
  const sb = m.makeSelfBanPayload({ ladder: LAD, window: 2, expiryWts: m.selfBanExpiryWts(1_800_000_000_000), verdictDigest: m.tier2VerdictDigest(rec.body) })
  ok(eventsMod.zSelfBanPayload.safeParse(sb).success, 'makeSelfBanPayload output passes zSelfBanPayload')
  eq(sb.kind, 'anticheat', 'selfban kind pinned')
  throwsT2(() => m.makeSelfBanPayload({ ladder: '', window: 2, expiryWts: 1, verdictDigest: m.tier2VerdictDigest(rec.body) }), 'empty ladder refused')
  throwsT2(() => m.makeSelfBanPayload({ ladder: LAD, window: -1, expiryWts: 1, verdictDigest: m.tier2VerdictDigest(rec.body) }), 'negative window refused')
  throwsT2(() => m.makeSelfBanPayload({ ladder: LAD, window: 2, expiryWts: 1, verdictDigest: 'not-a-digest' }), 'malformed verdict digest refused')
  eq(m.selfBanDueNow({ escalation: esc, selfBanAppended: false }), true, 'selfBanDueNow: CONVICTION fired + no selfban ⇒ due (A5-21)')
  eq(m.selfBanDueNow({ escalation: esc, selfBanAppended: true }), false, 'selfBanDueNow: selfban appended ⇒ settled')
  eq(m.selfBanDueNow({ escalation: { due: false }, selfBanAppended: false }), false, 'selfBanDueNow: no trigger ⇒ nothing due')
  eq(m.selfBanDueNow({ escalation: { due: false }, selfBanAppended: true }), false, 'selfBanDueNow: vacuous selfban is not "due"')

  // ── A5-21 [DECIDED 2026-07-22. Owner directive: an honest player is NEVER
  // banned]. The self-ban / suppression obligation anchors on the 5σ
  // CONVICTION (escalation.conviction: either arm crossing zThresholdMicro);
  // the 3σ escalation obliges ONLY deeper analysis. Rationale: at a 3σ ban
  // gate the one-sided FPR is ≈1.35e-3/window, so an honest 1k/3k/10k-game
  // career eventually owes a false 90-day self-ban with probability
  // ≈22.9%/57.9%/93.5%: the §0 false-fraud channel; at 5σ per-look FPR is
  // ≈2.9e-7, union-bounded < 3e-3 over 10^4 windows (§8 "astronomically
  // low"). These regressions pin the re-anchored wiring: flipping the gate
  // back to escalation.due turns every 'obliges NO ban' assertion here red.
  // The escalation-band chain (max z 4.54σ < 5σ): escalated, deeper analysis
  // obliged, but NO ban obligation, ever.
  ok(escBand.due && escBand.conviction === undefined, 'A5-21: the escalation-band chain escalates without convicting (fixture sanity)')
  eq(
    m.selfBanDueNow({ escalation: escBand, selfBanAppended: false }),
    false,
    'A5-21: NO self-ban obligation anywhere in the [3σ,5σ) escalation band. An honest account is never banned on escalation',
  )
  // ONE maximally-blatant game (a size-1 salted window at the +3σ cap)
  // escalates the J7 lifetime arm at W=1 but can never convict: the ban
  // obligation no longer fires off a single game (the §8 structural
  // no-single-game rule now extends to the ban path).
  const escOneGame = m.escalationDue([], new Map(), A, [GOLDEN.zBlat1])
  ok(
    !m.lifetimeVerdict([GOLDEN.zBlat1]).convicted,
    'A5-21: one capped game (W=1 lifetime) is NOT convicted, no single game convicts',
  )
  eq(escOneGame.due, true, 'A5-21: a single capped game still escalates (deeper analysis obliged)')
  eq(escOneGame.conviction, undefined, 'A5-21: …with NO conviction report')
  eq(
    m.selfBanDueNow({ escalation: escOneGame, selfBanAppended: false }),
    false,
    'A5-21: …and NO self-ban obligation off ONE game (pre-decision wiring obliged the 90d ban here)',
  )
  // Convictions DO oblige, on both arms. Trailing-K: the blatant chain's
  // earliest 5σ window names the deadline anchor.
  eq(esc.conviction?.game, `blat-${GOLDEN.convAtIndex}`, 'A5-21: trailing-K conviction carries the §8 deadline-anchoring game')
  eq(m.selfBanDueNow({ escalation: esc, selfBanAppended: false }), true, 'A5-21: trailing-K conviction + no selfban ⇒ the 90d obligation fires')
  // Lifetime arm: sustained metering (each window 2.6σ, individually
  // sub-escalation) convicts at W=4: the J7 closure still bans cheaters.
  const escMeter = m.escalationDue([], new Map(), A, [met26, met26, met26, met26])
  eq(escMeter.lifetime?.windows, 2, 'A5-21: metering escalates at the earliest prefix W=2 (deeper analysis)')
  eq(escMeter.conviction?.lifetime?.windows, 4, 'A5-21: …and CONVICTS at W=4 (zLife 5.2e6 ≥ 5σ)')
  eq(escMeter.conviction?.lifetime?.zLifeMicro, GOLDEN.zLife4x26, 'A5-21: lifetime conviction zLife golden')
  eq(escMeter.conviction?.atIndex, undefined, 'A5-21: a lifetime-only conviction carries no trailing-K anchor')
  eq(m.selfBanDueNow({ escalation: escMeter, selfBanAppended: false }), true, 'A5-21: a lifetime conviction obliges the self-ban')
  eq(m.selfBanDueNow({ escalation: escMeter, selfBanAppended: true }), false, 'A5-21: …settled once the selfban is appended')

  // ── A5-26: the 3σ ESCALATION line and the 5σ CONVICTION line are TWO distinct
  // thresholds with DISTINCT consequences: an affirmative test of the module
  // header property "escalation only obliges deeper analysis, never convict".
  // §3/§3b pin the statistic flags at FIXTURE z-values (4.14σ metered, 3.0σ /
  // 5.19σ single/floor) and §6/A5-21 above pins the 5σ conviction-anchored
  // self-ban wiring. This block locks both gates to the micro-σ and separates
  // the escalation consequence (deeper analysis ONLY) from the conviction
  // consequences (`convicted` + the §8 self-ban obligation).
  // A5-21 DECIDED 2026-07-22: the ban obligation anchors on the 5σ
  // conviction: the obligation-level assertions below pin the re-anchored
  // wiring (they flipped, deliberately, with the A5-21 block above).
  ok(
    PARAMS_A5.zEscalateMicro < PARAMS_A5.zThresholdMicro,
    'A5-26: escalation line is STRICTLY below the conviction line, two distinct thresholds, never collapsed',
  )
  // W=1 lifetime is the identity zLifeMicro === the lone window z (isqrt(1e6) =
  // 1000; §3b), so these hit EXACT statistic values astride each gate. A
  // regression sliding either threshold onto the other flips exactly one of them.
  const zStat = (z) => m.lifetimeVerdict([z])
  const sBelowEsc = zStat(PARAMS_A5.zEscalateMicro - 1)
  ok(!sBelowEsc.escalate && !sBelowEsc.convicted, 'A5-26: one micro-σ below 3σ ⇒ neither escalation nor conviction (no consequence yet)')
  const sOnEsc = zStat(PARAMS_A5.zEscalateMicro)
  ok(sOnEsc.escalate && !sOnEsc.convicted, 'A5-26: AT the 3σ line ⇒ escalation (deeper-analysis obligation) but NOT conviction')
  const sBelowConv = zStat(PARAMS_A5.zThresholdMicro - 1)
  ok(sBelowConv.escalate && !sBelowConv.convicted, 'A5-26: one micro-σ below 5σ STILL only escalates, "escalation never convicts", locked at the top of the band')
  const sOnConv = zStat(PARAMS_A5.zThresholdMicro)
  ok(sOnConv.escalate && sOnConv.convicted, 'A5-26: AT the 5σ line ⇒ conviction. The distinct consequence the escalation line never produces (and conviction ⇒ escalation, never the reverse)')
  // CONSEQUENCE separation at the OBLIGATION level (A5-21 decided): one
  // micro-σ below 5σ still escalates (deeper analysis) but obliges NO ban;
  // AT 5σ the conviction fires and THAT is what obliges the ban. The
  // obligation and the conviction are one line, across the whole band.
  const escTopOfBand = m.escalationDue([], new Map(), A, [PARAMS_A5.zThresholdMicro - 1])
  eq(escTopOfBand.due, true, 'A5-26: escalationDue.due fires on the top-of-band (sub-conviction) statistic. Deeper analysis obliged strictly below the conviction line')
  eq(escTopOfBand.conviction, undefined, 'A5-26: …with no conviction one micro-σ below the 5σ line')
  eq(
    m.selfBanDueNow({ escalation: escTopOfBand, selfBanAppended: false }),
    false,
    'A5-26: …and NO 90d self-ban obligation. The ban tracks the CONVICTION line, never escalation (A5-21 decided 2026-07-22)',
  )
  const escAtConv = m.escalationDue([], new Map(), A, [PARAMS_A5.zThresholdMicro])
  eq(escAtConv.conviction?.lifetime?.windows, 1, 'A5-26: AT the 5σ line the conviction fires (inclusive boundary, W=1 identity)')
  eq(escAtConv.conviction?.lifetime?.zLifeMicro, PARAMS_A5.zThresholdMicro, 'A5-26: …at exactly zThresholdMicro')
  eq(
    m.selfBanDueNow({ escalation: escAtConv, selfBanAppended: false }),
    true,
    'A5-26: …and the 90d self-ban obligation fires exactly there, obligation ≡ conviction',
  )

  // ==== 7. fold bans ========================================================
  console.log('\n· a4-v1 fold `bans` (selfban events only) …')
  const mkEv = (height, type, payload, lane = 'w') => ({
    body: { v: 1, lane, type, root: ROOTB, key: ROOTB, height, ts: 1_000 + height, payload },
    sig: 'A'.repeat(86),
  })
  // A5-22: the fold DERIVES a self-ban's expiry from the selfban EVENT's
  // witnessed ts + the §9 term (== tier2.selfBanExpiryWts): NEVER the self-
  // asserted payload expiryWts. mkEv stamps ts = 1_000 + height.
  const untilOf = (ts) => m.selfBanExpiryWts(ts)
  const s0 = foldMod.a4Fold.init(ROOTB)
  eq(Object.keys(s0.bans).length, 0, 'init: bans starts empty (byte-compatible with the A4 reserved shape)')
  // A5-38: a self-ban folds ONLY for a ladder the account has actually rated a
  // game in (a key of state.ladders). A real rated segment needs a witness sig
  // + an M-of-N-cosigned oppCkpt (heavy to synthesize here), so these fixtures
  // seed the ladders under test with ladderInit() (the §6 seed) as the faithful
  // "prior rated games folded" precondition: the gate itself (unplayed ladders
  // never fold, bounding the map) is exercised directly by the A5-38 regression.
  const seedLadders = (st, ...lids) => ({
    ...st,
    ladders: { ...st.ladders, ...Object.fromEntries(lids.map((l) => [l, foldMod.ladderInit()])) },
  })
  const verdictDigest = m.tier2VerdictDigest(rec.body)
  const banPayload = { kind: 'anticheat', ladder: LAD, window: 2, expiryWts: 9_000_000, verdict: verdictDigest }
  let s = foldMod.a4Fold.step(seedLadders(s0, LAD, 'bullet-60+0'), mkEv(0, 'genesis', { params: b64({ p: 1 }), name: 'x' }))
  const bansAfterGenesis = s.bans
  s = foldMod.a4Fold.step(s, mkEv(1, 'selfban', banPayload))
  eq(Object.keys(s.bans).length, 1, 'selfban folds into bans (one entry)')
  eq(s.bans[LAD]?.until, untilOf(1_001), 'bans[ladder].until = DERIVED (event ts + §9 term), NOT the self-asserted payload expiryWts (§0/§8/§9, A5-22)')
  ok(s.bans[LAD]?.until !== banPayload.expiryWts, 'the self-asserted payload expiryWts (9_000_000) is IGNORED: expiry is derived, not trusted')
  eq(s.bans[LAD]?.window, 2, 'bans[ladder].window = convicting window')
  eq(s.bans[LAD]?.verdict, verdictDigest, 'bans[ladder].verdict = the Tier-2 verdict digest')
  eq(s.byType.selfban, 1, 'byType counts the selfban')
  ok(bansAfterGenesis === s0.bans, 'non-selfban events keep the SAME bans reference (bytes cannot drift)')
  // a later selfban with a LARGER derived until (here: a later event ts) EXTENDS
  s = foldMod.a4Fold.step(s, mkEv(2, 'selfban', { ...banPayload, window: 3, expiryWts: 12_000_000 }))
  eq(Object.keys(s.bans).length, 1, 'same ladder: still one entry')
  eq(s.bans[LAD]?.until, untilOf(1_002), 'a later selfban EXTENDS the ban (until derived from the later event ts, not the payload 12_000_000)')
  eq(s.bans[LAD]?.window, 3, 'the extending selfban carries its own window (until/window/verdict move together)')
  // second ladder
  s = foldMod.a4Fold.step(s, mkEv(3, 'selfban', { ...banPayload, ladder: 'bullet-60+0' }))
  eq(Object.keys(s.bans).length, 2, 'a second ladder gets its own entry (bounded: one per ladder)')
  // malformed / wrong-lane selfbans are ignored
  const hashBefore = stateHash(s.bans)
  s = foldMod.a4Fold.step(s, mkEv(4, 'selfban', { ...banPayload, kind: 'other' }))
  eq(stateHash(s.bans), hashBefore, 'malformed selfban payload ignored (bans unchanged)')
  eq(s.byType.selfban, 4, '…while the basic counters still tick (byType counts the event, valid or not)')
  s = foldMod.a4Fold.step(s, mkEv(5, 'selfban', { ...banPayload, expiryWts: -1 }))
  eq(stateHash(s.bans), hashBefore, 'non-integer expiryWts ignored')
  s = foldMod.a4Fold.step(s, { body: { v: 1, lane: 'p', type: 'selfban', root: ROOTB, key: ROOTB, height: 0, ts: 1, payload: banPayload }, sig: 'A'.repeat(86) })
  eq(stateHash(s.bans), hashBefore, 'personal-lane selfban never folds (witnessed lane only)')
  ok(typeof stateHash(s) === 'string', 'full state stays canonical-hashable with bans populated')
  // determinism: independent fold of the same events ⇒ identical bytes
  let sRe = seedLadders(foldMod.a4Fold.init(ROOTB), LAD, 'bullet-60+0')
  sRe = foldMod.a4Fold.step(sRe, mkEv(0, 'genesis', { params: b64({ p: 1 }), name: 'x' }))
  sRe = foldMod.a4Fold.step(sRe, mkEv(1, 'selfban', banPayload))
  sRe = foldMod.a4Fold.step(sRe, mkEv(2, 'selfban', { ...banPayload, window: 3, expiryWts: 12_000_000 }))
  sRe = foldMod.a4Fold.step(sRe, mkEv(3, 'selfban', { ...banPayload, ladder: 'bullet-60+0' }))
  sRe = foldMod.a4Fold.step(sRe, mkEv(4, 'selfban', { ...banPayload, kind: 'other' }))
  sRe = foldMod.a4Fold.step(sRe, mkEv(5, 'selfban', { ...banPayload, expiryWts: -1 }))
  sRe = foldMod.a4Fold.step(sRe, { body: { v: 1, lane: 'p', type: 'selfban', root: ROOTB, key: ROOTB, height: 0, ts: 1, payload: banPayload }, sig: 'A'.repeat(86) })
  eq(stateHash(sRe), stateHash(s), 'independent refold ⇒ byte-identical state (incl. bans)')

  // ---- A5-38 regression: `bans` is bounded to PLAYED ladders (no free-selfban
  // bloat). Pre-fix banStep inserted one entry per DISTINCT selfban ladder
  // string with no eviction, and zSelfBanPayload.ladder is any 1..64-char
  // string never checked against a real ladder, so N witnessed selfbans with
  // N fabricated ladder strings grew `bans` to N entries, embedded verbatim in
  // every a4-v1 checkpoint viewers recompute and carry. The fix folds a selfban
  // ONLY for a ladder present in state.ladders (one the account has rated a game
  // in), so |bans| ≤ |ladders| and each entry costs one WITNESSED rated game.
  console.log('\n· A5-38: `bans` is bounded to played ladders (fabricated-ladder selfbans cannot bloat state) …')
  let g = seedLadders(foldMod.a4Fold.init(ROOTB), LAD) // exactly ONE played ladder
  g = foldMod.a4Fold.step(g, mkEv(0, 'genesis', { params: b64({ p: 1 }), name: 'x' }))
  g = foldMod.a4Fold.step(g, mkEv(1, 'selfban', banPayload)) // LAD is played ⇒ folds
  eq(Object.keys(g.bans).length, 1, 'A5-38: a self-ban on a PLAYED ladder folds (baseline: one entry)')
  const NBLOAT = 64
  for (let i = 0; i < NBLOAT; i++) {
    // each a DISTINCT, schema-valid, witnessed selfban for an UNPLAYED ladder
    g = foldMod.a4Fold.step(g, mkEv(2 + i, 'selfban', { ...banPayload, ladder: `ghost-ladder-${i}`, window: i }))
  }
  eq(
    Object.keys(g.bans).length,
    1,
    `A5-38: ${NBLOAT} distinct fabricated-ladder selfbans add ZERO entries (pre-fix: +${NBLOAT}). Bounded to played ladders`,
  )
  ok(!Object.prototype.hasOwnProperty.call(g.bans, 'ghost-ladder-0'), 'A5-38: a fabricated/unplayed ladder never enters bans')
  ok(
    Object.keys(g.bans).length <= Object.keys(g.ladders).length,
    'A5-38: |bans| ≤ |ladders|. The state-boundedness invariant (bans ⊆ the witness-bound ladders domain)',
  )
  eq(g.byType.selfban, 1 + NBLOAT, 'A5-38: the basic byType counter still ticks every selfban (only `bans` folding is gated, never the counters)')
  // a genuine self-ban on the PLAYED ladder still lands through the gate amid the bloat attempt
  g = foldMod.a4Fold.step(g, mkEv(2 + NBLOAT, 'selfban', { ...banPayload, ladder: LAD, window: 4 }))
  eq(Object.keys(g.bans).length, 1, 'A5-38: a real self-ban on the played ladder still folds through the gate (still one entry)')
  eq(g.bans[LAD]?.window, 4, 'A5-38: … and updates it (monotonic extend by the later event ts). The gate blocks only UNPLAYED ladders')

  // ---- A5-22 regression: derived + monotonic self-ban expiry (no self-un-ban)
  // The exact finding scenario: a convict appends a compliant selfban, then a
  // SECOND witnessed selfban {expiryWts:0} mid-sentence to un-ban itself.
  // Pre-fix banStep did `until := payload.expiryWts` (newest wins) → until=0 →
  // displayState 'placement' + pairingLegal legal. Now expiry is DERIVED from
  // the event ts and folds monotonically (max), so the ban survives.
  console.log('\n· A5-22: self-ban expiry is derived + monotonic (a convict cannot self-un-ban) …')
  const TRIG = 1_800_000_000_000 // §8 trigger witnessed time
  const compliantExpiry = m.selfBanExpiryWts(TRIG) // = TRIG + §9 term
  const midSentence = TRIG + 86_400_000 // trigger + 1 day, inside the 90-day term
  const evAt = (h, ts, payload) => ({ body: { v: 1, lane: 'w', type: 'selfban', root: ROOTB, key: ROOTB, height: h, ts, payload }, sig: 'A'.repeat(86) })
  let a = seedLadders(foldMod.a4Fold.init(ROOTB), LAD)
  a = foldMod.a4Fold.step(a, mkEv(0, 'genesis', { params: b64({ p: 1 }), name: 'x' }))
  // h1: the compliant self-ban. Event ts == trigger, so the derived until
  // equals the compliant client's own selfBanExpiryWts(trigger).
  a = foldMod.a4Fold.step(a, evAt(1, TRIG, m.makeSelfBanPayload({ ladder: LAD, window: 2, expiryWts: compliantExpiry, verdictDigest })))
  eq(a.bans[LAD]?.until, compliantExpiry, 'compliant selfban: derived until == selfBanExpiryWts(trigger) (fold agrees with the compliant client)')
  eq(displayMod.displayState({ n: 120, r: 1_534_000_000 }, 'Blitz', a.bans[LAD], midSentence).state, 'banned', 'mid-sentence control: displayState = banned')
  // h2: the un-ban attempt. A second selfban carrying expiryWts:0.
  const aAttack = foldMod.a4Fold.step(a, evAt(2, midSentence, { kind: 'anticheat', ladder: LAD, window: 0, expiryWts: 0, verdict: b64({ any: 'digest' }) }))
  ok(aAttack.bans[LAD]?.until >= compliantExpiry, 'A5-22: {expiryWts:0} selfban does NOT zero the ban. Expiry is derived, and max forbids shrinking (pre-fix: until=0)')
  const dispAfter = displayMod.displayState({ n: 120, r: 1_534_000_000 }, 'Blitz', aAttack.bans[LAD], midSentence)
  eq(dispAfter.state, 'banned', 'A5-22: displayState STILL banned mid-sentence after the un-ban attempt (was placement pre-fix)')
  const convictView = { root: ROOTB, ladderId: LAD, ratingMicro: 1_534_000_000, rdMicro: 60_000_000, tMicro: 900_000, display: dispAfter, banUntilWts: aAttack.bans[LAD]?.until }
  const oppView = { root: b64({ p: 'opp' }), ladderId: LAD, ratingMicro: 1_540_000_000, rdMicro: 60_000_000, tMicro: 900_000, display: { state: 'ranked', rating: 1540 } }
  const vAttack = pairingMod.pairingLegal(convictView, oppView, midSentence)
  ok(!vAttack.legal && vAttack.reason === 'banned', 'A5-22: pairingLegal STILL illegal (banned) after the un-ban attempt (was legal pre-fix)')
  // Pure monotonic guard, independent of the ts derivation: a selfban whose
  // DERIVED until would be SMALLER (an earlier event ts) cannot shorten the ban.
  const aEarlier = foldMod.a4Fold.step(a, evAt(2, TRIG - 10 * 86_400_000, { kind: 'anticheat', ladder: LAD, window: 0, expiryWts: 0, verdict: b64({ any: 'x' }) }))
  eq(aEarlier.bans[LAD]?.until, compliantExpiry, 'A5-22 monotonic: a selfban with an earlier ts (smaller derived until) cannot shorten the ban')
  eq(aEarlier.bans[LAD]?.window, 2, 'A5-22 monotonic: the losing selfban’s window/verdict are not adopted either')

  // ---- A5-08 regression: the un-ban path + the deterministic self-ban
  // deadline: newest-wins ONLY under monotonic DERIVED expiry.
  // A5-08 flagged that section 7's sole newest-wins coverage GREW the payload
  // expiry (9M -> 12M) and asserted the ban grew, pinning the PRE-A5-22
  // payload-driven "newest wins unconditionally" overwrite, while (1) the
  // adversarial direction (a second selfban that ERASES an active ban), (2) the
  // folded until vs selfBanExpiryWts(trigger) deadline check (the PIN-fuse
  // analogue), and (3) the payload-inert EXTEND direction had no test anywhere.
  // A5-22/A5-38 fixed the fold (expiry DERIVED from the event ts, folded
  // MONOTONICALLY, bounded to played ladders); this pins A5-08's EXACT failure
  // scenario and the one direction the A5-22 shrink test did not cover.
  console.log('\n· A5-08: un-ban rejected + newest-wins only under monotonic derived expiry …')
  const T8 = 1_700_000_000_000 // §8 trigger witnessed time
  let z8 = seedLadders(foldMod.a4Fold.init(ROOTB), LAD)
  z8 = foldMod.a4Fold.step(z8, mkEv(0, 'genesis', { params: b64({ p: 1 }), name: 'x' }))
  // the compliant self-ban: its DERIVED until is exactly selfBanExpiryWts(ts)
  z8 = foldMod.a4Fold.step(z8, evAt(1, T8, { kind: 'anticheat', ladder: LAD, window: 2, expiryWts: m.selfBanExpiryWts(T8), verdict: verdictDigest }))
  eq(z8.bans[LAD]?.until, m.selfBanExpiryWts(T8), 'A5-08: folded until == selfBanExpiryWts(trigger ts). The deterministic §8/§9 deadline (the PIN-fuse-analogue check the fold-bans suite lacked)')
  const mid8 = T8 + 30 * 86_400_000 // 30 days into the 90-day term
  eq(displayMod.displayState({ n: 120, r: 1_534_000_000 }, 'Blitz', z8.bans[LAD], mid8).state, 'banned', 'A5-08: control, displayState banned 30d into the term')
  // (1) the finding's LITERAL un-ban: a second selfban carrying expiryWts:1.
  const unban8 = foldMod.a4Fold.step(z8, evAt(2, mid8, { kind: 'anticheat', ladder: LAD, window: 0, expiryWts: 1, verdict: b64({ any: 'x' }) }))
  eq(unban8.bans[LAD]?.until, m.selfBanExpiryWts(mid8), 'A5-08: the un-ban selfban{expiryWts:1} folds until = selfBanExpiryWts(its event ts), NEVER the payload 1 (pre-fix: bans.until=1, ban erased)')
  eq(displayMod.displayState({ n: 120, r: 1_534_000_000 }, 'Blitz', unban8.bans[LAD], mid8).state, 'banned', 'A5-08: displayState STILL banned after the un-ban attempt (pre-fix: fell through to provisional/ranked)')
  const conv8 = { root: ROOTB, ladderId: LAD, ratingMicro: 1_534_000_000, rdMicro: 60_000_000, tMicro: 900_000, display: displayMod.displayState({ n: 120, r: 1_534_000_000 }, 'Blitz', unban8.bans[LAD], mid8), banUntilWts: unban8.bans[LAD]?.until }
  const opp8 = { root: b64({ p: 'opp8' }), ladderId: LAD, ratingMicro: 1_540_000_000, rdMicro: 60_000_000, tMicro: 900_000, display: { state: 'ranked', rating: 1540 } }
  const pl8 = pairingMod.pairingLegal(conv8, opp8, mid8)
  ok(!pl8.legal && pl8.reason === 'banned', 'A5-08: pairingLegal STILL illegal (banned) after the un-ban attempt (pre-fix: legal)')
  // (2) newest-wins ONLY under monotonic expiry. The ORIGINAL defect's own
  // direction, inverted: a HUGE payload expiryWts with a NON-advancing event ts
  // must NOT extend the ban (pre-A5-22 `until := payload.expiryWts` would jump it
  // to the huge number). The payload is fully inert; only the DERIVED until wins.
  const huge8 = foldMod.a4Fold.step(z8, evAt(2, T8 - 10 * 86_400_000, { kind: 'anticheat', ladder: LAD, window: 9, expiryWts: 9_999_999_999_999, verdict: b64({ any: 'y' }) }))
  eq(huge8.bans[LAD]?.until, m.selfBanExpiryWts(T8), 'A5-08: a selfban with a HUGE payload expiryWts but an EARLIER event ts does NOT extend the ban. Newest-wins is gated on the DERIVED until, the payload number is inert')
  eq(huge8.bans[LAD]?.window, 2, 'A5-08: … and the losing selfban window/verdict are not adopted (until/window/verdict move together)')
  // (3) first-wins on a TIE: an equal derived until (same event ts) is a no-op
  // too: the `prev.until >= until` boundary (monotonic max, first-wins on tie).
  const tie8 = foldMod.a4Fold.step(z8, evAt(2, T8, { kind: 'anticheat', ladder: LAD, window: 7, expiryWts: 5, verdict: b64({ any: 'z' }) }))
  eq(tie8.bans[LAD]?.window, 2, 'A5-08: an equal derived until (same event ts) does not overwrite. First-wins on tie (incumbent window/verdict kept)')

  // ==== 8. pairingLegal honors bans =========================================
  console.log('\n· pairingLegal: active bans make pairing illegal …')
  const ranked = (root, rating, extra = {}) => ({
    root,
    ladderId: LAD,
    ratingMicro: rating * 1_000_000,
    rdMicro: 60_000_000,
    tMicro: 900_000,
    display: { state: 'ranked', rating },
    ...extra,
  })
  const AT = 5_000_000
  const pa = ranked(b64({ p: 'a' }), 1500)
  const pb = ranked(b64({ p: 'b' }), 1510)
  ok(pairingMod.pairingLegal(pa, pb, AT).legal, 'baseline: close ranked pair is legal')
  const paBan = ranked(b64({ p: 'a' }), 1500, { banUntilWts: AT + 1 })
  const vBanA = pairingMod.pairingLegal(paBan, pb, AT)
  ok(!vBanA.legal && vBanA.reason === 'banned', 'active ban on a ⇒ illegal "banned"')
  const vBanB = pairingMod.pairingLegal(pb, paBan, AT)
  ok(!vBanB.legal && vBanB.reason === 'banned', 'active ban on b ⇒ illegal "banned" (both directions)')
  eq(JSON.stringify(vBanA), JSON.stringify(vBanB), 'pairingLegal(a,b) ≡ pairingLegal(b,a) under bans (symmetry)')
  ok(pairingMod.pairingLegal(ranked(b64({ p: 'a' }), 1500, { banUntilWts: AT }), pb, AT).legal, 'ban expiring exactly AT atWts no longer binds (until > atWts rule)')
  const paDispBan = { ...ranked(b64({ p: 'a' }), 1500), display: { state: 'banned', until: AT + 1 } }
  const vDisp = pairingMod.pairingLegal(paDispBan, pb, AT)
  ok(!vDisp.legal && vDisp.reason === 'banned', "the 'banned' display state alone also blocks pairing")
  const pool = (root, extra = {}) => ({
    root, ladderId: LAD, ratingMicro: 1_200_000_000, rdMicro: 350_000_000, tMicro: 500_000,
    display: { state: 'placement', n: 3, of: 10 }, ...extra,
  })
  ok(pairingMod.pairingLegal(pool(b64({ p: 'c' })), pool(b64({ p: 'd' })), AT).legal, 'baseline: unranked pool pair is legal')
  const vPoolBan = pairingMod.pairingLegal(pool(b64({ p: 'c' }), { banUntilWts: AT + 1 }), pool(b64({ p: 'd' })), AT)
  ok(!vPoolBan.legal && vPoolBan.reason === 'banned', 'a banned ladder cannot pair even in the unranked pool')
  ok(pairingMod.pairingLegal(ranked(b64({ p: 'a' }), 1500, { banUntilWts: 1.5 }), pb, AT).legal, 'malformed banUntilWts is no ban (fail toward the stricter later evidence, never a crash)')
  const vSame = pairingMod.pairingLegal(paBan, { ...paBan }, AT)
  ok(!vSame.legal && vSame.reason === 'same-root', 'rule order: same-root still precedes the ban rule')

  // ==== 9. display surfaces =================================================
  console.log('\n· display: the banned surface state …')
  const lState = { n: 120, r: 1_534_000_000, rd: 60_000_000 }
  eq(JSON.stringify(displayMod.displayState(lState, 'Blitz')), JSON.stringify({ state: 'ranked', rating: 1534 }), 'no ban args: pre-A5 rendering unchanged (ranked)')
  eq(
    JSON.stringify(displayMod.displayState(lState, 'Blitz', { until: AT + 1 }, AT)),
    JSON.stringify({ state: 'banned', until: AT + 1 }),
    'active ban ⇒ banned surface state',
  )
  eq(JSON.stringify(displayMod.displayState(lState, 'Blitz', { until: AT }, AT)), JSON.stringify({ state: 'ranked', rating: 1534 }), 'expired ban falls through to the normal state')
  eq(
    JSON.stringify(displayMod.displayState({ n: 3, r: 1_200_000_000, rd: 350_000_000 }, 'Blitz', { until: AT + 1 }, AT)),
    JSON.stringify({ state: 'banned', until: AT + 1 }),
    'banned overrides placement too (the ban is the surface)',
  )
  eq(JSON.stringify(displayMod.displayState(lState, 'Blitz', { until: AT + 1 })), JSON.stringify({ state: 'ranked', rating: 1534 }), 'ban without atWts is not evaluated (no ambient time: caller must pin the instant)')
  const pv = displayMod.pairViewOf(ROOTB, LAD, lState, 900_000, 'Blitz', { until: AT + 1 }, AT)
  eq(pv.banUntilWts, AT + 1, 'pairViewOf carries banUntilWts from the fold ban')
  eq(pv.display.state, 'banned', 'pairViewOf display is banned at the pinned wts')
  const vPv = pairingMod.pairingLegal(pv, pb, AT)
  ok(!vPv.legal && vPv.reason === 'banned', 'fold ban → pairViewOf → pairingLegal end-to-end refusal')
  const pvClean = displayMod.pairViewOf(ROOTB, LAD, lState, 900_000, 'Blitz')
  eq(pvClean.banUntilWts, undefined, 'pairViewOf without a ban carries no banUntilWts')
  // §9 bans are public facts: rendered to EVERY viewer
  eq(JSON.stringify(pairingMod.spectatorOpponentInfo(paDispBan)), JSON.stringify({ kind: 'banned', until: AT + 1 }), 'spectator sees banned')
  eq(
    JSON.stringify(pairingMod.visibleOpponentInfo(pool(b64({ p: 'c' })), paDispBan)),
    JSON.stringify({ kind: 'banned', until: AT + 1 }),
    'even a placement viewer sees banned (bans are public; ratings stay hidden)',
  )
  eq(JSON.stringify(pairingMod.visibleOpponentInfo(pool(b64({ p: 'c' })), pb)), JSON.stringify({ kind: 'unranked-pool' }), 'non-banned opponents: the §6 information rule is unchanged')
  eq(JSON.stringify(pairingMod.visibleOpponentInfo(pb, pool(b64({ p: 'c' })))), JSON.stringify({ kind: 'bracket', lo: 800, hi: 1600 }), 'ranked viewer on a provisional: bracket only, unchanged')

  // ---- second-bundle determinism anchor ------------------------------------
  console.log('\n· cross-bundle determinism …')
  const m2 = await bundleOnce(outdir, 'b')
  eq(m2.tier2AnchorsDigest(A), GOLDEN.anchorsDigest, 'second esbuild bundle: identical anchors digest')
  eq(hashMod.toB64u(m2.windowSalt(mkReveal(1), { tLease: 2 })), GOLDEN.saltW1, 'second bundle: identical salt derivation')
  eq(m2.windowVerdict(w30(met), A).zMicro, GOLDEN.zMet30, 'second bundle: identical zMicro bits')
  eq(
    JSON.stringify(m2.lifetimeVerdict([met26, met26, met26, met26])),
    JSON.stringify(m.lifetimeVerdict([met26, met26, met26, met26])),
    'second bundle: identical lifetimeVerdict bits',
  )
}

main()
