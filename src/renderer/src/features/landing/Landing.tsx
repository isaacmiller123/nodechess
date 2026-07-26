import { useCallback, useMemo, useRef, useState, type JSX } from 'react'
import Logo from '../../components/Logo'
import LatticeDemo from './LatticeDemo'
import OfflineDemo from './OfflineDemo'
import { OFFERS, detectPlatform, offerFor, type PlatformOffer } from './downloads'
import './landing.css'

/* THE LANDING PAGE. Web only, shown once, before the app.
   Self contained: this module and its two figures draw everything they need
   and fetch nothing, so the page is as offline as the thing it describes.

   It does not decide when it appears. It takes one prop, and it calls it when
   the visitor wants to be in the app.

   Every number on this page was read out of the repository first. There is
   nothing here that is not true of the shipped program. */

/** The rows under "What is in it". */
const FACTS: readonly { name: string; value: string; note: string }[] = [
  {
    name: 'Puzzles',
    value: '4,699,980',
    note: 'Lichess puzzles, rated and themed'
  },
  { name: 'School', value: '40 chapters', note: 'Beginner up to 2000' },
  { name: 'Games', value: '23', note: 'Chess, its variants, go, shogi, checkers and more' },
  { name: 'Engine', value: 'Stockfish', note: 'Bundled, runs on your own machine' },
  { name: 'Opponents', value: 'People or the engine', note: 'Online when you want it' }
]

/* The rows under "How it is different". No mechanism, only consequence.

   These deliberately do NOT repeat the two sections above them. "It runs on
   your machine" and "it works offline" have already been said once in words and
   shown twice in a diagram, and saying them a third time here read as a page
   with one idea. What is left is what a player actually notices in use: nothing
   is rationed, the engine is theirs, the parts know about each other, and the
   account is not an email address. */
const DIFFERS: readonly { name: string; line: string }[] = [
  {
    name: 'Nothing is rationed',
    line: 'No daily puzzle cap, no analysis quota, no queue for a server with something better to do. The only limit is the machine you are sitting at.'
  },
  {
    name: 'The engine is yours, at full strength',
    line: 'Stockfish runs on your own cores, as deep as you care to ask. It is not a weaker instance handed out to a free tier, and nobody else is waiting on it.'
  },
  {
    name: 'The parts know about each other',
    line: 'A game you lose becomes the puzzle you get, the opening you keep misplaying becomes the chapter it opens next. Play, puzzles, school, openings and analysis are one program, not five that share a login.'
  },
  {
    name: 'The account is twenty four words',
    line: 'No email, no password, and so no reset link and nothing to leak. You keep the words, and they are what signs you in on the next device.'
  }
]

