// The wait before a profile opens. Nobody is hosting the account, so the client
// has to gather it and check it before there is anything to show. That work is
// real, and it is also none of the player's business: the old card narrated five
// protocol stages (key resolve hops, pointer records, holders answering, erasure
// shards reassembled, checkpoint cosignatures) at the person waiting on a
// profile. It now says what it is doing in the only terms that matter to them.
//
// Two drive modes, one card:
//   LIVE (recon === null): the resolve is still in flight. The card spins and
//     never completes on its own; ProfilePage calls the reveal when the resolve
//     settles.
//   SETTLED (recon !== null): the facts are known (live resolve done, or the
//     offline fixture preview). A short beat, then reveal.

import { useEffect, useRef, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import type { UiProfile, UiReconstruction } from '../mock/types'

/** How long the settled card holds before handing off to the profile. */
const SETTLE_MS = 520

export type ReconCheckpoint = UiProfile['checkpoint']

export function ReconstructionCard({
  profile,
  handle: handleProp,
  recon: reconProp,
  onDone
}: {
  /** Convenience source (fixture / suite): supplies handle + recon in one
   *  object when the explicit props are omitted. */
  profile?: UiProfile
  handle?: string
  /** The resolved facts, or null while the live resolve is still in flight. Not
   *  rendered: it only decides whether this card can hand off yet. */
  recon?: UiReconstruction | null
  /** Accepted so callers can keep passing it; deliberately unused. Checkpoint
   *  heights and cosigner counts are not shown to players. */
  checkpoint?: ReconCheckpoint | null
  /** Called once the wait finishes (SETTLED mode only). */
  onDone: () => void
}): JSX.Element {
  const handle = handleProp ?? profile?.handle ?? ''
  const recon: UiReconstruction | null =
    reconProp !== undefined ? reconProp : (profile?.reconstruction ?? null)
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  // Settled: hold one beat, then reveal. Live: wait for the resolve, which
  // re-runs this effect when recon becomes non-null.
  useEffect(() => {
    if (recon === null) return undefined
    const id = window.setTimeout(() => onDoneRef.current(), SETTLE_MS)
    return () => window.clearTimeout(id)
  }, [recon])

  return (
    <section className="card aprof-card aprof-rail aprof-recon" aria-busy>
      <header className="aprof-card-head">
        <span className="aprof-eyebrow">
          <Loader2 size={14} className="aprof-spin" aria-hidden /> Loading{' '}
          <span className="account-handle-mono">{handle}</span>
        </span>
        <p className="aprof-card-sub muted small">This can take a few seconds.</p>
      </header>

      <span className="visually-hidden" role="status">
        Loading profile
      </span>
    </section>
  )
}
