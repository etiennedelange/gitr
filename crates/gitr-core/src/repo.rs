use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::branches::{self, Branch};
use crate::diff::{self, FileDiff, LineStats};
use crate::highlight::{self, DiffSyntax};
use crate::hooks::TraceFile;
use crate::runner::{GitRunner, Kind, OnLine, RunOpts};
use crate::status::{self, RepoStatus};
use crate::GitError;
use crate::info::read_operation;
use crate::log::{self, CommitDetails, LogPage, ResetMode, ResetPreview};

/// How a diverged branch is integrated with its upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Strategy {
    Rebase,
    Merge,
}

/// Result of integrating (or continuing): done, or stopped on conflicts in `files` files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum IntegrateOutcome {
    Done,
    Conflicts { files: usize },
    /// The rebase/merge finished, but putting the stashed uncommitted changes back conflicted in
    /// `files` files: git leaves conflict markers there and keeps the changes in `git stash list`.
    StashConflict { files: usize },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PullOutcome {
    UpToDate,
    FastForwarded,
    NoUpstream,
    Diverged,
}

/// Staged changes summary handed to the commit-message generator.
#[derive(Debug, Clone, Default)]
pub struct StagedChanges {
    pub branch: Option<String>,
    pub stat: String,
    pub diff: String,
    pub recent_subjects: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Git {
    runner: GitRunner,
    /// Shared by every clone, like the runner.
    diffs: Arc<Mutex<DiffCache>>,
}

/// The diffs the UI was just sent, so the syntax request that follows each one colours that
/// same diff instead of running git for it again. Each is taken once.
#[derive(Debug, Default)]
struct DiffCache {
    entries: VecDeque<(PathBuf, String, CachedDiff)>,
    /// Per repository, bumped by [`Git::forget_diffs`]: a diff git made before the repository
    /// changed is not kept, so colours are never worked out for a diff the UI has replaced.
    generations: HashMap<PathBuf, u64>,
}

#[derive(Debug, Clone)]
struct CachedDiff {
    diff: FileDiff,
    /// A commit diff's first parent (None for a root commit or a working-tree diff).
    base: Option<String>,
}

/// Enough for the diffs whose syntax requests are still on their way.
const CACHED_DIFFS: usize = 8;

fn worktree_diff_key(path: &str, staged: bool, untracked: bool) -> String {
    format!("w\0{staged}\0{untracked}\0{path}")
}

fn commit_diff_key(sha: &str, path: &str, orig_path: Option<&str>) -> String {
    format!("c\0{sha}\0{}\0{path}", orig_path.unwrap_or(""))
}

impl Git {
    pub fn new(runner: GitRunner) -> Self {
        Self { runner, diffs: Default::default() }
    }

    fn diff_cache(&self) -> std::sync::MutexGuard<'_, DiffCache> {
        self.diffs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn diff_generation(&self, repo: &Path) -> u64 {
        self.diff_cache().generations.get(repo).copied().unwrap_or(0)
    }

    fn keep_diff(&self, repo: &Path, key: String, generation: u64, diff: CachedDiff) {
        let mut cache = self.diff_cache();
        if cache.generations.get(repo).copied().unwrap_or(0) != generation {
            return;
        }
        cache.entries.retain(|(r, k, _)| !(r == repo && *k == key));
        if cache.entries.len() == CACHED_DIFFS {
            cache.entries.pop_front();
        }
        cache.entries.push_back((repo.to_path_buf(), key, diff));
    }

    fn take_diff(&self, repo: &Path, key: &str) -> Option<CachedDiff> {
        let mut cache = self.diff_cache();
        let i = cache.entries.iter().position(|(r, k, _)| r == repo && k == key)?;
        cache.entries.remove(i).map(|(_, _, d)| d)
    }

    /// Drops what is remembered of `repo`'s diffs. Call it when the repository changes, before
    /// the UI asks for its diffs again.
    pub fn forget_diffs(&self, repo: &Path) {
        let mut cache = self.diff_cache();
        cache.entries.retain(|(r, _, _)| r != repo);
        *cache.generations.entry(repo.to_path_buf()).or_default() += 1;
    }

    pub fn runner(&self) -> &GitRunner {
        &self.runner
    }

    /// Full status: every untracked file is listed on its own (the Changes list).
    pub async fn status(&self, repo: &Path) -> Result<RepoStatus, GitError> {
        self.status_with(repo, "--untracked-files=all").await
    }

    /// Status for a dashboard row: an untracked folder counts as one entry, so git doesn't walk
    /// into it. Much cheaper for build output or `node_modules` that isn't ignored.
    pub async fn status_summary(&self, repo: &Path) -> Result<RepoStatus, GitError> {
        self.status_with(repo, "--untracked-files=normal").await
    }

    async fn status_with(&self, repo: &Path, untracked: &str) -> Result<RepoStatus, GitError> {
        let out = self.runner.run(repo, Kind::Read, &["status", "--porcelain=v2", "--branch", "-z", untracked]).await?;
        Ok(status::parse_porcelain_v2(&out))
    }

    /// Added/removed line counts per changed file, staged and unstaged (untracked files excluded).
    pub async fn line_stats(&self, repo: &Path) -> Result<LineStats, GitError> {
        let numstat = |cached: bool| {
            let mut args = vec!["diff", "--numstat", "-z", "--no-ext-diff", "-M"];
            if cached {
                args.push("--cached");
            }
            async move { self.runner.run(repo, Kind::Read, &args).await.map(|out| diff::parse_numstat_z(&out)) }
        };
        Ok(LineStats { staged: numstat(true).await?, unstaged: numstat(false).await? })
    }

    pub async fn fetch(&self, repo: &Path) -> Result<(), GitError> {
        self.fetch_with(repo, Prompt::Allowed).await
    }

    /// Fetches all remotes. With `Prompt::Never` (batches) a missing sign-in fails fast as an
    /// `Auth` error instead of opening a sign-in window.
    pub async fn fetch_with(&self, repo: &Path, prompt: Prompt) -> Result<(), GitError> {
        let opts = RunOpts { env: self.network_env(repo, prompt).await, ..Default::default() };
        self.runner
            .run_with(repo, Kind::Network, &["fetch", "--all", "--prune", "--no-progress"], opts)
            .await
            .map(|_| ())
    }

    /// Environment for a command that talks to a remote. `Prompt::Never` tells Git Credential
    /// Manager to fail instead of showing a window. Unless the user configured SSH themselves,
    /// ssh never waits for an answer nobody can give (see `ssh_command`).
    async fn network_env(&self, repo: &Path, prompt: Prompt) -> Vec<(OsString, OsString)> {
        let mut env = Vec::new();
        if prompt == Prompt::Never {
            env.push(("GCM_INTERACTIVE".into(), "never".into()));
        }
        if !self.user_configured_ssh(repo).await {
            env.push(("GIT_SSH_COMMAND".into(), ssh_command(prompt).into()));
        }
        env
    }

