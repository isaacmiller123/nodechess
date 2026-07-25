# Decentralized Accounts — §13 parameter decisions (build-time defaults)

Companion to docs/ACCOUNTS-SPEC.md v1.1. Every §13 open parameter, the chosen default, and the
rationale. Parameters marked **[SIGN-OFF]** want Isaac's explicit approval; everything else is a
sensible default changeable before A-final without migration pain. Parameters marked
**[A5-CALIBRATED]** get provisional values here and final values from the A5 calibration runs
(which carry proof obligations per spec §7).

Wire-format-affecting parameters (marked **[FROZEN-AT-GENESIS]**) are baked into every chain's
genesis event as a `params` digest, so verification rules can never drift under existing chains:
a chain is verified under the parameters it was created with, and parameter revisions create a
new params version that only applies to chains/segments created after it.

## Identity & crypto

| Param | Default | Rationale |
|---|---|---|
| `TAG_len` | **5** base32 chars (25 bits) | 4 chars = 1M tag space — birthday collisions get common at tens of thousands of users; 5 chars keeps accidental collision rare at 2M users while staying screen-friendly (`isaac#K7Q2M`). |
| ed25519 lib | **@noble/ed25519 3.1.0** (+ @noble/hashes 2.2.0 for sha512 wiring) | Audited, zero-dep, ships pure ESM usable in browser/node/worker identically. Sync API wired once via `hashes.sha512`. @noble/ed25519, @noble/hashes, @scure/bip39, @scure/base, hash-wasm are all EXACT-pinned in package.json `dependencies` (no carets — a silent minor bump of a key-derivation dep is a determinism hazard). @noble/hashes is declared explicitly, never relied on as a transitive. |
| Mnemonic | **BIP39, 24 words** (@scure/bip39 2.2.0), encoding the 32-byte argon2id seed | Audited sister lib; 256-bit seed = 24 words. Keyfile export = JSON `{v: 1, kind: 'chess-sharp-keyfile', name, tag, seed}` with `seed` base64url-no-pad (plaintext by design — it IS the lifeline; UI copy states it plainly). |
| argon2id derivation params | **m=64 MiB (65536 KiB), t=3, p=1, out=32 raw bytes** via hash-wasm | **[FROZEN-AT-GENESIS]** — these are part of key derivation; changing them changes everyone's keys. Measured ~98 ms on an M-series desktop; the 1–3s phone estimate is verified as an A1 acceptance item BEFORE these are truly frozen. Same params regardless of platform. Distinct from server/auth.ts's interim password-hash params (m=19456 KiB, t=2, p=1, random salt, encoded output) — the two argon2 call sites must never share helpers. |
| Username normalization | **NFKC → trim → case-fold (lower)** | **[FROZEN-AT-GENESIS]** Sign-in must derive identical keys for "Isaac", "isaac", "Ｉsaac". Display name preserves the user's original casing (carried in the profile record); the folded form feeds the salt. Zero-width/control chars stripped; 3–24 chars, printable. |
| argon2 salt derivation | **salt = sha256(utf8(foldedUsername))** — 32 bytes | **[FROZEN-AT-GENESIS]** The spec's "salt = username" cannot be literal: hash-wasm rejects salts < 8 bytes and folded usernames go down to 3 chars. Hashing preserves the semantics (deterministic, per-username) and satisfies the length rule. |
| Password normalization | **NFKD** before argon2id (`pwNorm: 'nfkd-v1'`) | **[FROZEN-AT-GENESIS]** BIP39 precedent. Visually identical passwords typed through NFC- vs NFD-emitting pipelines (macOS filename copy, some IMEs) must derive the same key — with no recovery (C-5), a mismatch is silent permanent lockout. Found by the A1 adversarial review. |
| Unicode data drift | Engine-provided `normalize()`/`toLowerCase` — **accepted limitation** | Normalization of codepoints assigned AFTER an engine's Unicode data version can differ across engines (e.g. U+32FF pre/post Unicode 12.1). Affects only names using newly-assigned codepoints on old engines; the failure mode is "name derives a different account on an outdated client", self-healing on update. Pinning would mean shipping Unicode tables (~MBs) — declined. |
| Child-key paths | SLIP-0010 hardened, path `m/purpose'/index'`; purposes: `0=device`, `1=session`, `2=context` | Matches spec §1 certificates: cert = root-signed `(childPub, purpose, index)`. Hardened-only (ed25519 has no public derivation — certificates are the public binding, per spec). |
| Hash (chains, ids, fingerprints) | **SHA-256** (@noble/hashes) | Universal, cheap, hardware-accelerated everywhere; hash-wasm stays argon2-only. Event id = sha256 of canonical bytes. Tag fingerprint = sha256(rootPub). |
| Canonical serialization | **Deterministic JSON**: UTF-8, lexicographically sorted keys, no whitespace, **integers only** (no floats anywhere in signed payloads; fixed-point micro-units where fractional values exist, e.g. rating×10⁶), no `null` fields (absent instead), strings NFC | **[FROZEN-AT-GENESIS]** Bit-determinism demands one encoding. JSON over CBOR: zero deps, trivially auditable, the repo already lives on JSON. The codec rejects (never silently normalizes) floats, unsorted input maps at verify time. |

