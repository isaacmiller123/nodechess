import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type {
  SchoolChapterMeta,
  ChapterProgressRow,
  SchoolMastery,
  PlacementState
} from '@shared/types'
import { useReadoutSlot } from '../../components/Layout'
import { ChapterPlayer } from './ChapterPlayer'
import { PlacementFlow } from './PlacementFlow'
import { TodayCard } from './TodayCard'
import { RecommendedNextCard } from './RecommendedNextCard'
import { Icon, pad } from './SchoolScene'
import './school.css'

type LoadState = 'loading' | 'ready' | 'empty'

// ---------------------------------------------------------------------------
// The journey tiers: named sections of the 40-chapter curriculum, derived from
// chapter ORDER ranges only (the internal Elo bands are never surfaced). The
// last tier is open-ended so future chapters keep a home.
// ---------------------------------------------------------------------------
interface TierDef {
  key: string
  numeral: string
  name: string
  blurb: string
  from: number
  to: number
}
const TIERS: TierDef[] = [
  {
    key: 'foundation',
    numeral: 'I',
    name: 'Foundation',
    blurb: 'The rules, board vision and the first mates: the ground everything stands on.',
    // Open floor so a mis-ordered chapter can never silently drop off the map.
    from: Number.NEGATIVE_INFINITY,
    to: 7
  },
  {
    key: 'core',
    numeral: 'II',
    name: 'Core Tactics & First Repertoire',
    blurb: 'Forks, pins and discoveries, plus the first openings you can trust.',
    from: 8,
    to: 16
  },
  {
    key: 'upper',
    numeral: 'III',
    name: 'Upper-Middle Game',
    blurb: 'A grown-up repertoire, pawn play, endgames and real combinations.',
    from: 17,
    to: 28
  },
  {
    key: 'advanced',
    numeral: 'IV',
    name: 'Advanced Mastery',
    blurb: 'Deep calculation, conversion and theory: the run at master play.',
    from: 29,
    to: Number.POSITIVE_INFINITY
  }
]

/**
 * Chess School.
 *
 * v1 draws the inside of a lesson and nothing else, so the index is built from
 * the same parts that page is made of: a chapter is a .go row in a .panel, a
 * tier is a .sec with its count in the .sec-head, and what you did today and
 * what Viktor thinks you should do next stand in the aside. There is no ring,
 * no node line and no hero card, because none of those exist in this design and
 * a chapter list does not need them: the count says how far you are and the
 * trace under the readout says it again for the whole school.
 *
 * Degrades honestly when the desktop bridge is absent (a clear "connect" state,
 * never a sample chapter).
 */
