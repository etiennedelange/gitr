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
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
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

    fireEvent.click(screen.getByRole('button', { name: 'Detailed cards' }))
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
