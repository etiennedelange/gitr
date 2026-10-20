mod common;

use std::path::{Path, PathBuf};

use common::*;
use gitr_core::log::{RefKind, RefLabel, ResetMode};
use gitr_core::repo::{HookOpts, IntegrateOutcome};
use gitr_core::info;

fn commit(dir: &Path, file: &str, content: &str, msg: &str) -> String {
    write(dir, file, content);
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
    head(dir)
}

fn head(dir: &Path) -> String {
    git_out(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

fn subjects(page: &gitr_core::log::LogPage) -> Vec<&str> {
    page.commits.iter().map(|c| c.subject.as_str()).collect()
}

/// A bare remote and a clone of it with `pushed` commits on origin/main, then `local` more.
fn clone_with(pushed: usize, local: usize) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    let dir = tmp.path().join("clone");
    git(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), dir.to_str().unwrap()]);
    for i in 0..pushed {
        commit(&dir, "a.txt", &format!("pushed {i}\n"), &format!("pushed {i}"));
    }
    if pushed > 0 {
        git(&dir, &["push", "-q", "-u", "origin", "main"]);
    }
    for i in 0..local {
        commit(&dir, "a.txt", &format!("local {i}\n"), &format!("local {i}"));
    }
    (tmp, dir)
}

#[tokio::test]
async fn log_lists_head_newest_first_with_paging() {
    let (_t, dir) = repo_with_commit();
    // 449 more commits through fast-import: one process instead of hundreds.
    let parent = head(&dir);
    let mut stream = String::new();
    for i in 1..450 {
        let msg = format!("commit {i}\n");
        stream.push_str(&format!("commit refs/heads/main\ncommitter T <t@x> {} +0000\ndata {}\n{msg}", 946684800 + i, msg.len()));
        if i == 1 {
            stream.push_str(&format!("from {parent}\n"));
        }
        stream.push('\n');
    }
    git_stdin(&dir, &["fast-import", "--quiet"], stream.as_bytes());
    let g = isolated_git();
    let p1 = g.log(&dir, 0, 200).await.unwrap();
    let p2 = g.log(&dir, 200, 200).await.unwrap();
    let p3 = g.log(&dir, 400, 200).await.unwrap();
    assert_eq!((p1.commits.len(), p2.commits.len(), p3.commits.len()), (200, 200, 50));
    assert_eq!((p1.has_more, p2.has_more, p3.has_more), (true, true, false));
    assert_eq!(p1.commits[0].subject, "commit 449");
    assert_eq!(p3.commits.last().unwrap().subject, "init");
    assert!(p3.commits.last().unwrap().parents.is_empty());
    let mut all: Vec<&str> = [&p1, &p2, &p3].iter().flat_map(|p| p.commits.iter().map(|c| c.sha.as_str())).collect();
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 450, "no commit listed twice");
}

#[tokio::test]
async fn log_parses_awkward_subjects() {
    let (_t, dir) = repo_with_commit();
    commit(&dir, "a.txt", "1\n", "Tabs\there and an emoji 🚀");
    commit(&dir, "a.txt", "2\n", "Unit\u{1f}separator, \"quotes\" and %H");
    write(&dir, "a.txt", "3\n");
    git(&dir, &["commit", "-q", "-a", "--allow-empty-message", "-m", ""]);
    let page = isolated_git().log(&dir, 0, 10).await.unwrap();
    assert_eq!(subjects(&page), ["", "Unit\u{1f}separator, \"quotes\" and %H", "Tabs\there and an emoji 🚀", "init"]);
    assert_eq!(page.commits[1].author_name, "Test Author");
    assert_eq!(page.commits[1].author_email, "author@example.com");
    assert_eq!(page.commits[1].author_time, 946684800);
}

