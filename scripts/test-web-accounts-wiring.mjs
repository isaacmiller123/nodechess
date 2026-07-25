// A6 lane-4 wiring suite: the renderer accounts store's PURE derivations
// over the REAL web glue (no browser, no network, no engine).
//
//   node scripts/test-web-accounts-wiring.mjs
//
// What it proves:
//  1. AUTH LIFECYCLE: createAccount / signIn / signOut / resumeSession /
//     forgetRememberedSeed / listKeyringAccounts against src/web/accounts.ts
//     with real argon2id derivation over a stubbed localStorage.
//  2. CHAIN → UI, src/renderer/.../features/account/store/derive.ts:
//     deriveOwnAccount / deriveChainEvents / deriveDevices / deriveProfile /
//     foldChainA4 / foldDigestOf produce exactly what the shared folds say
//     (§0: derived, never asserted), deterministically (same inputs → same
//     JSON twice).
//  3. §10 EDIT PROFILE: updateProfile appends a verifying personal-lane
//     record and the derivation round-trips it. Includes the §10 staleness
//     value (deriveProfile.lastWitnessedActivityWts): null on every locally
//     created chain, the UI's honest "no witnessed activity" source, never
//     a fabricated freshness claim (review complete-1).
//  4. §6/§9 RENDERING: placement/provisional/ranked/banned states from
//     synthetic fold states, including the ban→standing projection.
//  5. RENDERER STORE PRIVACY CONTRACT (review wiring-3), mock/store.ts
//     bundled headless (react stubbed to a bare useSyncExternalStore):
//     signIn(remember:true) stores the seed; store.signOut() ALWAYS forgets
//     it: asserted via the exported signOutSequence with the REAL
//     forgetRememberedSeed and an injected failing teardown, and the
//     resumed boot after sign-out stays signed out.
//
// Style: house ok/eq kit, failures counter, exit(1) on any failure.

import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { bundleFixture } from './lib/accounts-fixture.mjs'

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
  } catch {
    ok(true, msg)
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
  }
}

const B64U_RE = /^[A-Za-z0-9_-]{43}$/

