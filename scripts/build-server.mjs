#!/usr/bin/env node
// Bundle the web server (server/index.ts) → dist-server/index.cjs.
//
// Self-contained on purpose: fastify + @fastify/static live in
// devDependencies (they must NOT ride into the desktop app that
// electron-builder packages from `dependencies`), and the Docker runtime
// stage copies only dist-web + dist-server + static trees: no node_modules.
// CommonJS output because fastify's dependency graph is cjs-native and
// esbuild bundles it losslessly that way (__dirname stays real).

import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  define: {
    __WEB_APP_VERSION__: JSON.stringify(pkg.version),
    // A-final (ACCOUNTS-SPEC §14, server/afinal.ts): every SHIPPED build
    // defaults to the decentralized accounts (interim /api/auth answers 410).
    // Env ACCOUNTS_DECENTRALIZED=0/1 overrides at runtime; ad-hoc bundles
    // without this define (the pre-A-final test rigs) fall back OFF.
    __ACCOUNTS_DECENTRALIZED_DEFAULT__: JSON.stringify('on')
  },
  logLevel: 'info'
})
