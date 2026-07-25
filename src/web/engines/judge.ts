// A5 J1, Web JudgeEngine adapter (spec §8, §11): the canonical judge in the
// browser. UNCONDITIONALLY loads `stockfish-18-lite-single`. This module
// deliberately BYPASSES assets.ts's context-sensitive chessWorkerUrl()
// selection (which stays for play/analysis): "identical binary everywhere"
// means the judge's single-thread binary, by hash, even on crossOriginIsolated
// pages that would pick the multithreaded build for play.
//
// Content-hash gate, TOCTOU-free: we fetch the wasm BYTES ourselves, sha256
// them against PARAMS_A5.judgeWasmSha256, and hand the engine those exact
// verified bytes via an immutable blob: URL passed in the worker's location
// hash (the stockfish.js glue's documented `#<wasmUrl>` override). The worker
// therefore instantiates from the verified bytes. A server that swaps the
// asset between our fetch and instantiation cannot win, and a mismatch throws
// a typed JudgeWasmHashError before any worker exists.
//
// Every newWebJudgeEngine() is a judge-DEDICATED worker. Never the pools.ts
// play/analysis instances. Keep this module small; no UI.

import { PARAMS_A5, JudgeWasmHashError, type JudgeEngine } from '@shared/accounts/judge'
import { sha256 } from '@shared/accounts/hash'
import { enginesDir, wasmSupported } from './assets'

/** The pinned judge engine assets (same-origin under <base>/engines/). */
export const JUDGE_ENGINE_ASSET = 'stockfish-18-lite-single.js'
export const JUDGE_WASM_ASSET = 'stockfish-18-lite-single.wasm'

/** Handshake budget: wasm is already fetched/verified, this covers compile. */
const JUDGE_START_TIMEOUT_MS = 90_000

function toHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}

/** send cmd, resolve on the token line, reject on error/timeout. */
function expect(engine: JudgeEngine, cmd: string, token: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      offErr()
      reject(new Error(`judge engine timeout waiting for "${token}"`))
    }, timeoutMs)
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      off()
      offErr()
      fn()
    }
    const off = engine.onLine((line) => {
      if (line === token || line.startsWith(token + ' ')) done(resolve)
    })
    const offErr = engine.onError ? engine.onError((err) => done(() => reject(err))) : () => {}
    engine.send(cmd)
  })
}

/**
 * The subset of the DOM `Worker` surface the judge adapter drives. Declared
 * explicitly so the fail-closed engine object below can be built over either a
 * real dedicated Worker (newWebJudgeEngine) or a test double: the teardown and
 * post-close send() semantics are then exercisable without a browser.
 */
export interface JudgeWorkerLike {
  postMessage(data: string): void
  terminate(): void
  onmessage: ((e: MessageEvent) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

/**
 * Wrap a judge worker in the shared JudgeEngine surface, FAIL-CLOSED like the
 * node adapter (server/judge/nodeAdapter.ts). A single teardown handles EITHER
 * an explicit close() OR a worker `error` event: it terminates the dedicated
 * worker, revokes the verified-bytes blob URL, and notifies every onError
 * subscriber exactly once. judgeGame's onError wiring turns that notification
 * into a JudgeEngineError, so an in-flight barrier/analyseOne REJECTS instead
 * of awaiting a `readyok`/`bestmove` the dead worker can never send. And any
 * send() after teardown THROWS rather than silently no-op'ing, so a judgeGame
 * begun on a closed engine fails the same way.
 *
 * A5-23: Worker.terminate() fires no `error` event, so without this the web
 * adapter defeated onError's documented purpose (types.ts): an in-flight or
 * post-close judgeGame hung forever, while the node path already rejected loudly
 * (child exit -> onExit -> onError -> JudgeEngineError; post-exit send() throws).
 */
export function makeWorkerJudgeEngine(worker: JudgeWorkerLike, wasmBlobUrl: string): JudgeEngine {
  const lineCbs = new Set<(line: string) => void>()
  const errCbs = new Set<(err: Error) => void>()
  let closed = false

  const teardown = (err: Error): void => {
    if (closed) return
    closed = true
    try {
      worker.postMessage('quit')
    } catch {
      /* worker already gone */
    }
    worker.terminate()
    URL.revokeObjectURL(wasmBlobUrl)
    // terminate() emits no `error` event, so notify in-flight subscribers here.
    for (const cb of [...errCbs]) cb(err)
  }

  worker.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') return
    for (const cb of [...lineCbs]) cb(e.data)
  }
  worker.onerror = (e: ErrorEvent) => {
    teardown(new Error(e.message || 'judge worker error'))
  }

  return {
    send: (cmd) => {
      // Post-close/-death send MUST throw (never a silent no-op) so a judgeGame
      // begun on a dead engine fails-closed like the node adapter (which throws
      // 'judge engine has exited'), instead of blocking forever on a reply that
      // can never arrive.
      if (closed) throw new Error('judge engine worker is closed')
      worker.postMessage(cmd)
    },
    onLine: (cb) => {
      lineCbs.add(cb)
      return () => lineCbs.delete(cb)
    },
    onError: (cb) => {
      errCbs.add(cb)
      return () => errCbs.delete(cb)
    },
    close: async () => {
      teardown(new Error('judge engine worker closed'))
    },
  }
}

/**
 * Fetch + hash-verify the pinned judge wasm, spawn a dedicated single-thread
 * worker instantiated from the verified bytes, complete the UCI handshake,
 * and return the shared JudgeEngine surface for judgeGame().
 * Throws JudgeWasmHashError on a content-hash mismatch (fail closed).
 */
export async function newWebJudgeEngine(): Promise<JudgeEngine> {
  if (typeof Worker !== 'function' || !wasmSupported()) {
    throw new Error('web judge requires Worker + WebAssembly support')
  }
  const wasmUrl = `${enginesDir()}${JUDGE_WASM_ASSET}`
  const resp = await fetch(wasmUrl)
  if (!resp.ok) throw new Error(`judge wasm fetch failed (HTTP ${resp.status}) at ${wasmUrl}`)
  const bytes = new Uint8Array(await resp.arrayBuffer())
  const hex = toHex(sha256(bytes))
  if (hex !== PARAMS_A5.judgeWasmSha256) {
    throw new JudgeWasmHashError(hex, PARAMS_A5.judgeWasmSha256, wasmUrl)
  }

  // Immutable in-memory URL over the verified bytes; the glue fetches THIS.
  const wasmBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }))
  const worker = new Worker(`${enginesDir()}${JUDGE_ENGINE_ASSET}#${encodeURIComponent(wasmBlobUrl)}`)

  const engine = makeWorkerJudgeEngine(worker, wasmBlobUrl)

  try {
    await expect(engine, 'uci', 'uciok', JUDGE_START_TIMEOUT_MS)
    await expect(engine, 'isready', 'readyok', JUDGE_START_TIMEOUT_MS)
  } catch (err) {
    await engine.close()
    throw err
  }
  // uciok implies the module instantiated; the blob URL has served its bytes.
  URL.revokeObjectURL(wasmBlobUrl)
  return engine
}
