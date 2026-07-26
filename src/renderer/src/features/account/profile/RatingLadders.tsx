// Rating display states: the ONE renderer every account surface reuses.
// Hiding is a rendering rule (C-4). Placement and provisional ladders never show
// a number, on any surface, for anyone; every client derives the same state from
// public data (the shared displayState(), never a state anyone authored).
// For OTHER accounts' ladders, pass `projection`, the shared visibility
// projection (mm/pairing visibleOpponentInfo / spectatorOpponentInfo): a
// placement/provisional viewer gets NOTHING rating-shaped ('Unranked pool'); a
// ranked viewer or spectator gets a bracket for a hidden subject and the
// revealed rating once ranked. Own surfaces omit `projection`.
//
// COPY RULE for this file: a state, or a number, and never the reason the rule
// exists. Hover text is UI too, so it follows the same rule.

import { type JSX } from 'react'
import { Ban, EyeOff, Flame, Rabbit, Turtle, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { OpponentInfo } from '@shared/accounts/mm/pairing'
import type { LadderKey, UiLadder } from '../mock/types'

/** Category icons: the same mapping the app's TimeControlPicker uses. */
export const LADDER_ICON: Record<LadderKey, LucideIcon> = {
  Bullet: Zap,
  Blitz: Flame,
  Rapid: Rabbit,
  Classical: Turtle
}

/** Visibility projection per ladder for a non-own profile (shared OpponentInfo). */
export type LadderProjection = Partial<Record<LadderKey, OpponentInfo>>

/** The ± beside a ranked rating: 2·RD, matching the app's ratingBand. Input is
 * the protocol micro-RD. */
function bandOf(rdMicro: number): number {
  const rd = Number.isFinite(rdMicro) && rdMicro > 0 ? rdMicro / 1_000_000 : 0
  return Math.round(2 * rd)
}

/** Tiny inline rating trend, oldest to newest. Decorative; the number carries. */
function Sparkline({ points }: { points: number[] }): JSX.Element | null {
  if (points.length < 2) return null
  const w = 72
  const h = 22
  const pad = 3
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(1, max - min)
  const step = (w - pad * 2) / (points.length - 1)
  const xy = points.map((p, i) => ({
    x: pad + i * step,
    y: h - pad - ((p - min) / span) * (h - pad * 2)
  }))
  const line = xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const last = xy[xy.length - 1]
  return (
    <svg className="aprof-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r="2" fill="currentColor" />
    </svg>
  )
}

/** Ban expiry, for the banned pills. A public fact, shown to everyone. */
function bannedUntilLabel(until: number): string {
  return new Date(until).toLocaleDateString()
}

/**
 * The ban expiry this cell must surface, or null when not banned. The shared
 * projection wins for other-account surfaces: visibleOpponentInfo and
 * spectatorOpponentInfo put 'banned' ahead of every rating rule, because a ban
 * is a public fact and never rating-shaped. Own surfaces read the own display
 * state.
 */
function bannedUntilOf(l: UiLadder, info: OpponentInfo | undefined): number | null {
  if (info !== undefined) return info.kind === 'banned' ? info.until : null
  return l.display.state === 'banned' ? l.display.until : null
}

/** Hover text for the compact cells (numbers only when ranked). */
function compactTitle(l: UiLadder): string {
  const d = l.display
  if (d.state === 'ranked')
    return `${l.key}: ${d.rating} ±${bandOf(l.state.rd)} over ${l.games} games`
  if (d.state === 'banned') {
    // Bans are public facts, rendered honestly to everyone.
    return `${l.key}: banned until ${bannedUntilLabel(d.until)}`
  }
  if (d.state === 'provisional') {
    return `${l.key}: rating shows at ${d.of} games (${d.n} played)`
  }
  return `${l.key}: placement, ${d.n} of ${d.of} played`
}

/** Compact hover text through the projection: never the subject's own numbers
 * when the viewer's surface may not carry them. */
function compactProjectedTitle(l: UiLadder, info: OpponentInfo): string {
  if (info.kind === 'banned') return `${l.key}: banned until ${bannedUntilLabel(info.until)}`
  if (info.kind === 'rating') return `${l.key}: ${info.rating} over ${l.games} games`
  if (info.kind === 'bracket') return `${l.key}: somewhere in ${info.lo}–${info.hi}`
  return `${l.key}: hidden until your own ${l.key} rating shows`
}

export function RatingLadders({
  ladders,
  compact,
  projection
}: {
  ladders: UiLadder[]
  compact?: boolean
  /**
   * Present when rendering ANOTHER account's ladders: the shared projection of
   * what THIS viewer may see per ladder. Absent means own ladders (own numbers
   * always render per their own display states).
   */
  projection?: LadderProjection
}): JSX.Element {
  if (compact) {
    return (
      <div className="aprof-ladders is-compact">
        {ladders.map((l) => {
          const Icon = LADDER_ICON[l.key]
          const d = l.display
          const info = projection?.[l.key]
          return (
            <span
              key={l.key}
              className="aprof-compact-cell"
              title={info === undefined ? compactTitle(l) : compactProjectedTitle(l, info)}
            >
              <Icon size={13} aria-hidden />
              {/* A4-17: the projection binds on EVERY surface, compact
                  included. A provisional viewer sees nothing rating-shaped. */}
              {info !== undefined ? (
                info.kind === 'banned' ? (
                  <span className="aprof-compact-state is-banned">Banned</span>
                ) : info.kind === 'rating' ? (
                  <span className="aprof-compact-val num">{info.rating}</span>
                ) : info.kind === 'bracket' ? (
                  <span className="aprof-compact-val num">
                    {info.lo}–{info.hi}
                  </span>
                ) : (
                  <span className="aprof-compact-state">Unranked pool</span>
                )
              ) : d.state === 'ranked' ? (
                <span className="aprof-compact-val num">
                  {d.rating}
                  <span className="aprof-compact-band num">±{bandOf(l.state.rd)}</span>
                </span>
              ) : d.state === 'banned' ? (
                <span className="aprof-compact-state is-banned">Banned</span>
              ) : d.state === 'provisional' ? (
                <span className="aprof-compact-state">Provisional</span>
              ) : (
                <span className="aprof-compact-state num">
                  Placement {d.n}/{d.of}
                </span>
              )}
            </span>
          )
        })}
      </div>
    )
  }

  return (
    <div className="aprof-ladders">
      {ladders.map((l) => {
        const Icon = LADDER_ICON[l.key]
        const d = l.display
        const info = projection?.[l.key]
        const bannedUntil = bannedUntilOf(l, info)
        return (
          <div key={l.key} className="aprof-ladder">
            <span className={`aprof-ladder-ico is-${l.key.toLowerCase()}`} aria-hidden>
              <Icon size={15} />
            </span>
            <div className="aprof-ladder-id">
              <span className="aprof-ladder-name">{l.key}</span>
              <span className="aprof-ladder-games muted small num">
                {l.games.toLocaleString()} game{l.games === 1 ? '' : 's'}
              </span>
            </div>

            {/* An ACTIVE ladder ban is a PUBLIC fact (A4-17 review gap): the
                shared projection ranks it ahead of every rating rule
                (OpponentInfo 'banned'), and it renders to EVERY viewer,
                provisional included. Never rating-shaped. */}
            {bannedUntil !== null && (
              <div className="aprof-ladder-state is-banned">
                <span className="aprof-state-pill is-banned">
                  <Ban size={11} aria-hidden /> Banned
                </span>
                <span className="aprof-banned-note muted small num">
                  until {new Date(bannedUntil).toLocaleDateString()}
                </span>
              </div>
            )}

            {/* A4-17: a placement/provisional viewer sees NOTHING rating-shaped
                about anyone. No number, no bracket, no band, no sparkline, no
                reveal progress. */}
            {info?.kind === 'unranked-pool' && (
              <div className="aprof-ladder-state is-pool">
                <span className="aprof-state-pill is-pool">
                  <EyeOff size={11} aria-hidden /> Unranked pool
                </span>
                <span className="aprof-pool-note muted small">
                  hidden until your own {l.key} rating shows
                </span>
              </div>
            )}

            {/* Ranked viewer / spectator on a hidden subject: the wide range
                ONLY, never the precise number. */}
            {info?.kind === 'bracket' && (
              <div className="aprof-ladder-state is-bracket">
                <span className="aprof-state-pill">
                  {d.state === 'provisional' ? 'Provisional' : 'Placement'}
                </span>
                <span className="aprof-bracket num" title="Their rating is somewhere in this range">
                  {info.lo}–{info.hi}
                </span>
              </div>
            )}

            {/* Revealed rating: own ranked ladder, or a ranked subject seen by
                a ranked viewer / spectator ('rating' projection). */}
            {(info === undefined || info.kind === 'rating') && d.state === 'ranked' && (
              <div className="aprof-ladder-state is-ranked">
                {l.history && l.history.length > 1 && <Sparkline points={l.history} />}
                <span className="aprof-ladder-rating num">{d.rating}</span>
                <span className="aprof-ladder-band num" title="Play more games to narrow this">
                  ±{bandOf(l.state.rd)}
                </span>
              </div>
            )}

            {info === undefined && d.state === 'provisional' && (
              <div className="aprof-ladder-state">
                <span className="aprof-state-pill">Provisional</span>
                <span className="aprof-reveal">
                  <span
                    className="aprof-reveal-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={d.of}
                    aria-valuenow={d.n}
                    aria-label={`${l.key} games toward reveal`}
                  >
                    <span
                      className="aprof-reveal-fill"
                      style={{ width: `${Math.min(100, (d.n / d.of) * 100)}%` }}
                    />
                  </span>
                  <span className="aprof-reveal-note muted small num">
                    rating shows at {d.of} games · {d.n} played
                  </span>
                </span>
              </div>
            )}

            {info === undefined && d.state === 'placement' && (
              <div className="aprof-ladder-state">
                <span className="aprof-state-pill">Placement</span>
                <span
                  className="aprof-pips"
                  role="img"
                  aria-label={`${d.n} of ${d.of} placement games played`}
                >
                  {Array.from({ length: d.of }, (_, i) => (
                    <span key={i} className={`aprof-pip${i < d.n ? ' is-filled' : ''}`} />
                  ))}
                </span>
                <span className="aprof-placement-note muted small num">
                  {d.n} of {d.of}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
