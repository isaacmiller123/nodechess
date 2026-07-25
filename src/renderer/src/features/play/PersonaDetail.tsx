// Persona detail pane — opened from the gallery. Large portrait, biography,
// playing style, honest strength stats (peak vs estimated-today), their famous
// games (each opens in Analysis via the onOpenFamousGame prop App threaded
// through PlayView), and a self-contained Challenge block (color + time +
// start). Every extended Persona field is nullable and rendered defensively.

import { ArrowLeft, Play, Swords } from 'lucide-react'
import type { FamousGameMeta, Persona } from '@shared/types'
import type { ColorChoice } from './SetupCard'
import type { TimeControl } from './timeControl'
import { TimeControlPicker } from './TimeControlPicker'
import { TIME_STYLE_COPY, timeStyleForPersona } from './botTime'
import { personaInitials } from './PersonaGallery'

export interface PersonaDetailProps {
  persona: Persona
  /** Famous-game metadata by id, for labeling the games list. May be sparse or
   *  empty (fetch failed) — rows fall back to "Famous game N". */
  famousGames: Record<string, FamousGameMeta>
  colorChoice: ColorChoice
  /** Shared Play time control (the same value the Local tab edits). */
  timeControl: TimeControl
  onColor: (c: ColorChoice) => void
  onTimeControl: (tc: TimeControl) => void
  /** Return to the gallery. */
  onBack: () => void
  /** Start the game vs this persona (PlayView's startGame). */
  onChallenge: () => void
  /** Open a famous game in Analysis. Optional — rows render inert without it. */
  onOpenFamousGame?: (famousId: string) => void
}

const RESULT_LABEL: Record<string, string> = {
  '1-0': '1–0',
  '0-1': '0–1',
  '1/2-1/2': '½–½',
  '*': 'Unfinished'
}

const DETAIL_COLORS: { key: ColorChoice; glyph: string; label: string }[] = [
  { key: 'white', glyph: '♔', label: 'White' },
  { key: 'black', glyph: '♚', label: 'Black' },
  { key: 'random', glyph: '♔♚', label: 'Random' }
]

function Meter({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="pdet-meter">
      <span className="pdet-meter-label">{label}</span>
      <span className="pdet-meter-track" aria-hidden>
        <span className="pdet-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="pdet-meter-num num">{Math.round(pct)}</span>
    </div>
  )
}

