import { useState, type JSX } from 'react'
import { FileKey, KeyRound, Link2, Swords } from 'lucide-react'
import { AuthDialog } from './AuthDialog'
import './auth.css'

/**
 * Signed-out hero for the Account view. It answers one question, the one the
 * player arrived with: do I need an account, and what does it get me? What an
 * account IS internally (a derived keypair, a signed local file, a chain anyone
 * can re-verify) is not an answer to that question and is not on the card.
 */

export function SignedOutCard(): JSX.Element {
  const [dialog, setDialog] = useState<'signin' | 'create' | null>(null)

  return (
    <>
      <section className="card aauth-hero" aria-labelledby="aauth-hero-title">
        <span className="aauth-hero-badge" aria-hidden>
          <FileKey size={22} />
        </span>
        <h2 id="aauth-hero-title" className="aauth-hero-title">
          Create an account to play rated
        </h2>
        <p className="aauth-hero-lead">
          A username and a password is all it takes. No email, and nothing to confirm.
        </p>

        <ul className="aauth-perks">
          <li className="aauth-perk">
            <span className="aauth-perk-ic" aria-hidden>
              <Swords size={16} />
            </span>
            <span className="aauth-perk-body">
              <strong>Full local and offline play, no account needed</strong>
              <span>
                Engine games, analysis, puzzles, School: everything on this machine already works.
              </span>
            </span>
          </li>
          <li className="aauth-perk">
            <span className="aauth-perk-ic" aria-hidden>
              <Link2 size={16} />
            </span>
            <span className="aauth-perk-body">
              <strong>Unrated play by link</strong>
              <span>Send a friend a link and play. No sign-in on either side.</span>
            </span>
          </li>
        </ul>

        <p className="aauth-hero-more">
          An account adds rated ladders, friends, and a game history that follows you to any device.
        </p>

        <div className="aauth-cta-row">
          <button type="button" className="btn" onClick={() => setDialog('create')}>
            Create account
          </button>
          <button type="button" className="btn ghost" onClick={() => setDialog('signin')}>
            Sign in
          </button>
        </div>

        <p className="aauth-hero-foot">
          <KeyRound size={13} aria-hidden />
          There is no password reset. Save the recovery phrase you get when you create the account.
        </p>
      </section>

      {dialog && <AuthDialog mode={dialog} onClose={() => setDialog(null)} />}
    </>
  )
}
