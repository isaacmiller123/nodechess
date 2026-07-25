// Headless RENDER test for the A4 accounts UI (src/renderer/src/features/
// account/**) — the suite that makes the A4 renderer review fixes revert-proof.
// Every pinned behavior below was applied in the 2026-07 A4 fix pass and then
// found UNENFORCED by the re-verification (no script rendered any .tsx, so a
// silent revert kept all suites green). This suite renders the real components
// with react-dom/server and asserts the §6/§7/§12 rendering rules hold in the
// produced markup.
//
//   node scripts/test-a4-ui.mjs
//
// Pins (one section per review id):
//   A4-17  provisional viewer sees NOTHING rating-shaped about anyone —
//          RatingLadders/ProfilePage render through the SHARED projections
//          (mm/pairing visibleOpponentInfo / spectatorOpponentInfo); plus the
//          previously-missing 'banned' OpponentInfo branch renders.
//   A4-18  TrustWidthMeter geometry equals the SHARED quadratic width()
//          (widthMin + floor(widthSpan·(1−T)²)) at several T — a local linear
//          curve differs at every interior test point.
//   A4-25  the meter renders NO numeric trust/width oracle (no "T = …",
//          no "±N") in any build — §7 widening is invisible.
//   (A4-26 / A4-27 were pinned against the old RatedLobby, which was deleted
//    when rated play moved into Play. See the note where they used to run.)
//   A4-28  every fixture UiLadder.display IS displayState(state, key) — the
//          shared §6 authority (PARAMS_A4 reveal thresholds 120/100/80/40).
//   A4-29  the degradation carriers (reconstruction.path='floor',
//          revocationContested, checkpoint.mOfN=false — the viewer.ts
//          resolveProfile signals) render as VISIBLE degraded states.
//
// Pattern: esbuild-bundle on the fly (alias @shared → src/shared, css → empty,
// import.meta.env.DEV defined true so dev-only invariants are ARMED), stub
// localStorage/navigator BEFORE import (mock/store.ts boots at module eval),
// then renderToStaticMarkup and assert on markup/text. No new dependencies.
// Style: failures counter, per-assert one-line output, exit(failures ? 1 : 0).

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ACCT_UI = resolve(ROOT, 'src/renderer/src/features/account').replace(/\\/g, '/')

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
function deepEq(a, b, msg) {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  ok(ja === jb, ja === jb ? msg : `${msg} (got ${ja}, want ${jb})`)
}
/** Markup → visible text: drop tags (attributes/styles go with them). */
function textOf(markup) {
  return markup.replace(/<[^>]*>/g, ' ')
}
function count(hay, needle) {
  let n = 0
  let i = 0
  for (;;) {
    i = hay.indexOf(needle, i)
    if (i === -1) return n
    n++
    i += needle.length
  }
}

// ---- browser-shaped globals BEFORE the bundle import ------------------------
// mock/store.ts boots (resumeSession) at module eval; src/web/accounts.ts
// wants localStorage + navigator. Same stubs as scripts/test-web-accounts.mjs.
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
globalThis.localStorage = makeFakeStorage()
// node ≥21 defines globalThis.navigator as getter-only — defineProperty it.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'chess-sharp-a4-ui-suite (node)' },
  configurable: true,
})

