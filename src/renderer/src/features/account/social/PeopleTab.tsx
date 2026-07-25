import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type JSX
} from 'react'
import {
  AlertTriangle,
  Check,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import {
  getSocialClientState,
  runAcceptRequest,
  runDeclineRequest,
  runRemoveFriend,
  runSendFriendRequest,
  runSyncMailbox,
  subscribeSocialClient,
  type FriendPresence,
  type SocialClientState,
  type SocialFriendView,
  type SocialRequestView
} from '../net/socialClient'
import { isAccountRoot } from '../net/viewerClient'
import { ProfilePage } from '../profile/ProfilePage'
import './social.css'

/**
 * People tab: the LIVE social surface, wired to the account net's socialClient
 * (net/socialClient.ts).
 *
 *  - Find a player: look anyone up by account id; ProfilePage loads them whether
 *    or not their owner is online.
 *  - Friends: the folded friend list for THIS account, with each friend's live
 *    presence. Remove is unilateral and needs no consent.
 *  - Mailbox: incoming friend requests that were held for us until we synced.
 *
 * Every list is live data or an honest empty state. NO fixtures, NO dead
 * buttons. When the network is still coming up the surface says so.
 *
 * COPY RULE: the anti-spam ordering, countersigned edges, relay quotas and
 * mailbox lifetimes are load-bearing protocol and were previously printed on this
 * page as chips, captions and confirm text. None of it changes what the player
 * does, so none of it is rendered. An empty state says what to do next.
 */

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Short relative time against the wall clock; old timestamps fall back to a
 * date. */
function ago(ts: number): string {
  const d = Date.now() - ts
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))} min ago`
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`
  if (d < 30 * DAY) return `${Math.round(d / DAY)} d ago`
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "Friends since/for …" phrasing relative to the wall clock. */
function friendLabel(since: number | null): string | null {
  if (since === null) return null
  const days = Math.round((Date.now() - since) / DAY)
  if (days < 1) return 'Friends since today'
  if (days === 1) return 'Friends for a day'
  if (days < 60) return `Friends for ${days} days`
  if (days < 540) return `Friends for ${Math.round(days / 30)} months`
  return `Friends for ${Math.round(days / 365)} years`
}

const PRESENCE_META: Record<FriendPresence, { dot: 'online' | 'away' | 'offline'; label: string }> = {
  online: { dot: 'online', label: 'Online now' },
  playing: { dot: 'online', label: 'Playing' },
  away: { dot: 'away', label: 'Away' },
  offline: { dot: 'offline', label: 'Offline' }
}

/** React bridge to the live social client (house useSyncExternalStore pattern:
 * getSocialClientState returns a stable reference between real changes). */
function useSocialClient(): SocialClientState {
  return useSyncExternalStore(subscribeSocialClient, getSocialClientState, getSocialClientState)
}

/**
 * One friend row with the inline two-step remove. Removal is unilateral: the
 * other player is not asked and cannot block it, which is the one fact the
 * confirm has to carry. The row leaves the list once the fold drops the friend.
 */
