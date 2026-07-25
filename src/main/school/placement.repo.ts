import { getAppDb } from '../db/database'
import { estimateElo } from '../analysis/estElo'
import type { PlacementState, PlacementGameResult } from '../../shared/types'

// School placement persistence. A single-row store (school_placement, id=1) holds
// the user's INTERNAL estimated Elo: it gates which chapters unlock and is NEVER
// shown to the user. Each finished placement game (accuracy vs a fixed calibration
// engine level) is appended to placement_game and the converged estimate is the
// inverse-variance blend of every game's band, so a second game narrows (or
// corrects) the first. The estimate may move DOWN as well as up. It is overwritten,
// not Math.max'd, so a chapter-test pass or a weak game can re-place the user.
//
// Kept deliberately SEPARATE from the Glicko `rating` table (puzzle/vs-bot): that is
// a public rating; this is an internal teaching gate.

/** The fixed engine level placement games are played against. Accuracy is measured
 *  vs the analysis engine's best move (independent of opponent strength), so a
 *  single calibration level keeps placement simple and within engine.play's
 *  uciElo>=1320 floor (see memory: engine.play silently rejects weaker).
 *  Label integrity: 1500 >= ENGINE_ELO_FLOOR is a NATIVE UCI_Elo level, so
 *  ratings/botStrength.measuredElo({kind:'engine', elo:1500}) === 1500. The
 *  label needs no sub-floor correction (the mislabeled bands are all <1320).
 *  The Elo estimate itself comes from estimateElo(accuracy, moveCount), which
 *  is opponent-independent; recalibrations of that estimator flow through here
 *  transparently. */
export const PLACEMENT_ENGINE_ELO = 1500

interface PlacementRow {
  placed: number
  estimated_elo: number | null
  est_low: number | null
  est_high: number | null
}
interface GameRow {
  engine_elo: number
  accuracy: number
  move_count: number
  est: number
  low: number
  high: number
}

function gameRows(): PlacementGameResult[] {
  const db = getAppDb()
  const rows = db
    .prepare(
      'SELECT engine_elo, accuracy, move_count, est, low, high FROM placement_game ORDER BY created_at ASC'
    )
    .all() as unknown as GameRow[]
  return rows.map((r) => ({
    engineElo: r.engine_elo,
    accuracy: r.accuracy,
    moveCount: r.move_count,
    band: { est: r.est, low: r.low, high: r.high, accuracy: r.accuracy, kind: 'estimate' }
  }))
}

/** Representative accuracy to echo on the blended band: the same inverse-variance
 *  weights the estimate blend uses (a tighter game weighs more; see
 *  recordPlacementGame), so the accuracy shown with the estimate tracks how the
 *  estimate itself was formed. 0 only when no games exist. */
function blendedAccuracy(games: PlacementGameResult[]): number {
  let wSum = 0
  let wAcc = 0
  for (const g of games) {
    const half = Math.max(1, (g.band.high - g.band.low) / 2)
    const w = 1 / (half * half)
    wSum += w
    wAcc += w * g.band.accuracy
  }
  return wSum > 0 ? Math.round((wAcc / wSum) * 10) / 10 : 0
}

/** Current placement/unlock state. placed=false ⇒ everything is locked. */
export function getPlacementState(): PlacementState {
  const db = getAppDb()
  const row = db
    .prepare('SELECT placed, estimated_elo, est_low, est_high FROM school_placement WHERE id=1')
    .get() as unknown as PlacementRow | undefined
  const games = gameRows()
  const placed = (row?.placed ?? 0) === 1
  const est = row?.estimated_elo ?? null
  return {
    placed,
    estimatedElo: est,
    band:
      est != null
        ? {
            est,
            low: row?.est_low ?? est,
            high: row?.est_high ?? est,
            accuracy: blendedAccuracy(games),
            kind: 'estimate'
          }
        : null,
    games
  }
}

