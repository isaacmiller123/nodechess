import { useCallback, useEffect, useRef, useState, type JSX } from 'react'

/* OFFLINE.
   The same picture as the lattice, from one device's point of view: a game
   going on over here, everyone else over there, and the link between the two
   coming and going. The game does not pause when the link goes. That is the
   whole claim, so the drawing has to make it in one glance and without a word
   about how any of it works.

   It runs on a loop on its own. The visitor can also cut the link by hand and
   put it back, and the loop picks up again afterwards.

   The board patch is four squares by four, drawn with the app's own square
   colours and the app's own cburnett knight, so the thing continuing is
   visibly a game of chess and not an abstraction. */

type Phase = 'online' | 'offline' | 'resync'

const MOVE_MS = 900
const ONLINE_MS = 3600
const OFFLINE_MS = 5400
const FLUSH_MS = 260
const AFTER_FLUSH_MS = 900
const SLOTS = 12

/** Four squares a knight can walk round, as a closed loop, on a 4 x 4 patch. */
const WALK: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 2],
  [3, 3],
  [2, 1]
]

// ---- the network side, in grid units of the 190 x 150 drawing --------------

const DEV = { x: 20, y: 75 }
const HUBS = [
  { x: 86, y: 46 },
  { x: 86, y: 104 }
]
const PEERS = [
  { x: 128, y: 25 },
  { x: 128, y: 75 },
  { x: 128, y: 125 },
  { x: 168, y: 46 },
  { x: 168, y: 104 }
]
/** Indices into [...HUBS, ...PEERS]. */
const MESH: readonly (readonly [number, number])[] = [
  [0, 2],
  [0, 3],
  [1, 3],
  [1, 4],
  [2, 3],
  [3, 4],
  [2, 5],
  [3, 5],
  [3, 6],
  [4, 6],
  [5, 6]
]
const FAR = [...HUBS, ...PEERS]

const DUST: readonly { x: number; y: number }[] = [
  { x: 52, y: 14 },
  { x: 104, y: 8 },
  { x: 156, y: 12 },
  { x: 182, y: 78 },
  { x: 60, y: 140 },
  { x: 112, y: 143 },
  { x: 164, y: 138 },
  { x: 20, y: 20 },
  { x: 20, y: 130 }
]

const PULSES = 6
const GOSSIP = 3

interface Pulse {
  t0: number
  dur: number
  hub: number
  peer: number
}

const CAPTION: Readonly<Record<Phase, string>> = {
  online: 'Connected. Your move goes out as you play it.',
  offline: 'No network. The game carries on, and your moves are kept here.',
  resync: 'Back. What you played while it was gone goes out now.'
}

