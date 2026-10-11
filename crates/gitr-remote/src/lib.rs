use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Ado,
    GitHub,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub kind: HostKind,
    /// Browser base URL for the repository, e.g. `https://dev.azure.com/org/project/_git/repo`.
    pub web_url: String,
    pub owner: String,
    pub project: Option<String>,
    pub repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LinkTarget {
    Repo,
    Branch { branch: String },
    Commit { sha: String },
    File { branch: String, path: String },
    PullRequest { branch: String, target: Option<String> },
}

pub fn parse(remote_url: &str) -> Option<RemoteInfo> {
    let (host, path) = split_host_path(remote_url.trim())?;
    let host = host.to_ascii_lowercase();
    // The host and path end up in a URL opened in the browser, so a remote such as
    // `evil.com#:x` must not be able to steer it somewhere else.
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return None;
    }
    if path.chars().any(|c| matches!(c, '?' | '#' | '\\') || c.is_control()) {
        return None;
    }
    let segments: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    if host == "github.com" || host == "ssh.github.com" {
        return parse_github(&segments);
    }
    if host == "dev.azure.com" || host == "ssh.dev.azure.com" {
        return parse_ado_dev(&segments);
    }
    if host == "vs-ssh.visualstudio.com" {
        return parse_ado_ssh_v3(&segments, true);
    }
    if let Some(org) = host.strip_suffix(".visualstudio.com") {
        return parse_ado_vsts(org, &segments);
    }
    None
}

pub fn link(info: &RemoteInfo, target: &LinkTarget) -> String {
    let base = &info.web_url;
    match (info.kind, target) {
        (_, LinkTarget::Repo) => base.clone(),

        (HostKind::GitHub, LinkTarget::Branch { branch }) => {
            format!("{base}/tree/{}", encode(branch))
        }
        (HostKind::GitHub, LinkTarget::Commit { sha }) => format!("{base}/commit/{sha}"),
        (HostKind::GitHub, LinkTarget::File { branch, path }) => format!(
            "{base}/blob/{}/{}",
            encode(branch),
            encode(path.trim_start_matches('/'))
        ),
        (HostKind::GitHub, LinkTarget::PullRequest { branch, target }) => match target {
            Some(t) => format!("{base}/compare/{}...{}?expand=1", encode(t), encode(branch)),
            None => format!("{base}/pull/new/{}", encode(branch)),
        },

        (HostKind::Ado, LinkTarget::Branch { branch }) => {
            format!("{base}?version=GB{}", encode(branch))
        }
        (HostKind::Ado, LinkTarget::Commit { sha }) => format!("{base}/commit/{sha}"),
        (HostKind::Ado, LinkTarget::File { branch, path }) => format!(
            "{base}?path=/{}&version=GB{}",
            encode(path.trim_start_matches('/')),
            encode(branch)
        ),
        (HostKind::Ado, LinkTarget::PullRequest { branch, target }) => {
            let mut url = format!("{base}/pullrequestcreate?sourceRef={}", encode(branch));
            if let Some(t) = target {
                url.push_str(&format!("&targetRef={}", encode(t)));
            }
            url
        }
    }
}

/// Splits https/ssh/scp-style remote URLs into (host, path), dropping credentials and ports.
fn split_host_path(url: &str) -> Option<(String, String)> {
    if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "https" | "http" | "ssh" | "git") {
            return None;
        }
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        return Some((host.to_string(), path.to_string()));
    }
    // scp-like: [user@]host:path
    let (authority, path) = url.split_once(':')?;
    if authority.contains(['/', '\\']) || authority.len() == 1 {
        return None; // local path or Windows drive letter
    }
    let host = authority.rsplit('@').next()?;
    Some((host.to_string(), path.to_string()))
}

fn strip_git(s: &str) -> &str {
    s.strip_suffix(".git").unwrap_or(s)
}

fn parse_github(seg: &[&str]) -> Option<RemoteInfo> {
    let [owner, repo, ..] = seg else { return None };
    let repo = strip_git(repo);
    Some(RemoteInfo {
        kind: HostKind::GitHub,
        web_url: format!("https://github.com/{owner}/{repo}"),
        owner: (*owner).to_string(),
        project: None,
        repo: repo.to_string(),
    })
}

fn ado(org: &str, project: &str, repo: &str, base: String) -> Option<RemoteInfo> {
    let repo = strip_git(repo);
    Some(RemoteInfo {
        kind: HostKind::Ado,
        web_url: format!("{base}/{project}/_git/{repo}"),
        owner: org.to_string(),
        project: Some(decode(project)),
        repo: decode(repo),
    })
}

fn parse_ado_dev(seg: &[&str]) -> Option<RemoteInfo> {
    match seg {
        ["v3", ..] => parse_ado_ssh_v3(seg, false),
        [org, project, "_git", repo, ..] => {
            ado(org, project, repo, format!("https://dev.azure.com/{org}"))
        }
        [org, "_git", repo, ..] => ado(org, repo, repo, format!("https://dev.azure.com/{org}")),
        _ => None,
    }
}

fn parse_ado_vsts(org: &str, seg: &[&str]) -> Option<RemoteInfo> {
    let seg = match seg {
        ["DefaultCollection", rest @ ..] => rest,
        s => s,
    };
    let base = format!("https://{org}.visualstudio.com");
    match seg {
        [project, "_git", repo, ..] => ado(org, project, repo, base),
        ["_git", repo, ..] => ado(org, repo, repo, base),
        _ => None,
    }
}

