import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface InfoLine {
  depth?: number
  seldepth?: number
  multipv?: number
  scoreCp?: number
  mate?: number
  nodes?: number
  nps?: number
  timeMs?: number
  pv?: string[]
}

export interface BestMove {
  bestmove: string
  ponder?: string
}

export type GoLimit =
  | { kind: 'depth'; value: number }
  | { kind: 'movetime'; value: number }
  | { kind: 'nodes'; value: number }
  | { kind: 'infinite' }

function goArgs(l: GoLimit): string {
  switch (l.kind) {
    case 'depth':
      return `depth ${l.value}`
    case 'movetime':
      return `movetime ${l.value}`
    case 'nodes':
      return `nodes ${l.value}`
    case 'infinite':
      return 'infinite'
  }
}

function parseInfo(line: string): InfoLine | null {
  const t = line.split(/\s+/)
  const info: InfoLine = {}
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        info.depth = Number(t[++i])
        break
      case 'seldepth':
        info.seldepth = Number(t[++i])
        break
      case 'multipv':
        info.multipv = Number(t[++i])
        break
      case 'nodes':
        info.nodes = Number(t[++i])
        break
      case 'nps':
        info.nps = Number(t[++i])
        break
      case 'time':
        info.timeMs = Number(t[++i])
        break
      case 'score':
        if (t[i + 1] === 'cp') {
          info.scoreCp = Number(t[i + 2])
          i += 2
        } else if (t[i + 1] === 'mate') {
          info.mate = Number(t[i + 2])
          i += 2
        }
        break
      case 'pv':
        info.pv = t.slice(i + 1)
        i = t.length
        break
      default:
        break
    }
  }
  return info.depth !== undefined || info.pv ? info : null
}

/**
 * Thin, hand-rolled UCI wrapper over a spawned engine binary (architecture §6.3).
 * Pure Node (no Electron import) so it can be unit/smoke-tested headlessly.
 * Emits 'info' (InfoLine) and 'bestmove' (BestMove). One search at a time.
 */
export class UciEngine extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private searching = false
  private waiter: { token: string; resolve: () => void; reject: (e: Error) => void } | null = null
  // In-flight bestmove waiters' rejectors, so a crash/exit/timeout never hangs them.
  private pendingRejectors = new Set<(e: Error) => void>()

  /** `args` are extra launch arguments (lc0 needs `--weights=<file>`; Stockfish
   *  callers pass nothing. The default keeps every existing call site as-is). */
  constructor(
    private readonly exePath: string,
    private readonly args: readonly string[] = []
  ) {
    super()
  }

  // Reject the handshake waiter + all in-flight bestmove waiters (on exit/error).
  private failPending(err: Error): void {
    const w = this.waiter
    this.waiter = null
    if (w) w.reject(err)
    for (const reject of [...this.pendingRejectors]) reject(err)
    this.pendingRejectors.clear()
  }

  async start(): Promise<void> {
    // shell:false (the default, stated explicitly). Launch the binary directly on
    // every OS. Never set shell:true or windowsHide here: they change argument
    // handling and are unnecessary for a path-resolved engine binary.
    const proc = spawn(this.exePath, [...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    })
    this.proc = proc
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    // Spawn/runtime failure (missing exe, EACCES, crash): never let the child's
    // 'error' event become an uncaught exception that takes down the main process.
    proc.on('error', (err: Error) => {
      this.searching = false
      this.proc = null
      this.failPending(err)
      this.emit('engineError', err)
    })
    proc.on('exit', () => {
      this.searching = false
      this.proc = null
      this.failPending(new Error('engine process exited'))
      this.emit('exit')
    })
    await this.expect('uci', 'uciok', 10000)
    await this.expect('isready', 'readyok', 10000)
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    if (line.startsWith('info ')) {
      const info = parseInfo(line)
      if (info) this.emit('info', info)
    } else if (line.startsWith('bestmove')) {
      this.searching = false
      const p = line.split(/\s+/)
      this.emit('bestmove', { bestmove: p[1], ponder: p[3] } as BestMove)
    }
    if (this.waiter && line.startsWith(this.waiter.token)) {
      const w = this.waiter
      this.waiter = null
      w.resolve()
    }
  }

  private write(cmd: string): void {
    const proc = this.proc
    if (!proc || proc.killed || !proc.stdin.writable) return
    try {
      proc.stdin.write(cmd + '\n')
    } catch {
      /* engine gone between checks: ignore */
    }
  }

  private expect(cmd: string, token: string, timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.token === token) this.waiter = null
        reject(new Error(`UCI timeout waiting for "${token}"`))
      }, timeoutMs)
      this.waiter = {
        token,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e: Error) => {
          clearTimeout(timer)
          reject(e)
        }
      }
      this.write(cmd)
    })
  }

  // Resolve on the next 'bestmove'; reject on timeout or engine exit/error.
  private waitForBestmove(timeoutMs: number): Promise<BestMove> {
    return new Promise<BestMove>((resolve, reject) => {
      let done = false
      const onBest = (bm: BestMove): void => {
        if (done) return
        done = true
        cleanup()
        resolve(bm)
      }
      const rej = (e: Error): void => {
        if (done) return
        done = true
        cleanup()
        reject(e)
      }
      const timer = setTimeout(() => rej(new Error('engine bestmove timeout')), timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('bestmove', onBest)
        this.pendingRejectors.delete(rej)
      }
      this.once('bestmove', onBest)
      this.pendingRejectors.add(rej)
    })
  }

  isready(): Promise<void> {
    return this.expect('isready', 'readyok', 10000)
  }

  setOption(name: string, value: string | number | boolean): void {
    this.write(`setoption name ${name} value ${value}`)
  }

  async newGame(): Promise<void> {
    this.write('ucinewgame')
    await this.isready()
  }

  /** Fire-and-forget search; results stream via 'info' / 'bestmove'. */
  async search(fen: string, limit: GoLimit, multipv = 1): Promise<void> {
    if (this.searching) await this.stop()
    this.setOption('MultiPV', multipv)
    this.write(`position fen ${fen}`)
    this.searching = true
    this.write(`go ${goArgs(limit)}`)
  }

  /** Search and resolve with the engine's chosen move (rejects on timeout/exit). */
  async bestMove(fen: string, limit: GoLimit, timeoutMs = 60000): Promise<BestMove> {
    const result = this.waitForBestmove(timeoutMs)
    await this.search(fen, limit, 1)
    return result
  }

  async stop(): Promise<void> {
    if (!this.searching) return
    const settled = this.waitForBestmove(5000)
    this.write('stop')
    try {
      await settled
    } catch {
      /* engine already idle or gone: nothing to stop */
    }
  }

  // Graceful UCI `quit`, then a hard kill as a fallback. Universal across OSes:
  // Windows ignores SIGTERM (so the explicit kill is what actually stops it),
  // while macOS/Linux also honor the kill. No platform-conditional logic needed.
  async quit(): Promise<void> {
    if (!this.proc) return
    this.write('quit')
    await new Promise((r) => setTimeout(r, 150))
    this.kill()
  }

  kill(): void {
    if (this.proc && !this.proc.killed) this.proc.kill()
    this.proc = null
  }
}
