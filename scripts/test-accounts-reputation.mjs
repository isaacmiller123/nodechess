// Headless test for the A4 conduct + reputation modules
// (src/shared/accounts/ratings/{conduct,reputation}.ts; phase A4 brick 1c,
// re-fixtured by fix-brick F2 for the A4 review: A4-07/11/13/14/22).
//
//   node scripts/test-accounts-reputation.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-chain.mjs) and drives the §6b rules on
// REAL CRYPTO END-TO-END: every fixture segment carries a real event signature
// AND a real witness terminal signature over the full F1 RatedBinding (or the
// exact legacy bytes), embedded opponent checkpoints carry 4 real
// prefix-diverse cosigner attestations, and golden chains assert
// verifyChain(...).ok. Coverage: commend + rematch-accept byte/signature/cert
// verification (fail-closed), payload builders, the A4-07 witness-
// authentication gate (forged wstream / color-flip / bad binding / bad
// oppCkpt segments are EXCLUDED from every rep counter), the legacy-segment
// decision (seg-only), golden score cases, entanglement-weighted commends
// (A4-14 sybil-farm floor math), the countersigned + pending rematch rule
// (A4-13), window compaction (incl. the pend map), chain-level replay death
// (A4-11 'dup-game'), fold purity/totality, byte-determinism, and tiers.
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
function throws(fn, msg) {
  try {
    fn()
    ok(false, `${msg} (did not throw)`)
  } catch {
    ok(true, msg)
  }
}
function hasCode(vr, code, msg) {
  const got = vr.errors.map((e) => e.code)
  ok(!vr.ok && got.includes(code), `${msg}${got.includes(code) ? '' : ` (got ${JSON.stringify(got)})`}`)
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-reputation-test')
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
  console.log('· bundling src/shared/accounts (ratings/conduct + ratings/reputation) …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as events from '${SRC}/events.ts'`,
      `export * as certs from '${SRC}/certs.ts'`,
      `export * as chain from '${SRC}/chain.ts'`,
      `export * as seg from '${SRC}/segment.ts'`,
      `export * as a4 from '${SRC}/ratings/params.ts'`,
      `export * as conduct from '${SRC}/ratings/conduct.ts'`,
      `export * as rep from '${SRC}/ratings/reputation.ts'`,
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
  const { codec, hash, events, chain, seg, a4, conduct, rep } = M

  // ---- fixed raw keypairs -----------------------------------------------------
  const seedOf = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seedOf(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const me = kp(1) // subject root (chain owner)
  const oppA = kp(40) // opponent A root
  const oppB = kp(80) // opponent B root
  const oppAChild = kp(120) // opponent A's device key
  const stranger = kp(160)
  const wit = kp(200) // the game witness (terminal wstream signatures)
  // 10 sybil roots (fresh, checkpoint-less commenders, A4-14 farm fixtures)
  const sybils = Array.from({ length: 10 }, (_, i) => kp(20 + 3 * i))
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
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  const clone = (x) => structuredClone(x)
  const stateHash = (s) => hash.toB64u(codec.canonicalHash(s))

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
  /** VERIFIED opponent checkpoint: root-signed by oppKp, 4 real prefix-diverse
   * cosigner attestations: passes segment.ts verifyEmbeddedOppCkpt. The
   * embedded state self-describes as a4-v1 (A4-10 fold-id rule: a rated-
   * shaped segment may embed a4-v1 checkpoints only). */
  const mkOppCkpt = (oppKp) => {
    const state = { f: 'a4-v1', n: 6 }
    const body = {
      v: 1, lane: 'w', type: 'ckpt', root: oppKp.pubB, key: oppKp.pubB,
      height: 7, prev: fakeId('opp-prev'), ts: 5000,
      payload: { through: 6, state, stateDigest: stateHash(state) },
    }
    const ev = events.signBody(body, oppKp.priv)
    const id = events.eventId(body)
    return { ...ev, wit: cosigners.map((k) => mkAtt(k, id, 900)) }
  }
  /** The verifier's eligibility roster for evidence tests (A4-14): the game
   * witness + the 4 oppCkpt cosigners are recognized fabric witnesses. */
  const ELIG_KEYS = new Set([wit.pubB, ...cosigners.map((k) => k.pubB)])
  const elig = (w) => ELIG_KEYS.has(w)
  /**
   * Segment payload with a REAL witness terminal signature. Default: BOUND
   * (kind 'chess' + Blitz tc, witness signs the FULL F1 RatedBinding
   * {kind, tc, players, reason}). opts:
   *   legacy: true.   No kind/tc, witness signs the EXACT legacy bytes;
   *   est: true.      Embed a verified oppCkpt of oppKp (established pair);
   *   wsig:           override the wstream sig (forgery fixtures);
   *   bindColor:      sign players for THIS color while the payload claims
   *                   `color` (the A4-01 color-flip forgery fixture).
   */
  const segPayload = (game, oppKp, opts = {}) => {
    const { color = 'w', result = '1-0', reason = 'checkmate', legacy = false, est = false, wsig, bindColor } = opts
    const opp = oppKp.pubB
    const transcript = fakeId(`t:${game}`)
    const plies = 24
    const trueColor = bindColor ?? color
    const players = trueColor === 'w' ? { w: meB, b: opp } : { w: opp, b: meB }
    const wstream =
      wsig !== undefined
        ? { wkey: wit.pubB, sig: wsig }
        : seg.signWitnessEnd(wit.priv, wit.pubB, game, result, plies, transcript,
            legacy ? undefined : { kind: 'chess', tc: BLITZ_TC, players, reason })
    return {
      game, opp, color, result, reason, transcript, plies,
      heads: { w: { head: fakeId('hw'), height: 3 }, b: { head: fakeId('hb'), height: 5 } },
      wstream,
      ...(est ? { oppCkpt: mkOppCkpt(oppKp) } : {}),
      oppProfile: { name: 'Opponent' },
      ...(legacy ? {} : { kind: 'chess', tc: BLITZ_TC }),
    }
  }
  const addSeg = (c, game, oppKp, opts) =>
    chain.appendWitnessed(c, me.priv, meB, 'segment', segPayload(game, oppKp, opts), ts++)
  const addConduct = (c, payload) => chain.appendWitnessed(c, me.priv, meB, 'conduct', payload, ts++)
  const addCommend = (c, payload) => chain.appendWitnessed(c, me.priv, meB, 'commend', payload, ts++)
  /** Root-signed commend payload from `opp` for `game` into me's chain. */
  const commendFrom = (opp, game) =>
    conduct.makeCommendPayload({
      game,
      opp: opp.pubB,
      key: opp.pubB,
      sig: conduct.makeCommendSig(opp.priv, { game, from: opp.pubB, to: meB }),
    })
  /** Root-countersigned rematch-accept payload (A4-13) from `opp`. */
  const rematchFrom = (opp, { prior, game }) =>
    conduct.makeConductPayload({
      kind: 'rematch-accept', game, opp: opp.pubB, prior,
      key: opp.pubB,
      sig: conduct.makeRematchSig(opp.priv, { prior, game, from: opp.pubB, to: meB }),
    })
  /** Fold: witnessed events in height order (the checkpoint fold order). */
  const fold = (c) => {
    const w = c.events
      .filter((e) => e.body.lane === 'w')
      .sort((a, b) => a.body.height - b.body.height)
    return w.reduce((s, e) => rep.repStep(s, e), rep.repInit())
  }
  const scoreOf = (c) => rep.repScore(fold(c))

  // A root-signed cert event by oppA for oppAChild (standalone; chain
  // position is immaterial to a root-signed cert).
  const oppAChildCert = events.signBody(
    {
      v: 1, lane: 'p', type: 'cert', root: oppA.pubB, key: oppA.pubB,
      height: 0, ts: 500, payload: { pub: oppAChild.pubB, purpose: 0, index: 0 },
    },
    oppA.priv,
  )

  const G1 = fakeId('game-1')
  const G2 = fakeId('game-2')
  const G3 = fakeId('game-3')
  const G4 = fakeId('game-4')

  // ============================================================================
  // 1. commendBytes / rematchBytes, exact canonical bytes
  // ============================================================================
  console.log('\n· commendBytes canonical form …')
  {
    const ref = { game: G1, from: oppA.pubB, to: meB }
    const text = Buffer.from(conduct.commendBytes(ref)).toString('utf8')
    eq(text, `{"from":"${oppA.pubB}","game":"${G1}","t":"commend","to":"${meB}","v":1}`,
      'commendBytes = cjson {v:1,t:commend,game,from,to} with sorted keys')
    const again = Buffer.from(conduct.commendBytes({ to: meB, from: oppA.pubB, game: G1 })).toString('utf8')
    eq(again, text, 'field order of the ref object never reaches the bytes')
  }
  console.log('\n· rematchBytes canonical form (A4-13) …')
  {
    const ref = { prior: G1, game: G2, from: oppA.pubB, to: meB }
    const text = Buffer.from(conduct.rematchBytes(ref)).toString('utf8')
    eq(text, `{"from":"${oppA.pubB}","game":"${G2}","prior":"${G1}","t":"rematch","to":"${meB}","v":1}`,
      'rematchBytes = cjson {v:1,t:rematch,prior,game,from,to} with sorted keys')
    const again = Buffer.from(conduct.rematchBytes({ to: meB, from: oppA.pubB, prior: G1, game: G2 })).toString('utf8')
    eq(again, text, 'field order of the ref object never reaches the bytes')
    ok(text !== Buffer.from(conduct.commendBytes({ game: G2, from: oppA.pubB, to: meB })).toString('utf8'),
      'rematch bytes are domain-separated from commend bytes (t + prior)')
  }

  // ============================================================================
  // 2. commend sign/verify, root key, child key + certs, fail-closed matrix
  // ============================================================================
  console.log('\n· verifyCommend: root-signed …')
  {
    const p = commendFrom(oppA, G1)
    ok(conduct.verifyCommend(p, meB), 'root-signed commend verifies')
    ok(!conduct.verifyCommend(p, oppB.pubB), 'same payload against the wrong recipient root → false')
    ok(!conduct.verifyCommend({ ...p, sig: flip(p.sig) }, meB), 'flipped signature → false')
    ok(!conduct.verifyCommend({ ...p, game: G2 }, meB), 'signature does not transfer to another game → false')
    ok(!conduct.verifyCommend({ ...p, opp: oppB.pubB }, meB), 'signature does not transfer to another commender → false')
    const self = conduct.makeCommendPayload({
      game: G1, opp: meB, key: meB,
      sig: conduct.makeCommendSig(me.priv, { game: G1, from: meB, to: meB }),
    })
    ok(!conduct.verifyCommend(self, meB), 'self-commend (opp === to) → false')
  }
  console.log('\n· verifyCommend: child key + inline certs …')
  {
    const sig = conduct.makeCommendSig(oppAChild.priv, { game: G1, from: oppA.pubB, to: meB })
    const p = conduct.makeCommendPayload({
      game: G1, opp: oppA.pubB, key: oppAChild.pubB, sig, certs: [oppAChildCert],
    })
    ok(conduct.verifyCommend(p, meB), 'child-key commend with a root-signed inline cert verifies')
    ok(!conduct.verifyCommend({ ...p, certs: undefined }, meB), 'child key without certs → false')
    ok(!conduct.verifyCommend({ ...p, certs: [] }, meB), 'child key with empty certs → false')
    const wrongRootCert = events.signBody(
      { ...clone(oppAChildCert.body), root: oppB.pubB, key: oppB.pubB }, oppB.priv)
    ok(!conduct.verifyCommend({ ...p, certs: [wrongRootCert] }, meB),
      "cert signed by a DIFFERENT root than `opp` → false (key not proven oppA's)")
    const otherPubCert = events.signBody(
      { ...clone(oppAChildCert.body), payload: { pub: stranger.pubB, purpose: 0, index: 1 } }, oppA.priv)
    ok(!conduct.verifyCommend({ ...p, certs: [otherPubCert] }, meB), 'cert proving a different pub → false')
    const forgedCert = clone(oppAChildCert)
    forgedCert.sig = flip(forgedCert.sig)
    ok(!conduct.verifyCommend({ ...p, certs: [forgedCert] }, meB), 'cert with a forged signature → false')
    const strangerSig = conduct.makeCommendSig(stranger.priv, { game: G1, from: oppA.pubB, to: meB })
    ok(!conduct.verifyCommend({ ...p, key: stranger.pubB, sig: strangerSig, certs: [oppAChildCert] }, meB),
      'uncertified stranger key (cert names another pub) → false')
    ok(conduct.verifyCommend({ ...p, certs: [forgedCert, oppAChildCert] }, meB),
      'one bad cert + one good cert → the good one proves the key (true)')
  }
  console.log('\n· verifyCommend: fail-closed malformation matrix …')
  {
    const good = commendFrom(oppA, G1)
    ok(!conduct.verifyCommend(undefined, meB), 'undefined payload → false, no throw')
    ok(!conduct.verifyCommend(null, meB), 'null payload → false, no throw')
    ok(!conduct.verifyCommend('commend', meB), 'string payload → false')
    ok(!conduct.verifyCommend({ ...good, extra: 1 }, meB), 'extra key → false (.strict())')
    ok(!conduct.verifyCommend({ ...good, sig: 'short' }, meB), 'malformed sig shape → false')
    ok(!conduct.verifyCommend({ ...good, game: G1.slice(0, 42) }, meB), 'malformed game id → false')
    ok(!conduct.verifyCommend({ ...good, certs: 'nope' }, meB), 'non-array certs → false')
    ok(!conduct.verifyCommend({ ...good, certs: [] }, meB),
      'root-signed payload CARRYING certs → false (contract: absent when key === opp)')
    ok(!conduct.verifyCommend({ ...good, certs: [{ bad: true }] }, meB), 'garbage cert entry → false')
  }

  // ============================================================================
  // 2b. rematch-accept countersignature verification (A4-13)
  // ============================================================================
  console.log('\n· verifyRematchAccept: root-countersigned …')
  {
    const p = rematchFrom(oppA, { prior: G1, game: G2 })
    ok(conduct.verifyRematchAccept(p, meB), 'root-countersigned rematch-accept verifies')
    ok(!conduct.verifyRematchAccept(p, oppB.pubB), 'same payload against the wrong recipient root → false')
    ok(!conduct.verifyRematchAccept({ ...p, sig: flip(p.sig) }, meB), 'flipped countersignature → false')
    ok(!conduct.verifyRematchAccept({ ...p, game: G3 }, meB), 'signature does not transfer to another rematch game → false')
    ok(!conduct.verifyRematchAccept({ ...p, prior: G3 }, meB), 'signature does not transfer to another prior → false')
    ok(!conduct.verifyRematchAccept({ ...p, opp: oppB.pubB }, meB), 'signature does not transfer to another counterparty → false')
    const self = {
      kind: 'rematch-accept', game: G2, opp: meB, prior: G1, key: meB,
      sig: conduct.makeRematchSig(me.priv, { prior: G1, game: G2, from: meB, to: meB }),
    }
    ok(!conduct.verifyRematchAccept(self, meB), 'self-rematch (opp === to) → false')
    ok(!conduct.verifyRematchAccept(
      conduct.makeConductPayload({ kind: 'abort', game: G1, opp: oppA.pubB }), meB),
      "an 'abort' payload never verifies as a rematch-accept")
    ok(!conduct.verifyRematchAccept({ ...p, sig: 'A'.repeat(86) }, meB), 'garbage 86-char sig → false (fabricated countersig)')
    ok(!conduct.verifyRematchAccept(undefined, meB), 'undefined payload → false, no throw')
    ok(!conduct.verifyRematchAccept({ ...p, extra: 1 }, meB), 'extra key → false (.strict())')
  }
  console.log('\n· verifyRematchAccept: child key + inline certs …')
  {
    const sig = conduct.makeRematchSig(oppAChild.priv, { prior: G1, game: G2, from: oppA.pubB, to: meB })
    const p = conduct.makeConductPayload({
      kind: 'rematch-accept', game: G2, opp: oppA.pubB, prior: G1,
      key: oppAChild.pubB, sig, certs: [oppAChildCert],
    })
    ok(conduct.verifyRematchAccept(p, meB), 'child-key rematch-accept with a root-signed inline cert verifies')
    ok(!conduct.verifyRematchAccept({ ...p, certs: undefined }, meB), 'child key without certs → false')
    const forgedCert = clone(oppAChildCert)
    forgedCert.sig = flip(forgedCert.sig)
    ok(!conduct.verifyRematchAccept({ ...p, certs: [forgedCert] }, meB), 'forged cert → false')
    const rootP = rematchFrom(oppA, { prior: G1, game: G2 })
    ok(!conduct.verifyRematchAccept({ ...rootP, certs: [oppAChildCert] }, meB),
      'root-signed payload CARRYING certs → false (contract: absent when key === opp)')
  }

  // ============================================================================
  // 3. payload builders
  // ============================================================================
  console.log('\n· payload builders …')
  {
    const c1 = conduct.makeConductPayload({ kind: 'abort', game: G1, opp: oppA.pubB })
    eq(c1.prior, undefined, 'abort payload carries no prior')
    ok(events.zConductPayload.safeParse(c1).success, 'abort payload satisfies zConductPayload')
    const c2 = rematchFrom(oppA, { prior: G1, game: G2 })
    eq(c2.prior, G1, 'rematch-accept payload carries prior')
    ok(events.zConductPayload.safeParse(c2).success, 'countersigned rematch-accept satisfies zConductPayload')
    throws(() => conduct.makeConductPayload({ kind: 'rematch-accept', game: G2, opp: oppA.pubB, prior: G1 }),
      'rematch-accept without the counterparty sig+key throws (A4-13: no unilateral claims)')
    throws(() => conduct.makeConductPayload({
      kind: 'rematch-accept', game: G2, opp: oppA.pubB,
      key: oppA.pubB, sig: conduct.makeRematchSig(oppA.priv, { prior: G1, game: G2, from: oppA.pubB, to: meB }),
    }), 'rematch-accept without prior throws')
    throws(() => conduct.makeConductPayload({ kind: 'abort', game: G1, opp: oppA.pubB, prior: G2 }),
      'abort with prior throws')
    throws(() => conduct.makeConductPayload({ kind: 'abort', game: G1, opp: oppA.pubB, sig: 'A'.repeat(86), key: oppA.pubB }),
      'abort with sig/key throws (countersign material is rematch-only)')
    throws(() => conduct.makeConductPayload({ kind: 'noshow', game: 'not-an-id', opp: oppA.pubB }),
      'malformed game key throws')
    throws(() => conduct.makeConductPayload({
      kind: 'rematch-accept', game: G2, opp: oppA.pubB, prior: G1, key: oppAChild.pubB, sig: 'A'.repeat(86),
    }), 'rematch-accept child key without certs throws')
    throws(() => conduct.makeConductPayload({
      kind: 'rematch-accept', game: G2, opp: oppA.pubB, prior: G1, key: oppA.pubB, sig: 'A'.repeat(86), certs: [oppAChildCert],
    }), 'rematch-accept root key WITH certs throws')
    throws(() => conduct.makeCommendPayload({ game: G1, opp: oppA.pubB, key: oppAChild.pubB, sig: 'A'.repeat(86) }),
      'makeCommendPayload: child key without certs throws')
    throws(() => conduct.makeCommendPayload({ game: G1, opp: oppA.pubB, key: oppA.pubB, sig: 'A'.repeat(86), certs: [] }),
      'makeCommendPayload: root key WITH certs throws')
    ok(events.zCommendPayload.safeParse(commendFrom(oppA, G1)).success, 'built commend satisfies zCommendPayload')
  }

  // ============================================================================
  // 4. neutral start + single-class golden cases (weights: 350k/250k/100k/100k/50k/150k)
  // ============================================================================
  console.log('\n· neutral start …')
  {
    const s0 = rep.repInit()
    eq(rep.repScore(s0), 80, 'fresh state scores the documented neutral 80')
    eq(s0.commendTw, 0, 'fresh state has zero weighted commend credit')
    eq(Object.keys(s0.com).length, 0, 'fresh state has an empty commend-decay map (A4-14)')
    eq(Object.keys(s0.pend).length, 0, 'fresh state has no pending rematch claims')
    eq(s0.unsettled, 0, 'fresh state has zero unsettled pairing obligations (J5)')
    eq(Object.keys(s0.ob).length, 0, 'fresh state has no open pairing obligations (J5)')
    eq(rep.repTier(80), 2, 'neutral 80 sits in tier 2')
    eq(scoreOf(mkChain()), 80, 'genesis-only chain folds to the neutral 80 (visible from game 1)')
    eq(scoreOf(addSeg(mkChain(), G1, oppA)), 80, 'one clean completed game keeps 80 (merit not yet earned)')
  }
  console.log('\n· each weight class, isolated …')
  {
    // completion (0.35): 1 abort, 0 segments → completion 0, others: D=100 T=100 N=100 R=0 M=0
    eq(scoreOf(addConduct(mkChain(), conduct.makeConductPayload({ kind: 'abort', game: G1, opp: oppA.pubB }))),
      45, 'abort only: completion 0 → 80 − 35 = 45')
    // disconnect (0.25): subject lost by disconnect (bound segment; witness signed the reason)
    eq(scoreOf(addSeg(mkChain(), G1, oppA, { color: 'w', result: '0-1', reason: 'disconnect' })),
      55, 'own disconnect loss: disconnect 0 → 80 − 25 = 55')
    eq(scoreOf(addSeg(mkChain(), G1, oppA, { color: 'w', result: '1-0', reason: 'abandon' })),
      80, "opponent's abandon (subject WON) is not the subject's drop → stays 80")
    eq(scoreOf(addSeg(mkChain(), G1, oppA, { color: 'b', result: '0-1', reason: 'abandon' })),
      80, 'abandon win as black → stays 80 (color/result attribution)')
    // timeout-vs-resign (0.10)
    eq(scoreOf(addSeg(mkChain(), G1, oppA, { color: 'b', result: '1-0', reason: 'flag' })),
      70, 'flag loss with no resigns: toResign 0 → 80 − 10 = 70')
    eq(scoreOf(addSeg(mkChain(), G1, oppA, { color: 'w', result: '0-1', reason: 'resign' })),
      80, 'resign loss: toResign 100 (graceful) → stays 80')
    eq(scoreOf(addSeg(mkChain(), G1, oppA, { color: 'w', result: '1-0', reason: 'flag' })),
      80, "opponent's flag (subject won) → stays 80")
    // noshow (0.10)
    eq(scoreOf(addConduct(mkChain(), conduct.makeConductPayload({ kind: 'noshow', game: G1, opp: oppA.pubB }))),
      70, 'noshow only: noshowSub 0 → 80 − 10 = 70')
    // rematch (0.05, A4-13): claim alone is PENDING (counts nothing) …
    {
      let c = addSeg(mkChain(), G1, oppA)
      c = addConduct(c, rematchFrom(oppA, { prior: G1, game: G2 }))
      const sPend = fold(c)
      eq(sPend.rematch, 0, 'countersigned claim with no rematch game yet: rematch 0 (pending)')
      eq(sPend.pend[`${G2}:${oppA.pubB}`], 2, 'the claim is recorded pending at its witnessed height')
      eq(rep.repScore(sPend), 80, '…and the score is unmoved until the game appears')
      // … and counts when the rematch game's own segment lands
      c = addSeg(c, G2, oppA)
      const sDone = fold(c)
      eq(sDone.rematch, 1, 'the arriving verified segment for the claimed game settles the claim')
      eq(Object.keys(sDone.pend).length, 0, 'settling consumes the pending entry')
      eq(rep.repScore(sDone), 81, 'one settled rematch-accept → 80 + 1')
    }
    // commend (0.15, A4-14): fresh commender (no oppCkpt) → floor weight 1/20
    {
      let c = addSeg(mkChain(), G1, oppA)
      c = addCommend(c, commendFrom(oppA, G1))
      const s = fold(c)
      eq(s.commend, 1, 'fresh-commender commend counts once')
      eq(s.commendTw, 1, '…at the FLOOR weight (1 twentieth: no verified opponent checkpoint)')
      eq(rep.repScore(s), 83, 'commendSub = floor(400·1/(20·1)) = 20 → 80 + 3')
    }
    // commend from an ESTABLISHED pair (A4-14 layer split): the FOLD grants
    // only the decayed floor; the est tier is EARNED at read time through
    // eligibility-verified evidence (repEvidenceOf): never presumed.
    {
      let c = addSeg(mkChain(), G1, oppA, { est: true })
      c = addCommend(c, commendFrom(oppA, G1))
      const s = fold(c)
      eq(s.pair[`${G1}:${oppA.pubB}`].f & rep.PAIR_EST, rep.PAIR_EST, 'the pair carries the PAIR_EST claim flag')
      eq(s.commendTw, 1, 'IN-FOLD the est claim is weightless: the commend folds at the decayed floor (1)')
      eq(rep.repScore(s), 83, 'score WITHOUT evidence = 83: est weight is never presumed (A4-14)')
      const ev = rep.repEvidenceOf(c, elig)
      eq(ev.commendTwBonus, 19, 'eligibility-verified evidence earns the est remainder (20 − 1 = 19)')
      eq(rep.repScore(s, ev), 95, 'score WITH evidence: commendSub = min(100, floor(400·20/(20·1))) = 100 → 95')
      eq(rep.repEvidenceOf(c).commendTwBonus, 0, 'NO eligibility predicate → zero bonus (nothing vouched, nothing earned)')
      eq(rep.repEvidenceOf(c, () => false).commendTwBonus, 0, 'roster rejecting every key → zero bonus')
      // A4-14 PIN. The review's exact residue: valid-SIGNATURE cosigners that
      // the verifier does NOT recognize as eligible witnesses earn nothing.
      const eligNoCos = (w) => w === wit.pubB
      eq(rep.repEvidenceOf(c, eligNoCos).commendTwBonus, 0,
        'valid-sig but NON-ELIGIBLE cosigners → est tier NOT earned (A4-14: signature validity ≠ eligibility)')
      const eligNoWit = (w) => ELIG_KEYS.has(w) && w !== wit.pubB
      eq(rep.repEvidenceOf(c, eligNoWit).commendTwBonus, 0,
        'a self-run (non-eligible) wstream witness key → est tier NOT earned either')
    }
  }

  // ============================================================================
  // 4b. legacy segments (kind/tc-less, wstream-valid), seg only, ever
  // ============================================================================
  console.log('\n· legacy segments: completion only, never misconduct/merit …')
  {
    const cL = addSeg(mkChain(), G1, oppA, { legacy: true, color: 'w', result: '0-1', reason: 'disconnect' })
    const sL = fold(cL)
    eq(sL.seg, 1, 'legacy wstream-valid segment counts toward seg (the game happened)')
    eq(sL.drop, 0, "…but its self-asserted reason/color NEVER count as misconduct (unbound)")
    eq(rep.repScore(sL), 80, 'legacy disconnect-shaped loss keeps the neutral 80')
    eq((sL.pair[`${G1}:${oppA.pubB}`].f & rep.PAIR_BOUND), 0, 'legacy pair entry lacks PAIR_BOUND')
    // legacy + abort: legacy still feeds the completion denominator
    const cLA = addConduct(cL, conduct.makeConductPayload({ kind: 'abort', game: G2, opp: oppA.pubB }))
    eq(scoreOf(cLA), 62, 'legacy seg + abort: completion floor(100/2)=50, others clean → 62 (legacy feeds the denominator)')
    // legacy segments never unlock merit
    const cLC = addCommend(cL, commendFrom(oppA, G1))
    eq(fold(cLC).commend, 0, 'a commend referencing a LEGACY segment is ignored (opp is unbound)')
    let cLR = addConduct(cL, rematchFrom(oppA, { prior: G1, game: G2 }))
    cLR = addSeg(cLR, G2, oppA)
    eq(fold(cLR).rematch, 0, 'a rematch claim whose prior is LEGACY is ignored')
    // and a legacy ARRIVAL cannot settle a pending claim
    let cArr = addSeg(mkChain(), G1, oppA)
    cArr = addConduct(cArr, rematchFrom(oppA, { prior: G1, game: G2 }))
    cArr = addSeg(cArr, G2, oppA, { legacy: true })
    eq(fold(cArr).rematch, 0, 'a LEGACY segment for the claimed game does not settle the pending claim')
  }

  // ============================================================================
  // 4c. A4-07 / A4-22: witness authentication gates EVERY rep counter
  // ============================================================================
  console.log('\n· forged/unbound segments are excluded from all rep counters …')
  {
    const neutral = stateHash(fold(mkChain()))
    // (a) forged wstream signature (garbage 86-char b64u)
    const cF = addSeg(mkChain(), G1, oppA, { wsig: 'A'.repeat(86) })
    const sF = fold(cF)
    eq(sF.seg, 0, 'forged-wstream segment counts NOTHING (A4-07 gate)')
    eq(stateHash(sF), neutral, '…and leaves the rep state byte-identical to genesis-only')
    hasCode(chain.verifyChain(cF), 'bad-segment', '…and verifyChain rejects the chain (bad-segment)')
    // (b) bound payload whose witness signed the LEGACY bytes (bad-ladder-binding)
    const pHalf = segPayload(G1, oppA)
    pHalf.wstream = seg.signWitnessEnd(wit.priv, wit.pubB, G1, '1-0', 24, pHalf.transcript) // legacy bytes
    const cH = chain.appendWitnessed(mkChain(), me.priv, meB, 'segment', pHalf, ts++)
    eq(seg.verifySegmentEvent(cH.events[cH.events.length - 1]), 'bad-ladder-binding', 'fixture sanity: bad-ladder-binding')
    eq(fold(cH).seg, 0, 'bad-ladder-binding segment counts NOTHING in rep')
    // (c) the A4-01/A4-19 color flip: witness signed players for color b, payload claims w
    const cFlip = addSeg(mkChain(), G1, oppA, { result: '1-0', color: 'w', bindColor: 'b' })
    eq(seg.verifySegmentEvent(cFlip.events[cFlip.events.length - 1]), 'bad-ladder-binding',
      'fixture sanity: color-flip breaks the atomic binding')
    eq(fold(cFlip).seg, 0, 'color-flipped segment counts NOTHING in rep (loss cannot be laundered)')
    hasCode(chain.verifyChain(cFlip), 'bad-segment', '…and verifyChain rejects the color-flipped chain')
    // (d) forged EVENT signature (crafted, never appendable)
    const crafted = {
      body: {
        v: 1, lane: 'w', type: 'segment', root: meB, key: meB, height: 1,
        prev: fakeId('p'), ts: 1, payload: segPayload(G1, oppA),
      },
      sig: 'A'.repeat(86),
    }
    const s0 = rep.repInit()
    ok(rep.repStep(s0, crafted) === s0, 'forged event signature → pass-through (same reference)')
    // (e) unverifiable embedded oppCkpt (fabricated cosigners), fail-HARD
    const pBadCk = segPayload(G1, oppA, { est: true })
    pBadCk.oppCkpt = { ...pBadCk.oppCkpt, wit: pBadCk.oppCkpt.wit.map((a, i) => ({ ...a, sig: 'B'.repeat(86) })) }
    const cBadCk = chain.appendWitnessed(mkChain(), me.priv, meB, 'segment', pBadCk, ts++)
    eq(seg.verifySegmentEvent(cBadCk.events[cBadCk.events.length - 1]), 'bad-opp-ckpt', 'fixture sanity: fabricated cosigs')
    eq(fold(cBadCk).seg, 0, 'segment with an unverifiable oppCkpt counts NOTHING in rep')
  }

  // ============================================================================
  // 5. golden multi-event chains → exact scores (verifyChain-valid fixtures)
  // ============================================================================
  console.log('\n· golden chains …')
  {
    // Exemplary: 3 established games + 2 full-weight commends + 1 settled
    // rematch (claim → the rematch game itself arrives). Tier 3.
    let c = mkChain()
    c = addSeg(c, G1, oppA, { est: true, reason: 'checkmate' })
    c = addSeg(c, G2, oppA, { est: true, color: 'b', result: '1/2-1/2', reason: 'agreement' })
    c = addSeg(c, G3, oppB, { est: true, reason: 'stalemate', result: '1/2-1/2' })
    c = addCommend(c, commendFrom(oppA, G1))
    c = addCommend(c, commendFrom(oppB, G3))
    c = addConduct(c, rematchFrom(oppA, { prior: G1, game: G4 }))
    c = addSeg(c, G4, oppA, { est: true, color: 'b', result: '0-1', reason: 'resign' })
    const s = fold(c)
    eq(s.seg, 4, 'golden A: 4 segments counted')
    eq(s.commend, 2, 'golden A: 2 commends counted')
    eq(s.commendTw, 2, 'golden A: both commends fold at the decayed floor (distinct opps: 1 + 1)')
    eq(s.rematch, 1, 'golden A: the settled rematch counted')
    eq(Object.keys(s.pend).length, 0, 'golden A: no pending claims remain')
    eq(s.drop + s.toLoss + s.rsLoss, 0, 'golden A: no misconduct counters (the resign loss was the OPP’s)')
    // WITHOUT evidence: C=100 D=100 T=100 N=100 R=20 M=floor(400·2/80)=10 → 82
    eq(rep.repScore(s), 82, 'golden A score without evidence = 82 (est tier unearned)')
    // WITH eligibility-verified evidence: bonus 19+19 → tw 40 →
    // M=min(100,floor(400·40/80))=100 → 96 (the pre-split golden, now earned)
    const evA = rep.repEvidenceOf(c, elig)
    eq(evA.commendTwBonus, 38, 'golden A evidence: est remainder 19 + 19')
    eq(rep.repScore(s, evA), 96, 'golden A score with evidence = 96 exactly')
    eq(rep.repTier(rep.repScore(s, evA)), 3, 'golden A is tier 3 (with evidence)')
    eq(chain.verifyChain(c).ok, true, 'golden A chain verifies ok end-to-end (real crypto)')

    // Bad actor: 4 bound segments (2 own drops, 1 flag loss, 1 clean), 2 aborts, 1 noshow.
    let b = mkChain()
    b = addSeg(b, G1, oppA, { color: 'w', result: '0-1', reason: 'disconnect' })
    b = addSeg(b, G2, oppA, { color: 'b', result: '1-0', reason: 'abandon' })
    b = addSeg(b, G3, oppB, { color: 'w', result: '0-1', reason: 'flag' })
    b = addSeg(b, G4, oppB, { reason: 'checkmate' })
    b = addConduct(b, conduct.makeConductPayload({ kind: 'abort', game: fakeId('a1'), opp: oppA.pubB }))
    b = addConduct(b, conduct.makeConductPayload({ kind: 'abort', game: fakeId('a2'), opp: oppB.pubB }))
    b = addConduct(b, conduct.makeConductPayload({ kind: 'noshow', game: fakeId('n1'), opp: oppB.pubB }))
    const sb = fold(b)
    eq(sb.seg, 4, 'golden B: 4 segments')
    eq(sb.drop, 2, 'golden B: 2 own drops (witness-signed reasons)')
    eq(sb.toLoss, 1, 'golden B: 1 timeout loss')
    eq(sb.abort, 2, 'golden B: 2 aborts')
    eq(sb.noshow, 1, 'golden B: 1 noshow')
    // C=floor(400/6)=66 D=floor(200/4)=50 T=floor(0/1)=0 N=floor(600/7)=85 R=0 M=0
    eq(rep.repScore(sb), 44, 'golden B score = 44 exactly')
    eq(rep.repTier(44), 1, 'golden B is tier 1')
    eq(chain.verifyChain(b).ok, true, 'golden B chain verifies ok end-to-end')

    // Rock bottom: only misconduct, every sub-score 0.
    let z = mkChain()
    z = addSeg(z, G1, oppA, { color: 'w', result: '0-1', reason: 'disconnect' })
    for (let i = 0; i < 199; i++)
      z = addConduct(z, conduct.makeConductPayload({ kind: 'abort', game: fakeId(`za${i}`), opp: oppA.pubB }))
    for (let i = 0; i < 100; i++)
      z = addConduct(z, conduct.makeConductPayload({ kind: 'noshow', game: fakeId(`zn${i}`), opp: oppA.pubB }))
    const sz = fold(z)
    // C=floor(100/200)=0 D=0 T=100(no clock losses) N=floor(20000/300)=66 …
    eq(rep.repScore(sz), 16, 'rock-bottom chain scores floor(0+0+10+6.6+0+0) = 16')
    eq(rep.repTier(rep.repScore(sz)), 0, 'rock bottom is tier 0')
  }

  // ============================================================================
  // 6. rate limits + farming rejections
  // ============================================================================
  console.log('\n· commend rate limits …')
  {
    let c = addSeg(mkChain(), G1, oppA)
    const before = stateHash(fold(c))
    // (a) commend without ANY matching segment
    const cNoSeg = addCommend(mkChain(), commendFrom(oppA, G1))
    eq(rep.repScore(fold(cNoSeg)), 80, 'commend without a matching segment is ignored')
    eq(fold(cNoSeg).commend, 0, 'ignored commend leaves the counter at 0')
    // (b) commend whose (game) matches but opp does not (segment names oppA)
    const cWrongOpp = addCommend(c, commendFrom(oppB, G1))
    eq(fold(cWrongOpp).commend, 0, 'commend from a root the segment does not name is ignored')
    // (c) forged signature
    const forged = { ...commendFrom(oppA, G1), sig: 'A'.repeat(86) }
    const cForged = addCommend(c, forged)
    eq(fold(cForged).commend, 0, 'forged commend sig is silently ignored (fold never throws)')
    eq(stateHash(fold(cForged)), before, 'forged commend leaves the state bytes untouched')
    // (d) second commend for the same (opp, game)
    let c2 = addCommend(c, commendFrom(oppA, G1))
    const oneHash = stateHash(fold(c2))
    eq(fold(c2).commend, 1, 'first valid commend counts')
    c2 = addCommend(c2, commendFrom(oppA, G1))
    eq(fold(c2).commend, 1, 'second commend for the same (opp, game) is ignored')
    eq(fold(c2).commendTw, 1, '…and adds no weighted credit')
    eq(stateHash(fold(c2)), oneHash, 'duplicate commend leaves the state bytes untouched')
    // (e) commend arriving BEFORE its segment in chain order does not count
    let c3 = addCommend(mkChain(), commendFrom(oppA, G1))
    c3 = addSeg(c3, G1, oppA)
    eq(fold(c3).commend, 0, 'commend earlier in-chain than its segment does not count')
    // (f) self-commend event in own chain
    const selfP = {
      game: G1, opp: meB, key: meB,
      sig: conduct.makeCommendSig(me.priv, { game: G1, from: meB, to: meB }),
    }
    eq(fold(addCommend(addSeg(mkChain(), G1, oppA), selfP)).commend, 0, 'self-commend (opp === root) ignored')
  }
  console.log('\n· A4-14: sybil commend farm floor math …')
  {
    // 10 fresh sybil roots, one bound game + one root-signed commend each.
    // A 100% commend rate from checkpoint-less commenders.
    let cFarm = mkChain()
    for (let i = 0; i < 10; i++) cFarm = addSeg(cFarm, fakeId(`farm-${i}`), sybils[i])
    for (let i = 0; i < 10; i++) cFarm = addCommend(cFarm, commendFrom(sybils[i], fakeId(`farm-${i}`)))
    const sFarm = fold(cFarm)
    eq(sFarm.seg, 10, 'farm: all 10 games counted')
    eq(sFarm.commend, 10, 'farm: all 10 commends individually valid and counted')
    eq(sFarm.commendTw, 10, 'farm: each at the 1/20 floor, 10 twentieths total')
    eq(rep.repScore(sFarm), 83, 'farm commendSub = floor(400·10/(20·10)) = 20 → 83, NOT the 95 an earned record gets')
    eq(chain.verifyChain(cFarm).ok, true, 'the farm chain is chain-VALID (the fold rule, not verification, contains it)')
    eq(rep.repEvidenceOf(cFarm, elig).commendTwBonus, 0,
      'farm evidence: no oppCkpt anywhere → zero est bonus even under an honest roster')
    // A4-14 PIN. The review's sybil residue, closed: the SAME farm shape with
    // self-minted verifyEmbeddedOppCkpt-PASSING checkpoints (real keypairs,
    // real signatures. Est CLAIMS everywhere) still scores the farm floor:
    // the fold never grants est weight, and no verifier who does not vouch
    // for those cosigners ever will.
    let cEst = mkChain()
    for (let i = 0; i < 10; i++) cEst = addSeg(cEst, fakeId(`est-${i}`), sybils[i], { est: true })
    for (let i = 0; i < 10; i++) cEst = addCommend(cEst, commendFrom(sybils[i], fakeId(`est-${i}`)))
    const sEst = fold(cEst)
    eq(sEst.commendTw, 10, 'est-claim farm: the FOLD still grants only the floor (10 twentieths)')
    eq(rep.repScore(sEst), 83, 'est-claim farm WITHOUT evidence scores exactly the fresh-farm 83 (A4-14 pin)')
    eq(chain.verifyChain(cEst).ok, true, '…on a chain-VALID chain (the attack shape is real)')
    const eligNoCos = (w) => w === wit.pubB
    eq(rep.repEvidenceOf(cEst, eligNoCos).commendTwBonus, 0,
      'est-claim farm under a roster that does NOT recognize its cosigners → zero bonus → still 83')
    // contrast: when the verifier DOES vouch for the cosigners (real fabric
    // witnesses), the same shape earns full credit: goodwill is roster-earned
    const evEst = rep.repEvidenceOf(cEst, elig)
    eq(evEst.commendTwBonus, 190, 'eligibility-verified established opponents: bonus 10 × 19')
    eq(rep.repScore(sEst, evEst), 95, 'established commendSub with evidence = min(100, floor(400·200/200)) = 100 → 95')
  }
  console.log('\n· A4-14: per-opponent entanglement decay (§6b rate-limit) …')
  {
    // The buddy-farm vector: ONE established opp, 3 games, 3 commends. The
    // k-th in-window commend from one opp is worth floor(20/k) TOTAL
    // (fold floor(1/k) + evidence remainder): 20, 10, 6. Repeat goodwill
    // decays exactly like the trust fold's repeat-play entSat discount.
    let c = mkChain()
    c = addSeg(c, G1, oppA, { est: true })
    c = addSeg(c, G2, oppA, { est: true })
    c = addSeg(c, G3, oppA, { est: true })
    c = addCommend(c, commendFrom(oppA, G1))
    c = addCommend(c, commendFrom(oppA, G2))
    c = addCommend(c, commendFrom(oppA, G3))
    const s = fold(c)
    eq(s.commend, 3, 'decay: all 3 commends counted (distinct games; the ≤1-per-(opp,game) rule is separate)')
    eq(s.commendTw, 1, 'decay: fold floor tw = floor(1/1)+floor(1/2)+floor(1/3) = 1 + 0 + 0')
    eq(s.com[oppA.pubB].k, 3, 'decay: the windowed per-opp counter reached 3')
    const ev3 = rep.repEvidenceOf(c, elig)
    eq(ev3.commendTwBonus, 19 + 10 + 6, 'decay: est evidence remainder = 19 + 10 + 6')
    eq(s.commendTw + ev3.commendTwBonus, 36, 'decay: total credit 36 = 20 + 10 + 6, NOT 60. Buddy commends decay')
    // contrast: the same 3 est commends from 3 DISTINCT opps carry 60
    let cD = mkChain()
    const oppsD = [oppA, oppB, sybils[0]]
    for (let i = 0; i < 3; i++) cD = addSeg(cD, [G1, G2, G3][i], oppsD[i], { est: true })
    for (let i = 0; i < 3; i++) cD = addCommend(cD, commendFrom(oppsD[i], [G1, G2, G3][i]))
    const sD = fold(cD)
    eq(sD.commendTw, 3, 'distinct opps: fold floor 1+1+1')
    eq(sD.commendTw + rep.repEvidenceOf(cD, elig).commendTwBonus, 60, 'distinct opps: full 20 each. No decay across opponents')
    // the decay counter is WINDOWED: a commend after repPairWindow restarts k
    let gen2 = 0
    const pad = (cc, n) => {
      for (let i = 0; i < n; i++)
        cc = chain.appendWitnessed(cc, me.priv, meB, 'pin', { record: fakeId(`dpin${gen2}`), gen: gen2++ }, ts++)
      return cc
    }
    let cW = addSeg(mkChain(), G1, oppA) // h1
    cW = addCommend(cW, commendFrom(oppA, G1)) // h2: k=1, tw+1
    cW = pad(cW, a4.PARAMS_A4.repPairWindow) // ride far past the window
    cW = addSeg(cW, G2, oppA) // state-modifying → prunes the stale com entry
    cW = addCommend(cW, commendFrom(oppA, G2))
    const sW = fold(cW)
    eq(sW.com[oppA.pubB].k, 1, 'window: the per-opp decay counter restarted (k = 1) after repPairWindow')
    eq(sW.commendTw, 2, 'window: both commends earned the floor (decay memory is O(window), like pair/pend)')
    // evidence↔fold mirror at the window edge (the walk runs THROUGH repStep:
    // counted ⇔ earning, zero rule drift)
    let gen3 = 0
    const pad3 = (cc, n) => {
      for (let i = 0; i < n; i++)
        cc = chain.appendWitnessed(cc, me.priv, meB, 'pin', { record: fakeId(`epin${gen3}`), gen: gen3++ }, ts++)
      return cc
    }
    const W = a4.PARAMS_A4.repPairWindow
    let cE = addSeg(mkChain(), G1, oppA, { est: true }) // h1
    cE = pad3(cE, W - 1) // heads through h(W)
    const cEok = addCommend(cE, commendFrom(oppA, G1)) // h(W+1), diff exactly W
    eq(fold(cEok).commend, 1, 'evidence mirror fixture: commend at the window edge counts in the fold')
    eq(rep.repEvidenceOf(cEok, elig).commendTwBonus, 19, 'evidence at the window edge grants the est remainder')
    const cEbad = addCommend(pad3(cE, 1), commendFrom(oppA, G1)) // diff W+1
    eq(fold(cEbad).commend, 0, '…one past the edge the fold ignores the commend')
    eq(rep.repEvidenceOf(cEbad, elig).commendTwBonus, 0, '…and evidence grants NOTHING (counted ⇔ earned, zero drift)')
  }
  console.log('\n· A4-21 CLOSED (A7): the read-time commend-revocation discount …')
  {
    // The scenario the closure covers: oppA certified a child key, the key
    // was STOLEN, oppA revoked it in oppA's OWN chain, and the thief mints a
    // commend with the old cert inline. The revoke demonstrably exists …
    const revokeEv = events.signBody(
      {
        v: 1, lane: 'w', type: 'revoke', root: oppA.pubB, key: oppA.pubB,
        height: 8, prev: fakeId('opp-prev-2'), ts: 6000, payload: { pub: oppAChild.pubB },
      },
      oppA.priv,
    )
    ok(events.verifyEventSig(revokeEv), 'fixture sanity: the revoke event in the COMMENDER’s chain is real and root-signed')
    // … and it lives in the commender's chain, which the FOLD may never read
    // (§5/§6 recursion + A4-04 determinism) and inline payload material
    // cannot carry, so the two design pins below STAY true forever. The
    // closure is exactly at the conduct.ts-designated seam: repEvidenceOf
    // takes the caller's revocation view and discounts at READ TIME.
    const childCommend = conduct.makeCommendPayload({
      game: G1, opp: oppA.pubB, key: oppAChild.pubB,
      sig: conduct.makeCommendSig(oppAChild.priv, { game: G1, from: oppA.pubB, to: meB }),
      certs: [oppAChildCert],
    })
    ok(conduct.verifyCommend(childCommend, meB),
      'A4-21 PIN (permanent design boundary): a certified-then-revoked child key still verifies. Inline material cannot carry the revoke')
    let c = addSeg(mkChain(), G1, oppA, { est: true })
    c = addCommend(c, childCommend)
    const s = fold(c)
    eq(s.commend, 1,
      'A4-21 PIN (permanent design boundary): …and the deterministic fold counts it. The discount lives at read time only')
    eq(s.commendTw, 1, 'fold floor credit for the commend is 1 twentieth (k = 1)')
    const foldDigestBefore = stateHash(s)
    const commendTs = c.events.find((e) => e.body.type === 'commend').body.ts
    const viewAt = (wts) => (root, key) =>
      root === oppA.pubB && key === oppAChild.pubB ? wts : undefined
    // ── revoked BEFORE the commend (the stolen-key case) ⇒ DISCOUNTED ──
    const evRev = rep.repEvidenceOf(c, elig, viewAt(commendTs - 1))
    eq(evRev.commendTwRevoked, 1, 'A4-21 CLOSED: revoked-before-signing key ⇒ the folded floor twentieth is flagged for subtraction')
    eq(evRev.commendTwBonus, 0, 'A4-21 CLOSED: …and the est-tier bonus is denied')
    eq(rep.repScore(s, evRev), 80, 'A4-21 CLOSED: with the view, the stolen-key commend contributes ZERO (score = fresh-with-one-game 80)')
    const cNone = addSeg(mkChain(), G1, oppA, { est: true })
    eq(rep.repScore(s, evRev), rep.repScore(fold(cNone), rep.repEvidenceOf(cNone, elig)),
      'A4-21 CLOSED: read-time total equals the same chain with NO commend at all')
    // ── equal witnessed times (ordering unprovable) ⇒ DISCOUNTED (§0 no-forgery) ──
    eq(rep.repEvidenceOf(c, elig, viewAt(commendTs)).commendTwRevoked, 1,
      'A4-21 tie-break: revocation wts == commend wts ⇒ discounted (unprovable order fails toward no-forgery)')
    // ── revoked AFTER the commend (honest device rotation) ⇒ COUNTED IN FULL ──
    const evLive = rep.repEvidenceOf(c, elig, viewAt(commendTs + 1))
    eq(evLive.commendTwRevoked, 0, 'A4-21 honest rotation: key revoked AFTER signing ⇒ no discount')
    eq(evLive.commendTwBonus, 19, '…and the est-tier bonus is granted as before')
    eq(rep.repScore(s, evLive), 95, '…full commend credit (score 95): rotation never costs earned goodwill')
    // ── no view / view that cannot vouch ⇒ unchanged pre-closure behavior ──
    const evNoView = rep.repEvidenceOf(c, elig)
    eq(evNoView.commendTwRevoked, 0, 'no revocation view ⇒ nothing is flagged (absence of evidence is not a revocation)')
    eq(evNoView.commendTwBonus, 19, 'no view: est bonus unchanged')
    eq(rep.repEvidenceOf(c, elig, () => undefined).commendTwRevoked, 0,
      'a view with no revocation for the key flags nothing')
    // ── read-time ONLY: fold/checkpoint bytes are byte-identical ──
    eq(stateHash(fold(c)), foldDigestBefore,
      'A4-21 DIGEST PIN: the fold state digest is unchanged. No revocation view ever reaches checkpoint-embedded bytes')
  }
  console.log('\n· rematch + segment rate limits …')
  {
    // claim without an in-chain prior, and the game arriving later changes nothing
    let r1 = addConduct(mkChain(), rematchFrom(oppA, { prior: G1, game: G2 }))
    r1 = addSeg(r1, G2, oppA)
    const sr1 = fold(r1)
    eq(sr1.rematch, 0, 'rematch-accept without an in-chain prior segment is ignored (no pending either)')
    eq(Object.keys(sr1.pend).length, 0, '…and records no pending claim')
    // prior exists but with a DIFFERENT opp
    let r2 = addSeg(mkChain(), G1, oppB)
    r2 = addConduct(r2, rematchFrom(oppA, { prior: G1, game: G2 }))
    eq(fold(r2).rematch, 0, 'rematch-accept whose prior segment names a different opp is ignored')
    // duplicate claims per (prior, opp): the second is dead even before settling
    let r3 = addSeg(mkChain(), G1, oppA)
    r3 = addConduct(r3, rematchFrom(oppA, { prior: G1, game: G2 }))
    r3 = addConduct(r3, rematchFrom(oppA, { prior: G1, game: G3 }))
    r3 = addSeg(r3, G2, oppA)
    r3 = addSeg(r3, G3, oppA)
    eq(fold(r3).rematch, 1, 'second claim naming the same (prior, opp) is ignored (anti-farming)')
    // unilateral (fabricated-countersig) claim: schema-valid, never counts
    let r4 = addSeg(mkChain(), G1, oppA)
    r4 = addConduct(r4, { kind: 'rematch-accept', game: G2, opp: oppA.pubB, prior: G1, key: oppA.pubB, sig: 'A'.repeat(86) })
    r4 = addSeg(r4, G2, oppA)
    eq(fold(r4).rematch, 0, 'fabricated countersignature: the claim never counts, even after the game arrives (A4-13)')
    // the "rematch" cannot be the prior itself
    let r5 = addSeg(mkChain(), G1, oppA)
    r5 = addConduct(r5, rematchFrom(oppA, { prior: G1, game: G1 }))
    eq(fold(r5).rematch, 0, 'claim naming the prior as its own rematch game is ignored')
    // a pending claim that never settles counts nothing
    let r6 = addSeg(mkChain(), G1, oppA)
    r6 = addConduct(r6, rematchFrom(oppA, { prior: G1, game: G2 }))
    eq(fold(r6).rematch, 0, 'unsettled pending claim contributes 0')
    eq(rep.repScore(fold(r6)), 80, '…and never moves the score')
    // conduct events naming self are ignored
    const selfAbort = addConduct(mkChain(), { kind: 'abort', game: G1, opp: meB })
    eq(fold(selfAbort).abort, 0, 'conduct event with opp === root is ignored')
    // duplicate (game, opp) segment: fold counts once; the CHAIN layer kills it
    const dupPayload = segPayload(G1, oppA)
    let d = chain.appendWitnessed(mkChain(), me.priv, meB, 'segment', dupPayload, ts++)
    d = chain.appendWitnessed(d, me.priv, meB, 'segment', dupPayload, ts++)
    eq(fold(d).seg, 1, 'a duplicate (game, opp) segment is counted once (fold-level dedup)')
    hasCode(chain.verifyChain(d), 'dup-game', 'A4-11: verifyChain rejects the repeated game key chain-wide (dup-game)')
  }

  // ============================================================================
  // 7. purity / totality
  // ============================================================================
  console.log('\n· repStep purity + totality …')
  {
    const c = addSeg(mkChain(), G1, oppA)
    const s = fold(c)
    const sBytes = stateHash(s)
    // unknown / irrelevant events pass through as the SAME state object
    const genesis = c.events[0]
    ok(rep.repStep(s, genesis) === s, 'genesis (unknown to the fold) passes through unchanged (same reference)')
    const personal = events.signBody(
      { v: 1, lane: 'p', type: 'profile', root: meB, key: meB, height: 0, ts: 1, payload: { fields: { bio: 'x' } } },
      me.priv,
    )
    ok(rep.repStep(s, personal) === s, 'personal-lane event passes through unchanged')
    // malformed payloads (never appendable, but the fold must be total)
    const mk = (type, payload) => ({
      body: { v: 1, lane: 'w', type, root: meB, key: meB, height: 9, prev: fakeId('p'), ts: 1, payload },
      sig: 'A'.repeat(86),
    })
    ok(rep.repStep(s, mk('segment', { garbage: true })) === s, 'malformed segment payload ignored, no throw')
    ok(rep.repStep(s, mk('conduct', { kind: 'weird', game: G1, opp: oppA.pubB })) === s, 'unknown conduct kind ignored')
    ok(rep.repStep(s, mk('commend', { game: G1 })) === s, 'malformed commend payload ignored')
    ok(rep.repStep(s, mk('commend', null)) === s, 'null commend payload ignored, no throw')
    ok(rep.repStep(s, mk('segment', { ...segPayload(G2, oppA), plies: 1.5 })) === s,
      'float-carrying segment payload ignored, no throw')
    // repStep never mutates its input
    const seg2 = c.events.find((e) => e.body.type === 'segment')
    const s2a = rep.repStep(rep.repInit(), seg2)
    eq(stateHash(s), sBytes, 'input state bytes unchanged after all repStep calls')
    const s2b = rep.repStep(rep.repInit(), seg2)
    eq(stateHash(s2a), stateHash(s2b), 'same (state, event) twice → identical state bytes')
    // integer-counters-only contract: every leaf is a safe integer
    const leavesOk = (v) =>
      typeof v === 'number'
        ? Number.isSafeInteger(v) && v >= 0
        : typeof v === 'object' && v !== null && Object.values(v).every(leavesOk)
    ok(leavesOk(s2a), 'RepState leaves are all non-negative safe integers (no floats, no strings)')
  }

  // ============================================================================
  // 8. determinism, state bytes across rebuild + personal-lane reorder
  // ============================================================================
  console.log('\n· fold determinism …')
  {
    const buildFull = () => {
      let c = mkChain()
      c = chain.appendPersonal(c, me.priv, meB, 'profile', { fields: { bio: 'one' } }, 2000)
      c = addSeg(c, G1, oppA, { est: true, reason: 'checkmate' })
      c = addSeg(c, G2, oppB, { color: 'b', result: '1-0', reason: 'flag' })
      c = chain.appendPersonal(c, me.priv, meB, 'profile', { fields: { country: 'US' } }, 2100)
      c = addCommend(c, commendFrom(oppA, G1))
      c = addConduct(c, rematchFrom(oppA, { prior: G1, game: G3 }))
      c = addSeg(c, G3, oppA)
      return c
    }
    ts = 50_000
    const c1 = buildFull()
    ts = 50_000
    const c2 = buildFull()
    const h1 = stateHash(fold(c1))
    eq(h1, stateHash(fold(c2)), 'building the same chain twice → identical folded state bytes')
    eq(fold(c1).rematch, 1, 'the determinism fixture settles its rematch (pend exercised)')
    // personal-lane order (and any interleave of ignored events) is immaterial:
    // fold over raw storage with personal events reversed + moved to the front
    const w = c1.events.filter((e) => e.body.lane === 'w').sort((a, b) => a.body.height - b.body.height)
    const p = c1.events.filter((e) => e.body.lane === 'p').reverse()
    const reordered = [...p, ...w].reduce((s, e) => rep.repStep(s, e), rep.repInit())
    eq(stateHash(reordered), h1, 'reversed personal-lane order interleaved → identical state bytes')
    const interleaved = [w[0], p[1] ?? w[0], ...w.slice(1), ...p].reduce((s, e) => rep.repStep(s, e), rep.repInit())
    eq(stateHash(interleaved), h1, 'personal events interleaved mid-stream → identical state bytes')
    // and the folded chain verifies (fixtures are real, admissible events)
    eq(chain.verifyChain(c1).ok, true, 'the determinism fixture chain verifies ok end-to-end')
  }

  // ============================================================================
  // 9. windowed compaction (PARAMS_A4.repPairWindow), pair AND pend
  // ============================================================================
  console.log('\n· reference window: boundary cases …')
  const W = a4.PARAMS_A4.repPairWindow
  {
    eq(W, 200, 'PARAMS_A4.repPairWindow is the agreed 200')
    let gen = 0
    const padPins = (c, n) => {
      for (let i = 0; i < n; i++)
        c = chain.appendWitnessed(c, me.priv, meB, 'pin', { record: fakeId(`pin${gen}`), gen: gen++ }, ts++)
      return c
    }
    // segment at height 1; commend at height 1 + W → diff exactly W → valid
    let cEdge = addSeg(mkChain(), G1, oppA) // h1
    cEdge = padPins(cEdge, W - 1) // heads through h200
    const cEdgeOk = addCommend(cEdge, commendFrom(oppA, G1)) // h201, diff 200
    eq(fold(cEdgeOk).commend, 1, 'commend exactly at the window edge (diff = W) counts')
    // one past the edge → ignored
    const cEdgeBad = addCommend(padPins(cEdge, 1), commendFrom(oppA, G1)) // h202, diff 201
    eq(fold(cEdgeBad).commend, 0, 'commend one past the window edge (diff = W+1) is ignored')
    // same boundary for the rematch claim's PRIOR reference
    const rm = rematchFrom(oppA, { prior: G1, game: G2 })
    let cRmEdge = addConduct(cEdge, rm) // h201, prior diff exactly W → pending
    cRmEdge = addSeg(cRmEdge, G2, oppA) // arrival h202, claim diff 1
    eq(fold(cRmEdge).rematch, 1, 'rematch claim exactly at the prior window edge counts (once settled)')
    let cRmPast = addConduct(padPins(cEdge, 1), rm) // h202, prior diff W+1
    cRmPast = addSeg(cRmPast, G2, oppA)
    eq(fold(cRmPast).rematch, 0, 'rematch claim one past the prior window edge is ignored')
    // pending-claim arrival window: settle at exactly claim + W …
    let cPend = addSeg(mkChain(), G1, oppA) // h1
    cPend = addConduct(cPend, rematchFrom(oppA, { prior: G1, game: G3 })) // h2 → pend h2
    const cPendPad = padPins(cPend, W - 1) // heads through h201
    const cPendOk = addSeg(cPendPad, G3, oppA) // h202, claim diff exactly W
    eq(fold(cPendOk).rematch, 1, 'pending claim settles when the game arrives exactly W events later')
    // … but the pend entry is PRUNED one past the window
    const cPendPast = addSeg(padPins(cPendPad, 1), G3, oppA) // h203, diff W+1
    const sPendPast = fold(cPendPast)
    eq(sPendPast.rematch, 0, 'pending claim whose game arrives past the window counts nothing (pruned)')
    ok(!(`${G3}:${oppA.pubB}` in sPendPast.pend), '…and the pend entry is gone (bounded state)')
    console.log('\n· reference window: prune ↔ validity, no gap …')
    // commended in-window, then re-sent after the window: STILL ignored. The
    // rule that expires the memory is the rule that expires validity.
    let cDup = addSeg(mkChain(), G1, oppA) // h1
    cDup = addCommend(cDup, commendFrom(oppA, G1)) // h2: counts
    cDup = padPins(cDup, W) // heads through h202
    const sBeforeMod = fold(cDup)
    ok(`${G1}:${oppA.pubB}` in sBeforeMod.pair, 'pass-through events (pins) do NOT prune, entry still present')
    const pinEv = cDup.events[cDup.events.length - 1]
    ok(rep.repStep(sBeforeMod, pinEv) === sBeforeMod, 'pin event passes through unchanged (same reference, no prune)')
    const cDup2 = addCommend(cDup, commendFrom(oppA, G1)) // h203, diff 202 > W
    eq(fold(cDup2).commend, 1, 're-sent commend after the window is ignored (window rule, entry still in map)')
    // now force a prune (a state-modifying segment), THEN attempt the duplicate:
    // the entry is GONE, and the duplicate is still rejected by the same rule.
    const cPruned = addSeg(cDup, G2, oppB) // h203 → prunes h < 3
    const sPruned = fold(cPruned)
    ok(!(`${G1}:${oppA.pubB}` in sPruned.pair), 'a state-modifying step prunes the out-of-window entry')
    ok(`${G2}:${oppB.pubB}` in sPruned.pair, 'the fresh segment entry is present after the prune')
    eq(sPruned.commend, 1, 'the counted commend survives pruning (counters are permanent; only memory expires)')
    const cPrunedDup = addCommend(cPruned, commendFrom(oppA, G1)) // h204
    eq(fold(cPrunedDup).commend, 1, 'duplicate attempt AFTER pruning is rejected, no gap, no double count')
    eq(rep.repScore(fold(cPrunedDup)), rep.repScore(sPruned), 'the rejected post-prune duplicate never moves the score')
    // determinism with pruning in play: fold the pruned fixture twice
    eq(stateHash(fold(cPruned)), stateHash(fold(cPruned)), 'window fixture folds to identical state bytes twice')
    eq(chain.verifyChain(cPruned).ok, true, 'the window fixture chain verifies ok end-to-end')
  }
  console.log('\n· reference window: bounded state …')
  {
    // 300 REAL crafted segment events (valid event + wstream signatures; the
    // A4-07 gate verifies them): the pair map must stay O(window).
    let s = rep.repInit()
    for (let i = 1; i <= 300; i++) {
      const g = fakeId(`bulk${i}`)
      s = rep.repStep(
        s,
        events.signBody(
          {
            v: 1, lane: 'w', type: 'segment', root: meB, key: meB,
            height: i, prev: fakeId('prev'), ts: i,
            payload: segPayload(g, oppA),
          },
          me.priv,
        ),
      )
    }
    eq(s.seg, 300, '300 verified segments all counted')
    eq(Object.keys(s.pair).length, W + 1, `pair map holds exactly W+1 = ${W + 1} entries after 300 games`)
    ok(Object.keys(s.pair).length <= W + 1, 'pair map is window-bounded (≤ W+1), not O(games)')
    eq(rep.repScore(s), 80, '300 clean completed games still score the neutral 80 (no merit earned)')
  }

  // ============================================================================
  // 9b. A5 J5 (A4-12): pairing records + the self-executing obligation
  // ============================================================================
  console.log('\n· J5 makePairingPayload builder …')
  const pairingFrom = (oppKp, game) =>
    conduct.makePairingPayload({ game, opp: oppKp.pubB, kind: 'chess', tc: BLITZ_TC, atWts: 5000 })
  const addPairing = (c, game, oppKp) =>
    chain.appendWitnessed(c, me.priv, meB, 'pairing', pairingFrom(oppKp, game), ts++)
  {
    const p = pairingFrom(oppA, G1)
    ok(events.zPairingPayload.safeParse(p).success, 'built pairing satisfies the lead-authored zPairingPayload')
    eq(p.kind, 'chess', 'pairing carries the ladder kind')
    eq(`${p.tc.baseMs},${p.tc.incMs}`, '300000,0', 'pairing carries the ladder tc')
    throws(() => conduct.makePairingPayload({ game: 'not-an-id', opp: oppA.pubB, kind: 'chess', tc: BLITZ_TC, atWts: 1 }),
      'malformed game key throws')
    throws(() => conduct.makePairingPayload({ game: G1, opp: oppA.pubB, kind: '', tc: BLITZ_TC, atWts: 1 }),
      'empty kind throws')
    throws(() => conduct.makePairingPayload({ game: G1, opp: oppA.pubB, kind: 'chess', tc: { baseMs: 0.5, incMs: 0 }, atWts: 1 }),
      'float tc throws')
    throws(() => conduct.makePairingPayload({ game: G1, opp: oppA.pubB, kind: 'chess', tc: BLITZ_TC, atWts: -1 }),
      'negative atWts throws')
  }
  console.log('\n· J5 obligation: opened / settled by segment / abort / noshow, all neutral …')
  {
    // Opened: the pairing itself moves nothing.
    const cOpen = addPairing(mkChain(), G1, oppA)
    const sOpen = fold(cOpen)
    eq(sOpen.ob[`${G1}:${oppA.pubB}`], 1, 'a pairing opens an obligation at its witnessed height')
    eq(sOpen.unsettled, 0, 'opening an obligation is not misconduct')
    eq(rep.repScore(sOpen), 80, 'a lone open pairing keeps the neutral 80')
    // Settled by a BOUND segment (any result; here a loss).
    const cSeg = addSeg(cOpen, G1, oppA, { color: 'w', result: '0-1', reason: 'resign' })
    const sSeg = fold(cSeg)
    eq(sSeg.unsettled, 0, 'the bound segment for (game, opp) settles the obligation (any result)')
    eq(Object.keys(sSeg.ob).length, 0, 'settling empties the obligation map')
    eq(rep.repScore(sSeg), 80, 'a settled pairing is NEUTRAL (no bonus, no penalty, resign loss aside)')
    // Settled by an abort conduct event for the same (game, opp).
    const cAb = addConduct(addPairing(mkChain(), G1, oppA), conduct.makeConductPayload({ kind: 'abort', game: G1, opp: oppA.pubB }))
    const sAb = fold(cAb)
    eq(sAb.unsettled, 0, 'an abort conduct event for (game, opp) settles the obligation')
    eq(sAb.abort, 1, '…and the abort itself still counts once (its own axis)')
    eq(rep.repScore(sAb), 45, 'pairing + abort scores exactly the abort-only 45 (settlement adds nothing)')
    // Settled by a noshow conduct event.
    const cNs = addConduct(addPairing(mkChain(), G1, oppA), conduct.makeConductPayload({ kind: 'noshow', game: G1, opp: oppA.pubB }))
    const sNs = fold(cNs)
    eq(sNs.unsettled, 0, 'a noshow conduct event for (game, opp) settles the obligation')
    eq(rep.repScore(sNs), 70, 'pairing + noshow scores exactly the noshow-only 70')
  }
  console.log('\n· J5 obligation: left unsettled ⇒ abandonment-class misconduct, exactly once …')
  {
    // The next counted event (a NEW pairing) is the §8 deadline.
    const c2 = addPairing(addPairing(mkChain(), G1, oppA), G2, oppA)
    const s2 = fold(c2)
    eq(s2.unsettled, 1, 'pairing a NEW game without settling the last condemns it (next-event deadline)')
    eq(Object.keys(s2.ob).length, 1, 'the condemned entry left the map; only the new obligation is open')
    eq(s2.ob[`${G2}:${oppA.pubB}`], 2, '…the new obligation, at its own height')
    eq(rep.repScore(s2), 70, 'one unsettled obligation scores EXACTLY like one recorded noshow (mapped weight)')
    eq(rep.repScore(s2), rep.repScore(fold(addConduct(mkChain(), conduct.makeConductPayload({ kind: 'noshow', game: G1, opp: oppA.pubB })))),
      'unsettled ≡ noshow in the score (the do-not-invent-weights mapping)')
    // Exactly once: settling the SECOND obligation does not recount the first.
    const c3 = addSeg(c2, G2, oppA)
    const s3 = fold(c3)
    eq(s3.unsettled, 1, 'settling the later obligation never recounts the condemned one')
    // Mapped-weight math on a mixed chain: seg=1, unsettled=1 →
    // D = 1+0+0+1 = 2, noshowSub = floor(100·(2−0−1)/2) = 50;
    // completion/disconnect/toResign 100 → 35+25+10+5+0+0 = 75.
    eq(rep.repScore(s3), 75, 'mixed chain scores floor(35+25+10+ 0.10·50) = 75 exactly (mapped weights)')
    // A segment for a DIFFERENT game condemns too.
    const cSegOther = addSeg(addPairing(mkChain(), G1, oppA), G2, oppA)
    eq(fold(cSegOther).unsettled, 1, 'a counted segment for a DIFFERENT game condemns the open obligation')
    eq(fold(cSegOther).seg, 1, '…while counting normally itself')
    // A counted commend condemns too.
    let cCm = addSeg(mkChain(), G1, oppA) // h1: bound segment (commend target)
    cCm = addPairing(cCm, G2, oppA) // h2: open obligation
    cCm = addCommend(cCm, commendFrom(oppA, G1)) // h3: counted commend
    eq(fold(cCm).unsettled, 1, 'a counted commend is a next-event deadline (condemns the open obligation)')
    eq(fold(cCm).commend, 1, '…and still counts itself')
    // A LEGACY segment for the SAME (game, opp) settles NOTHING (unbound opp).
    const cLeg = addSeg(addPairing(mkChain(), G1, oppA), G1, oppA, { legacy: true })
    const sLeg = fold(cLeg)
    eq(sLeg.unsettled, 1, 'a LEGACY segment cannot settle the obligation (opp unbound): it condemns instead')
    eq(sLeg.seg, 1, '…while still counting toward seg (the game happened)')
    // 300 back-to-back pairings: map stays O(1), every predecessor condemned.
    let sMany = rep.repInit()
    for (let i = 1; i <= 300; i++) {
      sMany = rep.repStep(sMany, events.signBody({
        v: 1, lane: 'w', type: 'pairing', root: meB, key: meB, height: i, prev: fakeId('prev'), ts: i,
        payload: pairingFrom(oppA, fakeId(`ob${i}`)),
      }, me.priv))
    }
    eq(sMany.unsettled, 299, '300 chained pairings condemn 299 predecessors (each at its next event)')
    eq(Object.keys(sMany.ob).length, 1, 'the obligation map holds exactly ONE entry (O(1) ⊂ O(window))')
  }
  console.log('\n· J5 obligation: ignored events never condemn (exact pass-through preserved) …')
  {
    let gen2 = 0
    const padPins2 = (c, n) => {
      for (let i = 0; i < n; i++)
        c = chain.appendWitnessed(c, me.priv, meB, 'pin', { record: fakeId(`jpin${gen2}`), gen: gen2++ }, ts++)
      return c
    }
    const cOpen = addPairing(mkChain(), G1, oppA)
    const cPinned = padPins2(cOpen, 5)
    const sPinned = fold(cPinned)
    eq(sPinned.unsettled, 0, 'pin events after an open obligation do NOT condemn it (fold-level deadline, header)')
    eq(sPinned.ob[`${G1}:${oppA.pubB}`], 1, '…the obligation stays open across ignored events')
    const pinEv = cPinned.events[cPinned.events.length - 1]
    ok(rep.repStep(sPinned, pinEv) === sPinned, 'a pin passes through an obligation-carrying state unchanged (same reference)')
    // …and the ride-through obligation is STILL settleable in-window.
    eq(fold(addSeg(cPinned, G1, oppA)).unsettled, 0, 'the obligation settles after riding through ignored events')
    // Window edge: settle at EXACTLY diff = W …
    const cEdge = addSeg(padPins2(cOpen, W - 1), G1, oppA) // pairing h1, segment h201: diff exactly W
    const sEdge = fold(cEdge)
    eq(sEdge.unsettled, 0, 'settlement at exactly the window edge (diff = W) settles')
    eq(Object.keys(sEdge.ob).length, 0, '…and resolves the entry')
    // … but one past the edge the would-be settler CONDEMNS instead.
    const cPast = addSeg(padPins2(cOpen, W), G1, oppA) // segment h202: diff W+1
    const sPast = fold(cPast)
    eq(sPast.unsettled, 1, 'the same segment one past the window CONDEMNS (settlement validity expired with the window)')
    eq(sPast.seg, 1, '…while still counting as a segment')
    eq(Object.keys(sPast.ob).length, 0, '…and the entry is resolved (bounded state)')
    // Prune-then-no-double-count: a late abort settles nothing and recounts nothing.
    const cLate = addConduct(cPast, conduct.makeConductPayload({ kind: 'abort', game: G1, opp: oppA.pubB }))
    const sLate = fold(cLate)
    eq(sLate.unsettled, 1, 'a late abort after condemnation never double-counts the obligation')
    eq(sLate.abort, 1, '…and counts only as its own (self-recorded) abort')
  }
  console.log('\n· J5 obligation: dedup + ignore rules …')
  {
    // Duplicate pairing for the same (game, opp) in-window: second ignored.
    const cDup = addPairing(addPairing(mkChain(), G1, oppA), G1, oppA)
    const sDup = fold(cDup)
    eq(sDup.unsettled, 0, 'a duplicate in-window pairing is ignored (does not condemn its twin)')
    eq(Object.keys(sDup.ob).length, 1, '…one obligation, not two')
    const sDupObj = fold(addPairing(mkChain(), G1, oppA))
    const dupEv = cDup.events[cDup.events.length - 1]
    ok(rep.repStep(sDupObj, dupEv) === sDupObj, 'the duplicate pairing passes through unchanged (same reference)')
    eq(fold(addSeg(cDup, G1, oppA)).unsettled, 0, 'the deduped obligation settles once, cleanly')
    // Pairing whose (game, opp) already has an in-window BOUND segment: ignored.
    const cPost = addPairing(addSeg(mkChain(), G1, oppA), G1, oppA)
    const sPost = fold(cPost)
    eq(Object.keys(sPost.ob).length, 0, 'a pairing for an already-played (bound, in-window) game opens nothing')
    eq(fold(addSeg(cPost, G2, oppA)).unsettled, 0, '…and can never be condemned later')
    // opp === root: ignored.
    const selfP = { game: G1, opp: meB, kind: 'chess', tc: BLITZ_TC, atWts: 5000 }
    const cSelf = chain.appendWitnessed(mkChain(), me.priv, meB, 'pairing', selfP, ts++)
    const sSelf = fold(cSelf)
    eq(Object.keys(sSelf.ob).length, 0, 'a pairing with opp === root is ignored')
    // Malformed: ignored, no throw (crafted; never appendable).
    const sNeutral = fold(mkChain())
    const mkBad = (payload) => ({
      body: { v: 1, lane: 'w', type: 'pairing', root: meB, key: meB, height: 9, prev: fakeId('p'), ts: 1, payload },
      sig: 'A'.repeat(86),
    })
    ok(rep.repStep(sNeutral, mkBad({ garbage: true })) === sNeutral, 'malformed pairing payload ignored, no throw')
    ok(rep.repStep(sNeutral, mkBad(null)) === sNeutral, 'null pairing payload ignored, no throw')
    ok(rep.repStep(sNeutral, mkBad({ game: G1, opp: oppA.pubB, kind: 'chess', tc: { baseMs: 0.5, incMs: 0 }, atWts: 1 })) === sNeutral,
      'float-carrying pairing payload ignored, no throw')
  }
  console.log('\n· J5 obligation: determinism + chain validity …')
  {
    const buildJ5 = () => {
      let c = mkChain()
      c = addPairing(c, G1, oppA) // settled by the segment
      c = addSeg(c, G1, oppA)
      c = addPairing(c, G2, oppB) // condemned by the next pairing
      c = addPairing(c, G3, oppA) // settled by an abort
      c = addConduct(c, conduct.makeConductPayload({ kind: 'abort', game: G3, opp: oppA.pubB }))
      c = addPairing(c, G4, oppA) // left open at head
      return c
    }
    ts = 90_000
    const cA = buildJ5()
    ts = 90_000
    const cB = buildJ5()
    const sA = fold(cA)
    eq(stateHash(sA), stateHash(fold(cB)), 'building the same pairing chain twice → identical folded state bytes')
    eq(stateHash(fold(cA)), stateHash(fold(cA)), 'folding the same chain twice → identical state bytes')
    eq(sA.unsettled, 1, 'the J5 determinism fixture condemns exactly one obligation')
    eq(Object.keys(sA.ob).length, 1, 'the head obligation is still open (no clock: the fold cannot condemn the future)')
    eq(chain.verifyChain(cA).ok, true, 'the pairing-bearing chain verifies ok end-to-end (real crypto)')
    // score: seg=1, abort=1, unsettled=1 → C=floor(100/2)=50, D=100, T=100,
    // Dn = 1+1+0+1 = 3 → N = floor(100·(3−0−1)/3) = 66 → 17.5+25+10+6.6 = 59
    eq(rep.repScore(sA), 59, 'J5 fixture scores floor(17.5+25+10+6.6) = 59 exactly against the mapped weights')
  }

  // ============================================================================
  // 10. tier boundaries
  // ============================================================================
  console.log('\n· tier boundaries …')
  {
    eq(rep.repTier(0), 0, 'tier(0) = 0')
    eq(rep.repTier(39), 0, 'tier(39) = 0')
    eq(rep.repTier(40), 1, 'tier(40) = 1 (repTier1Min)')
    eq(rep.repTier(69), 1, 'tier(69) = 1')
    eq(rep.repTier(70), 2, 'tier(70) = 2 (repTier2Min)')
    eq(rep.repTier(89), 2, 'tier(89) = 2')
    eq(rep.repTier(90), 3, 'tier(90) = 3 (repTier3Min)')
    eq(rep.repTier(100), 3, 'tier(100) = 3')
    // weight sanity: PARAMS_A4 rep weights sum to exactly one (micro-units)
    const P = a4.PARAMS_A4
    eq(P.repWCompletionMicro + P.repWDisconnectMicro + P.repWTimeoutResignMicro +
       P.repWRematchMicro + P.repWNoshowMicro + P.repWCommendMicro, 1_000_000,
      'PARAMS_A4 reputation weights sum to exactly 1e6 (score range is [0,100])')
    // commend weight constants (A4-14)
    eq(rep.REP_COMMEND_FULL_TW, 20, 'full commend weight is 20 twentieths')
    eq(rep.REP_COMMEND_FLOOR_TW, 1, 'floor commend weight is 1 twentieth (1/20 of established)')
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
