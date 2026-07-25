import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

// Minimal GTP (Go Text Protocol v2) client. The KataGo seam for the games
// platform's Go bots (docs/GAMES-PLATFORM-SPEC.md §Bots: go → KataGo GTP ipc).
//
// Protocol shape: commands are single lines, optionally prefixed with a
// numeric id (`3 genmove b`); every response is `=[id] payload` (success) or
// `?[id] message` (failure), terminated by a BLANK line. Payloads may span
// multiple lines (e.g. `showboard`). This client always sends ids so responses
// pair with requests even if the engine emits diagnostics on stdout.
//
// Pure Node (no Electron import) and engine-agnostic: GNU Go / Leela Zero /
// KataGo all speak the same core verbs. The KataGo binary + nets arrive with
// their own dataset group (separate quest); this class is the ready seam:
//
//   const gtp = new GtpClient(katagoPath, ['gtp', '-model', netPath, '-config', cfgPath])
//   await gtp.start()
//   await gtp.boardsize(19); await gtp.komi(6.5)
//   await gtp.play('black', 'q16')
//   const answer = await gtp.genmove('white')   // 'q4' | 'pass' | 'resign'
//   await gtp.quit()

export interface GtpResponse {
  ok: boolean
  /** Response payload with the status/id prefix stripped, trimmed. */
  text: string
}

interface Pending {
  id: number
  resolve(r: GtpResponse): void
  reject(e: Error): void
}

export class GtpClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  /** Lines of the response currently being accumulated. */
  private current: string[] = []
  private readonly queue: Pending[] = []
  private nextId = 1

  constructor(
    private readonly exePath: string,
    private readonly args: readonly string[] = [],
    /** Working directory for the engine process: KataGo resolves its config's
     *  relative logDir against it, so callers pass the dataset dir. */
    private readonly cwd?: string
  ) {}

  /** Spawn the engine and verify it speaks GTP (protocol_version). */
  async start(timeoutMs = 20000): Promise<void> {
    if (this.proc) throw new Error('gtp: already started')
    const proc = spawn(this.exePath, [...this.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      cwd: this.cwd
    })
    this.proc = proc
    proc.stdout.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    proc.on('error', (err: Error) => this.failAll(err))
    proc.on('exit', () => this.failAll(new Error('gtp engine process exited')))
    const version = await this.send('protocol_version', timeoutMs)
    if (!version.ok) throw new Error(`gtp: bad handshake: ${version.text}`)
  }

  private failAll(err: Error): void {
    this.proc = null
    const pending = this.queue.splice(0, this.queue.length)
    this.current = []
    for (const p of pending) p.reject(err)
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      // GTP responses end with an empty line; \r is legal line noise (spec §2.9).
      const line = this.buf.slice(0, nl).replace(/\r/g, '')
      this.buf = this.buf.slice(nl + 1)
      if (line === '') {
        if (this.current.length > 0) this.finishResponse()
      } else {
        this.current.push(line)
      }
    }
  }

  private finishResponse(): void {
    const lines = this.current
    this.current = []
    const head = lines[0]
    const m = /^([=?])(\d*)\s?(.*)$/.exec(head)
    if (!m) return // stray diagnostics between responses: ignore
    const [, status, idStr, first] = m
    const id = idStr === '' ? null : Number(idStr)
    // Pair with the oldest in-flight command (ids are monotonic; an id-less
    // response can only belong to the head of the queue).
    const idx = id === null ? 0 : this.queue.findIndex((p) => p.id === id)
    if (idx < 0 || this.queue.length === 0) return
    const [pending] = this.queue.splice(idx, 1)
    const text = [first, ...lines.slice(1)].join('\n').trim()
    pending.resolve({ ok: status === '=', text })
  }

  /** Send one raw GTP command; resolves with its (possibly failed) response. */
  send(command: string, timeoutMs = 60000): Promise<GtpResponse> {
    const proc = this.proc
    if (!proc || proc.killed || !proc.stdin.writable) {
      return Promise.reject(new Error('gtp: engine not running'))
    }
    if (/[\r\n]/.test(command)) {
      return Promise.reject(new Error('gtp: command must be a single line'))
    }
    const id = this.nextId++
    return new Promise<GtpResponse>((resolve, reject) => {
      const pending: Pending = {
        id,
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      }
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(pending)
        if (i >= 0) this.queue.splice(i, 1)
        reject(new Error(`gtp: timeout waiting for '${command}'`))
      }, timeoutMs)
      this.queue.push(pending)
      proc.stdin.write(`${id} ${command}\n`)
    })
  }

  /** Send a command that MUST succeed; resolves with the payload text. */
  private async must(command: string, timeoutMs?: number): Promise<string> {
    const r = await this.send(command, timeoutMs)
    if (!r.ok) throw new Error(`gtp: '${command}' failed: ${r.text}`)
    return r.text
  }

  name(): Promise<string> {
    return this.must('name')
  }

  version(): Promise<string> {
    return this.must('version')
  }

  boardsize(size: number): Promise<string> {
    return this.must(`boardsize ${size}`)
  }

  clearBoard(): Promise<string> {
    return this.must('clear_board')
  }

  komi(value: number): Promise<string> {
    return this.must(`komi ${value}`)
  }

  /** vertex: 'q16' | 'pass' (GTP letters skip 'i', matching the go.ts codec). */
  play(color: 'black' | 'white', vertex: string): Promise<string> {
    return this.must(`play ${color} ${vertex}`)
  }

  /** The engine's move: a vertex, 'pass' or 'resign' (lowercased). */
  async genmove(color: 'black' | 'white', timeoutMs = 120000): Promise<string> {
    const text = await this.must(`genmove ${color}`, timeoutMs)
    return text.toLowerCase()
  }

  /** KataGo extension (kata-genmove_analyze etc. arrive with the dataset quest). */
  finalScore(): Promise<string> {
    return this.must('final_score')
  }

  /** Graceful GTP `quit`, then a hard kill fallback (same shape as UciEngine). */
  async quit(): Promise<void> {
    if (!this.proc) return
    try {
      await this.send('quit', 2000)
    } catch {
      /* engine gone or wedged: the kill below settles it */
    }
    this.kill()
  }

  kill(): void {
    if (this.proc && !this.proc.killed) this.proc.kill()
    this.failAll(new Error('gtp client killed'))
  }
}
