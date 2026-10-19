//! In-progress merge / rebase / cherry-pick / revert / bisect / `git am`: detection, guards,
//! abort, continue, skip, MERGE_MSG.
mod common;

use std::path::Path;

use common::*;
use gitr_core::info::{Operation, read_info};
use gitr_core::repo::IntegrateOutcome;

/// main and `side` both change a.txt (committed as "one\n") differently.
fn conflicting_branches() -> (tempfile::TempDir, std::path::PathBuf) {
    let (t, dir) = repo_with_commit();
    git(&dir, &["switch", "-q", "-c", "side"]);
    write(&dir, "a.txt", "side\n");
    git(&dir, &["commit", "-q", "-am", "side change"]);
    git(&dir, &["switch", "-q", "main"]);
    write(&dir, "a.txt", "main\n");
    git(&dir, &["commit", "-q", "-am", "main change"]);
    (t, dir)
}

/// Runs git expecting it to stop on a conflict (exit code != 0).
fn git_stops(dir: &Path, args: &[&str]) {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir).args(args);
    for op in isolated_env() {
        match op {
            gitr_core::runner::EnvOp::Set(k, v) => cmd.env(k, v),
            gitr_core::runner::EnvOp::Remove(k) => cmd.env_remove(k),
        };
    }
    let out = cmd.output().unwrap();
    assert!(!out.status.success(), "git {args:?} should stop on a conflict");
}

async fn assert_guarded(dir: &Path, state: &str) {
    let g = isolated_git();
    let refused = |r: Result<(), gitr_core::GitError>, what: &str| {
        let e = r.expect_err(&format!("{what} must be refused during a {state}"));
        assert!(e.to_string().contains(&format!("A {state} is in progress")), "{what}: {e}");
    };
    refused(g.fast_forward(dir).await.map(|_| ()), "pull");
    refused(g.checkout(dir, "main", false).await, "checkout");
    refused(g.create_branch(dir, "new-branch", None, true).await, "create-and-checkout");
    refused(g.undo_last_commit(dir).await.map(|_| ()), "undo");
    // Creating a branch without switching to it is harmless and still allowed.
    g.create_branch(dir, "kept", None, false).await.unwrap();
}

#[tokio::test]
async fn merge_detected_guarded_aborted_with_message() {
    let (_t, dir) = conflicting_branches();
    git_stops(&dir, &["merge", "side"]);
    assert_eq!(read_info(&dir).operation, Some(Operation::Merging));
    assert_guarded(&dir, "merge").await;

    let g = isolated_git();
    let msg = g.merge_message(&dir).await.unwrap().expect("MERGE_MSG");
    assert!(msg.starts_with("Merge branch 'side'"), "{msg}");
    assert!(!msg.lines().any(|l| l.starts_with('#')), "comments stripped: {msg}");

    g.abort_operation(&dir).await.unwrap();
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(read(&dir, "a.txt"), "main\n");
    assert_eq!(g.merge_message(&dir).await.unwrap(), None);
}

#[tokio::test]
async fn rebase_detected_and_aborted() {
    let (_t, dir) = conflicting_branches();
    git_stops(&dir, &["rebase", "side"]);
    assert_eq!(read_info(&dir).operation, Some(Operation::Rebasing));
    assert_guarded(&dir, "rebase").await;
    isolated_git().abort_operation(&dir).await.unwrap();
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(git_out(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
}

#[tokio::test]
async fn cherry_pick_detected_and_aborted() {
    let (_t, dir) = conflicting_branches();
    git_stops(&dir, &["cherry-pick", "side"]);
    assert_eq!(read_info(&dir).operation, Some(Operation::CherryPicking));
    assert_guarded(&dir, "cherry-pick").await;
    isolated_git().abort_operation(&dir).await.unwrap();
    assert_eq!(read_info(&dir).operation, None);
}

#[tokio::test]
async fn revert_detected_and_aborted() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "a.txt", "two\n");
    git(&dir, &["commit", "-q", "-am", "two"]);
    write(&dir, "a.txt", "three\n");
    git(&dir, &["commit", "-q", "-am", "three"]);
    git_stops(&dir, &["revert", "--no-edit", "HEAD~1"]);
    assert_eq!(read_info(&dir).operation, Some(Operation::Reverting));
    assert_guarded(&dir, "revert").await;
    isolated_git().abort_operation(&dir).await.unwrap();
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(read(&dir, "a.txt"), "three\n");
}

#[tokio::test]
async fn nothing_to_abort() {
    let (_t, dir) = repo_with_commit();
    assert_eq!(read_info(&dir).operation, None);
    assert!(isolated_git().abort_operation(&dir).await.is_err());
}

fn head_subject(dir: &Path) -> String {
    git_out(dir, &["log", "-1", "--format=%s"]).trim().to_string()
}

