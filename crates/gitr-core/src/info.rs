use std::path::Path;

use serde::Serialize;

/// A multi-step git operation that stopped half-way and is waiting for the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    Merging,
    Rebasing,
    CherryPicking,
    Reverting,
    Bisecting,
    /// `git am` applying a patch series.
    ApplyingPatches,
}

impl Operation {
    /// The git subcommand that owns this state.
    pub fn command(self) -> &'static str {
        match self {
            Self::Merging => "merge",
            Self::Rebasing => "rebase",
            Self::CherryPicking => "cherry-pick",
            Self::Reverting => "revert",
            Self::Bisecting => "bisect",
            Self::ApplyingPatches => "am",
        }
    }

    /// Arguments that end it and put the branch back: `git <cmd> --abort`, `git bisect reset`.
    pub fn abort_args(self) -> [&'static str; 2] {
        match self {
            Self::Bisecting => ["bisect", "reset"],
            _ => [self.command(), "--abort"],
        }
    }

    /// Whether `--continue` applies (a bisect goes on by marking commits good or bad).
    pub fn can_continue(self) -> bool {
        self != Self::Bisecting
    }

    /// Whether `--skip` applies: drop the commit or patch that stopped and go on with the rest.
    /// A merge has nothing to skip; `git bisect skip` means something else.
    pub fn can_skip(self) -> bool {
        matches!(self, Self::Rebasing | Self::CherryPicking | Self::Reverting | Self::ApplyingPatches)
    }

    /// "merge", "rebase", "cherry-pick", "revert", "bisect", "patch series" as a noun for
    /// messages ("A {noun} is in progress").
    pub fn noun(self) -> &'static str {
        match self {
            Self::ApplyingPatches => "patch series",
            _ => self.command(),
        }
    }
}

/// Cheap, process-free repo metadata read via gitoxide for dashboard rows.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub head_branch: Option<String>,
    pub remote_url: Option<String>,
    pub operation: Option<Operation>,
    /// The commit HEAD points at, for the dashboard's detailed cards (None on an unborn branch).
    pub last_commit: Option<LastCommit>,
}

/// The subject and committer time of the HEAD commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub subject: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
}

pub fn read_info(path: &Path) -> RepoInfo {
    let Ok(repo) = gix::open(path) else {
        return RepoInfo::default();
    };
    let head_branch = repo
        .head_name()
        .ok()
        .flatten()
        .map(|n| n.shorten().to_string());
    let remote_url = repo
        .find_default_remote(gix::remote::Direction::Fetch)
        .and_then(Result::ok)
        .and_then(|r| r.url(gix::remote::Direction::Fetch).map(|u| u.to_bstring().to_string()));
    RepoInfo { head_branch, remote_url, operation: operation_of(&repo), last_commit: last_commit_of(&repo) }
}

/// The in-progress operation of the repo at `path`, if any (reads `.git` state files only).
pub fn read_operation(path: &Path) -> Option<Operation> {
    gix::open(path).ok().as_ref().and_then(operation_of)
}

/// Reads one object from the repository's database; no git process.
fn last_commit_of(repo: &gix::Repository) -> Option<LastCommit> {
    let commit = repo.head_commit().ok()?;
    let subject = commit.message().ok()?.summary().to_string();
    let time = commit.time().ok()?.seconds;
    Some(LastCommit { subject, time })
}

fn operation_of(repo: &gix::Repository) -> Option<Operation> {
    use gix::state::InProgress as P;
    match repo.state()? {
        P::Merge => Some(Operation::Merging),
        P::Rebase | P::RebaseInteractive | P::ApplyMailboxRebase => Some(Operation::Rebasing),
        P::CherryPick | P::CherryPickSequence => Some(Operation::CherryPicking),
        P::Revert | P::RevertSequence => Some(Operation::Reverting),
        P::Bisect => Some(Operation::Bisecting),
        P::ApplyMailbox => Some(Operation::ApplyingPatches),
    }
}
