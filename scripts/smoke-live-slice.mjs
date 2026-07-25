// A6 M1: THE LIVE PROOF (real-transport smoke). Two signed-in player peers + one
// witness peer, EACH in its own worker thread (fresh trystero selfId + relay
// socket: the multi-process requirement), play one scripted RATED Blitz game
// end-to-end over the REAL trystero + werift WebRTC transport, and BOTH players'
// chains persist matching countersigned rated `segment`s that verifyChain green
// and move both ladders off the §6 seed. This is the vertical slice of the §1
// acceptance test on the live wire. The first time the browser fabric + the
// signed-play + witness + segment path all run over a real transport together.
//
//   node scripts/smoke-live-slice.mjs
//
// TRANSPORT (stated honestly): trystero 0.25.2 + werift, pointed at a LOCALHOST
// Nostr relay (scripts/lib/local-nostr-relay.mjs) rather than public relays.
// WHY: from bare node, three peers hammering the public relay pool trip
// rate-limiting ("you note too much") and never mesh (verified: see notesForLead);
// the werift WebRTC itself is 100% real (ICE over 127.0.0.1 host candidates). This
// is exactly the sanctioned A6 fallback: "a multi-process localhost
// signaling harness that KEEPS the real trystero transport". Point relayConfig at
// a public relay to run it fully public.
//
// GATED LOCAL-ONLY (like operator-smoke / the judge parity subset): SKIP under CI
// (WebRTC + relays are non-deterministic), HARD-run locally. Not in build.yml.

import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { startLocalNostrRelay } from './lib/local-nostr-relay.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- CI gate ---------------------------------------------------------------
if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log('SKIP smoke-live-slice: real WebRTC/relay transport is local-only (not deterministic under CI).')
  process.exit(0)
}

