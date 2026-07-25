// ───────────────────────────────────────────────────────────────────────────
// BROWSER TURN PROOF: cross-NAT media over a real TURN relay, native WebRTC.
//
//   node scripts/smoke-turn-browser.mjs
//
// Closes the one gap the node harness could not: werift (node WebRTC polyfill,
// used ONLY in scripts/smoke/*.ts) has a non-compliant TURN client (STUN error
// 420), so relay-only media never flowed. The PRODUCTION app uses the browser's
// NATIVE RTCPeerConnection (browserFabric.ts joinBrowserRoom). This test drives
// that exact transport in TWO headless-Chromium contexts (two "machines"),
// forces iceTransportPolicy:'relay' (host + srflx candidates FORBIDDEN), points
// ICE at a real coturn, and signals over real public Nostr relays. If the two
// pages exchange data, the bytes PHYSICALLY transited the TURN relay. The
// genuine cross-NAT path two strangers on separate networks use.
//
// Self-contained: spawns coturn (brew), bundles the trystero entry with esbuild,
// serves it, launches chromium via playwright-core. Local-only (real WebRTC +
// public relays are non-deterministic): SKIP under CI.
// ───────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

let passed = 0
let failures = 0
const ok = (c, m) => { c ? (passed++, console.log(`  ✓ ${m}`)) : (failures++, console.log(`  ✗ ${m}`)) }

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log('SKIP smoke-turn-browser: real WebRTC/TURN/relay transport is local-only.')
  process.exit(0)
}

const RELAYS = (process.env.ACCEPT_RELAY_URL ||
  'wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://nostr.mom')
  .split(',').map((s) => s.trim()).filter(Boolean)
