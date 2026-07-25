// Cross-platform Python launcher. macOS/Linux expose the interpreter as `python3`
// (there is no bare `python` on a stock macOS), while Windows installs `python`
// and the `py` launcher. This shim finds the first one that exists and forwards
// all arguments to it, so the npm `setup:engines` / `build:puzzles` scripts work
// identically on every OS. Usage: node scripts/run-python.mjs <script.py> [args...]
import { spawnSync } from 'node:child_process'

const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
const args = process.argv.slice(2)

for (const cmd of candidates) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  // ENOENT => this interpreter isn't installed; try the next candidate.
  if (res.error && res.error.code === 'ENOENT') continue
  process.exit(res.status ?? (res.signal ? 1 : 0))
}

console.error(
  `run-python: no Python interpreter found (tried: ${candidates.join(', ')}).\n` +
    'Install Python 3, macOS: `brew install python`, Windows: https://python.org, Linux: your package manager.'
)
process.exit(1)
