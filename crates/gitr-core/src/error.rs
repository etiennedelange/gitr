use serde::Serialize;

/// What went wrong, as far as Gitr can tell from git's (English) output. The UI picks the
/// message and the offered fix by kind, never by matching text itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    /// Push rejected: the remote has commits the local branch doesn't.
    NonFastForward,
    /// `index.lock` (or another lock file) exists: another git process, or a stale lock.
    Lock,
    /// Local changes would be overwritten (checkout, merge).
    Overwrite,
    /// `safe.directory`: the folder is owned by another user.
    DubiousOwnership,
    /// Credentials missing or rejected, SSH key refused.
    Auth,
    /// Host unreachable, connection dropped, repository not found.
    Network,
    /// Commit signing (GPG/SSH) failed.
    Signing,
    /// A git hook rejected the commit or push (set by the caller from git's trace, see `hooks`).
    Hook,
    /// The folder is not (or no longer) a git repository.
    NotARepo,
    /// A merge, rebase or cherry-pick stopped on conflicts.
    Conflict,
    /// git could not be started at all (not installed, or a wrong Git path).
    GitMissing,
    /// The user stopped the operation (set by the app, never classified from git's output).
    Cancelled,
    Other,
}

/// Patterns in priority order: the first kind with a matching pattern wins, so the most
/// specific kinds come first. Matched case-insensitively against stderr and stdout (git runs
/// with `LC_ALL=C`). Samples of the real output are in `tests/errors.rs`.
const PATTERNS: &[(ErrorKind, &[&str])] = &[
    (ErrorKind::Lock, &["another git process seems to be running", ".lock': file exists"]),
    (ErrorKind::DubiousOwnership, &["detected dubious ownership"]),
    (ErrorKind::NotARepo, &["not a git repository"]),
    (ErrorKind::Signing, &["gpg failed to sign", "failed to sign the data", "signing failed"]),
    (
        ErrorKind::Auth,
        &[
            "authentication failed",
            "could not read username",
            "could not read password",
            "terminal prompts disabled",
            "permission denied (publickey",
            "returned error: 401",
            "returned error: 403",
            "host key verification failed",
            // Git Credential Manager with GCM_INTERACTIVE=never (batches).
            "user interactivity has been disabled",
        ],
    ),
    (
        ErrorKind::Network,
        &[
            "could not resolve host",
            "could not resolve hostname",
            "failed to connect to",
            "could not connect to server",
            "remote end hung up unexpectedly",
            "connection timed out",
            "connection refused",
            "network is unreachable",
            "repository not found",
            "' not found",
        ],
    ),
    // SSH without a more specific line (key refused, agent missing): treat as sign-in.
    (ErrorKind::Auth, &["could not read from remote repository"]),
    (
        ErrorKind::NonFastForward,
        &["(fetch first)", "(non-fast-forward)", "updates were rejected because"],
    ),
    (ErrorKind::Overwrite, &["would be overwritten by"]),
    (
        ErrorKind::Conflict,
        &["conflict (", "automatic merge failed", "could not apply", "fix conflicts and then commit"],
    ),
];

pub fn classify(output: &str) -> ErrorKind {
    let lower = output.to_ascii_lowercase();
    PATTERNS
        .iter()
        .find(|(_, needles)| needles.iter().any(|n| lower.contains(n)))
        .map_or(ErrorKind::Other, |(kind, _)| *kind)
}

/// Whether git's output says credentials were missing or refused, so signing in can fix it.
/// Narrower than `Auth`: a 403 (signed in, but no access), a changed host key (a security
/// warning) and SSH's generic "could not read from remote repository" (also printed for a
/// missing repository) are auth errors that no sign-in fixes.
pub fn needs_sign_in(output: &str) -> bool {
    const SIGN_IN: &[&str] = &[
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "user interactivity has been disabled",
        "returned error: 401",
        "permission denied (publickey",
    ];
    let lower = output.to_ascii_lowercase();
    !lower.contains("host key verification failed") && SIGN_IN.iter().any(|p| lower.contains(p))
}

/// The lock file named in a Lock error (`Unable to create '<path>': File exists.`).
pub fn lock_path(output: &str) -> Option<String> {
    let lower = output.to_ascii_lowercase();
    let start = lower.find("unable to create '")? + "unable to create '".len();
    let end = start + lower[start..].find("': file exists")?;
    Some(output[start..end].to_string())
}

