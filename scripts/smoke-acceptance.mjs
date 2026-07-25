// A6 M6 / A-FINAL — THE §1 ACCEPTANCE TEST, END TO END, ON THE LIVE WIRE.
//
//   node scripts/smoke-acceptance.mjs   (npm run smoke:acceptance)
//
// FOUR account peers, EACH a FRESH argon2id account in its OWN worker thread
// (fresh trystero selfId + relay socket — the multi-process requirement), over
// the REAL trystero + werift WebRTC transport pointed at a localhost Nostr relay.
// This is the whole §1 acceptance sentence, asserted step by step:
//
//   PHASE 1 — THE ACCEPTANCE GATE:
//     • FOUR FRESH ACCOUNTS are created from argon2id identities (deriveIdentity
//       + deriveChild — the exact web/accounts.ts createAccount derivation). The
//       harness independently RE-DERIVES each root from (name,password) and
//       proves it equals the account the peer booted as — a real §1 root, not a
//       test keypair, deterministically reproducible (C-5: no recovery).
//     • TWO STRANGERS AUTO-PAIR with NO room code (the harness brokers nothing —
//       the shared gameKey proves the signed-pool rendezvous), host=white.
//     • A DISTINCT THIRD peer self-assigns as the WITNESS (neither player); the
//       real witnessed 'pairing' event anchors + verifies in BOTH chains.
//     • they play a scripted rated Blitz game; the countersigned rated `segment`
//       lands in BOTH chains (verifyChain green, verifySegmentEvent === null,
//       same game/transcript/witness-sig); the a4 fold moves BOTH ladders off 1200.
//     • the M5 Tier-1 JUDGE runs over the finished SIGNED transcript on BOTH
//       instances → a per-game Tier1Record naming the game + ladder, both sides
//       scored, and the SAME tier1Digest on both (the §8 cross-instance parity).
//     • both players FINAL-SYNC their chain into shard space (§5 erasure code +
//       self chain-pointer). THE OWNER (white) GOES OFFLINE, and a FOURTH FRESH
//       peer RECONSTRUCTS white's profile/game FROM SHARD SPACE through the live
//       viewer — bit-faithful chain, real folded profile, the rated game present.
//
//   PHASE 2 — HONEST 2-USER DEGRADATION (no third machine):
//     two peers, no witness ⇒ both reach 'waiting-witness' (opponentFound, NO game
//     opened, no lease grabbed — never a fake pairing, C-10); CASUAL (unsigned)
//     play over the same transport still starts + moves (byte-identical v5).
//
// TRANSPORT (stated honestly, exactly like smoke-live-slice / smoke-m2): trystero
// 0.25.2 + werift, pointed at a LOCALHOST Nostr relay (scripts/lib/local-nostr-
// relay.mjs) rather than public relays — the sanctioned A6 fallback
// ("a multi-process localhost signaling harness that KEEPS the real trystero
// transport"): from bare node, N peers hammering the public pool trip rate-
// limiting and never mesh, while the werift WebRTC itself is 100% real (ICE over
// 127.0.0.1 host candidates). Point relayConfig at a public relay to run it fully
// public. The in-worker Tier-1 judge uses the sanctioned spec-faithful UCI double
// (test-accounts-judge-runner's engine); the real pinned-WASM judge's determinism
// is proven by test-accounts-judge-runner §7 + test-judge-node.
//
// GATED LOCAL-ONLY (like smoke-live-slice / smoke-m2 / operator-smoke): SKIP under
// CI (real WebRTC + relays are non-deterministic), HARD-run locally. Not in build.yml.

import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { startLocalNostrRelay } from './lib/local-nostr-relay.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// ---- CI gate ---------------------------------------------------------------
if (process.env.CI || process.env.GITHUB_ACTIONS) {
  console.log('SKIP smoke-acceptance: real WebRTC/relay transport is local-only (not deterministic under CI).')
  process.exit(0)
}

