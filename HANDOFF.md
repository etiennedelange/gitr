# Handoff: in-app updater and Microsoft Store package for Gitr

> **Status, 2026-10-11:** PR 1 (in-app updater) is done and merged as #4. **PR 2 (Microsoft Store / MSIX) is shelved**: Gitr ships only through GitHub Releases for now, and the one-time SmartScreen click is accepted. Resume PR 2 only when the user asks; the plan below still applies. The app side already exists (`update::packaged()` and the "store" update channel in `src-tauri/src/update.rs`).

Written 2026-10-11 for the next session in the `etiennedelange/gitr` repo. Read `CLAUDE.md` first: branch and PR rules, screenshots, bug ledger, third-party notices.

## Where things stand

- `etiennedelange/gitr` is **private**. It has one commit (`ef25631` "Initial commit"), made from the old repo's latest `main` with the quiet-workbench restyle included.
- The rename is done everywhere: product "Gitr", identifier `dev.gitr.app`, crates `gitr-core` / `gitr-remote` / `gitr-ai`, binary `gitr.exe`, settings in `%APPDATA%\gitr`, env vars `GITR_*`.
- Before the push, `cargo clippy` was clean, and `pnpm test` (Rust tests, 269 UI tests, notices check), the UI check and build all passed. The app was also run headless with `/verify`.
- Releases are built by `.github/workflows/release.yml`: a `vX.Y.Z` tag on `main` builds the NSIS installer with `pnpm tauri build --bundles nsis` and publishes a GitHub Release. The installer is **unsigned**, so SmartScreen warns on first run.

## Goal

Friends should be able to install Gitr without SmartScreen getting in the way, without paying for a certificate yet. The plan has **two channels from one binary**:

|             | Direct download (GitHub Releases)                          | Microsoft Store                      |
| ----------- | ---------------------------------------------------------- | ------------------------------------ |
| Package     | NSIS `-setup.exe`, unsigned                                | MSIX, which Microsoft signs          |
| Updates     | Tauri updater; update packages signed with Tauri's own key | the Store; the in-app updater is off |
| SmartScreen | once, on first install                                     | never                                |

## Decisions already made, and why

- **Store via MSIX, not the `.exe`.** Microsoft requires an `.exe`/`.msi` submitted to the Store, and every executable inside it, to be signed with a trusted-CA certificate (https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements). An MSIX gets free Microsoft signing and hosting. Tauri doesn't build MSIX, so we package it ourselves with `makeappx`.
- **Signing certificate: not now.** These options were looked at and parked:
  - Azure Artifact Signing (about $10 a month; identity checks are limited to some countries).
  - SignPath Foundation (free for open source). It needs a public repo, a release history and a code-signing policy page first.
  - An OV certificate (roughly $100–400 a year).
  - Signing doesn't remove SmartScreen anyway until the certificate builds reputation. For reference, T3 Code (`pingdotgg/t3code`) signs with Azure Trusted Signing and only signs when its secrets are set.
- **The repo goes public**, so the updater can read `https://github.com/etiennedelange/gitr/releases/latest/download/latest.json`. **Until it is public, the updater can't work for anyone,** because release assets of a private repo need authentication. Add a `LICENSE` file (MIT, matching `Cargo.toml`) before going public, and scan the tree for secrets first.

## Work, as two PRs (each on its own branch, squash-merged)

### PR 1: `feature/in-app-updater` ("Update Gitr from inside the app")

**Rust (`src-tauri`)**

