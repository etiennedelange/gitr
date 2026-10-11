//! Per-repository coordination of git operations (no Tauri dependency, so it is unit-testable).
//!
//! - **Writes** (stage, commit, checkout, pull, push, …) take a per-repo fair (FIFO) lock, once,
//!   at the command boundary. Reads never touch this module.
//! - **Join**: a fetch/pull requested while the same operation runs on that repo waits for it and
//!   shares its result instead of running git again.
//! - **Busy state**: every queued or running write (and fetch) is an activity; the repo is busy
//!   while it has any. Changes of the displayed operation are reported through `on_busy`.
//! - **Cancel**: `cancel` stops everything running or queued on a repo that was started through
//!   `cancellable`. The work is dropped, which kills its git processes (see the runner).
//! - **Refresh gate**: per repo at most one refresh runs and one is queued; requests while a
//!   write is pending are deferred until the repo has no writes left.

use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, watch};

/// How long closing the app or installing an update waits for running writes.
pub const WRITES_LIMIT: std::time::Duration = std::time::Duration::from_secs(120);

pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
/// Called with the repo and its displayed operation (`None` = idle) whenever that changes.
pub type BusyFn = Arc<dyn Fn(&Path, Option<&'static str>) + Send + Sync>;
/// Produces one refresh of a repo (status → UI).
pub type RefreshFn = Arc<dyn Fn(PathBuf) -> BoxFuture + Send + Sync>;
/// Runs a future in the background (Tauri's runtime in the app, tokio in tests).
pub type SpawnFn = Arc<dyn Fn(BoxFuture) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NetOp {
    Fetch,
    Pull,
}

/// The operation was stopped by `RepoOps::cancel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

/// The repo already has a write running or queued; carries its operation name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Busy(pub &'static str);

#[derive(Clone)]
pub struct RepoOps {
    inner: Arc<Inner>,
}

struct Inner {
    repos: Mutex<HashMap<String, RepoState>>,
    next_id: AtomicU64,
    on_busy: BusyFn,
    refresh: RefreshFn,
    spawn: SpawnFn,
}

struct Activity {
    id: u64,
    op: &'static str,
    write: bool,
    running: bool,
}

#[derive(Default)]
struct RefreshState {
    running: bool,
    queued: bool,
    deferred: bool,
}

struct RepoState {
    path: PathBuf,
    write: Arc<AsyncMutex<()>>,
    activities: Vec<Activity>,
    shown: Option<&'static str>,
    inflight: HashMap<NetOp, Box<dyn Any + Send>>,
    refresh: RefreshState,
    /// Bumped by `cancel`; every `cancellable` running on the repo watches it.
    cancel: watch::Sender<u64>,
}

impl RepoState {
    fn new(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            write: Arc::new(AsyncMutex::new(())),
            activities: Vec::new(),
            shown: None,
            inflight: HashMap::new(),
            refresh: RefreshState::default(),
            cancel: watch::Sender::new(0),
        }
    }

    fn writes_pending(&self) -> bool {
        self.activities.iter().any(|a| a.write)
    }

    /// The operation to display: the most recently started running activity, else the first
    /// queued one (between one write finishing and the next acquiring the lock).
    fn label(&self) -> Option<&'static str> {
        self.activities
            .iter()
            .rev()
            .find(|a| a.running)
            .or_else(|| self.activities.first())
            .map(|a| a.op)
    }

    /// Updates `shown`; returns the change to report, if any.
    fn relabel(&mut self) -> Option<(PathBuf, Option<&'static str>)> {
        let label = self.label();
        (label != self.shown).then(|| {
            self.shown = label;
            (self.path.clone(), label)
        })
    }
}

fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().replace('/', "\\")
}

impl RepoOps {
    pub fn new(on_busy: BusyFn, refresh: RefreshFn, spawn: SpawnFn) -> Self {
        Self {
            inner: Arc::new(Inner {
                repos: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                on_busy,
                refresh,
                spawn,
            }),
        }
    }

    fn repos(&self) -> MutexGuard<'_, HashMap<String, RepoState>> {
        self.inner.repos.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn report(&self, change: Option<(PathBuf, Option<&'static str>)>) {
        if let Some((path, op)) = change {
            (self.inner.on_busy)(&path, op);
        }
    }

    fn add_activity(&self, path: &Path, op: &'static str, write: bool, running: bool) -> (ActivityGuard, Arc<AsyncMutex<()>>) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (lock, change) = {
            let mut repos = self.repos();
            let repo = repos.entry(key(path)).or_insert_with(|| RepoState::new(path));
            repo.activities.push(Activity { id, op, write, running });
            (repo.write.clone(), repo.relabel())
        };
        self.report(change);
        (ActivityGuard { ops: self.clone(), key: key(path), id }, lock)
    }

