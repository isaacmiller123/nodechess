import type { JSX } from 'react'
import { ShieldCheck, UserRound, Users } from 'lucide-react'
import { pairingLegal, visibleOpponentInfo, type PairView } from '@shared/accounts/mm/pairing'

/**
 * Who you were paired with. The ONLY place the rated flow renders anything
 * about an opponent, so the rating-visibility rule has one carrier instead of
 * one per state.
 *
 * What may be shown comes from the shared projection visibleOpponentInfo(own,
 * opp): a viewer whose OWN rating on this ladder is still hidden sees a pool and
 * nothing rating-shaped, while a ranked viewer sees a bracket for a still-hidden
 * opponent and the revealed rating for a ranked one.
 *
 * The card also re-checks pairingLegal on the EXACT views it is about to render
 * and refuses the whole card if the pairing is illegal. That refusal is a
 * PLAYER-FACING dead end, so it says the game will not start and stops there.
 * The reason code stays out of the UI: it is a protocol detail, and naming it
 * teaches an opponent-shopping trick.
 */
export function RatedOpponentCard({
  own,
  opp,
  atWts,
  ladderKey
}: {
  own: PairView
  /** The opponent's public PairView, when this client holds it. Null while the
   *  struck pairing's public views have not reached the surface: an honest gap,
   *  never a placeholder rating. A hidden viewer's card is identical either
   *  way. */
  opp: PairView | null
  /** The pairing record's witnessed timestamp. Both sides were evaluated at it,
   *  so legality cannot flip with this client's clock. */
  atWts: number
  ladderKey: string
}): JSX.Element {
  const hiddenViewer = own.display.state !== 'ranked'

  if (opp === null) {
    if (hiddenViewer) return <UnrankedPool ladderKey={ladderKey} />
    return (
      <div className="online-opp">
        <span className="online-opp-avatar" aria-hidden>
          <UserRound size={18} />
        </span>
        <span className="online-opp-id">
          <span className="online-opp-name">Opponent</span>
          <span className="online-opp-sub">Their rating has not arrived yet.</span>
        </span>
      </div>
    )
  }

  const verdict = pairingLegal(own, opp, atWts)
  const info = visibleOpponentInfo(own, opp)
  // A ban is both a public fact and an illegal pairing, so the two arrive
  // together; both land on the refusal card rather than a half-rendered
  // opponent. Reading the projection as well as the verdict keeps the card
  // fail-closed if those two rules are ever relaxed apart.
  if (!verdict.legal || info.kind === 'banned') {
    return (
      <div className="online-opp is-refused" role="status">
        <span className="online-opp-avatar" aria-hidden>
          <ShieldCheck size={18} />
        </span>
        <span className="online-opp-id">
          <span className="online-opp-name">Pairing refused</span>
          <span className="online-opp-sub">
            This {ladderKey} game will not start. Nothing was rated. Press Play to look again.
          </span>
        </span>
      </div>
    )
  }

  if (info.kind === 'unranked-pool') return <UnrankedPool ladderKey={ladderKey} />

  return (
    <div className="online-opp">
      <span className="online-opp-avatar" aria-hidden>
        <UserRound size={18} />
      </span>
      <span className="online-opp-id">
        <span className="online-opp-name">Opponent</span>
        <span className="online-opp-sub">
          {info.kind === 'bracket'
            ? `Still unranked on ${ladderKey}.`
            : `Ranked on the ${ladderKey} ladder.`}
        </span>
      </span>
      <span
        className="online-opp-rating num"
        title={info.kind === 'bracket' ? 'Rating range' : 'Rating'}
      >
        {info.kind === 'bracket' ? `${info.lo}–${info.hi}` : info.rating}
      </span>
    </div>
  )
}

/** The state of a viewer whose own rating on this ladder is still hidden: a
 *  pool, and not one number about anybody. */
function UnrankedPool({ ladderKey }: { ladderKey: string }): JSX.Element {
  return (
    <div className="online-opp is-pool">
      <span className="online-opp-avatar" aria-hidden>
        <Users size={18} />
      </span>
      <span className="online-opp-id">
        <span className="online-opp-name">Unranked opponent pool</span>
        <span className="online-opp-sub">
          Ratings stay hidden until your own {ladderKey} rating shows.
        </span>
      </span>
    </div>
  )
}