function FriendRow({
  friend,
  busy,
  onView,
  onRemove
}: {
  friend: SocialFriendView
  busy: boolean
  onView: (root: string) => void
  onRemove: (root: string) => void
}): JSX.Element {
  const [armed, setArmed] = useState(false)
  const presence = PRESENCE_META[friend.presence]
  const since = friendLabel(friend.since)

  return (
    <li className={`asoc-friend${armed ? ' is-armed' : ''}`}>
      <div className="asoc-friend-row">
        <span
          className={`asoc-presence is-${presence.dot}`}
          role="img"
          aria-label={presence.label}
          title={presence.label}
        />
        <div className="asoc-friend-id">
          <span className="asoc-friend-name">{friend.name ?? friend.label}</span>
          <span className="account-handle-mono muted">{friend.label}</span>
        </div>
        <div className="asoc-friend-meta">
          {since && <span className="asoc-friend-since num">{since}</span>}
        </div>
        <div className="asoc-friend-actions">
          <button type="button" className="btn ghost small" onClick={() => onView(friend.root)}>
            View
          </button>
          <button
            type="button"
            className="btn danger small"
            disabled={armed || busy}
            onClick={() => setArmed(true)}
          >
            Remove
          </button>
        </div>
      </div>

      {armed && (
        <div className="asoc-remove-confirm">
          <p className="asoc-remove-note">
            <AlertTriangle size={14} aria-hidden />
            {friend.name ?? friend.label} is not asked and cannot block this.
          </p>
          <div className="asoc-remove-actions">
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn danger solid small"
              disabled={busy}
              onClick={() => onRemove(friend.root)}
            >
              {busy ? 'Removing…' : 'Remove friend'}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/** One incoming friend request, the only live mailbox item today. */
function RequestRow({
  item,
  accepting,
  acceptBusy,
  onAccept,
  onDecline
}: {
  item: SocialRequestView
  accepting: boolean
  acceptBusy: boolean
  onAccept: (id: string) => void
  onDecline: (id: string) => void
}): JSX.Element {
  return (
    <li className="asoc-mail is-friend-request" aria-busy={accepting}>
      <span className="asoc-mail-icon">
        <UserPlus size={16} aria-hidden />
      </span>
      <div className="asoc-mail-body">
        <div className="asoc-mail-top">
          <span className="account-handle-mono">{item.name ?? item.label}</span>
          <span className="asoc-mail-kind">Friend request</span>
          <span className="asoc-mail-time num">{ago(item.ts)}</span>
        </div>

        {accepting ? (
          <span className="asoc-mail-busy" role="status">
            <Loader2 size={14} className="asoc-spin" aria-hidden />
            Adding them…
          </span>
        ) : (
          <div className="asoc-mail-actions">
            <button
              type="button"
              className="btn small"
              disabled={acceptBusy}
              onClick={() => onAccept(item.id)}
            >
              <Check size={14} aria-hidden /> Accept
            </button>
            <button
              type="button"
              className="btn ghost small"
              disabled={acceptBusy}
              onClick={() => onDecline(item.id)}
            >
              <X size={14} aria-hidden /> Decline
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

export function PeopleTab(): JSX.Element {
  const social = useSocialClient()
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [removingRoot, setRemovingRoot] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Opening People pulls anything that was held for us (best effort; the
  // singleton's own poll keeps it fresh thereafter).
  useEffect(() => {
    void runSyncMailbox()
  }, [])

  const viewProfile = useCallback((root: string) => {
    setSelectedHandle(root)
  }, [])

  const onAccept = useCallback((id: string) => {
    setAcceptingId(id)
    setNotice(null)
    void runAcceptRequest(id).then((r) => {
      setAcceptingId(null)
      if (!r.ok)
        setNotice(
          r.reason === 'edge-pending-witness'
            ? 'Accepted. They appear in your friends once the network is reachable.'
            : 'Could not accept that right now. Try again in a moment.'
        )
    })
  }, [])

  const onDecline = useCallback((id: string) => {
    runDeclineRequest(id)
  }, [])

  const onRemove = useCallback((root: string) => {
    setRemovingRoot(root)
    setNotice(null)
    void runRemoveFriend(root).then((r) => {
      setRemovingRoot(null)
      if (!r.ok)
        setNotice(
          r.reason === 'edge-pending-witness'
            ? 'Removed. It takes effect once the network is reachable.'
            : 'Could not remove them right now. Try again in a moment.'
        )
    })
  }, [])

  const onAdd = useCallback((root: string) => {
    setNotice(null)
    void runSendFriendRequest(root).then((r) => {
      setNotice(
        r.ok
          ? 'Friend request sent. They see it the next time they open the app.'
          : r.reason === 'no-relay'
            ? 'Not connected yet. Try again in a moment.'
            : 'Could not send that request. Try again in a moment.'
      )
    })
  }, [])

  // Viewing a profile takes over the whole tab (all hooks live above this).
  if (selectedHandle) {
    return <ProfilePage handle={selectedHandle} onBack={() => setSelectedHandle(null)} />
  }

  const q = query.trim()
  const queryIsRoot = isAccountRoot(q)
  const connecting = social.phase !== 'live'

  // Submitting navigates even for unknown handles; ProfilePage owns the honest
  // empty state for anything that is not a resolvable account id.
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    if (q) setSelectedHandle(q)
  }

  return (
    <div className="asoc-people">
      {/* ---- Find player ---- */}
      <section className="panel asoc-find">
        <div className="panel-head">
          <span className="asoc-head-icon">
            <Search size={15} aria-hidden />
          </span>
          <span className="panel-title">Find a player</span>
        </div>
        <div className="asoc-panel-body">
          <form className="asoc-search" role="search" onSubmit={onSubmit}>
            <div className="asoc-search-box">
              <Search size={15} aria-hidden className="asoc-search-icon" />
              <input
                type="text"
                className="text-input asoc-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Paste an account id"
                aria-label="Find a player by account id"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button type="submit" className="btn small" disabled={!q}>
              View
            </button>
            {queryIsRoot && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => onAdd(q)}
                title="Send a friend request"
              >
                <UserPlus size={14} aria-hidden /> Add friend
              </button>
            )}
          </form>

          {notice && (
            <p className="asoc-accepted" role="status">
              <Check size={14} aria-hidden />
              {notice}
            </p>
          )}

          <p className="asoc-caption">
            There is no name search. Ask a player for their account id to look them up.
          </p>
        </div>
      </section>

      <div className="asoc-columns">
        {/* ---- Friends ---- */}
        <section className="panel asoc-friends-panel">
          <div className="panel-head">
            <span className="asoc-head-icon">
              <Users size={15} aria-hidden />
            </span>
            <span className="panel-title">Friends</span>
            <span className="muted small num">{social.friends.length}</span>
          </div>
          <div className="asoc-panel-body">
            {social.friends.length === 0 ? (
              <div className="asoc-empty">
                <Users size={22} aria-hidden />
                <span>
                  {connecting
                    ? 'Connecting. Your friends appear in a moment.'
                    : 'No friends yet. Look someone up above and send a request.'}
                </span>
              </div>
            ) : (
              <ul className="asoc-friends">
                {social.friends.map((f) => (
                  <FriendRow
                    key={f.root}
                    friend={f}
                    busy={removingRoot === f.root}
                    onView={viewProfile}
                    onRemove={onRemove}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ---- Mailbox ---- */}
        <section className="panel asoc-mail-panel">
          <div className="panel-head">
            <span className="asoc-head-icon">
              <Mail size={15} aria-hidden />
            </span>
            <span className="panel-title">Mailbox</span>
            <span className="muted small num">{social.requests.length}</span>
            <button
              type="button"
              className="btn ghost small"
              style={{ marginLeft: 'auto' }}
              onClick={() => void runSyncMailbox()}
              disabled={connecting || social.busy === 'syncing'}
              title="Check for new requests now"
            >
              <RefreshCw size={13} aria-hidden className={social.busy === 'syncing' ? 'asoc-spin' : ''} />
              Sync
            </button>
          </div>
          <div className="asoc-panel-body">
            {social.requests.length === 0 ? (
              <div className="asoc-empty">
                <Mail size={22} aria-hidden />
                <span>
                  {connecting
                    ? 'Connecting. Any friend requests arrive in a moment.'
                    : 'No friend requests right now.'}
                </span>
              </div>
            ) : (
              <ul className="asoc-mailbox">
                {social.requests.map((m) => (
                  <RequestRow
                    key={m.id}
                    item={m}
                    accepting={acceptingId === m.id}
                    acceptBusy={acceptingId !== null}
                    onAccept={onAccept}
                    onDecline={onDecline}
                  />
                ))}
              </ul>
            )}

          </div>
        </section>
      </div>
    </div>
  )
}
