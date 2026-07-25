#!/usr/bin/env node
// A-final switch suite (ACCOUNTS-SPEC §14: lane 5, A6).
//
//   node scripts/test-afinal-flag.mjs
//
// Proves the ACCOUNTS_DECENTRALIZED flip end to end, both as pure routing/
// gating functions (server/afinal.ts + src/web/accountsFlag.ts, bundled and
// exercised in-process) and against the REAL server (server/index.ts +
// the real ipc-bridge bundle, test-web-auth harness style):
//   - flag ON  => every interim /api/auth endpoint answers 410
//     interim-accounts-superseded; the decentralized path is selected on the
//     web side (default ON there).
//   - flag OFF => the interim lifecycle is fully intact (me/signup/cookie).
//   - content plane (healthz, /api/ipc app:ping, statics) unaffected either
//     way; /api/review stays a normal 401 (persistence plane, never 410).
//   - default tiers: shipped bundles (build-server.mjs define) default ON;
//     ad-hoc bundles without the define default OFF: the exact invariant
//     that keeps test-web-auth/-bridge/-server green untouched; env
//     ACCOUNTS_DECENTRALIZED=0/1 overrides both ways (reversible flip).
// Synthetic fixtures only; servers bind 127.0.0.1 on ephemeral ports.
// Exit 1 on any failure.

import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'afinal-'))

let failures = 0
let asserts = 0
function check(name, cond) {
  asserts++
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Part A: pure resolution + gating functions (no server)
// ---------------------------------------------------------------------------

const pureEntry = path.join(dir, 'pure-entry.mjs')
writeFileSync(
  pureEntry,
  `export * as afinal from ${JSON.stringify(path.join(repoRoot, 'server/afinal.ts'))}\n` +
    `export * as webFlag from ${JSON.stringify(path.join(repoRoot, 'src/web/accountsFlag.ts'))}\n`
)
const pureAdhoc = path.join(dir, 'pure-adhoc.mjs')
const pureShipped = path.join(dir, 'pure-shipped.mjs')
execSync(
  `npx esbuild ${pureEntry} --bundle --platform=node --format=esm --outfile=${pureAdhoc}`,
  { stdio: 'pipe', cwd: repoRoot }
)
execSync(
  `npx esbuild ${pureEntry} --bundle --platform=node --format=esm ` +
    `--define:__ACCOUNTS_DECENTRALIZED_DEFAULT__='"on"' --outfile=${pureShipped}`,
  { stdio: 'pipe', cwd: repoRoot }
)

const { afinal, webFlag } = await import(pathToFileURL(pureAdhoc).href)
const shipped = await import(pathToFileURL(pureShipped).href)

console.log('--- pure: parseFlagToken (server grammar)')
const P = afinal.parseFlagToken
for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' on ']) {
  check(`'${v}' -> true`, P(v) === true)
}
for (const v of ['0', 'false', 'off', 'no', ' NO ']) {
  check(`'${v}' -> false`, P(v) === false)
}
for (const v of ['', 'banana', undefined]) {
  check(`${JSON.stringify(v)} -> undefined (never picks a side)`, P(v) === undefined)
}

console.log('--- pure: resolveAccountsFlag tiers')
const R = afinal.resolveAccountsFlag
const flagIs = (f, on, source) => f.on === on && f.source === source
check('env on wins', flagIs(R('1', 'off'), true, 'env'))
check('env off wins over build on (emergency fallback)', flagIs(R('0', 'on'), false, 'env'))
check('env garbage falls through to build default', flagIs(R('banana', 'on'), true, 'build-default'))
check('unset env -> build default on (shipped)', flagIs(R(undefined, 'on'), true, 'build-default'))
check('unset env -> build default off', flagIs(R(undefined, 'off'), false, 'build-default'))
check('build garbage -> fallback off', flagIs(R(undefined, 'zzz'), false, 'fallback'))
check('nothing set -> fallback OFF (pre-A-final rigs stay green)',
  flagIs(R(undefined, undefined), false, 'fallback'))

