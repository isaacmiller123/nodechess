# nodechess desktop release runbook: mac + win. Status: verified live (2026-07-24).

How a nodechess **desktop** build gets from this repo to the public download page. The web
target is a separate artifact: see [`WEB-DEPLOY.md`](WEB-DEPLOY.md).

The whole release is one idea: **push a `vX.Y.Z` git tag, and CI builds the mac + Windows
installers and attaches them to a GitHub Release.** Everything below is the detail around
that one sentence. The guarded helper `scripts/release.mjs` does the safe parts (validate +
bump); a human pushes the tag.

---

## At a glance

| | |
|---|---|
| Download page | GitHub Releases of **`isaacmiller123/nodechess`** (public) |
| What triggers a build | pushing a tag matching `v*` (also runnable manually via Actions) |
| Who builds | `.github/workflows/build.yml`: `macos-latest` + `windows-latest`, in parallel |
| Platforms | mac + Windows only: `electron-builder.yml` has no `linux:` target, so no Linux build has ever been produced |
| Signing | **none**: mac + win ship unsigned (users clear Gatekeeper / SmartScreen once) |
| Auto-update | Windows = in-place (electron-updater); macOS = check-and-notify + `.dmg` download |
| Installer size | ~186–188 MB per mac artifact (lean: engine + puzzle DB are **not** bundled) |
| Datasets | imported at runtime from a **separate** `datasets-v1` release, not the app tag |
| Local build lane | mac artifacts only, via `npm run package` (electron-builder can't cross-build) |

---

## 1. Verified build result (`npm run package`, this machine)

Ran `npm run package` (= `electron-vite build && electron-builder`) on macOS (Apple Silicon,
arm64) at version **1.2.1**. **Result: success, exit 0, ~115 s wall, ~1.6 GB peak RSS.** It
produced every mac artifact into `release/` (git-ignored):

| Artifact | Bytes | ≈ Size | For |
|---|---:|---:|---|
| `nodechess-1.2.1-arm64.dmg` | 185,880,979 | 186 MB | Apple Silicon installer |
| `nodechess-1.2.1-x64.dmg` | 187,820,866 | 188 MB | Intel installer |
| `nodechess-1.2.1-mac-arm64.zip` | 185,672,134 | 186 MB | Apple Silicon (update feed / no-DMG) |
| `nodechess-1.2.1-mac-x64.zip` | 187,692,632 | 188 MB | Intel (update feed / no-DMG) |
| `*.blockmap` (×4) | ~0.2 MB each | n/a | delta-update maps |
| `latest-mac.yml` | 801 B | n/a | update-feed metadata (lists all four) |

Sizes and timings are from that 1.2.1 run and have not been re-measured since; the filenames
follow the current scheme in §9, and releases published before the 2026-07-25 rename carry a
`Chess-` prefix instead.

Notes from the run:
- electron-builder **26.15.3**, electron **42.5.0**, dmg tooling (`hdiutil`) present.
- `skipped macOS code signing` with `reason=identity explicitly is set to null`. Expected.
- Both arches are built in one pass: electron-builder rebuilds native deps for arm64, then
  for x64, downloading the x64 Electron once (cached afterward). A cold first run also
  downloads the `dmgbuild` bundle.
- On macOS this command builds **mac only**. The Windows `.exe`/`.zip` come from the
  `windows-latest` CI leg: electron-builder cannot cross-compile the native installers.

Reproduce (this lane owns `out/` and `release/`):

```sh
export PATH=/opt/homebrew/bin:$PATH
npm run package -- --publish never    # --publish never = belt-and-suspenders, no upload
ls -la release/*.dmg release/*.zip
```

The built app is **ad-hoc signed only** (`codesign -dv` → `Signature=adhoc`,
`Identifier=Electron`); `spctl -a -t exec` rejects it. That is the unsigned state the
Gatekeeper story in §6 is written for, not a build defect.

---

## 2. One-time owner setup (mostly already done)

The classic "it's not a git repo yet" step is **already complete**: this tree is a git repo
with remote `origin → https://github.com/isaacmiller123/chess-sharp.git` (the rename to
`nodechess` is the one step still outstanding, see below) and tags through `v1.3.0`. Kept here
so the flow is reproducible from scratch:

1. **GitHub repo**, **public** (the Releases page *is* the download page), Actions enabled.
   Done, but still under the old name `isaacmiller123/chess-sharp`.
2. **Origin remote + first push** (already done, against `chess-sharp`; a from-scratch setup
   would use the new name):
   ```sh
   git init && git branch -M main
   git remote add origin https://github.com/isaacmiller123/nodechess.git
   git add -A && git commit -m "…" && git push -u origin main
   ```
3. **No secrets required for building.** CI signs nothing and uses the ambient
   `GITHUB_TOKEN` (workflow grants `contents: write`) to create the Release. No personal
   access token, no signing certs.
4. **Datasets release must exist** (it does): a **separate, stable** release tagged
   `datasets-v1` holds the engine + puzzle assets the app imports at runtime (see §4). App
   version bumps do **not** touch it.

Three places name the GitHub repo and **must stay in agreement**. `release.mjs check`
verifies this:
- `electron-builder.yml` → `publish: { owner, repo }`
- the `origin` git remote
- `src/main/updates/updateLogic.ts` → `UPDATE_OWNER` / `UPDATE_REPO` (where the app checks
  for updates)

`electron-builder.yml` and `updateLogic.ts` read `isaacmiller123/nodechess`. The `origin` remote
still points at `isaacmiller123/chess-sharp`, so `release.mjs check` fails until the repo is renamed
on GitHub and the remote is repointed:

```sh
git remote set-url origin https://github.com/isaacmiller123/nodechess.git
```

GitHub redirects the old path, so clones and existing release links keep working either way.

---

## 3. Cutting a release

### 3a. Validate the tree (read-only)

```sh
export PATH=/opt/homebrew/bin:$PATH
node scripts/release.mjs check          # add --full to also run `npm run typecheck`
```

Exits non-zero if not release-ready. It checks: git repo + branch + clean tree; version is
semver; the `vX.Y.Z` tag isn't already used; the three repo targets agree (§2); and the
build inputs exist (`electron-builder.yml`, `build/icon.icns`, `build/icon.ico`,
`.github/workflows/build.yml`).

### 3b. Bump the version

`package.json` `version` is the single source of truth (Electron reads it via
`app.getVersion()`; the updater compares against the newest release tag). Bump it with the
helper. It edits **only** the version string, so formatting is preserved:

```sh
node scripts/release.mjs bump patch            # 1.2.1 → 1.2.2 (also: minor | major | 1.3.0)
node scripts/release.mjs bump patch --dry-run  # print the plan, write nothing
```

By default `bump` writes `package.json` and stops, printing the exact next git commands. It
never commits, tags, or pushes unless you opt in, and every git-mutating step prints its
plan and asks `[y/N]` first (`--yes` to skip the prompt):

```sh
node scripts/release.mjs bump patch --tag      # + git commit package.json + local tag vX.Y.Z
node scripts/release.mjs bump patch --push     # + push branch and tag (double-confirm)
```

> Version-number ownership: `package.json` is owned by the build lead. Coordinate before
> running a `bump` that writes it.

### 3c. Push the tag (this is the actual release)

```sh
git push origin <branch> && git push origin vX.Y.Z
```

The `vX.Y.Z` push starts `build.yml`. Watch the **Actions** tab; when both legs are green the
Release exists at `https://github.com/isaacmiller123/nodechess/releases/tag/vX.Y.Z` with the
installers attached.

To rehearse without releasing: **Actions → build → Run workflow** (`workflow_dispatch`) builds
both platforms and uploads them as 14-day **workflow artifacts** without creating a Release
(the publish step is tag-only).

---

## 4. The lean installer + runtime datasets

The installer is deliberately small: it bundles only tiny, always-on content
(`resources/openings`, `famous`, `curriculum`, `personas`, `games-art` ≈ 33 MB, plus the
~750 KB mac Fairy-Stockfish). The **heavy** datasets are **not** in the repo or the
installer. They download on first run via **Settings → Datasets** from the separate
`datasets-v1` release (`src/main/datasets/datasets.service.ts`, streamed + sha256-verified):

| Dataset | Asset | Download | On disk |
|---|---|---:|---:|
| Stockfish 18 (Windows) | `stockfish-sf18-win-x64.exe` | 114 MB | 114 MB |
| Stockfish 18 (Apple Silicon) | `stockfish-sf18-mac-arm64` | 114 MB | 114 MB |
| Lichess puzzles | `puzzles.sqlite.zst` | 705 MB | 2.15 GB |
| Maia (human-style chess) | lc0 + 5 nets | ~ | ~ |
| KataGo (Go) | 2 nets (+ optional Human-SL 94.5 MB) | ~ | ~ |

Consequences for releasing:
- **App version bumps never re-upload datasets.** The `RELEASE_BASE` URL is pinned to the
  `datasets-v1` tag. Only touch that release when the engine/puzzle **data** itself changes.
- **Known gap: Intel Mac (`darwin-x64`) has no Stockfish artifact.** `ENGINE_ARTIFACTS`
  publishes `win32-x64` and `darwin-arm64` only, so on an Intel Mac the main analysis engine
  is unavailable (puzzles/Maia/KataGo still import; the tiny bundled Fairy-Stockfish still
  works). The `.dmg`/`.zip` still build and ship. This is a datasets-coverage gap, not a
  packaging one. Closing it = add a verified `darwin-x64` row (owned by the datasets lane).

---

## 5. Auto-update model (why the artifact names matter)

Both platforms check `isaacmiller123/nodechess` releases on launch (5 s after ready,
packaged builds only) to keep online-play peers on matching versions. The path is decided in
`src/main/updates/` and is a **hard constraint of shipping unsigned**:

- **Windows → true in-place update** (`electron-updater`). It reads `latest.yml` +
  `*.blockmap` off the Release, downloads in the background, and installs on confirm /
  on-quit. This is why CI must attach `latest.yml` and the blockmaps for the win leg.
- **macOS → check-and-notify only.** Squirrel.Mac refuses unsigned bundles, so there is
  **no** in-place mac update, ever. The app queries the releases API, and if newer, opens
  the browser to the right `.dmg` for the user's chip (picker prefers `nodechess-<v>-<arch>.dmg`
  → `nodechess-<v>-mac-<arch>.zip` → any `.dmg`). The user installs it over the old app.
  `latest-mac.yml` is emitted for symmetry but the mac app doesn't consume it.

