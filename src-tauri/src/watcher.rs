use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use notify_debouncer_mini::notify::RecommendedWatcher;
use tauri::{AppHandle, Manager};

use crate::ops::RepoOps;
use crate::state::AppState;

pub struct RepoWatcher {
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// Watches each configured root recursively and refreshes the owning repo's summary.
pub fn start(app: &AppHandle) -> Option<RepoWatcher> {
    let state = app.state::<AppState>();
    let config = state.config();
    if !config.watch {
        return None;
    }
    let excludes: Vec<String> = config.excludes.iter().map(|e| e.to_ascii_lowercase()).collect();
    let handle = app.clone();

    let mut debouncer = new_debouncer(Duration::from_millis(400), move |res: DebounceEventResult| {
        let state = handle.state::<AppState>();
        let repos: Vec<PathBuf> = state.repos().into_iter().map(|r| PathBuf::from(r.path)).collect();
        let dirty: HashSet<PathBuf> = match res {
            Ok(events) => events
                .iter()
                .filter(|ev| !is_noise(&ev.path, &excludes))
                .filter_map(|ev| owning_repo(&ev.path, &repos))
                .collect(),
            // Events were lost (e.g. the OS buffer overflowed during a big checkout): any repo
            // may have changed, so all of them are refreshed.
            Err(e) => {
                tracing::warn!(target: "gitr", error = %e, "file watcher error; refreshing every repo");
                repos.into_iter().collect()
            }
        };
        // Held back while the window is unfocused; merged per repo and deferred while a write
        // runs (see ops::RepoOps).
        let ops = handle.state::<RepoOps>();
        for repo in handle.state::<FocusGate>().admit(dirty) {
            ops.request_refresh(&repo);
        }
    })
    .ok()?;

    for group in &config.groups {
        for root in &group.roots {
            let _ = debouncer.watcher().watch(root, RecursiveMode::Recursive);
        }
    }
    Some(RepoWatcher { _debouncer: debouncer })
}

/// Watcher-driven refreshes only run while Gitr's window has focus. While it is unfocused
/// (you are in your editor or terminal) changed repos are remembered, and refreshed once each
/// when the window gets focus back. Refreshes after Gitr's own operations are not gated.
pub struct FocusGate {
    inner: Mutex<GateState>,
}

struct GateState {
    focused: bool,
    pending: HashSet<PathBuf>,
}

impl Default for FocusGate {
    fn default() -> Self {
        Self { inner: Mutex::new(GateState { focused: true, pending: HashSet::new() }) }
    }
}

impl FocusGate {
    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The repos to refresh now; while unfocused they are remembered instead and none are returned.
    pub fn admit(&self, repos: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
        let mut st = self.lock();
        if st.focused {
            return repos.into_iter().collect();
        }
        st.pending.extend(repos);
        Vec::new()
    }