export function PersonaDetail({
  persona: p,
  famousGames,
  colorChoice,
  timeControl,
  onColor,
  onTimeControl,
  onBack,
  onChallenge,
  onOpenFamousGame
}: PersonaDetailProps) {
  // The strength the challenge is presented at: honest modern estimate when the
  // catalog has one, else the historical peak.
  const challengeElo = p.modernElo ?? p.peakElo

  // Clock personality (bot time manager): how this player spends their time.
  const clockCopy = TIME_STYLE_COPY[timeStyleForPersona(p)]

  const traits: string[] = []
  if (p.style.prefersAttack) traits.push('Attacking')
  if (p.style.prefersSolid) traits.push('Solid')
  if (p.style.risk >= 0.75) traits.push('Sacrifices freely')
  if (p.style.aggression <= 0.35) traits.push('Patient')

  const subLine = [p.country, p.years, p.era].filter(Boolean).join(' · ')

  return (
    <div className="psetup-panel pdet">
      <button type="button" className="pdet-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden />
        All grandmasters
      </button>

      <div className="pdet-hero">
        <span className="pdet-photo">
          {p.photo ? (
            <img src={p.photo} alt={p.name} />
          ) : (
            <span className="pdet-initials" aria-hidden>
              {personaInitials(p.name)}
            </span>
          )}
        </span>

        <div className="pdet-id">
          <div className="pdet-name-row">
            <h2 className="pdet-name">{p.name}</h2>
            {p.title && <span className="pdet-title">{p.title}</span>}
          </div>
          {subLine && <span className="pdet-sub muted">{subLine}</span>}

          <div className="pdet-stats">
            <div className="pdet-stat">
              <span className="pdet-stat-label">Peak rating</span>
              <span className="pdet-stat-value num">
                {p.peakElo}
                {p.peakYear != null ? ` (${p.peakYear})` : ''}
              </span>
            </div>
            {p.modernElo != null && (
              <div className="pdet-stat">
                <span className="pdet-stat-label">Estimated strength today</span>
                <span className="pdet-stat-value num">~{p.modernElo}</span>
              </div>
            )}
            <div className="pdet-stat">
              <span className="pdet-stat-label">Clock style</span>
              <span className="pdet-stat-value">{clockCopy.name}</span>
            </div>
          </div>
          {p.modernEloNote && <p className="pdet-note muted">{p.modernEloNote}</p>}
          <p className="pdet-note muted">
            {clockCopy.name} on the clock. {clockCopy.line}
          </p>

          <div className="pdet-meters">
            <Meter label="Aggression" value={p.style.aggression} />
            <Meter label="Risk" value={p.style.risk} />
          </div>
          {traits.length > 0 && (
            <div className="pdet-tags">
              {traits.map((t) => (
                <span key={t} className="pdet-tag">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {p.styleDesc && (
        <section className="pdet-section">
          <h3>How they play</h3>
          <p>{p.styleDesc}</p>
        </section>
      )}

      <section className="pdet-section">
        <h3>About</h3>
        <p>{p.bio}</p>
      </section>

      {p.famousGameIds.length > 0 && (
        <section className="pdet-section">
          <h3>Famous games</h3>
          <div className="pdet-games">
            {p.famousGameIds.map((id, i) => {
              const meta: FamousGameMeta | undefined = famousGames[id]
              const body = (
                <>
                  <span className="pdet-game-icon" aria-hidden>
                    <Play size={13} />
                  </span>
                  <span className="pdet-game-main">
                    <span className="pdet-game-title">
                      {meta ? `${meta.white} vs ${meta.black}` : `Famous game ${i + 1}`}
                      {meta && (
                        <span className="pdet-game-result num">
                          {RESULT_LABEL[meta.result] ?? meta.result}
                        </span>
                      )}
                    </span>
                    {meta && (
                      <span className="pdet-game-sub muted">
                        {meta.event} · {meta.year}
                      </span>
                    )}
                    {meta?.significance && (
                      <span className="pdet-game-sig muted">{meta.significance}</span>
                    )}
                  </span>
                  <span className="pdet-game-open">Analyze</span>
                </>
              )
              return onOpenFamousGame ? (
                <button
                  key={id}
                  type="button"
                  className="pdet-game"
                  title="Open in Analysis"
                  onClick={() => onOpenFamousGame(id)}
                >
                  {body}
                </button>
              ) : (
                <div key={id} className="pdet-game is-static">
                  {body}
                </div>
              )
            })}
          </div>
          <p className="pdet-games-hint muted">Games open on the Analysis board, move by move.</p>
        </section>
      )}

      <section className="pdet-challenge" aria-label={`Challenge ${p.name}`}>
        <div className="pdet-challenge-row">
          <div className="pdet-challenge-field">
            <span className="psetup-label">Play as</span>
            <div className="segmented pdet-seg" role="group" aria-label="Play as">
              {DETAIL_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`seg${colorChoice === c.key ? ' on' : ''}`}
                  aria-pressed={colorChoice === c.key}
                  onClick={() => onColor(c.key)}
                >
                  <span className="pdet-glyph" aria-hidden>
                    {c.glyph}
                  </span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <div className="pdet-challenge-field pdet-challenge-tc">
            <span className="psetup-label">Time control</span>
            {/* The shared picker (preset chips + Custom sliders), dense variant. */}
            <TimeControlPicker value={timeControl} onChange={onTimeControl} dense />
          </div>
        </div>

        <button type="button" className="btn pdet-go" onClick={onChallenge}>
          <Swords size={16} aria-hidden />
          Challenge {p.name}
        </button>
        <p className="pdet-go-note muted">
          Plays in {p.name}&rsquo;s style at ~{challengeElo} strength
          {p.modernElo != null ? ', the estimate against today’s field.' : '.'}
        </p>
      </section>

      {p.photoAttribution && <footer className="pdet-attrib">Photo: {p.photoAttribution}</footer>}
    </div>
  )
}
