// PLAY → ONLINE, transcribed from design-lab/v1/play.html (#s-online and
// #s-search).
//
// v1 draws one panel with Stakes / Clock / Side and a commit row carrying both
// buttons, and a separate full-screen SEARCHING state that echoes back what was
// asked for. All of that is here, in both stakes: the Stakes switch changes
// what the rows ANSWER, never which rows exist. A control the app cannot honour
// in a given stake is drawn showing the answer it will use and refuses the
// press, with the reason next to it, because a row that disappears is a row the
// player cannot ask about.
//
// The reasons are QUALIFIERS, one short line each, never paragraphs. What
// rated and casual mean is taught once in PlayExplainer, before the screen; all
// this screen owes a player is which control is locked and why, said where the
// lock is. The one exception is the account requirement, which is repeated at
// the Stakes switch because that is the moment it costs something.
//
// What the app cannot honour, and why the locks are where they are:
//
//   Rated is a pool per ladder, played at that ladder's own clock, and the two
//   colours come with the pairing. So four of the eight clocks and all three
//   sides are locked in Rated, and every one of them is live in Casual.
//
//   Casual is a code, not a pool: there is nobody to search for. Rated cannot
//   be played from a code. So exactly one of v1's two buttons is live in each
//   stake, and the line above them says which and why.
//
// Everything the pool knows about pairing (widths, trust, witnesses, judges)
// stays where it has always been: out of the player's sight. What is on screen
// is what they picked and whether it can start.

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { RatedCategory } from '@shared/accounts/ratings/ladders'
import type { MpGameConfig } from '@shared/types'
import type { GameKind } from '../../games/kernel'
import type { ViewKey } from '../../components/Layout'
import { listGames } from '../../games/registry'
import { useAccountsUi } from '../account/mock/store'
import { MM_DEFAULT_TC, matchmakingStore, useMatchmaking } from '../account/net/matchmaking'
import { onlineStore } from './online/onlineStore'
import { useOnlineGame } from './online/useOnlineGame'
import { banDate, standingSentence, useOwnFold } from './online/RatedPanel'
import { RATED_LADDERS, ownPairView, ratedLadderId, ratedLadderOf } from './online/ratedPairing'
import { BYOYOMI_PRESETS, byoyomiPresetById } from './byoyomi'
import type { GoHandicap } from '../../games/go'
import {
  CUSTOM_TIME_CONTROL_ID,
  timeControlById,
  timeControlLabel,
  type TimeControl
} from './timeControl'
import { CLOCK_CHIP_IDS, ClockChips, Segmented, useElapsed } from './SetupControls'
import type { ColorChoice } from './setupTypes'
import { WhileYouWait } from './WhileYouWait'

type Stakes = 'Rated' | 'Casual'

const GO_SIZES = [9, 13, 19] as const
const GO_HANDICAPS: readonly GoHandicap[] = [0, 2, 3, 4, 5, 6, 7, 8, 9]

const SIDE_OPTIONS: readonly { key: ColorChoice; label: string }[] = [
  { key: 'white', label: 'White' },
  { key: 'black', label: 'Black' },
  { key: 'random', label: 'Random' }
]

/** Is this control one of the four the rated pools actually run? Compared
 *  against MM_DEFAULT_TC itself, so the row can never offer a clock no seek is
 *  advertised at. */
function isLadderClock(tc: TimeControl): boolean {
  return RATED_LADDERS.some(
    (k) => MM_DEFAULT_TC[k].baseMs === tc.baseMs && MM_DEFAULT_TC[k].incMs === tc.incMs
  )
}

/** v1's eight chips minus the four a rated seek can be started at: 5+0, 15+10,
 *  Unlimited and Custom. They still draw; they refuse the press, and the note
 *  under the row says why. */
const RATED_LOCKED_CLOCKS: readonly string[] = [
  ...CLOCK_CHIP_IDS.filter((id) => !isLadderClock(timeControlById(id))),
  CUSTOM_TIME_CONTROL_ID
]