export default function SchoolView({
  onOpenSettings
}: {
  /** Deep link to Settings → Datasets: the placement flow's engine notice and
   *  the lesson puzzle segments' puzzle-DB notice both land there. */
  onOpenSettings?: () => void
} = {}): JSX.Element {
  const [chapters, setChapters] = useState<SchoolChapterMeta[]>([])
  const [mastery, setMastery] = useState<SchoolMastery | null>(null)
  const [placement, setPlacement] = useState<PlacementState | null>(null)
  const [calibrationElo, setCalibrationElo] = useState(1500)
  const [state, setState] = useState<LoadState>('loading')
  const [openId, setOpenId] = useState<string | null>(null)

  // Reloads index + mastery (also re-run after finishing a chapter to refresh badges).
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const api = window.api?.school
    if (!api) {
      setState('empty')
      return
    }
    let cancelled = false
    setState('loading')
    Promise.all([
      api.chapters().catch(() => ({ chapters: [] })),
      api.mastery().catch(() => null),
      api.placementState?.().catch(() => null) ?? Promise.resolve(null),
      api.placementConfig?.().catch(() => null) ?? Promise.resolve(null)
    ])
      .then(([cs, m, p, cfg]) => {
        if (cancelled) return
        const list = cs?.chapters ?? []
        setChapters(list)
        setMastery(m ?? null)
        setPlacement(p ?? null)
        if (cfg?.engineElo) setCalibrationElo(cfg.engineElo)
        setState(list.length > 0 ? 'ready' : 'empty')
      })
      .catch(() => {
        if (!cancelled) setState('empty')
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  // Placement is required once, and only when the bridge actually returned a state
  // (web/dev with no bridge => placement null => never block the index).
  const needsPlacement = state === 'ready' && placement != null && !placement.placed

  // ----- A chapter is open: hand the whole stage to the player. -----
  // The index below is a separate component so that exactly ONE screen owns the
  // readout at a time: two components writing the same slot fight over it.
  if (openId) {
    return (
      <ChapterPlayer
        chapterId={openId}
        onExit={() => {
          setOpenId(null)
          // Refresh progress/mastery so the index reflects the just-finished work.
          setReloadKey((k) => k + 1)
        }}
        onOpenSettings={onOpenSettings}
      />
    )
  }

  // ----- Not placed yet: the placement game gates the whole school. -----
  if (needsPlacement) {
    return (
      <PlacementFlow
        engineElo={calibrationElo}
        onPlaced={() => setReloadKey((k) => k + 1)}
        onOpenSettings={onOpenSettings}
      />
    )
  }

  return (
    <SchoolIndex
      chapters={chapters}
      mastery={mastery}
      placement={placement}
      state={state}
      onOpenChapter={setOpenId}
      onRetakePlacement={() => {
        void window.api?.school
          ?.resetPlacement?.()
          .then(() => setReloadKey((k) => k + 1))
          .catch(() => {})
      }}
    />
  )
}

// ---------------------------------------------------------------------------

function SchoolIndex({
  chapters,
  mastery,
  placement,
  state,
  onOpenChapter,
  onRetakePlacement
}: {
  chapters: SchoolChapterMeta[]
  mastery: SchoolMastery | null
  placement: PlacementState | null
  state: LoadState
  onOpenChapter: (id: string) => void
  onRetakePlacement: () => void
}): JSX.Element {
  // chapterId -> progress row, for badge lookup.
  const progressById = useMemo(() => {
    const map = new Map<string, ChapterProgressRow>()
    for (const row of mastery?.chapters ?? []) map.set(row.chapterId, row)
    return map
  }, [mastery])

  // chapterId -> count of completed lessons, for the real progress fractions.
  const doneLessonsByChapter = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of mastery?.lessons ?? []) map.set(l.chapterId, (map.get(l.chapterId) ?? 0) + 1)
    return map
  }, [mastery])

  const completedCount = useMemo(
    () => (mastery?.chapters ?? []).filter((c) => c.completed).length,
    [mastery]
  )
  const conceptsLearned = useMemo(
    () => (mastery?.concepts ?? []).filter((c) => c.mastery >= 0.6).length,
    [mastery]
  )

  const ordered = useMemo(
    () =>
      [...chapters].sort((a, b) => {
        if (a.band !== b.band) return a.band.localeCompare(b.band)
        return a.order - b.order
      }),
    [chapters]
  )
  const unlockedCount = useMemo(() => chapters.filter((c) => !c.locked).length, [chapters])

  // The learner's CURRENT chapter: first unlocked chapter not yet completed.
  const current = useMemo(
    () => ordered.find((ch) => !ch.locked && !(progressById.get(ch.id)?.completed ?? false)),
    [ordered, progressById]
  )

  // Chapters grouped into the named tiers by order range (empty tiers dropped).
  const tiers = useMemo(
    () =>
      TIERS.map((t) => ({
        ...t,
        chapters: ordered.filter((c) => c.order >= t.from && c.order <= t.to)
      })).filter((t) => t.chapters.length > 0),
    [ordered]
  )

  const started = current ? (doneLessonsByChapter.get(current.id) ?? 0) > 0 : false
  useReadoutSlot(
    current ? `${started ? 'Continue' : 'Start'} ${current.title}` : null,
    chapters.length > 0 ? completedCount / chapters.length : null
  )

  if (state === 'loading') {
    return (
      <div className="col-single" aria-busy="true">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Chapters</h2>
          </div>
          <div className="well">
            <div className="empty">
              <p className="empty-line" role="status">
                Loading the curriculum.
              </p>
              <p className="empty-line">Forty chapters, and where you stand in them.</p>
            </div>
          </div>
        </section>
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className="col-single">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Chapters</h2>
          </div>
          <div className="well">
            <div className="empty">
              <p className="empty-line">
                {window.api?.school
                  ? 'No chapters are installed yet.'
                  : 'Chess School lives in the desktop app.'}
              </p>
              <p className="empty-line">
                {window.api?.school
                  ? 'Viktor has nothing to teach until the curriculum is on this machine.'
                  : 'Connect to the desktop app to load Viktor’s chapters.'}
              </p>
            </div>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="home">
      <div>
        <TodayCard onOpenChapter={onOpenChapter} />

        {tiers.map((tier) => {
          const doneInTier = tier.chapters.filter(
            (c) => progressById.get(c.id)?.completed ?? false
          ).length
          const allLocked = tier.chapters.every((c) => c.locked)
          return (
            <section className="sec" key={tier.key}>
              <div className="sec-head">
                <h2 className="lbl">
                  {tier.numeral} · {tier.name}
                </h2>
                <span className="sec-count">
                  {allLocked ? 'Locked' : `${doneInTier} of ${tier.chapters.length} done`}
                </span>
              </div>
              <p className="sec-note">{tier.blurb}</p>
              <div className="panel golist">
                {tier.chapters.map((meta) => (
                  <ChapterRow
                    key={meta.id}
                    meta={meta}
                    isCurrent={meta.id === current?.id}
                    completed={progressById.get(meta.id)?.completed ?? false}
                    lessonsDone={doneLessonsByChapter.get(meta.id) ?? 0}
                    onOpen={() => onOpenChapter(meta.id)}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      <aside className="side">
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Your school</h2>
          </div>
          <div className="panel">
            <div className="facts">
              <div className="fact">
                <span>Unlocked</span>
                <span className="fact-value num">
                  {unlockedCount} of {chapters.length}
                </span>
              </div>
              <div className="fact">
                <span>Chapters passed</span>
                <span className="fact-value num">{completedCount}</span>
              </div>
              <div className="fact">
                <span>Concepts held</span>
                <span className="fact-value num">{conceptsLearned}</span>
              </div>
            </div>
            {placement?.placed && (
              <div className="panel-foot">
                <button className="btn is-quiet" type="button" onClick={onRetakePlacement}>
                  Retake placement
                </button>
              </div>
            )}
          </div>
        </section>

        <RecommendedNextCard onOpenChapter={onOpenChapter} />
      </aside>
    </div>
  )
}

/**
 * One chapter, as a row that takes you into it. Four states, and the state is
 * written where .go writes everything else: the name, one mono line under it,
 * and either the arrow or a .lbl saying why there is no arrow. A locked chapter
 * says what opens it and NEVER shows the internal Elo that ordered it.
 */
function ChapterRow({
  meta,
  isCurrent,
  completed,
  lessonsDone,
  onOpen
}: {
  meta: SchoolChapterMeta
  isCurrent: boolean
  completed: boolean
  lessonsDone: number
  onOpen: () => void
}): JSX.Element {
  const total = meta.lessonCount ?? 0
  const name = `${pad(meta.order)} ${meta.title}`

  if (meta.locked) {
    return (
      <div className="go" aria-disabled>
        <span>
          <span className="go-name">{name}</span>
          <span className="go-sub">
            {meta.lockReason === 'placement'
              ? 'Finish placement to open this one.'
              : 'Pass the chapters before it to open this one.'}
          </span>
        </span>
        <span className="lbl">Locked</span>
      </div>
    )
  }

  const sub = completed
    ? `Passed · ~${meta.estMinutes} min`
    : total > 0
      ? `${lessonsDone} of ${total} lessons · ~${meta.estMinutes} min`
      : `${meta.conceptCount} concept${meta.conceptCount === 1 ? '' : 's'} · ~${meta.estMinutes} min`

  return (
    <button className={`go${isCurrent ? ' row is-here' : ''}`} type="button" onClick={onOpen}>
      <span>
        <span className="go-name">{name}</span>
        <span className="go-sub">{sub}</span>
      </span>
      {completed ? (
        <span className="lbl">Done</span>
      ) : (
        <Icon id="i-arrow" className="icon go-arrow" />
      )}
    </button>
  )
}
