// Settings → Datasets. Imports the large redistributable datasets (Stockfish
// engine, Lichess puzzle DB, Maia human-style chess nets, the KataGo Go
// engine) from the project's public GitHub release into the per-user datasets
// folder, with live progress. The KataGo row carries an opt-in for the 94 MB
// Human-SL net (human-like go bot levels). Kept out of the repo/installer so
// distribution stays lean.
//
// design-lab/v1 never drew this: a static page has nothing to fetch. So it is
// built out of the same .set-row / .chip / .set-track vocabulary as the four
// sections above it, and it states what is on this machine rather than what a
// mock imagined. Every label, size and installed flag comes from main.

import { Fragment, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { isWebBuild } from '../../platform'
import type {
  DatasetImportResult,
  DatasetItemMeta,
  DatasetProgress,
  DatasetStatus
} from '@shared/types'
import { Sec, SetMeter, SetRow } from './controls'

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export default function DatasetsPanel({
  /** A finished import changes what the rest of Settings can claim, so the
   *  parent gets told rather than re-probing on a timer. */
  onInstalled
}: {
  onInstalled?: () => void
} = {}): JSX.Element {
  const api = typeof window !== 'undefined' ? window.api?.datasets : undefined

  const [status, setStatus] = useState<DatasetStatus | null>(null)
  const [items, setItems] = useState<DatasetItemMeta[]>([])
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<DatasetProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // Opt-in extras (today: the katago row's Human-SL net).
  const [includeHuman, setIncludeHuman] = useState(false)

  const refresh = useCallback(() => {
    api
      ?.status()
      .then(setStatus)
      .catch(() => undefined)
  }, [api])

  useEffect(() => {
    if (!api) return
    refresh()
    api
      .items()
      .then((r) => setItems(r.items))
      .catch(() => undefined)
    const off = api.onProgress((p) => setProgress(p))
    return off
  }, [api, refresh])

  const onImport = useCallback(() => {
    if (!api) return
    setImporting(true)
    setError(null)
    setDone(false)
    setProgress(null)
    api
      .import({ includeHuman })
      .then((res: DatasetImportResult) => {
        setStatus(res.status)
        if (res.ok) {
          setDone(true)
          onInstalled?.()
        } else if (res.error && res.error !== 'cancelled') setError(res.error)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setImporting(false)
        setProgress(null)
        refresh()
      })
  }, [api, refresh, includeHuman, onInstalled])

  const onCancel = useCallback(() => {
    api?.cancel().catch(() => undefined)
  }, [api])

  // Keep the latest item label for the progress line without re-subscribing.
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Web build: assets are served by the site itself, so there is no import
  // flow, so the whole section reduces to one honest line (all hooks are
  // above; safe).
  if (isWebBuild) {
    return (
      <Sec label="Datasets">
        <div className="panel">
          <div className="empty">
            <span className="empty-line">Nothing to download.</span>
            <span className="empty-line">Everything is delivered with the app.</span>
          </div>
        </div>
      </Sec>
    )
  }

  if (!api) {
    return (
      <Sec label="Datasets">
        <div className="panel">
          <div className="empty">
            <span className="empty-line">Dataset management is available in the desktop app.</span>
            <span className="empty-line">
              Open Settings there to fetch the engine and the puzzle database.
            </span>
          </div>
        </div>
      </Sec>
    )
  }

  const installedCount = items.filter((it) => (status ? status[it.key] : false)).length
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : 0
  const activeItem =
    progress && progress.key !== 'all'
      ? itemsRef.current.find((i) => i.key === progress.key)
      : undefined
  const phaseLabel =
    progress?.phase === 'verify' ? 'Verifying' : progress?.phase === 'download' ? 'Downloading' : ''
  const humanInstalled = status?.katagoHuman ?? false
  const allIn = !!status?.complete && !(includeHuman && !humanInstalled)

  return (
    <Sec
      label="Datasets"
      count={items.length ? `${installedCount} of ${items.length} installed` : ''}
    >
      <p className="sec-note">
        Download the engines and the puzzle database once. They work offline afterwards.
      </p>

      <div className="panel">
        {items.map((it) => {
          const installed = status ? status[it.key] : false
          const optInInstalled = it.optIn?.installed ?? humanInstalled
          return (
            <Fragment key={it.key}>
              <SetRow
                name={it.label}
                sub={`${fmtBytes(it.bytes)} download${
                  it.installedBytes !== it.bytes ? `, ${fmtBytes(it.installedBytes)} on disk` : ''
                }`}
              >
                <span className={`set-state${installed ? ' is-on' : ''}`}>
                  {installed ? 'Installed' : 'Not installed'}
                </span>
              </SetRow>

              {it.optIn && (
                <SetRow
                  name={it.optIn.label}
                  sub={`${fmtBytes(it.optIn.bytes)}. Human-like go bots.`}
                >
                  {optInInstalled ? (
                    <span className="set-state is-on">Installed</span>
                  ) : (
                    <button
                      type="button"
                      className="chip"
                      aria-pressed={includeHuman}
                      disabled={importing}
                      onClick={() => setIncludeHuman((v) => !v)}
                    >
                      Add to this import
                    </button>
                  )}
                </SetRow>
              )}
            </Fragment>
          )
        })}

        {importing && (
          <div className="set-row is-stack" role="status" aria-live="polite">
            <SetMeter
              head={
                <>
                  {phaseLabel}
                  {/* Group importers name the exact artifact (e.g. 'Maia 1500 weights'). */}
                  {progress?.message
                    ? ` ${progress.message}`
                    : activeItem
                      ? ` ${activeItem.label}`
                      : '…'}
                  {progress && progress.itemCount > 1
                    ? ` (${progress.itemIndex + 1}/${progress.itemCount})`
                    : ''}
                </>
              }
              value={
                progress && progress.total > 0
                  ? `${fmtBytes(progress.received)} / ${fmtBytes(progress.total)} · ${pct}%`
                  : 'Starting…'
              }
              pct={pct}
            />
          </div>
        )}

        {error && (
          <SetRow>
            <span className="set-state is-bad" role="alert">
              {error}
            </span>
          </SetRow>
        )}

        {done && !error && (
          <SetRow
            name="Datasets ready"
            sub="Analysis, hints, game review and the puzzle trainer are all available now."
          >
            <span className="set-state is-on" role="status">
              Done
            </span>
          </SetRow>
        )}

        <div className="panel-foot">
          {importing ? (
            <button type="button" className="btn is-quiet" onClick={onCancel}>
              Cancel
            </button>
          ) : allIn ? (
            <button type="button" className="btn is-quiet" disabled>
              All datasets installed
            </button>
          ) : (
            <button type="button" className="btn" onClick={onImport}>
              Import datasets
            </button>
          )}
        </div>
      </div>
    </Sec>
  )
}
