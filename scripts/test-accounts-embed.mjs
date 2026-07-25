// Headless test for the A6 L3 embedder seams (src/shared/accounts/judge/
// embed.ts): banDeadline (the §8 conviction-anchored deadline min. A5-20/
// A5-21 residual), consensusSaltOpts + windowAnchor (the A5-17/A5-18
// consensus wiring, composed with tier2's verifySaltReveal on synthetic
// grants), suppressionScan (the read-time auditor's chain-side absence
// check), and publishVerdictRow / adoptVerdictRow[Judge] (storage binding +
// the A5-33 verified-adopt ban path).
//
//   node scripts/test-accounts-embed.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-tier2.mjs). Synthetic fixtures only:
// RAW fixed 32-byte seeds → ed25519 keypairs, the tier2 suite's frozen
// anchor-bundle fixture, hand-built chain-event bodies. No engine, no network.
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
function throwsE(fn, msg) {
  try {
    fn()
    ok(false, `${msg} (did not throw)`)
  } catch (e) {
    ok(e?.name === 'EmbedInputError', `${msg} (${e?.name}: ${String(e?.message).slice(0, 90)})`)
  }
}
function throwsT2(fn, msg) {
  try {
    fn()
    ok(false, `${msg} (did not throw)`)
  } catch (e) {
    ok(e?.name === 'Tier2InputError', `${msg} (${e?.name}: ${String(e?.message).slice(0, 90)})`)
  }
}

async function bundleOnce(outdir) {
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    `export * from '${SRC}/judge/index.ts'\n` +
      `export * as embedMod from '${SRC}/judge/embed.ts'\n` +
      `export * as eventsMod from '${SRC}/events.ts'\n` +
      `export * as hashMod from '${SRC}/hash.ts'\n` +
      `export * as codecMod from '${SRC}/codec.ts'\n`,
  )
  const outfile = resolve(outdir, 'embed.mjs')
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

// ---- goldens (recorded from a green run 2026-07-22; determinism anchors) ----
const GOLDEN = {
  // Cross-pins against scripts/test-accounts-tier2.mjs's frozen fixtures: the
  // 25-inno→blat chain's escalation (3σ) and conviction (5σ) crossings.
  escAtIndex: 31,
  convAtIndex: 34,
  convZ: 5_109_979,
  zLife4x26: 5_200_000,
  // windowAnchor('g-29') under ANCHOR_TAG, bit-frozen.
  anchorW1: 'VzJI9RCqDeT8EhviYwcgb0KsJaKij1aTk5cBAy_j8fs',
  // tier2VerdictKey(ROOTB fixture), bit-frozen.
  verdictKey: 'YlXIcyZJVr5NGcOQqwv2bkZPaPEyp43W_4GazVbWBDU',
}

