# Bug ledger

One row per bug fix, newest first. Kept in the same commit as the fix (see `CLAUDE.md`). The ledger answers "what broke, why, and how do we know it stays fixed?" in one line each. Longer investigations go in `docs/history.md`; user-visible wording goes in `CHANGELOG.md`.

Columns: **Date** · **Commit** (short hash; `pending` until committed, then fill in) · **Symptom** (what the user or a test saw) · **Root cause** · **Fix** · **Regression test** (test name or e2e script; `none` with a reason if untestable).

| Date | Commit | Symptom | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
| 2026-10-11 | pending | The v0.1.0 Release run failed at `pnpm notices:check` on windows-latest with `spawnSync pnpm ENOENT`; no release was published. | `tools/notices/generate.mjs` started `pnpm` with `execFileSync`, which can't run the `pnpm.cmd` shim on Windows. CI ran the check only on Linux (and only in `pnpm test`), so it had never run on Windows before a tag. | Run pnpm through `npm_execpath` (the pnpm binary that started the script), falling back to `pnpm` on PATH; `release-cache.yml` now runs `pnpm notices:check` on windows-latest on every relevant change to `main`. | none: needs Windows; the new `notices:check` step in `release-cache.yml` runs it there before every tag. |
