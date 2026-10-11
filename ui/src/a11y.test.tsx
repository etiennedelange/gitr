import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useApp } from './store'
import type { Config, RepoSummary } from './types'

const PATH = 'D:/w/alpha'
vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn() }))
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))
const config = { groups: [{ id: 'g', name: 'Work', roots: ['D:/w'] }], zoom: 100 } as unknown as Config
vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve([{ path: 'D:/w/alpha', name: 'alpha', groupId: 'g' }])),
    repoSummary: vi.fn(() => Promise.resolve({})),
    status: vi.fn(() => Promise.resolve({ branch: 'main', files: [] })),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    branches: vi.fn(() => Promise.resolve([])),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
    openRemote: vi.fn(),
    openWith: vi.fn(),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { Sidebar } = await import('./components/Sidebar')
const { RepoView } = await import('./components/RepoView')
const { DiffView } = await import('./components/DiffView')

const summary: RepoSummary = {
  path: PATH,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 1,
  behind: 2,
  staged: 0,
  unstaged: 3,
  conflicted: 0,
  remote: null,
  error: null,
  operation: null,
}
const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

beforeEach(() => useApp.setState({ summaries: { [PATH]: summary }, busy: {}, toasts: [], view: { kind: 'dashboard' } }))
afterEach(cleanup)

describe('sidebar', () => {
  it('announces whether a group is expanded', async () => {
    wrap(<Sidebar />)
    const head = await screen.findByRole('button', { name: /Work/ })
    expect(head).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
  })

  it('spells out the repo badges in text for screen readers', async () => {
    wrap(<Sidebar />)
    await screen.findByText('alpha')
    expect(screen.getByText('3 uncommitted')).toBeInTheDocument()
    expect(screen.getByText('2 behind')).toBeInTheDocument()
    expect(screen.getByText('1 ahead')).toBeInTheDocument()
  })
})

describe('repo tabs', () => {
  it('link to their panel and move with the arrow keys', async () => {
    wrap(<RepoView path={PATH} />)
    const changes = await screen.findByRole('tab', { name: /Changes/ })
    const history = screen.getByRole('tab', { name: 'History' })
    const branches = screen.getByRole('tab', { name: 'Branches' })
    const panel = screen.getByRole('tabpanel')
    expect(changes).toHaveAttribute('aria-controls', panel.id)
    expect(changes.tabIndex).toBe(0)
    expect(history.tabIndex).toBe(-1)
    expect(branches.tabIndex).toBe(-1)
    fireEvent.keyDown(changes, { key: 'ArrowRight' })
    expect(history).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(history)
    fireEvent.keyDown(history, { key: 'ArrowLeft' })
    expect(changes).toHaveAttribute('aria-selected', 'true')
    // The order wraps: left of Changes is Branches.
    fireEvent.keyDown(changes, { key: 'ArrowLeft' })
    expect(branches).toHaveAttribute('aria-selected', 'true')
  })
})

describe('diff', () => {
  it('can be focused so it scrolls with the keyboard', async () => {
    wrap(<DiffView repo={PATH} source={{ kind: 'worktree', path: 'a.ts', origPath: null, staged: false, untracked: false }} />)
    const body = await screen.findByLabelText('Diff of a.ts')
    expect(body.tabIndex).toBe(0)
  })
})
