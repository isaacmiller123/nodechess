#!/usr/bin/env node
// Bundle the server-side IPC bridge (server/bridge-entry.ts) →
// dist-server/ipc-bridge.cjs.
//
// This is the web server's persistence/content backend: the UNMODIFIED desktop
// ipc modules (app/maintenance/settings/puzzles×3/ratings/games/openings/coach/
// famous/school/personas/customVariants) with `electron` aliased to
// server/electron-shim.ts, which collects handle() registrations into a Map the
// server drives via POST /api/ipc/<channel>. Engine/review/datasets/updates/
// dialog ipc are desktop-only and deliberately NOT in the entry's import graph.
//
// Kept SEPARATE from scripts/build-server.mjs on purpose: dist-server/index.cjs
// (statics + auth + routing) builds without touching src/main, and
// server/index.ts require()s this artifact lazily at runtime. A missing bridge
// degrades to 503 coming-online instead of breaking the static server.

import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

await build({
  entryPoints: [path.join(root, 'server/bridge-entry.ts')],
  outfile: path.join(root, 'dist-server/ipc-bridge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  alias: {
    electron: path.join(root, 'server/electron-shim.ts'),
    '@shared': path.join(root, 'src/shared')
  },
  define: {
    __WEB_APP_VERSION__: JSON.stringify(pkg.version)
  },
  logLevel: 'info'
})
