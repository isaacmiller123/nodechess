import { useState, type JSX } from 'react'
import { ShieldCheck, UserRound, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAccountsUi } from './mock/store'
import { SignedOutCard } from './auth/SignedOutCard'
import { SecurityTab } from './hub/SecurityTab'
import { ProfileTab } from './profile/ProfileTab'
import { PeopleTab } from './social/PeopleTab'
import './account.css'

/**
 * The account area: who you are, who you play with, and how you keep the
 * account. Three tabs, because there are only three things a player does here.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *  - Rated play. Playing happens in Play; an account is identity, not a lobby.
 *    Splitting "find a rated game" from "find a game" was the single most
 *    confusing thing about the old layout.
 *  - The chain viewer, shard-duty tables, overlay stats and witness-peer lists.
 *    Real machinery, but it is machinery: a player has no decision to make with
 *    a k-bucket count, and surfacing it invited people to read it as something
 *    they were supposed to manage.
 *  - The anticheat explainer. It described the judge's thresholds and the exact
 *    conditions that do and do not oblige a ban, which is a cheating roadmap
 *    with extra steps. Detection is not more effective for being advertised.
 *
 * The rule for anything added here: a player must be able to DO something with
 * it. Numbers they can only look at belong in a log, not a product.
 */

export type AccountTab = 'profile' | 'people' | 'security'

const TABS: { key: AccountTab; label: string; Icon: LucideIcon }[] = [
  { key: 'profile', label: 'Profile', Icon: UserRound },
  { key: 'people', label: 'Friends', Icon: Users },
  { key: 'security', label: 'Account', Icon: ShieldCheck }
]

export default function AccountView(): JSX.Element {
  const ui = useAccountsUi()
  const [tab, setTab] = useState<AccountTab>('profile')

  if (!ui.signedIn) {
    return (
      <div className="account-view">
        <div className="account-signedout-wrap">
          <SignedOutCard />
        </div>
      </div>
    )
  }

  return (
    <div className="account-view">
      <div className="account-tabs" role="tablist" aria-label="Account sections">
        {TABS.map(({ key, label, Icon }) => {
          const on = tab === key
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              className={`account-tab${on ? ' on' : ''}`}
              onClick={() => setTab(key)}
            >
              <Icon size={15} aria-hidden />
              {label}
            </button>
          )
        })}
      </div>

      <div className="account-tab-body">
        {tab === 'profile' && <ProfileTab />}
        {tab === 'people' && <PeopleTab />}
        {tab === 'security' && <SecurityTab />}
      </div>
    </div>
  )
}