// ---- assert kit ------------------------------------------------------------
let passed = 0
let failed = 0
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✓ ${msg}`) } else { failed++; console.log(`  ✗ ${msg}`) } }
const eq = (a, b, msg) => ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

const TC = { initialMs: 180_000, incrementMs: 2_000 } // 3+2 ⇒ Blitz (matches MM_DEFAULT_TC.Blitz)
const SEED_MICRO = 1200 * 1_000_000
const K_REC = 12 // production K_rec (§5 40/12 geometry) — reconstruction floor

// Fresh, distinct argon2id credentials per run (distinct names ⇒ distinct roots).
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const CREDS = {
  a: { name: `alice-${RUN}`, password: `pw-alice-${RUN}-Xk9!` },
  b: { name: `bruno-${RUN}`, password: `pw-bruno-${RUN}-Zt3?` },
  witness: { name: `wanda-${RUN}`, password: `pw-wanda-${RUN}-Qm7#` },
  viewer: { name: `viktor-${RUN}`, password: `pw-viktor-${RUN}-Lp2$` },
}

async function bundleWorker(outdir) {
  const outfile = resolve(outdir, 'acceptancePeerWorker.mjs')
  await build({
    entryPoints: [resolve(ROOT, 'scripts/smoke/acceptancePeerWorker.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'node', 'default'],
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

/** A tiny bundle of the FROZEN identity derivation so the harness can RE-DERIVE
 *  each account root independently of the worker — proving the peer's account IS
 *  the argon2id identity for its (name,password), and reproducibly so (C-5). */
async function bundleDerive(outdir) {
  const entry = resolve(outdir, 'derive-entry.mjs')
  writeFileSync(
    entry,
    `export { deriveIdentity, deriveChild, KEY_PURPOSE, toB64u } from ${JSON.stringify(resolve(ROOT, 'src/shared/accounts/index.ts'))}\n`,
  )
  const outfile = resolve(outdir, 'derive.mjs')
  await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20',
    alias: { '@shared': resolve(ROOT, 'src/shared') }, absWorkingDir: ROOT, logLevel: 'warning',
  })
  return import(pathToFileURL(outfile).href)
}

/** Spawn one worker + accumulate everything it posts back. */
function spawnPeer(workerFile, role, cred, warmupMs = 0) {
  const w = new Worker(workerFile, { workerData: { role, name: cred.name, password: cred.password, relayUrl: RELAY_URL, relayUrls: PUBLIC_RELAYS, tc: TC, warmupMs, iceServers: PUBLIC_ICE, iceRelayOnly: ICE_RELAY_ONLY } })
  const state = {
    role, cred, ready: null, result: null, error: null,
    statuses: [], preps: [], witnessing: null, witnessResult: null,
    judge: null, synced: null, chainHash: null, reconstructed: null, left: false,
    casualCode: null, casualResult: null,
  }
  w.on('message', (m) => {
    if (m.type === 'log') console.log(`    [${m.role}:${m.name ?? ''}] ${m.msg}`)
    else if (m.type === 'error') { console.error(`    [${m.role}] ERROR ${m.msg}`); state.error = m.msg }
    else if (m.type === 'ready') state.ready = m
    else if (m.type === 'status') state.statuses.push(m)
    else if (m.type === 'prep') state.preps.push(m)
    else if (m.type === 'result') state.result = m
    else if (m.type === 'judge') state.judge = m
    else if (m.type === 'synced') state.synced = m
    else if (m.type === 'chainHash') state.chainHash = m.hash
    else if (m.type === 'reconstructed') state.reconstructed = m
    else if (m.type === 'left') state.left = true
    else if (m.type === 'witnessing') state.witnessing = m
    else if (m.type === 'witnessResult') state.witnessResult = m
    else if (m.type === 'casualCode') state.casualCode = m.code
    else if (m.type === 'casualResult') state.casualResult = m
  })
  w.on('error', (e) => { console.error(`    [${role}] worker error ${e.message}`); state.error = String(e) })
  return { w, state }
}

let RELAY_URL = ''
// ── Public-internet override (ACCEPT_RELAY_URL) ──────────────────────────────
// Default: localhost relay (deterministic). Set ACCEPT_RELAY_URL=wss://<public
// nostr relay> to route SIGNALING through real public internet infrastructure —
// the genuine "two strangers worldwide discover each other" proof. When public,
// we also hand the peers the real DEFAULT_ICE_SERVERS STUN/TURN set (host
// candidates still win on one machine, but ICE gathers against public STUN).
const PUBLIC_RELAYS = (process.env.ACCEPT_RELAY_URL || '').split(',').map((s) => s.trim()).filter(Boolean)
const PUBLIC_RELAY = PUBLIC_RELAYS[0] || ''
// Optional reliable TURN: ACCEPT_TURN="turn:host:port,user,cred" (free openrelay
// TURN is frequently down; a real coturn makes the relay-only proof deterministic).
const CUSTOM_TURN = (() => {
  const raw = (process.env.ACCEPT_TURN || '').trim()
  if (!raw) return null
  const [urls, username, credential] = raw.split(',').map((s) => s.trim())
  return urls ? { urls, username, credential } : null
})()
const PUBLIC_ICE = PUBLIC_RELAY
  ? [
      ...(CUSTOM_TURN ? [CUSTOM_TURN] : []),
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: ['turn:standard.relay.metered.ca:80', 'turn:standard.relay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
    ]
  : []
// Force media through TURN only (cross-NAT proof): ACCEPT_ICE_RELAY_ONLY=1.
const ICE_RELAY_ONLY = process.env.ACCEPT_ICE_RELAY_ONLY === '1'
const openSignaling = async () => {
  if (PUBLIC_RELAY) {
    console.log(`· PUBLIC signaling relay ${PUBLIC_RELAY} (real internet infra)`)
    return { url: PUBLIC_RELAY, close: async () => {} }
  }
  const r = await startLocalNostrRelay()
  console.log(`· local signaling relay ${r.url}`)
  return { url: r.url, close: () => r.close() }
}
const waitFor = async (pred, ms, label) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 200)) }
  throw new Error(`timeout: ${label}`)
}
const lastStatus = (p) => p.state.statuses[p.state.statuses.length - 1] ?? null
const sawPhase = (p, phase) => p.state.statuses.some((s) => s.phase === phase)

