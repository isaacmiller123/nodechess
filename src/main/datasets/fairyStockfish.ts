import fs from 'node:fs'
import { importedFairyEnginePath, resolveFairyEnginePath, fairyEngineInstalled } from './paths'
import { downloadVerified, type DownloadSpec } from './datasets.service'

// Dataset group 'fairy-stockfish': the variant engine behind every non-chess
// chess-family bot (games platform, docs/GAMES-PLATFORM-SPEC.md §Bots):
// xiangqi/shogi/janggi/makruk/placement + the chessops variant wave.
//
// Per-platform story (mirrors ENGINE_ARTIFACTS in datasets.service.ts; asset
// names + checksums must stay in sync with docs/DATASETS.md §Games-platform
// engines: both binaries were uploaded to the project's datasets-v1 release
// and verified 2026-07-06):
//   - win32-x64: the official fairy_sf_14 'largeboard' build (upstream's
//     compatibility recommendation; also covers 10x10+ boards for the P3
//     custom-variant editor). Mirror-first from datasets-v1, official release
//     URL as fallback. Both serve the byte-identical file.
//   - darwin-arm64: BUNDLED in resources/engine/mac/fairy-stockfish (Homebrew
//     fairy-stockfish 14.0.1 bottle, ~750 KB: small enough to ship; no
//     official mac build exists upstream). The datasets-v1 mirror row below is
//     the fallback for installs without the bundled copy. Proven against all
//     13 routed variants by scripts/probe-fairy-sf.mjs.
//
// Resolution is imported-first then bundled (datasets/paths.ts), same as
// Stockfish, so an imported binary always wins without a reinstall.

const RELEASE_BASE =
  'https://github.com/isaacmiller123/nodechess/releases/download/datasets-v1'
const FAIRY_OFFICIAL =
  'https://github.com/fairy-stockfish/Fairy-Stockfish/releases/download/fairy_sf_14'

interface FairyArtifact {
  /** Download URLs, tried in order (project mirror first, upstream fallback). */
  urls: string[]
  bytes: number
  sha256: string
}

export const FAIRY_SF_ARTIFACTS: Record<string, FairyArtifact> = {
  'win32-x64': {
    urls: [
      `${RELEASE_BASE}/fairy-stockfish-14-win-x64.exe`,
      `${FAIRY_OFFICIAL}/fairy-stockfish-largeboard_x86-64.exe`
    ],
    bytes: 1930240,
    sha256: '2fe12ff0fcad0295482cab7660e1fcc24259cebc4ef164839fb16c9f9cabfc99'
  },
  'darwin-arm64': {
    // Normally shadowed by the bundled resources/engine/mac binary (same bytes).
    urls: [`${RELEASE_BASE}/fairy-stockfish-14-mac-arm64`],
    bytes: 743240,
    sha256: 'df96025ba16b8be2c3f7ae2e867844545330915e477c512eaf4c1202918f9e87'
  }
}

export { resolveFairyEnginePath, fairyEngineInstalled }

/** True when this platform needs (and can get) a runtime download. */
export function fairyImportNeeded(): boolean {
  return !fairyEngineInstalled() && FAIRY_SF_ARTIFACTS[`${process.platform}-${process.arch}`] !== undefined
}

export interface FairyImportProgress {
  label: string
  received: number
  total: number
}

/**
 * Download the Fairy-Stockfish binary if this platform needs it (idempotent).
 * Reuses the verified-streaming download from datasets.service, including its
 * cancellation flag.
 * TODO: surfaced via the datasets UI as part of the engines row rework
 * (datasets-release quest owns DatasetStatus/ipc integration).
 */
export async function importFairyStockfish(
  onProgress: (p: FairyImportProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  if (!fairyImportNeeded()) return { ok: true }
  const a = FAIRY_SF_ARTIFACTS[`${process.platform}-${process.arch}`]
  const dest = importedFairyEnginePath()
  let lastError = 'no download source for this platform'
  for (const url of a.urls) {
    try {
      const spec: DownloadSpec = {
        label: 'Fairy-Stockfish 14 engine',
        url,
        bytes: a.bytes,
        sha256: a.sha256,
        executable: true
      }
      await downloadVerified(spec, dest, (received, total) =>
        onProgress({ label: spec.label, received, total })
      )
      if (fs.existsSync(dest)) return { ok: true }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: false, error: lastError }
}
