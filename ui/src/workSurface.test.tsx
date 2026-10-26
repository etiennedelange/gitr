import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { useLayout } from './layout'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp, initialDashboard } from './store'
import type { Config, RepoStatus, RepoSummary } from './types'

// The fixes from the 2026-10-03 design critique: split diff, conflicts, keyboard paths, first run
// and the dashboard's order while batch results are shown.

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 34,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, key: i, size: 34, start: i * 34 })),
    scrollToIndex: () => {},
  }),
}))
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn(() => Promise.resolve()) }))

const A = 'D:/w/alpha'
const B = 'D:/w/beta'
const Z = 'D:/p/zeta'
let config: Config
let repos = [
  { path: A, name: 'alpha', groupId: 'g1' },
  { path: B, name: 'beta', groupId: 'g1' },
  { path: Z, name: 'zeta', groupId: 'g2' },
]
const file = (path: string, extra: object = {}) => ({
  path,
  origPath: null,
  index: '.',
  worktree: 'M',
  untracked: false,
  conflicted: false,
  ...extra,
})
let files = [file('a.ts')]
const hunk = {
  header: '@@ -1,2 +1,2 @@',
  lines: [
    { kind: 'remove', text: 'x'.repeat(400), oldNo: 1, newNo: null },
    { kind: 'add', text: 'y', oldNo: null, newNo: 1 },
  ],
}

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve(repos)),
    status: vi.fn(() => Promise.resolve({ branch: 'main', files } as unknown as RepoStatus)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [hunk] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
    repoSummary: vi.fn(() => Promise.resolve({})),
    refreshAll: vi.fn(() => Promise.resolve()),
    rescanRepos: vi.fn(() => Promise.resolve(repos)),
    busyRepos: vi.fn(() => Promise.resolve([])),
    devtoolsAvailable: vi.fn(() => Promise.resolve(false)),
    gitInfo: vi.fn(() => Promise.resolve({ path: 'git', version: '2.50', problem: null, settingIgnored: false })),
    listModels: vi.fn(() => Promise.resolve([])),
    saveConfig: vi.fn(() => Promise.resolve()),
    stage: vi.fn(() => Promise.resolve()),
    openWith: vi.fn(() => Promise.resolve()),
    runBatch: vi.fn(() => Promise.resolve([])),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { Sidebar } = await import('./components/Sidebar')
const { Dashboard } = await import('./components/Dashboard')
const { Changes } = await import('./components/Changes')
const { DiffView } = await import('./components/DiffView')
const { Settings } = await import('./components/Settings')
const { default: App } = await import('./App')
const { cyclePane } = await import('./lib/panes')
const { rankRepos } = await import('./lib/git')
const { api } = await import('./api')
const dialog = await import('@tauri-apps/plugin-dialog')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const sum = (path: string, extra: Partial<RepoSummary> = {}): RepoSummary => ({
  path,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  conflicted: 0,
  remote: null,
  error: null,
  operation: null,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  config = {
    groups: [
      { id: 'g1', name: 'Work', roots: ['D:/w'] },
      { id: 'g2', name: 'Play', roots: ['D:/p'] },
    ],
    zoom: 100,
    excludes: [],
  } as unknown as Config
  files = [file('a.ts')]
  try {
    localStorage.setItem('diffMode', 'unified')
  } catch {
    // jsdom without storage: unified is the default anyway
  }
  useApp.setState({
    summaries: { [A]: sum(A), [B]: sum(B), [Z]: sum(Z) },
    batch: {},
    busy: {},
    toasts: [],
    settingsDraft: null,
    view: { kind: 'dashboard' },
    dashboard: { ...initialDashboard },
  })
})
afterEach(cleanup)

// These tests read the ledger table; the cards have their own tests.
beforeEach(() => useLayout.setState({ dashboardView: 'table' }))
describe('split diff', () => {
  it('gives both sides fixed columns, so a long line cannot take the other side’s room', async () => {
    localStorage.setItem('diffMode', 'split')
    wrap(<DiffView repo={A} source={{ kind: 'worktree', path: 'a.ts', origPath: null, staged: false, untracked: false }} />)
    const table = (await screen.findByText('y')).closest('table') as HTMLTableElement
    expect(table).toHaveClass('split')
    const cols = table.querySelectorAll('colgroup > col')
    expect(cols).toHaveLength(4)
    expect(cols[0]).toHaveClass('ln-col')
    expect(cols[2]).toHaveClass('ln-col')
  })
})

describe('conflicts', () => {
  it('lead the list, open first, say what to do, and Mark resolved stages the file', async () => {
    files = [file('a.ts'), file('both.ts', { conflicted: true, index: 'U', worktree: 'U' })]
    wrap(<Changes path={A} />)
    await screen.findByText(/both\.ts has conflicts/)
    const list = screen.getByRole('list', { name: 'Unstaged files' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('both.ts')
    expect(within(rows[0]).getByTitle('Conflicted')).toHaveTextContent('U')
    expect(rows[0]).toHaveClass('active')
    expect(screen.getByText(/both\.ts has conflicts\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Mark resolved/ }))
    await flush()
    expect(api.stage).toHaveBeenCalledWith(A, ['both.ts'])
  })

  it('show untracked files with git’s ?, not U', async () => {
    files = [file('new.ts', { untracked: true, worktree: '?' })]
    wrap(<Changes path={A} />)
    await screen.findByText('new.ts')
    const list = screen.getByRole('list', { name: 'Unstaged files' })
    expect(within(list).getByTitle('Untracked')).toHaveTextContent('?')
  })
})

describe('sidebar keyboard', () => {
  it('is one Tab stop; arrow keys move through groups and repos, Left folds a group', async () => {
    wrap(<Sidebar />)
    await screen.findByText('alpha')
    const tree = document.querySelector('.tree') as HTMLElement
    const stops = Array.from(tree.querySelectorAll('button')).filter((b) => b.tabIndex === 0)
    expect(stops).toHaveLength(1)
    stops[0].focus()
    expect(document.activeElement).toHaveTextContent('Work')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toHaveTextContent('alpha')
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toHaveTextContent('zeta')
    // The Tab stop follows focus, so Tab back into the tree returns here.
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toHaveTextContent('Play')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.queryByText('zeta')).toBeNull()
  })
})

describe('F6', () => {
  it('cycles focus through the panes in order, and back with Shift', () => {
    document.body.innerHTML = `
      <div data-pane><button tabindex="-1">a</button><button tabindex="0">rail</button></div>
      <ul data-pane tabindex="0" id="list"></ul>
      <textarea data-pane id="msg"></textarea>`
    cyclePane(document, false)
    expect(document.activeElement).toHaveTextContent('rail')
    cyclePane(document, false)
    expect(document.activeElement?.id).toBe('list')
    cyclePane(document, false)
    expect(document.activeElement?.id).toBe('msg')
    cyclePane(document, false)
    expect(document.activeElement).toHaveTextContent('rail')
    cyclePane(document, true)
    expect(document.activeElement?.id).toBe('msg')
    document.body.innerHTML = ''
  })
})

describe('Ctrl+P', () => {
  it('ranks names that start with the query first', () => {
    const r = [
      { path: '1', name: 'billing', groupId: 'g' },
      { path: '2', name: 'app-billing', groupId: 'g' },
      { path: '3', name: 'notes', groupId: 'g' },
    ]
    expect(rankRepos(r, 'bill').map((x) => x.name)).toEqual(['billing', 'app-billing'])
    expect(rankRepos(r, '').map((x) => x.name)).toEqual(['app-billing', 'billing', 'notes'])
  })

  it('opens a repo by typing part of its name and Enter', async () => {
    wrap(<App />)
    await screen.findAllByText('alpha')
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true })
    const box = await screen.findByPlaceholderText('Go to repository…')
    expect(box.getAttribute('aria-label')).toBe('Go to repository')
    fireEvent.change(box, { target: { value: 'zet' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(useApp.getState().view).toEqual({ kind: 'repo', path: Z })
    expect(screen.queryByPlaceholderText('Go to repository…')).toBeNull()
  })
})

describe('dashboard', () => {
  it('shows the rail’s chips and plain words for batch results', async () => {
    useApp.setState({
      summaries: { [A]: sum(A, { behind: 2, ahead: 1, unstaged: 3 }), [B]: sum(B), [Z]: sum(Z) },
      batch: { [B]: { path: B, op: 'pull', state: 'ok', message: 'Up to date' } },
    })
    wrap(<Dashboard />)
    await screen.findByText('alpha')
    const row = screen.getByTitle(A).closest('.row') as HTMLElement
    expect(within(row).getByText('2 behind')).toBeInTheDocument()
    expect(within(row).getByText('1 ahead')).toBeInTheDocument()
    expect(within(row).getByText('3 uncommitted')).toBeInTheDocument()
    const beta = screen.getByTitle(B).closest('.row') as HTMLElement
    expect(within(beta).getByText('Up to date')).toBeInTheDocument()
    expect(within(beta).queryByText(/pull ok/)).toBeNull()
  })

  it('keeps rows in place while Fetch all / Pull all results are shown', async () => {
    useApp.setState({
      summaries: { [A]: sum(A), [B]: sum(B, { unstaged: 2 }), [Z]: sum(Z) },
      batch: { [B]: { path: B, op: 'pull', state: 'running', message: null } },
    })
    wrap(<Dashboard />)
    await screen.findByText('alpha')
    const order = () => Array.from(document.querySelectorAll('.table-body .row button.link')).map((b) => b.textContent)
    expect(order()).toEqual(['beta', 'alpha', 'zeta'])
    // The pull finishes and alpha now has an error: by status it would jump to the top.
    act(() =>
      useApp.setState({
        summaries: { [A]: sum(A, { error: 'boom' }), [B]: sum(B), [Z]: sum(Z) },
        batch: { [B]: { path: B, op: 'pull', state: 'ok', message: null } },
      }),
    )
    expect(order()).toEqual(['beta', 'alpha', 'zeta'])
    // Choosing a sort sorts again.
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } })
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'status' } })
    expect(order()).toEqual(['alpha', 'beta', 'zeta'])
  })

  it('says when everything is clean', async () => {
    wrap(<Dashboard />)
    expect(await screen.findByText('3 repositories, all clean and up to date')).toBeInTheDocument()
  })
})

describe('first run', () => {
  it('explains groups, and the first folder is saved without a Save step', async () => {
    config = { groups: [], zoom: 100, excludes: [], scanDepth: 3 } as unknown as Config
    vi.mocked(dialog.open).mockResolvedValueOnce('D:\\Repos')
    wrap(<Settings />)
    expect(await screen.findByText(/Each folder becomes a group in the sidebar/)).toBeInTheDocument()
    const choose = screen.getByRole('button', { name: 'Choose a folder…' })
    expect(choose).toHaveClass('primary')
    await act(async () => fireEvent.click(choose))
    await flush()
    expect(api.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ groups: [expect.objectContaining({ name: 'Repos', roots: ['D:\\Repos'] })] }),
    )
  })

  it('lists the shortcuts that exist, with all three tabs', async () => {
    wrap(<Settings />)
    expect(await screen.findByText('Next tab: Changes, History, Branches')).toBeInTheDocument()
    expect(screen.getByText('Go to a repository by name')).toBeInTheDocument()
    expect(screen.queryByText('Switch Changes / Branches')).toBeNull()
  })
})
