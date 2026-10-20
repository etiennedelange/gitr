use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gitr_ai::{MessageGenerator, build_prompt};
use gitr_core::branches::Branch;
use gitr_core::diff::{FileDiff, LineStats};
use gitr_core::highlight::DiffSyntax;
use gitr_core::Git;
use gitr_core::error::ErrorKind;
use gitr_core::locate::GitLocation;
use gitr_core::log::{CommitDetails, LogPage, ResetMode, ResetPreview};
use gitr_core::repo::{COMMIT_HOOKS, DiscardOutcome, HookOpts, IntegrateOutcome, LastCommit, PUSH_HOOKS, Prompt, PullOutcome, REVERT_HOOKS, Strategy};
use gitr_core::status::RepoStatus;
use gitr_remote::LinkTarget;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Semaphore;

use crate::config::{self, Config, RepoEntry};
use crate::ops::{Busy, Cancelled, NetOp, RepoOps};
use crate::recycle::RecycleBin;
use crate::state::{AppState, CmdError, RepoSummary, emit_summary, summarize};

type Res<T> = Result<T, CmdError>;

const MAX_AI_DIFF_BYTES: usize = 60_000;

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Config {
    state.config()
}

#[tauri::command]
pub fn save_config(app: AppHandle, state: State<'_, AppState>, config: Config) -> Res<()> {
    let git_path_changed;
    {
        let mut current = state.config.write().unwrap();
        let config = config::merge_preserving_zoom(config, &current);
        config::save(&state.dir, &config).map_err(CmdError::msg)?;
        state.ai.set_model(config.copilot_model.clone());
        git_path_changed = current.git_path != config.git_path;
        *current = config;
    }
    if git_path_changed {
        state.relocate_git();
    }
    restart_watcher(&app);
    Ok(())
}

/// Applies a UI zoom level (percent) to the webview and persists it immediately.
#[tauri::command]
pub fn set_zoom(window: tauri::WebviewWindow, state: State<'_, AppState>, zoom: u32) -> Res<u32> {
    let zoom = config::normalize_zoom(zoom);
    window.set_zoom(zoom as f64 / 100.0).map_err(|e| CmdError::msg(e.to_string()))?;
    let mut current = state.config.write().unwrap();
    let mut next = current.clone();
    next.zoom = zoom;
    config::save(&state.dir, &next).map_err(CmdError::msg)?;
    *current = next;
    Ok(zoom)
}

fn devtools_allowed(state: &AppState) -> bool {
    cfg!(debug_assertions) || state.config().devtools
}

/// Whether dev tools can be opened (always in debug builds, otherwise per the Settings flag).
#[tauri::command]
pub fn devtools_available(state: State<'_, AppState>) -> bool {
    devtools_allowed(&state)
}

/// Opens the dev tools if allowed; returns whether they were opened.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow, state: State<'_, AppState>) -> bool {
    let allowed = devtools_allowed(&state);
    if allowed {
        window.open_devtools();
    }
    allowed
}

pub fn restart_watcher(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.watcher.lock().unwrap();
    *slot = None;
    *slot = crate::watcher::start(app);
}

/// Which git is used, its version, and whether it is usable.
#[tauri::command]
pub fn git_info(state: State<'_, AppState>) -> GitLocation {
    state.git_location()
}

/// Sets (or clears, with `null`) the Git path, saves it and switches to it immediately.
#[tauri::command]
pub fn set_git_path(state: State<'_, AppState>, path: Option<String>) -> Res<GitLocation> {
    {
        let mut current = state.config.write().unwrap();
        let mut next = current.clone();
        next.git_path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).map(PathBuf::from);
        config::save(&state.dir, &next).map_err(CmdError::msg)?;
        *current = next;
    }
    Ok(state.relocate_git())
}

/// Looks for git again ("Check again" after installing it).
#[tauri::command]
pub fn recheck_git(state: State<'_, AppState>) -> GitLocation {
    state.relocate_git()
}

/// Deletes a lock file git left behind. Refused while Gitr itself is working on the repo,
/// and only for a `*.lock` file inside the repo's git folder.
#[tauri::command]
pub async fn remove_stale_lock(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, lock: String) -> Res<()> {
    let repo = state.known_repo(&path)?;
    if ops.is_busy(&repo) {
        return Err(CmdError::msg("Gitr is still working on this repository; wait for it to finish."));
    }
    let git_dir = state.git.git_dir(&repo).await?;
    check_lock_file(&git_dir, Path::new(&lock))?;
    std::fs::remove_file(&lock).map_err(|e| CmdError::msg(format!("Couldn't remove {lock}: {e}")))?;
    tracing::info!(target: "gitr", %lock, "removed stale lock");
    ops.request_refresh(&repo);
    Ok(())
}

/// `lock` must be an existing `*.lock` file inside `git_dir`.
fn check_lock_file(git_dir: &Path, lock: &Path) -> Res<()> {
    let bad = || CmdError::msg(format!("Not a git lock file of this repository: {}", lock.display()));
    let name_ok = lock.file_name().is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().ends_with(".lock"));
    let (Ok(lock), Ok(git_dir)) = (std::fs::canonicalize(lock), std::fs::canonicalize(git_dir)) else {
        return Err(bad());
    };
    if name_ok && lock.is_file() && lock.starts_with(&git_dir) { Ok(()) } else { Err(bad()) }
}

