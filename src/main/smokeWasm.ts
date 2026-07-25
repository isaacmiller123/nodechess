import { app, type BrowserWindow } from 'electron'

// --smoke-wasm: packaged-app self-test for the strict PROD_CSP (security.ts).
//
// The v1.1.0 xiangqi/Variant Lab breakage was invisible in dev because DEV_CSP
// carries 'unsafe-eval': only the packaged app runs the strict policy. This
// hook makes that testable headlessly: scripts/smoke-packed-wasm.mjs launches
// the packed binary with --smoke-wasm, the renderer boots the real app plus a
// ffish WASM probe (src/renderer/src/smokeWasm.ts, via the ?smoke-wasm query),
// and we forward every renderer console line to stdout and turn the outcome
// into an exit code:
//   0:   renderer printed SMOKE-WASM-OK (ffish WASM compiled + embind worked)
//   1:   SMOKE-WASM-FAIL, ANY Content-Security-Policy violation from any
//        module (catches non-ffish eval regressions too), renderer crash, or
//        timeout.
export function installSmokeWasm(win: BrowserWindow, timeoutMs = 60000): void {
  let finished = false
  const done = (code: number, why: string): void => {
    if (finished) return
    finished = true
    console.log(`[smoke-wasm] exit ${code}: ${why}`)
    app.exit(code)
  }
  const timer = setTimeout(() => done(1, `timeout after ${timeoutMs}ms`), timeoutMs)
  timer.unref()

  win.webContents.on('console-message', ({ message, level }) => {
    console.log(`[renderer:${level}] ${message}`)
    if (message.includes('SMOKE-WASM-OK')) {
      clearTimeout(timer)
      done(0, message)
    } else if (message.includes('SMOKE-WASM-FAIL') || message.includes('Content Security Policy')) {
      clearTimeout(timer)
      done(1, message)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    clearTimeout(timer)
    done(1, `renderer gone: ${details.reason}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    clearTimeout(timer)
    done(1, `did-fail-load ${code} ${desc}`)
  })
}
