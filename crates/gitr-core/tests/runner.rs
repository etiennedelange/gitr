mod common;

use std::time::{Duration, Instant};

use common::*;
use gitr_core::Git;
use gitr_core::runner::{Kind, RunOpts};

/// Fact 6: file names given to git are literal, never globs.
#[tokio::test]
async fn pathspecs_are_literal() {
    let (_t, dir) = repo_with_commit();
    write(&dir, "b.md", "b\n");
    git(&dir, &["add", "b.md"]);
    add_index_only(&dir, "*.md", "star\n");
    let out = isolated_runner().run(&dir, Kind::Read, &["ls-files", "-z", "--", "*.md"]).await.unwrap();
    assert_eq!(out, "*.md\0");
    // Without the runner's literal mode git would expand the glob.
    assert_eq!(git_out(&dir, &["ls-files", "-z", "--", "*.md"]), "*.md\0b.md\0");
}

/// Fact 8: large stdin and large stdout in one call complete. The runner writes stdin while
/// reading stdout, which avoids a deadlock when both pipes fill up.
///
/// Note: on Windows this test does not reproduce that deadlock with the old write-everything-
/// first code at these sizes (checked by mutation on 2026-10-01), and larger inputs run into the
/// per-object cost of git itself first. It guards correct completion, not the deadlock itself.
#[tokio::test]
async fn large_stdin_and_stdout_complete() {
    let (_t, dir) = repo_with_commit();
    // Look blobs up by object id: resolving `HEAD:path` re-reads refs per line, which made this
    // test depend on how fast git resolves refs on the machine (19 s for 10k lines on one run).
    let oid = git_stdin(&dir, &["hash-object", "-w", "--stdin"], "x".repeat(2000).as_bytes());
    let input = format!("{}\n", oid.trim()).repeat(2_000); // ~82 KB in, ~4 MB out
    assert!(input.len() > 64 * 1024);
    let runner = isolated_runner().with_read_timeout(Duration::from_secs(20));
    let out = runner
        .run_with(&dir, Kind::Read, &["cat-file", "--batch"], RunOpts { stdin: Some(input.as_bytes()), ..Default::default() })
        .await
        .expect("cat-file --batch with large stdin and stdout must complete");
    assert_eq!(out.matches(" blob 2000\n").count(), 2_000);
    assert!(out.len() > 4_000_000);
}

/// Fact 12: a command that would open an editor finishes instead of hanging.
#[tokio::test]
async fn editor_is_never_opened() {
    let (_t, dir) = repo_with_commit();
    let runner = isolated_runner();
    let before = git_out(&dir, &["log", "-1", "--format=%s"]);
    let started = Instant::now();
    // No -m / -F: git would normally launch an editor for the message.
    runner.run(&dir, Kind::LocalWrite, &["commit", "--amend", "--allow-empty"]).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(20));
    assert_eq!(git_out(&dir, &["log", "-1", "--format=%s"]), before);

    // Merge commits don't prompt for a message either.
    git(&dir, &["switch", "-q", "-c", "side"]);
    write(&dir, "side.txt", "s\n");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "side"]);
    git(&dir, &["switch", "-q", "main"]);
    runner.run(&dir, Kind::LocalWrite, &["merge", "--no-ff", "side"]).await.unwrap();
    assert!(git_out(&dir, &["log", "-1", "--format=%s"]).starts_with("Merge branch 'side'"));
}

/// Fact 11: a slow commit hook is not killed; the commit lands and leaves no index.lock.
#[tokio::test]
async fn slow_hook_commit_is_not_killed() {
    let (_t, dir) = repo_with_commit();
    write_hook(&dir, "pre-commit", "#!/bin/sh\nsleep 3\n");
    let g = Git::new(isolated_runner().with_read_timeout(Duration::from_secs(1)));
    write(&dir, "a.txt", "two\n");
    g.stage(&dir, &["a.txt".into()]).await.unwrap();
    let before = git_out(&dir, &["rev-parse", "HEAD"]);
    let started = Instant::now();
    let sha = g.commit(&dir, "slow hook", false).await.expect("commit must outlive the read timeout");
    assert!(started.elapsed() >= Duration::from_secs(3), "hook did not run");
    assert_ne!(sha, before.trim());
    assert!(!dir.join(".git/index.lock").exists());

    // Reads still time out. The read sleeps far longer than its limit (a tiny limit on a quick
    // command was flaky: under load git could finish before the first check).
    std::fs::remove_file(dir.join(".git/hooks/pre-commit")).unwrap();
    let r = isolated_runner().with_read_timeout(Duration::from_millis(200));
    let started = Instant::now();
    let err = r.run(&dir, Kind::Read, &["-c", "alias.slow=!sleep 10", "slow"]).await;
    assert!(matches!(err, Err(gitr_core::GitError::Timeout { .. })), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(5), "the timeout ended the read");
}

