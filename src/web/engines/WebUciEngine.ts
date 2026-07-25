// Browser twin of src/main/engine/UciEngine.ts: the same thin UCI wrapper,
// same events ('info', 'bestmove', 'exit', 'engineError'), same one-search-at-
// a-time discipline, same stop()/bestMove() semantics. Over a UciTransport
// (Worker or emscripten module) instead of a child process. Consumers ported
// from desktop (weak play, review, personas, evalVariant) attach/detach
// listeners exactly as they do against the desktop class.

import { Emitter } from './emitter'
import { goArgs, parseBestmove, parseInfo, type BestMove, type GoLimit, type InfoLine } from './uci'
import type { UciTransport } from './transport'

interface EngineEvents extends Record<string, unknown[]> {
  info: [InfoLine]
  bestmove: [BestMove]
  exit: []
  engineError: [Error]
}

/** First-start handshake budget: covers the wasm fetch + compile on a cold
 *  cache (7 MB for the chess build). Generous, but a wedged load must still
 *  fail rather than hang its caller forever. */
const START_TIMEOUT_MS = 90_000

export class WebUciEngine extends Emitter<EngineEvents> {
  private transport: UciTransport | null
  private searching = false
  private dead = false
  private waiter: { token: string; resolve: () => void; reject: (e: Error) => void } | null = null
  // In-flight bestmove waiters' rejectors, so a crash never hangs them.
  private pendingRejectors = new Set<(e: Error) => void>()

  constructor(transport: UciTransport) {
    super()
    this.transport = transport
    transport.onLine((line) => {
      const trimmed = line.trim()
      if (trimmed) this.onLine(trimmed)
    })
    transport.onError((err) => {
      this.searching = false
      this.failPending(err)
      this.emit('engineError', err)
    })
  }

  /** Write a file into the engine's virtual FS (fairy variants.ini). */
  writeFile(path: string, text: string): void {
    const t = this.transport
    if (!t) throw new Error('engine is terminated')
    if (!t.writeFile) throw new Error('engine transport has no filesystem')
    t.writeFile(path, text)
  }

  private failPending(err: Error): void {
    const w = this.waiter
    this.waiter = null
    if (w) w.reject(err)
    for (const reject of [...this.pendingRejectors]) reject(err)
    this.pendingRejectors.clear()
  }

  async start(): Promise<void> {
    await this.expect('uci', 'uciok', START_TIMEOUT_MS)
    await this.expect('isready', 'readyok', START_TIMEOUT_MS)
  }

  private onLine(line: string): void {
    if (line.startsWith('info ')) {
      const info = parseInfo(line)
      if (info) this.emit('info', info)
    } else if (line.startsWith('bestmove')) {
      this.searching = false
      this.emit('bestmove', parseBestmove(line))
    }
    if (this.waiter && line.startsWith(this.waiter.token)) {
      const w = this.waiter
      this.waiter = null
      w.resolve()
    }
  }

  private write(cmd: string): void {
    if (!this.transport || this.dead) return
    this.transport.send(cmd)
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

  /** Search and resolve with the engine's chosen move (rejects on timeout/crash). */
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

  /** Tear the engine down. The worker/module is discarded; a pool respawns. */
  quit(): void {
    if (this.dead) return
    this.dead = true
    this.searching = false
    this.failPending(new Error('engine terminated'))
    const t = this.transport
    this.transport = null
    try {
      t?.terminate()
    } catch {
      /* already gone */
    }
    this.emit('exit')
  }
}
