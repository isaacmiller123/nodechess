// THE A3 SHARD DUTY + REPAIR SUITE: storage brick 3 (spec §5 retention layer
// 3 / publish-on-write, §11 platform parity; module: src/shared/accounts/
// storage/shards.ts; params: docs/ACCOUNTS-PARAMS.md §Storage N=40/K=12).
//
//   node scripts/test-accounts-shards.mjs
//
// Proves the brick end to end, fabric-suite style:
//   0. static determinism guards (no ambient time/randomness/timers in the
//      module; PARAMS_A3 geometry; params digest golden);
//   1. shardKey: golden vectors (node/browser byte-parity anchors), per-idx
//      distinctness, out-of-range throws;
//   2. cutSnapshot + shardJob → verifyShardEnvelope ACCEPT (device-signed head
//      proven by embedded certs, and root-signed head with no certs) + the
//      REJECT matrix hitting every ShardVerdict variant;
//   3. dutyCarriers/isOnDuty: exact agreement with closestEligible; only
//      capacity-advertising, non-stale nodes carry duty; boundaries;
//   4. publish-on-write over a 24-node overlay harness: witnessed events
//      replicate at creation; finalSync leaves all N=40 rows in shard space at
//      the right keys; duty carriers hold their rows; the full chain
//      reconstructs from shard space alone (and from any 12 rows);
//   5. the store gate as an overlay STORE validator: forged/foreign/stale rows
//      rejected AT THE GATE network-wide; a keyless byte-flip of a public row
//      cannot evict the held verified row (poisoning); a fresher snapshot
//      replaces; downgrade replays and same-height forks store zero;
//   6. reconstructTolerant: any 12 of 40 reconstruct bit-identically
//      (adversarial subsets incl. all-parity); a corrupt row is excluded via
//      the end-to-end hash gate; below-K → honest null;
//   7. runRepair over a 20-node harness: healthy / not-on-duty / healed
//      (eviction=churn=healed end to end, counts + keys verified) /
//      unrecoverable (≥1 row and 0 rows), tick-driven only, deterministic;
//   8. browser parity: the full shard decision core bundled platform:'browser'
//      produces the identical digest and carries zero node built-ins.
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on any fail.

import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundleAndImport, makeOutdir, ROOT } from './lib/witness-bundle.mjs'
import { findNodeBuiltinRefs, readBundle } from './lib/accounts-fixture.mjs'

let passed = 0
let failures = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`) }
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function eq(a, b, msg) {
  ok(a === b, a === b ? msg : `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}
function throws(fn, msg) {
  try { fn(); ok(false, `${msg} (did not throw)`) } catch { ok(true, msg) }
}

// ---- goldens (recorded from a green run; byte-parity anchors) ---------------
// b64u(sha256(canonicalBytes(PARAMS_A3))), NOT frozen-at-genesis (C-3): a
// deliberate params revision updates this golden alongside the docs.
const GOLDEN_PARAMS_A3_DIGEST = 'ACxJEbqGQj7VOdWBvaLMiYuhfDHluYo0bZ0gbu_1yNE'
// shardKey(subject, idx) for subject = b64u(sha256(utf8('shard-golden-subject')))
// = 06oj7B_dESbNPoSGlp_Hva8tHlellLcMdhfSreqb4EU. Any change to the key-tag,
// hash, or byte layout breaks these on every platform at once.
const GOLDEN_SUBJECT = '06oj7B_dESbNPoSGlp_Hva8tHlellLcMdhfSreqb4EU'
const GOLDEN_SHARD_KEYS = {
  0: 'Z7HQrMSazpslw1pqJI4O7POsQWxlQ3y3P4nXyTBeSDE',
  1: 'SvVMO8YxL0adD-uqpRMjngMZgN6MXilKLoPpoRJqehk',
  12: 'XmQo-dBJH30az6mo3PqienHLBO_o1sehO-7nD3LenX4',
  39: 'YrDhGKoxpffvLmzqG0Nu_8GPqgwnN2n_37GXbMZwE40',
}

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as S from '@shared/accounts/storage'
`

// The full shard decision core: bundled twice (platform node vs browser),
// driven through one scripted build/verify/duty/reconstruct/merge sequence;
// the digests must match byte-for-byte (spec §11: browser is the design point).
const PARITY_ENTRY = `
import { canonicalHash } from '@shared/accounts/codec'
import { appendWitnessed, chainToBytes, createAccountChain } from '@shared/accounts/chain'
import { eventId } from '@shared/accounts/events'
import { ed25519, sha256, toB64u, utf8 } from '@shared/accounts/hash'
import { makeAttestation } from '@shared/accounts/witness/attest'
import { nodeIdOf } from '@shared/accounts/witness/distance'
import { signPresence } from '@shared/accounts/witness/presence'
import type { NodeDirectory } from '@shared/accounts/witness/types'
import { PARAMS_A3_DIGEST } from '@shared/accounts/storage/params'
import {
  cutSnapshot,
  dutyCarriers,
  reconstructTolerant,
  shardJob,
  shardKey,
  storageMerge,
  verifyShardEnvelope,
} from '@shared/accounts/storage/shards'