// ---- assert kit ------------------------------------------------------------
let passed = 0
let failed = 0
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✓ ${msg}`) } else { failed++; console.log(`  ✗ ${msg}`) } }
const eq = (a, b, msg) => ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

const TC = { initialMs: 300_000, incrementMs: 0 } // 5+0 ⇒ Blitz
const SEED_MICRO = 1200 * 1_000_000

async function bundleWorker(outdir) {
  const outfile = resolve(outdir, 'peerWorker.mjs')
  await build({
    entryPoints: [resolve(ROOT, 'scripts/smoke/peerWorker.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'node', 'default'],
    // Real transport packages load at runtime (native-ish); the app modules bundle.
    external: ['trystero', 'werift'],
    alias: {
      '@shared': resolve(ROOT, 'src/shared'),
      '@renderer': resolve(ROOT, 'src/renderer/src'),
    },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  return outfile
}

function spawnPeer(workerFile, role, relayUrl) {
  const w = new Worker(workerFile, { workerData: { role, relayUrl, seed: SEEDS[role], tc: TC } })
  const state = { role, ready: null, result: null, hosted: null }
  w.on('message', (m) => {
    if (m.type === 'log') console.log(`    [${m.role}] ${m.msg}`)
    else if (m.type === 'error') { console.error(`    [${m.role}] ERROR ${m.msg}`); state.error = m.msg }
    else if (m.type === 'ready') state.ready = m
    else if (m.type === 'hosted') state.hosted = m
    else if (m.type === 'result') state.result = m
  })
  w.on('error', (e) => { console.error(`    [${role}] worker error ${e.message}`); state.error = String(e) })
  return { w, state }
}

const SEEDS = { white: 11, black: 22, witness: 33 }
const waitFor = async (pred, ms, label) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 150)) }
  throw new Error(`timeout: ${label}`)
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'smoke-live-'))
  const relay = await startLocalNostrRelay()
  console.log(`· local signaling relay ${relay.url}`)
  console.log('· bundling peerWorker.ts (real transport modules external) …')
  const workerFile = await bundleWorker(outdir)

  const peers = {
    white: spawnPeer(workerFile, 'white', relay.url),
    black: spawnPeer(workerFile, 'black', relay.url),
    witness: spawnPeer(workerFile, 'witness', relay.url),
  }
  const all = Object.values(peers)

  try {
    console.log('· booting 3 account peers over the real fabric …')
    await waitFor(() => all.every((p) => p.state.ready || p.state.error), 40_000, 'all peers ready')
    for (const p of all) if (p.state.error) throw new Error(`${p.state.role} failed to boot: ${p.state.error}`)
    ok(true, 'all three account peers booted + announced presence on the live fabric')

    // Broker identities: each player gets its opponent; the witness gets both.
    const idOf = (r) => ({ root: peers[r].state.ready.root, key: peers[r].state.ready.key })
    peers.white.w.postMessage({ type: 'peers', peers: { opp: idOf('black') } })
    peers.black.w.postMessage({ type: 'peers', peers: { opp: idOf('white') } })
    peers.witness.w.postMessage({ type: 'peers', peers: { players: { w: idOf('white'), b: idOf('black') } } })

    // White auto-hosts; broker the room code to the witness FIRST (it must seat
    // before the guest so it receives the mirrored start), then to black.
    console.log('· white hosting the rated game …')
    await waitFor(() => peers.white.state.hosted || peers.white.state.error, 40_000, 'white hosted')
    if (peers.white.state.error) throw new Error(`white host failed: ${peers.white.state.error}`)
    const code = peers.white.state.hosted.code
    console.log(`· room ${code}: seating the witness, then joining black …`)
    peers.witness.w.postMessage({ type: 'code', code })
    await new Promise((r) => setTimeout(r, 9_000)) // witness WebRTC-connects + seats
    peers.black.w.postMessage({ type: 'code', code })

    console.log('· playing the scripted rated game to terminal + publishing segments …')
    await waitFor(
      () => (peers.white.state.result && peers.black.state.result) || all.some((p) => p.state.error),
      120_000,
      'both players published their segment',
    )
    for (const p of all) if (p.state.error) throw new Error(`${p.state.role}: ${p.state.error}`)

    const W = peers.white.state.result
    const B = peers.black.state.result
    peers.witness.w.postMessage({ type: 'stop' })

    // ---- THE PROOF ---------------------------------------------------------
    console.log('\n· PROOF. Matching countersigned rated segments in BOTH chains:')
    ok(W.landed && B.landed, 'both players appended a witnessed segment to their own chain')
    ok(W.verifyChainOk && B.verifyChainOk, 'both chains verifyChain green with the appended segment')
    eq(W.segmentVerifyErr, null, "white chain's segment verifies (verifySegmentEvent === null)")
    eq(B.segmentVerifyErr, null, "black chain's segment verifies (verifySegmentEvent === null)")
    if (W.segment && B.segment) {
      eq(W.segment.game, B.segment.game, 'both segments name the SAME game key (§3)')
      eq(W.segment.transcript, B.segment.transcript, 'both segments carry the SAME transcript digest (§3 pairwise)')
      eq(W.segment.wstreamSig, B.segment.wstreamSig, 'both segments embed the SAME witness terminal signature (one witness, two chains)')
      eq(W.segment.color, 'w', 'white segment records the white seat')
      eq(B.segment.color, 'b', 'black segment records the black seat')
      eq(W.segment.opp, B.root, 'white segment names black as opponent')
      eq(B.segment.opp, W.root, 'black segment names white as opponent')
      eq(W.segment.result, '1-0', 'segment result is 1-0 (black resigned)')
      eq(W.segment.kind, 'chess', 'segment carries the rated ladder kind')
    }
    console.log('\n· PROOF. The a4 fold moved BOTH ladders off the §6 seed:')
    ok(W.ladder && W.ladder.n === 1, 'white Blitz ladder folded exactly 1 rated game')
    ok(B.ladder && B.ladder.n === 1, 'black Blitz ladder folded exactly 1 rated game')
    ok(W.ladder && W.ladder.r > SEED_MICRO, 'white (winner) rating rose above 1200')
    ok(B.ladder && B.ladder.r < SEED_MICRO, 'black (loser) rating fell below 1200')
  } finally {
    await Promise.all(all.map((p) => p.w.terminate()))
    await relay.close()
    rmSync(outdir, { recursive: true, force: true })
  }

  console.log(`\n${failed ? `❌ ${failed} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failed ? `, ${failed} failures` : ''}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(`\nSMOKE FAILED: ${err?.stack ?? err}`); process.exit(1) })
