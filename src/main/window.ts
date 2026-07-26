import { app, BrowserWindow } from 'electron'
import path from 'node:path'

// Locked security defaults (architecture §2.4). Changing any of these is a review bug.
// opts.smokeWasm: --smoke-wasm self-test (see main/smokeWasm.ts). The window
// stays hidden and the renderer gets ?smoke-wasm=1 so it runs the WASM probe.
export function createWindow(opts?: { smokeWasm?: boolean }): BrowserWindow {
  const smokeWasm = opts?.smokeWasm === true
  const win = new BrowserWindow({
    title: 'nodechess',
    width: 1280,
    height: 832,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#161512',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Keep renderer timers running when the window is hidden/occluded (MP-V3 §6,
      // L4): online-multiplayer liveness (heartbeat), the host's authoritative flag
      // watchdog, and the lobby/hosting phase all run on renderer timers. WebRTC
      // exempts us once a data channel is up, but this also protects the pre-game
      // lobby, which holds no WebRTC connection yet.
      backgroundThrottling: false
    }
  })

  // CAMERA, AND NOTHING ELSE.
  //
  // Electron denies every permission request by default unless a handler says
  // otherwise, so without this the QR sign-in scanner (features/account/pairing)
  // fails on desktop with a permission error while working fine in a browser.
  // That is the one place the packaged app asks for a device at all.
  //
  // This is an ALLOWLIST OF ONE and it must stay that way. The renderer loads
  // only our own bundle, but a permission handler that says yes to everything
  // would hand geolocation, notifications, the microphone and the screen to any
  // script that ever finds its way in. Anything not named here is denied, which
  // is the pre-existing behaviour for everything except the camera.
  const ses = win.webContents.session
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  // Chromium also asks synchronously on some paths (enumerateDevices, and the
  // check that precedes a getUserMedia prompt), and that path ignores the
  // handler above. Same single allowance.
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  if (!smokeWasm) win.once('ready-to-show', () => win.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (smokeWasm) url.searchParams.set('smoke-wasm', '1')
    win.loadURL(url.toString())
  } else {
    // TODO(packaging): serve via a registered app:// protocol for strict-CSP correctness.
    win.loadFile(
      path.join(__dirname, '../renderer/index.html'),
      smokeWasm ? { query: { 'smoke-wasm': '1' } } : undefined
    )
  }

  return win
}
