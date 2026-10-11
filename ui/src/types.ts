export type HostKind = 'ado' | 'github'

export interface RemoteInfo {
  kind: HostKind
  webUrl: string
  owner: string
  project: string | null
  repo: string
}

export interface Group {
  id: string
  name: string
  roots: string[]
}

export interface Config {
  groups: Group[]
  scanDepth: number
  excludes: string[]
  concurrency: number
  copilotModel: string | null
  copilotCliPath: string | null
  watch: boolean
  zoom: number
  devtools: boolean
  /** git executable; null = found automatically. */
  gitPath: string | null
  /** How to integrate a diverged branch when the repo has no pull.rebase setting. */
  divergedStrategy: Strategy
}

export interface RepoEntry {
  path: string
  name: string
  groupId: string
}

export interface RepoSummary {
  path: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  conflicted: number
  remote: RemoteInfo | null
  error: string | null
  /** A merge, rebase, cherry-pick or revert waiting for the user. */
  operation: Operation | null
  /** The commit HEAD points at (null on an unborn branch); History reloads when it moves. */
  head?: string | null
}

export interface FileEntry {
  path: string
  origPath: string | null
  index: string
  worktree: string
  untracked: boolean
  conflicted: boolean
}

export interface RepoStatus {
  branch: string | null
  detached: boolean
  oid: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: FileEntry[]
}

export type LineKind = 'context' | 'add' | 'remove' | 'nonewline'

export interface DiffLine {
  kind: LineKind
  oldNo: number | null
  newNo: number | null
  text: string
}

export interface Hunk {
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface FileDiff {
  binary: boolean
  truncated: boolean
  hunks: Hunk[]
}

export interface Branch {
  name: string
  remote: boolean
  isHead: boolean
  upstream: string | null
  ahead: number
  behind: number
  gone: boolean
  sha: string
  committedAt: number
}

export type LinkTarget =
  | { kind: 'repo' }
  | { kind: 'branch'; branch: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'file'; branch: string; path: string }
  | { kind: 'pullRequest'; branch: string; target: string | null }

export type BatchOp = 'fetch' | 'pull'
export type BatchState = 'running' | 'ok' | 'skipped' | 'error'

export interface BatchProgress {
  path: string
  op: BatchOp
  state: BatchState
  message: string | null
  /** For `error`: what went wrong. */
  kind?: ErrorKind | null
  /** Failed only because a sign-in is needed (batches never ask); the dashboard offers Sign in. */
  signIn?: boolean
}

/** What went wrong, as classified by the backend from git's output. */
export type ErrorKind =
  | 'non-fast-forward'
  | 'lock'
  | 'overwrite'
  | 'dubious-ownership'
  | 'auth'
  | 'network'
  | 'signing'
  | 'hook'
  | 'not-a-repo'
  | 'conflict'
  | 'git-missing'
  | 'cancelled'
  | 'other'

export interface CmdError {
  /** Plain-language message for the kind. */
  message: string
  /** git's raw output (behind "details"). */
  detail: string | null
  kind: ErrorKind
  /** The repository the failing command ran in. */
  repo: string | null
  /** For `lock`: the lock file git couldn't create. */
  lockPath: string | null
  /** For `hook`: the hook that failed (e.g. `pre-commit`). */
  hook?: string | null
}

export interface ModelInfo {
  id: string
  name: string
}

export type OpenWith = 'explorer' | 'terminal' | 'vsCode'

/** Backend busy state of a repo: the running operation (e.g. "committing"), or null when idle. */
export interface RepoBusy {
  path: string
  op: string | null
}

/** Result of a discard: files the Recycle Bin could not take (left untouched). */
export interface DiscardOutcome {
  failed: { path: string; untracked: boolean; reason: string }[]
}

/** The last commit when it can be undone (unpushed, not a merge). */
export interface LastCommit {
  subject: string
  message: string
}

/** Added/removed line counts of one changed file. */
export interface LineStat {
  path: string
  added: number
  removed: number
  binary: boolean
}

/** Line counts of staged and unstaged changes (untracked files are not included). */
export interface LineStats {
  staged: LineStat[]
  unstaged: LineStat[]
}

/** A multi-step git operation that stopped half-way. */
export type Operation = 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | 'bisecting' | 'applying-patches'

/** Which git is used and whether it is usable. */
export interface GitLocation {
  path: string | null
  /** e.g. "2.55.0.windows.1" */
  version: string | null
  problem: { kind: 'missing' } | { kind: 'tooOld'; found: string } | null
  /** A Git path was set in Settings but couldn't be run; automatic detection was used. */
  settingIgnored: boolean
}

/** How a diverged branch is integrated with its upstream. */
export type Strategy = 'rebase' | 'merge'

/** How the branch relates to its upstream, right after a fetch. */
export interface Divergence {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  strategy: Strategy
}

export type IntegrateOutcome =
  | { kind: 'done' }
  | { kind: 'conflicts'; files: number }
  /** Integrated, but putting the stashed uncommitted changes back conflicted (they stay in git stash list). */
  | { kind: 'stashConflict'; files: number }

export interface IntegrateResult {
  outcome: IntegrateOutcome
  strategy: Strategy
  pushed: boolean
}

/** A branch, remote branch or tag pointing at a commit. */
export interface RefLabel {
  kind: 'head' | 'local' | 'remote' | 'tag'
  name: string
}

export interface LogEntry {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** Unix seconds. */
  authorTime: number
  subject: string
  refs: RefLabel[]
  /** On no remote-tracking branch. */
  unpushed: boolean
}

export interface LogPage {
  commits: LogEntry[]
  hasMore: boolean
}

export interface CommitFile {
  path: string
  origPath: string | null
  /** A M D R C T */
  status: string
  added: number
  removed: number
  binary: boolean
}

export interface CommitDetails {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  authorTime: number
  committerName: string
  committerEmail: string
  committerTime: number
  message: string
  /** Against the first parent, or the empty tree for a root commit. */
  files: CommitFile[]
  truncated: boolean
}

export type ResetMode = 'soft' | 'mixed'

/** What a reset to a commit would take off the branch. */
export interface ResetPreview {
  /** Commits that leave the branch. */
  leaving: number
  /** Of those, on no remote branch. */
  unpushed: number
  /** Of those, already on the upstream. */
  onUpstream: number
}
