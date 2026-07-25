import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// nodechess seed: desktop build.
//
// Separate from electron.vite.config.ts (the full app) because it shares
// nothing with it: no preload bridge, no IPC, no engines, no datasets. The
// renderer here is src/seed, the same source the browser build at
// seed.nodechess.com serves, so both platforms run identical code.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'out-seed/main'),
      rollupOptions: { input: { index: resolve(__dirname, 'src/seed/electron-main.ts') } },
    },
  },
  // No preload: the seed page is plain web code with no privileged surface.
  renderer: {
    root: resolve(__dirname, 'src/seed'),
    build: {
      outDir: resolve(__dirname, 'out-seed/seed'),
      rollupOptions: { input: { index: resolve(__dirname, 'src/seed/index.html') } },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react()],
  },
})
