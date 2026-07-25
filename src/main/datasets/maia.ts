import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { MAIA_LEVELS, type MaiaLevel } from '../../shared/types'
import { datasetsDir } from './paths'
import { downloadVerified, type DownloadSpec } from './datasets.service'

// Dataset group 'maia' — everything the "Human" chess bot style needs:
//   - lc0 (the Leela Chess Zero engine binary), per-platform, spawned like
//     Stockfish (UCI over stdio, plus a --weights=<file> launch argument);
//   - the CSSLab maia-<elo> weight files (lc0 loads .pb.gz directly, no
//     decompression needed on our side), platform-independent, ~1.3 MB each.
//
// Layout on disk (per-user, writable — same root as the other datasets):
//   <userData>/datasets/maia/lc0[.exe]        (+ dnnl.dll on Windows)
//   <userData>/datasets/maia/weights/maia-<level>.pb.gz
//
// Weight files download straight from the CSSLab maia-chess v1.0 GitHub release
// (public, stable, verified below by sha256+size on 2026-07-06). The lc0 binary
// follows the Stockfish pattern instead: per-platform artifacts hosted on the
// project's own datasets release, because upstream ships no raw single binaries
// (win-x64 is a zip of lc0.exe+dnnl.dll; mac has no official build at all — we
// extract the Homebrew bottle, lc0 0.32.1, eigen CPU backend, fine at nodes=1).

const RELEASE_BASE =
  'https://github.com/isaacmiller123/nodechess/releases/download/datasets-v1'
const MAIA_RELEASE = 'https://github.com/CSSLab/maia-chess/releases/download/v1.0'

export { MAIA_LEVELS, type MaiaLevel }

interface MaiaWeightArtifact {
  level: MaiaLevel
  /** Asset name in BOTH releases (ours + CSSLab's) AND the on-disk filename. */
  asset: string
  bytes: number
  sha256: string
}

// All five verified 2026-07-06 against the CSSLab release (HTTP content-length
// + local sha256 of the downloaded files). The same files are mirrored
// byte-for-byte on our datasets-v1 release (re-hashed after upload), so the
// importer tries the mirror first and falls back to CSSLab upstream.
export const MAIA_WEIGHTS: MaiaWeightArtifact[] = [
  {
    level: 1100,
    asset: 'maia-1100.pb.gz',
    bytes: 1313193,
    sha256: 'e1cf1cd0c96b8a4fa6a275f4b9fd54ed1ffebf9fe44641b9fceded310e9619c4'
  },
  {
    level: 1300,
    asset: 'maia-1300.pb.gz',
    bytes: 1244431,
    sha256: '36195f87bf4761834baa0bf87472b18509a7261a9d7d6f1a8443261369a733f2'
  },
  {
    level: 1500,
    asset: 'maia-1500.pb.gz',
    bytes: 1258199,
    sha256: '35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00'
  },
  {
    level: 1700,
    asset: 'maia-1700.pb.gz',
    bytes: 1313415,
    sha256: 'd277eacd792d340a30abb464dc65127254e65cac57abca17facc469889b96478'
  },
  {
    level: 1900,
    asset: 'maia-1900.pb.gz',
    bytes: 1262607,
    sha256: 'e2f565f42d7cd9f122557e6dc4eb84e5bbaedceda1d404dc485d3611c7c97a12'
  }
]

interface Lc0File {
  /** Asset name in the project's datasets GitHub release. */
  asset: string
  /** On-disk filename inside the maia dir (dnnl.dll MUST keep its dll name). */
  file: string
  bytes: number
  sha256: string
  executable?: boolean
}

// lc0 0.32.1, keyed by `${process.platform}-${process.arch}` like ENGINE_ARTIFACTS.
// Both platforms uploaded + verified 2026-07-06 (see docs/DATASETS.md):
//   mac-arm64: the raw Mach-O from the Homebrew bottle's libexec/lc0 (0.32.1,
//     Metal/Accelerate — links only system libraries, so one file suffices).
//   win-x64: lc0.exe + dnnl.dll extracted from the official release zip
//     https://github.com/LeelaChessZero/lc0/releases/download/v0.32.1/lc0-v0.32.1-windows-cpu-dnnl.zip
//     (two raw files, keeping the one-file-per-item download pattern; no
//     archive support needed in this importer).
const LC0_ARTIFACTS: Record<string, Lc0File[]> = {
  'darwin-arm64': [
    {
      asset: 'lc0-0.32.1-mac-arm64',
      file: 'lc0',
      bytes: 1848672,
      sha256: '6a6f5e8083025c6cd194ddcfb3ead17b51347c4591cff436670ce7a3bd14f98f',
      executable: true
    }
  ],
  'win32-x64': [
    {
      asset: 'lc0-0.32.1-win-x64.exe',
      file: 'lc0.exe',
      bytes: 2196992,
      sha256: '2130a6b980c8d9543888d3d4b2e45642b550ba73b36e05ae892e9c9130afd5ed'
    },
    {
      asset: 'lc0-0.32.1-win-x64-dnnl.dll',
      file: 'dnnl.dll',
      bytes: 19601280,
      sha256: '4c642ebe5e4300fb74417d43cc57d5ef33656f7b5fc536a9655ca02f8120c930'
    }
  ]
}

