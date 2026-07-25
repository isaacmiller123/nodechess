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
 * ../store/derive.ts (§0: derived, never asserted). Network-dependent
 * surfaces (PIN committee, presence, friends transport, mailbox, witness set,
 * shard duty, verdicts, other profiles) still render fixtures. Each such
 * component gates on the DEV_FIXTURE flag (./fixtures) and mounts
 * ./FixturePreviewBadge.tsx so it labels itself as sample data in the UI;
 * grep DEV_FIXTURE across features/account to list every fixture surface.
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
  listKeyringAccounts,
  loadOwnChain,
  resumeSession,
  sessionInfo,
  signIn as webSignIn,
  signOut as webSignOut,
  updateProfile as webUpdateProfile,
  verifyOwnChain,
  type AccountsState,
} from '../../../../../web/accounts'
import type { Chain } from '@shared/accounts'
import {
  deriveChainEvents,
  deriveDevices,
  deriveOwnAccount,
  deriveProfile,
  foldChainA4,
  foldDigestOf,
} from '../store/derive'
import { PIN_STATUS } from './fixtures'
import type {
  LadderKey,
  RatingDisplay,
  UiChainEvent,
  UiDevice,
  UiOwnAccount,
  UiPinStatus,
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
  /** PIN committee status, DEV_FIXTURE (C-2: committee-held state needs the
   * witness network; the wizard/dialogs are preview flows until then). */
  pin: UiPinStatus
}

let state: AccountsUiState = {
  // Boot signed OUT: a session only exists after real derivation or a
  // successful remembered-seed resume (kicked off below).
  signedIn: false,
  account: null,
  viewerDisplay: null,
  busy: 'idle',
  error: null,
  keyringAccounts: null,
  chainEvents: null,
  devices: null,
  foldDigest: null,
  lastWitnessedActivityWts: null,
  pin: PIN_STATUS,
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

function deriveBundle(acct: AccountsState, chain: Chain): DerivedBundle {
  const info = sessionInfo()
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
    devices: deriveDevices(chain, info?.devicePub ?? ''),
    foldDigest: foldDigestOf(foldChainA4(chain).fold),
    lastWitnessedActivityWts: deriveProfile(chain).lastWitnessedActivityWts,
  }
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
      pendingCreate = null
      set({
        signedIn: false,
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

  /** PIN committee provisioned (DEV_FIXTURE: flips the preview status flag;
   * the real committee is A2 witness machinery awaiting network wiring). */
  pinConfigured(): void {
    set({ pin: { ...state.pin, set: true } })
  },

  /**
   * Record a PIN failure against the committee counter (§1: lifetime, never
   * resets on success). DEV_FIXTURE. Returns the updated preview status.
   */
  recordPinFailure(): UiPinStatus {
    const pin = { ...state.pin, failures: Math.min(state.pin.failures + 1, state.pin.lifetimeCap) }
    set({ pin })
    return pin
  },
}

// ---------------------------------------------------------------------------
// Boot: remembered-seed resume (fail-closed inside resumeSession) + keyring
// ---------------------------------------------------------------------------

void (async () => {
  set({ busy: 'resuming' })
  try {
    const acct = await resumeSession()
    if (acct.signedIn) {
      const b = deriveBundle(acct, await loadOwnChain())
      set({
        signedIn: true,
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
