import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

// Dataset resolution. The large datasets (Stockfish engine binary, Lichess puzzle
// DB) are NOT shipped in the repo or the installer. They are imported at runtime
// into a writable per-user folder. Every consumer resolves "imported first, then
// bundled" so a freshly imported dataset is picked up without a reinstall.
//
//   imported:  <userData>/datasets/...   (written by the dataset importer)
//   bundled:   <resources>/...           (only present in a "full" build)
//
// In dev, userData is redirected to <project>/.devdata (see main/index.ts), so
// imports land there and never touch the per-user app-data folder or the Desktop
// (%APPDATA% on Windows, ~/Library/Application Support on macOS).
//
// Everything below is platform-aware off a single code path (congruent, not
// forked): the engine binary is `stockfish.exe` on Windows and `stockfish`
// (no extension) on macOS/Linux, and the bundled copy lives under a per-platform
// subfolder (win | mac | linux). The puzzle DB is a plain SQLite file and is
// byte-for-byte identical on every OS.

/** Per-platform subfolder holding the bundled engine binary. */
function enginePlatformDir(): 'win' | 'mac' | 'linux' {
  switch (process.platform) {
    case 'win32':
      return 'win'
    case 'darwin':
      return 'mac'
    default:
      return 'linux'
  }
}

/** Engine binary filename: only Windows carries the `.exe` extension. */
export function engineBinaryName(): string {
  return process.platform === 'win32' ? 'stockfish.exe' : 'stockfish'
}

/** Fairy-Stockfish binary filename (games platform variant bots). */
export function fairyBinaryName(): string {
  return process.platform === 'win32' ? 'fairy-stockfish.exe' : 'fairy-stockfish'
}

export function datasetsDir(): string {
  return path.join(app.getPath('userData'), 'datasets')
}

export function importedEnginePath(): string {
  return path.join(datasetsDir(), 'engine', engineBinaryName())
}

export function importedFairyEnginePath(): string {
  return path.join(datasetsDir(), 'engine', fairyBinaryName())
}

export function importedPuzzlesPath(): string {
  return path.join(datasetsDir(), 'puzzles.sqlite')
}

function bundledEnginePath(): string {
  const rel = path.join('engine', enginePlatformDir(), engineBinaryName())
  return app.isPackaged
    ? path.join(process.resourcesPath, rel)
    : path.join(__dirname, '../../resources', rel)
}

// Fairy-Stockfish's mac build ships BUNDLED (resources/engine/mac, from the
// Homebrew fairy-stockfish 14.0.1 bottle: it's only ~750 KB); win-x64 imports
// at runtime from the official Fairy-Stockfish GitHub release (see
// datasets/fairyStockfish.ts). Resolution stays imported-first like Stockfish.
function bundledFairyEnginePath(): string {
  const rel = path.join('engine', enginePlatformDir(), fairyBinaryName())
  return app.isPackaged
    ? path.join(process.resourcesPath, rel)
    : path.join(__dirname, '../../resources', rel)
}

function bundledPuzzlesPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'data', 'puzzles.sqlite')
    : path.join(__dirname, '../../resources/data/puzzles.sqlite')
}

/** The engine binary to launch: an imported one wins over any bundled one. */
export function resolveEnginePath(): string {
  const imported = importedEnginePath()
  return fs.existsSync(imported) ? imported : bundledEnginePath()
}

/** The Fairy-Stockfish binary to launch: imported first, then bundled. */
export function resolveFairyEnginePath(): string {
  const imported = importedFairyEnginePath()
  return fs.existsSync(imported) ? imported : bundledFairyEnginePath()
}

/** The puzzle DB to open: an imported one wins over any bundled one. */
export function resolvePuzzlesPath(): string {
  const imported = importedPuzzlesPath()
  return fs.existsSync(imported) ? imported : bundledPuzzlesPath()
}

export function engineInstalled(): boolean {
  return fs.existsSync(resolveEnginePath())
}

export function fairyEngineInstalled(): boolean {
  return fs.existsSync(resolveFairyEnginePath())
}

export function puzzlesInstalled(): boolean {
  return fs.existsSync(resolvePuzzlesPath())
}