#[tokio::test]
async fn log_labels_refs() {
    let (_t, dir) = clone_with(2, 1);
    git(&dir, &["branch", "feature/x", "HEAD~1"]);
    git(&dir, &["tag", "v1.0", "HEAD~2"]);
    let g = isolated_git();
    let page = g.log(&dir, 0, 10).await.unwrap();
    let refs: Vec<&Vec<RefLabel>> = page.commits.iter().map(|c| &c.refs).collect();
    assert_eq!(refs[0], &vec![RefLabel { kind: RefKind::Head, name: "main".into() }]);
    assert!(refs[1].contains(&RefLabel { kind: RefKind::Remote, name: "origin/main".into() }), "{:?}", refs[1]);
    assert!(refs[1].contains(&RefLabel { kind: RefKind::Local, name: "feature/x".into() }), "{:?}", refs[1]);
    assert!(refs[1].iter().all(|r| r.name != "origin/HEAD"));
    assert_eq!(refs[2], &vec![RefLabel { kind: RefKind::Tag, name: "v1.0".into() }]);

    git(&dir, &["checkout", "-q", "--detach", "HEAD~1"]);
    let page = g.log(&dir, 0, 10).await.unwrap();
    assert_eq!(page.commits[0].refs[0], RefLabel { kind: RefKind::Head, name: "HEAD".into() });
}

#[tokio::test]
async fn log_marks_unpushed() {
    let (_t, dir) = clone_with(2, 3);
    let page = isolated_git().log(&dir, 0, 10).await.unwrap();
    let marks: Vec<bool> = page.commits.iter().map(|c| c.unpushed).collect();
    assert_eq!(marks, [true, true, true, false, false]);
    // Paging keeps the marks right past the first page.
    let tail = isolated_git().log(&dir, 2, 2).await.unwrap();
    assert_eq!(tail.commits.iter().map(|c| c.unpushed).collect::<Vec<_>>(), [true, false]);

    let (_t2, alone) = repo_with_commit();
    commit(&alone, "a.txt", "2\n", "second");
    let page = isolated_git().log(&alone, 0, 10).await.unwrap();
    assert!(page.commits.iter().all(|c| !c.unpushed), "no remotes: nothing is marked");
}

#[tokio::test]
async fn log_on_unborn_branch_is_empty() {
    let tmp = tempfile::tempdir().unwrap();
    init(tmp.path());
    let page = isolated_git().log(tmp.path(), 0, 200).await.unwrap();
    assert!(page.commits.is_empty() && !page.has_more);
}

#[tokio::test]
async fn details_report_message_files_renames_and_binary() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "old name.txt", "line\n".repeat(20).as_str());
    commit(&dir, "b.txt", "b\n", "prep");
    git(&dir, &["mv", "old name.txt", "new name.txt"]);
    std::fs::write(dir.join("img.bin"), [0u8, 1, 2, 3, 0, 255]).unwrap();
    write(&dir, "a.txt", "one\ntwo\n");
    git(&dir, &["rm", "-q", "b.txt"]);
    let sha = commit(&dir, "c.txt", "c\n", "Subject line\n\nBody paragraph.\n\nRefs: #1");
    let d = isolated_git().commit_details(&dir, &sha).await.unwrap();
    assert_eq!(d.message, "Subject line\n\nBody paragraph.\n\nRefs: #1");
    assert_eq!(d.committer_name, "Test Committer");
    assert_eq!(d.parents.len(), 1);
    let by = |p: &str| d.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} in {:?}", d.files));
    assert_eq!((by("a.txt").status.as_str(), by("a.txt").added, by("a.txt").removed), ("M", 1, 0));
    assert_eq!(by("new name.txt").status, "R");
    assert_eq!(by("new name.txt").orig_path.as_deref(), Some("old name.txt"));
    assert_eq!(by("b.txt").status, "D");
    assert!(by("img.bin").binary);
    assert_eq!(by("c.txt").status, "A");
    assert!(!d.truncated);
}

