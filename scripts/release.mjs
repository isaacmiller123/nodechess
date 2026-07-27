#!/usr/bin/env node
// Guarded release helper for the nodechess DESKTOP app (mac + win).
//
// What cutting a release actually is here: bump package.json `version`, commit
// it, push an annotated `vX.Y.Z` tag, and let .github/workflows/build.yml build
// + attach the mac/win installers to the GitHub Release. This script owns the
// SAFE, boring parts of that: it validates the tree is release-ready and bumps
// the version, and it REFUSES to do the dangerous part (push a tag) without an
// explicit, confirmed opt-in. The full story lives in docs/RELEASE.md.
//
// It is deliberately conservative:
//   • default command is `check`. Read-only, mutates nothing, just tells you
//     whether the tree could be released right now.
//   • `bump` edits ONLY the version string in package.json (targeted, so the
//     file's formatting is preserved) and stops. It never commits or pushes
//     unless you add --tag / --push, and even then it asks first (unless --yes).
//   • every git-mutating path prints its exact plan and waits for a y/N, so a
//     stray invocation can never publish a release on its own.
//
// Usage:
//   node scripts/release.mjs [check]                 validate only (default)
//   node scripts/release.mjs check --full            + run `npm run typecheck`
//   node scripts/release.mjs bump patch|minor|major  write next version, stop
//   node scripts/release.mjs bump 1.3.0              write an explicit version
//     flags for bump:
//       --tag          also `git commit` package.json + create tag vX.Y.Z (local)
//       --push         also push the branch and the tag to origin (implies --tag)
//       --yes          skip the interactive confirmation prompt
//       --allow-dirty  permit a dirty working tree (default: bump requires clean)
//       --dry-run      print the plan and exit without writing/committing/pushing
//
// Exit code is non-zero when the tree is NOT release-ready, so CI or a wrapper
// can gate on `node scripts/release.mjs check`.

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = path.join(ROOT, 'package.json')

// ---- tiny cli plumbing --------------------------------------------------------

const ARGV = process.argv.slice(2)
const FLAGS = new Set(ARGV.filter((a) => a.startsWith('--')))
const POSITIONAL = ARGV.filter((a) => !a.startsWith('--'))
const has = (f) => FLAGS.has(f)

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
}

let hardFails = 0
let warnings = 0
const ok = (m) => console.log(`  ${C.green('✓')} ${m}`)
const warn = (m) => {
  warnings++
  console.log(`  ${C.yellow('!')} ${m}`)
}
const fail = (m) => {
  hardFails++
  console.log(`  ${C.red('✗')} ${m}`)
}
const die = (m) => {
  console.error(`\n${C.red('release: ' + m)}`)
  process.exit(1)
}

/** Run a command, return trimmed stdout; throws on non-zero exit. */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
}
/** Run a command, never throw. Returns { ok, out }. For probes. */
function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) }
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// ---- semver -------------------------------------------------------------------

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' }
}
function nextVersion(current, level) {
  const s = parseSemver(current)
  if (!s) die(`current version "${current}" is not valid semver`)
  if (level === 'patch') return `${s.major}.${s.minor}.${s.patch + 1}`
  if (level === 'minor') return `${s.major}.${s.minor + 1}.0`
  if (level === 'major') return `${s.major + 1}.0.0`
  // Explicit version supplied.
  if (parseSemver(level)) return level
  die(`bump target must be patch|minor|major or an explicit X.Y.Z (got "${level}")`)
}

// ---- inputs -------------------------------------------------------------------

function readPkg() {
  try {
    return JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  } catch (e) {
    die(`cannot read package.json: ${e.message}`)
  }
}

/** Pull owner/repo out of `git remote get-url origin`. */
function remoteOwnerRepo() {
  const r = tryRun('git', ['remote', 'get-url', 'origin'])
  if (!r.ok) return null
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(r.out)
  return m ? { owner: m[1], repo: m[2] } : null
}

/** Grep owner/repo out of the electron-builder publish block (no yaml dep). */
function builderPublishTarget() {
  let text
  try {
    text = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
  } catch {
    return null
  }
  const owner = /^\s*owner:\s*(\S+)/m.exec(text)?.[1]
  const repo = /^\s*repo:\s*(\S+)/m.exec(text)?.[1]
  return owner && repo ? { owner, repo } : null
}

