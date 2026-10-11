//! Finding the git executable and checking its version.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Oldest git Gitr works with: `merge --autostash` (diverged pull) needs 2.27; path lists via
/// stdin (`--pathspec-from-file`) need 2.25.
pub const MIN_VERSION: (u32, u32, u32) = (2, 27, 0);
pub const MIN_VERSION_TEXT: &str = "2.27";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GitProblem {
    /// No candidate could be run.
    Missing,
    /// The first git found is older than [`MIN_VERSION`].
    TooOld { found: String },
}

/// The outcome of looking for git.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLocation {
    /// The git that is used (None when missing).
    pub path: Option<PathBuf>,
    /// Its version as printed, e.g. "2.55.0.windows.1".
    pub version: Option<String>,
    pub problem: Option<GitProblem>,
    /// A Git path was set in Settings but could not be run; automatic detection was used.
    pub setting_ignored: bool,
}

/// `git version 2.55.0.windows.1` → (2, 55, 0) and "2.55.0.windows.1".
pub fn parse_version(output: &str) -> Option<((u32, u32, u32), String)> {
    let text = output.trim().strip_prefix("git version ")?.trim().to_string();
    let mut parts = text.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty());
    let mut next = || parts.next().and_then(|p| p.parse::<u32>().ok());
    let major = next()?;
    let minor = next()?;
    let patch = next().unwrap_or(0);
    Some(((major, minor, patch), text))
}

/// Where to look, in order: the Settings path, PATH, Git for Windows folders, Scoop.
/// `env` reads environment variables (injected for tests).
pub fn candidates(setting: Option<&Path>, env: &dyn Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let exe = if cfg!(windows) { "git.exe" } else { "git" };
    let mut out = Vec::new();
    if let Some(s) = setting {
        out.push(s.to_path_buf());
    }
    if let Some(path) = env("PATH") {
        out.extend(std::env::split_paths(&path).map(|dir| dir.join(exe)));
    }
    let under = |var: &str, rel: &str| env(var).map(|base| PathBuf::from(base).join(rel));
    out.extend(
        [
            under("ProgramFiles", r"Git\cmd\git.exe"),
            under("ProgramFiles(x86)", r"Git\cmd\git.exe"),
            under("LOCALAPPDATA", r"Programs\Git\cmd\git.exe"),
            under("USERPROFILE", r"scoop\apps\git\current\cmd\git.exe"),
            under("USERPROFILE", r"scoop\shims\git.exe"),
        ]
        .into_iter()
        .flatten(),
    );
    out
}

/// Finds git: the first candidate that runs (per `probe`, which returns its `--version` output)
/// wins. A Settings path that doesn't run is skipped and reported via `setting_ignored`.
pub fn locate_with(
    setting: Option<&Path>,
    env: &dyn Fn(&str) -> Option<OsString>,
    probe: &dyn Fn(&Path) -> Option<String>,
) -> GitLocation {
    let mut setting_ignored = false;
    for (i, candidate) in candidates(setting, env).into_iter().enumerate() {
        let found = probe(&candidate).as_deref().and_then(parse_version);
        let Some((version, text)) = found else {
            if i == 0 && setting.is_some() {
                setting_ignored = true;
            }
            continue;
        };
        let problem = (version < MIN_VERSION).then(|| GitProblem::TooOld { found: text.clone() });
        return GitLocation { path: Some(candidate), version: Some(text), problem, setting_ignored };
    }
    GitLocation { path: None, version: None, problem: Some(GitProblem::Missing), setting_ignored }
}

/// Finds git on this machine (real environment, runs `<candidate> --version`).
pub fn locate(setting: Option<&Path>) -> GitLocation {
    locate_with(setting, &|var| std::env::var_os(var), &probe_version)
}

