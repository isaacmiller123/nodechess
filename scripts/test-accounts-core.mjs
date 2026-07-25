// Accounts A1 core-crypto suite: derive.ts / identity.ts / mnemonic.ts, plus
// regression guards over the shared codec/params they depend on.
//
//   node scripts/test-accounts-core.mjs
//
// The modules under test live in src/shared/accounts (platform-neutral TS).
// We esbuild-bundle them on the fly with alias @shared → src/shared into a
// temp dir, then dynamic-import (same pattern as scripts/test-mp-store.mjs).
//
// Golden vectors frozen here:
//  - SLIP-0010 official ed25519 test vectors (spec document, both seeds),
//    private keys AND chain codes hex-exact. If the implementation disagrees
//    with these, THE IMPLEMENTATION is wrong.
//  - argon2id KAT: ('TestUser', 'correct horse battery staple') → seed hex.
//    Freezes the whole pipeline: normalization → salt rule → argon2 params.
//  - tag KAT for rootPub = bytes 00..1f, and the KAT identity's rootPub/tag.
//  - PARAMS_V1_DIGEST: the FROZEN-AT-GENESIS parameter digest.
//
// Exit 0 = all green; any failure prints per-line and exits 1.

import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- tiny check kit ---------------------------------------------------------
let failures = 0
let passed = 0
function check(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ FAIL: ${msg}`)
  }
}
function eq(a, b, msg) {
  check(a === b, `${msg}${a === b ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`)
}
function throws(fn, msg, probe) {
  try {
    fn()
    check(false, `${msg} (did not throw)`)
    return
  } catch (e) {
    check(probe ? probe(e) : true, `${msg}${probe && !probe(e) ? ` (wrong error: ${e})` : ''}`)
  }
}
async function throwsAsync(fn, msg, probe) {
  try {
    await fn()
    check(false, `${msg} (did not throw)`)
  } catch (e) {
    check(probe ? probe(e) : true, `${msg}${probe && !probe(e) ? ` (wrong error: ${e})` : ''}`)
  }
}
const hex = (b) => Buffer.from(b).toString('hex')
const unhex = (s) => Uint8Array.from(Buffer.from(s, 'hex'))

// ---- deterministic PRNG for the random-seed roundtrips ------------------------
function xorshift32(state) {
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) & 0xff
  }
}

// ---- golden constants ---------------------------------------------------------
// argon2id('correct horse battery staple', salt=sha256('testuser'), m=64MiB t=3 p=1) → seed
const ARGON2_KAT_HEX = 'fa3616fce3505728af8fa08f8e38286d85a34b773e8075332844c9f20d11cd4a'
// deriveIdentity('TestUser', 'correct horse battery staple') root pub + tag
const KAT_ROOTPUB_HEX = '3262ce03725712aac822722cc907d22f098c77d6d248901efbd9cdb2f5661a24'
const KAT_TAG = '7U2MY'
// tagOf(rootPub = bytes 00..1f)
const TAG_GOLDEN_PUB = Uint8Array.from({ length: 32 }, (_, i) => i)
const TAG_GOLDEN = 'MMG42'
// b64u(sha256(canonicalBytes(PARAMS_V1))). Changed ONCE pre-ship when
// PARAMS_V1 gained the pwNorm ('nfkd-v1') row: nothing had shipped, so v1
// grew the row instead of minting v2. The argon2 KAT above did NOT change:
// NFKD of a pure-ASCII password is the identity.
const PARAMS_DIGEST_GOLDEN = 'ZDoblqaVf5z1zL8IvmWK2sdZK29JTNWZpY38XuDBZdk'

// ---- SLIP-0010 official ed25519 test vectors (from the SLIP-0010 spec doc) ----
// Vector 1: seed 000102030405060708090a0b0c0d0e0f
const SLIP10_V1_SEED = '000102030405060708090a0b0c0d0e0f'
const SLIP10_V1 = [
  {
    path: 'm',
    cc: '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
    priv: '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    pub: 'a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed',
  },
  {
    path: "m/0'",
    index: 0,
    cc: '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
    priv: '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    pub: '8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c',
  },
  {
    path: "m/0'/1'",
    index: 1,
    cc: 'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
    priv: 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    pub: '1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187',
  },
  {
    path: "m/0'/1'/2'",
    index: 2,
    cc: '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c',
    priv: '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9',
    pub: 'ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1',
  },
  {
    path: "m/0'/1'/2'/2'",
    index: 2,
    cc: '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc',
    priv: '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662',
    pub: '8abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c',
  },
  {
    path: "m/0'/1'/2'/2'/1000000000'",
    index: 1000000000,
    cc: '68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230',
    priv: '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
    pub: '3c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a',
  },
]
// Vector 2: the 512-bit seed
const SLIP10_V2_SEED =
  'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a2' +
  '9f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542'
const SLIP10_V2 = [
  {
    path: 'm',
    cc: 'ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b',
    priv: '171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012',
    pub: '8fe9693f8fa62a4305a140b9764c5ee01e455963744fe18204b4fb948249308a',
  },
  {
    path: "m/0'",
    index: 0,
    cc: '0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d',
    priv: '1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635',
    pub: '86fab68dcb57aa196c77c5f264f215a112c22a912c10d123b0d03c3c28ef1037',
  },
  {
    path: "m/0'/2147483647'",
    index: 2147483647,
    cc: '138f0b2551bcafeca6ff2aa88ba8ed0ed8de070841f0c4ef0165df8181eaad7f',
    priv: 'ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4',
    pub: '5ba3b9ac6e90e83effcd25ac4e58a1365a9e35a3d3ae5eb07b9e4d90bcf7506d',
  },
  {
    path: "m/0'/2147483647'/1'",
    index: 1,
    cc: '73bd9fff1cfbde33a1b846c27085f711c0fe2d66fd32e139d3ebc28e5a4a6b90',
    priv: '3757c7577170179c7868353ada796c839135b3d30554bbb74a4b1e4a5a58505c',
    pub: '2e66aa57069c86cc18249aecf5cb5a9cebbfd6fadeab056254763874a9352b45',
  },
  {
    path: "m/0'/2147483647'/1'/2147483646'",
    index: 2147483646,
    cc: '0902fe8a29f9140480a00ef244bd183e8a13288e4412d8389d140aac1794825a',
    priv: '5837736c89570de861ebc173b1086da4f505d4adb387c6a1b1342d5e4ac9ec72',
    pub: 'e33c0f7d81d843c572275f287498e8d408654fdf0d1e065b84e2e6f157aab09b',
  },
  {
    path: "m/0'/2147483647'/1'/2147483646'/2'",
    index: 2,
    cc: '5d70af781f3a37b829f0d060924d5e960bdc02e85423494afc0b1a41bbe196d4',
    priv: '551d333177df541ad876a60ea71f00447931c0a9da16f227c11ea080d7391b8d',
    pub: '47150c75db263559a70d5778bf36abbab30fb061ad69f69ece61a72b0cfa4fc0',
  },
]

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'core-'))
  try {
    await run(outdir)
  } finally {
    // cleanup on failure paths too. A crashed run must not leak temp dirs
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `${failures} FAILURES: ` : 'ALL GREEN: '}${passed} assertions`)
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  // ==========================================================================
  // 0. bundle src/shared/accounts on the fly (alias @shared), dynamic-import
  // ==========================================================================
  console.log('· bundling src/shared/accounts …')
  const entry = resolve(outdir, 'entry.ts')
  const p = (rel) => resolve(ROOT, rel).replace(/\\/g, '/')
  writeFileSync(
    entry,
    `export * from '${p('src/shared/accounts/derive.ts')}'\n` +
      `export * from '${p('src/shared/accounts/identity.ts')}'\n` +
      `export * from '${p('src/shared/accounts/mnemonic.ts')}'\n` +
      `export { canonicalBytes, canonicalHash, parseCanonical, CodecError, compareKeys } from '${p('src/shared/accounts/codec.ts')}'\n` +
      `export { PARAMS_V1, PARAMS_V1_DIGEST } from '${p('src/shared/accounts/params.ts')}'\n` +
      `export { ed25519, sha256, toB64u, fromB64u, utf8, toBase32, bytesEqual } from '${p('src/shared/accounts/hash.ts')}'\n` +
      `export { TAG_LEN, KEY_PURPOSE } from '${p('src/shared/accounts/types.ts')}'\n`,
  )
  const out = resolve(outdir, 'accounts.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  const A = await import(pathToFileURL(out).href)
  check(typeof A.deriveIdentity === 'function', 'bundle imports (deriveIdentity exported)')

  // ==========================================================================
  // 1. SLIP-0010 official ed25519 test vectors, priv + chain code hex-exact.
  // ==========================================================================
  console.log('\n· SLIP-0010 official ed25519 vectors …')
  for (const [seedHex, rows, label] of [
    [SLIP10_V1_SEED, SLIP10_V1, 'vector 1 (128-bit seed)'],
    [SLIP10_V2_SEED, SLIP10_V2, 'vector 2 (512-bit seed)'],
  ]) {
    let node = A.slip10Master(unhex(seedHex))
    for (const row of rows) {
      if (row.index !== undefined) node = A.slip10Child(node, row.index)
      eq(hex(node.priv), row.priv, `${label} ${row.path} private key`)
      eq(hex(node.chainCode), row.cc, `${label} ${row.path} chain code`)
      eq(hex(A.ed25519.getPublicKey(node.priv)), row.pub, `${label} ${row.path} public key`)
    }
  }
  throws(() => A.slip10Child(A.slip10Master(unhex(SLIP10_V1_SEED)), 0x80000000), 'slip10Child rejects index ≥ 2^31 (hardening applied internally)')
  throws(() => A.slip10Child(A.slip10Master(unhex(SLIP10_V1_SEED)), -1), 'slip10Child rejects negative index')

  // ==========================================================================
  // 2. argon2 derivation KAT, freezes normalization → salt rule → argon2.
  // ==========================================================================
  console.log('\n· argon2id derivation KAT …')
  const KAT_NAME = 'TestUser'
  const KAT_PW = 'correct horse battery staple'
  const seed = await A.deriveSeed(KAT_NAME, KAT_PW)
  eq(seed.length, 32, 'deriveSeed returns 32 bytes')
  eq(hex(seed), ARGON2_KAT_HEX, 'argon2 KAT seed matches the golden constant')
  // pwNorm 'nfkd-v1' explicitly: NFKD of pure ASCII is the identity, so the
  // seed KAT above survives the params change; ONLY the params digest moved.
  eq(KAT_PW.normalize('NFKD'), KAT_PW, 'KAT password is NFKD-invariant (pure ASCII, seed KAT unaffected by pwNorm)')
  const seed2 = await A.deriveSeed('testuser', KAT_PW)
  eq(hex(seed2), ARGON2_KAT_HEX, 'case-variant username derives the identical seed')
  const seedOtherPw = await A.deriveSeed(KAT_NAME, KAT_PW + '!')
  check(hex(seedOtherPw) !== ARGON2_KAT_HEX, 'different password derives a different seed')
  // pwNorm regression: the NFC and NFD spellings of one password must derive
  // the SAME seed ('caf\u00e9' vs 'cafe\u0301': café both ways).
  const seedNfcPw = await A.deriveSeed(KAT_NAME, 'caf\u00e9')
  const seedNfdPw = await A.deriveSeed(KAT_NAME, 'cafe\u0301')
  eq(hex(seedNfdPw), hex(seedNfcPw), "NFC 'caf\u00e9' and NFD 'cafe\u0301' passwords derive the identical seed (pwNorm nfkd-v1)")
  check(hex(seedNfcPw) !== ARGON2_KAT_HEX, "the 'caf\u00e9' seed differs from the KAT seed (sanity)")

  // full identity KAT
  const id = await A.deriveIdentity(KAT_NAME, KAT_PW)
  eq(hex(id.seed), ARGON2_KAT_HEX, 'deriveIdentity carries the KAT seed')
  eq(hex(id.rootPub), KAT_ROOTPUB_HEX, 'deriveIdentity rootPub matches golden')
  eq(id.tag, KAT_TAG, 'deriveIdentity tag matches golden')
  eq(id.foldedName, 'testuser', 'deriveIdentity foldedName is case-folded')
  eq(id.displayName, 'TestUser', 'deriveIdentity displayName keeps original casing')
  eq(hex(A.slip10Master(id.seed).priv), hex(id.rootPriv), 'rootPriv = SLIP-0010 master priv of the seed')
  // child derivation is deterministic and purpose/index-separated
  const d0 = A.deriveChild(id.seed, A.KEY_PURPOSE.device, 0)
  const d0b = A.deriveChild(id.seed, A.KEY_PURPOSE.device, 0)
  eq(hex(d0.pub), hex(d0b.pub), 'deriveChild is deterministic')
  check(hex(d0.pub) !== hex(A.deriveChild(id.seed, A.KEY_PURPOSE.device, 1).pub), 'device index 0 ≠ index 1')
  check(hex(d0.pub) !== hex(A.deriveChild(id.seed, A.KEY_PURPOSE.session, 0).pub), 'device 0 ≠ session 0 (purpose-separated)')
  check(hex(d0.pub) !== hex(id.rootPub), 'child pub ≠ root pub')

  // ==========================================================================
  // 3. normalization. Folding, NFKC, zero-width strip, rejects.
  // ==========================================================================
  console.log('\n· username normalization …')
  eq(A.normalizeUsername('Isaac').folded, 'isaac', "'Isaac' folds to 'isaac'")
  eq(A.normalizeUsername('isaac').folded, 'isaac', "'isaac' folds to 'isaac'")
  eq(A.normalizeUsername('ISAAC').folded, 'isaac', "'ISAAC' folds to 'isaac'")
  eq(A.normalizeUsername('Isaac').display, 'Isaac', 'display keeps original casing')
  eq(A.normalizeUsername('Ｉsaac').folded, 'isaac', "fullwidth 'Ｉsaac' NFKC-folds equal to 'isaac'")
  eq(A.normalizeUsername('Isa\u200bac').folded, 'isaac', 'zero-width space stripped')
  eq(A.normalizeUsername('Isa\u200dac').folded, 'isaac', 'zero-width joiner stripped')
  eq(A.normalizeUsername('\ufeffIsaac').folded, 'isaac', 'BOM/zero-width no-break stripped')
  eq(A.normalizeUsername('  Isaac  ').folded, 'isaac', 'surrounding whitespace trimmed')
  eq(A.normalizeUsername('Isa\u0007ac').folded, 'isaac', 'embedded control char stripped')
  const isNameErr = (reason) => (e) => e.name === 'NameError' && e.reason === reason
  throws(() => A.normalizeUsername('ab'), 'rejects 2 chars (too-short)', isNameErr('too-short'))
  throws(() => A.normalizeUsername('a'.repeat(25)), 'rejects 25 chars (too-long)', isNameErr('too-long'))
  throws(() => A.normalizeUsername('isaac#K7Q2M'), "rejects '#' anywhere (tag delimiter)", isNameErr('hash-char'))
  throws(() => A.normalizeUsername('\u200b\u200c\ufeff'), 'rejects empty-after-strip', isNameErr('empty'))
  throws(() => A.normalizeUsername('   '), 'rejects whitespace-only (empty after trim)', isNameErr('empty'))
  throws(() => A.normalizeUsername(''), 'rejects empty string', isNameErr('empty'))
  // NFKC can INTRODUCE a '#' (U+FF03 fullwidth number sign). Still rejected.
  throws(() => A.normalizeUsername('isaac＃X'), "rejects fullwidth '＃' (NFKC → '#')", isNameErr('hash-char'))
  // Lone surrogates: TextEncoder would silently substitute U+FFFD, letting
  // distinct names collide onto one salt: rejected as not-printable (\p{Cs}).
  throws(() => A.normalizeUsername('ab\ud800'), 'rejects a lone high surrogate (not-printable)', isNameErr('not-printable'))
  throws(() => A.normalizeUsername('a\udfffbc'), 'rejects a lone low surrogate (not-printable)', isNameErr('not-printable'))
  // Case-folding can CHANGE length: U+0130 ('İ') lowercases to i+U+0307 (2
  // chars). Both display AND folded forms must satisfy the 3-24 bound.
  {
    const turkish = A.normalizeUsername('\u0130\u0130\u0130') // '\u0130\u0130\u0130': display 3 chars
    eq(turkish.display, '\u0130\u0130\u0130', "display '\u0130\u0130\u0130' kept as typed (3 chars)")
    eq(turkish.folded, 'i\u0307i\u0307i\u0307', 'folded form is i+combining-dot ×3')
    eq(turkish.folded.length, 6, 'folded length 6: accepted (display 3 and folded 6 both within 3-24)')
  }
  throws(() => A.normalizeUsername('\u0130\u0130'), "rejects '\u0130\u0130' (display 2 < 3, too-short)", isNameErr('too-short'))
  throws(() => A.normalizeUsername('\u0130'.repeat(13)),
    "rejects 13×'İ' (display 13 ≤ 24 but folded 26 > 24: folded length also bounded)", isNameErr('too-long'))

  // ==========================================================================
  // 4. tag + handle parse/format.
  // ==========================================================================
  console.log('\n· tag + handle …')
  eq(A.tagOf(TAG_GOLDEN_PUB), TAG_GOLDEN, `tagOf(bytes 00..1f) = '${TAG_GOLDEN}' (golden)`)
  eq(A.tagOf(TAG_GOLDEN_PUB).length, A.TAG_LEN, `tag is TAG_LEN (${A.TAG_LEN}) chars`)
  eq(A.formatHandle('isaac', 'K7Q2M'), 'isaac#K7Q2M', 'formatHandle joins with #')
  const ph = A.parseHandle('isaac#K7Q2M')
  check(ph !== null && ph.name === 'isaac' && ph.tag === 'K7Q2M', 'parseHandle roundtrips formatHandle')
  const phLower = A.parseHandle('isaac#k7q2m')
  check(phLower !== null && phLower.tag === 'K7Q2M', 'parseHandle accepts lowercase tag, canonicalizes uppercase')
  const rt = A.parseHandle(A.formatHandle(id.displayName, id.tag))
  check(rt !== null && rt.name === 'TestUser' && rt.tag === KAT_TAG, 'format→parse roundtrip on the KAT identity')
  eq(A.parseHandle('isaac'), null, 'parseHandle rejects missing #')
  eq(A.parseHandle('isaac#K7Q2M#X'), null, 'parseHandle rejects two #')
  eq(A.parseHandle('isaac#K7Q'), null, 'parseHandle rejects short tag')
  eq(A.parseHandle('isaac#K7Q2MX'), null, 'parseHandle rejects long tag')
  eq(A.parseHandle('isaac#K1Q2M'), null, "parseHandle rejects non-base32 tag char ('1')")
  eq(A.parseHandle('ab#K7Q2M'), null, 'parseHandle rejects 2-char name')
  eq(A.parseHandle('a'.repeat(25) + '#K7Q2M'), null, 'parseHandle rejects 25-char name')
  eq(A.parseHandle('#K7Q2M'), null, 'parseHandle rejects empty name')

  // ==========================================================================
  // 5. mnemonic, 24 words, bit-exact roundtrip, checksum, keyfile + zod.
  // ==========================================================================
  console.log('\n· mnemonic …')
  const words = A.seedToMnemonic(seed)
  eq(words.split(' ').length, 24, 'mnemonic is exactly 24 words')
  eq(hex(A.mnemonicToSeed(words)), ARGON2_KAT_HEX, 'KAT seed roundtrips bit-exact through the mnemonic')
  const rand = xorshift32(0xC0FFEE)
  for (let i = 0; i < 10; i++) {
    const s = Uint8Array.from({ length: 32 }, rand)
    const m = A.seedToMnemonic(s)
    check(m.split(' ').length === 24 && hex(A.mnemonicToSeed(m)) === hex(s), `random seed ${i + 1}/10 roundtrips bit-exact (24 words)`)
  }
  // wrong checksum: swap the final word for a different wordlist word.
  {
    const parts = words.split(' ')
    parts[23] = parts[23] === 'abandon' ? 'ability' : 'abandon'
    throws(() => A.mnemonicToSeed(parts.join(' ')), 'wrong checksum rejected')
  }
  throws(() => A.mnemonicToSeed('not a mnemonic at all'), 'garbage mnemonic rejected')
  throws(() => A.mnemonicToSeed(words.split(' ').slice(0, 12).join(' ')), '12-word truncation rejected (we require the 24-word/32-byte form)')
  throws(() => A.seedToMnemonic(new Uint8Array(16)), 'seedToMnemonic rejects non-32-byte seed')

  console.log('\n· keyfile …')
  const kf = A.makeKeyfile(id)
  eq(kf.v, 1, 'keyfile v=1')
  eq(kf.kind, 'chess-sharp-keyfile', 'keyfile kind')
  eq(kf.name, 'TestUser', 'keyfile carries display name')
  eq(kf.tag, KAT_TAG, 'keyfile carries tag')
  const parsed = A.parseKeyfile(JSON.stringify(kf))
  eq(hex(parsed.seed), ARGON2_KAT_HEX, 'keyfile roundtrips the seed bit-exact')
  eq(parsed.name, 'TestUser', 'keyfile roundtrips name')
  eq(parsed.tag, KAT_TAG, 'keyfile roundtrips tag')
  throws(() => A.parseKeyfile('{'), 'parseKeyfile rejects non-JSON')
  throws(() => A.parseKeyfile(JSON.stringify({ ...kf, extra: 1 })), 'zod .strict(): unknown key rejected')
  throws(() => A.parseKeyfile(JSON.stringify({ ...kf, v: 2 })), 'wrong version rejected')
  throws(() => A.parseKeyfile(JSON.stringify({ ...kf, kind: 'other' })), 'wrong kind rejected')
  throws(() => A.parseKeyfile(JSON.stringify({ ...kf, tag: 'k7q2m' })), 'lowercase tag rejected (canonical uppercase only)')
  throws(() => A.parseKeyfile(JSON.stringify({ ...kf, seed: 'AAAA' })), 'short seed rejected (not 32 bytes)')
  throws(() => A.parseKeyfile(JSON.stringify({ ...kf, seed: '!!!' })), 'non-b64u seed rejected')
  {
    const { seed: _omit, ...noSeed } = kf
    throws(() => A.parseKeyfile(JSON.stringify(noSeed)), 'missing seed field rejected')
  }

  // ==========================================================================
  // 6. codec regression. Guard the shared codec this suite depends on.
  // ==========================================================================
  console.log('\n· codec (cjson-v1) regression …')
  const text = (v) => Buffer.from(A.canonicalBytes(v)).toString('utf8')
  eq(text({ b: 1, a: 2 }), '{"a":2,"b":1}', 'object keys sorted')
  eq(text({ Z: 1, a: 2, A: 3 }), '{"A":3,"Z":1,"a":2}', 'keys sorted by UTF-8 byte order (uppercase first)')
  eq(text({ a: [1, 'x', true], b: { c: 0 } }), '{"a":[1,"x",true],"b":{"c":0}}', 'nested arrays/objects serialize canonically')
  eq(text({ a: undefined, b: 1 }), '{"b":1}', 'undefined object member means absent')
  const isCodecErr = (e) => e.name === 'CodecError'
  throws(() => A.canonicalBytes({ a: 1.5 }), 'float 1.5 rejected', isCodecErr)
  throws(() => A.canonicalBytes({ a: NaN }), 'NaN rejected', isCodecErr)
  throws(() => A.canonicalBytes({ a: -0 }), 'negative zero rejected', isCodecErr)
  throws(() => A.canonicalBytes({ a: 2 ** 53 }), '2^53 (unsafe integer) rejected', isCodecErr)
  throws(() => A.canonicalBytes({ a: null }), 'null rejected (absent means absent)', isCodecErr)
  throws(() => A.canonicalBytes([1, null, 2]), 'null in array rejected', isCodecErr)
  throws(() => A.canonicalBytes([1, undefined, 2]), 'undefined in array rejected', isCodecErr)
  throws(() => A.canonicalBytes({ a: 'e\u0301' }), 'non-NFC string rejected (never normalized silently)', isCodecErr)
  throws(() => A.canonicalBytes({ a: '\uD800' }), 'lone surrogate rejected', isCodecErr)
  // parseCanonical strictness
  const rtObj = { a: 1, b: ['x', { c: true }] }
  check(JSON.stringify(A.parseCanonical(A.canonicalBytes(rtObj))) === JSON.stringify(rtObj), 'parseCanonical roundtrips canonical bytes')
  const enc = (s) => new TextEncoder().encode(s)
  throws(() => A.parseCanonical(enc('{"a": 1}')), 'parseCanonical rejects non-canonical spacing', isCodecErr)
  throws(() => A.parseCanonical(enc('{"b":1,"a":2}')), 'parseCanonical rejects unsorted keys', isCodecErr)
  throws(() => A.parseCanonical(enc('{"a":1.0}')), 'parseCanonical rejects float form 1.0', isCodecErr)
  throws(() => A.parseCanonical(enc('{"a":null}')), 'parseCanonical rejects null', isCodecErr)
  throws(() => A.parseCanonical(enc('{"a":"\\u0041"}')), 'parseCanonical rejects escaping variants (\\u0041 for A)', isCodecErr)
  // params digest golden
  eq(A.PARAMS_V1_DIGEST, PARAMS_DIGEST_GOLDEN, 'PARAMS_V1_DIGEST matches the FROZEN-AT-GENESIS golden')
  eq(A.toB64u(A.canonicalHash(A.PARAMS_V1)), PARAMS_DIGEST_GOLDEN, 'digest recomputes from PARAMS_V1 via canonicalHash')

  // ==========================================================================
  // 7. ed25519: sign/verify roundtrip + tamper rejection (sync hash wiring).
  // ==========================================================================
  console.log('\n· ed25519 sign/verify …')
  const msg = A.canonicalBytes({ hello: 'world', n: 42 })
  const sig = A.ed25519.sign(msg, id.rootPriv) // sync call. Proves sha512 wiring
  eq(sig.length, 64, 'signature is 64 bytes')
  check(A.ed25519.verify(sig, msg, id.rootPub) === true, 'sign/verify roundtrip (sync API works)')
  {
    const badSig = sig.slice()
    badSig[0] ^= 1
    check(A.ed25519.verify(badSig, msg, id.rootPub) === false, 'tampered signature fails')
    const badMsg = msg.slice()
    badMsg[0] ^= 1
    check(A.ed25519.verify(sig, badMsg, id.rootPub) === false, 'tampered message fails')
    const badPub = id.rootPub.slice()
    badPub[0] ^= 1
    check(A.ed25519.verify(sig, msg, badPub) === false, 'tampered pubkey fails (no throw)')
  }
  // a child key signs too, and its sig does not verify under the root pub
  const childSig = A.ed25519.sign(msg, d0.priv)
  check(A.ed25519.verify(childSig, msg, d0.pub) === true, 'child key sign/verify roundtrip')
  check(A.ed25519.verify(childSig, msg, id.rootPub) === false, 'child sig does not verify under root pub')

  // deriveSeed input validation surfaces NameError before any argon2 work
  await throwsAsync(() => A.deriveSeed('ab', 'pw'), 'deriveSeed rejects invalid username (NameError)', (e) => e.name === 'NameError')
}

main().catch((err) => {
  console.error(`\n❌ ${err.stack || err}`)
  process.exit(1)
})
