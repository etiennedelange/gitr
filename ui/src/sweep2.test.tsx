import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp, initialDashboard } from './store'
import { useLayout } from './layout'
import type { Config, RepoStatus, RepoSummary } from './types'

const PATH = 'D:/w/alpha'
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

const config = {
  groups: [
    { id: 'g1', name: 'Work', roots: ['D:/w'] },
    { id: 'g2', name: 'Play', roots: ['D:/p'] },
  ],
  zoom: 100,
} as unknown as Config
let repos = [
  { path: 'D:/w/alpha', name: 'alpha', groupId: 'g1' },
  { path: 'D:/p/zeta', name: 'zeta', groupId: 'g2' },
]
let statusImpl: () => Promise<RepoStatus> = () =>
  Promise.resolve({ branch: 'main', files: [file('a.ts'), file('b.ts')] } as unknown as RepoStatus)
const file = (path: string) => ({ path, origPath: null, index: '.', worktree: 'M', untracked: false, conflicted: false })

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve(repos)),
    status: vi.fn(() => statusImpl()),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
    lastCommitMessage: vi.fn(() => Promise.resolve('Previous message')),
    repoSummary: vi.fn(() => Promise.resolve({})),
    refreshAll: vi.fn(() => Promise.resolve()),
    rescanRepos: vi.fn(() => Promise.resolve(repos)),
    busyRepos: vi.fn(() => Promise.resolve([])),
    devtoolsAvailable: vi.fn(() => Promise.resolve(false)),
    gitInfo: vi.fn(() => Promise.resolve({ path: 'git', version: '2.50', problem: { kind: 'missing' }, settingIgnored: false })),
    runBatch: vi.fn(() => Promise.resolve([])),
    commit: vi.fn(),
    push: vi.fn(),
  },
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e)),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { open } = await import('@tauri-apps/plugin-dialog')
const { Sidebar } = await import('./components/Sidebar')
const { Dashboard } = await import('./components/Dashboard')
const { Changes } = await import('./components/Changes')
const { CommitBox } = await import('./components/CommitBox')
const { RepoView } = await import('./components/RepoView')
const { GitBanner } = await import('./components/GitBanner')
const { default: App } = await import('./App')
const { api } = await import('./api')
const { copyText } = await import('./nativeMenu')

const wrap = (ui: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const summary: RepoSummary = {
  path: PATH,
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
}

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ settingsDraft: null })
  repos = [
    { path: 'D:/w/alpha', name: 'alpha', groupId: 'g1' },
    { path: 'D:/p/zeta', name: 'zeta', groupId: 'g2' },
  ]
  statusImpl = () => Promise.resolve({ branch: 'main', files: [file('a.ts'), file('b.ts')] } as unknown as RepoStatus)
  useApp.setState({
    summaries: { [PATH]: summary },
    batch: {},
    busy: {},
    toasts: [],
    view: { kind: 'dashboard' },
    dashboard: { ...initialDashboard },
  })
})
afterEach(cleanup)

describe('sidebar filter', () => {
  it('hides groups with no match and opens collapsed groups that have one', async () => {
    wrap(<Sidebar />)
    await screen.findByText('alpha')
    fireEvent.click(screen.getByRole('button', { name: /Work/ })) // collapse Work
    expect(screen.queryByText('alpha')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Filter repositories…'), { target: { value: 'alp' } })
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Play/ })).toBeNull()
  })

  it('says when nothing matches', async () => {
    wrap(<Sidebar />)
    await screen.findByText('alpha')
    fireEvent.change(screen.getByPlaceholderText('Filter repositories…'), { target: { value: 'nope' } })
    expect(screen.getByText('No repositories match.')).toBeInTheDocument()
  })
})

describe('dashboard header', () => {
  it('does not claim Ctrl+Shift+F fetches only the shown repos', async () => {
    wrap(<Dashboard />)
    await screen.findByText('alpha')
    expect(screen.getByRole('button', { name: /Fetch all/ })).toHaveAttribute('title', 'Fetch all (Ctrl+Shift+F)')
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'alp' } })
    const shown = screen.getByRole('button', { name: /Fetch shown/ })
    expect(shown.getAttribute('title')).toMatch(/Ctrl\+Shift\+F fetches all/)
  })

  it('adds a folder right from the dashboard when there are no repositories yet', async () => {
    repos = []
    wrap(<Dashboard />)
    fireEvent.click(await screen.findByRole('button', { name: /Add a folder…/ }))
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true })))
  })
})

