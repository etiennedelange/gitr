import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type {
  BatchOp,
  BatchProgress,
  Branch,
  CmdError,
  CommitDetails,
  Config,
  DiscardOutcome,
  Divergence,
  FileDiff,
  GitLocation,
  IntegrateOutcome,
  IntegrateResult,
  LastCommit,
  LineStats,
  LinkTarget,
  LogPage,
  ModelInfo,
  OpenWith,
  RepoBusy,
  RepoEntry,
  RepoStatus,
  RepoSummary,
  ResetMode,
  ResetPreview,
  Strategy,
} from './types'

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
let invoke: Invoke = tauriInvoke

/**
 * Design preview only (`pnpm mock`): answers Gitr's commands from mock data inside the real
 * window, where the Tauri bridge itself cannot be replaced. Never called by the app.
 */
export function setInvoke(fn: Invoke) {
  invoke = fn
}

export const api = {
  getConfig: () => invoke<Config>('get_config'),
  saveConfig: (config: Config) => invoke<void>('save_config', { config }),
  setZoom: (zoom: number) => invoke<number>('set_zoom', { zoom }),
  openDevtools: () => invoke<boolean>('open_devtools'),
  devtoolsAvailable: () => invoke<boolean>('devtools_available'),
  openLogsFolder: () => invoke<string>('open_logs_folder'),
  listRepos: () => invoke<RepoEntry[]>('list_repos'),
  rescanRepos: () => invoke<RepoEntry[]>('rescan_repos'),
  refreshAll: () => invoke<void>('refresh_all'),
  /** Refreshes one repo (merged with a queued refresh); its views update via `repo-summary`. */
  refreshRepo: (path: string) => invoke<void>('refresh_repo', { path }),
  repoSummary: (path: string) => invoke<RepoSummary>('repo_summary', { path }),
  /** `interactive`: a single user action that waits for a busy repo instead of skipping it. */
  runBatch: (op: BatchOp, paths: string[], interactive = false) => invoke<BatchProgress[]>('run_batch', { op, paths, interactive }),
  busyRepos: () => invoke<RepoBusy[]>('busy_repos'),
  status: (path: string) => invoke<RepoStatus>('repo_status', { path }),
  lineStats: (path: string) => invoke<LineStats>('line_stats', { path }),
  stage: (path: string, files: string[]) => invoke<void>('stage', { path, files }),
  unstage: (path: string, files: string[]) => invoke<void>('unstage', { path, files }),
  /** `permanent` only after the user agreed to lose exactly these files. */
  discard: (path: string, tracked: string[], untracked: string[], permanent = false) =>
    invoke<DiscardOutcome>('discard', { path, tracked, untracked, permanent }),
  lastCommitUndo: (path: string) => invoke<LastCommit | null>('last_commit_undo', { path }),
  undoLastCommit: (path: string) => invoke<string>('undo_last_commit', { path }),
  fileDiff: (path: string, file: string, staged: boolean, untracked: boolean) =>
    invoke<FileDiff>('file_diff', { path, file, staged, untracked }),
  commit: (path: string, message: string, amend: boolean, skipHooks = false) =>
    invoke<string>('commit', { path, message, amend, skipHooks }),
  lastCommitMessage: (path: string) => invoke<string>('last_commit_message', { path }),
  push: (path: string, skipHooks = false) => invoke<void>('push', { path, skipHooks }),
  branches: (path: string) => invoke<Branch[]>('branches', { path }),
  checkout: (path: string, branch: string, remote: boolean) => invoke<void>('checkout', { path, branch, remote }),
  createBranch: (path: string, name: string, start: string | null, checkout: boolean) =>
    invoke<void>('create_branch', { path, name, start, checkout }),
  deleteBranch: (path: string, name: string, force: boolean) => invoke<void>('delete_branch', { path, name, force }),
  openRemote: (path: string, target: LinkTarget) => invoke<string>('open_remote', { path, target }),
  openWith: (path: string, appKind: OpenWith) => invoke<void>('open_with', { path, appKind }),
  generateCommitMessage: (path: string) => invoke<string>('generate_commit_message', { path }),
  cancelGeneration: () => invoke<void>('cancel_generation'),
  /** Stops the running and queued operations of a repo; resolves whether anything was running. */
  cancelOperation: (path: string) => invoke<boolean>('cancel_operation', { path }),
  listModels: () => invoke<ModelInfo[]>('list_models'),
  gitInfo: () => invoke<GitLocation>('git_info'),
  /** null = find git automatically. */
  setGitPath: (path: string | null) => invoke<GitLocation>('set_git_path', { path }),
  recheckGit: () => invoke<GitLocation>('recheck_git'),
  removeStaleLock: (path: string, lock: string) => invoke<void>('remove_stale_lock', { path, lock }),
  trustFolder: (path: string) => invoke<void>('trust_folder', { path }),
  abortOperation: (path: string) => invoke<void>('abort_operation', { path }),
  mergeMessage: (path: string) => invoke<string | null>('merge_message', { path }),
  pullStrategy: (path: string) => invoke<Strategy>('pull_strategy', { path }),
  /** Fetches, then reports ahead/behind and the strategy. */
  divergence: (path: string) => invoke<Divergence>('divergence', { path }),
  integrate: (path: string, push: boolean) => invoke<IntegrateResult>('integrate', { path, push }),
  continueOperation: (path: string) => invoke<IntegrateOutcome>('continue_operation', { path }),
  /** Skips the commit a rebase, cherry-pick, revert or `git am` stopped on. */
  skipOperation: (path: string) => invoke<IntegrateOutcome>('skip_operation', { path }),
  /** HEAD's history, newest first. */
  log: (path: string, skip: number, limit: number) => invoke<LogPage>('log', { path, skip, limit }),
  commitDetails: (path: string, sha: string) => invoke<CommitDetails>('commit_details', { path, sha }),
  commitFileDiff: (path: string, sha: string, file: string, origPath: string | null) =>
    invoke<FileDiff>('commit_file_diff', { path, sha, file, origPath }),
  resetPreview: (path: string, sha: string) => invoke<ResetPreview>('reset_preview', { path, sha }),
  /** A new commit that undoes `sha`; stops in the Reverting state on conflicts. */
  revertCommit: (path: string, sha: string) => invoke<IntegrateOutcome>('revert_commit', { path, sha }),
  /** Moves the branch to `sha` (an ancestor of HEAD). Never touches working-tree files. Resolves the previous HEAD. */
  resetBranch: (path: string, sha: string, mode: ResetMode) => invoke<string>('reset_branch', { path, sha, mode }),
  /** Puts the branch back where the last reset found it (only if that branch is still checked out; the working tree is never touched). */
  undoReset: (path: string, previousHead: string) => invoke<void>('undo_reset', { path, previousHead }),
}

export function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) {
    return (e as CmdError).message
  }
  return String(e)
}

export function errorDetail(e: unknown): string | null {
  if (e && typeof e === 'object' && 'detail' in e) return (e as CmdError).detail
  return null
}

/** The structured error from a failed backend command, if `e` is one. */
export function asCmdError(e: unknown): CmdError | null {
  return e && typeof e === 'object' && 'kind' in e && 'message' in e ? (e as CmdError) : null
}
