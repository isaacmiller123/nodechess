/**
 * Accounts UI store: WIRED (A6, lane 4). Same house pattern as
 * features/play/online/onlineStore.ts: a module-level store outside React,
 * bridged with useSyncExternalStore, so auth state survives view unmounts.
 *
 * The React surface is unchanged from the preview build, but the internals
 * are real: createAccount / signIn / signOut / exportMnemonic run against
 * src/web/accounts.ts (real argon2id derivation, real keyring + chain in
 * localStorage), and every account surface (ladders, reputation, standing,
 * profile, devices, chain rows) is a pure fold over the stored chain via
 * ../store/derive.ts (§0: derived, never asserted). Nothing in this store is
 * sample data: a surface whose channel is not up renders its own empty state
 * (friends over net/socialClient, other players over net/viewerClient), and
 * state this store cannot derive from the chain is simply absent from it.
 *
 * Clock rule: Date.now() is allowed HERE (renderer glue layer, same contract
 * as src/web/accounts.ts): the shared library and ../store/derive.ts stay
 * clock-free and take `atWts` explicitly.
 */

import { useSyncExternalStore } from 'react'
import { displayState } from '@shared/accounts/ratings/display'
import {
  createAccount as webCreateAccount,
  exportKeyfile as webExportKeyfile,
  exportMnemonic as webExportMnemonic,
  forgetRememberedSeed,
  getState as webGetState,
  keyring,
  listKeyringAccounts,
  loadOwnChain,
  rootSigningKey,
  resumeSession,
  sessionInfo,
  signIn as webSignIn,
  signInWithMnemonic as webSignInWithMnemonic,
  signOut as webSignOut,
  updateProfile as webUpdateProfile,
  verifyOwnChain,
  type AccountsState,
} from '../../../../../web/accounts'
import type { Chain } from '@shared/accounts'
import {
  appendPairedPersonal,
  clearPairedRecord,
  loadPairedRecord,
  pairedSigningKey,
  resumePaired,
  revokeDevice,
  type AdoptedAccount,
} from '../pairing/enroll'
import { setAdoptionSink } from '../pairing/claimStore'
import {
  deriveChainEvents,
  deriveDevices,
  deriveOwnAccount,
  deriveProfile,
  foldChainA4,
  foldDigestOf,
} from '../store/derive'
import type {
  LadderKey,
  RatingDisplay,
  UiChainEvent,
  UiDevice,
  UiOwnAccount,
} from './types'

/** The signed-in account's §6 display state, per ladder: the VIEWER side of
 * the provisional-information rule (mm/pairing visibleOpponentInfo). */
export type ViewerDisplayByLadder = Record<LadderKey, RatingDisplay>

/** One keyring row for pickers (real: web accounts listKeyringAccounts). */
export interface UiKeyringAccount {
  handle: string
  displayName: string
  foldedName: string
  tag: string
  current: boolean
  remembered: boolean
}

/**
 * Derive the viewer display-states from the account's protocol ladder state
 * via the SHARED displayState() (A4-17): the value every opponent-facing
 * surface must project through. Never a fixture-authored state.
 */
function viewerDisplayOf(account: UiOwnAccount | null): ViewerDisplayByLadder | null {
  if (!account) return null
  const out: Partial<ViewerDisplayByLadder> = {}
  for (const l of account.ladders) out[l.key] = displayState(l.state, l.key)
  return out as ViewerDisplayByLadder
}