/// Adds the repo to `safe.directory` in the global git config ("Trust this folder").
#[tauri::command]
pub async fn trust_folder(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<()> {
    let repo = state.known_repo(&path)?;
    state.git.trust_folder(&repo).await?;
    tracing::info!(target: "gitr", repo = %repo.display(), "added to safe.directory");
    ops.request_refresh(&repo);
    Ok(())
}

/// How the repo integrates a diverged branch (`pull.rebase`, else the Settings default).
#[tauri::command]
pub async fn pull_strategy(state: State<'_, AppState>, path: String) -> Res<Strategy> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.pull_strategy(&repo, state.config().diverged_strategy).await?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub strategy: Strategy,
}

/// Fetches (joining a running fetch), then reports how the branch relates to its upstream:
/// the basis for fast-forward vs. rebase/merge and for the confirmation's commit counts.
#[tauri::command]
pub async fn divergence(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<Divergence> {
    let repo = state.known_repo(&path)?;
    fetch_shared(&ops, &state.git, &repo, Prompt::Allowed).await?;
    ops.request_refresh(&repo);
    let st = state.git.status(&repo).await?;
    let strategy = state.git.pull_strategy(&repo, state.config().diverged_strategy).await?;
    Ok(Divergence { branch: st.branch, upstream: st.upstream, ahead: st.ahead, behind: st.behind, strategy })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrateResult {
    pub outcome: IntegrateOutcome,
    pub strategy: Strategy,
    /// Whether it pushed afterwards (only when asked and the branch integrated).
    pub pushed: bool,
}

/// Rebases onto / merges the upstream (per `pull_strategy`), under the write lock. With `push`,
/// pushes afterwards when the branch integrated (also if only putting back the stashed changes
/// conflicted: that concerns the working copy, not the commits).
#[tauri::command]
pub async fn integrate(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, push: bool) -> Res<IntegrateResult> {
    let repo = state.known_repo(&path)?;
    let git = &state.git;
    let strategy = git.pull_strategy(&repo, state.config().diverged_strategy).await?;
    let label = match strategy {
        Strategy::Rebase => "rebasing",
        Strategy::Merge => "merging",
    };
    write_op(&ops, &state.git, &repo, label, async {
        let outcome = git.integrate(&repo, strategy).await?;
        let integrated = matches!(outcome, IntegrateOutcome::Done | IntegrateOutcome::StashConflict { .. });
        let pushed = push && integrated;
        if pushed {
            git.push(&repo).await?;
        }
        Ok(IntegrateResult { outcome, strategy, pushed })
    })
    .await
}

/// Continues the rebase / merge / cherry-pick / revert / `git am` in progress once nothing is
/// conflicted.
#[tauri::command]
pub async fn continue_operation(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<IntegrateOutcome> {
    let repo = state.known_repo(&path)?;
    write_op(&ops, &state.git, &repo, "continuing", state.git.continue_operation(&repo)).await
}

/// Skips the commit a rebase, cherry-pick, revert or `git am` stopped on.
#[tauri::command]
pub async fn skip_operation(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<IntegrateOutcome> {
    let repo = state.known_repo(&path)?;
    write_op(&ops, &state.git, &repo, "skipping", state.git.skip_operation(&repo)).await
}

/// Aborts the merge, rebase, cherry-pick, revert or `git am` in progress, or ends a bisect.
#[tauri::command]
pub async fn abort_operation(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<()> {
    let repo = state.known_repo(&path)?;
    write_op(&ops, &state.git, &repo, "aborting", state.git.abort_operation(&repo)).await
}

/// The prepared message of an in-progress merge, for prefilling the commit box.
#[tauri::command]
pub async fn merge_message(state: State<'_, AppState>, path: String) -> Res<Option<String>> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.merge_message(&repo).await?)
}

/// Opens `%APPDATA%\gitr\logs` in Explorer (creating it if needed).
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Res<String> {
    let dir = config::logs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| CmdError::msg(e.to_string()))?;
    let path = dir.to_string_lossy().to_string();
    app.opener().open_path(&path, None::<&str>).map_err(|e| CmdError::msg(e.to_string()))?;
    Ok(path)
}

#[tauri::command]
pub fn list_repos(state: State<'_, AppState>) -> Vec<RepoEntry> {
    state.repos()
}

#[tauri::command]
pub async fn rescan_repos(app: AppHandle, state: State<'_, AppState>) -> Res<Vec<RepoEntry>> {
    let config = state.config();
    let repos = tokio::task::spawn_blocking(move || config::discover_repos(&config))
    .await
    .map_err(|e| CmdError::msg(e.to_string()))?;
    let _ = config::save_repo_cache(&state.dir, &repos);
    *state.repos.write().unwrap() = repos.clone();
    restart_watcher(&app);
    Ok(repos)
}

/// Refreshes every repo concurrently; results stream to the UI as `repo-summary` events.
#[tauri::command]
pub async fn refresh_all(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    let sem = Arc::new(Semaphore::new(state.config().concurrency.max(1) * 2));
    let mut tasks = Vec::new();
    for repo in state.repos() {
        let (app, git, sem) = (app.clone(), state.git.clone(), sem.clone());
        tasks.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            emit_summary(&app, &git, &PathBuf::from(repo.path)).await;
        }));
    }
    for t in tasks {
        let _ = t.await;
    }
    Ok(())
}

#[tauri::command]
pub async fn repo_summary(state: State<'_, AppState>, path: String) -> Res<RepoSummary> {
    let repo = state.known_repo(&path)?;
    Ok(summarize(&state.git, &repo).await)
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BatchOp {
    Fetch,
    Pull,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub path: String,
    pub op: BatchOp,
    /// running | ok | skipped | error
    pub state: &'static str,
    pub message: Option<String>,
    /// For `error`: what went wrong.
    pub kind: Option<ErrorKind>,
    /// The repo failed only because a sign-in is needed, which batches never ask for; the UI
    /// offers one Sign in for these (see `batch_one`).
    pub sign_in: bool,
}

/// One repo's result in a batch.
#[derive(Debug, Clone, PartialEq)]
struct BatchResult {
    state: &'static str,
    message: Option<String>,
    kind: Option<ErrorKind>,
    sign_in: bool,
}

impl BatchResult {
    fn new(state: &'static str, message: Option<String>) -> Self {
        Self { state, message, kind: None, sign_in: false }
    }
}

/// The error is missing or refused credentials, which a sign-in can fix (not a 403, a changed
/// host key or a missing repository).
fn wants_sign_in(e: &CmdError) -> bool {
    e.kind == ErrorKind::Auth && e.detail.as_deref().is_some_and(gitr_core::error::needs_sign_in)
}

/// Runs a write on `repo` under its write lock (FIFO), then refreshes it once the lock is free.
async fn write_op<T>(
    ops: &RepoOps,
    git: &Git,
    repo: &Path,
    op: &'static str,
    work: impl Future<Output = Result<T, gitr_core::GitError>>,
) -> Res<T> {
    let started = AtomicBool::new(false);
    let result = ops
        .cancellable(repo, async {
            let guard = ops.write(repo, op).await;
            started.store(true, Ordering::Relaxed);
            let result = work.await;
            // Deferred by the gate until the guard below is dropped, so it runs after the write.
            ops.request_refresh(repo);
            drop(guard);
            result
        })
        .await;
    match result {
        Ok(result) => Ok(result?),
        Err(Cancelled) => Err(stopped(ops, git, repo, op, started.load(Ordering::Relaxed)).await),
    }
}

/// The error for an operation the user stopped. A write killed mid-way can leave `index.lock`
/// behind (on Windows git gets no chance to remove it); then it is reported as a lock error, so
/// the UI offers **Remove stale lock**.
async fn stopped(ops: &RepoOps, git: &Git, repo: &Path, op: &str, wrote: bool) -> CmdError {
    ops.request_refresh(repo);
    let repo_str = Some(repo.to_string_lossy().into_owned());
    if wrote
        && let Ok(git_dir) = git.git_dir(repo).await
        && let lock = git_dir.join("index.lock")
        && lock.is_file()
    {
        return CmdError {
            message: format!("Stopped {op}. Git was stopped mid-write and left a lock file behind."),
            detail: None,
            kind: ErrorKind::Lock,
            repo: repo_str,
            lock_path: Some(lock.to_string_lossy().into_owned()),
            hook: None,
        };
    }
    CmdError { message: format!("Stopped {op}."), detail: None, kind: ErrorKind::Cancelled, repo: repo_str, lock_path: None, hook: None }
}

/// Refreshes the repo's summary (and with it every view of the repo), merged with a refresh
/// already queued. The UI asks for it when the window gets focus.
#[tauri::command]
pub fn refresh_repo(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<()> {
    let repo = state.known_repo(&path)?;
    ops.request_refresh(&repo);
    Ok(())
}

/// Stops what Gitr is doing in the repo: the running operation and everything queued behind
/// it. Each stopped call returns a `cancelled` (or `lock`) error. Returns whether anything ran.
#[tauri::command]
pub fn cancel_operation(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<bool> {
    let repo = state.known_repo(&path)?;
    Ok(ops.cancel(&repo))
}

/// `git fetch`, shared with a fetch of the same repo that is already running. Fetch takes no
/// write lock (it only updates remote-tracking refs) but shows the repo as busy.
async fn fetch_shared(ops: &RepoOps, git: &Git, repo: &Path, prompt: Prompt) -> Res<()> {
    let (result, ran_with) = fetch_joined(ops, git, repo, prompt).await;
    // A single action that joined a batch's fetch got that fetch's answer, which never had the
    // chance to sign in: fetch again, allowed to prompt.
    if prompt == Prompt::Allowed && ran_with == Prompt::Never && result.as_ref().is_err_and(wants_sign_in) {
        return fetch_joined(ops, git, repo, prompt).await.0;
    }
    result
}

/// The fetch (run, or joined while running) and the prompt mode it ran with.
async fn fetch_joined(ops: &RepoOps, git: &Git, repo: &Path, prompt: Prompt) -> (Res<()>, Prompt) {
    // Cancelled inside the join, so callers waiting on this fetch get the cancel too instead of
    // starting a new fetch.
    ops.join(repo, NetOp::Fetch, || async {
        let fetch = ops.cancellable(repo, async {
            let _busy = ops.activity(repo, "fetching");
            git.fetch_with(repo, prompt).await.map_err(CmdError::from)
        });
        let result = match fetch.await {
            Ok(result) => result,
            Err(Cancelled) => Err(stopped(ops, git, repo, "fetching", false).await),
        };
        (result, prompt)
    })
    .await
}

/// Fetch + fast-forward under the write lock, shared with a pull of the same repo that is
/// already running. The fetch part joins a running fetch. Like `fetch_shared`, a single action
/// that joined a batch's pull which needed a sign-in pulls again, allowed to prompt.
async fn pull_shared(ops: &RepoOps, git: &Git, repo: &Path, prompt: Prompt) -> Res<PullOutcome> {
    let (result, ran_with) = pull_joined(ops, git, repo, prompt).await;
    if prompt == Prompt::Allowed && ran_with == Prompt::Never && result.as_ref().is_err_and(wants_sign_in) {
        return pull_joined(ops, git, repo, prompt).await.0;
    }
    result
}

async fn pull_joined(ops: &RepoOps, git: &Git, repo: &Path, prompt: Prompt) -> (Res<PullOutcome>, Prompt) {
    ops.join(repo, NetOp::Pull, || async {
        let merging = AtomicBool::new(false);
        let pull = ops.cancellable(repo, async {
            let guard = ops.write(repo, "pulling").await;
            let result = match fetch_shared(ops, git, repo, prompt).await {
                Ok(()) => {
                    merging.store(true, Ordering::Relaxed);
                    git.fast_forward(repo).await.map_err(CmdError::from)
                }
                Err(e) => Err(e),
            };
            ops.request_refresh(repo);
            drop(guard);
            result
        });
        let result = match pull.await {
            Ok(result) => result,
            Err(Cancelled) => Err(stopped(ops, git, repo, "pulling", merging.load(Ordering::Relaxed)).await),
        };
        (result, prompt)
    })
    .await
}

fn pull_message(o: PullOutcome) -> (&'static str, Option<String>) {
    match o {
        PullOutcome::FastForwarded => ("ok", Some("Fast-forwarded".to_string())),
        PullOutcome::UpToDate => ("ok", Some("Up to date".to_string())),
        PullOutcome::NoUpstream => ("skipped", Some("No upstream branch".to_string())),
        PullOutcome::Diverged => ("skipped", Some("Diverged from upstream. Open the repo to rebase or merge.".to_string())),
    }
}

pub fn busy_message(busy: Busy) -> String {
    format!("busy ({})", busy.0)
}

/// One repo of a batch. Joins the same operation if it is already running; otherwise a
/// non-interactive batch skips a repo that has a write running or queued, and an interactive
/// request (repo view, sidebar menu, Sign in) waits its turn. Only an interactive request may
/// show a sign-in window; in a batch, missing credentials fail fast with `sign_in` set.
async fn batch_one(ops: &RepoOps, git: &Git, repo: &Path, op: BatchOp, interactive: bool) -> BatchResult {
    let net = match op {
        BatchOp::Fetch => NetOp::Fetch,
        BatchOp::Pull => NetOp::Pull,
    };
    if !interactive
        && !ops.is_inflight(repo, net)
        && let Some(busy) = ops.busy_write(repo)
    {
        return BatchResult::new("skipped", Some(busy_message(busy)));
    }
    // `git fetch` with no remote exits 0 having done nothing; don't report that as a fetch.
    if op == BatchOp::Fetch && matches!(git.has_remote(repo).await, Ok(false)) {
        return BatchResult::new("skipped", Some("No remote".to_string()));
    }
    let prompt = if interactive { Prompt::Allowed } else { Prompt::Never };
    let result = match op {
        BatchOp::Fetch => fetch_shared(ops, git, repo, prompt).await.map(|()| ("ok", None)),
        BatchOp::Pull => pull_shared(ops, git, repo, prompt).await.map(pull_message),
    };
    if op == BatchOp::Fetch {
        ops.request_refresh(repo);
    }
    match result {
        Ok((state, message)) => BatchResult::new(state, message),
        Err(e) if e.kind == ErrorKind::Cancelled => BatchResult::new("skipped", Some(e.message)),
        Err(e) if !interactive && wants_sign_in(&e) => {
            BatchResult { state: "error", message: Some("Sign-in needed".to_string()), kind: Some(e.kind), sign_in: true }
        }
        Err(e) => BatchResult { state: "error", message: Some(e.message), kind: Some(e.kind), sign_in: false },
    }
}

/// Fetch or fast-forward pull many repos with bounded concurrency. Failures never abort the batch.
/// `interactive` = a single user action (repo view): wait for a busy repo instead of skipping it.
#[tauri::command]
pub async fn run_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    ops: State<'_, RepoOps>,
    op: BatchOp,
    paths: Vec<String>,
    interactive: Option<bool>,
) -> Res<Vec<BatchProgress>> {
    let interactive = interactive.unwrap_or(false);
    let paths: Vec<PathBuf> = paths.iter().map(|p| state.known_repo(p)).collect::<Res<_>>()?;
    let sem = Arc::new(Semaphore::new(state.config().concurrency.max(1)));
    let mut tasks = Vec::new();
    for repo in paths {
        let (app, git, sem, ops) = (app.clone(), state.git.clone(), sem.clone(), ops.inner().clone());
        tasks.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let path = repo.to_string_lossy().to_string();
            let emit = |r: BatchResult| {
                let p = BatchProgress { path: path.clone(), op, state: r.state, message: r.message, kind: r.kind, sign_in: r.sign_in };
                let _ = app.emit("batch-progress", p.clone());
                p
            };
            emit(BatchResult::new("running", None));
            emit(batch_one(&ops, &git, &repo, op, interactive).await)
        }));
    }
    let mut out = Vec::new();
    for t in tasks {
        if let Ok(p) = t.await {
            out.push(p);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBusy {
    pub path: String,
    /// The running operation (e.g. "committing"); `None` = idle.
    pub op: Option<&'static str>,
}

/// Repos busy right now (initial state for the UI; changes arrive as `repo-busy` events).
#[tauri::command]
pub fn busy_repos(ops: State<'_, RepoOps>) -> Vec<RepoBusy> {
    ops.busy_repos()
        .into_iter()
        .map(|(path, op)| RepoBusy { path: path.to_string_lossy().to_string(), op: Some(op) })
        .collect()
}

#[tauri::command]
pub async fn repo_status(state: State<'_, AppState>, path: String) -> Res<RepoStatus> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.status(&repo).await?)
}

#[tauri::command]
pub async fn line_stats(state: State<'_, AppState>, path: String) -> Res<LineStats> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.line_stats(&repo).await?)
}

#[tauri::command]
pub async fn stage(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, files: Vec<String>) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let git = &state.git;
    write_op(&ops, &state.git, &repo, "staging", async {
        if files.is_empty() { git.stage_all(&repo).await } else { git.stage(&repo, &files).await }
    })
    .await
}

#[tauri::command]
pub async fn unstage(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, files: Vec<String>) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let git = &state.git;
    write_op(&ops, &state.git, &repo, "unstaging", async {
        if files.is_empty() { git.unstage_all(&repo).await } else { git.unstage(&repo, &files).await }
    })
    .await
}

/// Discards changes. Normally every discarded file goes to the Recycle Bin first; files the bin
/// can't take are left untouched and returned in `failed`. `permanent` is only sent after the
/// user explicitly agreed to lose exactly those files.
#[tauri::command]
pub async fn discard(
    state: State<'_, AppState>,
    ops: State<'_, RepoOps>,
    path: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
    permanent: Option<bool>,
) -> Res<DiscardOutcome> {
    let repo = state.known_repo(&path)?;
    let git = &state.git;
    write_op(&ops, &state.git, &repo, "discarding", async {
        if permanent.unwrap_or(false) {
            git.discard_permanently(&repo, &tracked, &untracked).await.map(|()| DiscardOutcome::default())
        } else {
            git.discard(&repo, &tracked, &untracked, Arc::new(RecycleBin)).await
        }
    })
    .await
}

/// The last commit if it can be undone (unpushed, not a merge), else null.
#[tauri::command]
pub async fn last_commit_undo(state: State<'_, AppState>, path: String) -> Res<Option<LastCommit>> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.last_commit_undo(&repo).await?)
}

/// Undoes the last commit (changes stay staged); returns its message for the commit box.
#[tauri::command]
pub async fn undo_last_commit(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String) -> Res<String> {
    let repo = state.known_repo(&path)?;
    write_op(&ops, &state.git, &repo, "undoing commit", state.git.undo_last_commit(&repo)).await
}

#[tauri::command]
pub async fn file_diff(
    state: State<'_, AppState>,
    path: String,
    file: String,
    staged: bool,
    untracked: bool,
    full: bool,
) -> Res<FileDiff> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.diff_file(&repo, &file, staged, untracked, full).await?)
}

