# Branches and releases

`main` is the only long-lived branch and always releasable. Work happens on short branches, lands through a pull request with **Squash and merge**, and a version tag on `main` builds the Windows installer and publishes a GitHub Release.

## Day to day

1. Branch from `main`: `feature/<topic>` or `fix/<topic>` (`design/…`, `chore/…` are fine too).
2. Commit as often as you like; the branch's commits are squashed away.
3. Open a PR. CI (`.github/workflows/ci.yml`) runs the UI checks and the Rust tests on Windows, Linux and macOS. A PR that only changes Markdown files (or is a release PR) skips them: `release.mjs skip-ci` decides, and the jobs still report success so the PR can merge. Go through the template's self-review checklist and look at the diff on GitHub.
4. **Squash and merge.** The PR title becomes the commit subject on `main` and the line in the release notes, so write it as one: "Add folder from the main window", not "wip". Label it `feature`, `bug` or `skip-changelog` to sort it in the notes (`.github/release.yml`).

The head branch is deleted after merging. Run `git fetch --prune` and delete your local copy with `git branch -D <branch>`. Use `-D` because a squash merge doesn't look merged to git.

## Cutting a release

The version lives in one place: `version` under `[workspace.package]` in `Cargo.toml`. `tauri.conf.json` has no version, so Tauri reads it from there.

```sh
pnpm release 1.2.0
```

It checks first: no uncommitted changes to tracked files, `gh` signed in, `v1.2.0` not tagged yet and not older than the newest tag, and entries under the CHANGELOG's `[Unreleased]`. After you confirm, it does what you'd otherwise do by hand:

1. On a `release/1.2.0` branch from `origin/main`, `pnpm release:version 1.2.0` sets the version, updates `Cargo.lock`, and turns the `[Unreleased]` entries into a dated `## [1.2.0]` section. It commits that as "Release 1.2.0" (signed, if your git signs commits) and pushes it.
2. It opens the PR "Release 1.2.0" with the `skip-changelog` label and turns on squash auto-merge, so the PR merges itself once CI is green. CI recognises a version-only change (only the version in `Cargo.toml` and the workspace crates in `Cargo.lock`, plus the CHANGELOG) and skips its build and test steps, which already passed when the code merged; the required checks still report success. Any other change on the release branch gets the full run.
3. It waits for the merge (checking every 10 seconds), tags the merge commit `v1.2.0`, pushes the tag, and switches you back to an up-to-date `main`.
4. It follows the Release workflow below and prints the release page.

Ctrl+C is safe at any point. Run the same command again and it carries on from where it stopped (branch pushed, PR open, PR merged, tag pushed). `--yes` skips the question. If CI fails, fix it on the release branch and run it again.

`.github/workflows/release.yml` then:

- checks that the tag is on `main` and matches the version in `Cargo.toml`;
- builds `Gitr_1.2.0_x64-setup.exe` with `pnpm tauri build --bundles nsis` on `windows-latest`, and its updater signature `Gitr_1.2.0_x64-setup.exe.sig`;
- writes `latest.json` for the in-app updater (see below);
- publishes a GitHub Release with the installer, its `.sig`, `latest.json` and `SHA256SUMS.txt`. The notes are the CHANGELOG's `[1.2.0]` section followed by GitHub's generated list of merged PRs since the previous tag.

A version with a pre-release part (`v1.2.0-beta.1`) is published as a pre-release. Installed copies never see it: the updater asks for the *latest* release, and GitHub's latest skips pre-releases. To try the updater, release two normal patch versions.

If a run fails after the tag is pushed, fix the cause and rerun it (**Actions → Release → Run workflow** with the tag). If the fix needs code, make a new patch version instead. The release-tag ruleset stops tags from being moved.

## Distribution channels

One binary, two ways to get it:

|             | Direct download (GitHub Releases)                            | Microsoft Store                         |
| ----------- | ------------------------------------------------------------ | --------------------------------------- |
| Package     | NSIS `-setup.exe`, not code-signed                           | MSIX, signed by Microsoft               |
| Updates     | the in-app updater; update packages signed with our own key  | the Store; the in-app updater is off    |
| SmartScreen | warns once, on first install ("More info → Run anyway")      | never                                   |

**The Microsoft Store channel isn't built yet.** It was shelved on 2026-10-11, so GitHub Releases is the only way to get Gitr for now. The app already detects an MSIX package (below), so the Store build needs only the packaging.

