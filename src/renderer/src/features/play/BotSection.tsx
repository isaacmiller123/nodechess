// PLAY → BOT, transcribed from design-lab/v1/play.html (#s-bot).
//
// v1 draws Level / Clock / Side / Help and eight two-line chips. The app has
// three different machines behind that one word, so a Style row sits above the
// level row and decides what the level row contains: eight Stockfish levels,
// the five Maia nets (once they are on disk), or a grandmaster. The rest of
// the section is v1's, row for row.
//
// The eight blurbs are v1's own copy. Below Elo 1320 Stockfish cannot be
// weakened natively and the app softens it artificially, so those three levels
// say what they actually measure at instead of leaving v1's sentence to imply
// a number the engine is not playing.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  ENGINE_ELO_FLOOR,
  MAIA_LEVELS,
  type FamousGameMeta,
  type MaiaLevel,
  type Persona
} from '@shared/types'
import { measuredElo } from '@shared/botStrength'
import { EngineRequiredNotice } from '../../components/EngineRequiredNotice'
import { useSettings } from '../../state/settings'
import { ClockChips, Segmented } from './SetupControls'
import { timeControlById, type TimeControl } from './timeControl'
import type { BotStyle, ColorChoice, StartSpec } from './setupTypes'

interface Level {
  label: string
  elo: number
  note: string
}

// v1's eight levels, with v1's eight notes.
const LEVELS: readonly Level[] = [
  { label: 'L1', elo: 800, note: 'Level 1 moves almost at random and never takes a free piece.' },
  { label: 'L2', elo: 1000, note: 'Level 2 takes what is handed to it and misses everything else.' },
  {
    label: 'L3',
    elo: 1200,
    note: 'Level 3 takes any piece you leave loose and misses tactics two moves deep.'
  },
  { label: 'L4', elo: 1400, note: 'Level 4 punishes loose pieces and finds short forks.' },
  {
    label: 'L5',
    elo: 1600,
    note: 'Level 5 defends properly and will trade you down to a lost endgame.'
  },
  { label: 'L6', elo: 1800, note: 'Level 6 plays a real opening and does not give material back.' },
  { label: 'L7', elo: 2000, note: 'Level 7 grinds. One inaccuracy is usually the whole game.' },
  { label: 'L8', elo: 2200, note: 'Level 8 does not make mistakes. Beating it is a project.' }
]

const SIDE_OPTIONS: readonly { key: ColorChoice; label: string }[] = [
  { key: 'white', label: 'White' },
  { key: 'black', label: 'Black' },
  { key: 'random', label: 'Random' }
]

/** Initials for the no-photo portrait ("Paul Morphy" -> "PM"). */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .slice(0, 2)
    .join('')
}

/** First sentence of a persona's style description. The regex needs whitespace
 *  or end after the stop so move notation like "1.e4" never cuts it short. */
function hookOf(p: Persona): string {
  const src = (p.styleDesc ?? p.bio).trim()
  const end = src.search(/[.!?](?:\s|$)/)
  return end >= 0 ? src.slice(0, end + 1) : src
}

export interface BotSectionProps {
  onStart: (spec: StartSpec) => void
  /** No Stockfish on disk: every one of these opponents runs on it. */
  engineMissing: boolean
  onOpenSettings?: () => void
  /** Open one of a grandmaster's own games in Analysis. */
  onOpenFamousGame?: (famousId: string) => void
}