async function run(outdir) {
  console.log('· bundling src/shared/accounts (judge barrel + embed seams) …')
  const m = await bundleOnce(outdir)
  const { embedMod: E, eventsMod, hashMod, codecMod } = m
  const { PARAMS_A5, PARAMS_A5_DIGEST } = m
  const K = PARAMS_A5.reganK
  const b64 = (v) => hashMod.toB64u(codecMod.canonicalHash(v))

  // ---- shared fixtures (mirrors the tier2 suite's frozen shapes) -----------
  const LAD = 'blitz-300+0'
  const OTHER_LAD = 'rapid-600+0'
  const ROOTB = b64({ r: 'accused' })
  const OTHERB = b64({ r: 'other' })
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
  // SUITE-LOCAL synthetic anchor bundle: the tier2 suite's frozen fixture
  // (anchor-INJECTED estimator; the MEASURED judge bundle is exercised via
  // TIER2_ANCHORS_JUDGE in §4's adopt-wrapper block). Do not "update".
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
  const chainOf = (entries) => {
    const games = entries.map((e) => ({ game: e.rec.game, side: e.side, elo: e.elo }))
    const records = new Map(entries.map((e) => [e.rec.game, e.rec]))
    return { games, records }
  }

  // ==== 1. banDeadline. The §8 conviction-anchored deadline ================
  console.log('\n· banDeadline (A5-20/A5-21 residual: min by chain ordinal, conviction-only) …')
  // Real trailing-K conviction: the tier2 suite's frozen 25-inno→blat chain.
  const ents35 = [...Array.from({ length: 25 }, (_, i) => inno(i)), ...Array.from({ length: 10 }, (_, i) => blat(i))]
  const c35 = chainOf(ents35)
  const esc35 = m.escalationDue(c35.games, c35.records, A)
  eq(esc35.due, true, 'fixture: 25 inno → 10 blat escalates')
  eq(esc35.atIndex, GOLDEN.escAtIndex, 'fixture: escalation (3σ) crossing at index 31 (tier2 golden)')
  ok(esc35.conviction !== undefined, 'fixture: conviction (5σ) present')
  eq(esc35.conviction?.atIndex, GOLDEN.convAtIndex, 'fixture: conviction crossing at index 34 (tier2 golden)')
  eq(esc35.conviction?.zMicro, GOLDEN.convZ, 'fixture: conviction z golden')
  let resolverCalled = false
  const dl35 = E.banDeadline(esc35, () => {
    resolverCalled = true
    return 0
  })
  ok(dl35 !== null, 'trailing-K conviction ⇒ a deadline exists')
  eq(dl35.ordinal, GOLDEN.convAtIndex, 'deadline ordinal = the CONVICTION-completing game (34)')
  ok(dl35.ordinal !== esc35.atIndex, 'deadline anchors at the conviction (34), NEVER the 3σ escalation crossing (31), A5-21')
  eq(dl35.source, 'trailingK', 'source names the trailing-K arm')
  eq(dl35.game, 'blat-9', 'deadline carries the completing game key')
  eq(resolverCalled, false, 'resolver is never invoked without a lifetime conviction arm')

  // Real lifetime conviction: four closed windows at 2.6σ (J7 metering closure).
  const escLife = m.escalationDue([], new Map(), A, [2_600_000, 2_600_000, 2_600_000, 2_600_000])
  eq(escLife.due, true, 'lifetime fixture: 4×2.6σ windows escalate')
  eq(escLife.conviction?.lifetime?.zLifeMicro, GOLDEN.zLife4x26, 'lifetime conviction z golden (5.2σ exact)')
  eq(escLife.conviction?.lifetime?.windows, 4, 'lifetime conviction at the earliest convicting prefix W=4')
  const dlLife = E.banDeadline(escLife, (W) => W * K - 1 + 7) // caller maps W → b(W)−1 (off(W)=7)
  eq(dlLife.ordinal, 4 * K - 1 + 7, 'lifetime deadline = the caller-resolved ordinal b(W)−1 (126)')
  eq(dlLife.source, 'lifetime', 'source names the lifetime arm')
  eq(dlLife.lifetimeWindows, 4, 'deadline carries the convicting window count W')

  // Min by ordinal, BOTH orders + tie (synthetic both-arm convictions).
  const mkEsc = (conviction) => ({ due: true, atIndex: 30, game: 'esc-g', zMicro: 3_100_000, conviction })
  const bothLife = { zLifeMicro: 5_200_000, windows: 4 }
  const dA = E.banDeadline(mkEsc({ atIndex: 200, game: 'g200', zMicro: 5_000_000, lifetime: bothLife }), () => 126)
  eq(dA.source, 'lifetime', 'both arms: lifetime ordinal 126 < trailing 200 ⇒ lifetime wins')
  eq(dA.ordinal, 126, 'both arms: min ordinal is the deadline (lifetime first)')
  const dB = E.banDeadline(mkEsc({ atIndex: 100, game: 'g100', zMicro: 5_000_000, lifetime: bothLife }), () => 126)
  eq(dB.source, 'trailingK', 'both arms flipped: trailing 100 < lifetime 126 ⇒ trailing-K wins')
  eq(dB.ordinal, 100, 'both arms flipped: min ordinal is the deadline (trailing first)')
  const dT = E.banDeadline(mkEsc({ atIndex: 119, game: 'g119', zMicro: 5_000_000, lifetime: bothLife }), () => 119)
  eq(dT.source, 'trailingK', 'tie (same ordinal = same game): the game-key-carrying trailing-K arm is reported')
  // Resolver bound acceptance at the partition-geometry edges b(W)−1 ∈ [WK−1, (W+1)K−2].
  eq(E.banDeadline(mkEsc({ lifetime: bothLife }), () => 4 * K - 1).ordinal, 119, 'resolver at lower bound WK−1 accepted')
  eq(E.banDeadline(mkEsc({ lifetime: bothLife }), () => 5 * K - 2).ordinal, 148, 'resolver at upper bound (W+1)K−2 accepted')

  // Escalation alone NEVER produces a deadline (honest never banned).
  const ents32 = [...Array.from({ length: 25 }, (_, i) => inno(i)), ...Array.from({ length: 7 }, (_, i) => blat(i))]
  const c32 = chainOf(ents32)
  const esc32 = m.escalationDue(c32.games, c32.records, A)
  eq(esc32.due, true, 'fixture: 25 inno → 7 blat escalates (3σ) …')
  eq(esc32.conviction, undefined, '… but never convicts (5σ)')
  eq(E.banDeadline(esc32, () => 0), null, 'escalation-only verdict ⇒ NO deadline (A5-21: 3σ obliges analysis, never a ban)')
  eq(E.banDeadline({ due: false }, () => 0), null, 'not-due verdict ⇒ no deadline')

  console.log('\n· banDeadline fail-closed matrix …')
  throwsE(() => E.banDeadline(null, () => 0), 'null escalation refused')
  throwsE(() => E.banDeadline('x', () => 0), 'non-object escalation refused')
  throwsE(() => E.banDeadline({}, () => 0), 'missing due refused')
  throwsE(() => E.banDeadline(esc35, 'nope'), 'non-function resolver refused')
  throwsE(() => E.banDeadline(mkEsc({}), () => 0), 'conviction with neither arm refused')
  throwsE(() => E.banDeadline(mkEsc({ atIndex: 34 }), () => 0), 'trailing arm missing game/zMicro refused')
  throwsE(
    () => E.banDeadline(mkEsc({ atIndex: K - 2, game: 'g', zMicro: 5_000_000 }), () => 0),
    'atIndex below K−1 refused (no trailing-K window completes there)',
  )
  throwsE(() => E.banDeadline(mkEsc({ atIndex: -1, game: 'g', zMicro: 5_000_000 }), () => 0), 'negative atIndex refused')
  throwsE(
    () => E.banDeadline(mkEsc({ atIndex: 34, game: 'g', zMicro: 4_999_999 }), () => 0),
    'SUB-CONVICTION zMicro refused: no ban may anchor below the 5σ line, whatever the caller asserts (§0)',
  )
  throwsE(() => E.banDeadline(mkEsc({ atIndex: 34, game: '', zMicro: 5_000_000 }), () => 0), 'empty game key refused')
  throwsE(
    () => E.banDeadline(mkEsc({ lifetime: { zLifeMicro: 5_200_000, windows: 0 } }), () => 0),
    'lifetime windows 0 refused',
  )
  throwsE(
    () => E.banDeadline(mkEsc({ lifetime: { zLifeMicro: 4_999_999, windows: 4 } }), () => 126),
    'SUB-CONVICTION zLifeMicro refused (§0, lifetime arm)',
  )
  throwsE(() => E.banDeadline(mkEsc({ lifetime: bothLife }), () => 4 * K - 2), 'resolver below WK−1 refused (broken partition map)')
  throwsE(() => E.banDeadline(mkEsc({ lifetime: bothLife }), () => 5 * K - 1), 'resolver above (W+1)K−2 refused')
  throwsE(() => E.banDeadline(mkEsc({ lifetime: bothLife }), () => 126.5), 'non-integer resolver result refused')
  throwsE(
    () =>
      E.banDeadline(mkEsc({ lifetime: bothLife }), () => {
        throw new Error('boom')
      }),
    'throwing resolver fails closed',
  )
  throwsE(
    () => E.banDeadline({ due: false, conviction: { atIndex: 34, game: 'g', zMicro: 5_000_000 } }, () => 0),
    'conviction on a not-due verdict refused (structurally impossible)',
  )

  // ==== 2. consensusSaltOpts + windowAnchor (A5-17/A5-18 wiring) ============
  console.log('\n· consensusSaltOpts + windowAnchor …')
  const seeds = [1, 2, 3].map((i) => new Uint8Array(32).fill(i))
  const wkeys = seeds.map((s) => hashMod.toB64u(hashMod.ed25519.getPublicKey(s)))
  const copts = E.consensusSaltOpts(wkeys)
  eq(copts.requireAnchor, true, 'consensus opts hard-wire requireAnchor (A5-17: no predictable-before salt is ever blessed)')
  eq(copts.witnessSet.length, 3, 'consensus opts pin the canonical witness set (A5-18: grind-proof)')
  eq(copts.tLease, undefined, 'tLease omitted ⇒ the PARAMS_A2 default applies downstream')
  eq(E.consensusSaltOpts(wkeys, 2).tLease, 2, 'explicit tLease is carried through')
  throwsE(() => E.consensusSaltOpts([]), 'empty witness set refused (must not degrade to the reveal-defined legacy salt)')
  throwsE(() => E.consensusSaltOpts([wkeys[0], wkeys[0]]), 'duplicate witness refused')
  throwsE(() => E.consensusSaltOpts([wkeys[0], 'short']), 'non-NodeId member refused')
  throwsE(() => E.consensusSaltOpts('x'), 'non-array witness set refused')
  throwsE(() => E.consensusSaltOpts(Array.from({ length: 65 }, (_, i) => b64({ w: i })), 2), 'oversize witness set refused')
  throwsE(() => E.consensusSaltOpts(wkeys, 0), 'tLease 0 refused')

  const keys60 = Array.from({ length: 60 }, (_, i) => `g-${i}`)
  const aW1 = E.windowAnchor(keys60, 1)
  eq(aW1.length, 43, 'windowAnchor is a 32-byte b64u commitment (SaltReveal.anchor shape)')
  eq(aW1, GOLDEN.anchorW1, 'windowAnchor golden (window 1 ⇒ digest of the game key at ordinal K−1 = g-29)')
  eq(E.windowAnchor(keys60, 1), aW1, 'recomputable-after: independent re-derivation is bit-identical')
  const aW2 = E.windowAnchor(keys60, 2)
  ok(aW2 !== aW1, 'each window binds a different anchor game (ordinal wK−1)')
  eq(E.windowAnchor(keys60.slice(0, 30), 1), aW1, 'only ordinals ≤ wK−1 are consulted: the anchor never reaches into window w (non-circular)')
  throwsE(() => E.windowAnchor(keys60, 0), 'window 0 refused (b(0)=0: no jittered boundary, ordinal −1 does not exist)')
  throwsE(() => E.windowAnchor(keys60, -1), 'negative window refused')
  throwsE(() => E.windowAnchor(keys60, 1.5), 'non-integer window refused')
  throwsE(() => E.windowAnchor(keys60.slice(0, 29), 1), 'anchor game not chained yet ⇒ refused (the §7b unpredictable-before hole this closes)')
  throwsE(() => E.windowAnchor([...keys60.slice(0, 29), ''], 1), 'empty game key at the anchor ordinal refused')
  throwsE(() => E.windowAnchor('x', 1), 'non-array game list refused')

  console.log('\n· consensus opts composed with tier2 verifySaltReveal (synthetic grants) …')
  const TL = 2
  const coptsTL = E.consensusSaltOpts(wkeys, TL)
  const mkRevealA = (win, anchor, which = [0, 1, 2]) => ({
    v: 1,
    scheme: PARAMS_A5.saltScheme,
    root: ROOTB,
    ladder: LAD,
    window: win,
    ...(anchor !== undefined ? { anchor } : {}),
    grants: which.map((i) => m.signSaltGrant(ROOTB, LAD, win, wkeys[i], wkeys[i], seeds[i], 7_000 + i, anchor)),
  })
  const vOK = m.verifySaltReveal(mkRevealA(1, aW1), coptsTL)
  ok(vOK.ok, 'anchored reveal with the full witness set verifies under consensus opts')
  eq(vOK.salt?.length, 43, 'consensus salt derived')
  const canonical2 = [...wkeys].sort(codecMod.compareKeys).slice(0, TL)
  const idxOf = (k) => wkeys.indexOf(k)
  const vPin = m.verifySaltReveal(mkRevealA(1, aW1, canonical2.map(idxOf)), coptsTL)
  ok(vPin.ok && vPin.salt === vOK.salt, 'A5-18 pin holds through the seam: any superset of the canonical threshold subset ⇒ the SAME salt')
  ok(!m.verifySaltReveal(mkRevealA(1, undefined), coptsTL).ok, 'anchorless reveal is REJECTED under consensus opts (A5-17)')
  ok(
    m.verifySaltReveal(mkRevealA(1, undefined), coptsTL).errors.some((e) => e.includes('anchor')),
    'rejection names the missing post-game anchor',
  )
  const nonCanonicalPair = [wkeys.find((k) => !canonical2.includes(k)), canonical2[0]].map(idxOf)
  ok(
    !m.verifySaltReveal(mkRevealA(1, aW1, nonCanonicalPair), coptsTL).ok,
    'a reveal missing a canonical grantor is rejected (the pinned threshold subset is incomplete)',
  )
  const swapped = { ...mkRevealA(1, aW1), anchor: E.windowAnchor(keys60, 2) }
  ok(!m.verifySaltReveal(swapped, coptsTL).ok, 'post-hoc anchor swap invalidates every grant signature (unforgeable)')
  ok(m.verifySaltReveal(mkRevealA(1, undefined), { tLease: TL }).ok, 'contrast: the legacy/diagnostic path (no consensus opts) still admits anchorless reveals')
  ok(
    hashMod.toB64u(m.windowSalt(mkRevealA(1, aW1), coptsTL)) !==
      hashMod.toB64u(m.windowSalt(mkRevealA(1, undefined), { tLease: TL })),
    'the anchor is load-bearing: anchored and legacy salts differ',
  )

  // ==== 3. suppressionScan. The chain-side absence check ===================
  console.log('\n· suppressionScan (§8: the NEXT witnessed-lane event must be the selfban) …')
  const VD = b64({ d: 'verdict' })
  let h = 0
  const ev = (lane, type, payload) => ({
    body: { v: 1, lane, type, root: ROOTB, key: ROOTB, height: h++, ts: 1_000 + h, payload },
    sig: 'unchecked-by-scan',
  })
  const seg = (game) => ev('w', 'segment', { game })
  const pair = (game) => ev('w', 'pairing', { game })
  const prof = () => ev('p', 'profile', { fields: {} })
  const sb = (ladder, window = 0, expiryWts = 9_000_000, verdict = VD) =>
    ev('w', 'selfban', { kind: 'anticheat', ladder, window, expiryWts, verdict })
  const CONV = 'game-conv'
  const eid = (e) => eventsMod.eventId(e.body)

  {
    const ban = sb(LAD)
    const r = E.suppressionScan([seg('g1'), seg(CONV), ban], CONV, LAD)
    eq(r.kind, 'compliant', 'selfban as the next witnessed-lane event ⇒ compliant')
    eq(r.selfBanEvent, eid(ban), 'compliant result names the selfban event id')
    eq(r.selfBan.ladder, LAD, 'compliant result carries the parsed payload')
  }
  eq(E.suppressionScan([seg(CONV), prof(), sb(LAD)], CONV, LAD).kind, 'compliant', 'personal-lane events between game and selfban are ignored (§8 obliges the witnessed lane)')
  {
    const g2 = seg('g2')
    const r = E.suppressionScan([seg(CONV), g2, sb(LAD)], CONV, LAD)
    eq(r.kind, 'suppressed', 'another witnessed-lane event first ⇒ suppressed (even though a selfban follows later)')
    eq(r.deadlineEvent, eid(g2), 'deadlineEvent = the FIRST other witnessed-lane event (what the suppression record mints)')
    eq(r.deadlineType, 'segment', 'deadline event type reported')
  }
  eq(E.suppressionScan([seg(CONV), pair('g3')], CONV, LAD).deadlineType, 'pairing', 'a pairing event violates the obligation too (any witnessed-lane event)')
  eq(E.suppressionScan([seg('g0'), seg(CONV)], CONV, LAD).kind, 'pending', 'no witnessed-lane event after the game yet ⇒ pending (nothing provable)')
  eq(E.suppressionScan([seg(CONV), prof()], CONV, LAD).kind, 'pending', 'only personal-lane events after ⇒ still pending')
  eq(E.suppressionScan([sb(LAD), seg(CONV)], CONV, LAD).kind, 'pending', 'a selfban appended BEFORE the conviction game discharges nothing')
  {
    const mine = sb(LAD)
    const r = E.suppressionScan([seg(CONV), sb(OTHER_LAD), mine], CONV, LAD)
    eq(r.kind, 'compliant', "another ladder's schema-valid selfban is SKIPPED. Near-simultaneous convictions must not ban-trap a compliant client (§0)")
    eq(r.selfBanEvent, eid(mine), '… and THIS ladder’s selfban then discharges the obligation')
  }
  {
    const g4 = seg('g4')
    const r = E.suppressionScan([seg(CONV), sb(OTHER_LAD), g4], CONV, LAD)
    eq(r.kind, 'suppressed', 'the skip yields nothing to a cheater: the deadline still fires on the first consequential event')
    eq(r.deadlineEvent, eid(g4), '… and the deadline is that event, not the other-ladder selfban')
  }
  // A6 review embed-1 (§0; the round's critical): window/expiryWts are NEVER
  // compliance criteria. `window` has no protocol-pinned value across the two
  // conviction arms, and payload `expiryWts` is INERT (the A5-22 fold derives
  // the real §9 term from the event's witnessed ts), so a compliant client
  // can carry ANY values there and must never be condemned for them. The
  // pre-fix strict opts turned exactly such selfbans into 'suppressed'.
  eq(E.suppressionScan([seg(CONV), sb(LAD, 3)], CONV, LAD).kind, 'compliant', 'embed-1: any same-ladder schema-valid selfban discharges (window 3)')
  eq(E.suppressionScan([seg(CONV), sb(LAD, 4)], CONV, LAD).kind, 'compliant', 'embed-1: a DIFFERENT window value is STILL compliant. Window is protocol-unpinned, never a condemnation basis')
  eq(E.suppressionScan([seg(CONV), sb(LAD, 0, 9_000_000)], CONV, LAD).kind, 'compliant', 'embed-1: expiry at the §9 term compliant')
  eq(E.suppressionScan([seg(CONV), sb(LAD, 0, 1)], CONV, LAD).kind, 'compliant', 'embed-1: a SHORT payload expiry is STILL compliant. The field is inert (the fold imposes the derived 90d term regardless)')
  eq(E.suppressionScan([seg(CONV), ev('w', 'selfban', { kind: 'anticheat', ladder: LAD, window: 0 })], CONV, LAD).kind, 'suppressed', 'malformed selfban payload is never compliant (fail-closed) ⇒ deadline')
  eq(E.suppressionScan([pair(CONV), seg(CONV), sb(LAD)], CONV, LAD).kind, 'compliant', 'only a SEGMENT completes the conviction game: a pairing event naming it is not the anchor')

  console.log('\n· suppressionScan fail-closed matrix …')
  throwsE(() => E.suppressionScan([seg('g1')], CONV, LAD), 'conviction game absent from the chain ⇒ scan undefined, refused')
  throwsE(() => E.suppressionScan([seg(CONV), seg(CONV)], CONV, LAD), 'duplicate conviction segments ⇒ malformed chain, refused')
  throwsE(
    () => E.suppressionScan([seg(CONV), { body: { ...sb(LAD).body, root: OTHERB } }], CONV, LAD),
    'mixed roots ⇒ refused (one accused chain only)',
  )
  throwsE(() => E.suppressionScan([seg(CONV), {}], CONV, LAD), 'event without a body refused')
  throwsE(() => E.suppressionScan([{ body: { ...seg(CONV).body, lane: 'x' } }], CONV, LAD), 'unknown lane refused')
  throwsE(() => E.suppressionScan([{ body: { ...seg(CONV).body, payload: null } }], CONV, LAD), 'non-object payload refused')
  throwsE(() => E.suppressionScan([seg(CONV)], '', LAD), 'empty conviction game key refused')
  throwsE(() => E.suppressionScan([seg(CONV)], 'x'.repeat(129), LAD), 'oversize game key refused')
  throwsE(() => E.suppressionScan([seg(CONV)], CONV, ''), 'empty ladder refused')
  throwsE(() => E.suppressionScan('x', CONV, LAD), 'non-array chain refused')
  throwsE(
    () => E.suppressionScan([seg(CONV), sb(LAD), 'garbage'], CONV, LAD),
    'UPFRONT full-domain validation: a malformed event AFTER the would-be resolution still refuses the scan (input-shape-determined, never scan-depth-determined)',
  )

  // ==== 4. publishVerdictRow / adoptVerdictRow[Judge] =======================
  console.log('\n· publishVerdictRow / adoptVerdictRow (A5-33 verified adopt) …')
  const sSeed = new Uint8Array(32).fill(7)
  const SIG = hashMod.toB64u(hashMod.ed25519.getPublicKey(sSeed))
  const entries0 = w30(inno)
  const entries1 = w30(met)
  const mkVerdict = (window, entries, extra = {}) =>
    m.makeTier2Verdict({
      kind: 'verdict',
      root: ROOTB,
      ladder: LAD,
      window,
      entries,
      anchors: A,
      verdictWts: 5_000,
      signer: SIG,
      key: SIG,
      priv: sSeed,
      ...extra,
    })
  const rec0 = mkVerdict(0, entries0)
  const rec1 = mkVerdict(1, entries1)
  const pub = E.publishVerdictRow([rec0, rec1])
  eq(pub.key, m.tier2VerdictKey(ROOTB), 'publish binds the row to the deterministic shard-space key of the ACCUSED root')
  eq(pub.key, GOLDEN.verdictKey, 'verdict key golden (domain-separated, fixed forever)')
  eq(pub.row.v, 1, 'row shape v1')
  eq(pub.row.verdicts.length, 2, 'row carries the records')
  throwsT2(() => E.publishVerdictRow([]), 'empty record list refused (tier2 builder rule)')
  throwsT2(
    () => E.publishVerdictRow([rec0, { ...rec1, body: { ...rec1.body, root: OTHERB } }]),
    'mixed accused roots refused (tier2 builder rule)',
  )

  const entriesFor = (rec) => (rec.body.window === 0 ? entries0 : rec.body.window === 1 ? entries1 : null)
  const adoptOk = E.adoptVerdictRow({ subjectRoot: ROOTB, key: pub.key, row: pub.row, anchors: A, entriesFor })
  eq(adoptOk.ok, true, 'happy path: every record re-verified from supplied inputs ⇒ adopted')
  eq(adoptOk.adopted.length, 2, 'both records adopted')
  eq(adoptOk.errors.length, 0, 'no errors')
  const jsonRow = JSON.parse(JSON.stringify(pub.row))
  eq(E.adoptVerdictRow({ subjectRoot: ROOTB, key: pub.key, row: jsonRow, anchors: A, entriesFor }).ok, true, 'JSON storage roundtrip adopts identically (plain-value row)')

  const wrongKey = E.adoptVerdictRow({ subjectRoot: ROOTB, key: m.tier2VerdictKey(OTHERB), row: pub.row, anchors: A, entriesFor })
  eq(wrongKey.ok, false, 'row under the wrong shard-space slot is rejected outright')
  eq(wrongKey.adopted.length, 0, '… nothing adopted from a mis-slotted row')
  {
    // A record for a DIFFERENT accused smuggled under this subject's key.
    const recOther = m.makeTier2Verdict({
      kind: 'verdict',
      root: OTHERB,
      ladder: LAD,
      window: 0,
      entries: entries0,
      anchors: A,
      verdictWts: 5_000,
      signer: SIG,
      key: SIG,
      priv: sSeed,
    })
    const r = E.adoptVerdictRow({ subjectRoot: ROOTB, key: pub.key, row: { v: 1, verdicts: [rec0, recOther] }, anchors: A, entriesFor })
    eq(r.ok, false, 'a smuggled foreign-root record fails the row')
    eq(r.adopted.length, 1, '… but the valid record is still individually adopted')
    ok(r.errors.some((e) => e.includes('different accused root')), '… with a typed per-record error')
  }
  {
    const tampered = JSON.parse(JSON.stringify(pub.row))
    tampered.verdicts[0].body.zMicro += 1
    const r = E.adoptVerdictRow({ subjectRoot: ROOTB, key: pub.key, row: tampered, anchors: A, entriesFor })
    eq(r.ok, false, 'tampered zMicro is rejected (exact recompute + signature receipts)')
    eq(r.adopted.length, 1, '… the untouched record still adopts')
  }
  {
    const r = E.adoptVerdictRow({ subjectRoot: ROOTB, key: pub.key, row: pub.row, anchors: A, entriesFor: () => null })
    eq(r.ok, false, 'missing window inputs ⇒ rejected, NEVER adopt unverified (§0)')
    eq(r.adopted.length, 0, '… nothing adopted without inputs')
    ok(r.errors.every((e) => e.includes('Never adopt unverified')), '… with the fail-closed reason')
  }
  eq(
    E.adoptVerdictRow({
      subjectRoot: ROOTB,
      key: pub.key,
      row: pub.row,
      anchors: A,
      entriesFor: () => {
        throw new Error('boom')
      },
    }).ok,
    false,
    'a throwing entriesFor fails closed (verifier never throws)',
  )
  for (const garbage of [null, 'x', { v: 2, verdicts: [rec0] }, { v: 1, verdicts: [] }]) {
    eq(E.adoptVerdictRow({ subjectRoot: ROOTB, key: pub.key, row: garbage, anchors: A, entriesFor }).ok, false, `malformed row ${JSON.stringify(garbage)?.slice(0, 30)} rejected, never thrown`)
  }
  {
    // A6 review embed-2: an over-cap row is BOUNDED (only the first
    // ADOPT_ROW_MAX records are examined) but must never wholesale-suppress
    // the valid evidence inside that prefix, pre-fix, one junk record past
    // the cap erased genuine convictions (adopted: []).
    const over = E.adoptVerdictRow({
      subjectRoot: ROOTB, key: pub.key,
      row: { v: 1, verdicts: [rec0, ...Array.from({ length: 256 }, () => ({ junk: true }))] },
      anchors: A, entriesFor,
    })
    eq(over.ok, false, 'embed-2: oversize row still reports not-ok (overflow + junk noted)')
    eq(over.adopted.length, 1, 'embed-2: …but the VALID record in the examined prefix is STILL adopted. Junk padding cannot suppress evidence')
    ok(over.errors.some((e) => e.includes('Only the first')), 'embed-2: overflow reported explicitly (deterministic prefix)')
    const overCapWork = E.adoptVerdictRow({
      subjectRoot: ROOTB, key: pub.key,
      row: { v: 1, verdicts: Array.from({ length: 5000 }, () => ({ junk: true })) },
      anchors: A, entriesFor,
    })
    eq(overCapWork.ok, false, 'embed-2: bounded untrusted work preserved. A 5000-record junk row is examined only to the cap')
    eq(overCapWork.adopted.length, 0, 'embed-2: …and adopts nothing')
  }
  eq(E.adoptVerdictRow({}).ok, false, 'malformed options object fails closed')

  // Suppression record through the seam: scan → mint → publish → adopt.
  {
    const g2 = seg('g2')
    const scan = E.suppressionScan([seg(CONV), g2], CONV, LAD)
    eq(scan.kind, 'suppressed', 'integration: the auditor scan yields the deadline …')
    const entriesConv = w30(blat) // full reganK window, z ≥ 5σ (tier2 golden zBlat30)
    const recSupp = m.makeTier2Verdict({
      kind: 'suppression',
      root: ROOTB,
      ladder: LAD,
      window: 34,
      entries: entriesConv,
      anchors: A,
      verdictWts: 6_000,
      deadlineEvent: scan.deadlineEvent,
      signer: SIG,
      key: SIG,
      priv: sSeed,
    })
    const pubS = E.publishVerdictRow([recSupp])
    const r = E.adoptVerdictRow({ subjectRoot: ROOTB, key: pubS.key, row: pubS.row, anchors: A, entriesFor: () => entriesConv })
    eq(r.ok, true, '… which mints a suppression record that publishes and adopts (scan → mint → publish → adopt roundtrip)')
    eq(r.adopted[0].body.deadlineEvent, eid(g2), '… carrying the scan-derived deadlineEvent')
  }

  console.log('\n· A5-33: the judge-pinned BAN path …')
  const wrapReject = E.adoptVerdictRowJudge({ subjectRoot: ROOTB, key: pub.key, row: pub.row, entriesFor })
  eq(wrapReject.ok, false, 'adoptVerdictRowJudge REJECTS records computed under a foreign anchor bundle')
  eq(wrapReject.adopted.length, 0, '… adopting none of them')
  ok(wrapReject.errors.every((e) => e.includes('A5-33')), '… each with the A5-33 binding error (checked before any input gathering)')
  {
    const recJ = m.makeTier2Verdict({
      kind: 'verdict',
      root: ROOTB,
      ladder: LAD,
      window: 0,
      entries: entries0,
      anchors: m.TIER2_ANCHORS_JUDGE,
      verdictWts: 5_000,
      signer: SIG,
      key: SIG,
      priv: sSeed,
    })
    const pubJ = E.publishVerdictRow([recJ])
    const r = E.adoptVerdictRowJudge({ subjectRoot: ROOTB, key: pubJ.key, row: pubJ.row, entriesFor: () => entries0 })
    eq(r.ok, true, 'a record computed under TIER2_ANCHORS_JUDGE adopts through the ban path')
    eq(r.adopted.length, 1, '… fully re-verified')
    eq(recJ.body.anchors, m.tier2AnchorsDigest(m.TIER2_ANCHORS_JUDGE), '… its anchors digest names the measured judge bundle')
    // And the injected core applies the same digest gate parameterized:
    eq(
      E.adoptVerdictRow({ subjectRoot: ROOTB, key: pubJ.key, row: pubJ.row, anchors: A, entriesFor: () => entries0 }).ok,
      false,
      'the injected core rejects a judge-anchored row against a different required bundle (same binding, parameterized)',
    )
  }
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-embed-test')
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

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
