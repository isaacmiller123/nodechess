// The profile page: view anyone, including accounts whose owner is long gone.
// When a target account root is opened and the live peer is up, the page
// resolves the profile over the network via viewerClient; without a live peer it
// falls back to the clearly-labelled sample profiles (offline preview).
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
  CloudOff,
  Copy,
  Globe,
  History,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Swords,
  Users
} from 'lucide-react'
import { visibleOpponentInfo, spectatorOpponentInfo } from '@shared/accounts/mm/pairing'
import { pairViewOf } from '@shared/accounts/ratings/display'
import { DEV_FIXTURE, MOCK_NOW, PROFILES, shortB64u } from '../mock/fixtures'
import { FixturePreviewBadge } from '../mock/FixturePreviewBadge'
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
import { DAY, accountAge, daysRemaining, gameDate, regionName, relativeWts } from './profileFormat'

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
  initialRevealed
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
}): JSX.Element {
  // A target ROOT (explicit, or a root-shaped handle) drives LIVE reconstruction
  // over the overlay; anything else is a fixture display handle (offline preview).
  const targetRoot = root ?? (isAccountRoot(handle) ? handle : undefined)
  const isLive = targetRoot !== undefined
  const fixtureProfile: UiProfile | undefined = PROFILES[handle]
  const ui = useAccountsUi()

  // Owner online → render straight from their live chain. Owner gone →
  // reconstruct from pointers/holders/shards first (§5), then reveal.
  const [revealed, setRevealed] = useState<boolean>(
    () => initialRevealed ?? (!isLive && (!fixtureProfile || fixtureProfile.reconstruction.ownerOnline))
  )
  const [paging, setPaging] = useState<'idle' | 'busy' | 'settled'>('idle')
  const [live, setLive] = useState<LiveState>({ phase: 'resolving' })
  const [retryKey, setRetryKey] = useState(0)

  // Reset the flow when the viewed target changes.
  useEffect(() => {
    const p = PROFILES[handle]
    const liveTarget = root ?? (isAccountRoot(handle) ? handle : undefined)
    setRevealed(initialRevealed ?? (liveTarget === undefined && (!p || p.reconstruction.ownerOnline)))
    setPaging('idle')
    setLive({ phase: 'resolving' })
  }, [handle, root, initialRevealed])

  // Fixture-only lazy-page mock: ask the holders, come back with the honest
  // failure mode (temporary unavailability that heals), never a dead button.
  useEffect(() => {
    if (isLive || paging !== 'busy') return
    const t = window.setTimeout(() => setPaging('settled'), 950)
    return () => window.clearTimeout(t)
  }, [paging, isLive])

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

  // ---- LIVE reconstruction path ------------------------------------------
  if (isLive && targetRoot !== undefined) {
    const shortHandle = shortB64u(targetRoot)
    return (
      <div className="aprof-page">
        <div className="aprof-page-top">
          <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden />
          </button>
          <span className="aprof-page-title">Profile</span>
          <span className="account-handle-mono muted small">{shortHandle}</span>
        </div>

        {live.phase === 'resolving' && (
          <ReconstructionCard handle={shortHandle} recon={null} checkpoint={null} onDone={() => {}} />
        )}

        {live.phase === 'unavailable' && (
          <UnavailableCard
            handle={shortHandle}
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
            <RevealedProfile profile={live.result.profile} ui={ui} nowMs={Date.now()} pager={live.result.pager} />
          ))}
      </div>
    )
  }

  // ---- FIXTURE preview path (offline / display-handle) -------------------
  if (!fixtureProfile) {
    return (
      <div className="aprof-page">
        <div className="aprof-page-top">
          <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden />
          </button>
          <span className="aprof-page-title">Profile</span>
          <span className="account-handle-mono muted small">{handle}</span>
        </div>
        <section className="card aprof-card aprof-missing">
          <span className="aprof-missing-icon" aria-hidden>
            <Search size={22} />
          </span>
          <h3 className="aprof-missing-title">Nothing found</h3>
          <p className="muted">No account matches that id. Check it and try again.</p>
          <button type="button" className="btn ghost" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden /> Back
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="aprof-page">
      <div className="aprof-page-top">
        <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />
        </button>
        <span className="aprof-page-title">Profile</span>
        <span className="account-handle-mono muted small">{fixtureProfile.handle}</span>
        {DEV_FIXTURE && (
          <FixturePreviewBadge label="Sample profile (offline preview)" />
        )}
      </div>

      {!revealed ? (
        <ReconstructionCard
          handle={fixtureProfile.handle}
          recon={fixtureProfile.reconstruction}
          checkpoint={fixtureProfile.checkpoint}
          onDone={() => setRevealed(true)}
        />
      ) : (
        <RevealedProfile
          profile={fixtureProfile}
          ui={ui}
          nowMs={MOCK_NOW}
          pager={null}
          paging={paging}
          onLoadMore={() => setPaging('busy')}
        />
      )}
    </div>
  )
}

