//! Regression tests for file names and contents that used to be dangerous or unusual (glob
//! characters, leading dash, Unicode, CRLF, non-UTF-8), for path lists too long for one Windows
//! command line, and for every kind of merge conflict entry.
mod common;

use std::path::Path;

use common::*;
use gitr_core::diff::LineKind;

fn exists(dir: &Path, name: &str) -> bool {
    dir.join(name).exists()
}

/// Fact 1: discarding untracked `a[12].txt` must not delete `a1.txt` / `a2.txt`.
#[tokio::test]
async fn discard_untracked_glob_name_deletes_only_that_file() {
    let (_t, dir) = repo_with_commit();
    for f in ["a1.txt", "a2.txt", "a[12].txt"] {
        write(&dir, f, "x\n");
    }
    isolated_git().discard(&dir, &[], &["a[12].txt".into()], test_bin(&dir)).await.unwrap();
    assert!(!exists(&dir, "a[12].txt"));
    assert!(exists(&dir, "a1.txt") && exists(&dir, "a2.txt"));
}

/// Fact 2: discarding tracked `a[12].txt` must not revert modified `a1.txt`.
#[tokio::test]
async fn discard_tracked_glob_name_restores_only_that_file() {
    let (_t, dir) = repo_with_commit();
    for f in ["a1.txt", "a[12].txt"] {
        write(&dir, f, "orig\n");
    }
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "files"]);
    write(&dir, "a1.txt", "changed\n");
    write(&dir, "a[12].txt", "changed\n");
    isolated_git().discard(&dir, &["a[12].txt".into()], &[], test_bin(&dir)).await.unwrap();
    assert_eq!(read(&dir, "a[12].txt"), "orig\n");
    assert_eq!(read(&dir, "a1.txt"), "changed\n");
}

/// Fact 3: stage/unstage of `a[12].txt` touch only that file.
#[tokio::test]
async fn stage_and_unstage_bracket_name_touch_only_that_file() {
    let (_t, dir) = repo_with_commit();
    for f in ["a1.txt", "a2.txt", "a[12].txt"] {
        write(&dir, f, "x\n");
    }
    let g = isolated_git();
    g.stage(&dir, &["a[12].txt".into()]).await.unwrap();
    assert_eq!(staged_names(&dir), ["a[12].txt"]);

    g.stage(&dir, &["a1.txt".into(), "a2.txt".into()]).await.unwrap();
    g.unstage(&dir, &["a[12].txt".into()]).await.unwrap();
    assert_eq!(staged_names(&dir), ["a1.txt", "a2.txt"]);
}

/// Fact 3: `*` and `?` names. Windows can't create such files, so these are index-only entries;
/// staging such a name must never pick up `b.md` / `x.txt`.
#[tokio::test]
async fn star_and_question_names_are_literal() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "b.md", "b\n");
    write(&dir, "x.txt", "x\n");
    git(&dir, &["add", "b.md", "x.txt"]);
    git(&dir, &["commit", "-q", "-m", "b and x"]);
    write(&dir, "b.md", "b2\n");
    write(&dir, "x.txt", "x2\n");
    let g = isolated_git();

    // Staging a literal name that has no worktree file may fail, but must not stage the others.
    let _ = g.stage(&dir, &["*.md".into()]).await;
    let _ = g.stage(&dir, &["?.txt".into()]).await;
    assert!(staged_names(&dir).is_empty(), "{:?}", staged_names(&dir));

    // Unstaging resets only the entry with that exact name.
    git(&dir, &["add", "b.md", "x.txt"]);
    add_index_only(&dir, "*.md", "star\n");
    add_index_only(&dir, "?.txt", "q\n");
    assert_eq!(staged_names(&dir), ["*.md", "?.txt", "b.md", "x.txt"]);
    g.unstage(&dir, &["*.md".into(), "?.txt".into()]).await.unwrap();
    assert_eq!(staged_names(&dir), ["b.md", "x.txt"]);
}

