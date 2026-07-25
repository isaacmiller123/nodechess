// Headless test for the A4 trust + matchmaking modules
// (src/shared/accounts/mm/{trust,pairing,index}.ts: phase A4 brick 2b,
// rebuilt for the A4 review fixes A4-03/04/05/06/16/20/23/24).
//
//   node scripts/test-accounts-trust-mm.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-reputation.mjs) and drives the §7
// rules over REAL CRYPTOGRAPHY: every fixture the positive assertions rely
// on carries real ed25519 signatures (event sigs, witness terminal sigs with
// the full F1 RatedBinding, attestations, oppCkpt cosignatures), and the
// negative assertions prove forged material moves NOTHING:
//  · body-only fold (A4-04): TrustInputs has no wit-derived members and the
//    fold is wit-INVARIANT: attach/strip arbitrary wit arrays, identical
//    state canonicalHash (asserted for the trust fold AND the whole a4-v1
//    fold);
//  · verified evidence (A4-03): trustEvidenceOf verifies every attestation
//    signature; forged attestations move neither age nor cosig evidence;
//  · verified diversity (A4-05/06): only verifySegmentEvent-passing segments
//    count; fabricated oppCkpts (garbage sig / wrong root / <M cosigs /
//    forged cosig) contribute ZERO; the borrowed-checkpoint attack dies on
//    the root-binding; fresh no-ckpt opponents earn the documented floor
//    proxy only;
//  · pinned pairing time (A4-16): pairingLegal requires atWts, fails closed
//    without it;
//  · golden trustT values re-frozen from chains that PASS verifyChain.
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

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-trust-mm-test')
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

