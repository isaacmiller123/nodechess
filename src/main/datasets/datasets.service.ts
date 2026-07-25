import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DatasetItemMeta, DatasetProgress, DatasetStatus } from '../../shared/types'
import {
  datasetsDir,
  importedEnginePath,
  importedPuzzlesPath,
  engineInstalled,
  puzzlesInstalled
} from './paths'
// Group importers (circular-safe: both sides only reference each other inside
// functions — maia/katago/fairy pull downloadVerified from this module).
import { importMaia, maiaGroupBytes, maiaGroupInstalled } from './maia'
import {
  importKatago,
  katagoGroupBytes,
  katagoGroupInstalled,
  katagoHumanNetBytes,
  katagoNetInstalled
} from './katago'
import { fairyImportNeeded, importFairyStockfish } from './fairyStockfish'

// Runtime dataset importer. Downloads the heavy, redistributable datasets that
// are kept out of the repo/installer, straight from the project's public GitHub
// release, into the writable per-user datasets folder. Streamed + verified, so a
// half-finished download never corrupts an install (write to *.part, then rename).

const RELEASE_BASE =
  'https://github.com/isaacmiller123/nodechess/releases/download/datasets-v1'

export interface DatasetItem {
  key: 'engine' | 'puzzles'
  label: string
  url: string
  /** Size of the downloaded artifact (compressed, for the .zst). */
  bytes: number
  /** sha256 of the downloaded artifact (compressed bytes for the .zst). */
  sha256: string
  /** Transparent decompression applied while writing to disk. */
  compressed?: 'zstd'
  /** Final on-disk size after decompression (for display). */
  installedBytes: number
}

interface EngineArtifact {
  /** Asset name in the GitHub release (raw, self-contained Stockfish binary). */
  asset: string
  bytes: number
  sha256: string
}

// Stockfish 18 binaries, keyed by `${process.platform}-${process.arch}`. Each is
// the raw, self-contained engine with the NNUE net embedded (same provenance as
// the official Stockfish sf_18 release), hosted on the project's datasets release.
// Adding a platform = add one verified row here; nothing else changes.
const ENGINE_ARTIFACTS: Record<string, EngineArtifact> = {
  'win32-x64': {
    asset: 'stockfish-sf18-win-x64.exe',
    bytes: 114007552,
    sha256: 'c86215fa1977d53b82ed854540a4c7b025be4cd042276c85ba3de53fb9118911'
  },
  'darwin-arm64': {
    asset: 'stockfish-sf18-mac-arm64',
    bytes: 113853992,
    sha256: 'bc0cac905ecdf2147fe22055c733bcd999b1e3f7c399fbaf7fb9055786563590'
  }
}

/** The `${platform}-${arch}` key used to look up the engine artifact. */
export function engineArtifactKey(): string {
  return `${process.platform}-${process.arch}`
}

function engineItem(): DatasetItem | null {
  const a = ENGINE_ARTIFACTS[engineArtifactKey()]
  if (!a) return null
  return {
    key: 'engine',
    label: 'Stockfish 18 engine',
    url: `${RELEASE_BASE}/${a.asset}`,
    bytes: a.bytes,
    sha256: a.sha256,
    installedBytes: a.bytes
  }
}

const PUZZLES_ITEM: DatasetItem = {
  key: 'puzzles',
  label: 'Lichess puzzle database',
  url: `${RELEASE_BASE}/puzzles.sqlite.zst`,
  bytes: 705175215,
  sha256: 'ecc7719bad6fe9edc45cd8d28acc0bf2549a98783f6b3901fa373e8b45bef4b4',
  compressed: 'zstd',
  installedBytes: 2148864000
}

// The puzzle DB is a plain SQLite file — identical on every OS. The engine is
// per-platform; on a platform with no published binary the engine row is simply
// absent (a bundled engine, if any, still resolves) and only puzzles import.
export const DATASET_ITEMS: DatasetItem[] = [engineItem(), PUZZLES_ITEM].filter(
  (x): x is DatasetItem => x !== null
)

export type { DatasetItemMeta, DatasetProgress, DatasetStatus }

export function datasetStatus(): DatasetStatus {
  const engine = engineInstalled()
  const puzzles = puzzlesInstalled()
  const maia = maiaGroupInstalled()
  const katago = katagoGroupInstalled()
  return {
    engine,
    puzzles,
    maia,
    katago,
    katagoHuman: katagoNetInstalled('b18-human'),
    // The optional Human-SL net never gates completeness.
    complete: engine && puzzles && maia && katago
  }
}

