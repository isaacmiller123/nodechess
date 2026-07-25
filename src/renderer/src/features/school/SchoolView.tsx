import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  GraduationCap,
  Lock,
  Play,
  RotateCcw,
  Trophy
} from 'lucide-react'
import type {
  SchoolChapterMeta,
  ChapterProgressRow,
  SchoolMastery,
  PlacementState
} from '@shared/types'
import { ChapterPlayer } from './ChapterPlayer'
import { PlacementFlow } from './PlacementFlow'
import { TodayCard } from './TodayCard'
import { RecommendedNextCard } from './RecommendedNextCard'
import { ProgressRing } from './ChapterOverview'
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

type NodeState = 'done' | 'current' | 'open' | 'locked'

/**
 * Chess School index, Viktor's curriculum as a guided JOURNEY: a header band
 * (identity + stats + the Today/Recommended surfaces side by side) above the
 * tiered chapter path. The current chapter is the hero card with a progress
 * ring and Continue CTA; completed chapters compact with checkmarks; locked
 * chapters dimmed with a name-based hint (never an Elo). Selecting a chapter
 * opens the full-board ChapterPlayer. Degrades gracefully when the desktop
 * bridge is absent (clear "connect" state instead of crashing).
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

  // Sorted chapters + derived journey state. ALL hooks run before any early
  // return below so the hook order is stable across renders (React error #300).
  const ordered = useSorted(chapters)
  const unlockedCount = useMemo(() => chapters.filter((c) => !c.locked).length, [chapters])

  // The learner's CURRENT chapter: first unlocked chapter not yet completed.
  // It renders as the hero card on the path.
  const currentId = useMemo(() => {
    for (const ch of ordered) {
      if (ch.locked) continue
      if (!(progressById.get(ch.id)?.completed ?? false)) return ch.id
    }
    return null
  }, [ordered, progressById])

  // Chapters grouped into the named tiers by order range (empty tiers dropped).
  const tiers = useMemo(
    () =>
      TIERS.map((t) => ({
        ...t,
        chapters: ordered.filter((c) => c.order >= t.from && c.order <= t.to)
      })).filter((t) => t.chapters.length > 0),
    [ordered]
  )

  // Placement is required once, and only when the bridge actually returned a state
  // (web/dev with no bridge => placement null => never block the index).
  const needsPlacement = state === 'ready' && placement != null && !placement.placed

  // Clear placement so the learner can re-place (re-runs the placement game, which
  // re-derives which chapters are pre-completed).
  const retakePlacement = (): void => {
    void window.api?.school
      ?.resetPlacement?.()
      .then(() => setReloadKey((k) => k + 1))
      .catch(() => {})
  }

  // ----- A chapter is open: hand the whole stage to the player. -----
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

  // ----- Index: header band + journey. -----
  return (
    <div className="school-view">
      <header className="school-hero">
        <div className="school-hero-top">
          <div className="school-hero-id">
            <span className="school-hero-avatar" aria-hidden>
              <GraduationCap size={20} />
            </span>
            <div className="school-hero-copy">
              <h2 className="school-hero-title">Viktor’s Chess School</h2>
              <p className="school-lede">
                Taught on the board, drilled in guided practice, proven against the engine.
              </p>
            </div>
          </div>
          {state === 'ready' && (
            <div className="school-stats">
              <SchoolStat icon={<BookOpen size={15} />} num={unlockedCount} label="Unlocked" />
              <SchoolStat icon={<CheckCircle2 size={15} />} num={completedCount} label="Completed" />
              <SchoolStat icon={<Trophy size={15} />} num={conceptsLearned} label="Concepts" />
              {placement?.placed && (
                <button type="button" className="school-retake" onClick={retakePlacement}>
                  <RotateCcw size={13} /> Retake placement
                </button>
              )}
            </div>
          )}
        </div>

        {/* Today (daily lesson + local-day streak) and Viktor's weakness-driven
            "Recommended next", compact side-by-side header surfaces. Each renders
            null until the bridge returns data. */}
        {state === 'ready' && (
          <div className="school-home-surfaces">
            <TodayCard onOpenChapter={(id) => setOpenId(id)} />
            <RecommendedNextCard onOpenChapter={(id) => setOpenId(id)} />
          </div>
        )}
      </header>

      {state === 'loading' && (
        <>
          <span className="visually-hidden" role="status">
            Loading chapters…
          </span>
          <SchoolSkeleton />
        </>
      )}

      {state === 'empty' && (
        <div className="school-state">
          <span className="school-state-icon" aria-hidden>
            <GraduationCap size={26} />
          </span>
          <h3 className="school-state-title">
            {window.api?.school ? 'No chapters yet' : 'Chess School lives in the desktop app'}
          </h3>
          <p className="muted">
            {window.api?.school
              ? 'No chapters are available yet.'
              : 'Connect to the desktop app to load Viktor’s chapters.'}
          </p>
        </div>
      )}

      {state === 'ready' && (
        <div className="school-journey">
          {tiers.map((tier) => {
            const doneInTier = tier.chapters.filter(
              (c) => progressById.get(c.id)?.completed ?? false
            ).length
            const allLocked = tier.chapters.every((c) => c.locked)
            const tierComplete = doneInTier === tier.chapters.length
            const tierPct = tier.chapters.length > 0 ? doneInTier / tier.chapters.length : 0
            return (
              <section
                key={tier.key}
                className={`school-tier${allLocked ? ' is-locked' : ''}${
                  tierComplete ? ' is-complete' : ''
                }`}
              >
                <header className="school-tier-head">
                  <span className="school-tier-index" aria-hidden>
                    {tierComplete ? <Check size={18} /> : tier.numeral}
                  </span>
                  <div className="school-tier-copy">
                    <h3 className="school-tier-name">{tier.name}</h3>
                    <p className="school-tier-blurb">{tier.blurb}</p>
                  </div>
                  <div className="school-tier-meter">
                    {allLocked ? (
                      <span className="school-tier-lock">
                        <Lock size={13} /> Locked
                      </span>
                    ) : (
                      <>
                        <span className="school-tier-count num">
                          {doneInTier}/{tier.chapters.length}
                        </span>
                        <div
                          className="school-tier-bar"
                          role="progressbar"
                          aria-valuenow={Math.round(tierPct * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${tier.name} progress`}
                        >
                          <div
                            className="school-tier-bar-fill"
                            style={{ width: `${Math.round(tierPct * 100)}%` }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </header>
                <ol className="school-path">
                  {tier.chapters.map((ch) => {
                    const progress = progressById.get(ch.id)
                    const nodeState: NodeState = ch.locked
                      ? 'locked'
                      : (progress?.completed ?? false)
                        ? 'done'
                        : ch.id === currentId
                          ? 'current'
                          : 'open'
                    return (
                      <JourneyNode
                        key={ch.id}
                        meta={ch}
                        nodeState={nodeState}
                        bossWon={progress?.bossWon ?? false}
                        lessonsDone={doneLessonsByChapter.get(ch.id) ?? 0}
                        onOpen={() => setOpenId(ch.id)}
                      />
                    )
                  })}
                </ol>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function useSorted(chapters: SchoolChapterMeta[]): SchoolChapterMeta[] {
  return useMemo(
    () =>
      [...chapters].sort((a, b) => {
        if (a.band !== b.band) return a.band.localeCompare(b.band)
        return a.order - b.order
      }),
    [chapters]
  )
}

function SchoolStat({
  icon,
  num,
  label
}: {
  icon: JSX.Element
  num: number
  label: string
}): JSX.Element {
  return (
    <div className="school-stat">
      <span className="school-stat-icon">{icon}</span>
      <span className="school-stat-num num">{num}</span>
      <span className="school-stat-label">{label}</span>
    </div>
  )
}

/** Two-digit chapter number for the compact rows ("04", "23"). */
function pad(order: number): string {
  return String(order).padStart(2, '0')
}

/**
 * One chapter on the journey path. Four states:
 *   • current. The hero: big card, progress ring, Continue/Start CTA
 *   • done:     compact row with a checkmark and a Review affordance
 *   • open:     unlocked but not current (rare; e.g. after a re-placement)
 *   • locked:   dimmed, non-interactive, name-based hint (NEVER an Elo)
 */
function JourneyNode({
  meta,
  nodeState,
  bossWon,
  lessonsDone,
  onOpen
}: {
  meta: SchoolChapterMeta
  nodeState: NodeState
  bossWon: boolean
  lessonsDone: number
  onOpen: () => void
}): JSX.Element {
  const totalLessons = meta.lessonCount ?? 0
  // Real progress: the fraction of lessons done (placement pre-completes the
  // chapters you tested out of, so those read full via the 'done' state).
  const donePct =
    nodeState === 'done' ? 1 : totalLessons > 0 ? Math.min(1, lessonsDone / totalLessons) : 0
  const started = lessonsDone > 0

  if (nodeState === 'locked') {
    return (
      <li className="school-node is-locked">
        <span className="school-node-marker" aria-hidden>
          <Lock size={14} />
        </span>
        <div className="school-locked-card" aria-disabled>
          <span className="school-node-order num" aria-hidden>
            {pad(meta.order)}
          </span>
          <span className="school-locked-title">{meta.title}</span>
          <span className="school-locked-hint">
            {meta.lockReason === 'placement'
              ? 'Finish placement to unlock'
              : 'Pass earlier chapters to unlock'}
          </span>
        </div>
      </li>
    )
  }

  if (nodeState === 'done') {
    return (
      <li className="school-node is-done">
        <span className="school-node-marker" aria-hidden>
          <Check size={15} />
        </span>
        <button type="button" className="school-done-card" onClick={onOpen}>
          <span className="school-node-order num" aria-hidden>
            {pad(meta.order)}
          </span>
          <span className="school-done-title">{meta.title}</span>
          {bossWon && (
            <span
              className="school-done-boss"
              role="img"
              title="Sparring game won"
              aria-label="Sparring game won"
            >
              <Trophy size={13} />
            </span>
          )}
          <span className="school-done-cta">
            Review <ChevronRight size={14} />
          </span>
        </button>
      </li>
    )
  }

  if (nodeState === 'current') {
    return (
      <li className="school-node is-current">
        <span className="school-node-marker" aria-hidden>
          <Play size={14} />
        </span>
        <button type="button" className="school-current-card" onClick={onOpen}>
          <ProgressRing
            pct={donePct}
            size={64}
            stroke={6}
            label={started ? undefined : <Play size={20} />}
          />
          <span className="school-current-body">
            <span className="school-current-eyebrow">
              Chapter {meta.order} · {started ? 'In progress' : 'Up next'}
            </span>
            <span className="school-current-title">{meta.title}</span>
            <span className="school-current-sub">{meta.subtitle}</span>
            <span className="school-card-meta">
              {totalLessons > 0 ? (
                <span className="school-card-fact">
                  <BookOpen size={14} /> {started ? `${lessonsDone}/${totalLessons}` : totalLessons}{' '}
                  lesson{totalLessons === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="school-card-fact">
                  <GraduationCap size={14} /> {meta.conceptCount} concept
                  {meta.conceptCount === 1 ? '' : 's'}
                </span>
              )}
              <span className="school-card-fact">
                <Clock size={14} /> ~{meta.estMinutes} min
              </span>
            </span>
          </span>
          <span className="school-current-cta">
            {started ? 'Continue' : 'Start'} <ChevronRight size={18} />
          </span>
        </button>
      </li>
    )
  }

  // Unlocked but neither current nor completed.
  return (
    <li className="school-node is-open">
      <span className="school-node-marker" aria-hidden>
        <span className="school-node-dot" />
      </span>
      <button type="button" className="school-open-card" onClick={onOpen}>
        <span className="school-node-order num" aria-hidden>
          {pad(meta.order)}
        </span>
        <span className="school-open-body">
          <span className="school-open-title">{meta.title}</span>
          {started && totalLessons > 0 && (
            <span className="school-open-progress" aria-hidden>
              <span
                className="school-open-progress-fill"
                style={{ width: `${Math.round(donePct * 100)}%` }}
              />
            </span>
          )}
        </span>
        <span className="school-open-cta">
          {started ? `Continue · ${lessonsDone}/${totalLessons}` : 'Start'}{' '}
          <ChevronRight size={14} />
        </span>
      </button>
    </li>
  )
}

/** Index loading skeleton: header surfaces + one tier with hero and rows. */
function SchoolSkeleton(): JSX.Element {
  return (
    <div className="school-skeleton" aria-hidden>
      <div className="school-home-surfaces">
        <div className="school-skel skel-surface" />
        <div className="school-skel skel-surface" />
      </div>
      <div className="skel-tier">
        <div className="school-skel skel-tier-head" />
        <div className="school-skel skel-hero" />
        <div className="school-skel skel-row" />
        <div className="school-skel skel-row" />
        <div className="school-skel skel-row" />
      </div>
    </div>
  )
}