/// Syntax colours for `file_diff`'s lines. Separate, so the diff shows before colouring is done.
#[tauri::command]
pub async fn file_diff_syntax(
    state: State<'_, AppState>,
    path: String,
    file: String,
    staged: bool,
    untracked: bool,
    full: bool,
) -> Res<DiffSyntax> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.diff_file_syntax(&repo, &file, staged, untracked, full).await?)
}

/// A commit id from the UI: hex only, so nothing else (an option, a revision expression) reaches git.
fn sha_arg(sha: &str) -> Res<&str> {
    let sha = sha.trim();
    if gitr_core::log::is_object_id(sha) {
        Ok(sha)
    } else {
        Err(CmdError::msg(format!("Not a commit id: {sha:?}")))
    }
}

/// HEAD's history, newest first (a page of at most 1000 commits).
#[tauri::command]
pub async fn log(state: State<'_, AppState>, path: String, skip: usize, limit: usize) -> Res<LogPage> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.log(&repo, skip, limit.clamp(1, 1000)).await?)
}

#[tauri::command]
pub async fn commit_details(state: State<'_, AppState>, path: String, sha: String) -> Res<CommitDetails> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.commit_details(&repo, sha_arg(&sha)?).await?)
}

#[tauri::command]
pub async fn commit_file_diff(
    state: State<'_, AppState>,
    path: String,
    sha: String,
    file: String,
    orig_path: Option<String>,
    full: bool,
) -> Res<FileDiff> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.commit_file_diff(&repo, sha_arg(&sha)?, &file, orig_path.as_deref(), full).await?)
}

