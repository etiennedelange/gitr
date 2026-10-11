/**
 * Design preview: runs the real UI against a mocked backend with synthetic repositories, either
 * in the Gitr window (`pnpm mock`) or in a browser (`pnpm mock:web`). Loaded from
 * /preview.html; not part of the app build. See README.md in this folder.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import type { BatchOp, Branch, FileDiff, FileEntry, RepoStatus, RepoSummary } from '../types'
import { SCENARIOS, scenarioById } from './scenarios'
import { runHooks, stopHooks } from './hooks'
import { batchResult } from './signin'
import { UNTRACKED_DIRS, f as fileEntry } from './data'
import * as history from './history'

const params = new URLSearchParams(location.search)
const scenario = scenarioById(params.get('scenario'))

// Inside the Gitr window (`pnpm mock`) the real Tauri bridge exists: keep it for plugin
// calls and mock only Gitr's own commands. In a browser, everything is mocked.
const inApp = '__TAURI_INTERNALS__' in window

// Mutable copies: staging, committing and so on change them for the rest of the session.
const status: Record<string, RepoStatus> = structuredClone(scenario.status)
const summaries: Record<string, RepoSummary> = structuredClone(scenario.summaries)
const fallbackDiff = Object.values(scenario.diffs)[0]
history.setSample(fallbackDiff)
let shaN = 0
// Files a mock reset put in the working tree, so Undo reset can take them out again.
const resetFiles: Record<string, string[]> = {}
const listeners = new Map<string, Set<number>>()

// Rebases that stop on one more conflict after the first Continue or Skip.
const stopAgain = new Set(Object.keys(summaries).filter((p) => summaries[p].operation === 'rebasing'))

const summaryOf = (path: string): RepoSummary => {
  const s = summaries[path]
  const st = status[path]
  if (!st) return s
  const staged = st.files.filter((f) => !f.untracked && !f.conflicted && f.index !== '.').length
  // Like the app's summary (--untracked-files=normal), an untracked folder counts once.
  const dirs = UNTRACKED_DIRS[path] ?? []
  const folded = new Set<string>()
  const unstaged = st.files.filter((f) => {
    if (!(f.untracked || f.conflicted || f.worktree !== '.')) return false
    const dir = f.untracked && dirs.find((d) => f.path.startsWith(d))
    if (!dir) return true
    if (folded.has(dir)) return false
    folded.add(dir)
    return true
  }).length
  const conflicted = st.files.filter((f) => f.conflicted).length
  return { ...s, staged, unstaged, conflicted, head: history.headOf(s) }
}
const announce = (path: string) => void emit('repo-summary', summaryOf(path))

const move = (path: string, files: string[], toStaged: boolean) => {
  const st = status[path]
  for (const f of st.files) {
    if (files.length && !files.includes(f.path)) continue
    if (toStaged && f.conflicted) {
      // Staging a conflicted file marks it resolved, as `git add` does.
      f.conflicted = false
      f.index = 'M'
      f.worktree = '.'
    } else if (toStaged && (f.worktree !== '.' || f.untracked)) {
      f.index = f.untracked ? 'A' : f.worktree
      f.worktree = '.'
      f.untracked = false
    } else if (!toStaged && f.index !== '.') {
      f.worktree = f.index === 'A' && !f.origPath ? '?' : f.index
      f.untracked = f.worktree === '?'
      f.index = '.'
    }
  }
  announce(path)
}

/** The operation is over: resolved files are committed, the rest of the working tree stays. */
const endOperation = (path: string) => {
  summaries[path] = { ...summaries[path], operation: null, conflicted: 0, detached: false, branch: summaries[path].branch ?? 'main' }
  const st = status[path]
  if (st)
    Object.assign(st, {
      branch: summaries[path].branch,
      detached: false,
      files: st.files.filter((f) => !f.conflicted && (f.untracked || f.worktree !== '.')),
    })
}

const lineStats = (path: string) => {
  const all = scenario.lines[path] ?? {}
  const st = status[path]
  const pick = (staged: boolean) =>
    (st?.files ?? [])
      .filter((f: FileEntry) => !f.untracked && (staged ? f.index !== '.' : f.worktree !== '.'))
      .filter((f) => all[f.path])
      .map((f) => ({ path: f.path, ...all[f.path] }))
  return { staged: pick(true), unstaged: pick(false) }
}