/// Fact 3 with real files where the OS allows them.
#[cfg(unix)]
#[tokio::test]
async fn star_and_question_real_files_are_literal() {
    let (_t, dir) = repo_with_commit();
    for f in ["b.md", "*.md", "x.txt", "?.txt"] {
        write(&dir, f, "x\n");
    }
    let g = isolated_git();
    g.stage(&dir, &["*.md".into(), "?.txt".into()]).await.unwrap();
    assert_eq!(staged_names(&dir), ["*.md", "?.txt"]);
    g.discard(&dir, &[], &["b.md".into()], test_bin(&dir)).await.unwrap();
    g.unstage(&dir, &["*.md".into()]).await.unwrap();
    g.discard(&dir, &[], &["*.md".into()], test_bin(&dir)).await.unwrap();
    assert!(!exists(&dir, "*.md") && !exists(&dir, "b.md") && exists(&dir, "x.txt") && exists(&dir, "?.txt"));
}

/// Fact 4: leading dash, spaces and Unicode work for stage, unstage and discard.
#[tokio::test]
async fn odd_names_stage_unstage_discard() {
    let names = ["-rf.txt", "sub dir/naïve file.txt", "日本.txt"];
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    let list: Vec<String> = names.iter().map(|s| s.to_string()).collect();

    // Untracked: stage, unstage, discard (delete).
    for n in names {
        write(&dir, n, "new\n");
    }
    g.stage(&dir, &list).await.unwrap();
    let mut expected: Vec<String> = list.clone();
    expected.sort();
    assert_eq!(staged_names(&dir), expected);
    g.unstage(&dir, &list).await.unwrap();
    assert!(staged_names(&dir).is_empty());
    let st = g.status(&dir).await.unwrap();
    let mut untracked: Vec<String> = st.files.iter().filter(|f| f.untracked).map(|f| f.path.clone()).collect();
    untracked.sort();
    assert_eq!(untracked, expected, "status must report the names exactly");
    g.discard(&dir, &[], &list, test_bin(&dir)).await.unwrap();
    assert!(names.iter().all(|n| !exists(&dir, n)));

    // Tracked: modify, discard (restore).
    for n in names {
        write(&dir, n, "orig\n");
    }
    g.stage(&dir, &list).await.unwrap();
    g.commit(&dir, "odd names", false).await.unwrap();
    for n in names {
        write(&dir, n, "changed\n");
    }
    g.discard(&dir, &list, &[], test_bin(&dir)).await.unwrap();
    assert!(names.iter().all(|n| read(&dir, n) == "orig\n"));
}

/// Facts 5 and 7: 300 paths (> 32K characters together) in one git call, passed via stdin.
#[tokio::test]
async fn many_long_paths_in_one_call_via_stdin() {
    let (_t, dir) = repo_with_commit();
    let stem = "p".repeat(110);
    let names: Vec<String> = (0..300).map(|i| format!("d/{stem}_{i:03}.txt")).collect();
    assert!(names.iter().map(|n| n.len() + 1).sum::<usize>() > 32_768);
    for n in &names {
        write(&dir, n, "x\n");
    }
    let g = isolated_git();

    let log = LogCapture::start();
    g.stage(&dir, &names).await.unwrap();
    let adds = log.git_lines("add");
    assert_eq!(adds.len(), 1, "expected exactly one git add: {}", log.text().chars().take(600).collect::<String>());
    assert!(adds[0].contains("--pathspec-from-file=-") && adds[0].contains("--pathspec-file-nul"));
    assert!(!adds[0].contains(&stem), "paths must not be on the command line");
    assert_eq!(staged_names(&dir).len(), 300);

    g.unstage(&dir, &names).await.unwrap();
    assert_eq!(log.git_lines("reset").len(), 1);
    assert!(staged_names(&dir).is_empty());

    // Untracked discard of all 300.
    g.discard(&dir, &[], &names, test_bin(&dir)).await.unwrap();
    assert!(names.iter().all(|n| !exists(&dir, n)));

    // Tracked discard of all 300 in one restore.
    for n in &names {
        write(&dir, n, "orig\n");
    }
    g.stage(&dir, &names).await.unwrap();
    g.commit(&dir, "many", false).await.unwrap();
    for n in &names {
        write(&dir, n, "changed\n");
    }
    g.discard(&dir, &names, &[], test_bin(&dir)).await.unwrap();
    assert_eq!(log.git_lines("restore").len(), 1);
    assert!(names.iter().all(|n| read(&dir, n) == "orig\n"));
}

fn write_bytes(dir: &Path, name: &str, content: &[u8]) {
    std::fs::write(dir.join(name), content).unwrap();
}

