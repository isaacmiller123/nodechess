import { useState, type JSX } from 'react'
import { useReadoutSlot } from '../../components/Layout'
import { accountsUiStore, useAccountsUi } from './mock/store'
import type { UiDevice, UiLadder, UiOwnAccount } from './mock/types'
import { AccountSignIn } from './AccountSignIn'
import { AccountRecovery } from './AccountRecovery'
import { AccountProfile } from './AccountProfile'
import { AccountPeople } from './AccountPeople'
import { DevicePairing } from './pairing/DevicePairing'
import { ProfilePage } from './profile/ProfilePage'
import { relativeWts } from './profile/profileFormat'
import { useRecoverySaved } from './recoveryAck'
import './account.css'

/**
 * The account page, from design-lab/v1/account.html: who you are, where the
 * keys live, and the one thing to do on this screen.
 *
 * WHERE THIS DIFFERS FROM THE MOCK, AND WHY. The mock is a static page, so its
 * numbers are placeholders and this one has to report what is actually true:
 *  - "Rating 1500, provisional" is not a number this app has. Ratings are per
 *    time control, and a ladder below its reveal threshold shows a state, never
 *    a number, on every surface, for everyone. So Identity reports the state
 *    and the Ratings section carries the four ladders.
 *  - the recovery phrase is twenty-four words, not twelve. See AccountRecovery.
 *  - "Change name" is not a thing that can happen. The name is an input to the
 *    key derivation and is signed into the account's first record, so changing
 *    it would be a different account. The editable fields are the profile ones,
 *    and the button goes there.
 *
 * WHAT IS DELIBERATELY NOT HERE: the network machinery. Peer counts, witness
 * reachability, checkpoint heights and chain digests are real, and a player has
 * no decision to make with any of them.
 */

function deviceDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/** The ± beside a ranked rating: 2·RD, from the protocol micro-RD. */
function bandOf(rdMicro: number): number {
  const rd = Number.isFinite(rdMicro) && rdMicro > 0 ? rdMicro / 1_000_000 : 0
  return Math.round(2 * rd)
}

/** One ladder as a value and a note. A rating below its reveal threshold is a
 *  state and a count, never a number: that rule holds on every surface. */
function ladderCell(l: UiLadder): { value: string; note: string } {
  const d = l.display
  if (d.state === 'ranked') return { value: String(d.rating), note: `± ${bandOf(l.state.rd)}` }
  if (d.state === 'banned')
    return { value: 'Banned', note: `until ${new Date(d.until).toLocaleDateString()}` }
  if (d.state === 'provisional')
    return { value: 'Provisional', note: `shows at ${d.of} games · ${d.n} played` }
  return { value: 'Placement', note: `${d.n} of ${d.of}` }
}

/** The Identity panel's Rating row. With nothing ranked there is no number to
 *  show; with several, the one you have played most is the one you mean. */
function ratingCell(ladders: UiLadder[], ratedGames: number): { value: string; note: string } {
  const ranked = ladders.filter((l) => l.display.state === 'ranked')
  if (ranked.length === 0)
    return { value: 'Unrated', note: ratedGames === 0 ? 'no rated games' : 'more games needed' }
  const top = ranked.reduce((a, b) => (b.games > a.games ? b : a))
  const d = top.display
  return { value: d.state === 'ranked' ? String(d.rating) : 'Unrated', note: top.key }
}

/**
 * One device. Removal is a real, signed act (the account records that this key
 * is retired, and every verifier honours it), so it is a two-step control: a
 * device signed in months ago should not come off the account on one stray tap.
 */