/// A bisect is shown, guards pull and checkout, has no Continue or Skip, and Abort
/// ends it (`git bisect reset`) back on the branch it started from.
#[tokio::test]
async fn bisect_detected_guarded_and_ended() {
    let (_t, dir) = repo_with_commit();
    for n in ["two", "three", "four"] {
        write(&dir, "a.txt", &format!("{n}\n"));
        git(&dir, &["commit", "-q", "-am", n]);
    }
    git(&dir, &["bisect", "start", "HEAD", "HEAD~3"]);
    assert_eq!(read_info(&dir).operation, Some(Operation::Bisecting));
    assert_guarded(&dir, "bisect").await;

    let g = isolated_git();
    let e = g.continue_operation(&dir).await.expect_err("a bisect has no Continue");
    assert!(e.to_string().contains("good or bad"), "{e}");
    let e = g.skip_operation(&dir).await.expect_err("`bisect skip` is not this Skip");
    assert!(e.to_string().contains("no commit to skip"), "{e}");

    g.abort_operation(&dir).await.unwrap();
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(git_out(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert_eq!(head_subject(&dir), "four");
}

/// `git am` with a patch that doesn't apply on main.
fn stopped_am() -> (tempfile::TempDir, std::path::PathBuf) {
    let (t, dir) = conflicting_branches();
    let patch = git_out(&dir, &["format-patch", "-1", "side", "--stdout"]);
    std::fs::write(dir.join("../side.patch"), patch).unwrap();
    git_stops(&dir, &["am", "../side.patch"]);
    (t, dir)
}

/// `git am` is shown, guarded and aborted.
#[tokio::test]
async fn am_detected_guarded_and_aborted() {
    let (_t, dir) = stopped_am();
    assert_eq!(read_info(&dir).operation, Some(Operation::ApplyingPatches));
    assert_guarded(&dir, "patch series").await;
    isolated_git().abort_operation(&dir).await.unwrap();
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(head_subject(&dir), "main change");
}

/// Skip drops the patch `git am` stopped on.
#[tokio::test]
async fn am_patch_skipped() {
    let (_t, dir) = stopped_am();
    assert_eq!(isolated_git().skip_operation(&dir).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(head_subject(&dir), "main change");
}

/// Resolves a.txt with `content` and stages it.
fn resolve(dir: &Path, content: &str) {
    write(dir, "a.txt", content);
    git(dir, &["add", "a.txt"]);
}

/// Continue finishes a cherry-pick once its conflict is resolved and staged.
#[tokio::test]
async fn cherry_pick_continued() {
    let (_t, dir) = conflicting_branches();
    git_stops(&dir, &["cherry-pick", "side"]);
    resolve(&dir, "both\n");
    assert_eq!(isolated_git().continue_operation(&dir).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(head_subject(&dir), "side change");
    assert_eq!(read(&dir, "a.txt"), "both\n");
}

/// Continue finishes a revert once its conflict is resolved and staged.
#[tokio::test]
async fn revert_continued() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "a.txt", "two\n");
    git(&dir, &["commit", "-q", "-am", "two"]);
    write(&dir, "a.txt", "three\n");
    git(&dir, &["commit", "-q", "-am", "three"]);
    git_stops(&dir, &["revert", "--no-edit", "HEAD~1"]);
    resolve(&dir, "one\nthree\n");
    assert_eq!(isolated_git().continue_operation(&dir).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(head_subject(&dir), "Revert \"two\"");
}

/// Skip during a rebase drops the commit it stopped on, stops again on the next
/// conflicting one, and finishes after that.
#[tokio::test]
async fn rebase_skips_commit_by_commit() {
    let (_t, dir) = conflicting_branches();
    write(&dir, "a.txt", "main 2\n");
    git(&dir, &["commit", "-q", "-am", "main change 2"]);
    git_stops(&dir, &["rebase", "side"]);
    let g = isolated_git();
    assert_eq!(g.skip_operation(&dir).await.unwrap(), IntegrateOutcome::Conflicts { files: 1 });
    assert_eq!(read_info(&dir).operation, Some(Operation::Rebasing));
    assert_eq!(g.skip_operation(&dir).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(git_out(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
    assert_eq!(git_out(&dir, &["rev-parse", "HEAD"]), git_out(&dir, &["rev-parse", "side"]));
    assert_eq!(read(&dir, "a.txt"), "side\n");
}

/// Skip ends a single cherry-pick without picking anything.
#[tokio::test]
async fn cherry_pick_skipped() {
    let (_t, dir) = conflicting_branches();
    git_stops(&dir, &["cherry-pick", "side"]);
    write(&dir, "a.txt", "half-resolved\n");
    assert_eq!(isolated_git().skip_operation(&dir).await.unwrap(), IntegrateOutcome::Done);
    assert_eq!(read_info(&dir).operation, None);
    assert_eq!(head_subject(&dir), "main change");
    assert_eq!(read(&dir, "a.txt"), "main\n");
}

/// A merge has nothing to skip; Skip leaves it as it is.
#[tokio::test]
async fn merge_cannot_be_skipped() {
    let (_t, dir) = conflicting_branches();
    git_stops(&dir, &["merge", "side"]);
    let e = isolated_git().skip_operation(&dir).await.expect_err("nothing to skip in a merge");
    assert!(e.to_string().contains("A merge has no commit to skip"), "{e}");
    assert_eq!(read_info(&dir).operation, Some(Operation::Merging));
}