- Add `tauri-plugin-updater = "2"` and register it in `src-tauri/src/lib.rs` next to the opener and dialog plugins.
- New module `src-tauri/src/update.rs`:
  - `packaged() -> bool` checks whether we run inside an MSIX package, using `GetCurrentPackageFullName` from the `windows` crate (feature `Win32_Storage_Packaging_Appx`). Pin the crate to the version Tauri already uses, as `windows-core` is pinned in `src-tauri/Cargo.toml`. It returns `false` off Windows.
  - Command `check_update` returns `{ channel: "direct" | "store", available: Option<{ version, notes, date }> }`. Command `install_update` installs. When packaged, both return straight away with `channel: "store"` and touch no network.
  - `install_update` first waits until running git writes finish. Reuse the `writes_running(&ops)` logic from the close-request guard in `lib.rs` by moving it somewhere both can call it. Then `download_and_install`: NSIS runs in passive mode and the app restarts.
  - On startup, check once after a few seconds. A failed check is only logged with `tracing`, never shown as a toast.
- `tauri.conf.json`:
  - `bundle.createUpdaterArtifacts: true`
  - `bundle.publisher: "Etienne de Lange"`. The Store rejects a publisher name equal to the product name.
  - `plugins.updater.pubkey` and the `latest.json` endpoint above
  - `plugins.updater.windows.installMode: "passive"`

**UI (`ui/src`)**

- `api.ts`: `checkUpdate` and `installUpdate`, with their types in `types.ts`.
- `components/UpdateBanner.tsx`, modelled on `GitBanner.tsx`:
  - Text: "Gitr 0.3.0 is available."
  - Buttons: **What's new** (opens the release page), **Restart and update** (primary), and dismiss for this session.
  - It shows "Updating…" while downloading and reports errors through `notifyError`.
- `Settings.tsx`: a new **Updates** section with its own nav entry. It shows the current version and a **Check for updates** button with the result. When packaged, it says "Updates come from the Microsoft Store."
- Preview mock (`ui/src/preview/preview.ts`): answer `check_update` and `install_update`, add a scenario parameter that shows an available update, and document it in `ui/src/preview/README.md`.
- Tests:
  - The banner shows and hides correctly, the Store channel hides it, install calls the API, and dismiss works.
  - The new Settings section.

**Release pipeline**

- `release.yml`:
  - Pass the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets to the build.
  - Collect `*-setup.exe.sig`.
  - Generate `latest.json` with a new subcommand, `node tools/release/release.mjs updater-manifest <version> <exe> <sig>`. It writes version, notes (from the existing `changelogSection`), `pub_date` and `platforms["windows-x86_64"] = { url, signature }`.
  - Upload `latest.json` with the installer. Pre-releases are skipped automatically, because `releases/latest` ignores them.
- `release-cache.yml`: build with `--config '{"bundle":{"createUpdaterArtifacts":false}}'`. That workflow has no secrets, and the build would fail without the private key.
- **Key (the user does this):**
  - Run `pnpm tauri signer generate -w ~/.tauri/gitr-updater.key`.
  - Store the private key and its password as repo secrets with `gh secret set`.
  - **Back up the key:** without it, existing installs can never be updated again.
  - The public key goes into `tauri.conf.json`.

**Docs and housekeeping**

- `docs/releasing.md`: the updater, key handling and `latest.json`. Replace the "isn't code-signed" note with the two-channel table.
- A `CHANGELOG.md` entry under Unreleased → Added, and an "Install" section in the README.
- `pnpm notices`, because new dependencies are added.
- A new screenshot scene, `update` (the dashboard with the banner), in `tools/screenshots/capture.mjs`. Run `pnpm screenshots` and look at the images.

### PR 2: `feature/store-msix` ("Microsoft Store package")

**Packaging**