    /// `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` is set: their SSH setup is left alone.
    async fn user_configured_ssh(&self, repo: &Path) -> bool {
        if ["GIT_SSH_COMMAND", "GIT_SSH"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty())) {
            return true;
        }
        let opts = RunOpts { ok_codes: &[1], ..Default::default() };
        matches!(self.runner.run_with(repo, Kind::Read, &["config", "--get", "core.sshCommand"], opts).await, Ok(out) if !out.trim().is_empty())
    }

    /// Fetch, then fast-forward only. Never merges or rebases; local changes that would be
    /// overwritten cause git to refuse, which surfaces as an error.
    pub async fn pull_ff(&self, repo: &Path) -> Result<PullOutcome, GitError> {
        self.fetch(repo).await?;
        self.fast_forward(repo).await
    }

    /// Fast-forwards the current branch to its upstream as last fetched. No network access.
    pub async fn fast_forward(&self, repo: &Path) -> Result<PullOutcome, GitError> {
        Self::ensure_no_operation(repo)?;
        let st = self.status(repo).await?;
        if st.upstream.is_none() {
            return Ok(PullOutcome::NoUpstream);
        }
        if st.behind == 0 {
            return Ok(PullOutcome::UpToDate);
        }
        if st.ahead > 0 {
            return Ok(PullOutcome::Diverged);
        }
        self.runner.run(repo, Kind::LocalWrite, &["merge", "--ff-only", "@{u}"]).await?;
        Ok(PullOutcome::FastForwarded)
    }

    /// How to integrate a diverged branch: `pull.rebase` from the repo's own config, else from the
    /// user's global config (true / merges / interactive → rebase, false → merge), else `default`.
    /// The system-level value is ignored on purpose: the Git for Windows installer writes
    /// `pull.rebase=false` there for everyone, which would otherwise always mean merge.
    pub async fn pull_strategy(&self, repo: &Path, default: Strategy) -> Result<Strategy, GitError> {
        for scope in ["--local", "--global"] {
            let value = self
                .runner
                .run_with(repo, Kind::Read, &["config", scope, "--get", "pull.rebase"], RunOpts { ok_codes: &[1], ..Default::default() })
                .await?;
            match value.trim().to_ascii_lowercase().as_str() {
                "" => continue,
                "false" | "no" | "off" | "0" => return Ok(Strategy::Merge),
                _ => return Ok(Strategy::Rebase),
            }
        }
        Ok(default)
    }

    /// Integrates the upstream into a diverged branch: rebases the local commits onto it, or
    /// merges it. Uncommitted changes are stashed for the operation (`--autostash`) and put back
    /// afterwards; if it stops on conflicts git keeps that stash with the operation and restores it
    /// on `--continue` or `--abort`. Never opens an editor (the runner sets `GIT_EDITOR=true`).
    pub async fn integrate(&self, repo: &Path, strategy: Strategy) -> Result<IntegrateOutcome, GitError> {
        Self::ensure_no_operation(repo)?;
        let args: &[&str] = match strategy {
            Strategy::Rebase => &["rebase", "--autostash", "@{u}"],
            Strategy::Merge => &["merge", "--autostash", "--no-edit", "@{u}"],
        };
        let result = self.runner.run(repo, Kind::LocalWrite, args).await;
        self.stopped_or(repo, result).await
    }

    /// Continues the rebase / merge / cherry-pick / revert / `git am` in progress, once no
    /// conflicted files remain. A rebase can stop again on the next commit's conflicts.
    pub async fn continue_operation(&self, repo: &Path) -> Result<IntegrateOutcome, GitError> {
        let Some(op) = read_operation(repo) else {
            return Err(GitError::invalid("Nothing to continue: no rebase, merge, cherry-pick or revert is in progress."));
        };
        if !op.can_continue() {
            return Err(GitError::invalid("A bisect goes on by marking commits good or bad in a terminal, or ends with End bisect."));
        }
        let st = self.status(repo).await?;
        if st.files.iter().any(|f| f.conflicted) {
            return Err(GitError::invalid("Resolve and stage the conflicted files first."));
        }
        let result = self.runner.run(repo, Kind::LocalWrite, &[op.command(), "--continue"]).await;
        self.stopped_or(repo, result).await
    }

    /// Skips the commit (or patch) a rebase, cherry-pick, revert or `git am` stopped on, and goes
    /// on with the rest (`git <cmd> --skip`). That commit's changes, and any edits made to resolve
    /// its conflicts, are dropped from the working copy. It can stop again on the next commit.
    pub async fn skip_operation(&self, repo: &Path) -> Result<IntegrateOutcome, GitError> {
        let op = match read_operation(repo) {
            Some(op) if op.can_skip() => op,
            Some(op) => return Err(GitError::invalid(format!("A {} has no commit to skip.", op.noun()))),
            None => return Err(GitError::invalid("Nothing to skip: no rebase, cherry-pick or revert is in progress.")),
        };
        let result = self.runner.run(repo, Kind::LocalWrite, &[op.command(), "--skip"]).await;
        self.stopped_or(repo, result).await
    }

    /// A failure that left the repo in an operation with conflicts is a stop, not an error.
    async fn stopped_or(&self, repo: &Path, result: Result<String, GitError>) -> Result<IntegrateOutcome, GitError> {
        match result {
            Ok(_) => {
                // git exits 0 even when re-applying the autostash conflicted.
                let st = self.status(repo).await?;
                let files = st.files.iter().filter(|f| f.conflicted).count();
                Ok(if files > 0 { IntegrateOutcome::StashConflict { files } } else { IntegrateOutcome::Done })
            }
            Err(e) => {
                if read_operation(repo).is_some() {
                    let st = self.status(repo).await?;
                    let files = st.files.iter().filter(|f| f.conflicted).count();
                    if files > 0 {
                        return Ok(IntegrateOutcome::Conflicts { files });
                    }
                }
                Err(e)
            }
        }
    }

    pub async fn stage(&self, repo: &Path, paths: &[String]) -> Result<(), GitError> {
        self.with_paths(repo, &["add", "-A"], paths).await
    }

    pub async fn stage_all(&self, repo: &Path) -> Result<(), GitError> {
        self.runner.run(repo, Kind::LocalWrite, &["add", "-A"]).await.map(|_| ())
    }

    pub async fn unstage(&self, repo: &Path, paths: &[String]) -> Result<(), GitError> {
        self.with_paths(repo, &["reset", "-q"], paths).await
    }

    pub async fn unstage_all(&self, repo: &Path) -> Result<(), GitError> {
        self.runner.run(repo, Kind::LocalWrite, &["reset", "-q"]).await.map(|_| ())
    }