#[derive(Debug, Clone, thiserror::Error, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GitError {
    #[error("failed to start git: {message}")]
    Spawn { message: String },
    #[error("git {op} failed: {stderr}")]
    Failed {
        op: String,
        code: Option<i32>,
        /// git's output (stderr, then stdout when it has something), for "details".
        stderr: String,
        kind: ErrorKind,
        /// The folder the command ran in (the repository).
        cwd: String,
        /// For `Hook`: the hook that failed (e.g. `pre-commit`).
        #[serde(skip_serializing_if = "Option::is_none")]
        hook: Option<String>,
    },
    #[error("git {op} timed out after {seconds}s")]
    Timeout { op: String, seconds: u64 },
    #[error("{message}")]
    Invalid { message: String },
}

impl GitError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid { message: message.into() }
    }

    /// A failed git command; `stderr` and `stdout` are both classified (push --porcelain puts
    /// the rejection on stdout).
    pub fn failed(op: &str, cwd: &str, code: Option<i32>, stderr: &str, stdout: &str) -> Self {
        let (stderr, stdout) = (stderr.trim(), stdout.trim());
        let text = match (stderr.is_empty(), stdout.is_empty()) {
            (false, false) => format!("{stderr}\n{stdout}"),
            (false, true) => stderr.to_string(),
            _ => stdout.to_string(),
        };
        // Keep details readable even if a command printed a lot before failing.
        let text = if text.len() > 64 * 1024 {
            let mut cut = 64 * 1024;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            format!("{}\n[output truncated]", &text[..cut])
        } else {
            text
        };
        Self::Failed { op: op.to_string(), code, kind: classify(&text), stderr: text, cwd: cwd.to_string(), hook: None }
    }

    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Failed { kind, .. } => *kind,
            Self::Spawn { .. } => ErrorKind::GitMissing,
            _ => ErrorKind::Other,
        }
    }

    /// Marks a failure as caused by `hook`. The hook's own output decides nothing: a lint hook
    /// that prints "connection refused" is still a hook failure.
    pub fn into_hook_failure(self, name: &str) -> Self {
        match self {
            Self::Failed { op, code, stderr, cwd, .. } => {
                Self::Failed { op, code, stderr, kind: ErrorKind::Hook, cwd, hook: Some(name.to_string()) }
            }
            other => other,
        }
    }

    /// The hook that failed, for `Hook` errors.
    pub fn hook(&self) -> Option<&str> {
        match self {
            Self::Failed { hook, .. } => hook.as_deref(),
            _ => None,
        }
    }

    pub fn lock_path(&self) -> Option<String> {
        match self {
            Self::Failed { kind: ErrorKind::Lock, stderr, .. } => lock_path(stderr),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn most_specific_kind_wins() {
        // A rejected push whose real cause is authentication.
        assert_eq!(classify("! [rejected] main -> main\nfatal: Authentication failed for 'https://x'"), ErrorKind::Auth);
        // SSH: an unresolvable host is a network problem, not a sign-in problem.
        assert_eq!(
            classify("ssh: Could not resolve hostname nope: No such host is known.\nfatal: Could not read from remote repository."),
            ErrorKind::Network
        );
        assert_eq!(classify("fatal: Could not read from remote repository."), ErrorKind::Auth);
        assert_eq!(classify("something unexpected"), ErrorKind::Other);
    }

    #[test]
    fn only_credential_failures_need_a_sign_in() {
        for yes in [
            "fatal: Authentication failed for 'https://dev.azure.com/acme/'",
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
            "fatal: Cannot prompt because user interactivity has been disabled.",
            "error: RPC failed; HTTP 401 curl 22 The requested URL returned error: 401",
            "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        ] {
            assert!(needs_sign_in(yes), "{yes}");
        }
        for no in [
            "fatal: unable to access 'https://x/': The requested URL returned error: 403",
            "Host key verification failed.\nfatal: Could not read from remote repository.",
            "fatal: '/srv/gone.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
            "fatal: unable to access 'https://x/': Could not resolve host: x",
        ] {
            assert!(!needs_sign_in(no), "{no}");
        }
    }

    #[test]
    fn lock_path_keeps_original_case() {
        let out = "fatal: Unable to create 'C:/Repos/My Repo/.git/index.lock': File exists.\n\nAnother git process seems to be running";
        assert_eq!(lock_path(out).as_deref(), Some("C:/Repos/My Repo/.git/index.lock"));
        assert_eq!(lock_path("fatal: other"), None);
    }
}