    fn mark_running(&self, key: &str, id: u64) {
        let change = {
            let mut repos = self.repos();
            let Some(repo) = repos.get_mut(key) else { return };
            if let Some(a) = repo.activities.iter_mut().find(|a| a.id == id) {
                a.running = true;
            }
            repo.relabel()
        };
        self.report(change);
    }

    /// Waits for the repo's write lock (FIFO) and holds it until the guard is dropped.
    /// The repo counts as busy from the moment of the call, including while queued.
    pub async fn write(&self, path: &Path, op: &'static str) -> WriteGuard {
        let (activity, lock) = self.add_activity(path, op, true, false);
        let held = lock.lock_owned().await;
        self.mark_running(&activity.key, activity.id);
        WriteGuard { _lock: held, _activity: activity }
    }

    /// Whether any repository has a write (commit, checkout, pull, …) running or queued.
    pub fn writes_running(&self) -> bool {
        self.repos().values().any(|r| r.writes_pending())
    }

    /// Waits until no repository has a write running or queued, but at most `limit`: a stuck git
    /// (a hook waiting for input) must not hold things up forever. Returns whether they finished.
    pub async fn writes_finished(&self, limit: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        while self.writes_running() {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        true
    }

    /// The operation of the write running (or first queued) on `path`, if any.
    pub fn busy_write(&self, path: &Path) -> Option<Busy> {
        let repos = self.repos();
        let repo = repos.get(&key(path))?;
        let writes = || repo.activities.iter().filter(|a| a.write);
        writes().find(|a| a.running).or_else(|| writes().next()).map(|a| Busy(a.op))
    }

    /// Marks the repo busy with a non-write operation (e.g. fetching) until the guard drops.
    pub fn activity(&self, path: &Path, op: &'static str) -> ActivityGuard {
        self.add_activity(path, op, false, true).0
    }

    /// Whether `op` is currently running on `path` (so a new request would join it).
    pub fn is_inflight(&self, path: &Path, op: NetOp) -> bool {
        self.repos().get(&key(path)).is_some_and(|r| r.inflight.contains_key(&op))
    }

    /// Runs `make()` unless `op` is already running on `path`; then waits for that run and
    /// returns a clone of its result. If the running caller goes away without a result, the
    /// waiting caller runs the operation itself.
    pub async fn join<T, F, Fut>(&self, path: &Path, op: NetOp, make: F) -> T
    where
        T: Clone + Send + Sync + 'static,
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let mut make = Some(make);
        loop {
            enum Role<T> {
                Wait(watch::Receiver<Option<T>>),
                Lead(watch::Sender<Option<T>>),
            }
            let role = {
                let mut repos = self.repos();
                let repo = repos.entry(key(path)).or_insert_with(|| RepoState::new(path));
                match repo.inflight.get(&op).and_then(|rx| rx.downcast_ref::<watch::Receiver<Option<T>>>()) {
                    Some(rx) => Role::Wait(rx.clone()),
                    None => {
                        let (tx, rx) = watch::channel(None);
                        repo.inflight.insert(op, Box::new(rx));
                        Role::Lead(tx)
                    }
                }
            };
            match role {
                Role::Wait(mut rx) => {
                    if let Ok(value) = rx.wait_for(Option::is_some).await {
                        return value.clone().expect("checked by wait_for");
                    }
                    // The leader was dropped before publishing; try again (possibly leading).
                }
                Role::Lead(tx) => {
                    let _cleanup = InflightGuard { ops: self.clone(), key: key(path), op };
                    let make = make.take().expect("a caller leads at most once");
                    let value = make().await;
                    let _ = tx.send(Some(value.clone()));
                    return value;
                }
            }
        }
    }

    /// Runs `work` until it finishes or `cancel(path)` is called. On cancel `work` is dropped
    /// wherever it is: waiting for the write lock, or with git running (which kills git).
    pub async fn cancellable<T>(&self, path: &Path, work: impl Future<Output = T>) -> Result<T, Cancelled> {
        let mut cancel = {
            let mut repos = self.repos();
            repos.entry(key(path)).or_insert_with(|| RepoState::new(path)).cancel.subscribe()
        };
        let cancelled = async move {
            // The sender lives as long as the repo's state; if it is gone, never cancel.
            if cancel.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            biased;
            () = cancelled => Err(Cancelled),
            out = work => Ok(out),
        }
    }

