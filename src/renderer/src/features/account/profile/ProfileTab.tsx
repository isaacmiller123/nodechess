// The OWN profile tab. Left: "As others see you", the profile exactly as any
// other client derives it. Right: the editor, which applies every change
// instantly and merges across devices at the next sync (no save button).
//
// Copy rule: field feedback answers the edit the player just made. It never
// explains where the value is stored or what signs it.

import { useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react'
import {
  AlertCircle,
  Check,
  Clock,
  Eye,
  Globe,
  ImagePlus,
  Signature,
  UserRound
} from 'lucide-react'
import { AVATAR_B64_MAX_CHARS } from '@shared/accounts/events'
import { accountsUiStore, useAccountsUi } from '../mock/store'
import { RatingLadders } from './RatingLadders'
import { ReputationPanel } from './ReputationPanel'
import { regionName, relativeWts } from './profileFormat'
import './profile.css'

/** Chess figurine flairs: the picker's whole vocabulary. */
const FLAIRS = ['♔', '♕', '♖', '♗', '♘', '♙', '♚', '♛', '♜', '♝', '♞', '♟']

const MAX_AVATAR_BYTES = 32 * 1024
const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function ProfileTab(): JSX.Element {
  const ui = useAccountsUi()
  // This tab only mounts signed-in, so ui.account is set here; the null-guard
  // below is the honest fallback (never a fixture). Hook initializers read it
  // through optional chaining so all hooks stay above the guard (hooks-first).
  const account = ui.account

  /**
   * The REAL derived last-activity value from the canonical shared fold (store
   * to derive.ts deriveProfile), or null when there is none on record. This
   * surface never asserts a fabricated freshness claim.
   */
  const lastWitnessedWts = ui.signedIn ? ui.lastWitnessedActivityWts : null

  // Editable fields: controlled, applied instantly (house style, no save button).
  const [bio, setBio] = useState(account?.profile.bio ?? '')
  const [country, setCountry] = useState(account?.profile.country ?? '')
  const [flair, setFlair] = useState(account?.profile.flair ?? '♟')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarNote, setAvatarNote] = useState<string | null>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // A7 avatar convention: the stored field is `${mime};${base64}` (documented
  // at zProfileFields.avatar). Render whatever the verified record carries;
  // a fresh local pick previews via object URL until the chain write lands.
  const chainAvatar = ((): string | null => {
    const v = account?.profile.avatar
    if (typeof v !== 'string' || v.length === 0) return null
    const cut = v.indexOf(';')
    if (cut <= 0) return null
    const mime = v.slice(0, cut)
    if (!AVATAR_MIMES.has(mime)) return null
    return `data:${mime};base64,${v.slice(cut + 1)}`
  })()
  const avatarSrc = avatarUrl ?? chainAvatar

  // Revoke replaced / unmounted avatar object URLs.
  useEffect(() => {
    if (!avatarUrl) return
    return () => URL.revokeObjectURL(avatarUrl)
  }, [avatarUrl])

  if (!account) {
    return (
      <div className="aprof-tab">
        <p className="muted small">Loading your profile…</p>
      </div>
    )
  }

  const region = regionName(country)
  const regionLabel = country.length === 2 ? region : 'Not set'

  /** Commit a field as a REAL signed 'profile' record (store to
   * src/web/accounts.ts updateProfile to appendPersonal). Bio and country commit
   * on blur, one record per edit rather than per keystroke; flair commits on
   * pick. Skips unchanged values. */
  const commit = (patch: { bio?: string; country?: string; flair?: string }): void => {
    if (!ui.signedIn) return
    const cur = ui.account?.profile
    if (patch.bio !== undefined && patch.bio === cur?.bio) return
    if (patch.country !== undefined && patch.country === cur?.country) return
    if (patch.flair !== undefined && patch.flair === cur?.flair) return
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
    setAvatarUrl(URL.createObjectURL(file))
    if (!ui.signedIn) {
      setAvatarNote(`${file.name} · ${kb} KB · preview only. Sign in to save it.`)
      return
    }
    // A7: the avatar is a REAL stored field now, `mime;base64` in the signed
    // 'profile' record (schema cap AVATAR_B64_MAX_CHARS), so every device
    // derives the same avatar.
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
      const okWrite = await accountsUiStore.updateProfile({ avatar: value })
      setAvatarNote(
        okWrite
          ? `${file.name} · ${kb} KB · saved`
          : `${file.name} · ${kb} KB · could not be saved. Try again in a moment.`
      )
    })()
  }

  return (
    <div className="aprof-tab">
      {/* ---------------- As others see you ---------------- */}
      <section className="card aprof-card aprof-rail aprof-preview" aria-label="Profile preview">
        <header className="aprof-card-head">
          <span className="aprof-eyebrow">
            <Eye size={14} aria-hidden /> As others see you
          </span>
          <p className="aprof-card-sub muted small">
            This is your public profile.
          </p>
        </header>
        <div className="aprof-card-body">
          <div className="aprof-identity">
            {avatarSrc ? (
              <img className="aprof-avatar is-img" src={avatarSrc} alt="Your avatar" />
            ) : (
              <span className="aprof-avatar" aria-hidden>
                <span className="aprof-avatar-glyph">{flair}</span>
              </span>
            )}
            <div className="aprof-identity-main">
              <h3 className="aprof-name">
                {account.displayName}
                <span className="aprof-tag">#{account.tag}</span>
              </h3>
              <span className="aprof-handle account-handle-mono">{account.handle}</span>
              <span className="aprof-identity-meta muted small">
                <Globe size={12} aria-hidden /> {regionLabel}
                <span className="aprof-dot" aria-hidden>
                  ·
                </span>
                <Clock size={12} aria-hidden />{' '}
                {lastWitnessedWts !== null
                  ? `Last played ${relativeWts(lastWitnessedWts, Date.now())}`
                  : 'No games played yet.'}
              </span>
            </div>
          </div>
          {bio.trim() !== '' && <p className="aprof-bio">{bio}</p>}

          <div className="aprof-sect">
            <span className="aprof-sect-title">Ratings</span>
            <span className="aprof-sect-sub muted small">
              Play 10 games in a time control to get a rating.
            </span>
          </div>
          <RatingLadders ladders={account.ladders} />

          <div className="aprof-sect">
            <span className="aprof-sect-title">Reputation</span>
            <span className="aprof-sect-sub muted small">
              How other players have found you to play against.
            </span>
          </div>
          <ReputationPanel reputation={account.reputation} />
        </div>
      </section>

      {/* ---------------- Edit ---------------- */}
      <section className="card aprof-card aprof-edit" aria-label="Edit profile">
        <header className="aprof-card-head">
          <span className="aprof-eyebrow">
            <UserRound size={14} aria-hidden /> Edit profile
          </span>
          <p className="aprof-card-sub muted small">
            Changes save as you type.
          </p>
        </header>
        <div className="aprof-card-body">
          <div className="aprof-field">
            <span className="aprof-field-label">Avatar</span>
            <div className="aprof-avatar-row">
              {avatarUrl ? (
                <img className="aprof-avatar-mini is-img" src={avatarUrl} alt="Current avatar" />
              ) : (
                <span className="aprof-avatar-mini" aria-hidden>
                  {flair}
                </span>
              )}
              <button
                type="button"
                className="btn ghost aprof-btn-sm"
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus size={14} aria-hidden /> Upload image
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="aprof-file-input"
                aria-label="Choose avatar image"
                onChange={onAvatarPick}
              />
              <span className="aprof-field-hint muted small">
                PNG or JPEG, 32 KB max.
              </span>
            </div>
            {avatarError && (
              <p className="aprof-alert" role="alert">
                <AlertCircle size={13} aria-hidden /> {avatarError}
              </p>
            )}
            {avatarNote && !avatarError && (
              <p className="aprof-status" role="status">
                <Check size={13} aria-hidden /> {avatarNote}
              </p>
            )}
          </div>

          <div className="aprof-field">
            <div className="aprof-field-labelrow">
              <label className="aprof-field-label" htmlFor="aprof-bio">
                Bio
              </label>
              <span className={`aprof-count num${bio.length >= 480 ? ' is-max' : ''}`}>
                {bio.length} / 500
              </span>
            </div>
            <textarea
              id="aprof-bio"
              className="aprof-textarea"
              maxLength={500}
              rows={3}
              value={bio}
              onChange={(e) => setBio(e.target.value.slice(0, 500))}
              onBlur={() => commit({ bio })}
              placeholder="Tell the pool who they're up against"
            />
          </div>

          <div className="aprof-field">
            <label className="aprof-field-label" htmlFor="aprof-country">
              Country
            </label>
            <div className="aprof-country-row">
              <input
                id="aprof-country"
                className="text-input aprof-country"
                maxLength={2}
                value={country}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) =>
                  setCountry(
                    e.target.value
                      .replace(/[^a-zA-Z]/g, '')
                      .toUpperCase()
                      .slice(0, 2)
                  )
                }
                onBlur={() => commit({ country })}
                placeholder="US"
              />
              <span className="aprof-field-hint muted small">
                {country.length === 2 ? region : 'Two-letter code'}
              </span>
            </div>
          </div>

          <div className="aprof-field">
            <span className="aprof-field-label" id="aprof-flair-label">
              Flair
            </span>
            <div className="aprof-flairs" role="group" aria-labelledby="aprof-flair-label">
              {FLAIRS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`aprof-flair${flair === f ? ' on' : ''}`}
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
        <footer className="aprof-card-foot muted small">
          <Signature size={13} aria-hidden />
          Changes sync to your other devices.
        </footer>
      </section>
    </div>
  )
}
