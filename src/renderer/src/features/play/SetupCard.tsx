// Play setup — a three-tab experience:
//   "Local"         play on this machine: vs Stockfish (tiered Elo slider,
//                   piece-icon color picker, shared TimeControlPicker) OR
//                   "Over the board" (two humans, one screen — OtbSetup).
//   "Online"        internet play — renders <OnlineTab/> (owned by another builder).
//   "Grandmasters"  the persona gallery (PersonaGallery) + detail (PersonaDetail)
//                   with its own Challenge flow.
// State stays in PlayView (this component is controlled). All styling lives in
// setup.css (namespaced .psetup-/.qm-/.otb-/.pgal-/.pdet-).

import type { CSSProperties } from 'react'
import { Crown, Cpu, Users, Swords, Wifi } from 'lucide-react'
import {
  ENGINE_ELO_FLOOR,
  MAIA_LEVELS,
  type FamousGameMeta,
  type MaiaLevel,
  type Persona
} from '@shared/types'
import { measuredElo } from '@shared/botStrength'
import { EngineAvatar } from '../../components/Avatar'
import { EngineRequiredNotice } from '../../components/EngineRequiredNotice'
import { TimeControlPicker } from './TimeControlPicker'
import type { TimeControl } from './timeControl'
import { PersonaGallery } from './PersonaGallery'
import { PersonaDetail } from './PersonaDetail'
import { OtbSetup } from './OtbSetup'
import OnlineTab, { type OnlineStage } from './OnlineTab'

export type ColorChoice = 'white' | 'black' | 'random'
/** Top-level Play tab. */
export type PlayTab = 'local' | 'online' | 'grandmasters'
/** Which Local sub-mode is active. */
export type LocalMode = 'engine' | 'otb'
/** vs-Computer engine style: Classic Stockfish (any Elo) or Human (Maia nets —
 *  only offered once the maia dataset group is installed). */
export type BotStyle = 'classic' | 'human'

export interface OtbConfig {
  whiteName: string
  blackName: string
  autoFlip: boolean
}

export interface SetupCardProps {
  /** Active top-level tab. */
  tab: PlayTab
  /** Active Local sub-mode (vs computer / over the board). */
  localMode: LocalMode
  elo: number
  /** vs-Computer style toggle state (Classic Stockfish / Human Maia). */
  botStyle: BotStyle
  /** Selected Human level — one lc0 net per band (maia-1100..1900). */
  maiaLevel: MaiaLevel
  /** True when the maia dataset group is installed (lc0 + >=1 weight): the
   *  style toggle only renders then. */
  maiaReady: boolean
  colorChoice: ColorChoice
  /** The selected time control (shared across engine, OTB and Grandmasters). */
  timeControl: TimeControl
  /** Over-the-board config (names + auto-flip). */
  otb: OtbConfig
  personas: Persona[]
  personasLoading: boolean
  selectedPersonaId: string | null
  /** Famous-game metadata by id (labels PersonaDetail's games list). */
  famousGames: Record<string, FamousGameMeta>
  /** Live online-session stage (from OnlineTab via PlayView): 'lobby'/'game'
   *  lock the other tabs (switching would unmount the tab and tear the session
   *  down); 'game' also hands the card the full play width. */
  onlineStage: OnlineStage
  onTab: (t: PlayTab) => void
  onLocalMode: (m: LocalMode) => void
  onElo: (v: number) => void
  onBotStyle: (s: BotStyle) => void
  onMaiaLevel: (l: MaiaLevel) => void
  onColor: (c: ColorChoice) => void
  onTimeControl: (tc: TimeControl) => void
  onOtb: (patch: Partial<OtbConfig>) => void
  /** OnlineTab's stage reports, threaded up to PlayView's state. */
  onOnlineStage: (stage: OnlineStage) => void
  /** null returns the Grandmasters tab from detail to the gallery. */
  onSelectPersona: (id: string | null) => void
  /** Start the currently-configured game (engine, OTB, or persona challenge). */
  onStart: () => void
  /** Open a famous game in Analysis (threaded from App via PlayView). */
  onOpenFamousGame?: (famousId: string) => void
  /** True when the Stockfish dataset isn't on disk (fresh install): the
   *  engine-dependent starts (vs Computer, Grandmasters) swap their Start
   *  button for the install CTA — same pattern as the go bots' KataGo card. */
  engineMissing?: boolean
  /** Deep link to Settings → Datasets (the engine download lives there). */
  onOpenSettings?: () => void
}

const ELO_MIN = 100
const ELO_MAX = 3190

