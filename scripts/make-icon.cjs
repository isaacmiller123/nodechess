// Render the nodechess logo to build/icon.png (512) and build/icon.ico (256) via an
// offscreen Electron window. Run: electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()

const SVG = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4ea0ef"/>
      <stop offset="1" stop-color="#2a72b8"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#g)"/>
  <!-- The node mark, same geometry as src/renderer/src/components/Logo.tsx. -->
  <g transform="translate(256 256) scale(8.6) translate(-24 -24)" fill="#ffffff">
    <g stroke="#ffffff" stroke-width="2.6" stroke-linecap="round">
      <line x1="24" y1="24" x2="24" y2="8"/>
      <line x1="24" y1="24" x2="10.1" y2="32"/>
      <line x1="24" y1="24" x2="37.9" y2="32"/>
    </g>
    <circle cx="24" cy="24" r="6"/>
    <circle cx="24" cy="8" r="3.6"/>
    <circle cx="10.1" cy="32" r="3.6"/>
    <circle cx="37.9" cy="32" r="3.6"/>
  </g>
</svg>`

const HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">${SVG}</body>`

function icoFromPng(png) {
  const h = Buffer.alloc(6)
  h.writeUInt16LE(0, 0)
  h.writeUInt16LE(1, 2)
  h.writeUInt16LE(1, 4)
  const d = Buffer.alloc(16)
  d[0] = 0 // width 0 => 256
  d[1] = 0 // height 0 => 256
  d.writeUInt16LE(1, 4) // color planes
  d.writeUInt16LE(32, 6) // bpp
  d.writeUInt32LE(png.length, 8)
  d.writeUInt32LE(22, 12) // offset (6 + 16)
  return Buffer.concat([h, d, png])
}

app.on('ready', () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })
  let done = false
  // capturePage AFTER the load settles, not the first 'paint' event: offscreen
  // rendering emits a blank frame before the SVG is laid out, and taking the
  // first non-empty frame silently wrote an all-white icon.
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const image = await win.webContents.capturePage()
      if (done || image.isEmpty()) {
        console.log('FAIL: capturePage returned an empty image')
        return app.quit()
      }
      done = true
      const dir = path.join(__dirname, '..', 'build')
      fs.mkdirSync(dir, { recursive: true })
      const png = image.toPNG()
      fs.writeFileSync(path.join(dir, 'icon.png'), png)
      const png256 = image.resize({ width: 256, height: 256 }).toPNG()
      const ico = icoFromPng(png256)
      fs.writeFileSync(path.join(dir, 'icon.ico'), ico)
      console.log(`icon written: png=${png.length}B ico=${ico.length}B at ${dir}`)
      setTimeout(() => app.quit(), 150)
    }, 600)
  })
  win.webContents.setFrameRate(2)
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  setTimeout(() => {
    if (!done) {
      console.log('FAIL: no paint captured')
      app.quit()
    }
  }, 8000)
})