#[tokio::test]
async fn details_of_merge_use_first_parent_and_root_uses_empty_tree() {
    let (_t, dir) = repo_with_commit();
    let root = head(&dir);
    git(&dir, &["checkout", "-q", "-b", "side"]);
    commit(&dir, "side.txt", "s\n", "side work");
    git(&dir, &["checkout", "-q", "main"]);
    commit(&dir, "main.txt", "m\n", "main work");
    git(&dir, &["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
    let merge = head(&dir);
    let g = isolated_git();
    let d = g.commit_details(&dir, &merge).await.unwrap();
    assert_eq!(d.parents.len(), 2);
    assert_eq!(d.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["side.txt"], "what the merge brought into main");

    let r = g.commit_details(&dir, &root).await.unwrap();
    assert!(r.parents.is_empty());
    assert_eq!((r.files.len(), r.files[0].path.as_str(), r.files[0].status.as_str()), (1, "a.txt", "A"));
}

#[tokio::test]
async fn commit_file_diff_matches_the_commit() {
    let (_t, dir) = repo_with_commit();
    let root = head(&dir);
    write(&dir, "gone.txt", "bye\n");
    write(&dir, "move me.txt", "keep\n".repeat(10).as_str());
    commit(&dir, "a.txt", "one\n", "prep");
    git(&dir, &["mv", "move me.txt", "moved.txt"]);
    git(&dir, &["rm", "-q", "gone.txt"]);
    write(&dir, "new.txt", "fresh\n");
    let sha = commit(&dir, "a.txt", "one\nTWO\n", "changes");
    let g = isolated_git();

    let m = g.commit_file_diff(&dir, &sha, "a.txt", None, false).await.unwrap();
    let lines: Vec<String> = m.hunks.iter().flat_map(|h| h.lines.iter().map(|l| format!("{:?}:{}", l.kind, l.text))).collect();
    assert_eq!(lines, ["Context:one", "Add:TWO"]);
    let added = g.commit_file_diff(&dir, &sha, "new.txt", None, false).await.unwrap();
    assert_eq!(added.hunks[0].lines.len(), 1);
    let deleted = g.commit_file_diff(&dir, &sha, "gone.txt", None, false).await.unwrap();
    assert_eq!(format!("{:?}", deleted.hunks[0].lines[0].kind), "Remove");
    let renamed = g.commit_file_diff(&dir, &sha, "moved.txt", Some("move me.txt"), false).await.unwrap();
    assert!(renamed.hunks.is_empty() && !renamed.binary, "a pure rename has no content change");
    let root_diff = g.commit_file_diff(&dir, &root, "a.txt", None, false).await.unwrap();
    assert_eq!(root_diff.hunks[0].lines[0].text, "one");
}

#[tokio::test]
async fn full_file_diffs_keep_every_unchanged_line() {
    let (_t, dir) = repo_with_commit();
    let before: String = (1..=30).map(|n| format!("line {n}\n")).collect();
    commit(&dir, "f.txt", &before, "thirty lines");
    let after = before.replace("line 3\n", "line three\n").replace("line 28\n", "line twenty-eight\n");
    let sha = commit(&dir, "f.txt", &after, "two edits far apart");
    write(&dir, "f.txt", &after.replace("line 15\n", "line fifteen\n"));
    let g = isolated_git();

    // Hunks: two separate changes, each with a little context. Full: one hunk, the whole file.
    let hunks = g.commit_file_diff(&dir, &sha, "f.txt", None, false).await.unwrap();
    assert_eq!(hunks.hunks.len(), 2);
    let full = g.commit_file_diff(&dir, &sha, "f.txt", None, true).await.unwrap();
    assert_eq!(full.hunks.len(), 1);
    let new_side: Vec<u32> = full.hunks[0].lines.iter().filter_map(|l| l.new_no).collect();
    assert_eq!(new_side, (1..=30).collect::<Vec<_>>());
    assert_eq!(full.hunks[0].lines.iter().filter(|l| format!("{:?}", l.kind) != "Context").count(), 4);

    let worktree = g.diff_file(&dir, "f.txt", false, false, true).await.unwrap();
    assert_eq!((worktree.hunks.len(), worktree.hunks[0].lines.len()), (1, 31));
    assert!(worktree.hunks[0].lines.iter().any(|l| l.text == "line fifteen"));
    assert!(worktree.hunks[0].lines.iter().any(|l| l.text == "line twenty-eight"));
    assert_eq!(g.diff_file(&dir, "f.txt", false, false, false).await.unwrap().hunks[0].lines.len(), 8);

    let syntax = g.commit_file_diff_syntax(&dir, &sha, "f.txt", None, true).await.unwrap();
    assert!(syntax.old.is_empty() && syntax.new.is_empty(), "plain text has no colours");
}

#[tokio::test]
async fn ids_that_are_not_commit_ids_never_reach_git() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    for bad in ["--output=/tmp/x", "HEAD", "HEAD~1", "a b"] {
        assert!(g.commit_details(&dir, bad).await.is_err(), "{bad}");
        assert!(g.commit_file_diff(&dir, bad, "a.txt", None, false).await.is_err(), "{bad}");
        assert!(g.reset(&dir, bad, ResetMode::Soft).await.is_err(), "{bad}");
    }
}

// ---- revert ----

#[tokio::test]
async fn revert_adds_a_commit_that_undoes_the_changes() {
    let (_t, dir) = repo_with_commit();
    let sha = commit(&dir, "a.txt", "one\ntwo\n", "Add two");
    commit(&dir, "b.txt", "b\n", "Unrelated");
    let out = isolated_git().revert_with(&dir, &sha, HookOpts::default()).await.unwrap();
    assert_eq!(out, IntegrateOutcome::Done);
    assert_eq!(read(&dir, "a.txt"), "one\n");
    assert_eq!(read(&dir, "b.txt"), "b\n");
    assert_eq!(git_out(&dir, &["log", "-1", "--format=%s"]).trim(), "Revert \"Add two\"");
}

#[tokio::test]
async fn revert_of_a_merge_undoes_what_it_brought_in() {
    let (_t, dir) = repo_with_commit();
    git(&dir, &["checkout", "-q", "-b", "side"]);
    commit(&dir, "side.txt", "s\n", "side work");
    git(&dir, &["checkout", "-q", "main"]);
    commit(&dir, "main.txt", "m\n", "main work");
    git(&dir, &["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
    let merge = head(&dir);
    isolated_git().revert_with(&dir, &merge, HookOpts::default()).await.unwrap();
    assert!(!dir.join("side.txt").exists());
    assert!(dir.join("main.txt").exists());
}

#[tokio::test]
async fn revert_that_conflicts_stops_in_the_reverting_state() {
    let (_t, dir) = repo_with_commit();
    let sha = commit(&dir, "a.txt", "two\n", "Change to two");
    commit(&dir, "a.txt", "three\n", "Change to three");
    let before = head(&dir);
    let g = isolated_git();
    let out = g.revert_with(&dir, &sha, HookOpts::default()).await.unwrap();
    assert_eq!(out, IntegrateOutcome::Conflicts { files: 1 });
    assert_eq!(info::read_operation(&dir), Some(info::Operation::Reverting));
    g.abort_operation(&dir).await.unwrap();
    assert_eq!(head(&dir), before);
    assert_eq!(read(&dir, "a.txt"), "three\n");
}

#[tokio::test]
async fn revert_refuses_to_overwrite_local_changes() {
    let (_t, dir) = repo_with_commit();
    let sha = commit(&dir, "a.txt", "one\ntwo\n", "Add two");
    write(&dir, "a.txt", "one\ntwo\nmine\n");
    let before = head(&dir);
    assert!(isolated_git().revert_with(&dir, &sha, HookOpts::default()).await.is_err());
    assert_eq!(head(&dir), before);
    assert_eq!(read(&dir, "a.txt"), "one\ntwo\nmine\n", "the local change is untouched");
    assert_eq!(info::read_operation(&dir), None);
}

/// Pins which commit hooks `git revert` runs, so a git upgrade that changes it shows up here.
#[tokio::test]
async fn revert_runs_only_the_hooks_revert_hooks_names() {
    let (_t, dir) = repo_with_commit();
    let sha = commit(&dir, "a.txt", "one\ntwo\n", "Add two");
    for name in ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"] {
        write_hook(&dir, name, &format!("#!/bin/sh\necho {name} >> .git/hooks-ran\n"));
    }
    isolated_git().revert_with(&dir, &sha, HookOpts::default()).await.unwrap();
    let ran = std::fs::read_to_string(dir.join(".git/hooks-ran")).unwrap_or_default();
    let ran: Vec<&str> = ran.lines().collect();
    assert_eq!(ran, gitr_core::repo::REVERT_HOOKS, "no pre-commit and no commit-msg (git 2.55, --no-edit)");
}

// ---- reset ----

fn status_short(dir: &Path) -> String {
    git_out(dir, &["status", "--porcelain=v1", "-uall"])
}

/// Three commits after init, plus an untracked file and an unstaged edit that must survive.
fn reset_scene() -> (tempfile::TempDir, PathBuf, Vec<String>) {
    let (t, dir) = repo_with_commit();
    let shas = vec![
        commit(&dir, "b.txt", "b\n", "add b"),
        commit(&dir, "c.txt", "c\n", "add c"),
        commit(&dir, "b.txt", "b2\n", "change b"),
    ];
    write(&dir, "untracked.txt", "u\n");
    write(&dir, "a.txt", "one\nlocal\n");
    (t, dir, shas)
}

fn files_on_disk(dir: &Path) -> Vec<(String, String)> {
    ["a.txt", "b.txt", "c.txt", "untracked.txt"].iter().map(|f| (f.to_string(), read(dir, f))).collect()
}

#[tokio::test]
async fn reset_soft_keeps_changes_staged_and_files_untouched() {
    let (_t, dir, shas) = reset_scene();
    let disk = files_on_disk(&dir);
    let previous = isolated_git().reset(&dir, &shas[0], ResetMode::Soft).await.unwrap();
    assert_eq!(previous, shas[2]);
    assert_eq!(head(&dir), shas[0]);
    assert_eq!(files_on_disk(&dir), disk);
    let st = status_short(&dir);
    assert!(st.contains("M  b.txt") && st.contains("A  c.txt"), "{st}");
    assert!(st.contains(" M a.txt") && st.contains("?? untracked.txt"), "{st}");
}

#[tokio::test]
async fn reset_mixed_keeps_changes_unstaged_and_files_untouched() {
    let (_t, dir, shas) = reset_scene();
    let disk = files_on_disk(&dir);
    isolated_git().reset(&dir, &shas[0], ResetMode::Mixed).await.unwrap();
    assert_eq!(head(&dir), shas[0]);
    assert_eq!(files_on_disk(&dir), disk);
    let st = status_short(&dir);
    assert!(st.contains(" M b.txt") && st.contains("?? c.txt") && st.contains(" M a.txt"), "{st}");
}

#[tokio::test]
async fn reset_refuses_head_itself_other_branches_and_operations() {
    let (_t, dir, shas) = reset_scene();
    let g = isolated_git();
    assert!(g.reset(&dir, &shas[2], ResetMode::Soft).await.is_err(), "already there");
    git(&dir, &["stash", "-u", "-q"]);
    git(&dir, &["checkout", "-q", "-b", "other", &shas[0]]);
    let elsewhere = commit(&dir, "d.txt", "d\n", "elsewhere");
    git(&dir, &["checkout", "-q", "main"]);
    let err = g.reset(&dir, &elsewhere, ResetMode::Soft).await.unwrap_err();
    assert!(err.to_string().contains("not on the current branch"), "{err}");
    assert_eq!(head(&dir), shas[2]);

    // A revert stopped on conflicts: reset would make it worse.
    let (_t2, dir2) = repo_with_commit();
    let first = head(&dir2);
    let two = commit(&dir2, "a.txt", "two\n", "two");
    commit(&dir2, "a.txt", "three\n", "three");
    g.revert_with(&dir2, &two, HookOpts::default()).await.unwrap();
    assert!(g.reset(&dir2, &first, ResetMode::Soft).await.is_err());
}

#[tokio::test]
async fn reset_preview_counts_unpushed_and_pushed() {
    let (_t, dir) = clone_with(3, 2);
    let target = git_out(&dir, &["rev-parse", "HEAD~4"]).trim().to_string();
    let p = isolated_git().reset_preview(&dir, &target).await.unwrap();
    assert_eq!((p.leaving, p.unpushed, p.on_upstream), (4, 2, 2));
    let near = git_out(&dir, &["rev-parse", "HEAD~1"]).trim().to_string();
    let p = isolated_git().reset_preview(&dir, &near).await.unwrap();
    assert_eq!((p.leaving, p.unpushed, p.on_upstream), (1, 1, 0));
}

#[tokio::test]
async fn undo_reset_restores_head_and_keeps_the_index() {
    let (_t, dir, shas) = reset_scene();
    let g = isolated_git();
    let previous = g.reset(&dir, &shas[0], ResetMode::Soft).await.unwrap();
    g.undo_reset(&dir, &previous, Some("refs/heads/main")).await.unwrap();
    assert_eq!(head(&dir), shas[2]);
    let st = status_short(&dir);
    assert!(!st.contains("b.txt") && !st.contains("c.txt"), "back to clean apart from the local edits: {st}");
    assert!(st.contains(" M a.txt") && st.contains("?? untracked.txt"), "{st}");
}

#[tokio::test]
async fn undo_reset_after_a_mixed_reset_leaves_no_phantom_changes() {
    let (_t, dir, shas) = reset_scene();
    let g = isolated_git();
    let previous = g.reset(&dir, &shas[0], ResetMode::Mixed).await.unwrap();
    g.undo_reset(&dir, &previous, Some("refs/heads/main")).await.unwrap();
    assert_eq!(head(&dir), shas[2]);
    let st = status_short(&dir);
    assert!(!st.contains("b.txt") && !st.contains("c.txt"), "back to clean apart from the local edits: {st}");
    assert!(st.contains(" M a.txt") && st.contains("?? untracked.txt"), "{st}");
}

#[tokio::test]
async fn undo_reset_is_refused_once_the_branch_moved_on() {
    let (_t, dir, shas) = reset_scene();
    let g = isolated_git();
    let previous = g.reset(&dir, &shas[0], ResetMode::Mixed).await.unwrap();
    commit(&dir, "e.txt", "e\n", "new work after the reset");
    let moved = head(&dir);
    assert!(g.undo_reset(&dir, &previous, Some("refs/heads/main")).await.is_err());
    assert_eq!(head(&dir), moved, "the new commit is kept");
}

#[tokio::test]
async fn undo_reset_is_refused_on_a_different_branch() {
    let (_t, dir, shas) = reset_scene();
    let g = isolated_git();
    let previous = g.reset(&dir, &shas[0], ResetMode::Soft).await.unwrap();
    git(&dir, &["stash", "-u", "-q"]);
    git(&dir, &["checkout", "-q", "-b", "other", &shas[0]]);
    let err = g.undo_reset(&dir, &previous, Some("refs/heads/main")).await.unwrap_err();
    assert!(err.to_string().contains("different branch"), "{err}");
    assert_eq!(head(&dir), shas[0], "the other branch stays put");
}

#[tokio::test]
async fn undo_reset_keeps_files_staged_since_and_still_follows_the_rest() {
    let (_t, dir, shas) = reset_scene();
    let g = isolated_git();
    let previous = g.reset(&dir, &shas[0], ResetMode::Mixed).await.unwrap();
    git(&dir, &["add", "c.txt"]);
    g.undo_reset(&dir, &previous, Some("refs/heads/main")).await.unwrap();
    assert_eq!(head(&dir), shas[2]);
    let st = status_short(&dir);
    assert!(!st.contains("b.txt"), "b.txt follows the undo: {st}");
    assert!(!st.contains("?? c.txt") && !st.contains("D  c.txt"), "no phantom change for c.txt: {st}");
}
