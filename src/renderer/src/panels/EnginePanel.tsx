import { pvToSan, turnColor } from '../chess/chess'
import { displaySan } from '../chess/notation'
import { formatScore, toWhite } from '../chess/scores'
import type { PvLine } from '../hooks/useAnalysis'
import { EngineRequiredNotice } from '../components/EngineRequiredNotice'

export interface EnginePanelProps {
  fen: string
  lines: PvLine[]
  depth: number
  enabled: boolean
  multipv: number
  figurineMode: boolean
  /** Stockfish binary not on disk (useEngineReady): show the install CTA
   *  instead of "analyzing…" at depth 0 forever. */
  engineMissing?: boolean
  /** engine:analyze rejection (useAnalysis.error). Surfaced when the engine
   *  IS installed but failed (crash/broken binary). */
  error?: string | null
  /** Deep link to Settings → Datasets for the install CTA. */
  onOpenSettings?: () => void
  onToggle: () => void
  onMultipv: (n: number) => void
  onPlayUci: (uci: string) => void
}

export function EnginePanel(props: EnginePanelProps) {
  const {
    fen,
    lines,
    depth,
    enabled,
    multipv,
    figurineMode,
    engineMissing,
    error,
    onOpenSettings,
    onToggle,
    onMultipv,
    onPlayUci
  } = props
  const stm = turnColor(fen)
  const unavailable = engineMissing || error != null

  return (
    <section className="panel engine-panel" aria-label="Engine analysis">
      <div className="panel-head">
        <span className="panel-title">Engine</span>
        <span className="muted small num">
          {enabled ? (unavailable ? 'Stockfish 18 · unavailable' : `Stockfish 18 · depth ${depth}`) : 'paused'}
        </span>
        <button
          type="button"
          className={`toggle-pill ${enabled ? 'on' : ''}`}
          aria-pressed={enabled}
          aria-label={`Engine ${enabled ? 'on' : 'off'}`}
          onClick={onToggle}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      <div className="engine-lines">
        {enabled && engineMissing && (
          <EngineRequiredNotice context="analysis" onOpenSettings={onOpenSettings} />
        )}
        {enabled && !engineMissing && error != null && (
          <div className="muted small pad" role="alert">
            Engine failed to start: {error}
          </div>
        )}
        {enabled && !unavailable && lines.length === 0 && (
          <div className="muted small pad" role="status">
            analyzing…
          </div>
        )}
        {!enabled && <div className="muted small pad">Turn on the engine to see top lines.</div>}
        {enabled &&
          lines.map((l) => {
            const score = toWhite({ cp: l.scoreCp, mate: l.mate }, stm)
            const positive = (score.mate ?? score.cp ?? 0) >= 0
            const sans = pvToSan(fen, l.pv, 10)
              .map((s) => displaySan(s, figurineMode))
              .join(' ')
            const scoreText = formatScore(score)
            return (
              <button
                key={l.multipv}
                type="button"
                className="engine-line"
                onClick={() => l.pv[0] && onPlayUci(l.pv[0])}
                title="Play this move"
                aria-label={`Line ${l.multipv}: evaluation ${scoreText} for ${positive ? 'White' : 'Black'}. Play this move.`}
              >
                <span className={`eval-chip ${positive ? 'pos' : 'neg'} num`} aria-hidden>
                  {scoreText}
                </span>
                <span className="pv num" aria-hidden>
                  {sans}
                </span>
              </button>
            )
          })}
      </div>

      <div className="engine-controls">
        <label className="ctl">
          Lines
          <input
            type="range"
            min={1}
            max={5}
            value={multipv}
            aria-label="Number of engine lines"
            aria-valuetext={`${multipv} lines`}
            onChange={(e) => onMultipv(Number(e.target.value))}
          />
          <span className="num" aria-hidden>
            {multipv}
          </span>
        </label>
      </div>
    </section>
  )
}
