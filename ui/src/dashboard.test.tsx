import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useApp, initialDashboard } from './store'
import type { Config, RepoSummary } from './types'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 34,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, key: i, size: 34, start: i * 34 })),
    scrollToIndex: () => {},
  }),
}))
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))

const config = { groups: [{ id: 'g', name: 'Work', roots: ['D:/w'] }], zoom: 100 } as unknown as Config
const repos = ['alpha', 'beta', 'gamma'].map((n) => ({ path: `D:/w/${n}`, name: n, groupId: 'g' }))
let finishRefresh: () => void = () => {}

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve(repos)),
    refreshAll: vi.fn(() => new Promise<void>((r) => (finishRefresh = r))),
    rescanRepos: vi.fn(() => Promise.resolve(repos)),
    runBatch: vi.fn(() => Promise.resolve([])),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { Dashboard } = await import('./components/Dashboard')

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Dashboard />
    </QueryClientProvider>,
  )
const summary = (path: string, s: Partial<RepoSummary>): RepoSummary => ({
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
  ...s,
})
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const body = () => document.querySelector('.table-body') as HTMLElement

beforeEach(() => {
  useApp.setState({ summaries: {}, batch: {}, busy: {}, toasts: [], view: { kind: 'dashboard' }, dashboard: { ...initialDashboard } })
})
afterEach(cleanup)

describe('dashboard', () => {
  it('shows Refresh as busy until the refresh finishes', async () => {
    mount()
    await screen.findByText('alpha')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Refresh/ })))
    expect(screen.getByRole('button', { name: /Refreshing/ })).toBeDisabled()
    await act(async () => finishRefresh())
    expect(screen.getByRole('button', { name: /^Refresh$/ })).toBeEnabled()
  })

  it('labels the filters like the rest of the UI, each with how many repos it shows', async () => {
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', { behind: 2 }),
        'D:/w/beta': summary('D:/w/beta', { unstaged: 1 }),
        'D:/w/gamma': summary('D:/w/gamma', { error: 'boom' }),
      },
    })
    mount()
    await screen.findByText('alpha')
    for (const [name, n] of [
      ['All', 3],
      ['Attention', 1],
      ['Changes', 1],
      ['Behind', 1],
      ['Ahead', 0],
    ] as const)
      expect(screen.getByRole('button', { name: new RegExp(`^${name}\\s*${n}$`) })).toBeInTheDocument()
  })

  it('puts the repos that need attention in their own band first', async () => {
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', {}),
        'D:/w/beta': summary('D:/w/beta', { operation: 'merging', conflicted: 1 }),
        'D:/w/gamma': summary('D:/w/gamma', { unstaged: 4 }),
      },
    })
    mount()
    await screen.findByText('alpha')
    const order = [...body().querySelectorAll('.band, .row .repo-link')].map((el) => el.textContent)
    expect(order).toEqual(['Needs attention1', 'beta', 'Everything else2', 'gamma', 'alpha'])
  })

  it('bands the rest by group, with each repo striped in its group colour, when all groups show', async () => {
    config.groups.push({ id: 'p', name: 'Personal', roots: ['D:/p'] })
    repos.push({ path: 'D:/p/delta', name: 'delta', groupId: 'p' })
    try {
      useApp.setState({
        summaries: {
          'D:/w/alpha': summary('D:/w/alpha', {}),
          'D:/w/beta': summary('D:/w/beta', { error: 'boom' }),
          'D:/w/gamma': summary('D:/w/gamma', { unstaged: 4 }),
          'D:/p/delta': summary('D:/p/delta', { behind: 1 }),
        },
      })
      mount()
      await screen.findByText('alpha')
      const order = () => [...body().querySelectorAll('.band, .row .repo-link')].map((el) => el.textContent)
      expect(order()).toEqual(['Needs attention1', 'beta', 'Work2', 'gamma', 'alpha', 'Personal1', 'delta'])
      const stripe = (name: string) => screen.getByText(name).closest<HTMLElement>('.row')!.style.getPropertyValue('--group')
      expect([stripe('beta'), stripe('gamma'), stripe('delta')]).toEqual(['var(--g-teal)', 'var(--g-teal)', 'var(--g-rose)'])
      expect(body().querySelectorAll('.row .group-stripe')).toHaveLength(4)

      // One group chosen: back to attention, then everything else.
      act(() => useApp.getState().setDashboard({ group: 'g' }))
      expect(order()).toEqual(['Needs attention1', 'beta', 'Everything else2', 'gamma', 'alpha'])
    } finally {
      config.groups.pop()
      repos.pop()
    }
  })

  it('draws no group stripes with only one group', async () => {
    mount()
    await screen.findByText('alpha')
    expect(body().querySelector('.group-stripe')).toBeNull()
  })

  it('keeps filter, search and sort when you leave and come back', async () => {
    const first = mount()
    await screen.findByText('alpha')
    fireEvent.click(screen.getByRole('button', { name: /^Behind/ }))
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'al' } })
    first.unmount()
    mount()
    expect(screen.getByPlaceholderText(/Search/)).toHaveValue('al')
    expect(screen.getByRole('button', { name: /^Behind/ })).toHaveClass('on')
  })

  it('restores the scroll position', async () => {
    const first = mount()
    await screen.findByText('alpha')
    body().scrollTop = 120
    fireEvent.scroll(body())
    first.unmount()
    mount()
    await screen.findByText('alpha')
    expect(body().scrollTop).toBe(120)
  })

  it('moves through the rows with the arrow keys and opens one with Enter', async () => {
    useApp.setState({ summaries: {} })
    mount()
    await screen.findByText('alpha')
    const rows = () => Array.from(document.querySelectorAll('.table-body .row'))
    fireEvent.keyDown(body(), { key: 'ArrowDown' })
    expect(rows()[0]).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(body(), { key: 'ArrowDown' })
    expect(rows()[1]).toHaveAttribute('aria-current', 'true')
    expect(rows()[0]).not.toHaveAttribute('aria-current')
    fireEvent.keyDown(body(), { key: 'Enter' })
    expect(useApp.getState().view).toEqual({ kind: 'repo', path: 'D:/w/beta' })
  })

  it('keeps showing how the last Fetch all / Pull all went', async () => {
    useApp.setState({
      batch: {
        a: { path: 'a', op: 'fetch', state: 'ok', message: null },
        b: { path: 'b', op: 'fetch', state: 'error', message: 'x' },
      },
    })
    mount()
    await flush()
    expect(screen.getByText('1 done, 1 failed')).toBeInTheDocument()
  })
})
