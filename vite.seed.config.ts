import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// nodechess seed: the standalone node runner served at seed.nodechess.com.
//
// A separate target from vite.web.config.ts on purpose: this page must stay
// tiny. It pulls in the accounts/overlay stack and nothing else: no engines, no
// board, no puzzle data. A volunteer leaving it open in a background tab costs
// them almost nothing.
//
// It needs NO cross-origin isolation headers: those exist for the app's
// SharedArrayBuffer engine workers, and a seed node runs no engine.
//
// The Electron desktop build wraps this exact bundle (see electron.seed.config.ts),
// so the browser page and the installed app are the same program.
export default defineConfig({
  root: resolve(__dirname, 'src/seed'),
  // src/seed/public carries _headers, which Cloudflare Pages reads from the
  // deploy root. Was false, which is why the seed shipped with no headers.
  publicDir: resolve(__dirname, "src/seed/public"),
  server: { port: 5200 },
  preview: { port: 5200 },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-seed'),
    emptyOutDir: true,
    target: 'es2022',
  },
  plugins: [react()],
})
