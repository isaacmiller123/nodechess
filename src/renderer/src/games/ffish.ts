// ffish-es6 WASM loader: async singleton over the emscripten module factory
// (docs/GAMES-PLATFORM-SPEC.md §Approved stack).
//
// ffish-es6 exports an emscripten factory: `Module(opts) → Promise<ffish>`.
// GameSpec calls are sync, so the ffish family specs (games/ffishVariants.ts)
// route every rules call through getFfish(), which throws a clear error until
// preloadFfish() has resolved. Callers (registry consumers) see
// `requiresPreload: true` on the entries and await `spec.preload()` first.
//
// WASM resolution, in priority order:
//   1. options.wasmBinary: headless tests pass the bytes directly (this
//      emscripten build has no node filesystem read path. REQUIRED in node).
//   2. options.wasmUrl: explicit override.
//   3. browser/worker: `import('ffish-es6/ffish.wasm?url')`: Vite turns the
//      asset into a URL for emscripten's locateFile. Headless esbuild bundles
//      must mark it external (external: ['*?url']): the branch never runs in
//      node, where load() without wasmBinary throws instead.

import type { FairyStockfish, ModuleOptions } from 'ffish-es6'

export type { FairyStockfish }

export interface FfishPreloadOptions {
  /** WASM bytes (headless tests). Wins over URL resolution. */
  wasmBinary?: ArrayBuffer | Uint8Array
  /** Explicit URL for ffish.wasm. */
  wasmUrl?: string
  /** Forward engine prints (illegal-move chatter etc.) to the console. Default: silent. */
  verbose?: boolean
}

let instance: FairyStockfish | null = null
let pending: Promise<FairyStockfish> | null = null

export function isFfishReady(): boolean {
  return instance !== null
}

/** The loaded module. Throws until preloadFfish() has resolved. */
export function getFfish(): FairyStockfish {
  if (!instance) {
    throw new Error(
      'ffish WASM not loaded yet: await preloadFfish() (or the game spec\'s preload()) ' +
        'before using xiangqi/shogi/janggi/makruk/placement rules'
    )
  }
  return instance
}

/** Idempotent singleton load. Options are honored on the FIRST call only. */
export function preloadFfish(options?: FfishPreloadOptions): Promise<FairyStockfish> {
  if (instance) return Promise.resolve(instance)
  if (!pending) {
    pending = load(options).then(
      (mod) => {
        instance = mod
        return mod
      },
      (err) => {
        pending = null // allow retry after a failed load
        throw err
      }
    )
  }
  return pending
}

async function load(options?: FfishPreloadOptions): Promise<FairyStockfish> {
  const factory = (await import('ffish-es6')).default
  const moduleOptions: Record<string, unknown> = {}
  if (!options?.verbose) {
    const noop = (): void => undefined
    moduleOptions.print = noop
    moduleOptions.printErr = noop
  }
  if (options?.wasmBinary) {
    moduleOptions.wasmBinary = options.wasmBinary
  } else if (options?.wasmUrl) {
    const url = options.wasmUrl
    moduleOptions.locateFile = (): string => url
  } else if (
    typeof window !== 'undefined' ||
    typeof (globalThis as { importScripts?: unknown }).importScripts === 'function'
  ) {
    const asset = (await import('ffish-es6/ffish.wasm?url')) as { default: string }
    moduleOptions.locateFile = (): string => asset.default
  } else {
    // bare node: this emscripten build has no filesystem read path, and the
    // renderer tsconfig has no node types. Callers must supply the bytes.
    throw new Error('preloadFfish in node requires options.wasmBinary (read ffish.wasm yourself)')
  }
  return factory(moduleOptions as ModuleOptions)
}
