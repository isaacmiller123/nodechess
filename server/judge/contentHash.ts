// Content-hash pin for the canonical judge WASM (spec §8: "the judge always
// loads the single-thread WASM Stockfish build by content hash").
//
// The judge's trust model is reproducibility, not client residence: a verdict
// is a pure function of countersigned data replayed against a BIT-IDENTICAL
// engine binary on every machine. That binary is pinned by the sha256 of its
// raw `.wasm` bytes; a loader (server/judge/nodeEngine.ts, and the browser
// judge at A5) MUST verify the file against this hash before trusting any
// output. If the shipped binary ever drifts (e.g. a floated `stockfish` semver
// bump republishes the blob), this check fails LOUDLY — which is the intended
// behaviour for a content-pinned judge.
//
// SINGLE SOURCE OF TRUTH (A5-12): the sha256 of record is
// PARAMS_A5.judgeWasmSha256 (src/shared/accounts/judge/params.ts) — the only
// copy folded into PARAMS_A5_DIGEST (which every JudgeOutput/Tier1Record
// attests) and the value the web gate (src/web/engines/judge.ts) verifies.
// JUDGE_WASM_SHA256 below is DERIVED from it, never a second literal, so the
// node and web gates can never silently diverge: re-pinning the binary
// requires editing params.ts, which drifts PARAMS_A5_DIGEST — every verdict
// then names the new rule set, exactly as §8 demands.
//
// node-only (server/**). Not imported by src/shared/** (this server → shared
// import is the allowed direction; nodeAdapter.ts already depends on the
// shared judge core).
//
// JUDGE_WASM_BYTES is the byte length of
//   node_modules/stockfish/bin/stockfish-18-lite-single.wasm
// as resolved by the repo lockfile (stockfish@18.0.8) — an independent
// cross-check kept HERE because canonical PARAMS_A5 carries the hash only
// (adding a field would drift PARAMS_A5_DIGEST). It also equals the
// `l=7295411` constant the Emscripten glue (stockfish-18-lite-single.js)
// bakes in for its own length guard, so a mismatch on either field means the
// wrong blob. A re-pin must update it alongside params.ts; forgetting either
// side fails the node gate loudly (never silently).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { PARAMS_A5 } from '@shared/accounts/judge/params'

/** Package-relative module id used for default resolution. */
export const JUDGE_WASM_MODULE_ID = 'stockfish/bin/stockfish-18-lite-single.wasm'

/**
 * sha256 (hex) of the pinned judge WASM — the spec §8 content-hash pin,
 * derived from the digest-attested PARAMS_A5.judgeWasmSha256 (single source
 * of truth; see header — never re-pin here, re-pin in params.ts).
 */
export const JUDGE_WASM_SHA256 = PARAMS_A5.judgeWasmSha256

/** Byte length of the pinned judge WASM (independent cross-check, see header). */
export const JUDGE_WASM_BYTES = 7295411

export interface WasmHash {
  /** sha256 of the file, lowercase hex. */
  sha256: string
  /** file length in bytes. */
  bytes: number
}

export interface WasmHashVerdict extends WasmHash {
  /** true iff both sha256 AND byte length match the pinned values. */
  ok: boolean
  /** the pinned sha256 compared against. */
  expectedSha256: string
  /** the pinned byte length compared against. */
  expectedBytes: number
}

/**
 * Resolve the shipped judge WASM path. Best-effort: resolves the `stockfish`
 * package relative to THIS module (cwd-independent). Callers that bundle this
 * file (e.g. the on-the-fly esbuild test harness) should pass an explicit path
 * instead, since package resolution from a bundle temp dir will not find the
 * dependency.
 */
export function defaultWasmPath(): string {
  const require = createRequire(import.meta.url)
  return require.resolve(JUDGE_WASM_MODULE_ID)
}

/**
 * Compute the sha256 + byte length of a WASM file. Pure function of the file
 * bytes. Defaults to the resolved shipped judge WASM when no path is given.
 */
export function computeWasmHash(wasmPath: string = defaultWasmPath()): WasmHash {
  const buf = readFileSync(wasmPath)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  return { sha256, bytes: buf.byteLength }
}

/**
 * Verify a WASM file against the pinned content hash. Returns the measured
 * hash/length alongside the pinned expectations and an `ok` flag; never throws
 * on mismatch (callers decide how loud to be). Defaults to the shipped WASM.
 */
export function verifyWasmHash(wasmPath: string = defaultWasmPath()): WasmHashVerdict {
  const { sha256, bytes } = computeWasmHash(wasmPath)
  return {
    ok: sha256 === JUDGE_WASM_SHA256 && bytes === JUDGE_WASM_BYTES,
    sha256,
    bytes,
    expectedSha256: JUDGE_WASM_SHA256,
    expectedBytes: JUDGE_WASM_BYTES,
  }
}

/**
 * Verify and throw with a precise message on mismatch. Use at judge-load time
 * so an un-pinned binary can never silently produce verdicts.
 */
export function assertWasmHash(wasmPath: string = defaultWasmPath()): void {
  const v = verifyWasmHash(wasmPath)
  if (!v.ok) {
    throw new Error(
      `judge WASM content-hash mismatch at ${wasmPath}: ` +
        `got sha256=${v.sha256} (${v.bytes} bytes), ` +
        `expected sha256=${v.expectedSha256} (${v.expectedBytes} bytes)`,
    )
  }
}
