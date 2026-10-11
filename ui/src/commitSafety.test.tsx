import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { LastCommit, RepoStatus } from './types'

const PATH = 'C:/w/safety'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
const ask = vi.fn<(q: string, o?: unknown) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: unknown) => ask(q, o), open: vi.fn() }))

const status: RepoStatus = {
  branch: 'main',
  files: [{ path: 'src/a.ts', origPath: null, index: '.', worktree: 'M', untracked: false, conflicted: false }],
} as unknown as RepoStatus

let lastCommit: LastCommit | null = null

vi.mock('./api', () => ({
  api: {
    status: vi.fn(() => Promise.resolve(status)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    discard: vi.fn(() => Promise.resolve({ failed: [] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(lastCommit)),
    lastCommitMessage: vi.fn(() => Promise.resolve('Previous message')),
    commit: vi.fn(() => Promise.resolve('abcdef0123')),
    push: vi.fn(() => Promise.resolve()),
    cancelGeneration: vi.fn(),
    generateCommitMessage: vi.fn(() => Promise.resolve('x')),
  },
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e)),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { api } = await import('./api')
const { Changes } = await import('./components/Changes')
const { CommitBox } = await import('./components/CommitBox')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ busy: {}, summaries: {}, toasts: [] })
  lastCommit = null
})
afterEach(cleanup)

describe('commit & push', () => {
  it('says the commit succeeded when only the push fails', async () => {
    vi.mocked(api.push).mockRejectedValueOnce({ message: 'Push rejected' })
    wrap(<CommitBox path={PATH} stagedCount={1} branch="main" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix thing' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '& Push' })))
    await flush()
    const messages = useApp.getState().toasts.map((t) => t.message)
    expect(messages).toContain('Committed abcdef0, but the push failed')
    expect(messages).toContain('Push rejected')
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
})

describe('amend', () => {
  const amendWith = async () => {
    wrap(<CommitBox path={PATH} stagedCount={1} branch="main" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reworded' } })
    await flush()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Amend' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Amend last commit/ })))
    await flush()
  }

  it('asks first when the last commit cannot be undone because it is already pushed', async () => {
    lastCommit = null
    ask.mockResolvedValue(false)
    await amendWith()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatch(/already pushed/)
    expect(api.commit).not.toHaveBeenCalled()
  })

  it('amends after the user agrees', async () => {
    lastCommit = null
    ask.mockResolvedValue(true)
    await amendWith()
    expect(api.commit).toHaveBeenCalledWith(PATH, 'Reworded', true, false)
  })

  it('does not ask for an unpushed commit', async () => {
    lastCommit = { subject: 'Last', message: 'Last' }
    await amendWith()
    expect(ask).not.toHaveBeenCalled()
    expect(api.commit).toHaveBeenCalledWith(PATH, 'Reworded', true, false)
  })
})

describe('discard', () => {
  it('does nothing if the repo became busy while the confirmation was open', async () => {
    ask.mockImplementation(async () => {
      useApp.getState().setRepoBusy(PATH, 'pulling')
      return true
    })
    wrap(<Changes path={PATH} />)
    await screen.findByText('a.ts')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Discard all' })))
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(api.discard).not.toHaveBeenCalled()
  })
})

describe('shortcuts', () => {
  it('Ctrl+Shift+Enter commits and pushes', async () => {
    wrap(<CommitBox path={PATH} stagedCount={1} branch="main" />)
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'Fix thing' } })
    await act(async () => fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, shiftKey: true }))
    await flush()
    expect(api.commit).toHaveBeenCalled()
    expect(api.push).toHaveBeenCalledWith(PATH)
  })

  it('placeholder mentions both commit shortcuts', () => {
    wrap(<CommitBox path={PATH} stagedCount={1} branch="main" />)
    expect(screen.getByRole('textbox').getAttribute('placeholder')).toMatch(/Ctrl\+Enter.*Ctrl\+Shift\+Enter/)
  })

  it('Ctrl+G does nothing when nothing is staged', async () => {
    wrap(<CommitBox path={PATH} stagedCount={0} branch="main" />)
    await act(async () => fireEvent.keyDown(window, { key: 'g', ctrlKey: true }))
    expect(api.generateCommitMessage).not.toHaveBeenCalled()
  })
})
