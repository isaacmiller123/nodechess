// Headless test for the update decision logic (src/main/updates/updateLogic.ts.
// The PURE half of the update service; no electron imports, so it bundles
// straight into bare node).
//
// Pins the contract the update feature stands on:
//
//   decideUpdatePath      the mac-vs-win decision table. BINDING: this app
//                         ships UNSIGNED, so electron-updater (in-place
//                         auto-update) is ONLY ever chosen on packaged
//                         Windows; macOS ALWAYS gets notify-download (Squirrel
//                         .Mac refuses unsigned bundles), as do dev builds and
//                         unknown platforms.
//   parseSemver/cmpSemver semver goldens incl. v-prefix, prerelease ordering
//   isNewerVersion        (§11), build metadata, malformed input → never nag.
//   latestReleaseApiUrl   feed-URL construction (public GitHub API, no token).
//   parseLatestRelease    /releases/latest payload narrowing.
//   pickMacAsset/…        asset selection against the EXACT artifact names
//                         electron-builder.yml produces.
//
//   node scripts/test-updater.mjs
//
// Final line: 'ALL GREEN: N assertions'. Exit 0 = all green.

import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- tiny assert kit --------------------------------------------------------
let passed = 0
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
  passed++
  console.log(`  ✓ ${msg}`)
}
function eq(actual, expected, msg) {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ---- bundle -----------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'updater-'))
const outfile = resolve(tmp, 'bundle.mjs')
await build({
  entryPoints: [resolve(ROOT, 'src/main/updates/updateLogic.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})

try {
  const {
    UPDATE_OWNER,
    UPDATE_REPO,
    decideUpdatePath,
    parseSemver,
    cmpSemver,
    isNewerVersion,
    latestReleaseApiUrl,
    parseLatestRelease,
    pickMacAsset,
    pickWinAsset,
    pickLinuxAsset,
    pickAssetForPlatform
  } = await import(pathToFileURL(outfile).href)

  // ==========================================================================
  // 1. decideUpdatePath, the mac-vs-win decision table (BINDING).
  // ==========================================================================
  console.log('decideUpdatePath: unsigned-build decision table')
  const TABLE = [
    // [platform, packaged, expected]
    ['win32', true, 'electron-updater'], // packaged Windows: true in-place auto-update
    ['win32', false, 'notify-download'], // dev on Windows: never touch the real installer
    ['darwin', true, 'notify-download'], // mac packaged: UNSIGNED → Squirrel refuses; NEVER in-place
    ['darwin', false, 'notify-download'], // mac dev
    ['linux', true, 'notify-download'], // linux ships an AppImage + deb, but never in-place
    ['freebsd', false, 'notify-download'] // anything unknown
  ]
  for (const [platform, packaged, want] of TABLE) {
    eq(
      decideUpdatePath(platform, packaged),
      want,
      `${platform} ${packaged ? 'packaged' : 'dev'} → ${want}`
    )
  }
  ok(
    !TABLE.some(([p, , want]) => p === 'darwin' && want === 'electron-updater'),
    'no darwin row may EVER map to electron-updater (unsigned build)'
  )

  // ==========================================================================
  // 2. semver, parse goldens.
  // ==========================================================================
  console.log('\nparseSemver: goldens')
  eq(JSON.stringify(parseSemver('1.2.3')), '{"major":1,"minor":2,"patch":3,"pre":[]}', 'plain 1.2.3')
  eq(JSON.stringify(parseSemver('v1.2.3')), '{"major":1,"minor":2,"patch":3,"pre":[]}', 'v-prefix stripped')
  eq(JSON.stringify(parseSemver(' V10.0.1 ')), '{"major":10,"minor":0,"patch":1,"pre":[]}', 'V-prefix + whitespace')
  eq(
    JSON.stringify(parseSemver('1.2.3-beta.1')),
    '{"major":1,"minor":2,"patch":3,"pre":["beta","1"]}',
    'prerelease identifiers split'
  )
  eq(JSON.stringify(parseSemver('1.2.3+build.7')?.pre), '[]', 'build metadata ignored')
  eq(parseSemver('1.2'), null, 'two-part version → null')
  eq(parseSemver('1.2.3.4'), null, 'four-part version → null')
  eq(parseSemver(''), null, 'empty → null')
  eq(parseSemver('latest'), null, 'non-numeric → null')
  eq(parseSemver('1.2.x'), null, 'wildcard → null')

  // ==========================================================================
  // 3. semver, ordering goldens (cmpSemver via isNewerVersion).
  // ==========================================================================
  console.log('\nisNewerVersion: ordering goldens')
  const NEWER = [
    // [latest, current] where latest IS newer
    ['1.1.7', '1.1.6'],
    ['1.2.0', '1.1.9'],
    ['2.0.0', '1.9.9'],
    ['v1.2.0', '1.1.6'], // tag shape vs app.getVersion() shape
    ['1.2.0', 'v1.1.6'],
    ['1.0.0', '1.0.0-rc.1'], // release outranks its prerelease
    ['1.0.0-rc.2', '1.0.0-rc.1'], // numeric prerelease ordering
    ['1.0.0-rc.10', '1.0.0-rc.9'], // …numeric, not lexicographic
    ['1.0.0-beta', '1.0.0-alpha'], // alphanumeric prerelease ordering
    ['1.0.0-alpha.1', '1.0.0-alpha'], // longer prerelease sorts after its prefix
    ['1.0.0-1', '1.0.0-0'],
    ['1.0.0-a', '1.0.0-999'] // numeric < alphanumeric (semver §11)
  ]
  for (const [a, b] of NEWER) {
    eq(isNewerVersion(a, b), true, `${a} newer than ${b}`)
    eq(isNewerVersion(b, a), false, `${b} NOT newer than ${a}`)
  }
  const EQUAL = [
    ['1.1.6', '1.1.6'],
    ['v1.1.6', '1.1.6'],
    ['1.1.6+build.9', '1.1.6'], // build metadata never differentiates
    ['1.0.0-rc.1', '1.0.0-rc.1']
  ]
  for (const [a, b] of EQUAL) {
    eq(isNewerVersion(a, b), false, `${a} not newer than ${b} (equal)`)
    eq(isNewerVersion(b, a), false, `${b} not newer than ${a} (equal)`)
  }
  console.log('malformed input → false (never nag off garbage)')
  eq(isNewerVersion('garbage', '1.1.6'), false, 'malformed latest → false')
  eq(isNewerVersion('1.2.0', 'garbage'), false, 'malformed current → false')
  eq(isNewerVersion('', ''), false, 'empty both → false')
  console.log('cmpSemver: symmetry sanity')
  eq(cmpSemver(parseSemver('1.2.3'), parseSemver('1.2.3')), 0, 'equal triples → 0')
  eq(cmpSemver(parseSemver('1.2.4'), parseSemver('1.2.3')), 1, 'patch bump → 1')
  eq(cmpSemver(parseSemver('1.2.3'), parseSemver('1.2.4')), -1, 'patch drop → -1')

  // ==========================================================================
  // 4. Feed-URL construction.
  // ==========================================================================
  console.log('\nlatestReleaseApiUrl: construction')
  eq(UPDATE_OWNER, 'isaacmiller123', 'owner constant')
  eq(UPDATE_REPO, 'nodechess', 'repo constant')
  eq(
    latestReleaseApiUrl(),
    'https://api.github.com/repos/isaacmiller123/nodechess/releases/latest',
    'default feed URL'
  )
  eq(
    latestReleaseApiUrl('o', 'r'),
    'https://api.github.com/repos/o/r/releases/latest',
    'parameterized feed URL'
  )

  // ==========================================================================
  // 5. parseLatestRelease, payload narrowing.
  // ==========================================================================
  console.log('\nparseLatestRelease: payload narrowing')
  const good = parseLatestRelease({
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/isaacmiller123/nodechess/releases/tag/v1.2.0',
    assets: [
      { name: 'nodechess-Setup-1.2.0.exe', browser_download_url: 'https://x/nodechess-Setup-1.2.0.exe' },
      { name: 'nodechess-1.2.0-arm64.dmg', browser_download_url: 'https://x/nodechess-1.2.0-arm64.dmg' },
      { name: 'not-a-real-asset' } // missing url → skipped, not fatal
    ]
  })
  ok(good !== null, 'well-formed payload parses')
  eq(good.version, '1.2.0', "tag 'v1.2.0' → version '1.2.0' (v stripped)")
  eq(good.assets.length, 2, 'malformed asset entries are skipped')
  eq(good.assets[0].url, 'https://x/nodechess-Setup-1.2.0.exe', 'asset url comes from browser_download_url')
  eq(
    good.releaseUrl,
    'https://github.com/isaacmiller123/nodechess/releases/tag/v1.2.0',
    'release page URL captured'
  )
  eq(parseLatestRelease(null), null, 'null payload → null')
  eq(parseLatestRelease('nope'), null, 'string payload → null')
  eq(parseLatestRelease({}), null, 'missing tag_name → null')
  eq(parseLatestRelease({ tag_name: 'latest' }), null, 'non-semver tag → null')
  const noAssets = parseLatestRelease({ tag_name: '1.3.0' })
  ok(noAssets !== null && noAssets.assets.length === 0, 'missing assets array → empty list, not null')

  // ==========================================================================
  // 6. Asset selection, against electron-builder.yml's EXACT artifact names.
  // ==========================================================================
  console.log('\npickMacAsset / pickWinAsset: artifact-name goldens')
  const V = '1.2.0'
  const RELEASE_ASSETS = [
    { name: `nodechess-Setup-${V}.exe`, url: 'u:setup' }, // nsis (the auto-update target)
    { name: `nodechess-Portable-${V}.exe`, url: 'u:portable' }, // portable, NEVER offered
    { name: `nodechess-${V}-win-x64.zip`, url: 'u:winzip' },
    { name: `nodechess-${V}-arm64.dmg`, url: 'u:dmg-arm64' },
    { name: `nodechess-${V}-x64.dmg`, url: 'u:dmg-x64' },
    { name: `nodechess-${V}-mac-arm64.zip`, url: 'u:zip-arm64' },
    { name: `nodechess-${V}-mac-x64.zip`, url: 'u:zip-x64' },
    { name: `nodechess-${V}-linux-x86_64.AppImage`, url: 'u:appimage' },
    { name: `nodechess-${V}-linux-amd64.deb`, url: 'u:deb' },
    { name: 'latest.yml', url: 'u:latest' },
    { name: `nodechess-Setup-${V}.exe.blockmap`, url: 'u:blockmap' }
  ]
  eq(pickMacAsset(RELEASE_ASSETS, 'arm64')?.url, 'u:dmg-arm64', 'mac arm64 → arm64 dmg')
  eq(pickMacAsset(RELEASE_ASSETS, 'x64')?.url, 'u:dmg-x64', 'mac x64 → x64 dmg')
  const zipsOnly = RELEASE_ASSETS.filter((a) => !a.name.endsWith('.dmg'))
  eq(pickMacAsset(zipsOnly, 'arm64')?.url, 'u:zip-arm64', 'no dmg → exact-arch mac zip')
  eq(pickMacAsset(RELEASE_ASSETS, 'riscv')?.url, 'u:dmg-arm64', 'unknown arch → any dmg fallback')
  eq(pickMacAsset([], 'arm64'), null, 'no assets → null (release page link remains)')
  ok(
    pickMacAsset(RELEASE_ASSETS, 'x64').name !== `nodechess-${V}-arm64.dmg`,
    'x64 mac never handed the arm64 dmg'
  )
  eq(pickWinAsset(RELEASE_ASSETS)?.url, 'u:setup', 'win → the NSIS nodechess-Setup exe')
  ok(pickWinAsset(RELEASE_ASSETS).url !== 'u:portable', 'win never offered the portable exe')
  eq(pickWinAsset([{ name: `nodechess-Portable-${V}.exe`, url: 'u:portable' }]), null, 'portable-only → null')
  // Releases cut before the rename are still installable from a nodechess build.
  eq(
    pickWinAsset([{ name: `Chess-Setup-${V}.exe`, url: 'u:legacy' }])?.url,
    'u:legacy',
    'legacy Chess-Setup naming still resolves'
  )
  eq(
    pickMacAsset([{ name: `Chess-${V}-arm64.dmg`, url: 'u:legacy-dmg' }], 'arm64')?.url,
    'u:legacy-dmg',
    'legacy mac dmg naming still resolves (suffix match)'
  )

  // ==========================================================================
  // pickLinuxAsset (BINDING): a Linux user must be handed the format they
  // actually installed, never "a Linux file". The release carries both, so a
  // wrong guess installs cleanly and leaves two copies or a dead one.
  // ==========================================================================
  console.log('pickLinuxAsset: format decides, and an unknown format never guesses')
  eq(pickLinuxAsset(RELEASE_ASSETS, 'appimage')?.url, 'u:appimage', 'appimage install → AppImage')
  eq(pickLinuxAsset(RELEASE_ASSETS, 'deb')?.url, 'u:deb', 'deb install → deb')
  eq(pickLinuxAsset(RELEASE_ASSETS, null), null, 'unknown format → null, NEVER a guess')
  ok(
    pickLinuxAsset(RELEASE_ASSETS, 'appimage').name.endsWith('.AppImage') &&
      pickLinuxAsset(RELEASE_ASSETS, 'deb').name.endsWith('.deb'),
    'the two Linux formats are never crossed'
  )
  eq(pickLinuxAsset([], 'appimage'), null, 'no assets → null (release page link remains)')

  console.log('pickAssetForPlatform: per-platform dispatch')
  eq(pickAssetForPlatform(RELEASE_ASSETS, 'darwin', 'arm64')?.url, 'u:dmg-arm64', 'darwin → mac pick')
  eq(pickAssetForPlatform(RELEASE_ASSETS, 'win32', 'x64')?.url, 'u:setup', 'win32 → win pick')
  eq(
    pickAssetForPlatform(RELEASE_ASSETS, 'linux', 'x64', 'appimage')?.url,
    'u:appimage',
    'linux + appimage → AppImage'
  )
  eq(
    pickAssetForPlatform(RELEASE_ASSETS, 'linux', 'x64', 'deb')?.url,
    'u:deb',
    'linux + deb → deb'
  )
  eq(
    pickAssetForPlatform(RELEASE_ASSETS, 'linux', 'x64'),
    null,
    'linux, format unknown → null (release page fallback)'
  )
  eq(pickAssetForPlatform(RELEASE_ASSETS, 'freebsd', 'x64'), null, 'unknown platform → null')

  console.log(`\nALL GREEN: ${passed} assertions`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
