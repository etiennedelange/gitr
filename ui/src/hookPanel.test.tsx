import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { CmdError } from './types'

const PATH = 'C:/w/hooks'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
const ask = vi.fn<(q: string, o?: unknown) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: unknown) => ask(q, o), open: vi.fn() }))

vi.mock('./api', () => ({
  api: {
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
    commit: vi.fn(() => Promise.resolve('abcdef0123')),
    push: vi.fn(() => Promise.resolve()),
    openWith: vi.fn(() => Promise.resolve()),
    cancelGeneration: vi.fn(),
  },
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e)),
  errorDetail: () => null,
  asCmdError: (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? e : null),
}))

const { api } = await import('./api')
const { CommitBox } = await import('./components/CommitBox')
const { HookPanel } = await import('./components/HookPanel')
const { runPush } = await import('./lib/send')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const hookError = (hook: string, op: string): CmdError => ({
  message: `The ${hook} hook rejected the ${op}.`,
  detail: 'lint failed: 3 problems',
  kind: 'hook',
  repo: PATH,
  lockPath: null,
  hook,
})
const repoView = () =>
  wrap(
    <>
      <HookPanel path={PATH} />
      <CommitBox path={PATH} stagedCount={1} branch="main" />
    </>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  ask.mockResolvedValue(true)
  useApp.setState({ busy: {}, summaries: {}, toasts: [], hookRuns: {}, commits: {} })
})
afterEach(cleanup)

describe('hook panel', () => {
  it('shows hook output live while the hooks run', () => {
    repoView()
    expect(screen.queryByLabelText('Hook output')).toBeNull()
    act(() => {
      useApp.getState().hooksStarted(PATH, 'commit')
      useApp.getState().hookOutput(PATH, 'eslint: checking 12 files')
      useApp.getState().hookOutput(PATH, 'src/a.ts: 1 problem')
    })
    expect(screen.getByRole('status')).toHaveTextContent('Running commit hooks…')
    expect(screen.getByText(/eslint: checking 12 files\s+src\/a.ts: 1 problem/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Commit without hooks' })).toBeNull()
  })

  it('a rejected commit names the hook, keeps the message, and can be committed without hooks', async () => {
    vi.mocked(api.commit).mockRejectedValueOnce(hookError('pre-commit', 'commit'))
    repoView()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix thing' } })
    act(() => useApp.getState().hooksStarted(PATH, 'commit'))
    act(() => useApp.getState().hookOutput(PATH, 'lint failed: 3 problems'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Commit(?! and push)/ })))
    await flush()

    expect(screen.getByRole('alert')).toHaveTextContent('The pre-commit hook rejected the commit.')
    expect(screen.getByText('lint failed: 3 problems')).toBeInTheDocument()
    expect(useApp.getState().toasts).toEqual([])
    expect(screen.getByRole('textbox')).toHaveValue('Fix thing')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit without hooks' })))
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toContain('pre-commit')
    expect(api.commit).toHaveBeenLastCalledWith(PATH, 'Fix thing', false, true)
    expect(screen.queryByLabelText('Hook output')).toBeNull()
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Committed abcdef0 without hooks'])
  })

  it('does nothing when the user declines to skip hooks', async () => {
    vi.mocked(api.commit).mockRejectedValueOnce(hookError('commit-msg', 'commit'))
    ask.mockResolvedValueOnce(false)
    repoView()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wip' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Commit(?! and push)/ })))
    await flush()
    // No live output arrived: git's output is shown instead.
    expect(screen.getByText('lint failed: 3 problems')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Commit without hooks' })))
    await flush()
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('The commit-msg hook rejected the commit.')
  })

  it('a push rejected by pre-push can be pushed without hooks', async () => {
    vi.mocked(api.push).mockRejectedValueOnce(hookError('pre-push', 'push'))
    repoView()
    await act(async () => void (await runPush(PATH, 2)))
    expect(screen.getByRole('alert')).toHaveTextContent('The pre-push hook rejected the push.')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Push without hooks' })))
    await flush()
    expect(api.push).toHaveBeenLastCalledWith(PATH, true)
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Pushed without hooks'])
    expect(screen.queryByLabelText('Hook output')).toBeNull()
  })

  it('other failures stay toasts, and Dismiss closes the panel', async () => {
    vi.mocked(api.commit).mockRejectedValueOnce({
      message: 'Commit signing failed.',
      detail: null,
      kind: 'signing',
      repo: PATH,
      lockPath: null,
    })
    repoView()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } })
    act(() => useApp.getState().hooksStarted(PATH, 'commit'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Commit(?! and push)/ })))
    await flush()
    expect(screen.queryByLabelText('Hook output')).toBeNull()
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Commit signing failed.'])

    act(() => useApp.getState().hookFailed(PATH, hookError('pre-commit', 'commit'), { kind: 'push' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss hook output' }))
    expect(screen.queryByLabelText('Hook output')).toBeNull()
  })
})
