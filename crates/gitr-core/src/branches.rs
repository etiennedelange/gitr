use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    pub sha: String,
    pub committed_at: i64,
}

pub const FOR_EACH_REF_FORMAT: &str = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(objectname:short)%00%(committerdate:unix)";

pub fn parse_for_each_ref(out: &str) -> Vec<Branch> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            let [full, short, upstream, track, head, sha, date] = f.as_slice() else {
                return None;
            };
            if full.ends_with("/HEAD") {
                return None;
            }
            let (ahead, behind, gone) = parse_track(track);
            Some(Branch {
                name: short.to_string(),
                remote: full.starts_with("refs/remotes/"),
                is_head: *head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                ahead,
                behind,
                gone,
                sha: sha.to_string(),
                committed_at: date.parse().unwrap_or(0),
            })
        })
        .collect()
}

fn parse_track(track: &str) -> (u32, u32, bool) {
    if track == "gone" {
        return (0, 0, true);
    }
    let (mut a, mut b) = (0, 0);
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            a = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            b = n.parse().unwrap_or(0);
        }
    }
    (a, b, false)
}

#[cfg(test)]
#[allow(clippy::octal_escapes)]
mod tests {
    use super::*;

    #[test]
    fn parses_refs() {
        let out = [
            "refs/heads/main\0main\0origin/main\0ahead 1, behind 2\0*\0abc\01700000000",
            "refs/heads/old\0old\0origin/old\0gone\0 \0def\01",
            "refs/remotes/origin/HEAD\0origin\0\0\0 \0abc\01",
            "refs/remotes/origin/main\0origin/main\0\0\0 \0abc\01",
        ]
        .join("\n");
        let b = parse_for_each_ref(&out);
        assert_eq!(b.len(), 3);
        assert!(b[0].is_head && !b[0].remote);
        assert_eq!((b[0].ahead, b[0].behind), (1, 2));
        assert!(b[1].gone);
        assert!(b[2].remote && b[2].upstream.is_none());
    }
}
