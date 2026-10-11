//! Every error kind, recognised from the output git really prints (Git for Windows 2.55,
//! LC_ALL=C). Where a failure can be produced locally it is produced through Gitr's own
//! `Git` API; auth and dubious ownership can't be (no credentials server offline, and
//! Git for Windows ignores GIT_TEST_ASSUME_DIFFERENT_OWNER), so their real messages are
//! quoted verbatim.
mod common;

use std::path::{Path, PathBuf};

use common::*;
use gitr_core::GitError;
use gitr_core::error::{ErrorKind, classify, lock_path};
use gitr_core::runner::Kind;

fn kind(r: Result<impl Sized, GitError>) -> ErrorKind {
    match r {
        Ok(_) => panic!("expected a failure"),
        Err(e) => e.kind(),
    }
}

/// Two clones of one bare remote; `a` is behind after `b` pushes.
fn diverged() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let remote = tmp.path().join("remote.git");
    git(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
    let a = tmp.path().join("a");
    std::fs::create_dir_all(&a).unwrap();
    init(&a);
    write(&a, "f.txt", "1\n");
    git(&a, &["add", "."]);
    git(&a, &["commit", "-q", "-m", "1"]);
    git(&a, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&a, &["push", "-q", "-u", "origin", "main"]);
    let b = tmp.path().join("b");
    git(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), b.to_str().unwrap()]);
    write(&b, "g.txt", "b\n");
    git(&b, &["add", "."]);
    git(&b, &["commit", "-q", "-m", "b"]);
    git(&b, &["push", "-q", "origin", "main"]);
    write(&a, "h.txt", "a\n");
    git(&a, &["add", "."]);
    git(&a, &["commit", "-q", "-m", "a"]);
    (tmp, a)
}

#[tokio::test]
async fn non_fast_forward_push() {
    let (_t, a) = diverged();
    let err = isolated_git().push(&a).await.unwrap_err();
    assert_eq!(err.kind(), ErrorKind::NonFastForward, "{err}");
    // push --porcelain prints the rejection on stdout; details keep both streams.
    let GitError::Failed { stderr, cwd, .. } = &err else { panic!() };
    assert!(stderr.contains("[rejected]") && stderr.contains("Updates were rejected"), "{stderr}");
    assert_eq!(Path::new(cwd), a);
}

#[tokio::test]
async fn lock_file_left_behind() {
    let (_t, dir) = repo_with_commit();
    std::fs::write(dir.join(".git/index.lock"), "").unwrap();
    write(&dir, "a.txt", "two\n");
    let err = isolated_git().stage(&dir, &["a.txt".into()]).await.unwrap_err();
    assert_eq!(err.kind(), ErrorKind::Lock);
    let lock = err.lock_path().expect("lock path");
    assert!(lock.ends_with(".git/index.lock"), "{lock}");
    assert_eq!(std::fs::canonicalize(&lock).unwrap(), std::fs::canonicalize(dir.join(".git/index.lock")).unwrap());
}

#[tokio::test]
async fn local_changes_would_be_overwritten() {
    let (_t, dir) = repo_with_commit();
    git(&dir, &["switch", "-q", "-c", "other"]);
    write(&dir, "a.txt", "other\n");
    git(&dir, &["commit", "-q", "-am", "other"]);
    git(&dir, &["switch", "-q", "main"]);
    write(&dir, "a.txt", "local edit\n");
    assert_eq!(kind(isolated_git().checkout(&dir, "other", false).await), ErrorKind::Overwrite);
}

#[tokio::test]
async fn network_unreachable_and_unknown_host() {
    let (_t, dir) = repo_with_commit();
    let r = isolated_runner();
    let refused = r.run(&dir, Kind::Network, &["ls-remote", "https://127.0.0.1:9/x.git"]).await;
    assert_eq!(kind(refused), ErrorKind::Network);
    let unknown = r.run(&dir, Kind::Network, &["ls-remote", "https://does-not-exist.invalid/x.git"]).await;
    assert_eq!(kind(unknown), ErrorKind::Network);
}

#[tokio::test]
async fn signing_failed() {
    let (_t, dir) = repo_with_commit();
    // The isolated test env forces commit.gpgsign=false (GIT_CONFIG_KEY_1); turn it on here.
    git(&dir, &["config", "gpg.program", "does-not-exist"]);
    write(&dir, "a.txt", "two\n");
    git(&dir, &["add", "."]);
    let g = gitr_core::Git::new(isolated_runner().with_env("GIT_CONFIG_VALUE_1", "true"));
    assert_eq!(kind(g.commit(&dir, "signed", false).await), ErrorKind::Signing);
}

