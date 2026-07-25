import { app, Menu } from 'electron'

// macOS routes the standard editing shortcuts (Cmd+C/V/X/A, Cmd+Z/Shift+Cmd+Z)
// and the app/window shortcuts (Cmd+Q, Cmd+W, Cmd+M, Cmd+H) through the global
// application menu: with NO menu installed, those keys simply do nothing. So on
// darwin we install a minimal menu built entirely from standard roles (no custom
// items): the app menu (About/Hide/Quit), the Edit menu (undo/redo/cut/copy/
// paste/selectAll) and the Window menu.
//
// On Windows/Linux the in-window menu bar is hidden (autoHideMenuBar in
// window.ts) and these shortcuts are handled by the OS/renderer, so we clear the
// application menu there. One code path, congruent across platforms.
export function installAppMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: app.name, role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
