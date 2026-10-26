import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { useApp, initialDashboard } from './store'
import { useLayout, reloadLayout } from './layout'
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

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve(repos)),
    refreshAll: vi.fn(() => Promise.resolve()),
    rescanRepos: vi.fn(() => Promise.resolve(repos)),
    runBatch: vi.fn(() => Promise.resolve([])),
    openWith: vi.fn(() => Promise.resolve()),
    openRemote: vi.fn(() => Promise.resolve('')),
    push: vi.fn(() => Promise.resolve()),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? e : null),
}))
const { api } = await import('./api')
const { Dashboard } = await import('./components/Dashboard')
const { FLASH_MS } = await import('./components/DashboardCards')

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
const card = (name: string) => document.querySelector(`.repo-card[aria-label="${name}"]`) as HTMLElement
const list = () => document.querySelector('.card-list') as HTMLElement

beforeEach(() => {
  localStorage.clear()
  reloadLayout()
  useApp.setState({
    summaries: {},
    fresh: {},
    hookRuns: {},
    batch: {},
    busy: {},
    toasts: [],
    view: { kind: 'dashboard' },
    dashboard: { ...initialDashboard },
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('dashboard cards', () => {
  it('shows compact cards by default and switches to the table and to detailed cards, remembering the choice', async () => {
    mount()
    await screen.findByText('alpha')
    expect(card('alpha')).toHaveClass('compact')
    expect(document.querySelector('.table-body')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Table' }))
    expect(document.querySelector('.table-body .row')).not.toBeNull()
    expect(card('alpha')).toBeNull()
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(card('alpha')).toHaveClass('detailed')
    expect(JSON.parse(localStorage.getItem('layout')!).dashboardView).toBe('detailed')
    reloadLayout()
    expect(useLayout.getState().dashboardView).toBe('detailed')
  })

  it('falls back to compact cards when the saved layout is unknown', () => {
    localStorage.setItem('layout', JSON.stringify({ dashboardView: 'mosaic' }))
    reloadLayout()
    expect(useLayout.getState().dashboardView).toBe('compact')
  })

  it('keeps the bands, with the repos that need attention first', async () => {
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', {}),
        'D:/w/beta': summary('D:/w/beta', { error: 'boom' }),
        'D:/w/gamma': summary('D:/w/gamma', { unstaged: 4 }),
      },
    })
    mount()
    await screen.findByText('alpha')
    const order = [...list().querySelectorAll('.card-band, .card-name')].map((el) => el.textContent)
    expect(order).toEqual(['Needs attention1', 'beta', 'Everything else2', 'gamma', 'alpha'])
  })

  it('shows counts, the last commit and a Pull for what is behind on a detailed card', async () => {
    useLayout.setState({ dashboardView: 'detailed' })
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', {
          behind: 3,
          staged: 1,
          unstaged: 2,
          head: '9f03b11aa',
          lastCommit: { subject: 'Export invoices as CSV', time: Date.now() / 1000 - 120 },
        }),
      },
    })
    mount()
    await screen.findByText('alpha')
    const c = card('alpha')
    expect(c).toHaveTextContent('±3')
    expect(c).toHaveTextContent('↓3')
    expect(c).toHaveTextContent('9f03b11')
    expect(c).toHaveTextContent('Export invoices as CSV')
    expect(c).toHaveTextContent('2 min ago')
    expect(c.querySelector('.card-mix')).toHaveAttribute('aria-label', '1 staged, 2 unstaged')
    expect(screen.getByRole('button', { name: /Pull ↓3/ })).toBeEnabled()
  })

  it('pushes what is ahead from the card', async () => {
    useApp.setState({ summaries: { 'D:/w/alpha': summary('D:/w/alpha', { ahead: 2 }) } })
    mount()
    await screen.findByText('alpha')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Push ↑2/ })))
    expect(api.push).toHaveBeenCalledWith('D:/w/alpha', false)
    expect(useApp.getState().toasts.at(-1)?.message).toBe('Pushed')
  })

  it('offers no Push without an upstream, and Pull and Push when the branches diverged', async () => {
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', { ahead: 1, upstream: null }),
        'D:/w/beta': summary('D:/w/beta', { ahead: 1, behind: 2 }),
      },
    })
    mount()
    await screen.findByText('alpha')
    expect(card('alpha').querySelector('.next')).toBeNull()
    expect([...card('beta').querySelectorAll('.next')].map((b) => b.textContent)).toEqual(['Pull ↓2', 'Push ↑1'])
  })

  it('points to the hook output when a hook rejects the push', async () => {
    const err = { kind: 'hook', message: 'The pre-push hook rejected the push.', detail: 'lint failed', repo: 'D:/w/alpha' }
    vi.mocked(api.push).mockRejectedValueOnce(err)
    useApp.setState({ summaries: { 'D:/w/alpha': summary('D:/w/alpha', { ahead: 1 }) } })
    mount()
    await screen.findByText('alpha')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Push ↑1/ })))
    const toast = useApp.getState().toasts.at(-1)!
    expect(toast.kind).toBe('error')
    expect(toast.message).toBe('alpha: The pre-push hook rejected the push.')
    expect(useApp.getState().hookRuns['D:/w/alpha']?.failed?.retry).toEqual({ kind: 'push' })
    await act(async () => void (await toast.action!.run()))
    expect(useApp.getState().view).toEqual({ kind: 'repo', path: 'D:/w/alpha' })
  })

  it('moves down and up to the card below and above, across the bands', async () => {
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', { error: 'boom' }),
        'D:/w/beta': summary('D:/w/beta', {}),
        'D:/w/gamma': summary('D:/w/gamma', {}),
      },
    })
    mount()
    await screen.findByText('alpha')
    // Three cards a row: "Needs attention" holds alpha, "Everything else" beta and gamma.
    for (const g of document.querySelectorAll<HTMLElement>('.card-grid')) g.style.gridTemplateColumns = '1fr 1fr 1fr'
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(card('alpha')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(list(), { key: 'ArrowRight' })
    expect(card('beta')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(list(), { key: 'ArrowLeft' })
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(card('beta')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(list(), { key: 'ArrowRight' })
    expect(card('gamma')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(list(), { key: 'ArrowUp' })
    expect(card('alpha')).toHaveAttribute('aria-current', 'true')
  })

  it('shows the axis only when behind or ahead, and says when a card is up to date', async () => {
    useApp.setState({
      summaries: { 'D:/w/alpha': summary('D:/w/alpha', {}), 'D:/w/beta': summary('D:/w/beta', { behind: 1 }) },
    })
    mount()
    await screen.findByText('alpha')
    expect(card('alpha').querySelector('.divergence')).toBeNull()
    expect(card('alpha')).toHaveTextContent('Up to date')
    expect(card('beta').querySelector('.divergence')).not.toBeNull()
    expect(card('beta')).not.toHaveTextContent('Up to date')
  })

  it('offers no Pull or Push on a repo with an error', async () => {
    useApp.setState({ summaries: { 'D:/w/alpha': summary('D:/w/alpha', { behind: 2, ahead: 1, error: 'boom' }) } })
    mount()
    await screen.findByText('alpha')
    expect(card('alpha').querySelector('.next')).toBeNull()
  })

  it('shows an error once on a detailed card, with dashes for zero counts and no change bar when clean', async () => {
    useLayout.setState({ dashboardView: 'detailed' })
    useApp.setState({
      summaries: {
        'D:/w/alpha': summary('D:/w/alpha', { error: 'Couldn’t reach the remote' }),
        'D:/w/beta': summary('D:/w/beta', {}),
        'D:/w/gamma': summary('D:/w/gamma', { ahead: 1 }),
      },
    })
    mount()
    await screen.findByText('alpha')
    expect(card('alpha').textContent!.split('Couldn’t reach the remote').length - 1).toBe(1)
    expect([...card('beta').querySelectorAll('.card-stat b')].map((b) => b.textContent)).toEqual(['–', '–', '–'])
    expect(card('beta').querySelector('.card-mix')).toBeNull()
    expect(card('gamma')).toHaveTextContent('↑1')
    expect(card('gamma').querySelector('.badge')).toBeNull()
  })

  it('names the group on a card only where no group heading does', async () => {
    config.groups.push({ id: 'p', name: 'Personal', roots: ['D:/p'] })
    repos.push({ path: 'D:/p/delta', name: 'delta', groupId: 'p' })
    try {
      useLayout.setState({ dashboardView: 'detailed' })
      useApp.setState({
        summaries: {
          'D:/w/alpha': summary('D:/w/alpha', { error: 'boom' }),
          'D:/w/beta': summary('D:/w/beta', {}),
          'D:/p/delta': summary('D:/p/delta', {}),
        },
      })
      mount()
      await screen.findByText('delta')
      expect(card('alpha').querySelector('.card-group')).toHaveTextContent('Work')
      expect(card('beta').querySelector('.card-group')).toBeNull()
      expect(card('delta').querySelector('.card-group')).toBeNull()
      // Compact cards show only the swatch, on the same terms.
      fireEvent.click(screen.getByRole('button', { name: 'Cards' }))
      expect(card('alpha').querySelector('.group-swatch')).not.toBeNull()
      expect(card('beta').querySelector('.group-swatch')).toBeNull()
    } finally {
      config.groups.pop()
      repos.pop()
    }
  })

  it('moves across the cards with the arrow keys and opens one with Enter', async () => {
    mount()
    await screen.findByText('alpha')
    fireEvent.keyDown(list(), { key: 'ArrowDown' })
    expect(card('alpha')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(list(), { key: 'ArrowRight' })
    expect(card('beta')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(list(), { key: 'ArrowLeft' })
    expect(card('alpha')).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(list(), { key: 'Enter' })
    expect(useApp.getState().view).toEqual({ kind: 'repo', path: 'D:/w/alpha' })
  })
})

describe('new changes on the cards', () => {
  it('flashes nothing for the first status of a repo', async () => {
    mount()
    await screen.findByText('alpha')
    act(() => useApp.getState().setSummary(summary('D:/w/alpha', { behind: 2 })))
    expect(card('alpha').querySelector('.card-flash')).toBeNull()
    expect(card('alpha').querySelector('.fresh-dot')).toBeNull()
  })

  it('flashes once in the hue of what went up and keeps a dot until the card is hovered', async () => {
    useApp.setState({ summaries: { 'D:/w/alpha': summary('D:/w/alpha', {}) } })
    mount()
    await screen.findByText('alpha')
    act(() => useApp.getState().setSummary(summary('D:/w/alpha', { behind: 2 })))
    const flash = card('alpha').querySelector('.card-flash')
    expect(flash).toHaveClass('behind')
    expect(card('alpha').querySelector('.fresh-dot.behind')).toHaveTextContent('New incoming commits')

    // Hovering marks it seen without cutting the flash short or starting it again.
    fireEvent.mouseEnter(card('alpha'))
    expect(card('alpha').querySelector('.fresh-dot')).toBeNull()
    expect(card('alpha').querySelector('.card-flash')).toBe(flash)
  })

  it('does not play the flash again on a later render', async () => {
    useApp.setState({ summaries: { 'D:/w/alpha': summary('D:/w/alpha', {}) } })
    mount()
    await screen.findByText('alpha')
    act(() => useApp.getState().setSummary(summary('D:/w/alpha', { unstaged: 1 })))
    expect(card('alpha').querySelector('.card-flash.dirty')).not.toBeNull()

    const later = Date.now() + FLASH_MS + 1
    vi.spyOn(Date, 'now').mockReturnValue(later)
    // Another repo's status re-renders the dashboard; alpha's old news stays a dot, not a flash.
    act(() => useApp.getState().setSummary(summary('D:/w/beta', {})))
    expect(card('alpha').querySelector('.card-flash')).toBeNull()
    expect(card('alpha').querySelector('.fresh-dot.dirty')).not.toBeNull()
    vi.restoreAllMocks()
  })

  it('counts opening the repo from anywhere as seeing it', async () => {
    useApp.setState({ summaries: { 'D:/w/alpha': summary('D:/w/alpha', {}) } })
    mount()
    await screen.findByText('alpha')
    act(() => useApp.getState().setSummary(summary('D:/w/alpha', { behind: 1 })))
    // The sidebar and Ctrl+P open a repo without touching its card.
    act(() => useApp.getState().setView({ kind: 'repo', path: 'D:/w/alpha' }))
    expect(useApp.getState().fresh['D:/w/alpha']?.seen).toBe(true)
  })

  it('drops the mark once what it pointed at is gone', async () => {
    useApp.setState({ summaries: { 'D:/w/alpha': summary('D:/w/alpha', {}) } })
    mount()
    await screen.findByText('alpha')
    act(() => useApp.getState().setSummary(summary('D:/w/alpha', { behind: 1 })))
    act(() => useApp.getState().setSummary(summary('D:/w/alpha', { behind: 0 })))
    expect(useApp.getState().fresh['D:/w/alpha']).toBeUndefined()
    expect(card('alpha').querySelector('.fresh-dot')).toBeNull()
  })
})

const { cardAbove } = await import('./components/DashboardCards')

describe('cardAbove', () => {
  // Sections of 2, 5 and 1 cards, 3 to a row:  [0 1]  [2 3 4 / 5 6]  [7]
  const sizes = [2, 5, 1]
  it('moves a row within a section, onto a shorter last row', () => {
    expect(cardAbove(sizes, 2, 3, 1)).toBe(5)
    expect(cardAbove(sizes, 4, 3, 1)).toBe(6)
    expect(cardAbove(sizes, 6, 3, -1)).toBe(3)
  })
  it('crosses into the next and previous sections, keeping the column where it can', () => {
    expect(cardAbove(sizes, 1, 3, 1)).toBe(3)
    expect(cardAbove(sizes, 6, 3, 1)).toBe(7)
    expect(cardAbove(sizes, 4, 3, -1)).toBe(1)
    expect(cardAbove(sizes, 7, 3, -1)).toBe(5)
  })
  it('skips empty sections and stays put at either end', () => {
    expect(cardAbove([1, 0, 2], 0, 3, 1)).toBe(1)
    expect(cardAbove([1, 0, 2], 2, 3, -1)).toBe(0)
    expect(cardAbove(sizes, 0, 3, -1)).toBe(0)
    expect(cardAbove(sizes, 7, 3, 1)).toBe(7)
  })
  it('leaves a section whose last row is full', () => {
    expect(cardAbove([3, 1], 0, 3, 1)).toBe(3)
    expect(cardAbove([3, 1], 2, 3, 1)).toBe(3)
  })
})
