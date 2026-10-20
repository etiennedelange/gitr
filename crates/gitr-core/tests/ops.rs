mod common;

use common::*;
use gitr_core::info;
use gitr_core::repo::PullOutcome;
use gitr_core::runner::Kind;

#[tokio::test]
async fn runner_is_isolated() {
    let (_t, dir) = repo_with_commit();
    let runner = isolated_runner();
    let config = runner
        .run(&dir, Kind::Read, &["config", "--list", "--show-origin", "--show-scope"])
        .await
        .unwrap();
    for line in config.lines() {
        assert!(
            !line.starts_with("global") && !line.starts_with("system"),
            "leaked config from the developer setup: {line}"
        );
    }
    let ident = runner.run(&dir, Kind::Read, &["var", "GIT_AUTHOR_IDENT"]).await.unwrap();
    assert_eq!(ident.trim(), AUTHOR_IDENT);

    // The plain test helper is isolated the same way.
    let helper = git_out(&dir, &["config", "--list", "--show-scope"]);
    assert!(helper.lines().all(|l| !l.starts_with("global") && !l.starts_with("system")), "{helper}");
    assert_eq!(git_out(&dir, &["var", "GIT_AUTHOR_IDENT"]).trim(), AUTHOR_IDENT);
}

#[tokio::test]
async fn stage_unstage_commit_flow() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    write(&dir, "a.txt", "one\ntwo\n");
    write(&dir, "sub dir/new.txt", "new\n");

    let st = g.status(&dir).await.unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!((st.staged_count(), st.unstaged_count()), (0, 2));

    g.stage(&dir, &["sub dir/new.txt".into()]).await.unwrap();
    let st = g.status(&dir).await.unwrap();
    assert_eq!((st.staged_count(), st.unstaged_count()), (1, 1));

    let d = g.diff_file(&dir, "a.txt", false, false, false).await.unwrap();
    assert_eq!(d.hunks.len(), 1);
    assert!(d.hunks[0].lines.iter().any(|l| l.text == "two"));

    g.unstage_all(&dir).await.unwrap();
    assert_eq!(g.status(&dir).await.unwrap().staged_count(), 0);

    g.stage_all(&dir).await.unwrap();
    let staged = g.staged_changes(&dir, 10_000).await.unwrap();
    assert!(staged.diff.contains("+two"));
    assert_eq!(staged.recent_subjects, vec!["init"]);

    let sha = g.commit(&dir, "second", false).await.unwrap();
    assert_eq!(sha.len(), 40);
    let st = g.status(&dir).await.unwrap();
    assert!(st.files.is_empty());
}

#[tokio::test]
async fn untracked_diff_and_discard() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    write(&dir, "a.txt", "changed\n");
    write(&dir, "u.txt", "u\n");
    let d = g.diff_file(&dir, "u.txt", false, true, false).await.unwrap();
    assert_eq!(d.hunks[0].lines[0].text, "u");

    g.discard(&dir, &["a.txt".into()], &["u.txt".into()], test_bin(&dir)).await.unwrap();
    assert!(g.status(&dir).await.unwrap().files.is_empty());
    assert_eq!(read(&dir, "a.txt").trim(), "one");
}

#[tokio::test]
async fn discard_refuses_paths_that_are_not_untracked_files() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    write(&dir, "u.txt", "u\n");
    write(&dir, ".gitignore", "ignored.log\n");
    write(&dir, "ignored.log", "keep\n");
    for bad in ["a.txt", "ignored.log", "../outside.txt", ".git/config", "missing.txt"] {
        let err = g.discard(&dir, &[], &["u.txt".into(), bad.into()], test_bin(&dir)).await;
        assert!(err.is_err(), "{bad} should be refused");
        // Validation happens before deleting anything.
        assert!(dir.join("u.txt").exists(), "u.txt deleted although {bad} was refused");
    }
    assert!(dir.join("a.txt").exists() && dir.join("ignored.log").exists());
}

#[tokio::test]
async fn empty_message_is_rejected() {
    let (_t, dir) = repo_with_commit();
    assert!(isolated_git().commit(&dir, "  ", false).await.is_err());
}

#[tokio::test]
async fn branches_checkout_create_delete() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    g.create_branch(&dir, "feature/x", None, true).await.unwrap();
    let b = g.branches(&dir).await.unwrap();
    assert!(b.iter().any(|b| b.name == "feature/x" && b.is_head));
    g.checkout(&dir, "main", false).await.unwrap();
    g.delete_branch(&dir, "feature/x", false).await.unwrap();
    let b = g.branches(&dir).await.unwrap();
    assert_eq!(b.len(), 1);
}