/**
 * Record one finished placement game and return the converged state. The new
 * estimate is the inverse-variance blend of every game's band (a tighter band ⇒
 * more weight), so each extra game sharpens the estimate.
 */
export function recordPlacementGame(
  engineElo: number,
  accuracy: number,
  moveCount: number
): PlacementState {
  const db = getAppDb()
  const band = estimateElo(accuracy, moveCount)
  const now = Date.now()
  db.prepare(
    `INSERT INTO placement_game(engine_elo, accuracy, move_count, est, low, high, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(engineElo, accuracy, moveCount, band.est, band.low, band.high, now)

  // Inverse-variance blend across all games (halfWidth as the std proxy).
  const games = gameRows()
  let wSum = 0
  let wEst = 0
  for (const g of games) {
    const half = Math.max(1, (g.band.high - g.band.low) / 2)
    const w = 1 / (half * half)
    wSum += w
    wEst += w * g.band.est
  }
  const est = Math.round(wEst / wSum)
  const halfWidth = Math.round(Math.sqrt(1 / wSum))
  const low = est - halfWidth
  const high = est + halfWidth

  db.prepare(
    `UPDATE school_placement
       SET placed=1, estimated_elo=?, est_low=?, est_high=?, updated_at=?
     WHERE id=1`
  ).run(est, low, high, now)

  return getPlacementState()
}

/**
 * Set the internal estimate directly (used by a chapter-test pass to correct a
 * mis-placement: bump the estimate to at least `floorElo` so that chapter's band
 * unlocks). Only ever raises; never lowers (a pass shouldn't demote).
 */
export function bumpPlacementFloor(floorElo: number): void {
  const db = getAppDb()
  const row = db
    .prepare('SELECT placed, estimated_elo FROM school_placement WHERE id=1')
    .get() as unknown as { placed: number; estimated_elo: number | null } | undefined
  // Only meaningful once placed; a pass before placement is ignored.
  if ((row?.placed ?? 0) !== 1) return
  const cur = row?.estimated_elo ?? 0
  if (floorElo <= cur) return
  db.prepare(
    'UPDATE school_placement SET estimated_elo=?, est_high=MAX(est_high, ?), updated_at=? WHERE id=1'
  ).run(floorElo, floorElo, Date.now())
}

/**
 * Clear placement (re-locks everything; the user re-places from scratch). Also
 * retracts the previous placement's OWN progress writes in the same transaction:
 * chapter_progress / lesson_progress rows carrying auto_completed=1 were
 * bulk-written by bulkCompleteChapters, not earned, so leaving them would let a
 * lower re-placement inherit stale 'Done' chapters that chain the progression
 * unlock upward (and hide them from pickDailyLesson). Manually earned rows
 * (auto_completed=0) and chapter_test history always survive. A reset must NEVER
 * destroy what the learner genuinely earned (spec §1 never says re-placement
 * wipes progress; it only re-derives the Elo gate). The re-place-LOWER hazard
 * that leaves, a surviving earned completion ABOVE the fresh estimate chaining
 * its successor open, is closed on the READ side instead:
 * school.repo.chapterMetas only chain-unlocks from a cleared chapter whose band
 * is within the CURRENT estimate, so stale above-estimate earned rows read as
 * history (best_pct, completed badges) but never as an unlock link. Direct SQL
 * on the mastery tables here: importing mastery.repo would create the
 * placement→mastery→school→placement cycle (same reason school.repo.chapterMetas
 * reads progress directly).
 */
export function resetPlacement(): PlacementState {
  const db = getAppDb()
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM chapter_progress WHERE auto_completed=1')
    db.exec('DELETE FROM lesson_progress WHERE auto_completed=1')
    db.exec('DELETE FROM placement_game')
    db.prepare(
      'UPDATE school_placement SET placed=0, estimated_elo=NULL, est_low=NULL, est_high=NULL, updated_at=? WHERE id=1'
    ).run(Date.now())
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return getPlacementState()
}