    /// Discards working-tree changes recoverably: every discarded file that exists on disk is
    /// first moved to `bin` (the Recycle Bin in the app), then tracked files are restored from
    /// the index (staged content is kept). Files the bin could not take are left untouched and
    /// returned in [`DiscardOutcome::failed`]; use [`discard_permanently`](Self::discard_permanently)
    /// for them only after the user agreed.
    pub async fn discard(
        &self,
        repo: &Path,
        tracked: &[String],
        untracked: &[String],
        bin: Arc<dyn Bin>,
    ) -> Result<DiscardOutcome, GitError> {
        self.validate_untracked(repo, untracked).await?;
        validate_paths(tracked)?;

        // (repo-relative path, untracked?) of files to move to the bin.
        let mut to_bin: Vec<(String, bool)> = untracked.iter().map(|p| (p.clone(), true)).collect();
        // Tracked paths to restore from the index.
        let mut restore: Vec<String> = Vec::new();
        for path in tracked {
            match std::fs::symlink_metadata(repo.join(crate::pathbytes::to_os(path))) {
                Ok(m) if m.is_file() || m.file_type().is_symlink() => to_bin.push((path.clone(), false)),
                // Deleted on disk: nothing to keep, just restore. Directories (submodules) are
                // never moved to the bin.
                _ => restore.push(path.clone()),
            }
        }

        let mut outcome = DiscardOutcome::default();
        if !to_bin.is_empty() {
            let files: Vec<PathBuf> = to_bin.iter().map(|(p, _)| repo.join(crate::pathbytes::to_os(p))).collect();
            let results = tokio::task::spawn_blocking(move || bin.move_to_bin(&files))
                .await
                .map_err(|e| GitError::invalid(format!("Recycle Bin task failed: {e}")))?;
            for ((path, is_untracked), result) in to_bin.into_iter().zip(results) {
                match result {
                    Ok(()) if !is_untracked => restore.push(path),
                    Ok(()) => {}
                    Err(reason) => outcome.failed.push(DiscardFailure { path, untracked: is_untracked, reason }),
                }
            }
        }
        if !restore.is_empty() {
            self.with_paths(repo, &["restore", "--worktree"], &restore).await?;
        }
        Ok(outcome)
    }

    /// Discards permanently: restores tracked files over their changes and deletes untracked
    /// files. Only for files the user explicitly agreed to lose (the Recycle Bin refused them).
    pub async fn discard_permanently(
        &self,
        repo: &Path,
        tracked: &[String],
        untracked: &[String],
    ) -> Result<(), GitError> {
        self.validate_untracked(repo, untracked).await?;
        validate_paths(tracked)?;
        if !tracked.is_empty() {
            self.with_paths(repo, &["restore", "--worktree"], tracked).await?;
        }
        for path in untracked {
            std::fs::remove_file(repo.join(crate::pathbytes::to_os(path)))
                .map_err(|e| GitError::invalid(format!("Could not delete {}: {e}", crate::pathbytes::display(path))))?;
        }
        Ok(())
    }

    /// The last commit, if it can be undone: it exists, is not a merge commit and is not on any
    /// remote-tracking branch (i.e. it was never pushed).
    pub async fn last_commit_undo(&self, repo: &Path) -> Result<Option<LastCommit>, GitError> {
        Ok(self.undoable_commit(repo).await?.map(|(commit, _)| commit))
    }

    /// Undoes the last commit if [`last_commit_undo`](Self::last_commit_undo) allows it: the
    /// branch moves back one commit (or becomes unborn for the first commit) and all of the
    /// commit's changes stay staged. Returns the commit's full message.
    pub async fn undo_last_commit(&self, repo: &Path) -> Result<String, GitError> {
        Self::ensure_no_operation(repo)?;
        let Some((commit, has_parent)) = self.undoable_commit(repo).await? else {
            return Err(GitError::invalid(
                "The last commit can't be undone: there is none, it is a merge commit, or it is already on a remote branch",
            ));
        };
        if has_parent {
            self.runner.run(repo, Kind::LocalWrite, &["reset", "--soft", "HEAD~1"]).await?;
        } else {
            // First commit: no HEAD~1. Deleting the branch ref keeps the index, so everything
            // stays staged on an unborn branch.
            self.runner.run(repo, Kind::LocalWrite, &["update-ref", "-d", "HEAD"]).await?;
        }
        Ok(commit.message)
    }

    /// (commit, has a parent) when HEAD can be undone.
    async fn undoable_commit(&self, repo: &Path) -> Result<Option<(LastCommit, bool)>, GitError> {
        let head = self
            .runner
            .run_with(repo, Kind::Read, &["rev-parse", "--verify", "-q", "HEAD"], RunOpts { ok_codes: &[1], ..Default::default() })
            .await?;
        if head.trim().is_empty() {
            return Ok(None);
        }
        let parents = self.runner.run(repo, Kind::Read, &["rev-list", "--parents", "-n", "1", "HEAD"]).await?;
        let parent_count = parents.split_whitespace().count().saturating_sub(1);
        if parent_count > 1 {
            return Ok(None);
        }
        let on_remote = self
            .runner
            .run(repo, Kind::Read, &["branch", "-r", "--contains", "HEAD", "--format=%(refname)"])
            .await?;
        if !on_remote.trim().is_empty() {
            return Ok(None);
        }
        let message = self.runner.run(repo, Kind::Read, &["log", "-1", "--format=%B"]).await?.trim_end().to_string();
        let subject = message.lines().next().unwrap_or("").to_string();
        Ok(Some((LastCommit { subject, message }, parent_count == 1)))
    }

    pub async fn diff_file(
        &self,
        repo: &Path,
        path: &str,
        staged: bool,
        untracked: bool,
    ) -> Result<FileDiff, GitError> {
        let generation = self.diff_generation(repo);
        let diff = self.read_diff_file(repo, path, staged, untracked).await?;
        let key = worktree_diff_key(path, staged, untracked);
        self.keep_diff(repo, key, generation, CachedDiff { diff: diff.clone(), base: None });
        Ok(diff)
    }

