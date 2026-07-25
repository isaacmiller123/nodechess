// A3 storage + overlay parameters (docs/ACCOUNTS-PARAMS.md §Storage, spec §5/§11).
// Like PARAMS_A2 these are NOT frozen-at-genesis: they govern replication,
// repair, and overlay coordination (C-3 ephemeral state), so they can be
// revised. Records that depend on them embed PARAMS_A3_DIGEST so a verifier
// always knows which rule set the record was built under.
import { canonicalHash, type CanonicalObject } from '../codec'
import { toB64u } from '../hash'

export const PARAMS_A3 = {
  v: 1,
  // Erasure coding (§5 layer 3): Reed-Solomon over GF(2^8), any kRec of
  // nShards reconstruct (3.33x expansion).
  nShards: 40,
  kRec: 12,
  // Shard duty (§5): shard i of subject X lives at shardKey(X, i); the
  // dutyK closest capacity-advertising nodes to that key carry it. Viewers
  // enumerate at most dutyK shard pointers per index (contact-sheet cap).
  dutyK: 2,
  // Repair (ACCOUNTS-PARAMS §Storage): scan owned shard space every 6h of
  // online time; re-encode + redistribute when observed live shards for a
  // subject fall below kRec + repairHeadroom.
  repairScanMs: 21_600_000,
  repairHeadroom: 8,
  // Publish-on-write replication (§5): witnessed events + pointer records
  // are stored on the replicateK overlay-closest nodes to the subject key.
  replicateK: 8,
  // Advertised capacity envelope (§11), MB per platform. A node's actual
  // budget rides PresenceBody.caps.shardMb; these are the defaults each
  // platform advertises.
  budgetDesktopMb: 200,
  budgetBrowserMb: 50,
  budgetMobileMb: 15,
  // Kademlia overlay (§5): routing only; trystero/Nostr is transport+bootstrap.
  kBucket: 16, // contacts per bucket AND the k of "k closest" lookups
  alpha: 3, // parallel in-flight probes per iterative lookup round
  rpcTimeoutMs: 10_000, // per-RPC budget on real transports (mock: instant)
  bucketRefreshMs: 3_600_000, // refresh idle buckets hourly (online time)
  // Hint-book bound (anti-DoS): FIND_NODE responses feed a supplementary hint
  // book that drain-mode lookups also probe. Capped (FIFO, oldest evicted) so a
  // malicious responder padding replies with binding-valid junk cannot inflate
  // memory OR the drain probe count without limit: the cost becomes a constant
  // (knownCap + table), never attacker-scalable. The routing table (separately
  // anti-eclipse-bounded) still backs lookup correctness, so bounding hints only
  // trims a supplementary source, never a load-bearing one.
  knownCap: 256,
  // Viewing flow (§5): profile page from the freshest holders.
  viewerHoldersMax: 5,
  viewerHoldersMin: 3,
  // Per-node stored-pointer cap per subject key (index-poisoning bound;
  // the enumeration cap is structural: real entanglements + dutyK per shard).
  pointerCapPerKey: 128,
  // Chain slice paging for lazy history (~2 KB/game budget, §5).
  eventsPageMax: 32,
} as const satisfies CanonicalObject

export const PARAMS_A3_DIGEST: string = toB64u(canonicalHash(PARAMS_A3))