const TURN_PORT = 3478
const ICE = [{ urls: `turn:127.0.0.1:${TURN_PORT}`, username: 'chess', credential: 'chess' }]
const APP_ID = 'nodechess-turn-proof-v1'
const ROOM = 'turn-proof-room'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. coturn ────────────────────────────────────────────────────────────────
function findTurnserver() {
  const r = spawnSync('which', ['turnserver'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : '/opt/homebrew/bin/turnserver'
}
function startCoturn() {
  spawnSync('pkill', ['-9', '-f', 'turnserver'])
  const bin = findTurnserver()
  const logFile = resolve(ROOT, 'scripts/.turn-proof.log')
  try { writeFileSync(logFile, '') } catch {}
  const args = [
    '-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', `--listening-port=${TURN_PORT}`,
    '--min-port=50000', '--max-port=50200', '--lt-cred-mech', '--user=chess:chess',
    '--realm=nodechess', '--no-tls', '--no-dtls', '--no-cli', '--no-multicast-peers',
    '--allow-loopback-peers', `--log-file=${logFile}`, '--simple-log', '-a', '-v',
  ]
  const proc = spawn(bin, args, { stdio: 'ignore' })
  return { proc, logFile }
}

// ── 2. bundle the trystero entry for the browser ─────────────────────────────
async function bundleEntry() {
  const out = await build({
    entryPoints: [resolve(__dirname, 'smoke/turnBrowserEntry.js')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
  })
  return out.outputFiles[0].text
}

// ── 3. serve bundle + per-role HTML ──────────────────────────────────────────
function serve(bundleJs) {
  const html = (role) => `<!doctype html><meta charset=utf8><title>turn ${role}</title>
<script>window.__CFG=${JSON.stringify({ role, appId: APP_ID, roomId: ROOM, relayUrls: RELAYS, iceServers: ICE })}</script>
<script src="/bundle.js"></script>`
  const server = createServer((req, res) => {
    if (req.url.startsWith('/bundle.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundleJs); return
    }
    const role = req.url.includes('role=b') ? 'b' : 'a'
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html(role))
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

async function main() {
  console.log('═══ BROWSER TURN PROOF, native WebRTC, relay-only, real coturn ═══')
  console.log(`· signaling relays: ${RELAYS.join(', ')}`)
  const turn = startCoturn()
  await sleep(2500)
  const bundleJs = await bundleEntry()
  const server = await serve(bundleJs)
  const port = server.address().port
  console.log(`· serving on http://127.0.0.1:${port}  (coturn on :${TURN_PORT})`)

  const { chromium } = await import('playwright-core')
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    console.log('· installing chromium-headless-shell …')
    spawnSync('npx', ['playwright-core', 'install', 'chromium-headless-shell'], { stdio: 'inherit' })
    browser = await chromium.launch({ headless: true })
  }
  console.log(`· chromium ${browser.version()}`)

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  const errs = []
  for (const [p, n] of [[pageA, 'A'], [pageB, 'B']]) p.on('pageerror', (e) => errs.push(`${n}: ${e.message}`))

  try {
    await pageA.goto(`http://127.0.0.1:${port}/?role=a`, { waitUntil: 'load' })
    await pageB.goto(`http://127.0.0.1:${port}/?role=b`, { waitUntil: 'load' })

    const bootedA = await pageA.evaluate('window.__ready === true')
    const bootedB = await pageB.evaluate('window.__ready === true')
    ok(bootedA && bootedB, 'both browser peers booted the native-WebRTC trystero transport (relay-only)')
    const eA = await pageA.evaluate('window.__err'); const eB = await pageB.evaluate('window.__err')
    if (eA) console.log(`    A err: ${eA}`); if (eB) console.log(`    B err: ${eB}`)

    // Wait (up to 90s) for a relay-only data channel + a delivered message each way.
    const deadline = Date.now() + 90_000
    let gotA = [], gotB = [], connA = false, connB = false
    while (Date.now() < deadline) {
      connA = await pageA.evaluate('window.__connected === true')
      connB = await pageB.evaluate('window.__connected === true')
      gotA = JSON.parse(await pageA.evaluate('JSON.stringify(window.__got)'))
      gotB = JSON.parse(await pageB.evaluate('JSON.stringify(window.__got)'))
      if (connA && connB && gotA.length && gotB.length) break
      await sleep(1500)
    }

    ok(connA && connB, 'both peers established a peer connection with iceTransportPolicy=relay (no host/srflx allowed)')
    ok(gotA.length > 0, `peer A received B's messages over the relay-only channel (${JSON.stringify(gotA.slice(0, 2))})`)
    ok(gotB.length > 0, `peer B received A's messages over the relay-only channel (${JSON.stringify(gotB.slice(0, 2))})`)
    ok(gotA.some((m) => m.includes('from-b')) && gotB.some((m) => m.includes('from-a')),
      'the messages are genuinely cross-peer (A got B, B got A), a real bidirectional TURN-relayed channel')

    // coturn MUST show real peer bytes relayed (sp/sb or rp/rb > 0 on a session).
    await sleep(1000)
    let log = ''
    try { log = readFileSync(turn.logFile, 'utf8') } catch {}
    // A CHANNEL_BIND is TURN's mechanism for relaying data to a SPECIFIC peer.
    // Coturn only processes one when a peer is actively relaying through it. Its
    // success (plus the bidirectional message exchange above) is the definitive
    // coturn-side proof. Per-session byte TOTALS print only at teardown (after we
    // tear down), so we assert on the relay-establishment op, not the epilogue.
    const boundChannel = /CHANNEL_BIND processed, success/.test(log)
    const bytesAtTeardown = /\b(sb|rb|sp|rp)=([1-9]\d*)/.test(log)
    ok(boundChannel || bytesAtTeardown,
      'coturn bound a relay channel + processed peer traffic. Media physically transited the TURN server')
    const usageLines = log.split('\n').filter((l) => /CHANNEL_BIND|ALLOCATE|usage/i.test(l)).slice(-4)
    if (usageLines.length) console.log('    coturn:\n      ' + usageLines.map((l) => l.replace(/^\d+: \([^)]*\): /, '')).join('\n      '))
    if (errs.length) console.log('  page errors:\n   ' + errs.join('\n   '))
  } finally {
    await browser.close().catch(() => {})
    server.close()
    try { turn.proc.kill('SIGKILL') } catch {}
    spawnSync('pkill', ['-9', '-f', 'turnserver'])
  }

  console.log(`\n${failures ? '✗ FAILED' : 'ALL GREEN'}: ${passed} passed, ${failures} failed`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error('SMOKE ERROR:', e); spawnSync('pkill', ['-9', '-f', 'turnserver']); process.exit(1) })