    async fn read_diff_file(&self, repo: &Path, path: &str, staged: bool, untracked: bool) -> Result<FileDiff, GitError> {
        let out = if untracked {
            self.runner
                .run_with(
                    repo,
                    Kind::Read,
                    &["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path],
                    RunOpts { ok_codes: &[1], ..Default::default() },
                )
                .await?
        } else {
            let mut args = vec!["diff", "--no-ext-diff", "-M"];
            if staged {
                args.push("--cached");
            }
            args.extend(["--", path]);
            self.runner.run(repo, Kind::Read, &args).await?
        };
        Ok(diff::parse_unified(&out))
    }

    /// The commit HEAD points at, or None on an unborn branch.
    pub async fn head_commit(&self, repo: &Path) -> Result<Option<String>, GitError> {
        let out = self
            .runner
            .run_with(repo, Kind::Read, &["rev-parse", "--verify", "-q", "HEAD"], RunOpts { ok_codes: &[1], ..Default::default() })
            .await?;
        let sha = out.trim();
        Ok((!sha.is_empty()).then(|| sha.to_string()))
    }

    /// HEAD's history, newest first: up to `limit` commits after the first `skip`. Commits on no
    /// remote-tracking branch are marked unpushed (nothing is marked in a repo without remotes).
    pub async fn log(&self, repo: &Path, skip: usize, limit: usize) -> Result<LogPage, GitError> {
        if self.head_commit(repo).await?.is_none() {
            return Ok(LogPage::default());
        }
        let skip_arg = format!("--skip={skip}");
        let max = format!("--max-count={}", limit + 1);
        let out = self
            .runner
            .run(repo, Kind::Read, &["log", "-z", "--no-show-signature", "--decorate=full", log::LOG_FORMAT, &skip_arg, &max, "HEAD", "--"])
            .await?;
        let mut commits = log::parse_log(&out);
        let has_more = commits.len() > limit;
        commits.truncate(limit);
        if !commits.is_empty() && self.has_remote(repo).await? {
            // rev-list lists in the same order as log, so the first skip+limit unpushed commits
            // cover every unpushed commit on this page.
            let n = format!("--max-count={}", skip + limit + 1);
            let out = self.runner.run(repo, Kind::Read, &["rev-list", &n, "HEAD", "--not", "--remotes"]).await?;
            let unpushed: HashSet<&str> = out.lines().map(str::trim).collect();
            for c in &mut commits {
                c.unpushed = unpushed.contains(c.sha.as_str());
            }
        }
        Ok(LogPage { commits, has_more })
    }

    /// Header, message and changed files of one commit (against its first parent).
    pub async fn commit_details(&self, repo: &Path, sha: &str) -> Result<CommitDetails, GitError> {
        check_object_id(sha)?;
        let out = self.runner.run(repo, Kind::Read, &["show", "-s", "-z", "--no-show-signature", log::DETAILS_FORMAT, sha, "--"]).await?;
        let mut details = log::parse_details_header(&out).ok_or_else(|| GitError::invalid(format!("Could not read commit {sha}")))?;
        let base = details.parents.first().cloned();
        let range: Vec<&str> = match &base {
            Some(parent) => vec![parent, &details.sha],
            None => vec!["--root", &details.sha],
        };
        let tree = |stat: &'static str| {
            let mut args = vec!["diff-tree", "-r", "-z", "-M", "--no-commit-id", stat];
            args.extend(range.iter().copied());
            args
        };
        let numstat = self.runner.run(repo, Kind::Read, &tree("--numstat")).await?;
        let names = self.runner.run(repo, Kind::Read, &tree("--name-status")).await?;
        let mut files = log::commit_files(log::parse_name_status_z(&names), &log::numstat(&numstat));
        details.truncated = files.len() > log::MAX_COMMIT_FILES;
        files.truncate(log::MAX_COMMIT_FILES);
        details.files = files;
        Ok(details)
    }

    /// The diff of one file in a commit, against the commit's first parent (or the empty tree).
    /// `orig_path` is the old name of a renamed file, so the rename is shown as one diff.
    pub async fn commit_file_diff(&self, repo: &Path, sha: &str, path: &str, orig_path: Option<&str>) -> Result<FileDiff, GitError> {
        let generation = self.diff_generation(repo);
        let cached = self.read_commit_file_diff(repo, sha, path, orig_path).await?;
        let diff = cached.diff.clone();
        self.keep_diff(repo, commit_diff_key(sha, path, orig_path), generation, cached);
        Ok(diff)
    }

    async fn read_commit_file_diff(&self, repo: &Path, sha: &str, path: &str, orig_path: Option<&str>) -> Result<CachedDiff, GitError> {
        check_object_id(sha)?;
        let parents = self.parents_of(repo, sha).await?;
        let mut args = vec!["diff-tree", "-p", "-M", "--no-ext-diff", "--no-commit-id"];
        match parents.first() {
            Some(parent) => args.push(parent),
            None => args.push("--root"),
        }
        args.extend([sha, "--"]);
        if let Some(orig) = orig_path {
            args.push(orig);
        }
        args.push(path);
        let out = self.runner.run(repo, Kind::Read, &args).await?;
        Ok(CachedDiff { diff: diff::parse_unified(&out), base: parents.into_iter().next() })
    }

    /// Syntax colours for [`Self::diff_file`]'s lines, from the files on both sides: the index
    /// against the working tree, or HEAD against the index when `staged`. Colours the diff
    /// `diff_file` just returned when it is remembered.
    pub async fn diff_file_syntax(&self, repo: &Path, path: &str, staged: bool, untracked: bool) -> Result<DiffSyntax, GitError> {
        let diff = match self.take_diff(repo, &worktree_diff_key(path, staged, untracked)) {
            Some(cached) => cached.diff,
            None => self.read_diff_file(repo, path, staged, untracked).await?,
        };
        let index = Text::Blob(format!(":0:{path}"));
        let (old, new) = match (untracked, staged) {
            (true, _) => (Text::None, Text::Disk),
            (false, true) => (Text::Blob(format!("HEAD:{path}")), index),
            (false, false) => (index, Text::Disk),
        };
        Ok(self.syntax_of(repo, path, diff, old, new).await)
    }

    /// Syntax colours for [`Self::commit_file_diff`]'s lines.
    pub async fn commit_file_diff_syntax(&self, repo: &Path, sha: &str, path: &str, orig_path: Option<&str>) -> Result<DiffSyntax, GitError> {
        let CachedDiff { diff, base } = match self.take_diff(repo, &commit_diff_key(sha, path, orig_path)) {
            Some(cached) => cached,
            None => self.read_commit_file_diff(repo, sha, path, orig_path).await?,
        };
        let old = match base {
            Some(parent) => Text::Blob(format!("{parent}:{}", orig_path.unwrap_or(path))),
            None => Text::None,
        };
        Ok(self.syntax_of(repo, path, diff, old, Text::Blob(format!("{sha}:{path}"))).await)
    }

    async fn syntax_of(&self, repo: &Path, path: &str, diff: FileDiff, old: Text, new: Text) -> DiffSyntax {
        let (old_needed, new_needed) = highlight::sides_needed(&diff);
        let old = if old_needed { old } else { Text::None };
        let new = if new_needed { new } else { Text::None };
        let [old, new] = self.texts_of(repo, path, [old, new]).await;
        // Colouring is CPU work, at most HIGHLIGHT_BUDGET of it; lines it didn't reach stay plain.
        let deadline = std::time::Instant::now() + HIGHLIGHT_BUDGET;
        let path = path.to_string();
        tokio::task::spawn_blocking(move || highlight::highlight_diff(&path, &diff, old.as_deref(), new.as_deref(), deadline))
            .await
            .unwrap_or_default()
    }

    /// Files' text for colouring, as the diff shows them. None when missing or too large. Every
    /// blob among them is read by the same two git processes.
    async fn texts_of<const N: usize>(&self, repo: &Path, path: &str, texts: [Text; N]) -> [Option<String>; N] {
        let specs: Vec<&str> = texts.iter().filter_map(|t| if let Text::Blob(spec) = t { Some(spec.as_str()) } else { None }).collect();
        let mut blobs = self.read_blobs(repo, &specs).await.into_iter();
        let mut out = [const { None }; N];
        for (text, slot) in texts.iter().zip(&mut out) {
            *slot = match text {
                Text::None => None,
                Text::Disk => disk_text(repo, path).await,
                Text::Blob(_) => blobs.next().flatten().map(|bytes| crate::pathbytes::display(&crate::pathbytes::decode(&bytes))),
            };
        }
        out
    }

