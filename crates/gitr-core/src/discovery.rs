use std::path::{Path, PathBuf};

pub const DEFAULT_EXCLUDES: &[&str] = &[
    "node_modules",
    "bin",
    "obj",
    "target",
    "dist",
    "packages",
    "$RECYCLE.BIN",
];

/// Finds git repositories under `root`. Does not descend into a repository once found.
pub fn discover(root: &Path, max_depth: usize, excludes: &[String]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(root, 0, max_depth, excludes, &mut found);
    found.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    found
}

pub fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

fn walk(dir: &Path, depth: usize, max_depth: usize, excludes: &[String], out: &mut Vec<PathBuf>) {
    if is_repo(dir) {
        out.push(dir.to_path_buf());
        return;
    }
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() || ft.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || is_excluded(&name, excludes) {
            continue;
        }
        walk(&entry.path(), depth + 1, max_depth, excludes, out);
    }
}

fn is_excluded(name: &str, excludes: &[String]) -> bool {
    excludes.iter().any(|e| e.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_repos_and_respects_depth_and_excludes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for p in ["a/.git", "group/b/.git", "group/b/nested/.git", "deep/x/y/z/.git", "node_modules/m/.git"] {
            std::fs::create_dir_all(root.join(p)).unwrap();
        }
        std::fs::create_dir_all(root.join("wt")).unwrap();
        std::fs::write(root.join("wt/.git"), "gitdir: elsewhere").unwrap();

        let excludes: Vec<String> = DEFAULT_EXCLUDES.iter().map(|s| s.to_string()).collect();
        let found = discover(root, 3, &excludes);
        let names: Vec<String> = found
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(names, vec!["a", "group/b", "wt"]);
    }
}