console.log('--- pure: gateInterimAuth routing')
const G = afinal.gateInterimAuth
const gated = (d) => d.gated === true && d.status === 410 && d.body.error === 'interim-accounts-superseded'
check('on: /api/auth/login gated 410 superseded', gated(G(true, '/api/auth/login')))
check('on: /api/auth (bare) gated', gated(G(true, '/api/auth')))
check('on: /api/auth/me?x=1 gated (query stripped)', gated(G(true, '/api/auth/me?x=1')))
check('on: /api/authx NOT gated (prefix trap)', G(true, '/api/authx').gated === false)
check('on: /healthz NOT gated', G(true, '/healthz').gated === false)
check('on: /api/ipc/app:ping NOT gated (content plane)', G(true, '/api/ipc/app:ping').gated === false)
check('on: /api/review/save NOT gated (persistence plane)', G(true, '/api/review/save').gated === false)
check('on: /assets/x.js NOT gated', G(true, '/assets/x.js').gated === false)
check('off: /api/auth/login NOT gated (interim intact)', G(false, '/api/auth/login').gated === false)

console.log('--- pure: accountsDecentralized() env+define plumbing')
delete process.env.ACCOUNTS_DECENTRALIZED
check('adhoc bundle, unset env -> off/fallback',
  flagIs(afinal.accountsDecentralized(), false, 'fallback'))
check('shipped bundle, unset env -> on/build-default',
  flagIs(shipped.afinal.accountsDecentralized(), true, 'build-default'))
process.env.ACCOUNTS_DECENTRALIZED = '1'
check('adhoc bundle, env 1 -> on/env', flagIs(afinal.accountsDecentralized(), true, 'env'))
process.env.ACCOUNTS_DECENTRALIZED = '0'
check('shipped bundle, env 0 -> off/env (reversible)',
  flagIs(shipped.afinal.accountsDecentralized(), false, 'env'))
delete process.env.ACCOUNTS_DECENTRALIZED

console.log('--- pure: web-side flag (default ON, decentralized selected)')
const W = webFlag
check('web parse: boolean passthrough', W.parseFlagToken(true) === true && W.parseFlagToken(false) === false)
check('web resolve: unset -> ON (decentralized is the default)', W.resolveWebAccountsFlag(undefined) === true)
check("web resolve: '0' -> OFF", W.resolveWebAccountsFlag('0') === false)
check("web resolve: 'off' -> OFF", W.resolveWebAccountsFlag('off') === false)
check("web resolve: '1' -> ON", W.resolveWebAccountsFlag('1') === true)
check('web resolve: garbage stays ON (never silently reverts the flip)',
  W.resolveWebAccountsFlag('banana') === true)
check("accountSystem(true) = 'decentralized'", W.accountSystem(true) === 'decentralized')
check("accountSystem(false) = 'interim'", W.accountSystem(false) === 'interim')
check('module constant: ACCOUNTS_DECENTRALIZED defaults true', W.ACCOUNTS_DECENTRALIZED === true)
check("module constant: ACCOUNT_SYSTEM = 'decentralized'", W.ACCOUNT_SYSTEM === 'decentralized')

// ---------------------------------------------------------------------------
// Part B: the REAL server (test-web-auth harness style)
// ---------------------------------------------------------------------------

// Fixture SPA root (the server refuses to boot without an index.html).
const webRoot = path.join(dir, 'dist-web')
mkdirSync(webRoot, { recursive: true })
writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>fixture</title>SPA-SHELL')

// Bundle the server twice: SHIPPED (with the build-server.mjs define) and
// AD-HOC (without, exactly how the pre-A-final suites bundle it), plus the
// real ipc bridge so the interim lifecycle + content plane are exercised.
const serverShipped = path.join(dir, 'shipped', 'server.cjs')
const serverAdhoc = path.join(dir, 'adhoc', 'server.cjs')
const versionDefine = `--define:__WEB_APP_VERSION__='"0.0.0-test"'`
execSync(
  `npx esbuild server/index.ts --bundle --platform=node --format=cjs ${versionDefine} ` +
    `--define:__ACCOUNTS_DECENTRALIZED_DEFAULT__='"on"' --outfile=${serverShipped}`,
  { stdio: 'pipe', cwd: repoRoot }
)
execSync(
  `npx esbuild server/index.ts --bundle --platform=node --format=cjs ${versionDefine} ` +
    `--outfile=${serverAdhoc}`,
  { stdio: 'pipe', cwd: repoRoot }
)
for (const out of [serverShipped, serverAdhoc]) {
  execSync(
    `npx esbuild server/bridge-entry.ts --bundle --platform=node --format=cjs ` +
      `--alias:electron=${path.join(repoRoot, 'server/electron-shim.ts')} ` +
      `--alias:@shared=${path.join(repoRoot, 'src/shared')} ` +
      `${versionDefine} --outfile=${path.join(path.dirname(out), 'ipc-bridge.cjs')}`,
    { stdio: 'pipe', cwd: repoRoot }
  )
}

