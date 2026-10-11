import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { Config, RepoStatus, RepoSummary } from './types'

const PATH = 'C:/w/repo'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(() => Promise.resolve(true)), open: vi.fn() }))
// jsdom has no layout: render every dashboard row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, key: i, size: 28, start: i * 28 })),
    measureElement: () => {},
  }),
}))

const config: Config = {
  groups: [{ id: 'g', name: 'Work', roots: ['C:/w'] }],
  scanDepth: 3,
  excludes: [],
  concurrency: 4,
  copilotModel: null,
  copilotCliPath: null,
  watch: true,
  zoom: 100,
  devtools: false,
  gitPath: null,
  divergedStrategy: 'rebase',
}
const status: RepoStatus = {
  branch: 'main',
  files: [
    { path: 'src/a.ts', origPath: null, index: '.', worktree: 'M', untracked: false, conflicted: false },
    { path: 'src/b.ts', origPath: null, index: 'M', worktree: '.', untracked: false, conflicted: false },
  ],
} as unknown as RepoStatus
const summary = {
  path: PATH,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 1,
  behind: 1,
  staged: 1,
  unstaged: 1,
  conflicted: 0,
  remote: null,
  error: null,
} as RepoSummary

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve([{ path: 'C:/w/repo', name: 'repo', groupId: 'g' }])),
    repoSummary: vi.fn(() => Promise.resolve(summary)),
    status: vi.fn(() => Promise.resolve(status)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    branches: vi.fn(() =>
      Promise.resolve([
        { name: 'main', remote: false, isHead: true, upstream: null, ahead: 0, behind: 0, gone: false, sha: 'a', committedAt: 0 },
        { name: 'feature', remote: false, isHead: false, upstream: null, ahead: 0, behind: 0, gone: false, sha: 'b', committedAt: 0 },
      ]),
    ),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    runBatch: vi.fn(() => Promise.resolve([])),
    push: vi.fn(() => Promise.resolve()),
    stage: vi.fn(() => Promise.resolve()),
    unstage: vi.fn(() => Promise.resolve()),
    discard: vi.fn(() => Promise.resolve()),
    commit: vi.fn(() => Promise.resolve('abcdef0123')),
    checkout: vi.fn(() => Promise.resolve()),
    createBranch: vi.fn(() => Promise.resolve()),
    busyRepos: vi.fn(() => Promise.resolve([])),
    divergence: vi.fn(() => Promise.resolve({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, strategy: 'rebase' })),
    openRemote: vi.fn(() => Promise.resolve('')),
    cancelOperation: vi.fn(() => Promise.resolve(true)),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? e : null),
}))

const { api } = await import('./api')
const { Dashboard } = await import('./components/Dashboard')
const { Sidebar } = await import('./components/Sidebar')
const { RepoView } = await import('./components/RepoView')
const { BUSY_DISPLAY_DELAY, notifyError } = await import('./hooks')
const { ask } = await import('@tauri-apps/plugin-dialog')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

const setBusy = (op: string | null) => act(() => useApp.getState().setRepoBusy(PATH, op))
const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))
const button = (name: RegExp | string) => screen.getByRole('button', { name })

