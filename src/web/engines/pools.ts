// Engine pools + serialization chains: the web twin of the desktop pool
// modules (StockfishPool/FairyPool) and engine.ipc.ts's serialize helpers.
//
// SHARED SINGLETONS: createEngineApi, createReviewApi and createPersonaMove
// are separate factories (the index.ts contract), but they must drive the SAME
// two logical Stockfish instances and the same fairy engine, through the same
// per-instance FIFO chains, or their option writes and temporarily attached
// listeners could interleave. Desktop gets this for free (one ipc module owns
// everything); on the web this module is that owner.
//
// Divergences from desktop (documented in the W2 report):
//  - review runs on the ANALYSIS instance (desktop spawns a throwaway engine
//    per review): a third 128 MB wasm instance per review is too heavy.
//  - persona moves run on the PLAY instance via the play chain (desktop keeps
//    a separate idle-reaped persona process): same memory reasoning; every
//    play-chain caller re-asserts its own options before searching, so the
//    sharing is safe.

import { isolated, chessWorkerUrl, fairyDir } from './assets'
import { WebUciEngine } from './WebUciEngine'
import {
  loadFairyModuleBrowser,
  moduleTransport,
  workerTransport,
  type FairyModule
} from './transport'

// ---- FIFO chains (verbatim port of engine.ipc.ts serialize helpers) --------------

function makeChain(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/** Analysis-instance chain: engine:analyze, engine:stop, review searches. */
export const serializeAnalysis = makeChain()
/** Play-instance chain: engine:play, persona moves. */
export const serializePlay = makeChain()
/** Fairy chain: engine:playVariant + engine:evalVariant. */
export const serializeFairy = makeChain()

// ---- Thread budgets ---------------------------------------------------------------

function cores(): number {
  return typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4
}

/** Desktop: cpus-1. Web: additionally capped. Every wasm thread is a worker
 *  with stack inside one shared memory, and the tab shares cores with the UI. */
function analysisThreads(): number {
  return Math.max(1, Math.min(8, cores() - 1))
}

function playThreads(): number {
  return Math.max(1, Math.min(2, cores() - 1))
}

// ---- Chess pool (two logical instances, mirrors StockfishPool) ---------------------

class WebStockfishPool {
  private analysis: WebUciEngine | null = null
  private play: WebUciEngine | null = null

  private async boot(threads: number, hashMb: number): Promise<WebUciEngine> {
    const eng = new WebUciEngine(workerTransport(chessWorkerUrl()))
    await eng.start()
    if (isolated()) eng.setOption('Threads', threads)
    eng.setOption('Hash', hashMb)
    eng.setOption('UCI_LimitStrength', false)
    await eng.isready()
    return eng
  }

  /** Drop a crashed engine so the next call respawns instead of writing into a
   *  dead worker (desktop pools never needed this; a dead process there
   *  surfaces via spawn errors; a dead worker is silent). */
  private watch(eng: WebUciEngine, slot: 'analysis' | 'play'): WebUciEngine {
    const drop = (): void => {
      if (this[slot] === eng) this[slot] = null
    }
    eng.once('engineError', drop)
    eng.once('exit', drop)
    return eng
  }

  async getAnalysis(): Promise<WebUciEngine> {
    if (!this.analysis) {
      this.analysis = this.watch(await this.boot(analysisThreads(), 128), 'analysis')
    }
    return this.analysis
  }

  async getPlay(): Promise<WebUciEngine> {
    if (!this.play) {
      this.play = this.watch(await this.boot(playThreads(), 32), 'play')
    }
    return this.play
  }

  hasAnalysis(): boolean {
    return this.analysis !== null
  }

  hasPlay(): boolean {
    return this.play !== null
  }
}

export const pool = new WebStockfishPool()

// ---- Fairy pool (mirrors FairyStockfishPool) ---------------------------------------

/** How the fairy module is created. Browser default; the headless suite
 *  injects a Node-built module so the REAL fairy WASM runs under Node. */
let fairyLoader: () => Promise<FairyModule> = () => loadFairyModuleBrowser(fairyDir())

export function setFairyModuleLoader(fn: () => Promise<FairyModule>): void {
  fairyLoader = fn
}

/** A custom variants.ini to load before selecting the variant. */
export interface VariantIni {
  /** Custom variant id. Keys the content-diff cache (desktop writeVariantIni). */
  id: string
  text: string
}

class WebFairyPool {
  private engine: WebUciEngine | null = null
  private variant: string | null = null
  private chess960 = false
  private loadedIni: string | null = null // "<id>\n<text>" content-diff key

  async get(variant: string, chess960: boolean, variantIni?: VariantIni): Promise<WebUciEngine> {
    if (!this.engine) {
      const eng = new WebUciEngine(moduleTransport(await fairyLoader()))
      await eng.start()
      eng.setOption('Threads', playThreads())
      eng.setOption('Hash', 32)
      await eng.isready()
      const drop = (): void => {
        if (this.engine === eng) {
          this.engine = null
          this.variant = null
          this.loadedIni = null
        }
      }
      eng.once('engineError', drop)
      eng.once('exit', drop)
      this.engine = eng
      this.variant = null // force the variant handshake below
      this.loadedIni = null
    }
    const e = this.engine
    if (variantIni !== undefined) {
      const key = `${variantIni.id}\n${variantIni.text}`
      if (key !== this.loadedIni) {
        // Desktop writes userData/variant-lab/<id>.ini and points VariantPath
        // at it; here the "disk" is the module's in-memory emscripten FS.
        const path = `/variant-${variantIni.id}.ini`
        e.writeFile(path, variantIni.text)
        e.setOption('VariantPath', path)
        await e.isready() // ini parse happens on the option. Settle before UCI_Variant
        this.loadedIni = key
        this.variant = null // re-select even if the name string matches
      }
    }
    if (this.variant !== variant || this.chess960 !== chess960) {
      e.setOption('UCI_Variant', variant)
      e.setOption('UCI_Chess960', chess960)
      await e.newGame()
      this.variant = variant
      this.chess960 = chess960
    }
    return e
  }

  hasEngine(): boolean {
    return this.engine !== null
  }
}

export const fairyPool = new WebFairyPool()
