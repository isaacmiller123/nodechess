// GameBoardProps → Tabletop3D bridge: the 3D drop-in for a game's 2D board.
//
// Same contract as every 2D board component (games/registry.ts
// GameBoardProps): presentation only, proposes canonical move strings via
// onMove and NEVER validates rules: the owner answers by advancing the spec
// state, and the piece reconciler below turns that state diff into stable
// TabletopPiece identities so Tabletop3D plays the right slide / capture-fade /
// flip animations.
//
// Per-kind read models (all presentation-only exports of the specs):
//   chess family   FEN board field          drag → UCI (promotion auto-queen,
//                                           king-takes-rook castling gestures)
//   checkers both  americanPiecesOf/intl…   drag → '11-15' / '11x18x25' by
//                                           first/last square match
//   go             signMapOf (dead stones   click → vertex; scoring clicks
//                  removed while scoring)   propose onAction('markdead …') and
//                                           a floating strip offers Finalize
//   gomoku         gomokuSignMapOf          click → vertex
//   othello        black/white bitboards    click → square name (flips animate
//                                           via color-diff → twoTone discs)
//   connect4       bb bitboards             click → column digit, discs drop in
//
// This module pulls three.js. Load it ONLY through React.lazy (see
// features/games/boardMode.tsx). Sounds: non-chess 2D boards self-sound via
// useBoardSound, so the bridge mirrors that exactly (chess-family views own
// their sounds: no double-play).

import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react'
import { advance } from '@react-three/fiber'
import type { GameBoardProps } from '../registry'
import type { GameKind, PlayerColor } from '../kernel'
import { getGame } from '../registry'
import {
  deadStonesOf,
  pointToVertex,
  scoreDetail,
  signMapOf,
  vertexToPoint,
  type GoSpec,
  type GoState
} from '../go'
import { gomokuSignMapOf, type GomokuState } from '../gomoku'
import {
  americanPiecesOf,
  intlPiecesOf,
  type AmericanCheckersState,
  type IntlCheckersState
} from '../checkers'
import type { OthelloState } from '../small/othello'
import { c4Bit, type Connect4State } from '../small/connect4'
import { useBoardSound } from '../boards/useBoardSound'
import { Tabletop3D } from './Tabletop3D'
import { diffFocus, type TheaterDirective } from './theater'
import type { TabletopBoardShape, TabletopPiece, TabletopPos } from './types'

// ---------------------------------------------------------------------------
// Occupancy read models. Spec state → who sits where (white frame: file 0 =
// a-file/left from white's seat, rank 0 = white's near row).

export interface OccPiece {
  file: number
  rank: number
  type: string
  color: PlayerColor
}

export function chessOccupancy(fen: string, ranks: number): OccPiece[] {
  const out: OccPiece[] = []
  const rows = (fen.split(' ')[0] ?? '').split('/')
  rows.forEach((row, i) => {
    const rank = ranks - 1 - i
    let file = 0
    let digits = ''
    for (const ch of row) {
      if (ch >= '0' && ch <= '9') {
        digits += ch
        continue
      }
      if (digits) {
        file += Number(digits)
        digits = ''
      }
      // Promoted-piece markers: crazyhouse suffix 'Q~' and fairy/shogi prefix
      // '+P': both annotate a real piece letter, they are not pieces. Reading
      // '+' as a piece would also shift every later piece on its rank.
      if (ch === '~' || ch === '+') continue
      if (ch === '[') break // bracket-FEN pocket segment
      out.push({
        file,
        rank,
        type: ch.toLowerCase(),
        color: ch === ch.toUpperCase() ? 'white' : 'black'
      })
      file++
    }
  })
  return out
}

/** PDN/FMJD codec square (1-based) → board pos; row 0 = top as numbered. */
export function checkersPosOf(square: number, n: number): TabletopPos {
  const half = n / 2
  const p = square - 1
  const row = Math.floor(p / half)
  const col = 2 * (p % half) + (row % 2 === 0 ? 1 : 0)
  return { file: col, rank: n - 1 - row }
}

/** Board pos → codec square, null on light squares. */
export function checkersSquareOf(pos: TabletopPos, n: number): number | null {
  const row = n - 1 - pos.rank
  const col = pos.file
  if ((row + col) % 2 !== 1) return null
  return row * (n / 2) + (col - (row % 2 === 0 ? 1 : 0)) / 2 + 1
}

function signMapOccupancy(map: number[][], size: number): OccPiece[] {
  const out: OccPiece[] = []
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = map[y][x]
      if (v === 0) continue
      out.push({ file: x, rank: size - 1 - y, type: 'stone', color: v === 1 ? 'black' : 'white' })
    }
  }
  return out
}

