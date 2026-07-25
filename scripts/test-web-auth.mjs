#!/usr/bin/env node
// Web auth suite (web port W3: docs/WEB-PORT-SPEC.md, build contract §3).
//
//   node scripts/test-web-auth.mjs
//
// Boots the REAL server (server/index.ts + the real ipc-bridge bundle) on an
// ephemeral port with a temp DATA_DIR and asserts the account lifecycle:
//   - GET /api/auth/me with no cookie -> {user:null}
//   - signup validation: bad username / short password / extra keys -> 400
//   - signup -> 200 {user}, sets an httpOnly SameSite=Lax sid cookie
//   - cookie roundtrip: me with the cookie -> the user
//   - duplicate username -> 409 (case-insensitively: 'Alice' after 'alice')
//   - login with the wrong password (and unknown user) -> 401
//   - login -> fresh session cookie that answers me
//   - logout -> {ok:true}, clears the cookie, the old token is dead server-side
//   - public channel (app:ping) works logged-out; private (games:list) -> 401
//   - server.sqlite + anon/users dirs land under DATA_DIR
//   - session tokens are sha256-hashed at rest (never the raw cookie value)
// Phase 2 boots a production-posture server (NODE_ENV=production, TRUST_PROXY,
// tight limits) and asserts: Secure cookie over plain http, login 429 past the
// per-IP limit (with per-forwarded-IP buckets), MAX_ACCOUNTS -> 403.
// Phase 3 plants a pre-hashing (user_version 0) session row and proves the
// boot migration hashes it in place without killing the session.
// Exit 1 on any failure.

import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'webauth-'))

// Fixture SPA root (the server refuses to boot without an index.html).
const webRoot = path.join(dir, 'dist-web')
mkdirSync(webRoot, { recursive: true })
writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>fixture</title>SPA-SHELL')

const dataDir = path.join(dir, 'data')

// Bundle the server and the ipc bridge exactly like the build scripts do, into
// the SAME temp dir (index.cjs finds ipc-bridge.cjs next to itself).
const serverOut = path.join(dir, 'server.cjs')
const bridgeOut = path.join(dir, 'ipc-bridge.cjs')
execSync(
  `npx esbuild server/index.ts --bundle --platform=node --format=cjs ` +
    `--define:__WEB_APP_VERSION__='"0.0.0-test"' --outfile=${serverOut}`,
  { stdio: 'pipe', cwd: repoRoot }
)
execSync(
  `npx esbuild server/bridge-entry.ts --bundle --platform=node --format=cjs ` +
    `--alias:electron=${path.join(repoRoot, 'server/electron-shim.ts')} ` +
    `--alias:@shared=${path.join(repoRoot, 'src/shared')} ` +
    `--define:__WEB_APP_VERSION__='"0.0.0-test"' --outfile=${bridgeOut}`,
  { stdio: 'pipe', cwd: repoRoot }
)

const serverEnvBase = {
  ...process.env,
  PORT: '0',
  HOST: '127.0.0.1',
  WEB_ROOT: webRoot,
  DATA_DIR: dataDir,
  PUZZLES_PATH: path.join(dir, 'no-puzzles.sqlite'), // absent. Degrades, irrelevant here
  RESOURCES_ROOT: path.join(repoRoot, 'resources'),
  LOG_LEVEL: 'silent',
  // Pin cookie behavior regardless of the invoking shell (production defaults
  // the sid cookie to Secure: phase 2 asserts that explicitly).
  NODE_ENV: 'development'
}

async function startServer(envOverrides = {}) {
  const child = spawn(process.execPath, [serverOut], {
    env: { ...serverEnvBase, ...envOverrides },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const base = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('server never reported listening')), 15_000)
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

// Main-phase server: rate limits opened wide so the lifecycle assertions below
// never trip them (phase 2 boots a tight-limit server and tests them for real).
const { child, base } = await startServer({ AUTH_RATE_LOGIN: '1000', AUTH_RATE_SIGNUP: '1000' })

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

/** Extract the sid cookie value ('' when cleared) from a response, or null. */
function sidOf(res) {
  const cookies = res.headers.getSetCookie?.() ?? []
  for (const c of cookies) {
    const m = c.match(/^sid=([^;]*)/)
    if (m) return decodeURIComponent(m[1])
  }
  return null
}

function sidCookieAttrs(res) {
  const cookies = res.headers.getSetCookie?.() ?? []
  return cookies.find((c) => c.startsWith('sid=')) ?? ''
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const post = (p, body, cookie) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `sid=${cookie}` } : {}) },
    body: JSON.stringify(body)
  })
const get = (p, cookie) =>
  fetch(`${base}${p}`, { headers: cookie ? { cookie: `sid=${cookie}` } : {} })