- `tools/release/msix.mjs`, with no dependencies, like `release.mjs`:
  - Stage `target/release/gitr.exe`, `THIRD_PARTY_NOTICES.txt` and the existing icons `src-tauri/icons/Square44x44Logo.png`, `Square150x150Logo.png` and `StoreLogo.png`. Add a `Wide310x150Logo.png` if Partner Center asks for one.
  - Write `AppxManifest.xml`, then run `makeappx pack`. On the runner, `makeappx` is under `Windows Kits\10\bin\<latest>\x64`.
  - Manifest contents:
    - `Identity Name` and `Publisher`, copied from Partner Center into `src-tauri/msix.json` (they aren't secret).
    - Version `X.Y.Z.0`, and `TargetDeviceFamily Windows.Desktop MinVersion 10.0.17763.0`.
    - `Executable="gitr.exe" EntryPoint="Windows.FullTrustApplication"`, and the capability `rescap:runFullTrust`.
  - Unit-test the version mapping and the manifest with `node --test`.
- `release.yml`: for non-pre-release tags, build the `.msix` after the NSIS installer and upload it as a **workflow artifact only**. It's unsigned until the Store signs it, so it doesn't belong on the GitHub Release. Run the same step in `release-cache.yml`, so packaging breaks before a tag rather than during a release.
- Submit by hand in Partner Center for now. The `msstore` CLI can automate this later.

**App behaviour under MSIX**

- **`%APPDATA%` writes are redirected:**
  - Packaged desktop apps get their `%APPDATA%` writes moved to `%LOCALAPPDATA%\Packages\<package family name>\LocalCache\Roaming\gitr`. The app itself reads them back without noticing.
  - **Settings → Open logs folder** starts Explorer, which runs outside the package and sees the real `%APPDATA%\gitr`. That folder would be empty.
  - Fix in `config.rs` and `commands.rs::open_logs_folder`: when `update::packaged()`, open the redirected path instead. Get the package family name from `GetCurrentPackageFamilyName`.
  - This is a bug fix, so it needs a bug-ledger row and a test of the path builder.
- Store and direct installs keep separate settings; say so in the docs.
- WebView2: an MSIX package can't run the WebView2 bootstrapper. Windows 11 and supported Windows 10 versions ship the Evergreen runtime; list it as a requirement.

**Docs**

- `docs/releasing.md`, Partner Center steps:
  - Create the account and reserve the name.
  - Copy the identity values into `msix.json`.
  - Upload the `.msix` from the run's artifacts.
- Local testing: in Developer Mode, `Add-AppxPackage -Register AppxManifest.xml` installs it without signing.
- A CHANGELOG entry.

## Needed from the user (outside the repo)

1. A Partner Center developer account (individual). **Reserve the name "Gitr" first.** I found no existing Store listing or Git client with that name, but only the reservation confirms it. If it's taken, use a display name like "Gitr – Git client".
2. The updater signing key and its repo secrets (see PR 1).
3. Making the repo public: after `LICENSE` is added and a secret scan is done, run `gh repo edit --visibility public`. Then rerun `tools/release/github-settings.sh`; its rulesets only work on public repos or with GitHub Pro.

## Loose ends from the move

- Not done yet:
  - Run `tools/release/github-settings.sh` on the new repo.
  - Move the old settings folder with `Move-Item $env:APPDATA\gitter $env:APPDATA\gitr`.
  - Archive the old repo.
- The personal-context MCP still describes the project as "Gitter", for example in `patterns/third-party-notices.md`. Suggest updates; don't make them yourself.
- `cargo fmt --check` reports differences in a few Rust files. They came over from the old repo, and CI doesn't check them. If you fix them, do it in a separate formatting-only PR.
- Confirm the first CI and Release-cache runs on the new repo went green.

## Verifying the whole thing

- `pnpm test`, `cargo clippy --workspace --all-targets`, `pnpm --filter ui exec vp check`, and `/verify` for the Settings section and the banner through the mock.
- The real update path can only be tested on Windows after the repo is public:
  - Release `v0.1.1` and install it, then release `v0.1.2`.
  - Check the banner appears, and that **Restart and update** ends on 0.1.2.
  - A pre-release isn't enough, because `latest` skips pre-releases.
- MSIX:
  - Download the run's artifact, enable Developer Mode, run `Add-AppxPackage -Register`, and launch the app.
  - Settings should say "Updates come from the Microsoft Store", and **Open logs folder** should show the logs.