export interface AccountsUiState {
  signedIn: boolean
  /**
   * HOW this device is signed in, which changes what it can do.
   *
   * 'password' is the original: the seed was re-derived here, so this device
   * holds the account's root key, can write the recovery phrase down, and is
   * the only kind of device that can add another one (§1: key certificates are
   * root-signed).
   *
   * 'paired' is a device signed in by scanning a code. It holds a certified
   * child key and the account's history, and nothing else. It can read
   * everything and sign its own records; it cannot export the phrase and cannot
   * enrol further devices, because the root key is not here and was never sent.
   * Surfaces that offer either of those must ask this, not `signedIn`.
   */
  sessionKind: 'password' | 'paired' | null
  account: UiOwnAccount | null
  /**
   * §6 viewer state per ladder, derived (shared displayState()) from the
   * signed-in account. null when signed out. Such a viewer is a spectator
   * (spectatorOpponentInfo), not a provisional viewer.
   */
  viewerDisplay: ViewerDisplayByLadder | null
  /** Async phase: derivation is seconds-scale on phones; 'resuming' is the
   * boot-time remembered-seed session restore (milliseconds, no argon2id). */
  busy: 'idle' | 'resuming' | 'deriving' | 'verifying'
  /** Last auth/profile failure, for the dialogs (cleared on the next try). */
  error: string | null
  /** This device's stored accounts (real keyring; null until first load). */
  keyringAccounts: UiKeyringAccount[] | null
  /** Real chain rows / devices / fold digest for the signed-in account
   * (null when signed out). */
  chainEvents: UiChainEvent[] | null
  devices: UiDevice[] | null
  foldDigest: string | null
  /**
   * §10 staleness for the signed-in account, from the canonical shared fold
   * (derive.ts deriveProfile → social/profile.ts): the newest VERIFIED
   * witness-attested time on the chain, or null = no witnessed activity on
   * record (the honest state of every locally-created chain until witness
   * transport ships). NEVER a self-claimed timestamp.
   */
  lastWitnessedActivityWts: number | null
}

let state: AccountsUiState = {
  // Boot signed OUT: a session only exists after real derivation or a
  // successful remembered-seed resume (kicked off below).
  signedIn: false,
  sessionKind: null,
  account: null,
  viewerDisplay: null,
  busy: 'idle',
  error: null,
  keyringAccounts: null,
  chainEvents: null,
  devices: null,
  foldDigest: null,
  lastWitnessedActivityWts: null,
}

const listeners = new Set<() => void>()