// Named strength tiers along the slider. `min` bounds the band (a tier is
// active from its min up to the next tier's min); `jump` is the representative
// Elo a chip click sets. Below ENGINE_ELO_FLOOR (1320) Stockfish can't be
// weakened natively — the main process approximates those tiers with an
// Elo-scaled softmax over MultiPV lines, hence the honesty footnote in the UI.
interface Tier {
  name: string
  min: number
  jump: number
  blurb: string
}

const TIERS: Tier[] = [
  {
    name: 'Beginner',
    min: ELO_MIN,
    jump: 250,
    blurb: 'Just learned the moves — hangs pieces and misses mate in one.'
  },
  {
    name: 'Novice',
    min: 500,
    jump: 650,
    blurb: 'Grabs free material but walks into forks, pins and back-rank tricks.'
  },
  {
    name: 'Casual',
    min: 850,
    jump: 1000,
    blurb: 'Plays sensible openings, then loses the thread in the middlegame.'
  },
  {
    name: 'Amateur',
    min: 1150,
    jump: 1300,
    blurb: 'Develops and castles on time; sharp tactics still slip through.'
  },
  {
    name: 'Intermediate',
    min: 1450,
    jump: 1550,
    blurb: 'A solid club-night opponent that punishes careless moves.'
  },
  {
    name: 'Club',
    min: 1750,
    jump: 1850,
    blurb: 'Positionally aware, and converts extra material with clean technique.'
  },
  {
    name: 'Expert',
    min: 2050,
    jump: 2200,
    blurb: 'Calculates deeply and rarely blunders. Bring a plan.'
  },
  {
    name: 'Master',
    min: 2350,
    jump: 2500,
    blurb: 'Master strength — precise, patient and unforgiving.'
  },
  {
    name: 'Grandmaster',
    min: 2700,
    jump: 2850,
    blurb: 'Elite strength. Every inaccuracy gets exploited.'
  },
  {
    name: 'Maximum',
    min: 3050,
    jump: ELO_MAX,
    blurb: 'Full-power Stockfish. Objectively hopeless — good luck.'
  }
]

function tierFor(elo: number): Tier {
  let t = TIERS[0]
  for (const tier of TIERS) if (elo >= tier.min) t = tier
  return t
}

const COLOR_OPTIONS: { key: ColorChoice; label: string; hint: string }[] = [
  { key: 'white', label: 'White', hint: 'You move first' },
  { key: 'black', label: 'Black', hint: 'Engine moves first' },
  { key: 'random', label: 'Random', hint: 'Coin flip' }
]

/** Piece-icon disc for the color picker (random = split white/black disc). */
function ColorDisc({ choice }: { choice: ColorChoice }) {
  if (choice === 'random') {
    return (
      <span className="qm-disc is-random" aria-hidden>
        <span className="qm-disc-glyph is-white">♔</span>
        <span className="qm-disc-glyph is-black">♚</span>
      </span>
    )
  }
  return (
    <span className={`qm-disc is-${choice}`} aria-hidden>
      {choice === 'white' ? '♔' : '♚'}
    </span>
  )
}

/** The vs-Computer configurator (Local → vs Computer): Classic Stockfish at
 *  any Elo, or — once the maia dataset is installed — the Human style, five
 *  Maia nets that play the moves people actually play at each band. */
