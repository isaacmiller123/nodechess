import { useEffect, useState } from 'react'
import type { ProgressSummary } from '../../../shared/types'
import { useAccountsUi } from '../features/account/mock/store'

/** rd at or above this is a rating the app does not yet trust. Same threshold
 *  StrengthCard and RatingCard use; kept in step with them deliberately, since
 *  three surfaces disagreeing about whether a rating is provisional is worse
 *  than any one of them being wrong. */
const PROVISIONAL_RD = 110

export interface Readout {
  /** 'mercer#K4T9P' when there is an account, else null. Never invented. */
  handle: string | null
  rating: number | null
  provisional: boolean
  games: number | null
  loading: boolean
}

/**
 * The four things the readout strip reports, on every screen.
 *
 * v1 draws PLAYER / RATING / GAMES / NEXT as the header of the content column
 * on all ten pages, so it is the shell's data, not any one view's. Everything
 * here is real or absent: a signed-out player has no handle and gets none, and
 * a summary that has not loaded reports nothing rather than a zero that would
 * read as "you have played no games".
 *
 * RATING is the vs-bot ladder, not the puzzle ladder, because it sits beside
 * GAMES and the two have to describe the same activity. The puzzle rating is
 * reported on the puzzles screen, where it is what you are doing.
 */
export function useReadout(): Readout {
  const ui = useAccountsUi()
  const [summary, setSummary] = useState<ProgressSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const api = window.api
    if (!api?.progress) {
      setLoading(false)
      return
    }
    api.progress
      .summary()
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch(() => {
        /* One unavailable channel reports nothing, it does not break the shell. */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return {
    handle: ui.signedIn ? (ui.account?.handle ?? null) : null,
    rating: summary ? Math.round(summary.vsBotRating) : null,
    provisional: summary ? summary.vsBotRd >= PROVISIONAL_RD || summary.vsBotRd <= 0 : false,
    games: summary ? summary.gamesPlayed : null,
    loading
  }
}
