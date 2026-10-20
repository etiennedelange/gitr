use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use gitr_ai::CopilotGenerator;
use gitr_core::error::ErrorKind;
use gitr_core::info::Operation;
use gitr_core::locate::{self, GitLocation};
use gitr_core::{Git, GitRunner};
use gitr_remote::RemoteInfo;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::task::AbortHandle;

use crate::config::{self, Config, RepoEntry};
use crate::watcher::RepoWatcher;

pub struct AppState {
    pub dir: PathBuf,
    pub config: RwLock<Config>,
    pub repos: RwLock<Vec<RepoEntry>>,
    pub git: Git,
    /// Which git is used and whether it is usable (missing / too old).
    pub git_location: RwLock<GitLocation>,
    pub ai: Arc<CopilotGenerator>,
    pub generation: Mutex<Option<AbortHandle>>,
    pub watcher: Mutex<Option<RepoWatcher>>,
    /// Per repo: the ref the last reset moved (None when detached) and the HEAD it moved away from,
    /// the only commit Undo reset accepts.
    pub resets: Mutex<std::collections::HashMap<PathBuf, (Option<String>, String)>>,
}

impl AppState {
    pub fn load() -> Self {
        let dir = config::config_dir();
        let config = config::load(&dir);
        let repos = config::load_repo_cache(&dir);
        let ai = CopilotGenerator::new(config.copilot_cli_path.clone(), config.copilot_model.clone());
        let location = locate::locate(config.git_path.as_deref());
        let git = Git::new(GitRunner::new(location.path.clone().unwrap_or_else(|| PathBuf::from("git"))));
        Self {
            dir,
            config: RwLock::new(config),
            repos: RwLock::new(repos),
            git,
            git_location: RwLock::new(location),
            ai: Arc::new(ai),
            generation: Mutex::new(None),
            watcher: Mutex::new(None),
            resets: Mutex::new(Default::default()),
        }
    }

    /// Looks for git again (after the Git path setting changed, or "Check again") and switches
    /// every git command to the result immediately.
    pub fn relocate_git(&self) -> GitLocation {
        let location = locate::locate(self.config().git_path.as_deref());
        self.git.runner().set_program(location.path.clone().unwrap_or_else(|| PathBuf::from("git")));
        tracing::info!(target: "gitr", ?location, "git located");
        *self.git_location.write().unwrap() = location.clone();
        location
    }

    pub fn git_location(&self) -> GitLocation {
        self.git_location.read().unwrap().clone()
    }

