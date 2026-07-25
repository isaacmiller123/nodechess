// Web-accounts packaging + determinism oracle (phase A1, stage 2).
//
//   node scripts/test-web-accounts.mjs
//
// Four jobs, no browser required (the REAL browser gate is
// scripts/test-web-accounts-browser.mjs):
//
//  1. BUNDLE PARITY: the shared accounts tree is bundled TWICE from one
//     fixture entry (esbuild platform=node and platform=browser, esm both,
//     nothing stubbed: zero node built-ins in the tree IS the assertion),
//     both bundles run under this node process, and every emitted digest
//     (argon2 seed, tag, chain bytes, verify digest) must be byte-identical
//     field by field AND match the goldens recorded from the stage-1 suites.
//  2. BUILTIN LEAK SCAN. The browser bundle text must contain no require()
//     of node builtins and no 'node:' imports.
//  3. KEYRING: MemoryKeyStore, StorageLikeKeyStore (over a localStorage-
//     shaped fake), and the Keyring account/chain persistence rules
//     (namespacing, seed opt-in, remove-account-keeps-chain).
//  4. WEB GLUE, src/web/accounts.ts bundled with stubbed localStorage +
//     navigator: createAccount / signIn (never creates!) / signOut /
//     exportMnemonic / exportKeyfile / verifyOwnChain semantics.
//
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).

import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import {
  GOLDENS,
  FIXTURE_ENTRY_TS,
  bundleFixture,
  findNodeBuiltinRefs,
} from './lib/accounts-fixture.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

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
async function throwsAsync(fn, msg) {
  try {
    await fn()
    ok(false, `${msg} (did not throw)`)
    return null
  } catch (e) {
    ok(true, msg)
    return e
  }
}