let bootN = 0
async function startServer(serverOut, envOverrides = {}) {
  const dataDir = path.join(dir, `data-${bootN++}`)
  const envBase = { ...process.env }
  delete envBase.ACCOUNTS_DECENTRALIZED // the suite controls the flag explicitly
  const child = spawn(process.execPath, [serverOut], {
    env: {
      ...envBase,
      PORT: '0',
      HOST: '127.0.0.1',
      WEB_ROOT: webRoot,
      DATA_DIR: dataDir,
      PUZZLES_PATH: path.join(dir, 'no-puzzles.sqlite'), // absent. Degrades, irrelevant here
      RESOURCES_ROOT: path.join(repoRoot, 'resources'),
      LOG_LEVEL: 'silent',
      NODE_ENV: 'development',
      AUTH_RATE_LOGIN: '1000',
      AUTH_RATE_SIGNUP: '1000',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const base = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('server never reported listening')), 20_000)
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += String(d)
      const m = buf.match(/nodechess-web listening (\S+)/)
      if (m) {
        clearTimeout(timer)
        resolvePromise(m[1])
      }
    })
    child.on('exit', (code) => rejectPromise(new Error(`server exited early (${code})`)))
  })
  return { child, base }
}

async function stopServer(s) {
  const gone = new Promise((resolvePromise) => s.child.once('exit', resolvePromise))
  s.child.kill()
  await gone
}

