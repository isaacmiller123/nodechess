// 2D/3D board-mode seam for the games library (docs/GAMES-PLATFORM-SPEC.md
// §3D tiers): a per-game persisted toggle (settings.board3d) + the lazy host
// that mounts the Tabletop3D bridge.
//
// - WILL-tier kinds only (chess-family standard boards, checkers both, go,
//   gomoku, othello, connect four). Crazyhouse stays 2D-only (pockets have no
//   tabletop representation yet); CAN-tier kinds stay 2D-first per the spec.
// - WebGL unavailable → the toggle renders nothing and every view keeps its
//   2D board silently (isTabletopSupported probes without pulling three.js).
// - The three.js bundle loads ONLY here, via React.lazy, the first time a 3D
//   board actually mounts: the toggle itself imports no 3D code.
// - A runtime failure (context lost) flips the preference back to 2D so the
//   user lands on a working board, not a black canvas.

import { lazy, Suspense, useCallback, type JSX } from 'react'
import { useSettings } from '../../state/settings'
import { isTabletopSupported } from '../../games/three/webgl'
import type { GameBoardProps } from '../../games/registry'

/** Kinds whose 3D table is shipped (spec WILL tier; crazyhouse excluded). */
const WILL_3D: ReadonlySet<string> = new Set([
  'chess',
  'chess960',
  'atomic',
  'antichess',
  'kingofthehill',
  'threecheck',
  'horde',
  'racingkings',
  'checkers',
  'checkers-intl',
  'go',
  'gomoku',
  'othello',
  'connect4'
])

/** Non-hook probe: does this kind get a 3D table on THIS machine? (WILL-tier
 *  kind + WebGL present: the same gate useBoardMode applies, minus the user
 *  preference.) Replay Theater uses it to pick its 3D stage vs 2D autoplay. */
export function tabletop3dOffered(kind: string): boolean {
  return WILL_3D.has(kind) && isTabletopSupported()
}

export function useBoardMode(kind: string): {
  /** Render the 3D board now (toggle on AND this machine can). */
  is3d: boolean
  set3d: (on: boolean) => void
  /** Show the toggle at all (WILL-tier kind + WebGL present). */
  available: boolean
} {
  const { settings, update } = useSettings()
  const available = WILL_3D.has(kind) && isTabletopSupported()
  const is3d = available && settings.board3d[kind] === true
  const set3d = useCallback(
    (on: boolean) => update({ board3d: { ...settings.board3d, [kind]: on } }),
    [update, settings.board3d, kind]
  )
  return { is3d, set3d, available }
}

/** Segmented 2D/3D control: renders nothing when 3D isn't offered here. */
export function BoardModeToggle({ kind }: { kind: string }): JSX.Element | null {
  const { is3d, set3d, available } = useBoardMode(kind)
  if (!available) return null
  return (
    <div className="bmode" role="radiogroup" aria-label="Board style">
      <button
        type="button"
        role="radio"
        aria-checked={!is3d}
        className={`bmode-btn${!is3d ? ' is-active' : ''}`}
        onClick={() => set3d(false)}
      >
        2D
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={is3d}
        className={`bmode-btn${is3d ? ' is-active' : ''}`}
        onClick={() => set3d(true)}
      >
        3D
      </button>
    </div>
  )
}

// The ONLY entry point to the three.js chunk from the app shell.
const GameBoard3D = lazy(() => import('../../games/three/GameBoard3D'))

/** Mounts the 3D board (lazy, shimmer while the chunk loads); on any runtime
 *  unavailability it flips the per-game preference back to 2D. */
export function Board3DHost(props: GameBoardProps): JSX.Element {
  const { set3d } = useBoardMode(props.kind)
  const onUnavailable = useCallback(() => set3d(false), [set3d])
  return (
    <div className="b3d-stage">
      <Suspense
        fallback={
          <div className="b3d-shimmer" role="status" aria-label="Setting up the 3D table" />
        }
      >
        <GameBoard3D {...props} onUnavailable={onUnavailable} />
      </Suspense>
    </div>
  )
}
