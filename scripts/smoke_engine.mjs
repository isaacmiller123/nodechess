// Headless engine smoke test (acceptance criterion A4): confirm the bundled
// Stockfish binary streams >=3 MultiPV lines (score + pv) and returns a bestmove,
// and that `stop` halts an infinite search promptly. Raw UCI over child_process,
// independent of the TS wrapper (which mirrors this exact protocol).
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Resolve the bundled engine the same way src/main/datasets/paths.ts does, so the
// smoke test runs on every platform (win/mac/linux) without drift.
const PLAT = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
const BIN = process.platform === 'win32' ? 'stockfish.exe' : 'stockfish'
const EXE = path.join(__dirname, '..', 'resources', 'engine', PLAT, BIN)
// Giuoco Piano, Black to move. A rich middlegame with clear top lines.
const FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3'

const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] })
proc.stdout.setEncoding('utf-8')

let buf = ''
const mpv = {}
let phase = 'analyze'
let stopSentAt = 0
let stopLatency = -1

const send = (s) => proc.stdin.write(s + '\n')

proc.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) onLine(line)
  }
})

function onLine(line) {
  if (line.startsWith('info ') && line.includes(' multipv ') && line.includes(' pv ')) {
    const idx = /multipv (\d+)/.exec(line)?.[1]
    const sc = /score (cp|mate) (-?\d+)/.exec(line)
    const depth = /depth (\d+)/.exec(line)?.[1]
    const pv = /\bpv (.+)$/.exec(line)?.[1]
    if (idx && sc && pv) {
      mpv[idx] = { depth, score: `${sc[1]} ${sc[2]}`, pv: pv.split(' ').slice(0, 6).join(' ') }
    }
  } else if (line.startsWith('bestmove')) {
    if (phase === 'analyze') reportAnalyze(line)
    else if (phase === 'stop') reportStop(line)
  }
}

function reportAnalyze(best) {
  const n = Object.keys(mpv).length
  console.log(`MultiPV lines streamed: ${n}`)
  for (const k of Object.keys(mpv).sort((a, b) => +a - +b)) {
    const l = mpv[k]
    console.log(`  pv${k}  depth ${l.depth}  ${l.score}  ${l.pv}`)
  }
  console.log(`  ${best}`)
  if (n < 3) {
    console.log('A4 SMOKE FAIL: fewer than 3 MultiPV lines')
    finish(1)
    return
  }
  // Phase 2: stop latency on an infinite search.
  phase = 'stop'
  send('position fen ' + FEN)
  send('go infinite')
  setTimeout(() => {
    stopSentAt = Date.now()
    send('stop')
  }, 400)
}

function reportStop(best) {
  stopLatency = Date.now() - stopSentAt
  console.log(`stop -> ${best} in ${stopLatency} ms`)
  const ok = stopLatency >= 0 && stopLatency < 1000
  console.log(ok ? 'A4 SMOKE PASS (>=3 MultiPV lines; stop halts < 1s)' : 'A4 SMOKE FAIL: stop too slow')
  finish(ok ? 0 : 1)
}

function finish(code) {
  send('quit')
  setTimeout(() => process.exit(code), 120)
}

// Drive the session.
send('uci')
setTimeout(() => {
  send('setoption name MultiPV value 3')
  send('isready')
  send('position fen ' + FEN)
  send('go movetime 1500')
}, 200)