    /// Blobs by `<rev>:<path>` spec: their sizes first, so nothing larger than
    /// [`highlight::MAX_SOURCE_BYTES`] is read, then their contents. Two git processes however
    /// many specs. None for a spec that is missing (a new file, an unborn HEAD, a conflict with
    /// no stage 0) or too large.
    async fn read_blobs(&self, repo: &Path, specs: &[&str]) -> Vec<Option<Vec<u8>>> {
        let mut out = vec![None; specs.len()];
        // cat-file takes one spec per line, so a name with a line break can't be asked for.
        let askable: Vec<usize> = (0..specs.len()).filter(|&i| !specs[i].contains(['\n', '\r'])).collect();
        let lines = |which: &[usize]| -> Vec<u8> {
            which.iter().flat_map(|&i| [crate::pathbytes::to_bytes(specs[i]), vec![b'\n']].concat()).collect()
        };
        if askable.is_empty() {
            return out;
        }
        let input = lines(&askable);
        let opts = RunOpts { stdin: Some(&input), ..Default::default() };
        // One line per spec: `blob <size>`, or `<spec> missing`.
        let Ok(sizes) = self.runner.run_with(repo, Kind::Read, &["cat-file", "--batch-check=%(objecttype) %(objectsize)"], opts).await else {
            return out;
        };
        let wanted: Vec<usize> = askable
            .iter()
            .zip(sizes.lines())
            .filter(|(_, line)| line.strip_prefix("blob ").and_then(|n| n.parse::<u64>().ok()).is_some_and(|n| n <= highlight::MAX_SOURCE_BYTES))
            .map(|(&i, _)| i)
            .collect();
        if wanted.is_empty() {
            return out;
        }
        let input = lines(&wanted);
        let opts = RunOpts { stdin: Some(&input), ..Default::default() };
        let Ok(raw) = self.runner.run_bytes(repo, Kind::Read, &["cat-file", "--batch"], opts).await else {
            return out;
        };
        // Each: `<oid> blob <size>\n<content>\n`, or `<spec> missing\n` if it went in between.
        let mut rest = raw.as_slice();
        for i in wanted {
            let Some(end) = rest.iter().position(|&b| b == b'\n') else { break };
            let header = String::from_utf8_lossy(&rest[..end]).into_owned();
            rest = &rest[end + 1..];
            let Some(size) = header.rsplit(' ').next().and_then(|n| n.parse::<usize>().ok()) else { continue };
            if rest.len() <= size {
                break;
            }
            if size as u64 <= highlight::MAX_SOURCE_BYTES {
                out[i] = Some(rest[..size].to_vec());
            }
            rest = &rest[size + 1..];
        }
        out
    }

    async fn parents_of(&self, repo: &Path, sha: &str) -> Result<Vec<String>, GitError> {
        let out = self.runner.run(repo, Kind::Read, &["rev-list", "--parents", "-n", "1", sha, "--"]).await?;
        Ok(out.split_whitespace().skip(1).map(str::to_string).collect())
    }

    /// Adds a commit that undoes `sha` (a merge is undone against its first parent). Stops in
    /// the Reverting state when it conflicts. git refuses, changing nothing, when the revert
    /// would overwrite uncommitted changes.
    pub async fn revert_with(&self, repo: &Path, sha: &str, hooks: HookOpts<'_>) -> Result<IntegrateOutcome, GitError> {
        Self::ensure_no_operation(repo)?;
        check_object_id(sha)?;
        let merge = self.parents_of(repo, sha).await?.len() > 1;
        let mut args = vec!["revert", "--no-edit"];
        if merge {
            args.extend(["-m", "1"]);
        }
        args.push(sha);
        let trace = TraceFile::new();
        let opts = RunOpts { env: vec![trace.env()], on_stderr: hooks.on_output, ..Default::default() };
        let result = self.runner.run_with(repo, Kind::LocalWrite, &args, opts).await.map_err(|e| hook_failure(e, &trace));
        self.stopped_or(repo, result).await
    }

    /// What resetting the branch to `sha` would take off it. Refuses a commit that isn't in
    /// HEAD's history (or is HEAD itself).
    pub async fn reset_preview(&self, repo: &Path, sha: &str) -> Result<ResetPreview, GitError> {
        let target = self.ancestor_of_head(repo, sha).await?;
        let range = format!("{target}..HEAD");
        let count = |args: Vec<String>| async move {
            let mut full = vec!["rev-list".to_string(), "--count".to_string()];
            full.extend(args);
            let refs: Vec<&str> = full.iter().map(String::as_str).collect();
            self.runner.run(repo, Kind::Read, &refs).await.map(|o| o.trim().parse::<u32>().unwrap_or(0))
        };
        let leaving = count(vec![range.clone()]).await?;
        if leaving == 0 {
            return Err(GitError::invalid("The branch is already at that commit."));
        }
        let unpushed = count(vec![range.clone(), "--not".into(), "--remotes".into()]).await?;
        let upstream = self
            .runner
            .run_with(repo, Kind::Read, &["rev-parse", "--verify", "-q", "@{u}"], RunOpts { ok_codes: &[1, 128], ..Default::default() })
            .await
            .unwrap_or_default();
        let on_upstream = if upstream.trim().is_empty() {
            0
        } else {
            leaving - count(vec![range, format!("^{}", upstream.trim())]).await?
        };
        Ok(ResetPreview { leaving, unpushed, on_upstream })
    }