    pub fn config(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    pub fn repos(&self) -> Vec<RepoEntry> {
        self.repos.read().unwrap().clone()
    }

    /// Only operate on repositories the user has configured; the UI never passes arbitrary paths.
    pub fn known_repo(&self, path: &str) -> Result<PathBuf, CmdError> {
        let known = self
            .repos
            .read()
            .unwrap()
            .iter()
            .any(|r| r.path.eq_ignore_ascii_case(path));
        if known {
            Ok(PathBuf::from(path))
        } else {
            Err(CmdError::msg(format!("Unknown repository: {path}")))
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    /// Plain-language message (per kind), shown in toasts and dashboard rows.
    pub message: String,
    /// git's raw output, behind "details".
    pub detail: Option<String>,
    pub kind: ErrorKind,
    /// The repository the failing command ran in (for actions such as Pull or Open terminal).
    pub repo: Option<String>,
    /// For `lock`: the lock file git couldn't create.
    pub lock_path: Option<String>,
    /// For `hook`: the hook that failed (e.g. `pre-commit`).
    pub hook: Option<String>,
}

impl CmdError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self { message: message.into(), detail: None, kind: ErrorKind::Other, repo: None, lock_path: None, hook: None }
    }
}

/// The message shown for a kind; `None` = use git's own first meaningful line.
pub fn friendly_message(kind: ErrorKind, op: &str) -> Option<String> {
    let action = match op {
        "commit" => "the commit",
        "push" => "the push",
        _ => "the operation",
    };
    Some(match kind {
        ErrorKind::NonFastForward => "Your branch and the remote have both moved on. Rebase or merge, then push.".into(),
        ErrorKind::Lock => "Another git process is using this repository, or one left a lock file behind.".into(),
        ErrorKind::Overwrite => "Your local changes would be overwritten. Commit or discard them first.".into(),
        ErrorKind::DubiousOwnership => "Git refuses to work in this folder because it is owned by another user.".into(),
        ErrorKind::Auth => "Sign-in failed or is needed for this remote.".into(),
        ErrorKind::Network => "Couldn't reach the remote. Check the network or VPN, and the remote address.".into(),
        ErrorKind::Signing => "Commit signing failed. Check your GPG or SSH signing setup.".into(),
        ErrorKind::Hook => format!("A git hook rejected {action}."),
        ErrorKind::NotARepo => "This folder is not a git repository (any more).".into(),
        ErrorKind::Conflict => "Git stopped on conflicts. Resolve them, or abort.".into(),
        ErrorKind::GitMissing => "Git couldn't be started. Install it, or set its path in Settings.".into(),
        ErrorKind::Cancelled | ErrorKind::Other => return None,
    })
}

impl From<gitr_core::GitError> for CmdError {
    fn from(e: gitr_core::GitError) -> Self {
        use gitr_core::GitError as E;
        let kind = e.kind();
        let lock_path = e.lock_path();
        match e {
            E::Failed { op, stderr, cwd, hook, .. } => Self {
                message: hook_message(hook.as_deref(), &op)
                    .or_else(|| refused_message(kind, &stderr))
                    .or_else(|| friendly_message(kind, &op))
                    .or_else(|| first_meaningful_line(&stderr))
                    .unwrap_or_else(|| format!("git {op} failed")),
                detail: Some(stderr),
                kind,
                repo: Some(cwd),
                lock_path,
                hook,
            },
            E::Spawn { message } => Self {
                message: friendly_message(kind, "").unwrap_or_default(),
                detail: Some(message),
                kind,
                repo: None,
                lock_path: None,
                hook: None,
            },
            other => Self::msg(other.to_string()),
        }
    }
}

impl From<gitr_ai::AiError> for CmdError {
    fn from(e: gitr_ai::AiError) -> Self {
        Self::msg(e.to_string())
    }
}

/// An auth error that no sign-in fixes (a 403, a changed host key, a missing repository behind
/// SSH) gets its own message instead of "Sign-in failed or is needed".
fn refused_message(kind: ErrorKind, stderr: &str) -> Option<String> {
    if kind != ErrorKind::Auth || gitr_core::error::needs_sign_in(stderr) {
        return None;
    }
    let lower = stderr.to_ascii_lowercase();
    Some(if lower.contains("host key verification failed") {
        "The server's SSH host key has changed or can't be checked, so git refused to connect.".into()
    } else if lower.contains("returned error: 403") {
        "The remote refused access: you are signed in but have no permission for this repository.".into()
    } else {
        "The remote couldn't be read. The repository may not exist, or you may have no access to it.".into()
    })
}

/// "The pre-commit hook rejected the commit." when the failing hook is known.
fn hook_message(hook: Option<&str>, op: &str) -> Option<String> {
    let action = match op {
        "commit" => "the commit",
        "push" => "the push",
        _ => "the operation",
    };
    hook.map(|h| format!("The {h} hook rejected {action}."))
}

fn first_meaningful_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("hint:"))
        .map(|l| l.trim_start_matches("error: ").trim_start_matches("fatal: ").to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: usize,
    pub unstaged: usize,
    pub conflicted: usize,
    pub remote: Option<RemoteInfo>,
    pub error: Option<String>,
    /// A merge, rebase, cherry-pick or revert waiting for the user.
    pub operation: Option<Operation>,
    /// The commit HEAD points at (None on an unborn branch); the History tab reloads when it moves.
    pub head: Option<String>,
}

pub async fn summarize(git: &Git, path: &Path) -> RepoSummary {
    let path_str = path.to_string_lossy().to_string();
    let info_path = path.to_path_buf();
    let info = tokio::task::spawn_blocking(move || gitr_core::info::read_info(&info_path))
        .await
        .unwrap_or_default();
    let remote = info.remote_url.as_deref().and_then(gitr_remote::parse);
    match git.status_summary(path).await {
        Ok(st) => RepoSummary {
            path: path_str,
            branch: st.branch.clone().or(info.head_branch),
            detached: st.detached,
            upstream: st.upstream.clone(),
            ahead: st.ahead,
            behind: st.behind,
            staged: st.staged_count(),
            unstaged: st.unstaged_count(),
            conflicted: st.files.iter().filter(|f| f.conflicted).count(),
            remote,
            error: None,
            operation: info.operation,
            head: st.oid.clone(),
        },
        Err(e) => RepoSummary {
            path: path_str,
            branch: info.head_branch,
            detached: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            conflicted: 0,
            remote,
            error: Some(CmdError::from(e).message),
            operation: info.operation,
            head: None,
        },
    }
}

pub async fn emit_summary(app: &AppHandle, git: &Git, path: &Path) {
    // The UI asks for the open diff again on this event; it must not be coloured from a diff
    // made before the change.
    git.forget_diffs(path);
    let summary = summarize(git, path).await;
    let _ = app.emit("repo-summary", summary);
}

/// Builds the per-repo operation coordinator: busy changes go to the UI as `repo-busy`
/// events, refreshes emit `repo-summary`, background work runs on Tauri's runtime.
pub fn repo_ops(app: &AppHandle) -> crate::ops::RepoOps {
    use std::sync::Arc;
    let busy_app = app.clone();
    let refresh_app = app.clone();
    crate::ops::RepoOps::new(
        Arc::new(move |path, op| {
            let event = crate::commands::RepoBusy { path: path.to_string_lossy().to_string(), op };
            let _ = busy_app.emit("repo-busy", event);
        }),
        Arc::new(move |path| {
            let app = refresh_app.clone();
            Box::pin(async move {
                let git = tauri::Manager::state::<AppState>(&app).git.clone();
                emit_summary(&app, &git, &path).await;
            })
        }),
        Arc::new(|fut| {
            tauri::async_runtime::spawn(fut);
        }),
    )
}
