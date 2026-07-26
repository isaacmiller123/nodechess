import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent
} from 'react'

/* THE LATTICE.
   The picture of how the thing is put together, drawn in the same language as
   the mark: a triangular field of nodes (.nc-n) joined by links (.nc-e), with
   dust at the rim. Everything below is inline SVG and arithmetic. No library,
   no network, nothing fetched: it draws and it plays with the connection gone.

   IT IS A CONSTRUCTION, NOT A SKETCH. Every coordinate on it comes out of one
   rule: a regular triangular tessellation of pitch S, in axial coordinates,
   kept to the nodes within RING cells of the centre. That gives a hexagon with
   six fold symmetry, three concentric rings, and links that are all exactly S
   long and all on exactly 0, 60 or 120 degrees. The setting out is left on the
   drawing behind the live graph: the grid the nodes stand on, the three rings
   they fall on, and the single cell the whole thing is repeated from.

   Four things happen on it.
     1. A change starts somewhere and spreads, one hop at a time, to everything
        that can still be reached, with traffic crossing the links between.
     2. A node can be taken out, and a link can be cut. Both change the graph
        the spread walks, so a route that was going through what you removed
        visibly goes round instead.
     3. Two nodes can be picked, and the change travels between them hop by
        hop along the shortest route still open. Cut that route while it runs
        and it recomputes in front of you.
     4. A node can be dragged. The links are springs, so the field takes the
        strain; let go and it snaps back onto its site, because the lattice is
        a construction and reasserts itself.

   THE READING UNDER THE PICTURE IS COMPUTED, NEVER ASSERTED. It comes from a
   flood fill over the surviving nodes and links, so when the field is split it
   says so, and says how big the pieces are.

   Live positions are held in refs and written straight to the DOM in the frame
   loop, because putting sixty attribute writes a frame through React state
   would be sixty renders a second for no gain. At rest the nodes sit exactly
   on their sites and the loop writes nothing. */

// ---- the construction -----------------------------------------------------

const VB_W = 360
const VB_H = 176
const CX = VB_W / 2
const CY = VB_H / 2
/** The cell. Every link on the picture is exactly this long. */
const S = 40
/** Height of one row of the tessellation: S times sin 60. */
const ROW = (S * Math.sqrt(3)) / 2
/** How many rings of cells are built. 2 gives 1 + 6 + 12 nodes. */
const RING = 2

interface Pt {
  x: number
  y: number
}

/** Axial coordinates to the page. q runs east, r runs south east. */
const at = (q: number, r: number): Pt => ({ x: CX + S * (q + r / 2), y: CY + ROW * r })

/** Rings from the centre, in cells. */
const rings = (q: number, r: number): number => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2

interface Site extends Pt {
  q: number
  r: number
  ring: number
}

/* Ordered centre first, then ring by ring, and inside a ring by angle, so an
   index is a position in the construction and not an entry in a list. */
const SITES: readonly Site[] = (() => {
  const out: Site[] = []
  for (let q = -RING; q <= RING; q++) {
    for (let r = -RING; r <= RING; r++) {
      const ring = rings(q, r)
      if (ring > RING) continue
      out.push({ q, r, ring, ...at(q, r) })
    }
  }
  out.sort(
    (a, b) => a.ring - b.ring || Math.atan2(a.y - CY, a.x - CX) - Math.atan2(b.y - CY, b.x - CX)
  )
  return out
})()

const N = SITES.length
const BASE: readonly Pt[] = SITES.map((s) => ({ x: s.x, y: s.y }))
/** How many nodes stand on each ring. Stated in the description, so read it. */
const RING_COUNT: readonly number[] = Array.from({ length: RING + 1 }, (_, k) =>
  SITES.reduce((n, s) => (s.ring === k ? n + 1 : n), 0)
)

/** Two sites are joined when they are one cell apart. Nothing else is. */
const EDGES: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = []
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      if (rings(SITES[a].q - SITES[b].q, SITES[a].r - SITES[b].r) === 1) out.push([a, b])
    }
  }
  return out
})()
const E = EDGES.length

interface Link {
  to: number
  edge: number
}

const ADJ: readonly (readonly Link[])[] = (() => {
  const out: Link[][] = SITES.map(() => [])
  EDGES.forEach(([a, b], i) => {
    out[a].push({ to: b, edge: i })
    out[b].push({ to: a, edge: i })
  })
  return out
})()

const siteAt = (q: number, r: number): number => SITES.findIndex((s) => s.q === q && s.r === r)

/** Three nodes are named, so the shape is read as people and their machines
 *  rather than as a diagram of infrastructure. They sit on three corners 120
 *  degrees apart, which is the symmetry the rest of the figure is built on. */