describe('busy repositories', () => {
  beforeEach(() => {
    useApp.setState({ busy: {}, batch: {}, summaries: { [PATH]: summary }, toasts: [] })
    vi.clearAllMocks()
  })
  afterEach(cleanup)

  it('dashboard row shows the operation as a pill after the display delay, and clears when idle', async () => {
    wrap(<Dashboard />)
    const row = (await screen.findByRole('button', { name: 'repo' })).closest('.row') as HTMLElement
    setBusy('committing')
    expect(within(row).queryByText('committing…')).toBeNull()
    await sleep(BUSY_DISPLAY_DELAY + 50)
    expect(within(row).getByText('committing…')).toHaveClass('pill', 'running')
    setBusy(null)
    expect(within(row).queryByText('committing…')).toBeNull()
  })

  it('sidebar repo shows a busy indicator with the operation', async () => {
    wrap(<Sidebar />)
    const item = (await screen.findByText('repo')).closest('button') as HTMLElement
    expect(within(item).queryByRole('status')).toBeNull()
    setBusy('pulling')
    await sleep(BUSY_DISPLAY_DELAY + 50)
    expect(within(item).getByRole('status')).toHaveAttribute('title', 'pulling…')
  })

  it('repo view disables every write while busy and shows the operation', async () => {
    wrap(<RepoView path={PATH} />)
    await screen.findByText('a.ts', { selector: '.fname' })
    const textarea = document.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'msg' } })
    const writes = () => [
      button(/Fetch/),
      button(/Pull/),
      button(/^Push/),
      button(/^Commit/),
      button('& Push'),
      button('Stage all'),
      button('Unstage all'),
      button('Discard all'),
    ]
    writes().forEach((b) => expect(b).toBeEnabled())

    setBusy('committing')
    await sleep(BUSY_DISPLAY_DELAY + 50)
    expect(screen.getByRole('status')).toHaveTextContent('committing…')
    expect(button('Committing…')).toBeDisabled()
    writes().forEach((b) => expect(b).toBeDisabled())

    // Keyboard and double-click don't sneak a write in.
    const list = screen.getAllByRole('list')[0]
    fireEvent.click(screen.getByText('a.ts', { selector: '.fname' }))
    fireEvent.keyDown(list, { key: ' ' })
    fireEvent.doubleClick(screen.getByText('a.ts', { selector: '.fname' }))
    fireEvent.keyDown(list, { key: 'Delete' })
    await sleep(20)
    expect(api.stage).not.toHaveBeenCalled()
    expect(api.discard).not.toHaveBeenCalled()

    setBusy(null)
    writes().forEach((b) => expect(b).toBeEnabled())
  })

  it('branch checkout, create and delete are disabled while busy', async () => {
    wrap(<RepoView path={PATH} />)
    fireEvent.click(await screen.findByText(/Branches/))
    await screen.findByText('feature')
    fireEvent.change(screen.getByPlaceholderText('new-branch-name'), { target: { value: 'x' } })
    setBusy('checking out')
    await sleep(BUSY_DISPLAY_DELAY + 50)
    expect(button('Checkout')).toBeDisabled()
    expect(button('Delete')).toBeDisabled()
    expect(button('Create & checkout')).toBeDisabled()
    fireEvent.doubleClick(screen.getByText('feature'))
    await sleep(20)
    expect(api.checkout).not.toHaveBeenCalled()
  })

  it('repo view fetch and pull wait for a busy repo (interactive) instead of being skipped', async () => {
    wrap(<RepoView path={PATH} />)
    await screen.findByText('a.ts', { selector: '.fname' })
    await act(async () => fireEvent.click(button(/Fetch/)))
    await act(async () => fireEvent.click(button(/Pull/)))
    expect(api.runBatch).toHaveBeenCalledWith('fetch', [PATH], true)
    // Pull fetches and checks for divergence first (diverged-pull); fetch joins like Fetch.
    expect(api.divergence).toHaveBeenCalledWith(PATH)
  })

  it('repo view Stop asks before stopping a local write, then stops the repo', async () => {
    wrap(<RepoView path={PATH} />)
    await screen.findByText('a.ts', { selector: '.fname' })
    setBusy('committing')
    await sleep(BUSY_DISPLAY_DELAY + 50)
    vi.mocked(ask).mockResolvedValueOnce(false)
    await act(async () => fireEvent.click(button('Stop committing')))
    expect(ask).toHaveBeenCalledTimes(1)
    expect(api.cancelOperation).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(button('Stop committing')))
    expect(api.cancelOperation).toHaveBeenCalledWith(PATH)
  })

  it('dashboard Stop stops a fetch without asking and without selecting the row', async () => {
    wrap(<Dashboard />)
    const row = (await screen.findByRole('button', { name: 'repo' })).closest('.row') as HTMLElement
    setBusy('fetching')
    await sleep(BUSY_DISPLAY_DELAY + 50)
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: 'Stop fetching' })))
    expect(ask).not.toHaveBeenCalled()
    expect(api.cancelOperation).toHaveBeenCalledWith(PATH)
    expect(row).not.toHaveClass('cursor')
    setBusy(null)
    expect(within(row).queryByRole('button', { name: /Stop/ })).toBeNull()
  })

  it('a stopped operation is reported as information, not as an error', () => {
    notifyError({ message: 'Stopped committing.', detail: null, kind: 'cancelled', repo: PATH, lockPath: null })
    expect(useApp.getState().toasts).toMatchObject([{ kind: 'info', message: 'Stopped committing.' }])
  })
})
