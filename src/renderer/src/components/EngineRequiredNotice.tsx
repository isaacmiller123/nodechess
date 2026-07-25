// Inline "Stockfish isn't installed yet" prompt: the chess siblings of the go
// bots' KataGo install card (KernelBot's .vbot-install): explains the one-time
// engine download and deep-links to Settings → Datasets instead of dead-ending
// (no board, no error) or spinning at depth 0 forever.
//
// Self-contained styling (engineRequired.css) so it renders correctly from any
// lazy chunk (Play, Analysis) without depending on games.css being loaded.

import type { JSX } from 'react'
import { Download } from 'lucide-react'
import { isWebBuild } from '../platform'
import './engineRequired.css'

const LEAD: Record<'play' | 'analysis' | 'placement', string> = {
  play: 'Playing the computer runs on',
  analysis: 'Analysis runs on',
  placement: 'The placement game runs on'
}

export function EngineRequiredNotice({
  context,
  onOpenSettings
}: {
  /** Picks the first words of the pitch; everything else is shared. */
  context: 'play' | 'analysis' | 'placement'
  /** Deep link to Settings → Datasets (the download lives there). */
  onOpenSettings?: () => void
}): JSX.Element {
  // Web build: nothing to download and nowhere to deep-link. Engines are
  // coming online in a later update, so say exactly that (no false CTA).
  if (isWebBuild) {
    return (
      <div className="engine-required" role="status">
        <p>
          {LEAD[context]} <strong>Stockfish</strong>. Engines are coming online here in a future
          update. Today they&apos;re in the desktop app.
        </p>
      </div>
    )
  }
  return (
    <div className="engine-required" role="status">
      <p>
        {LEAD[context]} <strong>Stockfish</strong>, a one-time engine download that stays on this
        machine. Grab it once and every strength, plus hints, analysis and game review, unlocks.
      </p>
      <SettingsCta onOpenSettings={onOpenSettings} />
    </div>
  )
}

/** The puzzles sibling: same install card, but for the Lichess puzzle database
 *  (datasets:status().puzzles). School warm-up/cool-down segments show this
 *  instead of dead-ending (or worse, faking a puzzle) when the DB is absent. */
export function PuzzlesRequiredNotice({
  onOpenSettings
}: {
  onOpenSettings?: () => void
}): JSX.Element {
  // Web build: the puzzle DB lives on the server, so there's nothing the user
  // can download to fix an absence. Same honest no-CTA card as the engine.
  if (isWebBuild) {
    return (
      <div className="engine-required" role="status">
        <p>
          Warm-up and cool-down drills come from the <strong>Lichess puzzle database</strong>,
          which hasn&apos;t come online here yet. Today it&apos;s in the desktop app.
        </p>
      </div>
    )
  }
  return (
    <div className="engine-required" role="status">
      <p>
        Warm-up and cool-down drills come from the <strong>Lichess puzzle database</strong>, a
        one-time download that stays on this machine. Grab it once and every puzzle in the app,
        School drills included, unlocks.
      </p>
      <SettingsCta onOpenSettings={onOpenSettings} />
    </div>
  )
}

function SettingsCta({ onOpenSettings }: { onOpenSettings?: () => void }): JSX.Element {
  return onOpenSettings ? (
    <button type="button" className="engine-required-btn" onClick={onOpenSettings}>
      <Download size={15} aria-hidden /> Download in Settings → Datasets
    </button>
  ) : (
    <p className="engine-required-hint">Open Settings → Datasets to download it.</p>
  )
}