const TAGS: readonly {
  i: number
  text: string
  dx: number
  dy: number
  anchor: 'start' | 'middle' | 'end'
}[] = [
  { i: siteAt(-RING, 0), text: 'you', dx: -8, dy: 1.7, anchor: 'end' },
  { i: siteAt(RING, -RING), text: 'your phone', dx: 0, dy: -9, anchor: 'middle' },
  { i: siteAt(0, RING), text: 'a friend', dx: 0, dy: 12, anchor: 'middle' }
]
const TAG_AT: Readonly<Record<number, (typeof TAGS)[number]>> = Object.fromEntries(
  TAGS.map((t) => [t.i, t])
)

/** Dust: the same grid carried past the built part, as in the mark. Never
 *  live. It is the tessellation continuing, which is the point of it. */
const DUST: readonly Pt[] = (() => {
  const out: Pt[] = []
  for (let r = -3; r <= 3; r++) {
    for (let q = -9; q <= 9; q++) {
      if (rings(q, r) <= RING) continue
      const p = at(q, r)
      if (p.x < 12 || p.x > VB_W - 12 || p.y < 12 || p.y > VB_H - 12) continue
      out.push(p)
    }
  }
  return out
})()

interface Seg {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** The setting out. Three families of lattice lines, at 0, 60 and 120, drawn
 *  long and left to be clipped by the frame, the way a drawing keeps the lines
 *  it was built from. */
const GRID: readonly Seg[] = (() => {
  const out: Seg[] = []
  const reach = 250
  const push = (px: number, py: number, dx: number, dy: number): void => {
    out.push({
      x1: px - dx * reach,
      y1: py - dy * reach,
      x2: px + dx * reach,
      y2: py + dy * reach
    })
  }
  for (let j = -2; j <= 2; j++) push(CX, CY + ROW * j, 1, 0)
  for (let k = -6; k <= 6; k++) {
    push(CX + S * k, CY, 0.5, Math.sqrt(3) / 2)
    push(CX + S * k, CY, -0.5, Math.sqrt(3) / 2)
  }
  return out
})()

/** The rings the nodes actually fall on: the first ring at S, the flats of the
 *  second at S root 3, its corners at 2S. Every one of these circles passes
 *  through nodes, which is why they are worth drawing. */
const RADII: readonly number[] = [S, S * Math.sqrt(3), S * RING]

/** One cell of the tessellation, called out twice in the margin where the
 *  field is only dust, so the rule the whole figure is repeated from is on the
 *  drawing. The two are a half turn apart, which the hexagon also is. */
const CELLS: readonly string[] = [
  [at(-4, 0), at(-3, 0), at(-4, 1)],
  [at(4, 0), at(3, 0), at(4, -1)]
].map((tri) => tri.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '))

// ---- motion ---------------------------------------------------------------

const HOP = 360 /* ms a change takes to cross one link */
const TAIL = 1500 /* ms the last node keeps glowing before the next spread */
const SEND_HOLD = 1100 /* ms the sent change rests at the far end before it repeats */
const WAVE_DOTS = 10
const GOSSIP_DOTS = 5

const K_EDGE = 0.055 /* link stiffness */
const K_HOME = 0.014 /* pull back to the site the node was set out on */
const K_SNAP = 0.09 /* the same pull once the node has been let go */
const DAMP = 0.88
const DAMP_SNAP = 0.79
const STEP = 16.7 /* ms per physics substep */
const SNAP_MS = 560 /* how long the lattice takes to reassert itself */

interface Wave {
  dist: number[]
  from: number[]
  t0: number
  span: number
}

interface Gossip {
  edge: number
  flip: boolean
  t0: number
  dur: number
}

interface Route {
  path: number[]
  edges: number[]
}

// ---- the graph ------------------------------------------------------------

/** Hops from `origin`, refusing to pass through a node that is out or along a
 *  link that has been cut. Everything the picture claims is read off this. */
function walk(
  origin: number,
  down: readonly boolean[],
  cut: readonly boolean[]
): { dist: number[]; from: number[]; via: number[] } {
  const dist = new Array<number>(N).fill(-1)
  const from = new Array<number>(N).fill(-1)
  const via = new Array<number>(N).fill(-1)
  if (down[origin]) return { dist, from, via }
  dist[origin] = 0
  const queue = [origin]
  for (let head = 0; head < queue.length; head++) {
    const a = queue[head]
    for (const link of ADJ[a]) {
      if (down[link.to] || cut[link.edge] || dist[link.to] >= 0) continue
      dist[link.to] = dist[a] + 1
      from[link.to] = a
      via[link.to] = link.edge
      queue.push(link.to)
    }
  }
  return { dist, from, via }
}

/** The sizes of the pieces the field is in, largest first. One entry means it
 *  is whole. More than one means it is split, and by how much. */
function groupsOf(down: readonly boolean[], cut: readonly boolean[]): number[] {
  const seen = new Array<boolean>(N).fill(false)
  const sizes: number[] = []
  for (let i = 0; i < N; i++) {
    if (down[i] || seen[i]) continue
    const { dist } = walk(i, down, cut)
    let n = 0
    for (let j = 0; j < N; j++) {
      if (dist[j] < 0) continue
      seen[j] = true
      n++
    }
    sizes.push(n)
  }
  return sizes.sort((a, b) => b - a)
}

const isOpen = (e: number, down: readonly boolean[], cut: readonly boolean[]): boolean =>
  !cut[e] && !down[EDGES[e][0]] && !down[EDGES[e][1]]

interface Fact {
  deg: number
  pairs: number
  through: number
  lose: number
}

/** What one node is worth to the rest, counted rather than claimed: how many
 *  links it still has, how many of the pairs that can reach each other have
 *  their shortest way through it, and how many nodes would lose touch with the
 *  main body if it went. */
function factsFor(down: readonly boolean[], cut: readonly boolean[]): (Fact | null)[] {
  const dists: number[][] = []
  for (let i = 0; i < N; i++) {
    dists.push(down[i] ? new Array<number>(N).fill(-1) : walk(i, down, cut).dist)
  }
  const live: number[] = []
  for (let i = 0; i < N; i++) if (!down[i]) live.push(i)

  return SITES.map((_, i) => {
    if (down[i]) return null
    let pairs = 0
    let through = 0
    for (let a = 0; a < live.length; a++) {
      const s = live[a]
      if (s === i) continue
      for (let b = a + 1; b < live.length; b++) {
        const t = live[b]
        if (t === i || dists[s][t] < 0) continue
        pairs++
        if (dists[s][i] >= 0 && dists[i][t] >= 0 && dists[s][i] + dists[i][t] === dists[s][t]) {
          through++
        }
      }
    }
    const without = down.slice()
    without[i] = true
    const rest = groupsOf(without, cut)
    return {
      deg: ADJ[i].filter((l) => !cut[l.edge] && !down[l.to]).length,
      pairs,
      through,
      lose: rest.length ? live.length - 1 - rest[0] : 0
    }
  })
}

const listOf = (nums: readonly number[]): string =>
  nums.length < 2 ? String(nums[0] ?? 0) : `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`

const sayFact = (f: Fact): string => {
  const links = `${f.deg} ${f.deg === 1 ? 'link' : 'links'} open.`
  if (f.pairs === 0) return links
  const risk =
    f.lose === 0
      ? 'Take it out and the rest still reach each other.'
      : `Take it out and ${f.lose} ${f.lose === 1 ? 'node loses' : 'nodes lose'} touch.`
  return `${links} On the shortest way between ${f.through} of the ${f.pairs} pairs. ${risk}`
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** A flash: up fast, down slow. Drives every lit value on the picture. */
const flash = (ms: number): number =>
  ms < 0 ? 0 : ms < 90 ? ms / 90 : Math.max(0, 1 - (ms - 90) / 950)

const NO_EDGES: ReadonlySet<number> = new Set<number>()

export default function LatticeDemo(): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const nodeEls = useRef<(SVGGElement | null)[]>([])
  const hitEls = useRef<(SVGCircleElement | null)[]>([])
  const edgeEls = useRef<(SVGLineElement | null)[]>([])
  const zoneEls = useRef<(SVGLineElement | null)[]>([])
  const waveEls = useRef<(SVGCircleElement | null)[]>([])
  const gossipEls = useRef<(SVGCircleElement | null)[]>([])
  const tetherEl = useRef<SVGLineElement | null>(null)

  const pos = useRef<Pt[]>(BASE.map((p) => ({ ...p })))
  const vel = useRef<Pt[]>(BASE.map(() => ({ x: 0, y: 0 })))
  const wave = useRef<Wave | null>(null)
  const gossip = useRef<Gossip[]>([])
  const drag = useRef<{ i: number; moved: number; at: Pt } | null>(null)
  const snapUntil = useRef(0)
  const atRest = useRef(false)

  const [down, setDown] = useState<boolean[]>(() => new Array<boolean>(N).fill(false))
  const [cut, setCut] = useState<boolean[]>(() => new Array<boolean>(E).fill(false))
  const [mode, setMode] = useState<'out' | 'send'>('out')
  const [pick, setPick] = useState<number[]>([])
  const [look, setLook] = useState<number | null>(null)
  const [held, setHeld] = useState<number | null>(null)
  const [cursor, setCursor] = useState(0)

  const downRef = useRef(down)
  const cutRef = useRef(cut)
  const modeRef = useRef(mode)
  const routeRef = useRef<(Route & { t0: number }) | null>(null)

  /* ---- everything the figure says about itself, computed from the graph ---- */

  const status = useMemo(() => {
    const outN = down.filter(Boolean).length
    const cutN = cut.filter(Boolean).length
    const liveN = N - outN
    if (liveN === 0) return 'Every node is out. Nothing left to route through.'
    const open = EDGES.reduce((n, _, e) => (isOpen(e, down, cut) ? n + 1 : n), 0)
    const groups = groupsOf(down, cut)
    if (groups.length === 1) {
      if (outN === 0 && cutN === 0) return `${N} nodes, ${E} links, every one of them reachable.`
      return `${liveN} nodes, ${open} links open, and every one of them still reachable.`
    }
    return `${liveN} nodes in ${groups.length} groups of ${listOf(groups)}. Those groups cannot reach each other.`
  }, [down, cut])

  const facts = useMemo(() => factsFor(down, cut), [down, cut])

  const route = useMemo<Route | null>(() => {
    if (mode !== 'send' || pick.length < 2) return null
    const [from, to] = pick
    if (down[from] || down[to]) return null
    const walked = walk(from, down, cut)
    if (walked.dist[to] < 0) return null
    const path: number[] = []
    const edges: number[] = []
    for (let n = to; n >= 0; n = walked.from[n]) {
      path.push(n)
      if (walked.via[n] >= 0) edges.push(walked.via[n])
    }
    path.reverse()
    edges.reverse()
    return { path, edges }
  }, [mode, pick, down, cut])

  const routeEdges = useMemo(() => new Set(route?.edges ?? []), [route])
  const routeNodes = useMemo(() => new Set(route?.path ?? []), [route])

  /** Hovering a node lights what runs through it: its own open links. */
  const viaEdges = useMemo<ReadonlySet<number>>(() => {
    if (look === null || down[look]) return NO_EDGES
    return new Set(ADJ[look].filter((l) => !cut[l.edge] && !down[l.to]).map((l) => l.edge))
  }, [look, down, cut])

  const hint = useMemo(() => {
    if (mode === 'send') {
      if (pick.length === 0) return 'Click a node. The change starts there.'
      if (pick.length === 1) return 'Now click the node it has to reach.'
      if (!route) return 'No way through. Those two are in different groups.'
      const hops = route.path.length - 1
      return `${hops} ${hops === 1 ? 'hop' : 'hops'}, by the shortest way still open. Cut a link on it and watch it go round.`
    }
    const f = look === null ? null : facts[look]
    if (look !== null && down[look]) return 'This one is out. Click it to put it back.'
    if (f) return sayFact(f)
    return 'Click a node to take it out. Click a link to cut it.'
  }, [mode, pick, route, look, facts, down])

  const keyHint =
    mode === 'send'
      ? 'Arrows move. Enter picks a node. Shift and an arrow cuts a link.'
      : 'Arrows move. Enter takes a node out. Shift and an arrow cuts a link.'

  /* ---- acting on it ---- */

  useEffect(() => {
    downRef.current = down
    cutRef.current = cut
    wave.current = null /* re-route from scratch the moment the shape changes */
  }, [down, cut])

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  /* A new route, or the same two ends by a new way, restarts the run, so the
     change is seen taking the new road and not halfway down the old one. */
  useEffect(() => {
    routeRef.current = route ? { ...route, t0: performance.now() } : null
  }, [route])

  const act = useCallback(
    (i: number) => {
      if (mode === 'send') {
        setPick((prev) => {
          if (prev.length !== 1) return [i]
          if (prev[0] === i) return []
          return [prev[0], i]
        })
        return
      }
      setDown((prev) => {
        const next = prev.slice()
        next[i] = !next[i]
        return next
      })
    },
    [mode]
  )

  const snip = useCallback((e: number) => {
    setCut((prev) => {
      const next = prev.slice()
      next[e] = !next[e]
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setDown(new Array<boolean>(N).fill(false))
    setCut(new Array<boolean>(E).fill(false))
  }, [])

  const broken = down.some(Boolean) || cut.some(Boolean)

  /** Pointer position in the drawing's own units. */
  const toGrid = useCallback((clientX: number, clientY: number): Pt | null => {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box || !box.width || !box.height) return null
    return {
      x: ((clientX - box.left) / box.width) * VB_W,
      y: ((clientY - box.top) / box.height) * VB_H
    }
  }, [])

  const onDown = useCallback(
    (i: number, ev: PointerEvent<SVGCircleElement>) => {
      ev.preventDefault()
      ev.currentTarget.setPointerCapture(ev.pointerId)
      const at0 = toGrid(ev.clientX, ev.clientY)
      drag.current = { i, moved: 0, at: at0 ?? { ...pos.current[i] } }
      setHeld(i)
      setCursor(i)
    },
    [toGrid]
  )

  const onMove = useCallback(
    (ev: PointerEvent<SVGCircleElement>) => {
      const d = drag.current
      if (!d) return
      const to = toGrid(ev.clientX, ev.clientY)
      if (!to) return
      d.moved += Math.hypot(to.x - d.at.x, to.y - d.at.y)
      d.at = to
    },
    [toGrid]
  )

  /* A press that went nowhere acts on the node; a press that travelled was a
     drag, and a drag must not also act underneath it. Either way the lattice
     is told to snap back onto its sites. */
  const onUp = useCallback(
    (i: number, ev: PointerEvent<SVGCircleElement>) => {
      const d = drag.current
      drag.current = null
      setHeld(null)
      snapUntil.current = performance.now() + SNAP_MS
      atRest.current = false
      if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
        ev.currentTarget.releasePointerCapture(ev.pointerId)
      }
      if (d && d.moved < 3) act(i)
    },
    [act]
  )

  /** The neighbour most nearly in the direction asked for. Ties, which the
   *  vertical arrows always produce on a triangular grid, go to the middle. */
  const stepTo = useCallback((i: number, dx: number, dy: number): number => {
    let best = -1
    let score = 0.2
    for (const link of ADJ[i]) {
      const vx = BASE[link.to].x - BASE[i].x
      const vy = BASE[link.to].y - BASE[i].y
      const k = (vx * dx + vy * dy) / Math.hypot(vx, vy)
      if (k < score - 0.001) continue
      if (
        k > score + 0.001 ||
        best < 0 ||
        Math.abs(BASE[link.to].x - CX) < Math.abs(BASE[best].x - CX)
      ) {
        score = Math.max(score, k)
        best = link.to
      }
    }
    return best
  }, [])

  const onKey = useCallback(
    (i: number, ev: KeyboardEvent<SVGCircleElement>) => {
      const arrows: Readonly<Record<string, [number, number]>> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      }
      const dir = arrows[ev.key]
      if (dir) {
        const to = stepTo(i, dir[0], dir[1])
        if (to < 0) return
        ev.preventDefault()
        if (ev.shiftKey) {
          const link = ADJ[i].find((l) => l.to === to)
          if (link) snip(link.edge)
          return
        }
        setCursor(to)
        setLook(to)
        hitEls.current[to]?.focus()
        return
      }
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        act(i)
      }
    },
    [act, snip, stepTo]
  )

