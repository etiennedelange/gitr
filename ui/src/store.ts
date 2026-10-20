import { create } from 'zustand'
import type { BatchProgress, CmdError, Config, RepoSummary } from './types'
import type { Filter, SortKey } from './lib/git'
import { loadDiffZoom, saveDiffZoom } from './lib/zoom'

export type View = { kind: 'dashboard' } | { kind: 'settings' } | { kind: 'repo'; path: string }

/** Dashboard filters and scroll, kept so they survive a trip into a repo and back. */
export interface DashboardState {
  filter: Filter
  text: string
  sort: SortKey
  group: string
  scroll: number
}
export const initialDashboard: DashboardState = { filter: 'all', text: '', sort: 'status', group: '', scroll: 0 }

const MAX_TOASTS = 5

export interface Toast {
  id: number
  kind: 'info' | 'error'
  message: string
  detail?: string | null
  /** The structured error, so the toast can offer a fix (Pull, Remove stale lock, …). */
  error?: CmdError | null
  /** One follow-up for an info toast, such as Undo. */
  action?: ToastAction | null
}

export interface ToastAction {
  label: string
  run: () => Promise<unknown>
}

/** The last reset of a repo, kept so it can be undone until the next write to that repo. */
export interface LastReset {
  previousHead: string
  /** "main back to 3f2a1c9" */
  label: string
}

/** What "… without hooks" repeats after a hook rejected it. */
export type HookRetry = { kind: 'commit'; message: string; amend: boolean; andPush: boolean } | { kind: 'push' }

/** Hooks of a commit or push in a repo: their output while they run, and the failure if one rejected it. */
export interface HookRun {
  op: 'commit' | 'push'
  lines: string[]
  /** Set once a hook rejected the operation. */
  failed: { error: CmdError; retry: HookRetry } | null
}

/** Hook output kept per run; a chatty linter can print thousands of lines. */
const MAX_HOOK_LINES = 2000

interface AppStore {
  view: View
  summaries: Record<string, RepoSummary>
  batch: Record<string, BatchProgress>
  /** Backend busy state per repo path: the running operation (absent = idle). */
  busy: Record<string, string>
  toasts: Toast[]
  dashboard: DashboardState
  /** Unsaved Settings edits, kept while you look at something else. Only valid for the `base` config they were made against. */
  settingsDraft: { base: Config; draft: Config } | null
  setSettingsDraft: (d: { base: Config; draft: Config } | null) => void
  setDashboard: (patch: Partial<DashboardState>) => void
  /** UI zoom in percent (mirrors config.zoom, owned by the backend). */
  zoom: number
  /** Zoom of the code in diffs, in percent, on top of the UI zoom (Ctrl + scroll over a diff). */
  diffZoom: number
  setDiffZoom: (zoom: number) => void
  /** Whether dev tools can be opened (debug build or Settings flag). */
  devtools: boolean
  /** Where closing Settings goes back to. */
  returnView: View
  setView: (view: View) => void
  closeSettings: () => void
  setZoom: (zoom: number) => void
  setDevtools: (devtools: boolean) => void
  setSummary: (s: RepoSummary) => void
  setBatch: (p: BatchProgress) => void
  clearBatch: () => void
  /** The sign-in banner was closed; it comes back with the next Fetch all / Pull all. Rows keep their results. */
  signInDismissed: boolean
  dismissSignIn: () => void
  /** Sign in is running (kept here so the banner keeps its state if it re-renders mid-way). */
  signingIn: boolean
  setSigningIn: (on: boolean) => void
  setRepoBusy: (path: string, op: string | null) => void
  setAllBusy: (busy: Record<string, string>) => void
  toast: (kind: Toast['kind'], message: string, detail?: string | null, error?: CmdError | null, action?: ToastAction | null) => void
  dismiss: (id: number) => void
  /** Hook runs per repo path (absent = none to show). */
  hookRuns: Record<string, HookRun>
  hooksStarted: (path: string, op: HookRun['op']) => void
  hookOutput: (path: string, line: string) => void
  hookFailed: (path: string, error: CmdError, retry: HookRetry) => void
  clearHookRun: (path: string) => void
  /** Bumped per repo when a commit lands, so the commit box clears (also for commits made elsewhere, e.g. "Commit without hooks"). */
  commits: Record<string, number>
  committed: (path: string) => void
  /** Per repo path; cleared when the next write to the repo starts. */
  resets: Record<string, LastReset>
  setReset: (path: string, reset: LastReset | null) => void
}