So the artifact **names** are an API the updater depends on. Don't rename them without
updating `pickMacAsset` / `pickWinAsset` in `updateLogic.ts`.

---

## 6. Unsigned builds: the first-run story (tell users this)

`electron-builder.yml` sets `identity: null` / `hardenedRuntime: false` (mac) and the win
build is unsigned too. Distributable, but the OS warns once. This copy also lives in the
README and the release notes:

**macOS (Gatekeeper).** First launch may say *"…cannot be opened because Apple cannot check
it for malicious software."* Either:
- **Right-click (Control-click) the app → Open → Open**. The per-app override (first launch
  only), **or**
- **System Settings → Privacy & Security → Open Anyway**, **or**
- if a browser quarantined the download, clear the flag in Terminal:
  ```sh
  xattr -dr com.apple.quarantine /Applications/nodechess.app
  ```
  (Run against wherever the app actually lives.)

**Windows (SmartScreen).** Double-clicking the `.exe` may show *"Windows protected your PC"*
→ **More info → Run anyway**. For the portable `.exe`/`.zip`, Windows may also flag the
download → right-click → **Properties** → tick **Unblock** → **OK**.

---

## 7. Local build: troubleshooting (mac, this lane only)

`npm run package` needs, on macOS: network (first run downloads the x64 Electron + dmg
tooling), `hdiutil` (Xcode Command Line Tools: `xcode-select --install`), and free disk
(~1–2 GB working set). Common outcomes:

