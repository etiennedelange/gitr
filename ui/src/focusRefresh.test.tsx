import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useApp } from './store'

const handlers = new Map<string, (e: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(event, cb)
    return Promise.resolve(() => {})
  }),
}))
vi.mock('./api', () => ({
  api: { busyRepos: vi.fn(() => Promise.resolve([])), refreshRepo: vi.fn(() => Promise.resolve()) },
  errorMessage: String,
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { api } = await import('./api')
const { useBackendEvents } = await import('./hooks')

function Events() {
  useBackendEvents()
  return null
}

describe('window focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Events />
      </QueryClientProvider>,
    )
  })
  afterEach(cleanup)

  it('refreshes the open repo when the window gets focus', () => {
    useApp.setState({ view: { kind: 'repo', path: 'C:/w/repo' } })
    handlers.get('window-focused')!({ payload: null })
    expect(api.refreshRepo).toHaveBeenCalledWith('C:/w/repo')
  })

  it('refreshes nothing extra on the dashboard (changed repos are refreshed by the backend)', () => {
    useApp.setState({ view: { kind: 'dashboard' } })
    handlers.get('window-focused')!({ payload: null })
    expect(api.refreshRepo).not.toHaveBeenCalled()
  })
})
