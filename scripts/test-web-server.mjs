#!/usr/bin/env node
// Web server suite (web port W1 — docs/WEB-PORT-SPEC.md).
//
//   node scripts/test-web-server.mjs
//
// Bundles server/index.ts, boots it on an ephemeral port against a fixture
// WEB_ROOT, and asserts the W1 contract:
//   - / serves the SPA with COOP/COEP (crossOriginIsolated prerequisites)
//   - hashed /assets/* are immutable, index.html is no-cache
//   - unknown GET paths fall back to index.html (SPA routing), non-GET 404
//   - /api/* answers 503 coming-online (never the SPA fallback)
//   - /healthz reports ok
//   - /games-art/* serves the injected art root
// Exit 1 on any failure.

import { execSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'webserver-'))

// Fixture SPA + art roots.
const webRoot = path.join(dir, 'dist-web')
mkdirSync(path.join(webRoot, 'assets'), { recursive: true })
writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>fixture</title>SPA-SHELL')
writeFileSync(path.join(webRoot, 'assets', 'main-HASH1234.js'), 'console.log("fixture")')
const artRoot = path.join(dir, 'games-art')
mkdirSync(path.join(artRoot, 'textures'), { recursive: true })
writeFileSync(path.join(artRoot, 'textures', 'felt.txt'), 'fixture-art')

// Bundle the server exactly like build-server.mjs does.
const serverOut = path.join(dir, 'server.cjs')
execSync(
  `npx esbuild server/index.ts --bundle --platform=node --format=cjs ` +
    `--define:__WEB_APP_VERSION__='"0.0.0-test"' --outfile=${serverOut}`,
  { stdio: 'pipe' }
)

// Boot on an ephemeral port; parse the "listening" line for the real address.
const child = spawn(process.execPath, [serverOut], {
  env: {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    WEB_ROOT: webRoot,
    GAMES_ART_ROOT: artRoot,
    LOG_LEVEL: 'silent'
  },
  stdio: ['ignore', 'pipe', 'inherit']
})

const base = await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error('server never reported listening')), 10_000)
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

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}

const isolated = (res) =>
  res.headers.get('cross-origin-opener-policy') === 'same-origin' &&
  res.headers.get('cross-origin-embedder-policy') === 'require-corp'

try {
  const root = await fetch(`${base}/`)
  check('/ is 200', root.status === 200)
  check('/ carries COOP+COEP', isolated(root))
  check('/ is the SPA shell', (await root.text()).includes('SPA-SHELL'))
  check('/ is no-cache', root.headers.get('cache-control') === 'no-cache')

  const asset = await fetch(`${base}/assets/main-HASH1234.js`)
  check('asset is 200', asset.status === 200)
  check('asset carries COOP+COEP', isolated(asset))
  check(
    'asset is immutable-cached',
    asset.headers.get('cache-control') === 'public, max-age=31536000, immutable'
  )

  const spa = await fetch(`${base}/school/chapter/anything?tab=1`)
  check('unknown GET falls back to the SPA shell (200)', spa.status === 200)
  check('fallback carries COOP+COEP', isolated(spa))
  check('fallback body is index.html', (await spa.text()).includes('SPA-SHELL'))

  const post = await fetch(`${base}/school/whatever`, { method: 'POST' })
  check('non-GET unknown path is 404, not the shell', post.status === 404)

  const api = await fetch(`${base}/api/games/list`)
  check('/api/* is 503, never the SPA fallback', api.status === 503)
  const apiBody = await api.json()
  check('/api/* body says coming-online', apiBody.error === 'coming-online')

  const apiBare = await fetch(`${base}/api`)
  check('/api (bare) is also 503, not the SPA shell', apiBare.status === 503)

  const staleChunk = await fetch(`${base}/assets/main-GONE1234.js`)
  check('missing hashed asset is 404, not index.html-as-JS', staleChunk.status === 404)
  const extPath = await fetch(`${base}/robots.txt`)
  check('extension-shaped path is 404, not the shell', extPath.status === 404)

  const health = await fetch(`${base}/healthz`)
  const healthBody = await health.json()
  check('/healthz ok', health.status === 200 && healthBody.ok === true)
  check('/healthz reports version', healthBody.version === '0.0.0-test')

  const art = await fetch(`${base}/games-art/textures/felt.txt`)
  check('/games-art/* serves the art root', art.status === 200 && (await art.text()) === 'fixture-art')
} finally {
  child.kill()
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nWeb server: all green')
