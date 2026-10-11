//! Integrating a diverged branch: rebase or merge, autostash, conflicts, Continue, Abort.
mod common;

use std::path::{Path, PathBuf};

use common::*;
use gitr_core::info::{Operation, read_info};
use gitr_core::repo::{IntegrateOutcome, Strategy};

/// `a` and the remote have diverged: the remote got `theirs.txt` (via `b`), `a` committed
/// `mine.txt`; `a` has fetched. Returns (tempdir, a, b).
fn diverged() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    let a = tmp.path().join("a");
    std::fs::create_dir_all(&a).unwrap();
    init(&a);
    write(&a, "shared.txt", "line 1\nline 2\nline 3\n");
    git(&a, &["add", "."]);
    git(&a, &["commit", "-q", "-m", "base"]);
    git(&a, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&a, &["push", "-q", "-u", "origin", "main"]);
    let b = tmp.path().join("b");
    git(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), b.to_str().unwrap()]);
    write(&b, "theirs.txt", "theirs\n");
    git(&b, &["add", "."]);
    git(&b, &["commit", "-q", "-m", "their commit"]);
    git(&b, &["push", "-q", "origin", "main"]);
    write(&a, "mine.txt", "mine\n");
    git(&a, &["add", "."]);
    git(&a, &["commit", "-q", "-m", "my commit"]);
    git(&a, &["fetch", "-q"]);
    (tmp, a, b)
}

