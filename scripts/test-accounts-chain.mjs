// Headless test for the accounts chain modules (src/shared/accounts/
// events|certs|chain|checkpoint|fraud.ts: phase A1 "chain" scope).
//
//   node scripts/test-accounts-chain.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-mp-store.mjs), imports them from a temp dir,
// and drives every rule in types.ts' doc comments: happy path, byte/digest
// determinism (with a golden vector), a full tamper matrix asserting exact
// VerifyError codes, fork proofs, checkpoint (incremental + deep + forgery),
// and the personal-lane LWW CRDT merge.
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
/** Assert a verify result is not ok and carries the given error code. */
function hasCode(vr, code, msg) {
  const got = vr.errors.map((e) => e.code)
  ok(!vr.ok && got.includes(code), `${msg}${!vr.ok && got.includes(code) ? '' : ` (ok=${vr.ok}, codes=[${got}])`}`)
}

// ---- golden vectors (recorded from a green run; determinism anchors) ---------
// All three changed ONCE pre-ship when PARAMS_V1 gained the pwNorm row
// (genesis payloads embed the params digest, so the chain goldens follow it).
// Digest of verifyChain(happy-path chain) built from the fixed seeds/timestamps
// below: any change to canonical serialization, hashing, fold, or projection
// shape breaks this on every platform at once.
const GOLDEN_VERIFY_DIGEST = '9X73ZssMl6BygmtesggEAp91sSDKfWM1ngaMG4-fCWM'
// sha256 (b64u) of chainToBytes(happy-path chain): the file-format anchor.
const GOLDEN_FILE_SHA256 = 'ZJm5bqJwj7RrgksYMvwxH20nzLvUATaFPmOwr6koQSc'
// b64u(sha256(canonicalBytes(PARAMS_V1))): frozen-at-genesis parameter digest.
const GOLDEN_PARAMS_DIGEST = 'ZDoblqaVf5z1zL8IvmWK2sdZK29JTNWZpY38XuDBZdk'

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-chain-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    // cleanup on failure paths too. A crashed run must not leak temp dirs
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  // ---- bundle the shared accounts modules ------------------------------------
  console.log('· bundling src/shared/accounts (events/certs/chain/checkpoint/fraud) …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as params from '${SRC}/params.ts'`,
      `export * as types from '${SRC}/types.ts'`,
      `export * as events from '${SRC}/events.ts'`,
      `export * as certs from '${SRC}/certs.ts'`,
      `export * as chain from '${SRC}/chain.ts'`,
      `export * as ckpt from '${SRC}/checkpoint.ts'`,
      `export * as fraud from '${SRC}/fraud.ts'`,
      `export * as a4 from '${SRC}/ratings/fold.ts'`,
      `export * as seg from '${SRC}/segment.ts'`,
      `export * as attest from '${SRC}/witness/attest.ts'`,
      `export * as viewer from '${SRC}/storage/viewer.ts'`,
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
  const { codec, hash, params, events, certs, chain, ckpt, fraud, a4, seg, attest, viewer } = M

  // ---- fixed raw keypairs -----------------------------------------------------
  const seed = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seed(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const root = kp(1)
  const devA = kp(50)
  const devB = kp(90)
  const stranger = kp(130)
  const rootB = root.pubB
  /** A valid-format 32-byte b64u that is not any real key. */
  const fakeId = (s) => hash.toB64u(hash.sha256(hash.utf8(s)))
  /** Flip one character of a b64u string (still valid b64u alphabet). */
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  const clone = (x) => structuredClone(x)

  // ============================================================================
  // 0. params digest is the frozen golden value
  // ============================================================================
  console.log('\n· frozen params digest …')
  eq(params.PARAMS_V1_DIGEST, GOLDEN_PARAMS_DIGEST, 'PARAMS_V1_DIGEST matches the recorded golden value')

  // ============================================================================
  // 1. schema sanity (zod mirrors of types.ts)
  // ============================================================================
  console.log('\n· payload schema sanity …')
  {
    ok(!events.zName.safeParse('ab').success, 'zName rejects < NAME_MIN chars')
    ok(!events.zName.safeParse('x'.repeat(25)).success, 'zName rejects > NAME_MAX chars')
    ok(!events.zName.safeParse('has​zwsp').success, 'zName rejects zero-width chars')
    ok(!events.zName.safeParse(' padded ').success, 'zName rejects untrimmed names')
    ok(events.zName.safeParse('Isaac Miller').success, 'zName accepts a normal display name')
    ok(!events.zGenesisPayload.safeParse({ params: fakeId('p'), name: 'Isaac', extra: 1 }).success,
      'zGenesisPayload is .strict() (extra key rejected)')
    ok(!events.zProfileFields.safeParse({ website: 'x' }).success,
      'profile fields restricted to PROFILE_FIELDS (unknown field rejected)')
    ok(!events.zProfileFields.safeParse({ bio: 'x'.repeat(501) }).success, 'bio > BIO_MAX rejected')
    ok(events.zProfileFields.safeParse({ bio: 'x'.repeat(500) }).success, 'bio at BIO_MAX accepted')
    ok(!events.zProfileFields.safeParse({ avatar: 'A'.repeat(events.AVATAR_B64_MAX_CHARS + 1) }).success,
      'avatar over the base64 cap rejected')
    ok(events.zProfileFields.safeParse({ avatar: 'A'.repeat(events.AVATAR_B64_MAX_CHARS) }).success,
      'avatar at the base64 cap accepted')
    ok(!events.zCertPayload.safeParse({ pub: fakeId('k'), purpose: 3, index: 0 }).success,
      'cert purpose outside 0..2 rejected')
    ok(events.zWitnessAttestation.safeParse({ w: fakeId('w'), wts: 1, epoch: 0, sig: 'A'.repeat(86) }).success,
      'zWitnessAttestation accepts the A2 shape')
    ok(!events.zWitnessAttestation.safeParse({ w: fakeId('w'), wts: 1, epoch: 0, sig: 'A'.repeat(86), x: 1 }).success,
      'zWitnessAttestation is .strict()')
  }

  // ============================================================================
  // 2. happy path: create + device certs + profile + revoke + checkpoint
  // ============================================================================
  console.log('\n· happy path chain …')
  function buildBase() {
    let c = chain.createAccountChain({
      rootPriv: root.priv,
      rootPub: root.pub,
      displayName: 'Isaac',
      ts: 1000,
      device: { pub: devA.pubB, index: 0, label: 'MacBook' },
    })
    c = chain.appendEvent(
      c,
      certs.makeCertEvent(root.priv, rootB, c, { childPub: devB.pubB, purpose: 0, index: 1, label: 'Work PC', ts: 1100 }),
    )
    c = chain.appendPersonal(c, root.priv, rootB, 'profile', { fields: { bio: 'hi there', country: 'US' } }, 1200)
    c = chain.appendPersonal(c, devA.priv, devA.pubB, 'profile', { fields: { flair: 'knight' } }, 1300)
    c = chain.appendEvent(c, certs.makeRevokeEvent(root.priv, rootB, c, { pub: devB.pubB, ts: 1400 }))
    // devB writes AFTER its revocation ts → must be ignored, not fraud
    c = chain.appendPersonal(c, devB.priv, devB.pubB, 'profile', { fields: { bio: 'EVIL' } }, 1500)
    c = chain.appendEvent(c, ckpt.makeCheckpointEvent(c, root.priv, rootB, 1600))
    return c
  }
  const base = buildBase()
  const vr = chain.verifyChain(base)
  {
    eq(vr.ok, true, 'happy chain verifies ok')
    eq(vr.errors.length, 0, 'happy chain has zero errors')
    eq(vr.witnessedHeight, 2, 'witnessed head height 2 (genesis, revoke, ckpt)')
    const ckptEv = base.events[base.events.length - 1]
    eq(vr.witnessedHead, events.eventId(ckptEv.body), 'witnessedHead is the checkpoint event id')
    eq(vr.activeKeys.length, 1, 'one active key after devB revocation')
    eq(vr.activeKeys[0].pub, devA.pubB, 'active key is devA')
    eq(vr.activeKeys[0].purpose, 0, 'active key purpose = device')
    eq(vr.profile.bio, 'hi there', 'profile.bio from root (devB post-revoke write excluded)')
    eq(vr.profile.country, 'US', 'profile.country folded')
    eq(vr.profile.flair, 'knight', 'profile.flair from certified devA')
    const heads = Object.fromEntries(vr.personalHeads.map((h) => [h.key, h]))
    eq(heads[rootB]?.height, 2, 'root personal head at height 2 (certA, certB, profile)')
    eq(heads[devA.pubB]?.height, 0, 'devA personal head at height 0')
    ok(!(devB.pubB in heads), 'devB has NO personal head (its only event is post-revoke, excluded)')
    eq(vr.fold.n, 3, 'basic fold counted 3 witnessed events')
    eq(vr.fold.byType.genesis, 1, 'fold byType.genesis = 1')
    eq(vr.fold.byType.revoke, 1, 'fold byType.revoke = 1')
    eq(vr.fold.byType.ckpt, 1, 'fold byType.ckpt = 1')
    eq(vr.fold.height, 2, 'fold head height = 2')
  }
  console.log('\n· pre-revoke-ts write by a revoked key IS included …')
  {
    // devB writes at ts 1350 < revoke ts 1400 → included; LWW: 1350 > devA's 1300
    let c = chain.createAccountChain({
      rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000,
      device: { pub: devA.pubB, index: 0 },
    })
    c = chain.appendEvent(c, certs.makeCertEvent(root.priv, rootB, c, { childPub: devB.pubB, purpose: 0, index: 1, ts: 1100 }))
    c = chain.appendPersonal(c, devA.priv, devA.pubB, 'profile', { fields: { flair: 'knight' } }, 1300)
    c = chain.appendPersonal(c, devB.priv, devB.pubB, 'profile', { fields: { flair: 'zzz' } }, 1350)
    c = chain.appendEvent(c, certs.makeRevokeEvent(root.priv, rootB, c, { pub: devB.pubB, ts: 1400 }))
    const v = chain.verifyChain(c)
    eq(v.ok, true, 'chain with pre-revoke devB write verifies ok')
    eq(v.profile.flair, 'zzz', "devB's ts-1350 write (≤ revoke ts) is included and LWW-wins")
    ok(v.personalHeads.some((h) => h.key === devB.pubB && h.height === 0), 'devB keeps its pre-revoke personal head')
  }

  // ============================================================================
  // 3. determinism: bytes, shuffle-independence, golden digest
  // ============================================================================
  console.log('\n· determinism …')
  {
    const again = buildBase()
    const bytes1 = chain.chainToBytes(base)
    const bytes2 = chain.chainToBytes(again)
    eq(Buffer.from(bytes1).toString('hex'), Buffer.from(bytes2).toString('hex'),
      'same inputs → chainToBytes byte-identical')
    // deterministic pseudo-shuffle of storage order
    const shuffled = { root: base.root, events: [...base.events].reverse() }
    const rot = { root: base.root, events: [...base.events.slice(3), ...base.events.slice(0, 3)] }
    eq(chain.verifyChain(shuffled).digest, vr.digest, 'reversed storage order → identical verify digest')
    eq(chain.verifyChain(rot).digest, vr.digest, 'rotated storage order → identical verify digest')
    eq(Buffer.from(chain.chainToBytes(shuffled)).toString('hex'), Buffer.from(bytes1).toString('hex'),
      'reversed storage order → identical chain bytes')
    eq(vr.digest, GOLDEN_VERIFY_DIGEST, 'verify digest matches the recorded GOLDEN vector')
    eq(hash.toB64u(hash.sha256(bytes1)), GOLDEN_FILE_SHA256, 'chainToBytes sha256 matches the recorded GOLDEN vector')
    // round-trip
    const back = chain.chainFromBytes(bytes1)
    eq(back.root, base.root, 'chainFromBytes recovers the root')
    eq(back.events.length, base.events.length, 'chainFromBytes recovers all events')
    eq(chain.verifyChain(back).digest, vr.digest, 'round-tripped chain verifies to the identical digest')
    // canonical over the event SET: duplicate storage serializes + verifies
    // identically to the deduped chain (one canonical byte stream per chain)
    const dup = { root: base.root, events: [...base.events, clone(base.events[3]), clone(base.events[0])] }
    eq(Buffer.from(chain.chainToBytes(dup)).toString('hex'), Buffer.from(bytes1).toString('hex'),
      'duplicate event storage → chainToBytes byte-identical to the deduped form')
    eq(chain.verifyChain(dup).digest, vr.digest, 'duplicate event storage → identical verify digest')
    const dedupBack = chain.chainFromBytes(chain.chainToBytes(dup))
    eq(dedupBack.events.length, base.events.length, 'the serialized file carries each event exactly once')
  }

  // ============================================================================
  // 4. tamper matrix. Every case must fail with the RIGHT code
  // ============================================================================
  console.log('\n· tamper: flipped signature bit …')
  {
    const c = clone(base)
    c.events[2].sig = flip(c.events[2].sig)
    hasCode(chain.verifyChain(c), 'bad-signature', 'flipped sig → bad-signature')
  }
  console.log('\n· tamper: edited payload (re-signed) breaks downstream linkage …')
  {
    const c = clone(base)
    const rev = c.events.find((e) => e.body.type === 'revoke')
    rev.body.payload.pub = devA.pubB // rewrite history: revoke devA instead
    rev.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(rev.body), root.priv)) // attacker re-signs
    hasCode(chain.verifyChain(c), 'bad-linkage', 'edited+re-signed event → id mismatch → bad-linkage at successor')
  }
  console.log('\n· tamper: edited payload (NOT re-signed) …')
  {
    const c = clone(base)
    const rev = c.events.find((e) => e.body.type === 'revoke')
    rev.body.payload.pub = devA.pubB
    hasCode(chain.verifyChain(c), 'bad-signature', 'edited unsigned event → bad-signature')
  }
  console.log('\n· tamper: witnessed height gap …')
  {
    const c = clone(base)
    c.events = c.events.filter((e) => e.body.type !== 'revoke') // hole at height 1
    hasCode(chain.verifyChain(c), 'bad-height', 'missing witnessed height → bad-height (gap)')
  }
  console.log('\n· tamper: duplicate witnessed height (different prevs) …')
  {
    const c = clone(base)
    const body = {
      v: 1, lane: 'w', type: 'revoke', root: rootB, key: rootB,
      height: 1, prev: fakeId('other-prev'), ts: 1401, payload: { pub: stranger.pubB },
    }
    c.events.push(events.signBody(body, root.priv))
    hasCode(chain.verifyChain(c), 'bad-height', 'two events at one height, different prevs → bad-height')
  }
  console.log('\n· tamper: wrong prev …')
  {
    let c = chain.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000 })
    const body = {
      v: 1, lane: 'w', type: 'revoke', root: rootB, key: rootB,
      height: 1, prev: fakeId('not-the-genesis'), ts: 1100, payload: { pub: stranger.pubB },
    }
    c = { root: c.root, events: [...c.events, events.signBody(body, root.priv)] }
    hasCode(chain.verifyChain(c), 'bad-linkage', 'prev not pointing at the head → bad-linkage')
  }
  console.log('\n· tamper: event signed by an uncertified key …')
  {
    const c = clone(base)
    const body = {
      v: 1, lane: 'p', type: 'profile', root: rootB, key: stranger.pubB,
      height: 0, ts: 2000, payload: { fields: { bio: 'sneaky' } },
    }
    c.events.push(events.signBody(body, stranger.priv))
    const v = chain.verifyChain(c)
    hasCode(v, 'uncertified-key', 'personal event by uncertified key → uncertified-key')
    ok(v.profile.bio === 'hi there', "uncertified key's write does not reach the profile")
  }
  console.log('\n· tamper: witnessed event by a key revoked at a lower height …')
  {
    // devB was revoked at witnessed height 1; devB signs a witnessed event at height 3
    let c = clone(base)
    const ev = certs.makeRevokeEvent(devB.priv, devB.pubB, c, { pub: stranger.pubB, ts: 1700 })
    c = chain.appendEvent(c, ev) // append gate is structural; verify must flag it
    hasCode(chain.verifyChain(c), 'revoked-key', 'witnessed event by revoked key → revoked-key')
  }
  console.log('\n· non-tamper: personal event by revoked key with later ts is IGNORED …')
  {
    const v = chain.verifyChain(base) // base already carries devB's post-revoke write
    eq(v.ok, true, 'ok stays true (ignored, not fraud)')
    ok(v.profile.bio === 'hi there', "revoked key's later-ts write excluded from the profile fold")
  }
  console.log('\n· revoke-then-recert cannot resurrect a key …')
  {
    let c = chain.createAccountChain({
      rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000,
      device: { pub: devA.pubB, index: 0 },
    })
    c = chain.appendEvent(c, certs.makeCertEvent(root.priv, rootB, c, { childPub: devB.pubB, purpose: 0, index: 1, ts: 1100 }))
    c = chain.appendEvent(c, certs.makeRevokeEvent(root.priv, rootB, c, { pub: devB.pubB, ts: 1200 }))
    // root re-certifies devB AFTER the revocation: revocation is permanent
    c = chain.appendEvent(c, certs.makeCertEvent(root.priv, rootB, c, { childPub: devB.pubB, purpose: 0, index: 2, ts: 1300 }))
    const v = chain.verifyChain(c)
    eq(v.ok, true, 'recert-after-revoke chain still verifies (the recert is inert, not fraud)')
    ok(!v.activeKeys.some((k) => k.pub === devB.pubB), 'recert does NOT resurrect the key in activeKeys')
    ok(v.activeKeys.some((k) => k.pub === devA.pubB), 'the untouched device key stays active (sanity)')
    // a witnessed event signed by the recerted key is still 'revoked-key'
    const cW = chain.appendEvent(c, certs.makeRevokeEvent(devB.priv, devB.pubB, c, { pub: stranger.pubB, ts: 1400 }))
    hasCode(chain.verifyChain(cW), 'revoked-key', 'witnessed event by the recerted key → still revoked-key')
    // its post-revoke-ts personal writes stay ignored too
    const cP = chain.appendPersonal(c, devB.priv, devB.pubB, 'profile', { fields: { bio: 'zombie' } }, 1500)
    const vP = chain.verifyChain(cP)
    eq(vP.ok, true, 'post-revoke personal write by the recerted key is ignored, not fraud')
    ok(vP.profile.bio === undefined, "the recerted key's later-ts personal write never reaches the profile")
  }
  console.log('\n· tamper: genesis with wrong params digest …')
  {
    const body = {
      v: 1, lane: 'w', type: 'genesis', root: rootB, key: rootB,
      height: 0, ts: 1000, payload: { params: fakeId('params-v999'), name: 'Isaac' },
    }
    const c = { root: rootB, events: [events.signBody(body, root.priv)] }
    hasCode(chain.verifyChain(c), 'bad-genesis', 'unknown params digest → bad-genesis')
  }
  console.log('\n· tamper: genesis not at height 0 …')
  {
    const body = {
      v: 1, lane: 'w', type: 'genesis', root: rootB, key: rootB,
      height: 1, ts: 1000, payload: { params: params.PARAMS_V1_DIGEST, name: 'Isaac' },
    }
    const c = { root: rootB, events: [events.signBody(body, root.priv)] }
    hasCode(chain.verifyChain(c), 'bad-genesis', 'genesis at height 1 (nothing at 0) → bad-genesis')
  }
  console.log('\n· tamper: second genesis …')
  {
    const c = clone(base)
    const body = {
      v: 1, lane: 'w', type: 'genesis', root: rootB, key: rootB,
      height: 0, ts: 1001, payload: { params: params.PARAMS_V1_DIGEST, name: 'Isaac' },
    }
    c.events.push(events.signBody(body, root.priv))
    hasCode(chain.verifyChain(c), 'bad-genesis', 'two genesis events → bad-genesis')
  }
  console.log('\n· tamper: wrong-root event …')
  {
    const c = clone(base)
    const body = {
      v: 1, lane: 'p', type: 'profile', root: stranger.pubB, key: stranger.pubB,
      height: 0, ts: 2000, payload: { fields: { bio: 'not my chain' } },
    }
    c.events.push(events.signBody(body, stranger.priv))
    hasCode(chain.verifyChain(c), 'wrong-root', "event bound to another root → wrong-root")
  }
  console.log('\n· tamper: float / null smuggled into a payload …')
  {
    const c1 = clone(base)
    c1.events.find((e) => e.body.type === 'profile').body.payload.x = 1.5
    hasCode(chain.verifyChain(c1), 'bad-canonical', 'float in payload → bad-canonical')
    const c2 = clone(base)
    c2.events.find((e) => e.body.type === 'profile').body.payload.y = null
    hasCode(chain.verifyChain(c2), 'bad-canonical', 'null in payload → bad-canonical')
  }
  console.log('\n· tamper: oversized / malformed payloads → bad-payload …')
  {
    const c = clone(base)
    const body = {
      v: 1, lane: 'p', type: 'profile', root: rootB, key: rootB,
      height: 3, prev: events.eventId(c.events.find((e) => e.body.type === 'profile' && e.body.key === rootB).body),
      ts: 2000, payload: { fields: { bio: 'x'.repeat(501) } },
    }
    c.events.push(events.signBody(body, root.priv))
    const vBad = chain.verifyChain(c)
    hasCode(vBad, 'bad-payload', 'bio over BIO_MAX → bad-payload')
    // VerifyError.detail must be STABLE (zod issue code+path only, never
    // zod's free text): a zod minor bump must not shift the parity digest.
    const badPayloadErr = vBad.errors.find((e) => e.code === 'bad-payload')
    eq(badPayloadErr?.detail, 'payload invalid: too_big at fields.bio',
      'bad-payload detail is the stable code+path form (no zod prose)')
    throws(() => chain.appendEvent(base, events.signBody(body, root.priv)),
      'appendEvent refuses the oversized-bio event outright')
  }
  console.log('\n· tamper: __proto__ smuggled as a payload key …')
  {
    // JSON.parse creates an OWN '__proto__' property (no setter): the codec
    // must refuse it in both directions, and the signing/append paths must
    // fail cleanly instead of signing bytes zod would silently disagree with.
    const evilPayload = JSON.parse('{"fields":{"__proto__":{"bio":"evil"}}}')
    let codecErr = null
    try {
      codec.canonicalBytes(evilPayload)
    } catch (e) {
      codecErr = e
    }
    ok(codecErr !== null && codecErr.name === 'CodecError', "canonicalBytes throws CodecError on a '__proto__' key")
    throws(() => codec.parseCanonical(hash.utf8('{"fields":{"__proto__":1}}')),
      "parseCanonical rejects '__proto__' keys (parse direction)")
    const evilBody = {
      v: 1, lane: 'p', type: 'profile', root: rootB, key: rootB,
      height: 3, prev: events.eventId(base.events.find((e) => e.body.type === 'profile' && e.body.key === rootB).body),
      ts: 2100, payload: evilPayload,
    }
    throws(() => events.signBody(evilBody, root.priv), "signBody refuses a '__proto__' payload key (never signs it)")
    throws(() => chain.appendPersonal(base, root.priv, rootB, 'profile', evilPayload, 2100),
      "appendPersonal fails cleanly on a '__proto__' payload key")
  }
  console.log('\n· tamper: truncated chain bytes rejected …')
  {
    const bytes = chain.chainToBytes(base)
    throws(() => chain.chainFromBytes(bytes.slice(0, bytes.length - 4)), 'chainFromBytes throws on truncated input')
    throws(() => chain.chainFromBytes(bytes.slice(0, Math.floor(bytes.length / 2))), 'chainFromBytes throws on half a file')
    throws(() => chain.chainFromBytes(hash.utf8('{"v":1,"root":3}')), 'chainFromBytes throws on wrong shape')
  }

  // ============================================================================
  // 5. append gate (structural admission throws on programmer misuse)
  // ============================================================================
  console.log('\n· append gate …')
  {
    throws(() => chain.appendEvent(base, base.events[0]), 'appendEvent refuses a second genesis')
    const bad = certs.makeRevokeEvent(root.priv, rootB, base, { pub: stranger.pubB, ts: 1700 })
    const gap = clone(bad)
    gap.body.height = 5
    gap.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(gap.body), root.priv))
    throws(() => chain.appendEvent(base, gap), 'appendEvent refuses a non-contiguous witnessed height')
    const wrongSig = clone(bad)
    wrongSig.sig = flip(wrongSig.sig)
    throws(() => chain.appendEvent(base, wrongSig), 'appendEvent refuses a bad signature')
    ok(chain.appendEvent(base, bad).events.length === base.events.length + 1, 'appendEvent admits a well-formed event')
    eq(base.events.length, 8, 'appendEvent did not mutate the source chain (8 events before and after)')
  }

  // ============================================================================
  // 6. forks: detectFork + verifyForkProof
  // ============================================================================
  console.log('\n· fork proofs …')
  {
    const headId = vr.witnessedHead
    const certList = base.events.filter((e) => e.body.type === 'cert')
    const e1 = certs.makeRevokeEvent(root.priv, rootB, base, { pub: stranger.pubB, ts: 2000 })
    const body2 = {
      v: 1, lane: 'w', type: 'revoke', root: rootB, key: devA.pubB,
      height: 3, prev: headId, ts: 2001, payload: { pub: fakeId('other-target') },
    }
    const e2 = events.signBody(body2, devA.priv)
    const proof = fraud.detectFork(e1, e2, certList)
    ok(proof !== null, 'two successors of one witnessed head → ForkProof')
    eq(proof.root, rootB, 'proof binds the root')
    eq(proof.certs.length, 1, 'proof carries exactly the cert proving devA (root needs none)')
    ok(fraud.verifyForkProof(proof), 'verifyForkProof accepts the proof (context-free)')
    const tampered = clone(proof)
    tampered.a.sig = flip(tampered.a.sig)
    ok(!fraud.verifyForkProof(tampered), 'proof with a tampered signature → false')
    const noCerts = clone(proof)
    noCerts.certs = []
    ok(!fraud.verifyForkProof(noCerts), 'proof stripped of the cert proving devA → false')
    const e3 = events.signBody({ ...body2, prev: fakeId('elsewhere'), ts: 2002 }, devA.priv)
    eq(fraud.detectFork(e1, e3, certList), null, 'different prevs → no fork')
    eq(fraud.detectFork(e1, e1, certList), null, 'same event twice → no fork (ids equal)')
    eq(fraud.detectFork(e1, e2, []), null, 'devA unproven without its cert → no fork proof minted')
    // genesis fork: two distinct geneses (both prev-absent) are a fork too
    const g2 = events.signBody({ ...base.events[0].body, ts: 1001 }, root.priv)
    ok(fraud.detectFork(base.events[0], g2, []) !== null, 'two distinct geneses (prev absent) → fork proof')
    // in-chain: verifyChain flags stored fork siblings
    const c = clone(base)
    c.events.push(e1, e2)
    hasCode(chain.verifyChain(c), 'fork', 'both successors stored in one chain → verify reports fork')
  }

  // ============================================================================
  // 7. checkpoints
  // ============================================================================
  console.log('\n· checkpoints: valid incremental + deep …')
  const ckptEv1 = base.events[base.events.length - 1]
  {
    ok(ckpt.verifyCheckpointIncremental(base, ckptEv1), 'first checkpoint verifies incrementally (from genesis)')
    ok(ckpt.verifyCheckpointDeep(base, ckptEv1), 'first checkpoint verifies deeply')
    eq(ckptEv1.body.payload.through, 1, 'checkpoint covers through the pre-ckpt head (height 1)')
    eq(ckptEv1.body.payload.prevCkpt, undefined, 'first checkpoint has no prevCkpt')
    eq(ckptEv1.body.payload.state.n, 2, 'embedded state folded 2 events (genesis + revoke)')
  }
  console.log('\n· checkpoints: a chain of three …')
  let ck2, ck3, cPre3, c3
  {
    let c = base
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('r1') }, 3000)
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('r2') }, 3001)
    ck2 = ckpt.makeCheckpointEvent(c, root.priv, rootB, 3100)
    c = chain.appendEvent(c, ck2)
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('r3') }, 3200)
    cPre3 = c
    ck3 = ckpt.makeCheckpointEvent(c, root.priv, rootB, 3300)
    c3 = chain.appendEvent(c, ck3)
    const v3 = chain.verifyChain(c3)
    eq(v3.ok, true, '3-checkpoint chain verifies ok')
    eq(ck2.body.payload.prevCkpt, events.eventId(ckptEv1.body), 'ckpt2.prevCkpt → ckpt1')
    eq(ck3.body.payload.prevCkpt, events.eventId(ck2.body), 'ckpt3.prevCkpt → ckpt2')
    ok(ckpt.verifyCheckpointIncremental(c3, ck2), 'ckpt2 verifies incrementally from ckpt1 state')
    ok(ckpt.verifyCheckpointIncremental(c3, ck3), 'ckpt3 verifies incrementally from ckpt2 state')
    ok(ckpt.verifyCheckpointDeep(c3, ck2), 'ckpt2 verifies deeply')
    ok(ckpt.verifyCheckpointDeep(c3, ck3), 'ckpt3 verifies deeply')
  }
  console.log('\n· checkpoints: forged stateDigest …')
  {
    const forged = clone(ck3)
    forged.body.payload.stateDigest = fakeId('forged-digest')
    forged.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(forged.body), root.priv))
    ok(!ckpt.verifyCheckpointIncremental(cPre3, forged), 'forged stateDigest → incremental verify false')
    ok(!ckpt.verifyCheckpointDeep(cPre3, forged), 'forged stateDigest → deep verify false')
    const cBad = chain.appendEvent(cPre3, forged)
    hasCode(chain.verifyChain(cBad), 'bad-checkpoint', 'forged stateDigest in-chain → bad-checkpoint')
  }
  console.log('\n· checkpoints: forged state under a CORRECT digest …')
  {
    const forged = clone(ck3)
    const state = clone(forged.body.payload.state)
    state.n = state.n + 1 // rewrite history by one event
    forged.body.payload.state = state
    forged.body.payload.stateDigest = hash.toB64u(codec.canonicalHash(state)) // digest is self-consistent
    forged.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(forged.body), root.priv))
    ok(!ckpt.verifyCheckpointIncremental(cPre3, forged), 'self-consistent forged state → incremental recompute catches it')
    ok(!ckpt.verifyCheckpointDeep(cPre3, forged), 'self-consistent forged state → deep recompute catches it')
    const cBad = chain.appendEvent(cPre3, forged)
    hasCode(chain.verifyChain(cBad), 'bad-checkpoint', 'self-consistent forged state in-chain → bad-checkpoint')
    // detail is a hand-written stable string
    ok(chain.verifyChain(cBad).errors.some((e) => e.code === 'bad-checkpoint' && e.detail === 'state recomputation mismatch'),
      "detail: 'state recomputation mismatch'")
  }
  console.log('\n· checkpoints: the remaining bad-checkpoint branches …')
  {
    // Hand-craft checkpoints appended to base (whose ckpt1 sits at witnessed
    // height 2, through 1) with a SELF-CONSISTENT stateDigest, so the earlier
    // branches pass and exactly the branch under test fires.
    const ckpt1Id = events.eventId(ckptEv1.body)
    const mkBadCkpt = (payloadPatch) => {
      const state = clone(ckptEv1.body.payload.state)
      const payload = {
        prevCkpt: ckpt1Id,
        through: 2,
        state,
        stateDigest: hash.toB64u(codec.canonicalHash(state)),
        ...payloadPatch,
      }
      for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k]
      const body = {
        v: 1, lane: 'w', type: 'ckpt', root: rootB, key: rootB,
        height: 3, prev: vr.witnessedHead, ts: 5000, payload,
      }
      return chain.appendEvent(clone(base), events.signBody(body, root.priv))
    }
    const expectBad = (c, detail, msg) => {
      const v = chain.verifyChain(c)
      hasCode(v, 'bad-checkpoint', msg)
      ok(v.errors.some((e) => e.code === 'bad-checkpoint' && e.detail === detail), `detail: '${detail}'`)
    }
    // (a) through >= own height. A checkpoint may only cover heights below itself
    expectBad(mkBadCkpt({ through: 3 }),
      'checkpoint must cover heights strictly below itself',
      'through == own height → bad-checkpoint')
    // (b1) prevCkpt mispointing when a prior checkpoint exists
    expectBad(mkBadCkpt({ prevCkpt: fakeId('not-a-ckpt') }),
      'prevCkpt does not reference the prior checkpoint',
      'mispointing prevCkpt → bad-checkpoint')
    // (b2) prevCkpt OMITTED when a prior checkpoint exists
    expectBad(mkBadCkpt({ prevCkpt: undefined }),
      'prevCkpt does not reference the prior checkpoint',
      'omitted prevCkpt (prior ckpt exists) → bad-checkpoint')
    // (c) through does not advance past the prior checkpoint (== prior through)
    expectBad(mkBadCkpt({ through: 1 }),
      'through does not advance past the prior checkpoint',
      'through == prior through → bad-checkpoint')
    // the first branch ('stateDigest does not match the embedded state') is
    // covered by the forged-stateDigest test above, assert its detail too
    {
      const forged2 = clone(ckptEv1)
      forged2.body.payload.stateDigest = fakeId('forged')
      forged2.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(forged2.body), root.priv))
      const c = clone(base)
      c.events = c.events.map((e) => (e.body.type === 'ckpt' ? forged2 : e))
      const v = chain.verifyChain(c)
      ok(v.errors.some((e) => e.code === 'bad-checkpoint' && e.detail === 'stateDigest does not match the embedded state'),
        "detail: 'stateDigest does not match the embedded state'")
    }
  }
  console.log('\n· checkpoints: a4-v1 fold in-chain (alt-fold audit) …')
  {
    // verifyChain must audit an in-chain checkpoint under the fold its state
    // names (foldIdOfState → registry), not blindly recompute basic-v1.
    let c = chain.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000 })
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('a4-r1') }, 2000)
    const ckBasic = ckpt.makeCheckpointEvent(c, root.priv, rootB, 2100) // basic-v1
    c = chain.appendEvent(c, ckBasic)
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('a4-r2') }, 2200)
    const ckA4 = ckpt.makeCheckpointEvent(c, root.priv, rootB, 2300, a4.a4Fold)
    const cA4 = chain.appendEvent(c, ckA4)
    eq(ckA4.body.payload.state.f, 'a4-v1', 'a4 checkpoint state carries f=a4-v1')
    eq(chain.verifyChain(cA4).ok, true, 'chain with a basic-v1 AND an a4-v1 in-chain checkpoint verifies ok')
    ok(ckpt.verifyCheckpointDeep(cA4, ckA4), 'a4 checkpoint verifies deeply')
    ok(!ckpt.verifyCheckpointIncremental(cA4, ckA4), 'basic→a4 fold transition is NOT one-step-verifiable (deep only, by design)')
    // pure-a4 chain: incremental works a4→a4
    let p = chain.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000 })
    p = chain.appendWitnessed(p, root.priv, rootB, 'revoke', { pub: fakeId('a4-p1') }, 2000)
    const pk1 = ckpt.makeCheckpointEvent(p, root.priv, rootB, 2100, a4.a4Fold)
    p = chain.appendEvent(p, pk1)
    p = chain.appendWitnessed(p, root.priv, rootB, 'revoke', { pub: fakeId('a4-p2') }, 2200)
    const pk2 = ckpt.makeCheckpointEvent(p, root.priv, rootB, 2300, a4.a4Fold)
    p = chain.appendEvent(p, pk2)
    eq(chain.verifyChain(p).ok, true, 'pure-a4 two-checkpoint chain verifies ok')
    ok(ckpt.verifyCheckpointIncremental(p, pk2), 'a4→a4 checkpoint verifies incrementally')
    // tampered a4 state under a self-consistent digest → recomputation catches it
    const forged = clone(ckA4)
    const st = clone(forged.body.payload.state)
    st.n = st.n + 1
    forged.body.payload.state = st
    forged.body.payload.stateDigest = hash.toB64u(codec.canonicalHash(st))
    forged.sig = hash.toB64u(hash.ed25519.sign(codec.canonicalBytes(forged.body), root.priv))
    const cForged = chain.appendEvent(c, forged)
    ok(chain.verifyChain(cForged).errors.some((e) => e.code === 'bad-checkpoint' && e.detail === 'state recomputation mismatch'),
      'tampered a4 state in-chain → bad-checkpoint (state recomputation mismatch)')
  }
  console.log('\n· checkpoints: unknown / malformed fold ids fail closed …')
  {
    let c = chain.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000 })
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('u-r1') }, 2000)
    const headId = chain.verifyChain(c).witnessedHead
    const mkFoldCkpt = (state) => {
      const payload = { through: 1, state, stateDigest: hash.toB64u(codec.canonicalHash(state)) }
      const body = { v: 1, lane: 'w', type: 'ckpt', root: rootB, key: rootB, height: 2, prev: headId, ts: 3000, payload }
      return chain.appendEvent(clone(c), events.signBody(body, root.priv))
    }
    const vUnknown = chain.verifyChain(mkFoldCkpt({ f: 'nope-v9', n: 1 }))
    ok(vUnknown.errors.some((e) => e.code === 'bad-checkpoint' && e.detail === "unknown fold id 'nope-v9'"),
      'unregistered fold id in-chain → bad-checkpoint (unknown fold id)')
    const vMalformed = chain.verifyChain(mkFoldCkpt({ f: 7, n: 1 }))
    ok(vMalformed.errors.some((e) => e.code === 'bad-checkpoint' && e.detail === 'malformed fold id in checkpoint state'),
      'non-string fold id in-chain → bad-checkpoint (malformed fold id)')
    ok(!ckpt.verifyCheckpointDeep(mkFoldCkpt({ f: 'nope-v9', n: 1 }), mkFoldCkpt({ f: 'nope-v9', n: 1 }).events.at(-1)),
      'unknown fold id → deep verify false (fail closed) in checkpoint.ts too')
  }
  console.log('\n· segments in verifyChain: binding, dup-game, rated⇒a4 (A4 review F4) …')
  {
    const opp = kp(200)
    const wit = kp(160)
    const tc = { baseMs: 180000, incMs: 2000 }
    const mkRatedSeg = (n, color, opts = {}) => {
      const g = opts.game ?? hash.toB64u(hash.sha256(hash.utf8('f4-game' + n)))
      const tr = seg.transcriptDigest(g, [], '1-0', 'resign')
      const players = { w: color === 'w' ? rootB : opp.pubB, b: color === 'w' ? opp.pubB : rootB }
      const binding = { kind: 'chess', tc, players: opts.players ?? players, reason: 'resign' }
      const ws = seg.signWitnessEnd(wit.priv, wit.pubB, g, '1-0', 0, tr, binding)
      return seg.makeSegmentPayload({
        game: g, opp: opp.pubB, color, result: '1-0', reason: 'resign', moves: [],
        heads: { w: { head: g, height: n }, b: { head: g, height: n } },
        wstream: ws, oppProfile: { name: 'Opp' }, kind: 'chess', tc,
      })
    }
    let c = chain.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000 })
    c = chain.appendWitnessed(c, root.priv, rootB, 'segment', mkRatedSeg(1, 'w'), 2000)
    const auto = ckpt.makeCheckpointEvent(c, root.priv, rootB, 2100) // no fold arg
    eq(auto.body.payload.state.f, 'a4-v1', 'makeCheckpointEvent auto-selects a4-v1 on a rated chain (A4-10 builder side)')
    const cOk = chain.appendEvent(c, auto)
    eq(chain.verifyChain(cOk).ok, true, 'valid fully-bound rated segment chain verifies ok')
    // dup-game: SAME game key re-appended later (valid binding, new event)
    const gameKey1 = c.events.find((e) => e.body.type === 'segment').body.payload.game
    const cDup = chain.appendWitnessed(chain.clone ? chain.clone(cOk) : clone(cOk), root.priv, rootB, 'segment', mkRatedSeg(2, 'w', { game: gameKey1 }), 3000)
    hasCode(chain.verifyChain(cDup), 'dup-game', 'replayed game key in one chain → dup-game (A4-09)')
    // bad-segment: color flipped vs the witness-signed players
    const cFlip = chain.appendWitnessed(clone(cOk), root.priv, rootB, 'segment', { ...mkRatedSeg(3, 'w'), color: 'b' }, 3000)
    hasCode(chain.verifyChain(cFlip), 'bad-segment', 'color flipped against witness-signed players → bad-segment (A4-01)')
    // rated ⇒ a4: an explicit basic-v1 checkpoint over rated play is fraud
    const cBasic = chain.appendEvent(c, ckpt.makeCheckpointEvent(c, root.priv, rootB, 2100, ckpt.basicFold))
    const vBasic = chain.verifyChain(cBasic)
    ok(vBasic.errors.some((e) => e.code === 'bad-checkpoint' && e.detail === 'chain has rated segments: checkpoint must embed the a4-v1 fold'),
      'basic-v1 checkpoint covering rated segments → bad-checkpoint (A4-10)')
    ok(!ckpt.verifyCheckpointDeep(cBasic, cBasic.events[cBasic.events.length - 1]),
      'standalone deep verify also refuses the basic-v1-over-rated checkpoint')
  }
  console.log('\n· fold-transition checkpoints: deep fallback (A4-15) …')
  {
    // basic-v1 ckpt (unrated chain) → later a4-v1 ckpt = a fold transition:
    // incremental is false by design; cosignCheckpoint and selectCheckpoint
    // must take the deep fallback instead of skipping/refusing.
    let c = chain.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000 })
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('t-r1') }, 2000)
    c = chain.appendEvent(c, ckpt.makeCheckpointEvent(c, root.priv, rootB, 2100)) // basic (unrated)
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('t-r2') }, 2200)
    const trans = ckpt.makeCheckpointEvent(c, root.priv, rootB, 2300, a4.a4Fold)
    ok(!ckpt.verifyCheckpointIncremental(chain.appendEvent(c, trans), trans), 'transition ckpt: incremental false (by design)')
    const wit2 = kp(210)
    const att = attest.cosignCheckpoint(trans, chain.appendEvent(c, trans), wit2.pubB, wit2.priv, 2400)
    ok(att !== null, 'cosignCheckpoint takes the deep fallback on a fold transition (A4-15)')
    const withWit = clone(trans)
    withWit.wit = [att]
    const working = chain.appendEvent(c, withWit)
    const surf = viewer.selectCheckpoint(working)
    ok(surf !== null && surf.id === events.eventId(trans.body), 'selectCheckpoint surfaces the transition ckpt via deep fallback (A4-15)')
    eq(surf?.verified, 'deep', 'transition ckpt surfaced as deep-verified')
  }
  console.log('\n· checkpoints: N_CKPT cadence helper …')
  {
    let c = chain.createAccountChain({ rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000 })
    // genesis counts as 1 witnessed event; N_CKPT = 20
    for (let i = 0; i < 18; i++) c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId(`n${i}`) }, 4000 + i)
    eq(ckpt.dueForCheckpoint(c), false, '19 witnessed events → not yet due')
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('n18') }, 4018)
    eq(ckpt.dueForCheckpoint(c), true, '20 witnessed events → due (N_CKPT respected)')
    c = chain.appendEvent(c, ckpt.makeCheckpointEvent(c, root.priv, rootB, 4100))
    eq(ckpt.dueForCheckpoint(c), false, 'checkpoint resets the cadence')
    for (let i = 0; i < 19; i++) c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId(`m${i}`) }, 4200 + i)
    eq(ckpt.dueForCheckpoint(c), false, '19 events since the checkpoint → not due')
    c = chain.appendWitnessed(c, root.priv, rootB, 'revoke', { pub: fakeId('m19') }, 4300)
    eq(ckpt.dueForCheckpoint(c), true, '20 events since the checkpoint → due again')
    eq(chain.verifyChain(c).ok, true, 'the long cadence chain still verifies ok')
  }

  // ============================================================================
  // 8. personal-lane CRDT: concurrent devices, LWW, arrival-order independence
  // ============================================================================
  console.log('\n· personal-lane CRDT merge …')
  {
    let c = chain.createAccountChain({
      rootPriv: root.priv, rootPub: root.pub, displayName: 'Isaac', ts: 1000,
      device: { pub: devA.pubB, index: 0 },
    })
    c = chain.appendEvent(c, certs.makeCertEvent(root.priv, rootB, c, { childPub: devB.pubB, purpose: 0, index: 1, ts: 1001 }))
    // interleaved concurrent writes from two certified devices
    c = chain.appendPersonal(c, devA.priv, devA.pubB, 'profile', { fields: { bio: 'from A' } }, 5000)
    c = chain.appendPersonal(c, devB.priv, devB.pubB, 'profile', { fields: { bio: 'from B' } }, 5001)
    c = chain.appendPersonal(c, devA.priv, devA.pubB, 'profile', { fields: { country: 'US' } }, 5002)
    c = chain.appendPersonal(c, devB.priv, devB.pubB, 'profile', { fields: { country: 'NZ' } }, 4999)
    // ts tie on 'flair': merge order falls through to key comparison
    c = chain.appendPersonal(c, devA.priv, devA.pubB, 'profile', { fields: { flair: 'A-flair' } }, 6000)
    c = chain.appendPersonal(c, devB.priv, devB.pubB, 'profile', { fields: { flair: 'B-flair' } }, 6000)
    const v = chain.verifyChain(c)
    eq(v.ok, true, 'concurrent two-device chain verifies ok')
    eq(v.profile.bio, 'from B', 'LWW: later ts wins bio (5001 > 5000)')
    eq(v.profile.country, 'US', 'LWW: later ts wins country even though B arrived later (4999 < 5002)')
    const tieWinner = codec.compareKeys(devA.pubB, devB.pubB) > 0 ? 'A-flair' : 'B-flair'
    eq(v.profile.flair, tieWinner, 'ts tie broken deterministically by key order')
    // swap arrival order → identical digest and identical profile
    const swapped = { root: c.root, events: [...c.events].reverse() }
    const v2 = chain.verifyChain(swapped)
    eq(v2.digest, v.digest, 'swapped arrival order → bit-identical verify digest')
    eq(v2.profile.bio, 'from B', 'swapped arrival order → same LWW winner')
    ok(v.personalHeads.some((h) => h.key === devA.pubB && h.height === 2), 'devA per-key head at height 2')
    ok(v.personalHeads.some((h) => h.key === devB.pubB && h.height === 2), 'devB per-key head at height 2')
  }

  // ============================================================================
  // 9. event primitive sanity
  // ============================================================================
  console.log('\n· event primitives …')
  {
    const g = base.events[0]
    eq(events.eventId(g.body), hash.toB64u(codec.canonicalHash(g.body)), 'eventId = b64u(canonicalHash(body))')
    ok(events.verifyEventSig(g), 'verifyEventSig accepts a valid event')
    ok(!events.verifyEventSig({ body: g.body, sig: flip(g.sig) }), 'verifyEventSig rejects a flipped sig')
    ok(!events.verifyEventSig({ body: { ...g.body, ts: 999 }, sig: g.sig }), 'verifyEventSig rejects a modified body')
    ok(!events.verifyEventSig({ body: { ...g.body, payload: { ...g.body.payload, x: 1.5 } }, sig: g.sig }),
      'verifyEventSig returns false (no throw) on a non-canonical body')
  }

}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
