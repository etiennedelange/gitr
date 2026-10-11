//! Commit history: `git log` pages, one commit's details and its per-file diff.

use serde::Serialize;

use crate::diff::{self, LineStat};

/// More changed files than this are not listed (huge merges or vendor drops); the UI says so.
pub const MAX_COMMIT_FILES: usize = 5_000;

/// Field separator inside one `--format` record (records themselves are NUL-separated by `-z`).
pub(crate) const SEP: char = '\u{1f}';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    /// What HEAD points at: the checked-out branch, or `HEAD` itself when detached.
    Head,
    Local,
    Remote,
    Tag,
}

/// A branch, remote branch or tag pointing at a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RefLabel {
    pub kind: RefKind,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Unix seconds.
    pub author_time: i64,
    pub subject: String,
    pub refs: Vec<RefLabel>,
    /// On no remote-tracking branch.
    pub unpushed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<LogEntry>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    /// A, M, D, R, C or T.
    pub status: String,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    /// The full message, trailing whitespace trimmed.
    pub message: String,
    /// Against the first parent, or the empty tree for a root commit.
    pub files: Vec<CommitFile>,
    /// More than [`MAX_COMMIT_FILES`] files changed; the rest are left out.
    pub truncated: bool,
}

/// What a reset to a commit would take off the branch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetPreview {
    /// Commits that leave the branch.
    pub leaving: u32,
    /// Of those, on no remote-tracking branch.
    pub unpushed: u32,
    /// Of those, already on the upstream.
    pub on_upstream: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    /// The undone commits' changes stay staged.
    Soft,
    /// The undone commits' changes stay in the working tree, unstaged.
    Mixed,
}

/// A full or abbreviated object id: 4 to 64 hex digits (SHA-1 and SHA-256 repositories). Anything
/// else (an option, a ref name, a revision expression) is refused before it reaches git.
pub fn is_object_id(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `--format` for [`parse_log`].
pub(crate) const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s";

/// Parses `git log -z --decorate=full` output in [`LOG_FORMAT`]. `unpushed` is left false.
pub fn parse_log(out: &str) -> Vec<LogEntry> {
    out.split('\0')
        .map(|r| r.trim_start_matches('\n'))
        .filter(|r| !r.is_empty())
        .filter_map(|record| {
            let mut f = record.splitn(7, SEP);
            let sha = f.next()?.to_string();
            let parents = f.next()?.split_whitespace().map(str::to_string).collect();
            let author_name = f.next()?.to_string();
            let author_email = f.next()?.to_string();
            let author_time = f.next()?.trim().parse().unwrap_or(0);
            let refs = parse_decorations(f.next()?);
            let subject = f.next().unwrap_or("").to_string();
            Some(LogEntry { sha, parents, author_name, author_email, author_time, subject, refs, unpushed: false })
        })
        .collect()
}

/// Parses `%D` with `--decorate=full`: `HEAD -> refs/heads/main, refs/remotes/origin/main,
/// tag: refs/tags/v1`. Remote `HEAD` symrefs, the stash and other namespaces are dropped.
pub fn parse_decorations(d: &str) -> Vec<RefLabel> {
    let label = |kind, name: &str| Some(RefLabel { kind, name: name.to_string() });
    d.split(", ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|r| {
            if let Some(branch) = r.strip_prefix("HEAD -> ") {
                return label(RefKind::Head, branch.strip_prefix("refs/heads/").unwrap_or(branch));
            }
            if r == "HEAD" {
                return label(RefKind::Head, "HEAD");
            }
            if let Some(tag) = r.strip_prefix("tag: ") {
                return label(RefKind::Tag, tag.strip_prefix("refs/tags/").unwrap_or(tag));
            }
            if let Some(local) = r.strip_prefix("refs/heads/") {
                return label(RefKind::Local, local);
            }
            if let Some(remote) = r.strip_prefix("refs/remotes/") {
                return (!remote.ends_with("/HEAD")).then(|| RefLabel { kind: RefKind::Remote, name: remote.to_string() });
            }
            None
        })
        .collect()
}

/// `--format` for [`parse_details_header`].
pub(crate) const DETAILS_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B";

