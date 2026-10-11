use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::{GitError, redact};

/// Default limit for read-only local commands (status, diff, log, …).
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Limit for network commands (fetch, push). Killing them never touches the worktree.
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

/// What a git invocation does. Every call must say so; it decides the time limit.
///
/// Local writes are never timed out: killing git mid-write (commit hooks, LFS smudge during a
/// merge, checkout) can leave `.git/index.lock` or a half-updated worktree, and on Windows the
/// process gets no chance to clean up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Reads repository state only.
    Read,
    /// Changes the index, refs, config or worktree on disk.
    LocalWrite,
    /// Talks to a remote (fetch, push).
    Network,
}

impl Kind {
    pub fn timeout(self, runner: &GitRunner) -> Option<Duration> {
        match self {
            Kind::Read => Some(runner.read_timeout),
            Kind::Network => Some(NETWORK_TIMEOUT),
            Kind::LocalWrite => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Read => "read",
            Kind::LocalWrite => "write",
            Kind::Network => "network",
        }
    }
}

/// An environment change applied on top of the runner's defaults (used to isolate tests).
#[derive(Debug, Clone)]
pub enum EnvOp {
    Set(OsString, OsString),
    Remove(OsString),
}

impl EnvOp {
    pub fn set(key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        Self::Set(key.as_ref().to_owned(), value.as_ref().to_owned())
    }

    pub fn remove(key: impl AsRef<OsStr>) -> Self {
        Self::Remove(key.as_ref().to_owned())
    }
}

/// Environment every git command gets.
pub const DEFAULT_ENV: &[(&str, &str)] = &[
    // Never block on a terminal credential prompt; GCM's GUI prompt still works.
    ("GIT_TERMINAL_PROMPT", "0"),
    // Status/diff must not take index.lock or rewrite the index.
    ("GIT_OPTIONAL_LOCKS", "0"),
    // English output, so stderr can be parsed.
    ("LC_ALL", "C"),
    // File names are never globs: `a[12].txt` must not match `a1.txt`.
    ("GIT_LITERAL_PATHSPECS", "1"),
    // Never open an editor; there is nobody to close it.
    ("GIT_EDITOR", "true"),
    ("GIT_MERGE_AUTOEDIT", "no"),
];

#[derive(Debug, Clone)]
pub struct GitRunner {
    /// Shared by every clone, so changing the Git path takes effect everywhere at once.
    git: Arc<RwLock<PathBuf>>,
    env: Vec<EnvOp>,
    read_timeout: Duration,
}

/// Receives git's stderr line by line while it runs.
pub type OnLine<'a> = &'a (dyn Fn(&str) + Send + Sync);

#[derive(Clone, Default)]
pub struct RunOpts<'a> {
    /// Written to git's stdin concurrently with reading its output.
    pub stdin: Option<&'a [u8]>,
    /// Exit codes treated as success (e.g. `diff --no-index` exits 1 when files differ).
    pub ok_codes: &'a [i32],
    /// Extra environment for this call only (after the runner's own).
    pub env: Vec<(OsString, OsString)>,
    /// Called with each line of stderr as git prints it (hooks print there too). stderr is
    /// still collected for the result.
    pub on_stderr: Option<OnLine<'a>>,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self::new("git")
    }
}

struct Outcome {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl GitRunner {
    pub fn new(git: impl Into<PathBuf>) -> Self {
        Self { git: Arc::new(RwLock::new(git.into())), env: Vec::new(), read_timeout: READ_TIMEOUT }
    }