// ===========================================================================
// PHASE 1 — the acceptance gate
// ===========================================================================
async function phaseAcceptance(workerFile, derive) {
  console.log('\n═══ PHASE 1 — THE §1 ACCEPTANCE GATE (fresh argon2id accounts, live wire) ═══')
  const relay = await openSignaling()
  RELAY_URL = relay.url

  // Witness + viewer boot FIRST so they are fully meshed (fabric + overlay) BEFORE
  // the searchers seek + before the players shard: the host's offer is a one-shot
  // broadcast, and the viewer must be a live carrier when the players final-sync.
  const witness = spawnPeer(workerFile, 'witness', CREDS.witness)
  const viewer = spawnPeer(workerFile, 'viewer', CREDS.viewer)
  const peers = { witness, viewer }
  const all = () => Object.values(peers)
  try {
    console.log('· booting the witness + the reconstruction viewer (fresh argon2id accounts) …')
    await waitFor(() => (witness.state.ready || witness.state.error) && (viewer.state.ready || viewer.state.error), 60_000, 'witness+viewer ready')
    for (const p of [witness, viewer]) if (p.state.error) throw new Error(`${p.state.role} failed to boot: ${p.state.error}`)
    await new Promise((r) => setTimeout(r, 7_000)) // mesh the fabric/overlay

    console.log('· booting the two strangers (fresh argon2id accounts; warm up, then search) …')
    peers.a = spawnPeer(workerFile, 'searcher', CREDS.a, 4_000)
    peers.b = spawnPeer(workerFile, 'searcher', CREDS.b, 4_000)
    await waitFor(() => all().every((p) => p.state.ready || p.state.error), 60_000, 'all peers ready')
    for (const p of all()) if (p.state.error) throw new Error(`${p.state.role} failed to boot: ${p.state.error}`)
    ok(true, 'all FOUR account peers booted + announced presence on the live fabric')

    // ---- PROOF: every account is a real argon2id §1 identity -----------------
    console.log('\n· PROOF — every peer is a FRESH argon2id account (independently re-derived):')
    for (const [key, p] of Object.entries(peers)) {
      const cred = p.state.cred
      const id = await derive.deriveIdentity(cred.name, cred.password)
      const reRoot = derive.toB64u(id.rootPub)
      eq(p.state.ready.root, reRoot, `${p.state.role} (${cred.name}) root === argon2id deriveIdentity(name,password) — a real §1 account, reproducible`)
      ok(typeof p.state.ready.root === 'string' && p.state.ready.root.length === 43, `${p.state.role} root is a 43-char b64u ed25519 account key`)
      ok(typeof p.state.ready.tag === 'string' && p.state.ready.tag.length > 0, `${p.state.role} carries a #tag identicon (${p.state.ready.tag})`)
    }
    const roots = all().map((p) => p.state.ready.root)
    eq(new Set(roots).size, roots.length, 'all four accounts are DISTINCT roots (four independent identities)')

    console.log('\n· waiting for the strangers to pair + the witness to attach + the game to finish + judge + sync …')
    await waitFor(
      () => (peers.a.state.result && peers.b.state.result) || all().some((p) => p.state.error),
      300_000,
      'both players published their segment',
    )
    for (const p of all()) if (p.state.error) throw new Error(`${p.state.role}: ${p.state.error}`)

    const A = peers.a.state.result
    const B = peers.b.state.result
    const white = A.color === 'w' ? A : B
    const black = A.color === 'w' ? B : A
    const whitePeer = A.color === 'w' ? peers.a : peers.b

    // ---- PROOF: paired with NO code exchanged --------------------------------
    console.log('\n· PROOF — two strangers auto-paired with NO room code exchanged:')
    ok(peers.a.state.statuses.some((s) => s.opponentFound), 'peer A found a legal opponent purely from the signed pool')
    ok(peers.b.state.statuses.some((s) => s.opponentFound), 'peer B found a legal opponent purely from the signed pool')
    ok(white.color === 'w' && black.color === 'b', 'exactly one host (white) and one guest (black) — the deterministic seat split')
    eq(white.segment && white.segment.game, black.segment && black.segment.game, 'both peers reached the SAME gameKey with NO parent brokering (pool rendezvous)')

    // ---- PROOF: a distinct third peer witnessed ------------------------------
    console.log('\n· PROOF — a distinct third peer attached as the witness (neither player):')
    ok(peers.witness.state.witnessing, 'the third peer self-assigned + attached as the witness')
    const wm = peers.witness.state.witnessing ?? {}
    ok(wm.host === white.root && wm.guest === black.root, 'the witness knows both players as host/guest and is NEITHER of them')
    ok(peers.witness.state.ready.root !== white.root && peers.witness.state.ready.root !== black.root, 'the witness is a distinct third account')

    // ---- PROOF: the live write lease at ONE epoch ----------------------------
    console.log('\n· PROOF — both players hold the live write lease at one monotonic epoch:')
    ok(peers.a.state.preps.some((p) => p.ok) && peers.b.state.preps.some((p) => p.ok), 'both players completed the pre-game lease + pairing prep')
    eq(white.epoch, 1, 'white acquired the lease at epoch 1 (fresh account)')
    eq(black.epoch, 1, 'black acquired the lease at epoch 1 (fresh account)')

    // ---- PROOF: the REAL witnessed pairing event in BOTH chains --------------
    console.log('\n· PROOF — the REAL witnessed pairing event anchored + verifies in BOTH chains:')
    ok(white.hasPairing && black.hasPairing, 'both chains carry a witnessed "pairing" event before move 1 (§3/§8)')
    ok(white.pairingVerified && black.pairingVerified, 'both pairing events verify (event sig + ≥1 attestation + correct game/ladder/opponent)')

    // ---- PROOF: the countersigned rated segment in BOTH chains ---------------
    console.log('\n· PROOF — matching countersigned rated segments in BOTH chains:')
    ok(white.landed && black.landed, 'both players appended a witnessed segment to their own chain')
    ok(white.verifyChainOk && black.verifyChainOk, 'both chains verifyChain green with pairing + segment')
    eq(white.segmentVerifyErr, null, "white chain's segment verifies (verifySegmentEvent === null)")
    eq(black.segmentVerifyErr, null, "black chain's segment verifies (verifySegmentEvent === null)")
    if (white.segment && black.segment) {
      eq(white.segment.game, black.segment.game, 'both segments name the SAME game key (§3)')
      eq(white.segment.transcript, black.segment.transcript, 'both segments carry the SAME transcript digest (§3 pairwise)')
      eq(white.segment.wstreamSig, black.segment.wstreamSig, 'both segments embed the SAME witness terminal signature (one witness, two chains)')
      eq(white.segment.color, 'w', 'white segment records the white seat')
      eq(black.segment.color, 'b', 'black segment records the black seat')
      eq(white.segment.opp, black.root, 'white segment names black as opponent')
      eq(black.segment.opp, white.root, 'black segment names white as opponent')
      eq(white.segment.result, '1-0', 'segment result is 1-0 (black resigned)')
      eq(white.segment.kind, 'chess', 'segment carries the rated ladder kind')
    }

    // ---- PROOF: the a4 fold moved BOTH ladders off the seed -------------------
    console.log('\n· PROOF — the a4 fold moved BOTH Blitz ladders off the §6 1200 seed:')
    ok(white.ladder && white.ladder.n === 1, 'white Blitz ladder folded exactly 1 rated game')
    ok(black.ladder && black.ladder.n === 1, 'black Blitz ladder folded exactly 1 rated game')
    ok(white.ladder && white.ladder.r > SEED_MICRO, 'white (winner) rating rose above 1200')
    ok(black.ladder && black.ladder.r < SEED_MICRO, 'black (loser) rating fell below 1200')

    // ---- PROOF: the M5 Tier-1 judge ran over the finished game ---------------
    console.log('\n· PROOF — the M5 Tier-1 anticheat judge ran over the finished SIGNED game (both instances):')
    await waitFor(() => (peers.a.state.judge && peers.b.state.judge) || all().some((p) => p.state.error), 60_000, 'both players judged').catch(() => {})
    const jA = peers.a.state.judge
    const jB = peers.b.state.judge
    ok(jA && jA.ok, 'peer A produced a Tier-1 record over its finished signed transcript')
    ok(jB && jB.ok, 'peer B produced a Tier-1 record over its finished signed transcript')
    if (jA && jB && jA.ok && jB.ok) {
      eq(jA.game, white.segment.game, 'the Tier-1 record names the game that was actually played')
      eq(jA.ladder, 'chess:Blitz', 'the Tier-1 record rated on the chess:Blitz ladder')
      eq(jA.tier1Digest, jB.tier1Digest, 'BOTH instances produced the IDENTICAL tier1Digest (the §8 cross-instance parity property)')
      ok(jA.wScored >= 1 && jA.bScored >= 1, 'both sides have scored moves in the judged record')
    }

    // ---- PROOF: both players final-synced their chain into shard space -------
    console.log('\n· PROOF — both players FINAL-SYNCED their chain into shard space (§5):')
    await waitFor(() => (peers.a.state.synced && peers.b.state.synced) || all().some((p) => p.state.error), 60_000, 'both players synced').catch(() => {})
    ok(peers.a.state.synced && peers.a.state.synced.ok, 'peer A erasure-coded its chain into shard space + pinned a self chain-pointer')
    ok(peers.b.state.synced && peers.b.state.synced.ok, 'peer B erasure-coded its chain into shard space + pinned a self chain-pointer')
    ok(whitePeer.state.synced && whitePeer.state.synced.liveRows >= K_REC, `white left ≥ K_rec(${K_REC}) live shard rows on the network (${whitePeer.state.synced?.liveRows} rows)`)

    // ---- PROOF: a FOURTH peer reconstructs white with the OWNER OFFLINE ------
    console.log('\n· PROOF — a FOURTH fresh peer RECONSTRUCTS white from shard space with the OWNER OFFLINE:')
    // Let the shard rows + the write-time pointer index settle across carriers.
    await new Promise((r) => setTimeout(r, 12_000))
    const whiteChainHash = whitePeer.state.result.chainHash
    ok(typeof whiteChainHash === 'string' && whiteChainHash.length === 43, 'white reported the hash of its own final chain (the bit-faithful target)')

    // THE OWNER (white) GOES OFFLINE — a graceful leave (sign-out / close-tab):
    // onPeerLeave prunes white from every routing table at once, so the viewer's
    // shard lookups never stall on a dead contact; white's shards live on the
    // OTHER carriers (black/witness/viewer) regardless — the network IS the storage.
    console.log(`· white (${whitePeer.state.cred.name}) signs off — the owner goes offline …`)
    whitePeer.w.postMessage({ type: 'leave' })
    await waitFor(() => whitePeer.state.left || whitePeer.state.error, 20_000, 'white left the overlay').catch(() => {})
    await new Promise((r) => setTimeout(r, 5_000)) // let onPeerLeave propagate + the mesh settle

    console.log('· the viewer reconstructs white over the live overlay (owner gone) …')
    peers.viewer.w.postMessage({ type: 'reconstruct', subjectRoot: white.root })
    await waitFor(() => peers.viewer.state.reconstructed || peers.viewer.state.error, 120_000, 'viewer reconstructed')
    if (peers.viewer.state.error) throw new Error(`viewer: ${peers.viewer.state.error}`)
    const rc = peers.viewer.state.reconstructed
    eq(rc.status, 'expected', 'viewerClient resolve status: expected (the full chain via the shard layer, owner offline)')
    ok(rc.hasChain, 'the full chain reconstructed from shard space')
    eq(rc.bitHash, whiteChainHash, 'THE PROOF: the reconstructed chain is BIT-FAITHFUL to white\'s original bytes (owner gone)')
    eq(rc.displayName, white.displayName, 'the reconstructed profile carries white\'s real genesis display name')
    ok(rc.available, 'the viewer reports the account as available (verified bytes reached it)')
    ok(rc.segments >= 1, `the reconstructed view carries white's rated game segment(s) (${rc.segments})`)
    eq(rc.ladderBlitzGames, 1, 'the reconstructed profile fold rated exactly the 1 Blitz game (real fold over reconstructed bytes)')

    peers.witness.w.postMessage({ type: 'stop' })
    await waitFor(() => peers.witness.state.witnessResult, 10_000, 'witness reported').catch(() => {})
    ok(peers.witness.state.witnessResult && peers.witness.state.witnessResult.witnessed, 'the witness produced a witnessed terminal for the game')
  } finally {
    for (const p of Object.values(peers)) { try { p.w.postMessage({ type: 'stop' }) } catch {} }
    await Promise.all(Object.values(peers).map((p) => p.w.terminate().catch(() => {})))
    await relay.close()
  }
}

