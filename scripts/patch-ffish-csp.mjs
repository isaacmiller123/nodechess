// Applies the eval-free embind rewrite to node_modules/ffish-es6/ffish.js IN
// PLACE (see scripts/lib/ffish-csp-patch.mjs for the why and the patch table).
// Runs from npm postinstall so every consumer, electron-vite build/dev and
// the headless test suites, gets the patched glue. Idempotent: a marker
// comment on line 1 makes re-runs a no-op. Throws (exit 1) if ffish.js is
// neither pristine-and-patchable nor already patched.
//
//   node scripts/patch-ffish-csp.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { patchFfishSource, isFfishSourcePatched } from './lib/ffish-csp-patch.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = resolve(ROOT, 'node_modules/ffish-es6/ffish.js')

const source = readFileSync(TARGET, 'utf8')
if (isFfishSourcePatched(source)) {
  console.log('ffish-csp-patch: already applied. Nothing to do')
} else {
  writeFileSync(TARGET, patchFfishSource(source))
  console.log('ffish-csp-patch: applied eval-free embind glue to node_modules/ffish-es6/ffish.js')
}
