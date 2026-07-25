// Node harness for the pinned canonical judge WASM (spec §11: "a Node harness
// for the pinned judge WASM (worker/loader shim)"; §8: single-thread build,
// fixed node counts, fixed MultiPV, pinned Hash ≤16MB, ucinewgame+TT-clear per
// judged game). A2 operator-peer prerequisite: this is the loader INFRA, not
// the judge logic (A5 owns Tier1/Tier2 signals & verdicts).
//
// Why a child process rather than worker_threads or global-shimming:
//   The shipped `stockfish-18-lite-single.js` is Emscripten UMD glue that
//   ALREADY carries a first-class Node branch: when run as `node <that>.js`
//   (require.main === module) it starts a readline UCI REPL, reads commands on
//   stdin, writes engine lines to stdout, and locates its `.wasm` sibling via
//   __dirname. It needs NO browser globals in that mode. Its `worker_threads`
//   branch, by contrast, is a pthread guard: `... && !worker_threads.isMainThread`
//   short-circuits the whole setup to a no-op, because this is the SINGLE-thread
//   build that never spawns pthread workers, so loading it inside a Node Worker
//   would install no command handler at all. Spawning it as a subprocess is
//   therefore both the faithful "worker" model (isolated address space, message
//   passing) and the path the build actually supports under Node. The subprocess
//   is `process.execPath <sf.js>`, so it works identically on macOS/Linux/Windows.
//
// Determinism (the product): single-thread + fixed `go nodes N` + a cleared TT
// yields bit-identical search output. This harness enforces the spec's TT-reset
// discipline (`ucinewgame` + `setoption name Clear Hash value true`) before
// every analysis and an `isready`/`readyok` barrier so option changes are
// applied before the search starts. `time`/`nps` in engine output are wall-clock
// and intentionally excluded from the deterministic surface (see `AnalysisLine`,
// which carries only search-determined fields).
//
// node-only (server/**). Not imported by src/shared/**.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'
import { assertWasmHash } from './contentHash.js'

/** Package-relative module id of the pinned single-thread judge engine glue. */
export const JUDGE_ENGINE_MODULE_ID = 'stockfish/bin/stockfish-18-lite-single.js'

/** Spec §8: pinned Hash is ≤16MB (allocatable on the weakest supported device). */
export const JUDGE_MAX_HASH_MB = 16

/** One MultiPV line from a fixed-node search, restricted to deterministic fields. */
export interface AnalysisLine {
  /** 1-based MultiPV rank. */
  multipv: number
  /** search depth reached for this line at the node cap. */
  depth: number
  /** selective (max) depth for this line. */
  seldepth: number
  /** centipawn score, from White-to-move POV per UCI (present iff not a mate line). */
  scoreCp?: number
  /** mate-in-N (signed) score (present iff a forced mate was found). */
  mate?: number
  /** 'upper' | 'lower' when the score is an aspiration-window bound, else undefined. */
  bound?: 'upper' | 'lower'
  /** reported node count at emission (equals the cap once the search stops). */
  nodes: number
  /** principal variation, UCI long-algebraic moves. */
  pv: string[]
}

/** Result of a fixed-node analysis. Every field is search-determined (no timing). */
export interface AnalysisResult {
  /** the analysed position. */
  fen: string
  /** requested node cap. */
  nodes: number
  /** requested MultiPV. */
  multipv: number
  /** best move in UCI long-algebraic (from the `bestmove` line). */
  bestmove: string
  /** ponder move, if the engine reported one. */
  ponder?: string
  /** one entry per MultiPV rank (the final line emitted for each rank), sorted by rank. */
  lines: AnalysisLine[]
}

export interface AnalyseOptions {
  /** fixed node cap for `go nodes N` (never depth/time; spec §8). */
  nodes: number
  /** MultiPV count. */
  multipv: number
  /** Hash table size in MB; must be ≤ JUDGE_MAX_HASH_MB. */
  hashMb: number
}

export interface JudgeInstance {
  /** send a raw UCI command line (no trailing newline needed). */
  send(cmd: string): void
  /** subscribe to engine output lines; returns an unsubscribe function. */
  onLine(cb: (line: string) => void): () => void
  /** subscribe to child-process exit (fires once, incl. after quit()); returns unsubscribe. */
  onExit(cb: () => void): () => void
  /** resolve once the engine answers `readyok` (UCI `isready` barrier). */
  isready(): Promise<void>
  /**
   * Analyse a FEN at a fixed node count with fixed MultiPV and pinned Hash.
   * Clears the TT (`ucinewgame` + `Clear Hash`) and applies options behind an
   * `isready` barrier before searching, so results are deterministic and
   * independent of any prior analysis on this instance (spec §8 replay gate).
   * Calls are serialized per instance.
   */
  analyseFixedNodes(fen: string, opts: AnalyseOptions): Promise<AnalysisResult>
  /** send `quit` and resolve when the child process exits. */
  quit(): Promise<void>
}