#[tokio::test]
async fn hook_rejected_commit_and_push() {
    let (_t, dir) = repo_with_commit();
    write_hook(&dir, "pre-commit", "#!/bin/sh\necho 'lint failed: 3 problems'\nexit 1\n");
    write(&dir, "a.txt", "two\n");
    git(&dir, &["add", "."]);
    let err = isolated_git().commit(&dir, "hooked", false).await.unwrap_err();
    assert_eq!(err.kind(), ErrorKind::Hook);
    assert_eq!(err.hook(), Some("pre-commit"));
    let GitError::Failed { stderr, .. } = &err else { panic!() };
    assert!(stderr.contains("lint failed: 3 problems"), "the hook's own output is in details: {stderr}");

    // pre-push, via core.hooksPath (honoured too).
    let (_t2, a) = diverged();
    let hooks = a.join("my-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    std::fs::write(hooks.join("pre-push"), "#!/bin/sh\necho 'tests must pass'\nexit 1\n").unwrap();
    make_executable(&hooks.join("pre-push"));
    git(&a, &["config", "core.hooksPath", "my-hooks"]);
    git(&a, &["fetch", "-q"]);
    git(&a, &["rebase", "-q", "origin/main"]);
    let err = isolated_git().push(&a).await.unwrap_err();
    assert_eq!((err.kind(), err.hook()), (ErrorKind::Hook, Some("pre-push")));
}

/// The trace decides, not the hook's text: a lint hook that prints a network error is still a
/// hook failure, and the hook that failed is named (here the second of two).
#[tokio::test]
async fn hook_failure_is_read_from_the_trace() {
    let (_t, dir) = repo_with_commit();
    write_hook(&dir, "pre-commit", "#!/bin/sh\nexit 0\n");
    write_hook(&dir, "commit-msg", "#!/bin/sh\necho 'fatal: unable to access: Could not resolve host: lint.example'\nexit 1\n");
    write(&dir, "a.txt", "two\n");
    git(&dir, &["add", "."]);
    let err = isolated_git().commit(&dir, "hooked", false).await.unwrap_err();
    assert_eq!((err.kind(), err.hook()), (ErrorKind::Hook, Some("commit-msg")));
}

#[tokio::test]
async fn hook_present_but_failure_explained_keeps_its_kind() {
    let (_t, a) = diverged();
    write_hook(&a, "pre-push", "#!/bin/sh\nexit 0\n");
    assert_eq!(kind(isolated_git().push(&a).await), ErrorKind::NonFastForward);
}

#[tokio::test]
async fn not_a_repository() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(kind(isolated_git().status(tmp.path()).await), ErrorKind::NotARepo);
}

#[tokio::test]
async fn merge_conflict() {
    let (_t, dir) = repo_with_commit();
    git(&dir, &["switch", "-q", "-c", "side"]);
    write(&dir, "a.txt", "side\n");
    git(&dir, &["commit", "-q", "-am", "side"]);
    git(&dir, &["switch", "-q", "main"]);
    write(&dir, "a.txt", "main\n");
    git(&dir, &["commit", "-q", "-am", "main"]);
    let r = isolated_runner().run(&dir, Kind::LocalWrite, &["merge", "side"]).await;
    assert_eq!(kind(r), ErrorKind::Conflict);
}

/// Messages git prints that can't be produced offline / on Windows, quoted verbatim.
#[test]
fn auth_and_dubious_ownership_messages() {
    for out in [
        "fatal: could not read Username for 'https://dev.azure.com': terminal prompts disabled",
        "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
        "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
        "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
        "Host key verification failed.\nfatal: Could not read from remote repository.",
    ] {
        assert_eq!(classify(out), ErrorKind::Auth, "{out}");
    }
    let dubious = "fatal: detected dubious ownership in repository at 'D:/Repos/x'\n'D:/Repos/x' is owned by:\n\tBUILTIN/Administrators (S-1-5-32-544)\nbut the current user is:\n\tPC/me (S-1-5-21-1)\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory D:/Repos/x";
    assert_eq!(classify(dubious), ErrorKind::DubiousOwnership);
    assert_eq!(classify("remote: Repository not found.\nfatal: repository 'https://github.com/o/gone.git/' not found"), ErrorKind::Network);
    assert_eq!(lock_path("fatal: other"), None);
}

/// "Trust this folder": adds the repo to safe.directory in the global config, once.
#[tokio::test]
async fn trust_folder_writes_safe_directory_once() {
    let (t, dir) = repo_with_commit();
    let global = t.path().join("global.gitconfig");
    std::fs::write(&global, "").unwrap();
    let g = gitr_core::Git::new(isolated_runner().with_env("GIT_CONFIG_GLOBAL", &global));
    g.trust_folder(&dir).await.unwrap();
    g.trust_folder(&dir).await.unwrap();
    let text = std::fs::read_to_string(&global).unwrap();
    let entry = dir.to_string_lossy().replace('\\', "/");
    assert_eq!(text.matches("directory = ").count(), 1, "listed exactly once: {text}");
    assert!(text.contains(&format!("directory = {entry}")), "{text}");
}
