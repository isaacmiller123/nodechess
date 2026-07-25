// THE A6-M4 LANES L-presence-mail + L-friends SUITE: the LIVE social surface
// over the account peer overlay (src/renderer/src/features/account/net/socialClient.ts,
// spec §3 friendships, §10 presence/mailbox/anti-spam, C-3), headless over an
// in-process MockFabric network of REAL account peers.
//
//   node scripts/test-accounts-social-client.mjs
//
// socialClient is the renderer-hosted BODY around the pure, separately-tested
// social transport; the crypto and every admission/eviction decision are the
// shared substrate (createSocialRelay / mailboxAdmit / mailboxDrain / the §10
// edge fold), reused VERBATIM. This suite proves the WIRING:
//   1. PRESENCE end to end over the live overlay. Publish, freshest-wins across
//      two publishers, expiry reads offline, unknown reads offline (SC wrappers).
//   2. THE §10 INVARIANT, LIVE THROUGH THE SC-INSTALLED RELAY: a friend request
//      SURVIVES an offline recipient AND a sybil flood cannot evict it; it is
//      delivered FIRST at sync, decodes as a verified §3 request, and the
//      consent edge is countersigned + verifies + yields a MUTUALLY-READABLE
//      edge (areFriends over both chains).
//   3. mailbox anti-spam QUOTAS hold through the wiring. Per-sender-root rate
//      limit, per-recipient fair share, box cap, and the bad-sig/self/duplicate
//      refusal matrix.
//   4. the app-lifetime CONTROLLER: honest signed-out/no-peer states (no
//      fixtures), a live sync surfaces the request, accept countersigns + mails
//      the consent back + lands the edge, and the friends list folds from the
//      OWN chain.
//
// House style: esbuild-bundle on the fly (alias @shared; net modules by abs
// path), one-line asserts, exit(1) on any fail.

import { resolve } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import { bundleAndImport, makeOutdir, ROOT } from './lib/witness-bundle.mjs'

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

const NET = resolve(ROOT, 'src/renderer/src/features/account/net').replace(/\\/g, '/')

const ENTRY = `
export * as A from '@shared/accounts'
export * as W from '@shared/accounts/witness'
export * as O from '@shared/accounts/overlay'
export * as S from '@shared/accounts/storage'
export * as SOC from '@shared/accounts/social'
export * as SEG from '@shared/accounts/segment'
export * as P from '${NET}/peerService'
export * as SC from '${NET}/socialClient'
`