export default function Landing({ onEnter }: { onEnter: () => void }): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const getRef = useRef<HTMLElement | null>(null)

  /* Read once. The visitor's platform does not change while they read. */
  const lead: PlatformOffer = useMemo(() => offerFor(detectPlatform()), [])

  const toDownloads = useCallback(() => {
    getRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div className="lp">
      <div className="lp-inner">
        {/* ---- masthead ---- */}
        <header className="lp-hero">
          <div className="lp-hero-text">
            <h1 className="lp-word">
              <span className="nc-word">
                <span className="nc-word-a">node</span>
                <span className="nc-word-b">chess</span>
              </span>
            </h1>
            <p className="lp-lede">
              Chess that lives on your machine. It plays, it teaches, it sets you puzzles and it
              takes your games apart afterwards, and it goes on doing all of that when the network
              does not.
            </p>
            <div className="lp-acts">
              <button className="btn is-primary" type="button" onClick={onEnter}>
                Open it in this browser
              </button>
              <button className="btn" type="button" onClick={toDownloads}>
                Get the desktop app
              </button>
            </div>
            <div className="chips lp-hero-chips">
              <span className="chip">Offline first</span>
              <span className="chip">Nothing to sign up for</span>
            </div>
          </div>

          {/* The mark, large, with both motions on: it waves as a whole when the
              pointer is over it and ripples out from wherever the pointer is. */}
          <div className="lp-hero-mark">
            <Logo size={280} variant="lattice" motion="both" title="nodechess" />
          </div>
        </header>

        {/* ---- what it is ---- */}
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">What is in it</h2>
            <span className="sec-count">{FACTS.length} things</span>
          </div>
          <p className="sec-note">
            The desktop build carries all of it on the disk. In the browser it arrives as you use
            it, and stays.
          </p>
          <div className="panel facts">
            {FACTS.map((f) => (
              <div className="fact" key={f.name}>
                <span className="lbl">{f.name}</span>
                <span className="fact-value">
                  {f.value}
                  <span className="fact-note">{f.note}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ---- the shape of the thing ---- */}
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">How it is put together</h2>
            <span className="sec-count">Take it apart</span>
          </div>
          <p className="sec-note">
            There is no middle. Every node holds the whole picture, so a change made at one of them
            reaches the others by whatever route is open. Drag a node and the field flexes, then
            snaps back. Press one to take it out, or press a link to cut it, and watch what was
            going through it go round. Send a change between two nodes and it finds the shortest
            way still open. Cut enough and the field splits, and it will tell you so.
          </p>
          <LatticeDemo />
        </section>

        {/* ---- offline ---- */}
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">With the network gone</h2>
            <span className="sec-count">Cut it and see</span>
          </div>
          <p className="sec-note">
            A game does not stop because the connection did. It keeps taking your moves, and when
            the connection comes back the moves go out.
          </p>
          <OfflineDemo />
        </section>

        {/* ---- how it differs ---- */}
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">How it is different</h2>
          </div>
          <div className="panel lp-list">
            {DIFFERS.map((d) => (
              <div className="row lp-diff" key={d.name}>
                <span className="lp-diff-name">{d.name}</span>
                <p className="lp-diff-line">{d.line}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- the download ---- */}
        <section className="sec" ref={getRef}>
          <div className="sec-head">
            <h2 className="lbl">Get the desktop app</h2>
            <span className="sec-count">{lead.name}</span>
          </div>

          <div className="panel lp-get">
            <div>
              <div className="lp-get-name">
                {lead.href ? `nodechess for ${lead.name}` : lead.note}
                {lead.href ? null : <span className="tag">soon</span>}
              </div>
              <div className="lp-get-note">
                {lead.href
                  ? lead.note
                  : 'The desktop app runs on macOS, Windows and Linux today.'}
              </div>
            </div>
            {lead.href ? (
              <a className="btn is-primary" href={lead.href} target="_blank" rel="noreferrer">
                Download for {lead.name}
              </a>
            ) : (
              <button className="btn is-primary" type="button" onClick={onEnter}>
                Open it in this browser
              </button>
            )}
          </div>

          <div className="lp-more">
            <button
              className="btn is-quiet"
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? 'Hide other downloads' : 'Other downloads'}
            </button>
          </div>

          {showAll ? (
            <div className="panel golist lp-all">
              {OFFERS.map((o) => (
                <div className="go lp-offer" key={o.id}>
                  <span>
                    <span className="go-name">{o.name}</span>
                    <span className="go-sub">{o.note}</span>
                  </span>
                  {o.href ? (
                    <a className="btn" href={o.href} target="_blank" rel="noreferrer">
                      Download
                    </a>
                  ) : (
                    <span className="tag">soon</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {/* ---- foot ---- */}
        <footer className="lp-foot">
          <span className="nc-lockup nc-lockup-sm">
            <Logo size={22} variant="lattice" motion="wave" title="nodechess" />
            <span className="nc-word">
              <span className="nc-word-a">node</span>
              <span className="nc-word-b">chess</span>
            </span>
          </span>
          <button className="btn is-primary" type="button" onClick={onEnter}>
            Open it in this browser
          </button>
        </footer>
      </div>
    </div>
  )
}
