// Proof-of-life for the KataGo dataset group (docs/GAMES-PLATFORM-SPEC.md §Engines):
// spawns the imported mac KataGo over GTP with the b6c96 net, plays one 9x9
// genmove and prints the move. No app code involved: this exercises exactly
// what src/main/datasets/katago.ts installs.
//
//   node scripts/verify-katago.mjs
//
// Resolution order (same layout katago.ts writes):
//   1) <repo>/.devdata/datasets/katago/{katago,default_gtp.cfg,nets/kata-b6c96.bin.gz}
//   2) env KATAGO_BIN / KATAGO_CFG / KATAGO_NET overrides
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const kgDir = path.join(repo, '.devdata', 'datasets', 'katago')

const bin = process.env.KATAGO_BIN ?? path.join(kgDir, 'katago')
const cfg = process.env.KATAGO_CFG ?? path.join(kgDir, 'default_gtp.cfg')
const net = process.env.KATAGO_NET ?? path.join(kgDir, 'nets', 'kata-b6c96.bin.gz')

for (const [label, p] of [['binary', bin], ['config', cfg], ['net', net]]) {
  if (!existsSync(p)) {
    console.error(`verify-katago: missing ${label}: ${p}`)
    console.error('Import the katago dataset group first (or set KATAGO_BIN/KATAGO_CFG/KATAGO_NET).')
    process.exit(1)
  }
}

const child = spawn(
  bin,
  ['gtp', '-config', cfg, '-model', net, '-override-config', 'maxVisits=8,numSearchThreads=2'],
  { cwd: kgDir, stdio: ['pipe', 'pipe', 'pipe'] }
)

const timeout = setTimeout(() => {
  console.error('verify-katago: timed out after 120s')
  child.kill()
  process.exit(1)
}, 120_000)

let stderrTail = ''
child.stderr.on('data', (d) => {
  stderrTail = (stderrTail + d.toString()).slice(-2000)
})
child.on('error', (err) => {
  console.error(`verify-katago: failed to spawn: ${err.message}`)
  process.exit(1)
})

// Minimal GTP driver: queue commands, each "= ..." (or "? ...") line answers one.
const commands = ['boardsize 9', 'komi 7.0', 'genmove b', 'quit']
const answers = []
let buf = ''
child.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const reply = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 2)
    if (reply.length > 0) answers.push(reply)
    if (answers.length < commands.length && answers.length > 0) {
      child.stdin.write(commands[answers.length] + '\n')
    }
  }
})
child.stdin.write(commands[0] + '\n')

child.on('close', (code) => {
  clearTimeout(timeout)
  const genmove = answers[2] ?? ''
  const m = genmove.match(/^=\s*([A-HJ-T][0-9]{1,2}|pass)/i)
  if (!m) {
    console.error(`verify-katago: no legal move in reply ${JSON.stringify(genmove)} (exit ${code})`)
    console.error(`stderr tail:\n${stderrTail}`)
    process.exit(1)
  }
  console.log(`katago 9x9 genmove (b6c96, ${path.basename(bin)}): ${m[1]}`)
  console.log('verify-katago: OK')
})
