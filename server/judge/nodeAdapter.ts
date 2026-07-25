// A5 J1, Node JudgeEngine adapter: the shared judged-game protocol
// (src/shared/accounts/judge) over the A2 child-process harness
// (server/judge/nodeEngine.ts). The §8 content-hash gate is MANDATORY here:
// the adapter measures the sha256 of the EXACT `.wasm` the spawned child loads
// (its enginePath sibling: the glue self-resolves it; a decoupled wasmPath is
// refused fail-closed) and refuses to spawn on any mismatch with a typed
// JudgeWasmHashError (there is no opt-out), and the wrapped newInstance()
// re-verifies the same loaded file at spawn (default gate kept on, two layers,
// both loud). Verified bytes == executed bytes, the node analogue of the web
// adapter's verified-bytes blob: URL (A5-13).
//
// node-only (server/**). Not imported by src/shared/**.

import { JudgeWasmHashError, type JudgeEngine } from '@shared/accounts/judge'
import { verifyWasmHash } from './contentHash.js'
import { gatedWasmPath, newInstance, resolveEnginePath } from './nodeEngine.js'

export interface NodeJudgeEngineOptions {
  /** override the engine glue path (defaults to the resolved shipped build). */
  enginePath?: string
  /**
   * OPTIONAL cross-check only: if given it MUST equal the enginePath sibling
   * the child loads, else JudgeWasmPathError. It cannot redirect the engine
   * (A5-13); omit it and the gate uses the loaded sibling directly.
   */
  wasmPath?: string
}

/**
 * Spawn a judge-DEDICATED engine instance (never shared with any play or
 * analysis pool) behind the shared JudgeEngine surface. Before spawning
 * anything it throws JudgeWasmHashError if the loaded sibling's bytes do not
 * match the pinned content hash, or JudgeWasmPathError if opts.wasmPath names a
 * file other than the sibling the child loads (A5-13). Fail-closed, no opt-out.
 */
export async function newNodeJudgeEngine(opts: NodeJudgeEngineOptions = {}): Promise<JudgeEngine> {
  const enginePath = opts.enginePath ?? resolveEnginePath()
  // Gate layer 1: hash the EXACT sibling the spawned child loads, never a
  // decoupled wasmPath the engine can't reach (gatedWasmPath throws
  // JudgeWasmPathError if opts.wasmPath names any other file): verified bytes
  // are the executed bytes (A5-13).
  const wasmPath = gatedWasmPath(enginePath, opts.wasmPath)
  const v = verifyWasmHash(wasmPath)
  if (!v.ok) throw new JudgeWasmHashError(v.sha256, v.expectedSha256, wasmPath)
  // Layer 2: newInstance re-derives + re-verifies the same loaded sibling at
  // spawn. Pass only enginePath. The gate no longer trusts an external wasmPath.
  const inst = await newInstance({ enginePath })
  return {
    send: (cmd) => inst.send(cmd),
    onLine: (cb) => inst.onLine(cb),
    onError: (cb) => inst.onExit(() => cb(new Error('judge engine process exited'))),
    close: () => inst.quit(),
  }
}
