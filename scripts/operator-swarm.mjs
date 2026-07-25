// ───────────────────────────────────────────────────────────────────────────
// Operator / witness swarm: spin up N always-online peers so you can test
// rated play (needs a 3rd witness) and the PIN committee (needs ~M-of-N peers)
// WITHOUT owning N machines.
//
//   node scripts/operator-swarm.mjs [count] [url]
//     count : how many operator peers (default 3; enough to witness; use 8+ to
//             satisfy a PIN committee)
//     url   : the app to join (default http://localhost:8080)
//
// Each peer is the REAL app in a headless Chromium (native WebRTC; the same
// transport a real player uses), signed in via window.__chessAccounts. A
// signed-in peer is witness-capable and matchmaking auto-assigns it (see
// accountNetBoot.ts: "a dev/ops witness surface ... In production the always-on
// operator peer"). They join the SAME fabric as your browser (same relays/appId)
// so they show up as witnesses/committee members for your games.
//
// Ctrl-C to stop them all.
// ───────────────────────────────────────────────────────────────────────────
import { setTimeout as sleep } from 'node:timers/promises'

const COUNT = Math.max(1, Number(process.argv[2] || 3))
const URL = process.argv[3] || 'http://localhost:8080'
const PASSWORD = 'operator-swarm-pw'

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`)

async function bootPeer(chromium, i) {
  const name = `operator-${i}-${Math.random().toString(36).slice(2, 7)}`
  const context = await chromium.launchPersistentContext('', { headless: true })
  const page = await context.newPage()
  page.on('pageerror', (e) => log(`  [${name}] page error: ${e.message}`))
  await page.goto(URL, { waitUntil: 'load' })

  // Wait for the app's account surface to mount.
  await page.waitForFunction('!!window.__chessAccounts', null, { timeout: 30_000 })
  const isolated = await page.evaluate('self.crossOriginIsolated === true')
  if (!isolated) log(`  [${name}] WARNING: not crossOriginIsolated, argon2/engines may fail`)

  // Create + sign in a fresh account (unique name ⇒ no collision).
  const res = await page.evaluate(
    async ({ name, password }) => {
      try {
        await window.__chessAccounts.createAccount(name, password, { rememberSeed: true })
        const st = window.__chessAccounts.getState?.()
        return { ok: true, signedIn: !!(st && (st.account || st.signedIn || st.status === 'signed-in')) }
      } catch (e) {
        return { ok: false, err: String((e && e.message) || e) }
      }
    },
    { name, password: PASSWORD },
  )
  if (!res.ok) {
    log(`  [${name}] createAccount failed: ${res.err}`)
    return { name, context, page, ok: false }
  }

  // Give accountNetBoot time to join the fabric + announce witness caps.
  await sleep(4000)
  const status = await page.evaluate(() => {
    const w = window.__chessWitness
    const st = (w && (w.status?.() || w.getStatus?.() || w.state)) || null
    return { hasWitnessSurface: !!w, status: st }
  }).catch(() => ({ hasWitnessSurface: false }))

  log(`  ✓ [${name}] online. Witness surface: ${status.hasWitnessSurface ? 'yes' : 'no'}${status.status ? ' ' + JSON.stringify(status.status) : ''}`)
  return { name, context, page, ok: true }
}

async function main() {
  log(`Operator swarm: ${COUNT} peer(s) → ${URL}`)
  const { chromium } = await import('playwright-core')
  let browserOk = true
  try { const b = await chromium.launch({ headless: true }); await b.close() } catch { browserOk = false }
  if (!browserOk) {
    log('installing chromium-headless-shell …')
    const { spawnSync } = await import('node:child_process')
    spawnSync('npx', ['playwright-core', 'install', 'chromium-headless-shell'], { stdio: 'inherit' })
  }

  const peers = []
  for (let i = 1; i <= COUNT; i++) {
    try { peers.push(await bootPeer(chromium, i)) }
    catch (e) { log(`  [operator-${i}] boot error: ${String(e.message || e)}`) }
    await sleep(1500) // stagger so N peers don't hammer the relay at once
  }

  const live = peers.filter((p) => p && p.ok)
  log(`─── ${live.length}/${COUNT} operator peers ONLINE and witness-capable ───`)
  if (!live.length) { log('no peers came online: is the server up at ' + URL + ' ?'); process.exit(1) }
  log('These stay online as witnesses / committee members. Ctrl-C to stop.')

  // Heartbeat + keep the process (and browsers) alive.
  const shutdown = async () => {
    log('shutting down operator swarm …')
    for (const p of live) { try { await p.context.close() } catch {} }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  for (;;) {
    await sleep(30_000)
    let up = 0
    for (const p of live) { if (!p.page.isClosed()) up++ }
    log(`heartbeat: ${up}/${live.length} peers alive`)
  }
}

main().catch((e) => { console.error('SWARM ERROR:', e); process.exit(1) })