async function main() {
  const outdir = makeOutdir('accounts-social-client-test')
  try {
    await run(await bundleAndImport(outdir, ENTRY))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W, O, S, SOC, SEG, P, SC } = M
  const b64 = A.toB64u
  const seed32 = (tag) => A.sha256(A.utf8(tag))
  const idLike = (tag) => b64(seed32(tag))
  const kpOf = (tag) => {
    const priv = seed32(tag)
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub, pubB: b64(pub) }
  }
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)

  const T0 = 1_750_000_000_000
  const clock = { now: T0 + 10_000 }
  const nowFn = () => clock.now

  // Small mailbox geometry so floods overflow fast; semantics unchanged.
  const P_MBX = {
    v: 1, rateWindowMs: 3_600_000, ratePerWindow: 8, boxCap: 8, perSenderPerBox: 2,
    recipientsCap: 64, sendersCap: 256, retentionMs: 14 * 86_400_000, payloadMaxChars: 2048,
  }

  // --- chain fixtures (verbatim shape from the social-transport suite) --------
  const wit = kpOf('scl-witness')
  const attOf = (ev) => W.makeAttestation(A.eventId(ev.body), 0, wit.pubB, wit.priv, T0 + 5_000)
  const attachWit = (ch) => {
    const last = ch.events[ch.events.length - 1]
    return { root: ch.root, events: [...ch.events.slice(0, -1), { ...last, wit: [attOf(last)] }] }
  }
  const segPayload = (tag, opp) => {
    const game = idLike('scl-game-' + tag)
    const transcript = SEG.transcriptDigest(game, [], '1-0', 'resign')
    return SEG.makeSegmentPayload({
      game, opp, color: 'w', result: '1-0', reason: 'resign', moves: [],
      heads: { w: { head: idLike('hw-' + tag), height: 0 }, b: { head: idLike('hb-' + tag), height: 0 } },
      wstream: SEG.signWitnessEnd(wit.priv, wit.pubB, game, '1-0', 0, transcript),
      oppProfile: { name: 'Opp' },
    })
  }
  const genesisChain = (tag, kp, name) =>
    A.createAccountChain({ rootPriv: kp.priv, rootPub: kp.pub, displayName: name, ts: T0, device: { pub: kpOf(tag + '-dev').pubB, index: 0 } })
  const withSegs = (tag, kp, name, opps) => {
    let ch = genesisChain(tag, kp, name)
    opps.forEach((opp, i) => {
      ch = attachWit(A.appendWitnessed(ch, kp.priv, kp.pubB, 'segment', segPayload(tag + '-' + i, opp), T0 + 1000 + i))
    })
    return ch
  }

  // The reconstructed-chain view the relay's §10 edge fold derives from (its C-1
  // cache in production). SC.installSocialRelay wires makeChainEdgeProvider over it.
  const chains = new Map()
  const chainOf = (root) => chains.get(root) ?? null

  // --- a network of real account peers, each running an SC-installed relay ----
  const bus = new W.MockFabric()
  const makeIdentity = (tag) => {
    const rootKp = kpOf('scl-root-' + tag)
    const devKp = kpOf('scl-dev-' + tag)
    return {
      tag, rootKp, devKp, nodeId: W.nodeIdOf(rootKp.pubB),
      identity: { root: rootKp.pubB, key: devKp.pubB, priv: devKp.priv },
      signer: { root: rootKp.pubB, rootPriv: rootKp.priv },
    }
  }
  const startPeer = async (spec) =>
    P.startAccountPeer({ identity: spec.identity, fabric: bus.endpoint(spec.nodeId), now: nowFn, platform: 'desktop-browser', autoBootstrap: false })

  const relaySpecs = Array.from({ length: 14 }, (_, i) => makeIdentity('relay-' + i))
  const eSpec = makeIdentity('established') // the established sender (a live peer)
  const allSpecs = [...relaySpecs, eSpec]
  const peers = new Map() // nodeId -> AccountPeer
  for (const s of allSpecs) peers.set(s.nodeId, await startPeer(s))
  for (const p of peers.values()) await p.bootstrap()

  // Install THIS lane's relay on every peer (the SC wiring under test).
  const relays = new Map() // nodeId -> SocialRelay
  for (const [nodeId, peer] of peers) relays.set(nodeId, SC.installSocialRelay(peer.fabric, { now: nowFn, chainOf, params: P_MBX }))
  ok(peers.size === 15 && relays.size === 15, 'brought up 15 account peers, each running an SC-installed mailbox relay')

  const ePeer = peers.get(eSpec.nodeId)
  const anyPeer = peers.get(relaySpecs[0].nodeId) // a generic routing vehicle

  // ==========================================================================
  console.log('\n· 0. static discipline: socialClient imports no node: builtins …')
  // ==========================================================================
  {
    const src = readFileSync(resolve(ROOT, 'src/renderer/src/features/account/net/socialClient.ts'), 'utf8')
    ok(!/from 'node:|from "node:/.test(src), 'socialClient.ts imports no node: builtins (bundles for the browser)')
    ok(/setSocialRootSignerProvider/.test(src) && /getSocialClientState/.test(src), 'socialClient exposes the root-signer provider hook + the reactive state accessor')
  }

  // ==========================================================================
  console.log('\n· 1. PRESENCE end to end over the live overlay (SC wrappers) …')
  // ==========================================================================
  {
    const Pk = kpOf('scl-presence')
    const signerP = { root: Pk.pubB, rootPriv: Pk.priv }
    const n1 = await SC.publishOwnPresence(peers.get(relaySpecs[3].nodeId).overlay, signerP, 'online', clock.now)
    ok(n1 > 0, `published presence 'online' to ${n1} overlay replicas`)
    let st = await SC.fetchPresence(peers.get(relaySpecs[6].nodeId).overlay, Pk.pubB, clock.now + 1_000)
    eq(st, 'online', 'a second node reads the published presence as online')

    // Freshest-wins across two publishers.
    const n2 = await SC.publishOwnPresence(peers.get(relaySpecs[9].nodeId).overlay, signerP, 'playing', clock.now + 2_000)
    ok(n2 > 0, 'a fresher presence claim (playing) publishes')
    st = await SC.fetchPresence(peers.get(relaySpecs[2].nodeId).overlay, Pk.pubB, clock.now + 3_000)
    eq(st, 'playing', 'freshest-wins across two publishers: the reader sees the newest claim')

    st = await SC.fetchPresence(peers.get(relaySpecs[4].nodeId).overlay, Pk.pubB, clock.now + 2_000 + SC.SOCIAL_PRESENCE_TTL_MS + 1)
    eq(st, 'offline', 'past its ttl the claim reads offline (expiry at the caller’s witnessed time)')
    eq(await SC.fetchPresence(anyPeer.overlay, kpOf('scl-nobody').pubB, clock.now), 'offline', 'an unknown root reads offline (fail closed, no negative presence)')
  }

  // ==========================================================================
  console.log('\n· 2. THE §10 INVARIANT, LIVE: request survives offline recipient …')
  // ==========================================================================
  const R = kpOf('scl-recipient') // OFFLINE until it syncs. No peer, no drain
  const signerR = { root: R.pubB, rootPriv: R.priv }
  {
    // Established E: a verified chain with 2 witnessed games vs R ⇒ edge 100_000.
    const chainE = withSegs('ce', eSpec.rootKp, 'Established', [R.pubB, R.pubB])
    chains.set(eSpec.rootKp.pubB, chainE)
    chains.set(R.pubB, genesisChain('cr', R, 'Recipient'))
    ok(A.verifyChain(chainE).ok, 'fixture: established sender chain (2 games vs R) verifies')

    // E sends a §3 friend request to the OFFLINE recipient (rides the mailbox).
    const eSent = await SC.sendFriendRequest({ fabric: ePeer.fabric, node: ePeer.overlay, signer: eSpec.signer, peerRoot: R.pubB, nowMs: clock.now })
    ok(eSent.offered > 0 && eSent.admitted === eSent.offered, `established root's request admitted at all ${eSent.offered} relays (recipient OFFLINE; the mailbox holds it)`)

    // The relays froze E's admission edge at the fold value. Public signed data,
    // never sender-asserted, which is exactly the SC-installed edge provider.
    const rRelays = (await ePeer.overlay.lookup(SOC.mailboxKeyOfRoot(R.pubB))).filter((c) => c.nodeId !== ePeer.nodeId).slice(0, P_MBX.boxCap).map((c) => c.nodeId)
    const eId = (() => { // recover E's mail id from a relay box
      for (const id of rRelays) { const m = (relays.get(id).state().boxes[R.pubB] ?? []).find((x) => x.sender === eSpec.rootKp.pubB); if (m) return m.id }
      return null
    })()
    ok(eId !== null, 'E’s request is stored at R’s relays')
    const frozen = rRelays.map((id) => (relays.get(id).state().boxes[R.pubB] ?? []).find((m) => m.id === eId)?.edgeMicro)
    ok(frozen.length > 0 && frozen.every((e) => e === 100_000), 'every relay froze E’s edge at the fold value 100_000 (2 witnessed games, relay-computed via SC’s edge provider)')

    // THE SYBIL FLOOD: 12 fresh roots, one request each, 12+1 > boxCap 8.
    const sybils = Array.from({ length: 12 }, (_, i) => kpOf('scl-sybil-' + i))
    chains.set(sybils[0].pubB, genesisChain('syb0', sybils[0], 'Syb0')) // some with real (empty) chains,
    const sybilOutcomes = []
    for (let i = 0; i < sybils.length; i++) {
      const sig = { root: sybils[i].pubB, rootPriv: sybils[i].priv }
      sybilOutcomes.push(await SC.sendFriendRequest({ fabric: anyPeer.fabric, node: anyPeer.overlay, signer: sig, peerRoot: R.pubB, nowMs: clock.now + 10 + i }))
    }
    ok(sybilOutcomes.some((r) => r.outcomes.includes('box-full')), 'the flood overflows: late sybils are refused box-full (0 is never STRICTLY greater than an established 100_000)')
    const survives = rRelays.every((id) => (relays.get(id).state().boxes[R.pubB] ?? []).some((m) => m.id === eId))
    ok(survives, 'THE §10 INVARIANT, LIVE THROUGH THE SC RELAY: a sybil flood CANNOT evict the established root’s request before the offline recipient next syncs')
    ok(rRelays.every((id) => (relays.get(id).state().boxes[R.pubB] ?? []).length <= P_MBX.boxCap), 'every relay box respects boxCap under the flood (bounded state)')

    // R COMES ONLINE and SYNCS (drains via any node, authenticated as R).
    clock.now += 1_000
    const drained = await SC.syncMailbox({ fabric: anyPeer.fabric, node: anyPeer.overlay, signer: signerR, nowMs: clock.now })
    ok(drained.length >= 1, `R drains its relays’ boxes on sync (${drained.length} messages)`)
    eq(drained[0].mail.body.sender, eSpec.rootKp.pubB, 'the established root’s request is DELIVERED FIRST (§10 priority order at drain)')
    eq(drained[0].edgeMicro, 100_000, 'delivered with its relay-frozen edge (100_000)')
    eq(SC.priorityOfEdge(drained[0].edgeMicro), 'entangled', 'an established §3 edge surfaces the ENTANGLED §10 priority')
    const reqHalf = SC.readRequestHalf(drained[0])
    ok(reqHalf !== null && reqHalf.from === eSpec.rootKp.pubB && reqHalf.to === R.pubB, 'and it decodes as a VERIFIED §3 friend request bound to the pair')

    // CONSENT: the consent edge is countersigned + verifies, and completes a
    // mutually-readable edge across both chains (the §3 round-trip, live).
    const addR = SC.consentToRequest(reqHalf, R.pubB)
    ok(addR !== null && SOC.verifyFriendAdd(addR, R.pubB), 'consent derives R’s chain-appendable add. COUNTERSIGNED (carries E’s signature) and verifies')
    let cR = A.appendWitnessed(chains.get(R.pubB), R.priv, R.pubB, 'friend', addR, clock.now)
    chains.set(R.pubB, cR)
    // R mails the consent half back; E drains + adopts it into ITS add.
    const back = await SC.sendFriendConsent({ fabric: anyPeer.fabric, node: anyPeer.overlay, signer: signerR, peerRoot: eSpec.rootKp.pubB, nowMs: clock.now })
    ok(back.admitted > 0, 'R’s consent mail is admitted on the way back to E')
    const drainedE = await SC.syncMailbox({ fabric: ePeer.fabric, node: ePeer.overlay, signer: eSpec.signer, nowMs: clock.now })
    const consentHalf = drainedE.map((d) => SC.readConsentHalf(d)).find((h) => h && h.from === R.pubB)
    ok(consentHalf != null, 'E drains R’s verified consent half')
    const addE = SC.adoptConsent(consentHalf, eSpec.rootKp.pubB, R.pubB)
    ok(addE !== null && SOC.verifyFriendAdd(addE, eSpec.rootKp.pubB), 'E adopts the consent into ITS add: countersigned by R and verifies (expected-peer bound)')
    let cE = A.appendWitnessed(chains.get(eSpec.rootKp.pubB), eSpec.rootKp.priv, eSpec.rootKp.pubB, 'friend', addE, clock.now + 1)
    chains.set(eSpec.rootKp.pubB, cE)

    const vE = SOC.friendsOfChain(cE)
    const vR = SOC.friendsOfChain(cR)
    ok(vE !== null && vR !== null && SOC.areFriends(vE, vR), 'THE §3 EDGE IS LIVE: the round-trip yields a MUTUALLY-READABLE friendship (areFriends on both verified chains)')
    // 600_000 friend + 2 witnessed games (2·50_000) = 700_000. The full §10 fold.
    eq(SOC.edgeMicroOfChains({ sender: eSpec.rootKp.pubB, recipient: R.pubB, senderChain: cE, recipientChain: cR, atWts: clock.now }), 700_000, 'the completed edge now feeds the §10 fold at friend (600_000) + 2 games (100_000) = 700_000')

    // A second sync finds the boxes cleared (drain actually drains).
    const again = await SC.syncMailbox({ fabric: anyPeer.fabric, node: anyPeer.overlay, signer: signerR, nowMs: clock.now + 1 })
    eq(again.length, 0, 'a second R sync finds cleared boxes')
  }

  // ==========================================================================
  console.log('\n· 3. mailbox anti-spam QUOTAS hold through the SC-installed relay …')
  // ==========================================================================
  {
    // The quotas are enforced PER RELAY (each relay tracks its own per-sender
    // windows + per-box shares); so (like the substrate suite) drive raw sends
    // at ONE relay, which is precisely the handler SC.installSocialRelay created.
    const r0 = relaySpecs[0].nodeId
    const R3 = kpOf('scl-recip3')
    const mailTo = (kp, recip, tag) => SOC.signMail({ v: 1, sender: kp.pubB, recipient: recip, kind: 'friend-request', payload: 'p-' + tag, sentTs: clock.now + 500 }, kp.priv)
    const sendRaw = (mail) => anyPeer.fabric.request(r0, 'social-mail-send', { v: 1, mail })

    // Per-sender-root RATE LIMIT (across recipients): the 9th admitted send in the
    // window is refused (ratePerWindow 8).
    const s1 = kpOf('scl-rate')
    let rateHit = null
    for (let i = 0; i < 12; i++) {
      const r = await sendRaw(mailTo(s1, kpOf('scl-rate-recip-' + i).pubB, 'rate-' + i))
      if (r.admitted === false) { rateHit = r.reason; break }
    }
    eq(rateHit, 'rate-limited', 'the per-sender-root rate limit fires across recipients (mailbox.ts window, verbatim)')

    // Per-recipient FAIR SHARE: one fresh sender holds at most perSenderPerBox (2)
    // slots in one box; the 3rd distinct request to the same recipient is refused.
    const s2 = kpOf('scl-fair')
    const shares = []
    for (let i = 0; i < 4; i++) shares.push(await sendRaw(mailTo(s2, R3.pubB, 'fair-' + i)))
    ok(shares.some((r) => r.reason === 'sender-share'), 'per-recipient fair-share cap: one sender cannot exceed perSenderPerBox slots in a box (sender-share)')

    // Relay-boundary refusal matrix.
    const s3 = kpOf('scl-matrix')
    const good = mailTo(s3, kpOf('scl-r4').pubB, 'good')
    eq((await sendRaw({ body: good.body, sig: flip(good.sig) })).reason, 'bad-sig', 'the SC-installed relay refuses a forged envelope signature (no spoofed senders)')
    eq((await sendRaw(SOC.signMail({ v: 1, sender: s3.pubB, recipient: s3.pubB, kind: 'x', payload: 'p', sentTs: clock.now + 500 }, s3.priv))).reason, 'self-mail', 'the relay refuses self-mail')
    ok((await sendRaw(good)).admitted === true, 'an honest control mail is admitted…')
    eq((await sendRaw(good)).reason, 'duplicate', '…and its replay is refused as duplicate (id-bound, budget not burned)')
    eq((await anyPeer.fabric.request(r0, 'social-mail-send', { v: 1 })).error, 'malformed-request', 'a malformed wire payload gets the typed rpc error, never a throw across the fabric')
  }

  // ==========================================================================
  console.log('\n· 4. the app-lifetime SINGLETON: honest states + live accept …')
  // ==========================================================================
  {
    // Honest signed-out surface with NO singleton live. Never a fixture.
    const out = SC.getSocialClientState()
    eq(out.phase, 'signed-out', 'with no client live the singleton state is honestly signed-out')
    eq(out.friends.length, 0, 'signed-out friends list is empty (no fixture rows)')
    eq(out.requests.length, 0, 'signed-out requests list is empty')
    ok((await SC.runSendFriendRequest(kpOf('x').pubB)).ok === false, 'imperative delegators fail honestly when no client is live')

    // A live SINGLETON for a fresh account Q with its OWN peer.
    const qSpec = makeIdentity('ctl-q')
    const qPeer = await startPeer(qSpec)
    await qPeer.bootstrap()
    peers.set(qSpec.nodeId, qPeer)
    relays.set(qSpec.nodeId, SC.installSocialRelay(qPeer.fabric, { now: nowFn, chainOf, params: P_MBX }))
    let qChain = genesisChain('cq', qSpec.rootKp, 'Q')
    chains.set(qSpec.rootKp.pubB, qChain)

    const client = SC.startSocialClientSingleton({
      signer: qSpec.signer,
      getPeer: () => qPeer,
      now: nowFn,
      loadChain: async () => chains.get(qSpec.rootKp.pubB) ?? null,
      // The witnessed-lane write hook the lead wires to lease+appendWitnessed.
      appendFriendEdge: async (payload) => {
        qChain = A.appendWitnessed(chains.get(qSpec.rootKp.pubB), qSpec.rootKp.priv, qSpec.rootKp.pubB, 'friend', payload, clock.now)
        chains.set(qSpec.rootKp.pubB, qChain)
        return true
      },
      chainOf,
    })
    // Settle the constructor's initial publish, then a clean baseline.
    await client.refresh()
    await client.sync()
    eq(SC.getSocialClientState().phase, 'live', 'a live singleton with a peer reports phase live (via getSocialClientState)')
    eq(client.getState().friends.length, 0, 'a fresh account has an honest EMPTY friends list (folded from its own chain)')
    eq(client.getState().requests.length, 0, 'and an honest empty requests list')

    // E (a stranger to Q) sends Q a friend request; Q syncs and surfaces it.
    const eToQ = await SC.sendFriendRequest({ fabric: ePeer.fabric, node: ePeer.overlay, signer: eSpec.signer, peerRoot: qSpec.rootKp.pubB, nowMs: clock.now })
    ok(eToQ.admitted > 0, 'E’s request to Q is admitted at Q’s relays')
    await client.sync()
    eq(client.getState().requests.length, 1, 'Q’s singleton surfaces exactly one incoming request after sync')
    const reqId = client.getState().requests[0].id
    eq(client.getState().requests[0].from, eSpec.rootKp.pubB, 'the surfaced request is from E, root-identified (no fabricated handle)')
    eq(client.getState().requests[0].priority, 'new', 'a stranger’s request honestly shows the §10 NEW-sender priority (no prior edge with Q)')

    // Accept via the imperative delegator the un-fixtured UI calls.
    const acc = await SC.runAcceptRequest(reqId)
    ok(acc.ok, 'runAcceptRequest succeeds: countersign + mail the consent back + land the witnessed edge')
    ok(client.getState().friends.some((f) => f.root === eSpec.rootKp.pubB), 'after accept, E appears in Q’s friends list (folded from Q’s advanced own chain)')
    ok(client.getState().friends.every((f) => f.countersigned), 'every folded friend edge is countersigned (§3)')
    eq(client.getState().requests.length, 0, 'the accepted request leaves the incoming list')
    ok(SOC.friendsOf(qSpec.rootKp.pubB, qChain.events).friends.includes(eSpec.rootKp.pubB), 'Q’s own chain now carries the verified countersigned add toward E')

    SC.stopSocialClientSingleton()
    eq(SC.getSocialClientState().phase, 'signed-out', 'after stopSocialClientSingleton the surface is signed-out again')
  }

  // Clean teardown of the peer fleet.
  for (const p of peers.values()) await p.stop()
}

main().catch((e) => { console.error(e); process.exit(1) })
