// UCI transports: how raw command/line strings reach a WASM engine.
//
// Two shapes exist in this app:
//  - workerTransport: the `stockfish` npm package's builds ARE worker scripts,
//    `new Worker(url)`, postMessage(command string), onmessage → line strings.
//  - moduleTransport: fairy-stockfish-nnue.wasm's emscripten module runs on the
//    calling thread (its own pthread pool does the searching) and speaks
//    postMessage/addMessageListener; the module also exposes FS.writeFile,
//    which custom variants need for their variants.ini.
//
// Everything browser-global lives inside functions (never at module eval) so
// the headless suite can bundle these modules under Node. Where it drives the
// REAL fairy WASM through moduleTransport via a Node-built module instance.

export interface UciTransport {
  send(cmd: string): void
  onLine(cb: (line: string) => void): void
  onError(cb: (err: Error) => void): void
  /** Write a file into the engine's virtual FS (fairy variants.ini). Only the
   *  module transport implements this. */
  writeFile?(path: string, text: string): void
  terminate(): void
}

/** A stockfish.js-style worker: strings in, line strings out. */
export function workerTransport(url: string): UciTransport {
  const worker = new Worker(url)
  const lineCbs: Array<(line: string) => void> = []
  const errCbs: Array<(err: Error) => void> = []
  worker.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') for (const cb of lineCbs) cb(e.data)
  }
  worker.onerror = (e: ErrorEvent) => {
    const err = new Error(e.message || 'engine worker error')
    for (const cb of errCbs) cb(err)
  }
  return {
    send: (cmd) => worker.postMessage(cmd),
    onLine: (cb) => lineCbs.push(cb),
    onError: (cb) => errCbs.push(cb),
    terminate: () => {
      try {
        worker.postMessage('quit')
      } catch {
        /* worker already gone */
      }
      worker.terminate()
    }
  }
}

// ---- Fairy-Stockfish module (fairy-stockfish-nnue.wasm) --------------------------

/** The slice of the emscripten module instance the engine layer touches. */
export interface FairyModule {
  postMessage(cmd: string): void
  addMessageListener(cb: (line: string) => void): void
  terminate?(): void
  FS: { writeFile(path: string, data: string): void }
}

type FairyFactory = (opts: {
  locateFile: (file: string) => string
  mainScriptUrlOrBlob: string
}) => Promise<FairyModule>

let fairyScriptLoad: Promise<FairyFactory> | null = null

/** Load fairy stockfish.js via a same-origin <script> tag (it is a classic UMD
 *  script, not an ES module: bundling it would break its own worker/wasm
 *  resolution) and return the global `Stockfish` factory. Memoized; a failed
 *  load clears the memo so a later call can retry. */
function loadFairyFactory(scriptUrl: string): Promise<FairyFactory> {
  if (!fairyScriptLoad) {
    fairyScriptLoad = new Promise<FairyFactory>((resolve, reject) => {
      const existing = (globalThis as { Stockfish?: FairyFactory }).Stockfish
      if (existing) {
        resolve(existing)
        return
      }
      const s = document.createElement('script')
      s.src = scriptUrl
      s.async = true
      s.onload = () => {
        const factory = (globalThis as { Stockfish?: FairyFactory }).Stockfish
        if (factory) resolve(factory)
        else reject(new Error('fairy engine script loaded but exposed no Stockfish factory'))
      }
      s.onerror = () => reject(new Error(`failed to load fairy engine script ${scriptUrl}`))
      document.head.appendChild(s)
    })
    fairyScriptLoad.catch(() => {
      fairyScriptLoad = null
    })
  }
  return fairyScriptLoad
}

/** Browser loader for the fairy module: script tag + emscripten factory.
 *  locateFile pins the .wasm and stockfish.worker.js to the fairy asset dir;
 *  mainScriptUrlOrBlob is REQUIRED. The pthread workers importScripts it and
 *  without it the module would try to re-resolve itself relative to nothing. */
export async function loadFairyModuleBrowser(fairyBase: string): Promise<FairyModule> {
  const abs = (p: string): string => new URL(p, document.baseURI).href
  const factory = await loadFairyFactory(abs(`${fairyBase}stockfish.js`))
  return factory({
    locateFile: (file: string) => abs(`${fairyBase}${file}`),
    mainScriptUrlOrBlob: abs(`${fairyBase}stockfish.js`)
  })
}

/** Wrap a fairy module instance as a UciTransport (with FS access). */
export function moduleTransport(m: FairyModule): UciTransport {
  const errCbs: Array<(err: Error) => void> = []
  return {
    send: (cmd) => {
      try {
        m.postMessage(cmd)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        for (const cb of errCbs) cb(e)
      }
    },
    onLine: (cb) => m.addMessageListener(cb),
    onError: (cb) => errCbs.push(cb),
    writeFile: (path, text) => m.FS.writeFile(path, text),
    terminate: () => m.terminate?.()
  }
}
