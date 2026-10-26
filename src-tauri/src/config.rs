use std::path::{Path, PathBuf};

use gitr_core::discovery::DEFAULT_EXCLUDES;
use gitr_core::repo::Strategy;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub groups: Vec<Group>,
    pub scan_depth: usize,
    pub excludes: Vec<String>,
    pub concurrency: usize,
    pub copilot_model: Option<String>,
    pub copilot_cli_path: Option<PathBuf>,
    pub watch: bool,
    /// UI zoom in percent; always one of [`ZOOM_PRESETS`].
    #[serde(deserialize_with = "lenient_zoom")]
    pub zoom: u32,
    /// Allow opening the WebView dev tools (F12 / Ctrl+Shift+I / Inspect) in release builds.
    pub devtools: bool,
    /// git executable to use; `None` = find it automatically (PATH, Git for Windows, Scoop).
    pub git_path: Option<PathBuf>,
    /// How to integrate a diverged branch when the repo has no `pull.rebase` setting.
    pub diverged_strategy: Strategy,
}

pub const DEFAULT_ZOOM: u32 = 100;
pub const ZOOM_PRESETS: [u32; 11] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

/// Any value that isn't a preset falls back to 100%.
pub fn normalize_zoom(v: u32) -> u32 {
    if ZOOM_PRESETS.contains(&v) { v } else { DEFAULT_ZOOM }
}

/// Never fails: a bad `zoom` value resets zoom only, not the whole config.
fn lenient_zoom<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = toml::Value::deserialize(d).ok();
    Ok(v.and_then(|v| v.as_integer())
        .and_then(|i| u32::try_from(i).ok())
        .map(normalize_zoom)
        .unwrap_or(DEFAULT_ZOOM))
}

/// Settings saves send the whole config; zoom is owned by `set_zoom`, so keep the current value.
pub fn merge_preserving_zoom(mut incoming: Config, current: &Config) -> Config {
    incoming.zoom = current.zoom;
    incoming
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub roots: Vec<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            groups: Vec::new(),
            scan_depth: 3,
            excludes: DEFAULT_EXCLUDES.iter().map(|s| s.to_string()).collect(),
            concurrency: 6,
            copilot_model: None,
            copilot_cli_path: None,
            watch: true,
            zoom: DEFAULT_ZOOM,
            devtools: false,
            git_path: None,
            diverged_strategy: Strategy::Rebase,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub path: String,
    pub name: String,
    pub group_id: String,
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("gitr")
}

/// `%APPDATA%\gitr\logs`
pub fn logs_dir() -> PathBuf {
    config_dir().join("logs")
}

pub fn load(dir: &Path) -> Config {
    let path = dir.join("config.toml");
    let Ok(text) = std::fs::read_to_string(&path) else { return Config::default() };
    toml::from_str(&text).unwrap_or_else(|e| {
        // The next save would overwrite the unreadable file with defaults, losing the user's
        // groups; keep a copy of it first.
        let backup = dir.join("config.toml.bak");
        let kept = std::fs::copy(&path, &backup).is_ok();
        tracing::warn!(target: "gitr", error = %e, backup_kept = kept, "config.toml is unreadable; using defaults");
        Config::default()
    })
}

pub fn save(dir: &Path, config: &Config) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = toml::to_string_pretty(config).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("config.toml"), &text)
}