#[tauri::command]
pub async fn commit_file_diff_syntax(
    state: State<'_, AppState>,
    path: String,
    sha: String,
    file: String,
    orig_path: Option<String>,
    full: bool,
) -> Res<DiffSyntax> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.commit_file_diff_syntax(&repo, sha_arg(&sha)?, &file, orig_path.as_deref(), full).await?)
}

/// What a reset to `sha` would take off the branch, for the Reset dialog.
#[tauri::command]
pub async fn reset_preview(state: State<'_, AppState>, path: String, sha: String) -> Res<ResetPreview> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.reset_preview(&repo, sha_arg(&sha)?).await?)
}

/// Adds a commit that undoes `sha`. Stops in the Reverting state on conflicts. Hook output goes
/// to the hook panel; `git revert` has no `--no-verify`, so there is no "without hooks" here.
#[tauri::command]
pub async fn revert_commit(app: AppHandle, state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, sha: String) -> Res<IntegrateOutcome> {
    let repo = state.known_repo(&path)?;
    let sha = sha_arg(&sha)?;
    let git = &state.git;
    let run = async |hooks: HookOpts<'_>| git.revert_with(&repo, sha, hooks).await;
    let work = with_hook_output(&app, git, &repo, REVERT_HOOKS, "commit", run, false);
    write_op(&ops, git, &repo, "reverting", work).await
}

