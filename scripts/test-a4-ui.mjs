// Headless RENDER test for the A4 accounts UI (src/renderer/src/features/
// account/**) and for the rated-play surface it feeds (features/play/online/**).
// The suite that makes the A4 renderer review fixes revert-proof.
// Every pinned behavior below was applied in the 2026-07 A4 fix pass and then
// found UNENFORCED by the re-verification (no script rendered any .tsx, so a
// silent revert kept all suites green). This suite renders the real components
// with react-dom/server and asserts the §6/§7/§12 rendering rules hold in the
// produced markup.
//
//   node scripts/test-a4-ui.mjs
//
// Pins (one section per review id):
//   A4-17  provisional viewer sees NOTHING rating-shaped about anyone.
//          RatingLadders/ProfilePage render through the SHARED projections
//          (mm/pairing visibleOpponentInfo / spectatorOpponentInfo); plus the
//          previously-missing 'banned' OpponentInfo branch renders.
//   A4-18  the SHARED quadratic width() curve holds its goldens
//          (widthMin + floor(widthSpan·(1−T)²)) at several T: a local linear
//          curve differs at every interior test point.
//   A4-25  the meter renders NO numeric trust/width oracle (no "T = …",
//          no "±N") in any build: §7 widening is invisible.
//   A4-26  the rated flow in Play → Online satisfies mm/pairing.pairingLegal
//          on the EXACT PairViews it builds (features/play/online/
//          ratedPairing.ownPairView), and its opponent card refuses to render
//          a pairing the protocol rejects.
//   A4-27  on a ladder where the signed-in account is NOT ranked, no spillover
//          bracket and no opponent rating ever renders on that client. Not
//          even when the counterparty advertises a revealed rating (§6).
//   A4-28  every fixture UiLadder.display IS displayState(state, key). The
//          shared §6 authority (PARAMS_A4 reveal thresholds 120/100/80/40).
//   A4-29  the degradation carriers (reconstruction.path='floor',
//          revocationContested, checkpoint.mOfN=false: the viewer.ts
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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const ACCT_UI = resolve(ROOT, 'src/renderer/src/features/account').replace(/\\/g, '/')
// The rated surface moved here when rated play became a choice inside Play →
// Online. Only its PURE modules are imported: they deliberately never reach the
// matchmaking engine, so no relay transport is pulled into this process.
const PLAY_UI = resolve(ROOT, 'src/renderer/src/features/play').replace(/\\/g, '/')

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
// node ≥21 defines globalThis.navigator as getter-only, defineProperty it.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'nodechess-a4-ui-suite (node)' },
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
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`
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
      `export { RatedOpponentCard } from '${PLAY_UI}/online/RatedOpponentCard.tsx'`,
      `export { RATED_LADDERS, ownPairView, ratedLadderId, ratedLadderOf } from '${PLAY_UI}/online/ratedPairing.ts'`,
      `export { timeControlById } from '${PLAY_UI}/timeControl.ts'`,
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
    // node_modules at runtime: node loads their CJS fine, and the whole
    // graph shares ONE react instance. The renderer/shared PROJECT tree is
    // what gets bundled (alias resolves @shared to a path first).
    packages: 'external',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    // DEV=true ARMS the dev-only module-scope invariants (ratedPairing throws
    // on import if the picker's speed categories and the protocol's ladder
    // categories ever disagree) and proves no dev-only numeric oracle renders
    // (A4-25).
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
    RatedOpponentCard,
    RATED_LADDERS,
    ownPairView,
    ratedLadderId,
    ratedLadderOf,
    timeControlById,
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
  ok(true, 'bundle imported: account + rated-play module-scope invariants held (DEV armed)')

  const mira = PROFILES['mira#T8FQ2']
  const adrift = PROFILES['adrift#P9GH3']
  const vanished = PROFILES['vanished#Q3XR7']
  const newbie = PROFILES['newbie#F2PLC']
  ok(mira && adrift && vanished && newbie, 'fixture profiles present (mira/adrift/vanished/newbie)')

  // ==========================================================================
  // A4-28: fixture display states ARE the shared displayState() output
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
  // A4-18: the shared quadratic width() curve, and A4-25, no trust oracle
  // ==========================================================================
  // TrustWidthMeter is GONE. It rendered a band plus several paragraphs telling
  // the player how pairing widens under suspicion, which is a description of the
  // anticheat mechanism handed to the person it defends against.
  //
  // Its two rules still matter, so they are pinned WITHOUT it:
  //  A4-18 kept its golden values of the shared width() curve. Those are what
  //        actually stop a regression back to the linear curve; the deleted
  //        component only mirrored them into CSS percentages.
  //  A4-25 is now a SOURCE scan instead of a render assertion, which is strictly
  //        stronger: it fails if the vocabulary appears in any player-facing file
  //        at all, whether or not a code path currently renders it. Grepping for
  //        this after the fact is how the old copy survived three cleanup passes.
  console.log('\n[A4-18] the shared quadratic width() curve holds its goldens …')
  eq(width(1_000_000), 50, 'width(T=1) golden: 50')
  eq(width(500_000), 162, 'width(T=0.5) golden: 162')
  eq(width(0), 500, 'width(T=0) golden: 500')
  for (const t of [250_000, 500_000, 750_000]) {
    const linear = PARAMS_A4.widthMin + Math.floor((PARAMS_A4.widthSpan * (1_000_000 - t)) / 1_000_000)
    ok(linear !== width(t), `T=${t / 1e6}: linear curve (${linear}) is not the quadratic (${width(t)})`)
  }

  console.log('\n[A4-25] no player-facing file names trust, suspicion or pairing width …')
  {
    const roots = [
      resolve(ROOT, 'src/renderer/src/features/play'),
      resolve(ROOT, 'src/renderer/src/features/account'),
      resolve(ROOT, 'src/seed'),
    ]
    const files = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.tsx')) files.push(full)
      }
    }
    for (const r of roots) walk(r)
    ok(files.length > 20, `scanned ${files.length} player-facing .tsx files`)

    // Vocabulary that must never reach a player. Matched against JSX TEXT and
    // string literals only, so the identical words stay legal in code comments
    // and in identifiers like trustT / tMicro, which are implementation.
    const BANNED = [
      /trust[- ]earned/i,
      /island term/i,
      /precision is earned/i,
      /comparable[- ]suspicion/i,
      /suspicion/i,
      /trust score/i,
      /pairing window/i,
      /\bwidest\b/i,
      /precision band/i,
      /standard band/i,
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      // Strip // and /* */ comments so implementation prose is exempt.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const rel = f.slice(ROOT.length + 1)
      for (const re of BANNED) {
        ok(!re.test(code), `${rel}: no ${String(re)} in code or copy`)
      }
      ok(!/\bT\s*=\s*\{?\s*\d/.test(code), `${rel}: no numeric "T =" trust readout`)
      ok(!/±\s*\{?\s*\d/.test(code), `${rel}: no "±<number>" width readout`)
    }
  }

  // ==========================================================================
  // A4-17. Provisional viewer: nothing rating-shaped, on any surface
  // ==========================================================================
  console.log('\n[A4-17] §6 provisional-information rule on RatingLadders/ProfilePage …')
  // Derived from the fixture PROTOCOL state (not hardcoded) so a legitimate
  // fixture retune cannot rot these pins. The RULE stays pinned either way.
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
  // Same deletion as above: the explainer sentence was exposition. The six
  // negative assertions immediately preceding are the actual §6 rule.
  ok(provFullText.trim().length > 40, 'full mode: the page still renders without leaking a rating')

  // (b) compact mode is a surface too. The projection binds there as well
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
    'the Classical bracket is bracketOf(eloOf(protocol rating)), [800,1600)'
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

  // (e) ProfilePage end-to-end: SPECTATOR first (store boots signed out).
  // The page has NO fixture path: the app resolves every profile it shows over
  // the network, so this suite hands the resolved profile in on the `profile`
  // prop. That is the only way these accounts reach a render, here or anywhere.
  eq(accountsUiStore.getState().signedIn, false, 'store boots signed OUT (spectator viewer)')
  const spectatorPage = render(
    h(ProfilePage, { handle: mira.handle, profile: mira, onBack: () => {} })
  )
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

  // (f) ProfilePage end-to-end: REAL signed-in placement/provisional viewer
  //     (real store → real argon2id + chain; fresh account = placement 0/10)
  console.log('  · creating a real account through the store (argon2id, a few seconds) …')
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
  const provPage = render(h(ProfilePage, { handle: mira.handle, profile: mira, onBack: () => {} }))
  const provPageText = textOf(provPage)
  eq(count(provPage, 'Unranked pool'), 4, 'hidden viewer ProfilePage: all 4 mira ladders are Unranked pool')
  ok(!MIRA_NUMBERS.test(provPageText), 'hidden viewer ProfilePage: no mira rating renders anywhere')
  ok(!provPage.includes('±'), 'hidden viewer ProfilePage: no ± band renders')
  ok(!provPage.includes(miraBracketStr), 'hidden viewer ProfilePage: no bracket renders')
  // The old §6 explainer sentence ("where your own rating is still hidden") was
  // deleted on purpose: it explained the rule instead of doing anything. The rule
  // itself is enforced by the three negative assertions above, which are what
  // actually matter. Pin that the page still renders rather than blanking.
  ok(provPageText.trim().length > 40, 'hidden viewer ProfilePage still renders a page')
  // The exported projection helper is what the page rendered:
  const pageProjection = projectionFor(mira, st.account.rootPub, st.account.ladders, st.viewerDisplay)
  ok(
    Object.values(pageProjection).every((p) => p.kind === 'unranked-pool'),
    'projectionFor(hidden viewer) is unranked-pool on every ladder'
  )

  // ==========================================================================
  // A4-26: the rated flow's OWN PairViews satisfy the shared pairingLegal
  // ==========================================================================
  // Re-pointed from the deleted account/rated/RatedLobby onto the surface that
  // replaced it: Play → Online's rated pool. `ownPairView` is the builder the
  // live panel calls for the signed-in account, and the counterparty's side is
  // that same projection built by THEIR client and carried in the signed seek,
  // so the views below are the exact ones the surface pairs and renders on.
  console.log('\n[A4-26] the rated flow’s PairViews satisfy mm/pairing.pairingLegal …')
  // Preview trust for the two sides (micro-units, §7 recomputable-by-anyone) and
  // the pinned instant both were evaluated at (A4-16): pairingLegal REQUIRES an
  // atWts, and a legality verdict must never depend on the auditor's clock.
  const OWN_TRUST_MICRO = 820_000
  const OPP_TRUST_MICRO = 700_000
  const PAIRING_WTS = 1_700_000_000_000
  /** Both sides of a pairing on `key`, built the way the surface builds them. */
  const pairOn = (key) => {
    const ownL = OWN_ACCOUNT.ladders.find((l) => l.key === key)
    const oppL = newbie.ladders.find((l) => l.key === key)
    return {
      own: ownPairView(OWN_ACCOUNT.rootPub, key, ownL.state, OWN_TRUST_MICRO),
      opp: ownPairView(newbie.rootPub, key, oppL.state, OPP_TRUST_MICRO),
    }
  }
  // The ladder a clock rates in IS half of a PairView's identity: the pool the
  // surface advertises must be the pool both sides key their pairing on.
  eq(ratedLadderOf(timeControlById('1+0')), 'Bullet', 'the picker’s 1+0 rates on the Bullet ladder')
  eq(ratedLadderOf(timeControlById('3+2')), 'Blitz', 'the picker’s 3+2 rates on the Blitz ladder')
  eq(ratedLadderOf(timeControlById('10+5')), 'Rapid', 'the picker’s 10+5 rates on the Rapid ladder')
  eq(ratedLadderOf(timeControlById('30+0')), 'Classical', 'the picker’s 30+0 rates on the Classical ladder')
  eq(ratedLadderOf(timeControlById('unlimited')), null, 'Unlimited rates on no ladder at all (§6)')
  for (const key of RATED_LADDERS) {
    const pv = pairOn(key)
    eq(pv.own.ladderId, ratedLadderId(key), `${key}: our view carries the ladder id the pool keys on`)
    eq(pv.opp.ladderId, ratedLadderId(key), `${key}: their view carries the same ladder id`)
    deepEq(
      pairingLegal(pv.own, pv.opp, PAIRING_WTS),
      { legal: true },
      `${key}: the pairing is LEGAL on the exact PairViews the surface builds`
    )
    deepEq(
      pairingLegal(pv.opp, pv.own, PAIRING_WTS),
      pairingLegal(pv.own, pv.opp, PAIRING_WTS),
      `${key}: legality is symmetric`
    )
  }
  // Blitz is the true spillover: we are ranked, they are not, and both sit on
  // the same fixed rail. Derived (not hardcoded) so a fixture retune cannot rot
  // the pins below.
  const blitzPv = pairOn('Blitz')
  eq(blitzPv.own.display.state, 'ranked', 'Blitz: our side is ranked (a true spillover)')
  ok(blitzPv.opp.display.state !== 'ranked', 'Blitz: their side is still hidden')
  eq(
    bracketOf(eloOf(blitzPv.own.ratingMicro)).lo,
    bracketOf(eloOf(blitzPv.opp.ratingMicro)).lo,
    'Blitz: both sides sit on the same §7 spillover rail'
  )
  const oppElo = eloOf(blitzPv.opp.ratingMicro)
  const oppBracket = bracketOf(oppElo)
  const oppBracketStr = `${oppBracket.lo}–${oppBracket.hi}`
  eq(oppElo, 1493, 'hidden Blitz display-Elo golden')
  eq(oppBracketStr, '800–1600', 'spillover bracket golden')
  const rankedCard = render(
    h(RatedOpponentCard, {
      own: blitzPv.own,
      opp: blitzPv.opp,
      atWts: PAIRING_WTS,
      ladderKey: 'Blitz',
    })
  )
  const rankedCardText = textOf(rankedCard)
  ok(rankedCard.includes(oppBracketStr), 'ranked viewer: the card shows the quantized BRACKET (shared projection)')
  ok(
    !new RegExp(`\\b${oppElo}\\b`).test(rankedCardText),
    'ranked viewer: the opponent’s precise hidden rating never renders'
  )
  // Fail-closed: the card re-runs pairingLegal on what it is about to render, so
  // a pairing the protocol rejects is never dressed up as a game.
  const crossLadder = render(
    h(RatedOpponentCard, {
      own: blitzPv.own,
      opp: pairOn('Rapid').opp,
      atWts: PAIRING_WTS,
      ladderKey: 'Blitz',
    })
  )
  ok(crossLadder.includes('Pairing refused'), 'an illegal pairing renders the refusal, not an opponent')
  // The raw verdict id ('ladder-mismatch') no longer leaks into player copy. The
  // rule is that an illegal pairing refuses instead of inventing an opponent,
  // which the assertion above and the no-bracket assertion below both cover.
  ok(!crossLadder.includes('ladder-mismatch'), 'the refusal does NOT leak the raw verdict id')
  ok(!/\d+–\d+/.test(textOf(crossLadder)), 'refused pairing: no bracket renders')
  // A missing counterparty view is an honest gap, never a placeholder number.
  const noOppCard = render(
    h(RatedOpponentCard, { own: blitzPv.own, opp: null, atWts: PAIRING_WTS, ladderKey: 'Blitz' })
  )
  // Wording changed; the rule is that it never invents a rating, pinned by the
  // not-one-digit assertion below.
  ok(noOppCard.trim().length > 20, 'no counterparty view yet: the card renders something honest')
  ok(!/\d/.test(textOf(noOppCard)), 'no counterparty view yet: not one digit renders')

  // ==========================================================================
  // A4-27: no spillover bracket / no opponent rating on a hidden client
  // ==========================================================================
  console.log('\n[A4-27] no spillover bracket on a provisional player’s client …')
  // A counterparty who is loudly RANKED on the same rail: the pairing is legal
  // and a ranked viewer would see the number, so the silence below is the §6
  // rendering rule doing its job: not an accident of the fixtures.
  const loudOpp = (key) =>
    ownPairView(newbie.rootPub, key, { n: 400, r: 1_499_000_000, rd: 55_000_000 }, OPP_TRUST_MICRO)
  eq(loudOpp('Blitz').display.state, 'ranked', 'the loud counterparty is ranked (400 games)')
  for (const key of ['Bullet', 'Classical']) {
    const pv = pairOn(key)
    ok(pv.own.display.state !== 'ranked', `${key}: the signed-in account is NOT ranked here`)
    const loud = loudOpp(key)
    deepEq(
      pairingLegal(pv.own, loud, PAIRING_WTS),
      { legal: true },
      `${key}: pairing with the ranked counterparty is legal (so the card is not merely refusing)`
    )
    for (const [label, opp] of [
      ['hidden counterparty', pv.opp],
      ['ranked counterparty', loud],
    ]) {
      const markup = render(
        h(RatedOpponentCard, { own: pv.own, opp, atWts: PAIRING_WTS, ladderKey: key })
      )
      const text = textOf(markup)
      ok(markup.includes('Unranked opponent pool'), `${key} / ${label}: the pool state renders`)
      ok(!markup.includes(oppBracketStr), `${key} / ${label}: no spillover bracket renders`)
      ok(!/\d+–\d+/.test(text), `${key} / ${label}: no bracket range of any shape renders`)
      ok(!/\d/.test(text), `${key} / ${label}: not one digit renders. No rating can leak`)
    }
  }
  // The control: the SAME loud counterparty against a ranked viewer DOES render
  // its rating, so the assertions above pin the §6 rule and not a blank card.
  const controlCard = render(
    h(RatedOpponentCard, {
      own: blitzPv.own,
      opp: loudOpp('Blitz'),
      atWts: PAIRING_WTS,
      ladderKey: 'Blitz',
    })
  )
  ok(
    /\b1499\b/.test(textOf(controlCard)),
    'control: a ranked viewer DOES see a ranked opponent’s rating. The rule above is not vacuous'
  )

  // ==========================================================================
  // A4-29: C-12 degradation carriers render as a VISIBLE degraded state
  // ==========================================================================
  console.log('\n[A4-29] degraded reconstruction renders degraded: never silently complete …')
  eq(adrift.reconstruction.path, 'floor', 'fixture carries the floor path (resolveProfile status)')
  eq(adrift.reconstruction.revocationContested, true, 'fixture carries revocationContested (C-12)')
  eq(adrift.checkpoint.mOfN, false, 'fixture carries the below-threshold checkpoint (mOfN:false)')
  const degradedPage = render(
    h(ProfilePage, {
      handle: adrift.handle,
      profile: adrift,
      onBack: () => {},
      initialRevealed: true,
    })
  )
  // C-12 is now ONE sentence instead of three mechanism chips. Every degradation
  // the resolve can report (floor path, contested revocation, checkpoint under
  // the cosigner threshold) collapses to the single bit a player can act on:
  // part of this is missing. The rule is unchanged and strictly better stated,
  // so it is pinned on the new copy. A degraded view must never read as complete.
  ok(
    degradedPage.includes('Some of this profile could not be loaded'),
    'revealed page: a degraded view says so, in one sentence'
  )
  ok(
    !degradedPage.includes('Revocation contested') &&
      !degradedPage.includes('cosigner threshold') &&
      !degradedPage.includes('floor path'),
    'revealed page: the underlying mechanisms are NOT named to the player'
  )
  // The healthy counterpart: a complete view must NOT show the incomplete notice,
  // otherwise the signal means nothing.
  const healthyPage = render(
    h(ProfilePage, {
      handle: mira.handle,
      profile: mira,
      onBack: () => {},
      initialRevealed: true,
    })
  )
  ok(
    !healthyPage.includes('Some of this profile could not be loaded'),
    'healthy profile: no incomplete notice renders'
  )

  const gate = render(h(ProfilePage, { handle: adrift.handle, profile: adrift, onBack: () => {} }))
  ok(gate.includes('Loading'), 'owner-offline profile opens with the loading stage')

  // ReconstructionCard is now purely the waiting state. Naming the floor path was
  // its old job and moved to ProfilePage's single sentence, pinned above. What it
  // must still never do is leak the mechanism while waiting.
  const floorCard = render(h(ReconstructionCard, { profile: adrift, onDone: () => {} }))
  ok(floorCard.includes('Loading'), 'ReconstructionCard renders the waiting state')
  ok(
    !floorCard.includes('Reconstruction floor') && !floorCard.includes('shard'),
    'ReconstructionCard names no mechanism to the player'
  )
  const expectedCard = render(h(ReconstructionCard, { profile: vanished, onDone: () => {} }))
  ok(
    !/survivors|union of what|shard|checkpoint/i.test(textOf(expectedCard)),
    'ReconstructionCard leaks no storage mechanism on the expected path either'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
