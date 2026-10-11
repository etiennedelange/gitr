# Plan: Gitr on macOS

Written 2026-10-11 for a later session in `etiennedelange/gitr`. Read `CLAUDE.md` first: branch and PR rules, screenshots, bug ledger, third-party notices. Nothing here is started; Windows stays the main platform.

## Where things stand

- Gitr is Tauri 2 (Rust + React), so it can run on macOS, but only Windows is built and released. `release.yml` builds the NSIS installer on `windows-latest`. `latest.json` has only a `windows-x86_64` entry.
- CI's `rust (macos-latest)` job runs `cargo test --workspace` on macOS. That proves the Rust code compiles and its tests pass there. It never builds the UI or a `.app`, and never starts the app.
- Code that already handles non-Windows: stopping git kills its process group (`killpg` in `crates/gitr-core/src/runner.rs`), the Recycle Bin is the `trash` crate (cross-platform), the WebView2 hardening in `src-tauri/src/native.rs` is skipped off Windows, the file watcher (`notify`) uses FSEvents, and `update::packaged()` returns false.
- `src-tauri/icons/icon.icns` already exists, but `bundle.icon` in `tauri.conf.json` doesn't list it.
- The Microsoft Store work is shelved (see `HANDOFF.md` in the repo root); this plan doesn't depend on it.

## Goal

Install Gitr on a Mac from GitHub Releases and keep it updated with the same in-app updater, without paying Apple yet. Personal use first: one person who accepts the Gatekeeper step once.

|             | Windows (today)                             | macOS (this plan)                                              |
| ----------- | ------------------------------------------- | -------------------------------------------------------------- |
| Package     | NSIS `-setup.exe`, unsigned                 | `.dmg` with `Gitr.app`, ad-hoc signed, not notarized           |
| Updates     | in-app updater, `windows-x86_64`            | in-app updater, `darwin-aarch64` (and `darwin-x86_64`, see below) |
| First run   | SmartScreen: More info → Run anyway         | Gatekeeper: System Settings → Privacy & Security → Open Anyway |

## Decisions to make first

1. **Which Macs.** Apple Silicon only (`aarch64-apple-darwin`, simplest), or a universal build (`--target universal-apple-darwin`) that also covers Intel Macs. A universal build doubles the Rust compile on the runner. Recommendation: Apple Silicon only, unless an Intel Mac is in use.
2. **Signing.** No Apple Developer account ($99 a year) for now: ad-hoc sign (`bundle.macOS.signingIdentity: "-"`), which Apple Silicon needs for the app to run at all. Without notarization, the first launch is blocked until you allow it in System Settings. On macOS 15 and later, Control-click → Open no longer bypasses this. Notarization can come later through Tauri's `APPLE_*` environment variables, without code changes.
3. **Recycle Bin method.** On macOS, the `trash` crate deletes through Finder by default, which asks once for permission to control Finder (an Automation prompt) and makes the trash sound. It also has an `NSFileManager` method with no prompt, but then Finder's "Put Back" doesn't work. Pick one; recommendation: Finder, for Put Back.

## Work, as PRs (each on its own branch, squash-merged)

### PR 1: `feature/macos-app` ("Run Gitr on macOS")

Make the app correct on macOS. Use `pnpm tauri dev` on a Mac to try it.