/// A CRLF file under `text=auto` makes `git add` warn "CRLF will be replaced by LF" on stderr;
/// staging must still succeed, normalise the index copy and leave the working copy alone.
/// (`.gitattributes`, because the isolated environment pins `core.autocrlf=false`.)
#[tokio::test]
async fn crlf_file_stages_despite_the_line_ending_warning() {
    let (_t, dir) = repo_with_commit();
    write(&dir, ".gitattributes", "* text=auto\n");
    write_bytes(&dir, "w.txt", b"one\r\ntwo\r\n");
    let g = isolated_git();
    g.stage(&dir, &["w.txt".into(), ".gitattributes".into()]).await.unwrap();
    assert_eq!(staged_names(&dir), [".gitattributes", "w.txt"]);
    assert_eq!(git_out(&dir, &["show", ":w.txt"]), "one\ntwo\n");
    assert_eq!(std::fs::read(dir.join("w.txt")).unwrap(), b"one\r\ntwo\r\n");
}

/// A file whose only change is its line endings is listed, and its diff and line counts load.
#[tokio::test]
async fn line_ending_only_change_is_listed_and_diffs() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "e.txt", "one\ntwo\n");
    git(&dir, &["add", "e.txt"]);
    git(&dir, &["commit", "-q", "-m", "lf"]);
    write_bytes(&dir, "e.txt", b"one\r\ntwo\r\n");
    let g = isolated_git();

    let st = g.status(&dir).await.unwrap();
    assert!(st.files.iter().any(|f| f.path == "e.txt" && f.worktree == 'M'), "{:?}", st.files);
    let diff = g.diff_file(&dir, "e.txt", false, false, false).await.unwrap();
    let count = |k| diff.hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind == k).count();
    assert_eq!((count(LineKind::Remove), count(LineKind::Add)), (2, 2), "{diff:?}");
    let stats = g.line_stats(&dir).await.unwrap();
    assert!(stats.unstaged.iter().any(|s| s.path == "e.txt" && s.added == 2 && s.removed == 2), "{stats:?}");
}

/// Discarding a change to a file committed with CRLF puts back its exact bytes.
#[tokio::test]
async fn discard_restores_crlf_bytes() {
    let (_t, dir) = repo_with_commit();
    write_bytes(&dir, "w.txt", b"one\r\ntwo\r\n");
    git(&dir, &["add", "w.txt"]);
    git(&dir, &["commit", "-q", "-m", "crlf"]);
    write_bytes(&dir, "w.txt", b"changed\r\n");
    isolated_git().discard(&dir, &["w.txt".into()], &[], test_bin(&dir)).await.unwrap();
    assert_eq!(std::fs::read(dir.join("w.txt")).unwrap(), b"one\r\ntwo\r\n");
}

/// Latin-1 content (not valid UTF-8): status, diff and line counts still load (showing such
/// text correctly is not done yet; this only guards that nothing fails).
#[tokio::test]
async fn non_utf8_content_loads() {
    let (_t, dir) = repo_with_commit();
    write_bytes(&dir, "l1.txt", b"caf\xe9\n");
    git(&dir, &["add", "l1.txt"]);
    git(&dir, &["commit", "-q", "-m", "latin-1"]);
    write_bytes(&dir, "l1.txt", b"caf\xe9 cr\xe8me\n");
    write_bytes(&dir, "new.txt", b"na\xefve\n");
    let g = isolated_git();

    let st = g.status(&dir).await.unwrap();
    assert_eq!(st.files.len(), 2, "{:?}", st.files);
    let tracked = g.diff_file(&dir, "l1.txt", false, false, false).await.unwrap();
    assert!(!tracked.binary && !tracked.hunks.is_empty(), "{tracked:?}");
    let untracked = g.diff_file(&dir, "new.txt", false, true, false).await.unwrap();
    assert!(!untracked.hunks.is_empty(), "{untracked:?}");
    let stats = g.line_stats(&dir).await.unwrap();
    assert!(stats.unstaged.iter().any(|s| s.path == "l1.txt" && s.added == 1 && s.removed == 1), "{stats:?}");
}