    /// Moves the branch (or detached HEAD) back to `sha`, an ancestor of HEAD. Soft keeps the
    /// undone changes staged, mixed keeps them unstaged; working-tree files never change, and
    /// there is deliberately no hard reset. Returns the previous HEAD, for undo.
    pub async fn reset(&self, repo: &Path, sha: &str, mode: ResetMode) -> Result<String, GitError> {
        Self::ensure_no_operation(repo)?;
        self.reset_preview(repo, sha).await?;
        let target = self.ancestor_of_head(repo, sha).await?;
        let previous = self.head_sha(repo).await?;
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
        };
        self.runner.run(repo, Kind::LocalWrite, &["reset", "-q", flag, &target, "--"]).await?;
        Ok(previous)
    }

    /// Undoes a reset: moves the branch forward to `previous_head` again. `branch` is the ref the
    /// reset moved (None when HEAD was detached); the undo is refused when HEAD is on something
    /// else now, so it can never move a different branch. The working tree is never touched. The
    /// index follows too, except for files staged since: a mixed reset emptied it of the undone
    /// commits' files, and leaving it would show each as a staged deletion plus an untracked file.
    /// Refused when HEAD moved since (a commit made after the reset would be lost).
    pub async fn undo_reset(&self, repo: &Path, previous_head: &str, branch: Option<&str>) -> Result<(), GitError> {
        Self::ensure_no_operation(repo)?;
        check_object_id(previous_head)?;
        if self.head_ref(repo).await?.as_deref() != branch {
            return Err(GitError::invalid("A different branch is checked out now, so the reset can't be undone here."));
        }
        let head = self.head_sha(repo).await?;
        let base = self.runner.run(repo, Kind::Read, &["merge-base", &head, previous_head]).await?;
        if base.trim() != head {
            return Err(GitError::invalid("The branch has moved since the reset, so it can't be undone here."));
        }
        // Files the undone commits touched, minus those staged by hand since (their index entry differs from HEAD).
        let touched = self.runner.run(repo, Kind::Read, &["diff-tree", "-r", "-z", "--name-only", "--no-commit-id", &head, previous_head]).await?;
        let staged = self.runner.run(repo, Kind::Read, &["diff", "--cached", "-z", "--name-only"]).await?;
        let staged: HashSet<&str> = staged.split('\0').collect();
        let follow: Vec<&str> = touched.split('\0').filter(|p| !p.is_empty() && !staged.contains(p)).collect();
        self.runner.run(repo, Kind::LocalWrite, &["reset", "-q", "--soft", previous_head, "--"]).await?;
        if !follow.is_empty() {
            let mut list = follow.join("\0").into_bytes();
            list.push(0);
            let opts = RunOpts { stdin: Some(&list), ..Default::default() };
            self.runner
                .run_with(repo, Kind::LocalWrite, &["--literal-pathspecs", "reset", "-q", previous_head, "--pathspec-from-file=-", "--pathspec-file-nul"], opts)
                .await?;
        }
        Ok(())
    }

    /// The ref HEAD is on (`refs/heads/main`), or None when detached.
    pub async fn head_ref(&self, repo: &Path) -> Result<Option<String>, GitError> {
        let out = self
            .runner
            .run_with(repo, Kind::Read, &["symbolic-ref", "-q", "HEAD"], RunOpts { ok_codes: &[1], ..Default::default() })
            .await?;
        let r = out.trim();
        Ok((!r.is_empty()).then(|| r.to_string()))
    }

    /// The full id of `sha` if it is a commit in HEAD's history.
    async fn ancestor_of_head(&self, repo: &Path, sha: &str) -> Result<String, GitError> {
        check_object_id(sha)?;
        let spec = format!("{sha}^{{commit}}");
        let full = self.runner.run(repo, Kind::Read, &["rev-parse", "--verify", "-q", &spec]).await?.trim().to_string();
        let base = self
            .runner
            .run_with(repo, Kind::Read, &["merge-base", &full, "HEAD"], RunOpts { ok_codes: &[1], ..Default::default() })
            .await?;
        if base.trim() != full {
            return Err(GitError::invalid("That commit is not on the current branch."));
        }
        Ok(full)
    }

    pub async fn commit(&self, repo: &Path, message: &str, amend: bool) -> Result<String, GitError> {
        self.commit_with(repo, message, amend, HookOpts::default()).await
    }

    /// Commits the staged changes. A failure caused by a hook is a `Hook` error naming it.
    pub async fn commit_with(&self, repo: &Path, message: &str, amend: bool, hooks: HookOpts<'_>) -> Result<String, GitError> {
        if message.trim().is_empty() && !amend {
            return Err(GitError::invalid("Commit message is empty"));
        }
        let mut args = vec!["commit", "-q", "-F", "-"];
        if amend {
            args.push("--amend");
        }
        if hooks.skip {
            args.push("--no-verify");
        }
        let trace = TraceFile::new();
        let opts = RunOpts { stdin: Some(message.as_bytes()), env: vec![trace.env()], on_stderr: hooks.on_output, ..Default::default() };
        if let Err(e) = self.runner.run_with(repo, Kind::LocalWrite, &args, opts).await {
            return Err(hook_failure(e, &trace));
        }
        self.head_sha(repo).await
    }

    /// Whether any of `names` is installed as a hook (honouring `core.hooksPath`).
    pub async fn has_hooks(&self, repo: &Path, names: &[&str]) -> bool {
        let Ok(dir) = self.runner.run(repo, Kind::Read, &["rev-parse", "--git-path", "hooks"]).await else { return false };
        let dir = repo.join(dir.trim());
        names.iter().any(|name| dir.join(name).is_file())
    }

    pub async fn push(&self, repo: &Path) -> Result<(), GitError> {
        self.push_with(repo, HookOpts::default()).await
    }

    /// Pushes the current branch (setting its upstream if it has none). A failure caused by the
    /// pre-push hook is a `Hook` error.
    pub async fn push_with(&self, repo: &Path, hooks: HookOpts<'_>) -> Result<(), GitError> {
        let st = self.status(repo).await?;
        let remote = match st.upstream {
            Some(_) => None,
            None => Some(self.default_remote(repo).await?),
        };
        let mut args = vec!["push", "--porcelain"];
        if hooks.skip {
            args.push("--no-verify");
        }
        if let Some(remote) = &remote {
            args.extend(["-u", remote, "HEAD"]);
        }
        let trace = TraceFile::new();
        let mut env = self.network_env(repo, Prompt::Allowed).await;
        env.push(trace.env());
        let opts = RunOpts { env, on_stderr: hooks.on_output, ..Default::default() };
        match self.runner.run_with(repo, Kind::Network, &args, opts).await {
            Ok(_) => Ok(()),
            Err(e) => Err(hook_failure(e, &trace)),
        }
    }

    pub async fn branches(&self, repo: &Path) -> Result<Vec<Branch>, GitError> {
        let format = format!("--format={}", branches::FOR_EACH_REF_FORMAT);
        let out = self
            .runner
            .run(repo, Kind::Read, &["for-each-ref", &format, "refs/heads", "refs/remotes"])
            .await?;
        Ok(branches::parse_for_each_ref(&out))
    }

    /// Checks out a local branch, or creates a tracking branch when given `remote/name`.
    pub async fn checkout(&self, repo: &Path, branch: &str, remote: bool) -> Result<(), GitError> {
        Self::ensure_no_operation(repo)?;
        let args: Vec<&str> = if remote {
            vec!["switch", "--track", branch]
        } else {
            vec!["switch", branch]
        };
        self.runner.run(repo, Kind::LocalWrite, &args).await.map(|_| ())
    }

    pub async fn create_branch(
        &self,
        repo: &Path,
        name: &str,
        start: Option<&str>,
        checkout: bool,
    ) -> Result<(), GitError> {
        if checkout {
            Self::ensure_no_operation(repo)?;
        }
        let mut args = if checkout { vec!["switch", "-c", name] } else { vec!["branch", name] };
        if let Some(s) = start {
            args.push(s);
        }
        self.runner.run(repo, Kind::LocalWrite, &args).await.map(|_| ())
    }

    pub async fn delete_branch(&self, repo: &Path, name: &str, force: bool) -> Result<(), GitError> {
        let flag = if force { "-D" } else { "-d" };
        self.runner.run(repo, Kind::LocalWrite, &["branch", flag, name]).await.map(|_| ())
    }

    pub async fn head_sha(&self, repo: &Path) -> Result<String, GitError> {
        Ok(self.runner.run(repo, Kind::Read, &["rev-parse", "HEAD"]).await?.trim().to_string())
    }

    pub async fn last_commit_message(&self, repo: &Path) -> Result<String, GitError> {
        Ok(self.runner.run(repo, Kind::Read, &["log", "-1", "--format=%B"]).await?.trim_end().to_string())
    }

    pub async fn staged_changes(&self, repo: &Path, max_diff_bytes: usize) -> Result<StagedChanges, GitError> {
        let st = self.status(repo).await?;
        let stat = self.runner.run(repo, Kind::Read, &["diff", "--cached", "--stat", "--no-ext-diff"]).await?;
        let mut diff = self
            .runner
            .run(repo, Kind::Read, &["diff", "--cached", "--no-ext-diff", "-M", "-U2"])
            .await?;
        // The diff goes to an online service: never send what looks like a credential file.
        let diff_all = withhold_secrets(&diff);
        diff = diff_all;
        if diff.len() > max_diff_bytes {
            let mut cut = max_diff_bytes;
            while !diff.is_char_boundary(cut) {
                cut -= 1;
            }
            diff.truncate(cut);
            diff.push_str("\n[diff truncated]\n");
        }
        let recent_subjects = self
            .runner
            .run(repo, Kind::Read, &["log", "-n", "10", "--format=%s"])
            .await
            .map(|o| o.lines().map(str::to_string).collect())
            .unwrap_or_default();
        Ok(StagedChanges { branch: st.branch, stat, diff, recent_subjects })
    }

    /// Whether the repository has any remote configured (a fetch of none "succeeds" doing nothing).
    pub async fn has_remote(&self, repo: &Path) -> Result<bool, GitError> {
        Ok(!self.runner.run(repo, Kind::Read, &["remote"]).await?.trim().is_empty())
    }

    async fn default_remote(&self, repo: &Path) -> Result<String, GitError> {
        let out = self.runner.run(repo, Kind::Read, &["remote"]).await?;
        let remotes: Vec<&str> = out.lines().collect();
        remotes
            .iter()
            .find(|r| **r == "origin")
            .or(remotes.first())
            .map(|r| r.to_string())
            .ok_or_else(|| GitError::invalid("Repository has no remote to push to"))
    }

    /// Runs `base` once with `paths` fed NUL-separated through stdin. Paths are literal
    /// (`GIT_LITERAL_PATHSPECS=1` in the runner) and never touch the command line, so there is
    /// no length limit and no partial application.
    async fn with_paths(&self, repo: &Path, base: &[&str], paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut args: Vec<&str> = base.to_vec();
        args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
        let stdin = nul_separated(paths);
        self.runner
            .run_with(repo, Kind::LocalWrite, &args, RunOpts { stdin: Some(&stdin), ..Default::default() })
            .await
            .map(|_| ())
    }

    /// Refuses while a merge, rebase, cherry-pick, revert, bisect or `git am` is waiting for the
    /// user: pulling, switching branches or undoing a commit then would make it worse.
    fn ensure_no_operation(repo: &Path) -> Result<(), GitError> {
        match read_operation(repo) {
            Some(op) => Err(GitError::invalid(format!(
                "A {} is in progress. Finish or abort it first.",
                op.noun()
            ))),
            None => Ok(()),
        }
    }

    /// Aborts the merge, rebase, cherry-pick, revert or `git am` in progress (`git <cmd>
    /// --abort`), or ends a bisect (`git bisect reset`, back to where it started).
    pub async fn abort_operation(&self, repo: &Path) -> Result<(), GitError> {
        let Some(op) = read_operation(repo) else {
            return Err(GitError::invalid("Nothing to abort: no merge, rebase, cherry-pick or revert is in progress."));
        };
        self.runner.run(repo, Kind::LocalWrite, &op.abort_args()).await.map(|_| ())
    }

    /// The prepared message of an in-progress merge (`MERGE_MSG`), without comment lines.
    pub async fn merge_message(&self, repo: &Path) -> Result<Option<String>, GitError> {
        let rel = self.runner.run(repo, Kind::Read, &["rev-parse", "--git-path", "MERGE_MSG"]).await?;
        let Ok(text) = std::fs::read_to_string(repo.join(rel.trim())) else {
            return Ok(None);
        };
        let message: String = text.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n");
        let message = message.trim().to_string();
        Ok((!message.is_empty()).then_some(message))
    }

    /// Adds `repo` to `safe.directory` in the user's global git config, unless it is listed
    /// already. Runs outside the repo: git refuses to work inside an untrusted one.
    pub async fn trust_folder(&self, repo: &Path) -> Result<(), GitError> {
        let entry = repo.to_string_lossy().replace('\\', "/");
        let neutral = std::env::temp_dir();
        let listed = self
            .runner
            .run_with(
                &neutral,
                Kind::Read,
                &["config", "--global", "--get-all", "safe.directory"],
                RunOpts { ok_codes: &[1], ..Default::default() },
            )
            .await?;
        if listed.lines().any(|l| l.trim().eq_ignore_ascii_case(&entry)) {
            return Ok(());
        }
        self.runner
            .run(&neutral, Kind::LocalWrite, &["config", "--global", "--add", "safe.directory", &entry])
            .await
            .map(|_| ())
    }

    /// The repository's git folder (absolute), e.g. `<repo>/.git`.
    pub async fn git_dir(&self, repo: &Path) -> Result<PathBuf, GitError> {
        Ok(PathBuf::from(self.runner.run(repo, Kind::Read, &["rev-parse", "--absolute-git-dir"]).await?.trim()))
    }

    /// Checks that every path is safe and is exactly a file git lists as untracked (not
    /// ignored): the set `git clean -f` would remove. Nothing is touched.
    async fn validate_untracked(&self, repo: &Path, paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let listed = self
            .runner
            .run(repo, Kind::Read, &["ls-files", "--others", "--exclude-standard", "-z"])
            .await?;
        let untracked: HashSet<&str> = listed.split('\0').filter(|p| !p.is_empty()).collect();
        validate_paths(paths)?;
        for path in paths {
            if !untracked.contains(path.as_str()) {
                return Err(GitError::invalid(format!("Not an untracked file: {path}")));
            }
        }
        Ok(())
    }
}

