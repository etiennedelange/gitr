# Bug ledger

One row per bug fix, newest first. Kept in the same commit as the fix (see `CLAUDE.md`). The ledger answers "what broke, why, and how do we know it stays fixed?" in one line each. Longer investigations go in `docs/history.md`; user-visible wording goes in `CHANGELOG.md`.

Columns: **Date** · **Commit** (short hash; `pending` until committed, then fill in) · **Symptom** (what the user or a test saw) · **Root cause** · **Fix** · **Regression test** (test name or e2e script; `none` with a reason if untestable).

| Date | Commit | Symptom | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
