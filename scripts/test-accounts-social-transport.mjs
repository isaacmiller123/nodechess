// THE A7 SOCIAL-TRANSPORT SUITE: kickoff brick 1 (spec §10/§3/§5, C-3).
//
//   node scripts/test-accounts-social-transport.mjs
//
// Proves the social transport end to end, mock-pair style (multi-client
// MockFabric networks, real ed25519 identities, real overlay nodes with the
// composed social store gate, real relays calling the pure mailboxAdmit/
// mailboxDrain at the boundary with edgeMicro from the §10 fold):
//   0. static discipline guards + overlay-key domain separation;
//   1. edge-strength fold: fresh root ≡ 0 STRUCTURALLY, entanglement/friend/
//      trust terms, caps, clamps, fail-closed matrix;
//   2. presence: store-gate refusal matrix (unsigned, forged, ttl-cap,
//      future, expired, malformed, foreign-key) + END-TO-END freshest-wins
//      across two publishing nodes and a third reader;
//   3. friend-edge countersignature exchange RIDING THE MAILBOX, end to end:
//      request → drain → consent → drain → adopt → BOTH chains append →
//      mutually-readable edge (areFriends); forged + cross-pair-replayed
//      countersignatures refused at every seam;
//   4. mailbox relaying, THE KICKOFF SENTENCE AS AN EXECUTABLE ASSERT,
//      through the relay: "a sybil flood can't evict an established root's
//      request before the offline recipient next syncs"; plus the converse
//      (established displaces sybil mail), authenticated drain (forged sig /
//      replayed ts refused, boxes actually clear), and the relay-boundary
//      refusal matrix (bad-sig, oversize, self-mail, duplicate, rate-limit);
//   5. determinism: two identical fresh networks driven through the same
//      sequence produce byte-identical relay states and results;
//   6. browser parity: the decision core bundled platform:'browser' produces
//      the identical transcript digest and carries zero node built-ins.
//
// House style: esbuild-bundle on the fly, one-line asserts, exit(1) on fail.
// Test identities are RAW fixed 32-byte seeds → ed25519 (never argon2).

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

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as S from '@shared/accounts/storage'
export * as SOC from '@shared/accounts/social'
export * as SEG from '@shared/accounts/segment'
`

// Byte-determinism anchors for the fixed seed 'stp-gold' (recorded from a
// green run; a change to a tag, the hashing, or b64u breaks these everywhere
// at once). Filled by section 0.
const GOLDEN_PRESENCE_KEY = 'oP638-xZJHRL7NZEUoIbqdE6btqXa6-ZhJJIbLdfr48'
const GOLDEN_MAILBOX_KEY = '938tgqd_sp09kbrwQUedUj_14jspXvXjBYAJS0T5pKI'

// The pure decision core bundled twice (platform node vs browser), driven
// through one scripted sequence: transcripts must match byte-for-byte, and
// the browser bundle must carry zero node built-ins.
const PARITY_ENTRY = `
import { canonicalBytes, ed25519, sha256, toB64u, utf8 } from '@shared/accounts'
import {
  EDGE_FRIEND_MICRO, decodeFriendHalf, edgeStrengthMicro, encodeFriendHalf,
  mailId, mailboxKeyOfRoot, makeFriendHalf, makeSocialPresenceRow,
  presenceKeyOfRoot, presenceRowClaim, signMail, signSocialPresence,
  verifyDrainedMail, verifyFriendHalf,
} from '@shared/accounts/social'