| Symptom | Cause / fix |
|---|---|
| `skipped macOS code signing` (identity is set to null) | **Expected**, not an error. |
| Hangs on `downloaded label=electron` | Network fetch of the x64 Electron zip. Let it finish or retry; it caches under `~/Library/Caches/electron`. |
| `GH_TOKEN is not set` at the very end | Publish was attempted. Run `npm run package -- --publish never` (CI already passes this). |
| dmg step fails | `hdiutil` missing → install Xcode Command Line Tools. |
| Native module ABI error | Re-run `npm ci` so `electron-rebuild` rebuilds against Electron 42. |

Local runs land in `release/` (git-ignored). Only the mac artifacts appear locally; trust CI
for the Windows set.

---

## 8. Optional: signing (removes the §6 warnings)

Unsigned is the current, deliberate policy. To upgrade later:

- **macOS: Apple Developer ID** ($99/yr). Set `mac.identity` to the Developer ID Application
  name in `electron-builder.yml`, restore `hardenedRuntime: true`, add a notarization step,
  and supply `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` as repo secrets.
  Then **mac in-place auto-update becomes possible** (Squirrel.Mac accepts signed bundles),
  with a follow-up change in `src/main/updates/`. Also lets you drop the imported-Stockfish
  hardened-runtime exception.