  /* ---- the frame loop ---- */

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduce = media.matches
    const onPref = (): void => {
      reduce = media.matches
      atRest.current = false
    }
    media.addEventListener('change', onPref)

    let raf = 0
    let last = performance.now()
    let acc = 0
    const litNode = new Array<number>(N).fill(-1)
    const litEdge = new Array<number>(E).fill(-1)
    const nodeK = new Array<number>(N).fill(0)
    const edgeK = new Array<number>(E).fill(0)

    /* Under prefers-reduced-motion the field does not flex and does not spring
       home: the node under the finger follows it, and the moment it is let go
       the lattice is simply back. */
    const physics = (snapping: boolean): void => {
      const p = pos.current
      const v = vel.current
      const d = drag.current
      const home = snapping ? K_SNAP : K_HOME
      const damp = snapping ? DAMP_SNAP : DAMP
      for (let e = 0; e < E && !reduce; e++) {
        const [a, b] = EDGES[e]
        const dx = p[b].x - p[a].x
        const dy = p[b].y - p[a].y
        const len = Math.hypot(dx, dy) || 0.001
        const f = (K_EDGE * (len - S)) / len
        v[a].x += f * dx
        v[a].y += f * dy
        v[b].x -= f * dx
        v[b].y -= f * dy
      }
      for (let i = 0; i < N; i++) {
        if (d && d.i === i) {
          p[i].x = Math.max(8, Math.min(VB_W - 8, d.at.x))
          p[i].y = Math.max(8, Math.min(VB_H - 8, d.at.y))
          v[i].x = 0
          v[i].y = 0
          continue
        }
        if (reduce) continue
        v[i].x += home * (BASE[i].x - p[i].x)
        v[i].y += home * (BASE[i].y - p[i].y)
        v[i].x *= damp
        v[i].y *= damp
        p[i].x += v[i].x
        p[i].y += v[i].y
      }
    }

