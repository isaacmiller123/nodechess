// A6 M1 Lane A proof: the browser accounts fabric over an INJECTED fake room
// (no relay; deterministic + headless). Proves createBrowserFabric
// (src/renderer/src/features/account/net/browserFabric.ts) is a faithful
// FabricEndpoint:
//   1. announce() records own presence locally AND gossips it; a receiver
//      ingests VERIFIED presence into directory() + learns nodeId->peerId;
//   2. request() round-trips a FRAMED CanonicalObject to the right handler,
//      attributing the caller by nodeId (the reverse peerId map);
//   3. an unknown FabricRequestKind returns { error } (never throws at the peer);
//   4. a request to an unknown node throws (no silent dead route);
//   5. close() leaves the room.
// Plus iceConfig (Lane A step 1): resolveIceServers() is byte-identical to the
// former inline set with no override, and the C-11 override + operator-fallback
// slot compose as specified.
//
// House style: esbuild-bundle on the fly (trystero external; the injected room
// means joinRoom is never called), one-line asserts, exit(1) on any fail.
//
//   node scripts/test-accounts-browser-fabric.mjs

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const BROWSER_FABRIC_TS = resolve(ROOT, 'src/renderer/src/features/account/net/browserFabric.ts').replace(/\\/g, '/')
const ICE_CONFIG_TS = resolve(ROOT, 'src/renderer/src/features/account/net/iceConfig.ts').replace(/\\/g, '/')

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const ENTRY = `
export * as BF from '${BROWSER_FABRIC_TS}'
export * as IC from '${ICE_CONFIG_TS}'
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
`

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/browser-fabric-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  console.log('· bundling browserFabric.ts + iceConfig.ts + shared tree (trystero external) …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(entry, ENTRY)
  const outfile = resolve(outdir, 'bundle.mjs')
  await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    mainFields: ['module', 'main'], conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    // The injected fake room means createBrowserFabric never calls joinRoom, so
    // trystero is never loaded at runtime. Keep it external (no browser bundling).
    external: ['trystero'],
    absWorkingDir: ROOT, logLevel: 'warning',
  })
  const { BF, IC, A, W } = await import(pathToFileURL(outfile).href)
  const NOW = 1_700_000_000_000

  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  const presenceOf = (root, device, ts = NOW) =>
    W.signPresence(
      { v: 1, root: root.pubB, key: device.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: W.PARAMS_A2_DIGEST, ts, uptimePct: 99 },
      device.priv,
    )

  // ==========================================================================
  console.log('\n· iceConfig: C-11 replaceable STUN/TURN (step 1) …')
  // ==========================================================================
  const original = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:standard.relay.metered.ca:80', 'turn:standard.relay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
  ]
  ok(deepEq(IC.resolveIceServers(), original), 'resolveIceServers() with no override is byte-identical to the former inline ICE_SERVERS (rtcTransport unchanged)')
  ok(deepEq([...IC.DEFAULT_ICE_SERVERS], original), 'DEFAULT_ICE_SERVERS matches the former inline set exactly')
  const fresh = IC.resolveIceServers()
  fresh[0].urls.push('stun:mutated')
  ok(!deepEq(IC.resolveIceServers(), fresh), 'resolveIceServers() returns a fresh deep copy each call (caller mutation cannot poison the source)')
  const overridden = IC.resolveIceServers({ override: [{ urls: 'stun:my.stun:3478' }] })
  ok(overridden.length === 1 && overridden[0].urls === 'stun:my.stun:3478', 'an explicit override REPLACES the base set (C-11 programmatic replacement)')
  const withFallback = IC.resolveIceServers({ operatorFallback: [{ urls: 'turn:operator.example:3478', username: 'op', credential: 'op' }] })
  ok(withFallback.length === original.length + 1 && withFallback[withFallback.length - 1].urls === 'turn:operator.example:3478', 'the operator-fallback slot is appended as relay-of-last-resort (after the base set)')

  // ==========================================================================
  console.log('\n· a fake trystero network (frame/dispatch, no relay) …')
  // ==========================================================================
  // Each fake room carries a peerId, its message/request handlers, and a `left`
  // flag. Sends/requests JSON round-trip the payload to simulate the wire frame.
  function makeFakeNetwork() {
    const rooms = new Map()
    let ctr = 0
    const wire = (x) => JSON.parse(JSON.stringify(x))
    function makeRoom() {
      const peerId = 'peer-' + ctr++
      const state = { peerId, onMessage: null, onRequest: null, left: false }
      const room = {
        makeAction(_ns, config) {
          if (config && config.kind === 'request') {
            state.onRequest = config.onRequest ?? null
            return {
              async request(data, opts) {
                const t = rooms.get(opts.target)
                if (!t || t.left || !t.onRequest) throw new Error('fake: no target ' + opts.target)
                return wire(await t.onRequest(wire(data), { peerId }))
              },
            }
          }
          state.onMessage = config && config.onMessage ? config.onMessage : null
          return {
            send(data, opts) {
              const target = opts && opts.target
              for (const [pid, r] of rooms) {
                if (pid === peerId || r.left || !r.onMessage) continue
                if (target && pid !== target) continue
                r.onMessage(wire(data), { peerId })
              }
              return Promise.resolve()
            },
          }
        },
        async leave() { state.left = true; rooms.delete(peerId) },
      }
      rooms.set(peerId, state)
      return { room, state }
    }
    return { makeRoom }
  }

  const net = makeFakeNetwork()
  const aRoot = kp(10), aDev = kp(11)
  const bRoot = kp(20), bDev = kp(21)
  const nodeA = W.nodeIdOf(aRoot.pub)
  const nodeB = W.nodeIdOf(bRoot.pub)
  const roomA = net.makeRoom()
  const roomB = net.makeRoom()
  const A_ = BF.createBrowserFabric({ nodeId: nodeA, room: roomA.room })
  const B_ = BF.createBrowserFabric({ nodeId: nodeB, room: roomB.room, staleAfterMs: 123_456 })

  eq(A_.nodeId, nodeA, 'the fabric reports its own nodeId')
  eq(B_.directory().staleAfterMs, 123_456, 'directory() advertises the configured staleAfterMs')
  ok(BF.createBrowserFabric({ nodeId: nodeA, room: net.makeRoom().room }).directory().staleAfterMs === W.PARAMS_A2.leaseTtlMs * 4, 'the default staleAfterMs is PARAMS_A2.leaseTtlMs * 4 (matches the operator peer)')

  // ==========================================================================
  console.log('\n· announce populates directory() locally + across peers …')
  // ==========================================================================
  const spA = presenceOf(aRoot, aDev)
  A_.announce(spA)
  ok(A_.directory().nodes.has(nodeA), 'announce records own presence in the local directory (self is trusted)')
  ok(B_.directory().nodes.has(nodeA), 'the announced presence gossips to a peer, whose directory ingests it')
  ok(deepEq(B_.directory().nodes.get(nodeA), spA), 'the ingested SignedPresence survives the wire frame byte-for-byte')

  // a newest-wins update replaces the older record
  const spAnew = presenceOf(aRoot, aDev, NOW + 5_000)
  A_.announce(spAnew)
  eq(B_.directory().nodes.get(nodeA).body.ts, NOW + 5_000, 'a newer presence supersedes the older one (newest-per-node wins)')

  // a bad-signature presence never enters a peer's directory
  const forged = { body: { ...spA.body, uptimePct: 1 }, sig: spA.sig } // sig no longer matches body
  const cRoom = net.makeRoom()
  const C_ = BF.createBrowserFabric({ nodeId: W.nodeIdOf(kp(30).pub), room: cRoom.room })
  // drive the forged record straight into C's presence action as if gossiped
  cRoom.state.onMessage(JSON.parse(JSON.stringify(forged)), { peerId: 'peer-x' })
  ok(!C_.directory().nodes.has(W.nodeIdOf(aRoot.pub)) || C_.directory().nodes.size === 0, 'a bad-signature presence is dropped by verifyPresence (never enters the directory)')

  // ==========================================================================
  console.log('\n· request round-trips a framed CanonicalObject to a handler …')
  // ==========================================================================
  // B must know A's peerId (from A's presence) to route; A must know B's (to
  // attribute the caller). Announce both.
  B_.announce(presenceOf(bRoot, bDev))
  let seenFrom = null
  let seenPayload = null
  const sent = { hi: 'there', n: 7 }
  A_.onRequest('head', async (from, payload) => {
    seenFrom = from
    seenPayload = payload
    return { echo: payload.n, ok: true }
  })
  const res = await B_.request(nodeA, 'head', sent)
  ok(deepEq(res, { echo: 7, ok: true }), 'request() returns the handler response across the frame')
  eq(seenFrom, nodeB, "the handler attributes the caller by nodeId (reverse peerId map)")
  ok(seenPayload && seenPayload !== sent && deepEq(seenPayload, sent), 'the handler receives a FRAMED copy of the payload (crossed the wire, not the same reference)')

  // ==========================================================================
  console.log('\n· unknown kind → { error }; unknown node → throws …')
  // ==========================================================================
  const unknown = await B_.request(nodeA, 'lease-grant', { root: aRoot.pubB })
  ok(unknown && typeof unknown.error === 'string' && unknown.error.includes('lease-grant'), 'an unregistered FabricRequestKind returns { error } (the peer never throws)')
  let threw = false
  try { await B_.request(W.nodeIdOf(kp(99).pub), 'head', {}) } catch { threw = true }
  ok(threw, 'a request to a node with no learned peer throws (no silent dead route)')

  // ==========================================================================
  console.log('\n· close() leaves the room …')
  // ==========================================================================
  await A_.close()
  ok(roomA.state.left, 'close() calls room.leave()')
}

main().catch((e) => { console.error(e); process.exit(1) })
