// The profile page: view anyone, including accounts whose owner is long gone.
// The page resolves the account over the network via viewerClient and renders
// what came back. There is no offline preview and no sample profile: a profile
// this device has not actually fetched does not render, so a lookup that cannot
// be reached says so, in the same sections and the same language as the rest of
// the account page, and says what to do next.
//
// WHAT THIS PAGE SHOWS A PLAYER: a name, a region, an age, ratings, reputation,
// and games. Nothing about how any of it was fetched or verified. The protocol
// facts the resolve returns (checkpoint height, cosigner counts, shard rows,
// contested revocations, the reconstruction floor) are NOT product copy. They
// collapse into one honest sentence when the view is incomplete, so a degraded
// profile is never presented as a complete one, and stay out of the UI
// otherwise. Opponent ladders render ONLY through the shared projection
// (mm/pairing visibleOpponentInfo), so a viewer never sees a rating they are not
// allowed to see.

import { useEffect, useState, type JSX } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  Clock,
  Copy,
  Globe,
  History,
  Loader2,
  ShieldAlert,
  Swords,
  Users
} from 'lucide-react'
import { visibleOpponentInfo, spectatorOpponentInfo } from '@shared/accounts/mm/pairing'
import { pairViewOf } from '@shared/accounts/ratings/display'
import type { UiGameRow, UiLadder, UiProfile, UiStanding } from '../mock/types'
import { useAccountsUi, type AccountsUiState, type ViewerDisplayByLadder } from '../mock/store'
import { getAccountPeer } from '../net/peerService'
import {
  gameRowsFromEvents,
  isAccountRoot,
  viewAccountForPeer,
  type ViewerAvailability,
  type ViewerResult
} from '../net/viewerClient'
import { ReconstructionCard } from './ReconstructionCard'
import { LADDER_ICON, RatingLadders, type LadderProjection } from './RatingLadders'
import { ReputationPanel } from './ReputationPanel'
import {
  DAY,
  accountAge,
  daysRemaining,
  gameDate,
  regionName,
  relativeWts,
  shortB64u
} from './profileFormat'
// The ladder, reputation and game-row rendering. The panels, wells, empty
// states and buttons around them are v1's own vocabulary, so this stylesheet
// carries only the parts v1 never drew.
import './profile.css'

/**
 * The rating-visibility projection for every ladder of a viewed profile (A4-17),
 * computed with the SHARED pure helpers over PairViews built from protocol
 * state. Signed-out viewers are spectators (spectatorOpponentInfo); signed-in
 * viewers project through the store's per-ladder viewer display state via
 * visibleOpponentInfo, so a placement/provisional viewer gets 'unranked-pool'
 * for that ladder, never a number or bracket.
 * Exported for the UI suite (scripts/test-a4-ui.mjs): the pins run against the
 * exact projection this page renders.
 */
export function projectionFor(
  subject: UiProfile,
  viewerRoot: string | null,
  viewerLadders: UiLadder[] | null,
  viewerDisplay: ViewerDisplayByLadder | null
): LadderProjection {
  const out: LadderProjection = {}
  for (const l of subject.ladders) {
    const opp = pairViewOf(subject.rootPub, `chess:${l.key}`, l.state, 0, l.key)
    const vl = viewerLadders?.find((v) => v.key === l.key)
    const vd = viewerDisplay?.[l.key]
    out[l.key] =
      viewerRoot && vl && vd
        ? visibleOpponentInfo(
            {
              root: viewerRoot,
              ladderId: `chess:${l.key}`,
              ratingMicro: vl.state.r,
              rdMicro: vl.state.rd,
              tMicro: 0,
              display: vd
            },
            opp
          )
        : spectatorOpponentInfo(opp)
  }
  return out
}

type LiveState =
  | { phase: 'resolving' }
  | { phase: 'ready'; result: ViewerResult }
  | { phase: 'unavailable'; availability: ViewerAvailability | null; reason: string }