Gitr knows which one it is by asking Windows whether it runs inside an MSIX package (`update::packaged()` in `src-tauri/src/update.rs`). Inside one, Settings → Updates says "Updates come from the Microsoft Store", there is no update banner, and the update commands touch no network.

A code-signing certificate is parked for now: Azure Artifact Signing (about $10 a month, identity checks only in some countries), SignPath Foundation (free for open source, but needs a public repo, a release history and a signing-policy page) and an OV certificate ($100–400 a year) were looked at. A new certificate doesn't stop SmartScreen anyway until it has built up reputation.

## In-app updater

`tauri-plugin-updater` reads `https://github.com/etiennedelange/gitr/releases/latest/download/latest.json` (`plugins.updater` in `tauri.conf.json`). The UI checks 5 seconds after startup and from **Settings → Updates**. A failed startup check is only logged. **Restart and update** downloads the installer, checks its signature against `plugins.updater.pubkey`, waits up to two minutes for running git writes (as closing the window does), and runs the NSIS installer in passive mode (a progress bar, no questions). The installer closes Gitr and starts the new version.

Release assets of a private repository need authentication, so the updater only works once the repository is public.

`latest.json` is written by `node tools/release/release.mjs updater-manifest <version> <setup.exe> <setup.exe.sig>`:

```json
{
  "version": "1.2.0",
  "notes": "the CHANGELOG's [1.2.0] section",
  "pub_date": "2026-10-11T09:00:00.000Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/etiennedelange/gitr/releases/download/v1.2.0/Gitr_1.2.0_x64-setup.exe",
      "signature": "the content of Gitr_1.2.0_x64-setup.exe.sig"
    }
  }
}
```

### The updater signing key

`bundle.createUpdaterArtifacts` makes `tauri build` sign the installer with a minisign key, and every installed copy checks updates against the public half in `tauri.conf.json`. This is not code signing: it doesn't change what SmartScreen says, but it stops anyone who could swap a release asset from pushing their own installer to every user.

Once, on your own machine:

```sh
pnpm tauri signer generate -w ~/.tauri/gitr-updater.key   # asks for a password
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/gitr-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD             # paste the password
```

Put the public key (`~/.tauri/gitr-updater.key.pub`, one line) into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` and merge that before the first release that has the updater.

**Back up the private key and its password** somewhere outside this machine, such as a password manager. Without them no installed copy can ever be updated again: their users would have to download a new installer by hand. Changing the key works the same way: the copies that trust the old key don't accept updates signed with the new one.

The release job fails early when the secret is missing. `release-cache.yml` has no secrets, so it builds with `createUpdaterArtifacts` turned off. A local `pnpm tauri build` needs the key in `TAURI_SIGNING_PRIVATE_KEY`, or the same `--config src-tauri/tauri.no-updater.conf.json`.

## Build speed and caching

- **CI:** `Swatinem/rust-cache` keeps compiled dependencies per OS, and `setup-node` keeps the pnpm store. Only `main` saves caches. PRs restore `main`'s, so they can't push it out of the 10 GB cache limit.
- **Releases:** a cache saved under a tag can't be read by later tags, so the release job only restores. `.github/workflows/release-cache.yml` saves on `main`: it runs the same release build when `Cargo.lock`, a `Cargo.toml`, `pnpm-lock.yaml` or `tauri.conf.json` changes, and twice a week so the cache isn't evicted after 7 days unused. It caches the release-profile dependencies and Tauri's NSIS download (`%LOCALAPPDATA%\tauri`). It also catches a broken installer build before you tag (built without the updater signature, as it has no secrets). A release then compiles only Gitr's own crates.
- The release profile (`lto = "fat"`, `codegen-units = 1`) makes a small binary at the cost of a slower final link; that link happens on every release whatever the cache.

## Repository settings

`tools/release/github-settings.sh` applies these. Run it once after `gh auth login`, and again after changing it:

- squash merge only, with the PR title and body as the commit message; merge commits and rebase merging off;
- head branches deleted after merging; auto-merge and "Update branch" allowed;
- ruleset **main**: changes only through a PR, squash only, linear history, no force-push or deletion, open review threads must be resolved, and CI's `ui` and `rust (…)` jobs must pass. A solo PR needs no approving review;
- ruleset **release tags**: `v*` tags can be created but not moved or deleted.

Rulesets on a private repository need GitHub Pro; on Free the script applies the merge settings and skips the rulesets (and GitHub leaves auto-merge off). Without them nothing stops a direct push to `main` or a moved tag, so the release job's checks (tag on `main`, version match) are the safety net. The required checks are CI's job names, so rename them there and in the script together.
