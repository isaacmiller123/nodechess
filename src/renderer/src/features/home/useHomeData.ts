import { useEffect, useState } from 'react'
import type {
  DailyStreak,
  DatasetStatus,
  GameRow,
  ProgressSummary,
  SchoolChapterMeta,
  SchoolMastery
} from '../../../../shared/types'

export interface HomeData {
  summary: ProgressSummary | null
  games: GameRow[]
  chapters: SchoolChapterMeta[]
  mastery: SchoolMastery | null
  /** What is actually on disk. Null until the probe answers, so a row stays
   *  quiet rather than announcing an absence nobody has looked for yet. */
  datasets: DatasetStatus | null
  dailyStreak: DailyStreak | null
}

export interface UseHomeDataResult {
  data: HomeData
  loading: boolean
}

const EMPTY: HomeData = {
  summary: null,
  games: [],
  chapters: [],
  mastery: null,
  datasets: null,
  dailyStreak: null
}

/**
 * Everything Home reads, in one round of parallel calls: the progress summary,
 * the newest games, the curriculum tree, what datasets are installed, and the
 * daily-puzzle streak. Promise.allSettled so one unavailable channel costs its
 * own line and nothing else. Tolerates window.api being undefined.
 */
export function useHomeData(): UseHomeDataResult {
  const [data, setData] = useState<HomeData>(EMPTY)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api) {
      setLoading(false)
      return
    }

    void (async () => {
      const [summaryR, gamesR, chaptersR, masteryR, datasetsR, streakR] = await Promise.allSettled([
        api.progress.summary(),
        api.games.list({ limit: 5 }),
        api.school?.chapters?.() ?? Promise.resolve({ chapters: [] }),
        api.school?.mastery?.() ?? Promise.resolve(null),
        api.datasets?.status?.() ?? Promise.resolve(null),
        api.puzzles?.dailyStreak?.() ?? Promise.resolve(null)
      ])
      if (cancelled) return

      setData({
        summary: summaryR.status === 'fulfilled' ? summaryR.value : null,
        games: gamesR.status === 'fulfilled' ? (gamesR.value.games ?? []) : [],
        chapters: chaptersR.status === 'fulfilled' ? (chaptersR.value.chapters ?? []) : [],
        mastery: masteryR.status === 'fulfilled' ? masteryR.value : null,
        datasets: datasetsR.status === 'fulfilled' ? datasetsR.value : null,
        dailyStreak: streakR.status === 'fulfilled' ? (streakR.value?.streak ?? null) : null
      })
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return { data, loading }
}
