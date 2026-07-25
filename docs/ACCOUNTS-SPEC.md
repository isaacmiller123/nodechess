# Decentralized Accounts — binding spec (v1.1)

Authoritative design for the database-less account system. User decisions locked 2026-07-14.
v1.1 (same day) folds a 33-finding adversarial review: the witness fabric is now defined, rating
fold inputs are pinned, the PIN committee is bound, checkpoints are self-verifying, wire
signatures are scheduled as new work, and the build phases were reordered to match real
dependencies. Builders conform to this exactly; deviations need owner approval. This spec
supersedes the interim server-account system (server/auth.ts + per-user DBs) once phase A-final
ships — see §14.

**The goal, in the owner's words:** accounts without a database — not for anonymization, but for
nodes and network verification. Ratings, bans, reputation, profiles, and anticheat all exist and
all run client-side, unspoofable, under identical rules for 2 users and 2 million, on desktop and
in the worst-case browser.

## §0 Prime directive

**No node holds authority. Some nodes are merely awake.** Authority lives in keys held by users;
availability lives in dumb, replaceable replicas; the two never meet. Every claim about an
account — rating, trust/reputation, ban state — is a **pure recomputable function over public
signed data** (the subject's chain plus threshold-signed witness records, §4): never asserted,
always re-derivable by any verifier, bit-identically.

The one-line model: *your account is a signed file you carry; every game writes itself into both
players' files; everyone online holds a few pieces of everyone else; to view anyone you gather
the pieces and check the math yourself.*

Security stance, stated honestly everywhere: **tamper-evidence, not tamper-proofness.** A modified
client can lie — it cannot lie consistently to a network that remembers. Every mechanism below is
designed so tampering is detectable by anyone, forever, and strictly worse than compliance
("rational-actor security").

## §1 Identity

- **Derivation**: `argon2id(password, salt = username) → 32-byte seed → ed25519 root keypair`
  (SLIP-0010 hardened derivation for private child keys). Creating an account is pure local
  computation; signing in on any device is re-derivation. No signup round-trip, no email.
  Crypto deps: an audited ed25519 library (e.g. @noble/ed25519) + hash-wasm **promoted to
  `dependencies`** with its first renderer-side import — both A1 deliverables.
- **Display identity**: `name#TAG`, TAG = first 4–5 base32 chars of the root pubkey fingerprint.
  Self-derived — no registry, no squatting; collisions disambiguate by tag. The network's role is
  verification only.
- **Key certificates** (not public HD derivation — ed25519 child pubkeys are not publicly
  derivable from a root pubkey): every child key (device, session, context) is introduced by a
  **root-signed key certificate** `(child pubkey, purpose, index)` carried in the chain.
  "The network picks the key" = a verifier picks any enrolled child from the chain and challenges
  a fresh signature under it; siblinghood is proven by the certificates. Bans and trust bind to
  the **root** and cannot be shed by key rotation.
- **Devices**: enrollment is a **personal-lane** root-signed certificate — valid offline, and
  sufficient for local/offline use. **Witnessed-zone participation** by a device additionally
  requires its enrollment to be witness-countersigned at first witnessed contact (PIN-gated, like
  lease takeover). A witnessed revocation invalidates all enrollments with earlier witnessed
  timestamps — so a password thief's silent offline enrollments never outrank the owner's
  witnessed revocation.
- **Recovery**: none, by design. The client nudges a mnemonic/keyfile export at creation and
  states the deal plainly. (C-5.)
- **PIN** (4–8 digits): gates the witnessed zone only. Password alone = full local/offline use +
  unrated link-play. Mechanics, bound tight (closes the committee attack):
  - Verification is a **threshold OPRF against a bound committee**: at PIN creation, a witnessed
    root-signed record fixes a T-of-N committee drawn by key-distance from the witness fabric
    (§4). Members hold shares + a **threshold-replicated failure counter**. They can neither
    learn the PIN nor derive keys.
  - **Any re-share or re-provision of the committee is a PIN-gated handoff that carries the
    counter forward** — a fresh committee can never start at zero, so a password thief cannot
    reset the fuse by re-provisioning to nodes he controls. Proactive re-sharing under threshold
    control preserves shares + counter across churn.
  - **100 lifetime failures → 90-day witnessed-zone ban.** On the 100th failure the committee
    emits a **threshold-signed fuse-tripped record** (root, witnessed timestamp, expiry),
    published into shard/pointer space under the account's key — a public signed fact any
    verifier can check (§0 holds). Lease grants and game-witnessing MUST check it; witnessing for
    a fuse-banned root within the window is witness misbehavior.
  - **Post-trip rule**: the counter never resets on success; on ban expiry it refills headroom by
    R (default 20) — each subsequent trip needs R further failures. "Lifetime" means lifetime.

## §2 The chain

An account is a **self-carried, append-only, hash-linked log of signed events**. Two lanes:

- **Witnessed lane** — rated games, bans, conduct events (§7), friendship add/accept/remove (§3),
  device revocations, witnessed device enrollments: anything others must trust. Strictly
  **single-writer**, serialized by the write lease (§4); every event carries witness
  countersignature(s) and a witnessed timestamp. **A same-epoch fork in the witnessed lane is
  fraud** — two signed successors of one head under one lease epoch are self-authenticating
  proof, slashable on sight (§4 defines the one innocent-looking case and its adjudication).
- **Personal lane** — profile, bio, avatar, settings, School progress, device enrollment
  certificates: self-signed, mergeable CRDT-style across devices; concurrent writes are sync
  noise, not fraud.

**Checkpoints — self-verifying, never trusted.** Every N_ckpt witnessed games, a checkpoint
records the account's derived state (per-ladder rating/RD, trust inputs digest, ban state). A
checkpoint MUST: (a) embed the prior checkpoint's snapshot, (b) equal exact recomputation of the
fold over the covered segment range from that prior snapshot — **incrementally verifiable in one
step**, and (c) carry **M-of-N cosignatures from distinct eligible witnesses** (§4). A checkpoint
whose snapshot fails recomputation is self-authenticating fraud — slashable for the subject AND
the cosigning witnesses, exactly like a fork. Viewers on the fast path verify the incremental
step from the prior checkpoint; additionally they **spot-check** (re-derive a deeper range) with
probability p_spot, and always when the cosigner set lacks diversity. "Verify from genesis"
remains the full audit. Nothing on any path accepts an asserted number without a verification
rule attached.

Avatars and profile fields are small (avatar = base64 ≤ ~32 KB); a 10,000-game chain is tens of
MB; viewing fetches slices.

## §3 Entanglement

Every rated game produces a **pairwise countersigned segment** written into BOTH players' chains.
Contents: the move transcript with **per-move signature chaining** — each move message signed by
its mover over `(gameId, ply, move, clockMs, prevMoveSig)`, countersigned by the receiver's next
message, with the witness signing the interleaved stream (this is **new wire work**, §14-A3: the
shipped mp wire carries no signatures and host-authoritative clocks; wire v6 bumps
PROTOCOL_VERSION, adds a `witness` hello role, and reworks the two-peer session to admit exactly
one witness peer) — plus both chain heads at game time, witness signature + witnessed timestamp,
**each player's latest M-of-N-cosigned checkpoint** (rating, RD, checkpoint hash — the fold input,
§6), and a copy of each player's current profile record (~1–2 KB, the reconstruction snapshot,
§5).

