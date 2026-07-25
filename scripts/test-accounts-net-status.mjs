// A6-M4 (Lane L-ui) SUITE: the LIVE account-network status bridge that the hub
// UI reads (net/accountNetStatus.summarizeNetStatus), headless over MockFabric.
//
//   node scripts/test-accounts-net-status.mjs
//
// The hub's un-fixtured overlay surfaces (OverviewSection presence pill,
// SecurityTab PIN-committee readiness, GameChromeShowcase rated boundary,
// AccountView tab-strip pill) all derive from ONE pure read over the live
// AccountPeer's presence directory. This proves that read is honest:
//   1. no peer            ⇒ OFFLINE_STATUS (offline, all zero);
//   2. lone peer          ⇒ connecting (peer up, nobody else reachable);
//   3. peers announced     ⇒ online, peers/witness/committee counts exact,
//                            self excluded, ratedAvailable follows the §4 rule;
//   4. a committee-only peer (witness:false) is counted for committee, NOT for
//      witnesses (the caps distinction the PIN panel vs the rated boundary need);
//   5. stale presence (past the directory horizon) drops back to connecting.
//      A peer that went dark is offline, never a frozen count.
//
// peerService is fabric-agnostic, so the same summarizer that runs over Lane A's
// browser fabric in production runs here over an in-process MockFabric bus.
// React is stubbed (the pure summarizer never touches the hook).
//
// House style: esbuild-bundle on the fly (alias @shared + a react stub; net
// modules by abs path), one-line asserts, exit(1) on any fail.

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const NET = resolve(ROOT, 'src/renderer/src/features/account/net').replace(/\\/g, '/')

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as P from '${NET}/peerService'
export * as NS from '${NET}/accountNetStatus'
`

// accountNetStatus imports useSyncExternalStore from 'react' only for the hook;
// the pure summarizer under test never calls it, so a bare stub keeps react out
// of the node bundle entirely.
const REACT_STUB = `export function useSyncExternalStore(){ throw new Error('react stub: not used headless') }
export default {}
`

async function bundleAndImport(outdir) {
  const reactStub = resolve(outdir, 'react-stub.mjs')
  writeFileSync(reactStub, REACT_STUB)
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(entry, ENTRY)
  const outfile = resolve(outdir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared'), react: reactStub },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  return import(pathToFileURL(outfile).href)
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache', 'accounts-net-status-test')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(await bundleAndImport(outdir))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W, P, NS } = M
  const NOW = 1_750_000_000_000

  const kpOf = (tag) => {
    const priv = A.sha256(A.utf8(tag))
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  const makeIdentity = (tag) => {
    const rootKp = kpOf('nstatus-root-' + tag)
    const devKp = kpOf('nstatus-dev-' + tag)
    const nodeId = W.nodeIdOf(rootKp.pubB)
    return { tag, nodeId, identity: { root: rootKp.pubB, key: devKp.pubB, priv: devKp.priv } }
  }
  const startPeer = async (bus, spec, caps) =>
    P.startAccountPeer({
      identity: spec.identity,
      fabric: bus.endpoint(spec.nodeId),
      now: () => NOW,
      platform: 'desktop-browser',
      autoBootstrap: false,
      ...(caps ? { caps } : {}),
    })

  // ==========================================================================
  console.log('\n· 1. no peer ⇒ honest OFFLINE_STATUS …')
  // ==========================================================================
  const off = NS.summarizeNetStatus(null)
  ok(off === NS.OFFLINE_STATUS, 'summarizeNetStatus(null) returns the shared OFFLINE_STATUS constant (stable ref for useSyncExternalStore)')
  eq(off.peerLive, false, 'offline: peerLive false')
  eq(off.presence, 'offline', "offline: presence 'offline'")
  eq(off.nodeId, null, 'offline: nodeId null')
  ok(off.peersReachable === 0 && off.witnessesReachable === 0 && off.committeeReachable === 0, 'offline: all reachability counts zero')
  eq(off.ratedAvailable, false, 'offline: ratedAvailable false')

  // ==========================================================================
  console.log('\n· 2. lone peer ⇒ connecting (up, nobody else reachable) …')
  // ==========================================================================
  const bus = new W.MockFabric()
  const specA = makeIdentity('A')
  const peerA = await startPeer(bus, specA)
  const lone = NS.summarizeNetStatus(peerA, NOW)
  eq(lone.peerLive, true, 'lone: peerLive true')
  eq(lone.nodeId, W.nodeIdOf(specA.identity.root), 'lone: nodeId === sha256(root) (nodeIdOf)')
  eq(lone.presence, 'connecting', "lone: presence 'connecting' (self is excluded, no other node yet)")
  eq(lone.peersReachable, 0, 'lone: peersReachable 0 (self never counts)')
  eq(lone.witnessesReachable, 0, 'lone: witnessesReachable 0')
  eq(lone.ratedAvailable, false, 'lone: ratedAvailable false. Rated play honestly waits')

  // ==========================================================================
  console.log('\n· 3. peers announced ⇒ online with exact counts …')
  // ==========================================================================
  const specB = makeIdentity('B')
  const specC = makeIdentity('C')
  const peerB = await startPeer(bus, specB) // witness+committee (desktop-browser default)
  const peerC = await startPeer(bus, specC)
  const three = NS.summarizeNetStatus(peerA, NOW)
  eq(three.presence, 'online', "online: presence 'online' once ≥1 other node is reachable")
  eq(three.peersReachable, 2, 'online: peersReachable 2 (B, C; self excluded)')
  eq(three.witnessesReachable, 2, 'online: witnessesReachable 2 (both advertise the witness cap)')
  eq(three.committeeReachable, 2, 'online: committeeReachable 2 (both advertise the committee cap)')
  eq(three.ratedAvailable, true, 'online: ratedAvailable true. A third machine can witness (§4)')
  // Every observer on the bus reaches the same view (self is theirs, not counted).
  eq(NS.summarizeNetStatus(peerB, NOW).peersReachable, 2, 'symmetry: peer B also sees 2 others (A, C)')

  // ==========================================================================
  console.log('\n· 4. committee-only peer ⇒ committee counts it, witnesses do not …')
  // ==========================================================================
  const specD = makeIdentity('D')
  const peerD = await startPeer(bus, specD, { witness: false, committee: true })
  eq(peerD.caps.witness, false, 'peer D advertises witness:false (caps override)')
  const four = NS.summarizeNetStatus(peerA, NOW)
  eq(four.peersReachable, 3, 'with D: peersReachable 3 (B, C, D)')
  eq(four.witnessesReachable, 2, 'with D: witnessesReachable STILL 2. A committee-only node is not an eligible witness (§4 boundary)')
  eq(four.committeeReachable, 3, 'with D: committeeReachable 3. The PIN committee counts D')
  eq(four.ratedAvailable, true, 'with D: ratedAvailable still true (B, C witness-capable)')

  // ==========================================================================
  console.log('\n· 5. stale presence ⇒ drops to connecting (a dark peer is offline) …')
  // ==========================================================================
  // The in-process MockFabric double never expires presence (its directory
  // advertises a MAX_SAFE_INTEGER horizon: deterministic suites don't model
  // wall time). The PRODUCTION browser fabric advertises a finite horizon, so
  // the staleness branch is exercised here against a controlled directory:
  // summarizeNetStatus is pure and honors whatever staleAfterMs it is handed.
  ok(peerA.fabric.directory().staleAfterMs > 1e15, 'MockFabric double advertises a never-expire horizon (so §5 uses a controlled directory)')
  const STALE = 60_000
  const presence = (root, ts, witness = true, committee = true) => ({
    body: { root, ts, caps: { witness, committee, shardMb: 50 } },
  })
  const fakePeer = (entries) => ({
    root: 'SELF',
    nodeId: 'self-node',
    fabric: { directory: () => ({ nodes: new Map(entries), staleAfterMs: STALE }) },
  })
  // SELF (excluded), X fresh, Y aged 30s (fresh at NOW), committee-only Z.
  const peerF = fakePeer([
    ['self', presence('SELF', NOW)],
    ['x', presence('X', NOW)],
    ['y', presence('Y', NOW - 30_000)],
    ['z', presence('Z', NOW, false, true)],
  ])
  const fresh = NS.summarizeNetStatus(peerF, NOW)
  eq(fresh.peersReachable, 3, 'controlled: peersReachable 3 (X, Y, Z, SELF excluded by root)')
  eq(fresh.witnessesReachable, 2, 'controlled: witnessesReachable 2 (Z is committee-only)')
  eq(fresh.committeeReachable, 3, 'controlled: committeeReachable 3')
  // At exactly the horizon a node is still fresh (boundary is strict >).
  eq(NS.summarizeNetStatus(peerF, NOW + STALE).peersReachable, 2, 'at exactly the horizon: Y (age 90s) stale, X & Z (age 60s) still fresh, strict > boundary')
  // One tick past the horizon for the freshest nodes ⇒ everyone dark ⇒ connecting.
  const dark = NS.summarizeNetStatus(peerF, NOW + STALE + 1)
  eq(dark.peersReachable, 0, 'past the horizon: peersReachable 0 (every presence went stale)')
  eq(dark.presence, 'connecting', "past the horizon: presence back to 'connecting' (peer up, nobody fresh)")
  eq(dark.ratedAvailable, false, 'past the horizon: ratedAvailable false. A dark peer never counts')

  await Promise.all([peerA.stop(), peerB.stop(), peerC.stop(), peerD.stop()])
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
