import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { FileEntry, Operation, RepoStatus, RepoSummary } from './types'

const PATH = 'D:/Repos/work/api'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
const ask = vi.fn<(q: string, o?: { okLabel?: string; title?: string }) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: { okLabel?: string }) => ask(q, o), open: vi.fn() }))
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn(() => Promise.resolve()) }))

const summary = (s: Partial<RepoSummary> = {}): RepoSummary => ({
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
  ...s,
})
const file = (path: string, f: Partial<FileEntry> = {}): FileEntry => ({
  path,
  origPath: null,
  index: '.',
  worktree: 'M',
  untracked: false,
  conflicted: false,
  ...f,
})
let files: FileEntry[] = []

vi.mock('./api', () => ({
  api: {
    listRepos: vi.fn(() => Promise.resolve([{ path: 'D:/Repos/work/api', name: 'api', groupId: 'g' }])),
    repoSummary: vi.fn(() => Promise.resolve(useApp.getState().summaries['D:/Repos/work/api'])),
    status: vi.fn(() => Promise.resolve({ branch: 'main', files } as unknown as RepoStatus)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
    mergeMessage: vi.fn(() => Promise.resolve(null)),
    busyRepos: vi.fn(() => Promise.resolve([])),
    listModels: vi.fn(() => Promise.resolve([])),
    getConfig: vi.fn(() => Promise.resolve({ copilotModel: null })),
    continueOperation: vi.fn(() => Promise.resolve({ kind: 'done' })),
    abortOperation: vi.fn(() => Promise.resolve()),
    skipOperation: vi.fn(() => Promise.resolve({ kind: 'done' })),
    openWith: vi.fn(() => Promise.resolve()),
  },
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e)),
  errorDetail: () => null,
  asCmdError: (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? e : null),
}))

const { api } = await import('./api')
const { RepoView } = await import('./components/RepoView')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const lastToast = () => useApp.getState().toasts.at(-1)?.message
const withOperation = (operation: Operation, s: Partial<RepoSummary> = {}) =>
  useApp.setState({ summaries: { [PATH]: summary({ operation, ...s }) } })

beforeEach(() => {
  vi.clearAllMocks()
  files = []
  useApp.setState({ toasts: [], busy: {}, summaries: { [PATH]: summary() } })
})
afterEach(cleanup)

describe('Changes tab count', () => {
  it('counts the files the Changes list shows, not the summary (an untracked folder counts once there)', async () => {
    files = [
      file('build/a.o', { untracked: true, worktree: '?' }),
      file('build/b.o', { untracked: true, worktree: '?' }),
      file('build/c.o', { untracked: true, worktree: '?' }),
      file('src/x.ts', { index: 'M', worktree: 'M' }),
      file('c.txt', { index: 'U', worktree: 'U', conflicted: true }),
    ]
    // The summary would say 1 untracked folder + 1 staged + 2 unstaged + 1 conflicted.
    useApp.setState({ summaries: { [PATH]: summary({ staged: 1, unstaged: 3, conflicted: 1 }) } })
    wrap(<RepoView path={PATH} />)
    const tab = await screen.findByRole('tab', { name: /Changes/ })
    // x.ts is in both lists; the conflict is listed once.
    await vi.waitFor(() => expect(tab.textContent).toBe('Changes 6'))
  })
})

describe('operation banner', () => {
  const button = (name: string | RegExp) => screen.queryByRole('button', { name })

  it('bisect: no Continue, Skip or conflict count; End bisect asks, then ends it', async () => {
    withOperation('bisecting')
    wrap(<RepoView path={PATH} />)
    expect(await screen.findByText('Bisect in progress')).toBeTruthy()
    expect(button('Continue')).toBeNull()
    expect(button('Skip')).toBeNull()
    expect(screen.queryByText(/conflicted file/)).toBeNull()
    expect(screen.getByRole('note').textContent).toBe('Mark commits in a terminal: git bisect good or git bisect bad')

    ask.mockResolvedValueOnce(false)
    await act(async () => fireEvent.click(button('End bisect')!))
    expect(ask.mock.calls[0][0]).toMatch(/^End the bisect\?/)
    expect(api.abortOperation).not.toHaveBeenCalled()

    ask.mockResolvedValueOnce(true)
    await act(async () => fireEvent.click(button('End bisect')!))
    await flush()
    expect(api.abortOperation).toHaveBeenCalledWith(PATH)
    expect(lastToast()).toBe('Bisect ended')
  })

  it('git am: titled as applying patches, with Continue, Skip and Abort', async () => {
    withOperation('applying-patches')
    wrap(<RepoView path={PATH} />)
    expect(await screen.findByText('Applying patches (git am)')).toBeTruthy()
    expect(button('Continue')).toBeTruthy()
    expect(button('Skip')).toBeTruthy()
    expect(button('Abort')).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('git am --continue')
  })

  it('a merge has no Skip', async () => {
    withOperation('merging', { conflicted: 1 })
    wrap(<RepoView path={PATH} />)
    expect(await screen.findByText('Merge in progress')).toBeTruthy()
    expect(button('Skip')).toBeNull()
  })

  it('Skip during a rebase says what is lost, and runs only after Yes', async () => {
    withOperation('rebasing', { conflicted: 1 })
    wrap(<RepoView path={PATH} />)
    const skip = await screen.findByRole('button', { name: 'Skip' })

    ask.mockResolvedValueOnce(false)
    await act(async () => fireEvent.click(skip))
    const [question, options] = ask.mock.calls[0]
    expect(question).toBe(
      'Skip the commit the rebase stopped on? Its changes are left out, and so are any edits you made to resolve its conflicts. ' +
        'The rebase then goes on with the rest.',
    )
    expect(options).toMatchObject({ title: 'Skip commit', okLabel: 'Skip commit' })
    expect(api.skipOperation).not.toHaveBeenCalled()

    ask.mockResolvedValueOnce(true)
    vi.mocked(api.skipOperation).mockResolvedValueOnce({ kind: 'conflicts', files: 2 })
    await act(async () => fireEvent.click(skip))
    await flush()
    expect(api.skipOperation).toHaveBeenCalledWith(PATH)
    expect(lastToast()).toBe('Stopped on conflicts in 2 files. Resolve them, then Continue, or Abort.')
  })

  it('Skip on a cherry-pick that finishes reports it', async () => {
    withOperation('cherry-picking', { conflicted: 1 })
    wrap(<RepoView path={PATH} />)
    ask.mockResolvedValueOnce(true)
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Skip' })))
    await flush()
    expect(ask.mock.calls[0][0]).toMatch(/^Skip the commit the cherry-pick stopped on\?/)
    expect(lastToast()).toBe('Cherry-pick finished')
  })
})