function bitboardOccupancy(black: bigint, white: bigint): OccPiece[] {
  const out: OccPiece[] = []
  for (let i = 0; i < 64; i++) {
    const bit = 1n << BigInt(i)
    const color: PlayerColor | null = (black & bit) !== 0n ? 'black' : (white & bit) !== 0n ? 'white' : null
    if (!color) continue
    out.push({ file: i % 8, rank: Math.floor(i / 8), type: 'disc', color })
  }
  return out
}

export function occupancyOf(kind: GameKind, state: unknown, scoring: boolean): OccPiece[] {
  switch (kind) {
    case 'go': {
      const s = state as GoState
      const occ = signMapOccupancy(signMapOf(s), s.size)
      if (!scoring) return occ
      // Scoring phase: marked-dead groups leave the board (capture-fade), the
      // honest end-of-game look; un-marking respawns them.
      const dead = new Set(
        deadStonesOf(s)
          .map((v) => vertexToPoint(v, s.size))
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .map((p) => `${p.x},${s.size - 1 - p.y}`)
      )
      return occ.filter((o) => !dead.has(`${o.file},${o.rank}`))
    }
    case 'gomoku': {
      const s = state as GomokuState
      return signMapOccupancy(gomokuSignMapOf(s), s.size)
    }
    case 'checkers':
    case 'checkers-intl': {
      const n = kind === 'checkers' ? 8 : 10
      const views =
        kind === 'checkers'
          ? americanPiecesOf(state as AmericanCheckersState)
          : intlPiecesOf(state as IntlCheckersState)
      return views.map((v) => {
        const pos = checkersPosOf(v.square, n)
        return { file: pos.file, rank: pos.rank, type: v.king ? 'king' : 'man', color: v.color }
      })
    }
    case 'othello': {
      const s = state as OthelloState
      return bitboardOccupancy(s.black, s.white)
    }
    case 'connect4': {
      const s = state as Connect4State
      const out: OccPiece[] = []
      for (let col = 0; col < 7; col++) {
        for (let row = 0; row < 6; row++) {
          const bit = c4Bit(col, row)
          const color: PlayerColor | null =
            (s.bb[0] & bit) !== 0n ? 'white' : (s.bb[1] & bit) !== 0n ? 'black' : null
          if (color) out.push({ file: col, rank: row, type: 'disc', color })
        }
      }
      return out
    }
    default: {
      // Chess family. Every spec state carries its FEN.
      const fen = (state as { fen?: string }).fen
      const ranks = getGame(kind)?.spec.board.ranks ?? 8
      return fen ? chessOccupancy(fen, ranks) : []
    }
  }
}

// ---------------------------------------------------------------------------
// Stable-identity reconciler: matches the new occupancy against the previous
// TabletopPiece list so ids persist across moves. Match order: same square
// (same color, or any color for flip-in-place games) → moved same color+type
// (nearest) → same color any type (promotion/crowning) → fresh spawn. Whatever
// old ids remain were captured (Tabletop3D plays the lift-fade ghost).