pub fn load_repo_cache(dir: &Path) -> Vec<RepoEntry> {
    std::fs::read_to_string(dir.join("repos.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_repo_cache(dir: &Path, repos: &[RepoEntry]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(repos).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("repos.json"), &text)
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Discovers the repos of every group. A repo reachable from several roots (e.g. a group for
/// the repo itself and one for its parent folder) is listed once, in the group whose root is
/// closest to it; its position is where it was first found.
pub fn discover_repos(config: &Config) -> Vec<RepoEntry> {
    let mut out: Vec<RepoEntry> = Vec::new();
    // lowercase path -> (index in out, components in the winning root)
    let mut seen: std::collections::HashMap<String, (usize, usize)> = std::collections::HashMap::new();
    for group in &config.groups {
        for root in &group.roots {
            let depth = root.components().count();
            for path in gitr_core::discovery::discover(root, config.scan_depth, &config.excludes) {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let entry = RepoEntry { path: path.to_string_lossy().to_string(), name, group_id: group.id.clone() };
                match seen.get_mut(&entry.path.to_lowercase()) {
                    Some((i, best)) if depth > *best => {
                        out[*i] = entry;
                        *best = depth;
                    }
                    Some(_) => {}
                    None => {
                        seen.insert(entry.path.to_lowercase(), (out.len(), depth));
                        out.push(entry);
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_tolerates_partial_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mut c = Config::default();
        c.groups.push(Group { id: "g1".into(), name: "Unity".into(), roots: vec!["D:\\Repos\\Unity".into()] });
        c.copilot_model = Some("gpt-5-mini".into());
        save(tmp.path(), &c).unwrap();
        assert_eq!(load(tmp.path()), c);

        std::fs::write(tmp.path().join("config.toml"), "concurrency = 2\n").unwrap();
        let partial = load(tmp.path());
        assert_eq!(partial.concurrency, 2);
        assert_eq!(partial.scan_depth, 3);
        assert_eq!(partial.zoom, 100);
    }

    #[test]
    fn an_unreadable_config_is_backed_up_before_defaults_replace_it() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.toml"), "groups = [oops
").unwrap();
        assert_eq!(load(tmp.path()), Config::default());
        let backup = std::fs::read_to_string(tmp.path().join("config.toml.bak")).unwrap();
        assert_eq!(backup, "groups = [oops
");
    }

    #[test]
    fn a_group_colour_from_an_older_version_is_ignored_and_dropped_on_save() {
        let c = load_str("[[groups]]\nid = \"g1\"\nname = \"Work\"\nroots = [\"D:\\\\Repos\"]\ncolor = \"teal\"\n");
        assert_eq!(c.groups.len(), 1);
        assert_eq!(c.groups[0].name, "Work");
        assert!(!toml::to_string(&c).unwrap().contains("color"));
    }

    fn load_str(text: &str) -> Config {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.toml"), text).unwrap();
        load(tmp.path())
    }

    #[test]
    fn zoom_parsing_is_lenient() {
        assert_eq!(load_str("zoom = 125\n").zoom, 125);
        assert_eq!(load_str("zoom = 63\n").zoom, 100);
        assert_eq!(load_str("zoom = -5\n").zoom, 100);
        assert_eq!(load_str("zoom = 1.5\n").zoom, 100);
        let bad = load_str("concurrency = 2\nzoom = \"big\"\n");
        assert_eq!(bad.zoom, 100);
        assert_eq!(bad.concurrency, 2);
    }

    #[test]
    fn diverged_strategy_defaults_to_rebase_and_reads_merge() {
        assert_eq!(Config::default().diverged_strategy, Strategy::Rebase);
        let c: Config = toml::from_str("divergedStrategy = \"merge\"\n").unwrap();
        assert_eq!(c.diverged_strategy, Strategy::Merge);
        let text = toml::to_string_pretty(&c).unwrap();
        assert!(text.contains("divergedStrategy = \"merge\""), "{text}");
    }

    #[test]
    fn devtools_defaults_off_and_round_trips() {
        assert!(!load_str("concurrency = 2\n").devtools);
        assert!(load_str("devtools = true\n").devtools);
        let tmp = tempfile::tempdir().unwrap();
        let c = Config { devtools: true, ..Config::default() };
        save(tmp.path(), &c).unwrap();
        assert!(load(tmp.path()).devtools);
    }

    #[test]
    fn zoom_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let c = Config { zoom: 150, ..Config::default() };
        save(tmp.path(), &c).unwrap();
        assert!(std::fs::read_to_string(tmp.path().join("config.toml")).unwrap().contains("zoom = 150"));
        assert_eq!(load(tmp.path()).zoom, 150);
    }

    #[test]
    fn normalize_zoom_accepts_only_presets() {
        for p in ZOOM_PRESETS {
            assert_eq!(normalize_zoom(p), p);
        }
        assert_eq!(normalize_zoom(0), 100);
        assert_eq!(normalize_zoom(300), 100);
    }

    #[test]
    fn settings_save_keeps_current_zoom() {
        let current = Config { zoom: 150, ..Config::default() };
        let incoming = Config { zoom: 50, concurrency: 9, ..Config::default() };
        let merged = merge_preserving_zoom(incoming, &current);
        assert_eq!(merged.zoom, 150);
        assert_eq!(merged.concurrency, 9);
    }
    #[test]
    fn repo_in_two_groups_is_listed_once_in_the_closest_group() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("Atlas");
        for p in ["Tracer/.git", "Other/.git"] {
            std::fs::create_dir_all(parent.join(p)).unwrap();
        }
        let group = |id: &str, root: &std::path::Path| Group { id: id.into(), name: id.into(), roots: vec![root.to_path_buf()] };
        for parent_first in [true, false] {
            let mut c = Config::default();
            let (p, own) = (group("parent", &parent), group("own", &parent.join("Tracer")));
            c.groups = if parent_first { vec![p, own] } else { vec![own, p] };
            let repos = discover_repos(&c);
            let names: Vec<(&str, &str)> = repos.iter().map(|r| (r.name.as_str(), r.group_id.as_str())).collect();
            assert_eq!(repos.len(), 2, "{names:?}");
            assert!(names.contains(&("Tracer", "own")), "{names:?}");
            assert!(names.contains(&("Other", "parent")), "{names:?}");
        }
    }
}
