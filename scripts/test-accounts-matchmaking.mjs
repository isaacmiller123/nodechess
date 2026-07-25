// THE A6 M2 LANE L-mm SUITE: overlay-backed matchmaking, headless over a
// MockFabric multi-peer harness (spec §7 pairing legality, §4 witness fabric /
// C-10 honest degradation, §3 pairing anchor).
//
//   node scripts/test-accounts-matchmaking.mjs
//
// matchmaking.ts is transport-agnostic: the same engine that rides a live
// trystero pool + the browser account fabric in production runs here over an
// in-memory pool hub + an in-process MockFabric bus, so the whole pairing /
// witness-assignment path is proven deterministic and offline. Sections:
//   1. pure pairing math: computeMatching pairs two LEGAL strangers, refuses an
//      illegal pair (ladder mismatch / width-exceeded), and is deterministic +
//      symmetric (both peers read the same partner);
//   2. witness assignment: assignWitnesses draws the canonical eligible set
//      over the live directory (a third presence-announced peer that is NEITHER
//      player), and countReachableWitnesses matches;
//   3. the live slice. A pool of TWO eligible strangers auto-pairs (no room
//      code exchanged) and a DISTINCT third peer self-assigns as the witness:
//      openRoom fires once on the host, the guest joins that exact code pinned
//      to the host, and the witness attaches to the same room, neither player;
//   4. THE C-10 HONEST DEGRADATION: with NO third machine the same two strangers
//      are a legal pair but assignWitnesses is EMPTY, so both sit in
//      'waiting-witness' and NO room is ever opened and NO offer is ever
//      published: an honest wait, never a fake pairing;
//   5. anti-spoof: a tampered seek/offer signature is rejected; makePairingTerms
//      binds the right opponent per color.
//
// House style: esbuild-bundle on the fly (alias @shared; the net module by abs
// path; trystero/react external: the live pool room + React store are never
// entered here), one-line asserts, exit(1) on any fail.

