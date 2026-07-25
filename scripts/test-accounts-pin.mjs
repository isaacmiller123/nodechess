// Headless test for the A2 tOPRF PIN committee
// (src/shared/accounts/witness/{shamir,oprf,pin}.ts, spec §1).
//
//   node scripts/test-accounts-pin.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-chain.mjs), imports them from a temp
// dir, and drives every rule in the PIN scope:
//   · single-key OPRF output  ≡  threshold (share-split) OPRF output
//   · Shamir t-of-n recovery, (t-1) fails, Feldman commitments, wrong-share
//   · DLEQ partial verification + wrong-partial detection
//   · attempt counter never resets; effectiveCount resists a lowballing minority
//   · fuse trips at exactly 100, threshold-signed, verifies, expiry + refill R
//   · committee handoff carries the counter forward, rejects a reset-to-zero
//   · PIN session verify + wrong-pin / wrong-key rejection
//
// Randomness that is intrinsic (Shamir coeffs, OPRF blinds, DLEQ nonces) is fed
// a SEEDED rng so the run is reproducible; a couple of fixed-rng golden OPRF
// outputs anchor byte-determinism across node and the browser bundle.
//
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const nodeSha256 = (buf) => createHash('sha256').update(buf).digest()

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

// ---- golden vectors (recorded from a green run; determinism anchors) ---------
// Fixed-seed OPRF output + derived pinPub for pin '4271' under the deal below.
// Any drift in ristretto255_oprf, the finalize wiring, or the HMAC stretch
// breaks these on every platform at once.
const GOLDEN_OPRF_OUTPUT =
  'd4873eece4e57e9a5824e0591eeb1cde6117d40155afafcd6f5adbaf9a9378ac5a32443bcd14c4d135dffef0a3eb85d4c129c6ca8a4b6e7b76c55d3fe07e726d'
const GOLDEN_PIN_PUB = 'zH6Jr75wUt66XXIcyyMknmLkninSQr7rvoPZ30xQ8Hw'