/** Answers Gitr's own commands from the scenario; unsupported actions fail explicitly. */
function handle(cmd: string, args: unknown): unknown {
  const a = (args ?? {}) as Record<string, unknown>
  const path = a.path as string
  switch (cmd) {
    case 'plugin:event|listen': {
      const event = a.event as string
      const handlers = listeners.get(event) ?? new Set<number>()
      handlers.add(a.handler as number)
      listeners.set(event, handlers)
      return a.handler
    }
    case 'plugin:event|unlisten':
      listeners.get(a.event as string)?.delete(a.eventId as number)
      return null
    case 'plugin:event|emit': {
      const internals = window as Window & { __TAURI_INTERNALS__?: { runCallback: (id: number, data: unknown) => void } }
      if (!internals.__TAURI_INTERNALS__) throw new Error('Mock event bridge is unavailable')
      for (const id of listeners.get(a.event as string) ?? [])
        internals.__TAURI_INTERNALS__.runCallback(id, { event: a.event, payload: a.payload })
      return null
    }
    case 'get_config':
      return {
        groups: scenario.groups,
        scanDepth: 3,
        excludes: ['node_modules', 'target'],
        concurrency: 8,
        copilotModel: null,
        copilotCliPath: null,
        watch: true,
        zoom: 100,
        devtools: false,
        gitPath: null,
        divergedStrategy: 'rebase',
      }
    case 'list_repos':
    case 'rescan_repos':
      return scenario.repos
    case 'run_batch': {
      const op = a.op as BatchOp
      const paths = a.paths as string[]
      for (const p of paths) void emit('batch-progress', { path: p, op, state: 'running', message: null, kind: null })
      return new Promise((resolve) =>
        setTimeout(() => {
          const results = paths.map((p) => batchResult(p, op, !!a.interactive, summaries[p]))
          for (const r of results) {
            if (r.op === 'pull' && r.state === 'ok') summaries[r.path] = { ...summaries[r.path], behind: 0 }
            void emit('batch-progress', r)
            announce(r.path)
          }
          resolve(results)
        }, 500),
      )
    }
    case 'refresh_repo':
      announce(path)
      return null
    case 'refresh_all':
      setTimeout(() => scenario.repos.forEach((r) => announce(r.path)), 30)
      return null
    case 'repo_summary':
      return summaryOf(path)
    case 'busy_repos':
      return scenario.busy
    case 'devtools_available':
      return false
    case 'list_models':
      return [{ id: 'gpt-5', name: 'GPT-5' }]
    case 'repo_status':
      return structuredClone(
        status[path] ?? {
          branch: summaries[path]?.branch ?? null,
          detached: false,
          oid: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
        },
      )
    case 'line_stats':
      return lineStats(path)
    case 'file_diff': {
      const file = a.file as string
      // Any file with line counts gets a sample diff, so big change lists can be browsed.
      const known = Object.values(scenario.lines).some((l) => l[file])
      return (scenario.diffs[file] ?? (known ? fallbackDiff : { binary: false, truncated: false, hunks: [] })) satisfies FileDiff
    }
    case 'stage':
      return move(path, a.files as string[], true)
    case 'unstage':
      return move(path, a.files as string[], false)
    case 'branches':
      return (scenario.branches[path] ?? scenario.branches.default) satisfies Branch[]
    case 'last_commit_undo':
      return summaries[path]?.ahead
        ? { subject: 'Add CSV writer for invoice export', message: 'Add CSV writer for invoice export\n' }
        : null
    case 'last_commit_message':
      return 'Add CSV writer for invoice export\n'
    case 'commit':
      return runHooks(path, 'commit', !!a.skipHooks).then(() => {
        const st = status[path]
        const lines = scenario.lines[path] ?? {}
        const staged = (st?.files ?? []).filter((f) => !f.untracked && !f.conflicted && f.index !== '.')
        history.committed(
          summaries[path],
          typeof a.message === 'string' ? a.message : 'Commit',
          staged.map((f) => ({
            path: f.path,
            origPath: f.origPath,
            status: f.index,
            added: lines[f.path]?.added ?? 3,
            removed: lines[f.path]?.removed ?? 1,
            binary: false,
          })),
        )
        if (st) st.files = st.files.filter((f) => f.worktree !== '.' || f.untracked).map((f) => ({ ...f, index: '.' }))
        summaries[path] = { ...summaries[path], ahead: summaries[path].ahead + 1 }
        announce(path)
        return ['a41f9c2', '7be03d1', 'c9e5520', '0d6a8f4'][shaN++ % 4] + 'e5b1c0d9f3a2b7c4e6d8f0a1b3c5d7e9f'
      })
    case 'push':
      return runHooks(path, 'push', !!a.skipHooks).then(() => {
        summaries[path] = { ...summaries[path], ahead: 0 }
        history.pushed(summaries[path])
        announce(path)
        return null
      })
    case 'generate_commit_message':
      if (params.get('generate') === 'error') throw new Error('Simulated generation failure')
      return 'Export invoices as CSV and PDF\n\nAdds a PDF layout next to the CSV writer and renames FormatList to Formats.'
    case 'git_info':
    case 'recheck_git':
    case 'set_git_path':
      return gitLocation()
    case 'merge_message':
      return summaries[path]?.operation === 'merging' ? "Merge branch 'main' into fix/token-refresh" : null
    case 'abort_operation':
      endOperation(path)
      if (status[path]) status[path].files = []
      announce(path)
      return null
    case 'pull_strategy':
      return 'rebase'
    case 'divergence': {
      const s = summaries[path]
      return {
        branch: s?.branch ?? null,
        upstream: s?.upstream ?? null,
        ahead: s?.ahead ?? 0,
        behind: Math.max(s?.behind ?? 0, s?.ahead ? 1 : 0),
        strategy: 'rebase',
      }
    }
    case 'integrate':
      summaries[path] = { ...summaries[path], behind: 0, ahead: a.push ? 0 : summaries[path].ahead }
      announce(path)
      return { outcome: { kind: 'done' }, strategy: 'rebase', pushed: !!a.push }
    case 'continue_operation':
    case 'skip_operation': {
      // A rebase can stop again on its next commit; the second Continue or Skip finishes it.
      if (stopAgain.delete(path)) {
        const st = status[path]
        if (st)
          st.files = [
            ...st.files.filter((f) => f.untracked || f.worktree !== '.'),
            { path: 'src/Auth/TokenStore.cs', origPath: null, index: 'U', worktree: 'U', untracked: false, conflicted: true },
          ]
        else summaries[path] = { ...summaries[path], conflicted: 1 }
        announce(path)
        return { kind: 'conflicts', files: 1 }
      }
      endOperation(path)
      announce(path)
      return { kind: 'done' }
    }
    case 'cancel_operation': {
      if (stopHooks(path)) return true
      const busy = scenario.busy.some((b) => b.path === path)
      scenario.busy = scenario.busy.filter((b) => b.path !== path)
      void emit('repo-busy', { path, op: null })
      return busy
    }
    case 'trust_folder':
    case 'remove_stale_lock':
      return null
    case 'log':
      // ?history=slow|error: the loading and error states of the History tab.
      if (params.get('history') === 'error') throw new Error('fatal: bad object HEAD')
      if (params.get('history') === 'slow') return new Promise(() => {})
      return history.log(summaries[path], a.skip as number, a.limit as number)
    case 'commit_details':
      return history.details(summaries[path], a.sha as string)
    case 'commit_file_diff':
      return history.fileDiff(summaries[path], a.sha as string, a.file as string, fallbackDiff)
    case 'reset_preview':
      return history.resetPreview(summaries[path], a.sha as string)
    case 'revert_commit': {
      // ?revert=conflict: the revert stops on a conflict, as when later commits touched the same lines.
      const conflict = params.get('revert') === 'conflict'
      const outcome = history.revert(summaries[path], a.sha as string, conflict)
      if (conflict) {
        summaries[path] = { ...summaries[path], operation: 'reverting' }
        const st = status[path]
        if (st) st.files = [...st.files, fileEntry('src/Export/InvoiceExporter.cs', 'U', 'U', { conflicted: true })]
        else summaries[path] = { ...summaries[path], conflicted: 1 }
      } else summaries[path] = { ...summaries[path], ahead: summaries[path].ahead + 1 }
      announce(path)
      return outcome
    }
    case 'reset_branch': {
      const { previousHead, files, onUpstream } = history.reset(summaries[path], a.sha as string)
      const soft = a.mode === 'soft'
      const st = (status[path] ??= {
        branch: summaries[path].branch,
        detached: false,
        oid: null,
        upstream: summaries[path].upstream,
        ahead: 0,
        behind: 0,
        files: [],
      })
      const known = new Set(st.files.map((x) => x.path))
      resetFiles[path] = files.filter((x) => !known.has(x.path)).map((x) => x.path)
      for (const x of files) {
        if (known.has(x.path)) continue
        const letter = x.status === 'R' ? 'M' : x.status
        st.files.push(
          fileEntry(x.path, soft ? letter : '.', soft ? '.' : letter === 'A' ? '?' : letter, { untracked: !soft && letter === 'A' }),
        )
      }
      const ahead = history.log(summaries[path], 0, 10_000).commits.filter((c) => c.unpushed).length
      summaries[path] = { ...summaries[path], ahead, behind: summaries[path].behind + onUpstream }
      announce(path)
      return previousHead
    }
    case 'undo_reset': {
      const restored = history.undoReset(summaries[path], a.previousHead as string)
      const st = status[path]
      const added = new Set(resetFiles[path] ?? [])
      if (st) st.files = st.files.filter((x) => !added.has(x.path))
      delete resetFiles[path]
      const ahead = history.log(summaries[path], 0, 10_000).commits.filter((c) => c.unpushed).length
      const back = restored.filter((c) => !c.unpushed).length
      summaries[path] = { ...summaries[path], ahead, behind: Math.max(0, summaries[path].behind - back) }
      announce(path)
      return null
    }
    case 'plugin:dialog|message': {
      // Browser preview: a native dialog isn't available, so confirm() answers it (the app
      // window keeps the real dialogs). Returns the label of the chosen button, as Tauri does.
      const buttons = a.buttons as string | { OkCancelCustom?: [string, string] } | undefined
      const [yes, no] = typeof buttons === 'object' && buttons.OkCancelCustom ? buttons.OkCancelCustom : ['Yes', 'No']
      return window.confirm(String(a.message)) ? yes : no
    }
    default:
      if (cmd.startsWith('plugin:')) return null
      throw new Error(`Preview does not implement ${cmd}`)
  }
}

