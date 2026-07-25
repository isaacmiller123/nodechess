// Decentralized-accounts web glue (spec §14-A1 packaging deliverable).
//
// This is NOT the interim server-account system (authStore.ts / server/auth.ts
// — in service until A-final): it is the A1 client surface for the
// database-less accounts, wired to localStorage through the platform-neutral
// keyring. NO UI yet — A6 owns UI. window.__chessAccounts is a dev/test
// surface so the flows are reachable from the console and from CI page
// drivers without dead buttons anywhere.
//
// Clock rule: the shared library is clock-free by contract; THIS layer is
// where Date.now() is allowed. Every event timestamp originates here.

import {
  KEY_PURPOSE,
  Keyring,
  StorageLikeKeyStore,
  appendEvent,
  appendPersonal,
  certSetFrom,
  createAccountChain,
  deriveChild,
  makeCertEvent,
  deriveIdentity,
  ed25519,
  eventId,
  formatHandle,
  fromB64u,
  makeKeyfile,
  normalizeUsername,
  seedToMnemonic,
  slip10Master,
  tagOf,
  toB64u,
  verifyChain,
  type CanonicalObject,
  type Chain,
  type Identity,
  type StorageLike,
  type StoredAccount,
  type VerifyResult,
} from '@shared/accounts'

// ---------------------------------------------------------------------------
// Keyring over localStorage
// ---------------------------------------------------------------------------

// globalThis-based so the module also loads under the node-run web suites
// (which stub localStorage) — in the browser this IS window.localStorage.
// LAZY: this module is a side-effect import of the web entry, and a
// storage-denied context (or a bare-node import without the stub) must not
// blank the app at module-eval time — it errors when a flow actually runs.
let _keyring: Keyring | null = null
export function keyring(): Keyring {
  if (_keyring) return _keyring
  const storage = (globalThis as { localStorage?: StorageLike }).localStorage
  if (!storage) throw new Error('accounts: no localStorage available')
  _keyring = new Keyring(new StorageLikeKeyStore(storage))
  return _keyring
}

// ---------------------------------------------------------------------------
// In-memory session (cleared by signOut — the chain is NEVER cleared)
// ---------------------------------------------------------------------------

interface Session {
  identity: Identity
  account: StoredAccount
}

let session: Session | null = null

export interface AccountsState {
  signedIn: boolean
  foldedName?: string
  displayName?: string
  tag?: string
  handle?: string
  rootPub?: string
}

export function getState(): AccountsState {
  if (!session) return { signedIn: false }
  const { identity } = session
  return {
    signedIn: true,
    foldedName: identity.foldedName,
    displayName: identity.displayName,
    tag: identity.tag,
    handle: formatHandle(identity.displayName, identity.tag),
    rootPub: toB64u(identity.rootPub),
  }
}

// ---------------------------------------------------------------------------
// Device label (short, human) from the user agent
// ---------------------------------------------------------------------------

/** 'Chrome', 'Firefox', 'Safari', 'Edge' … + platform hint, ≤ 64 chars
 *  (zCertPayload label cap). Pure string munging — deterministic per UA. */