/// Moves the branch back to `sha` (soft or mixed; never hard). Returns the previous HEAD, which
/// Undo reset takes.
#[tauri::command]
pub async fn reset_branch(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, sha: String, mode: ResetMode) -> Res<String> {
    let repo = state.known_repo(&path)?;
    let sha = sha_arg(&sha)?;
    let git = &state.git;
    let work = async {
        let branch = git.head_ref(&repo).await?;
        git.reset(&repo, sha, mode).await.map(|previous| (branch, previous))
    };
    let (branch, previous) = write_op(&ops, git, &repo, "resetting", work).await?;
    state.resets.lock().unwrap().insert(repo, (branch, previous.clone()));
    Ok(previous)
}

/// Undoes the last reset of this repo (only to the HEAD that reset recorded, and only while
/// that is still ahead of HEAD: a commit made since is never thrown away).
#[tauri::command]
pub async fn undo_reset(state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, previous_head: String) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let previous = sha_arg(&previous_head)?.to_string();
    let branch = match state.resets.lock().unwrap().get(&repo) {
        Some((branch, head)) if *head == previous => branch.clone(),
        _ => return Err(CmdError::msg("There is no reset to undo for this repository.")),
    };
    write_op(&ops, &state.git, &repo, "undoing reset", state.git.undo_reset(&repo, &previous, branch.as_deref())).await?;
    state.resets.lock().unwrap().remove(&repo);
    Ok(())
}

/// A line of hook output for the repo view (`hook-output`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutput {
    pub path: String,
    pub line: String,
}

/// Runs `run` with hook output sent to the UI as `hook-output` events, once `hooks-started`
/// said that hooks are about to run. Without installed hooks nothing is sent.
async fn with_hook_output<T>(
    app: &AppHandle,
    git: &Git,
    repo: &Path,
    names: &[&str],
    op: &'static str,
    run: impl AsyncFnOnce(HookOpts<'_>) -> Result<T, gitr_core::GitError>,
    skip: bool,
) -> Result<T, gitr_core::GitError> {
    let path = repo.to_string_lossy().into_owned();
    if !git.has_hooks(repo, names).await {
        return run(HookOpts { skip, on_output: None }).await;
    }
    let _ = app.emit("hooks-started", serde_json::json!({ "path": path, "op": op }));
    let emit = |line: &str| {
        let _ = app.emit("hook-output", HookOutput { path: path.clone(), line: line.to_string() });
    };
    run(HookOpts { skip, on_output: Some(&emit) }).await
}

/// Commits the staged changes. `skip_hooks` (`--no-verify`) is only sent after the user chose
/// to commit without the hook that rejected the commit.
#[tauri::command]
pub async fn commit(
    app: AppHandle,
    state: State<'_, AppState>,
    ops: State<'_, RepoOps>,
    path: String,
    message: String,
    amend: bool,
    skip_hooks: Option<bool>,
) -> Res<String> {
    let repo = state.known_repo(&path)?;
    let git = &state.git;
    let run = async |hooks: HookOpts<'_>| git.commit_with(&repo, &message, amend, hooks).await;
    let work = with_hook_output(&app, git, &repo, COMMIT_HOOKS, "commit", run, skip_hooks.unwrap_or(false));
    write_op(&ops, git, &repo, "committing", work).await
}

#[tauri::command]
pub async fn last_commit_message(state: State<'_, AppState>, path: String) -> Res<String> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.last_commit_message(&repo).await?)
}

/// Pushes the current branch. `skip_hooks` as for `commit`.
#[tauri::command]
pub async fn push(app: AppHandle, state: State<'_, AppState>, ops: State<'_, RepoOps>, path: String, skip_hooks: Option<bool>) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let git = &state.git;
    let run = async |hooks: HookOpts<'_>| git.push_with(&repo, hooks).await;
    let work = with_hook_output(&app, git, &repo, PUSH_HOOKS, "push", run, skip_hooks.unwrap_or(false));
    write_op(&ops, git, &repo, "pushing", work).await
}

#[tauri::command]
pub async fn branches(state: State<'_, AppState>, path: String) -> Res<Vec<Branch>> {
    let repo = state.known_repo(&path)?;
    Ok(state.git.branches(&repo).await?)
}

fn branch_arg(name: &str) -> Res<&str> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(CmdError::msg(format!("Invalid branch name: {name:?}")));
    }
    Ok(name)
}

#[tauri::command]
pub async fn checkout(
    state: State<'_, AppState>,
    ops: State<'_, RepoOps>,
    path: String,
    branch: String,
    remote: bool,
) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let branch = branch_arg(&branch)?;
    write_op(&ops, &state.git, &repo, "checking out", state.git.checkout(&repo, branch, remote)).await
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    ops: State<'_, RepoOps>,
    path: String,
    name: String,
    start: Option<String>,
    checkout: bool,
) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let start = start.as_deref().map(branch_arg).transpose()?;
    let name = branch_arg(&name)?;
    write_op(&ops, &state.git, &repo, "creating branch", state.git.create_branch(&repo, name, start, checkout)).await
}

#[tauri::command]
pub async fn delete_branch(
    state: State<'_, AppState>,
    ops: State<'_, RepoOps>,
    path: String,
    name: String,
    force: bool,
) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let name = branch_arg(&name)?;
    write_op(&ops, &state.git, &repo, "deleting branch", state.git.delete_branch(&repo, name, force)).await
}