function DeviceRow({ device }: { device: UiDevice }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)

  const remove = async (): Promise<void> => {
    setWorking(true)
    await accountsUiStore.removeDevice(device.pub)
    setWorking(false)
    setConfirming(false)
  }

  return (
    <div className="row acct-row">
      <div className="acct-row-main">
        <span className="acct-row-name">{device.label}</span>
        {device.enrolledTs > 0 && (
          <span className="acct-row-sub">added {deviceDate(device.enrolledTs)}</span>
        )}
        {confirming && (
          <span className="acct-row-sub">
            Removing this signs it out. It can sign in again by scanning a new code.
          </span>
        )}
      </div>
      {device.thisDevice && <span className="tag">This device</span>}
      {device.revoked && <span className="tag">Removed</span>}
      {!device.revoked && !device.thisDevice && !confirming && (
        <button className="btn is-quiet" type="button" onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
      {confirming && (
        <>
          <button
            className="btn is-quiet"
            type="button"
            disabled={working}
            onClick={() => void remove()}
          >
            {working ? 'Removing' : 'Remove it'}
          </button>
          <button
            className="btn is-quiet"
            type="button"
            disabled={working}
            onClick={() => setConfirming(false)}
          >
            Keep
          </button>
        </>
      )}
    </div>
  )
}

function SignedIn({
  account,
  devices,
  lastPlayedWts,
  paired,
  onView
}: {
  account: UiOwnAccount
  devices: UiDevice[]
  lastPlayedWts: number | null
  /** This device was signed in by scanning, so it holds no recovery phrase and
   *  cannot add further devices. Both are said out loud rather than hidden. */
  paired: boolean
  onView: (root: string) => void
}): JSX.Element {
  const ratedGames = account.ladders.reduce((n, l) => n + l.games, 0)
  const active = devices.filter((d) => !d.revoked).length
  const rating = ratingCell(account.ladders, ratedGames)
  const standing = account.standing

  return (
    <>
      {/* 1. Who you are. */}
      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Identity</h2>
        </div>
        <div className="panel">
          <div className="facts">
            <div className="fact">
              <span className="lbl">Player</span>
              <span className="fact-value">{account.handle}</span>
            </div>
            <div className="fact">
              <span className="lbl">Name</span>
              <span className="fact-value">{account.displayName}</span>
            </div>
            <div className="fact">
              <span className="lbl">Rating</span>
              <span className="fact-value">
                {rating.value} <span className="fact-note">{rating.note}</span>
              </span>
            </div>
            <div className="fact">
              <span className="lbl">Games</span>
              <span className="fact-value">
                {ratedGames} <span className="fact-note">rated</span>
              </span>
            </div>
          </div>
          <div className="panel-foot">
            <button
              className="btn is-quiet"
              type="button"
              onClick={() => {
                const bio = document.getElementById('acct-bio')
                bio?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                bio?.focus({ preventScroll: true })
              }}
            >
              Edit profile
            </button>
          </div>
        </div>
      </section>

      {/* 2. Where the account actually lives. */}
      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Keys</h2>
          <span className="sec-count">
            {active} device{active === 1 ? '' : 's'}
          </span>
        </div>
        <div className="panel">
          <div className="acct-where">
            <svg className="icon" aria-hidden focusable="false">
              <use href="#i-lock" />
            </svg>
            <div>
              <p className="acct-where-text">Your keys are on this device and nowhere else.</p>
              <p className="acct-where-sub">
                {paired
                  ? 'Nobody, including us, can sign in as you or reset this for you. This device was signed in from another one, so the recovery phrase is not here: it is on the device you made the account on.'
                  : 'Nobody, including us, can sign in as you or reset this for you. If you lose the device, the recovery phrase below is the way back.'}
              </p>
            </div>
          </div>
          {devices.map((d) => (
            <DeviceRow key={d.pub} device={d} />
          ))}
        </div>
      </section>

      {/* 3. Signing in somewhere else, which is what most people came here to
             do once they have an account on one machine. */}
      {paired ? (
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Add a device</h2>
          </div>
          <div className="panel">
            <div className="empty">
              <p className="empty-line">This device cannot add another one.</p>
              <p className="empty-line">
                Adding a device has to happen on the one you made the account on, or on one signed
                in with your recovery phrase.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <DevicePairing />
      )}

      {/* 4. The one thing to do on this screen. */}
      <AccountRecovery rootPub={account.rootPub} paired={paired} />

      {/* Everything below is real and v1 drew none of it, so it is built from
          the same sections, panels and fact rows the page already uses. */}
      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Ratings</h2>
          <span className="sec-count num">
            {ratedGames} rated game{ratedGames === 1 ? '' : 's'}
          </span>
        </div>
        <div className="panel">
          <div className="facts">
            {account.ladders.map((l) => {
              const cell = ladderCell(l)
              return (
                <div className="fact" key={l.key}>
                  <span className="lbl">{l.key}</span>
                  <span className="fact-value">
                    {cell.value} <span className="fact-note">{cell.note}</span>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      <AccountProfile account={account} />

      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">Reputation</h2>
          <span className="sec-count">{account.reputation.tier}</span>
        </div>
        <div className="panel">
          <div className="facts">
            <div className="fact">
              <span className="lbl">Conduct</span>
              <span className="fact-value">
                {account.reputation.score} <span className="fact-note">of 100</span>
              </span>
            </div>
            {(standing.state === 'self-ban' || standing.state === 'pin-fuse') && (
              <div className="fact">
                <span className="lbl">Standing</span>
                <span className="fact-value">
                  Banned{' '}
                  <span className="fact-note">
                    until {new Date(standing.expiresWts).toLocaleDateString()}
                  </span>
                </span>
              </div>
            )}
            {standing.state === 'fork-permanent' && (
              <div className="fact">
                <span className="lbl">Standing</span>
                <span className="fact-value">Banned</span>
              </div>
            )}
            {account.reputation.components.map((c) => (
              <div className="fact" key={c.label}>
                <span className="lbl">{c.label}</span>
                <span className="fact-value">{c.value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <AccountPeople onView={onView} />

      <section className="sec">
        <div className="sec-head">
          <h2 className="lbl">This device</h2>
        </div>
        <div className="panel">
          <div className="facts">
            <div className="fact">
              <span className="lbl">Account made</span>
              {/* A chain with no readable genesis timestamp has no date to give,
                  and 0 formats as a perfectly plausible 1970. Say neither. */}
              <span className="fact-value">
                {account.createdWts > 0 ? deviceDate(account.createdWts) : 'Not recorded'}
              </span>
            </div>
            <div className="fact">
              <span className="lbl">Last rated game</span>
              <span className="fact-value">
                {lastPlayedWts === null ? 'None yet' : relativeWts(lastPlayedWts, Date.now())}
              </span>
            </div>
          </div>
          <div className="panel-foot">
            <button
              className="btn is-quiet"
              type="button"
              onClick={() => void accountsUiStore.signOut()}
            >
              Sign out
            </button>
          </div>
        </div>
      </section>
    </>
  )
}

export default function AccountView(): JSX.Element {
  const ui = useAccountsUi()
  const account = ui.account
  const saved = useRecoverySaved(account?.rootPub ?? null)
  const [viewing, setViewing] = useState<string | null>(null)

  const ratedGames = account ? account.ladders.reduce((n, l) => n + l.games, 0) : 0

  /* THE READOUT. v1 writes "Save your recovery phrase" here and flips it to
     "Play your first game" on the same click that marks the phrase saved, with
     the trace running with it. Both halves are true here because the flag is
     remembered: the trace reports the two steps this screen is for, having an
     account and having the phrase off the device. */
  const paired = ui.sessionKind === 'paired'
  const next = !ui.signedIn
    ? ui.busy === 'resuming'
      ? null
      : 'Create an account to play rated'
    : // A device signed in by scanning has no phrase to save, so nudging it to
      // save one would be asking for something that is not on this machine.
      !saved && !paired
      ? 'Save your recovery phrase'
      : ratedGames === 0
        ? 'Play your first game'
        : null
  useReadoutSlot(next, ui.signedIn ? (saved || paired ? 1 : 0.5) : null)

  // A player's profile takes the whole page, the same way it takes the whole
  // column everywhere else it is opened from.
  if (viewing !== null)
    return <ProfilePage handle={viewing} onBack={() => setViewing(null)} />

  return (
    <div className="acct col-single">
      {ui.signedIn && account ? (
        <SignedIn
          account={account}
          devices={ui.devices ?? []}
          lastPlayedWts={ui.lastWitnessedActivityWts}
          paired={paired}
          onView={setViewing}
        />
      ) : ui.busy === 'resuming' ? (
        <section className="sec">
          <div className="sec-head">
            <h2 className="lbl">Account</h2>
          </div>
          <div className="panel">
            <div className="empty">
              <p className="empty-line">Checking this device.</p>
              <p className="empty-line">A moment, then this page says where you stand.</p>
            </div>
          </div>
        </section>
      ) : (
        <AccountSignIn />
      )}
    </div>
  )
}