function EngineSetup({
  elo,
  botStyle,
  maiaLevel,
  maiaReady,
  colorChoice,
  timeControl,
  onElo,
  onBotStyle,
  onMaiaLevel,
  onColor,
  onTimeControl,
  onStart,
  engineMissing,
  onOpenSettings
}: {
  elo: number
  botStyle: BotStyle
  maiaLevel: MaiaLevel
  maiaReady: boolean
  colorChoice: ColorChoice
  timeControl: TimeControl
  onElo: (v: number) => void
  onBotStyle: (s: BotStyle) => void
  onMaiaLevel: (l: MaiaLevel) => void
  onColor: (c: ColorChoice) => void
  onTimeControl: (tc: TimeControl) => void
  onStart: () => void
  engineMissing?: boolean
  onOpenSettings?: () => void
}) {
  const tier = tierFor(elo)
  const fillPct = ((elo - ELO_MIN) / (ELO_MAX - ELO_MIN)) * 100
  const human = maiaReady && botStyle === 'human'
  return (
    <section className="psetup-panel qm" aria-label="Play vs Computer setup">
      <header className="qm-head">
        <EngineAvatar size={44} />
        <div className="qm-head-meta">
          <h2>{human ? `Maia ${maiaLevel}` : 'Stockfish'}</h2>
          <span className="muted small">
            {human
              ? 'A neural net trained on millions of real games — human moves, human mistakes.'
              : 'The classic engine opponent — dial it from first-timer to world-beater.'}
          </span>
        </div>
      </header>

      {maiaReady && (
        <div className="qm-styles" role="radiogroup" aria-label="Engine style">
          <button
            type="button"
            role="radio"
            aria-checked={botStyle === 'classic'}
            className={`qm-style${botStyle === 'classic' ? ' on' : ''}`}
            onClick={() => onBotStyle('classic')}
          >
            <span className="qm-style-name">Classic</span>
            <span className="qm-style-hint muted">Stockfish · any strength</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={botStyle === 'human'}
            className={`qm-style${botStyle === 'human' ? ' on' : ''}`}
            onClick={() => onBotStyle('human')}
          >
            <span className="qm-style-name">Human</span>
            <span className="qm-style-hint muted">Maia · plays like people do</span>
          </button>
        </div>
      )}

      {human ? (
        <div className="psetup-field">
          <div className="qm-strength-row">
            <span className="psetup-label" id="qm-maia-label">
              Strength
            </span>
            <span className="qm-readout">
              <span className="qm-readout-elo num">~{maiaLevel}</span>
              <span className="qm-readout-tier">Human</span>
            </span>
          </div>
          <div className="qm-maia-levels" role="radiogroup" aria-labelledby="qm-maia-label">
            {MAIA_LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={maiaLevel === l}
                className={`qm-maia-level${maiaLevel === l ? ' on' : ''}`}
                onClick={() => onMaiaLevel(l)}
              >
                <span className="num">{l}</span>
              </button>
            ))}
          </div>
          <p className="qm-blurb" aria-live="polite">
            <strong>Maia {maiaLevel}</strong> — plays like a ~{maiaLevel} human: the openings,
            plans and typical mistakes of real players at that rating.
          </p>
          <p className="qm-floor-note muted">
            Human levels are estimates — your rating is updated against ~{maiaLevel}.
          </p>
        </div>
      ) : (
        <div className="psetup-field">
          <div className="qm-strength-row">
            <span className="psetup-label" id="qm-strength-label">
              Strength
            </span>
            <span className="qm-readout">
              <span className="qm-readout-elo num">{elo}</span>
              <span className="qm-readout-tier">{tier.name}</span>
            </span>
          </div>
          <input
            className="qm-range"
            type="range"
            min={ELO_MIN}
            max={ELO_MAX}
            step={10}
            value={elo}
            aria-labelledby="qm-strength-label"
            aria-valuetext={`${elo} Elo — ${tier.name}`}
            style={{ '--fill': `${fillPct}%` } as CSSProperties}
            onChange={(e) => onElo(Number(e.target.value))}
          />
          <div className="qm-tiers" role="group" aria-label="Strength presets">
            {TIERS.map((t) => (
              <button
                key={t.name}
                type="button"
                className={`qm-tier${t === tier ? ' on' : ''}`}
                title={`${t.name} · ~${t.jump} Elo`}
                onClick={() => onElo(t.jump)}
              >
                {t.name}
              </button>
            ))}
          </div>
          <p className="qm-blurb" aria-live="polite">
            <strong>{tier.name}</strong> — {tier.blurb}
          </p>
          {elo < ENGINE_ELO_FLOOR && (
            <p className="qm-floor-note muted">
              Below {ENGINE_ELO_FLOOR} the engine is softened artificially — this level is measured
              to play at roughly ~{measuredElo({ kind: 'engine', elo })} strength, and your rating
              is updated against that measured number.
            </p>
          )}
        </div>
      )}

      <div className="psetup-field">
        <span className="psetup-label">Play as</span>
        <div className="qm-colors" role="group" aria-label="Play as">
          {COLOR_OPTIONS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`qm-color${colorChoice === c.key ? ' on' : ''}`}
              aria-pressed={colorChoice === c.key}
              onClick={() => onColor(c.key)}
            >
              <ColorDisc choice={c.key} />
              <span className="qm-color-label">{c.label}</span>
              <span className="qm-color-hint muted">{c.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="psetup-field">
        <span className="psetup-label">Time control</span>
        <TimeControlPicker value={timeControl} onChange={onTimeControl} />
      </div>

      {engineMissing ? (
        // Fresh install: no Stockfish on disk. Starting would dead-end (the
        // engine spawn rejects), so swap Start for the install CTA — the same
        // inline pattern as the go bots' KataGo card.
        <EngineRequiredNotice context="play" onOpenSettings={onOpenSettings} />
      ) : (
        <button type="button" className="btn psetup-start" onClick={onStart}>
          <span className="psetup-start-main">Start game</span>
          <span className="psetup-start-sub num">
            {human ? `vs Maia ${maiaLevel} · Human style` : `vs Stockfish · ${tier.name} · ${elo} Elo`}
          </span>
        </button>
      )}
    </section>
  )
}