export function ProfilePage({
  handle,
  root,
  onBack,
  initialRevealed,
  profile
}: {
  handle: string
  /** Explicit target account root (b64u). When omitted, a 43-char b64u `handle`
   *  is itself treated as the target root (view anyone by pasting their key). */
  root?: string
  onBack: () => void
  /** Skip-or-force the §5 reconstruction stage. Showcase/suite knob
   *  (scripts/test-a4-ui.mjs pins the revealed degraded view, A4-29); product
   *  callers omit it and get the owner-online default. */
  initialRevealed?: boolean
  /**
   * An ALREADY-RESOLVED profile, supplied by the caller. The A4 UI suite drives
   * the page this way, over known inputs, to pin the shared projections. The
   * app never passes it: every profile a player sees comes from the resolve
   * below, so there is no path from the shipped UI to a profile this device did
   * not fetch.
   */
  profile?: UiProfile
}): JSX.Element {
  // A target ROOT (explicit, or a root-shaped handle) is what the overlay can
  // look up. Anything else is not an account id this app can resolve.
  const targetRoot = root ?? (isAccountRoot(handle) ? handle : undefined)
  const isLive = profile === undefined && targetRoot !== undefined
  const ui = useAccountsUi()

  // Owner online → render straight from their live chain. Owner gone →
  // reconstruct from pointers/holders/shards first (§5), then reveal.
  const [revealed, setRevealed] = useState<boolean>(
    () => initialRevealed ?? (profile !== undefined && profile.reconstruction.ownerOnline)
  )
  const [live, setLive] = useState<LiveState>({ phase: 'resolving' })
  const [retryKey, setRetryKey] = useState(0)

  // Reset the flow when the viewed target changes.
  useEffect(() => {
    setRevealed(initialRevealed ?? (profile !== undefined && profile.reconstruction.ownerOnline))
    setLive({ phase: 'resolving' })
  }, [handle, root, initialRevealed, profile])

  // LIVE resolve: one authenticated-pointer lookup + the shard layer over the
  // peer overlay, via viewerClient. Never throws; a below-K_rec / no-pointer
  // target lands in an honest 'unavailable' phase (heals via repair on retry).
  useEffect(() => {
    if (!isLive || targetRoot === undefined) return
    let cancelled = false
    setLive({ phase: 'resolving' })
    setRevealed(initialRevealed ?? false)
    const peer = getAccountPeer()
    if (!peer) {
      setLive({ phase: 'unavailable', availability: null, reason: 'no-peer' })
      return
    }
    void viewAccountForPeer(peer, targetRoot)
      .then((result) => {
        if (cancelled) return
        if (result.availability.available) setLive({ phase: 'ready', result })
        else
          setLive({
            phase: 'unavailable',
            availability: result.availability,
            reason: result.availability.reason ?? 'below-k'
          })
      })
      .catch(() => {
        if (!cancelled) setLive({ phase: 'unavailable', availability: null, reason: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [isLive, targetRoot, retryKey, initialRevealed])

  // ---- Caller-supplied profile (the suite) -------------------------------
  if (profile !== undefined) {
    return (
      <div className="aprof-page">
        <PageTop label={profile.handle} onBack={onBack} />
        {!revealed ? (
          <ReconstructionCard
            handle={profile.handle}
            recon={profile.reconstruction}
            checkpoint={profile.checkpoint}
            onDone={() => setRevealed(true)}
          />
        ) : (
          <RevealedProfile profile={profile} ui={ui} nowMs={Date.now()} pager={null} />
        )}
      </div>
    )
  }

  // ---- Nothing to look up ------------------------------------------------
  // A real state, said plainly: what was typed is not an account id, so there
  // is nothing to fetch and nothing to show. Never a stand-in profile.
  if (targetRoot === undefined) {
    return (
      <div className="aprof-page">
        <PageTop label={handle} onBack={onBack} />
        <section className="sec">
          <div className="well">
            <div className="empty">
              <p className="empty-line">No account matches that id. Check it and try again.</p>
              <p className="empty-line">
                An account id is 43 characters. Ask the player to copy theirs and paste the whole
                thing.
              </p>
            </div>
          </div>
        </section>
      </div>
    )
  }

  // ---- LIVE resolve ------------------------------------------------------
  const shortHandle = shortB64u(targetRoot)
  return (
    <div className="aprof-page">
      <PageTop label={shortHandle} onBack={onBack} />

      {live.phase === 'resolving' && (
        <ReconstructionCard handle={shortHandle} recon={null} checkpoint={null} onDone={() => {}} />
      )}

      {live.phase === 'unavailable' && (
        <UnavailableSection
          reason={live.reason}
          onRetry={() => setRetryKey((k) => k + 1)}
          onBack={onBack}
        />
      )}

      {live.phase === 'ready' &&
        (!revealed ? (
          <ReconstructionCard
            handle={shortHandle}
            recon={live.result.profile.reconstruction}
            checkpoint={live.result.profile.checkpoint}
            onDone={() => setRevealed(true)}
          />
        ) : (
          <RevealedProfile
            profile={live.result.profile}
            ui={ui}
            nowMs={Date.now()}
            pager={live.result.pager}
          />
        ))}
    </div>
  )
}

/** The page's one row of chrome: back, what page this is, whose id is open. */
function PageTop({ label, onBack }: { label: string; onBack: () => void }): JSX.Element {
  return (
    <div className="aprof-page-top">
      <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden />
      </button>
      <span className="aprof-page-title">Profile</span>
      <span className="account-handle-mono muted small">{label}</span>
    </div>
  )
}

/** The profile could not be loaded this pass (not connected, nothing found, or
 *  too little of it reachable). What happened and what to do about it, in the
 *  page's own empty-state language: the resolve's reason codes stay internal,
 *  because none of them changes what the player does next. Never a fabricated
 *  profile. */
function UnavailableSection({
  reason,
  onRetry,
  onBack
}: {
  reason: string
  onRetry: () => void
  onBack: () => void
}): JSX.Element {
  const [line, next] =
    reason === 'no-peer'
      ? ['You are not connected yet.', 'Wait a moment, then retry.']
      : reason === 'no-pointers'
        ? ['No account matches that id. Check it and try again.', 'Retry once you have.']
        : ['This profile could not be loaded right now.', 'Try again in a moment.']
  return (
    <section className="sec">
      <div className="well">
        <div className="empty">
          <p className="empty-line">{line}</p>
          <p className="empty-line">{next}</p>
        </div>
        <div className="panel-foot aprof-foot-row">
          <button type="button" className="btn is-quiet" onClick={onRetry}>
            Retry
          </button>
          <button type="button" className="btn is-quiet" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    </section>
  )
}

/** The revealed profile body. The caller supplies the resolved UiProfile, the
 *  clock the relative times are read against, and the lazy history pager the
 *  resolve came with (null when there is nothing more to page). */
function RevealedProfile({
  profile,
  ui,
  nowMs,
  pager
}: {
  profile: UiProfile
  ui: AccountsUiState
  nowMs: number
  pager: ViewerResult['pager']
}): JSX.Element {
  const stale = nowMs - profile.lastWitnessedWts > 30 * DAY
  const totalGames = profile.ladders.reduce((n, l) => n + l.games, 0)
  const recon = profile.reconstruction
  // Every degradation signal the resolve can carry, collapsed to the one bit a
  // player can act on: is this view missing something?
  const incomplete =
    recon.path === 'floor' || recon.revocationContested || !profile.checkpoint.mOfN
  const [copied, setCopied] = useState(false)

  // Game history, lazy-paged through the pager the resolve returned
  // (openHistory). Without a pager there is one page and it is already here.
  const [liveGames, setLiveGames] = useState<UiGameRow[] | null>(null)
  const [nextPage, setNextPage] = useState(0)
  const [livePaging, setLivePaging] = useState<'idle' | 'busy' | 'settled' | 'end'>('idle')

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  // Load the newest history page (page 0) once, for the live path.
  useEffect(() => {
    if (!pager) return
    let cancelled = false
    setLivePaging('busy')
    void pager.page(0).then((p) => {
      if (cancelled) return
      if (p.ok) {
        setLiveGames(gameRowsFromEvents(p.events))
        setNextPage(1)
        setLivePaging(1 >= pager.pageCount ? 'end' : 'idle')
      } else {
        setLiveGames([])
        setLivePaging('settled')
      }
    })
    return () => {
      cancelled = true
    }
  }, [pager])

  const loadMoreLive = (): void => {
    if (!pager || nextPage >= pager.pageCount) {
      setLivePaging('end')
      return
    }
    setLivePaging('busy')
    const page = nextPage
    void pager.page(page).then((p) => {
      if (p.ok) {
        setLiveGames((g) => [...(g ?? []), ...gameRowsFromEvents(p.events)])
        setNextPage(page + 1)
        setLivePaging(page + 1 >= pager.pageCount ? 'end' : 'idle')
      } else {
        setLivePaging('settled')
      }
    })
  }

  // A4-17: own profile renders own numbers; anyone else renders through the
  // shared viewer projection. Signed-out means the spectator projection.
  const own = ui.account
  const isOwn = own !== null && own.handle === profile.handle
  const projection = isOwn
    ? undefined
    : projectionFor(profile, own?.rootPub ?? null, own?.ladders ?? null, ui.viewerDisplay)
  const viewerHiddenSomewhere =
    projection !== undefined && Object.values(projection).some((p) => p?.kind === 'unranked-pool')

  const copyHandle = (): void => {
    void navigator.clipboard?.writeText(profile.rootPub).catch(() => undefined)
    setCopied(true)
  }

  // The games to show + the paging control state.
  const games = pager ? (liveGames ?? []) : profile.games
  const pagingBusy = pager !== null && livePaging === 'busy'
  const pagingSettled = pager !== null && livePaging === 'settled'
  // No pager (rare: a segment floor with no pinned head) has nothing to page:
  // treat as ended so no dead "Load more" button renders.
  const pagingEnded = pager ? livePaging === 'end' : true

  return (
    <>
      <section className="panel aprof-card aprof-rail aprof-head-card">
        <div className="aprof-identity">
          <span className="aprof-avatar" aria-hidden>
            <span className="aprof-avatar-glyph">{profile.flair}</span>
          </span>
          <div className="aprof-identity-main">
            <h3 className="aprof-name">
              {profile.displayName}
              <span className="aprof-tag">#{profile.tag}</span>
            </h3>
            <span className="aprof-handle account-handle-mono">
              {shortB64u(profile.rootPub)}
              <button
                type="button"
                className="aprof-copy"
                aria-label={copied ? 'Copied' : 'Copy account key'}
                onClick={copyHandle}
              >
                {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
              </button>
            </span>
            {profile.bio.trim() !== '' && <p className="aprof-bio">{profile.bio}</p>}
          </div>
          <div className="aprof-meta">
            {profile.country.trim() !== '' && (
              <span className="aprof-meta-pill">
                <Globe size={12} aria-hidden /> {regionName(profile.country)}
              </span>
            )}
            {profile.createdWts > 0 && (
              <span className="aprof-meta-pill">
                <History size={12} aria-hidden /> {accountAge(profile.createdWts, nowMs)} on the network
              </span>
            )}
            {/* A count nobody took is not a count of zero, so an unknown one
                renders as nothing at all. */}
            {profile.friendsCount !== null && (
              <span className="aprof-meta-pill num">
                <Users size={12} aria-hidden /> {profile.friendsCount} friends
              </span>
            )}
            {profile.ladders.length > 0 && (
              <span className="aprof-meta-pill num">
                <Swords size={12} aria-hidden /> {totalGames.toLocaleString()} games
              </span>
            )}
          </div>
        </div>
        {profile.lastWitnessedWts > 0 && (
          <div className={`aprof-staleness${stale ? ' is-stale' : ''}`}>
            <Clock size={13} aria-hidden /> Last played {relativeWts(profile.lastWitnessedWts, nowMs)}
          </div>
        )}
      </section>

      <StandingStrip standing={profile.standing} nowMs={nowMs} />

      {/* A4-29 / C-12 in ONE player-facing sentence. Every degradation the
          resolve can report (the reconstruction floor, a contested revocation, a
          checkpoint under the cosigner threshold) means the same thing to the
          person reading: part of this profile is missing. So it is said once, in
          those words, and the incomplete view is never dressed up as complete.
          The individual carriers stay internal: they name mechanisms a player
          cannot act on. */}
      {incomplete && (
        <div className="aprof-contested" role="status">
          <span className="aprof-contested-icon" aria-hidden>
            <AlertTriangle size={15} />
          </span>
          <div className="aprof-contested-body">
            <strong className="aprof-contested-title">
              Some of this profile could not be loaded
            </strong>
            <span className="aprof-contested-sub">
              Recent games may be missing. Try again in a moment.
            </span>
          </div>
        </div>
      )}

      <div className="aprof-columns">
        <section className="panel aprof-card">
          <header className="aprof-card-head">
            <span className="aprof-eyebrow">Ratings</span>
            {viewerHiddenSomewhere && (
              <p className="aprof-card-sub muted small">
                Ratings stay hidden until your own rating shows.
              </p>
            )}
          </header>
          <div className="aprof-card-body">
            {/* Nothing recovered means nothing known, and nothing known renders
                as the empty state rather than as four fresh-looking ladders. */}
            {profile.ladders.length > 0 ? (
              <RatingLadders ladders={profile.ladders} projection={projection} />
            ) : (
              <div className="empty">
                <p className="empty-line">Ratings could not be loaded.</p>
                <p className="empty-line">Try again in a moment.</p>
              </div>
            )}
          </div>
        </section>

        <section className="panel aprof-card">
          <header className="aprof-card-head">
            <span className="aprof-eyebrow">Reputation</span>
            <p className="aprof-card-sub muted small">
              How other players have found them to play against.
            </p>
          </header>
          <div className="aprof-card-body">
            {profile.reputation !== null ? (
              <ReputationPanel reputation={profile.reputation} />
            ) : (
              <div className="empty">
                <p className="empty-line">Their conduct record could not be loaded.</p>
                <p className="empty-line">Try again in a moment.</p>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="panel aprof-card">
        <header className="aprof-card-head aprof-card-head-row">
          <span className="aprof-eyebrow">Games</span>
          <span className="muted small">newest first</span>
        </header>
        {games.length > 0 ? (
          <ul className="aprof-games">
            {games.map((g) => (
              <GameRow key={g.id} game={g} nowMs={nowMs} />
            ))}
          </ul>
        ) : (
          <p className="aprof-games-empty muted small">No games yet.</p>
        )}
        <div className="aprof-games-foot">
          {!pagingEnded && (
            <button
              type="button"
              className="btn is-quiet aprof-btn-sm"
              disabled={pagingBusy}
              onClick={loadMoreLive}
            >
              {pagingBusy ? (
                <>
                  <Loader2 size={13} className="aprof-spin" aria-hidden /> Loading…
                </>
              ) : (
                'Load more'
              )}
            </button>
          )}
          {pagingEnded && games.length > 0 && (
            <p className="aprof-games-note muted small" role="status">
              That&rsquo;s every game.
            </p>
          )}
          {pagingSettled && (
            <p className="aprof-games-note muted small" role="status">
              Older games could not be loaded right now. Try again in a moment.
            </p>
          )}
        </div>
      </section>
    </>
  )
}

/** Standing, when it is not good. A ban is a public fact and the player needs
 *  the date it lifts, so that is what this says. Which rule produced it, and
 *  what signed record it cites, are protocol facts with no user action attached:
 *  they stay out. */
function StandingStrip({ standing, nowMs }: { standing: UiStanding; nowMs: number }): JSX.Element | null {
  if (standing.state === 'good') return null

  const permanent = standing.state !== 'self-ban' && standing.state !== 'pin-fuse'
  const title =
    standing.state === 'self-ban'
      ? 'Rated play paused'
      : standing.state === 'pin-fuse'
        ? 'Account locked'
        : 'Account banned'

  return (
    <div className="aprof-standing" role="status">
      <span className="aprof-standing-icon" aria-hidden>
        {permanent ? <ShieldAlert size={15} /> : <Ban size={15} />}
      </span>
      <div className="aprof-standing-body">
        <span className="aprof-standing-titlerow">
          <strong className="aprof-standing-title">{title}</strong>
          <span className="aprof-standing-days num">
            {permanent ? 'permanent' : `${daysRemaining(standing.expiresWts, nowMs)} days remaining`}
          </span>
        </span>
      </div>
    </div>
  )
}

/** One game row, from the profile owner's perspective. */
function GameRow({ game, nowMs }: { game: UiGameRow; nowMs: number }): JSX.Element {
  const Icon = LADDER_ICON[game.ladder]
  const kind =
    game.result === '1/2-1/2'
      ? 'draw'
      : (game.result === '1-0') === (game.userColor === 'w')
        ? 'win'
        : 'loss'
  const label = kind === 'win' ? 'Win' : kind === 'loss' ? 'Loss' : 'Draw'
  return (
    <li className="aprof-game">
      <span className={`aprof-result is-${kind}`}>{label}</span>
      <span className="aprof-game-ladder">
        <Icon size={13} aria-hidden /> {game.ladder}
      </span>
      <span className="aprof-game-opp">
        vs <span className="account-handle-mono">{game.opponent}</span>
      </span>
      <span className="aprof-game-color muted small">
        as {game.userColor === 'w' ? 'White' : 'Black'}
      </span>
      <span className="aprof-game-when muted small num">{gameDate(game.ts, nowMs)}</span>
    </li>
  )
}
