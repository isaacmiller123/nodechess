// nodechess seed — desktop shell.
//
// The desktop seed node is the SAME program as seed.nodechess.com: this process
// exists only to host the built `dist-seed` bundle in a window and keep it
// alive. There is no IPC surface, no preload bridge and no node integration —
// the page is ordinary web code that talks to the network over WebRTC, exactly
// as it does in a browser tab. Keeping it that way means there is one seed
// implementation to reason about, not two.
//
// The one thing the desktop build adds over a tab is PERSISTENCE: closing the
// window keeps the swarm running in the tray, because a seed node that dies
// whenever someone tidies their windows is not much of a seed node.

import { join } from 'node:path'
import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'

const isDev = !app.isPackaged
const DEV_URL = 'http://localhost:5200'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function createWindow(): void {
  win = new BrowserWindow({
    width: 720,
    height: 780,
    minWidth: 460,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1113',
    title: 'nodechess seed',
    webPreferences: {
      // No preload, no node in the renderer: the seed page is web code.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win?.show())

  // Closing hides to the tray instead of quitting — the swarm keeps serving.
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
  })

  // Any link the page tries to open goes to the real browser, never an
  // in-app window we would then have to secure.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) void win.loadURL(DEV_URL)
  else void win.loadFile(join(__dirname, '../seed/index.html'))
}

function createTray(): void {
  // An empty image is a valid tray icon on every platform we ship; the real
  // artwork is wired with the rest of the brand assets.
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('nodechess seed')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => win?.show() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()))
}

// One instance only: two swarms from one installation would collide on the
// per-node IndexedDB stores and double-announce the same identities.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    win?.show()
    win?.focus()
  })

  void app.whenReady().then(() => {
    createWindow()
    createTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else win?.show()
    })
  })

  // Deliberately NOT quitting on window-all-closed: hiding to the tray is the
  // whole point. Quit is an explicit act from the tray menu.
  app.on('before-quit', () => {
    quitting = true
  })
}