describe('app', () => {
  it('leaves a repo view whose repo no longer exists', async () => {
    useApp.setState({ view: { kind: 'repo', path: 'D:/gone/repo' } })
    wrap(<App />)
    await flush()
    await flush()
    expect(useApp.getState().view).toEqual({ kind: 'dashboard' })
  })
})

describe('changes', () => {
  it('shows why the status could not be read', async () => {
    statusImpl = () => Promise.reject({ message: 'fatal: not a git repository' })
    wrap(<Changes path={PATH} />)
    expect(await screen.findByText(/fatal: not a git repository/)).toBeInTheDocument()
  })

  it('opens each diff at the top instead of keeping the previous file’s scroll', async () => {
    wrap(<Changes path={PATH} />)
    fireEvent.click(await screen.findByText('a.ts'))
    const first = await screen.findByLabelText('Diff of a.ts')
    first.scrollTop = 300
    fireEvent.click(screen.getByText('b.ts'))
    const second = await screen.findByLabelText('Diff of b.ts')
    expect(second).not.toBe(first)
  })

  it('keeps leading dots of folder names in place in right-to-left clipped paths', async () => {
    statusImpl = () => Promise.resolve({ branch: 'main', files: [file('.github/workflows/ci.yml')] } as unknown as RepoStatus)
    // The list view shows each file's folder beside it.
    useLayout.setState({ fileView: 'list' })
    wrap(<Changes path={PATH} />)
    const dir = await screen.findByText(/workflows/)
    // <bdi> isolates the path from the right-to-left clipping so \u201c.github\u201d keeps its dot in front.
    expect(dir.tagName).toBe('BDI')
    useLayout.setState({ fileView: 'tree' })
  })
})

describe('commit box', () => {
  it('drops the previous message again when Amend is turned off untouched', async () => {
    wrap(<CommitBox path={PATH} stagedCount={1} branch="main" />)
    const amend = screen.getByRole('checkbox', { name: 'Amend' })
    fireEvent.click(amend)
    await flush()
    expect(screen.getByRole('textbox')).toHaveValue('Previous message')
    fireEvent.click(amend)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  it('keeps an edited message when Amend is turned off', async () => {
    wrap(<CommitBox path={PATH} stagedCount={1} branch="main" />)
    const amend = screen.getByRole('checkbox', { name: 'Amend' })
    fireEvent.click(amend)
    await flush()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Previous message, edited' } })
    fireEvent.click(amend)
    expect(screen.getByRole('textbox')).toHaveValue('Previous message, edited')
  })
})

describe('repo header', () => {
  it('explains why Push is disabled on a detached HEAD', async () => {
    useApp.setState({ summaries: { [PATH]: { ...summary, detached: true, branch: null } } })
    wrap(<RepoView path={PATH} />)
    const push = await screen.findByRole('button', { name: /^Push/ })
    expect(push).toBeDisabled()
    expect(push.getAttribute('title')).toMatch(/detached/i)
  })
})

describe('git banner', () => {
  it('confirms that the install command was copied', async () => {
    wrap(<GitBanner />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
    await flush()
    expect(copyText).toHaveBeenCalled()
    expect(useApp.getState().toasts.at(-1)?.message).toBe('Copied')
    expect(api.gitInfo).toHaveBeenCalled()
  })
})

describe('unsaved settings', () => {
  const cfg = (name: string) => ({ ...config, groups: [{ id: 'g1', name, roots: ['D:/w'] }] }) as Config

  it('flags Settings in the sidebar while edits are waiting', async () => {
    useApp.setState({ settingsDraft: { base: cfg('Work'), draft: cfg('Renamed') } })
    wrap(<Sidebar />)
    expect(await screen.findByText('Unsaved')).toBeInTheDocument()
  })

  it('does not flag it when the kept draft equals what is saved', async () => {
    useApp.setState({ settingsDraft: { base: cfg('Work'), draft: cfg('Work') } })
    wrap(<Sidebar />)
    await screen.findByText('alpha')
    expect(screen.queryByText('Unsaved')).toBeNull()
  })
})

describe('button hints', () => {
  it('explains Refresh and Rescan', async () => {
    wrap(<Dashboard />)
    await screen.findByText('alpha')
    expect(screen.getByRole('button', { name: /^Refresh/ }).getAttribute('title')).toMatch(/status/i)
    expect(screen.getByRole('button', { name: /^Rescan/ }).getAttribute('title')).toMatch(/folders/i)
  })
})