## PIN (spec §1 — caps fixed by spec)

| Param | Default | Rationale |
|---|---|---|
| PIN committee | **T=6 of N=9** | Any two quorums intersect (6+6>9) so the threshold-replicated counter can't be forked; tolerates 3 members offline. Drawn by key-distance per §4, entanglement-distance floor applies. |
| Failure cap / refill / ban | **100 lifetime / R=20 / 90d** | Fixed by spec §1. |
| tOPRF suite | ristretto255 via @noble/curves (added at A2), OPRF per draft-irtf-cfrg-voprf | Standard VOPRF; ed25519-adjacent stack, same audit family. |

## Witness fabric (§4)

| Param | Default | Rationale |
|---|---|---|
| `W_n` (canonical witness set) | **16** | Large enough that eligibility floors + diversity rules leave a working quorum under churn; small enough that key-distance committees stay cheap to enumerate at 2-user scale (rule: at populations < W_n, all eligible nodes serve — spec §4). |
| `T_lease` | **9 of 16** | Strict majority → two valid overlapping-epoch leases impossible (9+9>16). |
| Checkpoint cosigners | **M=4 of N=8** eligible witnesses, ≥3 distinct /16-key-space prefixes (diversity bound) | 4 slashable cosignatures per checkpoint is real skin-in-the-game without making checkpoints expensive; N=8 is the nearest-eligible half of W_n. **[SIGN-OFF]** — this is the fraud-cost dial. |
| Witness eligibility floors | own-trust ≥ **0.5**; uptime attestation ≥ **95%** trailing 30d; entanglement-distance: **no direct game/friend edge with subject in trailing 90d AND shared-partner overlap < 20%** | Spec requires floors exist; these are the initial dials. At tiny populations the floors relax per §4 (any eligible node serves) but M-of-N + diversity still bound single-witness power. |
| Witnessed-time window | timestamp valid within **±90s** of the median of the attesting witnesses' independently observed network time; age/ban/staleness timestamps need ≥3 entanglement-distant attesters | Wide enough for clock skew + relay latency, far too narrow to fake account age or shave ban expiries meaningfully. |
| Lease TTL / heartbeat / epoch | **TTL 120s, heartbeat 20s** (5 missed beats → expiry), epoch = monotonic u64 fencing token | Short enough that "playing elsewhere" clears in ≤2 min after a crash; heartbeats piggyback on existing presence traffic. |

## Chain & checkpoints (§2)

| Param | Default | Rationale |
|---|---|---|
| `N_ckpt` | every **20** witnessed games | 10k-game chain → 500 checkpoints; incremental verify stays one small fold; fast-path viewers re-fold ≤19 games worst case. |
| `p_spot` | **0.05** (5%), always spot-check when cosigners lack diversity or checkpoint is < 2 epochs old | Cheap per-view; expected detection of a bad checkpoint ≈ certain at modest view counts, and fraud is permanent slashing on first catch. |
| Avatar cap | ≤ **32 KB** base64 | Fixed by spec §2. |

## Storage (§5)

| Param | Default | Rationale |
|---|---|---|
| `N_shards`/`K_rec` | **40/12** | Spec default. Reed–Solomon; any 12 of 40 reconstruct; 3.3× expansion. |
| Shard budgets | desktop app **200 MB**, desktop browser **50 MB** (with `navigator.storage.persist()`), mobile browser **15 MB** | Matches §11 envelope; advertised per platform in the node's hello. |
| Repair cadence | scan owned shard-space every **6h** online-time; re-shard when observed replicas < **K_rec + 8** | Heals browser eviction churn well before the 12-shard floor is threatened. |

## Ratings (§6)

| Param | Default | Rationale |
|---|---|---|
| Ladders | (kind × TimeCategory), Bullet/Blitz/Rapid/Classical from the shipped `timeControlCategory`; Unlimited unrated; Daily deferred | Fixed by spec. |
| Seeds | 1200, RD 350, vol 0.06 (glicko2.ts defaults) | Fixed by spec / shipped code. |
| Placement | **10 games**, RD floored at **300** during placement | Fixed count per spec; floor keeps early K high so placement actually places. |
| Reveal thresholds | **Bullet 120 · Blitz 100 · Rapid 80 · Classical 40** | **[SIGN-OFF]** Spec default is 100 with per-category values open. Scaled by games-per-hour so the hidden containment period is comparable wall-clock across ladders (~17h judged exposure each, per §9). |
| Spillover bracket width | **800 Elo**, quantized to fixed rails (…, 800–1600, 1600–2400, …) | Spec's own example; wide enough to estimate nothing precise. |

