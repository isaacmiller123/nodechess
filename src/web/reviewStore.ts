// The ReviewStore (web port W3 — build contract AGENT-CLIENT).
//
// The W2 engine layer computes reviews CLIENT-side (src/web/engines) and
// persists through the ReviewStore seam its contract file defines. There is
// exactly one implementation now that the web build is static: localStorage,
// LRU-capped at 40 reviews (reviews are the biggest client payload — tens of KB
// of move evals per game; 40 keeps well under quota, and on a quota error the
// tail is evicted until the write fits).

import type { GameReview } from '@shared/types'
import type { ReviewStore } from './engines'
import { setLocalGameAccuracy, storageGet, storageRemove, storageSet } from './localData'

// Pre-rebrand prefix, kept for the same reason as the keys in localData.ts:
// it addresses reviews already stored in users' browsers.
const REVIEWS_KEY = 'chess-sharp.reviews'
export const LOCAL_REVIEWS_CAP = 40

interface StoredReviews {
  /** Most-recently-used first. */
  order: number[]
  byGame: Record<string, GameReview>
}

function readReviews(): StoredReviews {
  const raw = storageGet(REVIEWS_KEY)
  if (!raw) return { order: [], byGame: {} }
  try {
    const p = JSON.parse(raw) as StoredReviews
    return {
      order: Array.isArray(p.order) ? p.order : [],
      byGame: p.byGame && typeof p.byGame === 'object' ? p.byGame : {}
    }
  } catch {
    return { order: [], byGame: {} }
  }
}

function evictTail(store: StoredReviews): void {
  const evicted = store.order.pop()
  if (evicted !== undefined) delete store.byGame[String(evicted)]
}

function localStorageWritable(): boolean {
  try {
    window.localStorage.setItem('chess-sharp.probe', '1')
    window.localStorage.removeItem('chess-sharp.probe')
    return true
  } catch {
    return false
  }
}

function writeReviews(store: StoredReviews): void {
  while (store.order.length > LOCAL_REVIEWS_CAP) evictTail(store)
  if (!localStorageWritable()) {
    // Private mode / storage disabled: session-lifetime memory fallback.
    storageSet(REVIEWS_KEY, JSON.stringify(store))
    return
  }
  // Quota-safe write: evict the LRU tail until the payload fits.
  for (;;) {
    try {
      window.localStorage.setItem(REVIEWS_KEY, JSON.stringify(store))
      return
    } catch {
      if (store.order.length === 0) return // nothing left to shed — drop the write
      evictTail(store)
    }
  }
}

function bumpToFront(store: StoredReviews, gameId: number): void {
  store.order = [gameId, ...store.order.filter((id) => id !== gameId)]
}

export const localReviewStore: ReviewStore = {
  async save(gameId, review) {
    // A pgn-only review (no stored game) has nothing to key a later lookup on;
    // the caller still gets the full review object back from review.run.
    if (gameId == null) return { reviewId: null }
    const store = readReviews()
    store.byGame[String(gameId)] = review
    bumpToFront(store, gameId)
    writeReviews(store)
    // Desktop parity (ipc/review.ipc.ts): a gameId review marks per-side
    // accuracy on the game row.
    setLocalGameAccuracy(gameId, review.white.accuracy, review.black.accuracy)
    return { reviewId: gameId }
  },

  async load(gameId) {
    const store = readReviews()
    const review = store.byGame[String(gameId)] ?? null
    if (review) {
      bumpToFront(store, gameId)
      writeReviews(store)
    }
    return { review, moveEvals: review?.moveEvals ?? [] }
  },

  async markAccuracy(gameId, white, black) {
    setLocalGameAccuracy(gameId, white, black)
  }
}

/** The store handed to createReviewApi/createPerfApi. */
export const reviewStore: ReviewStore = localReviewStore

/** app:resetProgress ('games' scope) wipes cached local reviews. */
export function clearLocalReviews(): void {
  storageRemove(REVIEWS_KEY)
}
