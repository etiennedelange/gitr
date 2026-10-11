//! Shared test support: every git process in tests runs isolated from the developer's own
//! configuration and environment (the same approach and fixture values as gitoxide's `gix-testtools`,
//! MIT OR Apache-2.0).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use gitr_core::runner::EnvOp;
use gitr_core::{Git, GitRunner};

#[cfg(windows)]
pub const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
pub const NULL_DEVICE: &str = "/dev/null";

pub const AUTHOR_IDENT: &str = "Test Author <author@example.com> 946684800 +0000";

pub fn isolated_env() -> Vec<EnvOp> {
    let removed = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "GIT_SSH_COMMAND",
        "EDITOR",
        "VISUAL",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
    ];
    let set = [
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("GIT_CONFIG_GLOBAL", NULL_DEVICE),
        ("GIT_TERMINAL_PROMPT", "0"),
        // Same as the runner default: never wait for an editor (and never remove it, which would
        // override the runner's own GIT_EDITOR).
        ("GIT_EDITOR", "true"),
        ("GIT_AUTHOR_NAME", "Test Author"),
        ("GIT_AUTHOR_EMAIL", "author@example.com"),
        ("GIT_AUTHOR_DATE", "2000-01-01 00:00:00 +0000"),
        ("GIT_COMMITTER_NAME", "Test Committer"),
        ("GIT_COMMITTER_EMAIL", "committer@example.com"),
        ("GIT_COMMITTER_DATE", "2000-01-02 00:00:00 +0000"),
        ("TZ", "UTC0"),
        ("GIT_CONFIG_COUNT", "5"),
        ("GIT_CONFIG_KEY_0", "init.defaultBranch"),
        ("GIT_CONFIG_VALUE_0", "main"),
        ("GIT_CONFIG_KEY_1", "commit.gpgsign"),
        ("GIT_CONFIG_VALUE_1", "false"),
        ("GIT_CONFIG_KEY_2", "core.autocrlf"),
        ("GIT_CONFIG_VALUE_2", "false"),
        ("GIT_CONFIG_KEY_3", "protocol.file.allow"),
        ("GIT_CONFIG_VALUE_3", "always"),
        ("GIT_CONFIG_KEY_4", "core.longpaths"),
        ("GIT_CONFIG_VALUE_4", "true"),
    ];
    removed
        .into_iter()
        .map(EnvOp::remove)
        .chain(set.into_iter().map(|(k, v)| EnvOp::set(k, v)))
        .collect()
}

pub fn isolated_runner() -> GitRunner {
    GitRunner::default().with_env_ops(isolated_env())
}

pub fn isolated_git() -> Git {
    Git::new(isolated_runner())
}

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir).args(args);
    for op in isolated_env() {
        match op {
            EnvOp::Set(k, v) => cmd.env(k, v),
            EnvOp::Remove(k) => cmd.env_remove(k),
        };
    }
    cmd
}

/// Runs git (isolated) and returns stdout; panics on failure.
pub fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = command(dir, args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn git(dir: &Path, args: &[&str]) {
    git_out(dir, args);
}

/// Runs git (isolated) feeding `stdin`; returns stdout; panics on failure.
pub fn git_stdin(dir: &Path, args: &[&str], stdin: &[u8]) -> String {
    use std::io::Write;
    let mut child = command(dir, args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
}

pub fn write(dir: &Path, name: &str, content: &str) {
    let p = dir.join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

/// Writes `.git/hooks/<name>` and makes it executable (on Unix git skips a hook that isn't).
pub fn write_hook(repo: &Path, name: &str, script: &str) {
    let p = repo.join(".git/hooks").join(name);
    std::fs::write(&p, script).unwrap();
    make_executable(&p);
}

/// Sets the executable bit on Unix; Windows has none (git runs hooks there regardless).
pub fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = path;
}

pub fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap()
}

pub fn repo_with_commit() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    init(&dir);
    write(&dir, "a.txt", "one\n");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "init"]);
    (tmp, dir)
}

/// Adds an index-only entry (no worktree file), e.g. names Windows can't create (`*.md`).
/// `core.protectNTFS=false` lets Git for Windows record such a name in the index; it only
/// exists to prove that pathspecs are matched literally.
pub fn add_index_only(dir: &Path, name: &str, content: &str) {
    let blob = git_stdin(dir, &["hash-object", "-w", "--stdin"], content.as_bytes());
    git(
        dir,
        &["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", &format!("100644,{},{name}", blob.trim())],
    );
}