    /// The git executable used for every command (by this runner and all its clones).
    pub fn program(&self) -> PathBuf {
        self.git.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Switches the git executable for this runner and all its clones, immediately.
    pub fn set_program(&self, git: impl Into<PathBuf>) {
        *self.git.write().unwrap_or_else(|e| e.into_inner()) = git.into();
    }

    /// Adds environment changes applied after the defaults (later entries win).
    pub fn with_env_ops(mut self, ops: impl IntoIterator<Item = EnvOp>) -> Self {
        self.env.extend(ops);
        self
    }

    pub fn with_env(self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.with_env_ops([EnvOp::set(key, value)])
    }

    pub fn without_env(self, key: impl AsRef<OsStr>) -> Self {
        self.with_env_ops([EnvOp::remove(key)])
    }

    pub fn with_read_timeout(mut self, timeout: Duration) -> Self {
        self.read_timeout = timeout;
        self
    }

    pub async fn run(&self, cwd: &Path, kind: Kind, args: &[&str]) -> Result<String, GitError> {
        self.run_with(cwd, kind, args, RunOpts::default()).await
    }

    /// `git --version` output, or a description of why it could not be determined.
    pub async fn version(&self) -> String {
        match self.run(&std::env::temp_dir(), Kind::Read, &["--version"]).await {
            Ok(v) => v.trim().to_string(),
            Err(e) => format!("unavailable ({e})"),
        }
    }

    pub async fn run_with(
        &self,
        cwd: &Path,
        kind: Kind,
        args: &[&str],
        opts: RunOpts<'_>,
    ) -> Result<String, GitError> {
        let op = args.first().copied().unwrap_or("git");
        let started = Instant::now();
        let result = self.exec(cwd, kind, args, &opts).await;
        let elapsed = started.elapsed();
        let result = result.and_then(|out| {
            if out.code == Some(0) || out.code.is_some_and(|c| opts.ok_codes.contains(&c)) {
                return Ok(out);
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = crate::pathbytes::decode(&out.stdout);
            Err(GitError::failed(op, &cwd.to_string_lossy(), out.code, &stderr, &stdout))
        });
        log_call(op, kind, args, cwd, elapsed, &result);
        result.map(|out| crate::pathbytes::decode(&out.stdout))
    }

    async fn exec(&self, cwd: &Path, kind: Kind, args: &[&str], opts: &RunOpts<'_>) -> Result<Outcome, GitError> {
        let mut cmd = Command::new(self.program());
        cmd.current_dir(cwd)
            .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
            .args(args.iter().map(|a| crate::pathbytes::to_os(a)))
            .envs(DEFAULT_ENV.iter().copied())
            .stdin(if opts.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Its own process group, so a cancel or timeout can end the hooks and helpers it starts.
        #[cfg(unix)]
        cmd.process_group(0);
        for op in &self.env {
            match op {
                EnvOp::Set(k, v) => cmd.env(k, v),
                EnvOp::Remove(k) => cmd.env_remove(k),
            };
        }
        cmd.envs(opts.env.iter().map(|(k, v)| (k, v)));
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            // Paused until it is in its job (below).
            cmd.creation_flags(CREATE_NO_WINDOW | crate::job::CREATE_SUSPENDED);
        }

        let mut child = cmd.spawn().map_err(|e| GitError::Spawn { message: e.to_string() })?;
        let pid = child.id();
        // Windows: put the paused git in its own job, then let it run, so nothing it starts can
        // be outside the job (see job.rs). Without a job, `taskkill /T` is the fallback.
        #[cfg(windows)]
        let job = match pid {
            Some(pid) => {
                let job = crate::job::Job::holding(pid);
                if !crate::job::resume(pid) {
                    let _ = child.start_kill();
                    return Err(GitError::Spawn { message: "git was started but could not be resumed".into() });
                }
                job
            }
            None => None,
        };

        // Feed stdin while git's output is being read; writing everything first deadlocks once
        // both pipes are full.
        let writer = match (opts.stdin, child.stdin.take()) {
            (Some(data), Some(mut stdin)) => {
                let data = data.to_vec();
                Some(tokio::spawn(async move {
                    let res = stdin.write_all(&data).await;
                    drop(stdin);
                    res
                }))
            }
            _ => None,
        };

        let (mut stdout, mut stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
        let on_stderr = opts.on_stderr;
        let wait = async {
            let read_out = async {
                let mut buf = Vec::new();
                stdout.read_to_end(&mut buf).await.map(|_| buf)
            };
            let read_err = async {
                let mut buf = Vec::new();
                let mut reader = BufReader::new(&mut stderr);
                loop {
                    let start = buf.len();
                    if reader.read_until(b'\n', &mut buf).await? == 0 {
                        break;
                    }
                    if let Some(f) = on_stderr {
                        f(String::from_utf8_lossy(&buf[start..]).trim_end_matches(['\r', '\n']));
                    }
                }
                Ok::<_, std::io::Error>(buf)
            };
            let (status, out, err) = tokio::join!(child.wait(), read_out, read_err);
            Ok::<_, std::io::Error>((status?, out?, err?))
        };
        // Declared after `child`, so it drops first: the tree is killed while git still runs.
        let mut tree = ProcessTree {
            pid,
            #[cfg(windows)]
            job,
        };
        let (status, stdout, stderr) = match kind.timeout(self) {
            Some(limit) => tokio::time::timeout(limit, wait).await.map_err(|_| GitError::Timeout {
                op: args.first().copied().unwrap_or("git").to_string(),
                seconds: limit.as_secs(),
            })?,
            None => wait.await,
        }
        .map_err(|e| GitError::Spawn { message: e.to_string() })?;
        tree.pid = None;

        if let Some(writer) = writer
            && let Ok(Err(e)) = writer.await
            && status.success()
        {
            // git exited 0 without reading all of its input; treat that as a failure.
            return Err(GitError::Spawn { message: format!("writing to git stdin failed: {e}") });
        }

        Ok(Outcome { code: status.code(), stdout, stderr })
    }
}

/// Kills git and every process it started (hooks, credential helpers, ssh) if it is dropped while
/// git still runs: when the operation is cancelled or timed out. `kill_on_drop` alone ends only
/// git itself, and a hung hook would keep running.
struct ProcessTree {
    pid: Option<u32>,
    /// On Windows, a job holding git: everything git starts joins it, which `taskkill /T` can't
    /// match (see `job.rs`). None if Windows refused; `taskkill /T` is the fallback then.
    #[cfg(windows)]
    job: Option<crate::job::Job>,
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        let Some(pid) = self.pid else { return };
        tracing::info!(target: "gitr::git", pid, "killing git process tree");
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
            return;
        }
        kill_tree(pid);
    }
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // git leads its own process group (see `exec`).
    // SAFETY: killpg only sends a signal; the group exists while git is unreaped.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Full path, so a `taskkill.exe` in the repo or on PATH is never run. Waits for it: the tree
    // can only be found while git (its root) is alive, and git is killed right after this.
    let taskkill = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
        .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
    let _ = std::process::Command::new(taskkill)
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn log_call(op: &str, kind: Kind, args: &[&str], cwd: &Path, elapsed: Duration, result: &Result<Outcome, GitError>) {
    let args = redact::urls(&args.join(" ")).into_owned();
    let cwd = cwd.display();
    let duration_ms = elapsed.as_millis() as u64;
    match result {
        Ok(out) => tracing::info!(
            target: "gitr::git",
            op, kind = kind.as_str(), args = %args, cwd = %cwd, duration_ms, exit_code = out.code.unwrap_or(-1),
            "git ok"
        ),
        Err(e) => {
            let (exit_code, detail) = match e {
                GitError::Failed { code, stderr, .. } => (code.unwrap_or(-1), first_line(stderr)),
                other => (-1, other.to_string()),
            };
            tracing::warn!(
                target: "gitr::git",
                op, kind = kind.as_str(), args = %args, cwd = %cwd, duration_ms, exit_code,
                stderr = %redact::urls(&detail),
                "git failed"
            );
        }
    }
}

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeouts_by_kind() {
        let r = GitRunner::default();
        assert_eq!(Kind::Read.timeout(&r), Some(Duration::from_secs(30)));
        assert_eq!(Kind::Network.timeout(&r), Some(Duration::from_secs(300)));
        assert_eq!(Kind::LocalWrite.timeout(&r), None);
        let r = r.with_read_timeout(Duration::from_secs(1));
        assert_eq!(Kind::Read.timeout(&r), Some(Duration::from_secs(1)));
        assert_eq!(Kind::LocalWrite.timeout(&r), None);
    }

    #[test]
    fn changing_the_program_applies_to_every_clone() {
        let r = GitRunner::new("git");
        let clone = r.clone();
        r.set_program("C:/Git/cmd/git.exe");
        assert_eq!(clone.program(), std::path::PathBuf::from("C:/Git/cmd/git.exe"));
    }

    #[test]
    fn default_env_is_literal_and_non_interactive() {
        let get = |k: &str| DEFAULT_ENV.iter().find(|(key, _)| *key == k).map(|(_, v)| *v);
        assert_eq!(get("GIT_LITERAL_PATHSPECS"), Some("1"));
        assert_eq!(get("GIT_EDITOR"), Some("true"));
        assert_eq!(get("GIT_MERGE_AUTOEDIT"), Some("no"));
        assert_eq!(get("GIT_TERMINAL_PROMPT"), Some("0"));
    }
}