/** Grep the updater's hard-coded owner/repo from updateLogic.ts. */
function updaterTarget() {
  let text
  try {
    text = readFileSync(path.join(ROOT, 'src/main/updates/updateLogic.ts'), 'utf8')
  } catch {
    return null
  }
  const owner = /UPDATE_OWNER\s*=\s*'([^']+)'/.exec(text)?.[1]
  const repo = /UPDATE_REPO\s*=\s*'([^']+)'/.exec(text)?.[1]
  return owner && repo ? { owner, repo } : null
}

/** Grep `const RELEASE_BASE = '<github url>'` out of a source file (no ts dep). */
function releaseBaseTarget(rel) {
  let text
  try {
    text = readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
  const url = /RELEASE_BASE\s*=\s*'([^']+)'/.exec(text)?.[1]
  const m = url ? /github\.com\/([^/]+)\/([^/]+)/.exec(url) : null
  return m ? { owner: m[1], repo: m[2] } : null
}

// The four runtime dataset importers. Each downloads the engine/puzzle assets
// from the datasets-v1 release of the SHIPPING repo, so they carry the same
// owner/repo the installer was published under.
const DATASET_FILES = [
  'src/main/datasets/datasets.service.ts',
  'src/main/datasets/fairyStockfish.ts',
  'src/main/datasets/katago.ts',
  'src/main/datasets/maia.ts'
]

// The public landing page's download buttons. Not baked into the app: a link a
// visitor clicks TODAY, so it tracks the live repo, see validate() step 4.
const LANDING_FILE = 'src/renderer/src/features/landing/downloads.ts'

// ---- validation ---------------------------------------------------------------