export function runSocialTransportParityScript(): string {
  const seed = (t: string) => sha256(utf8(t))
  const kp = (t: string) => {
    const priv = seed(t)
    return { priv, pubB: toB64u(ed25519.getPublicKey(priv)) }
  }
  const log: string[] = []
  const G = kp('stp-gold')
  const A = kp('stp-parity-a')
  const B = kp('stp-parity-b')
  const C = kp('stp-parity-c')

  log.push('pkey:' + presenceKeyOfRoot(G.pubB))
  log.push('mkey:' + mailboxKeyOfRoot(G.pubB))

  const parts = (over: object) => ({
    friendMutual: false, entangledGames: 0, trustMicro: 0, trustBaselineMicro: 0,
    repScore: 0, repBaselineScore: 0, ...over,
  })
  log.push('e0:' + edgeStrengthMicro(parts({})))
  log.push('ef:' + edgeStrengthMicro(parts({ friendMutual: true })))
  log.push('eg:' + edgeStrengthMicro(parts({ entangledGames: 9 })))
  log.push('emax:' + edgeStrengthMicro(parts({ friendMutual: true, entangledGames: 4, trustMicro: 1_000_000, repScore: 100 })))
  log.push('ebad:' + edgeStrengthMicro(parts({ trustMicro: 1_000_001, repScore: -1 })))
  log.push('efm:' + (EDGE_FRIEND_MICRO === 600_000))

  const half = makeFriendHalf({ selfRoot: A.pubB, peerRoot: B.pubB, key: A.pubB, priv: A.priv })
  const enc = encodeFriendHalf(half)
  log.push('half:' + (decodeFriendHalf(enc) !== null))
  log.push('half-x:' + (verifyFriendHalf({ ...half, to: C.pubB }) === null))
  log.push('half-sig:' + (verifyFriendHalf({ ...half, sig: (half.sig[0] === 'A' ? 'B' : 'A') + half.sig.slice(1) }) === null))

  const env = { v: 1 as const, sender: A.pubB, recipient: B.pubB, kind: 'friend-request', payload: enc, sentTs: 1_750_000_000_000 }
  const sm = signMail(env, A.priv)
  const stored = { id: mailId(env), sender: A.pubB, kind: env.kind, payload: env.payload, sig: sm.sig, sentTs: env.sentTs, arrivedWts: 1_750_000_001_000, edgeMicro: 50_000 }
  log.push('dm:' + (verifyDrainedMail(stored, B.pubB) !== null))
  log.push('dm-rebind:' + (verifyDrainedMail(stored, C.pubB) === null))
  log.push('dm-sig:' + (verifyDrainedMail({ ...stored, sig: (stored.sig[0] === 'A' ? 'B' : 'A') + stored.sig.slice(1) }, B.pubB) === null))

  const sp = signSocialPresence({ v: 1, root: G.pubB, status: 'online', ts: 1_750_000_000_000, ttlMs: 60_000 }, G.priv)
  const row = makeSocialPresenceRow(sp)
  log.push('row:' + (presenceRowClaim(row, presenceKeyOfRoot(G.pubB)) !== null))
  log.push('row-fk:' + (presenceRowClaim(row, presenceKeyOfRoot(A.pubB)) === null))
  return log.join('|')
}
`

async function main() {
  const outdir = makeOutdir('accounts-social-transport-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(`\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`)
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W, O, S, SOC, SEG } = M
  const b64 = A.toB64u
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const idLike = (tag) => b64(seed32(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: b64(pub) }
  }
  const canon = (v) => b64(A.canonicalHash(v))
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)

  const T0 = 1_750_000_000_000
  const WTS = T0 + 5_000
  const NOW = T0 + 10_000

  // Small suite mailbox geometry: floods overflow fast, semantics unchanged.
  const P_MBX = {
    v: 1, rateWindowMs: 3_600_000, ratePerWindow: 8, boxCap: 8, perSenderPerBox: 2,
    recipientsCap: 64, sendersCap: 256, retentionMs: 14 * 86_400_000, payloadMaxChars: 2048,
  }

  // --- shared chain fixtures -----------------------------------------------
  const wit = kpOf('stp-witness')
  const attOf = (ev) => W.makeAttestation(A.eventId(ev.body), 0, wit.pubB, wit.priv, WTS)
  const attachWit = (ch) => {
    const last = ch.events[ch.events.length - 1]
    return { root: ch.root, events: [...ch.events.slice(0, -1), { ...last, wit: [attOf(last)] }] }
  }
  const segPayload = (tag, opp, oppName) => {
    const game = idLike('stp-game-' + tag)
    const transcript = SEG.transcriptDigest(game, [], '1-0', 'resign')
    return SEG.makeSegmentPayload({
      game, opp, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike('hw-' + tag), height: 0 }, b: { head: idLike('hb-' + tag), height: 0 } },
      wstream: SEG.signWitnessEnd(wit.priv, wit.pubB, game, '1-0', 0, transcript),
      oppProfile: { name: oppName },
    })
  }
  const genesisChain = (tag, kp, name) =>
    A.createAccountChain({
      rootPriv: kp.priv, rootPub: kp.pub, displayName: name, ts: T0,
      device: { pub: kpOf(tag + '-dev').pubB, index: 0 },
    })
  const withSegs = (tag, kp, name, opps) => {
    let ch = genesisChain(tag, kp, name)
    opps.forEach((opp, i) => {
      ch = attachWit(A.appendWitnessed(ch, kp.priv, kp.pubB, 'segment', segPayload(tag + '-' + i, opp, 'Opp'), T0 + 1000 + i))
    })
    return ch
  }

  const E = kpOf('stp-est') // the established sender
  const R = kpOf('stp-recip') // flood-target recipient (offline until sync)
  const R2 = kpOf('stp-recip2') // converse-test recipient
  const R3 = kpOf('stp-recip3') // refusal-matrix recipient
  const fA = kpOf('stp-friend-a')
  const fB = kpOf('stp-friend-b')
  const fC = kpOf('stp-friend-c')
  const atk = kpOf('stp-attacker')

  const chainE = withSegs('ce', E, 'Established', [R.pubB, R.pubB, R2.pubB])
  const chainR = genesisChain('cr', R, 'Recipient')
  const chainR2 = genesisChain('cr2', R2, 'RecipientTwo')
  ok(A.verifyChain(chainE).ok, 'fixture: established sender chain (2 games vs R, 1 vs R2) verifies')

  // ==========================================================================
  console.log('\n· 0. static discipline guards + key domain separation …')
  // ==========================================================================
  {
    for (const f of ['src/shared/accounts/social/transport.ts', 'src/shared/accounts/social/edgeStrength.ts']) {
      const src = readFileSync(resolve(ROOT, f), 'utf8')
      ok(!/\bDate\.now\s*\(|\bMath\.random\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(|\bperformance\.now\s*\(/.test(src),
        `${f.split('/').pop()} calls no ambient time, randomness, or timers (clocks are the caller’s)`)
      ok(!/from 'node:|from "node:/.test(src), `${f.split('/').pop()} imports no node: builtins (platform-neutral)`)
    }
    const g = kpOf('stp-gold')
    eq(SOC.presenceKeyOfRoot(g.pubB), GOLDEN_PRESENCE_KEY, 'presenceKeyOfRoot(fixed seed) matches the recorded golden')
    eq(SOC.mailboxKeyOfRoot(g.pubB), GOLDEN_MAILBOX_KEY, 'mailboxKeyOfRoot(fixed seed) matches the recorded golden')
    const keys = [SOC.presenceKeyOfRoot(g.pubB), SOC.mailboxKeyOfRoot(g.pubB), W.nodeIdOf(g.pubB), S.pointerKeyOfRoot(g.pubB)]
    eq(new Set(keys).size, 4, 'presence, mailbox, events (nodeId), and pointer keys are pairwise domain-separated')
    throws(() => SOC.presenceKeyOfRoot('short'), 'presenceKeyOfRoot throws on a non-32-byte root (builders throw)')
    throws(() => SOC.mailboxKeyOfRoot('short'), 'mailboxKeyOfRoot throws on a non-32-byte root (builders throw)')
  }

  // ==========================================================================
  console.log('\n· 1. edge-strength fold (§10): fresh ≡ 0, earned terms, clamps …')
  // ==========================================================================
  {
    const edge = (sender, recipient, sc, rc, extra = {}) =>
      SOC.edgeMicroOfChains({ sender, recipient, senderChain: sc, recipientChain: rc, atWts: NOW, ...extra })

    const fresh = kpOf('stp-fresh')
    const chainFresh = genesisChain('cf', fresh, 'Fresh')
    eq(edge(fresh.pubB, R.pubB, chainFresh, chainR), 0, 'a FRESH root (verified genesis-only chain) derives edge EXACTLY 0, structurally, not empirically')
    eq(edge(fresh.pubB, R.pubB, null, chainR), 0, 'an absent sender chain derives 0 (fail closed)')
    eq(edge(fresh.pubB, R.pubB, chainE, chainR), 0, 'a sender chain with the WRONG root derives 0 (fail closed)')
    const tampered = { root: chainE.root, events: chainE.events.map((e, i) => (i === 1 ? { ...e, sig: flip(e.sig) } : e)) }
    eq(edge(E.pubB, R.pubB, tampered, chainR), 0, 'an unverifiable (tampered) sender chain derives 0 (fail closed)')
    eq(edge(E.pubB, E.pubB, chainE, chainE), 0, 'sender === recipient derives 0')
    eq(edge(E.pubB, R.pubB, chainE, chainR, { atWts: -1 }), 0, 'malformed atWts derives 0 (fail closed)')

    eq(edge(E.pubB, R.pubB, chainE, chainR), 100_000, '2 witnessed games vs the recipient ⇒ 100_000 (50_000/game, from the sender’s own verified chain)')
    eq(edge(E.pubB, R2.pubB, chainE, chainR2), 50_000, '1 witnessed game vs the recipient ⇒ 50_000')
    eq(edge(E.pubB, fA.pubB, chainE, null), 0, 'established ELSEWHERE but a stranger to THIS recipient ⇒ 0 (no eligible predicate: no global-trust term)')
    const many = withSegs('cm', kpOf('stp-many'), 'Many', Array.from({ length: 6 }, () => R.pubB))
    eq(edge(kpOf('stp-many').pubB, R.pubB, many, chainR), 200_000, 'entanglement term caps at 4 games ⇒ 200_000')

    // The trust term is EARNED only through the verifier's own eligibility
    // predicate (A4-03/05): with one, witnessed evidence lifts the edge above
    // the entanglement floor; without one it contributes exactly 0 (above).
    const withElig = edge(E.pubB, fA.pubB, chainE, null, { eligible: () => true })
    ok(withElig > 0, `an eligibility predicate unlocks the earned global-trust term for a stranger (got ${withElig} > 0)`)

    // Mutual §3 friend edge: built locally exactly like the A6 social suite.
    let cA = genesisChain('cfa', fA, 'FriendA')
    let cB = genesisChain('cfb', fB, 'FriendB')
    const sigB = SOC.makeFriendSig(fB.priv, fA.pubB, fB.pubB)
    const sigA = SOC.makeFriendSig(fA.priv, fB.pubB, fA.pubB)
    cA = A.appendWitnessed(cA, fA.priv, fA.pubB, 'friend', SOC.makeFriendAddPayload({ peer: fB.pubB, key: fB.pubB, sig: sigB }), T0 + 2000)
    const cAonly = cA
    cB = A.appendWitnessed(cB, fB.priv, fB.pubB, 'friend', SOC.makeFriendAddPayload({ peer: fA.pubB, key: fA.pubB, sig: sigA }), T0 + 2001)
    eq(edge(fA.pubB, fB.pubB, cA, cB), 600_000, 'a MUTUAL witnessed friend edge ⇒ 600_000')
    eq(edge(fA.pubB, fB.pubB, cAonly, genesisChain('cfb2', fB, 'FriendB')), 0, 'a ONE-SIDED add is NOT an edge (mutual-read rule, a stale countersig mints no priority)')
    eq(edge(fA.pubB, fB.pubB, cA, null), 0, 'friend term needs BOTH chains: missing recipient chain ⇒ 0 (fail closed)')

    // The pure combiner: exact weights, clamps, fail-closed parts.
    const parts = (over) => ({ friendMutual: false, entangledGames: 0, trustMicro: 0, trustBaselineMicro: 0, repScore: 0, repBaselineScore: 0, ...over })
    eq(SOC.edgeStrengthMicro(parts({ friendMutual: true, entangledGames: 4, trustMicro: 1_000_000, repScore: 100 })), 1_000_000, 'all four terms at cap sum to exactly 1_000_000')
    eq(SOC.edgeStrengthMicro(parts({ trustMicro: 1_000_000 })), 120_000, 'trust term scale: full earned trust ⇒ 120_000')
    eq(SOC.edgeStrengthMicro(parts({ trustMicro: 500_000, trustBaselineMicro: 400_000 })), 12_000, 'trust term is the EARNED delta above the empty-chain baseline (100_000 ⇒ 12_000)')
    eq(SOC.edgeStrengthMicro(parts({ trustMicro: 300_000, trustBaselineMicro: 400_000 })), 0, 'worse-than-baseline trust clamps to 0: never negative, never below a sybil')
    eq(SOC.edgeStrengthMicro(parts({ repScore: 100 })), 80_000, 'reputation term scale: full earned score ⇒ 80_000')
    eq(SOC.edgeStrengthMicro(parts({ repScore: 60, repBaselineScore: 80 })), 0, 'worse-than-baseline reputation clamps to 0')
    eq(SOC.edgeStrengthMicro(parts({ trustMicro: 1_000_001 })), 0, 'out-of-range trust part fails closed to 0')
    eq(SOC.edgeStrengthMicro(parts({ entangledGames: -3 })), 0, 'negative games part fails closed to 0')
    eq(SOC.edgeStrengthMicro(parts({ entangledGames: Number.NaN })), 0, 'NaN part fails closed to 0')
  }

  // ==========================================================================
  console.log('\n· network fixture: 14 overlay nodes, social gates + relays …')
  // ==========================================================================
  const clock = { now: NOW }
  const chains = new Map()
  const chainOf = (root) => chains.get(root) ?? null
  const edgeOf = SOC.makeChainEdgeProvider({ chainOf })
  chains.set(E.pubB, chainE)
  chains.set(R.pubB, chainR)
  chains.set(R2.pubB, chainR2)

  function makeNet(tag, n, edgeProvider) {
    const fabric = new W.MockFabric()
    const nodes = []
    for (let i = 0; i < n; i++) {
      const root = kpOf(tag + '-root-' + i)
      const dev = kpOf(tag + '-dev-' + i)
      const nodeId = W.nodeIdOf(root.pubB)
      const ep = fabric.endpoint(nodeId)
      ep.announce(W.signPresence(
        { v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 },
        dev.priv,
      ))
      const gate = SOC.makeSocialStoreGate({ nowMs: () => clock.now })
      const node = O.createOverlayNode(ep, { root: root.pubB, key: dev.pubB }, { nowMs: () => clock.now, validator: gate.validator, merge: gate.merge })
      const relay = SOC.createSocialRelay(ep, { nowMs: () => clock.now, edgeMicroOf: edgeProvider, params: P_MBX })
      nodes.push({ root, dev, nodeId, ep, node, relay })
    }
    return { fabric, nodes }
  }

  const net = makeNet('stp-main', 14, edgeOf)
  for (const n of net.nodes) await n.node.bootstrap()
  const n0 = net.nodes[0]
  const relayByNodeId = new Map(net.nodes.map((n) => [n.nodeId, n.relay]))
  ok(net.nodes.every((n) => O.tableSize(n.node.table) > 0), 'all 14 tables nonempty after bootstrap')

  // ==========================================================================
  console.log('\n· 2. presence transport: gate matrix + freshest-wins END TO END …')
  // ==========================================================================
  {
    const P = kpOf('stp-presence-root')
    const pkey = SOC.presenceKeyOfRoot(P.pubB)
    const claim = (status, ts, ttlMs = 300_000, priv = P.priv) =>
      SOC.signSocialPresence({ v: 1, root: P.pubB, status, ts, ttlMs }, priv)

    // Store-gate refusal matrix at ONE node's own gate (localPut = the same
    // acceptStore path a wire store rides).
    const rowOf = (sp) => ({ v: 1, t: 'social-presence', claim: sp })
    ok(n0.node.localPut(pkey, 'record', rowOf(claim('online', clock.now))), 'gate: a live, root-signed claim under its own key is accepted')
    ok(!n0.node.localPut(pkey, 'record', rowOf({ ...claim('online', clock.now), sig: flip(claim('online', clock.now).sig) })), 'gate: a FORGED signature is refused (unsigned/spoofed records never stored)')
    ok(!n0.node.localPut(pkey, 'record', rowOf(claim('online', clock.now, 300_001))), 'gate: a ttl above the params cap is refused (no immortal presence)')
    ok(!n0.node.localPut(pkey, 'record', rowOf(claim('online', clock.now + 120_001))), 'gate: an implausibly-future claim is refused')
    ok(!n0.node.localPut(pkey, 'record', rowOf(claim('online', clock.now - 300_001))), 'gate: an already-expired claim is refused')
    ok(!n0.node.localPut(pkey, 'record', { v: 1, t: 'social-presence', claim: { v: 1, root: P.pubB } }), 'gate: a malformed claim shape is refused')
    ok(!n0.node.localPut(SOC.presenceKeyOfRoot(atk.pubB), 'record', rowOf(claim('online', clock.now))), 'gate: a row under a FOREIGN root’s key is refused (key binding)')
    ok(n0.node.localPut(idLike('other-record'), 'record', { v: 1, anything: 'else' }), 'gate: non-presence records still fall through to the base validator (composition)')

    // END TO END: publish at node 3, fresher at node 9, read at node 6.
    const sp1 = claim('online', clock.now)
    const stored1 = await SOC.publishSocialPresence(net.nodes[3].node, sp1)
    ok(stored1 > 0, `E2E: node 3 published root P 'online' (stored at ${stored1} replicas)`)
    let view = await SOC.fetchSocialPresence(net.nodes[6].node, P.pubB, clock.now + 1_000)
    ok(view !== null && view.status === 'online', 'E2E: node 6 reads P as online')

    const sp2 = claim('playing', clock.now + 2_000)
    ok((await SOC.publishSocialPresence(net.nodes[9].node, sp2)) > 0, 'E2E: node 9 published a FRESHER claim (playing)')
    view = await SOC.fetchSocialPresence(net.nodes[6].node, P.pubB, clock.now + 3_000)
    ok(view !== null && view.status === 'playing' && view.ts === clock.now + 2_000, 'E2E FRESHEST-WINS ACROSS TWO NODES: the reader sees the newest claim (playing)')

    ok((await SOC.publishSocialPresence(net.nodes[11].node, sp1)) >= 0, 'E2E: republishing the STALE claim is tolerated…')
    view = await SOC.fetchSocialPresence(net.nodes[2].node, P.pubB, clock.now + 3_500)
    ok(view !== null && view.status === 'playing', '…and cannot regress the view (freshest still wins)')

    view = await SOC.fetchSocialPresence(net.nodes[4].node, P.pubB, clock.now + 2_000 + 300_001)
    eq(view, null, 'E2E: past its ttl the claim reads offline (expiry at the caller’s witnessed time)')
    eq(await SOC.fetchSocialPresence(net.nodes[5].node, kpOf('stp-nobody').pubB, clock.now), null, 'E2E: an unknown root reads offline (fail closed)')

    const forged = { body: { v: 1, root: P.pubB, status: 'online', ts: clock.now, ttlMs: 60_000 }, sig: b64(A.ed25519.sign(A.canonicalBytes({ v: 1, root: P.pubB, status: 'online', ts: clock.now, ttlMs: 60_000 }), atk.priv)) }
    throws(() => SOC.makeSocialPresenceRow(forged), 'builder refuses a forged claim (trusted path fails loudly)')
    eq(await net.nodes[8].node.put(pkey, 'record', { v: 1, t: 'social-presence', claim: forged }), 0, 'E2E: a forged claim pushed raw lands at ZERO replicas (every gate refuses)')
  }

  // ==========================================================================
  console.log('\n· 3. friend-edge countersignature exchange OVER THE MAILBOX …')
  // ==========================================================================
  {
    let cA = genesisChain('rt-a', fA, 'RTA')
    let cB = genesisChain('rt-b', fB, 'RTB')
    chains.set(fA.pubB, cA)
    chains.set(fB.pubB, cB)

    // A → request → B's relays (B offline; the mail waits).
    const reqMail = SOC.makeFriendRequestMail({ selfRoot: fA.pubB, peerRoot: fB.pubB, key: fA.pubB, priv: fA.priv, rootPriv: fA.priv, sentTs: clock.now })
    const sent = await SOC.sendSocialMail(n0.ep, n0.node, reqMail)
    ok(sent.offered > 0 && sent.admitted === sent.offered, `request admitted at all ${sent.offered} relays`)

    // B syncs: drain → read → consent (append own add + mail the consent back).
    const drainedB = await SOC.drainSocialMailbox(n0.ep, n0.node, { recipient: fB.pubB, rootPriv: fB.priv, ts: clock.now })
    ok(drainedB.length === 1 && drainedB[0].mail.body.sender === fA.pubB, 'B drains exactly the one request, sender-verified')
    const half = SOC.readFriendMail(drainedB[0].mail, 'friend-request')
    ok(half !== null && half.from === fA.pubB && half.to === fB.pubB, 'the request carries A’s verified half, bound to the pair')
    const addB = SOC.consentToFriendRequest(half, fB.pubB)
    ok(addB !== null, 'consent derives B’s chain-appendable add payload from A’s half')
    cB = A.appendWitnessed(cB, fB.priv, fB.pubB, 'friend', addB, clock.now)
    chains.set(fB.pubB, cB)
    const consentMail = SOC.makeFriendConsentMail({ selfRoot: fB.pubB, peerRoot: fA.pubB, key: fB.pubB, priv: fB.priv, rootPriv: fB.priv, sentTs: clock.now + 1 })
    const sent2 = await SOC.sendSocialMail(net.nodes[5].ep, net.nodes[5].node, consentMail)
    ok(sent2.admitted > 0, 'consent mail admitted on the way back')

    // A syncs: drain → adopt (bound to the peer A actually asked) → append.
    const drainedA = await SOC.drainSocialMailbox(net.nodes[7].ep, net.nodes[7].node, { recipient: fA.pubB, rootPriv: fA.priv, ts: clock.now })
    const consent = SOC.readFriendMail(drainedA[0].mail, 'friend-consent')
    ok(consent !== null && consent.from === fB.pubB, 'A drains B’s verified consent half')
    const addA = SOC.adoptFriendConsent(consent, fA.pubB, fB.pubB)
    ok(addA !== null, 'adopt derives A’s chain-appendable add payload')
    cA = A.appendWitnessed(cA, fA.priv, fA.pubB, 'friend', addA, clock.now + 2)
    chains.set(fA.pubB, cA)

    const vA = SOC.friendsOfChain(cA)
    const vB = SOC.friendsOfChain(cB)
    ok(vA !== null && vB !== null && SOC.areFriends(vA, vB), 'FRIEND ADD ROUND-TRIP YIELDS A MUTUALLY-READABLE EDGE (areFriends on both verified chains)')
    eq(SOC.edgeMicroOfChains({ sender: fA.pubB, recipient: fB.pubB, senderChain: cA, recipientChain: cB, atWts: clock.now }), 600_000, 'the completed edge now feeds the §10 fold at full friend weight')

    // Forgery / replay refusal matrix.
    const halfAB = SOC.makeFriendHalf({ selfRoot: fA.pubB, peerRoot: fB.pubB, key: fA.pubB, priv: fA.priv })
    eq(SOC.verifyFriendHalf({ ...halfAB, sig: flip(halfAB.sig) }), null, 'a FORGED countersignature is refused')
    eq(SOC.verifyFriendHalf({ ...halfAB, to: fC.pubB }), null, 'a half REPLAYED toward a different pair is refused (sorted two-root binding)')
    ok(!SOC.verifyFriendAdd({ action: 'add', peer: fA.pubB, key: fA.pubB, sig: halfAB.sig }, fC.pubB), 'the raw countersig also fails verifyFriendAdd for any other pair (fold-level backstop)')
    const smuggled = SOC.signMail({ v: 1, sender: atk.pubB, recipient: fB.pubB, kind: 'friend-request', payload: SOC.encodeFriendHalf(halfAB), sentTs: clock.now }, atk.priv)
    eq(SOC.readFriendMail(smuggled, 'friend-request'), null, 'a third party mailing SOMEONE ELSE’S half is refused (half.from must be the envelope sender)')
    const halfXA = SOC.makeFriendHalf({ selfRoot: atk.pubB, peerRoot: fA.pubB, key: atk.pubB, priv: atk.priv })
    eq(SOC.adoptFriendConsent(halfXA, fA.pubB, fB.pubB), null, 'an UNSOLICITED consent from a stranger is refused at adopt (expected-peer binding)')
    eq(SOC.consentToFriendRequest(halfAB, fC.pubB), null, 'a half consumed by the WRONG self root is refused')
    eq(SOC.readFriendMail(reqMail, 'friend-consent'), null, 'kind mismatch is refused')
  }

  // ==========================================================================
  console.log('\n· 4. mailbox relaying, THE §10 SENTENCE THROUGH THE RELAY …')
  // ==========================================================================
  {
    const mailTo = (senderKp, recipient, tag, kind = 'friend-request') =>
      SOC.signMail({ v: 1, sender: senderKp.pubB, recipient, kind, payload: 'p-' + tag, sentTs: clock.now }, senderKp.priv)

    // Established E's REQUEST lands first (recipient R is OFFLINE; no node,
    // no drain: exactly the kickoff scenario).
    const eMail = SOC.makeFriendRequestMail({ selfRoot: E.pubB, peerRoot: R.pubB, key: E.pubB, priv: E.priv, rootPriv: E.priv, sentTs: clock.now })
    const eId = SOC.mailId(eMail.body)
    const eSent = await SOC.sendSocialMail(n0.ep, n0.node, eMail)
    ok(eSent.offered > 0 && eSent.admitted === eSent.offered, `established root's request admitted at all ${eSent.offered} relays (edge from PUBLIC SIGNED DATA: 2 witnessed games)`)
    const eRelays = (await n0.node.lookup(SOC.mailboxKeyOfRoot(R.pubB))).filter((c) => c.nodeId !== n0.nodeId).slice(0, 8).map((c) => c.nodeId)
    const frozenEdges = eRelays.map((id) => (relayByNodeId.get(id).state().boxes[R.pubB] ?? []).find((m) => m.id === eId)?.edgeMicro)
    ok(frozenEdges.every((e) => e === 100_000), 'every relay froze E’s admission edge at the fold value 100_000 (relay-computed, never sender-asserted)')

    // THE SYBIL FLOOD: 12 fresh roots, one request each, 12+1 > boxCap 8.
    const sybils = Array.from({ length: 12 }, (_, i) => kpOf('stp-sybil-' + i))
    chains.set(sybils[0].pubB, genesisChain('syb0', sybils[0], 'Syb0')) // half with real (empty) chains,
    chains.set(sybils[1].pubB, genesisChain('syb1', sybils[1], 'Syb1')) // half unknown: both fold to 0
    const sybilOutcomes = []
    for (let i = 0; i < sybils.length; i++)
      sybilOutcomes.push(await SOC.sendSocialMail(n0.ep, n0.node, mailTo(sybils[i], R.pubB, 'flood-' + i)))
    ok(sybilOutcomes.some((r) => r.outcomes.includes('box-full')), 'the flood overflows: late sybils are refused box-full (0 is never STRICTLY greater than 0)')
    const boxesWithE = eRelays.map((id) => (relayByNodeId.get(id).state().boxes[R.pubB] ?? []).some((m) => m.id === eId))
    ok(boxesWithE.every(Boolean), 'THE §10 SENTENCE, THROUGH THE RELAY: a sybil flood can’t evict an established root’s request before the offline recipient next syncs. E’s request survives at EVERY relay')
    ok(eRelays.every((id) => (relayByNodeId.get(id).state().boxes[R.pubB] ?? []).length <= P_MBX.boxCap), 'every relay box respects boxCap under the flood (bounded state)')

    // R comes online and SYNCS: the request is there, and FIRST.
    clock.now = NOW + 1_000
    const drained = await SOC.drainSocialMailbox(net.nodes[3].ep, net.nodes[3].node, { recipient: R.pubB, rootPriv: R.priv, ts: clock.now })
    ok(drained.length >= P_MBX.boxCap, `the recipient drains the union of its relays' boxes (${drained.length} messages)`)
    ok(drained[0].mail.body.sender === E.pubB && drained[0].edgeMicro === 100_000, 'the established root’s request is DELIVERED FIRST (§10 priority order at drain)')
    ok(drained.some((d) => SOC.readFriendMail(d.mail, 'friend-request') !== null && d.mail.body.sender === E.pubB), 'and it decodes as a verified friend request (the §3 flow is live end to end)')
    const drained2 = await SOC.drainSocialMailbox(net.nodes[3].ep, net.nodes[3].node, { recipient: R.pubB, rootPriv: R.priv, ts: clock.now + 1 })
    eq(drained2.length, 0, 'a second sync finds cleared boxes (drain actually drains)')

    // CONVERSE: a box already FULL of sybil mail yields to the established root.
    for (let i = 0; i < 8; i++) await SOC.sendSocialMail(n0.ep, n0.node, mailTo(sybils[i], R2.pubB, 'pre-' + i))
    const e2Mail = SOC.makeFriendRequestMail({ selfRoot: E.pubB, peerRoot: R2.pubB, key: E.pubB, priv: E.priv, rootPriv: E.priv, sentTs: clock.now })
    const e2Sent = await SOC.sendSocialMail(n0.ep, n0.node, e2Mail)
    ok(e2Sent.admitted === e2Sent.offered, 'converse: the established sender displaces sybil mail from a FULL box (edge-priority eviction, mailbox.ts semantics verbatim)')
    const e2Relays = (await n0.node.lookup(SOC.mailboxKeyOfRoot(R2.pubB))).filter((c) => c.nodeId !== n0.nodeId).slice(0, 8).map((c) => c.nodeId)
    ok(e2Relays.every((id) => (relayByNodeId.get(id).state().boxes[R2.pubB] ?? []).some((m) => m.sender === E.pubB)), 'E’s mail present in every (still-capped) R2 box')

    // Relay-boundary refusal matrix: raw RPC against one relay.
    const r0 = eRelays[0]
    const sendRaw = (mail) => n0.ep.request(r0, 'social-mail-send', { v: 1, mail })
    const s1 = kpOf('stp-matrix-sender')
    const good = mailTo(s1, R3.pubB, 'm-good')
    const stateBefore = canon(relayByNodeId.get(r0).state())
    eq((await sendRaw({ body: good.body, sig: flip(good.sig) })).reason, 'bad-sig', 'relay refuses a mail with a forged envelope signature (no spoofed senders, ever)')
    eq(canon(relayByNodeId.get(r0).state()), stateBefore, 'a bad-sig offer leaves the relay state byte-identical (pure rejection)')
    const big = SOC.signMail({ v: 1, sender: s1.pubB, recipient: R3.pubB, kind: 'friend-request', payload: 'x'.repeat(P_MBX.payloadMaxChars + 1), sentTs: clock.now }, s1.priv)
    eq((await sendRaw(big)).reason, 'bad-shape', 'relay refuses an OVERSIZED payload (store gates refuse oversized records)')
    eq((await sendRaw(SOC.signMail({ v: 1, sender: s1.pubB, recipient: s1.pubB, kind: 'x', payload: 'p', sentTs: clock.now }, s1.priv))).reason, 'self-mail', 'relay refuses self-mail')
    ok((await sendRaw(good)).admitted === true, 'the honest control mail is admitted…')
    eq((await sendRaw(good)).reason, 'duplicate', '…and its replay is refused as duplicate (id-bound, budget not burned)')
    let rateHit = null
    for (let i = 0; i < 9; i++) {
      const r = await sendRaw(mailTo(s1, kpOf('stp-rate-recip-' + i).pubB, 'rate-' + i))
      if (r.admitted === false) { rateHit = r.reason; break }
    }
    eq(rateHit, 'rate-limited', 'the per-sender-root rate limit fires across recipients (mailbox.ts window semantics verbatim)')
    eq((await n0.ep.request(r0, 'social-mail-send', { v: 1 })).error, 'malformed-request', 'a malformed wire payload gets the typed rpc error, never a throw across the fabric')

    // Authenticated drain: forgery + replay, against live state.
    const drainBody = (ts, recip = R3.pubB) => ({ v: 1, t: 'social-mail-drain', recipient: recip, ts })
    const signDrain = (body, priv) => ({ body, sig: b64(A.ed25519.sign(A.canonicalBytes(body), priv)) })
    const boxLen = () => (relayByNodeId.get(r0).state().boxes[R3.pubB] ?? []).length
    ok(boxLen() > 0, 'fixture: R3 has mail waiting at the relay')
    eq((await n0.ep.request(r0, 'social-mail-drain', signDrain(drainBody(clock.now), atk.priv))).error, 'drain-refused', 'a drain signed by a NON-recipient is refused')
    eq((await n0.ep.request(r0, 'social-mail-drain', signDrain(drainBody(clock.now - 120_001), R3.priv))).error, 'drain-refused', 'a STALE drain timestamp is refused (freshness window)')
    eq((await n0.ep.request(r0, 'social-mail-drain', signDrain(drainBody(clock.now + 120_001), R3.priv))).error, 'drain-refused', 'a FUTURE drain timestamp is refused')
    ok(boxLen() > 0, 'refused drains cleared nothing')
    const legit = signDrain(drainBody(clock.now), R3.priv)
    ok((await n0.ep.request(r0, 'social-mail-drain', legit)).msgs.length > 0, 'the recipient-signed drain hands the box over…')
    eq(boxLen(), 0, '…and clears it')
    ok((await sendRaw(mailTo(kpOf('stp-late-sender'), R3.pubB, 'post-drain'))).admitted === true, 'new mail arrives after the drain…')
    eq((await n0.ep.request(r0, 'social-mail-drain', legit)).error, 'drain-refused', '…and a REPLAYED capture of the old drain is refused (strictly-monotonic ts per recipient)')
    eq(boxLen(), 1, 'the replay cleared nothing: the new mail still waits')
    ok((await n0.ep.request(r0, 'social-mail-drain', signDrain(drainBody(clock.now + 1), R3.priv))).msgs.length === 1, 'a FRESH signed drain (newer ts) delivers it')

    ok(await SOC.drainSocialMailbox(n0.ep, n0.node, { recipient: R3.pubB, rootPriv: atk.priv, ts: clock.now }).then(() => false, () => true),
      'the drain helper refuses a priv that does not match the recipient (builders throw)')
  }

  // ==========================================================================
  console.log('\n· 5. determinism: identical fresh networks ⇒ identical bytes …')
  // ==========================================================================
  {
    async function runScript() {
      const c2 = { now: NOW }
      const chains2 = new Map()
      const eKp = kpOf('det-est')
      const rKp = kpOf('det-recip')
      chains2.set(eKp.pubB, withSegs('det-ce', eKp, 'DetE', [rKp.pubB]))
      const provider = SOC.makeChainEdgeProvider({ chainOf: (root) => chains2.get(root) ?? null })
      const fabric = new W.MockFabric()
      const nodes = []
      for (let i = 0; i < 8; i++) {
        const root = kpOf('det-root-' + i)
        const dev = kpOf('det-dev-' + i)
        const ep = fabric.endpoint(W.nodeIdOf(root.pubB))
        ep.announce(W.signPresence({ v: 1, root: root.pubB, key: dev.pubB, caps: { witness: true, committee: true, shardMb: 50 }, params: S.PARAMS_A3_DIGEST, ts: NOW, uptimePct: 99 }, dev.priv))
        const gate = SOC.makeSocialStoreGate({ nowMs: () => c2.now })
        const node = O.createOverlayNode(ep, { root: root.pubB, key: dev.pubB }, { nowMs: () => c2.now, validator: gate.validator, merge: gate.merge })
        const relay = SOC.createSocialRelay(ep, { nowMs: () => c2.now, edgeMicroOf: provider, params: P_MBX })
        nodes.push({ nodeId: W.nodeIdOf(root.pubB), ep, node, relay })
      }
      for (const n of nodes) await n.node.bootstrap()
      const pKp = kpOf('det-presence')
      await SOC.publishSocialPresence(nodes[1].node, SOC.signSocialPresence({ v: 1, root: pKp.pubB, status: 'online', ts: c2.now, ttlMs: 60_000 }, pKp.priv))
      await SOC.publishSocialPresence(nodes[4].node, SOC.signSocialPresence({ v: 1, root: pKp.pubB, status: 'away', ts: c2.now + 500, ttlMs: 60_000 }, pKp.priv))
      await SOC.sendSocialMail(nodes[0].ep, nodes[0].node, SOC.makeFriendRequestMail({ selfRoot: eKp.pubB, peerRoot: rKp.pubB, key: eKp.pubB, priv: eKp.priv, rootPriv: eKp.priv, sentTs: c2.now }))
      for (let i = 0; i < 3; i++) {
        const syb = kpOf('det-syb-' + i)
        await SOC.sendSocialMail(nodes[0].ep, nodes[0].node, SOC.signMail({ v: 1, sender: syb.pubB, recipient: rKp.pubB, kind: 'friend-request', payload: 'd-' + i, sentTs: c2.now }, syb.priv))
      }
      const view = await SOC.fetchSocialPresence(nodes[6].node, pKp.pubB, c2.now + 1_000)
      const drained = await SOC.drainSocialMailbox(nodes[2].ep, nodes[2].node, { recipient: rKp.pubB, rootPriv: rKp.priv, ts: c2.now })
      const states = nodes.map((n) => canon(n.relay.state())).sort()
      return canon({ states, view: view ?? 'null', drained: drained.map((d) => d.mail.body.sender + ':' + d.edgeMicro) })
    }
    const d1 = await runScript()
    const d2 = await runScript()
    eq(d1, d2, 'two identical fresh networks driven through the same sequence end byte-identical (relay states + presence view + drain order)')
  }

  // ==========================================================================
  console.log('\n· 6. browser parity: social-transport decision core …')
  // ==========================================================================
  {
    const outNode = makeOutdir('accounts-stp-parity-node')
    const outBrowser = makeOutdir('accounts-stp-parity-browser')
    try {
      const coreNode = await bundleAndImport(outNode, PARITY_ENTRY, 'node')
      const coreBrowser = await bundleAndImport(outBrowser, PARITY_ENTRY, 'browser')
      const logNode = coreNode.runSocialTransportParityScript()
      const logBrowser = coreBrowser.runSocialTransportParityScript()
      eq(b64(A.sha256(A.utf8(logNode))), b64(A.sha256(A.utf8(logBrowser))), 'node and browser bundles produce the identical decision transcript')
      ok(logNode.includes('pkey:' + GOLDEN_PRESENCE_KEY) && logNode.includes('mkey:' + GOLDEN_MAILBOX_KEY), 'the parity transcript pins the same key goldens')
      ok(logNode.includes('e0:0') && logNode.includes('ef:600000') && logNode.includes('eg:200000') && logNode.includes('emax:1000000') && logNode.includes('ebad:0'), 'parity edge-fold values are the expected ones (0 / 600000 / 200000 / 1000000 / 0)')
      ok(logNode.includes('half:true') && logNode.includes('half-x:true') && logNode.includes('half-sig:true'), 'parity half verdicts: round-trip ok, cross-pair + forged refused')
      ok(logNode.includes('dm:true') && logNode.includes('dm-rebind:true') && logNode.includes('dm-sig:true'), 'parity drained-mail verdicts: verified, rebind refused, forged refused')
      const refs = findNodeBuiltinRefs(readBundle(resolve(outBrowser, 'bundle.mjs')))
      eq(refs.length, 0, 'the browser bundle of the social-transport core carries zero node built-ins')
    } finally {
      for (const d of [outNode, outBrowser]) rmSync(d, { recursive: true, force: true })
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