export interface NewInstanceOptions {
  /** override the engine glue path (defaults to the resolved shipped build). */
  enginePath?: string
  /**
   * verify the EXACT `.wasm` the child loads (its enginePath sibling) against
   * the pinned content hash immediately before spawning. Defaults to true:
   * there is no production reason to disable it (verified bytes == executed
   * bytes, spec §8 / A5-13).
   */
  verifyContentHash?: boolean
  /**
   * OPTIONAL cross-check only. If given it MUST name the enginePath sibling the
   * spawned child actually loads (loadedWasmPath): a divergent path is refused
   * fail-closed with JudgeWasmPathError. It CANNOT redirect the engine: the glue
   * self-resolves its own `__dirname` sibling and never receives this value
   * (A5-13). Omit it and the gate uses the loaded sibling directly.
   */
  wasmPath?: string
}

/** Resolve the shipped engine glue path (package resolution relative to this module). */
export function resolveEnginePath(): string {
  const require = createRequire(import.meta.url)
  return require.resolve(JUDGE_ENGINE_MODULE_ID)
}

/**
 * The `.wasm` the spawned judge child ACTUALLY loads. The shipped Emscripten
 * glue's Node branch (`require.main === module`, the mode this harness spawns it
 * in via `node <enginePath>`) resolves its binary as
 * `path.join(__dirname, basename(__filename, extname) + '.wasm')` and
 * readFileSync's THAT: the parent never hands it a wasmPath. The §8 content-
 * hash gate must therefore hash THIS exact file so the verified bytes are the
 * executed bytes (A5-13), the node analogue of the web adapter instantiating the
 * worker over its verified-bytes blob: URL (src/web/engines/judge.ts).
 */
export function loadedWasmPath(enginePath: string): string {
  return join(dirname(enginePath), basename(enginePath, extname(enginePath)) + '.wasm')
}

/**
 * The §8 gate was pointed at a `.wasm` the spawned judge child will never load.
 * Because the child self-resolves its enginePath sibling (loadedWasmPath) and
 * ignores any external wasmPath, verifying a divergent file would attest bytes
 * that never execute (a checked-vs-loaded split) so the judge REFUSES fail-
 * closed rather than gate a file decoupled from the one it runs (A5-13).
 */
export class JudgeWasmPathError extends Error {
  override readonly name = 'JudgeWasmPathError'
  constructor(
    /** the wasmPath the caller asked the gate to verify. */
    readonly requestedWasmPath: string,
    /** the enginePath sibling the child actually loads and the gate verifies. */
    readonly loadedPath: string,
    /** the engine glue the child is spawned as (`node <enginePath>`). */
    readonly enginePath: string,
  ) {
    super(
      `judge content-hash gate pointed at ${requestedWasmPath}, but the spawned ` +
        `judge child (node ${enginePath}) loads its sibling ${loadedPath} and never ` +
        `the given path. Refusing to verify a .wasm the engine never executes`,
    )
  }
}

/**
 * Resolve the exact `.wasm` the §8 gate must hash: always the loaded sibling
 * (loadedWasmPath). If the caller supplied an explicit wasmPath it is treated as
 * a cross-check and MUST name that same file, else JudgeWasmPathError. Closing
 * the checked-vs-loaded split (A5-13).
 */
export function gatedWasmPath(enginePath: string, wasmPath?: string): string {
  const loaded = loadedWasmPath(enginePath)
  if (wasmPath !== undefined && resolvePath(wasmPath) !== resolvePath(loaded)) {
    throw new JudgeWasmPathError(wasmPath, loaded, enginePath)
  }
  return loaded
}

function parseInfoLine(line: string): AnalysisLine | null {
  // Only score-bearing MultiPV info lines describe a candidate line.
  if (!line.startsWith('info ') || !line.includes(' multipv ') || !line.includes(' score ')) {
    return null
  }
  const num = (re: RegExp): number | undefined => {
    const m = line.match(re)
    return m ? Number(m[1]) : undefined
  }
  const multipv = num(/\bmultipv (\d+)/)
  const depth = num(/\bdepth (\d+)/)
  const seldepth = num(/\bseldepth (\d+)/)
  const nodes = num(/\bnodes (\d+)/)
  if (multipv === undefined || depth === undefined || nodes === undefined) return null
  const scoreM = line.match(/\bscore (cp|mate) (-?\d+)(?: (upper|lower)bound)?/)
  if (!scoreM) return null
  const pvM = line.match(/\bpv (.+)$/)
  const pv = pvM ? pvM[1].trim().split(/\s+/) : []
  const out: AnalysisLine = {
    multipv,
    depth,
    seldepth: seldepth ?? 0,
    nodes,
    pv,
  }
  if (scoreM[1] === 'cp') out.scoreCp = Number(scoreM[2])
  else out.mate = Number(scoreM[2])
  if (scoreM[3]) out.bound = scoreM[3] as 'upper' | 'lower'
  return out
}