export function reconcile(
  prev: TabletopPiece[],
  occ: OccPiece[],
  flipInPlace: boolean,
  nextId: () => string
): TabletopPiece[] {
  const out: TabletopPiece[] = []
  const prevByKey = new Map(prev.map((p) => [`${p.pos.file},${p.pos.rank}`, p]))
  const used = new Set<string>()
  const moved: OccPiece[] = []

  for (const o of occ) {
    const hit = prevByKey.get(`${o.file},${o.rank}`)
    if (hit && !used.has(hit.id) && (flipInPlace || hit.color === o.color)) {
      used.add(hit.id)
      out.push({ id: hit.id, pos: { file: o.file, rank: o.rank }, type: o.type, color: o.color })
    } else {
      moved.push(o)
    }
  }

  let pool = prev.filter((p) => !used.has(p.id))
  const claim = (o: OccPiece, sameType: boolean): boolean => {
    let best: TabletopPiece | null = null
    let bestD = Infinity
    for (const p of pool) {
      if (p.color !== o.color) continue
      if (sameType && p.type !== o.type) continue
      const d = Math.abs(p.pos.file - o.file) + Math.abs(p.pos.rank - o.rank)
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    if (!best) return false
    const b = best
    pool = pool.filter((p) => p.id !== b.id)
    out.push({ id: b.id, pos: { file: o.file, rank: o.rank }, type: o.type, color: o.color })
    return true
  }

  const unclaimed: OccPiece[] = []
  for (const o of moved) if (!claim(o, true)) unclaimed.push(o)
  for (const o of unclaimed) {
    if (!claim(o, false)) {
      out.push({ id: nextId(), pos: { file: o.file, rank: o.rank }, type: o.type, color: o.color })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Interaction → canonical move strings.

const PLACEMENT_KINDS = new Set<GameKind>(['go', 'gomoku', 'othello', 'connect4'])

export function placementMove(kind: GameKind, pos: TabletopPos, size: number): string {
  switch (kind) {
    case 'go':
    case 'gomoku':
      return pointToVertex(size - 1 - pos.rank, pos.file, size)
    case 'othello':
      return String.fromCharCode(97 + pos.file) + String(pos.rank + 1)
    case 'connect4':
      return String(pos.file + 1)
    default:
      return ''
  }
}

const FILES = 'abcdefghij'
const sqName = (pos: TabletopPos): string => `${FILES[pos.file]}${pos.rank + 1}`

/** Drag gesture → legal chess-family move (exact UCI, else auto-queen
 *  promotion, else the king-two-squares castling gesture mapped onto the
 *  king-takes-rook codec move). */
export function chessDragMove(
  legal: readonly string[],
  occ: OccPiece[],
  from: TabletopPos,
  to: TabletopPos
): string | null {
  const uci = sqName(from) + sqName(to)
  if (legal.includes(uci)) return uci
  const promos = legal.filter((m) => m.startsWith(uci) && m.length === uci.length + 1)
  if (promos.length > 0) return promos.find((m) => m.endsWith('q')) ?? promos[0]
  const mover = occ.find((o) => o.file === from.file && o.rank === from.rank)
  if (mover?.type === 'k' && to.rank === from.rank && to.file !== from.file) {
    const dir = Math.sign(to.file - from.file)
    const fromSq = sqName(from)
    for (const m of legal) {
      if (!m.startsWith(fromSq) || m.length !== 4) continue
      const df = FILES.indexOf(m[2])
      const dr = Number(m[3]) - 1
      if (dr !== from.rank || Math.sign(df - from.file) !== dir) continue
      const dest = occ.find((o) => o.file === df && o.rank === dr)
      if (dest && dest.color === mover.color && dest.type === 'r') return m
    }
  }
  return null
}

export function checkersDragMove(
  legal: readonly string[],
  n: number,
  from: TabletopPos,
  to: TabletopPos
): string | null {
  const fromSq = checkersSquareOf(from, n)
  const toSq = checkersSquareOf(to, n)
  if (fromSq === null || toSq === null) return null
  for (const m of legal) {
    const steps = m.split(/[x-]/).map(Number)
    if (steps[0] === fromSq && steps[steps.length - 1] === toSq) return m
  }
  return null
}

// ---------------------------------------------------------------------------

export interface GameBoard3DProps extends GameBoardProps {
  /** WebGL missing / lost / no provider. The host swaps back to the 2D board. */
  onUnavailable?(reason: string): void
  /** Replay Theater directive ref: passed through to Tabletop3D (cinematic
   *  rig). The bridge stamps `directive.shot` on every state commit, deriving
   *  the action square from the occupancy diff (see games/three/theater.ts). */
  theater?: { current: TheaterDirective }
  /** Theater playback tells the bridge what the LAST committed move was
   *  (capture flag from spec.moveMeta); ply −1/0 = start position, no shot. */
  theaterShot?: { ply: number; capture: boolean } | null
  /** Fires once with the live WebGL canvas (theater export records it). */
  onCanvasReady?(canvas: HTMLCanvasElement): void
}

export default function GameBoard3D({
  kind,
  state,
  orientation,
  interactive,
  onMove,
  onAction,
  onUnavailable,
  theater,
  theaterShot,
  onCanvasReady
}: GameBoard3DProps): JSX.Element {
  const spec = getGame(kind)!.spec
  const isChessFamily = spec.family === 'chess'

  // Headless-verification hook (same contract as Three3DDemo): hidden tabs get
  // no rAF, so automated checks force frames via window.__tabletopAdvance.
  useEffect(() => {
    const w = window as unknown as { __tabletopAdvance?: (t: number) => void }
    w.__tabletopAdvance = (t) => advance(t, true)
    return () => {
      delete w.__tabletopAdvance
    }
  }, [])

  // Non-chess 2D boards self-sound (chess-family views own theirs), mirror it.
  useBoardSound(kind, isChessFamily ? null : state)

  const goSpec = kind === 'go' ? (spec as unknown as GoSpec) : null
  const scoring = goSpec !== null && state !== null && goSpec.isScoringPhase(state as GoState)

  const size =
    kind === 'go' || kind === 'gomoku'
      ? ((state as GoState | GomokuState | null)?.size ?? spec.board.files)
      : spec.board.files

  const board: TabletopBoardShape = useMemo(() => {
    if (kind === 'connect4') return { layout: 'holes', files: 7, ranks: 6 }
    if (kind === 'go' || kind === 'gomoku') return { layout: 'intersections', files: size, ranks: size }
    return { layout: spec.board.layout, files: spec.board.files, ranks: spec.board.ranks }
  }, [kind, spec, size])

  const occ = useMemo(() => occupancyOf(kind, state, scoring), [kind, state, scoring])

  // Stable piece identities across state diffs (reset on restart/size change).
  const trackRef = useRef<{ sig: string; movesLen: number; pieces: TabletopPiece[]; n: number }>({
    sig: '',
    movesLen: 0,
    pieces: [],
    n: 0
  })
  const pieces = useMemo(() => {
    const t = trackRef.current
    const movesLen = (((state ?? {}) as { moves?: readonly string[] }).moves ?? []).length
    const sig = `${kind}|${size}`
    const fresh = sig !== t.sig || movesLen < t.movesLen
    const nextId = (): string => `p${++trackRef.current.n}`
    const next = fresh
      ? occ.map((o) => ({ id: nextId(), pos: { file: o.file, rank: o.rank }, type: o.type, color: o.color }))
      : reconcile(t.pieces, occ, kind === 'othello', nextId)
    trackRef.current = { sig, movesLen, pieces: next, n: trackRef.current.n }
    return next
  }, [occ, kind, size, state])

  // Theater choreography: on every committed ply, derive the action square
  // from the occupancy diff and stamp the directive's shot. TheaterRig frames
  // it (and slow-mos captures) from there. Scrubs work too: any state diff has
  // a centroid. Ply ≤ 0 (start position) clears the shot.
  const shotTrack = useRef<{ ply: number; occ: OccPiece[] }>({ ply: 0, occ: [] })
  useEffect(() => {
    if (!theater) return
    const prev = shotTrack.current
    const ply = theaterShot?.ply ?? 0
    if (ply !== prev.ply) {
      theater.current.shot =
        ply <= 0
          ? null
          : {
              atMs: performance.now(),
              capture: theaterShot?.capture === true,
              focus: diffFocus(prev.occ, occ)
            }
    }
    shotTrack.current = { ply, occ }
  }, [theater, theaterShot, occ])

  const onSquareClick = useCallback(
    (pos: TabletopPos): void => {
      if (kind === 'go' && scoring) {
        onAction?.(`markdead ${pointToVertex(size - 1 - pos.rank, pos.file, size)}`)
        return
      }
      if (PLACEMENT_KINDS.has(kind)) {
        const move = placementMove(kind, pos, size)
        if (move) onMove(move)
      }
    },
    [kind, scoring, size, onMove, onAction]
  )

  const onPieceDrag = useCallback(
    (_pieceId: string, from: TabletopPos, to: TabletopPos): void => {
      let legal: readonly string[] = []
      try {
        legal = spec.legalMoves(state)
      } catch {
        return
      }
      const move = isChessFamily
        ? chessDragMove(legal, occ, from, to)
        : kind === 'checkers' || kind === 'checkers-intl'
          ? checkersDragMove(legal, spec.board.files, from, to)
          : null
      if (move) onMove(move)
    },
    [spec, state, occ, kind, isChessFamily, onMove]
  )

  const draggable = isChessFamily || kind === 'checkers' || kind === 'checkers-intl'
  const score = scoring ? scoreDetail(state as GoState) : null

  return (
    <div className="b3d-wrap">
      <Tabletop3D
        kind={kind}
        board={board}
        pieces={pieces}
        orientation={orientation}
        interactive={interactive}
        onSquareClick={onSquareClick}
        onPieceDrag={draggable ? onPieceDrag : undefined}
        onUnavailable={onUnavailable}
        theater={theater}
        onCanvasReady={onCanvasReady}
        className="b3d-canvas"
      />
      {scoring && (
        <div className="b3d-scoring" role="status">
          <span>
            Scoring: tap dead groups
            {score ? ` · Black ${score.black} · White ${score.white}` : ''}
          </span>
          {onAction && (
            <button type="button" className="b3d-scoring-btn" onClick={() => onAction('finalize')}>
              Finalize score
            </button>
          )}
        </div>
      )}
    </div>
  )
}
