import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useApp } from './store'

const PATH = 'C:/w/br'
vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
const ask = vi.fn<(q: string, o?: unknown) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: unknown) => ask(q, o), open: vi.fn() }))
const branch = (name: string, extra = {}) => ({
  name,
  remote: false,
  isHead: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  sha: 'a',
  committedAt: 0,
  ...extra,
})
vi.mock('./api', () => ({
  api: {
    branches: vi.fn(() => Promise.resolve([branch('main', { isHead: true }), branch('feature', { ahead: 3 })])),
    deleteBranch: vi.fn(() => Promise.resolve()),
    createBranch: vi.fn(() => Promise.resolve()),
    checkout: vi.fn(() => Promise.resolve()),
    repoSummary: vi.fn(() => Promise.resolve({ path: 'C:/w/br', branch: 'main' })),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { api } = await import('./api')
const { Branches } = await import('./components/Branches')
const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Branches path={PATH} remote={null} />
    </QueryClientProvider>,
  )
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ busy: {}, summaries: {}, toasts: [] })
})
afterEach(cleanup)

describe('branches', () => {
  it('explains an invalid new branch name and blocks creating it', async () => {
    wrap()
    await screen.findByText('feature')
    fireEvent.change(screen.getByPlaceholderText('new-branch-name'), { target: { value: 'my branch' } })
    expect(screen.getByText(/space/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create/ })).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('new-branch-name'), { target: { value: 'my-branch' } })
    expect(screen.getByRole('button', { name: /Create/ })).toBeEnabled()
  })

  it('keeps Create enabled with no name, and says what is missing when pressed', async () => {
    wrap()
    await screen.findByText('feature')
    const create = screen.getByRole('button', { name: /Create/ })
    expect(create).toBeEnabled()
    fireEvent.click(create)
    expect(screen.getByRole('alert').textContent).toBe('Type a name for the new branch.')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New branch name' }))
    expect(api.createBranch).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'New branch name' }), { target: { value: 'x' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('labels the filter and new-name fields beyond their placeholders', async () => {
    wrap()
    await screen.findByText('feature')
    expect(screen.getByRole('textbox', { name: 'Filter branches' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'New branch name' })).toBeInTheDocument()
  })

  it('names the current branch for assistive technology', async () => {
    wrap()
    await screen.findByText('feature')
    expect(screen.getByLabelText('Current branch')).toBeInTheDocument()
  })

  it('warns about unpushed commits before deleting and refreshes the repo summary after', async () => {
    ask.mockResolvedValue(true)
    wrap()
    await screen.findByText('feature')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete' })))
    await flush()
    expect(ask.mock.calls[0][0]).toMatch(/3 commits not pushed/)
    expect(ask.mock.calls[0][1]).toMatchObject({ okLabel: 'Delete branch', cancelLabel: 'Cancel' })
    expect(api.deleteBranch).toHaveBeenCalled()
    expect(api.repoSummary).toHaveBeenCalledWith(PATH)
  })

  it('spells out what the Open and PR buttons do', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Branches path={PATH} remote={{ kind: 'github' } as never} />
      </QueryClientProvider>,
    )
    await screen.findAllByText('feature')
    expect(screen.getAllByRole('button', { name: 'Open' })[0].getAttribute('title')).toBe('Open in browser')
    expect(screen.getAllByRole('button', { name: 'PR' })[0].getAttribute('title')).toBe('Create pull request')
  })
})