export default function OfflineDemo(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('online')
  const phaseRef = useRef<{ name: Phase; t0: number }>({ name: 'online', t0: 0 })
  const auto = useRef(true)
  const moves = useRef<{ held: boolean }[]>([])
  const nextMove = useRef(0)
  const nextFlush = useRef(0)
  const walk = useRef(0)
  const gap = useRef(0)
  const pulses = useRef<(Pulse | null)[]>(new Array(PULSES).fill(null))
  const gossip = useRef<{ edge: number; t0: number; dur: number }[]>([])

  const pieceEl = useRef<HTMLDivElement | null>(null)
  const slotEls = useRef<(HTMLSpanElement | null)[]>([])
  const linkEls = useRef<(SVGLineElement | null)[]>([])
  const pulseEls = useRef<(SVGCircleElement | null)[]>([])
  const gossipEls = useRef<(SVGCircleElement | null)[]>([])

  /* The visitor takes the link down or puts it back. The loop resumes on its
     own once whatever they started has finished. */
  const cut = useCallback(() => {
    const now = performance.now()
    auto.current = false
    if (phaseRef.current.name === 'offline') {
      phaseRef.current = { name: 'resync', t0: now }
      nextFlush.current = now
      setPhase('resync')
    } else {
      phaseRef.current = { name: 'offline', t0: now }
      setPhase('offline')
    }
  }, [])

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let raf = 0
    const start = performance.now()
    phaseRef.current = { name: 'online', t0: start }
    nextMove.current = start + MOVE_MS

    const put = (i: number, cls: string): void => {
      const el = slotEls.current[i]
      if (el && el.className !== cls) el.className = cls
    }

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const ph = phaseRef.current

      // ---- the game keeps going, whatever the link is doing ----------------
      if (now >= nextMove.current && moves.current.length < SLOTS) {
        nextMove.current = now + MOVE_MS
        moves.current.push({ held: ph.name === 'offline' })
        walk.current = (walk.current + 1) % WALK.length
        const [col, row] = WALK[walk.current]
        pieceEl.current?.style.setProperty('transform', `translate(${col * 100}%, ${row * 100}%)`)
      }
      for (let i = 0; i < SLOTS; i++) {
        const m = moves.current[i]
        put(i, `lp-slot${m ? (m.held ? ' is-held' : ' is-sent') : ''}`)
      }

      // ---- the link ---------------------------------------------------------
      if (ph.name === 'online' && auto.current && now - ph.t0 > ONLINE_MS) {
        phaseRef.current = { name: 'offline', t0: now }
        setPhase('offline')
      } else if (ph.name === 'offline' && auto.current && now - ph.t0 > OFFLINE_MS) {
        phaseRef.current = { name: 'resync', t0: now }
        nextFlush.current = now
        setPhase('resync')
      } else if (ph.name === 'resync') {
        const stuck = moves.current.find((m) => m.held)
        if (stuck && now >= nextFlush.current) {
          stuck.held = false
          nextFlush.current = now + FLUSH_MS
          const slot = pulses.current.findIndex((p) => !p)
          if (slot >= 0) {
            pulses.current[slot] = {
              t0: now,
              dur: 900,
              hub: Math.floor(Math.random() * HUBS.length),
              peer: Math.floor(Math.random() * PEERS.length)
            }
          }
        } else if (!stuck && now - nextFlush.current > AFTER_FLUSH_MS) {
          phaseRef.current = { name: 'online', t0: now }
          auto.current = true
          moves.current = []
          nextMove.current = now + MOVE_MS
          setPhase('online')
        }
      }

      const want = ph.name === 'offline' ? 1 : 0
      gap.current += (want - gap.current) * (reduce ? 1 : 0.07)
      const g = gap.current
      for (let i = 0; i < HUBS.length; i++) {
        const h = HUBS[i]
        const mid = { x: (DEV.x + h.x) / 2, y: (DEV.y + h.y) / 2 }
        const pull = 1 - 0.55 * g
        const a = linkEls.current[i * 2]
        const b = linkEls.current[i * 2 + 1]
        if (a) {
          a.setAttribute('x2', (DEV.x + (mid.x - DEV.x) * pull).toFixed(2))
          a.setAttribute('y2', (DEV.y + (mid.y - DEV.y) * pull).toFixed(2))
        }
        if (b) {
          b.setAttribute('x2', (h.x + (mid.x - h.x) * pull).toFixed(2))
          b.setAttribute('y2', (h.y + (mid.y - h.y) * pull).toFixed(2))
        }
      }

      // ---- what crosses the link, once it is back --------------------------
      for (let i = 0; i < PULSES; i++) {
        const el = pulseEls.current[i]
        if (!el) continue
        const p = pulses.current[i]
        if (!p) {
          el.style.opacity = '0'
          continue
        }
        const u = (now - p.t0) / p.dur
        if (u >= 1) {
          pulses.current[i] = null
          el.style.opacity = '0'
          continue
        }
        const hub = HUBS[p.hub]
        const peer = PEERS[p.peer]
        const leg = u < 0.5 ? u / 0.5 : (u - 0.5) / 0.5
        const from = u < 0.5 ? DEV : hub
        const to = u < 0.5 ? hub : peer
        el.setAttribute('cx', (from.x + (to.x - from.x) * leg).toFixed(2))
        el.setAttribute('cy', (from.y + (to.y - from.y) * leg).toFixed(2))
        el.style.opacity = '1'
      }

      /* The rest of the network is not waiting for this device: it carries on
         talking to itself while the link is down. */
      for (let i = 0; i < GOSSIP; i++) {
        const el = gossipEls.current[i]
        if (!el) continue
        if (reduce) {
          el.style.opacity = '0'
          continue
        }
        let s = gossip.current[i]
        if (!s || now - s.t0 > s.dur) {
          s = {
            edge: Math.floor(Math.random() * MESH.length),
            t0: now + Math.random() * 800,
            dur: 1000 + Math.random() * 900
          }
          gossip.current[i] = s
        }
        const u = (now - s.t0) / s.dur
        if (u < 0) {
          el.style.opacity = '0'
          continue
        }
        const [a, b] = MESH[s.edge]
        el.setAttribute('cx', (FAR[a].x + (FAR[b].x - FAR[a].x) * u).toFixed(2))
        el.setAttribute('cy', (FAR[a].y + (FAR[b].y - FAR[a].y) * u).toFixed(2))
        el.style.opacity = (Math.sin(Math.PI * u) * 0.6).toFixed(3)
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="lp-fig">
      <div className="lp-off" data-phase={phase}>
        <div className="lp-off-game">
          <span className="lbl">Your game</span>
          <div className="lp-mini" aria-hidden="true">
            {Array.from({ length: 16 }, (_, i) => (
              <span
                key={i}
                className={`lp-sq${(Math.floor(i / 4) + i) % 2 === 0 ? ' is-light' : ' is-dark'}`}
              />
            ))}
            <div className="pc wn" ref={pieceEl} />
          </div>
          <div className="lp-tape" aria-hidden="true">
            {Array.from({ length: SLOTS }, (_, i) => (
              <span
                key={i}
                className="lp-slot"
                ref={(el) => {
                  slotEls.current[i] = el
                }}
              />
            ))}
          </div>
          <span className="lp-tape-lbl lbl">Moves</span>
        </div>

        <svg
          className="lp-net"
          viewBox="0 0 190 150"
          role="img"
          aria-label="One device linked to everyone else. The link breaks, the game carries on, and the moves cross when it comes back."
        >
          {DUST.map((d, i) => (
            <circle key={`d${i}`} className="nc-n lp-dust" cx={d.x} cy={d.y} r={1.15} />
          ))}

          {MESH.map(([a, b], i) => (
            <line
              key={`m${i}`}
              className="nc-e lp-e"
              x1={FAR[a].x}
              y1={FAR[a].y}
              x2={FAR[b].x}
              y2={FAR[b].y}
            />
          ))}

          {/* Each link to the rest is two half lines that pull apart, so losing
              the network is a gap you can see rather than a colour change. */}
          {HUBS.map((h, i) => (
            <g key={`l${i}`}>
              <line
                className="nc-e lp-link"
                x1={DEV.x}
                y1={DEV.y}
                x2={h.x}
                y2={h.y}
                ref={(el) => {
                  linkEls.current[i * 2] = el
                }}
              />
              <line
                className="nc-e lp-link"
                x1={h.x}
                y1={h.y}
                x2={DEV.x}
                y2={DEV.y}
                ref={(el) => {
                  linkEls.current[i * 2 + 1] = el
                }}
              />
            </g>
          ))}

          {Array.from({ length: GOSSIP }, (_, i) => (
            <circle
              key={`g${i}`}
              className="lp-gossip"
              r={1.5}
              cx={-10}
              cy={-10}
              ref={(el) => {
                gossipEls.current[i] = el
              }}
            />
          ))}
          {Array.from({ length: PULSES }, (_, i) => (
            <circle
              key={`p${i}`}
              className="lp-pulse"
              r={2.4}
              cx={-10}
              cy={-10}
              ref={(el) => {
                pulseEls.current[i] = el
              }}
            />
          ))}

          {FAR.map((f, i) => (
            <circle key={`f${i}`} className="nc-n lp-n lp-far" cx={f.x} cy={f.y} r={4.2} />
          ))}
          <circle className="nc-n lp-n lp-dev" cx={DEV.x} cy={DEV.y} r={6.4} />
          <text className="lp-tag" x={DEV.x} y={DEV.y - 12} textAnchor="middle">
            this device
          </text>
          <text className="lp-tag" x={148} y={13} textAnchor="middle">
            everyone else
          </text>
        </svg>
      </div>

      <div className="lp-fig-foot">
        <span className="lp-fig-read num" aria-live="polite">
          {CAPTION[phase]}
        </span>
        <button className="btn is-quiet" type="button" onClick={cut}>
          {phase === 'offline' ? 'Bring the network back' : 'Cut the network'}
        </button>
      </div>
    </div>
  )
}