const DAY = 86_400_000

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/a4-ui-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failures ? `, ${failures} failures` : ''}`
  )
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  // ---- bundle the renderer feature + shared authorities as ONE graph -------
  console.log('· bundling the account UI (.tsx) + shared authorities …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export { renderToStaticMarkup } from 'react-dom/server'`,
      `export { createElement as h } from 'react'`,
      `export { RatingLadders } from '${ACCT_UI}/profile/RatingLadders.tsx'`,
      `export { ProfilePage, projectionFor } from '${ACCT_UI}/profile/ProfilePage.tsx'`,
      `export { ReconstructionCard } from '${ACCT_UI}/profile/ReconstructionCard.tsx'`,
      `export { TrustWidthMeter, widthBand, WIDTH_FLOOR, WIDTH_CEIL } from '${ACCT_UI}/rated/TrustWidthMeter.tsx'`,
      `export { OWN_ACCOUNT, PROFILES, MOCK_NOW } from '${ACCT_UI}/mock/fixtures.ts'`,
      `export { accountsUiStore } from '${ACCT_UI}/mock/store.ts'`,
      `export { displayState, pairViewOf } from '@shared/accounts/ratings/display'`,
      `export { revealThreshold } from '@shared/accounts/ratings/ladders'`,
      `export { PARAMS_A4 } from '@shared/accounts/ratings/params'`,
      `export { width, bracketOf, eloOf, pairingLegal, visibleOpponentInfo, spectatorOpponentInfo } from '@shared/accounts/mm/pairing'`,
    ].join('\n')
  )
  const outfile = resolve(outdir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    // Bare packages (react, react-dom/server, lucide-react) resolve from
    // node_modules at runtime — node loads their CJS fine, and the whole
    // graph shares ONE react instance. The renderer/shared PROJECT tree is
    // what gets bundled (alias resolves @shared to a path first).
    packages: 'external',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    // DEV=true ARMS the dev-only module-scope invariants and proves no
    // dev-only numeric oracle renders (A4-25).
    define: {
      'import.meta.env.DEV': 'true',
      'import.meta.env.PROD': 'false',
      'import.meta.env.MODE': '"test"',
    },
    logLevel: 'warning',
  })
  const M = await import(pathToFileURL(outfile).href)
  const {
    renderToStaticMarkup,
    h,
    RatingLadders,
    ProfilePage,
    projectionFor,
    ReconstructionCard,
    TrustWidthMeter,
    widthBand,
    WIDTH_FLOOR,
    WIDTH_CEIL,
    OWN_ACCOUNT,
    PROFILES,
    MOCK_NOW,
    accountsUiStore,
    displayState,
    pairViewOf,
    revealThreshold,
    PARAMS_A4,
    width,
    bracketOf,
    eloOf,
    pairingLegal,
    visibleOpponentInfo,
    spectatorOpponentInfo,
  } = M
  const render = (el) => renderToStaticMarkup(el)
  ok(true, 'bundle imported — account UI module-scope invariants held (DEV armed)')

  const mira = PROFILES['mira#T8FQ2']
  const adrift = PROFILES['adrift#P9GH3']
  const vanished = PROFILES['vanished#Q3XR7']
  const newbie = PROFILES['newbie#F2PLC']
  ok(mira && adrift && vanished && newbie, 'fixture profiles present (mira/adrift/vanished/newbie)')

  // ==========================================================================
  // A4-28 — fixture display states ARE the shared displayState() output
  // ==========================================================================
  console.log('\n[A4-28] UiLadder.display === displayState(state, category) for every fixture …')
  eq(PARAMS_A4.revealBullet, 120, 'PARAMS_A4.revealBullet is 120')
  eq(PARAMS_A4.revealBlitz, 100, 'PARAMS_A4.revealBlitz is 100')
  eq(PARAMS_A4.revealRapid, 80, 'PARAMS_A4.revealRapid is 80')
  eq(PARAMS_A4.revealClassical, 40, 'PARAMS_A4.revealClassical is 40')
  for (const k of ['Bullet', 'Blitz', 'Rapid', 'Classical']) {
    eq(revealThreshold(k), PARAMS_A4[`reveal${k}`], `revealThreshold(${k}) is PARAMS_A4.reveal${k}`)
  }
  const allAccounts = [
    ['OWN_ACCOUNT', OWN_ACCOUNT],
    ...Object.entries(PROFILES),
  ]
  for (const [name, acct] of allAccounts) {
    for (const l of acct.ladders) {
      deepEq(
        l.display,
        displayState(l.state, l.key),
        `${name} ${l.key} display is displayState(state) verbatim`
      )
      eq(l.games, l.state.n, `${name} ${l.key} games mirrors state.n`)
      if (l.state.n >= revealThreshold(l.key)) {
        eq(l.display.state, 'ranked', `${name} ${l.key} n≥reveal ⇒ ranked`)
      } else {
        ok(l.display.state !== 'ranked', `${name} ${l.key} n<reveal ⇒ not ranked`)
      }
    }
  }
  // The two contradictions the review caught can never re-enter via fixtures:
  deepEq(
    OWN_ACCOUNT.ladders.find((l) => l.key === 'Bullet').display,
    { state: 'provisional', n: 62, of: 120 },
    'own Bullet is provisional 62/120 (NOT the old fixture revealAt 100)'
  )
  deepEq(
    displayState({ n: 100, r: 1_444_000_000 }, 'Bullet'),
    { state: 'provisional', n: 100, of: 120 },
    'Bullet at 100 games is STILL provisional (reveal is 120)'
  )
  deepEq(
    mira.ladders.find((l) => l.key === 'Classical').display,
    { state: 'provisional', n: 31, of: 40 },
    'mira Classical is provisional 31/40'
  )
  deepEq(
    displayState({ n: 41, r: 1_573_000_000 }, 'Classical'),
    { state: 'ranked', rating: 1573 },
    'Classical at 41 games is ranked (the old "provisional 41/40" fixture is impossible)'
  )

  // ==========================================================================
  // A4-18 — TrustWidthMeter geometry equals the shared quadratic width()
  // ==========================================================================
  console.log('\n[A4-18] meter band geometry is the shared quadratic width() …')
  eq(width(1_000_000), 50, 'width(T=1) golden: 50')
  eq(width(500_000), 162, 'width(T=0.5) golden: 162')
  eq(width(0), 500, 'width(T=0) golden: 500')
  eq(WIDTH_FLOOR, width(0), 'meter WIDTH_FLOOR is the shared curve at the trust floor')
  eq(WIDTH_CEIL, width(1_000_000), 'meter WIDTH_CEIL is the shared curve at full trust')
  const T_POINTS = [0, 150_000, 250_000, 400_000, 500_000, 750_000, 820_000, 1_000_000]
  for (const t of T_POINTS) {
    const markup = render(h(TrustWidthMeter, { tMicro: t }))
    const frac = width(t) / WIDTH_FLOOR
    const wantW = `width:${String(frac * 100)}%`
    const wantL = `left:${String(50 - frac * 50)}%`
    ok(
      markup.includes(wantW) && markup.includes(wantL),
      `T=${t / 1e6}: rendered band is ${wantW} / ${wantL} — width(T)=${width(t)} (shared quadratic)`
    )
  }
  // A local LINEAR curve (the reverted state) differs at every interior point:
  for (const t of [250_000, 500_000, 750_000]) {
    const linear = PARAMS_A4.widthMin + Math.floor((PARAMS_A4.widthSpan * (1_000_000 - t)) / 1_000_000)
    ok(linear !== width(t), `T=${t / 1e6}: linear curve (${linear}) ≠ quadratic (${width(t)})`)
    const markup = render(h(TrustWidthMeter, { tMicro: t }))
    ok(
      !markup.includes(`width:${String((linear / WIDTH_FLOOR) * 100)}%`),
      `T=${t / 1e6}: the linear-curve band width does NOT render`
    )
  }
  eq(widthBand(820_000), 'precision', 'T=0.82 classifies as the precision band')
  ok(
    render(h(TrustWidthMeter, { tMicro: 820_000 })).includes('Precision band'),
    'T=0.82 renders the coarse band label'
  )

  // ==========================================================================
  // A4-25 — no numeric T / ±width oracle in ANY build (DEV is armed here)
  // ==========================================================================
  console.log('\n[A4-25] the meter renders no numeric trust/width readout …')
  for (const t of [0, 500_000, 820_000, 1_000_000]) {
    const markup = render(h(TrustWidthMeter, { tMicro: t }))
    const text = textOf(markup)
    ok(!/±\s*\d/.test(text), `T=${t / 1e6}: no "±<number>" in rendered text`)
    ok(!/\bT\s*=/.test(text), `T=${t / 1e6}: no "T =" readout in rendered text`)
    ok(!/\d\.\d/.test(text), `T=${t / 1e6}: no decimal number in rendered text`)
    ok(!/\b\d{2,}\b/.test(text), `T=${t / 1e6}: no multi-digit number in rendered text`)
    ok(
      !markup.includes('dev-only') && !markup.includes('arate-meter-dev'),
      `T=${t / 1e6}: the dev-only oracle block is gone`
    )
  }

  // ==========================================================================
  // A4-17 — provisional viewer: nothing rating-shaped, on any surface
  // ==========================================================================
  console.log('\n[A4-17] §6 provisional-information rule on RatingLadders/ProfilePage …')
  // Derived from the fixture PROTOCOL state (not hardcoded) so a legitimate
  // fixture retune cannot rot these pins — the RULE stays pinned either way.
  const miraElo = Object.fromEntries(mira.ladders.map((l) => [l.key, eloOf(l.state.r)]))
  const MIRA_NUMBERS = new RegExp(`\\b(${Object.values(miraElo).join('|')})\\b`)
  deepEq(Object.values(miraElo), [1702, 1731, 1688, 1573], 'mira protocol display-Elo goldens')
  const miraClassicalBracket = bracketOf(miraElo.Classical)
  const miraBracketStr = `${miraClassicalBracket.lo}–${miraClassicalBracket.hi}`
  eq(miraBracketStr, '800–1600', 'mira Classical spillover bracket golden')
  const provViewerPV = (ladderId) => ({
    root: 'viewer-root-b64u',
    ladderId,
    ratingMicro: 1_444_000_000,
    rdMicro: 118_000_000,
    tMicro: 0,
    display: { state: 'provisional', n: 62, of: 120 },
  })
  const rankedViewerPV = (ladderId) => ({
    root: 'viewer-root-b64u',
    ladderId,
    ratingMicro: 1_478_000_000,
    rdMicro: 62_000_000,
    tMicro: 0,
    display: { state: 'ranked', rating: 1478 },
  })
  const miraOpp = {}
  for (const l of mira.ladders) {
    miraOpp[l.key] = pairViewOf(mira.rootPub, `chess:${l.key}`, l.state, 0, l.key)
  }

  // (a) provisional viewer → every ladder projects 'unranked-pool'
  const provProjection = {}
  for (const l of mira.ladders) {
    provProjection[l.key] = visibleOpponentInfo(provViewerPV(`chess:${l.key}`), miraOpp[l.key])
    eq(
      provProjection[l.key].kind,
      'unranked-pool',
      `shared projection: provisional viewer on mira ${l.key} is 'unranked-pool'`
    )
  }
  const provFull = render(h(RatingLadders, { ladders: mira.ladders, projection: provProjection }))
  const provFullText = textOf(provFull)
  eq(count(provFull, 'Unranked pool'), 4, 'full mode: all 4 ladders render the Unranked pool state')
  ok(!provFull.includes('±'), 'full mode: no ± band anywhere')
  ok(!MIRA_NUMBERS.test(provFullText), 'full mode: none of mira’s ratings render')
  ok(!/\d–\d/.test(provFullText), 'full mode: no numeric bracket range renders')
  ok(!provFull.includes('aprof-spark'), 'full mode: no sparkline renders')
  ok(!provFull.includes('progressbar'), 'full mode: no reveal-progress renders')
  ok(!provFull.includes('aprof-bracket'), 'full mode: no bracket element renders')
  ok(provFull.includes('hidden while your own'), 'full mode: the §6 explainer renders instead')

  // (b) compact mode is a surface too — the projection binds there as well
  const provCompact = render(
    h(RatingLadders, { ladders: mira.ladders, projection: provProjection, compact: true })
  )
  const provCompactText = textOf(provCompact)
  eq(count(provCompact, 'Unranked pool'), 4, 'compact mode: all 4 ladders render Unranked pool')
  ok(!provCompact.includes('±'), 'compact mode: no ± band')
  ok(!MIRA_NUMBERS.test(provCompactText), 'compact mode: none of mira’s ratings render')
  ok(!MIRA_NUMBERS.test(provCompact), 'compact mode: no rating leaks via title attributes either')

  // (c) ranked viewer / spectator: revealed ratings, bracket ONLY for hidden
  const rankedProjection = {}
  for (const l of mira.ladders) {
    rankedProjection[l.key] = visibleOpponentInfo(rankedViewerPV(`chess:${l.key}`), miraOpp[l.key])
    deepEq(
      rankedProjection[l.key],
      spectatorOpponentInfo(miraOpp[l.key]),
      `ranked-viewer projection equals the spectator projection for ${l.key}`
    )
  }
  eq(rankedProjection.Bullet.kind, 'rating', 'ranked viewer sees mira Bullet rating')
  eq(rankedProjection.Classical.kind, 'bracket', 'ranked viewer sees mira Classical as a bracket')
  deepEq(
    rankedProjection.Classical,
    { kind: 'bracket', ...bracketOf(eloOf(mira.ladders[3].state.r)) },
    'the Classical bracket is bracketOf(eloOf(protocol rating)) — [800,1600)'
  )
  const rankedFull = render(h(RatingLadders, { ladders: mira.ladders, projection: rankedProjection }))
  const rankedFullText = textOf(rankedFull)
  ok(
    ['Bullet', 'Blitz', 'Rapid'].every((k) => rankedFullText.includes(String(miraElo[k]))),
    'ranked viewer: revealed ratings render'
  )
  ok(rankedFull.includes(miraBracketStr), 'ranked viewer: hidden Classical renders the quantized bracket')
  ok(
    !new RegExp(`\\b${miraElo.Classical}\\b`).test(rankedFullText),
    'ranked viewer: the precise hidden rating NEVER renders'
  )

  // (d) the previously-missing 'banned' branch (A5 J4 public fact)
  const banState = { n: 200, r: 1_650_000_000, rd: 60_000_000 }
  const ban = { until: MOCK_NOW + 30 * DAY }
  const bannedDisplay = displayState(banState, 'Blitz', ban, MOCK_NOW)
  eq(bannedDisplay.state, 'banned', 'displayState with an active ban derives banned')
  const bannedLadder = { key: 'Blitz', state: banState, display: bannedDisplay, games: 200 }
  const bannedOppPV = pairViewOf('banned-root', 'chess:Blitz', banState, 0, 'Blitz', ban, MOCK_NOW)
  const bannedInfo = visibleOpponentInfo(provViewerPV('chess:Blitz'), bannedOppPV)
  eq(bannedInfo.kind, 'banned', 'a ban is a public fact: it projects even to a provisional viewer')
  const bannedProjected = render(
    h(RatingLadders, { ladders: [bannedLadder], projection: { Blitz: bannedInfo } })
  )
  ok(bannedProjected.includes('Banned'), "full mode renders the projected 'banned' OpponentInfo branch")
  ok(!/\b1650\b/.test(textOf(bannedProjected)), 'banned branch: the rating never renders')
  const bannedOwn = render(h(RatingLadders, { ladders: [bannedLadder] }))
  ok(bannedOwn.includes('Banned'), 'full mode renders an OWN banned ladder state')
  ok(!/\b1650\b/.test(textOf(bannedOwn)), 'own banned ladder: the rating never renders')
  const bannedCompact = render(
    h(RatingLadders, { ladders: [bannedLadder], projection: { Blitz: bannedInfo }, compact: true })
  )
  ok(bannedCompact.includes('Banned'), 'compact mode renders the banned state too')
  deepEq(
    pairingLegal(bannedOppPV, rankedViewerPV('chess:Blitz'), MOCK_NOW),
    { legal: false, reason: 'banned' },
    'and the banned ladder is unpairable under the shared pairingLegal'
  )

  // (e) ProfilePage end-to-end — SPECTATOR first (store boots signed out)
  eq(accountsUiStore.getState().signedIn, false, 'store boots signed OUT (spectator viewer)')
  const spectatorPage = render(h(ProfilePage, { handle: 'mira#T8FQ2', onBack: () => {} }))
  const spectatorText = textOf(spectatorPage)
  ok(
    spectatorText.includes(String(miraElo.Bullet)) && spectatorText.includes(String(miraElo.Blitz)),
    'spectator ProfilePage: revealed ratings render'
  )
  ok(spectatorPage.includes(miraBracketStr), 'spectator ProfilePage: hidden Classical renders its bracket')
  ok(
    !new RegExp(`\\b${miraElo.Classical}\\b`).test(spectatorText),
    'spectator ProfilePage: the precise hidden rating never renders'
  )
  ok(!spectatorPage.includes('Unranked pool'), 'spectator ProfilePage: not the provisional projection')

  // (f) ProfilePage end-to-end — REAL signed-in placement/provisional viewer
  //     (real store → real argon2id + chain; fresh account = placement 0/10)
  console.log('  · creating a real account through the store (argon2id — a few seconds) …')
  const created = await accountsUiStore.createAccount('a4uiviewer', 'correct horse battery staple')
  eq(created, true, 'store createAccount succeeds under node')
  accountsUiStore.finishCreate()
  const st = accountsUiStore.getState()
  eq(st.signedIn, true, 'store is signed in after finishCreate')
  ok(
    st.account.ladders.every((l) => l.display.state === 'placement'),
    'fresh account: every ladder is placement (a §6-hidden viewer)'
  )
  ok(
    st.viewerDisplay && ['Bullet', 'Blitz', 'Rapid', 'Classical'].every((k) => st.viewerDisplay[k]),
    'store derives viewerDisplay for all four ladders (shared displayState)'
  )
  const provPage = render(h(ProfilePage, { handle: 'mira#T8FQ2', onBack: () => {} }))
  const provPageText = textOf(provPage)
  eq(count(provPage, 'Unranked pool'), 4, 'hidden viewer ProfilePage: all 4 mira ladders are Unranked pool')
  ok(!MIRA_NUMBERS.test(provPageText), 'hidden viewer ProfilePage: no mira rating renders anywhere')
  ok(!provPage.includes('±'), 'hidden viewer ProfilePage: no ± band renders')
  ok(!provPage.includes(miraBracketStr), 'hidden viewer ProfilePage: no bracket renders')
  ok(
    provPage.includes('where your own rating is still hidden'),
    'hidden viewer ProfilePage: the §6 explainer names the rule'
  )
  // The exported projection helper is what the page rendered:
  const pageProjection = projectionFor(mira, st.account.rootPub, st.account.ladders, st.viewerDisplay)
  ok(
    Object.values(pageProjection).every((p) => p.kind === 'unranked-pool'),
    'projectionFor(hidden viewer) is unranked-pool on every ladder'
  )

  // A4-26 / A4-27 — REMOVED WITH THE OLD RATED LOBBY.
  //
  // Both asserted §6 information rules against features/account/rated/RatedLobby
  // (demo pairings satisfy mm/pairing.pairingLegal; a provisional player's client
  // renders no spillover bracket and no opponent rating). The lobby was deleted
  // when rated play moved into Play — the RULES still hold and still matter, so
  // these must be re-pointed at the new rated flow rather than dropped. The
  // shared authorities they check (pairingLegal, displayState, widthBand) are
  // still covered by A4-28, A4-17, A4-18 and A4-25 above.

  // ==========================================================================
  // A4-29 — C-12 degradation carriers render as a VISIBLE degraded state
  // ==========================================================================
  console.log('\n[A4-29] degraded reconstruction renders degraded — never silently complete …')
  eq(adrift.reconstruction.path, 'floor', 'fixture carries the floor path (resolveProfile status)')
  eq(adrift.reconstruction.revocationContested, true, 'fixture carries revocationContested (C-12)')
  eq(adrift.checkpoint.mOfN, false, 'fixture carries the below-threshold checkpoint (mOfN:false)')
  const degradedPage = render(
    h(ProfilePage, { handle: 'adrift#P9GH3', onBack: () => {}, initialRevealed: true })
  )
  ok(degradedPage.includes('Revocation contested'), 'revealed page: revocation-contested banner renders')
  ok(
    degradedPage.includes('floor path — degraded view'),
    'revealed page: the floor-path degradation badge renders'
  )
  ok(
    degradedPage.includes('checkpoint below cosigner threshold'),
    'revealed page: the below-M-of-N checkpoint chip renders'
  )
  const healthyPage = render(
    h(ProfilePage, { handle: 'mira#T8FQ2', onBack: () => {}, initialRevealed: true })
  )
  ok(
    !healthyPage.includes('Revocation contested') &&
      !healthyPage.includes('floor path — degraded view') &&
      !healthyPage.includes('checkpoint below cosigner threshold'),
    'healthy profile: none of the degradation chips render'
  )
  const gate = render(h(ProfilePage, { handle: 'adrift#P9GH3', onBack: () => {} }))
  ok(gate.includes('Reconstructing'), 'owner-offline profile opens with the §5 reconstruction stage')
  const floorCard = render(h(ReconstructionCard, { profile: adrift, onDone: () => {} }))
  ok(
    floorCard.includes('Reconstruction floor:') && floorCard.includes('never silent'),
    'ReconstructionCard names the floor path degradation (C-12, never silent)'
  )
  const expectedCard = render(h(ReconstructionCard, { profile: vanished, onDone: () => {} }))
  ok(
    expectedCard.includes('Guaranteed: the union of what survivors hold'),
    'ReconstructionCard renders the expected-path copy for a full reconstruction'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