export function runShardScript(): string {
  const log: string[] = []
  const seed32 = (tag: string): Uint8Array => sha256(utf8('shp-' + tag))
  const kp = (tag: string) => {
    const priv = seed32(tag)
    const pub = ed25519.getPublicKey(priv)
    return { priv, pub, pubB: toB64u(pub) }
  }
  const flip = (s: string): string => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

  // shardKey golden vectors
  const subj = toB64u(sha256(utf8('shard-golden-subject')))
  for (const i of [0, 1, 12, 39]) log.push('key' + i + ':' + shardKey(subj, i))

  // fixed chain -> attested head -> snapshot (k=3, n=6)
  const root = kp('root')
  const dev = kp('dev')
  const w1 = kp('wit')
  let c = createAccountChain({
    rootPriv: root.priv, rootPub: root.pub, displayName: 'Parity Subject', ts: 1000,
    device: { pub: dev.pubB, index: 0 },
  })
  c = appendWitnessed(c, dev.priv, dev.pubB, 'revoke', { pub: subj }, 1100)
  const headPlain = c.events[c.events.length - 1]
  const head = { body: headPlain.body, sig: headPlain.sig, wit: [makeAttestation(eventId(headPlain.body), 1, w1.pubB, w1.priv, 1105)] }
  const chainA = { root: c.root, events: c.events.map((e) => (e === headPlain ? head : e)) }
  const certEv = c.events.find((e) => e.body.type === 'cert')!
  const header = cutSnapshot(chainA, head, [certEv], dev.priv, { k: 3, n: 6 })
  const envs = shardJob(header, chainToBytes(chainA))
  const V = { k: 3, n: 6 }
  log.push('hdr:' + toB64u(canonicalHash(header as never)))
  for (const e of envs) log.push('v' + e.shard.idx + ':' + verifyShardEnvelope(e, V))
  const t1 = clone(envs[0]); t1.header.headId = flip(t1.header.headId); log.push('t1:' + verifyShardEnvelope(t1, V))
  const t2 = clone(envs[1]); t2.shard.dataHash = flip(t2.shard.dataHash); log.push('t2:' + verifyShardEnvelope(t2, V))
  const t3 = clone(envs[2]); delete (t3.header.head as { wit?: unknown }).wit; log.push('t3:' + verifyShardEnvelope(t3, V))
  const t4 = clone(envs[3]); t4.header.certs = []; log.push('t4:' + verifyShardEnvelope(t4, V))
  log.push('t5:' + verifyShardEnvelope(envs[0]))

  // duty ranking over a fixed signed directory (one zero-capacity node)
  const dir: NodeDirectory = { nodes: new Map(), staleAfterMs: 600_000 }
  for (let i = 0; i < 8; i++) {
    const r = kp('dir-root-' + i)
    const d = kp('dir-dev-' + i)
    dir.nodes.set(nodeIdOf(r.pub), signPresence({
      v: 1, root: r.pubB, key: d.pubB,
      caps: { witness: true, committee: true, shardMb: i === 3 ? 0 : 25 },
      params: PARAMS_A3_DIGEST, ts: 1_000_000, uptimePct: 90,
    }, d.priv))
  }
  const subjectId = nodeIdOf(root.pub)
  for (let idx = 0; idx < 6; idx++)
    log.push('duty' + idx + ':' + dutyCarriers(subjectId, idx, dir, { nowMs: 1_000_500, dutyK: 3 }).join(','))

  // reconstruct subsets
  const shards = envs.map((e) => e.shard)
  for (const ids of [[0, 1, 2], [3, 4, 5], [0, 3, 5], [5, 1, 4]]) {
    const got = reconstructTolerant(ids.map((i) => shards[i]))
    log.push('rc' + ids.join('') + ':' + (got ? toB64u(sha256(got)) : 'null'))
  }

  // events merge fold (commutative over the set)
  const row = (evs: unknown[]) => ({ v: 1, events: evs }) as never
  const m1 = storageMerge(row([chainA.events[0]]), row([head]), 'events', subjectId)
  const m2 = storageMerge(row([head]), row([chainA.events[0]]), 'events', subjectId)
  const h1 = toB64u(canonicalHash(m1 as never))
  log.push('mg:' + h1 + ':' + (h1 === toB64u(canonicalHash(m2 as never)) ? 'comm' : 'divergent'))

  return toB64u(sha256(utf8(JSON.stringify(log))))
}
`

async function main() {
  const outdir = makeOutdir('accounts-shards-test')
  const outNode = makeOutdir('accounts-shards-parity-node')
  const outBrowser = makeOutdir('accounts-shards-parity-browser')
  try {
    await run(await bundleAndImport(outdir, ENTRY), outNode, outBrowser)
  } finally {
    for (const d of [outdir, outNode, outBrowser]) rmSync(d, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M, outNode, outBrowser) {
  const { A, W, O, S } = M
  const NOW = 1_750_000_000_000
  const b64 = A.toB64u
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: A.toB64u(pub) }
  }
  const fakeId = (s) => b64(A.sha256(A.utf8(s)))
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
  const clone = (x) => structuredClone(x)
  const canon = (v) => b64(A.canonicalHash(v))
  const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  const shaB = (bytes) => b64(A.sha256(bytes))

  /** Attach a witness attestation to a signed event (id is over body only). */
  const attest = (ev, wkp, wts, epoch = 1) => ({
    body: ev.body,
    sig: ev.sig,
    wit: [W.makeAttestation(A.eventId(ev.body), epoch, wkp.pubB, wkp.priv, wts)],
  })

  // ==========================================================================
  console.log('\n· 0. static determinism guards + params …')
  // ==========================================================================
  {
    const src = readFileSync(resolve(ROOT, 'src/shared/accounts/storage/shards.ts'), 'utf8')
    ok(!/\bDate\.now\s*\(|\bMath\.random\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|\bperformance\.now\s*\(/.test(src),
      'shards.ts calls no ambient time, randomness, or timers. Repair runs ONLY when ticked')
    ok(!/from 'node:|from "node:/.test(src), "shards.ts imports no node: builtins (platform-neutral)")
    ok(src.includes('PARAMS_A3_DIGEST'), 'shards.ts embeds the revisable-params digest seam')
    eq(S.PARAMS_A3.nShards, 40, 'PARAMS_A3.nShards = 40 (ACCOUNTS-PARAMS §Storage)')
    eq(S.PARAMS_A3.kRec, 12, 'PARAMS_A3.kRec = 12 (any 12 of 40 reconstruct)')
    eq(S.PARAMS_A3_DIGEST, GOLDEN_PARAMS_A3_DIGEST, 'PARAMS_A3_DIGEST matches the recorded golden value')
  }

  // ==========================================================================
  console.log('\n· 1. shardKey: goldens, distinctness, range …')
  // ==========================================================================
  {
    eq(b64(A.sha256(A.utf8('shard-golden-subject'))), GOLDEN_SUBJECT, 'golden subject id reproduces')
    for (const [idx, want] of Object.entries(GOLDEN_SHARD_KEYS))
      eq(S.shardKey(GOLDEN_SUBJECT, Number(idx)), want, `shardKey(subject, ${idx}) matches the golden vector`)
    eq(S.shardKey(GOLDEN_SUBJECT, 7), S.shardKey(GOLDEN_SUBJECT, 7), 'shardKey is deterministic')
    const keys = new Set(Array.from({ length: 40 }, (_, i) => S.shardKey(GOLDEN_SUBJECT, i)))
    eq(keys.size, 40, 'all 40 row keys of one subject are distinct')
    ok(!keys.has(GOLDEN_SUBJECT), 'no row key collides with the subject key itself (hash-spread neighborhoods)')
    ok(S.shardKey(fakeId('another-subject'), 0) !== S.shardKey(GOLDEN_SUBJECT, 0), 'different subjects → different keys at one idx')
    throws(() => S.shardKey(GOLDEN_SUBJECT, -1), 'shardKey throws on idx -1')
    throws(() => S.shardKey(GOLDEN_SUBJECT, 1.5), 'shardKey throws on a fractional idx')
    throws(() => S.shardKey(GOLDEN_SUBJECT, 2 ** 32), 'shardKey throws on idx 2^32')
    throws(() => S.shardKey(GOLDEN_SUBJECT, NaN), 'shardKey throws on NaN idx')
    throws(() => S.shardKey('short-b64u', 0), 'shardKey throws on a subject that is not 32 bytes')
  }

  // ==========================================================================
  console.log('\n· 2. cutSnapshot + shardJob → verifyShardEnvelope (k=3, n=6) …')
  // ==========================================================================
  // Subject chain: root-signed genesis, device cert, then a witnessed event
  // SIGNED BY THE DEVICE, so the accept path exercises the embedded-cert
  // proof, not just root signatures. One witness attests the head.
  const sub = {
    root: kpOf('shard-subject-root'),
    dev: kpOf('shard-subject-dev'),
    wit: kpOf('shard-witness-1'),
    stranger: kpOf('shard-stranger'),
  }
  let subChainPlain = A.createAccountChain({
    rootPriv: sub.root.priv, rootPub: sub.root.pub, displayName: 'Shard Subject', ts: 1000,
    device: { pub: sub.dev.pubB, index: 0 },
  })
  subChainPlain = A.appendWitnessed(subChainPlain, sub.dev.priv, sub.dev.pubB, 'revoke', { pub: fakeId('gone-1') }, 1100)
  const headPlain = subChainPlain.events[subChainPlain.events.length - 1]
  const headAtt = attest(headPlain, sub.wit, 1105)
  const genesisAtt = attest(subChainPlain.events[0], sub.wit, 1005)
  const subChain = {
    root: subChainPlain.root,
    events: subChainPlain.events.map((e) => (e === headPlain ? headAtt : e === subChainPlain.events[0] ? genesisAtt : e)),
  }
  const certEv = subChain.events.find((e) => e.body.type === 'cert')
  const subChainBytes = A.chainToBytes(subChain)
  const VOPT = { k: 3, n: 6 }
  let header, envs
  {
    ok(A.verifyChain(subChain).ok, 'the fixture subject chain verifies ok (sanity)')
    header = S.cutSnapshot(subChain, headAtt, [certEv], sub.dev.priv, VOPT)
    eq(header.root, sub.root.pubB, 'header.root binds the subject root')
    eq(header.headId, A.eventId(headAtt.body), 'header.headId = eventId(head.body)')
    eq(header.height, 1, 'header.height is the witnessed head height')
    eq(header.blobLen, subChainBytes.length, 'header.blobLen = chainToBytes length')
    eq(header.blobHash, shaB(subChainBytes), 'header.blobHash = sha256(chainToBytes)')
    eq(header.k, 3, 'header.k from opts')
    eq(header.n, 6, 'header.n from opts')
    eq(header.params, S.PARAMS_A3_DIGEST, 'header embeds PARAMS_A3_DIGEST (revisable-rule pin)')
    eq(header.commitSig.length, 86, 'header carries the owner blob commitment (ed25519 over the binding tuple)')
    ok(S.verifyShardEnvelope(S.shardJob(header, subChainBytes)[0], VOPT) === 'ok', 'the committed job verifies at the gate')
    throws(() => S.cutSnapshot(subChain, headAtt, [certEv], sub.stranger.priv, VOPT), 'cutSnapshot refuses a commitPriv that does not match head.body.key')
    throws(() => S.cutSnapshot(subChain, genesisAtt, [certEv], sub.dev.priv, VOPT), 'cutSnapshot refuses a non-head witnessed event as head')
    throws(() => S.cutSnapshot({ root: subChain.root, events: [] }, headAtt, [], sub.dev.priv, VOPT), 'cutSnapshot refuses a chain with no witnessed lane')
    const foreign = A.createAccountChain({ rootPriv: sub.stranger.priv, rootPub: sub.stranger.pub, displayName: 'Foreign', ts: 1000 })
    throws(() => S.cutSnapshot(foreign, headAtt, [certEv], sub.dev.priv, VOPT), "cutSnapshot refuses a head that is not the chain's own")

    envs = S.shardJob(header, subChainBytes)
    eq(envs.length, 6, 'shardJob emits n envelopes')
    ok(envs.every((e, i) => e.shard.idx === i), 'envelopes ride in ascending idx order')
    eq(canon(envs), canon(S.shardJob(header, subChainBytes)), 'shardJob is byte-deterministic (same header+bytes → same envelopes)')
    throws(() => S.shardJob(header, subChainBytes.slice(1)), 'shardJob refuses bytes that do not match header blobHash/blobLen')
  }

  console.log('\n· 2a. ACCEPT path …')
  {
    ok(envs.every((e) => S.verifyShardEnvelope(e, VOPT) === 'ok'), "every envelope of the job verifies 'ok' under the advertised geometry")
    // Root-signed head needs no certs: a fresh chain whose head is the genesis.
    const solo = kpOf('shard-solo-root')
    const soloChainP = A.createAccountChain({ rootPriv: solo.priv, rootPub: solo.pub, displayName: 'Solo Subject', ts: 1000 })
    const soloHead = attest(soloChainP.events[0], sub.wit, 1010)
    const soloChain = { root: soloChainP.root, events: [soloHead] }
    const soloHeader = S.cutSnapshot(soloChain, soloHead, [], solo.priv, VOPT)
    const soloEnvs = S.shardJob(soloHeader, A.chainToBytes(soloChain))
    eq(S.verifyShardEnvelope(soloEnvs[0], VOPT), 'ok', 'a root-signed attested head verifies with an EMPTY cert set')
  }

  console.log('\n· 2b. REJECT matrix, every ShardVerdict variant …')
  {
    const V = (env, want, msg) => eq(S.verifyShardEnvelope(env, VOPT), want, msg)
    const T = (mut) => { const e = clone(envs[0]); mut(e); return e }
    // --- bad-envelope: malformed / zod-rejected / non-canonical shapes
    V(42, 'bad-envelope', 'a number → bad-envelope')
    V(null, 'bad-envelope', 'null → bad-envelope')
    V('shard', 'bad-envelope', 'a string → bad-envelope')
    V({}, 'bad-envelope', 'an empty object → bad-envelope')
    V([envs[0]], 'bad-envelope', 'an array → bad-envelope')
    V(T((e) => { e.extra = 1 }), 'bad-envelope', 'an extra top-level key → bad-envelope (strict shape)')
    V(T((e) => { e.v = 2 }), 'bad-envelope', 'an unknown envelope version → bad-envelope')
    V(T((e) => { delete e.shard }), 'bad-envelope', 'a missing shard frame → bad-envelope')
    V(T((e) => { e.header.height = 1.5 }), 'bad-envelope', 'a float height (non-canonical) → bad-envelope')
    V(T((e) => { e.header.certs = 'nope' }), 'bad-envelope', 'a non-array certs field → bad-envelope')
    V(T((e) => { e.header.certs = Array.from({ length: S.HEADER_CERTS_MAX + 1 }, () => clone(certEv)) }), 'bad-envelope',
      `certs over HEADER_CERTS_MAX=${S.HEADER_CERTS_MAX} → bad-envelope (padded-list bound)`)
    V(JSON.parse('{"v":1,"__proto__":{"x":1}}'), 'bad-envelope', "a '__proto__'-key object → bad-envelope (no throw)")
    // --- wrong-params: foreign rule set / geometry
    V(T((e) => { e.header.params = fakeId('other-params') }), 'wrong-params', 'a foreign params digest → wrong-params')
    eq(S.verifyShardEnvelope(envs[0]), 'wrong-params', 'the k=3/n=6 job is REFUSED under default production geometry (12/40), foreign geometry never guessed')
    V(T((e) => { e.header.k = 4 }), 'wrong-params', 'header.k differing from the advertised k → wrong-params')
    {
      const e = clone(envs[0]); e.header.k = 4; e.header.n = 2
      eq(S.verifyShardEnvelope(e, { k: 4, n: 2 }), 'wrong-params', 'k > n is refused even when it matches the advertised pair')
    }
    // --- bad-head: not a valid owner-signed witnessed event of root/headId/height
    V(T((e) => { e.header.root = sub.stranger.pubB }), 'bad-head', 'header.root not the head root → bad-head')
    V(T((e) => { e.header.height = 2 }), 'bad-head', 'header.height not the head height → bad-head')
    V(T((e) => { e.header.headId = flip(e.header.headId) }), 'bad-head', 'header.headId not eventId(head.body) → bad-head')
    V(T((e) => { e.header.head.sig = flip(e.header.head.sig) }), 'bad-head', 'a flipped head signature → bad-head')
    V(T((e) => { e.header.head.body.ts += 1 }), 'bad-head', 'an edited head body (id shifts) → bad-head')
    {
      // A personal-lane event smuggled as the head (certs are personal + valid).
      const e = clone(envs[0])
      e.header.head = clone(certEv)
      e.header.headId = A.eventId(certEv.body)
      e.header.height = certEv.body.height
      eq(S.verifyShardEnvelope(e, VOPT), 'bad-head', 'a personal-lane event as head → bad-head (witnessed lane required)')
    }
    // --- unattested-head: witness countersignature missing or invalid
    V(T((e) => { e.header.head.wit = [] }), 'unattested-head', 'an empty attestation list → unattested-head')
    V(T((e) => { delete e.header.head.wit }), 'unattested-head', 'an absent attestation list → unattested-head')
    V(T((e) => { e.header.head.wit[0].sig = flip(e.header.head.wit[0].sig) }), 'unattested-head', 'a flipped attestation signature → unattested-head')
    V(T((e) => { e.header.head.wit = genesisAtt.wit }), 'unattested-head', "an attestation bound to a DIFFERENT event id → unattested-head")
    // --- uncertified-key: cert-chain games
    V(T((e) => { e.header.certs = [] }), 'uncertified-key', 'a device-signed head with certs stripped → uncertified-key')
    {
      const otherCert = A.makeCertEvent(sub.root.priv, sub.root.pubB, subChainPlain, { childPub: sub.stranger.pubB, purpose: 0, index: 1, ts: 1150 })
      V(T((e) => { e.header.certs = [otherCert] }), 'uncertified-key', 'certs proving a DIFFERENT pub → uncertified-key')
    }
    {
      // A "cert" for the signing device minted by a stranger, not the root.
      const strangerChain = A.createAccountChain({ rootPriv: sub.stranger.priv, rootPub: sub.stranger.pub, displayName: 'Foreign', ts: 1000 })
      const strangerCert = A.makeCertEvent(sub.stranger.priv, sub.stranger.pubB, strangerChain, { childPub: sub.dev.pubB, purpose: 0, index: 0, ts: 1150 })
      V(T((e) => { e.header.certs = [strangerCert] }), 'uncertified-key', 'a cert root-signed by the WRONG root → uncertified-key')
    }
    V(T((e) => { e.header.certs = [clone(subChain.events.find((x) => x.body.type === 'revoke'))] }), 'uncertified-key',
      'a non-cert event smuggled into certs proves nothing → uncertified-key')
    {
      const selfCert = clone(certEv)
      selfCert.body.payload.pub = sub.root.pubB
      selfCert.sig = b64(A.ed25519.sign(A.canonicalBytes(selfCert.body), sub.root.priv))
      V(T((e) => { e.header.certs = [selfCert] }), 'uncertified-key', 'a root-as-own-child cert is inert → uncertified-key')
    }
    // --- uncommitted-blob: the REAL head paired with a FOREIGN blobHash (the
    // defect-A poison). blobHash is signed by head.body.key; changing it (even
    // with self-consistent framing) breaks the owner commitment.
    V(T((e) => { e.header.blobHash = flip(e.header.blobHash); e.shard.dataHash = e.header.blobHash }), 'uncommitted-blob',
      'a real head + foreign blobHash (self-consistent framing) → uncommitted-blob (owner commit binds the blob; poison cannot pin a slot)')
    V(T((e) => { e.header.blobLen += 1 }), 'uncommitted-blob', 'an edited blobLen breaks the owner commitment → uncommitted-blob')
    V(T((e) => { e.header.commitSig = flip(e.header.commitSig) }), 'uncommitted-blob', 'a flipped commit signature → uncommitted-blob')
    // --- bad-shard: framing not bound byte-for-byte to the header
    eq(S.verifyShardEnvelope(T((e) => { e.shard.idx = 5 }), VOPT), 'bad-shard',
      'an in-range idx re-label is REJECTED: the owner commits a per-row body hash (bodyHashes[idx]), so a row carrying idx-0 bytes under label idx-5 fails the body commit')
    V(T((e) => { e.shard.k = 4 }), 'bad-shard', 'shard.k differing from header.k → bad-shard')
    V(T((e) => { e.shard.n = 5 }), 'bad-shard', 'shard.n differing from header.n → bad-shard')
    V(T((e) => { e.shard.dataHash = flip(e.shard.dataHash) }), 'bad-shard', 'shard.dataHash differing from blobHash → bad-shard')
    V(T((e) => { e.shard.dataLen += 3 }), 'bad-shard', 'shard.dataLen differing from blobLen → bad-shard')
    V(T((e) => { e.shard.body = e.shard.body.slice(0, -4) }), 'bad-shard', 'a truncated shard body → bad-shard')
    V(T((e) => { e.shard.body = e.shard.body + '==' }), 'bad-shard', 'a padded (non-canonical b64u) body → bad-shard')
    V(T((e) => { e.shard.body = '+/+/' + e.shard.body.slice(4) }), 'bad-shard', 'standard-base64 characters in the body → bad-shard')
  }
  {
    // idx >= n: relabel the shard row outside the job geometry. The HEADER is
    // untouched (so its owner commit stays valid; mutating header.n would break
    // the commit and surface as uncommitted-blob first), and the framing check
    // must still reject a row idx at/beyond n.
    const e = clone(envs[5])
    e.shard.idx = 6 // >= header.n (6)
    eq(S.verifyShardEnvelope(e, VOPT), 'bad-shard', 'shard.idx ≥ header.n → bad-shard (row outside the job)')
  }

  // ==========================================================================
  console.log('\n· 3. dutyCarriers / isOnDuty, closestEligible agreement …')
  // ==========================================================================
  {
    const STALE = 600_000
    const mkPresence = (i, shardMb, ts) => {
      const r = kpOf('duty-root-' + i)
      const d = kpOf('duty-dev-' + i)
      return { nodeId: W.nodeIdOf(r.pub), sp: W.signPresence({
        v: 1, root: r.pubB, key: d.pubB, caps: { witness: true, committee: true, shardMb },
        params: S.PARAMS_A3_DIGEST, ts, uptimePct: 95,
      }, d.priv) }
    }
    const recs = [
      ...Array.from({ length: 20 }, (_, i) => mkPresence(i, 50, NOW)), // capacity, fresh
      mkPresence(100, 0, NOW), // zero capacity, fresh
      mkPresence(101, 0, NOW),
      mkPresence(102, 50, NOW - STALE - 1), // capacity, stale
      mkPresence(103, 50, NOW - STALE - 1),
    ]
    const dirOf = (order) => {
      const dm = W.makeDirectory(STALE)
      for (const r of order) dm.ingest(r.sp, r.sp.body.ts)
      return dm.directory
    }
    const dir = dirOf(recs)
    eq(dir.nodes.size, 24, 'directory ingested all 24 signed presences')
    const subjId = W.nodeIdOf(sub.root.pub)
    const eligible = (r) => r.sp.body.caps.shardMb > 0 && NOW - r.sp.body.ts <= STALE
    let agreeAll = true
    for (let idx = 0; idx < 40; idx++) {
      const want = W.closestEligible(S.shardKey(subjId, idx), recs, eligible, S.PARAMS_A3.dutyK)
      if (!sameIds(S.dutyCarriers(subjId, idx, dir, { nowMs: NOW }), want)) agreeAll = false
    }
    ok(agreeAll, 'dutyCarriers agrees EXACTLY with closestEligible ground truth for all 40 rows (default dutyK)')
    const zeroCaps = new Set([recs[20].nodeId, recs[21].nodeId])
    const stales = new Set([recs[22].nodeId, recs[23].nodeId])
    let zeroWouldRank = false
    let cleanAll = true
    for (let idx = 0; idx < 40; idx++) {
      const raw = W.closestEligible(S.shardKey(subjId, idx), recs, () => true, S.PARAMS_A3.dutyK)
      if (raw.some((id) => zeroCaps.has(id) || stales.has(id))) zeroWouldRank = true
      const got = S.dutyCarriers(subjId, idx, dir, { nowMs: NOW })
      if (got.some((id) => zeroCaps.has(id) || stales.has(id))) cleanAll = false
    }
    ok(zeroWouldRank, 'sanity: an ineligible node WOULD rank top-dutyK for at least one row by raw distance')
    ok(cleanAll, 'no zero-capacity or stale node ever carries duty (CAPACITY-ADVERTISING live nodes only)')
    eq(S.dutyCarriers(subjId, 0, dir, { nowMs: NOW }).length, S.PARAMS_A3.dutyK, `a populous directory yields exactly dutyK=${S.PARAMS_A3.dutyK} carriers`)
    eq(S.dutyCarriers(subjId, 0, dir, { nowMs: NOW, dutyK: 5 }).length, 5, 'dutyK is honored as an override')
    ok(sameIds(
      S.dutyCarriers(subjId, 3, dir, { nowMs: NOW }),
      S.dutyCarriers(subjId, 3, dirOf([...recs].reverse()), { nowMs: NOW }),
    ), 'carrier ranking is independent of directory insertion order (objective, viewer-checkable)')
    // boundary: fewer eligible nodes than dutyK
    const tiny = dirOf([recs[0], recs[20]])
    eq(S.dutyCarriers(subjId, 0, tiny, { nowMs: NOW }).length, 1, 'fewer eligible than dutyK → all eligible returned (no padding)')
    ok(S.isOnDuty(recs[0].nodeId, subjId, 0, tiny, { nowMs: NOW }), 'the sole eligible node IS on duty')
    ok(!S.isOnDuty(recs[20].nodeId, subjId, 0, tiny, { nowMs: NOW }), 'the zero-capacity node is NOT on duty')
    ok(!S.isOnDuty(fakeId('never-announced'), subjId, 0, dir, { nowMs: NOW }), 'a node absent from the directory is never on duty')
    {
      const carriers = S.dutyCarriers(subjId, 7, dir, { nowMs: NOW })
      ok(carriers.every((id) => S.isOnDuty(id, subjId, 7, dir, { nowMs: NOW })), 'every ranked carrier reports isOnDuty true')
      const off = recs.map((r) => r.nodeId).filter((id) => !carriers.includes(id))
      ok(off.every((id) => !S.isOnDuty(id, subjId, 7, dir, { nowMs: NOW })), 'every non-carrier reports isOnDuty false')
    }
  }

  // ==========================================================================
  console.log('\n· 4. publish-on-write + finalSync over a 24-node overlay …')
  // ==========================================================================
  /** A fabric node with the storage gate installed (spec §5 carrier). */
  function makeShardNode(fabric, tag, extra = {}, gateOpts = {}) {
    const root = kpOf('sn-root-' + tag)
    const dev = kpOf('sn-dev-' + tag)
    const nodeId = W.nodeIdOf(root.pub)
    const ep = fabric.endpoint(nodeId)
    const announce = (ts) => ep.announce(W.signPresence(
      { v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts, uptimePct: 99 },
      dev.priv,
    ))
    announce(NOW)
    const gate = S.makeShardStoreValidator({ shardMb: 50, ...gateOpts })
    const node = O.createOverlayNode(ep, { root: root.pubB, key: dev.pubB },
      { nowMs: () => NOW, validator: gate.validator, merge: gate.merge, ...extra })
    return { root, dev, nodeId, ep, node, gate, announce }
  }

  const fab = new W.MockFabric()
  const nodes = Array.from({ length: 24 }, (_, i) => makeShardNode(fab, 'main-' + i))
  for (const n of nodes) await n.node.bootstrap()
  const subjectId = W.nodeIdOf(sub.root.pub)
  const dirMain = nodes[0].ep.directory()

  {
    const stored = await S.publishWitnessedEvent(nodes[2].node, sub.root.pubB, headAtt, [certEv])
    eq(stored, S.PARAMS_A3.replicateK, `a witnessed event replicates at creation onto replicateK=${S.PARAMS_A3.replicateK} nodes`)
    const closest = nodes.find((n) => n.nodeId === W.closestEligible(subjectId, nodes, () => true, 1)[0])
    const row = closest.node.localGet(subjectId, 'events')
    ok(row !== null && row.events.some((e) => A.eventId(e.body) === header.headId), 'the closest node to the subject key holds the published event')
    const stored2 = await S.publishWitnessedEvent(nodes[9].node, sub.root.pubB, genesisAtt)
    eq(stored2, S.PARAMS_A3.replicateK, 'a second witnessed event replicates too')
    const merged = await nodes[17].node.getMerged(subjectId, 'events')
    ok(merged !== null && merged.events.length === 2
      && A.eventId(merged.events[0].body) === A.eventId(genesisAtt.body)
      && A.eventId(merged.events[1].body) === header.headId,
      'getMerged unions the event rows across holders, sorted (height, id). Deterministic set fold')
    const forged = clone(headAtt); forged.sig = flip(forged.sig)
    eq(await S.publishWitnessedEvent(nodes[3].node, sub.root.pubB, forged), 0, 'a forged (bad-sig) event stores NOWHERE: rejected at every gate')
    eq(await S.publishWitnessedEvent(nodes[4].node, sub.root.pubB, headPlain, [certEv]), 0, 'an UNATTESTED event stores nowhere (witness countersignature is the §0 authority)')
    eq(await nodes[5].node.put(W.nodeIdOf(sub.stranger.pub), 'events', { v: 1, events: [headAtt] }), 0,
      "a real event published under ANOTHER subject's key stores nowhere (subject-key binding)")
  }

  console.log('\n· 4a. finalSync leaves all 40 rows in shard space …')
  let fsMain
  {
    fsMain = await S.finalSync(nodes[1].node, subChain, headAtt, [certEv], sub.dev.priv)
    eq(canon(fsMain.header), canon(S.cutSnapshot(subChain, headAtt, [certEv], sub.dev.priv)), 'finalSync header equals an independent cutSnapshot (deterministic, commitSig included)')
    eq(fsMain.header.n, 40, 'default geometry: n = 40')
    eq(fsMain.header.k, 12, 'default geometry: k = 12')
    eq(fsMain.perIdx.length, 40, 'one store count per shard row')
    ok(fsMain.perIdx.every((c) => c === S.PARAMS_A3.replicateK), `every row landed on all replicateK=${S.PARAMS_A3.replicateK} closest nodes`)
    let carriersHold = true
    for (let idx = 0; idx < 40; idx++) {
      const key = S.shardKey(subjectId, idx)
      for (const cid of S.dutyCarriers(subjectId, idx, dirMain, { nowMs: NOW })) {
        const held = nodes.find((n) => n.nodeId === cid).node.localGet(key, 'shard')
        if (held === null || S.verifyShardEnvelope(held) !== 'ok' || held.shard.idx !== idx
          || W.nodeIdOf(held.header.root) !== subjectId) carriersHold = false
      }
    }
    ok(carriersHold, 'EVERY duty carrier of every row holds a verified envelope at its key (dutyK ⊆ replicateK placement)')
    ok(nodes.some((n) => n.gate.subjects().includes(subjectId)), "holders' gates record the subject for the repair worklist")
  }
  {
    // A viewer that joins AFTER the owner is gone reconstructs the chain from
    // shard space alone (§5: "a final sync leaves the full chain in shard space").
    const viewer = makeShardNode(fab, 'viewer-late')
    await viewer.node.bootstrap()
    const rows = []
    for (let idx = 0; idx < 40; idx++) {
      const got = await viewer.node.get(S.shardKey(subjectId, idx), 'shard')
      if (got !== null && S.verifyShardEnvelope(got) === 'ok') rows.push(got.shard)
    }
    eq(rows.length, 40, 'a late-joining viewer resolves all 40 rows through the overlay')
    const blob = S.reconstructTolerant(rows)
    ok(blob !== null && shaB(blob) === shaB(subChainBytes), 'the full 40-row set reconstructs the chain bytes bit-identically')
    const parityOnly = S.reconstructTolerant(rows.slice(28, 40))
    ok(parityOnly !== null && shaB(parityOnly) === shaB(subChainBytes), 'the 12 ALL-PARITY rows alone reconstruct bit-identically')
    const back = A.chainFromBytes(blob)
    const vr = A.verifyChain(back)
    ok(vr.ok, 'the reconstructed chain fully verifies (owner signatures intact)')
    eq(vr.witnessedHead, fsMain.header.headId, "the reconstructed chain's witnessed head equals the countersigned headId (blob↔head binding)")
  }

  // ==========================================================================
  console.log('\n· 5. the gate under attack: forgery, poisoning, downgrade …')
  // ==========================================================================
  const envsMain = S.shardJob(fsMain.header, subChainBytes)
  const key0 = S.shardKey(subjectId, 0)
  const holder0 = nodes.find((n) => n.node.localGet(key0, 'shard') !== null)
  {
    const atk = makeShardNode(fab, 'attacker', { validator: () => false })
    await atk.node.bootstrap()
    const forged = clone(envsMain[0]); forged.header.head.sig = flip(forged.header.head.sig)
    eq(await atk.node.put(key0, 'shard', forged), 0, 'a forged envelope (bad head sig) stores NOWHERE: rejected at the gate, not by policy')
    eq(await atk.node.put(S.shardKey(W.nodeIdOf(sub.stranger.pub), 0), 'shard', clone(envsMain[0])), 0,
      "a VALID envelope re-keyed to another subject's slot stores nowhere (wrong-subject replay)")
    eq(await atk.node.put(S.shardKey(subjectId, 1), 'shard', clone(envsMain[0])), 0,
      "a valid row offered at a DIFFERENT row's key stores nowhere (idx-key binding)")
    // THE POISONING CASE (regression for the per-row body-commit fix): same
    // height, same head, same blob-level framing: the shard BODY byte-flipped.
    // The owner commits sha256(body) per row (header.bodyHashes[idx]), so a
    // keyless attacker cannot mint a same-length garbage body that verifies.
    // It is refused at the GATE (not merely at reconstruction), so it can never
    // FIRST-store to pin a slot and strand the honest snapshot.
    const poisoned = clone(envsMain[0])
    const body = A.fromB64u(poisoned.shard.body); body[0] ^= 0xff
    poisoned.shard.body = b64(body)
    eq(S.verifyShardEnvelope(poisoned), 'bad-shard', 'the byte-flipped body FAILS store-time verification: the owner commits a per-row body hash the framing now authenticates')
    eq(await atk.node.put(key0, 'shard', poisoned), 0, 'a keyless body-flip of a public row stores NOWHERE, refused at every gate')
    eq(canon(holder0.node.localGet(key0, 'shard')), canon(envsMain[0]), "the holder's row is byte-identical to the honest envelope after the attack")
    // BODY-POISON FIRST-OFFERED to an EMPTY slot (the actual keyless attack: a
    // churned duty slot the attacker races). Pre-fix it verified 'ok', first-store
    // pinned it, and the honest same-height row was refused FOREVER; the per-row
    // body commit refuses it before any slot is claimed.
    {
      const freshGate = S.makeShardStoreValidator({ shardMb: 50 })
      const flip5 = clone(envsMain[5]); const bb = A.fromB64u(flip5.shard.body); bb[0] ^= 0xff; flip5.shard.body = b64(bb)
      const k5 = S.shardKey(subjectId, 5)
      ok(!freshGate.validator(fakeId('atk-first'), k5, 'shard', flip5), 'a body-flip poison offered FIRST to a fresh gate is refused. It can never pin a slot against the honest row')
      ok(freshGate.validator(fakeId('honest'), k5, 'shard', clone(envsMain[5])), '…and the honest committed row is accepted at that same key')
    }
    // TWO poisoned rows can no longer strand a recoverable snapshot: because the
    // gate refuses every body-flip, ≥ kRec honest rows always remain (pre-fix two
    // pinned corrupt rows defeated reconstructTolerant's single leave-one-out and
    // rendered 38/40 honest shards UNRECOVERABLE).
    {
      const honestRows = envsMain.map((e) => e.shard) // all 40 honest bodies
      const flipShard = (idx) => { const s = clone(envsMain[idx].shard); const bb = A.fromB64u(s.body); bb[0] ^= 0xff; s.body = b64(bb); return s }
      // Sanity: a body-flip fails the gate, so it is never among the reconstruction set.
      const fakeFlip = { v: 1, header: clone(envsMain[0].header), shard: flipShard(0) }
      eq(S.verifyShardEnvelope(fakeFlip), 'bad-shard', 'a body-flip envelope never verifies, so it never enters a reconstruction set')
      // The 40 honest rows (the only rows the gate ever admits) reconstruct.
      const blob = S.reconstructTolerant(honestRows)
      ok(blob !== null && shaB(blob) === shaB(subChainBytes), 'the honest rows the gate admits reconstruct bit-identically (poison never occupies a slot)')
    }
    // DEFECT-A REGRESSION: an attacker replays the REAL public head with a
    // FOREIGN blobHash (self-consistent framing). Pre-fix it verified 'ok' and,
    // raced first, pinned the slot so the honest same-height row was refused
    // FOREVER: permanent owner-gone loss. The owner commitment makes it fail.
    const foreignBlob = clone(envsMain[0])
    foreignBlob.header.blobHash = fakeId('foreign-blob-poison')
    foreignBlob.shard.dataHash = foreignBlob.header.blobHash // self-consistent framing
    eq(S.verifyShardEnvelope(foreignBlob), 'uncommitted-blob', 'a real head + foreign blobHash is refused: blobHash is owner-committed')
    const freshGate = S.makeShardStoreValidator({ shardMb: 50 })
    ok(!freshGate.validator(fakeId('atk-first'), key0, 'shard', foreignBlob), 'the foreign-blob poison is refused even when FIRST-offered. It can never pin a slot against the real snapshot')
    ok(freshGate.validator(fakeId('honest'), key0, 'shard', clone(envsMain[0])), '…and the honest committed row is accepted at that same key')
  }
  {
    const g = S.makeShardStoreValidator({ shardMb: 50 })
    const from = fakeId('gate-peer')
    ok(g.validator(from, key0, 'shard', clone(envsMain[0])), 'gate: a valid row at its key is accepted')
    ok(g.validator(from, key0, 'shard', clone(envsMain[0])), 'gate: the byte-identical snapshot row re-stores idempotently')
    eq(g.usedBytes(), A.canonicalBytes(envsMain[0]).length, 'gate: usedBytes counts the row once (replace, not double-count)')
    ok(sameIds(g.subjects(), [subjectId]), 'gate: subjects() lists the held subject (repair worklist)')
    ok(!g.validator(from, key0, 'events', { v: 1, events: [headAtt] }), 'gate: an events row under a SHARD key is refused (key names the subject, not a row)')
    ok(!g.validator(from, key0, 'pointers', { v: 1 }), "gate: kind 'pointers' stays refused until brick 4's verifier exists")
    ok(g.validator(from, fakeId('any-record'), 'record', { v: 1 }), "gate: kind 'record' falls through to the overlay default (unchanged behavior)")
    // events-kind rules
    ok(g.validator(from, subjectId, 'events', { v: 1, events: [headAtt, genesisAtt], certs: [certEv] }), 'gate: a valid multi-event row (device-signed proven by its certs) is accepted')
    ok(!g.validator(from, subjectId, 'events', { v: 1, events: [] }), 'gate: an empty events row is refused')
    ok(!g.validator(from, subjectId, 'events', { v: 1, events: Array.from({ length: S.PARAMS_A3.eventsPageMax + 1 }, () => headAtt), certs: [certEv] }),
      `gate: an events row over eventsPageMax=${S.PARAMS_A3.eventsPageMax} is refused`)
    ok(!g.validator(from, subjectId, 'events', { v: 1, events: [certEv] }), 'gate: a personal-lane event in an events row is refused (witnessed only)')
    ok(!g.validator(from, W.nodeIdOf(sub.stranger.pub), 'events', { v: 1, events: [headAtt], certs: [certEv] }), 'gate: an events row under the wrong subject key is refused')
    // events-key AUTHORIZATION (defect E, §0): a device-signed event needs its cert.
    ok(!g.validator(from, subjectId, 'events', { v: 1, events: [headAtt] }), 'gate: a device-signed event WITHOUT its cert is refused (key not proven for root)')
    ok(g.validator(from, subjectId, 'events', { v: 1, events: [genesisAtt] }), 'gate: a ROOT-signed event needs no cert (key === root)')
    {
      // An attacker attributes a self-signed, self-attested event to subject X:
      // no honest cert can prove the attacker key, so X's key never confers
      // standing on possession-signed data.
      const atkKp = kpOf('events-atk'); const atkWit = kpOf('events-atk-wit')
      const body = { v: 1, lane: 'w', type: 'revoke', root: sub.root.pubB, key: atkKp.pubB, height: 5, ts: 9000, payload: { pub: fakeId('atk-target') } }
      const ev = { body, sig: b64(A.ed25519.sign(A.canonicalBytes(body), atkKp.priv)), wit: [W.makeAttestation(A.eventId(body), 1, atkWit.pubB, atkWit.priv, 9005)] }
      ok(!g.validator(from, subjectId, 'events', { v: 1, events: [ev] }), 'gate: an event signed by an UNAUTHORIZED key under X is refused even self-attested (defect E)')
      ok(!g.validator(from, subjectId, 'events', { v: 1, events: [ev], certs: [certEv] }), 'gate: …and no honest cert proves the attacker key either')
    }
    eq(g.usedBytes(), A.canonicalBytes(envsMain[0]).length, 'gate: events rows are NOT counted against the shard byte budget (bounded instead by the merge row cap)')
  }
  {
    // Budget accounting: exact-fit replace, second-key refusal, zero-budget refusal.
    const bytes0 = A.canonicalBytes(envsMain[0]).length
    const g = S.makeShardStoreValidator({ shardMb: 50, budgetBytes: bytes0 })
    const from = fakeId('gate-peer')
    ok(g.validator(from, key0, 'shard', clone(envsMain[0])), 'budget: a row exactly at the byte budget is accepted')
    ok(!g.validator(from, S.shardKey(subjectId, 1), 'shard', clone(envsMain[1])), 'budget: a second row over the budget is refused (honest degradation)')
    eq(g.usedBytes(), bytes0, 'budget: refusal leaves the accounting untouched')
    const g0 = S.makeShardStoreValidator({ shardMb: 0 })
    ok(!g0.validator(from, key0, 'shard', clone(envsMain[0])), 'budget: a zero-capacity gate refuses every shard row (advertise 0 ⇒ carry 0)')
  }
  {
    // storageMerge semantics, direct.
    const rowOf = (evs) => ({ v: 1, events: evs })
    const a = rowOf([genesisAtt]); const bRow = rowOf([headAtt, genesisAtt])
    const m1 = S.storageMerge(a, bRow, 'events', subjectId)
    const m2 = S.storageMerge(bRow, a, 'events', subjectId)
    eq(canon(m1), canon(m2), 'storageMerge(events) is commutative over the event set (arrival-order independent)')
    eq(m1.events.length, 2, 'storageMerge dedupes by event id')
    eq(A.eventId(m1.events[0].body), A.eventId(genesisAtt.body), 'union sorts by (height, id)')
    eq(canon(S.storageMerge(clone(envsMain[0]), clone(envsMain[1]), 'shard', key0)), canon(envsMain[1]),
      "storageMerge(shard) is plain replace (staleness is the VALIDATOR's decision)")
    eq(canon(S.storageMerge(null, a, 'events', subjectId)), canon(a), 'storageMerge with no prior row keeps the incoming row')
    eq(canon(S.storageMerge({ v: 2 }, a, 'events', subjectId)), canon(a), 'storageMerge falls back to replace on a malformed prior (fail-closed fold)')
  }
  {
    // Defect D: the merged events row is BOUNDED (an active lane cannot grow it
    // without limit off the advertised byte budget). Synthetic root-signed
    // rows (merge does not verify; only the SET/order/cap matter here). Height
    // 0 is a genuine root-signed GENESIS (the merge now identifies the preserved
    // genesis by type+key+subject-binding, not height alone, defect: height-0
    // flood evicting the real genesis).
    const cap = S.EVENTS_ROW_MAX
    const synthEv = (h) => ({
      body: h === 0
        ? { v: 1, lane: 'w', type: 'genesis', root: sub.root.pubB, key: sub.root.pubB, height: 0, ts: 1000, payload: { params: fakeId('params'), name: 'Cap Subject' } }
        : { v: 1, lane: 'w', type: 'revoke', root: sub.root.pubB, key: sub.root.pubB, height: h, ts: 1000 + h, payload: { pub: fakeId('gone-' + h) } },
      sig: 'A'.repeat(86),
    })
    const total = cap + 100
    const half = Math.ceil(total / 2)
    const rowA = { v: 1, events: Array.from({ length: half }, (_, i) => synthEv(i)) }
    const rowB = { v: 1, events: Array.from({ length: total - half }, (_, i) => synthEv(half + i)) }
    const capped = S.storageMerge(rowA, rowB, 'events', subjectId)
    eq(capped.events.length, cap, `an events-row union past EVENTS_ROW_MAX=${cap} is bounded (unbounded growth closed, defect D)`)
    ok(capped.events.some((e) => e.body.height === 0), 'the cap preserves genesis (the display name survives)')
    eq(capped.events[capped.events.length - 1].body.height, total - 1, 'the cap keeps the NEWEST rows')
    ok(!capped.events.some((e) => e.body.height === 50), 'older rows past the cap are dropped (full history stays in shard space)')
    // getMerged folds RAW find-value responses through storageMerge, so an
    // OVERSIZED hostile events array must be pre-bounded BEFORE the per-event
    // hashing: each side is sliced to EVENTS_ROW_MAX first, so the work (and the
    // result) is bounded regardless of the offered length (reader CPU-DoS closed).
    const oversized = { v: 1, events: Array.from({ length: cap * 2 }, (_, i) => synthEv(i)) }
    const bounded = S.storageMerge(oversized, { v: 1, events: [synthEv(0)] }, 'events', subjectId)
    ok(bounded.events.length <= cap, `a storageMerge fold over a 2×EVENTS_ROW_MAX row is BOUNDED at ≤ ${cap} (pre-sliced before hashing, not O(N))`)
  }
  {
    // §5b: events-row CERT channel. acceptEvents validates every cert (shape +
    // root-signed of THIS subject) so junk/oversize padding can never ride the
    // row off-budget (§11) or squat a slot; storageMerge retains certs
    // DETERMINISTICALLY over the set (arrival-order independent) and NEEDED-first
    // so a valid-cert flood cannot evict a device cert a surviving event needs.
    const g = S.makeShardStoreValidator({ shardMb: 50 })
    const from = fakeId('cert-peer')
    // 20 DISTINCT valid root-signed device certs of the subject.
    const realCerts = Array.from({ length: 20 }, (_, i) =>
      A.makeCertEvent(sub.root.priv, sub.root.pubB, subChainPlain, { childPub: kpOf('cert-dev-' + i).pubB, purpose: 0, index: 10 + i, ts: 1200 + i }))
    ok(realCerts.every((c) => A.certsProving(sub.root.pubB, [c], [c.body.payload.pub]).length === 1), 'sanity: the fixture device certs are valid root-signed certs')
    // Junk / oversize / foreign-root certs are refused at the gate.
    const junkCert = { body: { v: 1, pad: 'A'.repeat(50_000) }, sig: 'A'.repeat(86) }
    ok(!g.validator(from, subjectId, 'events', { v: 1, events: [genesisAtt], certs: [junkCert] }),
      'gate: a root-signed row carrying a shape-invalid / oversize junk cert is REFUSED (no off-budget padding, no cert-slot squatting)')
    const foreignCert = A.makeCertEvent(sub.stranger.priv, sub.stranger.pubB,
      A.createAccountChain({ rootPriv: sub.stranger.priv, rootPub: sub.stranger.pub, displayName: 'F', ts: 1000 }),
      { childPub: sub.dev.pubB, purpose: 0, index: 0, ts: 1200 })
    ok(!g.validator(from, subjectId, 'events', { v: 1, events: [genesisAtt], certs: [foreignCert] }), "gate: a cert root-signed by a FOREIGN root is refused (not this subject's)")
    ok(g.validator(from, subjectId, 'events', { v: 1, events: [genesisAtt], certs: realCerts.slice(0, S.EVENTS_CERTS_MAX) }), `gate: a row with exactly EVENTS_CERTS_MAX=${S.EVENTS_CERTS_MAX} valid certs is accepted`)
    ok(!g.validator(from, subjectId, 'events', { v: 1, events: [genesisAtt], certs: realCerts.slice(0, S.EVENTS_CERTS_MAX + 1) }), 'gate: a row with more than EVENTS_CERTS_MAX certs is refused (padded-list bound)')
    // storageMerge: order-independent + needed-cert-preserving cert union.
    const rowNeeded = { v: 1, events: [headAtt], certs: [certEv] } // headAtt is device-signed; certEv proves its key
    const rowFlood = { v: 1, events: [genesisAtt], certs: realCerts.slice(0, S.EVENTS_CERTS_MAX) }
    const mA = S.storageMerge(rowFlood, rowNeeded, 'events', subjectId)
    const mB = S.storageMerge(rowNeeded, rowFlood, 'events', subjectId)
    eq(canon(mA), canon(mB), 'storageMerge cert union is arrival-order INDEPENDENT above the cap (byte-identical both directions, set-deterministic)')
    eq(mA.certs.length, S.EVENTS_CERTS_MAX, `the unioned certs are bounded at EVENTS_CERTS_MAX=${S.EVENTS_CERTS_MAX}`)
    ok(mA.certs.some((c) => A.eventId(c.body) === A.eventId(certEv.body)), 'the NEEDED device cert (proving a surviving event) survives an unneeded valid-cert flood (never evicted by arrival order, defects: cert-channel eviction + non-determinism)')
  }

  console.log('\n· 5b-r3. events-row FLOOD cannot evict the real head/genesis …')
  {
    // ROUND 3 (second fix). A leaked cert-proven key (its root-signed cert is
    // never deleted) can mint unlimited witnessed forgeries at ANY height, but
    // neither acceptEvents nor the merge cap may let them delete the real head +
    // events (defect: high-height flood evicts newest-by-height) or the display-
    // name genesis (defect: height-0 flood evicts genesis-by-height-0).
    const subjId = W.nodeIdOf(sub.root.pub)
    const gate = S.makeShardStoreValidator({ shardMb: 50 })
    const mint = (body, priv) => ({ body, sig: b64(A.ed25519.sign(A.canonicalBytes(body), priv)) })
    const atkWit = kpOf('r3-flood-atk-wit')
    const forge = (body) => ({ ...mint(body, sub.dev.priv), wit: [W.makeAttestation(A.eventId(body), 1, atkWit.pubB, atkWit.priv, 9000)] })
    const cap = S.EVENTS_ROW_MAX

    // (defect 6) acceptEvents refuses structurally-impossible height-0 events.
    const h0revoke = forge({ v: 1, lane: 'w', type: 'revoke', root: sub.root.pubB, key: sub.dev.pubB, height: 0, ts: 7, payload: { pub: fakeId('r3-x') } })
    ok(!gate.validator('atk', subjId, 'events', { v: 1, events: [h0revoke], certs: [certEv] }), 'gate: a NON-genesis witnessed event at height 0 is refused (defect 6: height 0 is the genesis slot only)')
    const devGenesis = forge({ v: 1, lane: 'w', type: 'genesis', root: sub.root.pubB, key: sub.dev.pubB, height: 0, ts: 7, payload: { params: fakeId('r3-p'), name: 'EVIL' } })
    ok(!gate.validator('atk', subjId, 'events', { v: 1, events: [devGenesis], certs: [certEv] }), 'gate: a DEVICE-signed "genesis" is refused (defect 6: a genesis is root-signed)')

    // A real linked chain: root-signed genesis + 6 device-signed revokes (h1..h6).
    let chain = A.createAccountChain({ rootPriv: sub.root.priv, rootPub: sub.root.pub, displayName: 'R3 Flood Subject', ts: 1000, device: { pub: sub.dev.pubB, index: 0 } })
    chain = { root: chain.root, events: [attest(chain.events[0], sub.wit, 1005), ...chain.events.slice(1)] }
    for (let h = 1; h <= 6; h++) {
      const last = A.appendWitnessed(chain, sub.dev.priv, sub.dev.pubB, 'revoke', { pub: fakeId('r3-gone-' + h) }, 1000 + h * 100)
      chain = { root: last.root, events: [...last.events.slice(0, -1), attest(last.events[last.events.length - 1], sub.wit, 1000 + h * 100 + 5)] }
    }
    const realW = chain.events.filter((e) => e.body.lane === 'w')
    const realGid = A.eventId(realW.find((e) => e.body.height === 0).body)
    const realHeadId = A.eventId(realW.find((e) => e.body.height === 6).body)
    ok(gate.validator('atk', subjId, 'events', { v: 1, events: realW, certs: [certEv] }), 'gate: the real chain events (genesis + 6 linked device revokes) are accepted (control)')

    // (defect 6) a height-0 flood: ids ground ABOVE the real genesis so it would
    // win a "keep highest id" cap: cannot evict the real genesis.
    const h0Flood = []
    for (let i = 0; h0Flood.length < cap + 20; i++) {
      const ev = forge({ v: 1, lane: 'w', type: 'genesis', root: sub.root.pubB, key: sub.dev.pubB, height: 0, ts: i, payload: { params: fakeId('r3-p'), name: 'E' + i } })
      if (A.eventId(ev.body) > realGid) h0Flood.push(ev)
    }
    const mergedG = S.storageMerge({ v: 1, events: realW.filter((e) => e.body.height === 0) }, { v: 1, events: h0Flood }, 'events', subjId)
    ok(mergedG.events.some((e) => A.eventId(e.body) === realGid), 'merge: the REAL genesis survives a height-0 flood (defect 6: genesis identified by type+key+subject, not height alone)')
    ok(mergedG.events.length <= cap, 'merge: bounded under the height-0 flood')

    // (defect 5) a DISCONNECTED high-height flood cannot evict the real events.
    const hiFlood = []
    for (let i = 0; i < cap + 20; i++)
      hiFlood.push(forge({ v: 1, lane: 'w', type: 'revoke', root: sub.root.pubB, key: sub.dev.pubB, height: 999999, ts: i, payload: { pub: fakeId('r3-hf' + i) } }))
    let merged = S.storageMerge({ v: 1, events: realW, certs: [certEv] }, { v: 1, events: hiFlood.slice(0, cap), certs: [certEv] }, 'events', subjId)
    merged = S.storageMerge(merged, { v: 1, events: hiFlood.slice(cap), certs: [certEv] }, 'events', subjId)
    const kept = new Set(merged.events.map((e) => A.eventId(e.body)))
    ok(merged.events.length <= cap, 'merge: bounded under the high-height flood')
    ok(realW.every((e) => kept.has(A.eventId(e.body))), 'merge: ALL real events (genesis + h1..h6) survive the height-999999 flood (defect 5: attacker height cannot evict the real linked spine)')
    ok(kept.has(realHeadId), 'merge: the real head (h6) is not evicted by the flood')

    // (round 4) a SINGLE LINKING forgery must not collapse the preserved spine.
    // The round-3 walk followed the UNIQUE successor and ended at the first
    // fork, so ONE forged event claiming prev = realGenesisId turned the whole
    // spine into genesis-only, and the disconnected height-999999 flood then
    // evicted the real h1..h6 anyway. The walk is now a reachable-set over
    // chain-shaped links (prev matches AND height steps +1): a forged SIBLING
    // costs the attacker one spine slot but never unseats the real branch, and
    // a "link" at a non-contiguous height is off-spine, not a walk-stopper.
    const linkForge = forge({ v: 1, lane: 'w', type: 'revoke', root: sub.root.pubB, key: sub.dev.pubB, height: 1, prev: realGid, ts: 424242, payload: { pub: fakeId('r4-lf') } })
    const offShape = forge({ v: 1, lane: 'w', type: 'revoke', root: sub.root.pubB, key: sub.dev.pubB, height: 999999, prev: realGid, ts: 424243, payload: { pub: fakeId('r4-os') } })
    let m4 = S.storageMerge({ v: 1, events: [...realW, linkForge, offShape], certs: [certEv] }, { v: 1, events: hiFlood.slice(0, cap), certs: [certEv] }, 'events', subjId)
    m4 = S.storageMerge(m4, { v: 1, events: hiFlood.slice(cap), certs: [certEv] }, 'events', subjId)
    const kept4 = new Set(m4.events.map((e) => A.eventId(e.body)))
    ok(m4.events.length <= cap, 'merge: bounded under the flood + linking forgeries')
    ok(realW.every((e) => kept4.has(A.eventId(e.body))), 'merge: ALL real events (genesis + h1..h6, incl. the real head) survive the flood even with a FORGED h1 SIBLING linked to genesis (round 4: one linking forgery cannot collapse the spine to genesis-only and hand the flood the eviction)')
    ok(kept4.has(realHeadId), 'merge: the real head (h6) survives the linking-forgery flood')
  }

  console.log('\n· 5a. snapshot advance + downgrade/fork replay network-wide …')
  {
    // Owner writes one more witnessed event → snapshot 2 (height 2) supersedes.
    let c2p = A.appendWitnessed(subChain, sub.dev.priv, sub.dev.pubB, 'revoke', { pub: fakeId('gone-2') }, 1200)
    const h2Plain = c2p.events[c2p.events.length - 1]
    const h2Att = attest(h2Plain, sub.wit, 1205)
    const chain2 = { root: c2p.root, events: c2p.events.map((e) => (e === h2Plain ? h2Att : e)) }
    const fs2 = await S.finalSync(nodes[3].node, chain2, h2Att, [certEv], sub.dev.priv)
    eq(fs2.header.height, 2, 'snapshot 2 binds the advanced head')
    ok(fs2.perIdx.every((c) => c >= S.PARAMS_A3.replicateK - 1),
      'a FRESHER snapshot replaces through every honest gate (≥ replicateK−1: the refuse-all attacker now lurks in some closest-8 windows)')
    {
      // A fresh prober (no local holdings) resolves closest-first: every row it
      // reaches is the height-2 snapshot, and shard space reconstructs the NEW
      // chain. (A pre-viewer holder crowded out of the closest-8 window may
      // keep a stale copy locally. It sits outside the duty window and behind
      // 8 fresher holders, so resolution never surfaces it.)
      const probe = makeShardNode(fab, 'probe-h2')
      await probe.node.bootstrap()
      const rows2 = []
      for (let idx = 0; idx < 40; idx++) {
        const got = await probe.node.get(S.shardKey(subjectId, idx), 'shard')
        if (got !== null && S.verifyShardEnvelope(got) === 'ok' && got.header.height === 2) rows2.push(got.shard)
      }
      eq(rows2.length, 40, 'every row a fresh prober resolves is the height-2 snapshot (fresher replaces network-wide)')
      const blob2 = S.reconstructTolerant(rows2)
      ok(blob2 !== null && shaB(blob2) === shaB(A.chainToBytes(chain2)), 'shard space now reconstructs the ADVANCED chain bit-identically')
    }
    const now0 = await nodes[6].node.get(key0, 'shard')
    eq(now0.header.height, 2, 'the row at key 0 is now the height-2 row')
    const atk = makeShardNode(fab, 'attacker-2', { validator: () => false })
    await atk.node.bootstrap()
    eq(await atk.node.put(key0, 'shard', clone(envsMain[0])), 0, 'replaying the STALE height-1 row stores nowhere (downgrade refused network-wide)')
    // Same-height fork: a second witnessed event at height 2 (equivocation),
    // attested by a rogue witness: the context-free floor admits it as a HEAD,
    // but holders of the honest height-2 row refuse the fork (first-held wins).
    const forkPlain = A.signBody({ ...h2Plain.body, ts: h2Plain.body.ts + 7 }, sub.dev.priv)
    const forkAtt = attest(forkPlain, sub.wit, 1210)
    const chainFork = { root: chain2.root, events: chain2.events.map((e) => (e === h2Att ? forkAtt : e)) }
    const forkHeader = S.cutSnapshot(chainFork, forkAtt, [certEv], sub.dev.priv)
    const forkEnvs = S.shardJob(forkHeader, A.chainToBytes(chainFork))
    eq(S.verifyShardEnvelope(forkEnvs[0]), 'ok', 'sanity: the fork row verifies stand-alone (equivocation is not detectable per-row)')
    eq(await atk.node.put(key0, 'shard', forkEnvs[0]), 0, 'a same-height FORK row stores nowhere over the held honest row (first-held wins; §8 adjudicates forks)')
    const still = await nodes[8].node.get(key0, 'shard')
    eq(still.header.headId, fs2.header.headId, 'the honest height-2 row survives both replay attacks')
  }

  // ==========================================================================
  console.log('\n· 6. reconstructTolerant, any 12 of 40, corruption, floors …')
  // ==========================================================================
  {
    const blob = Uint8Array.from({ length: 2531 }, (_, i) => (i * 31 + 7) & 0xff)
    const shards = S.encode(blob, 12, 40)
    const want = shaB(blob)
    const pick = (ids) => ids.map((i) => clone(shards[i]))
    const subsets = [
      ['all-data rows 0..11', Array.from({ length: 12 }, (_, i) => i)],
      ['ALL-PARITY rows 28..39', Array.from({ length: 12 }, (_, i) => 28 + i)],
      ['stride 0,3,…,33', Array.from({ length: 12 }, (_, i) => i * 3)],
      ['worst mix 0..10 + 39', [...Array.from({ length: 11 }, (_, i) => i), 39]],
      ['interleaved ends', [0, 39, 1, 38, 2, 37, 3, 36, 4, 35, 5, 34]],
    ]
    for (const [name, ids] of subsets) {
      const got = S.reconstructTolerant(pick(ids))
      ok(got !== null && shaB(got) === want, `subset ${name} reconstructs bit-identically`)
    }
    {
      const rev = pick(subsets[2][1]).reverse()
      const got = S.reconstructTolerant(rev)
      ok(got !== null && shaB(got) === want, 'arrival order does not matter (reversed set reconstructs identically)')
    }
    {
      // 13 rows, one corrupted same-length: the end-to-end hash gate detects
      // it; deterministic leave-one-out excludes it; the result is verified.
      const set = pick([0, 5, 9, 13, 17, 20, 22, 25, 28, 31, 34, 37, 39])
      const bad = A.fromB64u(set[4].body); bad[10] ^= 0x55; set[4].body = b64(bad)
      const got = S.reconstructTolerant(set)
      ok(got !== null && shaB(got) === want, 'a corrupt row among 13 is detected via the integrity hash and EXCLUDED, output verified')
    }
    {
      const set = pick([0, 5, 9, 13, 17, 20, 22, 25, 28, 31, 34, 37])
      const bad = A.fromB64u(set[0].body); bad[0] ^= 1; set[0].body = b64(bad)
      eq(S.reconstructTolerant(set), null, 'exactly 12 rows with one corrupt → honest null (below K after exclusion, never a wrong blob)')
    }
    eq(S.reconstructTolerant(pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), null, '11 rows (below K_rec=12) → null')
    {
      const set = pick([0, 5, 9, 13, 17, 20, 22, 25, 28, 31, 34, 37])
      const dup = clone(shards[5]); const db = A.fromB64u(dup.body); db[3] ^= 9; dup.body = b64(db)
      const got = S.reconstructTolerant([...set, dup])
      ok(got !== null && shaB(got) === want, 'a conflicting duplicate idx is treated as an erasure and healed around')
    }
    {
      const junk = clone(shards[2]); junk.dataHash = flip(junk.dataHash)
      const got = S.reconstructTolerant([...pick([0, 5, 9, 13, 17, 20, 22, 25, 28, 31, 34, 37]), junk])
      ok(got !== null && shaB(got) === want, 'a mixed-framing junk row is treated as an erasure and healed around')
    }
    eq(S.reconstructTolerant([]), null, 'an empty set → null (never throws)')
    eq(S.reconstructTolerant([{ v: 9 }]), null, 'garbage rows → null (never throws)')
  }

  // ==========================================================================
  console.log('\n· 7. runRepair over a 20-node harness (k=3, n=8, dutyK=1) …')
  // ==========================================================================
  {
    const STALE = 600_000
    const GEO = { k: 3, n: 8 }
    const ROPT = { ...GEO, dutyK: 1, repairHeadroom: 2 } // heal band: 3 ≤ live < 5
    const rfab = new W.MockFabric({ staleAfterMs: STALE })
    const rnodes = Array.from({ length: 20 }, (_, i) =>
      makeShardNode(rfab, 'rep-' + i, { replicateK: 1 }, { verify: GEO }))
    for (const n of rnodes) await n.node.bootstrap()
    const keys = Array.from({ length: 8 }, (_, i) => S.shardKey(subjectId, i))
    const alive = new Set(rnodes)
    const kill = async (n) => { alive.delete(n); await n.node.close(); await n.ep.close() }
    const refresh = (ts) => { for (const n of alive) n.announce(ts) }
    const holdersOf = (idx) => [...alive].filter((n) => n.node.localGet(keys[idx], 'shard') !== null)
    const liveRows = () => keys.map((_, i) => i).filter((i) => holdersOf(i).length > 0)
    const ctxOf = (n) => ({ node: n.node, directory: n.ep.directory(), subjects: [subjectId], opts: ROPT })

    const fs = await S.finalSync(rnodes[0].node, subChain, headAtt, [certEv], sub.dev.priv, GEO)
    ok(fs.perIdx.every((c) => c === 1), 'replicateK=1 seam: every row stored on exactly one node (fully controllable churn)')
    eq(liveRows().length, 8, 'all 8 rows are live after the final sync')

    eq((await S.runRepair({ ...ctxOf(rnodes[0]), subjects: [] }, NOW)).length, 0, 'an empty subject list ticks to an empty action list')
    eq((await S.runRepair({ ...ctxOf(rnodes[0]), subjects: [subjectId, subjectId] }, NOW)).length, 1, 'duplicate subjects collapse to one scan')

    // --- healthy
    const holder0 = holdersOf(0)[0]
    const healthy = (await S.runRepair(ctxOf(holder0), NOW))[0]
    eq(healthy.outcome, 'healthy', 'live=8 ≥ kRec+headroom=5 → healthy')
    eq(healthy.live, 8, 'healthy tick observed all 8 rows')
    eq(healthy.redistributed.length, 0, 'healthy tick redistributes nothing')
    eq(healthy.headId, fs.header.headId, 'healthy tick reports the freshest snapshot head')
    eq(JSON.stringify(await S.runRepair(ctxOf(holder0), NOW)), JSON.stringify([healthy]), 'a repeated tick is bit-deterministic given identical inputs')

    // --- not-on-duty
    const dutyNow = new Set()
    for (let i = 0; i < 8; i++) for (const id of S.dutyCarriers(subjectId, i, rnodes[0].ep.directory(), { nowMs: NOW, dutyK: 1 })) dutyNow.add(id)
    const bystander = rnodes.find((n) => !dutyNow.has(n.nodeId) && n.gate.subjects().length === 0)
    ok(bystander !== undefined, 'sanity: a node exists that neither carries duty nor holds rows')
    eq((await S.runRepair(ctxOf(bystander), NOW))[0].outcome, 'not-on-duty', 'a non-carrier holding nothing reports not-on-duty (no scan work)')

    // --- eviction = churn: kill row holders until 3 ≤ live < 5
    const holderNode = keys.map((_, i) => holdersOf(i)[0])
    for (let idx = 7; idx >= 0 && liveRows().length > 4; idx--) {
      const h = holderNode[idx]
      if (!alive.has(h)) continue
      const kills = keys.filter((_, i) => alive.has(holderNode[i]) && holderNode[i] === h).length
      if (liveRows().length - kills >= 3) await kill(h)
    }
    const liveAfterChurn = liveRows()
    ok(liveAfterChurn.length >= 3 && liveAfterChurn.length < 5, `churn dropped live rows into the heal band (${liveAfterChurn.length} of 8)`)
    const T2 = NOW + 3_600_000
    refresh(T2) // survivors re-announce; the dead age out of the duty view
    const repairer = [...alive].find((n) => n.gate.subjects().includes(subjectId) && liveAfterChurn.some((i) => holdersOf(i).includes(n)))
    ok(repairer !== undefined, 'sanity: a surviving holder exists to run the tick')
    const missing = keys.map((_, i) => i).filter((i) => !liveAfterChurn.includes(i))
    const healed = (await S.runRepair(ctxOf(repairer), T2))[0]
    eq(healed.outcome, 'healed', 'live under kRec+headroom with ≥ kRec survivors → healed')
    eq(healed.live, liveAfterChurn.length, 'the tick observed exactly the surviving rows')
    ok(sameIds(healed.redistributed, missing), `the missing rows [${missing}] were re-encoded and re-stored (ascending idx)`)
    eq(healed.stored, missing.length, 'every redistributed row was accepted by its new carrier (replicateK=1 → one store each)')
    eq(healed.headId, fs.header.headId, 'healing preserved the snapshot identity (same countersigned head)')
    eq(liveRows().length, 8, 'after the heal every row is live again')
    {
      let redistributedRight = true
      for (const i of missing) {
        const carrier = S.dutyCarriers(subjectId, i, repairer.ep.directory(), { nowMs: T2, dutyK: 1 })[0]
        const held = [...alive].find((n) => n.nodeId === carrier)?.node.localGet(keys[i], 'shard')
        if (!held || S.verifyShardEnvelope(held, GEO) !== 'ok' || held.shard.idx !== i) redistributedRight = false
      }
      ok(redistributedRight, 'every healed row landed on the CURRENT duty carrier for its key, verified')
      const viewer = [...alive].find((n) => n !== repairer)
      const rows = []
      for (const k of keys) {
        const got = await viewer.node.get(k, 'shard')
        if (got !== null && S.verifyShardEnvelope(got, GEO) === 'ok') rows.push(got.shard)
      }
      const blob = S.reconstructTolerant(rows)
      ok(blob !== null && shaB(blob) === shaB(subChainBytes), 'END TO END: eviction = churn = healed. The chain reconstructs bit-identically after repair')
    }
    eq((await S.runRepair(ctxOf(repairer), T2))[0].outcome, 'healthy', 'the tick after a heal reports healthy (repair converges, no oscillation)')

    // --- unrecoverable (≥1 row) then unrecoverable (0 rows)
    const T3 = T2 + 3_600_000
    while (liveRows().length > 2) {
      const i = liveRows()[liveRows().length - 1]
      await kill(holdersOf(i)[0])
    }
    refresh(T3)
    const survivorHolder = [...alive].find((n) => liveRows().some((i) => holdersOf(i).includes(n)))
    const unrec = (await S.runRepair(ctxOf(survivorHolder), T3))[0]
    eq(unrec.outcome, 'unrecoverable', 'live<kRec=3 → unrecoverable (honest unavailability, no crash, no truncation)')
    ok(unrec.live >= 1 && unrec.live < GEO.k,
      `the report carries the observed live count (${unrec.live}): ≥1 seen, under kRec (observation may honestly undercount held rows once routing decays under churn)`)
    eq(unrec.redistributed.length, 0, 'nothing is redistributed below kRec')
    const T4 = T3 + 3_600_000
    while (liveRows().length > 0) await kill(holdersOf(liveRows()[0])[0])
    refresh(T4)
    const dutyCarrier0 = [...alive].find((n) => S.isOnDuty(n.nodeId, subjectId, 0, n.ep.directory(), { nowMs: T4, dutyK: 1 }))
    ok(dutyCarrier0 !== undefined, 'sanity: a live on-duty node exists after total row loss')
    const gone = (await S.runRepair(ctxOf(dutyCarrier0), T4))[0]
    ok(gone.outcome === 'unrecoverable' && gone.live === 0, 'zero surviving rows → unrecoverable with live=0 (reported, never dropped)')
  }

  // ==========================================================================
  console.log('\n· 7a. heal-incomplete: reconstructed but every re-store refused …')
  // ==========================================================================
  {
    // Defect C: when the heal band is reached but the missing rows' carriers
    // all refuse (over budget), stored==0: the outcome must be 'heal-incomplete',
    // never a false 'healed' a scheduler would treat as safe.
    const GEO2 = { k: 3, n: 8 }
    const ROPT2 = { ...GEO2, dutyK: 1, repairHeadroom: 2 } // heal band: 3 ≤ live < 5
    const hdr8 = S.cutSnapshot(subChain, headAtt, [certEv], sub.dev.priv, GEO2)
    const envs8 = S.shardJob(hdr8, subChainBytes)
    const keys8 = Array.from({ length: 8 }, (_, i) => S.shardKey(subjectId, i))
    const fk = kpOf('heal-incomplete-node')
    const fkDev = kpOf('heal-incomplete-dev')
    const dm = W.makeDirectory(600_000)
    dm.ingest(W.signPresence(
      { v: 1, root: fk.pubB, key: fkDev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
      fkDev.priv,
    ), NOW)
    const liveByKey = new Map()
    for (let i = 0; i < 4; i++) liveByKey.set(keys8[i], envs8[i]) // 4 live rows = heal band
    // A carrier on duty (sole capacity node) that holds the live rows but whose
    // every re-store is refused (put → 0).
    const fakeNode = {
      nodeId: W.nodeIdOf(fk.pub),
      localGet: (key) => liveByKey.get(key) ?? null,
      get: async (key) => liveByKey.get(key) ?? null,
      put: async () => 0,
    }
    const acts = await S.runRepair({ node: fakeNode, directory: dm.directory, subjects: [subjectId], opts: ROPT2 }, NOW)
    eq(acts.length, 1, 'the tick scanned the subject')
    eq(acts[0].outcome, 'heal-incomplete', 'reconstructed but every re-store refused (stored==0) → heal-incomplete, NOT a false healed')
    eq(acts[0].stored, 0, '…and stored is 0 (nothing re-replicated: a scheduler must escalate, not mark safe)')
    eq(acts[0].redistributed.length, 4, 'the 4 missing rows were attempted (redistributed list is honest)')
    eq(acts[0].live, 4, 'live reports the 4 observed rows')
  }

  // ==========================================================================
  console.log('\n· 7b. repair iterates snapshot groups + rejects unresolvable chains …')
  // ==========================================================================
  {
    const GEO3 = { k: 3, n: 8 }
    const ROPT3 = { ...GEO3, dutyK: 1, repairHeadroom: 2 } // heal band: 3 ≤ live < 5
    const keys8 = Array.from({ length: 8 }, (_, i) => S.shardKey(subjectId, i))
    const fk = kpOf('repair-group-node'); const fkDev = kpOf('repair-group-dev')
    const dm = W.makeDirectory(600_000)
    dm.ingest(W.signPresence(
      { v: 1, root: fk.pubB, key: fkDev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
      fkDev.priv,
    ), NOW)
    const mkFakeNode = (byKey, putRet = 1) => ({
      nodeId: W.nodeIdOf(fk.pub),
      localGet: (key) => byKey.get(key) ?? null,
      get: async (key) => byKey.get(key) ?? null,
      put: async () => putRet,
    })

    // --- MULTI-GROUP (the round-1 critical/major repair fix, previously UNPINNED):
    // a partial NEWER snapshot (below kRec) sits over an intact OLDER one. Repair
    // must SKIP the freshest-but-starved group and heal the older RECONSTRUCTABLE
    // one: pre-fix it committed to the single tie-broken freshest group and
    // reported 'unrecoverable', stranding a recoverable snapshot.
    {
      const hdr1 = S.cutSnapshot(subChain, headAtt, [certEv], sub.dev.priv, GEO3) // height 1
      const envs1 = S.shardJob(hdr1, subChainBytes)
      const c2p = A.appendWitnessed(subChain, sub.dev.priv, sub.dev.pubB, 'revoke', { pub: fakeId('grp-gone-2') }, 1400)
      const h2p = c2p.events[c2p.events.length - 1]
      const h2a = attest(h2p, sub.wit, 1405)
      const chain2 = { root: c2p.root, events: c2p.events.map((e) => (e === h2p ? h2a : e)) }
      const hdr2 = S.cutSnapshot(chain2, h2a, [certEv], sub.dev.priv, GEO3) // height 2
      const envs2 = S.shardJob(hdr2, A.chainToBytes(chain2))
      const byKey = new Map()
      byKey.set(keys8[0], envs2[0]); byKey.set(keys8[1], envs2[1]) // height-2 group: 2 rows < kRec=3
      for (let i = 2; i < 8; i++) byKey.set(keys8[i], envs1[i]) // height-1 group: 6 rows ≥ kRec
      const act = (await S.runRepair({ node: mkFakeNode(byKey), directory: dm.directory, subjects: [subjectId], opts: ROPT3 }, NOW))[0]
      ok(act.outcome !== 'unrecoverable', 'repair does NOT commit to the below-kRec freshest group and give up (round-1 multi-group fix, now pinned)')
      eq(act.height, 1, 'repair heals from the OLDER reconstructable snapshot (height 1), not the starved height-2 group')
      eq(act.headId, hdr1.headId, '…reporting the older group’s committed head')
      eq(act.outcome, 'healed', 'the older group reconstructs and its missing rows re-store → healed')
      ok(sameIds(act.redistributed, [0, 1]), 'exactly the height-2-occupied slots were re-encoded from the older snapshot')
    }

    // --- UNRESOLVABLE CHAIN: a publisher finalSyncs a structurally-serializable
    // but SEMANTICALLY-INVALID chain (an interior witnessed event dropped → lane
    // gap). Every envelope verifies (real head, real commit, real per-row body)
    // and the group reconstructs, but verifyChain FAILS, so no viewer can resolve
    // it. Repair must NOT report healed/healthy; it must match the viewer's
    // 'bad-chain' (repair's health verdict tracks viewer resolvability).
    {
      const c3 = A.appendWitnessed(subChain, sub.dev.priv, sub.dev.pubB, 'revoke', { pub: fakeId('gap-2') }, 1500)
      const gap2p = c3.events[c3.events.length - 1]
      const gap2a = attest(gap2p, sub.wit, 1505)
      const gappy = { root: c3.root, events: c3.events.filter((e) => !(e.body.lane === 'w' && e.body.height === 1)).map((e) => (e === gap2p ? gap2a : e)) }
      ok(!A.verifyChain(gappy).ok, 'sanity: the gappy chain FAILS verifyChain (witnessed lane gap) yet serializes')
      const gappyBytes = A.chainToBytes(gappy)
      const hdrGap = S.cutSnapshot(gappy, gap2a, [certEv], sub.dev.priv, GEO3)
      const envsGap = S.shardJob(hdrGap, gappyBytes)
      eq(S.verifyShardEnvelope(envsGap[0], GEO3), 'ok', 'sanity: every gappy-snapshot envelope still verifies at the gate (real head + commit + body)')
      const byKey = new Map()
      for (let i = 0; i < 5; i++) byKey.set(keys8[i], envsGap[i]) // 5 rows ≥ kRec=3, reconstructs
      const act = (await S.runRepair({ node: mkFakeNode(byKey), directory: dm.directory, subjects: [subjectId], opts: ROPT3 }, NOW))[0]
      eq(act.outcome, 'unrecoverable', "repair reports 'unrecoverable' for a reconstructable-but-verify-FAILING chain, never a false 'healed'")
      eq(act.redistributed.length, 0, '…and re-replicates nothing (no budget spent maintaining a snapshot no viewer can accept)')
      const vres = await S.readChainFromShards({ get: async (k) => byKey.get(k) ?? null }, sub.root.pubB, GEO3)
      ok(vres.chain === undefined && vres.report.reason === 'bad-chain', 'readChainFromShards rejects the identical rows as bad-chain, repair and viewer now agree')
    }
  }

  // ==========================================================================
  console.log('\n· 8. browser parity: the shard decision core …')
  // ==========================================================================
  {
    const coreNode = await bundleAndImport(outNode, PARITY_ENTRY, 'node')
    const coreBrowser = await bundleAndImport(outBrowser, PARITY_ENTRY, 'browser')
    const dNode = coreNode.runShardScript()
    const dBrowser = coreBrowser.runShardScript()
    eq(dNode, dBrowser, 'node and browser bundles produce the identical decision digest (keys, verdicts, duty, reconstruct, merge)')
    const refs = findNodeBuiltinRefs(readBundle(resolve(outBrowser, 'bundle.mjs')))
    eq(refs.length, 0, 'the browser bundle of the shard core carries zero node built-ins')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
