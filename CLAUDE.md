# Instructions for agents

## Branches and releases

Work on a short branch (`feature/…`, `fix/…`) and land it on `main` through a PR with Squash and merge; never push to `main` directly. The PR title becomes the commit on `main` and the release-notes line. The app version lives only in `Cargo.toml`'s `[workspace.package]`; change it with `pnpm release:version`, or release with `pnpm release <version>`, which does every step. See `docs/releasing.md`.

## Screenshots stay current (required)

After any visible UI change (layout, copy, colours, icons, new or removed views, changed preview mock data), run `pnpm screenshots` (or `pnpm screenshots <scene>` for one scene) and commit the updated `docs/screenshots/` in the same commit as the change. Look at the images before committing. A new view or state worth showing gets a new scene in `tools/screenshots/capture.mjs`.

## Bug-fix ledger (required)

Every bug fix is recorded in `docs/bug-ledger.md`, in the same commit as the fix. A fix without a ledger row is not finished.

- **What counts:** anything that corrects wrong behaviour, whether reported by the user, found by a test, e2e run, audit or sweep, or noticed while working on something else. Small fixes count. A fix folded into a larger commit still gets its own row.
- **When:** add the row before committing, with `pending` as the commit hash. After committing, replace `pending` with the short hash (a follow-up commit is fine).
- **Row contents:** date, commit, symptom (what was observed), root cause (why, not just where), fix, and the regression test that fails without the fix. If no test is possible, write `none` and the reason.
- **Order:** newest first. One row per distinct bug; one commit may have several rows.
- **Fixes you make for a bug you introduced** during the same task still get a row if the bug was ever committed or shown to the user.
- **Related records stay separate:** user-visible wording goes in `CHANGELOG.md` (Fixed), long investigations in `docs/history.md`. The ledger row is the index; link to those rather than copying them.
- **Before saying a fix is done**, check that the ledger row exists. If you find fixes in `git log` that are missing from the ledger, add them.


## Third-party notices (required)

After adding, removing or updating a Rust or npm dependency, run `pnpm notices` and commit `THIRD_PARTY_NOTICES.txt` in the same commit. `pnpm test` fails when it is stale. A new dependency's licence must be permissive (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode, OFL for fonts; MPL-2.0 only unmodified); ask before adding anything copyleft (GPL, LGPL, AGPL) or with no licence.
