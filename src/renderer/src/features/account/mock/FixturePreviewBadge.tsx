import type { JSX } from 'react'
import { FlaskConical } from 'lucide-react'
import { DEV_FIXTURE } from './fixtures'

/**
 * The functional face of the DEV_FIXTURE flag (./fixtures): every signed-in
 * surface that renders fixture data mounts this badge, so (a) the user is
 * told, in place, that what they are looking at is sample data (the UI never
 * asserts a fabricated fact as live), and (b) grepping DEV_FIXTURE finds
 * every fixture surface (each mount site gates on the flag explicitly).
 * Renders nothing once DEV_FIXTURE flips off with the network transport work.
 *
 * Styling: .account-fixture-badge in account.css, the same warning-pill idiom
 * as the AccountView tab-strip preview pill.
 */
export function FixturePreviewBadge({ label }: { label?: string }): JSX.Element | null {
  if (!DEV_FIXTURE) return null
  return (
    <span className="account-fixture-badge" role="note">
      <FlaskConical size={11} aria-hidden />
      {label ?? 'Sample data'}
    </span>
  )
}