/// Parses `git show -s -z` output in [`DETAILS_FORMAT`]; `files` is left empty.
pub fn parse_details_header(out: &str) -> Option<CommitDetails> {
    let record = out.split('\0').next()?;
    let mut f = record.splitn(9, SEP);
    let sha = f.next()?.trim().to_string();
    if sha.is_empty() {
        return None;
    }
    Some(CommitDetails {
        sha,
        parents: f.next()?.split_whitespace().map(str::to_string).collect(),
        author_name: f.next()?.to_string(),
        author_email: f.next()?.to_string(),
        author_time: f.next()?.trim().parse().unwrap_or(0),
        committer_name: f.next()?.to_string(),
        committer_email: f.next()?.to_string(),
        committer_time: f.next()?.trim().parse().unwrap_or(0),
        message: f.next().unwrap_or("").trim_end().to_string(),
        files: Vec::new(),
        truncated: false,
    })
}

/// One `git diff-tree --name-status -z` entry: status letter, old path for renames and copies,
/// and path.
pub fn parse_name_status_z(out: &str) -> Vec<(String, Option<String>, String)> {
    let mut fields = out.split('\0').filter(|s| !s.is_empty());
    let mut v = Vec::new();
    while let Some(code) = fields.next() {
        let letter = code.chars().next().map(String::from).unwrap_or_default();
        if letter == "R" || letter == "C" {
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else { break };
            v.push((letter, Some(old.to_string()), new.to_string()));
        } else {
            let Some(path) = fields.next() else { break };
            v.push((letter, None, path.to_string()));
        }
    }
    v
}

/// Joins name-status entries with numstat counts (both keyed by the new path).
pub fn commit_files(names: Vec<(String, Option<String>, String)>, stats: &[LineStat]) -> Vec<CommitFile> {
    names
        .into_iter()
        .map(|(status, orig_path, path)| {
            let stat = stats.iter().find(|s| s.path == path);
            CommitFile {
                added: stat.map_or(0, |s| s.added),
                removed: stat.map_or(0, |s| s.removed),
                binary: stat.is_some_and(|s| s.binary),
                path,
                orig_path,
                status,
            }
        })
        .collect()
}

pub(crate) fn numstat(out: &str) -> Vec<LineStat> {
    diff::parse_numstat_z(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decorations_cover_branches_remotes_tags_and_detached_head() {
        let refs = parse_decorations(
            "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/heads/feature/x, refs/stash",
        );
        assert_eq!(
            refs,
            vec![
                RefLabel { kind: RefKind::Head, name: "main".into() },
                RefLabel { kind: RefKind::Remote, name: "origin/main".into() },
                RefLabel { kind: RefKind::Tag, name: "v1.0".into() },
                RefLabel { kind: RefKind::Local, name: "feature/x".into() },
            ]
        );
        assert_eq!(parse_decorations("HEAD"), vec![RefLabel { kind: RefKind::Head, name: "HEAD".into() }]);
        assert!(parse_decorations("").is_empty());
    }

    #[test]
    fn log_records_keep_separators_in_the_subject() {
        let out = format!("a1{SEP}p1 p2{SEP}Ann{SEP}a@x{SEP}946684800{SEP}{SEP}Merge: tabs\tand {SEP} odd\0\nb2{SEP}{SEP}Bo{SEP}b@x{SEP}1{SEP}tag: refs/tags/v1{SEP}\0");
        let log = parse_log(&out);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].parents, ["p1", "p2"]);
        assert_eq!(log[0].subject, format!("Merge: tabs\tand {SEP} odd"));
        assert!(log[1].parents.is_empty());
        assert_eq!(log[1].subject, "");
        assert_eq!(log[1].refs, vec![RefLabel { kind: RefKind::Tag, name: "v1".into() }]);
    }

    #[test]
    fn name_status_handles_renames_and_copies() {
        let v = parse_name_status_z("M\0a.txt\0R087\0old.txt\0new.txt\0C100\0x\0y\0D\0gone\0");
        assert_eq!(
            v,
            vec![
                ("M".into(), None, "a.txt".into()),
                ("R".into(), Some("old.txt".into()), "new.txt".into()),
                ("C".into(), Some("x".into()), "y".into()),
                ("D".into(), None, "gone".into()),
            ]
        );
    }

    #[test]
    fn object_ids_only() {
        assert!(is_object_id("abcd"));
        assert!(is_object_id(&"a".repeat(40)));
        assert!(is_object_id(&"F".repeat(64)));
        for bad in ["--output=x", "HEAD", "a b", "abc", &"a".repeat(65), "abcd~1", ""] {
            assert!(!is_object_id(bad), "{bad}");
        }
    }
}
