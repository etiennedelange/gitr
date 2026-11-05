import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { useLayout } from './layout'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(() => Promise.resolve(true)), open: vi.fn() }))

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
    abortOperation: vi.fn(() => Promise.resolve()),
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

// These tests read the ledger table; the cards have their own tests.
beforeEach(() => useLayout.setState({ dashboardView: 'table' }))
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

  it('lists the repos that need you in a banner above, and keeps them in their place in the list', async () => {
    const { api } = await import('./api')
    const { ask } = await import('@tauri-apps/plugin-dialog')
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', {}),
        'D:/w/beta': summary('D:/w/beta', { operation: 'merging', conflicted: 1 }),
        'D:/w/gamma': summary('D:/w/gamma', { unstaged: 4 }),
      },
    })
    mount()
    await screen.findByText('alpha')
    // No separate band: beta sorts first in the list, where it belongs.
    const order = [...body().querySelectorAll('.band, .row .repo-link')].map((el) => el.textContent)
    expect(order).toEqual(['beta', 'gamma', 'alpha'])
    const banner = screen.getByRole('region', { name: 'Needs attention' })
    expect(banner).toHaveTextContent('betaMerge in progress · 1 conflict')
    expect(banner.querySelectorAll('li')).toHaveLength(1)
    // Abort asks first, then aborts; Open goes to the repo.
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: 'Abort' })))
    expect(ask).toHaveBeenCalled()
    expect(api.abortOperation).toHaveBeenCalledWith('D:/w/beta')
    fireEvent.click(within(banner).getByRole('button', { name: 'Open beta' }))
    expect(useApp.getState().view).toEqual({ kind: 'repo', path: 'D:/w/beta' })
  })

  it('offers Retry for a failed fetch in the banner, and folds a long list under "Show N more"', async () => {
    const { api } = await import('./api')
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', {}),
        'D:/w/beta': summary('D:/w/beta', {}),
        'D:/w/gamma': summary('D:/w/gamma', {}),
      },
      batch: { 'D:/w/alpha': { path: 'D:/w/alpha', op: 'fetch', state: 'error', message: 'Could not reach the remote', signIn: false } },
    } as never)
    mount()
    await screen.findByText('gamma')
    const banner = screen.getByRole('region', { name: 'Needs attention' })
    expect(banner).toHaveTextContent('alphaFetch failed · Could not reach the remote')
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: 'Retry' })))
    expect(api.runBatch).toHaveBeenCalledWith('fetch', ['D:/w/alpha'], true)
    cleanup()

    // Four repos in trouble: three show, the fourth folds away.
    repos.push({ path: 'D:/w/delta', name: 'delta', groupId: 'g' })
    try {
      useApp.setState({
        batch: {},
        summaries: Object.fromEntries(repos.map((r) => [r.path, summary(r.path, { error: 'boom' })])),
      })
      mount()
      await screen.findByText('Show 1 more')
      const list = () => screen.getByRole('region', { name: 'Needs attention' }).querySelectorAll('li')
      expect(list()).toHaveLength(3)
      fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }))
      expect(list()).toHaveLength(4)
    } finally {
      repos.pop()
    }
  })

  it('reads like a ledger: numbers not bars, blank zeros, a two-tone branch and quiet clean rows', async () => {
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', {}),
        'D:/w/gamma': summary('D:/w/gamma', { branch: 'feature/VA-2905', behind: 12, unstaged: 3 }),
      },
    })
    mount()
    await screen.findByText('alpha')
    const row = (name: string) => screen.getByText(name).closest<HTMLElement>('.row')!
    // Behind and ahead are numerals with their arrows; a zero leaves the cell empty.
    expect(row('gamma').querySelector('.dv-behind')).toHaveTextContent('↓12')
    expect(row('gamma').querySelector('.dv-ahead')).toHaveTextContent('')
    expect(row('gamma').querySelector('.dv-bar, .dv-axis')).toBeNull()
    expect(row('gamma').querySelector('.counts')).toHaveTextContent('±3')
    expect(row('alpha').querySelector('.counts')).toHaveTextContent('')
    // The folder path is set apart from the branch's own name.
    expect(row('gamma').querySelector('.branch-path')).toHaveTextContent('feature/')
    expect(row('gamma').querySelector('.branch-cell')).toHaveTextContent('feature/VA-2905')
    // Clean repos recede; repos with work in them don't.
    expect(row('alpha')).toHaveClass('quiet')
    expect(row('gamma')).not.toHaveClass('quiet')
  })

  it('bands the rest by group, told apart by their headings and never by colour, when all groups show', async () => {
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
      // A group's band ends with a one-line summary of the repos in it.
      expect(order()).toEqual(['Work31 with changes', 'beta', 'gamma', 'alpha', 'Personal11 behind', 'delta'])
      const stripe = (name: string) => screen.getByText(name, { selector: '.repo-link' }).closest<HTMLElement>('.row')!.style.getPropertyValue('--group')
      expect([stripe('beta'), stripe('gamma'), stripe('delta')]).toEqual(['', '', ''])
      expect(body().querySelectorAll('.group-stripe, .group-swatch')).toHaveLength(0)

      // One group chosen: one list, no bands.
      act(() => useApp.getState().setDashboard({ group: 'g' }))
      expect(order()).toEqual(['beta', 'gamma', 'alpha'])
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
