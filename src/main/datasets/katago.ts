import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { datasetsDir } from './paths'
import { downloadVerified, type DownloadSpec } from './datasets.service'

// Dataset group 'katago' — everything the Go bot needs (docs/GAMES-PLATFORM-SPEC.md
// §Engines; verification: scripts/verify-katago.mjs):
//   - the KataGo 1.16.5 engine, per-platform, spawned over GTP;
//   - neural nets, platform-independent .bin.gz files KataGo loads directly.
//
// Unlike stockfish/lc0, KataGo is NOT a single self-contained file on either
// platform (mac: Metal-backend binary + ~84 relocated Homebrew dylibs, all load
// paths rewritten to @executable_path and ad-hoc re-signed; win: katago.exe +
// its MSVC/libzip/OpenSSL DLLs), so the binary ships as ONE archive per
// platform and the importer extracts it with the OS's own bsdtar — /usr/bin/tar
// on macOS, %SystemRoot%\System32\tar.exe on Windows 10+ (reads .zip too).
// Both archives also carry default_gtp.cfg, the config the GTP spawn uses.
//
// Layout on disk (per-user, writable — same root as the other datasets):
//   <userData>/datasets/katago/katago[.exe]     (+ dylibs/DLLs + default_gtp.cfg)
//   <userData>/datasets/katago/nets/<asset>.bin.gz
//
// Nets (all mirrored on our datasets release; verified 2026-07-06 by download
// + sha256 against the originals):
//   - kata-b6c96.bin.gz / kata-b10c128.bin.gz — g170 run, CC0 public domain
//     (https://katagoarchive.org/g170/LICENSE.txt). Small + fast on CPU/Metal;
//     these power the ordinary strength levels.
//   - kata-b18-humanv0.bin.gz — the Human-SL b18 net from the KataGo v1.15.0
//     release (b18c384nbt-humanv0.bin.gz), the flagship human-like levels.
//     94.5 MB, so it is a separate, optional item (`includeHuman`).

const RELEASE_BASE =
  'https://github.com/isaacmiller123/nodechess/releases/download/datasets-v1'

export const KATAGO_VERSION = '1.16.5'

interface KatagoBinaryArtifact {
  /** Archive asset name in the project's datasets GitHub release. */
  asset: string
  bytes: number
  sha256: string
}

// KataGo 1.16.5 archives, keyed by `${process.platform}-${process.arch}` like
// ENGINE_ARTIFACTS. mac: relocatable Homebrew-derived bundle (Metal backend).
// win: the official eigen (pure CPU) release zip, unmodified.
const KATAGO_BINARIES: Record<string, KatagoBinaryArtifact> = {
  'darwin-arm64': {
    asset: 'katago-mac-arm64.tgz',
    bytes: 4451080,
    sha256: 'bd6cf118f55654936143aee0656105a40b3263bb4ca3f9c1f58d1a820bb1463b'
  },
  'win32-x64': {
    asset: 'katago-win-x64.zip',
    bytes: 4773666,
    sha256: '02c0dd2417939bf891988f7106e4776e513c2a198e2338bd42aa826def67669b'
  }
}

export type KatagoNetId = 'b6c96' | 'b10c128' | 'b18-human'

interface KatagoNetArtifact {
  id: KatagoNetId
  /** Asset name in the datasets release AND the on-disk filename. */
  asset: string
  bytes: number
  sha256: string
  /** Upstream source (fallback when the mirror is unreachable). */
  upstream: string
  /** Large optional nets are only fetched when explicitly requested. */
  optional?: boolean
}

export const KATAGO_NETS: KatagoNetArtifact[] = [
  {
    id: 'b6c96',
    asset: 'kata-b6c96.bin.gz',
    bytes: 3827339,
    sha256: 'f57fddf4672364d385d6ab177364ab819810d1123e229cb2649c4f337a2160b1',
    upstream: 'https://katagoarchive.org/g170/neuralnets/g170-b6c96-s175395328-d26788732.bin.gz'
  },
  {
    id: 'b10c128',
    asset: 'kata-b10c128.bin.gz',
    bytes: 11138361,
    sha256: '1a8e05a4ea3fca20dab79410cbb566c760767fcdd2fa0b701cfe259a84cc8b04',
    upstream:
      'https://katagoarchive.org/g170/neuralnets/g170e-b10c128-s1141046784-d204142634.bin.gz'
  },
  {
    id: 'b18-human',
    asset: 'kata-b18-humanv0.bin.gz',
    bytes: 99066230,
    sha256: '637746e44f0efe00ad1245a50aa9bbf0716efe364c43965ead97bd6835d84ab5',
    upstream:
      'https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz',
    optional: true
  }
]

// ---- Paths ------------------------------------------------------------------

export function katagoDir(): string {
  return path.join(datasetsDir(), 'katago')
}

export function katagoNetsDir(): string {
  return path.join(katagoDir(), 'nets')
}

export function katagoBinaryName(): string {
  return process.platform === 'win32' ? 'katago.exe' : 'katago'
}

export function importedKatagoPath(): string {
  return path.join(katagoDir(), katagoBinaryName())
}

/** The GTP config the archives ship next to the binary. */
export function katagoConfigPath(): string {
  return path.join(katagoDir(), 'default_gtp.cfg')
}

export function katagoNetPath(id: KatagoNetId): string {
  const net = KATAGO_NETS.find((n) => n.id === id)
  if (!net) throw new Error(`katago: unknown net '${id}'`)
  return path.join(katagoNetsDir(), net.asset)
}

/** The KataGo binary to launch: the imported one, with a dev-only fallback to a
 *  Homebrew install so Go bots are testable on this mac before an import runs.
 *  Packaged builds only ever use the imported binary. */
