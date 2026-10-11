use std::borrow::Cow;

/// Hides credentials embedded in URLs: `https://user:pass@host/x` → `https://***@host/x`.
///
/// Handles every `scheme://` occurrence in `s`. URLs without userinfo (and scp-style
/// `git@host:path`, which carries no secret) are left unchanged.
pub fn urls(s: &str) -> Cow<'_, str> {
    if !s.contains("://") {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    let mut changed = false;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c == '/' || c.is_whitespace() || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str("***");
                out.push_str(&authority[at..]);
                changed = true;
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    if changed { Cow::Owned(out) } else { Cow::Borrowed(s) }
}

#[cfg(test)]
mod tests {
    use super::urls;

    #[test]
    fn redacts_user_and_password() {
        assert_eq!(urls("https://user:s3cret@dev.azure.com/org/_git/r"), "https://***@dev.azure.com/org/_git/r");
    }

    #[test]
    fn redacts_token_only() {
        assert_eq!(urls("https://ghp_abc123@github.com/o/r.git"), "https://***@github.com/o/r.git");
        assert_eq!(urls("https://oauth2:xyz@gitlab.com/o/r"), "https://***@gitlab.com/o/r");
    }

    #[test]
    fn leaves_plain_urls_and_scp_syntax() {
        assert_eq!(urls("https://github.com/o/r.git"), "https://github.com/o/r.git");
        assert_eq!(urls("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(urls("ssh://git@host/r"), "ssh://***@host/r");
        assert_eq!(urls("no url here"), "no url here");
    }

    #[test]
    fn redacts_every_url_in_a_line() {
        assert_eq!(
            urls("fatal: unable to access 'https://a:b@h1/x': and https://c@h2/y end"),
            "fatal: unable to access 'https://***@h1/x': and https://***@h2/y end"
        );
    }
}