## Matchmaking (§7)

| Param | Default | Rationale |
|---|---|---|
| Width curve | `width(T) = 50 + 450·(1−T)^2` | Continuous, ±50 at T=1, ±500 at T=0, flat near the top (honest players sit in precision matchmaking), steep near the floor. |
| Island term | pairing cost includes `0.35 · |T_a − T_b| · 500` Elo-equivalent penalty when either side's T < 0.6 | Comparable-suspicion accounts attract; negligible effect in the honest band. **[A5-CALIBRATED]** |
| Opponent-diversity weighting | opponent o contributes `T_o · min(1, entdist(o)/D₀)` to the diversity term, saturating log-count of unique weighted opponents; D₀ = the eligibility floor distance | Fresh/low-trust/close sock puppets contribute ≈0 (spec §7). |
| Trust-term weights (chain-shape, A4) | age 0.15 · diversity 0.30 · fork/checkpoint cleanliness 0.25 · completion hygiene 0.30; forensic terms re-weight in at A5 | A4 ships T from chain shape only (spec §14-A4); weights renormalize when Tier-1 forensics land. **[A5-CALIBRATED]** |

## Judge (§8) — provisional, every value re-pinned by A5 calibration

| Param | Default | Rationale |
|---|---|---|
| Binary | `stockfish-18-lite-single` WASM, **content hash pinned in code at A5** (sha256 of the wasm blob, verified at load) | Fixed by spec §8. |
| `T1_nodes` | **200,000/position, MultiPV 4** | ~8M nodes per 40-move game ≈ seconds on desktop single-thread WASM, tens of seconds on phones (spec budget). **[A5-CALIBRATED]** |
| `T2_nodes` | **2,000,000/position, MultiPV 6** | Deep enough for Regan-style aggregation; runnable overnight on a phone, minutes on desktop. **[A5-CALIBRATED]** |
| Hash / TT | **16 MB**, `ucinewgame` + TT clear before every judged game (per-game granularity) | Fixed by spec (≤16 MB, weakest-device allocatable). |
| Score-equivalence window | engine-match counts any move within **±15cp** of a MultiPV line at the judged depth | Absorbs engine variance per spec (never exact-move matching). **[A5-CALIBRATED]** |
| Regan window | **K=30** rated games per ladder, z-threshold **5.0** | ~2.9e-7 single-test FPR before correction; A5's obligation is proving the empty-margin property, which may move both. **[A5-CALIBRATED]** |
| Commit-reveal salt | `sha256(thresholdSig_lease-epoch(root ‖ ladder ‖ windowIndex))`, revealed at window close | Witness-derived per spec §7(b): unpredictable before, fully recomputable after. |
| estElo | refit against the corpus re-analyzed at (T1_nodes, MultiPV 4) via the existing corpus/fit harness | Spec obligation — shipped depth-12 fit does not transfer. |

## Social (§10)

| Param | Default | Rationale |
|---|---|---|
| Mailbox retention | **30 days** or until synced | Covers a monthly-cadence player; it's ephemeral coordination state (C-3). |
| Per-sender-root limits | **5 pending friend requests** per recipient; **20 mailbox items/day** per (sender, recipient) | Stops floods without touching normal use. |
| Per-recipient fair-share | **200 items**; eviction order: strangers-by-oldest first, entangled/friend senders never evicted by stranger pressure | Spec §10: sybil floods can't evict established roots. |
| Reputation fold weights | completion 0.35 · disconnect/abandon 0.25 · timeout-vs-resign 0.10 · rematch acceptance 0.05 · no-show 0.10 · commendations 0.15 → 0–100 score; badge tiers 0–39 / 40–69 / 70–89 / 90–100 | **[SIGN-OFF]** First-cut weighting of §6b's enumerated inputs; commendations rate-limited 1/opponent/game by entanglement. |

## Items explicitly flagged for sign-off

1. **Checkpoint cosigner count (M=4 of 8)** — the fraud-cost vs. checkpoint-weight dial.
2. **Per-category reveal thresholds (120/100/80/40)** — deviates from flat-100 to equalize wall-clock containment.
3. **Reputation fold weights** — product-feel decision more than a security one.
4. (FYI, not blocking) argon2id m=64 MiB is frozen at genesis — raising it later means new accounts only; it cannot be rotated under existing names.
