import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useApp } from './store'

const PATH = 'C:/w/repo'
vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn() }))
vi.mock('./api', () => ({
  api: {
    status: vi.fn(() => Promise.resolve({ branch: 'main', files: [] })),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
    branches: vi.fn(() => Promise.resolve([])),
    repoSummary: vi.fn(() => Promise.resolve({})),
    push: vi.fn(() => Promise.resolve()),
  },
  asCmdError: () => null,
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
}))
vi.mock('./hooks', async (orig) => ({
  ...(await orig<typeof import('./hooks')>()),
  useRepos: () => ({ data: [{ path: PATH, name: 'repo', groupId: 'g' }] }),
}))
const { RepoView } = await import('./components/RepoView')
const { api } = await import('./api')

const summary = (ahead: number) =>
  ({
    path: PATH,
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    ahead,
    behind: 0,
    staged: 0,
    unstaged: 0,
    conflicted: 0,
    operation: null,
    error: null,
    remote: null,
  }) as never

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RepoView path={PATH} />
    </QueryClientProvider>,
  )
}

describe('Push message', () => {
  afterEach(cleanup)

  it('does not claim to have pushed when nothing was ahead', async () => {
    useApp.setState({ toasts: [], summaries: { [PATH]: summary(0) }, busy: {} })
    renderView()
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Push/ })))
    await act(async () => {})
    expect(api.push).toHaveBeenCalled()
    expect(useApp.getState().toasts.at(-1)?.message).toBe('Nothing to push: already up to date')
  })

  it('says Pushed when commits were ahead', async () => {
    useApp.setState({ toasts: [], summaries: { [PATH]: summary(2) }, busy: {} })
    renderView()
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^Push/ })))
    await act(async () => {})
    expect(useApp.getState().toasts.at(-1)?.message).toBe('Pushed')
  })
})