function set(patch: Partial<AccountsUiState>): void {
  state = { ...state, ...patch }
  // viewerDisplay is a pure derivation of the account. Never set directly.
  if ('account' in patch) state = { ...state, viewerDisplay: viewerDisplayOf(state.account) }
  listeners.forEach((fn) => fn())
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Chain → UI derivation (all real)
// ---------------------------------------------------------------------------

interface DerivedBundle {
  account: UiOwnAccount
  chainEvents: UiChainEvent[]
  devices: UiDevice[]
  foldDigest: string
  /** §10 staleness from the canonical profile fold (null = none witnessed). */
  lastWitnessedActivityWts: number | null
}

/**
 * `devicePub` marks which row in the device list is THIS machine. It comes from
 * the web session for a password sign-in and from the paired record for a
 * scanned one, so the caller passes it rather than this function assuming there
 * is a web session to ask.
 */
function deriveBundle(acct: AccountsState, chain: Chain, devicePub?: string): DerivedBundle {
  const own = devicePub ?? sessionInfo()?.devicePub ?? ''
  const account = deriveOwnAccount(
    {
      displayName: acct.displayName ?? '',
      foldedName: acct.foldedName ?? '',
      tag: acct.tag ?? '',
      rootPub: acct.rootPub ?? '',
    },
    chain,
    Date.now(),
  )
  return {
    account,
    chainEvents: deriveChainEvents(chain),
    devices: deriveDevices(chain, own),
    foldDigest: foldDigestOf(foldChainA4(chain).fold),
    lastWitnessedActivityWts: deriveProfile(chain).lastWitnessedActivityWts,
  }
}

/** The same bundle, from a paired device's record and verified history. */
function pairedBundle(adopted: AdoptedAccount): DerivedBundle {
  const r = adopted.record
  return deriveBundle(
    {
      signedIn: true,
      displayName: r.displayName,
      foldedName: r.foldedName,
      tag: r.tag,
      rootPub: r.root,
    },
    adopted.chain,
    r.devicePub,
  )
}

/** Load whichever chain the live session owns, or null when signed out. */
async function currentChain(): Promise<{ chain: Chain; devicePub: string } | null> {
  if (state.sessionKind === 'paired') {
    const signing = pairedSigningKey()
    if (!signing) return null
    const chain = await keyring().loadChain(signing.root)
    return chain ? { chain, devicePub: signing.key } : null
  }
  const info = sessionInfo()
  if (!info) return null
  return { chain: await loadOwnChain(), devicePub: info.devicePub }
}

async function refreshKeyring(): Promise<void> {
  try {
    set({ keyringAccounts: await listKeyringAccounts() })
  } catch {
    // No storage (or storage denied): the pickers render their empty state.
    set({ keyringAccounts: [] })
  }
}

/** Staged by createAccount, committed by finishCreate (the dialog shows the
 * C-5 recovery step in between. Flipping signedIn earlier would unmount it). */
let pendingCreate: DerivedBundle | null = null

/**
 * The sign-out privacy sequence (wiring-3): forget the opt-in remembered seed
 * FIRST, while the session still exists, because forgetRememberedSeed
 * requires one. THEN tear the session down. The ordering is the guarantee:
 * a remembered seed is never left behind because the session teardown failed,
 * so the next boot cannot silently auto-resume an account the user signed out
 * of. A forget failure with nothing remembered / no session is benign and
 * swallowed; a doSignOut failure propagates AFTER the forget already ran.
 * Exported for the wiring suite, which asserts the seed is forgotten even
 * when doSignOut throws.
 */
export async function signOutSequence(
  forget: () => Promise<void>,
  doSignOut: () => void,
): Promise<void> {
  try {
    await forget()
  } catch {
    /* not signed in or nothing remembered: nothing to forget */
  }
  doSignOut()
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export const accountsUiStore = {
  getState(): AccountsUiState {
    return state
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  /**
   * §1: pure local computation. No signup round-trip. Real argon2id + chain
   * genesis via src/web/accounts.ts. Does NOT flip signedIn yet: the create
   * flow shows the recovery-export step first (C-5); the dialog commits with
   * finishCreate() once recovery is acknowledged. Returns success (failure
   * message lands in state.error. The dialog stays open).
   *
   * `remember` defaults FALSE (privacy default, wiring-6): the seed is stored
   * only on explicit opt-in: mirrors src/web/accounts.ts CreateAccountOpts
   * ("Default: NOT stored") and the types.ts StoredAccount contract.
   */
  async createAccount(name: string, password: string, remember = false): Promise<boolean> {
    set({ busy: 'deriving', error: null })
    try {
      const acct = await webCreateAccount(name, password, { rememberSeed: remember })
      set({ busy: 'verifying' })
      pendingCreate = deriveBundle(acct, await loadOwnChain())
      await refreshKeyring()
      set({ busy: 'idle' })
      return true
    } catch (e) {
      set({ busy: 'idle', error: errMsg(e) })
      return false
    }
  },

  /** Commit the account staged by createAccount (recovery step acknowledged). */
  finishCreate(): void {
    if (!pendingCreate) return
    const b = pendingCreate
    pendingCreate = null
    set({
      signedIn: true,
      sessionKind: 'password',
      account: b.account,
      chainEvents: b.chainEvents,
      devices: b.devices,
      foldDigest: b.foldDigest,
      lastWitnessedActivityWts: b.lastWitnessedActivityWts,
    })
  },

  /** §1: signing in anywhere is re-derivation, never lookup. Real argon2id +
   * stored-chain verification. Returns success (failures land in .error).
   * `remember` defaults FALSE. Seed persistence is explicit opt-in only. */
  async signIn(name: string, password: string, remember = false): Promise<boolean> {
    set({ busy: 'deriving', error: null })
    try {
      const acct = await webSignIn(name, password, { rememberSeed: remember })
      set({ busy: 'verifying' })
      const b = deriveBundle(acct, await loadOwnChain())
      await refreshKeyring()
      set({
        busy: 'idle',
        signedIn: true,
        sessionKind: 'password',
        account: b.account,
        chainEvents: b.chainEvents,
        devices: b.devices,
        foldDigest: b.foldDigest,
        lastWitnessedActivityWts: b.lastWitnessedActivityWts,
      })
      return true
    } catch (e) {
      set({ busy: 'idle', error: errMsg(e) })
      return false
    }
  },

  /**
   * The way BACK IN with the 24 words: the other half of exportMnemonicWords.
   * No password and no username, because neither is in the phrase.
   *
   * The caller validates the phrase first (../recoveryPhrase), so anything that
   * reaches here is a real phrase and any failure is about the ACCOUNT, not the
   * typing. Same busy phases as signIn so the wait reads the same, minus the
   * derivation stage the phrase skips. Returns success (failures land in
   * .error).
   */
  async signInWithPhrase(phrase: string, remember = false): Promise<boolean> {
    set({ busy: 'verifying', error: null })
    try {
      const acct = await webSignInWithMnemonic(phrase, { rememberSeed: remember })
      const b = deriveBundle(acct, await loadOwnChain())
      await refreshKeyring()
      set({
        busy: 'idle',
        signedIn: true,
        sessionKind: 'password',
        account: b.account,
        chainEvents: b.chainEvents,
        devices: b.devices,
        foldDigest: b.foldDigest,
        lastWitnessedActivityWts: b.lastWitnessedActivityWts,
      })
      return true
    } catch (e) {
      set({ busy: 'idle', error: errMsg(e) })
      return false
    }
  },

  /**
   * Clears the in-memory session AND the opt-in remembered seed. Chain and
   * keyring record persist (sign-out never destroys the self-carried file).
   * Privacy contract (wiring-3): sign-out ALWAYS forgets the remembered seed.
   * Sequenced via signOutSequence so the forget runs FIRST and survives a
   * failing session teardown. Returns the completion promise (callers may
   * fire-and-forget; the wiring suite awaits it).
   */
  signOut(): Promise<void> {
    return (async () => {
      try {
        await signOutSequence(forgetRememberedSeed, webSignOut)
      } catch {
        // Even a failing sign-out ends signed out locally: the seed forget
        // already ran (it is sequenced before the session teardown).
      }
      // Same contract for a device signed in by scanning: signing out drops
      // the key this device signs with, so the next boot cannot silently bring
      // back an account the user just left. The account's own history stays,
      // exactly as it does for a password sign-out.
      clearPairedRecord()
      pendingCreate = null
      set({
        signedIn: false,
        sessionKind: null,
        account: null,
        chainEvents: null,
        devices: null,
        foldDigest: null,
        lastWitnessedActivityWts: null,
        busy: 'idle',
        error: null,
      })
      await refreshKeyring()
    })()
  },

  /** §10 edit profile: append a signed personal-lane record via the real
   * chain, then re-derive every surface from it. */
  async updateProfile(patch: {
    bio?: string
    country?: string
    flair?: string
    avatar?: string
  }): Promise<boolean> {
    if (!state.signedIn) return false
    try {
      if (state.sessionKind === 'paired') {
        // A paired device signs its own records with the key the account
        // certified for it. That is what the certificate is for (§2 personal
        // lane), so profile edits work here without the root key ever being
        // involved.
        const fields: { [k: string]: string } = {}
        for (const k of ['bio', 'avatar', 'country', 'flair'] as const)
          if (patch[k] !== undefined) fields[k] = patch[k] as string
        if (Object.keys(fields).length === 0) return false
        await appendPairedPersonal('profile', { fields }, Date.now())
        return await accountsUiStore.refreshFromChain()
      }
      const chain = await webUpdateProfile(patch)
      const b = deriveBundle(webGetState(), chain)
      set({
        account: b.account,
        chainEvents: b.chainEvents,
        devices: b.devices,
        foldDigest: b.foldDigest,
        lastWitnessedActivityWts: b.lastWitnessedActivityWts,
        error: null,
      })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  /**
   * Open a session for a device that was just signed in by scanning a code.
   * Registered as the pairing layer's completion sink at the bottom of this
   * file, so the pairing code never imports the store back.
   */
  adoptPaired(adopted: AdoptedAccount): void {
    const b = pairedBundle(adopted)
    set({
      busy: 'idle',
      signedIn: true,
      sessionKind: 'paired',
      account: b.account,
      chainEvents: b.chainEvents,
      devices: b.devices,
      foldDigest: b.foldDigest,
      lastWitnessedActivityWts: b.lastWitnessedActivityWts,
      error: null,
    })
    void refreshKeyring()
  },

  /**
   * Re-read this session's stored history and rebuild every surface from it.
   * The account page is a pure fold over that history, so anything that appends
   * to it (a device added, a device removed, a paired profile edit) has to say
   * so here or the page keeps rendering the previous truth.
   */
  async refreshFromChain(): Promise<boolean> {
    try {
      const cur = await currentChain()
      if (!cur) return false
      const identity =
        state.sessionKind === 'paired'
          ? (() => {
              const r = loadPairedRecord()
              return r
                ? {
                    signedIn: true,
                    displayName: r.displayName,
                    foldedName: r.foldedName,
                    tag: r.tag,
                    rootPub: r.root,
                  }
                : webGetState()
            })()
          : webGetState()
      const b = deriveBundle(identity, cur.chain, cur.devicePub)
      set({
        account: b.account,
        chainEvents: b.chainEvents,
        devices: b.devices,
        foldDigest: b.foldDigest,
        lastWitnessedActivityWts: b.lastWitnessedActivityWts,
      })
      return true
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  /**
   * Remove a device from the account (§1 revocation): a signed event saying
   * that key is retired, which every verifier honours from then on. Signed by
   * the root when this device holds it, by this device's own certified key
   * otherwise.
   *
   * Refuses to remove the key THIS device signs with. Removing yourself is
   * signing out, and doing it this way would leave a device holding a key its
   * own account no longer accepts.
   */
  async removeDevice(pub: string): Promise<boolean> {
    if (!state.signedIn) return false
    try {
      const cur = await currentChain()
      if (!cur) throw new Error('this device is not signed in')
      if (pub === cur.devicePub)
        throw new Error('that is this device. Use Sign out to sign this one out.')
      const paired = state.sessionKind === 'paired' ? pairedSigningKey() : null
      const root = paired ? null : rootSigningKey()
      const signer = paired
        ? { priv: paired.priv, key: paired.key }
        : root
          ? { priv: root.rootPriv, key: root.root }
          : null
      if (!signer) throw new Error('this device cannot sign for the account right now')
      const next = revokeDevice(cur.chain, signer.priv, signer.key, pub, Date.now())
      await keyring().saveChain(next.root, next)
      return await accountsUiStore.refreshFromChain()
    } catch (e) {
      set({ error: errMsg(e) })
      return false
    }
  },

  /** The 24 real BIP39 words (C-5), or null when no session holds a seed. */
  exportMnemonicWords(): string[] | null {
    try {
      return webExportMnemonic().split(' ')
    } catch {
      return null
    }
  },

  /** Real keyfile JSON + a download filename, or null when signed out. */
  exportKeyfile(): { json: string; filename: string } | null {
    try {
      const json = webExportKeyfile()
      const s = webGetState()
      return { json, filename: `${s.foldedName ?? 'account'}-${s.tag ?? 'key'}.keyfile.json` }
    } catch {
      return null
    }
  },

  /** Re-verify the stored chain from genesis (the §2 audit button). */
  async verifyOwnChainNow(): Promise<'ok' | 'failed' | 'unavailable'> {
    try {
      return (await verifyOwnChain()).ok ? 'ok' : 'failed'
    } catch {
      return 'unavailable'
    }
  },

  clearError(): void {
    if (state.error !== null) set({ error: null })
  },
}

// ---------------------------------------------------------------------------
// Boot: remembered-seed resume (fail-closed inside resumeSession) + keyring
// ---------------------------------------------------------------------------

// Where a completed pairing lands. Registered before boot runs, so a scan that
// finishes while the resume is still in flight is not dropped.
setAdoptionSink((adopted) => accountsUiStore.adoptPaired(adopted))

void (async () => {
  set({ busy: 'resuming' })
  try {
    const acct = await resumeSession()
    if (acct.signedIn) {
      const b = deriveBundle(acct, await loadOwnChain())
      set({
        signedIn: true,
        sessionKind: 'password',
        account: b.account,
        chainEvents: b.chainEvents,
        devices: b.devices,
        foldDigest: b.foldDigest,
        lastWitnessedActivityWts: b.lastWitnessedActivityWts,
      })
    }
  } catch {
    /* no storage / no resumable session: boot signed out */
  }
  // A device signed in by scanning has no seed to resume from, so it resumes
  // from its own record instead: same fail-closed rules (the history must be
  // present, verify, and still certify this device) and the same silence when
  // any of that is not true.
  if (!state.signedIn) {
    try {
      const adopted = await resumePaired()
      if (adopted) accountsUiStore.adoptPaired(adopted)
    } catch {
      /* a paired record that cannot be resumed simply is not a session */
    }
  }
  await refreshKeyring()
  set({ busy: 'idle' })
})()

/** React bridge. House useSyncExternalStore convention. */
export function useAccountsUi(): AccountsUiState {
  return useSyncExternalStore(
    accountsUiStore.subscribe,
    accountsUiStore.getState,
    accountsUiStore.getState
  )
}