if (inApp) {
  // The Tauri bridge is locked in the real window, so swap the invoke behind Gitr's api module.
  // Plugin calls (events, dialogs, window theme) keep using the real bridge.
  const { setInvoke } = await import('../api')
  setInvoke(async (cmd, args) => handle(cmd, args) as never)
} else {
  mockWindows('main')
  mockIPC(handle)
}

/** ?git=missing|old shows the git banner. */
function gitLocation() {
  const git = params.get('git')
  if (git === 'missing') return { path: null, version: null, problem: { kind: 'missing' }, settingIgnored: false }
  if (git === 'old')
    return {
      path: 'C:/Program Files/Git/cmd/git.exe',
      version: '2.20.1.windows.1',
      problem: { kind: 'tooOld', found: '2.20.1.windows.1' },
      settingIgnored: false,
    }
  return { path: 'C:/Program Files/Git/cmd/git.exe', version: '2.55.0.windows.1', problem: null, settingIgnored: false }
}

// URL parameters (all optional), handy for bookmarks and screenshots:
//   scenario=default|many|errors|clean|empty   theme=light|dark   chrome=0 (hide the toolbar)
//   view=repo|settings   repo=<name>   tab=history|branches   file=<path suffix>   message=<commit message>
//   revert=conflict (History: Revert stops on a conflict)   history=slow|error (History loading / error)
//   git=missing|old (git banner)   toast=non-fast-forward|lock|dubious-ownership|auth (error toast)
//   hooks=pass|fail (simulated commit and push hooks)   signin=expired (batches need a sign-in)
const theme = params.get('theme')
if (theme === 'light' || theme === 'dark') localStorage.setItem('theme', theme)

