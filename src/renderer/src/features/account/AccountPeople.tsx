import { useCallback, useEffect, useState, useSyncExternalStore, type JSX } from 'react'
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
  type SocialFriendView
} from './net/socialClient'
import { isAccountRoot } from './net/viewerClient'

/**
 * Friends, in v1's language: a section, a panel, one row per person.
 *
 * Every list here is live or honestly empty. Nothing on this surface is
 * sample data, and the empty states say what to do next rather than
 * apologising. What holds a friendship together, and why a request has to wait
 * for the other side, is not a decision the player makes and is not on screen.
 */

const DAY = 86_400_000

const PRESENCE_LABEL: Record<FriendPresence, string> = {
  online: 'Online now',
  playing: 'Playing',
  away: 'Away',
  offline: 'Offline'
}

function friendLabel(since: number | null): string | null {
  if (since === null) return null
  const days = Math.round((Date.now() - since) / DAY)
  if (days < 1) return 'Friends since today'
  if (days === 1) return 'Friends for a day'
  if (days < 60) return `Friends for ${days} days`
  if (days < 540) return `Friends for ${Math.round(days / 30)} months`
  return `Friends for ${Math.round(days / 365)} years`
}

function useSocialClient(): SocialClientState {
  return useSyncExternalStore(subscribeSocialClient, getSocialClientState, getSocialClientState)
}

/** One friend. Removing is unilateral, which is the one fact the confirm has
 *  to carry, so it takes two clicks and says so. */
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
  const since = friendLabel(friend.since)

  return (
    <div className="row acct-row">
      <div className="acct-row-main">
        <span className="acct-row-name">{friend.name ?? friend.label}</span>
        <span className="acct-row-sub">
          {PRESENCE_LABEL[friend.presence]}
          {since ? ` · ${since}` : ''}
        </span>
      </div>
      {armed ? (
        <>
          <span className="acct-hint">
            {friend.name ?? friend.label} is not asked and cannot block this.
          </span>
          <button className="btn is-quiet" type="button" onClick={() => setArmed(false)}>
            Cancel
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => onRemove(friend.root)}
          >
            {busy ? 'Removing' : 'Remove friend'}
          </button>
        </>
      ) : (
        <>
          <button className="btn is-quiet" type="button" onClick={() => onView(friend.root)}>
            View
          </button>
          <button
            className="btn is-quiet"
            type="button"
            disabled={busy}
            onClick={() => setArmed(true)}
          >
            Remove
          </button>
        </>
      )}
    </div>
  )
}

export function AccountPeople({ onView }: { onView: (root: string) => void }): JSX.Element {
  const social = useSocialClient()
  const [query, setQuery] = useState('')
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [removingRoot, setRemovingRoot] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Opening the page pulls anything that was held for us.
  useEffect(() => {
    void runSyncMailbox()
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

  const q = query.trim()
  const connecting = social.phase !== 'live'

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Friends</h2>
        <span className="sec-count num">{social.friends.length}</span>
      </div>
      <div className="panel">
        <div className="row acct-find">
          <input
            className="filter-input"
            value={query}
            placeholder="Paste an account id"
            aria-label="Find a player by account id"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" type="button" disabled={!q} onClick={() => onView(q)}>
            View
          </button>
          {isAccountRoot(q) && (
            <button
              className="btn is-quiet"
              type="button"
              onClick={() => {
                setNotice(null)
                void runSendFriendRequest(q).then((r) => {
                  setNotice(
                    r.ok
                      ? 'Friend request sent. They see it the next time they open the app.'
                      : r.reason === 'no-relay'
                        ? 'Not connected yet. Try again in a moment.'
                        : 'Could not send that request. Try again in a moment.'
                  )
                })
              }}
            >
              Add friend
            </button>
          )}
        </div>

        {notice && (
          <div className="row is-dense">
            <p className="acct-hint" role="status">
              {notice}
            </p>
          </div>
        )}

        {social.requests.map((m) => (
          <div className="row acct-row" key={m.id}>
            <div className="acct-row-main">
              <span className="acct-row-name">{m.name ?? m.label}</span>
              <span className="acct-row-sub">Wants to be friends</span>
            </div>
            <button
              className="btn"
              type="button"
              disabled={acceptingId !== null}
              onClick={() => onAccept(m.id)}
            >
              {acceptingId === m.id ? 'Adding' : 'Accept'}
            </button>
            <button
              className="btn is-quiet"
              type="button"
              disabled={acceptingId !== null}
              onClick={() => runDeclineRequest(m.id)}
            >
              Decline
            </button>
          </div>
        ))}

        {social.friends.length === 0 ? (
          <div className="empty">
            <p className="empty-line">
              {connecting ? 'Connecting. Your friends appear in a moment.' : 'No friends yet.'}
            </p>
            <p className="empty-line">
              There is no name search. Ask a player for their account id and look them up here.
            </p>
          </div>
        ) : (
          social.friends.map((f) => (
            <FriendRow
              key={f.root}
              friend={f}
              busy={removingRoot === f.root}
              onView={onView}
              onRemove={onRemove}
            />
          ))
        )}
      </div>
    </section>
  )
}
