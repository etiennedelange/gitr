import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { DiscardOutcome, LastCommit, RepoStatus } from './types'

const PATH = 'C:/w/repo'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
const ask = vi.fn<(q: string, o?: unknown) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: unknown) => ask(q, o), open: vi.fn() }))

const status: RepoStatus = {
  branch: 'main',
  files: [
    { path: 'src/a.ts', origPath: null, index: '.', worktree: 'M', untracked: false, conflicted: false },
    { path: 'notes.txt', origPath: null, index: '.', worktree: '.', untracked: true, conflicted: false },
  ],
} as unknown as RepoStatus

let lastCommit: LastCommit | null = null
let outcome: DiscardOutcome = { failed: [] }

vi.mock('./api', () => ({
  api: {
    status: vi.fn(() => Promise.resolve(status)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    stage: vi.fn(() => Promise.resolve()),
    unstage: vi.fn(() => Promise.resolve()),
    discard: vi.fn((_p: string, _t: string[], _u: string[], permanent?: boolean) => Promise.resolve(permanent ? { failed: [] } : outcome)),
    lastCommitUndo: vi.fn(() => Promise.resolve(lastCommit)),
    undoLastCommit: vi.fn(() => Promise.resolve('Add things\n\nWith a body.')),
    commit: vi.fn(() => Promise.resolve('abcdef0')),
    generateCommitMessage: vi.fn(() => Promise.resolve('Generated message')),
    cancelGeneration: vi.fn(() => Promise.resolve()),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { api } = await import('./api')
const { Changes } = await import('./components/Changes')
const { CommitBox } = await import('./components/CommitBox')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))

describe('recoverable discard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useApp.setState({ busy: {}, toasts: [] })
    lastCommit = null
    outcome = { failed: [] }
  })
  afterEach(cleanup)

  it('asks with Recycle Bin wording (fact 9)', async () => {
    ask.mockResolvedValue(false)
    wrap(<Changes path={PATH} />)
    await screen.findByText('a.ts')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discard all' })))
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toBe('Discard changes to 2 files? The current version goes to the Recycle Bin.')
    expect(ask.mock.calls[0][0]).not.toMatch(/cannot be undone/)
    expect(api.discard).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(screen.getAllByTitle('Discard')[0]))
    expect(ask.mock.calls[1][0]).toBe('Discard changes to src/a.ts? The current version goes to the Recycle Bin.')
  })

  it('discards via the Recycle Bin and asks nothing more when every file moved', async () => {
    ask.mockResolvedValue(true)
    wrap(<Changes path={PATH} />)
    await screen.findByText('a.ts')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discard all' })))
    await flush()
    expect(api.discard).toHaveBeenCalledTimes(1)
    expect(api.discard).toHaveBeenCalledWith(PATH, ['src/a.ts'], ['notes.txt'])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks before discarding refused files permanently; Yes discards only those (fact 7)', async () => {
    outcome = { failed: [{ path: 'notes.txt', untracked: true, reason: 'Z: is a network drive, which has no Recycle Bin' }] }
    ask.mockResolvedValue(true)
    wrap(<Changes path={PATH} />)
    await screen.findByText('a.ts')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discard all' })))
    await flush()
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1][0]).toBe(
      "Couldn't move 1 file to the Recycle Bin: Z: is a network drive, which has no Recycle Bin. Discard it permanently?",
    )
    expect(api.discard).toHaveBeenLastCalledWith(PATH, [], ['notes.txt'], true)
  })

  it('No leaves refused files untouched (facts 7, 8)', async () => {
    outcome = {
      failed: [
        { path: 'src/a.ts', untracked: false, reason: 'in use' },
        { path: 'notes.txt', untracked: true, reason: 'in use' },
      ],
    }
    ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    wrap(<Changes path={PATH} />)
    await screen.findByText('a.ts')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discard all' })))
    await flush()
    expect(ask.mock.calls[1][0]).toBe("Couldn't move 2 files to the Recycle Bin: in use. Discard them permanently?")
    expect(api.discard).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.discard).mock.calls.some((c) => c[3] === true)).toBe(false)
  })
})

describe('undo last commit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useApp.setState({ busy: {}, toasts: [] })
    outcome = { failed: [] }
  })

  afterEach(cleanup)

  it('is hidden when the last commit cannot be undone (fact 10)', async () => {
    lastCommit = null
    wrap(<Changes path={PATH} />)
    await screen.findByText('a.ts')
    await flush()
    expect(screen.queryByRole('button', { name: /Undo last commit/ })).toBeNull()
  })

  it('shows the subject as tooltip, undoes without asking and restores the message (facts 10–12, 14)', async () => {
    lastCommit = { subject: 'Add things', message: 'Add things\n\nWith a body.' }
    wrap(<Changes path={PATH} />)
    const button = await screen.findByRole('button', { name: /Undo last commit/ })
    expect(button.getAttribute('title')).toContain('Add things')
    await act(async () => fireEvent.click(button))
    await flush()
    expect(api.undoLastCommit).toHaveBeenCalledWith(PATH)
    expect(ask).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')!.value).toBe('Add things\n\nWith a body.')
    expect(useApp.getState().toasts.at(-1)?.message).toBe('Undid commit “Add things”')
  })

  it('keeps a draft typed in the box instead of overwriting it', async () => {
    lastCommit = { subject: 'Add things', message: 'Add things' }
    wrap(<Changes path={PATH} />)
    const button = await screen.findByRole('button', { name: /Undo last commit/ })
    const box = document.querySelector('textarea')!
    fireEvent.change(box, { target: { value: 'my new draft' } })
    await act(async () => fireEvent.click(button))
    await flush()
    expect(box.value).toBe('my new draft')
  })

  it('is disabled while the repo is busy (fact 16)', async () => {
    lastCommit = { subject: 'Add things', message: 'Add things' }
    wrap(<Changes path={PATH} />)
    const button = await screen.findByRole('button', { name: /Undo last commit/ })
    act(() => useApp.getState().setRepoBusy(PATH, 'undoing commit'))
    await act(() => new Promise((r) => setTimeout(r, 300)))
    expect(button).toBeDisabled()
  })
})

describe('commit message generation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useApp.setState({ busy: {}, summaries: {}, toasts: [] })
  })
  afterEach(cleanup)

  it.each(['generation failed', 'Cancelled'])('preserves the draft when %s', async (reason) => {
    vi.mocked(api.generateCommitMessage).mockRejectedValueOnce(reason)
    wrap(<CommitBox path={PATH} stagedCount={1} branch="main" />)
    const draft = screen.getByRole('textbox')
    fireEvent.change(draft, { target: { value: 'My carefully written draft' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Generate' })))
    expect(draft).toHaveValue('My carefully written draft')
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
    if (reason !== 'Cancelled') expect(screen.getByText(reason)).toBeInTheDocument()
  })
})
