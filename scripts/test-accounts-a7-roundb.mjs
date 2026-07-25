// A7 ROUND B SUITE: witness salt-grant SIGNING-TIME DISCIPLINE (A5-17 close,
// witness side) + the A5-18 CANONICAL-REVEAL publication slot.
//
//   node scripts/test-accounts-a7-roundb.mjs
//
// Proves:
//   1. witnessServe 'salt-grant': anchor required; no chain view ⇒ refuse
//      (fail closed); rated ordinal < w·K−1 ⇒ 'window-open'; at/after the
//      window-closing game ⇒ a grant SIGNED WITH THE WITNESS'S OWN CLOCK that
//      verifies over the anchored salt body; clientRequestSaltGrant round-trip.
//   2. Reveal slot: T_lease anchored grants assemble a SaltReveal the gate
//      accepts (key-bound, windowSalt-verified); anchorless / foreign-key /
//      tampered reveals refused; merge picks ONE canonical reveal (lex-least
//      canonical hash) in EVERY arrival order; publish → fetch round-trips.
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on fail.
// Test identities are RAW fixed 32-byte seeds → ed25519 (never argon2).

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = resolve(ROOT, 'src/shared/accounts').replace(/\\/g, '/')

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

async function bundle(outdir) {
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export * as codec from '${SRC}/codec.ts'`,
      `export * as hash from '${SRC}/hash.ts'`,
      `export * as proto from '${SRC}/witness/protocol.ts'`,
      `export * as lease from '${SRC}/witness/lease.ts'`,
      `export * as dist from '${SRC}/witness/distance.ts'`,
      `export * as wparams from '${SRC}/witness/params.ts'`,
      `export * as tier2 from '${SRC}/judge/tier2.ts'`,
      `export * as jparams from '${SRC}/judge/params.ts'`,
      `export * as jtrans from '${SRC}/judge/transport.ts'`,
    ].join('\n'),
  )
  const outfile = resolve(outdir, 'entry.mjs')
  await build({
    entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node',
    mainFields: ['module', 'main'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
  })
  return import(new URL(`file://${outfile}`).href)
}