const hex = (u8) => Buffer.from(u8).toString('hex')

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-pin-test')
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
  console.log('· bundling src/shared/accounts/witness (shamir/oprf/pin) …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as wparams from '${SRC}/witness/params.ts'`,
      `export * as shamir from '${SRC}/witness/shamir.ts'`,
      `export * as oprf from '${SRC}/witness/oprf.ts'`,
      `export * as pin from '${SRC}/witness/pin.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, 'pin.mjs')
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
  const { hash, codec, wparams, shamir, oprf, pin } = M
  const P = wparams.PARAMS_A2

  // ---- seeded rng: sha256(seed || counter) stream -----------------------------
  function seededRng(seedStr) {
    let ctr = 0
    const seed = hash.utf8(seedStr)
    let buf = new Uint8Array(0)
    const refill = () => {
      const c = new Uint8Array(4)
      new DataView(c.buffer).setUint32(0, ctr++, false)
      const chunk = nodeSha256(Buffer.concat([Buffer.from(seed), Buffer.from(c)]))
      buf = new Uint8Array([...buf, ...chunk])
    }
    return (n) => {
      while (buf.length < n) refill()
      const out = buf.slice(0, n)
      buf = buf.slice(n)
      return out
    }
  }

  // ---- member keys ------------------------------------------------------------
  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const N = P.pinN // 9
  const T = P.pinT // 6
  const members = Array.from({ length: N }, (_, i) => {
    const k = kp(10 + i * 7)
    // nodeId = sha256(memberRootPub): here we use the signing pub as the identity seed
    const nodeId = hash.toB64u(hash.sha256(k.pub))
    return { i: i + 1, key: k, nodeId }
  })
  const committee = members.map((m) => m.nodeId)
  // nodeId → advertised signing key binding (required by verifyFuseRecord/verifyHandoff).
  const keyOf = new Map(members.map((m) => [m.nodeId, m.key.pubB]))
  const root = kp(1)

  // ============================================================================
  // 1. Shamir over the ristretto255 scalar field
  // ============================================================================
  console.log('\n· Shamir T-of-N over the scalar field …')
  {
    const rng = seededRng('shamir-1')
    const secret = shamir.randScalar(rng)
    const deal = shamir.dealScalar(secret, T, N, rng)
    eq(deal.shares.length, N, `dealt ${N} shares`)

    // any T shares recover the secret
    const shuffled = [...deal.shares].sort(() => 0) // stable; pick arbitrary T subsets below
    const subsetA = [deal.shares[0], deal.shares[2], deal.shares[4], deal.shares[6], deal.shares[8], deal.shares[1]]
    const subsetB = [deal.shares[3], deal.shares[5], deal.shares[7], deal.shares[8], deal.shares[0], deal.shares[4]]
    eq(shamir.recoverScalar(subsetA, T), secret, 'any T shares recover the secret (subset A)')
    eq(shamir.recoverScalar(subsetB, T), secret, 'any T shares recover the secret (subset B)')
    ok(shamir.recoverScalar(shuffled.slice(0, T), T) === secret, 'first T shares recover the secret')

    // T-1 shares recover a DIFFERENT value (no error: the field gives garbage)
    const tMinus1 = deal.shares.slice(0, T - 1)
    throws(() => shamir.recoverScalar(tMinus1, T), 'recoverScalar throws when given < T shares')
    // interpolate the T-1 set as if it were a (T-1)-of-* poly → different secret
    const rec1 = shamir.recoverScalar(tMinus1, T - 1)
    ok(rec1 !== secret, 'T-1 shares interpolate to a DIFFERENT secret (not recoverable)')

    // Feldman commitments verify every share; a tampered share is rejected
    ok(deal.shares.every((s) => shamir.verifyShare(s.i, s.share, deal.commitments)), 'Feldman commitments verify all shares')
    ok(!shamir.verifyShare(deal.shares[0].i, shamir.modL(deal.shares[0].share + 1n), deal.commitments), 'tampered share fails Feldman verify')
    ok(!shamir.verifyShare(deal.shares[3].i, deal.shares[4].share, deal.commitments), 'a swapped share fails Feldman verify')

    // per-share commitment == share·G
    const sc = shamir.shareCommitment(deal.shares[0].share)
    ok(shamir.pointToBytes(sc).length === 32, 'shareCommitment serializes to 32 bytes')
    // a zero coefficient/share commits to the identity (multiply(0) would throw)
    let zeroOk = true
    try {
      const cz = shamir.commitments([0n, 1n])
      zeroOk = cz[0].equals(shamir.ZERO) && cz[1].equals(shamir.G)
    } catch {
      zeroOk = false
    }
    ok(zeroOk, 'commitments handle a zero coefficient (identity, no throw)')
    ok(shamir.shareCommitment(0n).equals(shamir.ZERO), 'shareCommitment(0) is the identity element')
  }

  // ============================================================================
  // 2. single-key OPRF output  ≡  threshold (share-split) OPRF output
  //    THE correctness test: multiple pins × committees.
  // ============================================================================
  console.log('\n· single-key OPRF  ≡  threshold OPRF (the key invariant) …')
  function thresholdRound(pinStr, secret, deal, respondingIdx, rngSeed) {
    const rng = seededRng(rngSeed)
    const bl = oprf.clientBlind(pinStr, rng)
    // each responding member evaluates under its share
    const partials = respondingIdx.map((idx) => {
      const share = deal.shares[idx - 1]
      return { i: share.i, partial: oprf.memberBlindEvaluate(share.share, bl.blinded) }
    })
    const combined = oprf.combinePartials(partials, T)
    const single = oprf.singleKeyBlindEvaluate(secret, bl.blinded)
    const outThresh = oprf.clientFinalize(pinStr, bl.blindState, combined)
    const outSingle = oprf.clientFinalize(pinStr, bl.blindState, single)
    return { combined, single, outThresh, outSingle, bl }
  }
  {
    for (const [pinStr, seed] of [['4271', 'c1'], ['0000', 'c2'], ['99887766', 'c3']]) {
      const rng = seededRng('deal-' + seed)
      const secret = shamir.randScalar(rng)
      const deal = shamir.dealScalar(secret, T, N, rng)
      const idxA = [1, 2, 3, 4, 5, 6]
      const idxB = [4, 5, 6, 7, 8, 9]
      const rA = thresholdRound(pinStr, secret, deal, idxA, 'blind-' + seed)
      ok(rA.combined === rA.single, `pin ${pinStr}: combined group element == single-key blindEvaluate (members ${idxA})`)
      ok(hex(rA.outThresh) === hex(rA.outSingle), `pin ${pinStr}: threshold finalize output == single-key output`)
      eq(rA.outThresh.length, oprf.OPRF_OUTPUT_BYTES, `pin ${pinStr}: OPRF output is ${oprf.OPRF_OUTPUT_BYTES} bytes`)
      // a DIFFERENT responding quorum yields the SAME output
      const rB = thresholdRound(pinStr, secret, deal, idxB, 'blind-' + seed)
      ok(hex(rB.outThresh) === hex(rA.outSingle), `pin ${pinStr}: a different quorum (${idxB}) yields the identical output`)
      // wrong PIN → different output
      const rWrong = thresholdRound(pinStr === '4271' ? '4272' : '4271', secret, deal, idxA, 'blind-' + seed)
      ok(hex(rWrong.outThresh) !== hex(rA.outThresh), `pin ${pinStr}: a wrong PIN yields a different output`)
    }
  }

  // ============================================================================
  // 3. pinKey stretch determinism + golden
  // ============================================================================
  console.log('\n· pinKey stretch (OPRF output → ed25519) …')
  let goldenOut, goldenPub
  {
    const rng = seededRng('deal-golden')
    const secret = shamir.randScalar(rng)
    const deal = shamir.dealScalar(secret, T, N, rng)
    const r = thresholdRound('4271', secret, deal, [1, 2, 3, 4, 5, 6], 'blind-golden')
    goldenOut = hex(r.outThresh)
    const pk = oprf.pinKeyFromOutput(r.outThresh)
    goldenPub = hash.toB64u(pk.pub)
    // deterministic: same output → same keypair
    const pk2 = oprf.pinKeyFromOutput(r.outThresh)
    ok(hash.toB64u(pk2.priv) === hash.toB64u(pk.priv), 'pinKeyFromOutput is deterministic (priv)')
    ok(hash.toB64u(pk2.pub) === goldenPub, 'pinKeyFromOutput is deterministic (pub)')
    // the keypair is a valid ed25519 pair
    ok(hash.toB64u(hash.ed25519.getPublicKey(pk.priv)) === goldenPub, 'derived pinKey priv→pub is a consistent ed25519 pair')
    throws(() => oprf.pinKeyFromOutput(r.outThresh.slice(0, 32)), 'pinKeyFromOutput rejects a non-64-byte output')
    console.log(`    [golden] OPRF output  = ${goldenOut}`)
    console.log(`    [golden] pinPub       = ${goldenPub}`)
    if (GOLDEN_PIN_PUB !== 'PLACEHOLDER') {
      eq(goldenOut, GOLDEN_OPRF_OUTPUT, 'fixed-seed OPRF output matches the recorded golden')
      eq(goldenPub, GOLDEN_PIN_PUB, 'fixed-seed pinPub matches the recorded golden')
    }
  }

  // ============================================================================
  // 4. DLEQ. A member returning a wrong partial is detectable
  // ============================================================================
  console.log('\n· DLEQ partial-evaluation proofs …')
  {
    const rng = seededRng('dleq-deal')
    const secret = shamir.randScalar(rng)
    const deal = shamir.dealScalar(secret, T, N, rng)
    const bl = oprf.clientBlind('1234', seededRng('dleq-blind'))
    const share = deal.shares[2]
    const commitment = hash.toB64u(shamir.pointToBytes(shamir.shareCommitment(share.share)))
    const partial = oprf.memberBlindEvaluate(share.share, bl.blinded)
    const proof = oprf.dleqProve(share.share, bl.blinded, partial, commitment, seededRng('dleq-nonce'))
    ok(oprf.dleqVerify(bl.blinded, partial, commitment, proof), 'honest partial + DLEQ proof verifies against the shareCommitment')
    // a member that lies about its partial (uses a different share) is caught
    const wrongPartial = oprf.memberBlindEvaluate(deal.shares[4].share, bl.blinded)
    ok(!oprf.dleqVerify(bl.blinded, wrongPartial, commitment, proof), 'a partial from a DIFFERENT share fails DLEQ against the commitment')
    // a forged proof for the wrong partial also fails (prover can\'t bind wrong share to commitment)
    const forged = oprf.dleqProve(deal.shares[4].share, bl.blinded, wrongPartial, commitment, seededRng('dleq-forge'))
    ok(!oprf.dleqVerify(bl.blinded, wrongPartial, commitment, forged), 'a proof for a wrong partial cannot satisfy the real commitment')

    // deterministic prover (RNG-free, what committee members use): verifies, is
    // reproducible, and its nonce is transcript-bound (a different blinded ⇒ a
    // different proof: no nonce reuse across evaluations).
    const detA = oprf.dleqProveDeterministic(share.share, bl.blinded, partial, commitment)
    ok(oprf.dleqVerify(bl.blinded, partial, commitment, detA), 'deterministic DLEQ proof verifies against the shareCommitment')
    const detB = oprf.dleqProveDeterministic(share.share, bl.blinded, partial, commitment)
    ok(detA.c === detB.c && detA.z === detB.z, 'deterministic DLEQ proof is reproducible (same share+transcript → same proof)')
    const bl2 = oprf.clientBlind('1234', seededRng('dleq-blind-2'))
    const partial2 = oprf.memberBlindEvaluate(share.share, bl2.blinded)
    const detC = oprf.dleqProveDeterministic(share.share, bl2.blinded, partial2, commitment)
    ok(detC.z !== detA.z, 'a different blinded element yields a different deterministic nonce (no reuse)')
    ok(oprf.dleqVerify(bl2.blinded, partial2, commitment, detC), 'the deterministic proof for the second blinded verifies too')
    // deterministic prover still cannot bind a wrong share to the commitment
    const detWrong = oprf.dleqProveDeterministic(deal.shares[4].share, bl.blinded, wrongPartial, commitment)
    ok(!oprf.dleqVerify(bl.blinded, wrongPartial, commitment, detWrong), 'a deterministic proof for a wrong partial cannot satisfy the real commitment')
  }

  // ============================================================================
  // 5. PIN record. Build + standalone verify
  // ============================================================================
  console.log('\n· PIN record (root-signed standalone) …')
  let pinRec, pinPub, pinPriv
  {
    const rng = seededRng('rec-deal')
    const secret = shamir.randScalar(rng)
    const deal = shamir.dealScalar(secret, T, N, rng)
    const r = thresholdRound('4271', secret, deal, [1, 2, 3, 4, 5, 6], 'rec-blind')
    const pk = oprf.pinKeyFromOutput(r.outThresh)
    pinPub = hash.toB64u(pk.pub)
    pinPriv = pk.priv
    const shareCommitments = deal.shares.map((s) => hash.toB64u(shamir.pointToBytes(shamir.shareCommitment(s.share))))
    const payload = pin.makePinRecordPayload({ committee, t: T, shareCommitments, pinPub })
    pinRec = pin.buildPinRecord(payload, root.priv, root.pubB)
    const vr = pin.verifyPinRecord(pinRec)
    ok(vr.ok, 'PIN record verifies (root sig + params + committee shape)')
    eq(payload.params, wparams.PARAMS_A2_DIGEST, 'PIN record embeds PARAMS_A2_DIGEST')
    // tamper: flip the pinPub → bad signature
    const bad = { ...pinRec, payload: { ...pinRec.payload, pinPub: committee[0] } }
    ok(!pin.verifyPinRecord(bad).ok, 'a tampered PIN record fails verification')
    // wrong committee size rejected at build time
    throws(() => pin.makePinRecordPayload({ committee: committee.slice(0, 5), t: T, shareCommitments: shareCommitments.slice(0, 5), pinPub }), 'makePinRecordPayload rejects a wrong-size committee')
    throws(() => pin.buildPinRecord(payload, members[0].key.priv, root.pubB), 'buildPinRecord rejects a non-root signer')
  }

  // ============================================================================
  // 6. Attempt counter. Never resets; effectiveCount resists a lowballing minority
  // ============================================================================
  console.log('\n· attempt counter + effectiveCount …')
  {
    let s = pin.newCounter()
    for (let i = 0; i < 100; i++) s = pin.applyEval(s)
    eq(pin.memberFails(s), 100, '100 evaluations, 0 successes → 100 fails')
    s = pin.applySuccess(s)
    eq(pin.memberFails(s), 99, 'a proven success reduces the count by 1 (net)')
    // more evals keep raising evaluations: the counter never resets
    for (let i = 0; i < 30; i++) s = pin.applyEval(s)
    eq(s.evaluations, 130, 'evaluations only ever grow (never reset)')
    eq(pin.memberFails(s), 129, 'fails = evaluations − successes tracks lifetime')
    ok(pin.applySuccess({ evaluations: 3, successes: 3 }).successes === 3, 'successes can never exceed evaluations')

    // effectiveCount = t-th largest; a minority cannot low-ball OR inflate
    const mkReport = (m, fails) => pin.signAttemptReport({ evaluations: fails, successes: 0 }, root.pubB, m.nodeId, m.key.pubB, m.key.priv, 5000)
    // honest 6 report 100, malicious 3 lowball to 0
    const lowball = members.map((m, i) => mkReport(m, i < 3 ? 0 : 100))
    ok(lowball.every((r, i) => pin.verifyAttemptReport(r, members[i].key.pubB)), 'all attempt reports verify against member keys')
    eq(pin.effectiveCount(lowball, T), 100, 'effectiveCount ignores a lowballing minority (t-th largest = 100)')
    // malicious 3 inflate to 999
    const inflate = members.map((m, i) => mkReport(m, i < 3 ? 999 : 100))
    eq(pin.effectiveCount(inflate, T), 100, 'effectiveCount ignores an inflating minority (t-th largest = 100)')
    // fewer than T reports → 0 (nothing t members agree on)
    eq(pin.effectiveCount(lowball.slice(0, T - 1), T), 0, 'fewer than T reports establish no effective count')
    // wrong-key verification fails
    ok(!pin.verifyAttemptReport(lowball[5], members[4].key.pubB), 'an attempt report fails verification under the wrong member key')
  }

  // ============================================================================
  // 7. Fuse. Trips at exactly 100, threshold-signed, verifies, expiry + refill
  // ============================================================================
  console.log('\n· fuse (trip / sign / verify / expiry / refill) …')
  let fuse
  {
    eq(pin.fuseThreshold(0), 100, 'first-cycle fuse threshold = pinLifetimeFails (100)')
    ok(!pin.shouldTrip(99, 0, false), 'fuse does NOT trip at 99')
    ok(pin.shouldTrip(100, 0, false), 'fuse trips at exactly 100')
    ok(!pin.shouldTrip(100, 0, true), 'fuse does not re-trip within a tripped cycle')
    eq(pin.fuseThreshold(1), 120, 'after 1 trip the threshold refills by R to 120')
    ok(!pin.shouldTrip(119, 1, false), 'second cycle does NOT trip at 119')
    ok(pin.shouldTrip(120, 1, false), 'second cycle trips at 120 (100 + R)')

    const trippedWts = 1_700_000_000_000
    const body = pin.fuseRecordBody(root.pubB, 100, trippedWts, pin.pinRecordId(pinRec.payload))
    eq(body.expiryWts, trippedWts + P.pinBanDays * 86_400_000, 'expiryWts = trippedWts + pinBanDays·86,400,000 ms')
    // T members sign the fuse
    const sigs = members.slice(0, T).map((m) => pin.signFuse(body, m.nodeId, m.key.pubB, m.key.priv))
    fuse = pin.makeFuseRecord(root.pubB, 100, trippedWts, pin.pinRecordId(pinRec.payload), sigs)
    const vr = pin.verifyFuseRecord(fuse, committee, keyOf)
    ok(vr.ok, 'fuse record verifies (≥ pinT valid committee signatures)')
    // only T-1 sigs → fails threshold
    const short = pin.makeFuseRecord(root.pubB, 100, trippedWts, pin.pinRecordId(pinRec.payload), sigs.slice(0, T - 1))
    ok(!pin.verifyFuseRecord(short, committee, keyOf).ok, 'fuse with < pinT signatures fails verification')
    // an outsider signature is not counted
    const outsider = kp(240)
    const outNode = hash.toB64u(hash.sha256(outsider.pub))
    const withOutsider = pin.makeFuseRecord(root.pubB, 100, trippedWts, pin.pinRecordId(pinRec.payload), [
      ...sigs.slice(0, T - 1),
      pin.signFuse(body, outNode, outsider.pubB, outsider.priv),
    ])
    ok(!pin.verifyFuseRecord(withOutsider, committee, keyOf).ok, 'a non-committee signer does not count toward the threshold')
    // tampered expiry rejected
    const tampered = { body: { ...fuse.body, expiryWts: fuse.body.expiryWts + 1_000_000 }, sigs: fuse.sigs }
    ok(!pin.verifyFuseRecord(tampered, committee, keyOf).ok, 'a fuse with a shaved/extended expiry fails (sigs no longer cover the body)')
    // fail-open guard: a single member cannot forge the record by claiming
    // distinct honest w's while signing with its OWN key (keyOf binding).
    const evil = members[0]
    const forged = pin.makeFuseRecord(root.pubB, 100, trippedWts, pin.pinRecordId(pinRec.payload),
      committee.slice(0, T).map((w) => ({ w, key: evil.key.pubB, sig: pin.signFuse(body, w, evil.key.pubB, evil.key.priv).sig })))
    ok(!pin.verifyFuseRecord(forged, committee, keyOf).ok, 'a single member cannot forge a fuse by impersonating peers (keyOf binding closes fail-open)')

    // isFuseActive window
    ok(pin.isFuseActive(fuse, trippedWts + 1000), 'fuse is active just after tripping')
    ok(pin.isFuseActive(fuse, body.expiryWts - 1), 'fuse is active 1 ms before expiry')
    ok(!pin.isFuseActive(fuse, body.expiryWts), 'fuse is inactive at expiry')
    ok(!pin.isFuseActive(fuse, trippedWts - 1), 'fuse is inactive before it tripped')
  }

  // ============================================================================
  // 8. PIN session. Verify + wrong-pin / wrong-key rejection
  // ============================================================================
  console.log('\n· PIN session (takeover / device-witness) …')
  {
    const device = kp(200)
    const body = { v: 1, root: root.pubB, device: device.pubB, purpose: 'lease-takeover', evalNonce: hash.toB64u(hash.sha256(hash.utf8('nonce-1'))), wts: 1_700_000_500_000 }
    const session = pin.makePinSession(body, pinPriv)
    ok(pin.verifyPinSession(session, pinPub), 'a valid PIN session verifies against pinPub')
    // wrong pinPub (from a wrong PIN) rejected
    const wrong = kp(201)
    ok(!pin.verifyPinSession(session, wrong.pubB), 'a PIN session fails under the wrong pinPub (wrong PIN)')
    // tampered body rejected
    const tampered = { body: { ...body, device: wrong.pubB }, pinSig: session.pinSig }
    ok(!pin.verifyPinSession(tampered, pinPub), 'a tampered PIN session (swapped device) fails verification')
    // session signed by a non-pin key rejected
    const forged = pin.makePinSession(body, wrong.priv)
    ok(!pin.verifyPinSession(forged, pinPub), 'a session signed by a non-pinKey fails against pinPub')
  }

  // ============================================================================
  // 9. Committee handoff carries the counter forward, rejects reset-to-zero
  // ============================================================================
  console.log('\n· committee handoff (counter carried forward) …')
  {
    // fresh committee (different nodes)
    const newMembers = Array.from({ length: N }, (_, i) => {
      const k = kp(150 + i * 3)
      return { i: i + 1, key: k, nodeId: hash.toB64u(hash.sha256(k.pub)) }
    })
    const newCommittee = newMembers.map((m) => m.nodeId)
    const rng = seededRng('handoff-deal')
    const secret = shamir.randScalar(rng)
    const deal = shamir.dealScalar(secret, T, N, rng)
    const shareCommitments = deal.shares.map((s) => hash.toB64u(shamir.pointToBytes(shamir.shareCommitment(s.share))))
    const carried = 87 // pre-handoff effective count

    const prevId = pin.pinRecordId(pinRec.payload)
    const newPayload = pin.makePinRecordPayload({ committee: newCommittee, t: T, shareCommitments, pinPub, prev: prevId, carriedFails: carried })
    const newRec = pin.buildPinRecord(newPayload, root.priv, root.pubB)
    const newId = pin.pinRecordId(newPayload)

    const nonce = hash.toB64u(hash.sha256(hash.utf8('handoff-nonce')))
    // The committee-handoff session is bound to the specific NEW record id.
    const session = pin.makePinSession({ v: 1, root: root.pubB, device: root.pubB, purpose: 'committee-handoff', evalNonce: nonce, wts: 1_700_001_000_000, record: newId }, pinPriv)
    const oldSigs = members.slice(0, T).map((m) => pin.signHandoff(root.pubB, prevId, newId, carried, m.nodeId, m.key.pubB, m.key.priv))
    const auth = pin.authorizeHandoff({ root: root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: carried, session, oldSigs })

    const vr = pin.verifyHandoff(auth, { oldCommittee: committee, keyOf, pinPub, newRecord: newRec, minCarry: carried })
    ok(vr.ok, 'a well-formed handoff verifies (pinKey session + old-committee threshold + carry)')

    // a session bound to a DIFFERENT record cannot authorize this handoff (replay).
    const wrongRecSession = pin.makePinSession({ v: 1, root: root.pubB, device: root.pubB, purpose: 'committee-handoff', evalNonce: nonce, wts: 1_700_001_000_000, record: prevId }, pinPriv)
    const replayAuth = pin.authorizeHandoff({ root: root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: carried, session: wrongRecSession, oldSigs })
    ok(!pin.verifyHandoff(replayAuth, { oldCommittee: committee, keyOf, pinPub, newRecord: newRec, minCarry: carried }).ok, 'a committee-handoff session bound to a different record is rejected (no replay)')

    // reject a re-provision that resets the counter to zero (session bound to zeroId).
    const zeroPayload = pin.makePinRecordPayload({ committee: newCommittee, t: T, shareCommitments, pinPub, prev: prevId, carriedFails: 0 })
    const zeroRec = pin.buildPinRecord(zeroPayload, root.priv, root.pubB)
    const zeroId = pin.pinRecordId(zeroPayload)
    const zeroSession = pin.makePinSession({ v: 1, root: root.pubB, device: root.pubB, purpose: 'committee-handoff', evalNonce: nonce, wts: 1_700_001_000_000, record: zeroId }, pinPriv)
    const zeroSigs = members.slice(0, T).map((m) => pin.signHandoff(root.pubB, prevId, zeroId, 0, m.nodeId, m.key.pubB, m.key.priv))
    const zeroAuth = pin.authorizeHandoff({ root: root.pubB, prevPinRecord: prevId, newPinRecord: zeroId, carriedFails: 0, session: zeroSession, oldSigs: zeroSigs })
    const zvr = pin.verifyHandoff(zeroAuth, { oldCommittee: committee, keyOf, pinPub, newRecord: zeroRec, minCarry: carried })
    ok(!zvr.ok, 'a handoff that resets the counter below the carried count is REJECTED')

    // reject a handoff missing the old-committee threshold
    const shortSigs = oldSigs.slice(0, T - 1)
    const shortAuth = pin.authorizeHandoff({ root: root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: carried, session, oldSigs: shortSigs })
    ok(!pin.verifyHandoff(shortAuth, { oldCommittee: committee, keyOf, pinPub, newRecord: newRec, minCarry: carried }).ok, 'a handoff without old-committee pinT signatures is rejected')

    // reject a handoff whose pinKey session is forged
    const forgedKp = kp(210)
    const forgedSession = pin.makePinSession({ v: 1, root: root.pubB, device: root.pubB, purpose: 'committee-handoff', evalNonce: nonce, wts: 1_700_001_000_000, record: newId }, forgedKp.priv)
    const forgedAuth = pin.authorizeHandoff({ root: root.pubB, prevPinRecord: prevId, newPinRecord: newId, carriedFails: carried, session: forgedSession, oldSigs })
    ok(!pin.verifyHandoff(forgedAuth, { oldCommittee: committee, keyOf, pinPub, newRecord: newRec, minCarry: carried }).ok, 'a handoff with a non-pinKey session is rejected')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