#[tauri::command]
pub async fn open_remote(app: AppHandle, state: State<'_, AppState>, path: String, target: LinkTarget) -> Res<String> {
    let repo = state.known_repo(&path)?;
    let info = tokio::task::spawn_blocking(move || gitr_core::info::read_info(&repo))
        .await
        .unwrap_or_default();
    let url = info.remote_url.ok_or_else(|| CmdError::msg("Repository has no remote"))?;
    let remote = gitr_remote::parse(&url)
        .ok_or_else(|| CmdError::msg(format!("Unsupported remote host: {url}")))?;
    let link = gitr_remote::link(&remote, &target);
    app.opener().open_url(&link, None::<&str>).map_err(|e| CmdError::msg(e.to_string()))?;
    Ok(link)
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenWith {
    Explorer,
    Terminal,
    VsCode,
}

#[tauri::command]
pub fn open_with(app: AppHandle, state: State<'_, AppState>, path: String, app_kind: OpenWith) -> Res<()> {
    let repo = state.known_repo(&path)?;
    let spawn = |program: &str, args: &[&str]| {
        std::process::Command::new(program)
            .args(args)
            .current_dir(&repo)
            .spawn()
            .map(|_| ())
            .map_err(|e| CmdError::msg(format!("Could not start {program}: {e}")))
    };
    match app_kind {
        OpenWith::Explorer => app
            .opener()
            .open_path(repo.to_string_lossy(), None::<&str>)
            .map_err(|e| CmdError::msg(e.to_string())),
        // Never through `cmd /c`: cmd looks in the current directory first, so a repository that
        // contains its own `code.bat` or `powershell.exe` would run it. Programs started directly
        // are found on PATH and in system folders only, never in `repo`.
        OpenWith::Terminal => spawn("wt.exe", &["-d", "."]).or_else(|_| spawn("powershell.exe", &[])),
        OpenWith::VsCode => spawn("code.cmd", &["."]),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiDelta {
    path: String,
    text: String,
}

#[tauri::command]
pub async fn generate_commit_message(app: AppHandle, state: State<'_, AppState>, path: String) -> Res<String> {
    let repo = state.known_repo(&path)?;
    let changes = state.git.staged_changes(&repo, MAX_AI_DIFF_BYTES).await?;
    if changes.diff.trim().is_empty() {
        return Err(gitr_ai::AiError::NothingStaged.into());
    }
    let ai = state.ai.clone();
    let emit_path = path.clone();
    let task = tokio::spawn(async move {
        ai.generate(
            build_prompt(&changes),
            Box::new(move |d| {
                let _ = app.emit("ai-delta", AiDelta { path: emit_path.clone(), text: d.to_string() });
            }),
        )
        .await
    });
    if let Some(prev) = state.generation.lock().unwrap().replace(task.abort_handle()) {
        prev.abort();
    }
    match task.await {
        Ok(r) => Ok(r?),
        Err(e) if e.is_cancelled() => Err(CmdError::msg("Cancelled")),
        Err(e) => Err(CmdError::msg(e.to_string())),
    }
}

#[tauri::command]
pub fn cancel_generation(state: State<'_, AppState>) {
    if let Some(h) = state.generation.lock().unwrap().take() {
        h.abort();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    name: String,
}

#[tauri::command]
pub async fn list_models(state: State<'_, AppState>) -> Res<Vec<ModelInfo>> {
    let models = state.ai.list_models().await?;
    Ok(models.into_iter().map(|(id, name)| ModelInfo { id, name }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gitr_core::GitRunner;

    #[test]
    fn sha_arg_accepts_only_commit_ids() {
        assert_eq!(sha_arg(" abc1234 ").unwrap(), "abc1234");
        assert!(sha_arg(&"f".repeat(64)).is_ok());
        for bad in ["--output=x", "HEAD", "a b", "abc", &"a".repeat(65), "abcd^"] {
            assert!(sha_arg(bad).is_err(), "{bad}");
        }
    }
    use gitr_core::runner::EnvOp;
    use std::time::Duration;

    fn env() -> Vec<EnvOp> {
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        vec![
            EnvOp::remove("GIT_DIR"),
            EnvOp::set("GIT_CONFIG_NOSYSTEM", "1"),
            EnvOp::set("GIT_CONFIG_GLOBAL", null),
            EnvOp::set("GIT_AUTHOR_NAME", "T"),
            EnvOp::set("GIT_AUTHOR_EMAIL", "t@example.com"),
            EnvOp::set("GIT_COMMITTER_NAME", "T"),
            EnvOp::set("GIT_COMMITTER_EMAIL", "t@example.com"),
        ]
    }

    fn git_cmd(dir: &Path, args: &[&str]) {
        let mut cmd = std::process::Command::new("git");
        cmd.current_dir(dir).args(args);
        for op in env() {
            match op {
                EnvOp::Set(k, v) => cmd.env(k, v),
                EnvOp::Remove(k) => cmd.env_remove(k),
            };
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A clone of a bare remote with one commit; returns (tempdir, clone path, remote path).
    fn cloned_repo() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        let seed = tmp.path().join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git_cmd(tmp.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        git_cmd(&seed, &["init", "-q", "-b", "main"]);
        std::fs::write(seed.join("f.txt"), "1\n").unwrap();
        git_cmd(&seed, &["add", "."]);
        git_cmd(&seed, &["commit", "-q", "-m", "c1"]);
        git_cmd(&seed, &["push", "-q", remote.to_str().unwrap(), "main"]);
        let repo = tmp.path().join("repo");
        git_cmd(tmp.path(), &["clone", "-q", remote.to_str().unwrap(), repo.to_str().unwrap()]);
        (tmp, repo, remote)
    }

    /// State and message of a batch result (most tests don't look at the kind).
    fn st(r: BatchResult) -> (&'static str, Option<String>) {
        (r.state, r.message)
    }

    fn ops() -> RepoOps {
        RepoOps::new(
            Arc::new(|_, _| {}),
            Arc::new(|_| Box::pin(async {})),
            Arc::new(|f| {
                tokio::spawn(f);
            }),
        )
    }

    fn git() -> Git {
        Git::new(GitRunner::default().with_env_ops(env()))
    }

    /// A dashboard row doesn't make git list every file of an untracked folder; it
    /// counts the folder once. The Changes list (full status) still lists each file.
    #[tokio::test]
    async fn summary_counts_an_untracked_folder_once() {
        let (_t, repo, _remote) = cloned_repo();
        for i in 0..50 {
            std::fs::create_dir_all(repo.join("out")).unwrap();
            std::fs::write(repo.join(format!("out/{i}.o")), "x").unwrap();
        }
        std::fs::write(repo.join("f.txt"), "2\n").unwrap();
        let git = git();
        let summary = crate::state::summarize(&git, &repo).await;
        assert_eq!((summary.staged, summary.unstaged), (0, 2));
        assert_eq!(git.status(&repo).await.unwrap().unstaged_count(), 51);
    }

    /// Fact 5: a non-interactive batch skips a repo with a write running; interactive waits.
    #[tokio::test]
    async fn batch_skips_busy_repo_but_interactive_waits() {
        let (_t, repo, _remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        let guard = ops.write(&repo, "committing").await;
        for op in [BatchOp::Fetch, BatchOp::Pull] {
            let r = st(batch_one(&ops, &git, &repo, op, false).await);
            assert_eq!(r, ("skipped", Some("busy (committing)".to_string())), "{op:?}");
        }
        let (o, g, p) = (ops.clone(), git.clone(), repo.clone());
        let waiting = tokio::spawn(async move { st(batch_one(&o, &g, &p, BatchOp::Pull, true).await) });
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!waiting.is_finished(), "interactive pull must wait for the running write");
        drop(guard);
        assert_eq!(waiting.await.unwrap(), ("ok", Some("Up to date".to_string())));
    }

    /// Fact 6: a fetch while a fetch runs joins it instead of running git again. The running
    /// "fetch" here is a stand-in that never touches git; the joined call gets its result even
    /// though the real remote has been removed (a real fetch would fail).
    #[tokio::test]
    async fn fetch_and_pull_join_running_operations() {
        let (_t, repo, remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        std::fs::remove_dir_all(&remote).unwrap();

        let (o, p) = (ops.clone(), repo.clone());
        let leader = tokio::spawn(async move {
            o.join(&p, NetOp::Fetch, || async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                (Ok::<(), CmdError>(()), Prompt::Never)
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Joins even from a non-interactive batch, and even a pull reuses the running fetch.
        assert_eq!(st(batch_one(&ops, &git, &repo, BatchOp::Fetch, false).await), ("ok", None));
        leader.await.unwrap().0.unwrap();

        // With nothing to join, the same fetch really runs and fails on the missing remote.
        let (state, _) = st(batch_one(&ops, &git, &repo, BatchOp::Fetch, false).await);
        assert_eq!(state, "error");

        // A pull started during a running fetch fetches once (the joined one) and fast-forwards.
        let (o, p) = (ops.clone(), repo.clone());
        let leader = tokio::spawn(async move {
            o.join(&p, NetOp::Fetch, || async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                (Ok::<(), CmdError>(()), Prompt::Never)
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(pull_shared(&ops, &git, &repo, Prompt::Allowed).await.unwrap(), PullOutcome::UpToDate);
        leader.await.unwrap().0.unwrap();
    }

    async fn wait_for(path: &Path) {
        let started = std::time::Instant::now();
        while !path.exists() {
            assert!(started.elapsed() < Duration::from_secs(20), "{} never appeared", path.display());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Stop ends a commit whose hook hangs, and the write queued behind it. git has already
    /// released `index.lock` when it runs pre-commit, so nothing is left behind.
    #[tokio::test]
    async fn stop_ends_a_hung_hook_and_queued_writes() {
        let (_t, repo, _remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        let hook = repo.join(".git/hooks/pre-commit");
        std::fs::write(&hook, "#!/bin/sh\necho > .git/hook-started\nsleep 60\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(repo.join("f.txt"), "2\n").unwrap();
        git_cmd(&repo, &["add", "f.txt"]);

        let (o, g, p) = (ops.clone(), git.clone(), repo.clone());
        let commit = tokio::spawn(async move { write_op(&o, &g, &p, "committing", g.commit(&p, "hung", false)).await });
        wait_for(&repo.join(".git/hook-started")).await;
        let (o, g, p) = (ops.clone(), git.clone(), repo.clone());
        let queued = tokio::spawn(async move { write_op(&o, &g, &p, "staging", g.stage_all(&p)).await });
        tokio::time::sleep(Duration::from_millis(100)).await;

        let started = std::time::Instant::now();
        assert!(ops.cancel(&repo));
        let commit = commit.await.unwrap().unwrap_err();
        let queued = queued.await.unwrap().unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10), "stopping took {:?}", started.elapsed());

        assert_eq!((commit.kind, commit.message.as_str()), (ErrorKind::Cancelled, "Stopped committing."));
        assert_eq!((queued.kind, queued.message.as_str()), (ErrorKind::Cancelled, "Stopped staging."));
        assert!(!repo.join(".git/index.lock").exists());
        assert!(!ops.is_busy(&repo));
        assert!(!ops.cancel(&repo), "nothing left to stop");
        // The staged change is untouched and the repo works again right away.
        std::fs::remove_file(&hook).unwrap();
        write_op(&ops, &git, &repo, "committing", git.commit(&repo, "after stop", false)).await.unwrap();
    }

    /// A checkout stopped while a slow smudge filter (as LFS uses) runs holds `index.lock`; the
    /// stop reports it as a lock error, which the UI offers to remove.
    #[tokio::test]
    async fn stopped_write_reports_the_lock_it_left() {
        let (_t, repo, _remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        git_cmd(&repo, &["switch", "-q", "-c", "big"]);
        std::fs::write(repo.join(".gitattributes"), "*.bin filter=slow\n").unwrap();
        std::fs::write(repo.join("a.bin"), "data\n").unwrap();
        git_cmd(&repo, &["add", "."]);
        git_cmd(&repo, &["commit", "-q", "-m", "bin"]);
        git_cmd(&repo, &["switch", "-q", "main"]);
        git_cmd(&repo, &["config", "filter.slow.clean", "cat"]);
        git_cmd(&repo, &["config", "filter.slow.smudge", "touch .git/smudge-started; sleep 60; cat"]);

        let (o, g, p) = (ops.clone(), git.clone(), repo.clone());
        let checkout = tokio::spawn(async move { write_op(&o, &g, &p, "checking out", g.checkout(&p, "big", false)).await });
        wait_for(&repo.join(".git/smudge-started")).await;
        assert!(ops.cancel(&repo));
        let err = checkout.await.unwrap().unwrap_err();

        assert_eq!(err.kind, ErrorKind::Lock, "{err:?}");
        assert!(err.message.starts_with("Stopped checking out."), "{}", err.message);
        let lock = err.lock_path.expect("the lock git left behind");
        assert!(lock.ends_with("index.lock") && Path::new(&lock).is_file(), "{lock}");
    }

    /// Stopping a fetch also ends the calls joined to it, instead of one of them starting the
    /// fetch again. The remote hangs for 60 s, far longer than the test allows.
    #[tokio::test]
    async fn stop_ends_a_fetch_and_its_joined_callers() {
        let (_t, repo, _remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        git_cmd(&repo, &["config", "protocol.ext.allow", "always"]);
        git_cmd(&repo, &["remote", "set-url", "origin", "ext::sh -c touch% .git/fetch-started;sleep% 60"]);

        let (o, g, p) = (ops.clone(), git.clone(), repo.clone());
        let leader = tokio::spawn(async move { st(batch_one(&o, &g, &p, BatchOp::Fetch, false).await) });
        wait_for(&repo.join(".git/fetch-started")).await;
        let (o, g, p) = (ops.clone(), git.clone(), repo.clone());
        let joined = tokio::spawn(async move { st(batch_one(&o, &g, &p, BatchOp::Pull, true).await) });
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert!(ops.cancel(&repo));
        let both = tokio::time::timeout(Duration::from_secs(10), async { (leader.await.unwrap(), joined.await.unwrap()) });
        let (leader, joined) = both.await.expect("stopped calls must return promptly");
        assert_eq!(leader, ("skipped", Some("Stopped fetching.".to_string())));
        assert_eq!(joined.0, "skipped", "{joined:?}");
        assert!(!ops.is_busy(&repo));
    }

    /// An `ext::` origin whose "server" prints `message` to stderr and fails.
    fn failing_remote(repo: &Path, message: &str) {
        git_cmd(repo, &["config", "protocol.ext.allow", "always"]);
        let escaped = message.replace(' ', "% ").replace('\'', "'\\''");
        git_cmd(repo, &["remote", "set-url", "origin", &format!("ext::sh -c echo% '{escaped}'% >&2;exit% 1")]);
    }

    /// In a batch, missing credentials fail fast as "Sign-in needed" with `sign_in` set (the UI
    /// then offers one Sign in); an interactive fetch reports the full message.
    #[tokio::test]
    async fn batch_reports_sign_in_needed() {
        let (_t, repo, _remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        failing_remote(&repo, "fatal: Authentication failed for 'https://dev.azure.com/acme/'");

        let r = batch_one(&ops, &git, &repo, BatchOp::Fetch, false).await;
        assert_eq!((r.state, r.message.as_deref(), r.kind, r.sign_in), ("error", Some("Sign-in needed"), Some(ErrorKind::Auth), true));
        assert!(batch_one(&ops, &git, &repo, BatchOp::Pull, false).await.sign_in);

        let r = batch_one(&ops, &git, &repo, BatchOp::Fetch, true).await;
        assert_eq!((r.state, r.kind, r.sign_in), ("error", Some(ErrorKind::Auth), false));
        assert_ne!(r.message.as_deref(), Some("Sign-in needed"));
    }

    /// Auth errors that no sign-in fixes count as failures, with a message that doesn't send the
    /// user to sign in: a 403, a changed host key, a missing repository behind SSH.
    #[tokio::test]
    async fn batch_failures_a_sign_in_cannot_fix() {
        let (_t, repo, _remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        for message in [
            "fatal: unable to access 'https://x/': The requested URL returned error: 403",
            "Host key verification failed.",
            "fatal: '/srv/gone.git' does not appear to be a git repository",
        ] {
            failing_remote(&repo, message);
            let r = batch_one(&ops, &git, &repo, BatchOp::Fetch, false).await;
            assert_eq!((r.state, r.sign_in), ("error", false), "{message}: {r:?}");
            let shown = r.message.unwrap_or_default();
            assert!(!shown.contains("Sign-in"), "{message}: {shown}");
        }
    }

    /// A single fetch that joins a batch fetch which needed a sign-in fetches again, allowed to
    /// prompt, instead of taking over the batch's "Sign-in needed".
    #[tokio::test]
    async fn single_fetch_joining_a_batch_may_still_prompt() {
        let (_t, repo, _remote) = cloned_repo();
        let (ops, git) = (ops(), git());
        git_cmd(&repo, &["config", "protocol.ext.allow", "always"]);
        // Slow; refuses with an auth error when told never to prompt (as GCM does), else fails
        // with something else. `.git/runs` logs each run.
        let server = repo.join(".git/server.sh");
        std::fs::write(&server, "echo \"gcm=$GCM_INTERACTIVE\" >> .git/runs\nsleep 1\nif [ \"$GCM_INTERACTIVE\" = never ]; then echo 'fatal: Authentication failed for x' >&2; else echo 'fatal: other' >&2; fi\nexit 1\n").unwrap();
        git_cmd(&repo, &["remote", "set-url", "origin", &format!("ext::sh {}", server.display())]);

        let (o, g, p) = (ops.clone(), git.clone(), repo.clone());
        let batch = tokio::spawn(async move { fetch_shared(&o, &g, &p, Prompt::Never).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let single = fetch_shared(&ops, &git, &repo, Prompt::Allowed).await;
        let batch = batch.await.unwrap();

        assert!(batch.as_ref().is_err_and(wants_sign_in), "{batch:?}");
        assert!(single.as_ref().is_err_and(|e| !wants_sign_in(e)), "the single fetch ran itself: {single:?}");
        let runs = std::fs::read_to_string(repo.join(".git/runs")).unwrap();
        // The second run keeps the inherited value (GitHub's Windows runners set `Never`).
        let inherited = std::env::var("GCM_INTERACTIVE").unwrap_or_default();
        assert_eq!(runs, format!("gcm=never\ngcm={inherited}\n"), "one batch run, then one run allowed to prompt");
    }

    /// "Remove stale lock" only ever deletes an existing `*.lock` file inside the git folder.
    #[test]
    fn lock_file_check() {
        let (_t, repo, _remote) = cloned_repo();
        let git_dir = repo.join(".git");
        let lock = git_dir.join("index.lock");
        std::fs::write(&lock, "").unwrap();
        assert!(check_lock_file(&git_dir, &lock).is_ok());
        // git prints the path with forward slashes.
        let forward = PathBuf::from(lock.to_string_lossy().replace('\\', "/"));
        assert!(check_lock_file(&git_dir, &forward).is_ok());

        let outside = repo.join("build.lock");
        std::fs::write(&outside, "").unwrap();
        assert!(check_lock_file(&git_dir, &outside).is_err(), "outside the git folder");
        let not_lock = git_dir.join("config");
        assert!(check_lock_file(&git_dir, &not_lock).is_err(), "not a .lock file");
        assert!(check_lock_file(&git_dir, &git_dir.join("gone.lock")).is_err(), "missing");
        assert!(check_lock_file(&git_dir, &git_dir.join("..").join("build.lock")).is_err(), "escapes via ..");
    }

    /// Fact 4 (and 7): every write command takes the repo lock exactly once at its boundary;
    /// read commands never touch it.
    #[test]
    fn write_commands_lock_once_and_reads_never() {
        let src = include_str!("commands.rs").replace("\r\n", "\n");
        let body = |name: &str| -> String {
            let start = src.find(&format!("async fn {name}(")).unwrap_or_else(|| panic!("no command {name}"));
            let end = src[start..].find("\n}\n").map(|e| start + e).unwrap();
            src[start..end].to_string()
        };
        let locks = |b: &str| ["write_op(", "pull_shared(", "ops.write("].iter().map(|n| b.matches(n).count()).sum::<usize>();
        for name in ["stage", "unstage", "discard", "commit", "push", "checkout", "create_branch", "delete_branch", "undo_last_commit", "abort_operation", "integrate", "continue_operation", "skip_operation"] {
            assert_eq!(locks(&body(name)), 1, "{name} must take the write lock exactly once");
        }
        // Pull (single and batch) goes through pull_shared → pull_joined, which takes the lock once.
        assert_eq!(body("pull_shared").matches("ops.write(").count(), 0);
        assert_eq!(body("pull_joined").matches("ops.write(").count(), 1);
        assert!(body("run_batch").contains("batch_one("));
        for name in ["repo_status", "line_stats", "file_diff", "branches", "last_commit_message", "repo_summary", "refresh_all", "last_commit_undo", "merge_message", "pull_strategy"] {
            let b = body(name);
            assert!(locks(&b) == 0 && !b.contains("ops"), "read command {name} must not wait on writes");
        }
    }
}
