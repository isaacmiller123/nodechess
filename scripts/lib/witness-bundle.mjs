// Shared esbuild bundling helper for the A2 witness/fabric suites
// (test-accounts-lease.mjs, test-accounts-fabric.mjs, operator-smoke.mjs).
// Mirrors the house style of scripts/test-accounts-witness.mjs: write a tiny TS
// entry that re-exports the shared modules, bundle it on the fly (alias
// @shared → src/shared), dynamic-import the result from a temp dir, and clean up
// in the caller's try/finally. platform:'node' by default; pass 'browser' to
// prove the shared tree carries zero node built-ins.

import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(__dirname, '..', '..')

/** Make a fresh temp outdir under node_modules/.cache/<tag>. */
export function makeOutdir(tag) {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache', tag)
  mkdirSync(cacheRoot, { recursive: true })
  return mkdtempSync(resolve(cacheRoot, 'run-'))
}

/**
 * Bundle `entrySource` (TypeScript) into `outdir` and dynamic-import it.
 * @param {string} outdir  temp dir (from makeOutdir)
 * @param {string} entrySource  TS module source (imports use absolute @shared or
 *                               server-relative paths: see the suites)
 * @param {'node'|'browser'} [platform]
 * @returns the imported module namespace
 */
export async function bundleAndImport(outdir, entrySource, platform = 'node') {
  const entry = resolve(outdir, 'entry.ts')
  writeFileSync(entry, entrySource)
  const outfile = resolve(outdir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform,
    mainFields: ['module', 'main'],
    conditions: ['import', 'module', 'default'],
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    absWorkingDir: ROOT,
    logLevel: 'warning',
  })
  return import(pathToFileURL(outfile).href)
}

/** The absolute src/shared/accounts dir with forward slashes (for entry imports). */
export const SRC_ACCOUNTS = resolve(ROOT, 'src/shared/accounts').replace(/\\/g, '/')