/** localStorage-shaped fake (the StorageLike structural contract). */
function makeFakeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(String(k), String(v))
    },
    removeItem: (k) => {
      map.delete(k)
    },
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
    _map: map,
  }
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/web-accounts-test')
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
  // ==========================================================================
  // 1+2. bundle parity: one fixture, two platforms, identical bytes
  // ==========================================================================
  console.log('· bundling the fixture entry for platform=node and platform=browser …')
  const entry = resolve(outdir, 'fixture.entry.ts')
  writeFileSync(entry, FIXTURE_ENTRY_TS + `\nexport * as lib from '@shared/accounts'\n`)
  const nodeOut = resolve(outdir, 'fixture.node.mjs')
  const browserOut = resolve(outdir, 'fixture.browser.mjs')
  await bundleFixture(entry, nodeOut, 'node')
  await bundleFixture(entry, browserOut, 'browser')
  ok(true, 'browser bundle built with nothing stubbed (zero node built-ins in the tree)')

  console.log('\n· builtin leak scan on the browser bundle …')
  {
    const text = readFileSync(browserOut, 'utf8')
    const hits = findNodeBuiltinRefs(text)
    eq(hits.length, 0, `browser bundle has no node-builtin require()/node: imports${hits.length ? `: ${hits.slice(0, 3).join(' | ')}` : ''}`)
    ok(!/\bfrom\s*["']node:/.test(text), "browser bundle text carries no 'node:' import specifiers")
  }

  console.log('\n· running BOTH bundles under node (argon2id runs twice, a few seconds) …')
  const nodeMod = await import(pathToFileURL(nodeOut).href)
  const browserMod = await import(pathToFileURL(browserOut).href)
  const rNode = await nodeMod.runFixture()
  const rBrowser = await browserMod.runFixture()

  console.log('\n· field-by-field parity between the two bundles …')
  {
    const fields = Object.keys(rNode).sort()
    eq(fields.join(','), Object.keys(rBrowser).sort().join(','), 'both runs emit the same field set')
    for (const f of fields) {
      eq(rBrowser[f], rNode[f], `platform parity: ${f}`)
    }
  }

  console.log('\n· goldens (recorded from the stage-1 suites + this suite) …')
  {
    eq(rNode.paramsDigest, GOLDENS.paramsDigest, 'paramsDigest matches the FROZEN-AT-GENESIS golden')
    eq(rNode.seedHex, GOLDENS.seedHex, 'argon2id seed matches the core-suite KAT')
    eq(rNode.tag, GOLDENS.tag, `tag is '${GOLDENS.tag}' (core-suite KAT)`)
    eq(rNode.verifyOk, true, 'golden fixture chain verifies ok')
    eq(rNode.verifyDigest, GOLDENS.chainVerifyDigest, 'verify digest matches the chain-suite GOLDEN_VERIFY_DIGEST')
    eq(rNode.chainFileSha256, GOLDENS.chainFileSha256, 'chain file sha256 matches the chain-suite GOLDEN_FILE_SHA256')
    eq(rNode.identityVerifyOk, true, 'identity-derived chain verifies ok')
    eq(rNode.identityVerifyDigest, GOLDENS.identityChainVerifyDigest,
      `identity-chain verify digest matches its golden${rNode.identityVerifyDigest !== GOLDENS.identityChainVerifyDigest ? ` (got ${rNode.identityVerifyDigest})` : ''}`)
    eq(rNode.identityChainFileSha256, GOLDENS.identityChainFileSha256,
      `identity-chain file sha256 matches its golden${rNode.identityChainFileSha256 !== GOLDENS.identityChainFileSha256 ? ` (got ${rNode.identityChainFileSha256})` : ''}`)
  }

  console.log('\n· unicode display-name fixture (Zoë / pâsswörd, NFC and NFD inputs) …')
  {
    eq(rNode.unicodeFoldedName, 'zo\u00eb', "unicode name folds to 'zo\u00eb' (NFC, casefolded)")
    eq(rNode.unicodeSeedHex, GOLDENS.unicodeSeedHex, 'unicode argon2id seed matches its golden')
    eq(rNode.unicodeNfdSeedHex, rNode.unicodeSeedHex,
      'NFD name + NFD password input derives the IDENTICAL seed (one account, no silent lockout)')
    eq(rNode.unicodeTag, GOLDENS.unicodeTag, `unicode tag is '${GOLDENS.unicodeTag}'`)
    eq(rNode.unicodeVerifyOk, true, 'unicode identity-derived chain verifies ok')
    eq(rNode.unicodeVerifyDigest, GOLDENS.unicodeChainVerifyDigest, 'unicode chain verify digest matches its golden')
    eq(rNode.unicodeChainFileSha256, GOLDENS.unicodeChainFileSha256, 'unicode chain file sha256 matches its golden')
  }

  console.log('\n· A3/A4 parity fixture (detmath, RS, routing, a4 fold) …')
  {
    eq(rNode.detmathDigest, GOLDENS.detmathDigest, 'detmath float64 bit-grid digest matches its golden')
    eq(rNode.rsRoundtripOk, true, 'RS 12-of-40 reconstruct is byte-identical to the source blob')
    eq(rNode.rsDigest, GOLDENS.rsDigest, 'RS shard+reconstruct digest matches its golden')
    eq(rNode.routingDigest, GOLDENS.routingDigest, 'overlay k-bucket routing digest matches its golden')
    eq(rNode.a4ParamsDigest, GOLDENS.a4ParamsDigest, 'PARAMS_A4 digest matches its golden')
    eq(rNode.a4VerifyOk, true, 'rated a4 fixture chain verifies ok')
    eq(rNode.a4CkptDeepOk, true, 'a4-v1 checkpoint verifies deeply')
    eq(rNode.a4StateHash, GOLDENS.a4StateHash, 'a4-v1 fold state hash matches its golden')
  }

  // ==========================================================================
  // 3. keyring: stores + persistence rules
  // ==========================================================================
  const L = nodeMod.lib
  console.log('\n· MemoryKeyStore …')
  {
    const s = new L.MemoryKeyStore()
    eq(await s.get('acct.v1.x'), null, 'get on empty store → null')
    await s.set('acct.v1.a.one', Uint8Array.of(1, 2, 3))
    await s.set('acct.v1.a.two', Uint8Array.of(4))
    await s.set('other.key', Uint8Array.of(5))
    const got = await s.get('acct.v1.a.one')
    eq(Array.from(got).join(','), '1,2,3', 'set/get roundtrips bytes')
    got[0] = 99
    eq(Array.from(await s.get('acct.v1.a.one')).join(','), '1,2,3', 'returned bytes are a copy (no aliasing)')
    eq((await s.list('acct.v1.a.')).join('|'), 'acct.v1.a.one|acct.v1.a.two', 'list(prefix) filters + sorts')
    await s.del('acct.v1.a.one')
    eq((await s.list('acct.v1.a.')).join('|'), 'acct.v1.a.two', 'del removes the key')
  }

  console.log('\n· StorageLikeKeyStore over a localStorage-shaped fake …')
  {
    const fake = makeFakeStorage()
    const s = new L.StorageLikeKeyStore(fake)
    // odd byte lengths exercise every base64 tail case
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff)
      await s.set(`acct.v1.t.${n}`, bytes)
      const back = await s.get(`acct.v1.t.${n}`)
      eq(Array.from(back).join(','), Array.from(bytes).join(','), `${n}-byte value roundtrips`)
    }
    eq(await s.get('acct.v1.missing'), null, 'missing key → null')
    eq((await s.list('acct.v1.t.')).length, 7, 'list(prefix) sees all 7 entries')
    await s.del('acct.v1.t.0')
    eq((await s.list('acct.v1.t.')).length, 6, 'del removes an entry')
    ok(typeof fake.getItem('acct.v1.t.32') === 'string', 'values are stored as strings (Storage contract)')
    // codec sanity straight from the module
    const { encodeB64, decodeB64 } = L._storageValueCodec
    const roundtrip = decodeB64(encodeB64(Uint8Array.of(0, 255, 128, 7)))
    eq(Array.from(roundtrip).join(','), '0,255,128,7', 'storage value codec roundtrips raw bytes')
  }

  console.log('\n· Keyring: accounts + chains …')
  {
    const store = new L.MemoryKeyStore()
    const ring = new L.Keyring(store)
    // build a real chain + account from fixed raw seeds (no argon2 needed)
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (7 + i) & 0xff)
    const pub = L.ed25519.getPublicKey(priv)
    const rootB = L.toB64u(pub)
    const dPriv = Uint8Array.from({ length: 32 }, (_, i) => (77 + i) & 0xff)
    const dPub = L.toB64u(L.ed25519.getPublicKey(dPriv))
    const chain = L.createAccountChain({
      rootPriv: priv, rootPub: pub, displayName: 'RingUser', ts: 1000,
      device: { pub: dPub, index: 0, label: 'Test' },
    })
    const certEv = chain.events.find((e) => e.body.type === 'cert')
    const acct = {
      v: 1, foldedName: 'ringuser', displayName: 'RingUser', tag: L.tagOf(pub),
      rootPub: rootB, device: { index: 0, pub: dPub, certEvent: L.eventId(certEv.body) },
    }
    eq(await ring.getAccount('ringuser'), null, 'getAccount before save → null')
    await ring.saveAccount(acct)
    const back = await ring.getAccount('ringuser')
    eq(back.displayName, 'RingUser', 'account record roundtrips displayName')
    eq(back.rootPub, rootB, 'account record roundtrips rootPub')
    eq(back.seedB64u, undefined, 'seed NOT stored by default (opt-in only)')
    ok((await store.list('acct.v1.')).every((k) => k.startsWith('acct.v1.')), "all keys namespaced 'acct.v1.'")

    await ring.saveChain(rootB, chain)
    const loaded = await ring.loadChain(rootB)
    eq(L.verifyChain(loaded).digest, L.verifyChain(chain).digest, 'saved→loaded chain verifies to the identical digest')
    eq(L.toB64u(L.chainToBytes(loaded)), L.toB64u(L.chainToBytes(chain)), 'chain bytes roundtrip bit-exactly')
    eq(await ring.loadChain(L.toB64u(L.sha256(L.utf8('nobody')))), null, 'loadChain for an unknown root → null')

    await throwsAsync(() => ring.saveChain(dPub, chain), 'saveChain with a mismatched root throws')
    await throwsAsync(() => ring.saveAccount({ ...acct, tag: 'bad!' }), 'saveAccount rejects an invalid record (zod strict)')

    // seed opt-in
    const acct2 = { ...acct, foldedName: 'ringuser2', seedB64u: L.toB64u(priv) }
    await ring.saveAccount(acct2)
    eq((await ring.getAccount('ringuser2')).seedB64u, L.toB64u(priv), 'explicit seedB64u opt-in is persisted')
    const names = (await ring.listAccounts()).map((a) => a.foldedName)
    eq(names.join('|'), 'ringuser|ringuser2', 'listAccounts returns both, sorted by foldedName')

    await ring.removeAccount('ringuser')
    eq(await ring.getAccount('ringuser'), null, 'removeAccount removes the record')
    ok((await ring.loadChain(rootB)) !== null, 'removeAccount does NOT remove the chain (the self-carried file stays)')
    await ring.removeChain(rootB)
    eq(await ring.loadChain(rootB), null, 'removeChain (separate, deliberate) removes the chain')

    // records are keyed (foldedName, tag): two identities sharing a folded
    // name coexist, tag-less lookups on the pair throw AmbiguousAccountError
    const acct3 = { ...acct, tag: 'AAAAA' }
    const acct4 = { ...acct, tag: 'BBBBB' }
    await ring.saveAccount(acct3)
    await ring.saveAccount(acct4)
    eq((await ring.getAccount('ringuser', 'AAAAA')).tag, 'AAAAA', 'getAccount with tag is exact (AAAAA)')
    eq((await ring.getAccount('ringuser', 'BBBBB')).tag, 'BBBBB', 'getAccount with tag is exact (BBBBB)')
    eq(await ring.getAccount('ringuser', 'CCCCC'), null, 'getAccount with an unknown tag → null')
    const ambErr = await throwsAsync(() => ring.getAccount('ringuser'), 'tag-less getAccount over two identities throws')
    ok(ambErr && ambErr.name === 'AmbiguousAccountError', 'the throw is a typed AmbiguousAccountError')
    eq(ambErr && ambErr.tags.join('|'), 'AAAAA|BBBBB', 'AmbiguousAccountError lists both tags (sorted)')
    await throwsAsync(() => ring.removeAccount('ringuser'), 'tag-less removeAccount over two identities throws too')
    await ring.removeAccount('ringuser', 'AAAAA')
    eq((await ring.getAccount('ringuser')).tag, 'BBBBB', 'after tagged removal the sole survivor resolves tag-less')
    await ring.removeAccount('ringuser')
    eq(await ring.getAccount('ringuser'), null, 'sole-match tag-less removeAccount works')

    // corrupt stored bytes must throw on load, not deserialize garbage
    await store.set('acct.v1.a.corrupt#AAAAA', L.utf8('{"not":"an account"}'))
    await throwsAsync(() => ring.getAccount('corrupt'), 'corrupt account record throws on read')
    await throwsAsync(() => ring.getAccount('corrupt', 'AAAAA'), 'corrupt account record throws on tagged read too')
    await store.set(`acct.v1.c.${rootB}`, L.utf8('{"v":1'))
    await throwsAsync(() => ring.loadChain(rootB), 'corrupt chain bytes throw on load (strict file format)')
  }

  // ==========================================================================
  // 4. web glue (src/web/accounts.ts) under stubbed localStorage + navigator
  // ==========================================================================
  console.log('\n· bundling src/web/accounts.ts (the web glue) …')
  const glueEntry = resolve(outdir, 'glue.entry.ts')
  writeFileSync(
    glueEntry,
    `export * from '${resolve(ROOT, 'src/web/accounts.ts').replace(/\\/g, '/')}'\n` +
      `export { mnemonicToSeed, parseKeyfile, fromB64u } from '@shared/accounts'\n`,
  )
  const glueOut = resolve(outdir, 'glue.mjs')
  await bundleFixture(glueEntry, glueOut, 'node')

  const fakeLS = makeFakeStorage()
  globalThis.localStorage = fakeLS
  // node ≥21 defines globalThis.navigator as getter-only: defineProperty it.
  const FIXED_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: FIXED_UA },
    configurable: true,
  })
  globalThis.window = globalThis
  const G = await import(pathToFileURL(glueOut).href)

  console.log('\n· device label from the user agent …')
  {
    eq(G.shortDeviceLabel(globalThis.navigator.userAgent), 'Chrome on macOS', 'UA → short label (Chrome on macOS)')
    eq(G.shortDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/128.0'),
      'Firefox on Windows', 'UA → Firefox on Windows')
    eq(G.shortDeviceLabel(''), 'Browser', 'empty UA → generic label')
    ok(G.shortDeviceLabel('x'.repeat(500)).length <= 64, 'label capped at the cert-label limit (64)')
  }

  console.log('\n· createAccount (offline, derive → chain → persist) …')
  {
    eq(G.getState().signedIn, false, 'starts signed out')
    const st = await G.createAccount('TestUser', 'correct horse battery staple')
    eq(st.signedIn, true, 'createAccount signs in')
    eq(st.tag, GOLDENS.tag, `createAccount derives the KAT tag '${GOLDENS.tag}'`)
    eq(st.handle, `TestUser#${GOLDENS.tag}`, 'handle is name#TAG with original casing')
    eq(st.foldedName, 'testuser', 'folded name is the casefold form')
    ok(typeof globalThis.window.__chessAccounts === 'object', 'window.__chessAccounts dev surface is exposed')
    ok([...fakeLS._map.keys()].every((k) => k.startsWith('acct.v1.')), 'all persisted keys namespaced acct.v1.')
    const acct = await G.keyring().getAccount('testuser')
    eq(acct.seedB64u, undefined, 'seed NOT persisted without the explicit opt-in')
    eq(acct.device.index, 0, 'device child index 0 enrolled')
    const vr = await G.verifyOwnChain()
    eq(vr.ok, true, 'persisted chain verifies ok (headless proof)')
    eq(vr.activeKeys.length, 1, 'one active (device) key at head')
    eq(vr.witnessedHeight, 0, 'witnessed lane is just the genesis')
    const dupe = await throwsAsync(
      () => G.createAccount('testuser', 'correct horse battery staple'),
      'createAccount refuses an existing (foldedName, tag) pair, same name + same password',
    )
    ok(dupe && /sign in instead/i.test(String(dupe.message)), 'the refusal directs to signIn')
  }

  console.log('\n· exports (mnemonic + keyfile) …')
  {
    const words = G.exportMnemonic()
    eq(words.split(' ').length, 24, 'mnemonic is 24 words')
    const seedBack = G.mnemonicToSeed(words)
    const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    eq(hex(seedBack), GOLDENS.seedHex, 'mnemonic roundtrips to the exact argon2 seed (KAT)')
    const kf = G.parseKeyfile(G.exportKeyfile())
    eq(hex(kf.seed), GOLDENS.seedHex, 'keyfile carries the exact seed')
    eq(kf.name, 'TestUser', 'keyfile carries the display name')
    eq(kf.tag, GOLDENS.tag, 'keyfile carries the tag')
  }

  console.log('\n· signOut clears the session, never the chain …')
  {
    const keysBefore = fakeLS._map.size
    G.signOut()
    eq(G.getState().signedIn, false, 'signOut → signed out')
    eq(fakeLS._map.size, keysBefore, 'signOut removed NOTHING from storage')
    await throwsAsync(async () => G.exportMnemonic(), 'exportMnemonic while signed out throws')
    await throwsAsync(async () => G.exportKeyfile(), 'exportKeyfile while signed out throws')
    await throwsAsync(() => G.verifyOwnChain(), 'verifyOwnChain while signed out throws')
  }

  console.log('\n· signIn: re-derivation against the stored chain …')
  {
    const wrong = await throwsAsync(() => G.signIn('TestUser', 'wrong password'), 'wrong password → throws (derived tag not found)')
    ok(wrong && /no account with this name and password/.test(String(wrong.message)),
      'wrong-password error is the honest tag-mismatch message')
    eq(G.getState().signedIn, false, 'failed signIn leaves us signed out')
    const st = await G.signIn('TESTUSER', 'correct horse battery staple')
    eq(st.signedIn, true, 'signIn with different casing works (fold → same account)')
    eq(st.tag, GOLDENS.tag, 'signIn re-derives the same identity')
    eq((await G.verifyOwnChain()).ok, true, 'chain verifies after sign-in')
  }

  console.log('\n· signIn NEVER creates …')
  {
    G.signOut()
    const keysBefore = fakeLS._map.size
    const e = await throwsAsync(() => G.signIn('NeverMade', 'whatever'), 'signIn for an unknown name throws')
    ok(e && /create it explicitly/.test(String(e.message)), 'error directs to explicit creation')
    eq(fakeLS._map.size, keysBefore, 'failed signIn persisted NOTHING (no create-if-absent)')
  }

  console.log('\n· cross-device signIn: adopt an account this machine has never seen …')
  {
    // Stand up a SECOND, empty device (fresh storage + a fresh module instance)
    // and prove the account can be signed into there from nothing but name +
    // password + the network. Before the restore seam existed this was flatly
    // impossible: signIn threw "create it explicitly" with no network path.
    const deviceA = fakeLS
    const acctA = await G.keyring().getAccount('testuser')
    const chainA = await G.keyring().loadChain(acctA.rootPub)

    const deviceB = makeFakeStorage()
    globalThis.localStorage = deviceB
    const H = await import(pathToFileURL(glueOut).href + '?device=b')

    // (a) with NO provider registered, behavior is exactly as before.
    const noNet = await throwsAsync(() => H.signIn('TestUser', 'correct horse battery staple'), 'device B without a restore provider still refuses')
    ok(noNet && /create it explicitly/.test(String(noNet.message)), 'and keeps the original local-only message')
    eq(deviceB._map.size, 0, 'a refused cross-device signIn persisted NOTHING')

    // (b) a provider that finds nothing ⇒ honest not-found, still no writes.
    H.setChainRestoreProvider(async () => null)
    const missing = await throwsAsync(() => H.signIn('TestUser', 'correct horse battery staple'), 'a provider that finds nothing still refuses')
    ok(missing && /or the network/.test(String(missing.message)), 'the message now names the network too')
    eq(deviceB._map.size, 0, 'still persisted nothing')

    // (c) a chain for a DIFFERENT root is refused, never adopted.
    const strangerRoot = L.deriveChild(new Uint8Array(32).fill(7), 0, 0)
    const stranger = L.createAccountChain({
      rootPriv: strangerRoot.priv, rootPub: strangerRoot.pub, displayName: 'Stranger',
      ts: 1_700_000_000_000, device: { pub: L.toB64u(strangerRoot.pub), index: 0, label: 'X' },
    })
    H.setChainRestoreProvider(async () => stranger)
    const wrongRoot = await throwsAsync(() => H.signIn('TestUser', 'correct horse battery staple'), 'a restored chain for a DIFFERENT root is refused')
    ok(wrongRoot, 'the root-binding check rejects it')
    eq(deviceB._map.size, 0, 'and nothing was written')

    // (d) the real thing: the account's own chain resolves ⇒ signed in.
    H.setChainRestoreProvider(async () => chainA)
    const st = await H.signIn('TestUser', 'correct horse battery staple')
    eq(st.signedIn, true, 'device B signs in from name + password alone')
    eq(st.tag, GOLDENS.tag, 'it derives the SAME identity as device A')
    eq((await H.verifyOwnChain()).ok, true, 'the adopted chain verifies on device B')

    const acctB = await H.keyring().getAccount('testuser')
    ok(acctB && acctB.device.index > 0, 'device B enrolled at a NEW device index (no key collision with A)')
    ok(acctB.device.pub !== acctA.device.pub, "and device B's key differs from device A's")
    const chainB = await H.keyring().loadChain(acctB.rootPub)
    eq(chainB.events.length, chainA.events.length + 1, "exactly one event was added: device B's cert")
    ok(chainB.events.some((e) => e.body.type === 'cert' && e.body.payload.pub === acctB.device.pub), "and it certifies device B's own key")

    globalThis.localStorage = deviceA
  }

  console.log('\n· rememberSeed opt-in …')
  {
    const st = await G.createAccount('SecondUser', 'hunter2hunter2', { rememberSeed: true })
    eq(st.signedIn, true, 'second account created')
    const acct = await G.keyring().getAccount('seconduser')
    ok(typeof acct.seedB64u === 'string' && acct.seedB64u.length === 43, 'seedB64u persisted on explicit opt-in')
    const seed = G.fromB64u(acct.seedB64u)
    eq(seed.length, 32, 'persisted seed is 32 bytes')
    const accts = await G.keyring().listAccounts()
    eq(accts.map((a) => a.foldedName).join('|'), 'seconduser|testuser', 'both accounts listed (sorted)')
  }

  console.log('\n· same name + different password COEXIST (tags disambiguate, spec §1) …')
  let dupTag1, dupTag2
  {
    G.signOut()
    const st1 = await G.createAccount('DupName', 'first password 111')
    dupTag1 = st1.tag
    G.signOut()
    const st2 = await G.createAccount('DupName', 'second password 222')
    dupTag2 = st2.tag
    ok(dupTag1 !== dupTag2, 'the two passwords derive two different tags')
    const dups = (await G.keyring().listAccounts()).filter((a) => a.foldedName === 'dupname')
    eq(dups.length, 2, 'both dupname identities coexist on the device')
    eq(dups.map((a) => a.tag).join('|'), [dupTag1, dupTag2].sort().join('|'),
      'listAccounts sorts same-name identities by tag')
    G.signOut()
    const s1 = await G.signIn('DupName', 'first password 111')
    eq(s1.tag, dupTag1, 'signIn resolves identity 1 by its password (derived tag)')
    G.signOut()
    const s2 = await G.signIn('DupName', 'second password 222')
    eq(s2.tag, dupTag2, 'signIn resolves identity 2 by its password (derived tag)')
    G.signOut()
    const wrong = await throwsAsync(() => G.signIn('DupName', 'third password 333'), 'a third password finds no identity')
    ok(wrong && /no account with this name and password/.test(String(wrong.message)),
      'honest wrong-password message (the derived-tag miss IS the signal)')
  }

  console.log('\n· AmbiguousAccountError through the glue keyring …')
  {
    const amb = await throwsAsync(() => G.keyring().getAccount('dupname'), 'tag-less getAccount over two identities throws')
    ok(amb && amb.name === 'AmbiguousAccountError', 'typed AmbiguousAccountError surfaces')
    ok(amb && Array.isArray(amb.tags) && amb.tags.length === 2
      && amb.tags.includes(dupTag1) && amb.tags.includes(dupTag2), 'the error lists both tags')
    eq((await G.keyring().getAccount('dupname', dupTag1)).tag, dupTag1, 'tagged getAccount stays exact')
    await throwsAsync(() => G.keyring().removeAccount('dupname'), 'tag-less removeAccount over two identities throws')
    await G.keyring().removeAccount('dupname', dupTag2)
    eq((await G.keyring().listAccounts()).filter((a) => a.foldedName === 'dupname').length, 1,
      'tagged removeAccount removed exactly one identity')
  }

  console.log('\n· createAccount rollback: record write fails AFTER the chain write …')
  {
    G.signOut()
    const chainKeysBefore = [...fakeLS._map.keys()].filter((k) => k.startsWith('acct.v1.c.')).length
    const origSetItem = fakeLS.setItem
    fakeLS.setItem = (k, v) => {
      if (k.startsWith('acct.v1.a.rollbackuser')) throw new Error('injected record-write failure')
      return origSetItem(k, v)
    }
    const e = await throwsAsync(() => G.createAccount('RollbackUser', 'trustno1trustno1'), 'createAccount rethrows the record-write failure')
    ok(e && /injected record-write failure/.test(String(e.message)), 'the ORIGINAL failure surfaces (not a rollback error)')
    fakeLS.setItem = origSetItem
    eq([...fakeLS._map.keys()].filter((k) => k.startsWith('acct.v1.a.rollbackuser')).length, 0, 'no orphan account record')
    eq([...fakeLS._map.keys()].filter((k) => k.startsWith('acct.v1.c.')).length, chainKeysBefore,
      'the chain write was rolled back (no orphan chain)')
    eq(G.getState().signedIn, false, 'failed create leaves us signed out')
    const st = await G.createAccount('RollbackUser', 'trustno1trustno1')
    eq(st.signedIn, true, 'the username is retryable after the failed create')
    eq((await G.verifyOwnChain()).ok, true, 'the retried account persists a verifying chain')
  }

  console.log('\n· an existing chain is NEVER overwritten (removeAccount → createAccount) …')
  {
    G.signOut()
    await G.createAccount('GhostUser', 'spooky password 999')
    G.signOut()
    const acct = await G.keyring().getAccount('ghostuser')
    const chainKey = `acct.v1.c.${acct.rootPub}`
    const chainBytesBefore = fakeLS.getItem(chainKey)
    ok(typeof chainBytesBefore === 'string', 'chain persisted under the root key')
    await G.keyring().removeAccount('ghostuser')
    eq(await G.keyring().getAccount('ghostuser'), null, 'removeAccount removed the record')
    eq(fakeLS.getItem(chainKey), chainBytesBefore, '… and deliberately preserved the chain')
    const e = await throwsAsync(() => G.createAccount('GhostUser', 'spooky password 999'),
      'createAccount refuses to overwrite the surviving append-only chain')
    ok(e && /sign in instead/i.test(String(e.message)), 'the refusal directs to signIn')
    eq(fakeLS.getItem(chainKey), chainBytesBefore, 'chain bytes are bit-identical after the refused create')
    eq(await G.keyring().getAccount('ghostuser'), null, 'the refused create persisted no record')
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
