// THE PLAY SCREEN, from design-lab/v1/play.html.
//
// Three peers in one row, the picked one's panel below them, and an Unfinished
// well at the bottom that grows into whatever space is left. Picking a peer
// changes the panel and nothing else, which is why each section owns its own
// form and hands this page a finished StartSpec rather than a pile of state.
//
// The teaching is NOT on this screen. It is in PlayExplainer, which opens once
// before a player's first game and can be re-opened from the head. What is left
// here is controls: a stakes choice, a clock row, a side row, a commit row, and
// one short qualifier wherever a control cannot be answered.
//
// The readout's NEXT line is v1's, per state: the sentences it writes are all
// true of the screen they appear on.

import { useState, type JSX } from 'react'
import { useReadoutSlot, type ViewKey } from '../../components/Layout'
import { useMatchmaking } from '../account/net/matchmaking'
import { useOnlineGame } from './online/useOnlineGame'
import { OnlineSection } from './OnlineSection'
import { BotSection } from './BotSection'
import { LocalSection } from './LocalSection'
import { PlayExplainer, usePlayExplainer } from './PlayExplainer'
import { UnfinishedSection } from './UnfinishedSection'
import type { PlayMode, StartSpec } from './setupTypes'

interface Peer {
  key: PlayMode
  name: string
  spec: string
  meta: string
}

// v1's three peers, verbatim. Same size, same weight, same row.
const PEERS: readonly Peer[] = [
  {
    key: 'online',
    name: 'Online',
    spec: 'Matched against a stranger near your strength.',
    meta: 'Rated or casual'
  },
  {
    key: 'bot',
    name: 'Bot',
    spec: 'Eight levels. It waits as long as you need.',
    meta: 'Works offline'
  },
  {
    key: 'local',
    name: 'Local board',
    spec: 'Two people taking turns on this screen.',
    meta: 'One device'
  }
]

export interface PlaySetupProps {
  onStart: (spec: StartSpec) => void
  engineMissing: boolean
  onOpenSettings?: () => void
  onOpenFamousGame?: (famousId: string) => void
  onNavigate?: (view: ViewKey) => void
}

export function PlaySetup({
  onStart,
  engineMissing,
  onOpenSettings,
  onOpenFamousGame,
  onNavigate
}: PlaySetupProps): JSX.Element {
  const online = useOnlineGame()
  const mm = useMatchmaking()
  // Opens itself once, the first time anyone reaches this screen; after that
  // only the head's "How Play works" brings it back.
  const explainer = usePlayExplainer()
  // v1 opens on Online, pressed.
  const [mode, setMode] = useState<PlayMode>('online')
  // v1's first NEXT is "Pick a way to play" and it only changes once a peer is
  // clicked, so the strip does not answer a question nobody asked yet.
  const [picked, setPicked] = useState(false)

  const ratedBusy = mm.phase !== 'idle' && mm.phase !== 'signed-out'
  const casualBusy = online.phase === 'hosting' || online.phase === 'connecting'
  const searching = mode === 'online' && (ratedBusy || casualBusy)

  const next = !picked
    ? 'Pick a way to play'
    : searching
      ? 'Waiting for an opponent'
      : mode === 'online'
        ? 'Pick a clock and find someone'
        : mode === 'bot'
          ? 'Pick a level'
          : 'Name the two players'
  useReadoutSlot(next, null)

  return (
    <div className="play col-single">
      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Play</h2>
          <span className="sec-count">{PEERS.length} ways</span>
          {/* The way back into the explainer. Quiet on purpose: it is there for
              the second reading, not the first. */}
          <button className="play-help" type="button" onClick={explainer.reopen}>
            How Play works
          </button>
        </div>

        <div className="play-modes" role="group" aria-label="Ways to play">
          {PEERS.map((p) => (
            <button
              key={p.key}
              className="play-mode"
              type="button"
              aria-pressed={mode === p.key}
              onClick={() => {
                setMode(p.key)
                setPicked(true)
              }}
            >
              <span className="play-mode-name">{p.name}</span>
              <span className="play-mode-spec">{p.spec}</span>
              <span className="play-mode-meta">{p.meta}</span>
            </button>
          ))}
        </div>
      </section>

      {mode === 'online' && <OnlineSection searching={searching} onNavigate={onNavigate} />}
      {mode === 'bot' && (
        <BotSection
          onStart={onStart}
          engineMissing={engineMissing}
          onOpenSettings={onOpenSettings}
          onOpenFamousGame={onOpenFamousGame}
        />
      )}
      {mode === 'local' && <LocalSection onStart={onStart} />}

      {/* The wait owns the screen while it runs. */}
      {!searching && <UnfinishedSection online={online} onReturn={() => setMode('online')} />}

      {explainer.open && <PlayExplainer onClose={explainer.close} />}
    </div>
  )
}