    /// Stops every cancellable operation running or queued on `path`. Returns whether anything
    /// was busy there.
    pub fn cancel(&self, path: &Path) -> bool {
        let repos = self.repos();
        let Some(repo) = repos.get(&key(path)).filter(|r| !r.activities.is_empty()) else { return false };
        tracing::info!(target: "gitr", repo = %repo.path.display(), op = ?repo.shown, "cancelling");
        repo.cancel.send_modify(|n| *n += 1);
        true
    }

    /// Asks for a refresh of `path`: merged with a queued one, held back while writes are pending.
    pub fn request_refresh(&self, path: &Path) {
        let start = {
            let mut repos = self.repos();
            let repo = repos.entry(key(path)).or_insert_with(|| RepoState::new(path));
            if repo.writes_pending() {
                repo.refresh.deferred = true;
                false
            } else if repo.refresh.running {
                repo.refresh.queued = true;
                false
            } else {
                repo.refresh.running = true;
                true
            }
        };
        if start {
            let ops = self.clone();
            let path = path.to_path_buf();
            (self.inner.spawn)(Box::pin(async move { ops.refresh_loop(path).await }));
        }
    }

    async fn refresh_loop(self, path: PathBuf) {
        let k = key(&path);
        loop {
            (self.inner.refresh)(path.clone()).await;
            let mut repos = self.repos();
            let Some(repo) = repos.get_mut(&k) else { return };
            if repo.refresh.queued && !repo.writes_pending() {
                repo.refresh.queued = false;
                continue;
            }
            if repo.refresh.queued {
                // A write started meanwhile: hold the queued refresh until it is done.
                repo.refresh.queued = false;
                repo.refresh.deferred = true;
            }
            repo.refresh.running = false;
            return;
        }
    }

    /// Whether anything (a write, or a fetch) is running or queued on `path`.
    pub fn is_busy(&self, path: &Path) -> bool {
        self.repos().get(&key(path)).is_some_and(|r| !r.activities.is_empty())
    }

    /// Repos that are busy right now, with the displayed operation.
    pub fn busy_repos(&self) -> Vec<(PathBuf, &'static str)> {
        self.repos().values().filter_map(|r| r.shown.map(|op| (r.path.clone(), op))).collect()
    }

    fn finish(&self, key: &str, id: u64) {
        let (change, refresh) = {
            let mut repos = self.repos();
            let Some(repo) = repos.get_mut(key) else { return };
            repo.activities.retain(|a| a.id != id);
            let refresh = (!repo.writes_pending() && repo.refresh.deferred).then(|| {
                repo.refresh.deferred = false;
                repo.path.clone()
            });
            (repo.relabel(), refresh)
        };
        self.report(change);
        if let Some(path) = refresh {
            self.request_refresh(&path);
        }
    }
}

/// Keeps a repo busy; dropping it (also on error or panic) ends the activity.
pub struct ActivityGuard {
    ops: RepoOps,
    key: String,
    id: u64,
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.ops.finish(&self.key, self.id);
    }
}

/// Holds a repo's write lock. Fields drop in order: the lock is released before the activity
/// ends, so the next queued write can start and the repo never flickers to idle in between.
pub struct WriteGuard {
    _lock: OwnedMutexGuard<()>,
    _activity: ActivityGuard,
}