/// Names staged in the index relative to HEAD.
pub fn staged_names(dir: &Path) -> Vec<String> {
    let out = git_out(dir, &["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"]);
    let mut v: Vec<String> = out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect();
    v.sort();
    v
}

/// Captures `tracing` output (plain text) emitted on the current thread while it lives.
///
/// One global subscriber writes into a thread-local buffer. Per-thread `set_default`
/// subscribers are flaky when tests run in parallel, because tracing caches callsite interest
/// globally.
pub struct LogCapture {
    buf: Arc<Mutex<Vec<u8>>>,
}

thread_local! {
    static CAPTURE: std::cell::RefCell<Option<Arc<Mutex<Vec<u8>>>>> = const { std::cell::RefCell::new(None) };
}

static GLOBAL: std::sync::Once = std::sync::Once::new();

impl LogCapture {
    pub fn start() -> Self {
        GLOBAL.call_once(|| {
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .with_writer(|| ThreadWriter)
                .finish();
            tracing::subscriber::set_global_default(subscriber).expect("global test subscriber");
        });
        let buf = Arc::new(Mutex::new(Vec::new()));
        CAPTURE.with(|c| *c.borrow_mut() = Some(buf.clone()));
        Self { buf }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.buf.lock().unwrap()).into_owned()
    }

    /// Log lines for git calls whose op is `op`.
    pub fn git_lines(&self, op: &str) -> Vec<String> {
        let needle = format!("op=\"{op}\"");
        let alt = format!("op={op} ");
        self.text().lines().filter(|l| l.contains(&needle) || l.contains(&alt)).map(str::to_string).collect()
    }
}

impl Drop for LogCapture {
    fn drop(&mut self) {
        CAPTURE.with(|c| *c.borrow_mut() = None);
    }
}

struct ThreadWriter;

impl std::io::Write for ThreadWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        CAPTURE.with(|c| {
            if let Some(buf) = c.borrow().as_ref() {
                buf.lock().unwrap().extend_from_slice(data);
            }
        });
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A bin for tests: moves files into a folder (never the real Recycle Bin) and can be told to
/// refuse files by name, like a Recycle Bin that can't take them.
pub struct FakeBin {
    pub dir: PathBuf,
    fail: std::collections::HashSet<String>,
    moved: Mutex<Vec<(PathBuf, PathBuf)>>,
}

impl FakeBin {
    pub fn new(dir: PathBuf) -> Arc<Self> {
        Self::failing(dir, &[])
    }

    pub fn failing(dir: PathBuf, names: &[&str]) -> Arc<Self> {
        Arc::new(Self { dir, fail: names.iter().map(|s| s.to_string()).collect(), moved: Mutex::default() })
    }

    /// Content now in the bin for `original` (None if it was never moved).
    pub fn content_of(&self, original: &Path) -> Option<String> {
        let moved = self.moved.lock().unwrap();
        let (_, dest) = moved.iter().find(|(from, _)| from == original)?;
        Some(std::fs::read_to_string(dest).unwrap())
    }

    pub fn count(&self) -> usize {
        self.moved.lock().unwrap().len()
    }
}

impl gitr_core::repo::Bin for FakeBin {
    fn move_to_bin(&self, files: &[PathBuf]) -> Vec<Result<(), String>> {
        std::fs::create_dir_all(&self.dir).unwrap();
        files
            .iter()
            .map(|file| {
                let name = file.file_name().unwrap().to_string_lossy().into_owned();
                if self.fail.contains(&name) {
                    return Err(format!("simulated: the file is in use ({name})"));
                }
                let mut moved = self.moved.lock().unwrap();
                let dest = self.dir.join(format!("{}_{name}", moved.len()));
                std::fs::rename(file, &dest).map_err(|e| e.to_string())?;
                moved.push((file.clone(), dest));
                Ok(())
            })
            .collect()
    }
}

/// A fake bin next to the repo (inside the test's temp dir).
pub fn test_bin(repo: &Path) -> Arc<dyn gitr_core::repo::Bin> {
    FakeBin::new(repo.parent().unwrap().join("bin"))
}
