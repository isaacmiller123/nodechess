// Operator-peer smoke (spec §11 / §4 C-10): construct the always-awake operator
// peer against a MockFabric (NOT real relays — CI stays offline/deterministic)
// and prove it serves lease grants + PIN evaluations as an ordinary eligible
// node, plus that its judge integration content-hash-verifies + constructs the
// pinned canonical WASM at startup AS the canonical §8 JudgeEngine surface:
// a judgeGame run through the peer-held handle must reproduce a fresh canonical
// re-run's judgeOutputDigest bit-for-bit (A5-32 regression — the raw A2
// analyseFixedNodes protocol, per-position TT clear + divergent parse, must
// never be the peer's judge capability). A5-24 regression: the peer's judge
// path is exercised END-TO-END here — driven over a MULTI-position fixture
// (TT-granularity-sensitive), bit-cross-checked against the canonical surface,
// config-echo-bound to PARAMS_A5_DIGEST, and judgeGame is asserted to
// fail-close on per-position TT reset BEFORE any engine I/O. CI-safe by
// construction: MockFabric (no relays), and the esbuild + pinned-WASM
// footprint already runs in the CI wall via test-judge-node.
//
//   node scripts/operator-smoke.mjs
//
// Bundles server/operator/peer.ts (trystero + werift marked external — the
// TrysteroFabric path is never entered here) alongside the shared witness tree,
// then drives the peer through the fabric from a client endpoint.

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { JUDGE_PARITY_POSITIONS } from './lib/accounts-fixture.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const PEER_TS = resolve(ROOT, 'server/operator/peer.ts').replace(/\\/g, '/')
const ADAPTER_TS = resolve(ROOT, 'server/judge/nodeAdapter.ts').replace(/\\/g, '/')
const ENGINE_JS = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.js')
const ENGINE_WASM = resolve(ROOT, 'node_modules/stockfish/bin/stockfish-18-lite-single.wasm')

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const ENTRY = `
export * as peer from '${PEER_TS}'
export * as adapter from '${ADAPTER_TS}'
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as J from '@shared/accounts/judge'
`

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/operator-smoke')
  mkdirSync(cacheRoot, { recursive: true })
  const outdir = mkdtempSync(resolve(cacheRoot, 'run-'))
  try {
    await run(outdir)
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED — ` : 'ALL GREEN — '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(outdir) {
  console.log('· bundling server/operator/peer.ts + shared witness tree …')
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(entry, ENTRY)
  const outfile = resolve(outdir, 'bundle.mjs')
  await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    mainFields: ['module', 'main'], conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    // The trystero/werift path is only reached by createTrysteroFabric, which
    // this smoke never calls — keep them external so no browser-WebRTC bundling.
    external: ['trystero', 'werift'],
    absWorkingDir: ROOT, logLevel: 'warning',
  })
  const { peer, adapter, A, W, J } = await import(pathToFileURL(outfile).href)
  const { PARAMS_A2, PARAMS_A2_DIGEST } = W
  const NOW = 1_700_000_000_000

  const kp = (b) => {
    const priv = Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  function seededRng(tag) {
    let ctr = 0
    const seed = A.utf8(tag)
    return (n) => {
      const out = new Uint8Array(n)
      let off = 0
      while (off < n) {
        const blk = A.sha256(A.concatBytes(seed, A.utf8(String(ctr++))))
        const take = Math.min(blk.length, n - off)
        out.set(blk.subarray(0, take), off); off += take
      }
      return out
    }
  }

  const fabric = new W.MockFabric()

  // --- the operator peer: an ordinary eligible node, always awake ------------
  const opRoot = kp(500)
  const opDevice = kp(510)
  const opNodeId = W.nodeIdOf(opRoot.pub)
  const identity = { rootPub: opRoot.pubB, nodeId: opNodeId, deviceKey: opDevice.pubB, devicePriv: opDevice.priv }
  const opEndpoint = fabric.endpoint(opNodeId)

  console.log('\n· starting the operator peer (MockFabric, judge content-hash-verified) …')
  const op = await peer.startOperatorPeer({
    appId: 'nodechess-accounts',
    dataDir: outdir,
    identity,
    fabric: opEndpoint,
    wts: () => NOW,
    judge: { enabled: true, enginePath: ENGINE_JS, wasmPath: ENGINE_WASM },
  })
  ok(!!op, 'startOperatorPeer resolved')
  eq(op.nodeId, opNodeId, 'the peer reports its nodeId')
  ok(!!op.judge, 'the pinned canonical judge WASM content-hash-verified and constructed at startup')
  // the peer announced witness-capable presence into the fabric
  const dir = opEndpoint.directory()
  ok(dir.nodes.has(opNodeId), 'the peer announced its presence into the fabric')

  // --- integration (b): the judge capability IS the canonical §8 surface -----
  // A5-32 regression: the peer must hold the shared JudgeEngine adapter (driven
  // ONLY via judgeGame), never the raw A2 JudgeInstance, whose analyseFixedNodes
  // protocol (per-position TT clear, divergent parser, no fail-closed checks)
  // is a different bit surface from the canonical judgeGame path.
  console.log('\n· the peer-held judge is the canonical JudgeEngine, bit-equal to a canonical re-run …')
  ok(typeof op.judge.send === 'function' && typeof op.judge.onLine === 'function', 'the judge exposes the JudgeEngine send/onLine surface')
  ok(typeof op.judge.onError === 'function' && typeof op.judge.close === 'function', 'the judge exposes the JudgeEngine onError/close surface (not quit/onExit)')
  ok(op.judge.analyseFixedNodes === undefined && op.judge.quit === undefined, 'the non-canonical A2 analyseFixedNodes/quit surface is NOT reachable from the peer handle')
  // Cross-check the surfaces: judge the MULTI-position parity fixture through
  // the peer-held handle via canonical judgeGame, then re-run it on a FRESH
  // canonical newNodeJudgeEngine — the judgeOutputDigest must match bit-for-bit
  // (the TT evolves across positions within a judged game, so any
  // per-position-reset or parse fork splits position i>0's bits). SMOKE-ONLY
  // node trim for wall-time: `nodes` ONLY may differ from PARAMS_A5
  // (multiPv/hashMb/ttReset stay pinned via judgeConfigForTier(2)).
  const SMOKE_T2 = { ...J.judgeConfigForTier(2), nodes: 20000 }
  // A5-24: the digest parity below has teeth ONLY over a multi-position game —
  // with a single position, per-game and per-position TT reset coincide and
  // the cross-check would be vacuously green against the A5-32 fork.
  ok(JUDGE_PARITY_POSITIONS.length >= 2, `the parity fixture is multi-position (${JUDGE_PARITY_POSITIONS.length} positions) — digest parity is TT-granularity-sensitive`)
  const viaPeer = await J.judgeGame(op.judge, JUDGE_PARITY_POSITIONS, SMOKE_T2)
  const freshCanonical = await adapter.newNodeJudgeEngine({ enginePath: ENGINE_JS, wasmPath: ENGINE_WASM })
  const viaCanonical = await J.judgeGame(freshCanonical, JUDGE_PARITY_POSITIONS, SMOKE_T2)
  await freshCanonical.close()
  eq(viaPeer.positions.length, JUDGE_PARITY_POSITIONS.length, `judgeGame drove all ${JUDGE_PARITY_POSITIONS.length} parity positions through the peer-held judge`)
  eq(viaPeer.positions[2].lines[0].mate, 1, 'mate-in-1 parity position judged {mate: 1} at rank 1 through the peer-held judge')
  eq(J.judgeOutputDigest(viaPeer), J.judgeOutputDigest(viaCanonical), 'the peer-held judge reproduces a canonical re-run judgeOutputDigest bit-for-bit (Tier-2 config, warm per-game TT)')
  // A5-24: a receipt computed through the peer handle names the CURRENT rule
  // set — the config echo folds PARAMS_A5_DIGEST into every JudgeOutput, so
  // canonical verifiers can bind the peer's bits to the params they check.
  eq(viaPeer.config.params, J.PARAMS_A5_DIGEST, 'the peer-run JudgeOutput config echo is stamped with the current PARAMS_A5_DIGEST')
  // A5-24: the canonical surface FAIL-CLOSES on the A2 harness's TT
  // granularity BEFORE any engine I/O — judgeGame can never be driven
  // per-position, so the analyseFixedNodes bit surface is structurally
  // excluded from §8 verdicts (not merely untested). If the canonical adapter
  // ever collapsed into the per-position protocol, test-judge-node's frozen
  // judgeGame digests catch it; here the stub throws on ANY engine contact,
  // pinning the validate-before-I/O ordering (fail-closed, no partial output).
  const untouchable = {
    send: () => { throw new Error('engine I/O reached before config validation') },
    onLine: () => () => {},
    close: async () => {},
  }
  const perPosErr = await J.judgeGame(untouchable, JUDGE_PARITY_POSITIONS, { ...SMOKE_T2, ttReset: 'per-position' }).then(() => null, (e) => e)
  ok(
    perPosErr !== null && perPosErr.name === 'JudgeConfigError',
    perPosErr !== null && perPosErr.name === 'JudgeConfigError'
      ? "judgeGame fail-closes on ttReset:'per-position' (JudgeConfigError, before any engine I/O)"
      : `judgeGame must fail-close on ttReset:'per-position' with JudgeConfigError before engine I/O (got ${perPosErr ? `${perPosErr.name}: ${perPosErr.message}` : 'resolved output'})`,
  )

  // --- integration (a-ish): the peer SERVES a lease grant --------------------
  console.log('\n· client requests a lease grant from the operator …')
  const subject = kp(600) // a lone client account
  const clientDev = kp(610)
  const clientEp = fabric.endpoint(W.nodeIdOf(subject.pub))
  const leaseBody = W.buildLeaseBody({ root: subject.pubB, epoch: 1, device: clientDev.pubB, grantedWts: NOW, ttlMs: PARAMS_A2.leaseTtlMs, params: PARAMS_A2_DIGEST })
  const grantRes = await clientEp.request(opNodeId, 'lease-grant', { leaseBody })
  ok(grantRes.grant, 'the operator returned a lease grant')
  ok(grantRes.grant && W.verifyGrantSig(grantRes.grant, W.leaseBodyHash(leaseBody)), 'the operator grant signature verifies over the lease body')
  eq(grantRes.grant && grantRes.grant.w, opNodeId, 'the grant is attributed to the operator nodeId')

  // --- integration: the peer SERVES a PIN evaluation -------------------------
  console.log('\n· client runs a committee PIN eval served by the operator …')
  const rng = seededRng('operator-smoke-pin')
  const pin = '2468'
  // single-member committee: the operator holds the whole OPRF key as its share.
  const k = W.randScalar(rng)
  const output = W.singleKeyOutput(pin, k, rng)
  const pinPub = A.toB64u(W.pinKeyFromOutput(output).pub)
  const commit = A.toB64u(W.pointToBytes(W.shareCommitment(k)))
  // degenerate 1-member committee (smoke only, no fuse-trip) — placeholder record id.
  const smokeRecId = A.toB64u(A.sha256(A.utf8('operator-smoke-pin-record')))
  op.member.provision(subject.pubB, 1, k, commit, pinPub, smokeRecId)
  const committee = { members: [opNodeId], t: 1, shareCommitments: [commit], pinPub }
  const pv = await W.pinVerifyFlow({ fabric: clientEp, root: subject.pubB, pin, committee, wts: NOW, rng: seededRng('operator-smoke-eval'), checkDleq: true })
  ok(pv.ok, 'the operator served the blind evaluation and the client derived the pinKey (DLEQ-verified)')
  eq(pv.ok && pv.pinPub, pinPub, 'the derived pinPub matches the committee pinPub')
  // the operator's counter registered the served evaluation (C-2)
  ok(op.member.counter(subject.pubB).evaluations >= 1, 'the operator counted the served evaluation')

  // --- removable, holds zero authority ---------------------------------------
  await op.stop()
  ok(true, 'the operator peer stops cleanly (removable — its loss costs only availability)')
}

main().catch((e) => { console.error(e); process.exit(1) })