await import('../main')

const { useApp } = await import('../store')
const view = params.get('view')
if (view === 'settings') useApp.getState().setView({ kind: 'settings' })
if (view === 'repo') {
  const wanted = params.get('repo')
  const repo = scenario.repos.find((r) => r.name === wanted) ?? scenario.repos.find((r) => status[r.path]) ?? scenario.repos[0]
  if (repo) useApp.getState().setView({ kind: 'repo', path: repo.path })
  const file = params.get('file')
  const tab = params.get('tab')
  const message = params.get('message')
  // Select a file / tab and fill the message once the lists have rendered.
  setTimeout(() => {
    if (tab === 'history') document.querySelector<HTMLButtonElement>('#tab-history')?.click()
    if (tab === 'branches') document.querySelector<HTMLButtonElement>('#tab-branches')?.click()
    if (file) [...document.querySelectorAll<HTMLElement>('.file-list li')].find((li) => li.title.endsWith(file))?.click()
    const ta = document.querySelector<HTMLTextAreaElement>('.commit-box textarea')
    if (message && ta) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, message)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, 400)
}

const toastKind = params.get('toast')
if (toastKind && scenario.repos[0]) {
  const { showErrorSample } = await import('./errors')
  setTimeout(() => showErrorSample(toastKind, scenario.repos[0].path), 500)
}

if (params.get('chrome') !== '0') {
  const { mountToolbar } = await import('./toolbar')
  mountToolbar(SCENARIOS, scenario)
}