/// Runs `<git> --version` without a console window; None if it can't run.
pub fn probe_version(git: &Path) -> Option<String> {
    if !git.is_file() {
        return None;
    }
    let mut cmd = std::process::Command::new(git);
    cmd.arg("--version").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::collections::HashMap;

    #[cfg(windows)] // used by the Windows-only search tests
    fn env_of(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = vars.iter().map(|(k, v)| (k.to_string(), OsString::from(v))).collect();
        move |k| map.get(k).cloned()
    }

    #[cfg(windows)] // used by the Windows-only search tests
    fn probe_of(found: &[(&str, &str)]) -> impl Fn(&Path) -> Option<String> {
        let map: HashMap<PathBuf, String> = found.iter().map(|(p, v)| (PathBuf::from(p), format!("git version {v}\n"))).collect();
        move |p| map.get(p).cloned()
    }

    #[cfg(windows)] // used by the Windows-only search tests
    const ENV: &[(&str, &str)] = &[
        ("PATH", r"C:\Tools;C:\Windows"),
        ("ProgramFiles", r"C:\Program Files"),
        ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        ("LOCALAPPDATA", r"C:\Users\me\AppData\Local"),
        ("USERPROFILE", r"C:\Users\me"),
    ];

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("git version 2.55.0.windows.1\n"), Some(((2, 55, 0), "2.55.0.windows.1".into())));
        assert_eq!(parse_version("git version 2.25.0"), Some(((2, 25, 0), "2.25.0".into())));
        assert_eq!(parse_version("git version 2.39"), Some(((2, 39, 0), "2.39".into())));
        assert_eq!(parse_version("not git"), None);
    }

    #[cfg(windows)]
    #[test]
    fn search_order_setting_path_gfw_scoop() {
        let env = env_of(ENV);
        let all = [
            (r"D:\custom\git.exe", "2.40.0"),
            (r"C:\Windows\git.exe", "2.41.0"),
            (r"C:\Program Files\Git\cmd\git.exe", "2.42.0"),
            (r"C:\Program Files (x86)\Git\cmd\git.exe", "2.43.0"),
            (r"C:\Users\me\AppData\Local\Programs\Git\cmd\git.exe", "2.44.0"),
            (r"C:\Users\me\scoop\apps\git\current\cmd\git.exe", "2.45.0"),
            (r"C:\Users\me\scoop\shims\git.exe", "2.46.0"),
        ];
        // Remove candidates from the front one by one: each time the next one in order wins.
        for i in 0..all.len() {
            let probe = probe_of(&all[i..]);
            let loc = locate_with(Some(Path::new(r"D:\custom\git.exe")), &env, &probe);
            assert_eq!(loc.path.as_deref(), Some(Path::new(all[i].0)), "step {i}");
            assert_eq!(loc.version.as_deref(), Some(all[i].1));
            assert_eq!(loc.setting_ignored, i > 0, "step {i}");
            assert_eq!(loc.problem, None);
        }
        let none = locate_with(None, &env, &probe_of(&[]));
        assert_eq!(none.problem, Some(GitProblem::Missing));
        assert_eq!(none.path, None);
    }

    #[cfg(windows)]
    #[test]
    fn too_old_is_reported_with_its_version() {
        let env = env_of(ENV);
        let old = locate_with(None, &env, &probe_of(&[(r"C:\Windows\git.exe", "2.26.9.windows.1")]));
        assert_eq!(old.problem, Some(GitProblem::TooOld { found: "2.26.9.windows.1".into() }));
        assert_eq!(old.path.as_deref(), Some(Path::new(r"C:\Windows\git.exe")));
        let ok = locate_with(None, &env, &probe_of(&[(r"C:\Windows\git.exe", "2.27.0")]));
        assert_eq!(ok.problem, None);
    }

    #[test]
    fn finds_the_real_git_on_this_machine() {
        let loc = locate(None);
        assert_eq!(loc.problem, None, "{loc:?}");
        assert!(loc.path.unwrap().is_file());
    }
}
