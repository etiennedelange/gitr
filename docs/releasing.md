# Branches and releases

`main` is the only long-lived branch and always releasable. Work happens on short branches, lands through a pull request with **Squash and merge**, and a version tag on `main` builds the Windows installer and publishes a GitHub Release.

## Day to day

1. Branch from `main`: `feature/<topic>` or `fix/<topic>` (`design/…`, `chore/…` are fine too).
2. Commit as often as you like; the branch's commits are squashed away.
3. Open a PR. CI (`.github/workflows/ci.yml`) runs the UI checks and the Rust tests on Windows, Linux and macOS. Go through the template's self-review checklist and look at the diff on GitHub.
4. **Squash and merge.** The PR title becomes the commit subject on `main` and the line in the release notes, so write it as one: "Add folder from the main window", not "wip". Label it `feature`, `bug` or `skip-changelog` to sort it in the notes (`.github/release.yml`).

The head branch is deleted after merging. Run `git fetch --prune` and delete your local copy with `git branch -D <branch>`. Use `-D` because a squash merge doesn't look merged to git.

## Cutting a release

The version lives in one place: `version` under `[workspace.package]` in `Cargo.toml`. `tauri.conf.json` has no version, so Tauri reads it from there.

1. On a branch, `pnpm release:version 1.2.0`. It sets the version, updates `Cargo.lock`, and turns the CHANGELOG's `[Unreleased]` entries into a dated `## [1.2.0]` section.
2. PR it ("Release 1.2.0") and squash-merge it.
3. Tag the merged commit and push the tag:

   ```sh
   git switch main && git pull
   git tag v1.2.0
   git push origin v1.2.0
   ```

`.github/workflows/release.yml` then:

- checks that the tag is on `main` and matches the version in `Cargo.toml`;
- checks that `THIRD_PARTY_NOTICES.txt` is current;
- builds `Gitr_1.2.0_x64-setup.exe` with `pnpm tauri build --bundles nsis` on `windows-latest`;
- publishes a GitHub Release with the installer and `SHA256SUMS.txt`. The notes are the CHANGELOG's `[1.2.0]` section followed by GitHub's generated list of merged PRs since the previous tag.

A version with a pre-release part (`v1.2.0-beta.1`) is published as a pre-release.

If a run fails after the tag is pushed, fix the cause and rerun it (**Actions → Release → Run workflow** with the tag). If the fix needs code, make a new patch version instead. The release-tag ruleset stops tags from being moved.

The installer isn't code-signed yet, so Windows SmartScreen warns on first run ("More info → Run anyway").

## Build speed and caching

- **CI:** `Swatinem/rust-cache` keeps compiled dependencies per OS, and `setup-node` keeps the pnpm store. Only `main` saves caches. PRs restore `main`'s, so they can't push it out of the 10 GB cache limit.
- **Releases:** a cache saved under a tag can't be read by later tags, so the release job only restores. `.github/workflows/release-cache.yml` saves on `main`: it runs the same release build when `Cargo.lock`, a `Cargo.toml`, `pnpm-lock.yaml` or `tauri.conf.json` changes, and twice a week so the cache isn't evicted after 7 days unused. It caches the release-profile dependencies and Tauri's NSIS download (`%LOCALAPPDATA%\tauri`). It also catches a broken installer build before you tag. A release then compiles only Gitr's own crates.
- The release profile (`lto = "fat"`, `codegen-units = 1`) makes a small binary at the cost of a slower final link; that link happens on every release whatever the cache.

## Repository settings

`tools/release/github-settings.sh` applies these. Run it once after `gh auth login`, and again after changing it:

- squash merge only, with the PR title and body as the commit message; merge commits and rebase merging off;
- head branches deleted after merging; auto-merge and "Update branch" allowed;
- ruleset **main**: changes only through a PR, squash only, linear history, no force-push or deletion, open review threads must be resolved, and CI's `ui` and `rust (…)` jobs must pass. A solo PR needs no approving review;
- ruleset **release tags**: `v*` tags can be created but not moved or deleted.

Rulesets on a private repository need GitHub Pro; on Free the script applies the merge settings and skips the rulesets (and GitHub leaves auto-merge off). Without them nothing stops a direct push to `main` or a moved tag, so the release job's checks (tag on `main`, version match) are the safety net. The required checks are CI's job names, so rename them there and in the script together.