    const writeGeometry = (): void => {
      const p = pos.current
      for (let i = 0; i < N; i++) {
        nodeEls.current[i]?.setAttribute(
          'transform',
          `translate(${p[i].x.toFixed(2)} ${p[i].y.toFixed(2)})`
        )
      }
      for (let e = 0; e < E; e++) {
        const [a, b] = EDGES[e]
        const x1 = p[a].x.toFixed(2)
        const y1 = p[a].y.toFixed(2)
        const x2 = p[b].x.toFixed(2)
        const y2 = p[b].y.toFixed(2)
        for (const el of [edgeEls.current[e], zoneEls.current[e]]) {
          if (!el) continue
          el.setAttribute('x1', x1)
          el.setAttribute('y1', y1)
          el.setAttribute('x2', x2)
          el.setAttribute('y2', y2)
        }
      }
      const d = drag.current
      const tether = tetherEl.current
      if (tether && d) {
        tether.setAttribute('x2', p[d.i].x.toFixed(2))
        tether.setAttribute('y2', p[d.i].y.toFixed(2))
      }
    }

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(now - last, 60)
      last = now
      const out = downRef.current
      const gone = cutRef.current

      /* ---- geometry. Still, unless a node is being pushed or is coming
         home, and then exactly on its site again the moment it arrives. */
      const snapping = !drag.current && !reduce && now < snapUntil.current
      if (drag.current || snapping) {
        acc += dt
        let guard = 0
        while (acc >= STEP && guard++ < 6) {
          physics(snapping)
          acc -= STEP
        }
        writeGeometry()
        atRest.current = false
      } else if (!atRest.current) {
        for (let i = 0; i < N; i++) {
          pos.current[i].x = BASE[i].x
          pos.current[i].y = BASE[i].y
          vel.current[i].x = 0
          vel.current[i].y = 0
        }
        writeGeometry()
        atRest.current = true
      }

