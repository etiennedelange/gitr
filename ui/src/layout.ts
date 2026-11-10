import { create } from 'zustand'

/** How changed files are listed: as a folder tree, or flat with each file's folder beside it. */
export type FileView = 'tree' | 'list'

/** How the dashboard shows repositories: the ledger table, compact cards or detailed cards. */
export type DashboardView = 'table' | 'compact' | 'detailed'
const DASHBOARD_VIEWS: DashboardView[] = ['table', 'compact', 'detailed']

/** Pane sizes the user dragged, in CSS pixels; absent means the pane's default. */
export interface PaneSizes {
  /** Width of the sidebar. */
  sidebar?: number
  /** Width of the Changes tab's file lists and commit box. */
  changesList?: number
  /** Share of the Unstaged and Staged lists' height that Unstaged gets, 0–1. */
  changesSplit?: number
  /** Width of the History tab's commit list. */
  historyList?: number
  /** Height of a commit's file list in the History tab. */
  historyFiles?: number
}

export type Pane = keyof PaneSizes

interface LayoutStore extends PaneSizes {
  fileView: FileView
  setFileView: (v: FileView) => void
  dashboardView: DashboardView
  setDashboardView: (v: DashboardView) => void
  /** `undefined` puts the pane back to its default size. */
  setPane: (pane: Pane, size: number | undefined) => void
}

const KEY = 'layout'
const PANES: Pane[] = ['sidebar', 'changesList', 'changesSplit', 'historyList', 'historyFiles']

/** The saved layout; anything missing or malformed falls back to the default. */
type Saved = PaneSizes & { fileView: FileView; dashboardView: DashboardView }

function load(): Saved {
  let saved: Record<string, unknown> = {}
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (v && typeof v === 'object') saved = v as Record<string, unknown>
  } catch {
    // Unreadable storage: start from the defaults.
  }
  const out: Saved = {
    fileView: saved.fileView === 'list' ? 'list' : 'tree',
    dashboardView: DASHBOARD_VIEWS.find((v) => v === saved.dashboardView) ?? 'compact',
  }
  for (const p of PANES) {
    const n = saved[p]
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[p] = n
  }
  return out
}

function save(s: LayoutStore) {
  const out: Record<string, unknown> = { fileView: s.fileView, dashboardView: s.dashboardView }
  for (const p of PANES) if (s[p] !== undefined) out[p] = s[p]
  try {
    localStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    // Storage can be unavailable; the layout then lasts until the app closes.
  }
}

export const useLayout = create<LayoutStore>((set) => ({
  ...load(),
  setFileView: (fileView) => set({ fileView }),
  setDashboardView: (dashboardView) => set({ dashboardView }),
  setPane: (pane, size) => set({ [pane]: size }),
}))
useLayout.subscribe(save)

/** Reads the saved layout again (tests, after changing storage). */
export function reloadLayout() {
  const fresh = load()
  useLayout.setState({ ...Object.fromEntries(PANES.map((p) => [p, undefined])), ...fresh })
}
