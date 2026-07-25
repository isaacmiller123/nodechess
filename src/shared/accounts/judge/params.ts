// A5 judge parameters (docs/ACCOUNTS-PARAMS.md §Judge + spec §8).
// Every value here is PROVISIONAL-UNTIL-CALIBRATED per the params doc
// ([A5-CALIBRATED]): the A5 calibration runs carry proof obligations (empty
// oracle margin, zero-false-positive holdout) and re-pin these before A-final.
// Records that depend on them embed PARAMS_A5_DIGEST so every verdict names
// the exact rule set that produced it. Fractional values are micro-units.
import { canonicalHash, type CanonicalObject } from '../codec'
import { toB64u } from '../hash'

export const PARAMS_A5 = {
  v: 1,
  // --- The canonical judge binary (§8): pinned by content hash, verified at
  // load, single-thread build on EVERY platform (bypasses the play/analysis
  // engine auto-selection). sha256 hex of stockfish-18-lite-single.wasm.
  judgeWasmSha256: 'a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1',
  // --- Fixed analysis configs (never depth/time — node counts only)
  t1Nodes: 200_000,
  t1MultiPv: 4,
  t2Nodes: 2_000_000,
  t2MultiPv: 6,
  hashMb: 16, // pinned small Hash, allocatable on the weakest supported device
  // ucinewgame + TT clear granularity: per judged game (spec §8, fixed)
  ttReset: 'per-game',
  // --- Tier-1 signal shaping
  // Engine-match counts any move within this centipawn distance of a MultiPV
  // line at the judged config (score-equivalence window — never exact-move).
  scoreEquivCp: 15,
  // --- Tier-2 aggregation (Regan-style)
  reganK: 30, // rated games per (ladder) window
  zThresholdMicro: 5_000_000, // 5.0 — conviction threshold
  zEscalateMicro: 3_000_000, // 3.0 — deterministic Tier-2 escalation trigger
  // Cross-window LIFETIME accumulation (owner decision 2026-07-21, closing the
  // §7(a) empty-margin gap J6 measured): per-window z-scores accumulate as
  // z_life(W) = ⌊Σ z_w / √W⌋ over the ladder's closed windows — ~N(0,1) under
  // the null, so the SAME thresholds apply. Sustained just-under-escalation
  // metering (≈2.6σ/window) crosses escalation at ~2 windows and conviction at
  // ~4 (≈120 games): the bounded one-shot inflation remains (accepted minor
  // flaw), sustained metering does not.
  lifetimeScheme: 'z-sum-over-sqrt-windows-v1',
  // Commit-reveal salt derivation id: sha256(thresholdSig_lease-epoch(root ‖
  // ladder ‖ windowIndex)), revealed at window close (spec §7b).
  saltScheme: 'lease-threshold-v1',
  // --- Ban terms (§9)
  selfBanDays: 90,
} as const satisfies CanonicalObject

export const PARAMS_A5_DIGEST: string = toB64u(canonicalHash(PARAMS_A5))
