// Electron replacement for the server's IPC-bridge bundle. scripts/
// build-ipc-bridge.mjs aliases `electron` to THIS file, so the unmodified
// desktop ipc modules (src/main/ipc/*.ipc.ts) bundle and run in plain Node.
// They consume exactly two electron surfaces:
//
//   ipcMain.handle(channel, fn):   collected into a Map here; the server drives
//                                  the handlers directly (POST /api/ipc/<channel>),
//                                  zod validation + all included, because the
//                                  bundled handle() wrapper (src/main/ipc/util.ts)
//                                  runs unchanged.
//   app,                           isPackaged / getPath('userData') / getVersion.
//
// Stub choices (build contract, shared decision 1):
//
//   isPackaged = true, with process.resourcesPath = <repo>/resources injected by
//   the server BEFORE any handler runs. school.repo/famous.repo/personas/
//   openings.repo/datasets-paths all resolve content via
//     app.isPackaged ? path.join(process.resourcesPath, …)
//                    : path.join(__dirname, '../../resources', …)
//   In this bundle __dirname is dist-server (depth 1 from the repo root), so the
//   dev branch would resolve to <repo>/../resources, the WRONG depth. The
//   packaged branch with an injected resourcesPath reads the real content
//   (curriculum/famous/personas/openings) for every repo from one knob.
//
//   getPath('userData') = the CURRENT per-request user dir, injected by the
//   server's FIFO-serialized bridge executor (setShimUserDataDir). Only
//   datasets/paths.ts consumes it in this bundle (imported-engine resolution
//   for the bounded school:debrief / personas:move engine passes), and only
//   ever inside a request scope.

export interface BridgeIpcEvent {
  senderFrame: { url: string }
}

export type BridgeIpcHandler = (event: BridgeIpcEvent, payload: unknown) => unknown

const handlers = new Map<string, BridgeIpcHandler>()
let userDataDir: string | null = null

export const ipcMain = {
  handle(channel: string, fn: BridgeIpcHandler): void {
    handlers.set(channel, fn)
  }
}

// Injected by scripts/build-ipc-bridge.mjs (esbuild define); typeof-guarded so
// an undefine'd bundle still loads.
declare const __WEB_APP_VERSION__: string

export const app = {
  isPackaged: true,
  getVersion(): string {
    return typeof __WEB_APP_VERSION__ === 'string' ? __WEB_APP_VERSION__ : 'dev'
  },
  getPath(name: string): string {
    if (name !== 'userData') {
      throw new Error(`electron-shim: unsupported app.getPath('${name}')`)
    }
    if (!userDataDir) {
      throw new Error('electron-shim: userData requested outside a bridge call scope')
    }
    return userDataDir
  }
}

/** Every handler the bundled ipc modules registered (channel -> fn). */
export function getRegisteredHandlers(): ReadonlyMap<string, BridgeIpcHandler> {
  return handlers
}

/** Point app.getPath('userData') at the per-request user dir (null between calls). */
export function setShimUserDataDir(dir: string | null): void {
  userDataDir = dir
}
