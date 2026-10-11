//! Which hooks git ran during a command, read from its trace2 event stream (`GIT_TRACE2_EVENT`).
//! A failing hook prints only its own output, so this is the only reliable way to tell that a
//! commit or push failed because of a hook, and which one.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookRun {
    pub name: String,
    /// Exit code; `None` if git recorded no exit (killed, or the trace was cut short).
    pub code: Option<i32>,
}

/// A trace2 event file for one git call; removed when dropped.
pub struct TraceFile {
    path: PathBuf,
}

impl TraceFile {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = format!("gitr-trace-{}-{}.json", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        Self { path: std::env::temp_dir().join(name) }
    }

    /// The environment that makes git write its events here.
    pub fn env(&self) -> (OsString, OsString) {
        ("GIT_TRACE2_EVENT".into(), self.path.clone().into_os_string())
    }

    /// The hooks the traced git ran, in order (empty if git wrote nothing).
    pub fn hook_runs(&self) -> Vec<HookRun> {
        std::fs::read_to_string(&self.path).map(|t| parse(&t)).unwrap_or_default()
    }
}

impl Default for TraceFile {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TraceFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Hook runs of the top-level git process. Git processes started by hooks (lint-staged runs
/// many) write to the same file; their `sid` contains a `/` and they are ignored.
pub fn parse(trace: &str) -> Vec<HookRun> {
    let mut runs: Vec<(u64, HookRun)> = Vec::new();
    for line in trace.lines() {
        let Ok(ev) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if ev["sid"].as_str().is_none_or(|sid| sid.contains('/')) {
            continue;
        }
        let Some(id) = ev["child_id"].as_u64() else { continue };
        match ev["event"].as_str() {
            Some("child_start") if ev["child_class"] == "hook" => {
                let name = ev["hook_name"].as_str().unwrap_or("hook").to_string();
                runs.push((id, HookRun { name, code: None }));
            }
            Some("child_exit") => {
                if let Some((_, run)) = runs.iter_mut().find(|(i, _)| *i == id) {
                    run.code = ev["code"].as_i64().map(|c| c as i32);
                }
            }
            _ => {}
        }
    }
    runs.into_iter().map(|(_, run)| run).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_hooks_of_the_top_level_git_only() {
        // Trimmed from real git 2.55 output: pre-commit fails with 3; a git started by the hook
        // (sid with `/`) runs its own child.
        let trace = r#"{"event":"version","sid":"A","evt":"4","exe":"2.55.0"}
{"event":"child_start","sid":"A","child_id":0,"child_class":"hook","hook_name":"pre-commit","argv":[".git/hooks/pre-commit"]}
{"event":"child_start","sid":"A/B","child_id":0,"child_class":"hook","hook_name":"post-checkout","argv":["x"]}
{"event":"child_exit","sid":"A/B","child_id":0,"pid":2,"code":9}
{"event":"child_exit","sid":"A","child_id":0,"pid":1,"code":3,"t_rel":0.001}
{"event":"child_start","sid":"A","child_id":1,"child_class":"?","argv":["git","gc","--auto"]}
{"event":"child_exit","sid":"A","child_id":1,"pid":3,"code":0}
not json
{"event":"child_start","sid":"A","child_id":2,"child_class":"hook","hook_name":"commit-msg","argv":["x"]}"#;
        assert_eq!(
            parse(trace),
            vec![
                HookRun { name: "pre-commit".into(), code: Some(3) },
                HookRun { name: "commit-msg".into(), code: None },
            ]
        );
    }
}
