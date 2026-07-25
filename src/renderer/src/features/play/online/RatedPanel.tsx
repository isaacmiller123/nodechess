import { useEffect, useState, type JSX } from 'react'
import { Flame, Loader2, Network, Rabbit, ShieldCheck, Swords, Turtle, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PairView } from '@shared/accounts/mm/pairing'
import type { DisplayState } from '@shared/accounts/ratings/display'
import type { RatedCategory } from '@shared/accounts/ratings/ladders'
import { trustT } from '@shared/accounts/mm/trust'
import { useAccountsUi } from '../../account/mock/store'
import { foldChainA4 } from '../../account/store/derive'
import { MM_DEFAULT_TC, matchmakingStore, useMatchmaking } from '../../account/net/matchmaking'
import { loadOwnChain } from '../../../../../web/accounts'
import type { UiOwnAccount } from '../../account/mock/types'
import { timeControlLabel, type TimeControl } from '../timeControl'
import { onlineStore } from './onlineStore'
import { RatedOpponentCard } from './RatedOpponentCard'
import { RATED_LADDERS, ownPairView, ratedLadderId, ratedLadderOf } from './ratedPairing'

/**
 * Rated online play, inside Play → Online. One ladder pool, one Play button:
 * the player picks a clock and the pool pairs them with a stranger. No code to
 * copy, no lobby to browse.
 *
 * Rated is the only flow that needs the account. What the surface SHOWS is
 * deliberately thin: a standing, a Play button, and whether the app can reach
 * the network right now. Pairing internals (trust, widths, witnesses, judge)
 * are never described to the player; a state the player can act on is, and
 * nothing more. A rated game that cannot start says so instead of faking one.
 */

const LADDER_ICON: Record<RatedCategory, LucideIcon> = {
  Bullet: Zap,
  Blitz: Flame,
  Rapid: Rabbit,
  Classical: Turtle
}

/** Display state as a label: a rating once the ladder reveals, the progress
 *  toward it before that. */
function standingLabel(d: DisplayState): string {
  if (d.state === 'ranked') return String(d.rating)
  if (d.state === 'banned') return 'Banned'
  return `${d.n}/${d.of}`
}

/** The longer form, for the line under the Play button. */
function standingSentence(key: RatedCategory, d: DisplayState): string {
  if (d.state === 'ranked') return `${key} · your rating is ${d.rating}`
  if (d.state === 'banned') return `${key} · banned`
  if (d.state === 'provisional')
    return `${key} · ${d.n} of ${d.of} games played. Your rating shows at ${d.of}.`
  return `${key} · placement, game ${d.n + 1} of ${d.of}`
}

function banDate(untilWts: number): string {
  return new Date(untilWts).toLocaleDateString()
}

/**
 * The values the seek needs, folded from this account's own chain: its trust in
 * micro-units and its ladder bans. Both stay INTERNAL. tMicro rides the outgoing
 * PairView and is never rendered, in any shape, coarse or exact. Null while
 * loading or signed out, so the surface waits instead of seeking with a wrong
 * number. Recomputes when the chain advances.
 */