// ---- Paths ------------------------------------------------------------------

export function maiaDir(): string {
  return path.join(datasetsDir(), 'maia')
}

export function maiaWeightsDir(): string {
  return path.join(maiaDir(), 'weights')
}

export function maiaWeightPath(level: MaiaLevel): string {
  return path.join(maiaWeightsDir(), `maia-${level}.pb.gz`)
}

export function lc0BinaryName(): string {
  return process.platform === 'win32' ? 'lc0.exe' : 'lc0'
}

export function importedLc0Path(): string {
  return path.join(maiaDir(), lc0BinaryName())
}

/** The lc0 binary to launch: the imported one, with a dev-only fallback to a
 *  Homebrew install so the Human style is testable on this mac before the
 *  datasets upload lands. Packaged builds only ever use the imported binary. */
export function resolveLc0Path(): string {
  const imported = importedLc0Path()
  if (fs.existsSync(imported)) return imported
  if (!app.isPackaged && process.platform === 'darwin') {
    const brew = '/opt/homebrew/bin/lc0'
    if (fs.existsSync(brew)) return brew
  }
  return imported
}

export function lc0Installed(): boolean {
  return fs.existsSync(resolveLc0Path())
}

export function maiaWeightInstalled(level: MaiaLevel): boolean {
  return fs.existsSync(maiaWeightPath(level))
}

/** True when the Human style can actually play: lc0 + at least one weight. */
export function maiaAvailable(): boolean {
  return lc0Installed() && MAIA_LEVELS.some((l) => maiaWeightInstalled(l))
}

/** True when the WHOLE group is present (the Settings row's "Installed"):
 *  lc0 + every level's weights. */
export function maiaGroupInstalled(): boolean {
  return lc0Installed() && MAIA_LEVELS.every((l) => maiaWeightInstalled(l))
}

/** Full download size of the group on this platform (lc0 + all five nets). */
export function maiaGroupBytes(): number {
  const lc0 = LC0_ARTIFACTS[`${process.platform}-${process.arch}`] ?? []
  return (
    lc0.reduce((sum, f) => sum + f.bytes, 0) + MAIA_WEIGHTS.reduce((sum, w) => sum + w.bytes, 0)
  )
}

// ---- Import -------------------------------------------------------------------

export interface MaiaImportProgress {
  label: string
  received: number
  total: number
  itemIndex: number
  itemCount: number
}

/** Everything still missing for this platform, as concrete download specs.
 *  lc0 rows without a published checksum are excluded (upload pending). */
function missingItems(): Array<DownloadSpec & { dest: string; fallbackUrl?: string }> {
  const items: Array<DownloadSpec & { dest: string; fallbackUrl?: string }> = []
  const lc0 = LC0_ARTIFACTS[`${process.platform}-${process.arch}`] ?? []
  for (const f of lc0.filter((f) => f.sha256 !== '')) {
    const dest = path.join(maiaDir(), f.file)
    if (!fs.existsSync(dest)) {
      items.push({
        label: `lc0 engine (${f.file})`,
        url: `${RELEASE_BASE}/${f.asset}`,
        bytes: f.bytes,
        sha256: f.sha256,
        executable: f.executable,
        dest
      })
    }
  }
  for (const w of MAIA_WEIGHTS) {
    if (!maiaWeightInstalled(w.level)) {
      items.push({
        label: `Maia ${w.level} weights`,
        // Mirror-first (our datasets release), CSSLab upstream as fallback —
        // identical bytes, one sha256 verifies either source.
        url: `${RELEASE_BASE}/${w.asset}`,
        fallbackUrl: `${MAIA_RELEASE}/${w.asset}`,
        bytes: w.bytes,
        sha256: w.sha256,
        dest: maiaWeightPath(w.level)
      })
    }
  }
  return items
}

/**
 * Download whatever is missing from the maia group (idempotent; retries resume
 * remaining items). Reuses the verified-streaming download from
 * datasets.service, including its cancellation flag. Surfaced via
 * datasets:import (runImport orchestrates all groups) + the Settings UI row.
 */
export async function importMaia(
  onProgress: (p: MaiaImportProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  try {
    const items = missingItems()
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const report = (received: number, total: number): void =>
        onProgress({ label: it.label, received, total, itemIndex: i, itemCount: items.length })
      try {
        await downloadVerified(it, it.dest, report)
      } catch (err) {
        // Mirror failed (offline release asset, checksum mismatch, ...): retry
        // once from upstream when the item has one. Cancellation is not retried.
        const cancelled = err instanceof Error && err.message === 'cancelled'
        if (!it.fallbackUrl || cancelled) throw err
        await downloadVerified({ ...it, url: it.fallbackUrl }, it.dest, report)
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
