import { useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react'
import { AVATAR_B64_MAX_CHARS } from '@shared/accounts/events'
import { accountsUiStore } from './mock/store'
import type { UiOwnAccount } from './mock/types'
import { regionName } from './profile/profileFormat'

/**
 * What other players see. v1 never drew it, so it is built out of the same
 * pieces its page uses: one section, one panel, a row per field. Every field
 * here is a real editable profile field; the ones that are not editable
 * (the name, the tag) are facts on the Identity panel instead.
 *
 * Edits apply as they are made, so there is no save button and no dirty state.
 */

/** Chess figurine flairs: the picker's whole vocabulary. */
const FLAIRS = ['♔', '♕', '♖', '♗', '♘', '♙', '♚', '♛', '♜', '♝', '♞', '♟']

const MAX_AVATAR_BYTES = 32 * 1024
const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The stored avatar field is `mime;base64`; render whatever the verified
 *  record carries, and nothing when it carries something unreadable. */
function avatarDataUri(stored: string): string | null {
  if (stored.length === 0) return null
  const cut = stored.indexOf(';')
  if (cut <= 0) return null
  const mime = stored.slice(0, cut)
  if (!AVATAR_MIMES.has(mime)) return null
  return `data:${mime};base64,${stored.slice(cut + 1)}`
}

export function AccountProfile({ account }: { account: UiOwnAccount }): JSX.Element {
  const [bio, setBio] = useState(account.profile.bio)
  const [country, setCountry] = useState(account.profile.country)
  const [flair, setFlair] = useState(account.profile.flair)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarNote, setAvatarNote] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Revoke replaced / unmounted preview object URLs.
  useEffect(() => {
    if (!avatarPreview) return
    return () => URL.revokeObjectURL(avatarPreview)
  }, [avatarPreview])

  const avatarSrc = avatarPreview ?? avatarDataUri(account.profile.avatar)
  const region = country.length === 2 ? regionName(country) : 'Two-letter code'

  /** One signed record per edit rather than per keystroke: bio and country
   *  commit on blur, flair on pick. Unchanged values write nothing. */
  const commit = (patch: { bio?: string; country?: string; flair?: string }): void => {
    const cur = account.profile
    if (patch.bio !== undefined && patch.bio === cur.bio) return
    if (patch.country !== undefined && patch.country === cur.country) return
    if (patch.flair !== undefined && patch.flair === cur.flair) return
    void accountsUiStore.updateProfile(patch)
  }

  function onAvatarPick(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const kb = Math.max(1, Math.ceil(file.size / 1024))
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError(`${file.name} is ${kb} KB. Pick an image under 32 KB.`)
      setAvatarNote(null)
      return
    }
    if (!AVATAR_MIMES.has(file.type)) {
      setAvatarError(`${file.name}: use a PNG, JPEG, WebP, or GIF image.`)
      setAvatarNote(null)
      return
    }
    setAvatarError(null)
    setAvatarPreview(URL.createObjectURL(file))
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      const value = `${file.type};${btoa(bin)}`
      if (value.length > AVATAR_B64_MAX_CHARS) {
        setAvatarError(`${file.name} is too large. Use a slightly smaller image.`)
        setAvatarNote(null)
        return
      }
      const ok = await accountsUiStore.updateProfile({ avatar: value })
      setAvatarNote(
        ok ? `${file.name} · ${kb} KB · saved` : `${file.name} could not be saved. Try again.`
      )
    })()
  }

  return (
    <section className="sec">
      <div className="sec-head">
        <h2 className="lbl">Profile</h2>
      </div>
      <p className="sec-note">What other players see. Changes save as you make them.</p>
      <div className="panel">
        <div className="acct-field">
          <span className="lbl">Picture</span>
          <div className="acct-pw">
            {avatarSrc ? (
              <img className="acct-avatar" src={avatarSrc} alt="Your picture" />
            ) : (
              <span className="acct-avatar acct-avatar-glyph" aria-hidden>
                {flair}
              </span>
            )}
            <button className="btn is-quiet" type="button" onClick={() => fileRef.current?.click()}>
              Upload image
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="vh"
              aria-label="Choose a picture"
              onChange={onAvatarPick}
            />
          </div>
          {avatarError ? (
            <p className="acct-alert" role="alert">
              {avatarError}
            </p>
          ) : avatarNote ? (
            <p className="acct-hint" role="status">
              {avatarNote}
            </p>
          ) : (
            <p className="acct-hint">PNG or JPEG, 32 KB max.</p>
          )}
        </div>

        <div className="acct-field">
          <label className="lbl" htmlFor="acct-bio">
            Bio
          </label>
          <textarea
            id="acct-bio"
            className="acct-textarea"
            maxLength={500}
            rows={3}
            value={bio}
            placeholder="Tell the pool who they are up against"
            onChange={(e) => setBio(e.target.value.slice(0, 500))}
            onBlur={() => commit({ bio })}
          />
          <p className="acct-hint num">{bio.length} / 500</p>
        </div>

        <div className="acct-field">
          <label className="lbl" htmlFor="acct-country">
            Country
          </label>
          <div className="acct-pw">
            <input
              id="acct-country"
              className="filter-input acct-input is-short"
              maxLength={2}
              value={country}
              autoComplete="off"
              spellCheck={false}
              placeholder="US"
              onChange={(e) =>
                setCountry(
                  e.target.value
                    .replace(/[^a-zA-Z]/g, '')
                    .toUpperCase()
                    .slice(0, 2)
                )
              }
              onBlur={() => commit({ country })}
            />
            <span className="acct-hint">{region}</span>
          </div>
        </div>

        <div className="acct-field">
          <span className="lbl" id="acct-flair-label">
            Flair
          </span>
          <div className="chips" role="group" aria-labelledby="acct-flair-label">
            {FLAIRS.map((f) => (
              <button
                key={f}
                className="chip acct-flair"
                type="button"
                aria-pressed={flair === f}
                aria-label={`Flair ${f}`}
                onClick={() => {
                  setFlair(f)
                  commit({ flair: f })
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