export function resolveKatagoPath(): string {
  const imported = importedKatagoPath()
  if (fs.existsSync(imported)) return imported
  if (!app.isPackaged && process.platform === 'darwin') {
    const brew = '/opt/homebrew/bin/katago'
    if (fs.existsSync(brew)) return brew
  }
  return imported
}

/** The GTP config to launch with: the imported default_gtp.cfg, with a dev-only
 *  Homebrew fallback matching resolveKatagoPath's binary fallback. */
export function resolveKatagoConfigPath(): string {
  const imported = katagoConfigPath()
  if (fs.existsSync(imported)) return imported
  if (!app.isPackaged && process.platform === 'darwin') {
    const brew = '/opt/homebrew/share/katago/configs/gtp_example.cfg'
    if (fs.existsSync(brew)) return brew
  }
  return imported
}

export function katagoInstalled(): boolean {
  return fs.existsSync(resolveKatagoPath())
}

export function katagoNetInstalled(id: KatagoNetId): boolean {
  return fs.existsSync(katagoNetPath(id))
}

/** True when a Go bot can actually play: engine + at least one non-human net. */
export function katagoAvailable(): boolean {
  return katagoInstalled() && (katagoNetInstalled('b6c96') || katagoNetInstalled('b10c128'))
}

/** True when the WHOLE standard group is present (the Settings row's
 *  "Installed"): engine + both standard nets. The Human-SL net is opt-in and
 *  never gates this. */
export function katagoGroupInstalled(): boolean {
  return katagoInstalled() && KATAGO_NETS.filter((n) => !n.optional).every((n) => katagoNetInstalled(n.id))
}

/** Full download size of the standard group on this platform (archive + nets). */
export function katagoGroupBytes(): number {
  const bin = KATAGO_BINARIES[`${process.platform}-${process.arch}`]
  return (
    (bin?.bytes ?? 0) +
    KATAGO_NETS.filter((n) => !n.optional).reduce((sum, n) => sum + n.bytes, 0)
  )
}

/** Download size of the optional Human-SL net (the opt-in checkbox). */
export function katagoHumanNetBytes(): number {
  return KATAGO_NETS.find((n) => n.id === 'b18-human')?.bytes ?? 0
}

// ---- Import -------------------------------------------------------------------

export interface KatagoImportProgress {
  label: string
  received: number
  total: number
  itemIndex: number
  itemCount: number
}

/** Extract an archive with the OS's own bsdtar (handles .tgz and .zip on both
 *  macOS and Windows 10+), then delete it. Throws on a non-zero exit. */
async function extractArchive(archive: string, into: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', into], { stdio: 'ignore' })
    child.on('error', (err) => reject(new Error(`katago: tar failed to start: ${err.message}`)))
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`katago: extraction failed (tar exit ${code})`))
    )
  })
  fs.rmSync(archive, { force: true })
  // bsdtar preserves modes from the tgz, but be explicit: the engine must be
  // spawnable on macOS/Linux (Windows ignores file modes).
  if (process.platform !== 'win32' && fs.existsSync(importedKatagoPath())) {
    fs.chmodSync(importedKatagoPath(), 0o755)
  }
}

interface KatagoItem extends DownloadSpec {
  dest: string
  fallbackUrl?: string
  archive?: boolean
}

/** Everything still missing for this platform, as concrete download specs. */
function missingItems(includeHuman: boolean): KatagoItem[] {
  const items: KatagoItem[] = []
  const bin = KATAGO_BINARIES[`${process.platform}-${process.arch}`]
  if (bin && !fs.existsSync(importedKatagoPath())) {
    items.push({
      label: `KataGo ${KATAGO_VERSION} engine`,
      url: `${RELEASE_BASE}/${bin.asset}`,
      bytes: bin.bytes,
      sha256: bin.sha256,
      dest: path.join(katagoDir(), bin.asset),
      archive: true
    })
  }
  for (const net of KATAGO_NETS) {
    if (net.optional && !includeHuman) continue
    if (!katagoNetInstalled(net.id)) {
      items.push({
        label: `KataGo net ${net.id}`,
        // Mirror-first (our datasets release), upstream as fallback —
        // identical bytes, one sha256 verifies either source.
        url: `${RELEASE_BASE}/${net.asset}`,
        fallbackUrl: net.upstream,
        bytes: net.bytes,
        sha256: net.sha256,
        dest: path.join(katagoNetsDir(), net.asset)
      })
    }
  }
  return items
}

/**
 * Download whatever is missing from the katago group (idempotent; retries
 * resume remaining items). Reuses the verified-streaming download from
 * datasets.service, including its cancellation flag. Pass `includeHuman` to
 * also fetch the 94.5 MB Human-SL net (the human-like flagship levels).
 * Surfaced via datasets:import (runImport orchestrates all groups) + the
 * Settings UI row with its opt-in Human-SL checkbox.
 */
export async function importKatago(
  onProgress: (p: KatagoImportProgress) => void,
  opts: { includeHuman?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  try {
    const items = missingItems(opts.includeHuman ?? false)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const report = (received: number, total: number): void =>
        onProgress({ label: it.label, received, total, itemIndex: i, itemCount: items.length })
      try {
        await downloadVerified(it, it.dest, report)
      } catch (err) {
        const cancelled = err instanceof Error && err.message === 'cancelled'
        if (!it.fallbackUrl || cancelled) throw err
        await downloadVerified({ ...it, url: it.fallbackUrl }, it.dest, report)
      }
      if (it.archive) await extractArchive(it.dest, katagoDir())
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
