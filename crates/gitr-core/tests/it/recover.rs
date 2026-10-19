//! Recoverable discard (files go to a bin first) and Undo last commit.

use std::path::Path;
use std::sync::Arc;

use crate::common::*;
use gitr_core::repo::DiscardFailure;

fn bin_for(dir: &Path) -> Arc<FakeBin> {
    FakeBin::new(dir.parent().unwrap().join("bin"))
}

/// A repo whose `a.txt` is committed as "one\n".
fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
    repo_with_commit()
}

/// Fact 1
#[tokio::test]
async fn untracked_goes_to_bin() {
    let (_t, dir) = repo();
    let bin = bin_for(&dir);
    write(&dir, "u.txt", "untracked work\n");
    let out = isolated_git().discard(&dir, &[], &["u.txt".into()], bin.clone()).await.unwrap();
    assert!(out.failed.is_empty());
    assert!(!dir.join("u.txt").exists());
    assert_eq!(bin.content_of(&dir.join("u.txt")).as_deref(), Some("untracked work\n"));
}

/// Fact 2
#[tokio::test]
async fn modified_tracked_binned_then_restored() {
    let (_t, dir) = repo();
    let bin = bin_for(&dir);
    write(&dir, "a.txt", "my edit\n");
    isolated_git().discard(&dir, &["a.txt".into()], &[], bin.clone()).await.unwrap();
    assert_eq!(read(&dir, "a.txt"), "one\n");
    assert_eq!(bin.content_of(&dir.join("a.txt")).as_deref(), Some("my edit\n"));
}

/// Fact 3
#[tokio::test]
async fn deleted_tracked_restored_without_bin() {
    let (_t, dir) = repo();
    let bin = bin_for(&dir);
    std::fs::remove_file(dir.join("a.txt")).unwrap();
    isolated_git().discard(&dir, &["a.txt".into()], &[], bin.clone()).await.unwrap();
    assert_eq!(read(&dir, "a.txt"), "one\n");
    assert_eq!(bin.count(), 0);
}

/// Fact 5: staged content is kept; only the working-copy change is discarded.
#[tokio::test]
async fn staged_content_kept() {
    let (_t, dir) = repo();
    let bin = bin_for(&dir);
    write(&dir, "a.txt", "staged A\n");
    git(&dir, &["add", "a.txt"]);
    write(&dir, "a.txt", "worktree B\n");
    isolated_git().discard(&dir, &["a.txt".into()], &[], bin.clone()).await.unwrap();
    assert_eq!(read(&dir, "a.txt"), "staged A\n");
    assert_eq!(staged_names(&dir), ["a.txt"]);
    assert_eq!(bin.content_of(&dir.join("a.txt")).as_deref(), Some("worktree B\n"));
}

/// Facts 6 and 8: files the bin refuses stay untouched; the others are discarded normally.
#[tokio::test]
async fn partial_failure_discards_moved_and_leaves_rest() {
    let (_t, dir) = repo();
    write(&dir, "b.txt", "b\n");
    git(&dir, &["add", "b.txt"]);
    git(&dir, &["commit", "-q", "-m", "b"]);
    write(&dir, "a.txt", "edit a\n");
    write(&dir, "b.txt", "edit b\n");
    write(&dir, "u.txt", "new u\n");
    write(&dir, "locked.txt", "new locked\n");
    let bin = FakeBin::failing(dir.parent().unwrap().join("bin"), &["b.txt", "locked.txt"]);

    let out = isolated_git()
        .discard(&dir, &["a.txt".into(), "b.txt".into()], &["u.txt".into(), "locked.txt".into()], bin.clone())
        .await
        .unwrap();

    // Moved ones are discarded…
    assert_eq!(read(&dir, "a.txt"), "one\n");
    assert!(!dir.join("u.txt").exists());
    // …refused ones are untouched and reported.
    assert_eq!(read(&dir, "b.txt"), "edit b\n");
    assert_eq!(read(&dir, "locked.txt"), "new locked\n");
    let mut failed = out.failed.clone();
    failed.sort_by(|x, y| x.path.cmp(&y.path));
    assert_eq!(
        failed,
        vec![
            DiscardFailure { path: "b.txt".into(), untracked: false, reason: "simulated: the file is in use (b.txt)".into() },
            DiscardFailure { path: "locked.txt".into(), untracked: true, reason: "simulated: the file is in use (locked.txt)".into() },
        ]
    );
}

/// Fact 8: when the bin takes nothing, nothing is deleted or overwritten.
#[tokio::test]
async fn failing_bin_never_overwrites() {
    let (_t, dir) = repo();
    write(&dir, "a.txt", "edit\n");
    write(&dir, "u.txt", "new\n");
    let bin = FakeBin::failing(dir.parent().unwrap().join("bin"), &["a.txt", "u.txt"]);
    let out = isolated_git().discard(&dir, &["a.txt".into()], &["u.txt".into()], bin).await.unwrap();
    assert_eq!(out.failed.len(), 2);
    assert_eq!(read(&dir, "a.txt"), "edit\n");
    assert_eq!(read(&dir, "u.txt"), "new\n");
}