// ===========================================================================
// PHASE 2 — honest 2-user degradation: 2 peers, no witness, casual still works
// ===========================================================================
async function phaseDegradation(workerFile) {
  console.log('\n═══ PHASE 2 — honest 2-user degradation (2 peers, no third machine) ═══')
  const relay = await openSignaling()
  RELAY_URL = relay.url
  const peers = {
    a: spawnPeer(workerFile, 'searcher', CREDS.a),
    b: spawnPeer(workerFile, 'searcher', CREDS.b),
  }
  const all = Object.values(peers)
  try {
    await waitFor(() => all.every((p) => p.state.ready || p.state.error), 60_000, 'both peers ready')
    for (const p of all) if (p.state.error) throw new Error(`${p.state.role} failed to boot: ${p.state.error}`)
    ok(true, 'both account peers booted (no third machine online)')

    console.log('· waiting for both strangers to pair legally + honestly WAIT for a witness …')
    await waitFor(
      () => all.every((p) => sawPhase(p, 'waiting-witness')) || all.some((p) => p.state.error),
      60_000,
      'both reach waiting-witness',
    )
    for (const p of all) if (p.state.error) throw new Error(`${p.state.role}: ${p.state.error}`)

    console.log('\n· PROOF — the rated flow HONESTLY WAITS, never a fake pairing (C-10):')
    for (const p of all) {
      const s = lastStatus(p)
      ok(s && s.phase === 'waiting-witness', `${p.state.role} sits in 'waiting-witness' (never a dead button)`)
      ok(p.state.statuses.some((x) => x.opponentFound), `${p.state.role} DID find its legal opponent — only the WITNESS is missing`)
      ok(s && s.witnessesReachable <= 1, `${p.state.role} has NO distinct third-machine witness (count ≤ the witness-capable opponent)`)
    }
    ok(peers.a.state.preps.length === 0 && peers.b.state.preps.length === 0, 'NO pre-game prep ran — no lease grabbed without a witness')
    ok(!peers.a.state.result && !peers.b.state.result, 'NO rated game room was ever opened — never a fake pairing (C-10)')

    console.log('\n· PROOF — CASUAL (unsigned) play still works while rated waits:')
    peers.a.w.postMessage({ type: 'casualHost' })
    await waitFor(() => peers.a.state.casualCode || peers.a.state.error, 30_000, 'casual host minted a code')
    if (peers.a.state.error) throw new Error(`casual host: ${peers.a.state.error}`)
    peers.b.w.postMessage({ type: 'casualJoin', code: peers.a.state.casualCode })
    await waitFor(
      () => (peers.a.state.casualResult && peers.b.state.casualResult) || all.some((p) => p.state.error),
      40_000,
      'both play the casual game',
    )
    for (const p of all) if (p.state.error) throw new Error(`${p.state.role}: ${p.state.error}`)
    ok(peers.a.state.casualResult && peers.a.state.casualResult.started, 'the casual game started for the host (unsigned, byte-identical v5)')
    ok(peers.b.state.casualResult && peers.b.state.casualResult.started, 'the casual game started for the joiner')
    ok(peers.b.state.casualResult && peers.b.state.casualResult.plies >= 1, 'a move flowed over the casual game (white e2e4) — casual is fully live')
    ok(!peers.a.state.result && !peers.b.state.result, 'the rated search still never opened a game — casual and rated are cleanly separate')
  } finally {
    for (const p of all) { try { p.w.postMessage({ type: 'stop' }) } catch {} }
    await Promise.all(all.map((p) => p.w.terminate().catch(() => {})))
    await relay.close()
  }
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'smoke-acc-'))
  console.log('· bundling acceptancePeerWorker.ts (real transport modules external) + the derive re-check …')
  const workerFile = await bundleWorker(outdir)
  const derive = await bundleDerive(outdir)
  try {
    await phaseAcceptance(workerFile, derive)
    await phaseDegradation(workerFile)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failed ? `❌ ${failed} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failed ? `, ${failed} failures` : ''}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => { console.error(`\nSMOKE FAILED: ${err?.stack ?? err}`); process.exit(1) })