export function SetupCard({
  tab,
  localMode,
  elo,
  botStyle,
  maiaLevel,
  maiaReady,
  colorChoice,
  timeControl,
  otb,
  personas,
  personasLoading,
  selectedPersonaId,
  famousGames,
  onlineStage,
  onTab,
  onLocalMode,
  onElo,
  onBotStyle,
  onMaiaLevel,
  onColor,
  onTimeControl,
  onOtb,
  onOnlineStage,
  onSelectPersona,
  onStart,
  onOpenFamousGame,
  engineMissing,
  onOpenSettings
}: SetupCardProps) {
  const selectedPersona =
    tab === 'grandmasters' ? (personas.find((p) => p.id === selectedPersonaId) ?? null) : null

  const TABS: { key: PlayTab; label: string; icon: typeof Swords }[] = [
    { key: 'local', label: 'Local', icon: Swords },
    { key: 'online', label: 'Online', icon: Wifi },
    { key: 'grandmasters', label: 'Grandmasters', icon: Crown }
  ]

  // While an online session is live (lobby or game), switching tabs would
  // unmount OnlineTab, whose cleanup tears the whole session down (hosted code
  // dies / live game is abandoned). Lock the other tabs until the user leaves
  // via the tab's own Cancel/Leave affordances.
  const onlineLocked = tab === 'online' && onlineStage !== 'idle'
  // A live online game reuses GameView — hand it the full play width.
  const onlineGameLive = tab === 'online' && onlineStage === 'game'

  return (
    <div
      className={`psetup${tab === 'grandmasters' ? ' is-wide' : ''}${onlineGameLive ? ' is-game' : ''}`}
    >
      <div className="psetup-tabs" role="tablist" aria-label="Play mode">
        {TABS.map((t) => {
          const Icon = t.icon
          const locked = onlineLocked && t.key !== 'online'
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`psetup-tab${tab === t.key ? ' on' : ''}`}
              disabled={locked}
              title={locked ? 'Leave the online game first' : undefined}
              onClick={() => onTab(t.key)}
            >
              <Icon size={15} aria-hidden />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'local' ? (
        <div className="psetup-local">
          <div className="psetup-subtabs" role="tablist" aria-label="Local mode">
            <button
              type="button"
              role="tab"
              aria-selected={localMode === 'engine'}
              className={`psetup-subtab${localMode === 'engine' ? ' on' : ''}`}
              onClick={() => onLocalMode('engine')}
            >
              <Cpu size={14} aria-hidden />
              vs Computer
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={localMode === 'otb'}
              className={`psetup-subtab${localMode === 'otb' ? ' on' : ''}`}
              onClick={() => onLocalMode('otb')}
            >
              <Users size={14} aria-hidden />
              Over the board
            </button>
          </div>

          {localMode === 'engine' ? (
            <EngineSetup
              elo={elo}
              botStyle={botStyle}
              maiaLevel={maiaLevel}
              maiaReady={maiaReady}
              colorChoice={colorChoice}
              timeControl={timeControl}
              onElo={onElo}
              onBotStyle={onBotStyle}
              onMaiaLevel={onMaiaLevel}
              onColor={onColor}
              onTimeControl={onTimeControl}
              onStart={onStart}
              engineMissing={engineMissing}
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <OtbSetup
              whiteName={otb.whiteName}
              blackName={otb.blackName}
              timeControl={timeControl}
              autoFlip={otb.autoFlip}
              onWhiteName={(whiteName) => onOtb({ whiteName })}
              onBlackName={(blackName) => onOtb({ blackName })}
              onTimeControl={onTimeControl}
              onAutoFlip={(autoFlip) => onOtb({ autoFlip })}
              onStart={onStart}
            />
          )}
        </div>
      ) : tab === 'online' ? (
        <OnlineTab
          initialTimeControl={timeControl}
          onTimeControl={onTimeControl}
          onStage={onOnlineStage}
        />
      ) : selectedPersona ? (
        <>
          {/* Persona games run on the same main-process Stockfish — a missing
              engine dataset must not dead-end the Challenge button either. */}
          {engineMissing && <EngineRequiredNotice context="play" onOpenSettings={onOpenSettings} />}
          <PersonaDetail
            persona={selectedPersona}
            famousGames={famousGames}
            colorChoice={colorChoice}
            timeControl={timeControl}
            onColor={onColor}
            onTimeControl={onTimeControl}
            onBack={() => onSelectPersona(null)}
            onChallenge={onStart}
            onOpenFamousGame={onOpenFamousGame}
          />
        </>
      ) : (
        <PersonaGallery personas={personas} loading={personasLoading} onOpen={onSelectPersona} />
      )}
    </div>
  )
}