    /// Records a focus change. On gaining focus, returns the repos that changed meanwhile.
    pub fn set_focused(&self, focused: bool) -> Vec<PathBuf> {
        let mut st = self.lock();
        st.focused = focused;
        if focused { st.pending.drain().collect() } else { Vec::new() }
    }
}

fn is_noise(path: &Path, excludes: &[String]) -> bool {
    let parts: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect();
    if parts.iter().any(|p| excludes.contains(p)) {
        return true;
    }
    match parts.iter().position(|p| p == ".git") {
        Some(i) => !is_interesting_git_path(&parts[i + 1..]),
        // Worktree files are always interesting (including Cargo.lock, yarn.lock, …).
        None => false,
    }
}

/// Inside `.git`, only files that change what Gitr shows trigger a refresh (an allowlist).
/// Everything else is git's own bookkeeping, including files git writes during read-only
/// commands: with `core.fsmonitor` every `git status` creates a cookie in
/// `.git/fsmonitor--daemon/cookies`, which used to trigger the next refresh, in a loop.
fn is_interesting_git_path(rest: &[String]) -> bool {
    if rest.last().is_some_and(|f| f.ends_with(".lock")) {
        return false;
    }
    match rest {
        [file] => matches!(
            file.as_str(),
            "head"
                | "index"
                | "packed-refs"
                | "config"
                | "fetch_head"
                | "orig_head"
                | "merge_head"
                | "cherry_pick_head"
                | "revert_head"
                // A bisect is recognised by BISECT_LOG; `git bisect start` alone doesn't move HEAD.
                | "bisect_log"
                | "bisect_start"
        ),
        [dir, ..] => matches!(dir.as_str(), "refs" | "rebase-merge" | "rebase-apply"),
        [] => false,
    }
}

fn owning_repo(path: &Path, repos: &[PathBuf]) -> Option<PathBuf> {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    repos
        .iter()
        .filter(|r| {
            let r = r.to_string_lossy().to_ascii_lowercase();
            lower == r || lower.starts_with(&format!("{r}\\")) || lower.starts_with(&format!("{r}/"))
        })
        .max_by_key(|r| r.as_os_str().len())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_noise() {
        let ex = vec!["node_modules".to_string()];
        // Written as Windows paths; elsewhere `\` is not a separator, so convert them.
        let native = |p: &str| if cfg!(windows) { PathBuf::from(p) } else { PathBuf::from(p.trim_start_matches("D:").replace('\\', "/")) };
        let noise = |p: &str| is_noise(&native(p), &ex);
        // Excluded folders and git internals that never change what Gitr shows.
        for p in [
            r"D:\r\a\node_modules\x\y.js",
            r"D:\r\a\.git\objects\ab\cd",
            r"D:\r\a\.git\index.lock",
            r"D:\r\a\.git\refs\heads\main.lock",
            r"D:\r\a\.git\fsmonitor--daemon\cookies\105564-18912",
            r"D:\r\a\.git\fsmonitor--daemon\cookies",
            r"D:\r\a\.git\COMMIT_EDITMSG",
            r"D:\r\a\.git\logs\HEAD",
            r"D:\r\a\.git",
        ] {
            assert!(noise(p), "{p} must not refresh");
        }
        // Git state that does change what Gitr shows.
        for p in [
            r"D:\r\a\.git\index",
            r"D:\r\a\.git\HEAD",
            r"D:\r\a\.git\refs\heads\feature\x",
            r"D:\r\a\.git\refs\remotes\origin\main",
            r"D:\r\a\.git\packed-refs",
            r"D:\r\a\.git\config",
            r"D:\r\a\.git\FETCH_HEAD",
            r"D:\r\a\.git\MERGE_HEAD",
            r"D:\r\a\.git\rebase-merge\done",
            r"D:\r\a\.git\rebase-apply\applying",
            r"D:\r\a\.git\BISECT_LOG",
            r"D:\r\a\.git\BISECT_START",
            // Worktree files always refresh, including package-manager lock files.
            r"D:\r\a\src\objects\x.rs",
            r"D:\r\a\Cargo.lock",
            r"D:\r\a\web\yarn.lock",
        ] {
            assert!(!noise(p), "{p} must refresh");
        }
    }

    #[test]
    fn focus_gate_holds_refreshes_while_unfocused() {
        let gate = FocusGate::default();
        let (a, b) = (PathBuf::from("a"), PathBuf::from("b"));
        assert_eq!(gate.admit([a.clone()]), vec![a.clone()], "focused at start: refresh right away");

        assert!(gate.set_focused(false).is_empty());
        assert!(gate.admit([a.clone(), b.clone()]).is_empty());
        assert!(gate.admit([a.clone()]).is_empty());
        let mut on_focus = gate.set_focused(true);
        on_focus.sort();
        assert_eq!(on_focus, vec![a.clone(), b], "each changed repo once, on focus");

        assert!(gate.set_focused(true).is_empty(), "nothing left over");
        assert_eq!(gate.admit([a.clone()]), vec![a]);
    }

    #[test]
    fn maps_to_deepest_repo() {
        let repos = vec![PathBuf::from(r"D:\R\a"), PathBuf::from(r"D:\R\a\nested"), PathBuf::from(r"D:\R\ab")];
        assert_eq!(owning_repo(Path::new(r"D:\R\a\nested\x.rs"), &repos), Some(PathBuf::from(r"D:\R\a\nested")));
        assert_eq!(owning_repo(Path::new(r"d:\r\ab\x.rs"), &repos), Some(PathBuf::from(r"D:\R\ab")));
        assert_eq!(owning_repo(Path::new(r"D:\R\other\x.rs"), &repos), None);
    }

    /// Regression: fsmonitor cookies must not trigger refreshes after a git status (seen as
    /// ~300 `git status` runs in 75 s on an idle repo).
    #[cfg(windows)]
    #[test]
    fn own_git_status_does_not_trigger_a_refresh() {
        use notify_debouncer_mini::notify::{self, Watcher};
        use std::process::Command;
        use std::time::Duration;

        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git").current_dir(&repo).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        git(&["add", "."]);
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        git(&["config", "core.fsmonitor", "true"]);
        git(&["status"]); // starts the fsmonitor daemon
        std::thread::sleep(Duration::from_millis(500));

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        })
        .unwrap();
        watcher.watch(&repo, notify::RecursiveMode::Recursive).unwrap();

        let runner = gitr_core::Git::default();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for _ in 0..3 {
            rt.block_on(runner.status(&repo)).unwrap();
        }
        // Git installations without a running fsmonitor daemon emit no cookies; exercise
        // the same watcher path explicitly so the test still proves the filter is active.
        let cookie = repo.join(".git").join("fsmonitor--daemon").join("cookies").join("audit-cookie");
        std::fs::create_dir_all(cookie.parent().unwrap()).unwrap();
        std::fs::write(&cookie, "").unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        drop(watcher);
        let _ = Command::new("git").current_dir(&repo).args(["fsmonitor--daemon", "stop"]).output();

        let events: Vec<PathBuf> = rx.try_iter().collect();
        assert!(
            events.iter().any(|p| p == &cookie),
            "expected the fsmonitor cookie to reach the watcher: {events:?}"
        );
        let triggering: Vec<&PathBuf> = events.iter().filter(|p| !is_noise(p, &[])).collect();
        assert!(triggering.is_empty(), "our own git status would trigger refreshes: {triggering:?}");
    }
}