Consequences, load-bearing:
- Partners **structurally cannot drop shared segments** — deletion breaks their own hash chain.
  Game history is physically distributed across everyone you ever played, retained by necessity.
- Rolling back contradicts heads embedded in other chains → fork detection spreads by gossip.
- **Result adjudication (closes rage-quit denial)**: the witness countersignature plus the signed
  transcript up to resignation/timeout/flag constitutes a **valid witnessed result** which the
  witness publishes for both chains. A player cannot deny a loss by withholding his final
  countersignature: a chain missing a witness-adjudicated decisive result it should contain is a
  tamper signal, treated like verdict suppression (§8) — strictly worse than accepting the loss.
- **Friendships are witnessed-lane entanglements**: request (signed; delivered live or via
  mailbox) → countersigned acceptance in both chains; removal is a unilateral signed witnessed
  event. Riding the witnessed lane gives friend lists fork protection — one verifiable list, not
  different lists for different audiences. Every edge carries two signatures.

## §4 The witness fabric

**Canonical witness set.** Each account's witness set is a deterministic function of its root
key: the W_n closest **eligible** live nodes by key-distance in the overlay (§5's metric).
Eligibility: minimum own-trust floor, uptime attestation, and **entanglement-distance from the
subject above a floor** (a node you mostly play/befriend cannot witness you — closes sock-puppet
witnessing). At populations too small to fill W_n, any eligible node serves (the operator peer
exists for exactly this); the M-of-N and diversity rules below still bound what any single
witness can attest.

- **Rated play requires ≥1 witness that is neither player** — and the honest boundary, stated
  plainly: with exactly two machines online and no third reachable, rated play is unavailable
  until one appears (degrades honestly, never a dead button). The operator's always-awake peer
  makes that window negligible; it follows the same rules, holds zero authority, and its removal
  costs availability at minimal scale — never truth, never data. (C-10.)
- **Witness = replicator**: signing an event and storing it are one act; the witnessed lane is
  complete at its witnesses by construction.
- **Write lease, with epochs (closes split-brain slashing).** A lease is valid only if signed by
  a **threshold T_lease of the canonical set** and carries a **monotonic epoch (fencing token)**;
  the threshold intersection makes two valid overlapping-epoch leases impossible. Devices append
  witnessed events only under a live lease; second device → "playing elsewhere"; expiry frees
  takeover; **takeover requires a PIN-gated witnessed session**. Slashing distinguishes: two
  successors under **one** epoch = user fraud, permanent; successors under **different epochs
  with conflicting witness grants** = witness fault — the accused presents the lease-epoch
  evidence (an automatic, mechanical appeal) and the faulty grantors are the ones slashed.
- **Witnessed time, diversity-bound (closes timestamp forgery).** A witnessed timestamp is valid
  only within a bounded window of the witnessing nodes' independently observed network time, and
  any timestamp bearing on **account age, ban expiry, or staleness** requires attestation by
  witnesses that are entanglement-distant from the subject. A self-adjacent witness cannot mint
  accepted time; fake account aging is closed (§9 pricing holds).
- The lease, presence, and mailbox are ephemeral coordination state — expiring, reconstructible,
  no authority. (C-3.)
- Unwitnessed zone (offline, link-play, local bots): unrestricted by design — nothing there
  touches state others must trust.

## §5 Storage & reconstruction (no database, ever)

**Law acknowledged**: computation cannot create history; offline data must already sit on
reachable machines. The network of clients IS the storage. Three retention layers:

1. **Entanglement gravity** (§3) — game history, near-immortal.
2. **Friend pinning** — friends replicate each other's full chains.
3. **Shard duty** — every witnessed-zone participant carries erasure-coded shards of other
   accounts' chains (N_shards per chain, any K_rec reconstruct; defaults 40/12), assigned by
   key-distance, with background **repair**. Capacity is advertised per platform (§11); browser
   eviction = churn = healed.

**The overlay is new work, named as such**: a Kademlia-style key-distance overlay
(routing tables, iterative lookups, bootstrap) built over WebRTC data channels — the shipped
trystero/Nostr fabric provides **transport and bootstrap only** (pairwise rooms via public
relays), not routing. Signaling currently rides third-party Nostr relays + public TURN; both must
be replaceable, with the operator peer as fallback relay/bootstrap. (C-11.)

**Publish-on-write**: witnessed events replicate at creation; personal-lane records push at next
sync; a final sync leaves the full chain in shard space.

**Authenticated pointer records (closes index poisoning).** At game end each player publishes a
signed pointer ("I hold a segment of X, hash H") into shard space under X's key. A pointer is
valid only if it **embeds the countersigned segment header it references** (X's head signature +
witness countersignature) or a verifiable shard-assignment proof — so only real entanglement
partners and assigned shard-carriers can mint pointers a viewer will enumerate. Viewers rank by
embedded proof and ignore the rest; the contact sheet is capped at real entanglements + assigned
shards. The index is built at write time; viewing never searches.

**Viewing flow** (acceptance scenario locked: 1,000 games, owner gone forever, 300 opponents
active): resolve key → overlay lookup (~log N hops) → authenticated pointer list → profile page
from the 3–5 freshest holders: newest profile snapshot + newest M-of-N checkpoint (verified
incrementally, spot-checked per §2) + head — renders in chess.com-profile time. Game history
lazy-pages (~2 KB/game). **Guaranteed floor**: the union of survivors' holdings. **Expected**:
everything, via shard layer + final sync. Failure mode is *temporary unavailability that heals*;
the true kill condition (every carrier gone before repair) is remotest for game history, most
real for the personal lane of a friendless inactive account. (C-8.)

## §6 Ratings

- **One ladder per (game kind × TimeCategory)**, bound to the shipped enum — Bullet, Blitz,
  Rapid, Classical (`timeControlCategory`). **Unlimited games are unrated** (no clock stream →
  no timing forensics). A **Daily ladder is deferred** until a correspondence mode exists.
- Glicko-2 (the app's `glicko2.ts`), all seeds identical: 1200, RD 350. **10 placement games per
  ladder** ride a held-high RD floor.
- **Fold inputs are pinned (closes the recursion/forgery hole):** the fold consumes opponent
  (rating, RD) **only from the M-of-N-cosigned checkpoint embedded in the game segment** (§3) —
  never self-asserted numbers, never live recursion into opponents' chains. A segment whose
  embedded checkpoint does not match the opponent's actual chain at that height is fraud,
  slashable like a fork. A full audit verifies embedded checkpoints one level deep into opponent
  chains and relies on fork-detection gossip beyond — bounded, so §5's timing guarantees hold.
- **Hidden until the per-ladder reveal threshold** (default 100; per-category values are open
  parameters). Display states derived identically by every client from public data:
  `Placement (n/10)` → `Provisional (n/100)` → `Ranked`.
- **Honest limit (C-4)**: the number is always computable by a modified client — hiding is a
  rendering rule. It works because a rating is a judgment *other machines* make: every compliant
  client renders Unranked, on every surface, for everyone. Self-computed numbers have no
  audience, no credential, no precision (§7), no future (§8).
- Provisional players see **no opponent ratings or brackets** on any surface (matchmaking,
  in-game, post-game). The spillover bracket (§7) is a protocol quantity used only in
  pairing-legality checks and rendered to ranked players + spectators — never to the provisional,
  whose surfaces show "Unranked opponent pool." Both clients verify bracket legality.

## §6b Reputation (distinct from rating and from trust)

The owner's list names three separate things: Elo (§6), **reputation** (public conduct standing),
and trust (§7, the private anticheat/matchmaking signal). Reputation is its own deterministic fold
over **witnessed conduct events** — completed vs. aborted games, disconnect/abandon rate,
timeout-vs-resign behavior, sportsmanship (accepted rematches, no-show rate), and **countersigned
peer commendations** (a signed "good game" event, one per opponent per game, rate-limited by the
entanglement so it can't be farmed). The fold yields a coarse public badge (e.g. a 0–100 conduct
score or a tier), shown on the profile like chess.com's. It is recomputable from the chain like
everything else, embedded in checkpoints (§2), and — unlike trust — **fully public and visible
from game 1** (conduct isn't hidden; only competitive rating is). Reputation never gates
matchmaking width (that's trust); it informs humans and can weight the friend-request and mailbox
priority (§10). Serialization of conduct events + the fold is an A4 deliverable.

## §7 Matchmaking — trust-width pairing

**Trust score T ∈ [0,1]**: a pure function over the public chain — clock forensics, ACPL-vs-strength
fit, engine-match aggregates (all Tier-1 judge outputs, §8), account age (diversity-bound
timestamps, §4), **entanglement-weighted opponent diversity**, fork/checkpoint cleanliness.
Deterministic: both sides recompute anyone's T and verify a pairing was legal.

- **Opponent diversity is entanglement-weighted (closes sybil farming):** each opponent's
  contribution to the diversity term is scaled by *that opponent's own independent trust and
  entanglement-distance from the subject* — fresh, low-trust, or closely-entangled sock puppets
  contribute ≈0, so a farm of throwaway roots (free under C-6) buys no width benefit.
- **Pairing width is a continuous curve on T**: ±50 at high trust → ±500 at the floor, plus an
  **island term** attracting comparable-suspicion accounts to each other. Two half-engine cheaters
  paired together must escalate to full-engine play to keep winning — statistically deafening (§8)
  on transcripts they generate for the judge themselves. High trust *earns* precision matchmaking;
  keeping it tight requires playing like your history.
- **Bounding the conviction oracle (closes threshold-surfing):** because T and verdicts are
  recomputable, a cheater has a local oracle for his exact distance to conviction and could meter
  assistance to sit just under it. Two required defenses, both calibrated in A5 with proof
  obligations: (a) the Tier-2 calibration MUST demonstrate the margin between *undetectable* and
  *advantageous* is empty — threshold-ε cheating yields negligible expected rating gain; and
  (b) the K-window boundaries and evaluation cadence carry **witness-derived commit-reveal salt**,
  so the exact frontier is not locally predictable *before* the games are played, while verdicts
  stay fully recomputable *after* reveal. The judge stays auditable; the frontier stops being a
  targetable line.
- **Provisional-first pools**: provisionals pair with provisionals (zero rating signal).
  Spillover to ranked opponents uses **wide quantized brackets** (e.g. 1600–2400) so an opponent's
  rating estimates nothing precise; Glicko's RD-discount means these games barely move a ranked
  rating. Liquidity in every growth regime without hostage stakes.
- **Soft signal → soft consequence; hard proof → hard consequence.** Suspicion only ever widens
  pairing — invisible, reversible, decaying with clean play. Anticheat bans come only from the
  Tier-2 judge (§8); an honest hot streak might drift someone to ±120 for a week with nothing
  visible or permanent.

## §8 Anticheat — the canonical judge

**Foundation**: the app ships the judge, bit-deterministic on every machine. The judge **always
loads the single-thread WASM Stockfish build by content hash** (today's non-isolated fallback,
`stockfish-18-lite-single`), on every platform — **bypassing** the context-sensitive engine
selection in `src/web/engines/assets.ts` (which stays for play/analysis). It runs on a
**judge-dedicated engine instance** never shared with the play/analysis pools, at **fixed node
counts** (never depth/time), **fixed MultiPV**, a **pinned small Hash** (≤16 MB, allocatable on
the weakest supported device), with a mandated `ucinewgame` + TT clear before every judged game.
Same transcript → same verdict bits on a gaming rig or a phone, today or in ten years. Verdicts
are pure functions of countersigned data (transcript + signed clocks, §3): trusted because
reproducible, not because client-resident. (Determinism gate in §14: same transcript replayed
after arbitrary prior engine use yields identical bits.)

- **Tier 1 — every rated game, everywhere.** Background on both clients + the witness (seconds
  desktop, tens mobile). Signals: centipawn-loss vs. estimated strength (`accuracy.ts` + estElo —
  the math ships, but the estElo anchor fit **must be re-run against a corpus analyzed at the
  judge's fixed-node config**, via the existing corpus/fit harness, before it feeds T; the shipped
  fit is depth-12 MultiPV-2 and does not transfer), engine-match rate against a MultiPV
  *score-equivalence window* (absorbs engine variance — never exact-move matching), clock
  forensics (think-time vs. **position complexity re-derived by the judge from its own fixed-node
  MultiPV output** — the shipped `complexityMultiplier` fold, never play-time probe values, which
  are nondeterministic and bot-pacing only), strength trajectory. Tier-1 output feeds T only.
- **Tier 2 — the only *anticheat* ban trigger** (§9 has other ban types). Deep fixed-node
  deterministic analysis, fired on a **deterministic, protocol-defined escalation condition** (a
  pure function of the chain, so every compliant client provably knows when the obligation fires —
  not an ad-hoc client heuristic). Runnable by anyone: opponent, witness (holds the segment
  regardless — colluders can't suppress), or a stranger later. **Aggregation, not gotchas**:
  Regan-style accumulated evidence over a K-game window with astronomically-low false-positive
  thresholds; no single game convicts. **Receipts always**: the accused re-runs the exact judge on
  the exact transcripts.
- **Verdict records**: a Tier-2 verdict is a signed record (by the computing party, reproducible
  by anyone) published into shard space under the accused's key — the channel verdict-portability
  adopts from, so phones adopt + spot-check network-computed verdicts.
- **Self-ban, with a defined deadline (closes the compliant-client trap):** the ban obligation
  anchors on the **deterministic conviction condition** — the accumulated statistic crossing the
  astronomically-low-FPR conviction line (5σ; per-look FPR ≈ 2.9e-7, union-bounded < 3e-3 over
  10⁴ windows) on either the trailing-K window or the lifetime accumulation — NEVER on the 3σ
  escalation condition, which obliges only the deeper Tier-2 analysis. *[DECIDED 2026-07-22,
  resolving this section's prior ambiguity ("deterministic trigger" vs "astronomically-low
  thresholds"); prime directive: an honest player is never banned. A 3σ-gated obligation carries
  ≈1.35e-3/window one-sided FPR — an honest 1k/3k/10k-game career would eventually owe a false
  90-day self-ban with probability ≈23%/58%/94%, the §0 false-fraud this spec forbids. Sustained
  metering still convicts via the lifetime accumulation (≈4 windows at 2.6σ/window).]* On the
  conviction firing, the honest client MUST append a signed self-ban **before any further
  witnessed-lane event** after the conviction-completing game. Suppression is provable *only*
  relative to that deterministic conviction — never relative to an arbitrary third-party Tier-2
  run, and never relative to mere escalation — so a compliant client that never had cause to run
  Tier-2 is never condemned by a stranger's later computation until the conviction condition is
  itself met on-chain. A conviction with no timely self-ban → permanent distrust; serving the
  90-day sentence is the lenient path.

## §9 Bans, rerolls, and the smurf economy

- **Ban taxonomy** (Tier-2 is the only *anticheat* trigger; the others are their own mechanisms):
  anticheat self-ban (90d; suppression → permanent, §8); PIN-fuse ban (90d, threshold-signed
  fuse-tripped record, §1); fork/equivocation (permanent on same-epoch proof, §4). All bind to the
  root; all expiries use diversity-bound witnessed time (§4). A verifier derives ban state from
  public signed records — no blocklist.
- **Rerolling is unpreventable and priced (C-6):** a fresh root enters naked — floor trust (±500,
  island-adjacent), provisional invisibility, zero history, re-pays the reveal-threshold wall under
  a judge watching every move, and **cannot fake age** (diversity-bound timestamps, §4). The hidden
  period is a containment chamber: ~17 hours of judged, unrewarded exposure before a rating exists
  to flex, expected outcome "burned before reveal." The smurf economy runs on fast visible payoff;
  this prices it negative.

## §10 Social surface (chess.com-parity behaviors)

Sign-in anywhere (derivation, not lookup) · edit profile (signed personal-lane records) · view
anyone incl. years-offline (§5; staleness shown as "last witnessed activity") · friends add/remove
(witnessed countersigned edges, §3) · reputation badge (§6b) · presence (ephemeral) ·
stats/history/rating graphs (viewer-derived). **Mailbox anti-spam (closes friend-request floods):**
relaying peers enforce per-sender-root rate limits + per-recipient fair-share quotas, prioritizing
senders with an existing entanglement/trust/reputation edge, so a sybil flood can't evict requests
from established roots before the offline recipient next syncs. Visible deltas from chess.com,
accepted: `name#TAG` (no unique names); no password reset (C-5).

## §11 Platform parity — browser is the design point

The protocol asks only what you did (deterministic by count), what you signed (universal), what you
can carry (advertised):

- **Judge**: node-count determinism → identical verdicts, different wall-clock. The judge pins the
  **single-thread build unconditionally** (§8) — NOT the context-sensitive two-build auto-selection,
  which is for play/analysis only; "identical binary everywhere" means the judge's binary, by hash.
  Phones run Tier 1 natively and adopt + spot-check Tier 2 (verdict portability).
- **Storage**: advertised per platform — desktop app hundreds of MB, desktop browser ~50 MB (with
  `navigator.storage.persist()`), mobile ~10–25 MB. Eviction = churn = repaired.
- **Network**: WebRTC as shipped; the §5 overlay is new work over it. Backgrounded tabs throttle →
  seen as offline, tolerated.
- **Crypto**: ed25519 (audited lib, §1) + argon2id via hash-wasm (**promote devDep → dependency +
  first renderer import**, A1) — sub-second to seconds on phones; checkpoint-first loading keeps the
  common path in milliseconds.
- **The operator's always-awake peer needs two new integrations to be a real peer** (not "just
  evolves"): a Node WebRTC binding to join the fabric, and a Node harness for the pinned judge WASM
  (worker/loader shim) — both A2 deliverables, since it is also witness-of-last-resort.

## §12 Accepted compromises (the honest ledger)

- **C-1** Peers keep local caches / gossip memory (heads, chains, shards, pointers, checkpoints) —
  distributed, reconstructible, unauthoritative. Without it fork detection has amnesia.
- **C-2** The PIN lifetime counter requires committee-held threshold state (§1). An unwitnessed
  counter against an adversary who owns the only machine that saw the failures is impossible.
- **C-3** Ephemeral coordination state exists: leases, mailboxes, presence. Expiring,
  reconstructible, no account data, no authority.
- **C-4** Rating hiding is a protocol rendering rule, not cryptography (§6).
- **C-5** No credential recovery; mnemonic/keyfile export is the lifeline.
- **C-6** Fresh-identity rerolls cannot be prevented, only priced (§9).
- **C-7** Ban expiry and thresholds require witnessed time (diversity-bound, §4).
- **C-8** Most fragile data: the personal lane of a friendless, long-inactive account.
- **C-9** A clique playing only among colluding members could same-epoch fork within the clique;
  detection probability grows with network mixing and the entanglement-distance witness rule (§4).
- **C-10** The operator's always-awake peer improves availability + is witness-of-last-resort; it is
  protocol-optional, unprivileged, removable without loss of truth/data/function (only availability
  at minimal scale). Rated play genuinely requires a third machine (§4).
- **C-11** The §5 overlay is new work; signaling/bootstrap currently ride third-party Nostr relays +
  public TURN, which must be replaceable (operator peer as fallback).
- **C-12** On the reconstruction floor (owner gone, <`K_rec` shard rows, no chain linkage to vet a
  revoke's signer), a device-signed revocation minted with a leaked certified key is
  indistinguishable from the legitimate cold-root flow, so honoring it — required so a
  device-revoked key cannot forge (§0) — can transiently hide an honest device's content: the
  viewer shrinks the case (root-refuted signers ignored, contested pairs gate both), surfaces it as
  `revocationContested`, and any reconstructing chain adjudicates and heals it (§14 — degraded,
  self-healing, never silent).

## §13 Open parameters (set at build time, calibrated where noted)

`TAG_len` (4–5) · ed25519 lib choice · `W_n` witness-set size · `T_lease` / `M`-of-`N` checkpoint
cosigners / PIN `T`-of-`N` committee · witness eligibility floors (trust, uptime,
entanglement-distance) · witnessed-time window bound · `N_shards`/`K_rec` (40/12) · per-platform
shard budgets · `N_ckpt` + `p_spot` spot-check probability · per-category reveal thresholds (100
blitz/rapid; Daily deferred) · placement RD floor · trust-width curve (±50…±500) + island weight ·
opponent-diversity weighting · spillover bracket width · **judge**: `T1_nodes`/`T2_nodes`, MultiPV,
pinned Hash MB, TT-reset granularity, binary content hash · estElo refit under judge config · Regan
K-window + z-threshold + commit-reveal salt derivation · lease TTL + heartbeat + epoch · PIN
committee failure cap (100) + refill R (20) + ban 90d · mailbox retention + quotas · reputation
fold weights.

## §14 Relationship to the current system + build phases

The shipped web accounts (server/auth.ts sessions, per-user DB files) are **interim**, in service
until A-final. The content plane (puzzle DB, curriculum, famous, personas — *content, not account
data*) stays conventionally served, out of scope. The operator's Fastify node evolves into the
always-awake peer (§11's two integrations required).

Phases reordered to match real dependencies (each ends green, desktop untouched, headless
multi-client suites in the test-mp mock-pair style):

- **A1 — Identity & keys**: derivation, tags, key certificates, chain format + two lanes, local
  keyring, mnemonic export, ed25519 + hash-wasm packaging. Proof: create / sign-in / local device
  enroll fully offline; chains verify headless.
- **A2 — Witness fabric + PIN**: canonical witness set, write lease with epochs, diversity-bound
  witnessed time, the tOPRF PIN committee (**pulled here — leases depend on it**), operator-peer
  Node WebRTC + Node judge-WASM harness. Proof: lease grant/takeover PIN-gated; a forced
  same-epoch fork is slashed and a different-epoch double-grant is appealed, in test.
- **A3 — Overlay + storage + wire v6**: Kademlia-over-WebRTC (routing, iterative lookup,
  bootstrap), shard duty + repair, authenticated pointers, reconstruction viewer, **wire v6**
  (PROTOCOL_VERSION bump, `witness` role, per-move signature chaining, countersigned clock stream).
  Proof: the §5 acceptance scenario (owner gone, partners reconstruct) in a multi-client harness;
  wire v6 signatures verify; existing test-mp stays green behind a version gate.
- **A4 — Ratings, reputation, matchmaking**: per-ladder Glicko folds with checkpoint-embedded
  inputs, placement, hidden/provisional rendering, conduct events + reputation fold, trust score
  (chain-shape terms; forensic terms weighted in at A5), width curve + island + pools. Proof:
  pairing legality verifiable by both clients; hidden numbers render Unranked everywhere;
  reputation badge derives from the chain.
- **A5 — Anticheat**: canonical judge pinning, Tier 1/Tier 2, estElo refit under judge config,
  oracle-margin + commit-reveal calibration, self-ban + suppression rule, verdict records. Proof:
  seeded cheater bots convicted within the K-window; honest holdout never flagged; verdicts
  bit-identical across desktop/browser/mobile; determinism gate (replay-after-warmup identical).
- **A6 — Social & polish**: profiles, friends, presence, mailbox + anti-spam, multi-device polish,
  full chess.com-parity walkthrough on web + desktop + a phone browser. **A-final** flips off the
  interim server accounts.

**Quality gates (every phase)**: desktop build + existing suites stay green; every fold / verdict /
score is deterministic under test (same inputs → same bits on node and in the browser bundle); no
dead buttons (honest degradation when peers/witnesses are scarce, incl. the 2-user rated-play
boundary); browser worst-case exercised in CI for at least chain verification + the judge.

## Prior art (the documented portions)

PGP web of trust · timeline entanglement (Maniatis–Baker 2002) · Secure Scuttlebutt (signed feeds,
gossip) · TrustChain (pairwise half-blocks, no global consensus) · Certificate Transparency
(append-only + fork proofs) · PoS slashing (equivocation punishment) · threshold OPRF / Signal SVR
(distributed PIN counting) · SLIP-0010 + key certificates (ed25519 child binding) · Kademlia
(key-distance overlay) · Freenet/IPFS/Storj (erasure coding + repair) · Regan z-scores & Lichess
Irwin (statistical cheat detection). The composition — entangled personal chains +
deterministic-committee witnesses + self-jailing clients + trust-width matchmaking + a
bit-reproducible judge — is the novel part.