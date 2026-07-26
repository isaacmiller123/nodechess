// Render the nodechess logo to build/icon.png, build/icon.ico and, on macOS,
// build/icon.icns via an offscreen Electron window.
// Run: electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

app.disableHardwareAcceleration()

// THE MARK, not a reduction of it. Generated from the SAME arrays the app
// draws: EDGES and NODES in src/renderer/src/components/Logo.tsx, 50 links and
// 67 nodes in a 100 x 100 box, so the icon cannot drift from the logo.
//
// WHAT CHANGED AND WHY. This used to draw the reduced rook on a blue gradient,
// on the argument that a lattice stops resolving at 16px in a dock. The owner
// asked for the detailed mark in grey and white instead, so the trade is taken
// deliberately: at 16px the field reads as texture rather than as a lattice,
// and the silhouette still reads as one solid mass because the built nodes are
// full white while the surrounding dust sits at 34%.
//
// Grey and white, never blue: the ground is the cold-iron gradient and the mark
// is #ffffff. Nothing here reads a palette token, because an icon is baked once
// and cannot follow a palette the user changes later.
const SVG = `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a3b3f"/><stop offset="1" stop-color="#1f2023"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <g transform="translate(21.78 3.72) scale(4.4698)">
    <g stroke="#ffffff" stroke-linecap="round" opacity="0.92">
      <line x1="27.2" y1="36.82" x2="39.8" y2="36.82" stroke-width="1.5"/>
      <line x1="27.2" y1="36.82" x2="33.5" y2="47.74" stroke-width="1.5"/>
      <line x1="39.8" y1="36.82" x2="52.4" y2="36.82" stroke-width="1.5"/>
      <line x1="39.8" y1="36.82" x2="33.5" y2="47.74" stroke-width="1.5"/>
      <line x1="39.8" y1="36.82" x2="46.1" y2="47.74" stroke-width="1.5"/>
      <line x1="52.4" y1="36.82" x2="65.0" y2="36.82" stroke-width="1.5"/>
      <line x1="52.4" y1="36.82" x2="46.1" y2="47.74" stroke-width="1.5"/>
      <line x1="52.4" y1="36.82" x2="58.7" y2="47.74" stroke-width="1.5"/>
      <line x1="65.0" y1="36.82" x2="58.7" y2="47.74" stroke-width="1.5"/>
      <line x1="33.5" y1="47.74" x2="46.1" y2="47.74" stroke-width="1.5"/>
      <line x1="33.5" y1="47.74" x2="39.8" y2="58.65" stroke-width="1.5"/>
      <line x1="46.1" y1="47.74" x2="58.7" y2="47.74" stroke-width="1.5"/>
      <line x1="46.1" y1="47.74" x2="39.8" y2="58.65" stroke-width="1.5"/>
      <line x1="46.1" y1="47.74" x2="52.4" y2="58.65" stroke-width="1.5"/>
      <line x1="58.7" y1="47.74" x2="52.4" y2="58.65" stroke-width="1.5"/>
      <line x1="58.7" y1="47.74" x2="65.0" y2="58.65" stroke-width="1.5"/>
      <line x1="39.8" y1="58.65" x2="52.4" y2="58.65" stroke-width="1.5"/>
      <line x1="39.8" y1="58.65" x2="33.5" y2="69.56" stroke-width="1.5"/>
      <line x1="39.8" y1="58.65" x2="46.1" y2="69.56" stroke-width="1.5"/>
      <line x1="52.4" y1="58.65" x2="65.0" y2="58.65" stroke-width="1.5"/>
      <line x1="52.4" y1="58.65" x2="46.1" y2="69.56" stroke-width="1.5"/>
      <line x1="52.4" y1="58.65" x2="58.7" y2="69.56" stroke-width="1.5"/>
      <line x1="65.0" y1="58.65" x2="58.7" y2="69.56" stroke-width="1.5"/>
      <line x1="65.0" y1="58.65" x2="71.3" y2="69.56" stroke-width="1.5"/>
      <line x1="33.5" y1="69.56" x2="46.1" y2="69.56" stroke-width="1.5"/>
      <line x1="33.5" y1="69.56" x2="27.2" y2="80.47" stroke-width="1.5"/>
      <line x1="33.5" y1="69.56" x2="39.8" y2="80.47" stroke-width="1.5"/>
      <line x1="46.1" y1="69.56" x2="58.7" y2="69.56" stroke-width="1.5"/>
      <line x1="46.1" y1="69.56" x2="39.8" y2="80.47" stroke-width="1.5"/>
      <line x1="46.1" y1="69.56" x2="52.4" y2="80.47" stroke-width="1.5"/>
      <line x1="58.7" y1="69.56" x2="71.3" y2="69.56" stroke-width="1.5"/>
      <line x1="58.7" y1="69.56" x2="52.4" y2="80.47" stroke-width="1.5"/>
      <line x1="58.7" y1="69.56" x2="65.0" y2="80.47" stroke-width="1.5"/>
      <line x1="71.3" y1="69.56" x2="65.0" y2="80.47" stroke-width="1.5"/>
      <line x1="71.3" y1="69.56" x2="77.6" y2="80.47" stroke-width="1.5"/>
      <line x1="27.2" y1="80.47" x2="39.8" y2="80.47" stroke-width="1.5"/>
      <line x1="39.8" y1="80.47" x2="52.4" y2="80.47" stroke-width="1.5"/>
      <line x1="52.4" y1="80.47" x2="65.0" y2="80.47" stroke-width="1.5"/>
      <line x1="65.0" y1="80.47" x2="77.6" y2="80.47" stroke-width="1.5"/>
      <line x1="39.8" y1="36.82" x2="33.5" y2="25.91" stroke-width="0.75"/>
      <line x1="39.8" y1="36.82" x2="46.1" y2="25.91" stroke-width="0.75"/>
      <line x1="65.0" y1="36.82" x2="58.7" y2="25.91" stroke-width="0.75"/>
      <line x1="65.0" y1="36.82" x2="71.3" y2="25.91" stroke-width="0.75"/>
      <line x1="65.0" y1="36.82" x2="77.6" y2="36.82" stroke-width="0.75"/>
      <line x1="65.0" y1="36.82" x2="71.3" y2="47.74" stroke-width="0.75"/>
      <line x1="39.8" y1="58.65" x2="27.2" y2="58.65" stroke-width="0.75"/>
      <line x1="65.0" y1="58.65" x2="71.3" y2="47.74" stroke-width="0.75"/>
      <line x1="32.5" y1="21.5" x2="27.2" y2="36.82" stroke-width="1.5"/>
      <line x1="50.0" y1="21.5" x2="52.4" y2="36.82" stroke-width="1.5"/>
      <line x1="67.5" y1="21.5" x2="65.0" y2="36.82" stroke-width="1.5"/>
    </g>
    <g fill="#ffffff">
      <circle cx="2.0" cy="15.0" r="0.7" opacity="0.34"/>
      <circle cx="14.6" cy="15.0" r="1.15" opacity="0.34"/>
      <circle cx="27.2" cy="15.0" r="1.15" opacity="0.34"/>
      <circle cx="39.8" cy="15.0" r="1.15" opacity="0.34"/>
      <circle cx="52.4" cy="15.0" r="1.15" opacity="0.34"/>
      <circle cx="65.0" cy="15.0" r="1.15" opacity="0.34"/>
      <circle cx="77.6" cy="15.0" r="1.15" opacity="0.34"/>
      <circle cx="90.2" cy="15.0" r="0.7" opacity="0.34"/>
      <circle cx="8.3" cy="25.91" r="1.15" opacity="0.34"/>
      <circle cx="20.9" cy="25.91" r="2.1" opacity="1"/>
      <circle cx="33.5" cy="25.91" r="2.1" opacity="1"/>
      <circle cx="46.1" cy="25.91" r="2.1" opacity="1"/>
      <circle cx="58.7" cy="25.91" r="2.1" opacity="1"/>
      <circle cx="71.3" cy="25.91" r="2.1" opacity="1"/>
      <circle cx="83.9" cy="25.91" r="1.15" opacity="0.34"/>
      <circle cx="96.5" cy="25.91" r="0.7" opacity="0.34"/>
      <circle cx="2.0" cy="36.82" r="0.7" opacity="0.34"/>
      <circle cx="14.6" cy="36.82" r="1.15" opacity="0.34"/>
      <circle cx="27.2" cy="36.82" r="4.9" opacity="1"/>
      <circle cx="39.8" cy="36.82" r="4.9" opacity="1"/>
      <circle cx="52.4" cy="36.82" r="4.9" opacity="1"/>
      <circle cx="65.0" cy="36.82" r="4.9" opacity="1"/>
      <circle cx="77.6" cy="36.82" r="2.1" opacity="1"/>
      <circle cx="90.2" cy="36.82" r="1.15" opacity="0.34"/>
      <circle cx="8.3" cy="47.74" r="1.15" opacity="0.34"/>
      <circle cx="20.9" cy="47.74" r="1.15" opacity="0.34"/>
      <circle cx="33.5" cy="47.74" r="4.9" opacity="1"/>
      <circle cx="46.1" cy="47.74" r="4.9" opacity="1"/>
      <circle cx="58.7" cy="47.74" r="4.9" opacity="1"/>
      <circle cx="71.3" cy="47.74" r="2.1" opacity="1"/>
      <circle cx="83.9" cy="47.74" r="1.15" opacity="0.34"/>
      <circle cx="96.5" cy="47.74" r="0.7" opacity="0.34"/>
      <circle cx="2.0" cy="58.65" r="0.7" opacity="0.34"/>
      <circle cx="14.6" cy="58.65" r="1.15" opacity="0.34"/>
      <circle cx="27.2" cy="58.65" r="2.1" opacity="1"/>
      <circle cx="39.8" cy="58.65" r="4.9" opacity="1"/>
      <circle cx="52.4" cy="58.65" r="4.9" opacity="1"/>
      <circle cx="65.0" cy="58.65" r="4.9" opacity="1"/>
      <circle cx="77.6" cy="58.65" r="1.15" opacity="0.34"/>
      <circle cx="90.2" cy="58.65" r="1.15" opacity="0.34"/>
      <circle cx="8.3" cy="69.56" r="1.15" opacity="0.34"/>
      <circle cx="20.9" cy="69.56" r="2.1" opacity="1"/>
      <circle cx="33.5" cy="69.56" r="4.9" opacity="1"/>
      <circle cx="46.1" cy="69.56" r="4.9" opacity="1"/>
      <circle cx="58.7" cy="69.56" r="4.9" opacity="1"/>
      <circle cx="71.3" cy="69.56" r="4.9" opacity="1"/>
      <circle cx="83.9" cy="69.56" r="1.15" opacity="0.34"/>
      <circle cx="96.5" cy="69.56" r="1.15" opacity="0.34"/>
      <circle cx="2.0" cy="80.47" r="1.15" opacity="0.34"/>
      <circle cx="14.6" cy="80.47" r="2.1" opacity="1"/>
      <circle cx="27.2" cy="80.47" r="4.9" opacity="1"/>
      <circle cx="39.8" cy="80.47" r="4.9" opacity="1"/>
      <circle cx="52.4" cy="80.47" r="4.9" opacity="1"/>
      <circle cx="65.0" cy="80.47" r="4.9" opacity="1"/>
      <circle cx="77.6" cy="80.47" r="4.9" opacity="1"/>
      <circle cx="90.2" cy="80.47" r="2.1" opacity="1"/>
      <circle cx="8.3" cy="91.38" r="1.15" opacity="0.34"/>
      <circle cx="20.9" cy="91.38" r="2.1" opacity="1"/>
      <circle cx="33.5" cy="91.38" r="2.1" opacity="1"/>
      <circle cx="46.1" cy="91.38" r="2.1" opacity="1"/>
      <circle cx="58.7" cy="91.38" r="2.1" opacity="1"/>
      <circle cx="71.3" cy="91.38" r="2.1" opacity="1"/>
      <circle cx="83.9" cy="91.38" r="2.1" opacity="1"/>
      <circle cx="96.5" cy="91.38" r="1.15" opacity="0.34"/>
      <circle cx="32.5" cy="21.5" r="6.3" opacity="1"/>
      <circle cx="50.0" cy="21.5" r="6.3" opacity="1"/>
      <circle cx="67.5" cy="21.5" r="6.3" opacity="1"/>
    </g>
  </g>
</svg>
`

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