async function run(outdir) {
  // ---- bundle the shared accounts modules -----------------------------------
  console.log('· bundling src/shared/accounts (mm/trust + mm/pairing) …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as events from '${SRC}/events.ts'`,
      `export * as chain from '${SRC}/chain.ts'`,
      `export * as checkpoint from '${SRC}/checkpoint.ts'`,
      `export * as seg from '${SRC}/segment.ts'`,
      `export * as a4 from '${SRC}/ratings/params.ts'`,
      `export * as rep from '${SRC}/ratings/reputation.ts'`,
      `export * as trust from '${SRC}/mm/trust.ts'`,
      `export * as pairing from '${SRC}/mm/pairing.ts'`,
      `export * as mm from '${SRC}/mm/index.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, 'accounts.mjs')
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
  const M = await import(pathToFileURL(outfile).href)
  const { codec, hash, events, chain, checkpoint, seg, a4, rep, trust, pairing, mm } = M
  const P = a4.PARAMS_A4
  const W = P.trustDivWindow

  // ---- fixed raw keypairs -----------------------------------------------------
  const seedOf = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seedOf(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const me = kp(1)
  const meB = me.pubB
  const wkp = kp(40) // the game witness (terminal wstream signatures)
  const fakeId = (s) => hash.toB64u(hash.sha256(hash.utf8(s)))
  const stateHash = (s) => hash.toB64u(codec.canonicalHash(s))

  // Real attester keypairs (age-anchor attestations on chain events).
  const aw = [kp(60), kp(61), kp(62), kp(63)]
  // Real oppCkpt cosigner keypairs: 4 with pairwise-distinct 2-char b64u
  // prefixes (⇒ satisfies the ≥3 prefix-diversity bound), deterministic scan.
  const cosigners = []
  {
    const prefixes = new Set()
    for (let b = 70; cosigners.length < 4 && b < 120; b++) {
      const k = kp(b)
      const pre = k.pubB.slice(0, 2)
      if (prefixes.has(pre)) continue
      prefixes.add(pre)
      cosigners.push(k)
    }
  }
  // Real opponent keypairs (roots that sign their own embedded checkpoints).
  const oppKps = Array.from({ length: 25 }, (_, i) => kp(130 + i * 2))
  const oppK = (i) => oppKps[i]
  const opp = (i) => fakeId(`opp-${i}`) // fresh no-ckpt opponents (plain roots)

  // ---- fixture helpers --------------------------------------------------------
  let ts = 10_000
  const mkChain = () =>
    chain.createAccountChain({ rootPriv: me.priv, rootPub: me.pub, displayName: 'Isaac', ts: 1000 })
  /** One REAL attestation by keypair k over event id (attest.ts byte contract). */
  const mkAtt = (k, id, wts) => ({
    w: k.pubB,
    wts,
    epoch: 0,
    sig: hash.toB64u(hash.ed25519.sign(codec.canonicalBytes({ e: id, epoch: 0, w: k.pubB, wts }), k.priv)),
  })
  /** n FORGED attestations (garbage sigs) at witnessed time wts. */
  const forgedWitArr = (n, wts, prefix = 'wit') =>
    Array.from({ length: n }, (_, i) => ({ w: fakeId(`${prefix}-${i}`), wts, epoch: 0, sig: 'B'.repeat(86) }))
  /** Attach a wit array to the event at index i (outside the signed bytes). */
  const withWitAt = (c, i, wit) => ({ root: c.root, events: c.events.map((e, j) => (j === i ? { ...e, wit } : e)) })
  const withGenesisWit = (c, wit) => withWitAt(c, 0, wit)
  const withLastWit = (c, wit) => withWitAt(c, c.events.length - 1, wit)
  /** REAL attestations by `kps` on the event at index i. */
  const attestAt = (c, i, kps, wts) => withWitAt(c, i, kps.map((k) => mkAtt(k, events.eventId(c.events[i].body), wts)))
  /** VERIFIED opponent checkpoint: root-signed by oppKp, real cosigner
   * attestations (passes segment.ts verifyEmbeddedOppCkpt). The embedded
   * state self-describes as a4-v1 (A4-10 fold-id rule: rated-shaped segments
   * may embed a4-v1 checkpoints only); `state` override for negatives. */
  const mkVerifiedOppCkpt = (oppKp, through, cosigs = cosigners, state = { f: 'a4-v1', n: through }) => {
    const body = {
      v: 1, lane: 'w', type: 'ckpt', root: oppKp.pubB, key: oppKp.pubB, height: through + 1,
      prev: fakeId('ck-prev'), ts: 900,
      payload: { through, state, stateDigest: stateHash(state) },
    }
    const ev = events.signBody(body, oppKp.priv)
    const id = events.eventId(body)
    return { ...ev, wit: cosigs.map((k) => mkAtt(k, id, 900)) }
  }
  /** The verifier's eligibility roster (A4-03/05): the game witness, the 4
   * oppCkpt cosigners and the 4 age attesters are recognized fabric
   * witnesses; everything else (sybil-minted keys included) is not. */
  const ELIG_KEYS = new Set([wkp.pubB, ...cosigners.map((k) => k.pubB), ...aw.map((k) => k.pubB)])
  const elig = (w) => ELIG_KEYS.has(w)
  /** trustEvidenceOf under the standard roster: the honest-verifier view. */
  const evidenceOf = (c) => trust.trustEvidenceOf(c, elig)
  /** Full-strength verified oppCkpt: through 200, 4 real diverse cosigners. */
  const fullCkpt = (oppKp) => mkVerifiedOppCkpt(oppKp, 200)
  const TC = { baseMs: 300_000, incMs: 0 } // Blitz
  /** Segment payload with a REAL witness terminal signature over the FULL F1
   * RatedBinding {kind, tc, players, reason} (rated=true) or the legacy bytes
   * (rated=false). */
  const segPayloadV = (game, oppB, opts = {}) => {
    const { oppCkpt, color = 'w', result = '1-0', reason = 'checkmate', rated = true, wsig } = opts
    const transcript = fakeId(`t:${game}`)
    const plies = 24
    const players = color === 'w' ? { w: meB, b: oppB } : { w: oppB, b: meB }
    const wstream =
      wsig !== undefined
        ? { wkey: wkp.pubB, sig: wsig }
        : seg.signWitnessEnd(wkp.priv, wkp.pubB, game, result, plies, transcript,
            rated ? { kind: 'chess', tc: TC, players, reason } : undefined)
    return {
      game, opp: oppB, color, result, reason, transcript, plies,
      heads: { w: { head: fakeId('hw'), height: 3 }, b: { head: fakeId('hb'), height: 5 } },
      wstream, oppProfile: { name: 'Opponent' },
      ...(rated ? { kind: 'chess', tc: TC } : {}),
      ...(oppCkpt !== undefined ? { oppCkpt } : {}),
    }
  }
  const addSeg = (c, game, oppB, opts) =>
    chain.appendWitnessed(c, me.priv, meB, 'segment', segPayloadV(game, oppB, opts), ts++)
  const addCkpt = (c, wit) => {
    const ev = checkpoint.makeCheckpointEvent(c, me.priv, meB, ts++)
    const c2 = chain.appendEvent(c, ev)
    if (!wit) return c2
    return withLastWit(c2, wit === 'real4' ? cosigners.map((k) => mkAtt(k, events.eventId(ev.body), 950)) : wit)
  }
  const wEvents = (c) => c.events.filter((e) => e.body.lane === 'w').sort((a, b) => a.body.height - b.body.height)
  const foldT = (c) => wEvents(c).reduce((s, e) => trust.trustInputsStep(s, e), trust.trustInputsInit())
  const foldRep = (c) => wEvents(c).reduce((s, e) => rep.repStep(s, e), rep.repInit())
  const TofChain = (c, now, evd) => trust.trustT(foldT(c), foldRep(c), now, evd)
  /** Standalone crafted-but-VALID segment event (real event + wstream sigs;
   * unrated shape, shared game key: trust has no game dedup; window tests
   * exercise heights, not chain linkage). */
  const WGAME = fakeId('wgame')
  const WSTREAM = seg.signWitnessEnd(wkp.priv, wkp.pubB, WGAME, '1-0', 24, fakeId(`t:${WGAME}`))
  const craftedSeg = (height, oppB) =>
    events.signBody(
      {
        v: 1, lane: 'w', type: 'segment', root: meB, key: meB, height,
        prev: fakeId('prev'), ts: height,
        payload: {
          game: WGAME, opp: oppB, color: 'w', result: '1-0', reason: 'checkmate',
          transcript: fakeId(`t:${WGAME}`), plies: 24,
          heads: { w: { head: fakeId('hw'), height: 3 }, b: { head: fakeId('hb'), height: 5 } },
          wstream: WSTREAM, oppProfile: { name: 'Opponent' },
        },
      },
      me.priv,
    )
  /** Standalone VALID rated segment event carrying `oppCkpt` (for the forged/
   * borrowed oppCkpt negatives: everything real except the checkpoint). */
  const segEvWithCkpt = (game, oppB, oppCkpt) =>
    events.signBody(
      { v: 1, lane: 'w', type: 'segment', root: meB, key: meB, height: 1, prev: fakeId('prev'), ts: 5, payload: segPayloadV(game, oppB, { oppCkpt }) },
      me.priv,
    )

  // ============================================================================
  // 1. params + barrel sanity
  // ============================================================================
  console.log('\n· params + barrel …')
  {
    eq(P.trustWAgeMicro + P.trustWDiversityMicro + P.trustWCleanlinessMicro + P.trustWCompletionMicro,
      1_000_000, 'PARAMS_A4 trust weights sum to exactly 1e6 (T range is [0, 1e6])')
    eq(W, 1000, 'PARAMS_A4.trustDivWindow is the agreed 1000')
    ok(mm.trustT === trust.trustT && mm.trustInputsStep === trust.trustInputsStep,
      'mm/index.ts re-exports the trust surface')
    ok(mm.trustEvidenceOf === trust.trustEvidenceOf, 'mm/index.ts re-exports trustEvidenceOf (A4-03)')
    ok(mm.pairingLegal === pairing.pairingLegal && mm.width === pairing.width,
      'mm/index.ts re-exports the pairing surface')
    eq(cosigners.length, 4, 'fixture: 4 real cosigner keypairs with distinct key prefixes')
  }

  // ============================================================================
  // 2. init + pass-through / purity / totality / body-only shape (A4-04)
  // ============================================================================
  console.log('\n· trustInputsInit + pass-through …')
  {
    const s0 = trust.trustInputsInit()
    eq(stateHash(s0), stateHash(trust.trustInputsInit()), 'init state bytes are stable')
    ok(!('firstWts' in s0) && !('ageDiv' in s0) && !('ckCosSum' in s0),
      'TrustInputs carries NO wit-derived members (A4-04: firstWts/ageDiv/ckCosSum are gone)')
    const c = addSeg(mkChain(), fakeId('g1'), opp(1))
    const s = foldT(c)
    const sBytes = stateHash(s)
    eq(s.wn, 1, 'one verified segment folds (wn 1)')
    const genesis = c.events[0]
    ok(trust.trustInputsStep(s, genesis) === s, 'genesis passes through (age lives in evidence now)')
    ok(trust.trustInputsStep(s, { ...genesis, wit: [mkAtt(aw[0], events.eventId(genesis.body), 1000)] }) === s,
      'ATTESTED genesis also passes through: the fold never reads wit')
    const personal = events.signBody(
      { v: 1, lane: 'p', type: 'profile', root: meB, key: meB, height: 0, ts: 1, payload: { fields: { bio: 'x' } } },
      me.priv,
    )
    ok(trust.trustInputsStep(s, personal) === s, 'personal-lane event passes through unchanged')
    const media = (type, payload) => ({
      body: { v: 1, lane: 'w', type, root: meB, key: meB, height: 9, prev: fakeId('p'), ts: 1, payload },
      sig: 'A'.repeat(86),
    })
    ok(trust.trustInputsStep(s, media('conduct', { kind: 'abort', game: fakeId('g'), opp: opp(1) })) === s,
      'conduct event is irrelevant to trust (reaches T via RepState only)')
    ok(trust.trustInputsStep(s, media('commend', { game: fakeId('g'), opp: opp(1), key: opp(1), sig: 'A'.repeat(86) })) === s,
      'commend event passes through unchanged')
    ok(trust.trustInputsStep(s, media('pin', { record: fakeId('r'), gen: 0 })) === s, 'pin event passes through unchanged')
    ok(trust.trustInputsStep(s, media('segment', { garbage: true })) === s, 'malformed segment payload ignored, no throw')
    ok(trust.trustInputsStep(s, media('segment', segPayloadV(fakeId('g2'), opp(2)))) === s,
      'FORGED event sig on a well-formed segment → pass-through (A4-05 full gate)')
    const badW = events.signBody(
      { v: 1, lane: 'w', type: 'segment', root: meB, key: meB, height: 9, prev: fakeId('p'), ts: 1, payload: segPayloadV(fakeId('g4'), opp(4), { wsig: 'A'.repeat(86) }) },
      me.priv,
    )
    ok(trust.trustInputsStep(s, badW) === s, 'forged WITNESS terminal sig → pass-through (never counts)')
    const selfSeg = events.signBody(
      { v: 1, lane: 'w', type: 'segment', root: meB, key: meB, height: 9, prev: fakeId('p'), ts: 1, payload: segPayloadV(fakeId('g5'), meB) },
      me.priv,
    )
    ok(trust.trustInputsStep(s, selfSeg) === s, 'self-naming segment (opp === root) ignored')
    ok(trust.trustInputsStep(s, media('ckpt', { nope: 1 })) === s, 'malformed ckpt payload ignored, no throw')
    ok(trust.trustInputsStep(s, media('ckpt', null)) === s, 'null ckpt payload ignored, no throw')
    eq(stateHash(s), sBytes, 'input state bytes unchanged after all step calls (never mutated)')
    const segEv = c.events.find((e) => e.body.type === 'segment')
    eq(stateHash(trust.trustInputsStep(trust.trustInputsInit(), segEv)),
      stateHash(trust.trustInputsStep(trust.trustInputsInit(), segEv)),
      'same (state, event) twice → identical state bytes')
    const leavesOk = (v) =>
      typeof v === 'number'
        ? Number.isSafeInteger(v) && v >= 0
        : typeof v === 'object' && v !== null && Object.values(v).every(leavesOk)
    ok(leavesOk(s), 'TrustInputs leaves are all non-negative safe integers')
  }

  // ============================================================================
  // 3. verified age evidence (A4-03, §4 diversity-bound witnessed time)
  // ============================================================================
  console.log('\n· verified age evidence …')
  {
    eq(trust.trustAgeMicro(undefined, 9e12), 0, 'absent evidence → age 0 regardless of now (documented neutral)')
    eq(trust.trustAgeMicro(evidenceOf(mkChain()), 9e12), 0, 'unattested chain → no basis → age 0')
    const c3 = attestAt(mkChain(), 0, [aw[0], aw[1], aw[2]], 1000)
    const e3 = evidenceOf(c3)
    eq(e3.ageBasisWts, 1000, '3 VALID ELIGIBLE genesis attestations set ageBasisWts to the attestation wts')
    eq(e3.ageAttesters, 3, '≥3 distinct valid eligible attesters counted (diversity bound met)')
    // A4-03 PIN. The review's exact attack: signature-VALID attestations by
    // keys the verifier does NOT recognize as eligible witnesses anchor
    // NOTHING. No witness roster in the verify path was the hole.
    eq(trust.trustEvidenceOf(c3).ageBasisWts, undefined,
      'A4-03: the SAME valid attestations WITHOUT an eligibility roster → NO age basis (age is roster-earned)')
    eq(trust.trustEvidenceOf(c3).ageAttesters, 0, '…and zero attesters counted')
    eq(trust.trustEvidenceOf(c3, (w) => false).ageBasisWts, undefined,
      'A4-03: a roster that rejects the attesting keys → NO basis (valid-sig ≠ eligible)')
    eq(trust.trustAgeMicro(trust.trustEvidenceOf(c3, (w) => false), 9e12), 0,
      '…→ age 0 forever: the self-minted backdated-attestation sybil is dead for every verifier')
    eq(trust.trustAgeMicro(e3, 1000), 0, 'age at the anchor instant = 0')
    eq(trust.trustAgeMicro(e3, 1000 + 15_551), 0, 'one ms short of 15_552 ms → still 0 (floor)')
    eq(trust.trustAgeMicro(e3, 1000 + 15_552), 1, 'exactly 15_552 ms → 1 micro-unit')
    eq(trust.trustAgeMicro(e3, 1000 + 7_776_000_000), 500_000, '90 days → exactly 500_000 (half)')
    eq(trust.trustAgeMicro(e3, 1000 + 15_552_000_000), 1_000_000, '180 days → saturates at 1e6')
    eq(trust.trustAgeMicro(e3, 1000 + 99_000_000_000), 1_000_000, 'far beyond saturation → still 1e6')
    eq(trust.trustAgeMicro(e3, 500), 0, 'atWts before the anchor clamps to 0 (never negative)')
    // thin basis: 2 valid eligible attesters
    const e2 = evidenceOf(attestAt(mkChain(), 0, [aw[0], aw[1]], 1000))
    eq(e2.ageAttesters, 2, '2 distinct valid eligible attesters → thin basis')
    eq(trust.trustAgeMicro(e2, 1000 + 15_552_000_000), 250_000, 'thin basis caps age at 250_000 even at 180d')
    eq(trust.trustAgeMicro(e2, 1000 + 1_555_200_000), 100_000, 'thin basis below the cap passes through (100_000)')
    // 3 valid attesters of which only 2 ELIGIBLE → thin (eligibility bounds diversity)
    const partial = (w) => w === aw[0].pubB || w === aw[1].pubB
    const ePart = trust.trustEvidenceOf(c3, partial)
    eq(ePart.ageAttesters, 2, 'a partially-recognized attester set counts only the eligible keys (2 → thin)')
    eq(trust.trustAgeMicro(ePart, 1000 + 15_552_000_000), 250_000, '…and the thin cap applies despite 3 valid sigs')
    // one key attesting thrice is not diverse
    const gid = events.eventId(mkChain().events[0].body)
    const dup = withGenesisWit(mkChain(), [mkAtt(aw[0], gid, 1000), mkAtt(aw[0], gid, 1001), mkAtt(aw[0], gid, 1002)])
    eq(evidenceOf(dup).ageAttesters, 1, '3 attestations by ONE key are 1 attester (thin)')
    eq(evidenceOf(dup).ageBasisWts, 1000, '…basis is still the min valid wts')
    // A4-20: FORGED attestations move NOTHING (roster or not; sigs first)
    const forged = withGenesisWit(mkChain(), forgedWitArr(3, 0))
    const ef = trust.trustEvidenceOf(forged, () => true)
    eq(ef.ageBasisWts, undefined, '3 forged (garbage-sig) attestations at wts=0 → NO age basis even under an accept-all roster')
    eq(trust.trustAgeMicro(ef, 9e12), 0, '…→ age stays 0: the sybil age-forge attack is dead')
    const wrongKey = withGenesisWit(mkChain(), [
      { ...mkAtt(aw[0], gid, 0), w: aw[1].pubB }, // valid sig, relabeled key
    ])
    eq(evidenceOf(wrongKey).ageBasisWts, undefined, 'attestation relabeled to another (eligible) key → invalid → no basis')
    const mixed = withGenesisWit(mkChain(), [mkAtt(aw[0], gid, 1000), ...forgedWitArr(2, 0)])
    const em = evidenceOf(mixed)
    eq(em.ageBasisWts, 1000, '1 valid + 2 forged: only the VALID one anchors (wts 1000, not the forged 0)')
    eq(em.ageAttesters, 1, '…and attester count is 1 (thin): forged sigs cannot pad diversity')
    // anchor from the first attested event when the genesis is unattested
    let cSeg = addSeg(mkChain(), fakeId('ga1'), opp(1))
    cSeg = attestAt(cSeg, 1, [aw[0], aw[1], aw[2]], 3000)
    const eSeg = evidenceOf(cSeg)
    eq(eSeg.ageBasisWts, 3000, 'unattested genesis: first attested event (height 1) anchors at min wts')
    eq(eSeg.ageAttesters, 3, '…with its 3 distinct valid eligible attesters')
    // the basis window: only the first TRUST_AGE_BASIS_EVENTS events can anchor
    eq(trust.TRUST_AGE_BASIS_EVENTS, 3, 'K = 3 (the documented birth-neighborhood bound)')
    let cLate = mkChain()
    for (let i = 0; i < 3; i++) cLate = addSeg(cLate, fakeId(`gl${i}`), opp(i))
    cLate = attestAt(cLate, 3, [aw[0], aw[1], aw[2]], 100) // height 3 = 4th witnessed event
    eq(evidenceOf(cLate).ageBasisWts, undefined,
      'attestations on the 4th witnessed event (beyond K) can NOT retro-anchor age')
    // min across the first K, attesters from the basis event
    let cMin = addSeg(addSeg(mkChain(), fakeId('gm1'), opp(1)), fakeId('gm2'), opp(2))
    cMin = attestAt(cMin, 0, [aw[0], aw[1], aw[2]], 1000)
    cMin = attestAt(cMin, 2, [aw[3]], 500)
    const eMin = evidenceOf(cMin)
    eq(eMin.ageBasisWts, 500, 'basis = earliest valid wts across the first K events (500 on event 2)')
    eq(eMin.ageAttesters, 1, '…attesters counted on THAT basis event (1 → thin cap applies)')
  }

  // ============================================================================
  // 4. opponent diversity. Verified proxies, floor, forged-zero (A4-05/06)
  // ============================================================================
  console.log('\n· opponent diversity …')
  {
    // divOf defaults to the honest-verifier roster evidence; pass a second
    // argument to model a different verifier's eligibility view.
    const divOf = (c, e = evidenceOf(c)) => trust.trustDiversityMicro(foldT(c), e)
    const one = (oppB, ck) => addSeg(mkChain(), fakeId('g1'), oppB, ck ? { oppCkpt: ck } : {})
    // verified proxy = min(1e6, 250k + 100k·min(4,|wit|) + floor(350k·min(through,200)/200))
    const o0 = oppK(0)
    eq(foldT(one(o0.pubB, fullCkpt(o0))).div[o0.pubB].w, 1_000_000, 'VERIFIED oppCkpt(through 200, 4 cosigners) → proxy 1e6')
    eq(divOf(one(o0.pubB, fullCkpt(o0))), 111_111, '1 full opponent → div floor(1e12/9e6) = 111_111')
    eq(foldT(one(o0.pubB, mkVerifiedOppCkpt(o0, 0))).div[o0.pubB].w, 650_000,
      'verified oppCkpt(through 0) → proxy 250k + 400k (cosig always saturated when verified) = 650_000')
    eq(divOf(one(o0.pubB, mkVerifiedOppCkpt(o0, 0))), 75_144, '…→ div floor(6.5e11/8.65e6) = 75_144')
    eq(foldT(one(o0.pubB, mkVerifiedOppCkpt(o0, 100))).div[o0.pubB].w, 825_000,
      'through 100 → proxy 250k+400k+175k = 825_000')
    eq(divOf(one(o0.pubB, mkVerifiedOppCkpt(o0, 100))), 93_484, '…→ div 93_484')
    eq(foldT(one(o0.pubB, mkVerifiedOppCkpt(o0, 400))).div[o0.pubB].w, 1_000_000, 'through 400 caps at 200 → proxy 1e6')
    // A4-05 ELIGIBILITY PINS. The review's exact residue: everything above
    // is signature-REAL, so what separates it from a sybil mint is ONLY the
    // verifier's roster. Full weight must be roster-EARNED:
    const cFull = one(o0.pubB, fullCkpt(o0))
    eq(trust.trustDiversityMicro(foldT(cFull)), 0,
      'A4-05: NO evidence → div 0, full-proxy diversity is never presumed')
    eq(evidenceOf(cFull).oppEligProxy[o0.pubB], 1_000_000, 'roster-eligible cosigners+witness → evidence grants the full proxy')
    eq(trust.trustEvidenceOf(cFull).oppEligProxy[o0.pubB], 0,
      'A4-05: no roster → the evidence proxy is 0 (nothing vouched, nothing earned)')
    const eligNoCos = (w) => w === wkp.pubB // witness recognized, cosigners NOT
    eq(trust.trustEvidenceOf(cFull, eligNoCos).oppEligProxy[o0.pubB], 50_000,
      'A4-05 PIN: valid-sig but NON-ELIGIBLE cosigners → the oppCkpt earns only the young-opponent FLOOR')
    eq(divOf(cFull, trust.trustEvidenceOf(cFull, eligNoCos)), 6_211,
      '…→ div collapses to the floor value 6_211 (the self-cosigned full proxy is dead)')
    const eligNoWit = (w) => w !== wkp.pubB && ELIG_KEYS.has(w) // cosigners ok, wstream key NOT
    eq(trust.trustEvidenceOf(cFull, eligNoWit).oppEligProxy[o0.pubB], 0,
      'A4-05 PIN: a self-run (non-eligible) wstream witness key → the whole segment earns 0 diversity')
    eq(divOf(cFull, trust.trustEvidenceOf(cFull, eligNoWit)), 0, '…→ div exactly 0')
    // only 3 of 4 cosigners eligible → below ckptM → floor
    const elig3 = (w) => w === wkp.pubB || cosigners.slice(0, 3).some((k) => k.pubB === w)
    eq(trust.trustEvidenceOf(cFull, elig3).oppEligProxy[o0.pubB], 50_000,
      'M−1 eligible cosigners (3 < ckptM 4) → floor, not full (threshold applies to the RECOGNIZED subset)')
    // A4-05 floor: a real witnessed game vs a YOUNG (no-ckpt) opponent
    eq(trust.TRUST_OPP_PROXY_FLOOR_MICRO, 50_000, 'documented proxy floor = 50_000 (1/20 of an established opponent)')
    eq(foldT(one(opp(1))).div[opp(1)].w, 50_000, 'no oppCkpt on a VERIFIED segment → the floor proxy')
    eq(divOf(one(opp(1))), 6_211, '…→ div floor(5e10/8.05e6) = 6_211 (small but non-zero)')
    eq(divOf(one(opp(1)), trust.trustEvidenceOf(one(opp(1)))), 0,
      'A4-05: even the floor is witness-earned, no roster ⇒ a self-witnessable game grants 0')
    // A4-05/06/23: FABRICATED oppCkpts contribute exactly ZERO (segment fails the gate)
    const zero = (ev, msg) => {
      eq(seg.verifySegmentEvent(ev), 'bad-opp-ckpt', `${msg}: verifySegmentEvent → 'bad-opp-ckpt'`)
      const st = trust.trustInputsStep(trust.trustInputsInit(), ev)
      ok(st === trust.trustInputsInit() || (st.wn === 0 && Object.keys(st.div).length === 0),
        `${msg}: contributes ZERO diversity (pass-through)`)
      // even under a maximally permissive fabricated evidence object the FOLD
      // state carries no entry. The gate, not the eligibility layer, zeroes it
      const permissive = { ageAttesters: 0, ckptCosigMicro: 1_000_000, oppEligProxy: { [ev.body.payload.opp]: 1_000_000 } }
      eq(trust.trustDiversityMicro(st, permissive), 0, `${msg}: div term is exactly 0`)
    }
    zero(segEvWithCkpt(fakeId('z1'), o0.pubB, { ...fullCkpt(o0), sig: 'A'.repeat(86) }),
      'garbage oppCkpt event sig')
    zero(segEvWithCkpt(fakeId('z2'), o0.pubB, mkVerifiedOppCkpt(o0, 200, cosigners.slice(0, 3))),
      'only 3 cosigners (< PARAMS_A2.ckptM)')
    const good = fullCkpt(o0)
    zero(segEvWithCkpt(fakeId('z3'), o0.pubB, { ...good, wit: [...good.wit.slice(0, 3), { ...good.wit[3], sig: 'B'.repeat(86) }] }),
      '4 cosigners, one FORGED attestation sig')
    zero(segEvWithCkpt(fakeId('z4'), o0.pubB, { ...good, wit: [...good.wit.slice(0, 3), mkAtt(cosigners[0], events.eventId(good.body), 901)] }),
      'duplicate cosigner key (4 entries, 3 distinct)')
    zero(segEvWithCkpt(fakeId('z5'), o0.pubB, { ...good, wit: [...good.wit.slice(0, 3), mkAtt(me, events.eventId(good.body), 901)] }),
      'the segment OWNER as cosigner (players may not cosign their own fold inputs)')
    // A4-06: the borrowed checkpoint. A GENUINE verified ckpt of oppK(0),
    // embedded under a different named opp → dies on root-binding.
    zero(segEvWithCkpt(fakeId('z6'), oppK(1).pubB, fullCkpt(o0)),
      'BORROWED genuine checkpoint (root ≠ named opp)')
    ok(!seg.verifyEmbeddedOppCkpt(segPayloadV(fakeId('z7'), oppK(1).pubB, { oppCkpt: fullCkpt(o0) }), meB),
      'verifyEmbeddedOppCkpt itself rejects the borrowed checkpoint (oppCkpt.body.root !== p.opp)')
    ok(seg.verifyEmbeddedOppCkpt(segPayloadV(fakeId('z8'), o0.pubB, { oppCkpt: fullCkpt(o0) }), meB),
      '…and accepts the same checkpoint under its TRUE root (the fixture is genuinely valid)')
    // saturating count over distinct full opponents
    const many = (k) => {
      let c = mkChain()
      for (let i = 0; i < k; i++) c = addSeg(c, fakeId(`gm${i}`), oppK(i).pubB, { oppCkpt: fullCkpt(oppK(i)) })
      return c
    }
    eq(divOf(many(5)), 384_615, '5 full distinct opponents → div 384_615')
    eq(divOf(many(10)), 555_555, '10 full distinct opponents → div 555_555')
    ok(divOf(many(10)) > divOf(many(5)) && divOf(many(5)) > divOf(many(1)), 'div is monotone in distinct opponents')
    // repeat-play entanglement discount
    const repeat = (k) => {
      let c = mkChain()
      for (let i = 0; i < k; i++) c = addSeg(c, fakeId(`gr${i}`), o0.pubB, { oppCkpt: fullCkpt(o0) })
      return c
    }
    eq(foldT(repeat(5)).div[o0.pubB].n, 5, 'repeat entry counts games (n = 5)')
    eq(divOf(repeat(5)), 24_390, 'ONE full opponent played 5× → div 24_390 (entSat = 1e6/5)')
    eq(divOf(repeat(10)), 12_345, '…played 10× → div 12_345: repeat play divides itself away')
    // max-proxy retention within the window (order-independent)
    let mixA = addSeg(mkChain(), fakeId('x1'), o0.pubB, { oppCkpt: fullCkpt(o0) })
    mixA = addSeg(mixA, fakeId('x2'), o0.pubB)
    let mixB = addSeg(mkChain(), fakeId('x1'), o0.pubB)
    mixB = addSeg(mixB, fakeId('x2'), o0.pubB, { oppCkpt: fullCkpt(o0) })
    eq(foldT(mixA).div[o0.pubB].w, 1_000_000, 'best proxy seen is retained when a later segment lacks the ckpt')
    eq(divOf(mixA), 58_823, 'w=1e6, n=2 → contribution 500_000 → div 58_823')
    eq(divOf(mixB), divOf(mixA), 'proxy-then-none ≡ none-then-proxy (max is order-independent)')
  }

  // ============================================================================
  // 5. fork/checkpoint cleanliness. Body-only cadence + verified cosig evidence
  // ============================================================================
  console.log('\n· checkpoint cleanliness …')
  {
    const segsN = (c, k, tag) => {
      for (let i = 0; i < k; i++) c = addSeg(c, fakeId(`${tag}${i}`), opp(i))
      return c
    }
    const clean = (c, evd) => trust.trustCleanlinessMicro(foldT(c), evd)
    eq(clean(mkChain()), 1_000_000, 'empty chain is presumed clean (1e6)')
    eq(clean(segsN(mkChain(), 20, 'a')), 1_000_000, 'exactly N_CKPT games without a ckpt → not yet late')
    const s21 = foldT(segsN(mkChain(), 21, 'b'))
    eq(s21.ckLateEv, 1, '21st game past the cadence → 1 late event')
    eq(clean(segsN(mkChain(), 21, 'b')), 976_190, '21 games, no ckpt → clean floor((952380+1e6)/2) = 976_190')
    const s25 = foldT(segsN(mkChain(), 25, 'c'))
    eq(s25.ckLateEv, 5, '25 games, no ckpt → 5 late events')
    eq(clean(segsN(mkChain(), 25, 'c')), 900_000, '…→ cadence 800_000, cosig neutral → clean 900_000')
    // on-time checkpoint; cosig diversity now lives in EVIDENCE (A4-04)
    let cOn = segsN(mkChain(), 20, 'd')
    cOn = addCkpt(cOn, 'real4')
    cOn = segsN(cOn, 5, 'e')
    const sOn = foldT(cOn)
    eq(sOn.ckLateEv, 0, 'on-time ckpt resets the cadence counter (no late events)')
    eq(sOn.ckN, 1, 'one ckpt folded (body-only counter)')
    ok(!('ckCosSum' in sOn), 'the fold state carries NO cosig counter (A4-04: wit left the fold)')
    const eOn = trust.trustEvidenceOf(cOn)
    eq(eOn.ckptCosigMicro, 1_000_000, '4 VALID distinct cosigners on the ckpt → evidence cosig 1e6')
    eq(clean(cOn, eOn), 1_000_000, 'on-time, fully-cosigned checkpointing → clean 1e6')
    // thin / forged / self cosig sets: all through VERIFIED evidence
    const ck2 = (() => {
      let c = segsN(mkChain(), 20, 'f')
      const ev = checkpoint.makeCheckpointEvent(c, me.priv, meB, ts++)
      c = chain.appendEvent(c, ev)
      return withLastWit(c, cosigners.slice(0, 2).map((k) => mkAtt(k, events.eventId(ev.body), 950)))
    })()
    eq(trust.trustEvidenceOf(ck2).ckptCosigMicro, 500_000, 'ckpt with 2 valid cosigners → evidence 500_000')
    eq(clean(ck2, trust.trustEvidenceOf(ck2)), 750_000, '…→ clean 750_000')
    const ckNone = addCkpt(segsN(mkChain(), 20, 'g'), undefined)
    eq(trust.trustEvidenceOf(ckNone).ckptCosigMicro, 0, 'ckpt with no cosigners → evidence 0')
    eq(clean(ckNone, trust.trustEvidenceOf(ckNone)), 500_000, '…→ clean 500_000')
    eq(clean(ckNone), 1_000_000,
      'SAME chain, ABSENT evidence → cosig neutral 1e6 (the documented neutral) → clean 1e6')
    const ckForged = addCkpt(segsN(mkChain(), 20, 'h'), forgedWitArr(4, 950))
    eq(trust.trustEvidenceOf(ckForged).ckptCosigMicro, 0,
      '4 FORGED cosigner attestations → evidence 0 (A4-20: forged sigs pad nothing)')
    // cosig-cleanliness is bounded ABOVE by its neutral (1e6), so sig-only
    // counting without a roster is safe. Self-minted cosigners can never buy
    // anything a ckpt-less chain does not already have; a roster only sharpens.
    const ckSybil = addCkpt(segsN(mkChain(), 20, 'hs'), 'real4')
    eq(trust.trustEvidenceOf(ckSybil).ckptCosigMicro, 1_000_000,
      'no roster: 4 valid cosigners count sig-only (bounded by the presumed-innocent neutral)')
    eq(trust.trustEvidenceOf(ckSybil, () => false).ckptCosigMicro, 0,
      'A4-03: a roster rejecting those keys counts them 0. Eligibility can only LOWER cosig-clean, never inflate')
    const ckSelf = (() => {
      let c = segsN(mkChain(), 20, 'i')
      const ev = checkpoint.makeCheckpointEvent(c, me.priv, meB, ts++)
      c = chain.appendEvent(c, ev)
      const id = events.eventId(ev.body)
      return withLastWit(c, [mkAtt(me, id, 950), ...cosigners.slice(0, 3).map((k) => mkAtt(k, id, 950))])
    })()
    eq(trust.trustEvidenceOf(ckSelf).ckptCosigMicro, 750_000,
      'root self-cosign is excluded: 3 external valid cosigners → 750_000')
    const ckDup = (() => {
      let c = segsN(mkChain(), 20, 'j')
      const ev = checkpoint.makeCheckpointEvent(c, me.priv, meB, ts++)
      c = chain.appendEvent(c, ev)
      const id = events.eventId(ev.body)
      return withLastWit(c, [mkAtt(cosigners[0], id, 950), mkAtt(cosigners[0], id, 951), mkAtt(cosigners[1], id, 950)])
    })()
    eq(trust.trustEvidenceOf(ckDup).ckptCosigMicro, 500_000,
      'duplicate cosigner keys count once (3 attestations, 2 keys → 500_000)')
    eq(trust.trustEvidenceOf(mkChain()).ckptCosigMicro, 1_000_000,
      'no ckpt events → evidence cosig neutral 1e6 (presumed innocent)')
  }

  // ============================================================================
  // 6. completion hygiene (from 1c RepState; never counted twice)
  // ============================================================================
  console.log('\n· completion hygiene …')
  {
    eq(trust.trustCompletionMicro(rep.repInit()), 1_000_000, 'fresh RepState → hygiene 1e6 (presumed innocent)')
    eq(trust.trustCompletionMicro({ ...rep.repInit(), seg: 8, drop: 2, abort: 1, noshow: 1 }), 600_000,
      'seg 8, drop 2, abort 1, noshow 1 → floor(1e6·6/10) = 600_000')
    eq(trust.trustCompletionMicro({ ...rep.repInit(), abort: 2 }), 0, 'only aborts, no games → hygiene 0')
    eq(trust.trustCompletionMicro({ ...rep.repInit(), seg: 5 }), 1_000_000, '5 clean completed games → 1e6')
  }

  // ============================================================================
  // 7. golden trustT on fixed synthetic chains (verifyChain-clean fixtures)
  // ============================================================================
  console.log('\n· golden trustT …')
  const goldenA = () => {
    let c = mkChain()
    for (let i = 0; i < 5; i++) c = addSeg(c, fakeId(`gA${i}`), oppK(i).pubB, { oppCkpt: fullCkpt(oppK(i)) })
    return attestAt(c, 0, [aw[0], aw[1], aw[2]], 1000)
  }
  {
    eq(trust.trustT(trust.trustInputsInit(), rep.repInit(), 9e12), 550_000,
      'fresh account baseline T = 550_000 exactly (documented; below the 600_000 island gate)')
    eq(trust.trustT(trust.trustInputsInit(), rep.repInit(), 9e12, evidenceOf(mkChain())), 550_000,
      'baseline is identical with evidence (a fresh chain proves nothing either way)')
    const cA = goldenA()
    const sA = foldT(cA)
    const eA = evidenceOf(cA)
    eq(sA.wn, 5, 'golden A: 5 verified segments folded')
    eq(sA.gSince, 5, 'golden A: 5 games since (no ckpt yet)')
    eq(sA.ckLateEv + sA.ckN, 0, 'golden A: clean counters untouched')
    eq(Object.keys(sA.div).length, 5, 'golden A: 5 windowed opponent entries')
    eq(eA.ageBasisWts, 1000, 'golden A evidence: verified age basis at wts 1000')
    eq(eA.ageAttesters, 3, 'golden A evidence: 3 valid eligible attesters (full age credit)')
    eq(Object.keys(eA.oppEligProxy).length, 5, 'golden A evidence: all 5 opponents eligibility-verified')
    // T = floor((150k·age + 300k·384615 + 250k·clean + 300k·1e6)/1e6)
    eq(TofChain(cA, 1000, eA), 665_384, 'golden A at age 0 → T = 665_384 exactly')
    eq(TofChain(cA, 1000 + 7_776_000_000, eA), 740_384, 'golden A at 90 days → T = 740_384 exactly')
    eq(TofChain(cA, 1000 + 15_552_000_000, eA), 815_384, 'golden A at 180 days → T = 815_384 exactly')
    eq(TofChain(cA, 1000 + 15_552_000_000), 550_000,
      'same chain WITHOUT evidence → age 0 AND div 0 (both roster-earned, A4-03/05) → the fresh 550_000')
    // A4-03 PIN. The review's headline number: the self-attested goldenA
    // shape must NOT clear the island gate for a verifier that does not
    // recognize its keys. (Pre-fix it scored 700_000+ on self-minted keys.)
    const eSybil = trust.trustEvidenceOf(cA, () => false)
    ok(TofChain(cA, 1000 + 15_552_000_000, eSybil) < P.islandGateMicro,
      'A4-03: goldenA under a roster rejecting its (self-mintable) keys stays BELOW the 600_000 island gate')
    eq(TofChain(cA, 1000 + 15_552_000_000, eSybil), 550_000,
      '…at exactly the fresh baseline: free keypairs buy nothing from any honest verifier')
    const vA = chain.verifyChain(cA)
    ok(vA.ok, `golden A chain verifies ok end-to-end (real sigs, real binding${vA.ok ? '' : ': ' + JSON.stringify(vA.errors)})`)
    ok(TofChain(cA, 1000 + 15_552_000_000, eA) >= P.islandGateMicro,
      'aged, diverse, clean chain clears the island gate, for verifiers whose roster vouches its witnesses')
  }

  // ============================================================================
  // 8. each trust term isolated (all-else-equal pairs)
  // ============================================================================
  console.log('\n· term isolation …')
  {
    // (a) AGE only: same chain + evidence, different atWts
    const cA = goldenA()
    const eA = evidenceOf(cA)
    eq(TofChain(cA, 1000 + 15_552_000_000, eA) - TofChain(cA, 1000, eA), 150_000,
      'age isolated: 0 → 180d moves T by exactly the full age weight (150_000)')
    // (b) DIVERSITY only: 5 distinct full-proxy opps vs 5 games vs one fresh opp
    let cDiv = mkChain()
    for (let i = 0; i < 5; i++) cDiv = addSeg(cDiv, fakeId(`iD${i}`), oppK(i).pubB, { oppCkpt: fullCkpt(oppK(i)) })
    let cMono = mkChain()
    for (let i = 0; i < 5; i++) cMono = addSeg(cMono, fakeId(`iM${i}`), opp(1))
    eq(trust.trustCleanlinessMicro(foldT(cDiv)), trust.trustCleanlinessMicro(foldT(cMono)), 'isolation (b): clean equal')
    eq(trust.trustCompletionMicro(foldRep(cDiv)), trust.trustCompletionMicro(foldRep(cMono)), 'isolation (b): hygiene equal')
    eq(TofChain(cDiv, 500, evidenceOf(cDiv)), 665_384, 'diverse chain (roster evidence, no age) → 665_384')
    eq(TofChain(cMono, 500, evidenceOf(cMono)), 550_374,
      'sock-shaped chain → 550_374 (floor proxy ÷ repeat discount): only diversity moved T')
    // (c) CLEANLINESS only: 25 games without vs with an on-time ckpt (same games)
    const seg25 = (c) => {
      for (let i = 0; i < 25; i++) c = addSeg(c, fakeId(`iC${i}`), opp(i))
      return c
    }
    const cLate = seg25(mkChain())
    let cTidy = mkChain()
    for (let i = 0; i < 20; i++) cTidy = addSeg(cTidy, fakeId(`iC${i}`), opp(i))
    cTidy = addCkpt(cTidy, 'real4')
    for (let i = 20; i < 25; i++) cTidy = addSeg(cTidy, fakeId(`iC${i}`), opp(i))
    eq(trust.trustDiversityMicro(foldT(cLate), evidenceOf(cLate)),
      trust.trustDiversityMicro(foldT(cTidy), evidenceOf(cTidy)), 'isolation (c): div equal')
    eq(trust.trustCompletionMicro(foldRep(cLate)), trust.trustCompletionMicro(foldRep(cTidy)), 'isolation (c): hygiene equal')
    eq(TofChain(cLate, 500, evidenceOf(cLate)), 565_540, 'late-checkpoint chain → 565_540')
    eq(TofChain(cTidy, 500, evidenceOf(cTidy)), 590_540, 'tidy chain → 590_540: only cleanliness moved T (Δ 25_000)')
    // (d) HYGIENE only: same inputs, different RepState
    const s0 = trust.trustInputsInit()
    eq(trust.trustT(s0, { ...rep.repInit(), seg: 8, drop: 2, abort: 1, noshow: 1 }, 500), 430_000,
      'hygiene isolated: dirty rep (600_000) → T = 430_000 (Δ = 120_000 = 0.3·0.4)')
  }

  // ============================================================================
  // 9. sock-puppet resistance (§7 / A4-23: the REAL attack, real signatures)
  // ============================================================================
  console.log('\n· sock-puppet resistance …')
  {
    // Floor puppets: genuinely witnessed games (valid event + wstream sigs by
    // an ELIGIBLE witness) against fresh throwaway roots with NO verifiable
    // checkpoint. They earn the floor proxy ONLY, and only from verifiers
    // whose roster vouches the witness.
    let farm = mkChain()
    for (let i = 0; i < 10; i++) farm = addSeg(farm, fakeId(`f${i}`), opp(100 + i))
    ok(chain.verifyChain(farm).ok, 'the no-ckpt puppet-farm chain is chain-VALID (the attack is real)')
    eq(trust.trustDiversityMicro(foldT(farm), evidenceOf(farm)), 58_823,
      '10 witnessed games vs fresh no-ckpt puppets → floor-only div 58_823 (eligible witness)')
    eq(TofChain(farm, 500, evidenceOf(farm)), 567_646, '…→ T = 567_646: BELOW the 600_000 island gate. No width benefit')
    ok(TofChain(farm, 500, evidenceOf(farm)) < P.islandGateMicro, 'a puppet farm cannot cross the island gate on floor proxies')
    eq(TofChain(farm, 500), 550_000, 'the same farm with NO evidence → the fresh 550_000 (diversity is roster-earned)')
    // ═══ A4-05 PIN. The review's EXACT unpinned variant: the FULL-PROXY
    // sybil. N real opponent keypairs, each with a REAL self-cosigned
    // (4 prefix-diverse self-minted keys) checkpoint, games witnessed by a
    // self-run wstream key: passes verifySegmentEvent AND verifyChain, and
    // the FOLD dutifully records full 1e6 proxies, but no verifier who does
    // not vouch for those keys ever grants them.
    const sybilW = kp(45) // the farm's self-run "witness"
    const sybilCos = [] // 4 prefix-diverse self-minted "cosigners"
    {
      const pre = new Set()
      for (let b = 180; sybilCos.length < 4 && b < 230; b++) {
        const k = kp(b)
        if (pre.has(k.pubB.slice(0, 2))) continue
        pre.add(k.pubB.slice(0, 2))
        sybilCos.push(k)
      }
    }
    let sFarm = mkChain()
    for (let i = 0; i < 10; i++) {
      const o = oppK(10 + i)
      const ck = mkVerifiedOppCkpt(o, 200, sybilCos)
      const game = fakeId(`sf${i}`)
      const transcript = fakeId(`t:${game}`)
      const players = { w: meB, b: o.pubB }
      const wstream = seg.signWitnessEnd(sybilW.priv, sybilW.pubB, game, '1-0', 24, transcript,
        { kind: 'chess', tc: TC, players, reason: 'checkmate' })
      sFarm = chain.appendWitnessed(sFarm, me.priv, meB, 'segment', {
        game, opp: o.pubB, color: 'w', result: '1-0', reason: 'checkmate', transcript, plies: 24,
        heads: { w: { head: fakeId('hw'), height: 3 }, b: { head: fakeId('hb'), height: 5 } },
        wstream, oppProfile: { name: 'Opponent' }, kind: 'chess', tc: TC, oppCkpt: ck,
      }, ts++)
    }
    ok(chain.verifyChain(sFarm).ok, 'A4-05: the full-proxy sybil chain PASSES verifyChain (signatures are all real)')
    eq(foldT(sFarm).wn, 10, '…and the fold counts its 10 segments')
    eq(foldT(sFarm).div[oppK(10).pubB].w, 1_000_000, '…recording FULL 1e6 potential proxies (the fold cannot judge eligibility)')
    eq(trust.trustDiversityMicro(foldT(sFarm), evidenceOf(sFarm)), 0,
      'A4-05 PIN: under the honest roster (which knows none of the farm keys) div = EXACTLY 0')
    eq(TofChain(sFarm, 500, evidenceOf(sFarm)), 550_000, '…→ T = the fresh 550_000: full-proxy sybil buys NOTHING')
    ok(TofChain(sFarm, 500, evidenceOf(sFarm)) < P.islandGateMicro, '…and stays below the island gate')
    // even a roster that (wrongly) vouches the sybil WITNESS but not the
    // cosigners caps every opponent at the floor
    const eHalf = trust.trustEvidenceOf(sFarm, (w) => w === sybilW.pubB)
    eq(eHalf.oppEligProxy[oppK(10).pubB], 50_000, '…witness-only recognition → floor proxies only')
    eq(trust.trustDiversityMicro(foldT(sFarm), eHalf), 58_823, '…→ div capped at the floor-farm 58_823')
    ok(TofChain(sFarm, 500, eHalf) < P.islandGateMicro, '…still below the island gate')
    // FABRICATED oppCkpts (garbage sigs): the segments fail verifySegmentEvent
    // → contribute NOTHING, and the chain itself is rejected by verifyChain.
    let forge = mkChain()
    for (let i = 0; i < 10; i++)
      forge = addSeg(forge, fakeId(`ff${i}`), oppK(i).pubB, {
        oppCkpt: { ...fullCkpt(oppK(i)), sig: 'A'.repeat(86) },
      })
    eq(trust.trustDiversityMicro(foldT(forge), evidenceOf(forge)), 0,
      '10 fabricated-oppCkpt segments → div EXACTLY 0 (gate, not floor)')
    eq(foldT(forge).wn, 0, '…none of them even count as games (full pass-through)')
    eq(TofChain(forge, 500, evidenceOf(forge)), 550_000, '…→ T stays at the fresh baseline 550_000')
    const vForge = chain.verifyChain(forge)
    ok(!vForge.ok && vForge.errors.some((e) => e.code === 'bad-segment'),
      'AND verifyChain rejects the fabricated-oppCkpt chain outright (bad-segment)')
    // A4-06 at chain level: one genuine checkpoint borrowed for 10 fake identities
    let borrow = mkChain()
    for (let i = 0; i < 10; i++)
      borrow = addSeg(borrow, fakeId(`fb${i}`), fakeId(`puppet-${i}`), { oppCkpt: fullCkpt(oppK(0)) })
    eq(trust.trustDiversityMicro(foldT(borrow), evidenceOf(borrow)), 0,
      'one BORROWED genuine checkpoint under 10 puppet names → div EXACTLY 0 (root-binding)')
    ok(!chain.verifyChain(borrow).ok, '…and the borrowed-checkpoint chain fails verifyChain')
    // honest contrast: full weight for verifiers who vouch the witnesses
    let honest = mkChain()
    for (let i = 0; i < 10; i++) honest = addSeg(honest, fakeId(`h${i}`), oppK(i).pubB, { oppCkpt: fullCkpt(oppK(i)) })
    ok(chain.verifyChain(honest).ok, 'the 10-established-opponent chain verifies')
    eq(trust.trustDiversityMicro(foldT(honest), evidenceOf(honest)), 555_555,
      '10 VERIFIED eligibility-vouched established opponents → div 555_555')
    ok(trust.trustDiversityMicro(foldT(honest), evidenceOf(honest)) >
      9 * trust.trustDiversityMicro(foldT(farm), evidenceOf(farm)),
      'established opponents dominate floor puppets by ~10×')
    let close = mkChain() // one established opponent replayed 10× (close entanglement)
    for (let i = 0; i < 10; i++) close = addSeg(close, fakeId(`c${i}`), oppK(0).pubB, { oppCkpt: fullCkpt(oppK(0)) })
    eq(trust.trustDiversityMicro(foldT(close), evidenceOf(close)), 12_345, 'one close-entangled opponent ×10 → div 12_345 (≈0)')
    ok(trust.trustDiversityMicro(foldT(close), evidenceOf(close)) <= Math.floor(1_000_000 / 9),
      'repeat-play contribution is bounded by the entanglement discount')
  }

  // ============================================================================
  // 10. wit-invariance of the fold (A4-04/A4-24, the architectural guarantee)
  // ============================================================================
  console.log('\n· wit-invariance of the fold …')
  {
    const cA = goldenA() // genesis carries 3 REAL attestations
    const stripped = { root: cA.root, events: cA.events.map((e) => ({ body: e.body, sig: e.sig })) }
    const garbled = {
      root: cA.root,
      events: cA.events.map((e, i) => ({ ...e, wit: [...forgedWitArr(2, i * 7, `g${i}`), ...(e.wit ?? [])] })),
    }
    const reAttested = attestAt(attestAt(stripped, 0, [aw[3]], 4444), 1, [aw[0], aw[1]], 5555)
    const h0 = stateHash(foldT(cA))
    eq(stateHash(foldT(stripped)), h0, 'STRIP all wit arrays → re-fold → IDENTICAL trust state hash')
    eq(stateHash(foldT(garbled)), h0, 'ATTACH arbitrary forged wit arrays → identical trust state hash')
    eq(stateHash(foldT(reAttested)), h0, 'attach different REAL attestations → identical trust state hash')
    // the same guarantee for the WHOLE a4-v1 fold (which embeds TrustInputs)
    const a4fold = checkpoint.foldById('a4-v1')
    const foldA4 = (c) => wEvents(c).reduce((s, e) => a4fold.step(s, e), a4fold.init(c.root))
    const a0 = stateHash(foldA4(cA))
    eq(stateHash(foldA4(stripped)), a0, 'a4-v1 fold state is wit-invariant too (stripped)')
    eq(stateHash(foldA4(garbled)), a0, 'a4-v1 fold state is wit-invariant too (garbled)')
    // …while the EVIDENCE (read-side, never embedded) legitimately differs:
    eq(evidenceOf(stripped).ageBasisWts, undefined, 'evidence DOES see the strip (no basis), by design')
    eq(evidenceOf(cA).ageBasisWts, 1000, '…vs the attested chain (basis 1000): wit lives in evidence, not state')
    // …and the eligibility ROSTER is likewise evidence-side only: two
    // verifiers with different rosters fold IDENTICAL state bytes (A4-04)
    eq(stateHash(foldT(cA)), h0, 'the fold state is roster-independent (eligibility never reaches embedded state)')
  }

  // ============================================================================
  // 11. windowed prune boundary + bounded size + state-byte determinism
  // ============================================================================
  console.log('\n· window prune + bounded state …')
  {
    // crafted VALID segments (real event + wstream sigs), heights 1..1203
    const evs = [craftedSeg(1, opp(0))]
    for (let h = 2; h <= 1203; h++) evs.push(craftedSeg(h, opp(h)))
    let s = trust.trustInputsInit()
    let s1001 = null
    let s1002 = null
    for (const ev of evs) {
      s = trust.trustInputsStep(s, ev)
      if (ev.body.height === 1001) s1001 = s
      if (ev.body.height === 1002) s1002 = s
    }
    ok(opp(0) in s1001.div, 'entry aged exactly W events (h=1 at evHeight 1001) SURVIVES: diff = W is in-window')
    eq(Object.keys(s1001.div).length, 1001, 'div map holds exactly W+1 = 1001 entries at the boundary')
    ok(!(opp(0) in s1002.div), 'one event past the window (diff = W+1) → entry pruned')
    eq(Object.keys(s1002.div).length, 1001, 'map stays at the W+1 bound after the prune')
    eq(s.wn, 1203, '1203 crafted verified games all counted')
    eq(Object.keys(s.div).length, 1001, '1203 distinct opponents → div map bounded at W+1 = 1001 entries')
    ok(codec.canonicalBytes(s).length < 200_000, 'serialized state stays window-bounded (< 200 KB), not O(games)')
    // repeat play REFRESHES an entry's window position
    let r = trust.trustInputsStep(trust.trustInputsInit(), craftedSeg(1, opp(0)))
    r = trust.trustInputsStep(r, craftedSeg(900, opp(0)))
    r = trust.trustInputsStep(r, craftedSeg(1900, opp(5)))
    ok(opp(0) in r.div && r.div[opp(0)].n === 2, 'entry refreshed at h=900 survives at evHeight 1900 with n=2')
    r = trust.trustInputsStep(r, craftedSeg(1901, opp(6)))
    ok(!(opp(0) in r.div), '…and is pruned one event later')
    // state-byte determinism: fold twice → identical canonicalHash
    const s2 = evs.reduce((acc, ev) => trust.trustInputsStep(acc, ev), trust.trustInputsInit())
    eq(stateHash(s), stateHash(s2), '1203-game fold twice → identical canonicalHash (state bytes pure)')
    ts = 77_000
    const g1 = goldenA()
    ts = 77_000
    const g2 = goldenA()
    eq(stateHash(foldT(g1)), stateHash(foldT(g2)), 'building the golden chain twice → identical folded state bytes')
    eq(stateHash(foldT(g1)), stateHash(foldT(g1)), 'folding one chain twice → identical state bytes')
  }

  // ============================================================================
  // 12. width curve goldens
  // ============================================================================
  console.log('\n· width curve …')
  {
    eq(pairing.width(1_000_000), 50, 'width(T=1e6) = 50 (precision matchmaking)')
    eq(pairing.width(0), 500, 'width(T=0) = 500 (the floor)')
    eq(pairing.width(500_000), 162, 'width(T=0.5) = 50 + floor(450·0.25) = 162')
    eq(pairing.width(750_000), 78, 'width(T=0.75) = 78')
    eq(pairing.width(250_000), 303, 'width(T=0.25) = 303')
    eq(pairing.width(900_000), 54, 'width(T=0.9) = 54 (flat near the top)')
    eq(pairing.width(200_000), 338, 'width(T=0.2) = 338')
    eq(pairing.width(-5), 500, 'width clamps T below 0')
    eq(pairing.width(2_000_000), 50, 'width clamps T above 1e6')
    let mono = true
    for (let t = 0; t < 1_000_000; t += 50_000) if (pairing.width(t) < pairing.width(t + 50_000)) mono = false
    ok(mono, 'width is monotone non-increasing in T over the whole range')
  }

  // ============================================================================
  // 13. island term
  // ============================================================================
  console.log('\n· island term …')
  {
    eq(pairing.islandCostElo(700_000, 650_000), 0, 'both sides at/above the gate → island off (0)')
    eq(pairing.islandCostElo(600_000, 600_000), 0, 'exactly at the gate on both sides → off')
    eq(pairing.islandCostElo(599_999, 600_000), 0, 'one side just under the gate, |ΔT| = 1 → cost floors to 0')
    eq(pairing.islandCostElo(0, 1_000_000), 175, 'T 0 vs 1e6 → floor(0.35·1e6·500/1e12·1e6) = 175 Elo')
    eq(pairing.islandCostElo(200_000, 500_000), 52, 'T 0.2 vs 0.5 → 52 Elo')
    eq(pairing.islandCostElo(500_000, 200_000), 52, 'island cost is symmetric in its arguments')
    eq(pairing.islandCostElo(0, 0), 0, 'comparable suspicion (both at the floor) → zero cost: they attract')
    eq(pairing.islandCostElo(-100, 2_000_000), 175, 'inputs clamp into [0, 1e6] before the gate/cost')
  }

  // ============================================================================
  // 14. bracket rails (fixed multiples of 800, floor toward −∞)
  // ============================================================================
  console.log('\n· bracket rails …')
  {
    const b = (r) => pairing.bracketOf(r)
    eq(JSON.stringify(b(0)), '{"lo":0,"hi":800}', 'bracketOf(0) = [0, 800)')
    eq(JSON.stringify(b(799)), '{"lo":0,"hi":800}', 'bracketOf(799) = [0, 800)')
    eq(JSON.stringify(b(800)), '{"lo":800,"hi":1600}', 'bracketOf(800) opens the next rail')
    eq(JSON.stringify(b(1200)), '{"lo":800,"hi":1600}', 'bracketOf(1200) = [800, 1600)')
    eq(JSON.stringify(b(1600)), '{"lo":1600,"hi":2400}', "bracketOf(1600) = [1600, 2400): the spec's own example rail")
    eq(JSON.stringify(b(2399)), '{"lo":1600,"hi":2400}', 'bracketOf(2399) = [1600, 2400)')
    eq(JSON.stringify(b(-1)), '{"lo":-800,"hi":0}', 'bracketOf(−1) = [−800, 0), floor toward −∞')
    eq(JSON.stringify(b(-800)), '{"lo":-800,"hi":0}', 'bracketOf(−800) = [−800, 0)')
    eq(JSON.stringify(b(-801)), '{"lo":-1600,"hi":-800}', 'bracketOf(−801) = [−1600, −800)')
    eq(pairing.eloOf(1_650_400_123), 1650, 'eloOf floors micro-units to integer Elo')
    eq(pairing.eloOf(-100_000_000), -100, 'eloOf handles negative micro ratings (floor toward −∞)')
  }

  // ============================================================================
  // 15. pairing legality matrix (pinned atWts, A4-16)
  // ============================================================================
  console.log('\n· pairing legality …')
  const AT = 1_000_000 // the pairing record's witnessed timestamp (both sides' T evaluated here)
  const pv = ({ root = 'RA', ladder = 'chess:Blitz', elo = 1500, t = 1_000_000, state = 'ranked', n = 50, of = 100 } = {}) => ({
    root,
    ladderId: ladder,
    ratingMicro: elo * 1_000_000,
    rdMicro: 80_000_000,
    tMicro: t,
    display: state === 'ranked' ? { state, rating: elo } : { state, n, of },
  })
  {
    const L = (a, b) => pairing.pairingLegal(a, b, AT)
    // A4-16: atWts is REQUIRED. The un-pinned form fails closed
    eq(pairing.pairingLegal(pv({ root: 'X' }), pv({ root: 'Y' })).reason, 'bad-at-wts',
      'pairingLegal WITHOUT atWts → illegal (bad-at-wts): no un-pinned evaluation exists')
    eq(pairing.pairingLegal(pv({ root: 'X' }), pv({ root: 'Y' }), 1.5).reason, 'bad-at-wts',
      'fractional atWts → illegal (bad-at-wts)')
    eq(pairing.pairingLegal(pv({ root: 'X' }), pv({ root: 'Y' }), -1).reason, 'bad-at-wts',
      'negative atWts → illegal (bad-at-wts)')
    eq(pairing.pairingLegal(pv({ root: 'X' }), pv({ root: 'X' })).reason, 'bad-at-wts',
      'bad-at-wts is rule 0: checked before even same-root')
    ok(pairing.pairingLegal(pv({ root: 'X' }), pv({ root: 'Y', elo: 1500 }), 0).legal,
      'atWts = 0 is a well-formed witnessed timestamp (only malformed fails)')
    // structure rules
    const self = pv({ root: 'X' })
    eq(L(self, pv({ root: 'X', elo: 1500 })).reason, 'same-root', 'same root → illegal (same-root)')
    eq(L(pv({ root: 'X' }), pv({ root: 'Y', ladder: 'chess:Rapid' })).reason, 'ladder-mismatch',
      'different ladderId → illegal (ladder-mismatch)')
    eq(L(pv({ root: 'X', ladder: 'chess960:Blitz' }), pv({ root: 'Y', ladder: 'chess:Blitz' })).reason,
      'ladder-mismatch', 'same category, different kind → different ladder → illegal')
    // provisional-first pool
    ok(L(pv({ root: 'X', state: 'placement', n: 1, of: 10 }), pv({ root: 'Y', state: 'placement', n: 9, of: 10 })).legal,
      'placement × placement → legal')
    ok(L(pv({ root: 'X', state: 'placement', n: 1, of: 10 }), pv({ root: 'Y', state: 'provisional' })).legal,
      'placement × provisional → legal')
    ok(L(pv({ root: 'X', state: 'provisional', elo: 400 }), pv({ root: 'Y', state: 'provisional', elo: 2300 })).legal,
      'provisional × provisional → legal at ANY protocol-rating distance (zero rating signal)')
    // spillover: bracket math only
    ok(L(pv({ root: 'X', state: 'provisional', elo: 1650 }), pv({ root: 'Y', elo: 1700 })).legal,
      'provisional 1650 × ranked 1700 (same [1600,2400) rail) → legal')
    ok(L(pv({ root: 'X', state: 'placement', elo: 1650, n: 3, of: 10 }), pv({ root: 'Y', elo: 1700 })).legal,
      'placement spillover uses the same bracket rule → legal')
    eq(L(pv({ root: 'X', state: 'provisional', elo: 1590 }), pv({ root: 'Y', elo: 1610 })).reason, 'bracket-mismatch',
      'provisional 1590 × ranked 1610: 20 Elo apart but ACROSS a rail → illegal (bracket math, not distance)')
    ok(L(pv({ root: 'X', state: 'provisional', elo: 1601 }), pv({ root: 'Y', elo: 2399 })).legal,
      'provisional 1601 × ranked 2399: 798 Elo apart but SAME rail → legal (never precise distance)')
    eq(L(pv({ root: 'X', state: 'provisional', elo: 1599 }), pv({ root: 'Y', elo: 1601 })).reason, 'bracket-mismatch',
      'provisional 1599 × ranked 1601 → illegal: precise closeness buys nothing')
    // ranked × ranked: width of BOTH sides
    ok(L(pv({ root: 'X', elo: 1500 }), pv({ root: 'Y', elo: 1550 })).legal, 'high trust both: Δ50 ≤ width 50 → legal')
    eq(L(pv({ root: 'X', elo: 1500 }), pv({ root: 'Y', elo: 1551 })).reason, 'width-exceeded',
      'high trust both: Δ51 > 50 → illegal')
    eq(L(pv({ root: 'X', elo: 1500, t: 1_000_000 }), pv({ root: 'Y', elo: 1560, t: 250_000 })).reason, 'width-exceeded',
      'Δ60 + island 131 = 191 > the HIGH-trust side’s 50 → illegal (both curves bind)')
    ok(191 <= pairing.width(250_000), '…even though 191 fits the low-trust side’s width (303), proves both-sides rule')
    // island attraction: comparable suspicion pairs; asymmetric suspicion repels
    ok(L(pv({ root: 'X', elo: 1500, t: 200_000 }), pv({ root: 'Y', elo: 1800, t: 200_000 })).legal,
      'both T=0.2: Δ300 + island 0 ≤ width 338 → legal (suspicious accounts attract)')
    eq(L(pv({ root: 'X', elo: 1500, t: 200_000 }), pv({ root: 'Y', elo: 1839, t: 200_000 })).reason, 'width-exceeded',
      'both T=0.2: Δ339 > 338 → illegal')
    ok(L(pv({ root: 'X', elo: 1500, t: 200_000 }), pv({ root: 'Y', elo: 1560, t: 550_000 })).legal,
      'T 0.2 vs 0.55: Δ60 + island 61 = 121 ≤ min(338, 141) → legal')
    eq(L(pv({ root: 'X', elo: 1500, t: 200_000 }), pv({ root: 'Y', elo: 1590, t: 550_000 })).reason, 'width-exceeded',
      'T 0.2 vs 0.55: Δ90 + island 61 = 151 > 141 → illegal (island term repels unequal suspicion)')
    ok(L(pv({ root: 'X', elo: 1500, t: 200_000 }), pv({ root: 'Y', elo: 1590, t: 200_000 })).legal,
      'same Δ90 with EQUAL suspicion → island 0 → legal: the island pulls likes together')
  }

  // ============================================================================
  // 16. symmetry property over a fixed PairView grid
  // ============================================================================
  console.log('\n· pairingLegal symmetry …')
  {
    const grid = [
      pv({ root: 'A', elo: 1500, t: 1_000_000 }),
      pv({ root: 'B', elo: 1540, t: 1_000_000 }),
      pv({ root: 'C', elo: 1800, t: 250_000 }),
      pv({ root: 'C', elo: 1800, t: 1_000_000 }), // same root as previous must be illegal vs it
      pv({ root: 'D', elo: 1590, state: 'provisional' }),
      pv({ root: 'E', elo: 1650, state: 'placement', n: 3, of: 10 }),
      pv({ root: 'F', elo: 1650, state: 'provisional' }),
      pv({ root: 'G', elo: -100, state: 'provisional' }),
      pv({ root: 'H', elo: 1700, t: 0 }),
      pv({ root: 'I', elo: 1550, ladder: 'chess:Rapid' }),
    ]
    let mismatches = 0
    let checked = 0
    for (const a of grid)
      for (const b of grid) {
        const ab = pairing.pairingLegal(a, b, AT)
        const ba = pairing.pairingLegal(b, a, AT)
        checked++
        if (ab.legal !== ba.legal || ab.reason !== ba.reason) mismatches++
      }
    eq(checked, 100, 'symmetry grid covers 100 ordered PairView pairs')
    eq(mismatches, 0, 'pairingLegal(a,b,atWts) ≡ pairingLegal(b,a,atWts), verdict AND reason, over the whole grid')
    ok(!pairing.pairingLegal(grid[2], grid[3], AT).legal, 'the same-root pair in the grid is illegal')
    ok(grid.every((v) => !pairing.pairingLegal(v, v, AT).legal), 'every self-pair is illegal (same-root)')
  }

  // ============================================================================
  // 17. visibleOpponentInfo matrix (§6 provisional information rule)
  // ============================================================================
  console.log('\n· visibleOpponentInfo …')
  {
    const placement = pv({ root: 'P1', state: 'placement', elo: 1650, n: 3, of: 10 })
    const provisional = pv({ root: 'P2', state: 'provisional', elo: 1650 })
    const ranked = pv({ root: 'P3', state: 'ranked', elo: 1700 })
    const V = pairing.visibleOpponentInfo
    for (const [viewer, name] of [[placement, 'placement'], [provisional, 'provisional']]) {
      eq(V(viewer, ranked).kind, 'unranked-pool', `${name} viewer × ranked opp → unranked-pool (nothing rating-shaped)`)
      eq(V(viewer, provisional).kind, 'unranked-pool', `${name} viewer × provisional opp → unranked-pool`)
      eq(V(viewer, placement).kind, 'unranked-pool', `${name} viewer × placement opp → unranked-pool`)
    }
    const un = V(provisional, ranked)
    ok(!('rating' in un) && !('lo' in un) && !('hi' in un),
      'the unranked-pool projection carries NO rating-shaped fields at all')
    const rb = V(ranked, provisional)
    eq(rb.kind, 'bracket', 'ranked viewer × provisional opp → quantized bracket only')
    eq(`${rb.lo}-${rb.hi}`, '1600-2400', '…the wide fixed rail (1650 → 1600–2400), estimating nothing precise')
    ok(!('rating' in rb), 'the bracket projection never carries a precise rating')
    eq(V(ranked, placement).kind, 'bracket', 'ranked viewer × placement opp → bracket too')
    const neg = V(ranked, pv({ root: 'P4', state: 'provisional', elo: -100 }))
    eq(`${neg.lo}-${neg.hi}`, '-800-0', 'bracket projection rails correctly for negative protocol ratings')
    const rr = V(ranked, pv({ root: 'P5', state: 'ranked', elo: 1834 }))
    eq(rr.kind, 'rating', 'ranked viewer × ranked opp → full rating')
    eq(rr.rating, 1834, '…the revealed display rating, verbatim')
    eq(pairing.spectatorOpponentInfo(provisional).kind, 'bracket', 'spectator × provisional → bracket (ranked-viewer rule)')
    eq(pairing.spectatorOpponentInfo(ranked).rating, 1700, 'spectator × ranked → full rating')
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