let nextToast = 1

export const useApp = create<AppStore>((set) => ({
  view: { kind: 'dashboard' },
  returnView: { kind: 'dashboard' },
  summaries: {},
  batch: {},
  busy: {},
  toasts: [],
  dashboard: { ...initialDashboard },
  settingsDraft: null,
  setSettingsDraft: (settingsDraft) => set({ settingsDraft }),
  setDashboard: (patch) => set((st) => ({ dashboard: { ...st.dashboard, ...patch } })),
  zoom: 100,
  diffZoom: loadDiffZoom(),
  setDiffZoom: (diffZoom) => {
    saveDiffZoom(diffZoom)
    set({ diffZoom })
  },
  devtools: false,
  setView: (view) => set((st) => ({ view, returnView: view.kind === 'settings' && st.view.kind !== 'settings' ? st.view : st.returnView })),
  closeSettings: () => set((st) => (st.view.kind === 'settings' ? { view: st.returnView } : {})),
  setZoom: (zoom) => set({ zoom }),
  setDevtools: (devtools) => set({ devtools }),
  setSummary: (s) => set((st) => ({ summaries: { ...st.summaries, [s.path]: s } })),
  setBatch: (p) => set((st) => ({ batch: { ...st.batch, [p.path]: p } })),
  clearBatch: () => set({ batch: {}, signInDismissed: false }),
  signInDismissed: false,
  dismissSignIn: () => set({ signInDismissed: true }),
  signingIn: false,
  setSigningIn: (signingIn) => set({ signingIn }),
  setRepoBusy: (path, op) =>
    set((st) => {
      const busy = { ...st.busy }
      if (op) busy[path] = op
      else delete busy[path]
      // Any later write makes the recorded reset stale: undoing it would throw that write away.
      if (!op || !st.resets[path]) return { busy }
      const resets = { ...st.resets }
      delete resets[path]
      return { busy, resets }
    }),
  setAllBusy: (busy) => set({ busy }),
  hookRuns: {},
  hooksStarted: (path, op) => set((st) => ({ hookRuns: { ...st.hookRuns, [path]: { op, lines: [], failed: null } } })),
  hookOutput: (path, line) =>
    set((st) => {
      const run = st.hookRuns[path]
      if (!run || run.failed) return {}
      return { hookRuns: { ...st.hookRuns, [path]: { ...run, lines: [...run.lines, line].slice(-MAX_HOOK_LINES) } } }
    }),
  hookFailed: (path, error, retry) =>
    set((st) => {
      const run = st.hookRuns[path]
      // Without streamed lines (e.g. the hook printed nothing live), show git's output.
      const lines = run?.lines.length ? run.lines : (error.detail ?? '').split('\n').filter(Boolean)
      return { hookRuns: { ...st.hookRuns, [path]: { op: retry.kind, lines, failed: { error, retry } } } }
    }),
  clearHookRun: (path) =>
    set((st) => {
      if (!st.hookRuns[path]) return {}
      const hookRuns = { ...st.hookRuns }
      delete hookRuns[path]
      return { hookRuns }
    }),
  resets: {},
  setReset: (path, reset) =>
    set((st) => {
      const resets = { ...st.resets }
      if (reset) resets[path] = reset
      else delete resets[path]
      return { resets }
    }),
  commits: {},
  committed: (path) => set((st) => ({ commits: { ...st.commits, [path]: (st.commits[path] ?? 0) + 1 } })),
  toast: (kind, message, detail, error, action) => {
    const id = nextToast++
    set((st) => {
      // The same error again replaces the earlier copy instead of stacking up.
      const same = (t: Toast) => t.kind === kind && t.message === message && (t.detail ?? null) === (detail ?? null)
      const toasts = [...st.toasts.filter((t) => !same(t)), { id, kind, message, detail, error, action }]
      // Over the limit, drop the oldest info toast first: an unread error should outlast confirmations.
      while (toasts.length > MAX_TOASTS) {
        const i = toasts.findIndex((t) => t.kind === 'info')
        toasts.splice(i < 0 ? 0 : i, 1)
      }
      return { toasts }
    })
  },
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}))
