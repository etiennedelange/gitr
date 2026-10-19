//! What a network command's environment tells credential helpers and ssh. The "remote" is an
//! `ext::` command that records its environment (credential helpers and ssh are started by git
//! with the same environment) and then fails.

use crate::common::*;
use gitr_core::repo::{Prompt, ssh_command};

/// A developer's own `GIT_SSH_COMMAND`/`GIT_SSH` rightly wins, which these tests can't control.
fn user_ssh_in_env() -> bool {
    let set = ["GIT_SSH_COMMAND", "GIT_SSH"].iter().any(|k| std::env::var_os(k).is_some());
    if set {
        eprintln!("skipped: GIT_SSH_COMMAND or GIT_SSH is set in this environment");
    }
    set
}

fn recording_remote(dir: &std::path::Path) {
    git(dir, &["config", "protocol.ext.allow", "always"]);
    let script = "ext::sh -c echo% \"gcm=$GCM_INTERACTIVE\"% >.git/env;echo% \"ssh=$GIT_SSH_COMMAND\"% >>.git/env;exit% 1";
    git(dir, &["remote", "add", "origin", script]);
}

#[tokio::test]
async fn batches_never_prompt_and_single_actions_may() {
    if user_ssh_in_env() {
        return;
    }
    let (_t, dir) = repo_with_commit();
    recording_remote(&dir);
    let g = isolated_git();

    g.fetch_with(&dir, Prompt::Never).await.unwrap_err();
    let env = read(&dir, ".git/env");
    assert!(env.contains("gcm=never\n"), "{env}");
    assert!(env.contains(&format!("ssh={}\n", ssh_command(Prompt::Never))), "{env}");
    assert!(env.contains("BatchMode=yes"), "{env}");

    g.fetch_with(&dir, Prompt::Allowed).await.unwrap_err();
    let env = read(&dir, ".git/env");
    // Left as inherited (GitHub's Windows runners set `GCM_INTERACTIVE=Never` for every process).
    let inherited = std::env::var("GCM_INTERACTIVE").unwrap_or_default();
    assert!(env.contains(&format!("gcm={inherited}\n")), "a single action leaves GCM's prompting alone: {env}");
    assert!(env.contains("StrictHostKeyChecking=accept-new") && !env.contains("BatchMode"), "{env}");
}

#[tokio::test]
async fn the_users_own_ssh_command_is_left_alone() {
    if user_ssh_in_env() {
        return;
    }
    let (_t, dir) = repo_with_commit();
    recording_remote(&dir);
    git(&dir, &["config", "core.sshCommand", "ssh -i ~/.ssh/work_key"]);
    isolated_git().fetch_with(&dir, Prompt::Never).await.unwrap_err();
    let env = read(&dir, ".git/env");
    assert!(env.contains("ssh=\n"), "GIT_SSH_COMMAND must not override core.sshCommand: {env}");
    assert!(env.contains("gcm=never\n"), "{env}");
}