/// A file name that isn't valid UTF-8 (only Linux lets us create one). It is listed, staged,
/// diffed and discarded under its own bytes, and never confused with a valid UTF-8 file whose
/// name looks the same (`caf\u{FFFD}.txt`).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn non_utf8_file_name_is_acted_on_by_its_bytes() {
    use std::os::unix::ffi::OsStrExt;
    let (_t, dir) = repo_with_commit();
    let raw = dir.join(std::ffi::OsStr::from_bytes(b"caf\xe9.txt"));
    std::fs::write(&raw, "x\n").unwrap();
    write(&dir, "caf\u{FFFD}.txt", "keep\n");
    write(&dir, "other.txt", "o\n");
    let g = isolated_git();

    let st = g.status(&dir).await.unwrap();
    let paths: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).filter(|p| p.starts_with("caf")).collect();
    assert_eq!(paths.len(), 2, "{:?}", st.files);
    assert_ne!(paths[0], paths[1], "the two names stay distinct");
    let bad = paths.iter().find(|p| **p != "caf\u{FFFD}.txt").unwrap().to_string();

    let diff = g.diff_file(&dir, &bad, false, true, false).await.unwrap();
    assert!(!diff.hunks.is_empty(), "untracked diff of the odd name");

    g.stage(&dir, std::slice::from_ref(&bad)).await.unwrap();
    assert_eq!(staged_names(&dir).len(), 1, "only the odd name is staged");
    assert!(git_out(&dir, &["ls-files", "--stage", "--", "caf\u{FFFD}.txt"]).is_empty(), "the look-alike is not staged");
    git(&dir, &["reset", "-q"]);

    g.discard(&dir, &[], &[bad], test_bin(&dir)).await.unwrap();
    assert!(!raw.exists(), "the odd name is discarded");
    assert!(exists(&dir, "caf\u{FFFD}.txt"), "the look-alike is kept");
    assert!(exists(&dir, "other.txt"));
}

/// Each kind of unmerged entry git can leave counts as conflicted (that count gates Continue),
/// never as staged, and its diff loads.
#[tokio::test]
async fn every_conflict_kind_counts_as_conflicted() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "both-mod.txt", "base\n");
    write(&dir, "we-mod.txt", "base\n");
    write(&dir, "they-mod.txt", "base\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    git(&dir, &["switch", "-q", "-c", "side"]);
    write(&dir, "both-mod.txt", "side\n");
    write(&dir, "both-add.txt", "side\n");
    git(&dir, &["rm", "-q", "we-mod.txt"]);
    write(&dir, "they-mod.txt", "side\n");
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "side"]);
    git(&dir, &["switch", "-q", "main"]);
    write(&dir, "both-mod.txt", "main\n");
    write(&dir, "both-add.txt", "main\n");
    write(&dir, "we-mod.txt", "main\n");
    git(&dir, &["rm", "-q", "they-mod.txt"]);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "main"]);
    assert!(command_fails(&dir, &["merge", "side"]));

    let g = isolated_git();
    let st = g.status(&dir).await.unwrap();
    let mut kinds: Vec<(String, String)> = st
        .files
        .iter()
        .map(|f| (f.path.clone(), format!("{}{}{}", f.index, f.worktree, if f.conflicted { " conflicted" } else { "" })))
        .collect();
    kinds.sort();
    assert_eq!(
        kinds,
        [
            ("both-add.txt".to_string(), "AA conflicted".to_string()),
            ("both-mod.txt".into(), "UU conflicted".into()),
            ("they-mod.txt".into(), "DU conflicted".into()),
            ("we-mod.txt".into(), "UD conflicted".into()),
        ]
    );
    assert_eq!(st.staged_count(), 0);
    assert_eq!(st.unstaged_count(), 4);
    for f in &st.files {
        g.diff_file(&dir, &f.path, false, false, false).await.unwrap_or_else(|e| panic!("{}: {e}", f.path));
    }
    let e = g.continue_operation(&dir).await.expect_err("Continue must wait for the conflicts");
    assert!(e.to_string().contains("Resolve and stage"), "{e}");
}

fn command_fails(dir: &Path, args: &[&str]) -> bool {
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir).args(args);
    for op in isolated_env() {
        match op {
            gitr_core::runner::EnvOp::Set(k, v) => cmd.env(k, v),
            gitr_core::runner::EnvOp::Remove(k) => cmd.env_remove(k),
        };
    }
    !cmd.output().unwrap().status.success()
}