// electron-builder wants an .icns for the mac target. Build the iconset from
// the one captured image and let iconutil pack it. macOS only: iconutil ships
// with the OS and has no cross-platform equivalent here, so on any other host
// the existing icns is left untouched and we say so rather than pretending.
function icnsFromImage(image, dir) {
  if (os.platform() !== 'darwin') {
    console.log('SKIP: icon.icns needs macOS iconutil; icns left as it was')
    return false
  }
  const iset = path.join(dir, 'icon.iconset')
  fs.rmSync(iset, { recursive: true, force: true })
  fs.mkdirSync(iset, { recursive: true })
  for (const pt of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = pt * scale
      const name = `icon_${pt}x${pt}${scale === 2 ? '@2x' : ''}.png`
      const resized = image.resize({ width: px, height: px, quality: 'best' })
      fs.writeFileSync(path.join(iset, name), resized.toPNG())
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iset, '-o', path.join(dir, 'icon.icns')])
  fs.rmSync(iset, { recursive: true, force: true })
  return true
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
      let icns = 0
      try {
        if (icnsFromImage(image, dir)) icns = fs.statSync(path.join(dir, 'icon.icns')).size
      } catch (err) {
        console.log(`FAIL: icns not written: ${err.message}`)
      }
      console.log(
        `icon written: png=${png.length}B ico=${ico.length}B icns=${icns || 'unchanged'} at ${dir}`
      )
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
