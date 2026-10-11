use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub binary: bool,
    pub truncated: bool,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub new_start: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Context,
    Add,
    Remove,
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

pub const MAX_DIFF_LINES: usize = 20_000;

/// Added/removed line counts of one changed file (`git diff --numstat`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStat {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
}

/// Line counts of the staged (index vs HEAD) and unstaged (worktree vs index) changes.
/// Untracked files are not included.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStats {
    pub staged: Vec<LineStat>,
    pub unstaged: Vec<LineStat>,
}

/// Parses `git diff --numstat -z`. A rename record has an empty path field followed by the
/// old and new paths as separate NUL-terminated fields; the new path is kept. Binary files
/// report `-` for both counts.
pub fn parse_numstat_z(out: &str) -> Vec<LineStat> {
    let mut stats = Vec::new();
    let mut fields = out.split('\0');
    while let Some(rec) = fields.next() {
        let mut parts = rec.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            fields.next();
            fields.next().unwrap_or_default()
        } else {
            path
        };
        stats.push(LineStat {
            path: path.to_string(),
            added: added.parse().unwrap_or(0),
            removed: removed.parse().unwrap_or(0),
            binary: added == "-",
        });
    }
    stats
}

/// Parses unified diff output for a single file.
pub fn parse_unified(out: &str) -> FileDiff {
    let mut diff = FileDiff::default();
    let (mut old_no, mut new_no) = (0u32, 0u32);
    let mut total = 0usize;
    // Columns of +/-/space markers before each line: 1 normally, one per parent in a combined
    // diff (`@@@`), which git prints for a file with merge conflicts.
    let mut cols = 1usize;

    for line in out.lines() {
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            diff.binary = true;
            continue;
        }
        let combined_header = line.starts_with("@@@");
        if let Some(rest) = line.strip_prefix("@@ ").or_else(|| combined_header.then(|| line.trim_start_matches('@').trim_start())) {
            cols = if combined_header { line.bytes().take_while(|&b| b == b'@').count() - 1 } else { 1 };
            let (old_start, new_start) = if combined_header { parse_combined_header(rest) } else { parse_hunk_header(rest) };
            old_no = old_start;
            new_no = new_start;
            diff.hunks.push(Hunk {
                header: line.to_string(),
                old_start,
                new_start,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = diff.hunks.last_mut() else { continue };
        if total >= MAX_DIFF_LINES {
            diff.truncated = true;
            break;
        }
        let (kind, text) = if cols > 1 {
            // Combined diff: any `+` column makes it part of the result, else any `-` removes it.
            if line.starts_with('\\') {
                (LineKind::NoNewline, line)
            } else {
                let Some(markers) = line.get(..cols) else { continue };
                if !markers.bytes().all(|b| matches!(b, b'+' | b'-' | b' ')) {
                    continue;
                }
                if markers.contains('+') {
                    (LineKind::Add, &line[cols..])
                } else if markers.contains('-') {
                    (LineKind::Remove, &line[cols..])
                } else {
                    (LineKind::Context, &line[cols..])
                }
            }
        } else {
            match line.as_bytes().first() {
                Some(b'+') => (LineKind::Add, &line[1..]),
                Some(b'-') => (LineKind::Remove, &line[1..]),
                Some(b' ') => (LineKind::Context, &line[1..]),
                Some(b'\\') => (LineKind::NoNewline, line),
                None => (LineKind::Context, ""),
                _ => continue,
            }
        };
        let (o, n) = match kind {
            LineKind::Add => {
                new_no += 1;
                (None, Some(new_no - 1))
            }
            LineKind::Remove => {
                old_no += 1;
                (Some(old_no - 1), None)
            }
            LineKind::Context => {
                old_no += 1;
                new_no += 1;
                (Some(old_no - 1), Some(new_no - 1))
            }
            LineKind::NoNewline => (None, None),
        };
        hunk.lines.push(DiffLine { kind, old_no: o, new_no: n, text: crate::pathbytes::display(text) });
        total += 1;
    }
    diff
}

/// `-1,3 -1,3 +1,5 @@@`: the first parent's old start and the result's new start.
fn parse_combined_header(rest: &str) -> (u32, u32) {
    let num = |t: &str| t.get(1..).and_then(|s| s.split(',').next()).and_then(|s| s.parse().ok()).unwrap_or(0);
    let tokens: Vec<&str> = rest.split(' ').collect();
    let old = tokens.iter().find(|t| t.starts_with('-')).map_or(0, |t| num(t));
    let new = tokens.iter().find(|t| t.starts_with('+')).map_or(0, |t| num(t));
    (old, new)
}

fn parse_hunk_header(rest: &str) -> (u32, u32) {
    let mut parts = rest.split(' ');
    let start = |s: Option<&str>| {
        s.and_then(|s| s.get(1..))
            .and_then(|s| s.split(',').next())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    };
    let old = start(parts.next());
    let new = start(parts.next());
    (old, new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hunks_with_line_numbers() {
        let out = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@ fn main\n a\n-b\n+B\n c\n@@ -10 +10,2 @@\n x\n+y\n\\ No newline at end of file\n";
        let d = parse_unified(out);
        assert!(!d.binary);
        assert_eq!(d.hunks.len(), 2);
        let h = &d.hunks[0];
        assert_eq!((h.old_start, h.new_start), (1, 1));
        assert_eq!(h.lines[1], DiffLine { kind: LineKind::Remove, old_no: Some(2), new_no: None, text: "b".into() });
        assert_eq!(h.lines[2], DiffLine { kind: LineKind::Add, old_no: None, new_no: Some(2), text: "B".into() });
        assert_eq!(h.lines[3].old_no, Some(3));
        assert_eq!(d.hunks[1].lines[1].new_no, Some(11));
        assert_eq!(d.hunks[1].lines[2].kind, LineKind::NoNewline);
    }

    #[test]
    fn parses_the_combined_diff_git_prints_for_a_conflicted_file() {
        let out = "diff --cc shared.txt
index 111,222..333
--- a/shared.txt
+++ b/shared.txt
@@@ -1,3 -1,3 +1,7 @@@
  line 1
++<<<<<<< HEAD
 +line 2 MAIN
++=======
+ line 2 SIDE
++>>>>>>> side
  line 3
";
        let d = parse_unified(out);
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!(h.new_start, 1);
        let texts: Vec<(&LineKind, &str)> = h.lines.iter().map(|l| (&l.kind, l.text.as_str())).collect();
        assert_eq!(texts[0], (&LineKind::Context, "line 1"));
        assert_eq!(texts[1], (&LineKind::Add, "<<<<<<< HEAD"));
        assert!(texts.contains(&(&LineKind::Add, "line 2 MAIN")));
        assert!(texts.contains(&(&LineKind::Add, "line 2 SIDE")));
        assert_eq!(texts.last().copied(), Some((&LineKind::Context, "line 3")));
        assert_eq!(h.lines[1].new_no, Some(2));
    }

    #[test]
    fn parses_numstat_with_renames_and_binaries() {
        let out = "3\t1\tsrc/a.rs\0-\t-\tlogo.png\x002\t0\t\0old name.txt\0new name.txt\0";
        let stats = parse_numstat_z(out);
        assert_eq!(stats.len(), 3);
        assert_eq!(stats[0], LineStat { path: "src/a.rs".into(), added: 3, removed: 1, binary: false });
        assert_eq!(stats[1], LineStat { path: "logo.png".into(), added: 0, removed: 0, binary: true });
        assert_eq!(stats[2], LineStat { path: "new name.txt".into(), added: 2, removed: 0, binary: false });
        assert!(parse_numstat_z("").is_empty());
    }

    #[test]
    fn detects_binary() {
        assert!(parse_unified("diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary);
    }
}