      const p = pos.current
      nodeK.fill(0)
      edgeK.fill(0)
      let dot = 0

      const run = routeRef.current
      if (modeRef.current === 'send') {
        // ---- one change, from the node picked to the node picked ----------
        if (run && run.path.length > 1) {
          const hops = run.path.length - 1
          if (reduce) {
            for (const i of run.path) nodeK[i] = 1
            for (const e of run.edges) edgeK[e] = 1
          } else {
            const cycle = hops * HOP + SEND_HOLD
            const t = (now - run.t0) % cycle
            for (let k = 0; k < run.path.length; k++) nodeK[run.path[k]] = flash(t - k * HOP)
            const k = Math.floor(t / HOP)
            if (k < hops) {
              const u = clamp01(t / HOP - k)
              const from = run.path[k]
              const to = run.path[k + 1]
              edgeK[run.edges[k]] = 1
              const el = waveEls.current[dot++]
              if (el) {
                el.setAttribute('cx', (p[from].x + (p[to].x - p[from].x) * u).toFixed(2))
                el.setAttribute('cy', (p[from].y + (p[to].y - p[from].y) * u).toFixed(2))
                el.style.opacity = '1'
              }
            }
          }
        } else if (run) {
          nodeK[run.path[0]] = 1
        }
      } else if (!reduce) {
        // ---- the change nobody asked for, spreading on its own ------------
        let w = wave.current
        if (!w || now - w.t0 > w.span) {
          const live: number[] = []
          for (let i = 0; i < N; i++) if (!out[i]) live.push(i)
          if (live.length) {
            const origin = live[Math.floor(Math.random() * live.length)]
            const walked = walk(origin, out, gone)
            const far = walked.dist.reduce((m, d) => (d > m ? d : m), 0)
            w = { dist: walked.dist, from: walked.from, t0: now, span: far * HOP + TAIL }
          } else {
            w = {
              dist: new Array<number>(N).fill(-1),
              from: new Array<number>(N).fill(-1),
              t0: now,
              span: TAIL
            }
          }
          wave.current = w
        }
        const t = now - w.t0
        for (let i = 0; i < N; i++) {
          const hop = w.dist[i]
          nodeK[i] = hop < 0 || out[i] ? 0 : flash(t - hop * HOP)
        }
        for (let e = 0; e < E; e++) {
          const [a, b] = EDGES[e]
          if (!isOpen(e, out, gone)) continue
          const lead = w.from[b] === a ? a : w.from[a] === b ? b : -1
          if (lead < 0) continue
          const to = lead === a ? b : a
          const u = (t - w.dist[lead] * HOP) / HOP
          edgeK[e] = u < 0 ? 0 : u <= 1 ? 1 : Math.max(0, 1 - (u - 1) * 1.4)
          if (u >= 0 && u <= 1 && dot < WAVE_DOTS) {
            const el = waveEls.current[dot++]
            if (el) {
              el.setAttribute('cx', (p[lead].x + (p[to].x - p[lead].x) * u).toFixed(2))
              el.setAttribute('cy', (p[lead].y + (p[to].y - p[lead].y) * u).toFixed(2))
              el.style.opacity = '1'
            }
          }
        }
      }