try {
  // ---- logged-out baseline ----
  let res = await get('/api/auth/me')
  let body = await res.json()
  check('me without a cookie -> 200 {user:null}', res.status === 200 && body.user === null)

  // ---- signup validation ----
  res = await post('/api/auth/signup', { username: 'ab', password: 'password123' })
  check('signup with a 2-char username -> 400', res.status === 400)
  res = await post('/api/auth/signup', { username: 'alice', password: 'short' })
  check('signup with a short password -> 400', res.status === 400)
  res = await post('/api/auth/signup', { username: 'bad name!', password: 'password123' })
  check('signup with invalid username chars -> 400', res.status === 400)
  res = await post('/api/auth/signup', {
    username: 'alice',
    password: 'password123',
    admin: true
  })
  check('signup with unexpected extra keys -> 400 (strict schema)', res.status === 400)

  // ---- signup ----
  res = await post('/api/auth/signup', { username: 'alice', password: 'password123' })
  body = await res.json()
  const aliceSid = sidOf(res)
  check('signup -> 200 with {user:{id,username}}', res.status === 200 && body.user?.username === 'alice' && Number.isInteger(body.user?.id))
  check('signup sets a sid cookie', typeof aliceSid === 'string' && aliceSid.length > 20)
  const attrs = sidCookieAttrs(res)
  check('sid cookie is HttpOnly', /httponly/i.test(attrs))
  check('sid cookie is SameSite=Lax', /samesite=lax/i.test(attrs))
  check('sid cookie has Path=/', /path=\//i.test(attrs))
  check('sid cookie is NOT Secure over http', !/;\s*secure/i.test(attrs))

  // ---- cookie roundtrip ----
  res = await get('/api/auth/me', aliceSid)
  body = await res.json()
  check('me with the signup cookie -> alice', res.status === 200 && body.user?.username === 'alice')
  check('me re-issues the rolling cookie', sidOf(res) === aliceSid)

  // ---- duplicates ----
  res = await post('/api/auth/signup', { username: 'alice', password: 'password456' })
  body = await res.json()
  check('duplicate username -> 409 username-taken', res.status === 409 && body.error === 'username-taken')
  res = await post('/api/auth/signup', { username: 'Alice', password: 'password456' })
  check('duplicate username is case-insensitive (Alice) -> 409', res.status === 409)

  // ---- login ----
  res = await post('/api/auth/login', { username: 'alice', password: 'WRONGpassword' })
  body = await res.json()
  check('wrong password -> 401 invalid-credentials', res.status === 401 && body.error === 'invalid-credentials')
  res = await post('/api/auth/login', { username: 'nobody', password: 'password123' })
  check('unknown user -> the same 401 (no user enumeration)', res.status === 401)

  res = await post('/api/auth/login', { username: 'alice', password: 'password123' })
  body = await res.json()
  const loginSid = sidOf(res)
  check('login -> 200 {user} + fresh cookie', res.status === 200 && body.user?.username === 'alice' && loginSid && loginSid !== aliceSid)
  res = await get('/api/auth/me', loginSid)
  body = await res.json()
  check('me with the login cookie -> alice', body.user?.username === 'alice')

  // ---- logout ----
  res = await post('/api/auth/logout', {}, loginSid)
  body = await res.json()
  check('logout -> {ok:true}', res.status === 200 && body.ok === true)
  check('logout clears the cookie', sidOf(res) === '')
  res = await get('/api/auth/me', loginSid)
  body = await res.json()
  check('the logged-out token is dead server-side', body.user === null)
  // The ORIGINAL signup session must still work (logout only kills its own token).
  res = await get('/api/auth/me', aliceSid)
  body = await res.json()
  check('an unrelated session survives the logout', body.user?.username === 'alice')

  // ---- channel gating ----
  res = await post('/api/ipc/app:ping', {})
  body = await res.json()
  check('public channel (app:ping) works logged-out', res.status === 200 && body.ok === true)
  res = await post('/api/ipc/games:list', {})
  body = await res.json()
  check('private channel (games:list) logged-out -> 401 auth-required', res.status === 401 && body.error === 'auth-required')
  res = await post('/api/ipc/games:list', {}, aliceSid)
  body = await res.json()
  check('private channel works with a session', res.status === 200 && Array.isArray(body.games))
  res = await post('/api/ipc/games:list', {}, 'forged-token-000000000000000000000000000000')
  check('a forged sid is just logged-out (401 on private)', res.status === 401)

  // ---- on-disk layout ----
  check('DATA_DIR/server.sqlite exists', existsSync(path.join(dataDir, 'server.sqlite')))
  check('DATA_DIR/anon app DB exists (public calls)', existsSync(path.join(dataDir, 'anon', 'app.sqlite')))
  check('DATA_DIR/users/1 app DB exists (alice)', existsSync(path.join(dataDir, 'users', '1', 'app.sqlite')))

  // ---- session tokens hashed at rest (audit WEB-SEC-01) ----
  // A server.sqlite read must never yield a replayable cookie value: rows hold
  // sha256(token), the raw token exists only in the browser's cookie jar.
  {
    const sdb = new DatabaseSync(path.join(dataDir, 'server.sqlite'))
    const tokens = sdb.prepare('SELECT token FROM sessions').all().map((row) => row.token)
    const ver = sdb.prepare('PRAGMA user_version').get()
    sdb.close()
    check('sessions store no raw cookie token', tokens.length > 0 && !tokens.includes(aliceSid))
    check('the live cookie is stored as its sha256', tokens.includes(sha256(aliceSid)))
    check('server.sqlite user_version stamped to 1', Number(ver.user_version) === 1)
  }

  // W1 contract intact: unknown api path is still the 503 catch-all.
  res = await fetch(`${base}/api/some/unknown`)
  check('unknown /api path stays 503 coming-online', res.status === 503)
} finally {
  child.kill()
}

// ---- Phase 2: hardened-boot behavior (Secure cookie, rate limits, account cap)
// A fresh DATA_DIR under production settings: the deploy posture from
// docs/WEB-DEPLOY.md (NODE_ENV=production, TRUST_PROXY=1) with tight knobs so
// the limits actually trip.
const dataDir2 = path.join(dir, 'data2')
const s2 = await startServer({
  DATA_DIR: dataDir2,
  NODE_ENV: 'production',
  TRUST_PROXY: '1',
  AUTH_RATE_LOGIN: '3',
  AUTH_RATE_SIGNUP: '10',
  MAX_ACCOUNTS: '2'
})
try {
  const post2 = (p, body, headers = {}) =>
    fetch(`${s2.base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })

  let res = await post2('/api/auth/signup', { username: 'prod-one', password: 'password123' })
  check('phase2: signup works under production settings', res.status === 200)
  check(
    'phase2: sid cookie is Secure in production even over plain http (WEB-SEC-05)',
    /;\s*secure/i.test(sidCookieAttrs(res))
  )

  res = await post2('/api/auth/signup', { username: 'prod-two', password: 'password123' })
  check('phase2: second signup fills MAX_ACCOUNTS=2', res.status === 200)
  res = await post2('/api/auth/signup', { username: 'prod-three', password: 'password123' })
  let body = await res.json()
  check('phase2: signup past MAX_ACCOUNTS -> 403 signups-closed', res.status === 403 && body.error === 'signups-closed')

  // Login limiter (AUTH_RATE_LOGIN=3/min/IP): three wrong guesses answer 401,
  // the fourth is refused at the limiter before any argon2 work.
  const codes = []
  for (let i = 0; i < 4; i++) {
    res = await post2('/api/auth/login', { username: 'prod-one', password: 'WRONG-password' })
    codes.push(res.status)
  }
  check(
    'phase2: wrong logins 401 up to the per-IP limit, then 429 (WEB-SEC-02)',
    codes[0] === 401 && codes[1] === 401 && codes[2] === 401 && codes[3] === 429
  )
  // Under TRUST_PROXY the limiter keys on the forwarded client IP (a real
  // proxy overwrites client-supplied values), so another client keeps working
  // while one is throttled.
  res = await post2(
    '/api/auth/login',
    { username: 'prod-one', password: 'password123' },
    { 'x-forwarded-for': '198.51.100.7' }
  )
  check('phase2: a different forwarded client IP has its own limit bucket', res.status === 200)
} finally {
  await stopServer(s2)
}

// ---- Phase 3: v0 -> v1 session migration (pre-hashing DBs upgrade in place)
// Simulate a server.sqlite written before token hashing: user_version 0 and a
// RAW token row. Boot on it: the constructor migration must hash the stored
// value so the original cookie keeps working and no raw token remains at rest.
const legacyRaw = 'legacy-raw-token-00000000000000000000000000'
{
  const sdb = new DatabaseSync(path.join(dataDir2, 'server.sqlite'))
  sdb.exec('PRAGMA user_version = 0')
  sdb
    .prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(legacyRaw, 1, Date.now(), Date.now() + 86_400_000)
  sdb.close()
}
const s3 = await startServer({ DATA_DIR: dataDir2, NODE_ENV: 'production', TRUST_PROXY: '1' })
try {
  const res = await fetch(`${s3.base}/api/auth/me`, { headers: { cookie: `sid=${legacyRaw}` } })
  const body = await res.json()
  check('phase3: a pre-hashing session cookie still resolves after migration', body.user?.username === 'prod-one')
} finally {
  await stopServer(s3)
}
{
  const sdb = new DatabaseSync(path.join(dataDir2, 'server.sqlite'))
  const tokens = sdb.prepare('SELECT token FROM sessions').all().map((row) => row.token)
  const ver = sdb.prepare('PRAGMA user_version').get()
  sdb.close()
  check('phase3: no raw legacy token remains at rest', !tokens.includes(legacyRaw) && tokens.includes(sha256(legacyRaw)))
  check('phase3: user_version stamped to 1', Number(ver.user_version) === 1)
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nWeb auth: all green')