/** Online refuses a game with no clock, so Unlimited is the one chip casual
 *  cannot take. Everything else, including Custom, is live. */
const CASUAL_LOCKED_CLOCKS: readonly string[] = ['unlimited']

export interface OnlineSectionProps {
  /** True while a search or a hosted table is running: the page hides its
   *  Unfinished section for the same reason v1 does, so the wait owns the
   *  screen. Derived by the page from the same two stores this reads. */
  searching: boolean
  /** Passed through to "While you wait", which has nowhere to go without it. */
  onNavigate?: (view: ViewKey) => void
}

export function OnlineSection({ searching, onNavigate }: OnlineSectionProps): JSX.Element {
  const { account } = useAccountsUi()
  const mm = useMatchmaking()
  const online = useOnlineGame()
  const { tMicro, bans, atWts } = useOwnFold(account)

  const [stakes, setStakes] = useState<Stakes>('Rated')
  // v1 opens on 10+5, which is the Rapid ladder's own control.
  const [ladderKey, setLadderKey] = useState<RatedCategory>('Rapid')
  const [tc, setTc] = useState<TimeControl>(() => timeControlById('10+5'))
  const [side, setSide] = useState<ColorChoice>('random')
  const [gameKind, setGameKind] = useState<GameKind>('chess')
  const [goSize, setGoSize] = useState<9 | 13 | 19>(19)
  const [goHandicap, setGoHandicap] = useState<GoHandicap>(0)
  const [goByoId, setGoByoId] = useState('off')
  const [joinCode, setJoinCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // Set when WE start a search, cleared when it ends. Returning to this screen
  // with a table already open leaves it null, and the head simply shows no
  // elapsed time rather than counting from the wrong instant.
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const elapsed = useElapsed(startedAt)

  const games = useMemo(() => listGames(), [])
  const kindTitle = useMemo(
    () => games.find((g) => g.spec.kind === gameKind)?.spec.title ?? 'Chess',
    [games, gameKind]
  )

  // The rated Clock row's own value: the pool's number for this ladder, worn as
  // a TimeControl so v1's chip row can show which of the eight it is. Never
  // written to `tc`, which is the casual pick and stays the player's.
  const ratedTc = useMemo<TimeControl>(() => {
    const t = MM_DEFAULT_TC[ladderKey]
    return {
      id: `ladder-${ladderKey}`,
      label: timeControlLabel(t.baseMs, t.incMs),
      baseMs: t.baseMs,
      incMs: t.incMs
    }
  }, [ladderKey])

  // Live third-machine count, polled while nothing is running, and the pool is
  // LEFT on the way out: a seek nobody is watching would pair into an empty
  // screen. That is also why the note below says the search stops when you go.
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

  useEffect(() => {
    if (!searching) setStartedAt(null)
  }, [searching])

  const rated = stakes === 'Rated'
  const ladders = account?.ladders ?? []
  const ladder = ladders.find((l) => l.key === ladderKey) ?? null
  const ban = bans[ratedLadderId(ladderKey)]
  const banned = ban !== undefined && ban.until > atWts
  const ownView =
    account && ladder && tMicro !== null
      ? ownPairView(account.rootPub, ladderKey, ladder.state, tMicro, ban, atWts)
      : null
  // Every one of these is a state the app can already detect, and each has its
  // own line under the ladder chips. A button that is enabled next to "cannot
  // start right now" would be lying about which of the two to believe.
  const canFind = rated && ownView !== null && mm.peerLive && !banned && mm.witnessesReachable > 0

  // Why rated cannot start, in one line, at the switch that chose it. Null when
  // nothing is in the way, and the row then carries no line at all. The account
  // case is first because it is the only one the player can act on right now.
  const ratedBlock: string | null = !account
    ? 'Needs an account. Make one on the Account screen.'
    : banned
      ? `Paused on ${ladderKey} until ${banDate(ban.until)}.`
      : !mm.peerLive
        ? 'Connecting.'
        : mm.witnessesReachable === 0
          ? 'Cannot start right now. Casual can.'
          : null

  const findOpponent = useCallback(() => {
    if (!canFind || !ownView) return
    setStartedAt(Date.now())
    void matchmakingStore.startRatedSearch({
      ladderKey,
      tc: MM_DEFAULT_TC[ladderKey],
      view: ownView
    })
  }, [canFind, ownView, ladderKey])

  const inviteByCode = useCallback(() => {
    // A coded game is the two of you and nothing else, so it cannot be rated.
    // The button says so on screen; this is the same rule, held.
    if (rated) return
    if (tc.baseMs <= 0) {
      setFormError('An online game needs a clock. Pick one above.')
      return
    }
    setFormError(null)
    const goByo = gameKind === 'go' ? byoyomiPresetById(goByoId).byo : null
    const cfg: MpGameConfig = {
      tc: { initialMs: tc.baseMs, incrementMs: tc.incMs, ...(goByo ? { byoyomi: goByo } : {}) },
      hostColor: side,
      ...(gameKind !== 'chess'
        ? {
            game: {
              kind: gameKind,
              ...(gameKind === 'chess960'
                ? { options: { positionNumber: Math.floor(Math.random() * 960) } }
                : {}),
              ...(gameKind === 'go'
                ? { options: { size: goSize, ...(goHandicap >= 2 ? { handicap: goHandicap } : {}) } }
                : {})
            }
          }
        : {})
    }
    setStartedAt(Date.now())
    onlineStore.host(cfg)
  }, [rated, tc, side, gameKind, goSize, goHandicap, goByoId])

  const join = useCallback(() => {
    const trimmed = joinCode.trim()
    if (trimmed.length < 5) {
      setFormError('Enter the whole code your opponent sent you.')
      return
    }
    setFormError(null)
    onlineStore.join(trimmed)
  }, [joinCode])

  const copyCode = useCallback(() => {
    if (!online.code) return
    void navigator.clipboard?.writeText(online.code).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => undefined
    )
  }, [online.code])

  const stopSearching = useCallback(() => {
    matchmakingStore.cancelRatedSearch()
    onlineStore.leave()
    setStartedAt(null)
  }, [])

  // ------------------------------------------------------------------
  // SEARCHING. v1: the whole screen becomes the wait, and what was asked
  // for is echoed back as data.
  // ------------------------------------------------------------------
  if (searching) {
    const ratedSearch = mm.phase !== 'idle' && mm.phase !== 'signed-out'
    const clockLabel = ratedSearch ? ratedTc.label : timeControlLabel(tc.baseMs, tc.incMs)
    const title =
      mm.phase === 'waiting-witness' || mm.phase === 'paired'
        ? 'Setting up the game'
        : 'Looking for an opponent'
    // v1's sub is the three rows above read straight back: pool, clock, side.
    const sideWord = ratedSearch ? 'random' : side
    const sub = `${ratedSearch ? 'Rated' : 'Casual'}, ${clockLabel}, ${sideWord} side`

    return (
      <section className="sec" id="s-search">
        <div className="sec-head">
          <h2 className="lbl">Online</h2>
          <span className="sec-count">Searching</span>
        </div>

        <div className="panel">
          <div className="play-search-head">
            <span className="play-dot" />
            <div>
              <div className="play-search-title">{title}</div>
              <div className="play-search-sub">{sub}</div>
            </div>
            {startedAt !== null && <span className="play-elapsed">{elapsed}</span>}
          </div>

          {/* Casual: the code IS the invitation, so it is the biggest thing
              on the wait and the code itself is the button. */}
          {!ratedSearch && online.code && (
            <button className="play-code" type="button" onClick={copyCode}>
              <span className="play-code-text">{online.code}</span>
              <span className="play-code-hint">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          )}

          <div className="facts">
            <div className="fact">
              <span className="lbl">Stakes</span>
              <span className="fact-value">{ratedSearch ? 'Rated' : 'Casual'}</span>
            </div>
            <div className="fact">
              <span className="lbl">Clock</span>
              <span className="fact-value">{clockLabel}</span>
            </div>
            <div className="fact">
              <span className="lbl">Side</span>
              <span className="fact-value">
                {ratedSearch ? 'Random' : SIDE_OPTIONS.find((s) => s.key === side)?.label}
              </span>
            </div>
            {/* v1's fourth fact. Rated: who the pool may hand you is the one
                rating-shaped thing a player is allowed to be told about it,
                and while your own ladder has not revealed a rating there is
                no distance to keep. Casual: a code has no pool at all. */}
            <div className="fact">
              <span className="lbl">Opponent</span>
              {ratedSearch ? (
                ladder && ladder.display.state === 'ranked' ? (
                  <span className="fact-value">
                    Near your rating
                    <span className="fact-note">on the {ladderKey} ladder</span>
                  </span>
                ) : (
                  <span className="fact-value">
                    Any rating
                    <span className="fact-note">while yours is provisional</span>
                  </span>
                )
              ) : (
                <span className="fact-value">Whoever you give the code to</span>
              )}
            </div>
            {ratedSearch ? (
              <div className="fact">
                <span className="lbl">Standing</span>
                <span className="fact-value">
                  {ladder ? standingSentence(ladderKey, ladder.display) : 'No games yet'}
                </span>
              </div>
            ) : (
              <div className="fact">
                <span className="lbl">Game</span>
                <span className="fact-value">{kindTitle}</span>
              </div>
            )}
          </div>

          {/* v1 says "Leaving this screen does not stop the search." That is
              true of a hosted table, which lives for the app's lifetime, and
              false of a rated seek, which leaves the pool on the way out. */}
          <p className="play-search-note">
            {ratedSearch
              ? 'Leaving this screen stops the search.'
              : 'Leaving this screen does not stop the search.'}
          </p>

          <div className="panel-foot">
            <button className="btn is-quiet" type="button" onClick={stopSearching}>
              Stop searching
            </button>
          </div>
        </div>

        {/* The wait has room for one honest offer. What a click costs is on
            the line directly above it, in both states. */}
        <WhileYouWait onNavigate={onNavigate} />
      </section>
    )
  }

  // ------------------------------------------------------------------
  // IDLE
  // ------------------------------------------------------------------

  return (
    <section className="sec" id="s-online">
      <div className="sec-head">
        <h2 className="lbl">Online</h2>
      </div>

      <div className="panel">
        <div className="play-field">
          <span className="lbl">Stakes</span>
          <div>
            <Segmented
              label="Stakes"
              value={stakes}
              options={[
                { key: 'Rated', label: 'Rated' },
                { key: 'Casual', label: 'Casual' }
              ]}
              onChange={setStakes}
            />
            {/* The account requirement, said where it costs something, and
                nowhere else. Casual never needs one, so it never shows a line. */}
            {rated && ratedBlock !== null && <span className="play-qual">{ratedBlock}</span>}
          </div>
        </div>

        {rated ? (
          <>
            {/* v1's clock row, whole, in both stakes. Rated runs four of the
                eight: picking one of those is picking its ladder, and the other
                four say no rather than quietly leaving the row. */}
            <div className="play-field">
              <span className="lbl">Clock</span>
              <div>
                <ClockChips
                  value={ratedTc}
                  onChange={(picked) => {
                    const key = ratedLadderOf(picked)
                    if (key === null) return
                    if (mm.phase !== 'idle') matchmakingStore.cancelRatedSearch()
                    setLadderKey(key)
                  }}
                  lockedIds={RATED_LOCKED_CLOCKS}
                  note="Rated runs its ladder's clock. Casual takes any."
                  customId="tc-custom-rated"
                />
                {/* Which ladder this clock is, and where the player stands on
                    it. A reading, not a lesson. */}
                <span className="play-qual">
                  {ladder
                    ? standingSentence(ladderKey, ladder.display)
                    : `${ladderKey} · no games on this ladder yet`}
                </span>
              </div>
            </div>

            {/* v1's Side control, whole. Rated has no side to give: the two
                colours come with the pairing, so the control shows the answer
                the app will use and refuses the press, with the reason under
                it. A row that vanishes reads as a bug. */}
            <div className="play-field">
              <span className="lbl">Side</span>
              <div>
                <Segmented
                  label="Side"
                  value="random"
                  options={SIDE_OPTIONS}
                  onChange={() => undefined}
                  disabled
                />
                <span className="play-qual">The colours come with the pairing.</span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="play-field">
              <span className="lbl">Game</span>
              <div className="chips" role="group" aria-label="Game">
                {games.map((g) => (
                  <button
                    key={g.spec.kind}
                    className="chip"
                    type="button"
                    aria-pressed={gameKind === g.spec.kind}
                    onClick={() => setGameKind(g.spec.kind)}
                  >
                    {g.spec.title}
                  </button>
                ))}
              </div>
            </div>

            {gameKind === 'go' && (
              <>
                <div className="play-field">
                  <span className="lbl">Board</span>
                  <div className="chips" role="group" aria-label="Board size">
                    {GO_SIZES.map((sz) => (
                      <button
                        key={sz}
                        className="chip"
                        type="button"
                        aria-pressed={goSize === sz}
                        onClick={() => setGoSize(sz)}
                      >
                        {sz}×{sz}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="play-field">
                  <span className="lbl">Handicap</span>
                  <div>
                    <div className="chips" role="group" aria-label="Handicap stones">
                      {GO_HANDICAPS.map((h) => (
                        <button
                          key={h}
                          className="chip"
                          type="button"
                          aria-pressed={goHandicap === h}
                          onClick={() => setGoHandicap(h)}
                        >
                          {h === 0 ? 'Off' : h}
                        </button>
                      ))}
                    </div>
                    {goHandicap >= 2 && (
                      <p className="play-note">
                        Black pre-places {goHandicap} stones, White moves first, komi drops to 0.5.
                      </p>
                    )}
                  </div>
                </div>
                <div className="play-field">
                  <span className="lbl">Overtime</span>
                  <div className="chips" role="group" aria-label="Byo-yomi">
                    {BYOYOMI_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        className="chip"
                        type="button"
                        aria-pressed={goByoId === p.id}
                        onClick={() => setGoByoId(p.id)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="play-field">
              <span className="lbl">Clock</span>
              <ClockChips
                value={tc}
                onChange={setTc}
                lockedIds={CASUAL_LOCKED_CLOCKS}
                note="An online game needs a clock."
                customId="tc-custom"
              />
            </div>

            <div className="play-field">
              <span className="lbl">Side</span>
              <Segmented label="Side" value={side} options={SIDE_OPTIONS} onChange={setSide} />
            </div>

            <div className="play-field">
              <span className="lbl">Join</span>
              <div>
                <div className="play-inputs">
                  <input
                    className="play-name play-join"
                    type="text"
                    placeholder="A1B2C-D3E4F"
                    aria-label="Join code"
                    spellCheck={false}
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') join()
                    }}
                  />
                  <button
                    className="btn is-quiet"
                    type="button"
                    onClick={join}
                    disabled={joinCode.trim().length < 5}
                  >
                    Join
                  </button>
                </div>
                <span className="play-qual">You join on their clock, on their side.</span>
              </div>
            </div>
          </>
        )}
      </div>

      {(formError || online.error) && (
        <p className="play-qual" role="alert">
          {formError || online.error}
        </p>
      )}

      {/* Both of v1's buttons, always, and each does only what its own word
          says. That is why one of them is asleep in each stake: the pool is
          rated and a code is not. The go-note names which, so the dim button is
          an answer rather than a fault. */}
      <div className="play-go">
        <button className="btn is-primary" type="button" onClick={findOpponent} disabled={!canFind}>
          Find an opponent
        </button>
        <button className="btn is-quiet" type="button" onClick={inviteByCode} disabled={rated}>
          Invite by code
        </button>
        <span className="play-go-note">
          {rated ? 'A code cannot be rated. Switch to Casual.' : 'Casual has no pool. Send a code.'}
        </span>
      </div>
    </section>
  )
}