/** Returns a snapshot of the checks so callers (bump) can reuse the results. */
function validate({ full = false } = {}) {
  const pkg = readPkg()
  console.log(C.bold(`\nnodechess release check, version ${pkg.version}\n`))

  // 1. git repo + branch + cleanliness
  const inRepo = tryRun('git', ['rev-parse', '--is-inside-work-tree']).ok
  if (!inRepo) fail('not a git repository (run `git init` + add the origin remote first)')
  const branch = inRepo ? tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out : ''
  const dirty = inRepo && tryRun('git', ['status', '--porcelain']).out.length > 0
  if (inRepo) {
    ok(`git repo present (branch: ${branch})`)
    if (dirty) warn('working tree is dirty: a release is tagged from a clean tree')
    else ok('working tree is clean')
  }

  // 2. version is semver
  if (parseSemver(pkg.version)) ok(`package.json version is valid semver (${pkg.version})`)
  else fail(`package.json version "${pkg.version}" is not valid semver`)

  // 3. the vX.Y.Z tag for the CURRENT version must be free to move forward from
  const tagName = `v${pkg.version}`
  const localTags = inRepo ? tryRun('git', ['tag', '--list', tagName]).out : ''
  if (localTags === tagName)
    warn(`tag ${tagName} already exists locally, bump the version before releasing`)
  else if (inRepo) ok(`tag ${tagName} is not yet used locally`)

  // 4. the GitHub targets. Two groups, answering two different questions
  //    (docs/RELEASE.md §2 is the runbook this encodes).
  //
  //    (a) BAKED INTO THE APP, so they must be IDENTICAL: electron-builder's
  //        publish block, the updater's UPDATE_OWNER/UPDATE_REPO, and the four
  //        src/main/datasets RELEASE_BASE constants. That shared slug is the
  //        canonical one; `origin` must reach it before a tag can publish, which
  //        is the pending-rename blocker RELEASE.md §2 describes.
  //    (b) THE PUBLIC SITE: the landing page's RELEASE_BASE is a link a visitor
  //        clicks TODAY, so it must name a slug that ALREADY resolves: the live
  //        one (`origin`), or the canonical one once the rename has happened.
  //        GitHub redirects the old name forever, so trailing the rename is
  //        stale, not broken. Demanding it match the canonical slug early would
  //        be demanding a 404.
  const remote = remoteOwnerRepo()
  const builder = builderPublishTarget()
  const updater = updaterTarget()
  const datasets = DATASET_FILES.map((f) => ({ file: f, target: releaseBaseTarget(f) }))
  const landing = releaseBaseTarget(LANDING_FILE)
  const fmt = (t) => (t ? `${t.owner}/${t.repo}` : '(unknown)')
  if (builder) ok(`electron-builder publishes to ${fmt(builder)}`)
  else fail('could not read publish owner/repo from electron-builder.yml')
  if (remote) ok(`git origin is ${fmt(remote)}`)
  else warn('no git origin remote: add one before pushing a tag')
  const same = (a, b) => a && b && a.owner === b.owner && a.repo === b.repo
  if (remote && builder && !same(remote, builder))
    fail(`MISMATCH: builder publishes to ${fmt(builder)} but origin is ${fmt(remote)}`)
  if (updater && builder && !same(updater, builder))
    fail(`MISMATCH: updater checks ${fmt(updater)} but builder publishes to ${fmt(builder)}`)

  // (a) continued: the dataset importers. A stray one here means a fresh install
  // downloads its engine + puzzle DB from a repo the installer never published
  // to, which is the first-run import failing on a name that does not exist.
  for (const d of datasets) {
    if (!d.target) fail(`could not read RELEASE_BASE from ${d.file}`)
    else if (builder && !same(d.target, builder))
      fail(`MISMATCH: ${d.file} imports datasets from ${fmt(d.target)} but builder publishes to ${fmt(builder)}`)
  }
  const datasetsAgree = datasets.every((d) => same(d.target, builder))
  if (datasetsAgree) ok(`all ${datasets.length} dataset importers pull from ${fmt(builder)}`)
  if (same(remote, builder) && same(updater, builder) && datasetsAgree)
    ok('publish target, git origin, updater, and dataset importers all agree')

  // (b) the landing page.
  if (!landing) fail(`could not read RELEASE_BASE from ${LANDING_FILE}`)
  else if (same(landing, builder)) ok(`landing page links to ${fmt(landing)}`)
  else if (same(landing, remote))
    warn(
      `landing page links to the LIVE repo ${fmt(landing)}, not the canonical ${fmt(builder)}: ` +
        'correct until the GitHub rename, repoint it after (docs/RELEASE.md §2)'
    )
  else if (!remote)
    // No origin means no way to know which slug resolves today: not a blocker.
    warn(`landing page links to ${fmt(landing)}, with no git origin to check it against`)
  else
    fail(
      `MISMATCH: landing page links to ${fmt(landing)}, which is neither the live repo ` +
        `${fmt(remote)} nor the publish target ${fmt(builder)}`
    )

  // 5. build inputs electron-builder needs
  const needFiles = [
    'electron-builder.yml',
    'build/icon.icns',
    'build/icon.ico',
    '.github/workflows/build.yml'
  ]
  for (const f of needFiles) {
    try {
      readFileSync(path.join(ROOT, f))
      ok(`present: ${f}`)
    } catch {
      fail(`missing: ${f}`)
    }
  }

  // 6. optional heavy gate. The same typecheck CI runs before packaging
  if (full) {
    console.log(C.dim('\n  running `npm run typecheck` (this is what CI gates on)…'))
    const t = tryRun('npm', ['run', 'typecheck'], { stdio: 'pipe' })
    if (t.ok) ok('typecheck passed')
    else fail('typecheck FAILED. Fix before releasing (rerun with output: npm run typecheck)')
  } else {
    warn('skipped typecheck (add --full to run it, or rely on CI) ')
  }

  console.log(
    `\n${hardFails ? C.red(`NOT release-ready, ${hardFails} blocker(s)`) : C.green('release-ready')}` +
      (warnings ? C.yellow(`, ${warnings} warning(s)`) : '') +
      '\n'
  )
  return { pkg, branch, dirty, inRepo }
}

// ---- interactive confirm ------------------------------------------------------