async function run(outdir) {
  const M = await bundle(outdir)
  const { hash, codec, proto, lease, dist, wparams, tier2, jparams, jtrans } = M
  const K = jparams.PARAMS_A5.reganK
  const T = wparams.PARAMS_A2.tLease

  const kp = (name) => {
    const seed = new Uint8Array(32)
    const bytes = new TextEncoder().encode(name)
    seed.set(bytes.slice(0, 32))
    const pub = hash.ed25519.getPublicKey(seed)
    return { priv: seed, pub, pubB: hash.toB64u(pub) }
  }
  const ROOT_S = kp('a7rb-subject').pubB
  const LAD = 'chess:Blitz'
  const ANCHOR = hash.toB64u(codec.canonicalHash({ a7: 'anchor', w: 0 }))

  const mkFabric = () => {
    const handlers = new Map()
    return {
      onRequest: (kind, fn) => handlers.set(kind, fn),
      request: async (_to, kind, payload) => {
        const fn = handlers.get(kind)
        if (!fn) throw new Error(`no handler: ${kind}`)
        return fn('caller-node', payload)
      },
      close: async () => {},
    }
  }
  const mkWitness = (name, ratedOrdinalOf) => {
    const w = kp(name)
    const fabric = mkFabric()
    const store = { get: async () => undefined, put: async () => {} }
    proto.witnessServe(fabric, { nodeId: dist.nodeIdOf(w.pubB), key: w.pubB, priv: w.priv }, {
      store, wts: () => 777_000, timeWindowMs: 60_000,
      ...(ratedOrdinalOf !== undefined ? { ratedOrdinalOf } : {}),
    })
    return { w, fabric, nodeId: dist.nodeIdOf(w.pubB) }
  }

  // ==========================================================================
  console.log('\n· 1. salt-grant signing-time discipline (A5-17, witness side) …')
  // ==========================================================================
  {
    const closed = mkWitness('a7rb-w-closed', () => K - 1) // window 0 closing game on-chain
    const open = mkWitness('a7rb-w-open', () => K - 2) // one short of the close
    const blind = mkWitness('a7rb-w-blind') // no chain view wired

    const r1 = await proto.clientRequestSaltGrant(open.fabric, open.nodeId, ROOT_S, LAD, 0, ANCHOR)
    eq(r1.error, 'window-open', 'ordinal w·K−2 ⇒ the witness REFUSES to pre-sign (window-open)')
    const r2 = await proto.clientRequestSaltGrant(blind.fabric, blind.nodeId, ROOT_S, LAD, 0, ANCHOR)
    eq(r2.error, 'no-chain-view', 'no ratedOrdinalOf wired ⇒ the witness refuses ALL salt grants (fail closed)')
    const r3 = await proto.clientRequestSaltGrant(closed.fabric, closed.nodeId, ROOT_S, LAD, 0, undefined)
    eq(r3.error, 'anchor-required', 'an anchorless request is refused: nothing valid exists to pre-sign')
    const r4 = await proto.clientRequestSaltGrant(closed.fabric, closed.nodeId, ROOT_S, LAD, 0, ANCHOR)
    ok(r4.grant !== undefined, 'at ordinal w·K−1 the witness signs the anchored grant')
    eq(r4.grant.wts, 777_000, "the grant's wts is the WITNESS's own clock at signing (never the requester's claim)")
    const bodyHash = tier2.saltBodyHash(ROOT_S, LAD, 0, ANCHOR)
    ok(lease.verifyGrantSig(r4.grant, bodyHash), 'the served grant verifies over the ANCHORED salt body (grantBytes convention)')
    ok(!lease.verifyGrantSig(r4.grant, tier2.saltBodyHash(ROOT_S, LAD, 0)), 'the same grant does NOT verify over the anchorless body (anchor is folded in)')
    const r5 = await proto.clientRequestSaltGrant(closed.fabric, closed.nodeId, ROOT_S, LAD, 1, ANCHOR)
    eq(r5.error, 'window-open', 'window 1 needs ordinal 2K−1: the same view refuses the NEXT window (per-window discipline)')
  }

  // ==========================================================================
  console.log('\n· 2. the canonical-reveal publication slot (A5-18) …')
  // ==========================================================================
  {
    const witnesses = Array.from({ length: T }, (_, i) => kp(`a7rb-grantor-${i}`))
    const grantsFor = (anchor) =>
      witnesses.map((w) =>
        tier2.signSaltGrant(ROOT_S, LAD, 0, dist.nodeIdOf(w.pubB), w.pubB, w.priv, 900_000 + 1, anchor),
      )
    const reveal = { v: 1, scheme: jparams.PARAMS_A5.saltScheme, root: ROOT_S, ladder: LAD, window: 0, anchor: ANCHOR, grants: grantsFor(ANCHOR) }
    const key = jtrans.saltRevealKey(ROOT_S, LAD, 0)
    const gate = jtrans.makeSaltRevealGate()

    ok(gate.validator('n1', key, 'record', reveal), 'a T_lease anchored reveal passes the slot gate (windowSalt re-verifies every grant)')
    ok(!gate.validator('n1', key, 'record', { ...reveal, anchor: undefined, grants: grantsFor(undefined) }),
      'an ANCHORLESS reveal is refused at the gate (consensus-path duty)')
    ok(!gate.validator('n1', jtrans.saltRevealKey(ROOT_S, LAD, 1), 'record', reveal), 'a reveal offered under a foreign slot key is refused (key binding)')
    ok(!gate.validator('n1', key, 'record', { ...reveal, grants: [{ ...reveal.grants[0], sig: reveal.grants[0].sig.slice(0, -2) + 'AA' }, ...reveal.grants.slice(1)] }),
      'a tampered grant signature sinks the reveal (threshold re-verified at the gate)')

    // canonical pick: a second VALID reveal (different grantor wts ⇒ different
    // bytes): merge keeps the lex-least canonical hash in EVERY order.
    const reveal2 = { ...reveal, grants: witnesses.map((w) => tier2.signSaltGrant(ROOT_S, LAD, 0, dist.nodeIdOf(w.pubB), w.pubB, w.priv, 900_777, ANCHOR)) }
    ok(gate.validator('n1', key, 'record', reveal2), 'fixture: the competing reveal is also valid')
    const h = (r) => hash.toB64u(codec.canonicalHash(r))
    const canonical = [reveal, reveal2].sort((a, b) => (h(a) < h(b) ? -1 : 1))[0]
    const mAB = gate.merge(gate.merge(null, reveal, 'record', key), reveal2, 'record', key)
    const mBA = gate.merge(gate.merge(null, reveal2, 'record', key), reveal, 'record', key)
    eq(h(mAB), h(canonical), 'merge keeps the lex-least valid reveal (arrival order A→B)')
    eq(h(mAB), h(mBA), 'merge is arrival-order independent (B→A folds to the same canonical reveal)')
    const mJunk = gate.merge(mAB, { v: 1, scheme: 'junk', grants: [] }, 'record', key)
    eq(h(mJunk), h(canonical), 'junk offered over the canonical reveal cannot displace it')

    // publish → fetch round-trip over a gate-installed stub node
    const mkNode = () => {
      let stored = null
      return {
        put: async (target, kind, value) => {
          if (!gate.validator('caller', target, kind, value)) return 0
          stored = gate.merge(stored, value, kind, target)
          return 1
        },
        get: async () => stored,
        getMerged: async () => stored,
      }
    }
    const node = mkNode()
    eq(await jtrans.publishSaltReveal(node, reveal2), 1, 'publishSaltReveal stores through the gate')
    await jtrans.publishSaltReveal(node, reveal)
    const fetched = await jtrans.fetchSaltReveal(node, ROOT_S, LAD, 0)
    eq(h(fetched), h(canonical), 'fetchSaltReveal returns THE canonical reveal after both publishes')
    eq(await jtrans.fetchSaltReveal(node, ROOT_S, LAD, 3), null, 'an empty slot fetches null (never a manufactured reveal)')
    // the canonical slot pick and direct windowSalt agree byte-for-byte
    eq(hash.toB64u(tier2.windowSalt(fetched, { requireAnchor: true })), hash.toB64u(tier2.windowSalt(canonical, { requireAnchor: true })),
      'windowSalt over the slot pick ≡ windowSalt over the canonical reveal (the salt VALUE is slot-independent)')
  }
}

async function main() {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache/accounts-a7rb-test')
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

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
