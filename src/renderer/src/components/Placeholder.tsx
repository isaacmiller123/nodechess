import type { ViewKey } from './Layout'

const COPY: Partial<Record<ViewKey, { title: string; body: string }>> = {
  home: {
    title: 'Home dashboard',
    body: 'Your progress at a glance, recent games, and continue-where-you-left-off across play, puzzles, and the School.'
  },
  play: {
    title: 'Play',
    body: 'Play Stockfish at any Elo, plus grandmaster-style personas (their openings + a style-matched engine).'
  },
  puzzles: {
    title: 'Puzzles',
    body: '4.7M bundled Lichess puzzles with a local Glicko-2 rating and spaced-repetition review.'
  },
  openings: {
    title: 'Openings',
    body: 'An offline opening explorer with names, ECO codes, and your own repertoire.'
  },
  progress: {
    title: 'Progress',
    body: 'Both ratings (kept distinct), accuracy trends, and your full game history.'
  }
}

export function Placeholder({ view }: { view: ViewKey }) {
  const c = COPY[view] ?? { title: 'Coming soon', body: '' }
  const headingId = `placeholder-${view}`
  return (
    <div className="placeholder">
      <section className="card" role="region" aria-labelledby={headingId}>
        <h2 id={headingId}>{c.title}</h2>
        {c.body && <p className="muted">{c.body}</p>}
        <p className="muted small">
          Under construction in the current build loop.
        </p>
      </section>
    </div>
  )
}