struct InflightGuard {
    ops: RepoOps,
    key: String,
    op: NetOp,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Some(repo) = self.ops.repos().get_mut(&self.key) {
            repo.inflight.remove(&self.op);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    type Events = Arc<Mutex<Vec<(String, Option<&'static str>)>>>;

    struct Harness {
        ops: RepoOps,
        events: Events,
        refreshes: Arc<AtomicUsize>,
    }

    fn harness(refresh_delay: Duration) -> Harness {
        let events: Events = Arc::default();
        let refreshes = Arc::new(AtomicUsize::new(0));
        let ev = events.clone();
        let rc = refreshes.clone();
        let ops = RepoOps::new(
            Arc::new(move |p, op| ev.lock().unwrap().push((p.to_string_lossy().into_owned(), op))),
            Arc::new(move |_p| {
                let rc = rc.clone();
                Box::pin(async move {
                    rc.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(refresh_delay).await;
                })
            }),
            Arc::new(|f| {
                tokio::spawn(f);
            }),
        );
        Harness { ops, events, refreshes }
    }

    fn repo(name: &str) -> PathBuf {
        PathBuf::from(format!(r"C:\r\{name}"))
    }

    async fn timed_write(ops: RepoOps, path: PathBuf, op: &'static str, hold: Duration) -> (Instant, Instant) {
        let _g = ops.write(&path, op).await;
        let start = Instant::now();
        tokio::time::sleep(hold).await;
        (start, Instant::now())
    }

    #[tokio::test]
    async fn same_repo_writes_never_overlap() {
        let h = harness(Duration::ZERO);
        let a = tokio::spawn(timed_write(h.ops.clone(), repo("a"), "committing", Duration::from_millis(100)));
        let b = tokio::spawn(timed_write(h.ops.clone(), repo("A"), "staging", Duration::from_millis(100)));
        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        assert!(a.1 <= b.0 || b.1 <= a.0, "writes overlapped: {a:?} {b:?}");
    }

    #[tokio::test]
    async fn different_repos_run_in_parallel() {
        let h = harness(Duration::ZERO);
        let a = tokio::spawn(timed_write(h.ops.clone(), repo("a"), "committing", Duration::from_millis(150)));
        let b = tokio::spawn(timed_write(h.ops.clone(), repo("b"), "committing", Duration::from_millis(150)));
        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        assert!(a.0 < b.1 && b.0 < a.1, "expected overlap: {a:?} {b:?}");
    }

    #[tokio::test]
    async fn writes_run_in_request_order() {
        let h = harness(Duration::ZERO);
        let order = Arc::new(Mutex::new(Vec::new()));
        let first = h.ops.write(&repo("a"), "committing").await;
        let mut tasks = Vec::new();
        for i in 0..5 {
            let (ops, order) = (h.ops.clone(), order.clone());
            tasks.push(tokio::spawn(async move {
                let _g = ops.write(&repo("a"), "staging").await;
                order.lock().unwrap().push(i);
            }));
            // Let task i enqueue before task i+1.
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(first);
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn writes_finished_waits_for_queued_and_running_writes() {
        let h = harness(Duration::ZERO);
        assert!(!h.ops.writes_running());
        let _fetch = h.ops.activity(&repo("a"), "fetching");
        assert!(!h.ops.writes_running(), "a fetch is not a write");
        let first = h.ops.write(&repo("b"), "committing").await;
        let ops = h.ops.clone();
        let queued = tokio::spawn(async move {
            let _g = ops.write(&repo("b"), "staging").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!h.ops.writes_finished(Duration::from_millis(50)).await, "gives up at the limit");
        drop(first);
        assert!(h.ops.writes_finished(Duration::from_secs(5)).await);
        assert!(queued.is_finished(), "waited for the queued write too");
    }

    #[tokio::test]
    async fn busy_write_reports_the_running_write() {
        let h = harness(Duration::ZERO);
        assert!(!h.ops.is_busy(&repo("a")));
        let f = h.ops.activity(&repo("a"), "fetching");
        assert!(h.ops.is_busy(&repo("a")), "a fetch counts as busy");
        drop(f);
        assert!(!h.ops.is_busy(&repo("a")));
        assert_eq!(h.ops.busy_write(&repo("a")), None);
        let g = h.ops.write(&repo("a"), "committing").await;
        // A queued write does not change what is reported: the running one is.
        let ops = h.ops.clone();
        let queued = tokio::spawn(async move { drop(ops.write(&repo("a"), "pushing").await) });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(h.ops.busy_write(&repo("a")), Some(Busy("committing")));
        assert_eq!(h.ops.busy_write(&repo("b")), None);
        drop(g);
        queued.await.unwrap();
        assert_eq!(h.ops.busy_write(&repo("a")), None);
        // A fetch alone is not a write.
        let _f = h.ops.activity(&repo("a"), "fetching");
        assert_eq!(h.ops.busy_write(&repo("a")), None);
        assert_eq!(h.ops.busy_repos(), vec![(repo("a"), "fetching")]);
    }

    #[tokio::test]
    async fn join_runs_once_and_shares_result() {
        let h = harness(Duration::ZERO);
        let runs = Arc::new(AtomicUsize::new(0));
        let call = |ops: RepoOps, runs: Arc<AtomicUsize>| async move {
            ops.join(&repo("a"), NetOp::Fetch, || async move {
                let n = runs.fetch_add(1, Ordering::SeqCst) + 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
                format!("fetched #{n}")
            })
            .await
        };
        let a = tokio::spawn(call(h.ops.clone(), runs.clone()));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(h.ops.is_inflight(&repo("a"), NetOp::Fetch));
        let b = tokio::spawn(call(h.ops.clone(), runs.clone()));
        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        assert_eq!((a.as_str(), b.as_str()), ("fetched #1", "fetched #1"));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(!h.ops.is_inflight(&repo("a"), NetOp::Fetch));

        // Afterwards a new request runs again; a different op is independent.
        assert_eq!(call(h.ops.clone(), runs.clone()).await, "fetched #2");
        let pull = h.ops.join(&repo("a"), NetOp::Pull, || async { 7u32 }).await;
        assert_eq!(pull, 7);
    }

    #[tokio::test]
    async fn join_survives_a_dropped_leader() {
        let h = harness(Duration::ZERO);
        let ops = h.ops.clone();
        let leader = tokio::spawn(async move {
            ops.join(&repo("a"), NetOp::Fetch, || async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                1u32
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let ops = h.ops.clone();
        let joiner = tokio::spawn(async move { ops.join(&repo("a"), NetOp::Fetch, || async { 2u32 }).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        leader.abort();
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), joiner).await.unwrap().unwrap(), 2);
    }

    #[tokio::test]
    async fn refresh_coalesces() {
        let h = harness(Duration::from_millis(100));
        for _ in 0..10 {
            h.ops.request_refresh(&repo("a"));
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        for _ in 0..10 {
            h.ops.request_refresh(&repo("a"));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(h.refreshes.load(Ordering::SeqCst), 2, "one running + one merged queued");
    }

    #[tokio::test]
    async fn refresh_deferred_during_write() {
        let h = harness(Duration::from_millis(10));
        let g = h.ops.write(&repo("a"), "committing").await;
        for _ in 0..5 {
            h.ops.request_refresh(&repo("a"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(h.refreshes.load(Ordering::SeqCst), 0, "held back while writing");
        drop(g);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(h.refreshes.load(Ordering::SeqCst), 1, "exactly one after the write");
        // Other repos are not held back.
        h.ops.request_refresh(&repo("b"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(h.refreshes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn busy_events_sequence() {
        let h = harness(Duration::ZERO);
        let first = h.ops.write(&repo("a"), "committing").await;
        let ops = h.ops.clone();
        let second = tokio::spawn(async move {
            let _g = ops.write(&repo("a"), "pushing").await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(h.ops.busy_repos(), vec![(repo("a"), "committing")]);
        drop(first);
        second.await.unwrap();
        let events: Vec<_> = h.events.lock().unwrap().iter().map(|(_, op)| *op).collect();
        assert_eq!(events, vec![Some("committing"), Some("pushing"), None]);
        assert!(h.ops.busy_repos().is_empty());
    }

    #[tokio::test]
    async fn released_on_error_and_panic() {
        let h = harness(Duration::ZERO);
        let ops = h.ops.clone();
        let failing = tokio::spawn(async move {
            let _g = ops.write(&repo("a"), "committing").await;
            Err::<(), &str>("git failed")
        });
        assert!(failing.await.unwrap().is_err());
        let ops = h.ops.clone();
        let panicking = tokio::spawn(async move {
            let _g = ops.write(&repo("a"), "committing").await;
            panic!("boom");
        });
        assert!(panicking.await.is_err());
        assert!(h.ops.busy_repos().is_empty());
        let free = tokio::time::timeout(Duration::from_secs(1), h.ops.write(&repo("a"), "staging")).await;
        assert!(free.is_ok(), "lock still held after panic");
        assert_eq!(h.events.lock().unwrap().last().unwrap().1, Some("staging"));
    }

    #[tokio::test]
    async fn cancel_stops_running_and_queued_work_only() {
        let h = harness(Duration::ZERO);
        assert!(!h.ops.cancel(&repo("a")), "idle repo: nothing to stop");
        assert_eq!(h.ops.cancellable(&repo("a"), async { 1 }).await, Ok(1));

        let work = |ops: RepoOps, op| async move {
            let o = ops.clone();
            ops.cancellable(&repo("a"), async move {
                let _g = o.write(&repo("a"), op).await;
                tokio::time::sleep(Duration::from_secs(60)).await;
            })
            .await
        };
        let running = tokio::spawn(work(h.ops.clone(), "committing"));
        let queued = tokio::spawn(work(h.ops.clone(), "pushing"));
        let elsewhere = tokio::spawn({
            let ops = h.ops.clone();
            async move { ops.cancellable(&repo("b"), async { tokio::time::sleep(Duration::from_millis(300)).await }).await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(h.ops.is_busy(&repo("a")));

        assert!(h.ops.cancel(&repo("A")));
        assert_eq!(running.await.unwrap(), Err(Cancelled));
        assert_eq!(queued.await.unwrap(), Err(Cancelled));
        assert!(!h.ops.is_busy(&repo("a")), "guards are released");
        assert_eq!(elsewhere.await.unwrap(), Ok(()), "other repos are not affected");
        // Work started after the stop runs normally.
        assert_eq!(h.ops.cancellable(&repo("a"), async { 2 }).await, Ok(2));
    }

}