fn parse_ado_ssh_v3(seg: &[&str], legacy_host: bool) -> Option<RemoteInfo> {
    let ["v3", org, project, repo, ..] = seg else {
        return None;
    };
    let base = if legacy_host {
        format!("https://{org}.visualstudio.com")
    } else {
        format!("https://dev.azure.com/{org}")
    };
    ado(org, project, repo, base)
}

fn decode(s: &str) -> String {
    s.replace("%20", " ")
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_remotes_never_produce_a_link() {
        for url in [
            "evil.com#:x",
            "evil.com?:x/_git/r",
            "https://evil.com#.visualstudio.com/p/_git/r",
            "git@github.com:o/r?x=1",
            "https://github.com/o/r#frag",
            "https://github.com/o\\..\\r",
        ] {
            assert_eq!(parse(url), None, "{url}");
        }
    }

    fn web(url: &str) -> String {
        parse(url)
            .unwrap_or_else(|| panic!("failed to parse {url}"))
            .web_url
    }

    #[test]
    fn parses_ado_variants() {
        let expected = "https://dev.azure.com/Contoso/Platform/_git/Web.Shared";
        for url in [
            "https://dev.azure.com/Contoso/Platform/_git/Web.Shared",
            "https://Contoso@dev.azure.com/Contoso/Platform/_git/Web.Shared",
            "https://dev.azure.com/Contoso/Platform/_git/Web.Shared/",
            "git@ssh.dev.azure.com:v3/Contoso/Platform/Web.Shared",
            "ssh://git@ssh.dev.azure.com:22/v3/Contoso/Platform/Web.Shared",
        ] {
            assert_eq!(web(url), expected, "{url}");
        }
    }

    #[test]
    fn parses_visualstudio_variants() {
        let expected = "https://contoso.visualstudio.com/Proj/_git/Repo";
        for url in [
            "https://contoso.visualstudio.com/Proj/_git/Repo",
            "https://contoso.visualstudio.com/DefaultCollection/Proj/_git/Repo",
            "contoso@vs-ssh.visualstudio.com:v3/contoso/Proj/Repo",
        ] {
            assert_eq!(web(url), expected, "{url}");
        }
    }

    #[test]
    fn ado_project_less_url_uses_repo_as_project() {
        assert_eq!(
            web("https://dev.azure.com/org/_git/Thing"),
            "https://dev.azure.com/org/Thing/_git/Thing"
        );
    }

    #[test]
    fn ado_names_with_spaces_are_decoded() {
        let info = parse("https://dev.azure.com/org/My%20Project/_git/My%20Repo").unwrap();
        assert_eq!(info.project.as_deref(), Some("My Project"));
        assert_eq!(info.repo, "My Repo");
        assert_eq!(
            info.web_url,
            "https://dev.azure.com/org/My%20Project/_git/My%20Repo"
        );
    }

    #[test]
    fn parses_github_variants() {
        for url in [
            "https://github.com/octo/hello.git",
            "https://github.com/octo/hello",
            "git@github.com:octo/hello.git",
            "ssh://git@github.com/octo/hello.git",
        ] {
            assert_eq!(web(url), "https://github.com/octo/hello", "{url}");
        }
    }

    #[test]
    fn rejects_unknown_and_local() {
        assert!(parse("https://gitlab.com/a/b").is_none());
        assert!(parse("C:\\repos\\thing").is_none());
        assert!(parse("/srv/git/thing.git").is_none());
    }

    #[test]
    fn builds_ado_links() {
        let i = parse("https://dev.azure.com/o/p/_git/r").unwrap();
        let b = "https://dev.azure.com/o/p/_git/r";
        assert_eq!(link(&i, &LinkTarget::Repo), b);
        assert_eq!(
            link(&i, &LinkTarget::Branch { branch: "feature/AB-1 x".into() }),
            format!("{b}?version=GBfeature/AB-1%20x")
        );
        assert_eq!(
            link(&i, &LinkTarget::Commit { sha: "abc".into() }),
            format!("{b}/commit/abc")
        );
        assert_eq!(
            link(&i, &LinkTarget::File { branch: "main".into(), path: "src/a b.rs".into() }),
            format!("{b}?path=/src/a%20b.rs&version=GBmain")
        );
        assert_eq!(
            link(
                &i,
                &LinkTarget::PullRequest { branch: "feat".into(), target: Some("develop".into()) }
            ),
            format!("{b}/pullrequestcreate?sourceRef=feat&targetRef=develop")
        );
    }

    #[test]
    fn builds_github_links() {
        let i = parse("git@github.com:o/r.git").unwrap();
        let b = "https://github.com/o/r";
        assert_eq!(
            link(&i, &LinkTarget::Branch { branch: "a/b".into() }),
            format!("{b}/tree/a/b")
        );
        assert_eq!(
            link(&i, &LinkTarget::Commit { sha: "abc".into() }),
            format!("{b}/commit/abc")
        );
        assert_eq!(
            link(&i, &LinkTarget::File { branch: "main".into(), path: "/x/y.rs".into() }),
            format!("{b}/blob/main/x/y.rs")
        );
        assert_eq!(
            link(&i, &LinkTarget::PullRequest { branch: "f".into(), target: None }),
            format!("{b}/pull/new/f")
        );
        assert_eq!(
            link(&i, &LinkTarget::PullRequest { branch: "f".into(), target: Some("main".into()) }),
            format!("{b}/compare/main...f?expand=1")
        );
    }
}