/**
 * Spawn a fresh judge engine instance under Node and complete the UCI
 * handshake. Verifies the pinned content hash by default. Resolves once the
 * engine has answered `uciok`.
 */
export async function newInstance(opts: NewInstanceOptions = {}): Promise<JudgeInstance> {
  const enginePath = opts.enginePath ?? resolveEnginePath()
  if (opts.verifyContentHash !== false) {
    // §8 gate: hash the EXACT file the child will load (its enginePath sibling),
    // and refuse a wasmPath that names any other file. The verified bytes are
    // the executed bytes (A5-13). Runs immediately before spawn to keep the
    // check->load window minimal; assertWasmHash throws on a hash mismatch and
    // gatedWasmPath throws JudgeWasmPathError on a decoupled path, both before
    // any child process exists.
    assertWasmHash(gatedWasmPath(enginePath, opts.wasmPath))
  }

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [enginePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  const listeners = new Set<(line: string) => void>()
  let stdoutBuf = ''
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
      stdoutBuf = stdoutBuf.slice(nl + 1)
      for (const cb of [...listeners]) cb(line)
    }
  })
  let stderrText = ''
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })

  let exited = false
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null
  const exitPromise = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true
      exitInfo = { code, signal }
      resolve()
    })
  })
  child.on('error', (err) => {
    stderrText += `\n[spawn error] ${String(err)}`
  })

  const send = (cmd: string): void => {
    if (exited) throw new Error(`judge engine has exited (${JSON.stringify(exitInfo)})`)
    child.stdin.write(cmd + '\n')
  }
  const onLine = (cb: (line: string) => void): (() => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }
  const onExit = (cb: () => void): (() => void) => {
    let live = true
    void exitPromise.then(() => {
      if (live) cb()
    })
    return () => {
      live = false
    }
  }

  /** Wait for a specific token line (e.g. 'uciok', 'readyok'). */
  const waitFor = (token: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const off = onLine((line) => {
        if (line === token || line.startsWith(token + ' ')) {
          off()
          resolve()
        }
      })
      exitPromise.then(() => {
        off()
        reject(new Error(`judge engine exited before "${token}"; stderr: ${stderrText.trim()}`))
      })
    })

  const isready = async (): Promise<void> => {
    const p = waitFor('readyok')
    send('isready')
    await p
  }

  // UCI handshake.
  {
    const p = waitFor('uciok')
    send('uci')
    await p
  }
  await isready()

  // Serialize analyses on this instance.
  let chain: Promise<unknown> = Promise.resolve()

  const analyseFixedNodes = (fen: string, o: AnalyseOptions): Promise<AnalysisResult> => {
    if (!Number.isInteger(o.nodes) || o.nodes <= 0) {
      return Promise.reject(new Error(`nodes must be a positive integer, got ${o.nodes}`))
    }
    if (!Number.isInteger(o.multipv) || o.multipv <= 0) {
      return Promise.reject(new Error(`multipv must be a positive integer, got ${o.multipv}`))
    }
    if (!Number.isInteger(o.hashMb) || o.hashMb <= 0 || o.hashMb > JUDGE_MAX_HASH_MB) {
      return Promise.reject(
        new Error(`hashMb must be an integer in 1..${JUDGE_MAX_HASH_MB}, got ${o.hashMb}`),
      )
    }
    const run = (): Promise<AnalysisResult> =>
      new Promise((resolve, reject) => {
        const byRank = new Map<number, AnalysisLine>()
        const off = onLine((line) => {
          const parsed = parseInfoLine(line)
          if (parsed) {
            // keep the LAST line per rank (the one at the node cap).
            byRank.set(parsed.multipv, parsed)
            return
          }
          if (line.startsWith('bestmove')) {
            off()
            const m = line.match(/^bestmove (\S+)(?: ponder (\S+))?/)
            const bestmove = m ? m[1] : ''
            const ponder = m && m[2] ? m[2] : undefined
            const lines = [...byRank.values()].sort((a, b) => a.multipv - b.multipv)
            resolve({ fen, nodes: o.nodes, multipv: o.multipv, bestmove, ponder, lines })
          }
        })
        exitPromise.then(() => {
          off()
          reject(
            new Error(`judge engine exited mid-analysis; stderr: ${stderrText.trim()}`),
          )
        })
        // Pinned options + mandated TT reset, behind an isready barrier so the
        // search starts from a known-clean, options-applied state.
        send(`setoption name Hash value ${o.hashMb}`)
        send(`setoption name MultiPV value ${o.multipv}`)
        send('ucinewgame')
        send('setoption name Clear Hash value true')
        isready().then(() => {
          send(`position fen ${fen}`)
          send(`go nodes ${o.nodes}`)
        }, reject)
      })
    const next = chain.then(run, run)
    // keep the chain alive regardless of this call's outcome.
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const quit = async (): Promise<void> => {
    if (exited) return
    try {
      send('quit')
    } catch {
      /* already gone */
    }
    await exitPromise
  }

  return { send, onLine, onExit, isready, analyseFixedNodes, quit }
}