/** The Settings → Datasets rows: one meta per importable group, with the
 *  Human-SL go net surfaced as the katago row's opt-in extra. */
export function datasetItems(): DatasetItemMeta[] {
  const items: DatasetItemMeta[] = DATASET_ITEMS.map((it) => ({
    key: it.key,
    label: it.label,
    bytes: it.bytes,
    installedBytes: it.installedBytes
  }))
  const maiaBytes = maiaGroupBytes()
  if (maiaBytes > 0) {
    items.push({
      key: 'maia',
      label: 'Maia human-style chess (lc0 + 5 nets)',
      bytes: maiaBytes,
      installedBytes: maiaBytes
    })
  }
  const katagoBytes = katagoGroupBytes()
  if (katagoBytes > 0) {
    items.push({
      key: 'katago',
      label: 'KataGo Go engine (2 nets)',
      bytes: katagoBytes,
      installedBytes: katagoBytes,
      optIn: {
        label: 'Human-style Go net',
        bytes: katagoHumanNetBytes(),
        installed: katagoNetInstalled('b18-human')
      }
    })
  }
  return items
}

export type ProgressFn = (p: DatasetProgress) => void

let importing = false
let cancelFlag = false

function destFor(key: 'engine' | 'puzzles'): string {
  return key === 'engine' ? importedEnginePath() : importedPuzzlesPath()
}

/** What downloadVerified needs to know about one artifact. Shared by the
 *  stockfish/puzzles items above and the maia group (see ./maia.ts). */
export interface DownloadSpec {
  label: string
  url: string
  /** Expected compressed size (progress fallback when content-length is absent). */
  bytes: number
  /** sha256 of the downloaded (compressed) bytes; '' skips verification (TODO rows). */
  sha256: string
  compressed?: 'zstd'
  /** chmod 0o755 after publish (engine binaries on macOS/Linux). */
  executable?: boolean
}

/** Abort a download if NO bytes arrive for this long — a stalled connection
 *  (dead wifi, half-open socket) must fail with a clear error instead of
 *  hanging the import forever with no way to make progress. */
const STALL_TIMEOUT_MS = 30_000

/**
 * Stream one artifact to `dest`: write to *.part, hash + meter the compressed
 * bytes (cancellation point), verify sha256, then atomically rename into place.
 * Exported so other dataset groups (maia) reuse the exact same discipline.
 *
 * A 1s watchdog guards the whole transfer: it aborts the fetch when no bytes
 * have arrived for STALL_TIMEOUT_MS (surfaced as a clear retryable error), and
 * it also honors cancelImport() while the stream is stalled — previously a
 * cancel was only observed on the NEXT chunk, which never came.
 */