#[tokio::test]
async fn pull_fast_forwards_and_detects_divergence_and_push_sets_upstream() {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);

    let a = tmp.path().join("a");
    std::fs::create_dir_all(&a).unwrap();
    init(&a);
    git(&a, &["remote", "add", "origin", remote.to_str().unwrap()]);
    write(&a, "f.txt", "1\n");
    git(&a, &["add", "."]);
    git(&a, &["commit", "-q", "-m", "c1"]);

    let g = isolated_git();
    g.push(&a).await.unwrap();
    assert_eq!(g.status(&a).await.unwrap().upstream.as_deref(), Some("origin/main"));

    let b = tmp.path().join("b");
    git(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), b.to_str().unwrap()]);
    assert_eq!(g.pull_ff(&b).await.unwrap(), PullOutcome::UpToDate);

    write(&a, "f.txt", "2\n");
    git(&a, &["commit", "-q", "-am", "c2"]);
    g.push(&a).await.unwrap();
    assert_eq!(g.pull_ff(&b).await.unwrap(), PullOutcome::FastForwarded);

    // fast_forward alone uses what was last fetched and never touches the network.
    write(&a, "f.txt", "2b\n");
    git(&a, &["commit", "-q", "-am", "c2b"]);
    g.push(&a).await.unwrap();
    assert_eq!(g.fast_forward(&b).await.unwrap(), PullOutcome::UpToDate, "nothing fetched yet");
    g.fetch(&b).await.unwrap();
    assert_eq!(g.fast_forward(&b).await.unwrap(), PullOutcome::FastForwarded);
    assert_eq!(read(&b, "f.txt"), "2b\n");

    write(&a, "f.txt", "3\n");
    git(&a, &["commit", "-q", "-am", "c3"]);
    g.push(&a).await.unwrap();
    write(&b, "g.txt", "local\n");
    git(&b, &["add", "."]);
    git(&b, &["commit", "-q", "-m", "local"]);
    assert_eq!(g.pull_ff(&b).await.unwrap(), PullOutcome::Diverged);

    let info = info::read_info(&b);
    assert_eq!(info.head_branch.as_deref(), Some("main"));
    assert!(info.remote_url.unwrap().contains("remote.git"));
}

#[tokio::test]
async fn line_stats_split_staged_and_unstaged() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    let before = read(&dir, "a.txt");
    write(&dir, "a.txt", &format!("{before}added 1\nadded 2\n"));
    g.stage(&dir, &["a.txt".into()]).await.unwrap();
    write(&dir, "a.txt", &format!("{before}added 1\n"));
    write(&dir, "untracked.txt", "ignored by numstat\n");

    let stats = g.line_stats(&dir).await.unwrap();
    assert_eq!(stats.staged.len(), 1);
    assert_eq!((stats.staged[0].path.as_str(), stats.staged[0].added, stats.staged[0].removed), ("a.txt", 2, 0));
    assert_eq!(stats.unstaged.len(), 1);
    assert_eq!((stats.unstaged[0].added, stats.unstaged[0].removed), (0, 1));
}

#[tokio::test]
async fn has_remote_tells_a_repo_without_remotes_apart() {
    let (_t, dir) = repo_with_commit();
    let g = isolated_git();
    assert!(!g.has_remote(&dir).await.unwrap());
    git(&dir, &["remote", "add", "origin", "https://example.invalid/x.git"]);
    assert!(g.has_remote(&dir).await.unwrap());
}

/// Summary status lists an untracked folder as one entry; full status lists each file.
#[tokio::test]
async fn summary_status_does_not_walk_untracked_folders() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "build/a.o", "x");
    write(&dir, "build/deep/b.o", "x");
    write(&dir, "loose.txt", "x");
    let g = isolated_git();
    let paths = |st: gitr_core::status::RepoStatus| {
        let mut v: Vec<String> = st.files.into_iter().map(|f| f.path).collect();
        v.sort();
        v
    };
    assert_eq!(paths(g.status_summary(&dir).await.unwrap()), ["build/", "loose.txt"]);
    assert_eq!(paths(g.status(&dir).await.unwrap()), ["build/a.o", "build/deep/b.o", "loose.txt"]);
}