/// Fact 7: after the user's explicit Yes, the refused files are discarded permanently.
#[tokio::test]
async fn permanent_discard_after_yes() {
    let (_t, dir) = repo();
    write(&dir, "a.txt", "edit\n");
    write(&dir, "u.txt", "new\n");
    isolated_git().discard_permanently(&dir, &["a.txt".into()], &["u.txt".into()]).await.unwrap();
    assert_eq!(read(&dir, "a.txt"), "one\n");
    assert!(!dir.join("u.txt").exists());
    // Same validation as before: ignored or tracked files are never deleted as "untracked".
    assert!(isolated_git().discard_permanently(&dir, &[], &["a.txt".into()]).await.is_err());
}

fn bare_remote_with(dir: &Path) -> std::path::PathBuf {
    let remote = dir.parent().unwrap().join("remote.git");
    git(dir.parent().unwrap(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    git(dir, &["remote", "add", "origin", remote.to_str().unwrap()]);
    remote
}

/// Facts 10 and 15: offered only for an unpushed, non-merge commit.
#[tokio::test]
async fn undo_offered_only_when_unpushed_and_not_merge() {
    let (_t, dir) = repo();
    let g = isolated_git();
    write(&dir, "a.txt", "two\n");
    git(&dir, &["commit", "-q", "-am", "second\n\nbody line"]);
    let last = g.last_commit_undo(&dir).await.unwrap().expect("unpushed commit is undoable");
    assert_eq!(last.subject, "second");

    // Pushed → not offered.
    bare_remote_with(&dir);
    git(&dir, &["push", "-q", "origin", "main"]);
    git(&dir, &["fetch", "-q", "origin"]);
    assert_eq!(g.last_commit_undo(&dir).await.unwrap(), None);

    // Merge commit → not offered (even though unpushed).
    git(&dir, &["switch", "-q", "-c", "side"]);
    write(&dir, "s.txt", "s\n");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "side"]);
    git(&dir, &["switch", "-q", "main"]);
    write(&dir, "m.txt", "m\n");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "main work"]);
    git(&dir, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    assert_eq!(g.last_commit_undo(&dir).await.unwrap(), None);
}

/// Facts 12 and 14: one commit back, changes staged, full message returned.
#[tokio::test]
async fn undo_moves_back_and_keeps_changes_staged() {
    let (_t, dir) = repo();
    let g = isolated_git();
    let before = git_out(&dir, &["rev-parse", "HEAD"]);
    write(&dir, "a.txt", "two\n");
    write(&dir, "new.txt", "new\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "Add things\n\nWith a body."]);

    let message = g.undo_last_commit(&dir).await.unwrap();
    assert_eq!(message, "Add things\n\nWith a body.");
    assert_eq!(git_out(&dir, &["rev-parse", "HEAD"]), before);
    assert_eq!(staged_names(&dir), ["a.txt", "new.txt"]);
    assert_eq!(read(&dir, "a.txt"), "two\n");
}

/// Fact 13: undoing the first commit leaves an unborn branch with everything staged.
#[tokio::test]
async fn undo_first_commit_leaves_unborn_branch_all_staged() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    init(&dir);
    write(&dir, "a.txt", "one\n");
    write(&dir, "b.txt", "two\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "initial"]);
    let g = isolated_git();
    assert_eq!(g.undo_last_commit(&dir).await.unwrap(), "initial");
    let st = g.status(&dir).await.unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert!(st.oid.is_none(), "branch must be unborn");
    let mut staged: Vec<String> = st.files.iter().filter(|f| f.is_staged()).map(|f| f.path.clone()).collect();
    staged.sort();
    assert_eq!(staged, ["a.txt", "b.txt"]);
    assert_eq!(g.last_commit_undo(&dir).await.unwrap(), None, "nothing left to undo");
}

/// Fact 15: the backend refuses directly, too.
#[tokio::test]
async fn undo_refuses_pushed_and_merge() {
    let (_t, dir) = repo();
    let g = isolated_git();
    bare_remote_with(&dir);
    git(&dir, &["push", "-q", "origin", "main"]);
    git(&dir, &["fetch", "-q", "origin"]);
    let head = git_out(&dir, &["rev-parse", "HEAD"]);
    assert!(g.undo_last_commit(&dir).await.is_err());
    assert_eq!(git_out(&dir, &["rev-parse", "HEAD"]), head, "pushed commit must stay");

    git(&dir, &["switch", "-q", "-c", "side"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "side"]);
    git(&dir, &["switch", "-q", "main"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "main"]);
    git(&dir, &["merge", "-q", "--no-ff", "-m", "merge", "side"]);
    let head = git_out(&dir, &["rev-parse", "HEAD"]);
    assert!(g.undo_last_commit(&dir).await.is_err());
    assert_eq!(git_out(&dir, &["rev-parse", "HEAD"]), head, "merge commit must stay");
}
