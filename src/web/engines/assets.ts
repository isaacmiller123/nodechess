// Engine asset locations + capability checks. All engine js/wasm files are
// served SAME-ORIGIN under <base>/engines/ (vite-plugin-static-copy wires them
// in vite.web.config.ts: dev server middleware + emitted into dist-web on
// build), which satisfies COEP require-corp. The servers (dev + prod) both
// send COOP/COEP so crossOriginIsolated/SharedArrayBuffer are available.
//
// Asset choices (see the W2 report for the full rationale):
//  - Standard chess: the `stockfish` npm package's LITE builds (Stockfish 18,
//    ~7 MB wasm with the small NNUE net EMBEDDED: no separate .nnue fetch).
//    lila-stockfish-web's sf171-79 was rejected because its NNUE nets (79 MB +
//    6 MB) are not shipped in the package and would need a CDN fetch.
//    stockfish-18-lite.js  = multithreaded (needs SharedArrayBuffer);
//    stockfish-18-lite-single.js = single-threaded fallback when the page is
//    not crossOriginIsolated (e.g. dist-web hosted without the headers).
//  - Variants: fairy-stockfish-nnue.wasm (the pychess build), documented
//    emscripten `Stockfish()` factory with FS.writeFile (custom variants.ini)
//    and addMessageListener. Chosen over lila-stockfish-web's fsf14 because
//    fsf14 exposes no FS, so Variant Lab customs could not load their ini.

/** Vite base URL ('/' in this app); guarded so non-Vite bundlers (the esbuild
 *  test harness) evaluate this module without an `import.meta.env`. */
function baseUrl(): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env
  return env?.BASE_URL ?? '/'
}

export function enginesDir(): string {
  return `${baseUrl()}engines/`
}

/** True when SharedArrayBuffer-backed (multithreaded) WASM can run here. */
export function isolated(): boolean {
  return (
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true &&
    typeof SharedArrayBuffer === 'function'
  )
}

/** The chess engine worker script for this context: multithreaded when the
 *  page is crossOriginIsolated, the single-threaded build otherwise. The
 *  stockfish.js worker resolves its .wasm as <same basename>.wasm next to the
 *  script, so the js/wasm pairs must be copied together. */
export function chessWorkerUrl(): string {
  return `${enginesDir()}${isolated() ? 'stockfish-18-lite.js' : 'stockfish-18-lite-single.js'}`
}

export function fairyDir(): string {
  return `${enginesDir()}fairy/`
}

export function fairyScriptUrl(): string {
  return `${fairyDir()}stockfish.js`
}

/** WASM support probe (every 2020+ browser passes; belt-and-braces). */
export function wasmSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function'
}

/** Can this environment run the engine layer at all (Worker + WASM)? The
 *  factories throw at CONSTRUCTION when this is false, so webApi's lazy()
 *  catch parks them and the W1 coming-online fallbacks keep answering.
 *  Exactly the designed degradation for engineless environments (bare Node
 *  test harnesses, ancient browsers). */
export function webEngineSupported(): boolean {
  return typeof Worker === 'function' && wasmSupported()
}

/** Same-origin reachability probe for one asset (HEAD, GET fallback for
 *  servers that answer HEAD with 405). Used by engine.status() so a
 *  misconfigured deployment reports NOT ready (renderer gates engage) instead
 *  of arming surfaces whose engine calls can only fail. */
export async function assetReachable(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: 'HEAD' })
    if (head.ok) return true
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url)
      return get.ok
    }
    return false
  } catch {
    return false
  }
}