      for (let i = 0; i < N; i++) {
        if (Math.abs(nodeK[i] - litNode[i]) < 0.01) continue
        litNode[i] = nodeK[i]
        nodeEls.current[i]?.style.setProperty('--lit', nodeK[i].toFixed(3))
      }
      for (let e = 0; e < E; e++) {
        if (Math.abs(edgeK[e] - litEdge[e]) < 0.01) continue
        litEdge[e] = edgeK[e]
        edgeEls.current[e]?.style.setProperty('--lit', edgeK[e].toFixed(3))
      }
      for (let i = dot; i < WAVE_DOTS; i++) {
        const el = waveEls.current[i]
        if (el) el.style.opacity = '0'
      }

      // ---- the traffic between spreads ------------------------------------
      for (let i = 0; i < GOSSIP_DOTS; i++) {
        const el = gossipEls.current[i]
        if (!el) continue
        const idle = reduce || modeRef.current === 'send'
        let g = gossip.current[i]
        const u = g ? (now - g.t0) / g.dur : 2
        if (idle || !g || u > 1 || !isOpen(g.edge, out, gone)) {
          el.style.opacity = '0'
          if (idle) continue
          const open: number[] = []
          for (let e = 0; e < E; e++) if (isOpen(e, out, gone)) open.push(e)
          if (!open.length) continue
          gossip.current[i] = {
            edge: open[Math.floor(Math.random() * open.length)],
            flip: Math.random() < 0.5,
            t0: now + Math.random() * 700,
            dur: 900 + Math.random() * 800
          }
          continue
        }
        if (u < 0) {
          el.style.opacity = '0'
          continue
        }
        const [ea, eb] = EDGES[g.edge]
        const from = g.flip ? eb : ea
        const to = g.flip ? ea : eb
        el.setAttribute('cx', (p[from].x + (p[to].x - p[from].x) * u).toFixed(2))
        el.setAttribute('cy', (p[from].y + (p[to].y - p[from].y) * u).toFixed(2))
        el.style.opacity = (Math.sin(Math.PI * clamp01(u)) * 0.7).toFixed(3)
      }
    }

    raf = requestAnimationFrame(frame)
    return () => {
      media.removeEventListener('change', onPref)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div className="lp-fig lp-lat-fig">
      <p className="visually-hidden" id="lp-lat-desc">
        A drawing of the lattice, set out on a regular triangular grid: {N} nodes, {RING_COUNT[0]}{' '}
        at the centre, {RING_COUNT[1]} on the first ring and {RING_COUNT[2]} on the second, joined
        by {E} links that are all the same length and all on the same three angles. There is no
        middle: a change made at one node reaches the others by whatever route is open. Take a node
        out, cut a link between two of them, or send a change from one node to another and watch
        the hops it takes. The reading under the drawing is counted from the graph itself and says
        whether everything left can still reach everything else.
      </p>

      <svg
        ref={svgRef}
        className="lp-lat"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="group"
        aria-label="The lattice"
        aria-describedby="lp-lat-desc"
      >
        <defs>
          <radialGradient id="lp-lat-fade" cx="50%" cy="50%" r="56%">
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.55" stopColor="#fff" stopOpacity="0.72" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="lp-lat-mask">
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="url(#lp-lat-fade)" />
          </mask>
        </defs>

        {/* The setting out, kept on the drawing: the grid the nodes stand on,
            the rings they fall on, and one cell of the tessellation called out
            in the margin. None of it is live and none of it is announced. */}
        <g className="lp-lat-set" aria-hidden="true" mask="url(#lp-lat-mask)">
          {GRID.map((g, i) => (
            <line key={`g${i}`} className="lp-lat-grid" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
          ))}
          {RADII.map((r) => (
            <circle key={`r${r.toFixed(1)}`} className="lp-lat-ring" cx={CX} cy={CY} r={r} />
          ))}
          {CELLS.map((pts, i) => (
            <polygon key={`c${i}`} className="lp-lat-cell" points={pts} />
          ))}
          {DUST.map((d, i) => (
            <circle key={`d${i}`} className="nc-n lp-dust" cx={d.x} cy={d.y} r={1.15} />
          ))}
        </g>

        {/* While a node is off its site, the drawing shows where it belongs. */}
        {held !== null ? (
          <g className="lp-lat-home" aria-hidden="true">
            <circle className="lp-lat-ghost" cx={BASE[held].x} cy={BASE[held].y} r={6.4} />
            <line
              className="lp-lat-tether"
              ref={tetherEl}
              x1={BASE[held].x}
              y1={BASE[held].y}
              x2={BASE[held].x}
              y2={BASE[held].y}
            />
          </g>
        ) : null}

        {EDGES.map(([a, b], i) => {
          const dead = down[a] || down[b]
          const cls = [
            'nc-e lp-e',
            cut[i] ? 'is-cut' : '',
            dead ? 'is-out' : '',
            !cut[i] && !dead && routeEdges.has(i) ? 'is-route' : '',
            !cut[i] && !dead && viaEdges.has(i) ? 'is-via' : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <g className="lp-lat-link" key={`e${i}`}>
              <line
                className={cls}
                ref={(el) => {
                  edgeEls.current[i] = el
                }}
                x1={BASE[a].x}
                y1={BASE[a].y}
                x2={BASE[b].x}
                y2={BASE[b].y}
              />
              <line
                className="lp-lat-zone"
                aria-hidden="true"
                ref={(el) => {
                  zoneEls.current[i] = el
                }}
                x1={BASE[a].x}
                y1={BASE[a].y}
                x2={BASE[b].x}
                y2={BASE[b].y}
                onPointerDown={(ev) => {
                  ev.preventDefault()
                  snip(i)
                }}
              />
            </g>
          )
        })}

        {Array.from({ length: GOSSIP_DOTS }, (_, i) => (
          <circle
            key={`t${i}`}
            className="lp-gossip"
            aria-hidden="true"
            r={1.5}
            cx={-10}
            cy={-10}
            ref={(el) => {
              gossipEls.current[i] = el
            }}
          />
        ))}
        {Array.from({ length: WAVE_DOTS }, (_, i) => (
          <circle
            key={`w${i}`}
            className="lp-pulse"
            aria-hidden="true"
            r={2.4}
            cx={-10}
            cy={-10}
            ref={(el) => {
              waveEls.current[i] = el
            }}
          />
        ))}

        {SITES.map((s, i) => {
          const tag = TAG_AT[i]
          const at1 = pick[0] === i
          const at2 = pick[1] === i
          const cls = [
            'lp-node',
            down[i] ? 'is-out' : '',
            routeNodes.has(i) ? 'is-route' : '',
            at1 || at2 ? 'is-pick' : '',
            look === i ? 'is-look' : ''
          ]
            .filter(Boolean)
            .join(' ')
          const f = facts[i]
          const label = down[i]
            ? `Node ${i + 1} of ${N}, out. Put it back.`
            : `Node ${i + 1} of ${N}. ${f ? sayFact(f) : ''} ${
                mode === 'send'
                  ? at1
                    ? 'Picked as the start.'
                    : 'Send a change from here.'
                  : 'Take it out.'
              }`
          return (
            <g
              key={`n${i}`}
              className={cls}
              transform={`translate(${s.x} ${s.y})`}
              ref={(el) => {
                nodeEls.current[i] = el
              }}
            >
              {at1 || at2 ? <circle className="lp-lat-pick" r={8.4} /> : null}
              <circle className="nc-n lp-n" r={4.4} />
              {tag ? (
                <text className="lp-tag" x={tag.dx} y={tag.dy} textAnchor={tag.anchor}>
                  {tag.text}
                </text>
              ) : null}
              <circle
                className="lp-hit"
                r={12}
                tabIndex={cursor === i ? 0 : -1}
                role="button"
                aria-pressed={mode === 'send' ? at1 || at2 : down[i]}
                aria-label={label}
                ref={(el) => {
                  hitEls.current[i] = el
                }}
                onPointerDown={(ev) => onDown(i, ev)}
                onPointerMove={onMove}
                onPointerUp={(ev) => onUp(i, ev)}
                onPointerCancel={() => {
                  drag.current = null
                  setHeld(null)
                  snapUntil.current = performance.now() + SNAP_MS
                  atRest.current = false
                }}
                onPointerEnter={() => setLook(i)}
                onPointerLeave={() => setLook((was) => (was === i ? null : was))}
                onFocus={() => {
                  setCursor(i)
                  setLook(i)
                }}
                onBlur={() => setLook((was) => (was === i ? null : was))}
                onKeyDown={(ev) => onKey(i, ev)}
              />
            </g>
          )
        })}
      </svg>

      <div className="lp-fig-foot lp-lat-foot">
        <span className="lp-lat-lines">
          <span className="lp-fig-read num" aria-live="polite">
            {status}
          </span>
          <span className="lp-lat-hint">
            <span className="lp-lat-mouse">{hint}</span>
            <span className="lp-lat-keys">{keyHint}</span>
          </span>
        </span>

        <span className="lp-lat-acts">
          <span className="segmented" role="group" aria-label="What a click does">
            <button
              className="seg"
              type="button"
              aria-pressed={mode === 'out'}
              onClick={() => {
                setMode('out')
                setPick([])
              }}
            >
              Take out
            </button>
            <button
              className="seg"
              type="button"
              aria-pressed={mode === 'send'}
              onClick={() => {
                setMode('send')
                setPick([])
              }}
            >
              Send a change
            </button>
          </span>
          <button className="btn is-quiet" type="button" onClick={reset} disabled={!broken}>
            Put it all back
          </button>
        </span>
      </div>
    </div>
  )
}