async function main() {
  const outdir = mkdtempSync(resolve(tmpdir(), 'wiring-'))
  process.on('exit', () => rmSync(outdir, { recursive: true, force: true }))

  console.log('· bundling web glue + renderer derive module (esbuild, @shared alias) …')
  const entry = resolve(outdir, 'wiring.entry.ts')
  const derivePath = resolve(
    ROOT,
    'src/renderer/src/features/account/store/derive.ts',
  ).replace(/\\/g, '/')
  const gluePath = resolve(ROOT, 'src/web/accounts.ts').replace(/\\/g, '/')
  writeFileSync(
    entry,
    `export * as G from '${gluePath}'\n` +
      `export * as D from '${derivePath}'\n` +
      `export { repInit, repScore, repTier } from '@shared/accounts/ratings/reputation'\n` +
      `export { PARAMS_A4 } from '@shared/accounts/ratings/params'\n`,
  )
  const out = resolve(outdir, 'wiring.mjs')
  await bundleFixture(entry, out, 'node')
  ok(true, 'bundle built (derive.ts is browser-clean: no react/DOM/node imports)')

  globalThis.localStorage = makeFakeStorage()
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    },
    configurable: true,
  })
  const { G, D, repInit, repScore, repTier, PARAMS_A4 } = await import(pathToFileURL(out).href)

  const NOW = 1_784_073_600_000 // fixed evaluation instant for derivations

  // ==========================================================================
  console.log('\n· create account (real argon2id → genesis + device-0 cert) …')
  // ==========================================================================
  eq(G.getState().signedIn, false, 'boots signed out')
  const st = await G.createAccount('Wiree', 'password-123', { rememberSeed: true })
  eq(st.signedIn, true, 'createAccount signs in')
  eq(st.foldedName, 'wiree', 'folded name casefolds')
  ok(typeof st.tag === 'string' && st.tag.length >= 4, `derived tag '${st.tag}'`)
  eq(st.handle, `Wiree#${st.tag}`, 'handle is name#TAG')
  const info = G.sessionInfo()
  ok(info !== null && info.deviceIndex === 0, 'sessionInfo carries device 0')
  eq((await G.verifyOwnChain()).ok, true, 'fresh chain verifies from genesis')

  // ==========================================================================
  console.log('\n· chain → UiOwnAccount (fresh chain: everything at protocol seeds) …')
  // ==========================================================================
  const idInputs = {
    displayName: st.displayName,
    foldedName: st.foldedName,
    tag: st.tag,
    rootPub: st.rootPub,
  }
  const chain0 = await G.loadOwnChain()
  const acc = D.deriveOwnAccount(idInputs, chain0, NOW)
  eq(acc.handle, st.handle, 'UiOwnAccount.handle matches the session handle')
  eq(acc.ladders.length, 4, 'four shipped ladders derived')
  eq(
    acc.ladders.map((l) => l.key).join(','),
    'Bullet,Blitz,Rapid,Classical',
    'ladder order is the shipped category order',
  )
  ok(
    acc.ladders.every((l) => l.display.state === 'placement' && l.display.n === 0),
    'every fresh ladder renders Placement 0/N (§6: never a number)',
  )
  ok(
    acc.ladders.every((l) => l.display.of === PARAMS_A4.placementGames),
    `placement denominator is PARAMS_A4.placementGames (${PARAMS_A4.placementGames})`,
  )
  ok(
    acc.ladders.every((l) => l.history === undefined),
    'no sparkline history before ranked (UiLadder contract)',
  )
  eq(acc.reputation.score, repScore(repInit()), 'reputation score === repScore(repInit())')
  eq(
    acc.reputation.tier,
    ['Poor', 'Mixed', 'Solid', 'Exemplary'][repTier(acc.reputation.score)],
    'tier label matches repTier band',
  )
  eq(acc.reputation.components.length, 6, 'six reputation breakdown rows')
  eq(acc.standing.state, 'good', 'standing derives good (no bans in the fold)')
  eq(acc.chainHeight, 0, 'witnessed height 0 (genesis only)')
  eq(acc.chainEvents, 2, 'two events total (genesis + device cert)')
  ok(acc.createdWts > 0, 'createdWts comes from the genesis event')
  eq(acc.profile.bio, '', 'no profile records yet → empty bio')

  // ==========================================================================
  console.log('\n· chain rows + devices (§2 viewer, §1 certificates) …')
  // ==========================================================================
  const rows = D.deriveChainEvents(chain0)
  eq(rows.length, 2, 'two chain rows')
  const gRow = rows.find((r) => r.type === 'genesis')
  const cRow = rows.find((r) => r.type === 'cert')
  ok(gRow && gRow.lane === 'w' && gRow.height === 0, 'genesis row: witnessed lane, height 0')
  ok(cRow && cRow.lane === 'p' && cRow.height === 0, 'cert row: personal lane, height 0')
  ok(gRow.summary.includes('Account created'), 'genesis summary')
  ok(cRow.summary.includes('Device 0 enrolled'), 'cert summary names device 0')
  ok(
    rows.every((r) => B64U_RE.test(r.id)),
    'row ids are real event ids (43-char b64u)',
  )
  ok(
    rows.every((r) => r.witnesses === undefined),
    'no witness badges without attestations (honest rendering)',
  )
  const devices = D.deriveDevices(chain0, info.devicePub)
  eq(devices.length, 1, 'one device derived from the cert')
  ok(
    devices[0].index === 0 && devices[0].thisDevice === true,
    'device 0 is marked as this device',
  )
  eq(devices[0].witnessed, false, 'unwitnessed cert renders witnessed:false (§0 honesty)')
  eq(devices[0].label, 'Chrome on macOS', 'device label from the UA')
  eq(devices[0].revoked, undefined, 'not revoked')

  // ==========================================================================
  console.log('\n· §10 edit profile: signed personal-lane record round-trip …')
  // ==========================================================================
  const chain1 = await G.updateProfile({ bio: 'wired bio', flair: '♞' })
  eq(chain1.events.length, 3, 'profile record appended')
  eq((await G.verifyOwnChain()).ok, true, 'chain still verifies after the profile record')
  const prof = D.deriveProfile(chain1)
  eq(prof.bio, 'wired bio', 'bio round-trips through the chain')
  eq(prof.flair, '♞', 'flair round-trips through the chain')
  eq(prof.country, '', 'untouched field keeps its default')
  // §10 staleness (complete-1): no witness attestations exist on a locally
  // created chain, so the derived value is null, the honest "no witnessed
  // activity on record" the profile surface renders. NEVER a self-claimed ts.
  eq(
    D.deriveProfile(chain0).lastWitnessedActivityWts,
    null,
    '§10 staleness: fresh chain derives lastWitnessedActivityWts null (no attestation → no claim)',
  )
  eq(
    prof.lastWitnessedActivityWts,
    null,
    '§10 staleness: personal-lane profile records never mint witnessed activity',
  )
  const acc2 = D.deriveOwnAccount(idInputs, chain1, NOW)
  eq(acc2.profile.bio, 'wired bio', 'UiOwnAccount picks up the profile fold')
  eq(acc2.chainHeight, 0, 'personal-lane record does not move the witnessed head')
  eq(acc2.chainEvents, 3, 'event count includes the profile record')
  const pRow = D.deriveChainEvents(chain1).find((r) => r.type === 'profile')
  eq(pRow?.summary, 'Profile updated: bio, flair', 'profile row summary lists the fields')
  // Personal lanes are PER-KEY (§2): the cert rides the ROOT key's personal
  // chain, so the device key's first record starts its own chain at height 0.
  ok(pRow.lane === 'p' && pRow.height === 0, "profile row: personal lane, device key's height 0")
  const chain2 = await G.updateProfile({ bio: 'second bio' })
  eq(D.deriveProfile(chain2).bio, 'second bio', 'later record wins per field')
  eq(D.deriveProfile(chain2).flair, '♞', 'unpatched field survives the later record')
  await throwsAsync(() => G.updateProfile({}), 'empty profile patch refuses')

  // ==========================================================================
  console.log('\n· determinism (same inputs → same bits) …')
  // ==========================================================================
  const j1 = JSON.stringify(D.deriveOwnAccount(idInputs, chain2, NOW))
  const j2 = JSON.stringify(D.deriveOwnAccount(idInputs, chain2, NOW))
  eq(j1, j2, 'deriveOwnAccount is bit-identical across runs')
  const dg1 = D.foldDigestOf(D.foldChainA4(chain2).fold)
  const dg2 = D.foldDigestOf(D.foldChainA4(chain2).fold)
  eq(dg1, dg2, 'fold digest is stable')
  ok(B64U_RE.test(dg1), 'fold digest is a 43-char b64u (canonicalHash)')

  // ==========================================================================
  console.log('\n· §6/§9 display + standing over synthetic fold states …')
  // ==========================================================================
  const mkDerived = (ladders, bans) => ({
    fold: { ladders, bans, rep: repInit() },
    histories: { Bullet: [], Blitz: [1400, 1450, 1500], Rapid: [], Classical: [] },
  })
  const rankedBlitz = { 'chess:Blitz': { r: 1_500_000_000, rd: 60_000_000, vol: 0, n: 200, placed: 1 } }
  {
    const ls = D.deriveLadders(mkDerived(rankedBlitz, {}), NOW)
    const blitz = ls.find((l) => l.key === 'Blitz')
    eq(blitz.display.state, 'ranked', '200 games ≥ revealBlitz → ranked')
    eq(blitz.display.rating, 1500, 'display Elo floors micro → 1500')
    ok(Array.isArray(blitz.history), 'ranked ladder carries its sparkline history')
    eq(ls.find((l) => l.key === 'Bullet').display.state, 'placement', 'untouched ladder stays placement')
  }
  {
    const provisional = { 'chess:Blitz': { r: 1_500_000_000, rd: 120_000_000, vol: 0, n: 50, placed: 1 } }
    const blitz = D.deriveLadders(mkDerived(provisional, {}), NOW).find((l) => l.key === 'Blitz')
    eq(blitz.display.state, 'provisional', '50 games < revealBlitz → provisional')
    eq(blitz.display.of, PARAMS_A4.revealBlitz, 'provisional denominator is the reveal threshold')
    eq(blitz.history, undefined, 'provisional ladder hides its history (no number leaks)')
  }
  {
    const ban = { 'chess:Blitz': { until: NOW + 1000, window: 3, verdict: 'v'.repeat(43) } }
    const blitz = D.deriveLadders(mkDerived(rankedBlitz, ban), NOW).find((l) => l.key === 'Blitz')
    eq(blitz.display.state, 'banned', 'active fold ban renders banned (§9 public fact)')
    const standing = D.deriveStanding({ ladders: rankedBlitz, bans: ban, rep: repInit() }, NOW)
    eq(standing.state, 'self-ban', 'active ban → self-ban standing')
    eq(standing.expiresWts, NOW + 1000, 'standing expiry is the fold ban until')
    eq(standing.record, 'v'.repeat(43), 'standing cites the verdict record')
  }
  {
    const expired = { 'chess:Blitz': { until: NOW - 1, window: 3, verdict: 'v'.repeat(43) } }
    const blitz = D.deriveLadders(mkDerived(rankedBlitz, expired), NOW).find((l) => l.key === 'Blitz')
    eq(blitz.display.state, 'ranked', 'expired ban falls through to ranked (read-time expiry)')
    eq(
      D.deriveStanding({ ladders: rankedBlitz, bans: expired, rep: repInit() }, NOW).state,
      'good',
      'expired ban → good standing',
    )
  }

  // ==========================================================================
  console.log('\n· session lifecycle: sign-out / resume / forget / re-derive …')
  // ==========================================================================
  G.signOut()
  eq(G.getState().signedIn, false, 'signOut clears the session')
  const resumed = await G.resumeSession()
  eq(resumed.signedIn, true, 'resumeSession restores from the remembered seed')
  eq(resumed.tag, st.tag, 'resumed session is the same identity')
  eq((await G.verifyOwnChain()).ok, true, 'resumed session verifies the stored chain')
  await G.forgetRememberedSeed()
  G.signOut()
  eq((await G.resumeSession()).signedIn, false, 'after forget, resume stays signed out')
  await throwsAsync(
    () => G.signIn('Wiree', 'wrong-password'),
    'wrong password refuses (different derived root)',
  )
  const back = await G.signIn('Wiree', 'password-123')
  eq(back.signedIn, true, 'correct password signs back in')
  let ring = await G.listKeyringAccounts()
  eq(ring.length, 1, 'keyring lists one stored account')
  ok(ring[0].current === true && ring[0].remembered === false, 'current, seed not remembered')
  G.signOut()
  await G.signIn('Wiree', 'password-123', { rememberSeed: true })
  ring = await G.listKeyringAccounts()
  eq(ring[0].remembered, true, 'rememberSeed at sign-in stores the seed (opt-in)')
  eq((await G.resumeSession()).signedIn, true, 'and resume works again')

  // ==========================================================================
  console.log('\n· wiring-1/2: fail-closed boot + genesis-verified names …')
  // ==========================================================================
  G.signOut()
  // Keyring rows are base64url(canonical JSON). Decode to find + tamper.
  const rowDecode = (v) => JSON.parse(Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  const rowEncode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const lsKeys = Array.from({ length: globalThis.localStorage.length }, (_, i) => globalThis.localStorage.key(i))
  const accKey = lsKeys.find((k) => {
    try {
      const o = rowDecode(globalThis.localStorage.getItem(k))
      return typeof o === 'object' && o !== null && typeof o.displayName === 'string' && typeof o.seedB64u === 'string'
    } catch {
      return false
    }
  })
  ok(accKey !== undefined, 'wiring-2 fixture: located the stored account record')
  const pristineRow = globalThis.localStorage.getItem(accKey)
  {
    // wiring-2: the session's names come from the SIGNED genesis, never the
    // mutable stored record: a tampered localStorage name must never ride
    // into a session (or the keyfile export it feeds).
    const t = rowDecode(pristineRow)
    t.displayName = 'Mallory'
    globalThis.localStorage.setItem(accKey, rowEncode(t))
    eq((await G.resumeSession()).signedIn, false, 'wiring-2: tampered stored displayName ⇒ NO session (genesis is the name authority)')
    const t2 = rowDecode(pristineRow)
    t2.foldedName = 'mallory'
    globalThis.localStorage.setItem(accKey, rowEncode(t2))
    eq((await G.resumeSession()).signedIn, false, 'wiring-2: tampered stored foldedName ⇒ NO session')
  }
  {
    // wiring-1: a corrupt keyring record must never break boot. The store
    // read itself sits inside the fail-closed boundary.
    globalThis.localStorage.setItem(accKey, '{corrupt')
    let boot = null
    try {
      boot = await G.resumeSession()
    } catch {
      boot = null
    }
    ok(boot !== null && boot.signedIn === false, 'wiring-1: corrupt keyring record ⇒ signed-out boot, never a throw')
    let listed = null
    try {
      listed = await G.listKeyringAccounts()
    } catch {
      listed = null
    }
    ok(Array.isArray(listed), 'wiring-1: listKeyringAccounts fails closed to a list, never a throw')
  }
  globalThis.localStorage.setItem(accKey, pristineRow)
  eq((await G.resumeSession()).signedIn, true, 'restored pristine record resumes again (fixture hygiene)')

  // ==========================================================================
  console.log('\n· renderer store privacy contract (wiring-3): sign-out ALWAYS forgets the seed …')
  // ==========================================================================
  // Bundle the REAL renderer store (mock/store.ts) headless. react is stubbed
  // to a bare useSyncExternalStore (the store only pulls that one hook); the
  // web glue resolves to the SAME module instance inside this bundle, so the
  // store's calls and our G2 assertions see one session + one keyring.
  const reactStub = resolve(outdir, 'react-stub.mjs')
  writeFileSync(
    reactStub,
    'export function useSyncExternalStore(subscribe, getSnapshot) {\n  return getSnapshot()\n}\n',
  )
  const storeEntry = resolve(outdir, 'store.entry.ts')
  const storePath = resolve(
    ROOT,
    'src/renderer/src/features/account/mock/store.ts',
  ).replace(/\\/g, '/')
  writeFileSync(
    storeEntry,
    `export * as S from '${storePath}'\n` + `export * as G2 from '${gluePath}'\n`,
  )
  const storeOut = resolve(outdir, 'store.mjs')
  // Fresh storage BEFORE the import: the store's boot IIFE (resumeSession +
  // keyring refresh) runs against an empty keyring and must boot signed out.
  globalThis.localStorage = makeFakeStorage()
  await build({
    entryPoints: [storeEntry],
    outfile: storeOut,
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared'), react: reactStub },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  const { S, G2 } = await import(pathToFileURL(storeOut).href)
  const storeState = () => S.accountsUiStore.getState()
  const waitFor = async (fn, ms = 10_000) => {
    const t0 = Date.now()
    while (!fn()) {
      if (Date.now() - t0 > ms) return false
      await new Promise((r) => setTimeout(r, 15))
    }
    return true
  }
  const remembered = async () => (await G2.listKeyringAccounts()).some((a) => a.remembered)

  ok(await waitFor(() => storeState().busy === 'idle'), 'store boot settles to idle')
  eq(storeState().signedIn, false, 'store boots signed OUT on an empty keyring')

  // create (remember:true) → recovery step → finishCreate commits.
  eq(await S.accountsUiStore.createAccount('Storee', 'password-456', true), true, 'store createAccount succeeds')
  eq(storeState().signedIn, false, 'createAccount stages, signedIn flips only at finishCreate (C-5)')
  S.accountsUiStore.finishCreate()
  eq(storeState().signedIn, true, 'finishCreate commits the staged account')
  eq(
    storeState().lastWitnessedActivityWts,
    null,
    'store carries §10 staleness null for a fresh chain (ProfileTab renders the honest copy, complete-1)',
  )
  eq(await remembered(), true, 'remember:true stored the seed (explicit opt-in)')

  // Sign-out through the store: seed forgotten, session gone, resume stays out.
  await S.accountsUiStore.signOut()
  eq(storeState().signedIn, false, 'store.signOut clears the UI session')
  eq(G2.getState().signedIn, false, 'store.signOut tears down the glue session')
  eq(await remembered(), false, 'store.signOut FORGETS the remembered seed (privacy contract)')
  eq((await G2.resumeSession()).signedIn, false, 'resumed boot after store.signOut stays signed out')

  // The contract under failure: signOutSequence runs the REAL forget first,
  // so the seed is gone even when the session teardown throws.
  await S.accountsUiStore.signIn('Storee', 'password-456', true)
  eq(storeState().signedIn, true, 'signed back in (remember:true)')
  eq(await remembered(), true, 'seed remembered again before the failure-injection round')
  let teardownThrew = false
  try {
    await S.signOutSequence(G2.forgetRememberedSeed, () => {
      throw new Error('injected teardown failure')
    })
  } catch {
    teardownThrew = true
  }
  ok(teardownThrew, 'injected teardown failure propagates (nothing swallows it silently)')
  eq(
    await remembered(),
    false,
    'seed is forgotten EVEN WHEN the teardown (webSignOut) throws: forget is sequenced first',
  )
  G2.signOut() // finish the teardown the injected failure skipped
  eq(
    (await G2.resumeSession()).signedIn,
    false,
    'resumed boot after the failed sign-out stays signed out (no seed to resume from)',
  )

  // wiring-6: the store's remember DEFAULT is false. No silent seed storage.
  await S.accountsUiStore.signIn('Storee', 'password-456')
  eq(storeState().signedIn, true, 'default-argument sign-in works')
  eq(await remembered(), false, 'store default remember=false: the seed is stored only on explicit opt-in')
  await S.accountsUiStore.signOut()

  // ==========================================================================
  console.log(
    `\n${failures === 0 ? `ALL GREEN: ${passed} assertions` : `${failures} FAILURES (${passed} passed)`}`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('suite crashed:', e)
  process.exit(1)
})