export function shortDeviceLabel(ua: string): string {
  let browser = 'Browser'
  if (/Edg\//.test(ua)) browser = 'Edge'
  else if (/OPR\//.test(ua)) browser = 'Opera'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua)) browser = 'Safari'
  let os = ''
  if (/Windows/.test(ua)) os = 'Windows'
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/iPhone|iPad/.test(ua)) os = 'iOS'
  else if (/Linux/.test(ua)) os = 'Linux'
  const label = os ? `${browser} on ${os}` : browser
  return label.slice(0, 64)
}

function deviceLabel(): string {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator
  return shortDeviceLabel(nav?.userAgent ?? '')
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export interface CreateAccountOpts {
  /** Explicit "keep me signed in on this device" — stores the seed (keyfile
   *  semantics, types.ts StoredAccount doc). Default: NOT stored. */
  rememberSeed?: boolean
}

// ---------------------------------------------------------------------------
// Cross-device restore seam (§5 the network IS the storage, §10 sign in anywhere)
// ---------------------------------------------------------------------------

/**
 * Resolve an account's own chain from the overlay, given the freshly derived
 * identity. Registered by the renderer's account-net layer (which owns the
 * peer/overlay) — this module must not import it, so the dependency is injected,
 * exactly like setPinRootSignerProvider.
 *
 * Takes the whole identity, not just the root, because the peer that performs
 * the lookup has to run AS this account: sign-in is what starts the peer, so a
 * restore that needed an already-signed-in peer would deadlock.
 *
 * Contract: resolve the subject's chain, verify it, and return it — or null when
 * the network has nothing (offline, or an account that never replicated). MUST
 * NOT throw; a restore failure is an honest "not found", never a broken sign-in.
 */
export type ChainRestoreProvider = (identity: Identity) => Promise<Chain | null>

let chainRestoreProvider: ChainRestoreProvider | null = null

/** Register the cross-device chain-restore provider (the account-net layer calls
 *  this once at boot). Until it is set, sign-in is local-only — the pre-network
 *  behavior, unchanged. */
export function setChainRestoreProvider(fn: ChainRestoreProvider | null): void {
  chainRestoreProvider = fn
}

/** Ask the network for `identity`'s chain. Verified here so a hostile or partial
 *  reconstruction can never become a local account. Null on anything short of a
 *  fully-verifying chain for the right root. */
async function restoreChainFor(identity: Identity): Promise<Chain | null> {
  if (!chainRestoreProvider) return null
  const rootPub = toB64u(identity.rootPub)
  let chain: Chain | null
  try {
    chain = await chainRestoreProvider(identity)
  } catch {
    return null // an unreachable overlay is "not found", not a sign-in failure
  }
  if (!chain || chain.root !== rootPub) return null
  return verifyChain(chain).ok ? chain : null
}

/**
 * Adopt a network-resolved chain onto THIS device: enroll a fresh device key as
 * a root-signed personal-lane cert (spec §1 "enrollment is a personal-lane
 * root-signed certificate — valid offline"), persist chain + record, and open
 * the session. Returns null when the network had nothing, so the caller can fall
 * through to its honest error.
 *
 * The new device takes the next free device index, so it never collides with the
 * original machine's key and both remain independently revocable.
 */
async function adoptFromNetwork(identity: Identity): Promise<AccountsState | null> {
  const restored = await restoreChainFor(identity)
  if (!restored) return null

  const rootPub = toB64u(identity.rootPub)
  const index = nextDeviceIndex(rootPub, restored)
  const device = deriveChild(identity.seed, KEY_PURPOSE.device, index)
  const devicePub = toB64u(device.pub)
  const certEv = makeCertEvent(identity.rootPriv, rootPub, restored, {
    childPub: devicePub,
    purpose: KEY_PURPOSE.device,
    index,
    label: deviceLabel(),
    ts: Date.now(),
  })
  const chain = appendEvent(restored, certEv)
  const vr = verifyChain(chain)
  if (!vr.ok) throw new Error(`device enrollment broke the restored chain: ${vr.errors[0]?.code}`)

  const account: StoredAccount = {
    v: 1,
    foldedName: identity.foldedName,
    displayName: identity.displayName,
    tag: identity.tag,
    rootPub,
    device: { index, pub: devicePub, certEvent: eventId(certEv.body) },
  }
  // Chain first, record second — the same ordering (and the same reasoning) as
  // createAccount: a half-adopted account must never brick the name.
  await keyring().saveChain(chain.root, chain)
  try {
    await keyring().saveAccount(account)
  } catch (e) {
    try {
      await keyring().removeChain(chain.root)
    } catch {
      /* best-effort rollback */
    }
    throw e
  }
  session = { identity, account }
  return getState()
}

/** The lowest device index not already certified in the chain. */
function nextDeviceIndex(rootPub: string, chain: Chain): number {
  const used = new Set(
    certSetFrom(rootPub, chain.events)
      .filter((c) => c.purpose === KEY_PURPOSE.device)
      .map((c) => c.index),
  )
  let i = 0
  while (used.has(i)) i++
  return i
}

/**
 * Create an account fully offline: derive → genesis + device-0 cert →
 * persist chain THEN record → signed in. Refuses an existing (foldedName,
 * tag) record and an existing chain for the derived root (creation is
 * deliberate; use signIn). Same name + different password derives a
 * different root/tag and COEXISTS (spec §1: collisions disambiguate by tag).
 */
export async function createAccount(
  name: string,
  password: string,
  opts?: CreateAccountOpts,
): Promise<AccountsState> {
  const identity = await deriveIdentity(name, password)
  const rootPub = toB64u(identity.rootPub)
  const existing = await keyring().getAccount(identity.foldedName, identity.tag)
  if (existing)
    throw new Error(
      `an account named '${identity.foldedName}#${identity.tag}' already exists on this device — sign in instead`,
    )
  // The chain is append-only and survives removeAccount by design — NEVER
  // overwrite one that is already on this device.
  if ((await keyring().loadChain(rootPub)) !== null)
    throw new Error(
      `a chain for '${identity.foldedName}#${identity.tag}' already exists on this device — sign in instead`,
    )
  const device = deriveChild(identity.seed, KEY_PURPOSE.device, 0)
  const devicePub = toB64u(device.pub)
  const now = Date.now() // glue-layer clock — the library never reads one
  const chain = createAccountChain({
    rootPriv: identity.rootPriv,
    rootPub: identity.rootPub,
    displayName: identity.displayName,
    ts: now,
    device: { pub: devicePub, index: 0, label: deviceLabel() },
  })
  const vr = verifyChain(chain)
  if (!vr.ok) throw new Error(`freshly created chain failed verification: ${vr.errors[0]?.code}`)
  const certEv = chain.events.find((e) => e.body.type === 'cert')
  if (!certEv) throw new Error('created chain is missing its device certificate')
  const account: StoredAccount = {
    v: 1,
    foldedName: identity.foldedName,
    displayName: identity.displayName,
    tag: identity.tag,
    rootPub,
    device: { index: 0, pub: devicePub, certEvent: eventId(certEv.body) },
    ...(opts?.rememberSeed ? { seedB64u: toB64u(identity.seed) } : {}),
  }
  // Chain FIRST, record second: if the record write fails, roll the chain
  // back (best-effort) so the username stays retryable — a half-created
  // account must never brick the name.
  await keyring().saveChain(chain.root, chain)
  try {
    await keyring().saveAccount(account)
  } catch (e) {
    try {
      await keyring().removeChain(chain.root)
    } catch {
      /* best-effort rollback — the original failure is what matters */
    }
    throw e
  }
  session = { identity, account }
  return getState()
}

/**
 * Sign in = re-derivation + verification against the stored chain. NEVER
 * creates anything: no stored account/chain for the name → error directing
 * the user to createAccount (create-if-absent is an explicit, separate act).
 * Lookup is by (foldedName, DERIVED tag): a wrong password derives a
 * different root/tag, so the record simply isn't found — when other tags
 * exist under the name, that mismatch IS the wrong-password signal.
 */
export interface SignInOpts {
  /** A6 additive: explicit "keep me signed in on this device" at sign-in —
   *  same keyfile semantics as CreateAccountOpts.rememberSeed. */
  rememberSeed?: boolean
}

export async function signIn(
  name: string,
  password: string,
  opts?: SignInOpts,
): Promise<AccountsState> {
  const identity = await deriveIdentity(name, password)
  let account = await keyring().getAccount(identity.foldedName, identity.tag)
  if (!account) {
    // CROSS-DEVICE (§10 "sign in anywhere"): this machine has never seen the
    // account, but the identity is fully derived — the keys ARE the account. Ask
    // the network for the chain and enroll this device against it. Only when
    // that finds nothing is "not on this device" the honest answer.
    const adopted = await adoptFromNetwork(identity)
    if (adopted) return adopted
    const sameName = (await keyring().listAccounts()).some(
      (a) => a.foldedName === identity.foldedName,
    )
    throw new Error(
      sameName
        ? 'no account with this name and password on this device'
        : chainRestoreProvider === null
          ? `no account named '${identity.foldedName}' on this device — create it explicitly`
          : `could not find '${identity.foldedName}' on this device or the network — check the name and password, or restore from your recovery phrase`,
    )
  }
  // Tag is a 25-bit prefix — keep the full-rootPub check as defense in depth.
  if (toB64u(identity.rootPub) !== account.rootPub)
    throw new Error('wrong password (derived key does not match this account)')
  let chain = await keyring().loadChain(account.rootPub)
  if (!chain) {
    // A record with no chain: recoverable the same way — the chain lives on the
    // network by design (§5), so refuse only once the network has nothing.
    const restored = await restoreChainFor(identity)
    if (restored) {
      await keyring().saveChain(restored.root, restored)
      chain = restored
    }
  }
  if (!chain) throw new Error('account record exists but its chain is missing — cannot sign in')
  if (chain.root !== account.rootPub) throw new Error('stored chain belongs to a different root')
  const vr = verifyChain(chain)
  if (!vr.ok)
    throw new Error(`stored chain failed verification (${vr.errors[0]?.code}) — refusing to sign in`)
  // Opt-in seed persistence (C-5 keyfile semantics) — only ever ADDS the
  // seed; forgetting is the explicit separate act (forgetRememberedSeed).
  if (opts?.rememberSeed && account.seedB64u === undefined) {
    account = { ...account, seedB64u: toB64u(identity.seed) }
    await keyring().saveAccount(account)
  }
  session = { identity, account }
  return getState()
}

/** Clears the in-memory identity ONLY. The chain + account record stay —
 *  sign-out never destroys the self-carried file. */
export function signOut(): void {
  session = null
}

function requireSession(): Session {
  if (!session) throw new Error('not signed in')
  return session
}

/** 24-word BIP39 encoding of the signed-in account's seed (the lifeline, C-5). */
export function exportMnemonic(): string {
  return seedToMnemonic(requireSession().identity.seed)
}

/** Keyfile JSON for the signed-in account (plaintext by design — C-5). */
export function exportKeyfile(): string {
  return JSON.stringify(makeKeyfile(requireSession().identity))
}

/** Load + verify the signed-in account's stored chain (the A1 headless-verify
 *  proof surface). Pure read — no state change. */
export async function verifyOwnChain(): Promise<VerifyResult> {
  const { account } = requireSession()
  const chain: Chain | null = await keyring().loadChain(account.rootPub)
  if (!chain) throw new Error('no stored chain for the signed-in account')
  return verifyChain(chain)
}

// ---------------------------------------------------------------------------
// A6 additive surface (renderer wiring — multi-device polish). Everything
// below is ADDITIVE: no pre-A6 export changes shape or behavior.
// ---------------------------------------------------------------------------

/** One keyring row for account pickers (no key material ever leaves here). */
export interface KeyringAccountInfo {
  foldedName: string
  displayName: string
  tag: string
  handle: string
  /** This row is the live session's account. */
  current: boolean
  /** Carries an opt-in remembered seed (resumeSession candidate). */
  remembered: boolean
}

/** List this device's stored accounts (§1: several roots, one machine).
 * Fail-closed (A6 review wiring-1): a corrupt keyring store yields an empty
 * list, never a throw that breaks every account's surface. */
export async function listKeyringAccounts(): Promise<KeyringAccountInfo[]> {
  let rows: StoredAccount[]
  try {
    rows = await keyring().listAccounts()
  } catch {
    return []
  }
  const cur = session?.account.rootPub
  return rows.map((a) => ({
    foldedName: a.foldedName,
    displayName: a.displayName,
    tag: a.tag,
    handle: formatHandle(a.displayName, a.tag),
    current: a.rootPub === cur,
    remembered: a.seedB64u !== undefined,
  }))
}

/**
 * Resume a session from an opt-in remembered seed (rememberSeed at create or
 * sign-in). FAIL-CLOSED at every step: a seed that does not re-derive the
 * stored root/tag, a missing chain, or a chain failing verification silently
 * skips the record (never a throw at boot, never a session from unverified
 * data). No argon2id here — the seed is post-KDF material, so resume is
 * milliseconds. Returns the (possibly unchanged) state.
 */
export async function resumeSession(): Promise<AccountsState> {
  if (session) return getState()
  // A6 review wiring-1: the store read itself must be inside the fail-closed
  // boundary — a corrupt keyring record throwing in listAccounts() would
  // otherwise break boot for EVERY account on the device.
  let stored: StoredAccount[]
  try {
    stored = await keyring().listAccounts()
  } catch {
    return getState()
  }
  for (const account of stored) {
    if (account.seedB64u === undefined) continue
    try {
      const seed = fromB64u(account.seedB64u)
      const master = slip10Master(seed)
      const rootPub = ed25519.getPublicKey(master.priv)
      // The remembered seed must re-derive the stored identity exactly.
      if (toB64u(rootPub) !== account.rootPub) continue
      if (tagOf(rootPub) !== account.tag) continue
      const chain = await keyring().loadChain(account.rootPub)
      if (!chain || chain.root !== account.rootPub) continue
      if (!verifyChain(chain).ok) continue
      // A6 review wiring-2: never a session from unverified data — the names
      // must come from the chain's SIGNED genesis, not the mutable stored
      // record (a tampered localStorage name would otherwise ride into the
      // session identity and the exported keyfile).
      const genesis = chain.events.find((e) => e.body.lane === 'w' && e.body.type === 'genesis')
      if (!genesis) continue
      const genesisName = (genesis.body.payload as { name?: unknown }).name
      if (typeof genesisName !== 'string') continue
      if (account.displayName !== genesisName) continue
      if (account.foldedName !== normalizeUsername(genesisName).folded) continue
      session = {
        identity: {
          seed,
          rootPriv: master.priv,
          rootPub,
          tag: account.tag,
          foldedName: account.foldedName,
          displayName: account.displayName,
        },
        account,
      }
      return getState()
    } catch {
      /* fail closed — a corrupt record must never block boot */
    }
  }
  return getState()
}

/** Drop the signed-in account's remembered seed (sign-out hygiene). The
 *  account record and chain stay — only the auto-resume material goes. */
export async function forgetRememberedSeed(): Promise<void> {
  const s = requireSession()
  if (s.account.seedB64u === undefined) return
  const stripped: StoredAccount = { ...s.account }
  delete stripped.seedB64u
  await keyring().saveAccount(stripped)
  s.account = stripped
}

/** The signed-in session's device/root pubs (for chain-derivation callers). */
export function sessionInfo(): { rootPub: string; devicePub: string; deviceIndex: number } | null {
  if (!session) return null
  const { account } = session
  return { rootPub: account.rootPub, devicePub: account.device.pub, deviceIndex: account.device.index }
}

/**
 * A6 (Lane C) — the signed-in device's ed25519 signing material for v6 signed
 * online play (spec §3). Derives the device child key EXACTLY as updateProfile
 * signs (`deriveChild(seed, KEY_PURPOSE.device, device.index)`), so a per-move /
 * segment signature made with `priv` verifies against `key` (= account.device.pub),
 * and `root` binds into the game key. Returns null when signed out (⇒ casual /
 * unsigned play, byte-identical v5). Fail-closed: a device-key mismatch (a
 * tampered record) returns null rather than a key that would never verify.
 *
 * The returned shape is a structural `MpSigningConfig` (minus the optional,
 * per-game `oppRoot` the matchmaker pins) — mpClient's `mpSigningKey` hands it
 * straight to `mp.configureSigning`. NEVER logged/persisted; `priv` stays in-mem. */
export function deviceSigningKey(): { priv: Uint8Array; key: string; root: string } | null {
  if (!session) return null
  const { identity, account } = session
  const device = deriveChild(identity.seed, KEY_PURPOSE.device, account.device.index)
  if (toB64u(device.pub) !== account.device.pub) return null
  return { priv: device.priv, key: account.device.pub, root: account.rootPub }
}

/**
 * A6 (M4 lead hook) — the signed-in account's ROOT signing material for the
 * records spec §1/§3/§10 bind to the ROOT itself: the standalone PIN record
 * (pinClient) and social presence / mailbox envelopes / friend halves
 * (socialClient). Mirrors {@link deviceSigningKey} but returns the ROOT child,
 * the SHAPE both `setPinRootSignerProvider` and `setSocialRootSignerProvider`
 * expect (`PinRootSigner` === `SocialRootSigner` === `{ root, rootPriv }`).
 * Returns null when signed out (⇒ the singletons report an honest
 * signer-unavailable state, never a fabricated committee/surface). Fail-closed:
 * a derived root that does not match the stored account root returns null rather
 * than a key that would never verify.
 *
 * Unlike deviceSigningKey it is DELIBERATELY not on the window dev surface — the
 * root private key never rides the global console object; the two providers
 * import it directly. `rootPriv` stays in-memory, NEVER logged/persisted.
 */
export function rootSigningKey(): { root: string; rootPriv: Uint8Array } | null {
  if (!session) return null
  const { identity, account } = session
  if (toB64u(identity.rootPub) !== account.rootPub) return null
  return { root: account.rootPub, rootPriv: identity.rootPriv }
}

/** Load the signed-in account's stored chain (read-only; throws signed out). */
export async function loadOwnChain(): Promise<Chain> {
  const { account } = requireSession()
  const chain = await keyring().loadChain(account.rootPub)
  if (!chain) throw new Error('no stored chain for the signed-in account')
  return chain
}

/** Profile field patch (§10 edit profile) — keys per zProfileFields. */
export interface ProfileFieldPatch {
  bio?: string
  avatar?: string
  country?: string
  flair?: string
}

/**
 * §10 edit profile: append a signed personal-lane 'profile' record to the
 * own chain, signed by THIS device's certified key. Verifies the appended
 * chain before persisting (fail-closed: an invalid field never lands) and
 * returns the new chain so callers can re-derive without a reload.
 */
export async function updateProfile(patch: ProfileFieldPatch): Promise<Chain> {
  const { identity, account } = requireSession()
  const fields: { [k: string]: string } = {}
  for (const k of ['bio', 'avatar', 'country', 'flair'] as const) {
    const v = patch[k]
    if (v !== undefined) fields[k] = v
  }
  if (Object.keys(fields).length === 0) throw new Error('empty profile update')
  const chain = await loadOwnChain()
  const device = deriveChild(identity.seed, KEY_PURPOSE.device, account.device.index)
  if (toB64u(device.pub) !== account.device.pub)
    throw new Error('device key mismatch — refusing to sign')
  const payload: CanonicalObject = { fields }
  const next = appendPersonal(chain, device.priv, account.device.pub, 'profile', payload, Date.now())
  const vr = verifyChain(next)
  if (!vr.ok) throw new Error(`profile update failed verification: ${vr.errors[0]?.code}`)
  await keyring().saveChain(next.root, next)
  return next
}

// ---------------------------------------------------------------------------
// Dev/test surface (NO UI in A1 — A6 owns UI)
// ---------------------------------------------------------------------------

const surface = {
  createAccount,
  signIn,
  signOut,
  exportMnemonic,
  exportKeyfile,
  getState,
  verifyOwnChain,
  // A6 additions
  listKeyringAccounts,
  resumeSession,
  forgetRememberedSeed,
  sessionInfo,
  deviceSigningKey,
  updateProfile,
}

declare global {
  interface Window {
    __chessAccounts?: typeof surface
  }
}

if (typeof window !== 'undefined') {
  window.__chessAccounts = surface
}
