// Pure, React-free formatting helpers for Home.
import type { GameRow, SchoolChapterMeta, SchoolMastery } from '../../../../shared/types'

/**
 * Compact relative date. Returns '' for null/invalid so callers can skip
 * rendering an empty separator. Falls back to a short locale date past 7d.
 */
export function formatRelativeDate(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return ''
  const now = Date.now()
  const diff = now - ts
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

export type GameResultKind = 'win' | 'loss' | 'draw' | 'unknown'

/**
 * Map a stored game result ('1-0' | '0-1' | '1/2-1/2') against the user's color
 * into win/loss/draw. Anything unexpected -> 'unknown' (neutral word, no crash).
 */
export function resultKind(game: Pick<GameRow, 'result' | 'user_color'>): GameResultKind {
  const r = game.result
  if (r === '1/2-1/2') return 'draw'
  const color = game.user_color
  if ((r === '1-0' || r === '0-1') && (color === 'white' || color === 'black')) {
    const userWon = (r === '1-0' && color === 'white') || (r === '0-1' && color === 'black')
    return userWon ? 'win' : 'loss'
  }
  return 'unknown'
}

/** The word in the Result column. */
export function resultChipLabel(kind: GameResultKind): string {
  switch (kind) {
    case 'win':
      return 'Win'
    case 'loss':
      return 'Loss'
    case 'draw':
      return 'Draw'
    default:
      return '·'
  }
}

/**
 * Best available human label for the opponent: explicit label, else
 * "Bot {elo}", else the non-user side's name, else 'Opponent'.
 */
export function opponentLabelOf(game: GameRow): string {
  if (game.opponent_label && game.opponent_label.trim()) return game.opponent_label.trim()
  if (game.opponent_elo != null && Number.isFinite(game.opponent_elo)) {
    return `Bot ${Math.round(game.opponent_elo)}`
  }
  const userColor = game.user_color
  const other =
    userColor === 'white' ? game.black_name : userColor === 'black' ? game.white_name : null
  if (other && other.trim()) return other.trim()
  return 'Opponent'
}

/**
 * Full moves in a stored game, for the Moves column.
 *
 * The `game` table has no ply column, so this number has to come out of the
 * PGN. The exact answer is a chessops replay, which would pull the whole move
 * parser into the eagerly loaded Home bundle to fill five table cells. Counting
 * SAN tokens is exact for what is actually stored: games.repo.listGames returns
 * game_kind 'chess' only, and only plain chess archives real SAN PGN (online
 * variants archive the wire codec and never appear in this list).
 *
 * Null when nothing countable is there, so the cell stays empty instead of
 * claiming a game had zero moves.
 */
export function moveCountOf(pgn: string | null | undefined): number | null {
  if (!pgn) return null
  const movetext = pgn
    .replace(/\[[^\]]*\]/g, ' ') // headers
    .replace(/\{[^}]*\}/g, ' ') // brace comments
    .replace(/;[^\n]*/g, ' ') // rest-of-line comments
    .replace(/\([^)]*\)/g, ' ') // variations
    .replace(/\$\d+/g, ' ') // NAGs
    .replace(/\d+\.(\.\.)?/g, ' ') // move numbers, both dot forms
    .replace(/1-0|0-1|1\/2-1\/2|\*/g, ' ') // the result token
  const plies = movetext.split(/\s+/).filter((t) => /^[a-hKQRBNO]/.test(t)).length
  return plies > 0 ? Math.ceil(plies / 2) : null
}

/** Chapter ordinals read as 01..40 everywhere in School. */
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The School row's sub-line: where the learner actually is in the curriculum.
 *
 * v1 draws one static "CH 07, LESSON 3 OF 5", which assumes a placed learner
 * part way through a chapter. Three other states are just as real and each gets
 * its own line, because a zeroed position on an unplaced account would be a
 * lie about progress that does not exist. Null when the curriculum did not
 * load at all, so the row can go without a sub-line rather than guess.
 */
export function schoolGoLine(
  chapters: SchoolChapterMeta[],
  mastery: SchoolMastery | null
): string | null {
  if (!chapters || chapters.length === 0) return null
  const prog = new Map((mastery?.chapters ?? []).map((c) => [c.chapterId, c]))
  // New-model chapters record per-lesson completion (mastery.lessons) and may
  // never bump segmentsDone: a chapter with any lesson done is also in progress.
  const lessonStarted = new Set((mastery?.lessons ?? []).map((l) => l.chapterId))
  const ordered = [...chapters].sort((a, b) => a.order - b.order)

  // Everything locked means placement has not been played. There is no chapter
  // to name, so the line names the one thing that opens all of them.
  if (!ordered.some((c) => !c.locked)) return 'TAKE YOUR PLACEMENT GAME'

  const unfinished = ordered.filter((c) => !c.locked && !prog.get(c.id)?.completed)
  const current =
    unfinished.find(
      (c) => (prog.get(c.id)?.segmentsDone ?? 0) > 0 || lessonStarted.has(c.id)
    ) ?? unfinished[0]
  if (!current) return 'EVERY UNLOCKED CHAPTER DONE'

  const total = current.lessonCount ?? 0
  if (total <= 0) return `CH ${pad(current.order)}`
  const done = (mastery?.lessons ?? []).filter((l) => l.chapterId === current.id).length
  return `CH ${pad(current.order)}, LESSON ${Math.min(done + 1, total)} OF ${total}`
}