function useOwnFold(account: UiOwnAccount | null): {
  tMicro: number | null
  bans: { [ladderId: string]: { until: number } }
  /** The instant trust and ban activity were evaluated at. */
  atWts: number
} {
  const [fold, setFold] = useState<{
    tMicro: number | null
    bans: { [ladderId: string]: { until: number } }
    atWts: number
  }>({ tMicro: null, bans: {}, atWts: 0 })
  const key = account ? `${account.rootPub}:${account.chainHeight}` : ''
  useEffect(() => {
    let alive = true
    if (!account) {
      setFold({ tMicro: null, bans: {}, atWts: 0 })
      return undefined
    }
    void (async () => {
      try {
        const chain = await loadOwnChain()
        const { fold: st } = foldChainA4(chain)
        const atWts = Date.now()
        if (alive) setFold({ tMicro: trustT(st.trust, st.rep, atWts), bans: st.bans, atWts })
      } catch {
        if (alive) setFold({ tMicro: null, bans: {}, atWts: 0 })
      }
    })()
    return () => {
      alive = false
    }
    // The account identity + chain height is the whole input; `account` itself
    // is a fresh object on every store emission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return fold
}

export interface RatedPanelProps {
  /** The tab's current time control. Seeds which pool opens selected, so a
   *  player who already picked 3+2 lands on Blitz. */
  initialTimeControl?: TimeControl
}

export function RatedPanel({ initialTimeControl }: RatedPanelProps = {}): JSX.Element {
  const { account } = useAccountsUi()
  const mm = useMatchmaking()
  const { tMicro, bans, atWts } = useOwnFold(account)
  const [ladderKey, setLadderKey] = useState<RatedCategory>(
    () => (initialTimeControl && ratedLadderOf(initialTimeControl)) || 'Blitz'
  )

  // Live third-machine count for the header, refreshed while nothing is
  // running; the search itself reports its own count. Leaving the tab leaves
  // the queue. A seek nobody is watching would pair into an empty screen.
  useEffect(() => {
    matchmakingStore.refreshWitnessStatus()
    const id = window.setInterval(() => {
      if (matchmakingStore.getState().phase === 'idle') matchmakingStore.refreshWitnessStatus()
    }, 4000)
    return () => {
      window.clearInterval(id)
      matchmakingStore.cancelRatedSearch()
    }
  }, [])

  const ladders = account?.ladders ?? []
  const ladder = ladders.find((l) => l.key === ladderKey) ?? null
  const ban = bans[ratedLadderId(ladderKey)]
  const banned = ban !== undefined && ban.until > atWts
  const searching = mm.phase === 'searching' || mm.phase === 'waiting-witness'
  // The handoff has fired: the pool opened (or joined) an mp room for us and the
  // board is about to take over the tab.
  const connecting = mm.phase === 'paired'
  // 'signed-out' is the engine's honest "your device key isn't ready" state; it
  // sits with idle so the player keeps a button to try again rather than a card
  // with nothing on it.
  const idle = !searching && !connecting
  const canPlay = !!account && ladder !== null && tMicro !== null && mm.peerLive && !banned

  const ownView: PairView | null =
    account && ladder && tMicro !== null
      ? ownPairView(account.rootPub, ladderKey, ladder.state, tMicro, ban, atWts)
      : null

  function pickLadder(key: RatedCategory): void {
    if (mm.phase !== 'idle') matchmakingStore.cancelRatedSearch()
    setLadderKey(key)
  }

  function play(): void {
    if (!canPlay || !ownView) return
    void matchmakingStore.startRatedSearch({
      ladderKey,
      tc: MM_DEFAULT_TC[ladderKey],
      view: ownView
    })
  }

  /** Back out of a struck pairing: leave the pool AND the room the handoff
   *  opened, so a match that never finishes connecting is never a dead end. */
  function leave(): void {
    matchmakingStore.cancelRatedSearch()
    onlineStore.leave()
  }

  if (!account) {
    return (
      <div className="online-card online-rated" aria-label="Rated play">
        <div className="online-card-head">
          <Swords size={18} className="online-card-icon" aria-hidden />
          <div>
            <h3>Rated play</h3>
            <span className="muted small">Ranked games against strangers, on four ladders.</span>
          </div>
        </div>
        <p className="online-note">
          Rated games need an account. Create one or sign in on the Account tab. Casual games below
          need nothing at all.
        </p>
      </div>
    )
  }

  return (
    <div className="online-card online-rated" aria-label="Rated play">
      <div className="online-card-head">
        <Swords size={18} className="online-card-icon" aria-hidden />
        <div>
          <h3>Rated play</h3>
          <span className="muted small">Pick a clock and play. We find you an opponent.</span>
        </div>
        {/* Connection state only: whether Play can work right now. Never a count
            of anything on the network. */}
        <span className={`online-rated-net${mm.witnessesReachable > 0 ? ' is-ok' : ''}`}>
          <Network size={12} aria-hidden />
          {!mm.peerLive
            ? 'connecting'
            : mm.witnessesReachable > 0
              ? 'ready to play'
              : 'rated play unavailable'}
        </span>
      </div>

      <div className="online-field">
        <span className="online-label" id="online-pool-label">
          Ladder
        </span>
        <div className="online-pools" role="group" aria-labelledby="online-pool-label">
          {RATED_LADDERS.map((key) => {
            const Icon = LADDER_ICON[key]
            const l = ladders.find((x) => x.key === key)
            const tc = MM_DEFAULT_TC[key]
            return (
              <button
                key={key}
                type="button"
                className={`online-pool${key === ladderKey ? ' on' : ''}`}
                aria-pressed={key === ladderKey}
                // "62/120" under a chip is progress toward a revealed rating,
                // not a rating. The long form says which it is.
                title={l ? standingSentence(key, l.display) : undefined}
                onClick={() => pickLadder(key)}
              >
                <span className="online-pool-tc num">{timeControlLabel(tc.baseMs, tc.incMs)}</span>
                <span className="online-pool-name">
                  <Icon size={13} aria-hidden /> {key}
                </span>
                {l && (
                  <span
                    className={`online-pool-standing num${l.display.state === 'ranked' ? ' is-ranked' : ''}`}
                  >
                    {standingLabel(l.display)}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {idle && (
        <>
          <button type="button" className="btn online-primary" onClick={play} disabled={!canPlay}>
            <Swords size={15} /> Play
          </button>
          <p className="online-note">
            {banned
              ? `Rated ${ladderKey} games are paused until ${banDate(ban.until)}.`
              : !mm.peerLive || mm.phase === 'signed-out'
                ? 'Connecting…'
                : ladder
                  ? standingSentence(ladderKey, ladder.display)
                  : `${ladderKey} · no games on this ladder yet`}
          </p>
          {mm.peerLive && mm.witnessesReachable === 0 && !banned && (
            <p className="online-note warn">
              Rated games cannot start right now. Play a casual game below, or try again in a few
              minutes.
            </p>
          )}
        </>
      )}

      {searching && (
        <div className="online-rated-flow" role="status" aria-busy="true">
          <Loader2 className="spin" size={18} aria-hidden />
          <span className="online-rated-flow-main">
            <span className="online-rated-flow-title">
              {mm.phase === 'waiting-witness'
                ? 'Opponent found'
                : `Searching for a ${ladderKey} game…`}
            </span>
            <span className="online-rated-flow-sub">
              {mm.phase === 'waiting-witness'
                ? 'Setting up the game…'
                : 'Looking for someone near your rating.'}
            </span>
          </span>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => matchmakingStore.cancelRatedSearch()}
          >
            Cancel
          </button>
        </div>
      )}

      {connecting && (
        <div className="online-rated-flow" role="status">
          <ShieldCheck size={18} aria-hidden />
          <span className="online-rated-flow-main">
            <span className="online-rated-flow-title">Opponent found</span>
            <span className="online-rated-flow-sub">Connecting you to the board…</span>
          </span>
          <button type="button" className="btn ghost small" onClick={leave}>
            Cancel
          </button>
        </div>
      )}

      {connecting && ownView && (
        // The one place anything about the opponent may be rendered. `opp` stays
        // null until the struck pairing's public PairViews reach this surface,
        // and the card says so rather than inventing a number; the atWts here is
        // our own evaluation instant, which only becomes load-bearing once a
        // counterparty view is passed with the pairing record's own wts.
        <RatedOpponentCard own={ownView} opp={null} atWts={atWts} ladderKey={ladderKey} />
      )}
    </div>
  )
}