/// Moves files somewhere recoverable (the OS Recycle Bin in the app; a folder in tests).
pub trait Bin: Send + Sync {
    /// One result per file, in order; `Err` carries a human-readable reason.
    fn move_to_bin(&self, files: &[PathBuf]) -> Vec<Result<(), String>>;
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardOutcome {
    /// Files the bin could not take; they were left untouched.
    pub failed: Vec<DiscardFailure>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardFailure {
    pub path: String,
    pub untracked: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub subject: String,
    pub message: String,
}

fn validate_paths(paths: &[String]) -> Result<(), GitError> {
    match paths.iter().find(|p| !is_safe_relative(p)) {
        Some(bad) => Err(GitError::invalid(format!("Refusing to touch unsafe path: {bad}"))),
        None => Ok(()),
    }
}

fn nul_separated(paths: &[String]) -> Vec<u8> {
    let mut out = Vec::with_capacity(paths.iter().map(|p| p.len() + 1).sum());
    for p in paths {
        out.extend_from_slice(&crate::pathbytes::to_bytes(p));
        out.push(0);
    }
    out
}

/// A repo-relative path with only normal components and nothing inside `.git`.
/// Whether a network command may ask the user to sign in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    /// A single action the user started: Git Credential Manager may show its sign-in window.
    Allowed,
    /// A batch over many repos: nothing may prompt; a missing sign-in fails fast.
    Never,
}

/// The ssh used when the user has no SSH configuration of their own: an
/// unknown host's key is accepted on first use (a changed key is still refused), ssh never asks
/// for a typed password, and in batches it asks nothing at all (a key with a passphrase and no
/// agent fails instead of waiting).
pub fn ssh_command(prompt: Prompt) -> String {
    let mut cmd = "ssh -o StrictHostKeyChecking=accept-new -o KbdInteractiveAuthentication=no".to_string();
    if prompt == Prompt::Never {
        cmd.push_str(" -o BatchMode=yes");
    }
    cmd
}

/// Hooks a commit can run.
pub const COMMIT_HOOKS: &[&str] = &["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];
/// Hooks `git revert --no-edit` runs: it commits through the sequencer, which skips
/// pre-commit, and commit-msg only runs when the message is edited. Pinned by a test.
pub const REVERT_HOOKS: &[&str] = &["prepare-commit-msg", "post-commit"];
/// Hooks a push can run.
pub const PUSH_HOOKS: &[&str] = &["pre-push"];

/// How commit and push treat hooks.
#[derive(Clone, Copy, Default)]
pub struct HookOpts<'a> {
    /// `--no-verify`: skips pre-commit and commit-msg (commit) or pre-push (push).
    pub skip: bool,
    /// Receives git's stderr line by line while it runs: hook output and git's own messages.
    pub on_output: Option<OnLine<'a>>,
}

/// A failed command is a hook failure when the trace shows a hook that exited non-zero (a
/// hook that fails stops the commit or push).
fn hook_failure(err: GitError, trace: &TraceFile) -> GitError {
    match trace.hook_runs().into_iter().find(|run| run.code != Some(0)) {
        Some(run) => err.into_hook_failure(&run.name),
        None => err,
    }
}

/// How long colouring one diff may take.
const HIGHLIGHT_BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);

