// Headless test for the A6 social core (src/shared/accounts/social/
// friends|profile.ts: spec §3 friend edges, §10 social surface).
//
//   node scripts/test-accounts-social.mjs
//
// Bundles the TS modules on the fly with esbuild (alias @shared → src/shared,
// same pattern as scripts/test-accounts-chain.mjs) and drives the lane
// contract: countersigned add verified on both sides, forged/absent/replayed
// countersigs refused, unilateral remove by either side + the mutual read,
// bit-identical re-folds, profile latest-wins + attested staleness, and the
// malformed-input fail-closed matrix. Synthetic fixtures only: no engine,
// no network. Keys are RAW fixed 32-byte seeds → ed25519 keypairs.

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
  ok(!vr.ok && got.includes(code), `${msg}${!vr.ok && got.includes(code) ? '' : ` (ok=${vr.ok}, codes=[${got}])`}`)
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-social-test')
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
  console.log('· bundling src/shared/accounts (social/friends|profile + chain kit) …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as events from '${SRC}/events.ts'`,
      `export * as certs from '${SRC}/certs.ts'`,
      `export * as chain from '${SRC}/chain.ts'`,
      `export * as attest from '${SRC}/witness/attest.ts'`,
      `export * as friends from '${SRC}/social/friends.ts'`,
      `export * as profile from '${SRC}/social/profile.ts'`,
      `export * as social from '${SRC}/social/index.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, 'social.mjs')
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
  const { codec, hash, events, certs, chain, attest, friends, profile, social } = M

  // ---- fixed raw keypairs -----------------------------------------------------
  const seed = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
  const kp = (b) => {
    const priv = seed(b)
    const pub = hash.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: hash.toB64u(pub) }
  }
  const A = kp(1) // subject
  const B = kp(30) // friend (root-signs the countersig)
  const C = kp(60) // friend (device-signs the countersig)
  const dA = kp(90) // A's device
  const dC = kp(120) // C's device
  const W = kp(150) // a witness key (attestations)
  const stranger = kp(180)
  const fakeId = (s) => hash.toB64u(hash.sha256(hash.utf8(s)))
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  const clone = (x) => structuredClone(x)

  const mkChain = (k, name, dev) =>
    chain.createAccountChain({
      rootPriv: k.priv,
      rootPub: k.pub,
      displayName: name,
      ts: 1000,
      ...(dev ? { device: { pub: dev.pubB, index: 0 } } : {}),
    })

  // ============================================================================
  // 1. schema sanity (zFriendPayload + registry rows)
  // ============================================================================
  console.log('\n· friend payload schema sanity …')
  {
    const sig = 'A'.repeat(86)
    eq(events.LANE_FOR.friend, 'w', "LANE_FOR.friend = 'w' (witnessed lane, §3)")
    ok(events.zFriendPayload.safeParse({ action: 'add', peer: fakeId('p'), key: fakeId('p'), sig }).success,
      'add with key+sig (root-signed shape) accepted')
    ok(events.zFriendPayload.safeParse({ action: 'remove', peer: fakeId('p') }).success,
      'bare remove accepted')
    ok(!events.zFriendPayload.safeParse({ action: 'add', peer: fakeId('p'), key: fakeId('p'), sig, x: 1 }).success,
      'zFriendPayload is .strict() (extra key rejected)')
    ok(!events.zFriendPayload.safeParse({ action: 'add', peer: fakeId('p'), key: fakeId('p') }).success,
      'add without sig rejected')
    ok(!events.zFriendPayload.safeParse({ action: 'add', peer: fakeId('p'), sig }).success,
      'add without key rejected')
    ok(!events.zFriendPayload.safeParse({ action: 'remove', peer: fakeId('p'), key: fakeId('p'), sig }).success,
      'remove carrying key+sig rejected')
    ok(!events.zFriendPayload.safeParse({ action: 'remove', peer: fakeId('p'), certs: [] }).success,
      'remove carrying certs rejected')
    ok(!events.zFriendPayload.safeParse({ action: 'befriend', peer: fakeId('p') }).success,
      'unknown action rejected')
    ok(!events.zFriendPayload.safeParse({ action: 'add', peer: 'short', key: fakeId('p'), sig }).success,
      'malformed peer key rejected')
    ok(!events.zFriendPayload.safeParse({ action: 'add', peer: fakeId('p'), key: fakeId('other'), sig }).success,
      'add with key ≠ peer but NO certs rejected (certs-iff-device rule)')
    ok(!events.zFriendPayload.safeParse({ action: 'add', peer: fakeId('p'), key: fakeId('p'), sig, certs: [] }).success,
      'add with key === peer but certs present rejected')
  }

  // ============================================================================
  // 2. countersigned add. Both sides verified (§3: two signatures per edge)
  // ============================================================================
  console.log('\n· countersigned add, root-signed both sides …')
  let cA = mkChain(A, 'Alice', dA)
  let cB = mkChain(B, 'Bob')
  const sigB_forAB = friends.makeFriendSig(B.priv, A.pubB, B.pubB) // B consents
  const sigA_forAB = friends.makeFriendSig(A.priv, B.pubB, A.pubB) // A consents (arg order immaterial)
  {
    cA = chain.appendWitnessed(cA, A.priv, A.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: B.pubB, key: B.pubB, sig: sigB_forAB }), 2000)
    cB = chain.appendWitnessed(cB, B.priv, B.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: A.pubB, key: A.pubB, sig: sigA_forAB }), 2001)
    eq(chain.verifyChain(cA).ok, true, "A's chain with the friend add verifies ok")
    eq(chain.verifyChain(cB).ok, true, "B's chain with the friend add verifies ok")
    const vA = friends.friendsOf(A.pubB, cA.events)
    const vB = friends.friendsOf(B.pubB, cB.events)
    eq(vA.friends.length, 1, "A's fold lists exactly one friend")
    eq(vA.friends[0], B.pubB, "A's fold lists B")
    eq(vB.friends[0], A.pubB, "B's fold lists A")
    ok(friends.areFriends(vA, vB), 'mutual read: A and B are friends')
    eq(vA.edges[0].state, 'add', "edge state is 'add'")
    eq(vA.edges[0].height, 1, 'edge decided at witnessed height 1')
    // authenticated read side
    const gA = friends.friendsOfChain(cA)
    ok(gA !== null && gA.friends[0] === B.pubB, 'friendsOfChain agrees on the verified chain')
    // both countersignatures cover IDENTICAL bytes (sorted pair rule)
    eq(Buffer.from(friends.friendBytes(A.pubB, B.pubB)).toString('hex'),
      Buffer.from(friends.friendBytes(B.pubB, A.pubB)).toString('hex'),
      'friendBytes is argument-order independent (one edge, one byte string)')
    ok(friends.verifyFriendAdd(cA.events.at(-1).body.payload, A.pubB), 'verifyFriendAdd accepts the real add')
    throws(() => friends.friendBytes(A.pubB, A.pubB), 'friendBytes refuses equal roots')
  }
  console.log('\n· countersigned add, device-key countersig with inline certs …')
  let cC = mkChain(C, 'Cara', dC)
  {
    const certEvC = cC.events.find((e) => e.body.type === 'cert') // C's root-signed cert of dC
    const sigDC = friends.makeFriendSig(dC.priv, A.pubB, C.pubB)
    const payload = friends.makeFriendAddPayload({ peer: C.pubB, key: dC.pubB, sig: sigDC, certs: [certEvC] })
    ok(friends.verifyFriendAdd(payload, A.pubB), 'device-signed countersig with inline cert verifies')
    // A6 review friends-2: certs:[] is NOT "certs supplied". The builder
    // refuses (a device-key add with empty certs would mint a payload the
    // fold permanently ignores), and the schema rejects it too (.min(1)).
    throws(
      () => friends.makeFriendAddPayload({ peer: C.pubB, key: dC.pubB, sig: sigDC, certs: [] }),
      'friends-2: builder refuses a device-key add with EMPTY certs',
    )
    ok(
      !events.zFriendPayload.safeParse({ action: 'add', peer: C.pubB, key: dC.pubB, sig: sigDC, certs: [] }).success,
      'friends-2: schema rejects certs:[] (min 1 when present)',
    )
    cA = chain.appendWitnessed(cA, dA.priv, dA.pubB, 'friend', payload, 2100) // A's DEVICE appends, too
    eq(chain.verifyChain(cA).ok, true, 'chain verifies with the device-countersigned add (device-appended)')
    // C's chain carries A's countersignature (the peer consents, §3)
    const sigA_forAC = friends.makeFriendSig(A.priv, C.pubB, A.pubB)
    // …and a WRONG-SIGNER sig (C signing its own edge) must NOT verify:
    ok(!friends.verifyFriendAdd(
      { action: 'add', peer: A.pubB, key: A.pubB, sig: friends.makeFriendSig(C.priv, C.pubB, A.pubB) }, C.pubB),
      "the subject's own signature presented as the peer's countersig → refused")
    cC = chain.appendWitnessed(cC, C.priv, C.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: A.pubB, key: A.pubB, sig: sigA_forAC }), 2101)
    const vA = friends.friendsOf(A.pubB, cA.events)
    const vC = friends.friendsOf(C.pubB, cC.events)
    eq(vA.friends.length, 2, "A's fold now lists two friends")
    ok(friends.areFriends(vA, vC), 'mutual read: A and C are friends')
    // friends list is compareKeys-sorted
    const sorted = [...vA.friends].sort(codec.compareKeys)
    ok(vA.friends.every((p, i) => p === sorted[i]), 'friends list is compareKeys-sorted')
    throws(() => friends.makeFriendAddPayload({ peer: C.pubB, key: dC.pubB, sig: sigDC }),
      'builder refuses a device-key add without certs')
    throws(() => friends.makeFriendAddPayload({ peer: C.pubB, key: C.pubB, sig: sigDC, certs: [certEvC] }),
      'builder refuses root-key add WITH certs (pointless material)')
  }

  // ============================================================================
  // 3. forged / absent / replayed countersigs refused (fail closed)
  // ============================================================================
  console.log('\n· forged countersig matrix …')
  {
    const good = friends.makeFriendAddPayload({ peer: B.pubB, key: B.pubB, sig: sigB_forAB })
    ok(!friends.verifyFriendAdd({ ...good, sig: flip(good.sig) }, A.pubB), 'flipped countersig → refused')
    ok(!friends.verifyFriendAdd({ ...good, key: stranger.pubB }, A.pubB),
      'key swapped to a stranger (≠ peer, no certs) → refused')
    const sigStranger = friends.makeFriendSig(stranger.priv, A.pubB, B.pubB)
    ok(!friends.verifyFriendAdd({ ...good, sig: sigStranger }, A.pubB),
      "stranger's signature under the peer's key → refused")
    // replay into another pair: B's sig for (A,B) presented in STRANGER's chain
    ok(!friends.verifyFriendAdd(good, stranger.pubB),
      "replayed countersig into a different pair → refused (bytes bind both roots)")
    // self-edge
    const sigSelf = friends.makeFriendSig(A.priv, A.pubB, B.pubB)
    ok(!friends.verifyFriendAdd({ action: 'add', peer: A.pubB, key: A.pubB, sig: sigSelf }, A.pubB),
      'self-edge → refused')
    // certs proving the WRONG key
    const certEvC = cC.events.find((e) => e.body.type === 'cert')
    const sigDC = friends.makeFriendSig(dC.priv, A.pubB, C.pubB)
    ok(!friends.verifyFriendAdd(
      { action: 'add', peer: C.pubB, key: stranger.pubB, sig: sigDC, certs: [clone(certEvC)] }, A.pubB),
      'inline cert proves a different key than `key` → refused')
    // cert signed by the WRONG root (A certifies dC, but peer is C)
    const bogusCert = clone(cA.events.find((e) => e.body.type === 'cert'))
    ok(!friends.verifyFriendAdd(
      { action: 'add', peer: C.pubB, key: dA.pubB, sig: sigDC, certs: [bogusCert] }, A.pubB),
      "cert root-signed by a DIFFERENT root than peer → refused")
    // tampered inline cert
    const tampered = clone(certEvC)
    tampered.sig = flip(tampered.sig)
    ok(!friends.verifyFriendAdd(
      { action: 'add', peer: C.pubB, key: dC.pubB, sig: sigDC, certs: [tampered] }, A.pubB),
      'inline cert with a broken event signature → refused')
    // an in-chain add with a forged countersig: chain stays valid, fold ignores
    const forged = { action: 'add', peer: B.pubB, key: B.pubB, sig: flip(sigB_forAB) }
    const cForged = chain.appendWitnessed(clone(cA), A.priv, A.pubB, 'friend', forged, 2200)
    eq(chain.verifyChain(cForged).ok, true, 'chain carrying a forged-countersig add still verifies (fold rule, not chain rule)')
    const vForged = friends.friendsOf(A.pubB, cForged.events)
    ok(vForged.friends.includes(B.pubB),
      'IGNORED means ignored: the forged later add does not disturb the earlier verified edge')
    eq(vForged.edges.find((e) => e.peer === B.pubB).height, 1,
      'edge state still decided by the earlier verified add (height 1)')
    // a forged add for a NEVER-added peer establishes nothing
    const forged2 = { action: 'add', peer: stranger.pubB, key: stranger.pubB, sig: flip(sigB_forAB) }
    const cForged2 = chain.appendWitnessed(clone(cA), A.priv, A.pubB, 'friend', forged2, 2300)
    ok(!friends.friendsOf(A.pubB, cForged2.events).friends.includes(stranger.pubB),
      'forged add for a new peer never establishes an edge')
  }

  // ============================================================================
  // 4. remove. Unilateral by either side; the mutual read; re-add
  // ============================================================================
  console.log('\n· remove by either side + mutual read …')
  {
    // B removes A: B's OWN chain flips; A's chain is untouched
    const cB2 = chain.appendWitnessed(clone(cB), B.priv, B.pubB, 'friend',
      friends.makeFriendRemovePayload(A.pubB), 3000)
    eq(chain.verifyChain(cB2).ok, true, 'chain with the remove verifies ok')
    const vA = friends.friendsOf(A.pubB, cA.events)
    const vB2 = friends.friendsOf(B.pubB, cB2.events)
    ok(!vB2.friends.includes(A.pubB), "B's fold no longer lists A after the remove")
    eq(vB2.edges.find((e) => e.peer === A.pubB).state, 'remove', "B's edge state for A is 'remove'")
    ok(vA.friends.includes(B.pubB), "A's chain still asserts the edge (its owner never removed)")
    ok(!friends.areFriends(vA, vB2), 'mutual read: NOT friends once either side removes')
    // stale-countersig resurrection attempt (§0): A re-adds with B's OLD sig
    const cA2 = chain.appendWitnessed(clone(cA), A.priv, A.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: B.pubB, key: B.pubB, sig: sigB_forAB }), 3100)
    const vA2 = friends.friendsOf(A.pubB, cA2.events)
    ok(vA2.friends.includes(B.pubB), "the replayed add IS locally valid (consent at assertion time)")
    ok(!friends.areFriends(vA2, vB2),
      "…but the mutual read stays false. A stale countersig cannot resurrect an edge the peer removed")
    // remove by the OTHER side symmetric
    const cA3 = chain.appendWitnessed(clone(cA), A.priv, A.pubB, 'friend',
      friends.makeFriendRemovePayload(B.pubB), 3200)
    ok(!friends.areFriends(friends.friendsOf(A.pubB, cA3.events), friends.friendsOf(B.pubB, cB.events)),
      "remove by A alone also breaks the mutual read")
    // re-add after removal: BOTH sides re-add → friends again
    const cB3 = chain.appendWitnessed(clone(cB2), B.priv, B.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: A.pubB, key: A.pubB, sig: sigA_forAB }), 3300)
    const vB3 = friends.friendsOf(B.pubB, cB3.events)
    eq(vB3.edges.find((e) => e.peer === A.pubB).state, 'add', 're-add after remove: latest state wins')
    ok(friends.areFriends(vA2, vB3), 'both sides re-added → friends again (mutual read true)')
    // remove for a never-added peer is inert
    const cB4 = chain.appendWitnessed(clone(cB), B.priv, B.pubB, 'friend',
      friends.makeFriendRemovePayload(stranger.pubB), 3400)
    ok(!friends.friendsOf(B.pubB, cB4.events).friends.includes(stranger.pubB),
      'remove of a never-added peer stays a non-edge')
    ok(friends.friendsOf(B.pubB, cB4.events).friends.includes(A.pubB),
      '…and does not disturb other edges')
    // self-mutual: a view is never friends with itself
    ok(!friends.areFriends(vA, vA), 'areFriends(x, x) is false')
  }

  // ============================================================================
  // 5. deterministic re-fold, bit-identical across storage order and rebuilds
  // ============================================================================
  console.log('\n· deterministic re-fold …')
  {
    const digestOf = (view) => hash.toB64u(codec.canonicalHash(view))
    const d1 = digestOf(friends.friendsOf(A.pubB, cA.events))
    const d2 = digestOf(friends.friendsOf(A.pubB, [...cA.events].reverse()))
    const rot = [...cA.events.slice(4), ...cA.events.slice(0, 4)]
    const d3 = digestOf(friends.friendsOf(A.pubB, rot))
    eq(d1, d2, 'reversed storage order → bit-identical FriendView digest')
    eq(d1, d3, 'rotated storage order → bit-identical FriendView digest')
    // a fully independent rebuild of the same logical chain folds identically
    let r = mkChain(A, 'Alice', dA)
    r = chain.appendWitnessed(r, A.priv, A.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: B.pubB, key: B.pubB, sig: sigB_forAB }), 2000)
    const certEvC = cC.events.find((e) => e.body.type === 'cert')
    const sigDC = friends.makeFriendSig(dC.priv, A.pubB, C.pubB)
    r = chain.appendWitnessed(r, dA.priv, dA.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: C.pubB, key: dC.pubB, sig: sigDC, certs: [certEvC] }), 2100)
    eq(digestOf(friends.friendsOf(A.pubB, r.events)), d1, 'independent rebuild → bit-identical FriendView digest')
    eq(digestOf(friends.friendsOf(A.pubB, r.events)), digestOf(friends.friendsOfChain(r)),
      'friendsOfChain and friendsOf agree bit-identically on a verified chain')
  }

  // ============================================================================
  // 6. profile: builder, latest-wins, attested staleness
  // ============================================================================
  console.log('\n· profile builder + latest-wins fold …')
  {
    throws(() => profile.makeProfilePayload({ bio: 'x'.repeat(501) }), 'builder refuses bio over BIO_MAX')
    const p = profile.makeProfilePayload({ bio: 'hi', country: 'US' })
    ok(events.zProfilePayload.safeParse(p).success, 'built payload satisfies zProfilePayload')
    let c = mkChain(A, 'Alice', dA)
    c = chain.appendPersonal(c, A.priv, A.pubB, 'profile', profile.makeProfilePayload({ bio: 'first', country: 'US' }), 5000)
    c = chain.appendPersonal(c, dA.priv, dA.pubB, 'profile', profile.makeProfilePayload({ bio: 'second' }), 5001)
    c = chain.appendPersonal(c, dA.priv, dA.pubB, 'profile', profile.makeProfilePayload({ flair: 'knight' }), 4000)
    const view = profile.profileView(c)
    ok(view !== null, 'profileView renders a verified chain')
    eq(view.name, 'Alice', 'name comes from the verified genesis')
    eq(view.root, A.pubB, 'view binds the root')
    eq(view.fields.bio, 'second', 'latest-wins: later ts wins bio across devices')
    eq(view.fields.country, 'US', 'untouched field folds through')
    eq(view.fields.flair, 'knight', 'earlier-ts write of an untouched field folds through')
    eq(view.lastWitnessedActivity, null, 'no attestations anywhere → lastWitnessedActivity null (NEVER body.ts)')
    // fail closed on an unverifiable chain
    const broken = clone(c)
    broken.events[1].sig = flip(broken.events[1].sig)
    eq(profile.profileView(broken), null, 'profileView refuses a chain that fails verification')
    eq(friends.friendsOfChain(broken), null, 'friendsOfChain refuses the same broken chain')
  }
  console.log('\n· staleness: lastWitnessedActivity from verified attestations only …')
  {
    let c = mkChain(A, 'Alice', dA)
    c = chain.appendWitnessed(c, A.priv, A.pubB, 'friend',
      friends.makeFriendAddPayload({ peer: B.pubB, key: B.pubB, sig: sigB_forAB }), 9_999_999)
    const withWit = clone(c)
    const attach = (ev, wts) => {
      ev.wit = [...(ev.wit ?? []), attest.makeAttestation(events.eventId(ev.body), 0, W.pubB, W.priv, wts)]
    }
    attach(withWit.events[0], 5000) // genesis attested at 5000
    attach(withWit.events.at(-1), 9000) // friend add attested at 9000
    attach(withWit.events.at(-1), 100) // an older co-attestation
    eq(chain.verifyChain(withWit).ok, true, 'attested chain still verifies')
    eq(profile.lastWitnessedActivityOf(withWit.events), 9000, 'max verified attested wts wins (9000)')
    eq(profile.profileView(withWit).lastWitnessedActivity, 9000, 'profileView surfaces the attested staleness')
    ok(profile.lastWitnessedActivityOf(withWit.events) !== 9_999_999,
      'author-claimed body.ts is NEVER the staleness source (§4)')
    // forged attestation → ignored; only-forged → null
    const forged = clone(c)
    attach(forged.events[0], 7000)
    forged.events[0].wit[0].sig = flip(forged.events[0].wit[0].sig)
    eq(profile.lastWitnessedActivityOf(forged.events), null, 'flipped attestation sig → ignored → null')
    const tamperedWts = clone(c)
    attach(tamperedWts.events[0], 7000)
    tamperedWts.events[0].wit[0].wts = 8_888_888 // lie about the time after signing
    eq(profile.lastWitnessedActivityOf(tamperedWts.events), null, 'tampered wts breaks the binding → null')
    // attestation lifted from a DIFFERENT event → refused (bound to event id)
    const lifted = clone(withWit)
    lifted.events[0].wit = [clone(withWit.events.at(-1).wit[0])] // 9000-att moved onto genesis
    lifted.events.at(-1).wit = undefined
    eq(profile.lastWitnessedActivityOf(lifted.events), null,
      'attestation moved to a different event fails its id binding → null')
  }

  // ============================================================================
  // 7. malformed-input fail-closed matrix
  // ============================================================================
  console.log('\n· malformed in-chain friend events → bad-payload …')
  {
    const base = mkChain(A, 'Alice', dA)
    const head = chain.verifyChain(base)
    const mk = (payload) => {
      const body = {
        v: 1, lane: 'w', type: 'friend', root: A.pubB, key: A.pubB,
        height: 1, prev: head.witnessedHead, ts: 2000, payload,
      }
      const c = clone(base)
      c.events.push(events.signBody(body, A.priv))
      return chain.verifyChain(c)
    }
    hasCode(mk({ action: 'add', peer: B.pubB }), 'bad-payload', 'in-chain add without key+sig → bad-payload')
    hasCode(mk({ action: 'remove', peer: B.pubB, sig: 'A'.repeat(86), key: B.pubB }), 'bad-payload',
      'in-chain remove carrying countersig material → bad-payload')
    hasCode(mk({ action: 'nope', peer: B.pubB }), 'bad-payload', 'in-chain unknown action → bad-payload')
    hasCode(mk({ action: 'add', peer: B.pubB, key: stranger.pubB, sig: 'A'.repeat(86) }), 'bad-payload',
      'in-chain device-key add without certs → bad-payload')
    const vSelf = mk({ action: 'add', peer: A.pubB, key: A.pubB, sig: 'A'.repeat(86) })
    hasCode(vSelf, 'bad-payload', 'in-chain SELF-edge → bad-payload (superRefine)')
    ok(vSelf.errors.some((e) => e.detail === 'friend event peer must not be the chain root'),
      'self-edge detail is the stable hand-written string')
    throws(() => chain.appendWitnessed(clone(base), A.priv, A.pubB, 'friend',
      { action: 'add', peer: A.pubB, key: A.pubB, sig: 'A'.repeat(86) }, 2000),
      'appendWitnessed refuses the self-edge outright')
  }
  console.log('\n· fold + verifier totality on garbage …')
  {
    ok(!friends.verifyFriendAdd(null, A.pubB), 'verifyFriendAdd(null) → false, no throw')
    ok(!friends.verifyFriendAdd(42, A.pubB), 'verifyFriendAdd(number) → false')
    ok(!friends.verifyFriendAdd({ action: 'remove', peer: B.pubB }, A.pubB), 'verifyFriendAdd on a remove → false')
    const garbage = [
      null, 42, {}, { body: null }, { body: {} },
      { body: { lane: 'w', type: 'friend', root: A.pubB, height: 0.5, ts: 1, payload: {} }, sig: 'x' },
      { body: { v: 1, lane: 'w', type: 'friend', root: A.pubB, key: A.pubB, height: 1, ts: 1, payload: { x: 1.5 } }, sig: 'A'.repeat(86) },
    ]
    let view = null
    let threw = false
    try {
      view = friends.friendsOf(A.pubB, garbage)
    } catch {
      threw = true
    }
    ok(!threw, 'friendsOf never throws on garbage event lists')
    eq(view?.friends.length, 0, 'garbage folds to an empty friend set')
    let staleThrew = false
    let stale = 0
    try {
      stale = profile.lastWitnessedActivityOf(garbage)
    } catch {
      staleThrew = true
    }
    ok(!staleThrew && stale === null, 'lastWitnessedActivityOf on garbage → null, no throw')
    throws(() => profile.makeProfilePayload({ website: 'x' }), 'unknown profile field refused by the builder')
    throws(() => friends.makeFriendRemovePayload('not-a-key'), 'remove builder refuses a malformed peer key')
    // social/index re-exports both modules
    ok(typeof social.friendsOf === 'function' && typeof social.profileView === 'function',
      'social/index.ts re-exports the friends + profile surface')
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