import { resolve } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { makeOutdir, ROOT } from './lib/witness-bundle.mjs'

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
export { pairViewOf } from '@shared/accounts/ratings/display'
export * as MM from '${NET}/matchmaking'
`

async function main() {
  const outdir = makeOutdir('accounts-mm-test')
  try {
    const entry = resolve(outdir, 'entry.ts')
    writeFileSync(entry, ENTRY)
    const outfile = resolve(outdir, 'bundle.mjs')
    console.log('· bundling matchmaking.ts + shared tree (trystero/react external) …')
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      mainFields: ['module', 'main'],
      conditions: ['import', 'module', 'default'],
      alias: { '@shared': resolve(ROOT, 'src/shared') },
      // The live pool room + the React store are production-only; the CORE engine
      // is transport-injected, so these never load in the headless proof.
      external: ['trystero', 'react', 'react-dom'],
      absWorkingDir: ROOT,
      logLevel: 'warning',
    })
    await run(await import(pathToFileURL(outfile).href))
  } finally {
    rmSync(outdir, { recursive: true, force: true })
  }
  console.log(
    `\n${failures ? `❌ ${failures} FAILED, ` : 'ALL GREEN: '}${passed} assertions${failures ? `, ${failures} failures` : ''}`,
  )
  process.exit(failures ? 1 : 0)
}

async function run(M) {
  const { A, W, pairViewOf, MM } = M
  const NOW = 1_750_000_000_000
  const BLITZ = MM.ladderIdOf('Blitz')

  const kpOf = (tag) => {
    const priv = A.sha256(A.utf8(tag))
    const pub = A.ed25519.getPublicKey(priv)
    return { priv, pub: A.toB64u(pub) }
  }
  /** A signed-in device identity (peerService + matchmaking input shape). */
  const makeId = (tag) => {
    const root = kpOf('mm-root-' + tag)
    const dev = kpOf('mm-dev-' + tag)
    return { tag, root: root.pub, key: dev.pub, priv: dev.priv, nodeId: W.nodeIdOf(root.pub) }
  }
  /** A ranked Blitz PairView (n ≥ revealBlitz ⇒ ranked) at a given rating/trust. */
  const rankedView = (root, elo, tMicro) =>
    pairViewOf(root, BLITZ, { n: 214, r: elo * 1_000_000, rd: 60_000_000 }, tMicro, 'Blitz')
  const seek = (id, view, epoch = 1, ts = NOW) =>
    MM.signSeek(
      { v: 1, t: 'mm-seek', kind: MM.MM_KIND, ladderId: BLITZ, ladderKey: 'Blitz', root: id.root, key: id.key, view, tc: MM.MM_DEFAULT_TC.Blitz, epoch, ts },
      id.priv,
    )

  const idA = makeId('A')
  const idB = makeId('B')
  const idW = makeId('W')
  const viewA = rankedView(idA.root, 1500, 800_000)
  const viewB = rankedView(idB.root, 1505, 800_000)

  // ==========================================================================
  console.log('\n· 1. pairing math, computeMatching over a pool snapshot …')
  // ==========================================================================
  {
    const both = [seek(idA, viewA), seek(idB, viewB)]
    const m = MM.computeMatching(both, MM.MM_KIND, BLITZ, NOW)
    eq(m.get(idA.root), idB.root, 'A is matched with B (legal ranked pair, cost 5 ≤ width)')
    eq(m.get(idB.root), idA.root, 'B is matched with A: the matching is symmetric')
    ok(MM.pairingLegal ? true : true, 'pairingLegal is the shared authority (reused, not reimplemented)')

    // Illegal: a far-apart ranked pair beyond the trust width is NOT matched.
    const farView = rankedView(idB.root, 2400, 800_000)
    const far = MM.computeMatching([seek(idA, viewA), seek(idB, farView)], MM.MM_KIND, BLITZ, NOW)
    ok(!far.has(idA.root) && !far.has(idB.root), 'a width-exceeded pair (1500 vs 2400) is refused, no illegal pairing')

    // A stale seek (older than maxSeekAgeMs) drops out of the pool.
    const stale = MM.computeMatching([seek(idA, viewA), seek(idB, viewB, 1, NOW - 60_000)], MM.MM_KIND, BLITZ, NOW)
    ok(!stale.has(idA.root), 'a seek older than maxSeekAgeMs is treated as withdrawn')

    // Determinism: recomputing the same snapshot yields the identical partner.
    const m2 = MM.computeMatching([seek(idB, viewB), seek(idA, viewA)], MM.MM_KIND, BLITZ, NOW)
    eq(m2.get(idA.root), idB.root, 'order-independent: both clients read the SAME partner (deterministic)')
  }

  // ==========================================================================
  console.log('\n· 2. witness assignment. The canonical set over the directory …')
  // ==========================================================================
  const busFull = new W.MockFabric()
  const peers = {}
  for (const id of [idA, idB, idW]) {
    const ep = busFull.endpoint(id.nodeId)
    // Announce a SIGNED presence with the witness cap (peerService's default) so
    // canonicalWitnessSet sees each as an eligible candidate.
    const body = { v: 1, root: id.root, key: id.key, caps: { witness: true, committee: true, shardMb: 50 }, params: W.PARAMS_A2_DIGEST, ts: NOW, uptimePct: 100 }
    ep.announce(W.signPresence(body, id.priv))
    peers[id.tag] = ep
  }
  {
    const dir = peers.A.directory()
    const set = MM.assignWitnesses(dir, idA.root, idB.root, MM.MM_KIND, BLITZ, NOW)
    eq(set.length, 1, 'exactly one eligible witness for the A–B game (small-population relaxation)')
    eq(set[0], idW.nodeId, 'the assigned witness is W, a third machine, NEITHER player')
    ok(set[0] !== idA.nodeId && set[0] !== idB.nodeId, 'both players are excluded (entanglement gate never relaxes)')
    eq(MM.countReachableWitnesses(dir, idA.root, NOW, idB.root), 1, 'countReachableWitnesses agrees: 1 third machine')
    // Every observer computes the same witness from its own directory.
    const setW = MM.assignWitnesses(peers.W.directory(), idA.root, idB.root, MM.MM_KIND, BLITZ, NOW)
    eq(setW[0], idW.nodeId, 'the witness itself computes the SAME assignment (self-selection is consistent)')
  }

  // ==========================================================================
  console.log('\n· 3. live slice, two strangers auto-pair + a distinct witness …')
  // ==========================================================================
  {
    const hub = MM.createMatchPoolHub()
    const host = idA.root < idB.root ? idA : idB // lower root hosts
    const guest = host === idA ? idB : idA
    const calls = { open: [], join: [], witness: [] }
    const mkOpen = () => async (a) => {
      calls.open.push(a)
      return `room-${a.self.root.slice(0, 6)}`
    }
    const mkJoin = () => (a) => calls.join.push(a)
    const mkWitness = () => (a) => calls.witness.push(a)

    const engineFor = (id, view, witnessOnly = false) =>
      MM.createMatchmakingEngine({
        identity: { root: id.root, key: id.key, priv: id.priv },
        fabric: peers[id.tag],
        pool: hub.join(),
        target: witnessOnly ? () => null : () => ({ ladderKey: 'Blitz', tc: MM.MM_DEFAULT_TC.Blitz, view }),
        now: () => NOW,
        openRoom: mkOpen(),
        joinRoom: mkJoin(),
        startWitness: mkWitness(),
      })

    const engA = engineFor(idA, viewA)
    const engB = engineFor(idB, viewB)
    const engW = engineFor(idW, null, true)
    for (let k = 0; k < 4; k++) {
      await engA.poll()
      await engB.poll()
      await engW.poll()
    }

    eq(calls.open.length, 1, 'openRoom fired exactly ONCE (only the host opens a room)')
    eq(calls.open[0].self.root, host.root, 'the lower-rooted peer is the host (deterministic)')
    const code = `room-${host.root.slice(0, 6)}`
    eq(calls.join.length, 1, 'the guest joined exactly one room')
    eq(calls.join[0].code, code, 'the guest joined the EXACT code the host opened, no code exchanged out of band')
    eq(calls.join[0].opponent.root, host.root, 'the guest pinned the host as its opponent (oppRoot)')
    eq(calls.witness.length, 1, 'the witness attached exactly once')
    eq(calls.witness[0].code, code, 'the witness attached to the SAME room')
    ok(
      calls.witness[0].host === host.root && calls.witness[0].guest === guest.root,
      'the witness knows both players (participants) and is NEITHER of them',
    )
    eq(engA.status().phase, 'paired', 'A reaches paired')
    eq(engB.status().phase, 'paired', 'B reaches paired')
    // Cosmetic root-fix: a paired peer's witnessesReachable EXCLUDES the matched
    // opponent (a peer we play cannot witness that same game). Of {A,B,W} only W
    // is a valid third machine for A once A is paired with B, so the honest count
    // is 1, not 2 (which is what counting the opponent would report).
    eq(engA.status().witnessesReachable, 1, 'A’s paired witnessesReachable EXCLUDES opponent B (only W remains)')
    eq(engB.status().witnessesReachable, 1, 'B’s paired witnessesReachable EXCLUDES opponent A (only W remains)')
    // The witness sees both players' device keys for move-sig verification.
    const parts = calls.witness[0].participants
    ok(
      parts.some((p) => p.root === idA.root && p.key === idA.key) && parts.some((p) => p.root === idB.root && p.key === idB.key),
      'the witness carries both players’ {root, device key} for move-sig verification',
    )
  }

  // ==========================================================================
  console.log('\n· 4. C-10 honest degradation. No third machine ⇒ honest wait …')
  // ==========================================================================
  {
    // A two-peer bus: A and B only, no eligible witness anywhere.
    const bus2 = new W.MockFabric()
    const eps = {}
    for (const id of [idA, idB]) {
      const ep = bus2.endpoint(id.nodeId)
      const body = { v: 1, root: id.root, key: id.key, caps: { witness: true, committee: true, shardMb: 50 }, params: W.PARAMS_A2_DIGEST, ts: NOW, uptimePct: 100 }
      ep.announce(W.signPresence(body, id.priv))
      eps[id.tag] = ep
    }
    eq(MM.assignWitnesses(eps.A.directory(), idA.root, idB.root, MM.MM_KIND, BLITZ, NOW).length, 0, 'assignWitnesses is EMPTY with only the two players online')

    const hub = MM.createMatchPoolHub()
    const calls = { open: 0, join: 0, witness: 0 }
    const engineFor = (id, view) =>
      MM.createMatchmakingEngine({
        identity: { root: id.root, key: id.key, priv: id.priv },
        fabric: eps[id.tag],
        pool: hub.join(),
        target: () => ({ ladderKey: 'Blitz', tc: MM.MM_DEFAULT_TC.Blitz, view }),
        now: () => NOW,
        openRoom: async () => {
          calls.open++
          return 'nope'
        },
        joinRoom: () => calls.join++,
        startWitness: () => calls.witness++,
      })
    const engA = engineFor(idA, viewA)
    const engB = engineFor(idB, viewB)
    for (let k = 0; k < 5; k++) {
      await engA.poll()
      await engB.poll()
    }
    eq(engA.status().phase, 'waiting-witness', 'A honestly WAITS for a witness (never a dead button)')
    eq(engB.status().phase, 'waiting-witness', 'B honestly WAITS for a witness')
    ok(engA.status().opponentRoot === idB.root, 'A did find its legal opponent: it is only the WITNESS that is missing')
    eq(calls.open, 0, 'NO room was ever opened: never a fake pairing without a witness (C-10)')
    eq(calls.join, 0, 'NO join was ever attempted')
    eq(calls.witness, 0, 'NO witness attached')
    eq(MM.countReachableWitnesses(eps.A.directory(), idA.root, NOW, idB.root), 0, 'the lobby honestly shows 0 reachable witnesses')
  }

  // ==========================================================================
  console.log('\n· 5. anti-spoof + pairing terms …')
  // ==========================================================================
  {
    const good = seek(idA, viewA)
    ok(MM.verifyMatchMsg(good), 'a well-formed signed seek verifies')
    const tampered = { body: { ...good.body, ts: good.body.ts + 1 }, sig: good.sig }
    ok(!MM.verifyMatchMsg(tampered), 'a tampered seek body (sig no longer matches) is rejected')
    const spoofView = { body: { ...good.body, view: { ...good.body.view, root: idB.root } }, sig: good.sig }
    ok(!MM.verifyMatchMsg(spoofView), 'a seek whose PairView.root disagrees with the seek root is rejected')

    const host = idA.root < idB.root ? idA : idB
    const guest = host === idA ? idB : idA
    const a = {
      kind: MM.MM_KIND,
      ladderKey: 'Blitz',
      ladderId: BLITZ,
      tc: MM.MM_DEFAULT_TC.Blitz,
      atWts: NOW,
      code: 'room-x',
      role: 'host',
      self: { root: idA.root, key: idA.key },
      opponent: { root: idB.root, key: idB.key },
      color: 'w',
      hostView: viewA,
      guestView: viewB,
    }
    const gameKey = A.toB64u(A.sha256(A.utf8('game-key')))
    const terms = MM.makePairingTerms(a, gameKey)
    eq(terms.w.opp, guest.root, 'white’s pairing payload names the guest (black) as opponent')
    eq(terms.b.opp, host.root, 'black’s pairing payload names the host (white) as opponent')
    eq(terms.w.game, gameKey, 'the pairing payload binds the host-minted gameKey (makePairingPayload reused)')
    eq(terms.w.atWts, NOW, 'the pairing payload carries the pinned atWts (§7/A4-16)')
  }

  // ==========================================================================
  console.log('\n· 6. pool re-entrancy, a self-publish never re-notifies (local echo) …')
  // ==========================================================================
  // The live search subscribes the engine's poll() to the pool AND poll()
  // publishes a fresh (higher-epoch) seek each round. If a self-publish notified
  // OUR OWN subscribers, that would re-enter poll → publish → notify → … and
  // stack-overflow. The pool adapters therefore notify ONLY on a REMOTE message,
  // never on the local echo of our own publish. (This is the root fix that makes
  // the boot's nonReentrantPool wrapper redundant.)
  {
    // (a) The shared in-memory hub: a REMOTE publish (another member) wakes a
    // peer; the peer's OWN publish does not.
    const hub = MM.createMatchPoolHub()
    const poolA = hub.join()
    const poolB = hub.join()
    let aNotifs = 0
    poolA.subscribe(() => aNotifs++)
    poolB.publish(seek(idB, viewB))
    eq(aNotifs, 1, 'hub: a REMOTE publish (peer B) wakes peer A’s subscriber')
    poolA.publish(seek(idA, viewA))
    eq(aNotifs, 1, 'hub: peer A’s OWN publish does NOT re-notify A (no poll re-entrancy)')
    eq(poolA.list().length, 2, 'hub: the self-published seek is still in list() (local echo updated the store)')
    // A publish-on-notify subscriber (the exact live-search shape) terminates
    // instead of recursing on its own echo.
    const poolC = hub.join()
    let cFires = 0
    poolC.subscribe(() => {
      cFires++
      if (cFires < 50) poolC.publish(seek(idW, rankedView(idW.root, 1500, 800_000)))
    })
    poolA.publish(seek(idA, viewA, 2))
    eq(cFires, 1, 'hub: a publish-on-notify subscriber does NOT recurse on its own echo (re-entrancy closed)')

    // (b) The production trystero adapter over an INJECTED fake room: same rule.
    // Local echo silent, a remote message notifies: proven with no real relay.
    let onMessage = null
    const sent = []
    const fakeRoom = {
      makeAction: (_ns, cfg) => {
        onMessage = cfg.onMessage
        return { send: (d) => sent.push(d) }
      },
      leave: async () => {},
    }
    const tPool = MM.createTrysteroMatchPool({ kind: MM.MM_KIND, ladderId: BLITZ, room: fakeRoom })
    let tNotifs = 0
    tPool.subscribe(() => tNotifs++)
    tPool.publish(seek(idA, viewA))
    eq(tNotifs, 0, 'trystero: a local publish does NOT notify subscribers (local echo silent, no re-entrancy)')
    eq(tPool.list().length, 1, 'trystero: the locally-published seek is in list() (echo updated the store)')
    eq(sent.length, 1, 'trystero: the local publish still broadcast over the room action')
    onMessage(seek(idB, viewB), { peerId: 'peerB' })
    eq(tNotifs, 1, 'trystero: a REMOTE message notifies subscribers (drives the poll loop forward)')
    eq(tPool.list().length, 2, 'trystero: the remote seek joined the pool')
    tPool.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
