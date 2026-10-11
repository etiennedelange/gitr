use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub detached: bool,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// Porcelain v2 status letters; `.` means unchanged.
    pub index: char,
    pub worktree: char,
    pub untracked: bool,
    pub conflicted: bool,
}

impl FileEntry {
    pub fn is_staged(&self) -> bool {
        !self.untracked && !self.conflicted && self.index != '.'
    }

    pub fn is_unstaged(&self) -> bool {
        self.untracked || self.conflicted || self.worktree != '.'
    }
}

impl RepoStatus {
    pub fn staged_count(&self) -> usize {
        self.files.iter().filter(|f| f.is_staged()).count()
    }

    pub fn unstaged_count(&self) -> usize {
        self.files.iter().filter(|f| f.is_unstaged()).count()
    }
}

/// Parses `git status --porcelain=v2 --branch -z --untracked-files=<all|normal>`.
pub fn parse_porcelain_v2(out: &str) -> RepoStatus {
    let mut st = RepoStatus::default();
    let mut records = out.split('\0').filter(|r| !r.is_empty());

    while let Some(rec) = records.next() {
        if let Some(header) = rec.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => st.oid = Some(value.to_string()),
                "branch.head" => {
                    if value == "(detached)" {
                        st.detached = true;
                    } else {
                        st.branch = Some(value.to_string());
                    }
                }
                "branch.upstream" => st.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }

        let kind = rec.as_bytes()[0];
        match kind {
            b'1' | b'2' | b'u' => {
                let field_count = match kind {
                    b'1' => 9,
                    b'2' => 10,
                    _ => 11,
                };
                let fields: Vec<&str> = rec.splitn(field_count, ' ').collect();
                let Some(path) = fields.last() else { continue };
                let xy: Vec<char> = fields.get(1).copied().unwrap_or("..").chars().collect();
                let orig_path = if kind == b'2' {
                    records.next().map(str::to_string)
                } else {
                    None
                };
                st.files.push(FileEntry {
                    path: path.to_string(),
                    orig_path,
                    index: xy.first().copied().unwrap_or('.'),
                    worktree: xy.get(1).copied().unwrap_or('.'),
                    untracked: false,
                    conflicted: kind == b'u',
                });
            }
            b'?' => st.files.push(FileEntry {
                path: rec[2..].to_string(),
                orig_path: None,
                index: '.',
                worktree: '?',
                untracked: true,
                conflicted: false,
            }),
            _ => {}
        }
    }
    st
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headers_and_entries() {
        let out = [
            "# branch.oid 1234567890abcdef",
            "# branch.head feature/AB-12",
            "# branch.upstream origin/feature/AB-12",
            "# branch.ab +2 -3",
            "1 M. N... 100644 100644 100644 aaa bbb src/staged file.rs",
            "1 .M N... 100644 100644 100644 aaa bbb src/unstaged.rs",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new name.rs",
            "old name.rs",
            "u UU N... 100644 100644 100644 100644 a b c conflict.rs",
            "? untracked dir/file.txt",
            "",
        ]
        .join("\0");
        let st = parse_porcelain_v2(&out);
        assert_eq!(st.branch.as_deref(), Some("feature/AB-12"));
        assert_eq!(st.upstream.as_deref(), Some("origin/feature/AB-12"));
        assert_eq!((st.ahead, st.behind), (2, 3));
        assert_eq!(st.files.len(), 5);
        assert_eq!(st.files[0].path, "src/staged file.rs");
        assert!(st.files[0].is_staged() && !st.files[0].is_unstaged());
        assert!(st.files[1].is_unstaged() && !st.files[1].is_staged());
        assert_eq!(st.files[2].orig_path.as_deref(), Some("old name.rs"));
        assert_eq!(st.files[2].path, "new name.rs");
        assert!(st.files[3].conflicted);
        assert!(st.files[4].untracked);
        assert_eq!(st.files[4].path, "untracked dir/file.txt");
        assert_eq!((st.staged_count(), st.unstaged_count()), (2, 3));
    }

    #[test]
    fn parses_initial_and_detached() {
        let st = parse_porcelain_v2("# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(st.oid.is_none());
        assert!(st.detached);
        assert!(st.branch.is_none());
    }
}