**Bundle identifier first**
- `tauri build` warns: `The bundle identifier "dev.gitr.app" … ends with .app. This is not recommended because it conflicts with the application bundle extension on macOS.` Change `identifier` in `tauri.conf.json` before the first Mac build, for example to `dev.gitr.desktop`. After that, never change it again.
- On Windows it names the WebView2 data folder (`%LOCALAPPDATA%\<identifier>`), which holds the browser-storage preferences: theme (`theme.ts`) and diff mode. Those reset once, unless the app copies them over from the old folder on first start. Gitr's real settings in `%APPDATA%\gitr` don't depend on it.
- Verify on Windows that an in-app update across the change replaces the existing install rather than installing a second copy beside it (the NSIS installer's registry keys may derive from it). Ship the change in a release on its own, not together with other installer changes.

**Settings and logs folder (the one real bug)**
- `config_dir()` in `src-tauri/src/config.rs` reads `%APPDATA%` and falls back to the **temp folder** when it's missing. On macOS that means settings and workspace groups are lost after a restart.
- Fix: Windows keeps `%APPDATA%\gitr`. macOS uses `~/Library/Application Support/gitr` (from `HOME`), and Linux uses `$XDG_CONFIG_HOME/gitr` or `~/.config/gitr`. It runs before Tauri starts (`logs::init` is the first line of `run()`), so this can't use Tauri's path API. A small function of the environment, unit-tested per platform the way `locate.rs` tests take an `env` closure.
- Logs: `~/Library/Logs/gitr` is the Mac convention. Either is fine; keep `logs_dir()` next to `config_dir()`.
- This counts as a bug fix (it affects Linux too): bug-ledger row plus the test.
- Doc comments and messages that say `%APPDATA%` (`config.rs`, `logs.rs`, `commands.rs::open_logs_folder`, Settings' "Open logs folder" hint, the README) should name the right folder per platform.

**Open terminal / Open in VS Code** (`commands.rs`, `open_with`)
- Today: `wt.exe`, then `powershell.exe`; and `code.cmd`.
- macOS: `open -a Terminal .` (or the user's default terminal app if that's easy), and `code` if it's on PATH, else `open -a "Visual Studio Code" .`. Keep the existing rule that programs are never looked up in the repo folder.
- Linux can stay unsupported, with a clear error.
- "Open in Explorer" works through the opener plugin already; only the label changes (see UI).

**Finding git, Copilot CLI and hooks' tools** (`crates/gitr-core/src/locate.rs`, `crates/gitr-ai/src/copilot.rs`)
- Apps started from Finder or the Dock get a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`). Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) is missing, so git falls back to Apple's `/usr/bin/git`. That only works with the Xcode command-line tools installed, and otherwise pops up Apple's install dialog. The Copilot CLI isn't found, and git hooks that call `node`, `npx` and so on fail.
- Fix in two parts:
  1. `locate.rs` candidates on macOS: Settings path, PATH, `/opt/homebrew/bin/git`, `/usr/local/bin/git`, then `/usr/bin/git`. Same test style as the Windows search-order test.
  2. At startup on macOS, read the login shell's PATH once (`$SHELL -l -c 'printf %s "$PATH"'`, with a short timeout) and set it for the process, so git, hooks and Copilot all see the user's tools. This is what most Mac Git GUIs do. Log the result; on failure, keep the default PATH.
- The git banner's install hint is `winget install Git.Git`; on macOS say `brew install git` or `xcode-select --install`.

**Sign-in**
- Batches set `GCM_INTERACTIVE=never` and `GIT_TERMINAL_PROMPT=0`, as on Windows. On a Mac, git usually stores HTTPS credentials with `osxkeychain`, which never shows a window. A missing or expired credential then fails, and the interactive Sign in has nothing to show unless Git Credential Manager is installed (`brew install --cask git-credential-manager`).
- Check this on a real Mac with GitHub and Azure DevOps remotes. At minimum, the sign-in message should say what to install. SSH remotes need no change.

**Keyboard shortcuts** (`App.tsx`, `RepoView.tsx`, `Dashboard.tsx`, `CommitBox.tsx`, `useWheelZoom.ts`, `lib/nativeGuards.ts`)
- They check `ctrlKey`. On a Mac they should use Cmd (`metaKey`): Cmd+P, Cmd+, (Settings, which macOS users expect), Cmd+Enter to commit, and so on.
- Add one helper (`isMod(e)`: `metaKey` on macOS, `ctrlKey` elsewhere) and use it everywhere. The shortcuts table in Settings and the README show ⌘ on a Mac.
- Ctrl+Tab for tabs is fine on a Mac. Zoom is Cmd+scroll or pinch.

**Wording**
- "Follow Windows" (theme) becomes "Follow the system" on every platform.
- "Open in Explorer" becomes "Show in Finder" on macOS.
- "Recycle Bin" becomes "Trash" on macOS, in the discard confirmation, the button tooltip and the errors in `Changes.tsx`.
- `lib/addFolder.ts` compares paths like Windows (`\`, case-insensitive). macOS paths use `/`, and APFS is usually case-insensitive too. Check that `norm` still works for `/Users/me/Repos` (it should, since it only replaces separators).
- The UI needs to know the platform: add it to `app_version`, or use `@tauri-apps/plugin-os` (a new dependency, so `pnpm notices`).

**Native feel (nice to have)**
- A minimal macOS app menu (Gitr → About, Settings…, Quit; Edit → Copy/Paste/Select All). Without an Edit menu, Cmd+C and Cmd+V don't work in text fields in a Tauri app on macOS. **Check this early; it may be a must.**
- WKWebView's own context menu and shortcuts: check whether right-click shows "Reload" or "Inspect Element", and turn them off the way `native.rs` does for WebView2.

**Tests and mock**
- Unit tests for the config path per platform, the macOS git search order, the PATH merge, and `open_with` command choice (as a pure function).
- UI tests for the shortcut helper and platform wording.
- The preview mock: add `platform=mac` to show the Mac wording and ⌘ in screenshots. Maybe a `dashboard-mac` scene, though the drawn title bar in `capture.mjs` is Windows-style.

### PR 2: `feature/macos-release` ("Release Gitr for macOS")

**Build** (`release.yml`)
- A second job, `macos`, on `macos-latest` (Apple Silicon runners). The same checks first: tag on main, version match, updater key, notices.
- `pnpm tauri build --bundles app,dmg` with the updater secrets: it makes `Gitr.app.tar.gz` and `.sig` for the updater, and `Gitr_<version>_aarch64.dmg` for people.
- `tauri.conf.json`: add `icons/icon.icns` to `bundle.icon`, and set `bundle.macOS.signingIdentity: "-"` and `minimumSystemVersion` (for example `"12.0"`). `bundle.targets` stays `["nsis"]` for Windows; the macOS job passes `--bundles`.
- `notices`: the notices file is generated for `x86_64-pc-windows-msvc` only (`TARGET` in `tools/notices/generate.mjs`). The Mac app ships different crates, so generate per target, or for the union of both targets, and put the file in the `.app` too.

**One release, both platforms**
- Today the Windows job creates the GitHub Release. With two jobs, split it: both build jobs upload artifacts, and a final `publish` job (needs both) writes `latest.json` and creates the release.
- `release.mjs updater-manifest` takes several `platform=exe,sig` pairs and writes one `latest.json` with `windows-x86_64` and `darwin-aarch64` (and `darwin-x86_64` if universal). Extend `release.test.mjs`.
- `SHA256SUMS.txt` covers the `.dmg` too.
- `release-cache.yml`: a macOS job too, so the Mac build breaks on `main` rather than on a tag (with `src-tauri/tauri.no-updater.conf.json`, no secrets).
- macOS runners cost nothing on a public repo, but they're slower; expect the release to take longer.

**Docs**
- README Install: the `.dmg`, dragging to Applications, and the one-time **System Settings → Privacy & Security → Open Anyway** step. Mention `xattr -dr com.apple.quarantine /Applications/Gitr.app` as the Terminal alternative.
- `docs/releasing.md`: the macOS job, the manifest with two platforms, and why it isn't notarized.
- CHANGELOG: "Gitr for macOS".

## Needed from the user

1. Decisions 1–3 above.
2. A Mac to try PR 1 on (`pnpm tauri dev`), and later to install the first release. CI can't open the app.
3. Later, optionally: an Apple Developer account for notarization, which removes the Gatekeeper step.

## Open questions to check on a real Mac

- Does the in-app updater trigger Gatekeeper again after an update? Files the app downloads itself usually don't get the quarantine flag, so it shouldn't, but confirm on the first update.
- Does an ad-hoc signed app keep its Automation (Finder) and Files and Folders permissions across updates? macOS ties permissions to the signature, and ad-hoc signatures change with every build, so it may ask again after each update. If that's annoying, it's an argument for a real certificate.
- Cmd+C and Cmd+V in the commit message box without an Edit menu (see Native feel).

## Verifying the whole thing

- `pnpm test`, `cargo clippy --workspace --all-targets`, `pnpm --filter ui exec vp check`, and `/verify` (Linux) for anything shared.
- On a Mac:
  - `pnpm tauri dev`: add a folder, quit, start again, and the groups are still there.
  - Fetch, pull, commit with a hook that uses `node`, generate a commit message with Copilot.
  - Discard a file and find it in the Trash (Put Back works).
  - Open terminal, VS Code and Finder; Cmd shortcuts; Cmd+C/V in the commit box.
- Release: tag a version, install the `.dmg`, allow it once in System Settings, then release the next patch version and update from the banner without another Gatekeeper prompt.
