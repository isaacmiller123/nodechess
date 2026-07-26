import { useCallback, useEffect, useState } from 'react'
import type {
  GameRow,
  ProgressSummary,
  PuzzleHistoryRow,
  PuzzleStats,
  RatingValue,
  SchoolChapterMeta,
  SchoolMastery
} from '../../../../shared/types'

export interface ProgressData {
  summary: ProgressSummary | null
  puzzleRating: RatingValue | null
  vsBotRating: RatingValue | null
  /**
   * A wider, recent window of games (newest-first) used for the analytics:
   * the accuracy bars, the strength track, the record and the runs. Capped at
   * TREND_WINDOW.
   */
  trendGames: GameRow[]
  /**
   * How many saved games the Recent games list can actually show. The summary's
   * gamesPlayed counts every kind in the archive (gomoku, go, imports); this is
   * the chess-only count the list is drawn from, so "5 of N" is true.
   */
  chessGames: number | null
  /** Aggregate + per-theme puzzle stats. Themes only cover tagged attempts. */
  puzzleStats: PuzzleStats | null
  /** Recent puzzle attempts, newest first: the only rating history that exists. */
  puzzleHistory: PuzzleHistoryRow[]
  chapters: SchoolChapterMeta[]
  mastery: SchoolMastery | null
}

const EMPTY: ProgressData = {
  summary: null,
  puzzleRating: null,
  vsBotRating: null,
  trendGames: [],
  chessGames: null,
  puzzleStats: null,
  puzzleHistory: [],
  chapters: [],
  mastery: null
}

/** Games fetched for the accuracy bars and the record (newest-first, capped). */
const TREND_WINDOW = 40

/** Attempts fetched for the puzzle rating track. 200 is the channel's ceiling. */
const HISTORY_WINDOW = 200

/**
 * Loads everything the page reads, in parallel. Uses Promise.allSettled so one
 * failing IPC channel degrades only its own section: a missing school payload
 * empties the School well and leaves the rating chart alone. Tolerates
 * window.api being undefined (browser preview) and unmount. `reload` re-runs
 * the fetch.
 */
export function useProgressData(): {
  data: ProgressData
  loading: boolean
  reload: () => void
} {
  const [data, setData] = useState<ProgressData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api) {
      setLoading(false)
      return
    }
    setLoading(true)

    void (async () => {
      const [summaryR, puzzleR, vsBotR, trendR, archiveR, statsR, historyR, chaptersR, masteryR] =
        await Promise.allSettled([
          api.progress.summary(),
          api.ratings.get('puzzle'),
          api.ratings.get('vs-bot'),
          api.games.list({ limit: TREND_WINDOW, offset: 0 }),
          // One row, for the per-kind counts that come back with it.
          api.games.listAll({ limit: 1, offset: 0 }),
          api.puzzles.stats(),
          api.puzzles.history({ limit: HISTORY_WINDOW, offset: 0 }),
          api.school.chapters(),
          api.school.mastery()
        ])
      if (cancelled) return

      const chessGames =
        archiveR.status === 'fulfilled'
          ? (archiveR.value.kinds ?? []).find((k) => k.kind === 'chess')?.count ?? 0
          : null

      setData({
        summary: summaryR.status === 'fulfilled' ? summaryR.value : null,
        puzzleRating: puzzleR.status === 'fulfilled' ? puzzleR.value : null,
        vsBotRating: vsBotR.status === 'fulfilled' ? vsBotR.value : null,
        trendGames: trendR.status === 'fulfilled' ? (trendR.value.games ?? []) : [],
        chessGames,
        puzzleStats: statsR.status === 'fulfilled' ? statsR.value : null,
        puzzleHistory: historyR.status === 'fulfilled' ? (historyR.value.rows ?? []) : [],
        chapters: chaptersR.status === 'fulfilled' ? (chaptersR.value.chapters ?? []) : [],
        mastery: masteryR.status === 'fulfilled' ? masteryR.value : null
      })
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [nonce])

  return { data, loading, reload }
}