async function confirm(question) {
  if (has('--yes')) return true
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

// ---- version write (targeted, format-preserving) ------------------------------

function writeVersion(newVersion) {
  const raw = readFileSync(PKG_PATH, 'utf8')
  const replaced = raw.replace(/("version":\s*")[^"]+(")/, `$1${newVersion}$2`)
  if (replaced === raw) die('could not find the "version" field to update in package.json')
  writeFileSync(PKG_PATH, replaced)
}

// ---- commands -----------------------------------------------------------------

async function cmdBump() {
  const level = POSITIONAL[1]
  if (!level) die('usage: node scripts/release.mjs bump <patch|minor|major|X.Y.Z> [--tag] [--push]')

  const state = validate({ full: has('--full') })
  const dryRun = has('--dry-run')
  const wantTag = has('--tag') || has('--push')
  const wantPush = has('--push')

  // A bump that will be committed/tagged must start from a clean, in-repo tree.
  if (wantTag) {
    if (!state.inRepo) die('cannot --tag/--push: not a git repository')
    if (state.dirty && !has('--allow-dirty'))
      die('working tree is dirty: commit/stash first, or pass --allow-dirty')
  }
  if (hardFails > 0 && !has('--allow-dirty'))
    die(`refusing to bump: ${hardFails} blocker(s) above (override unrelated blockers with --allow-dirty)`)

  const current = state.pkg.version
  const target = nextVersion(current, level)
  const tagName = `v${target}`

  // The new tag must not already exist (locally or on origin). That would make
  // the CI publish clobber a shipped release.
  if (tryRun('git', ['tag', '--list', tagName]).out === tagName)
    die(`tag ${tagName} already exists locally: pick a different version`)
  if (wantPush) {
    const ls = tryRun('git', ['ls-remote', '--tags', 'origin', tagName])
    if (ls.ok && ls.out.includes(tagName)) die(`tag ${tagName} already exists on origin: pick a different version`)
  }

  console.log(C.bold('Plan:'))
  console.log(`  • package.json version ${current} → ${C.green(target)}`)
  if (wantTag) console.log(`  • git commit package.json ("release: ${target}")`)
  if (wantTag) console.log(`  • git tag -a ${tagName} -m "nodechess ${target}"`)
  if (wantPush) console.log(`  • git push origin ${state.branch} && git push origin ${tagName}  ${C.dim('(triggers CI build.yml)')}`)
  if (!wantTag) console.log(C.dim('  • (no git actions: add --tag to commit+tag, --push to also push)'))
  console.log('')

  if (dryRun) {
    console.log(C.yellow('--dry-run: nothing written.'))
    printManualNext(state.branch, tagName, wantTag, wantPush)
    return
  }

  if (!(await confirm('Proceed?'))) die('aborted by user')

  writeVersion(target)
  ok(`package.json now at ${target}`)

  if (wantTag) {
    run('git', ['add', 'package.json'])
    run('git', ['commit', '-m', `release: ${target}`])
    run('git', ['tag', '-a', tagName, '-m', `nodechess ${target}`])
    ok(`committed and tagged ${tagName} (local)`)
  }
  if (wantPush) {
    if (!(await confirm(C.yellow(`Really push ${tagName} to origin? This publishes a release.`))))
      die('push aborted: the version bump and local tag are kept; push manually when ready')
    run('git', ['push', 'origin', state.branch], { stdio: 'inherit' })
    run('git', ['push', 'origin', tagName], { stdio: 'inherit' })
    ok(`pushed ${state.branch} and ${tagName}. Watch the Actions tab for the build`)
  }

  if (!wantPush) printManualNext(state.branch, tagName, wantTag, wantPush)
}

function printManualNext(branch, tagName, tagged, pushed) {
  if (pushed) return
  console.log(C.bold('\nNext steps (run when ready):'))
  if (!tagged) {
    console.log(`  git commit -am "release: ${tagName.slice(1)}"`)
    console.log(`  git tag -a ${tagName} -m "nodechess ${tagName.slice(1)}"`)
  }
  console.log(`  git push origin ${branch} && git push origin ${tagName}`)
  console.log(C.dim(`  → the ${tagName} push triggers .github/workflows/build.yml (mac + win).`))
  console.log(C.dim('  → see docs/RELEASE.md for the full flow.\n'))
}

// ---- dispatch -----------------------------------------------------------------

const cmd = POSITIONAL[0] || 'check'
if (cmd === 'check') {
  validate({ full: has('--full') })
  process.exit(hardFails ? 1 : 0)
} else if (cmd === 'bump') {
  await cmdBump()
} else {
  die(`unknown command "${cmd}": expected "check" or "bump" (see --help in the header)`)
}
