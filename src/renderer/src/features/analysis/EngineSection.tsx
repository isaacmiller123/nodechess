import { useEffect, useState, type CSSProperties, type JSX } from 'react'
import { pvToSan } from '../../chess/chess'
import { displaySan } from '../../chess/notation'
import { formatScore, toWhite } from '../../chess/scores'
import type { Color } from '../../chess/chess'
import type { PvLine, SearchStats } from '../../hooks/useAnalysis'
import { EngineRequiredNotice } from '../../components/EngineRequiredNotice'

/** The depth caps offered, ∞ last. Infinite is `null`: no target, no denominator. */
const DEPTHS: (number | null)[] = [18, 22, 26, 30, null]

/** v1 offers three line counts. The engine accepts 1..5. */
export const LINE_COUNTS = [1, 3, 5]

export interface EngineSectionProps {
  fen: string
  turn: Color
  lines: PvLine[]
  stats: SearchStats
  enabled: boolean
  /** Selected depth cap, or null for the infinite search. */
  depthCap: number | null
  multipv: number
  showArrows: boolean
  figurine: boolean
  /** No Stockfish binary on disk (useEngineReady). */
  engineMissing: boolean
  /** engine:analyze rejected: installed, but it failed to start. */
  error: string | null
  onDepthCap: (d: number | null) => void
  onMultipv: (n: number) => void
  onToggleArrows: () => void
  onStop: () => void
  onPlayUci: (uci: string) => void
  onOpenSettings?: () => void
}

/** 18_400_000 -> "18.4M". Nodes are the one number here that runs to nine digits. */
function formatNodes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/**
 * A principal variation with its move numbers, e.g. "12. g5 Nh5 13. Nd5". The
 * numbering comes from the position the line starts in, so a line from Black's
 * turn opens "12… ".
 */
function pvText(fen: string, pv: string[], figurine: boolean): string {
  const sans = pvToSan(fen, pv, 10)
  const fields = fen.split(' ')
  let num = Number.parseInt(fields[5] ?? '1', 10) || 1
  let white = fields[1] !== 'b'
  const out: string[] = []
  sans.forEach((san, i) => {
    const text = displaySan(san, figurine)
    if (white) out.push(`${num}. ${text}`)
    else if (i === 0) out.push(`${num}… ${text}`)
    else out.push(text)
    if (!white) num += 1
    white = !white
  })
  return out.join(' ')
}

/** Which engine is actually installed. v1 wrote "Stockfish 17" into the count;
 *  the shipped binary is not that, and it is not this file's guess either. */
function useEngineName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    const api = window.api?.app
    if (!api) return
    let cancelled = false
    api
      .dataVersion()
      .then((v) => {
        if (!cancelled && v?.engineVersion) setName(v.engineVersion)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return name
}

export function EngineSection(props: EngineSectionProps): JSX.Element {
  const {
    fen,
    turn,
    lines,
    stats,
    enabled,
    depthCap,
    multipv,
    showArrows,
    figurine,
    engineMissing,
    error,
    onDepthCap,
    onMultipv,
    onToggleArrows,
    onStop,
    onPlayUci,
    onOpenSettings
  } = props

  const engineName = useEngineName()
  const unavailable = engineMissing || error != null
  // A percentage needs a target. The infinite search has none, so the hairline
  // stays a hairline rather than pretending to be 68% of the way to somewhere.
  const progress = depthCap ? Math.min(100, Math.round((stats.depth / depthCap) * 100)) : 0

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Engine</h2>
        {engineName && (
          <span className="sec-count an-clip" title={engineName}>
            {engineName}
          </span>
        )}
      </div>

      <div className="panel">
        <div className="an-readout">
          depth <b>{stats.depth}</b>
          {stats.seldepth != null && (
            <>
              /<b>{stats.seldepth}</b>
            </>
          )}
          {stats.nodes != null && (
            <>
              {'   '}
              <b>{formatNodes(stats.nodes)}</b> nodes
            </>
          )}
          {stats.nps != null && (
            <>
              {'   '}
              <b>{(stats.nps / 1_000_000).toFixed(2)}</b> Mn/s
            </>
          )}
        </div>
        <div className="an-depthbar" style={{ '--an-w': `${progress}%` } as CSSProperties} />

        <div className="an-controls">
          <span className="an-ctlgroup">
            <span className="lbl">Depth</span>
            <span className="chips">
              {DEPTHS.map((d) => (
                <button
                  className="chip"
                  type="button"
                  key={d ?? 'inf'}
                  aria-pressed={depthCap === d}
                  aria-label={d === null ? 'Search without a depth limit' : `Search to depth ${d}`}
                  onClick={() => onDepthCap(d)}
                >
                  {d === null ? '∞' : d}
                </button>
              ))}
            </span>
          </span>
          <span className="an-ctlgroup">
            <span className="lbl">Lines</span>
            <span className="chips">
              {LINE_COUNTS.map((n) => (
                <button
                  className="chip"
                  type="button"
                  key={n}
                  aria-pressed={multipv === n}
                  aria-label={`Show ${n} ${n === 1 ? 'line' : 'lines'}`}
                  onClick={() => onMultipv(n)}
                >
                  {n}
                </button>
              ))}
            </span>
          </span>
          <span className="chips">
            <button
              className="chip"
              type="button"
              aria-pressed={showArrows}
              onClick={onToggleArrows}
            >
              Arrows
            </button>
          </span>
          <button className="chip an-stop" type="button" disabled={!enabled} onClick={onStop}>
            Stop
          </button>
        </div>

        {enabled && engineMissing && (
          <div className="an-notice">
            <EngineRequiredNotice context="analysis" onOpenSettings={onOpenSettings} />
          </div>
        )}

        {enabled && !engineMissing && error != null && (
          <div className="empty" role="alert">
            <p className="empty-line">Engine failed to start: {error}</p>
            <p className="empty-line">Everything else on this page still works.</p>
          </div>
        )}

        {!enabled && (
          <div className="empty">
            <p className="empty-line">The engine is off.</p>
            <p className="empty-line">Turn Engine on under the board to see its best lines.</p>
          </div>
        )}

        {enabled && !unavailable && lines.length === 0 && (
          <div className="empty" role="status">
            <p className="empty-line">Searching this position.</p>
          </div>
        )}

        {enabled &&
          !unavailable &&
          lines.map((l) => {
            const score = toWhite({ cp: l.scoreCp, mate: l.mate }, turn)
            const scoreText = formatScore(score)
            // The swatch is the arrow's brush. Only three brushes are ranked, so
            // a fourth and fifth line share the third's pale grey, which is
            // exactly the arrow they get on the board.
            const rank = Math.min(l.multipv ?? 1, 3)
            return (
              <button
                className={`an-pv${l.multipv === 1 ? ' is-best' : ''}`}
                type="button"
                key={l.multipv}
                aria-label={`Line ${l.multipv}, evaluation ${scoreText}. Play this move.`}
                onClick={() => l.pv[0] && onPlayUci(l.pv[0])}
              >
                <span className={`an-brush is-${rank}`} aria-hidden />
                <span className="an-score">{scoreText}</span>
                <span className="an-pvline">{pvText(fen, l.pv, figurine)}</span>
              </button>
            )
          })}
      </div>
    </section>
  )
}