/// Where one side of a diff comes from, for colouring it.
enum Text {
    None,
    /// The working-tree file.
    Disk,
    /// `<rev>:<path>` or `:0:<path>` (the index).
    Blob(String),
}

/// Refuses anything but an object id before it reaches git (see [`log::is_object_id`]).
/// The working-tree file's text, as [`Git::texts_of`] gives it.
async fn disk_text(repo: &Path, path: &str) -> Option<String> {
    if !is_safe_relative(path) {
        return None;
    }
    let file = repo.join(crate::pathbytes::to_os(path));
    let meta = tokio::fs::metadata(&file).await.ok()?;
    if !meta.is_file() || meta.len() > highlight::MAX_SOURCE_BYTES {
        return None;
    }
    let bytes = crate::pathbytes::decode(&tokio::fs::read(&file).await.ok()?);
    Some(crate::pathbytes::display(&bytes))
}

fn check_object_id(sha: &str) -> Result<(), GitError> {
    if log::is_object_id(sha) { Ok(()) } else { Err(GitError::invalid(format!("Not a commit id: {sha:?}"))) }
}

fn is_safe_relative(path: &str) -> bool {
    let p = Path::new(path);
    !path.is_empty()
        && p.components().all(|c| match c {
            Component::Normal(name) => !name.eq_ignore_ascii_case(".git"),
            _ => false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_relative_paths() {
        assert!(is_safe_relative("a.txt"));
        assert!(is_safe_relative("sub dir/日本.txt"));
        assert!(is_safe_relative("-rf.txt"));
        assert!(!is_safe_relative(""));
        assert!(!is_safe_relative("../x"));
        assert!(!is_safe_relative("a/../../x"));
        assert!(!is_safe_relative(".git/config"));
        assert!(!is_safe_relative("sub/.GIT/x"));
        assert!(!is_safe_relative("/etc/passwd"));
        // A drive path only exists on Windows; elsewhere `C:\x` is an ordinary file name.
        if cfg!(windows) {
            assert!(!is_safe_relative(r"C:\x"));
        }
    }

    #[test]
    fn nul_separates_paths() {
        assert_eq!(nul_separated(&["a".into(), "b c".into()]), b"a\0b c\0");
    }
}


/// Whether `path` looks like a file that holds credentials (keys, `.env` files, token configs).
pub fn looks_secret(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_ascii_lowercase();
    if name == ".env" || (name.starts_with(".env.") && !name.ends_with(".example") && !name.ends_with(".sample") && !name.ends_with(".template")) {
        return true;
    }
    const NAMES: &[&str] = &[".npmrc", ".pypirc", ".netrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json"];
    const EXTS: &[&str] = &[".pem", ".key", ".pfx", ".p12", ".jks", ".keystore", ".ppk", ".tfvars"];
    NAMES.contains(&name.as_str()) || EXTS.iter().any(|e| name.ends_with(e)) || name.starts_with("secrets.")
}

/// Replaces the per-file sections of a unified diff that belong to credential-looking files.
pub fn withhold_secrets(diff: &str) -> String {
    let mut out = String::with_capacity(diff.len());
    let mut skipping = false;
    for line in diff.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let path = rest.trim_end().rsplit_once(" b/").map(|(_, b)| b).unwrap_or("");
            skipping = looks_secret(path);
            if skipping {
                out.push_str(&format!("diff --git a/{path} b/{path}\n[contents withheld: {path} looks like a credential file]\n"));
                continue;
            }
        }
        if !skipping {
            out.push_str(line);
        }
    }
    out
}

#[cfg(test)]
mod secret_tests {
    use super::*;

    #[test]
    fn recognises_credential_files() {
        for p in [".env", "app/.env.local", "certs/server.pem", "id_rsa", "deploy/prod.tfvars", ".npmrc", "x/secrets.yml", "k.PFX"] {
            assert!(looks_secret(p), "{p}");
        }
        for p in [".env.example", "src/environment.ts", "README.md", "keyboard.rs", "secretsanta.txt"] {
            assert!(!looks_secret(p), "{p}");
        }
    }

    #[test]
    fn withholds_only_the_secret_sections() {
        let diff = "diff --git a/src/a.rs b/src/a.rs
+fn a() {}
diff --git a/.env b/.env
+TOKEN=abc123
+OTHER=1
diff --git a/b.rs b/b.rs
+fn b() {}
";
        let out = withhold_secrets(diff);
        assert!(!out.contains("abc123") && !out.contains("OTHER"));
        assert!(out.contains("+fn a() {}") && out.contains("+fn b() {}"));
        assert!(out.contains("[contents withheld: .env"));
    }
}