export async function downloadVerified(
  spec: DownloadSpec,
  dest: string,
  onChunk: (received: number, total: number) => void
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })

  const ac = new AbortController()
  let lastByteAt = Date.now()
  let stalled = false
  const watchdog = setInterval(() => {
    if (cancelFlag) {
      ac.abort()
      return
    }
    if (Date.now() - lastByteAt > STALL_TIMEOUT_MS) {
      stalled = true
      ac.abort()
    }
  }, 1000)

  try {
    const res = await fetch(spec.url, { redirect: 'follow', signal: ac.signal })
    if (!res.ok || !res.body) throw new Error(`${spec.label}: download failed (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || spec.bytes

    let received = 0
    const hash = crypto.createHash('sha256')
    // Meter sits on the COMPRESSED byte stream: hashes the artifact, reports
    // download progress, feeds the stall watchdog, and is the cancellation point.
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        if (cancelFlag) return cb(new Error('cancelled'))
        lastByteAt = Date.now()
        received += chunk.length
        hash.update(chunk)
        onChunk(received, total)
        cb(null, chunk)
      }
    })

    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    const out = fs.createWriteStream(tmp)
    try {
      if (spec.compressed === 'zstd') {
        await pipeline(source, meter, zlib.createZstdDecompress(), out)
      } else {
        await pipeline(source, meter, out)
      }
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      throw err
    }

    const digest = hash.digest('hex')
    if (spec.sha256 && digest !== spec.sha256) {
      fs.rmSync(tmp, { force: true })
      throw new Error(`${spec.label}: checksum mismatch (download corrupted, please retry)`)
    }

    // Atomic publish: only a fully-downloaded, verified file ever appears at dest.
    fs.rmSync(dest, { force: true })
    fs.renameSync(tmp, dest)

    // A freshly downloaded engine binary needs the executable bit on macOS/Linux
    // (Windows ignores file modes). Without this, spawning it fails with EACCES.
    if (spec.executable && process.platform !== 'win32') {
      fs.chmodSync(dest, 0o755)
    }
  } catch (err) {
    // Map watchdog aborts to clear outcomes: the abort reason surfaces as an
    // opaque AbortError/ERR_STREAM_PREMATURE_CLOSE from fetch/pipeline.
    if (stalled) {
      throw new Error(
        `${spec.label}: download stalled — no data received for ${Math.round(STALL_TIMEOUT_MS / 1000)}s. Check your connection and retry.`
      )
    }
    if (cancelFlag) throw new Error('cancelled')
    throw err
  } finally {
    clearInterval(watchdog)
  }
}

async function downloadItem(
  it: DatasetItem,
  itemIndex: number,
  itemCount: number,
  onProgress: ProgressFn
): Promise<void> {
  const dest = destFor(it.key)
  await downloadVerified(
    { ...it, executable: it.key === 'engine' },
    dest,
    (received, total) =>
      onProgress({ key: it.key, phase: 'download', received, total, itemIndex, itemCount })
  )
  onProgress({ key: it.key, phase: 'verify', received: it.bytes, total: it.bytes, itemIndex, itemCount })
}

export interface RunImportOptions {
  /** Also fetch the optional 94.5 MB Human-SL go net (the katago opt-in). */
  includeHuman?: boolean
}

export async function runImport(
  onProgress: ProgressFn,
  opts: RunImportOptions = {}
): Promise<{ ok: boolean; status: DatasetStatus; error?: string }> {
  if (importing) throw new Error('datasets: an import is already running')
  importing = true
  cancelFlag = false
  const assertNotCancelled = (): void => {
    if (cancelFlag) throw new Error('cancelled')
  }
  try {
    fs.mkdirSync(datasetsDir(), { recursive: true })
    // Only fetch what's missing, so a retry resumes the remaining items.
    const items = DATASET_ITEMS.filter((it) =>
      it.key === 'engine' ? !engineInstalled() : !puzzlesInstalled()
    )
    for (let i = 0; i < items.length; i++) {
      assertNotCancelled()
      await downloadItem(items[i], i, items.length, onProgress)
    }
    // Fairy-Stockfish rides the 'engine' key: a runtime import on platforms
    // where it isn't bundled (win-x64), a no-op elsewhere.
    assertNotCancelled()
    if (fairyImportNeeded()) {
      const r = await importFairyStockfish(({ label, received, total }) =>
        onProgress({
          key: 'engine',
          phase: 'download',
          received,
          total,
          itemIndex: 0,
          itemCount: 1,
          message: label
        })
      )
      if (!r.ok) throw new Error(r.error ?? 'Fairy-Stockfish import failed')
    }
    // Group importers reuse downloadVerified (same cancel flag); their per-item
    // progress maps onto the group's row key with the item name as `message`.
    assertNotCancelled()
    if (!maiaGroupInstalled()) {
      const r = await importMaia((p) =>
        onProgress({
          key: 'maia',
          phase: 'download',
          received: p.received,
          total: p.total,
          itemIndex: p.itemIndex,
          itemCount: p.itemCount,
          message: p.label
        })
      )
      if (!r.ok) throw new Error(r.error ?? 'maia import failed')
    }
    assertNotCancelled()
    const wantHuman = opts.includeHuman === true
    if (!katagoGroupInstalled() || (wantHuman && !katagoNetInstalled('b18-human'))) {
      const r = await importKatago(
        (p) =>
          onProgress({
            key: 'katago',
            phase: 'download',
            received: p.received,
            total: p.total,
            itemIndex: p.itemIndex,
            itemCount: p.itemCount,
            message: p.label
          }),
        { includeHuman: wantHuman }
      )
      if (!r.ok) throw new Error(r.error ?? 'katago import failed')
    }
    onProgress({
      key: 'all',
      phase: 'done',
      received: 0,
      total: 0,
      itemIndex: items.length,
      itemCount: items.length
    })
    return { ok: true, status: datasetStatus() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const cancelled = cancelFlag || message === 'cancelled'
    onProgress({
      key: 'all',
      phase: cancelled ? 'cancelled' : 'error',
      received: 0,
      total: 0,
      itemIndex: 0,
      itemCount: 0,
      message
    })
    return { ok: false, status: datasetStatus(), error: cancelled ? 'cancelled' : message }
  } finally {
    importing = false
  }
}

export function cancelImport(): void {
  cancelFlag = true
}
