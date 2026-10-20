//! Probes for bugs users of other Git clients reported (see the issue review of
//! 2026-10-03): non-UTF-8 paths, worktrees and file/symlink type changes. Each test asserts what
//! a user would expect; a failure is a confirmed exposure.
#![cfg(unix)]
mod common;

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::symlink;

use common::*;

#[tokio::test]
async fn utf8_path_with_accent_can_be_staged() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "café.txt", "x\n");
    let g = isolated_git();
    let st = g.status(&dir).await.unwrap();
    assert!(st.files.iter().any(|f| f.path == "café.txt"), "{:?}", st.files);
    g.stage(&dir, &["café.txt".into()]).await.unwrap();
    assert_eq!(staged_names(&dir), ["café.txt"]);
}

// macOS (APFS) refuses to create a file whose name is not valid UTF-8; only Linux lets us.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn latin1_file_name_can_be_staged() {
    let (_t, dir) = repo_with_commit();
    let name = OsStr::from_bytes(b"caf\xe9.txt");
    std::fs::write(dir.join(name), "x\n").unwrap();
    let g = isolated_git();
    let st = g.status(&dir).await.unwrap();
    let entry = st.files.iter().find(|f| f.path.starts_with("caf")).expect("listed");
    eprintln!("status path: {:?}", entry.path);
    let staged = g.stage(&dir, std::slice::from_ref(&entry.path)).await;
    eprintln!("stage result: {staged:?}");
    assert!(staged.is_ok(), "the app hands git back the path it was shown");
    assert_eq!(staged_names(&dir).len(), 1, "the file is staged");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn latin1_file_name_can_be_diffed_and_discarded() {
    let (_t, dir) = repo_with_commit();
    let name = OsStr::from_bytes(b"caf\xe9.txt");
    std::fs::write(dir.join(name), "one\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "latin1 name"]);
    std::fs::write(dir.join(name), "two\n").unwrap();
    let g = isolated_git();
    let st = g.status(&dir).await.unwrap();
    let entry = st.files.iter().find(|f| f.path.starts_with("caf")).expect("listed");
    let diff = g.diff_file(&dir, &entry.path, false, false, false).await;
    eprintln!("diff: {:?}", diff.as_ref().map(|d| d.hunks.len()));
    assert!(diff.is_ok_and(|d| !d.hunks.is_empty()), "diff of the modified file");
}

#[tokio::test]
async fn latin1_file_content_diff_loads() {
    let (_t, dir) = repo_with_commit();
    std::fs::write(dir.join("l.txt"), b"caf\xe9 one\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "latin1 content"]);
    std::fs::write(dir.join("l.txt"), b"caf\xe9 two\n").unwrap();
    let d = isolated_git().diff_file(&dir, "l.txt", false, false, false).await.unwrap();
    let text: String = d.hunks.iter().flat_map(|h| h.lines.iter().map(|l| l.text.clone())).collect::<Vec<_>>().join("|");
    // Shown as U+FFFD (decoding other encodings is not done yet); nothing may fail.
    assert_eq!(text, "caf\u{fffd} one|caf\u{fffd} two");
}

#[tokio::test]
async fn branch_checked_out_in_another_worktree() {
    let (t, dir) = repo_with_commit();
    git(&dir, &["branch", "feature"]);
    let wt = t.path().join("wt");
    git(&dir, &["worktree", "add", "-q", wt.to_str().unwrap(), "feature"]);
    let g = isolated_git();
    let list = g.branches(&dir).await.unwrap();
    let feature = list.iter().find(|b| b.name == "feature").unwrap();
    eprintln!("branch entry: {feature:?}");
    let del = g.delete_branch(&dir, "feature", true).await.unwrap_err();
    eprintln!("delete error: {del}");
    let co = g.checkout(&dir, "feature", false).await.unwrap_err();
    eprintln!("checkout error: {co}");
    // The worktree is also a repo of its own: status and branches work there.
    let st = g.status(&wt).await.unwrap();
    assert_eq!(st.branch.as_deref(), Some("feature"));
    for e in [del.to_string(), co.to_string()] {
        assert!(e.contains("worktree"), "git names the worktree: {e}");
    }
}

#[tokio::test]
async fn file_replaced_by_symlink_shows_a_diff_and_stages() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "link.txt", "plain\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "file"]);
    std::fs::remove_file(dir.join("link.txt")).unwrap();
    symlink("a.txt", dir.join("link.txt")).unwrap();
    let g = isolated_git();
    let st = g.status(&dir).await.unwrap();
    let e = st.files.iter().find(|f| f.path == "link.txt").expect("listed");
    eprintln!("status entry: {e:?}");
    let d = g.diff_file(&dir, "link.txt", false, false, false).await.unwrap();
    eprintln!("hunks: {}", d.hunks.len());
    assert!(!d.hunks.is_empty(), "unstaged type change has a diff");
    g.stage(&dir, &["link.txt".into()]).await.unwrap();
    let d = g.diff_file(&dir, "link.txt", true, false, false).await.unwrap();
    assert!(!d.hunks.is_empty(), "staged type change has a diff");
    git(&dir, &["commit", "-q", "-m", "now a symlink"]);
    let sha = git_out(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    let details = g.commit_details(&dir, &sha).await.unwrap();
    let f = details.files.iter().find(|f| f.path == "link.txt").unwrap();
    eprintln!("commit file: {f:?}");
    let cd = g.commit_file_diff(&dir, &sha, "link.txt", None, false).await.unwrap();
    assert!(!cd.hunks.is_empty(), "commit diff of a type change");
}

#[tokio::test]
async fn discarding_a_symlink_type_change_restores_the_file() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "link.txt", "plain\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "file"]);
    std::fs::remove_file(dir.join("link.txt")).unwrap();
    symlink("a.txt", dir.join("link.txt")).unwrap();
    let g = isolated_git();
    let out = g.discard(&dir, &["link.txt".into()], &[], test_bin(&dir)).await.unwrap();
    eprintln!("outcome: {out:?}");
    assert_eq!(read(&dir, "link.txt"), "plain\n");
    assert!(!std::fs::symlink_metadata(dir.join("link.txt")).unwrap().file_type().is_symlink());
}