export function BotSection({
  onStart,
  engineMissing,
  onOpenSettings,
  onOpenFamousGame
}: BotSectionProps): JSX.Element {
  const { settings, update } = useSettings()

  const [style, setStyle] = useState<BotStyle>('levels')
  // v1 opens on L3.
  const [elo, setElo] = useState(1200)
  const [maiaLevel, setMaiaLevel] = useState<MaiaLevel>(1500)
  const [maiaReady, setMaiaReady] = useState(false)
  const [colorChoice, setColorChoice] = useState<ColorChoice>('white')
  const [tc, setTc] = useState<TimeControl>(() => timeControlById('unlimited'))

  const [personas, setPersonas] = useState<Persona[]>([])
  const [personasLoading, setPersonasLoading] = useState(false)
  const [personaId, setPersonaId] = useState<string | null>(null)
  const [eraFilter, setEraFilter] = useState<string | null>(null)
  const [famousGames, setFamousGames] = useState<Record<string, FamousGameMeta>>({})

  // The Human style only exists once lc0 and a weight are on disk. One probe.
  useEffect(() => {
    let cancelled = false
    void window.api?.engine
      ?.status()
      .then((s) => {
        if (!cancelled) setMaiaReady(s.lc0Ready)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // Personas load lazily, once, on first opening the Grandmasters style.
  // Latched by a ref: an empty or failed list must not re-arm the fetch.
  const personasAttempted = useRef(false)
  useEffect(() => {
    if (style !== 'grandmasters' || personasAttempted.current) return
    const api = window.api
    if (!api?.personas) return
    personasAttempted.current = true
    setPersonasLoading(true)
    api.personas
      .list()
      .then((r) => setPersonas(r.personas))
      .catch(() => setPersonas([]))
      .finally(() => setPersonasLoading(false))
    api.famous
      .list()
      .then((r) => {
        const byId: Record<string, FamousGameMeta> = {}
        for (const g of r.games) byId[g.id] = g
        setFamousGames(byId)
      })
      .catch(() => setFamousGames({}))
  }, [style])

  const eras = useMemo(() => {
    const out: string[] = []
    for (const p of personas) if (!out.includes(p.era)) out.push(p.era)
    return out
  }, [personas])

  const countByEra = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of personas) m[p.era] = (m[p.era] ?? 0) + 1
    return m
  }, [personas])

  const shown = eraFilter ? personas.filter((p) => p.era === eraFilter) : personas
  const persona = personas.find((p) => p.id === personaId) ?? null

  const level = LEVELS.find((l) => l.elo === elo) ?? LEVELS[2]
  // The chip's own blurb labels the level; the softened line is a second short
  // qualifier rather than a sentence bolted onto the first, because the two say
  // different kinds of thing and only one of them is ever true.
  const softenedNote =
    elo < ENGINE_ELO_FLOOR
      ? `Softened below ${ENGINE_ELO_FLOOR}: measures about ${measuredElo({ kind: 'engine', elo })}.`
      : null

  const count =
    style === 'grandmasters'
      ? personasLoading
        ? 'Loading'
        : `${personas.length} players`
      : style === 'human'
        ? `${MAIA_LEVELS.length} levels`
        : `${LEVELS.length} levels`

  const styleNote =
    style === 'human'
      ? `Plays like a ~${maiaLevel} human, not a weakened engine.`
      : style === 'grandmasters'
        ? "Their openings and habits, at today's strength."
        : 'Eight fixed strengths, from beginner to unbeatable.'

  const canStart = style === 'grandmasters' ? persona !== null : true

  function start(): void {
    if (style === 'grandmasters') {
      if (!persona) return
      onStart({
        kind: 'persona',
        persona,
        color: colorChoice,
        tc
      })
      return
    }
    if (style === 'human' && maiaReady) {
      onStart({ kind: 'maia', level: maiaLevel, color: colorChoice, tc })
      return
    }
    onStart({ kind: 'engine', elo, color: colorChoice, tc })
  }

  const styleOptions: { key: BotStyle; label: string }[] = [
    { key: 'levels', label: 'Levels' },
    ...(maiaReady ? [{ key: 'human' as BotStyle, label: 'Human' }] : []),
    { key: 'grandmasters', label: 'Grandmasters' }
  ]

  return (
    <section className="sec" id="s-bot">
      <div className="sec-head">
        <h2 className="lbl">Bot</h2>
        <span className="sec-count">{count}</span>
      </div>

      <div className="panel">
        <div className="play-field">
          <span className="lbl">Style</span>
          <div>
            <Segmented
              label="Style"
              value={style}
              options={styleOptions}
              onChange={(s) => setStyle(s)}
            />
            <span className="play-qual">{styleNote}</span>
          </div>
        </div>

        {style === 'levels' && (
          <div className="play-field">
            <span className="lbl">Level</span>
            <div>
              <div className="chips" role="group" aria-label="Bot level">
                {LEVELS.map((l) => (
                  <button
                    key={l.label}
                    className="chip is-stacked play-lvl"
                    type="button"
                    aria-pressed={elo === l.elo}
                    onClick={() => setElo(l.elo)}
                  >
                    <span className="chip-main">{l.label}</span>
                    <span className="chip-sub">{l.elo}</span>
                  </button>
                ))}
              </div>
              <span className="play-qual" id="bot-note">
                {level.note}
              </span>
              {softenedNote !== null && <span className="play-qual">{softenedNote}</span>}
            </div>
          </div>
        )}

        {style === 'human' && (
          <div className="play-field">
            <span className="lbl">Level</span>
            <div className="chips" role="group" aria-label="Human level">
              {MAIA_LEVELS.map((l) => (
                <button
                  key={l}
                  className="chip is-stacked play-lvl"
                  type="button"
                  aria-pressed={maiaLevel === l}
                  onClick={() => setMaiaLevel(l)}
                >
                  <span className="chip-main">{l}</span>
                  <span className="chip-sub">Human</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {style === 'grandmasters' && (
          <>
            {eras.length > 0 && (
              <div className="play-field">
                <span className="lbl">Era</span>
                <div className="chips" role="group" aria-label="Era">
                  <button
                    className="chip"
                    type="button"
                    aria-pressed={eraFilter === null}
                    onClick={() => setEraFilter(null)}
                  >
                    All <span className="chip-n">{personas.length}</span>
                  </button>
                  {eras.map((era) => (
                    <button
                      key={era}
                      className="chip"
                      type="button"
                      aria-pressed={eraFilter === era}
                      onClick={() => setEraFilter((cur) => (cur === era ? null : era))}
                    >
                      {era} <span className="chip-n">{countByEra[era]}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="play-field">
              <span className="lbl">Player</span>
              {personas.length === 0 ? (
                <p className="play-note">
                  {personasLoading
                    ? 'Loading the grandmasters.'
                    : 'The grandmaster catalog did not load. Pick Levels above, or restart the app.'}
                </p>
              ) : (
                <div className="chips" role="group" aria-label="Grandmaster">
                  {shown.map((p) => (
                    <button
                      key={p.id}
                      className="chip"
                      type="button"
                      aria-pressed={personaId === p.id}
                      onClick={() => setPersonaId(p.id)}
                    >
                      {p.name} <span className="chip-n">{p.peakElo}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {persona && (
              <div className="play-gm">
                {persona.photo ? (
                  <img className="play-gm-face" src={persona.photo} alt="" />
                ) : (
                  <span className="play-gm-face" aria-hidden>
                    {initialsOf(persona.name)}
                  </span>
                )}
                <div>
                  <div className="play-gm-name">
                    {persona.title ? `${persona.title} ${persona.name}` : persona.name}
                  </div>
                  <div className="play-gm-years">
                    {[
                      persona.years ?? persona.era,
                      `Peak ${persona.peakElo}${persona.peakYear ? ` in ${persona.peakYear}` : ''}`,
                      persona.modernElo ? `Today about ${persona.modernElo}` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <p className="play-gm-bio">{hookOf(persona)}</p>
                </div>
              </div>
            )}
          </>
        )}

        <div className="play-field">
          <span className="lbl">Clock</span>
          <ClockChips value={tc} onChange={setTc} customId="bot-custom" />
        </div>

        <div className="play-field">
          <span className="lbl">Side</span>
          <Segmented
            label="Side"
            value={colorChoice}
            options={SIDE_OPTIONS}
            onChange={setColorChoice}
          />
        </div>

        <div className="play-field">
          <span className="lbl">Help</span>
          <Segmented
            label="Help"
            value={settings.hintsEnabled ? 'on' : 'off'}
            options={[
              { key: 'on', label: 'Hints on' },
              { key: 'off', label: 'Hints off' }
            ]}
            onChange={(v) => update({ hintsEnabled: v === 'on' })}
          />
        </div>
      </div>

      {engineMissing ? (
        <EngineRequiredNotice context="play" onOpenSettings={onOpenSettings} />
      ) : (
        <div className="play-go">
          <button className="btn is-primary" type="button" onClick={start} disabled={!canStart}>
            Start game
          </button>
          <span className="play-go-note">Bot games move the rating in the strip above.</span>
        </div>
      )}

      {/* A grandmaster's own games. The only thing on this page that leaves it
          for somewhere other than a board. */}
      {persona && onOpenFamousGame && persona.famousGameIds.length > 0 && (
        <section className="sec play-wait">
          <div className="sec-head">
            <h2 className="lbl">Their games</h2>
            <span className="sec-count">{persona.famousGameIds.length}</span>
          </div>
          <div className="panel golist">
            {persona.famousGameIds.map((id, i) => {
              const g = famousGames[id]
              return (
                <button key={id} className="go" type="button" onClick={() => onOpenFamousGame(id)}>
                  <span>
                    <span className="go-name">
                      {g ? `${g.white} vs ${g.black}` : `Game ${i + 1}`}
                    </span>
                    <span className="go-sub">
                      {g ? `${g.event}, ${g.year} · ${g.result}` : 'Open in Analysis'}
                    </span>
                  </span>
                  <svg className="icon go-arrow" aria-hidden focusable="false">
                    <use href="#i-arrow" />
                  </svg>
                </button>
              )
            })}
          </div>
        </section>
      )}
    </section>
  )
}