- **Windows: code-signing certificate** (OV/EV). Provide `CSC_LINK` + `CSC_KEY_PASSWORD`
  secrets; removes SmartScreen and improves the install trust prompt.

Neither is required to ship. `CSC_IDENTITY_AUTO_DISCOVERY: "false"` in CI keeps builds
unsigned regardless of any local keychain identity.

---

## 9. Reference: artifact names

From `electron-builder.yml` (`${version}` = `package.json` version):

| Platform | Target | Filename |
|---|---|---|
| Windows | NSIS installer | `nodechess-Setup-${version}.exe` |
| Windows | Portable | `nodechess-Portable-${version}.exe` |
| Windows | Zip | `nodechess-${version}-win-x64.zip` |
| macOS | DMG | `nodechess-${version}-${arch}.dmg` (`arm64` / `x64`) |
| macOS | Zip | `nodechess-${version}-mac-${arch}.zip` |
| both | Update feed | `latest.yml` (win), `latest-mac.yml` (mac), `*.blockmap` |

The Windows installer name is pinned rather than left to electron-builder's default because
`updateLogic.pickWinAsset` matches it by prefix. Releases published before the rename used a
`Chess-` prefix; both matchers still accept it.

---

## 10. Owner credential checklist

- [x] GitHub repo exists, **public**, Actions enabled, under `isaacmiller123/chess-sharp`.
- [ ] **Rename it to `isaacmiller123/nodechess` and repoint `origin`** (§2). `release.mjs check`
      fails until then, because `electron-builder.yml` and `updateLogic.ts` already say `nodechess`.
- [x] `origin` remote set; repo pushed; tags through `v1.3.0`.
- [x] `datasets-v1` release exists with the engine + puzzle assets.
- [ ] **Per release:** bump `package.json`, push `vX.Y.Z`, confirm both CI legs green + the
      Release page shows the installers.
- [ ] *(optional)* Apple Developer ID for mac signing/notarization ($99/yr). Enables mac
      in-place updates and removes the Gatekeeper prompt.
- [ ] *(optional)* Windows code-signing certificate: removes SmartScreen.
- [ ] *(follow-up, datasets lane)* publish a `darwin-x64` Stockfish artifact so Intel Macs
      get the analysis engine.

_Cross-refs: `.github/workflows/build.yml` (CI), `electron-builder.yml` (targets),
`src/main/updates/updateLogic.ts` (update + asset picking),
`src/main/datasets/datasets.service.ts` (runtime datasets), `scripts/release.mjs` (helper),
`WEB-DEPLOY.md` (web target)._
