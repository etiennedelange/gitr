import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Config } from './types'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(() => Promise.resolve(true)), open: vi.fn() }))
const setTheme = vi.fn(() => Promise.resolve())
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTheme }) }))

const config: Config = {
  groups: [{ id: 'g', name: 'Work', roots: ['C:/w'] }],
  scanDepth: 3,
  excludes: [],
  concurrency: 4,
  copilotModel: null,
  copilotCliPath: null,
  watch: true,
  zoom: 100,
  devtools: false,
  gitPath: null,
  divergedStrategy: 'rebase',
}
vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve([])),
    listModels: vi.fn(() => Promise.resolve([])),
    gitInfo: vi.fn(() => new Promise(() => {})),
    appVersion: vi.fn(() => new Promise(() => {})),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { Sidebar } = await import('./components/Sidebar')
const { Settings } = await import('./components/Settings')

/** The OS colour scheme jsdom reports; `matchMedia` is missing in jsdom otherwise. */
function systemDark(dark: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: dark && q.includes('dark'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

const renderApp = (withSettings = false) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Sidebar />
      {withSettings && <Settings />}
    </QueryClientProvider>,
  )

describe('light/dark toggle in the sidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    setTheme.mockClear()
    systemDark(false)
  })
  afterEach(cleanup)

  it('flips between light and dark and remembers the choice', () => {
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(setTheme).toHaveBeenLastCalledWith('dark')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('starts from what is showing when following Windows', () => {
    systemDark(true)
    renderApp()
    // Windows is dark, so the first click goes to light (an explicit choice from then on).
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(localStorage.getItem('theme')).toBe('light')
  })

  it('keeps the Settings theme switch in step', async () => {
    renderApp(true)
    const theme = await screen.findByRole('group', { name: 'Theme' })
    const pressed = () => within(theme).getByRole('button', { pressed: true }).textContent
    expect(pressed()).toBe('Match Windows')
    act(() => void fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' })))
    expect(pressed()).toBe('Dark')
    // And the other way: Settings → Match Windows changes what the toggle offers.
    systemDark(false)
    act(() => void fireEvent.click(within(theme).getByRole('button', { name: 'Match Windows' })))
    expect(localStorage.getItem('theme')).toBeNull()
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy()
  })
})
