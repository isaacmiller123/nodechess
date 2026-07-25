import { lazy, Suspense, useState, type JSX } from 'react'
import { ChevronRight, Dices, FlaskConical, Library } from 'lucide-react'
import { Board } from '../../board/Board'
import { pieceSetClass } from '../../board/pieceSets'
import { useSettings } from '../../state/settings'
import { CATALOG, type CatalogEntry } from './catalog'
import { ArtThumb } from './ArtThumb'
import { GamePage } from './GamePage'
import './games.css'
// The Lab hero card is styled by the editor's stylesheet (vl-hero). Imported
// eagerly so the hero renders styled before the lazy EditorView chunk loads.
import './editor/editor.css'
// Same for the section tabs (games-sections), styled by the Library sheet.
import '../library/library.css'

// Variant Lab (features/games/editor), code-split: the builder + ffish tooling
// only load when the user opens the Lab.
const EditorView = lazy(() => import('./editor/EditorView'))
// Library (features/library), code-split: the archive list + replay viewer
// only load when the user opens the Library section.
const LibraryView = lazy(() => import('../library/LibraryView'))

/**
 * Games library: the storefront. Card grid over the game catalog: playable
 * chess variants render a live mini board with a characteristic position;
 * coming-soon games get vector art placeholders with a P2 pill. Clicking a
 * card opens the per-game page (Play / Manual). The Variant Lab hero at the
 * bottom opens the custom-variant editor ('custom-editor' catalog card's
 * real home).
 */
export default function GamesView({
  onOpenSettings,
  onOpenChessGame
}: {
  /** Deep link to the Settings view (bot engine install prompts). */
  onOpenSettings?: () => void
  /** Route a saved CHESS game into the full Analysis/review view (Library). */
  onOpenChessGame?: (gameId: number) => void
}): JSX.Element {
  const { settings } = useSettings()
  const [selected, setSelected] = useState<CatalogEntry | null>(null)
  const [labOpen, setLabOpen] = useState(false)
  const [section, setSection] = useState<'games' | 'library'>('games')

  if (labOpen) {
    return (
      <Suspense
        fallback={
          <div className="view-loading" role="status">
            <span className="view-spinner" aria-hidden />
          </div>
        }
      >
        <EditorView onExit={() => setLabOpen(false)} />
      </Suspense>
    )
  }

  if (selected) {
    return <GamePage entry={selected} onBack={() => setSelected(null)} onOpenSettings={onOpenSettings} />
  }

  // Section tabs: the storefront ('games') and the cross-mode saved-game
  // Library ('library': features/library, replayable on every kind's board).
  const sectionTabs = (
    <div className="games-sections" role="tablist" aria-label="Games sections">
      <button
        type="button"
        role="tab"
        aria-selected={section === 'games'}
        className={`games-section-tab${section === 'games' ? ' is-active' : ''}`}
        onClick={() => setSection('games')}
      >
        <Dices size={15} aria-hidden /> Play
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={section === 'library'}
        className={`games-section-tab${section === 'library' ? ' is-active' : ''}`}
        onClick={() => setSection('library')}
      >
        <Library size={15} aria-hidden /> Library
      </button>
    </div>
  )

  if (section === 'library') {
    return (
      <div className="games-view">
        {sectionTabs}
        <Suspense
          fallback={
            <div className="view-loading" role="status">
              <span className="view-spinner" aria-hidden />
            </div>
          }
        >
          <LibraryView onOpenChessGame={(id) => onOpenChessGame?.(id)} />
        </Suspense>
      </div>
    )
  }

  const boardCls = `board-wrap board-${settings.boardTheme} ${pieceSetClass(settings.pieceSet)}`
  // Everything shipped in P2: the section only renders if a future wave adds
  // new not-yet-playable entries (an empty "Coming soon" header looks broken).
  const comingSoon = CATALOG.filter((e) => e.status === 'coming' && e.kind !== 'custom-editor')

  const card = (entry: CatalogEntry): JSX.Element => (
    <button
      key={entry.kind}
      type="button"
      className={`game-card${entry.status === 'coming' ? ' is-coming' : ''}`}
      onClick={() => (entry.kind === 'custom-editor' ? setLabOpen(true) : setSelected(entry))}
    >
      <span className="game-card-thumb" aria-hidden>
        {entry.thumbFen ? (
          <span className={`${boardCls} game-card-board`}>
            <Board
              fen={entry.thumbFen}
              orientation="white"
              turnColor="white"
              dests={new Map()}
              viewOnly
              coordinates={false}
              animation={false}
            />
          </span>
        ) : (
          <ArtThumb kind={entry.kind} />
        )}
        {entry.status === 'coming' && <span className="pill-p2 game-card-pill">P2</span>}
      </span>
      <span className="game-card-title">{entry.title}</span>
      <span className="game-card-tagline">{entry.tagline}</span>
    </button>
  )

  return (
    <div className="games-view">
      {sectionTabs}
      <p className="games-intro">
        One library, many boards. Every game ships with local play, five bot levels, online
        matches and an illustrated manual.
      </p>

      <section aria-labelledby="games-now">
        <h2 id="games-now" className="games-section-title">
          Play now
          <span className="games-section-sub">Full rules, over the board</span>
        </h2>
        <div className="games-grid">{CATALOG.filter((e) => e.status === 'playable').map(card)}</div>
      </section>

      <section aria-labelledby="games-lab">
        <h2 id="games-lab" className="games-section-title">
          Make your own
          <span className="games-section-sub">The Variant Lab: real Fairy-Stockfish rules</span>
        </h2>
        <button type="button" className="vl-hero" onClick={() => setLabOpen(true)}>
          <span className="vl-hero-icon">
            <FlaskConical size={26} aria-hidden />
          </span>
          <span className="vl-hero-body">
            <span className="vl-hero-title">Variant Lab</span>
            <span className="vl-hero-sub">
              Thirty pawns against the world. Queens that jump like knights. Captures that explode.
              Paint a start position, flip the rules, and play it over the board instantly.
            </span>
          </span>
          <span className="vl-hero-cta">
            Open the Lab <ChevronRight size={16} aria-hidden />
          </span>
        </button>
      </section>

      {comingSoon.length > 0 && (
        <section aria-labelledby="games-soon">
          <h2 id="games-soon" className="games-section-title">
            Coming soon
            <span className="games-section-sub">In the next wave</span>
          </h2>
          <div className="games-grid">{comingSoon.map(card)}</div>
        </section>
      )}
    </div>
  )
}