fn ahead_behind(dir: &Path) -> (u32, u32) {
    let out = git_out(dir, &["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    let mut it = out.split_whitespace().map(|n| n.parse().unwrap());
    (it.next().unwrap(), it.next().unwrap())
}

fn parents(dir: &Path, rev: &str) -> usize {
    git_out(dir, &["rev-list", "--parents", "-n", "1", rev]).split_whitespace().count() - 1
}

/// Fact 1 (and 2: unset → the default).
#[tokio::test]
async fn strategy_follows_pull_rebase() {
    let (_t, a, _b) = diverged();
    let g = isolated_git();
    assert_eq!(g.pull_strategy(&a, Strategy::Rebase).await.unwrap(), Strategy::Rebase);
    assert_eq!(g.pull_strategy(&a, Strategy::Merge).await.unwrap(), Strategy::Merge);
    for (value, expected) in [("true", Strategy::Rebase), ("merges", Strategy::Rebase), ("interactive", Strategy::Rebase), ("false", Strategy::Merge)] {
        git(&a, &["config", "pull.rebase", value]);
        assert_eq!(g.pull_strategy(&a, Strategy::Merge).await.unwrap(), expected, "pull.rebase={value}");
        assert_eq!(g.pull_strategy(&a, Strategy::Rebase).await.unwrap(), expected, "pull.rebase={value}");
    }
}

/// Fact 3: linear history, ahead only, no merge commit, local commit replayed.
#[tokio::test]
async fn rebase_replays_local_commits_on_top() {
    let (_t, a, _b) = diverged();
    let before = git_out(&a, &["rev-parse", "HEAD"]);
    assert_eq!(ahead_behind(&a), (1, 1));
    let out = isolated_git().integrate(&a, Strategy::Rebase).await.unwrap();
    assert_eq!(out, IntegrateOutcome::Done);
    assert_eq!(ahead_behind(&a), (1, 0));
    assert_eq!(parents(&a, "HEAD"), 1, "no merge commit");
    assert_ne!(git_out(&a, &["rev-parse", "HEAD"]), before, "local commit rewritten");
    assert_eq!(git_out(&a, &["log", "-1", "--format=%s"]).trim(), "my commit");
    assert!(a.join("theirs.txt").exists() && a.join("mine.txt").exists());
    assert_eq!(read_info(&a).operation, None);
}

/// Fact 4: one merge commit with the upstream as second parent; local commit untouched.
#[tokio::test]
async fn merge_creates_a_merge_commit() {
    let (_t, a, _b) = diverged();
    let mine = git_out(&a, &["rev-parse", "HEAD"]);
    let theirs = git_out(&a, &["rev-parse", "@{u}"]);
    let out = isolated_git().integrate(&a, Strategy::Merge).await.unwrap();
    assert_eq!(out, IntegrateOutcome::Done);
    assert_eq!(parents(&a, "HEAD"), 2);
    assert_eq!(git_out(&a, &["rev-parse", "HEAD^1"]), mine, "local commit not rewritten");
    assert_eq!(git_out(&a, &["rev-parse", "HEAD^2"]), theirs);
    assert_eq!(ahead_behind(&a), (2, 0));
}

/// Fact 5: uncommitted changes survive both strategies.
#[tokio::test]
async fn uncommitted_changes_are_kept() {
    for strategy in [Strategy::Rebase, Strategy::Merge] {
        let (_t, a, _b) = diverged();
        write(&a, "shared.txt", "line 1\nline 2 edited, not committed\nline 3\n");
        write(&a, "notes.txt", "untracked notes\n");
        let out = isolated_git().integrate(&a, strategy).await.unwrap();
        assert_eq!(out, IntegrateOutcome::Done, "{strategy:?}");
        assert_eq!(read(&a, "shared.txt"), "line 1\nline 2 edited, not committed\nline 3\n", "{strategy:?}");
        assert_eq!(read(&a, "notes.txt"), "untracked notes\n", "{strategy:?}");
        assert!(git_out(&a, &["stash", "list"]).trim().is_empty(), "autostash applied and dropped ({strategy:?})");
    }
}

/// Makes `a` and the remote change the same line of shared.txt in `n` local commits.
fn conflicting(n: usize) -> (tempfile::TempDir, PathBuf) {
    let (t, a, b) = diverged();
    write(&b, "shared.txt", "line 1\nline 2 THEIRS\nline 3\n");
    git(&b, &["commit", "-q", "-am", "their edit"]);
    git(&b, &["push", "-q"]);
    for i in 0..n {
        write(&a, "shared.txt", &format!("line 1\nline 2 MINE {i}\nline 3\n"));
        git(&a, &["commit", "-q", "-am", &format!("my edit {i}")]);
    }
    git(&a, &["fetch", "-q"]);
    (t, a)
}

/// Facts 11, 12: stops on conflicts; Continue refused while conflicted, then finishes.
#[tokio::test]
async fn conflict_then_continue() {
    let (_t, a) = conflicting(1);
    let g = isolated_git();
    let out = g.integrate(&a, Strategy::Rebase).await.unwrap();
    assert_eq!(out, IntegrateOutcome::Conflicts { files: 1 });
    assert_eq!(read_info(&a).operation, Some(Operation::Rebasing));

    let refused = g.continue_operation(&a).await.unwrap_err();
    assert!(refused.to_string().contains("Resolve and stage the conflicted files first"), "{refused}");

    write(&a, "shared.txt", "line 1\nline 2 RESOLVED\nline 3\n");
    git(&a, &["add", "shared.txt"]);
    assert_eq!(g.continue_operation(&a).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(read_info(&a).operation, None);
    assert_eq!(ahead_behind(&a).1, 0);
    assert_eq!(read(&a, "shared.txt"), "line 1\nline 2 RESOLVED\nline 3\n");
}

/// Fact 12 for merge: Continue concludes the merge with git's message, no editor.
#[tokio::test]
async fn merge_conflict_then_continue() {
    let (_t, a) = conflicting(1);
    let g = isolated_git();
    assert_eq!(g.integrate(&a, Strategy::Merge).await.unwrap(), IntegrateOutcome::Conflicts { files: 1 });
    assert_eq!(read_info(&a).operation, Some(Operation::Merging));
    write(&a, "shared.txt", "line 1\nline 2 RESOLVED\nline 3\n");
    git(&a, &["add", "shared.txt"]);
    assert_eq!(g.continue_operation(&a).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(parents(&a, "HEAD"), 2);
    assert!(git_out(&a, &["log", "-1", "--format=%s"]).starts_with("Merge "));
}

/// Fact 13: a two-commit rebase stops twice.
#[tokio::test]
async fn rebase_stops_again_on_next_commit() {
    let (_t, a) = conflicting(2);
    let g = isolated_git();
    assert_eq!(g.integrate(&a, Strategy::Rebase).await.unwrap(), IntegrateOutcome::Conflicts { files: 1 });
    write(&a, "shared.txt", "line 1\nline 2 RESOLVED 0\nline 3\n");
    git(&a, &["add", "shared.txt"]);
    assert_eq!(g.continue_operation(&a).await.unwrap(), IntegrateOutcome::Conflicts { files: 1 });
    assert_eq!(read_info(&a).operation, Some(Operation::Rebasing));
    write(&a, "shared.txt", "line 1\nline 2 RESOLVED 1\nline 3\n");
    git(&a, &["add", "shared.txt"]);
    assert_eq!(g.continue_operation(&a).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(read_info(&a).operation, None);
}

/// Fact 14: Abort restores the branch and the stashed uncommitted changes.
#[tokio::test]
async fn abort_restores_branch_and_uncommitted_changes() {
    for strategy in [Strategy::Rebase, Strategy::Merge] {
        let (_t, a) = conflicting(1);
        write(&a, "notes.txt", "uncommitted\n");
        git(&a, &["add", "notes.txt"]);
        let head = git_out(&a, &["rev-parse", "HEAD"]);
        let g = isolated_git();
        assert_eq!(g.integrate(&a, strategy).await.unwrap(), IntegrateOutcome::Conflicts { files: 1 }, "{strategy:?}");
        assert!(!a.join("notes.txt").exists() || read(&a, "notes.txt") == "uncommitted\n");
        g.abort_operation(&a).await.unwrap();
        assert_eq!(read_info(&a).operation, None, "{strategy:?}");
        assert_eq!(git_out(&a, &["rev-parse", "HEAD"]), head, "{strategy:?}");
        assert_eq!(read(&a, "shared.txt"), "line 1\nline 2 MINE 0\nline 3\n", "{strategy:?}");
        assert_eq!(read(&a, "notes.txt"), "uncommitted\n", "uncommitted change restored ({strategy:?})");
        assert!(git_out(&a, &["stash", "list"]).trim().is_empty(), "{strategy:?}");
    }
}

/// Integrating is refused while another operation is in progress; Continue needs one.
#[tokio::test]
async fn guards() {
    let (_t, a) = conflicting(1);
    let g = isolated_git();
    assert!(g.continue_operation(&a).await.is_err(), "nothing to continue");
    g.integrate(&a, Strategy::Rebase).await.unwrap();
    assert!(g.integrate(&a, Strategy::Merge).await.is_err(), "already rebasing");
}

/// Re-applying the stashed changes can conflict even though git reports success: that must not
/// look like a clean result, and the changes must stay safe in the stash list.
#[tokio::test]
async fn stash_that_conflicts_when_restored_is_reported_and_kept() {
    for strategy in [Strategy::Rebase, Strategy::Merge] {
        let (_t, a, b) = diverged();
        write(&b, "shared.txt", "line 1\nline 2 THEIRS\nline 3\n");
        git(&b, &["commit", "-q", "-am", "their edit"]);
        git(&b, &["push", "-q"]);
        git(&a, &["fetch", "-q"]);
        write(&a, "shared.txt", "line 1\nline 2 DIRTY\nline 3\n");
        let out = isolated_git().integrate(&a, strategy).await.unwrap();
        assert_eq!(out, IntegrateOutcome::StashConflict { files: 1 }, "{strategy:?}");
        assert_eq!(read_info(&a).operation, None, "the branch itself is done ({strategy:?})");
        assert_eq!(ahead_behind(&a).1, 0, "{strategy:?}");
        let stash = git_out(&a, &["stash", "list"]);
        assert!(stash.contains("autostash"), "changes kept in the stash list ({strategy:?}): {stash}");
        let stashed = git_out(&a, &["stash", "show", "-p", "stash@{0}"]);
        assert!(stashed.contains("+line 2 DIRTY"), "{strategy:?}: {stashed}");
    }
}

/// Option A: the system-level pull.rebase (Git for Windows' installer writes `false` there) is
/// ignored; the global config counts; the repo's own config wins over global.
#[tokio::test]
async fn strategy_ignores_system_config_but_honours_global_and_local() {
    let (t, a, _b) = diverged();
    let system = t.path().join("system.gitconfig");
    let global = t.path().join("global.gitconfig");
    std::fs::write(&system, "[pull]\n\trebase = false\n").unwrap();
    std::fs::write(&global, "").unwrap();
    let runner = isolated_runner()
        .without_env("GIT_CONFIG_NOSYSTEM")
        .with_env("GIT_CONFIG_SYSTEM", &system)
        .with_env("GIT_CONFIG_GLOBAL", &global);
    // Sanity: git itself sees the system value.
    let seen = runner.run(&a, gitr_core::runner::Kind::Read, &["config", "--get", "pull.rebase"]).await.unwrap();
    assert_eq!(seen.trim(), "false");
    let g = gitr_core::Git::new(runner);

    assert_eq!(g.pull_strategy(&a, Strategy::Rebase).await.unwrap(), Strategy::Rebase, "system value ignored");
    std::fs::write(&global, "[pull]\n\trebase = false\n").unwrap();
    assert_eq!(g.pull_strategy(&a, Strategy::Rebase).await.unwrap(), Strategy::Merge, "global honoured");
    git(&a, &["config", "pull.rebase", "true"]);
    assert_eq!(g.pull_strategy(&a, Strategy::Merge).await.unwrap(), Strategy::Rebase, "local wins over global");
}