/// Cancelling a command (dropping its future) also ends the hooks git started. With only
/// `kill_on_drop`, git dies but the hook runs on and finishes its work.
#[tokio::test]
async fn cancel_kills_hooks_too() {
    let (_t, dir) = repo_with_commit();
    let hook = "#!/bin/sh\necho started > .git/hook-started\nsleep 2\necho survived > .git/hook-survived\n";
    write_hook(&dir, "pre-commit", hook);
    write(&dir, "a.txt", "two\n");
    git(&dir, &["add", "a.txt"]);
    let before = git_out(&dir, &["rev-parse", "HEAD"]);

    let (g, d) = (isolated_git(), dir.clone());
    let commit = tokio::spawn(async move { g.commit(&d, "cancelled", false).await });
    let started = Instant::now();
    while !dir.join(".git/hook-started").exists() {
        assert!(started.elapsed() < Duration::from_secs(20), "hook never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    commit.abort();
    assert!(commit.await.unwrap_err().is_cancelled());

    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(!dir.join(".git/hook-survived").exists(), "the hook kept running after cancel");
    assert_eq!(git_out(&dir, &["rev-parse", "HEAD"]), before, "nothing was committed");
}

/// Cancelling also ends what the hook itself started, not just the hook's shell. On Windows, Git
/// for Windows' shell (MSYS) starts each command as a new process whose parent is gone, so
/// `taskkill /T` missed it: the command (a lint or test run, in a real hook) ran on after Stop.
#[tokio::test]
async fn cancel_kills_what_the_hook_started() {
    let (_t, dir) = repo_with_commit();
    // The child writes the start marker itself, so it exists before the test cancels. When the
    // hook wrote it, the test could cancel while the shell was still forking the child, and the
    // child could start after the kill had reached the group.
    let hook = "#!/bin/sh\nsh -c 'echo started > .git/hook-started; sleep 2; echo survived > .git/hook-child-survived'\n";
    write_hook(&dir, "pre-commit", hook);
    write(&dir, "a.txt", "two\n");
    git(&dir, &["add", "a.txt"]);

    let (g, d) = (isolated_git(), dir.clone());
    let commit = tokio::spawn(async move { g.commit(&d, "cancelled", false).await });
    let started = Instant::now();
    while !dir.join(".git/hook-started").exists() {
        assert!(started.elapsed() < Duration::from_secs(20), "hook never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    commit.abort();
    assert!(commit.await.unwrap_err().is_cancelled());

    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!dir.join(".git/hook-child-survived").exists(), "a process the hook started kept running after cancel");
}

/// Fact 13: one log line per call with op, args, cwd, duration and exit code; stderr on failure.
#[tokio::test]
async fn every_call_is_logged() {
    let (_t, dir) = repo_with_commit();
    let log = LogCapture::start();
    let runner = isolated_runner();
    runner.run(&dir, Kind::Read, &["rev-parse", "HEAD"]).await.unwrap();
    runner.run(&dir, Kind::Read, &["rev-parse", "--verify", "nope"]).await.unwrap_err();

    let lines = log.git_lines("rev-parse");
    assert_eq!(lines.len(), 2, "{}", log.text());
    let (ok, failed) = (&lines[0], &lines[1]);
    for field in ["kind=\"read\"", "args=rev-parse", "cwd=", "duration_ms=", "exit_code="] {
        assert!(ok.contains(field) || ok.contains(&field.replace('"', "")), "missing {field} in {ok}");
    }
    assert!(ok.contains("INFO") && ok.contains("exit_code=0") && !ok.contains("stderr="));
    assert!(failed.contains("WARN") && failed.contains("exit_code=128") && failed.contains("stderr="), "{failed}");
    assert!(failed.contains("fatal"), "{failed}");
}

/// Fact 15: credentials in URLs never reach the log.
#[tokio::test]
async fn credentials_are_redacted_in_logs() {
    let (_t, dir) = repo_with_commit();
    let log = LogCapture::start();
    let url = "https://user:s3cretPass@127.0.0.1:9/x.git";
    let _ = isolated_runner().run(&dir, Kind::Network, &["ls-remote", url]).await;
    let text = log.text();
    assert!(text.contains("https://***@127.0.0.1:9/x.git"), "{text}");
    assert!(!text.contains("s3cretPass") && !text.contains("user:"), "{text}");
}
