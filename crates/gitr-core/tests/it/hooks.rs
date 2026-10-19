//! Hooks during commit and push: their output arrives while they run, and they can be skipped.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::common::*;
use gitr_core::repo::HookOpts;

/// Hook output reaches `on_output` line by line while the hook still runs.
#[tokio::test]
async fn hook_output_streams_while_the_hook_runs() {
    let (_t, dir) = repo_with_commit();
    write_hook(&dir, "pre-commit", "#!/bin/sh\necho 'checking 1'\nsleep 1\necho 'checking 2' >&2\n");
    write(&dir, "a.txt", "two\n");
    git(&dir, &["add", "."]);

    let started = Instant::now();
    let seen: Arc<Mutex<Vec<(String, Duration)>>> = Arc::default();
    let sink = seen.clone();
    let on_output = move |line: &str| sink.lock().unwrap().push((line.to_string(), started.elapsed()));
    let hooks = HookOpts { on_output: Some(&on_output), ..Default::default() };
    isolated_git().commit_with(&dir, "streamed", false, hooks).await.unwrap();
    let done = started.elapsed();

    let seen = seen.lock().unwrap();
    let lines: Vec<&str> = seen.iter().map(|(l, _)| l.as_str()).collect();
    assert_eq!(lines, ["checking 1", "checking 2"], "hook stdout and stderr both arrive");
    assert!(seen[0].1 + Duration::from_millis(500) < done, "the first line arrived before the hook finished: {seen:?} {done:?}");
}

/// Skipping hooks commits and pushes even though the hooks would reject them.
#[tokio::test]
async fn skipped_hooks_do_not_run() {
    let (_t, dir) = repo_with_commit();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(&dir, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    write_hook(&dir, "pre-commit", "#!/bin/sh\necho ran > .git/pre-commit-ran\nexit 1\n");
    write_hook(&dir, "commit-msg", "#!/bin/sh\nexit 1\n");
    write_hook(&dir, "pre-push", "#!/bin/sh\nexit 1\n");
    write(&dir, "a.txt", "two\n");
    git(&dir, &["add", "."]);

    let g = isolated_git();
    let skip = HookOpts { skip: true, ..Default::default() };
    g.commit(&dir, "blocked", false).await.unwrap_err();
    std::fs::remove_file(dir.join(".git/pre-commit-ran")).unwrap();
    g.commit_with(&dir, "unblocked", false, skip).await.unwrap();
    assert!(!dir.join(".git/pre-commit-ran").exists(), "pre-commit must not run");
    assert_eq!(git_out(&dir, &["log", "-1", "--format=%s"]).trim(), "unblocked");

    assert_eq!(g.push(&dir).await.unwrap_err().hook(), Some("pre-push"));
    g.push_with(&dir, skip).await.unwrap();
    assert_eq!(git_out(remote.path(), &["log", "-1", "--format=%s", "main"]).trim(), "unblocked");
}
