import { UserAvatar, EngineAvatar } from '../../components/Avatar'
import type { Color } from '../../chess/chess'
import { PieceIcon } from '../../board/PieceIcon'
import { Clock, type ClockInterp } from './Clock'

/* ---------------------------------------------------------------------------
   Captured-material model — pure helpers, derived from the current FEN alone
   (standard-start baseline). Kept in this file per the play-UI contract.
   --------------------------------------------------------------------------- */

type CapturedRole = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen'

const ROLE_ORDER: CapturedRole[] = ['pawn', 'knight', 'bishop', 'rook', 'queen']
const ROLE_VALUE: Record<CapturedRole, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 }
const ROLE_START: Record<CapturedRole, number> = { pawn: 8, knight: 2, bishop: 2, rook: 2, queen: 1 }
/** Captured-piece icon edge (px): matches the row's 16px min-height in play.css
 *  so the first capture never makes the card jump. */
const CAPTURED_PIECE_PX = 16
const CHAR_ROLE: Record<string, CapturedRole> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen'
}

export interface MaterialSummary {
  /** Opponent pieces this side has won so far (display order pawns → queen). */
  captured: { role: CapturedRole; count: number }[]
  /** Material points this side is AHEAD by; 0 when level or behind. */
  lead: number
}

/**
 * Captured pieces + material lead for one side, computed from the current FEN
 * against the standard starting set. Missing-piece counts clamp at zero so a
 * promotion (e.g. a second queen) never yields negative captures, while the
 * point lead is read from the material actually on the board, so promotions
 * still swing it correctly.
 */
export function materialSummary(fen: string, color: Color): MaterialSummary {
  const board = fen.split(' ')[0] ?? ''
  const count: Record<Color, Record<CapturedRole, number>> = {
    white: { pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0 },
    black: { pawn: 0, knight: 0, bishop: 0, rook: 0, queen: 0 }
  }
  for (const ch of board) {
    const role = CHAR_ROLE[ch.toLowerCase()]
    if (!role) continue // digits, '/', kings
    count[ch === ch.toLowerCase() ? 'black' : 'white'][role] += 1
  }
  const opp: Color = color === 'white' ? 'black' : 'white'
  const captured = ROLE_ORDER.map((role) => ({
    role,
    count: Math.max(0, ROLE_START[role] - count[opp][role])
  })).filter((entry) => entry.count > 0)
  let points = 0
  for (const role of ROLE_ORDER) {
    points += ROLE_VALUE[role] * (count[color][role] - count[opp][role])
  }
  return { captured, lead: Math.max(0, points) }
}

/** Readable summary for assistive tech, e.g. "captured 2 pawns, 1 knight, up 2". */
function capturedAriaLabel(material: MaterialSummary): string {
  if (material.captured.length === 0 && material.lead === 0) return 'No captures'
  const parts = material.captured.map(({ role, count }) => `${count} ${role}${count > 1 ? 's' : ''}`)
  const capturedText = parts.length > 0 ? `Captured ${parts.join(', ')}` : 'No captures'
  return material.lead > 0 ? `${capturedText}, up ${material.lead}` : capturedText
}

/* ---------------------------------------------------------------------------
   Player card
   --------------------------------------------------------------------------- */

/** Clock data rendered inside the card (chess.com style). Null hides the clock. */
export interface ChipClock {
  ms: number
  active: boolean
  over: boolean
  /** ONLINE path: authoritative snapshot the Clock self-ticks from (Clock.tsx). */
  interp?: ClockInterp
  /** ONLINE path: one-shot low-time hook, forwarded to the Clock. */
  onLowTime?: () => void
}

export interface PlayerChipProps {
  kind: 'user' | 'engine'
  name: string
  /** Sub-label next to the name, e.g. the engine's Elo or a persona's peak Elo. */
  sub?: string
  /** Optional secondary line under the name, e.g. "in the style of …". */
  styleLine?: string
  /** User avatar data URL (ignored for the engine chip). */
  avatar?: string | null
  /** Persona portrait data URI (engine chip). Falls back to the engine avatar. */
  photo?: string | null
  /** Engine chip shows an animated thinking indicator when true. */
  thinking?: boolean
  /** Long bot allocation (>= ~8s): the indicator gains a quiet
   *  "thinking deeply…" caption (the dots themselves are slowed/warmed by
   *  GameView's `.play-view.is-deepthink` rules in play.css). */
  deepThink?: boolean
  /** Current position FEN — drives the captured-pieces row + material badge. */
  fen?: string
  /** Which color this player commands (needed to attribute captures). */
  color?: Color
  /** True when it is this player's turn in the live game (active-turn glow). */
  active?: boolean
  /** Integrated countdown clock; omit/null for untimed games. */
  clock?: ChipClock | null
}

export function PlayerChip({
  kind,
  name,
  sub,
  styleLine,
  avatar = null,
  photo = null,
  thinking = false,
  deepThink = false,
  fen,
  color,
  active = false,
  clock = null
}: PlayerChipProps) {
  const material = fen !== undefined && color !== undefined ? materialSummary(fen, color) : null
  // Captured pieces are the OPPONENT's men this side has won, so they render
  // in the opponent's color (real piece-set artwork, chess.com style).
  const capturedColor: Color = color === 'white' ? 'black' : 'white'

  const avatarNode = photo ? (
    <img className="avatar chip-photo" src={photo} alt="" width={44} height={44} draggable={false} />
  ) : kind === 'user' ? (
    <UserAvatar src={avatar} name={name} size={44} />
  ) : (
    <EngineAvatar label={name} size={44} />
  )

  const className = ['player-chip', active ? 'is-active' : '', kind === 'engine' ? 'is-engine' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className}>
      {avatarNode}
      <div className="chip-meta">
        <div className="chip-name-row">
          <span className="chip-name" title={name}>
            {name}
          </span>
          {sub && <span className="chip-sub num">{sub}</span>}
          {thinking && (
            <span
              className={`chip-thinking${deepThink ? ' is-deep' : ''}`}
              role="status"
              aria-label={`${name} is thinking${deepThink ? ' deeply' : ''}`}
            >
              <span className="chip-dot" aria-hidden />
              <span className="chip-dot" aria-hidden />
              <span className="chip-dot" aria-hidden />
              {deepThink && (
                <span className="chip-think-label" aria-hidden>
                  thinking deeply…
                </span>
              )}
            </span>
          )}
        </div>
        {styleLine && <span className="chip-style">{styleLine}</span>}
        {material && (
          <div className="chip-captured" aria-label={capturedAriaLabel(material)}>
            {material.captured.map(({ role, count }) => (
              <span key={role} className="chip-captured-stack" aria-hidden>
                {Array.from({ length: count }, (_, i) => (
                  <PieceIcon key={i} role={role} color={capturedColor} size={CAPTURED_PIECE_PX} />
                ))}
              </span>
            ))}
            {material.lead > 0 && (
              <span className="chip-material num" aria-hidden>
                +{material.lead}
              </span>
            )}
          </div>
        )}
      </div>
      {clock && (
        <Clock
          ms={clock.ms}
          active={clock.active}
          over={clock.over}
          label={name}
          interp={clock.interp}
          onLowTime={clock.onLowTime}
        />
      )}
    </div>
  )
}