/** The profile could not be loaded this pass (not connected, nothing found, or
 *  too little of it reachable). One plain sentence and a retry: the resolve's
 *  reason codes stay internal, because none of them changes what the player
 *  does next. Never a fabricated profile. */
function UnavailableCard({
  handle,
  reason,
  onRetry,
  onBack
}: {
  handle: string
  reason: string
  onRetry: () => void
  onBack: () => void
}): JSX.Element {
  const copy =
    reason === 'no-peer'
      ? 'You are not connected yet. Wait a moment, then retry.'
      : reason === 'no-pointers'
        ? 'No account matches that id. Check it and try again.'
        : 'This profile could not be loaded right now. Try again in a moment.'
  return (
    <section className="card aprof-card aprof-rail aprof-recon">
      <header className="aprof-card-head">
        <span className="aprof-eyebrow">
          <CloudOff size={14} aria-hidden /> <span className="account-handle-mono">{handle}</span>
        </span>
        <p className="aprof-card-sub muted small">{copy}</p>
      </header>
      <div className="aprof-games-foot">
        <button type="button" className="btn ghost aprof-btn-sm" onClick={onRetry}>
          <RefreshCw size={13} aria-hidden /> Retry
        </button>
        <button type="button" className="btn ghost aprof-btn-sm" onClick={onBack}>
          <ArrowLeft size={13} aria-hidden /> Back
        </button>
      </div>
    </section>
  )
}

/** The revealed profile body. Identical rendering for the live resolve and the
 *  fixture preview; the caller supplies the UiProfile, its evaluation clock
 *  (Date.now for live data, MOCK_NOW for the frozen fixture), and the lazy
 *  history pager (live) or the fixture mock paging state. */
function RevealedProfile({
  profile,
  ui,
  nowMs,
  pager,
  paging: fixturePaging,
  onLoadMore: fixtureLoadMore
}: {
  profile: UiProfile
  ui: AccountsUiState
  nowMs: number
  pager: ViewerResult['pager']
  paging?: 'idle' | 'busy' | 'settled'
  onLoadMore?: () => void
}): JSX.Element {
  const isLive = pager !== null || fixturePaging === undefined
  const stale = nowMs - profile.lastWitnessedWts > 30 * DAY
  const totalGames = profile.ladders.reduce((n, l) => n + l.games, 0)
  const recon = profile.reconstruction
  // Every degradation signal the resolve can carry, collapsed to the one bit a
  // player can act on: is this view missing something?
  const incomplete =
    recon.path === 'floor' || recon.revocationContested || !profile.checkpoint.mOfN
  const [copied, setCopied] = useState(false)

  // Live game history, lazy-paged through the pager (openHistory). Fixture
  // preview renders profile.games with the mock "load more" note.
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

  // The games to show + the paging control state (live pager vs fixture mock).
  const games = pager ? (liveGames ?? []) : profile.games
  const pagingBusy = pager ? livePaging === 'busy' : fixturePaging === 'busy'
  const pagingSettled = pager ? livePaging === 'settled' : fixturePaging === 'settled'
  // Live with no pager (rare: a segment floor with no pinned head) has nothing to
  // page: treat as ended so no dead "Load more" button renders.
  const pagingEnded = pager ? livePaging === 'end' : isLive
  const onLoadMore = pager ? loadMoreLive : (fixtureLoadMore ?? (() => {}))

  return (
    <>
      <section className="card aprof-card aprof-rail aprof-head-card">
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
              {isLive ? shortB64u(profile.rootPub) : profile.handle}
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
            <span className="aprof-meta-pill">
              <Globe size={12} aria-hidden /> {regionName(profile.country)}
            </span>
            {profile.createdWts > 0 && (
              <span className="aprof-meta-pill">
                <History size={12} aria-hidden /> {accountAge(profile.createdWts, nowMs)} on the network
              </span>
            )}
            <span className="aprof-meta-pill num">
              <Users size={12} aria-hidden /> {profile.friendsCount} friends
            </span>
            <span className="aprof-meta-pill num">
              <Swords size={12} aria-hidden /> {totalGames.toLocaleString()} games
            </span>
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
        <section className="card aprof-card aprof-panel">
          <header className="aprof-card-head">
            <span className="aprof-eyebrow">Ratings</span>
            {viewerHiddenSomewhere && (
              <p className="aprof-card-sub muted small">
                Ratings stay hidden until your own rating shows.
              </p>
            )}
          </header>
          <div className="aprof-card-body">
            <RatingLadders ladders={profile.ladders} projection={projection} />
          </div>
        </section>

        <section className="card aprof-card aprof-panel">
          <header className="aprof-card-head">
            <span className="aprof-eyebrow">Reputation</span>
            <p className="aprof-card-sub muted small">
              How other players have found them to play against.
            </p>
          </header>
          <div className="aprof-card-body">
            <ReputationPanel reputation={profile.reputation} />
          </div>
        </section>
      </div>

      <section className="card aprof-card aprof-panel">
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
              className="btn ghost aprof-btn-sm"
              disabled={pagingBusy}
              onClick={onLoadMore}
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
          {pagingEnded && (
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
