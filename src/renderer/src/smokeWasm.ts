// Renderer half of the --smoke-wasm packaged-app self-test (main/smokeWasm.ts).
//
// Runs ALONGSIDE the normal app mount (so the whole renderer boots under the
// strict PROD_CSP: any module-level eval/WASM violation anywhere surfaces as
// a console CSP error, which the main process treats as failure). The probe
// itself exercises exactly what broke in v1.1.0: compiling the ffish-es6 WASM
// (needs script-src 'wasm-unsafe-eval') and its embind bindings (need the
// eval-free glue from scripts/patch-ffish-csp.mjs): a Board round-trip plus
// the Variant Lab's loadVariantConfig path.
//
// Protocol (watched by main via console-message): print exactly one of
//   SMOKE-WASM-OK ...    → exit 0
//   SMOKE-WASM-FAIL ...  → exit 1
export async function runSmokeWasm(): Promise<void> {
  try {
    const { preloadFfish } = await import('./games/ffish')
    const ffish = await preloadFfish()

    const board = new ffish.Board('xiangqi')
    const moves = board.legalMoves().split(' ').filter(Boolean)
    const startFen = board.fen()
    board.push(moves[0])
    const pushed = board.fen() !== startFen
    board.delete()
    if (moves.length !== 44 || !pushed) {
      throw new Error(`xiangqi probe: legalMoves=${moves.length} (want 44), pushed=${pushed}`)
    }

    // Variant Lab path: runtime-loaded custom variant config.
    ffish.loadVariantConfig('[smokevar:chess]\nmaxRank = 8\n')
    if (!ffish.variants().includes('smokevar')) {
      throw new Error('loadVariantConfig probe: smokevar missing from ffish.variants()')
    }

    console.log('SMOKE-WASM-OK xiangqi 44 moves, push/fen round-trip, loadVariantConfig')
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    // Single line: main matches on the prefix; newlines would split the message.
    console.log('SMOKE-WASM-FAIL ' + detail.replace(/\s+/g, ' '))
  }
}