function req(base, method, p, { body, cookie } = {}) {
  return fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie: `sid=${cookie}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
}

/** Extract the sid cookie value from a response, or null. */
function sidOf(res) {
  const cookies = res.headers.getSetCookie?.() ?? []
  for (const c of cookies) {
    const m = c.match(/^sid=([^;]*)/)
    if (m) return decodeURIComponent(m[1])
  }
  return null
}

const is410 = async (res) => {
  const body = await res.json().catch(() => ({}))
  return res.status === 410 && body.error === 'interim-accounts-superseded'
}

// ---- Boot A: shipped bundle, env unset -> the shipped default is ON --------
{
  console.log('--- boot A: shipped bundle, env unset (default ON)')
  const s = await startServer(serverShipped)
  check('GET /api/auth/me -> 410 superseded', await is410(await req(s.base, 'GET', '/api/auth/me')))
  check('POST /api/auth/signup -> 410 superseded',
    await is410(await req(s.base, 'POST', '/api/auth/signup', { body: { username: 'zoe-a', password: 'password123' } })))
  check('POST /api/auth/login -> 410 superseded',
    await is410(await req(s.base, 'POST', '/api/auth/login', { body: { username: 'zoe-a', password: 'password123' } })))
  check('POST /api/auth/logout -> 410 superseded',
    await is410(await req(s.base, 'POST', '/api/auth/logout', { body: {} })))
  check('DELETE /api/auth/me -> 410 (all methods refused)',
    await is410(await req(s.base, 'DELETE', '/api/auth/me')))
  check('GET /api/auth (bare namespace) -> 410', await is410(await req(s.base, 'GET', '/api/auth')))
  check('GET /api/auth/bogus -> 410 (whole namespace superseded, not coming-online)',
    await is410(await req(s.base, 'GET', '/api/auth/bogus')))
  const hz = await req(s.base, 'GET', '/healthz')
  check('content plane: /healthz 200 ok', hz.status === 200 && (await hz.json()).ok === true)
  const ping = await req(s.base, 'POST', '/api/ipc/app:ping', { body: {} })
  check('content plane: /api/ipc/app:ping 200 (bridge untouched)',
    ping.status === 200 && (await ping.json()).ok === true)
  const rev = await req(s.base, 'POST', '/api/review/save', { body: {} })
  check('persistence plane: /api/review/save -> 401 auth-required (NOT 410)',
    rev.status === 401 && (await rev.json()).error === 'auth-required')
  const spa = await req(s.base, 'GET', '/')
  check('content plane: SPA shell still served',
    spa.status === 200 && (await spa.text()).includes('SPA-SHELL'))
  await stopServer(s)
}

// ---- Boot B: shipped bundle, env 0 -> interim fully intact (reversible) ----
{
  console.log('--- boot B: shipped bundle, ACCOUNTS_DECENTRALIZED=0 (emergency fallback)')
  const s = await startServer(serverShipped, { ACCOUNTS_DECENTRALIZED: '0' })
  const me0 = await req(s.base, 'GET', '/api/auth/me')
  check('me with no cookie -> 200 {user:null}',
    me0.status === 200 && (await me0.json()).user === null)
  const su = await req(s.base, 'POST', '/api/auth/signup', {
    body: { username: 'zoe-b', password: 'password123' }
  })
  const suBody = await su.json().catch(() => ({}))
  const sid = sidOf(su)
  check('signup -> 200 {user} (interim lifecycle intact)',
    su.status === 200 && suBody.user?.username === 'zoe-b')
  check('signup sets a sid cookie', typeof sid === 'string' && sid.length > 0)
  const me1 = await req(s.base, 'GET', '/api/auth/me', { cookie: sid })
  check('cookie roundtrip: me -> the user',
    me1.status === 200 && (await me1.json()).user?.username === 'zoe-b')
  const bogus = await req(s.base, 'GET', '/api/auth/bogus')
  check('unclaimed /api/auth/bogus -> 503 coming-online (gate NOT registered)',
    bogus.status === 503 && (await bogus.json()).error === 'coming-online')
  const ping = await req(s.base, 'POST', '/api/ipc/app:ping', { body: {} })
  check('content plane: app:ping 200', ping.status === 200 && (await ping.json()).ok === true)
  await stopServer(s)
}

// ---- Boot C: ad-hoc bundle, env unset -> fallback OFF (existing suites) ----
{
  console.log('--- boot C: ad-hoc bundle, env unset (pre-A-final rigs stay green)')
  const s = await startServer(serverAdhoc)
  const su = await req(s.base, 'POST', '/api/auth/signup', {
    body: { username: 'zoe-c', password: 'password123' }
  })
  const suBody = await su.json().catch(() => ({}))
  const sid = sidOf(su)
  check('ad-hoc bundle without define: signup 200 (test-web-auth invariant)',
    su.status === 200 && suBody.user?.username === 'zoe-c')
  const me = await req(s.base, 'GET', '/api/auth/me', { cookie: sid })
  check('ad-hoc bundle: cookie roundtrip intact',
    me.status === 200 && (await me.json()).user?.username === 'zoe-c')
  await stopServer(s)
}

// ---- Boot D: ad-hoc bundle, env 1 -> the explicit switch still flips ON ----
{
  console.log('--- boot D: ad-hoc bundle, ACCOUNTS_DECENTRALIZED=1')
  const s = await startServer(serverAdhoc, { ACCOUNTS_DECENTRALIZED: '1' })
  check('env 1 on an undefined bundle: me -> 410', await is410(await req(s.base, 'GET', '/api/auth/me')))
  check('env 1: signup -> 410',
    await is410(await req(s.base, 'POST', '/api/auth/signup', { body: { username: 'zoe-d', password: 'password123' } })))
  const ping = await req(s.base, 'POST', '/api/ipc/app:ping', { body: {} })
  check('env 1: content plane app:ping 200', ping.status === 200 && (await ping.json()).ok === true)
  const hz = await req(s.base, 'GET', '/healthz')
  check('env 1: /healthz 200', hz.status === 200 && (await hz.json()).ok === true)
  await stopServer(s)
}

// ---------------------------------------------------------------------------
console.log('')
if (failures > 0) {
  console.error(`${failures}/${asserts} assertions FAILED`)
  process.exit(1)
}
console.log(`ALL GREEN, ${asserts} assertions (A-final flag: shipped default ON, ` +
  `interim 410-gated, env-reversible, content plane untouched)`)
