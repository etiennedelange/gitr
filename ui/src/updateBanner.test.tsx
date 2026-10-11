import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UpdateCheck } from './types'
import { useApp } from './store'

vi.mock('./api', () => ({
  api: {
    checkUpdate: vi.fn(),
    installUpdate: vi.fn(),
    openReleasePage: vi.fn(() => Promise.resolve()),
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { api } = await import('./api')
const { UpdateBanner, UPDATE_CHECK_DELAY_MS } = await import('./components/UpdateBanner')

const available: UpdateCheck = { channel: 'direct', available: { version: '0.3.0', notes: null, date: null } }

const renderBanner = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UpdateBanner />
    </QueryClientProvider>,
  )
/** Lets the startup delay pass and the check resolve. */
const startup = () => act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS + 50))

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.clearAllMocks()
    vi.mocked(api.checkUpdate).mockResolvedValue(available)
    useApp.setState({ toasts: [] })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('checks once, a few seconds after startup, and offers the new version', async () => {
    renderBanner()
    await act(() => vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS - 100))
    expect(api.checkUpdate).not.toHaveBeenCalled()
    await startup()
    expect(api.checkUpdate).toHaveBeenCalledTimes(1)
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Gitr 0.3.0 is available.')
    fireEvent.click(within(banner).getByRole('button', { name: "What's new" }))
    expect(api.openReleasePage).toHaveBeenCalledWith('0.3.0')
  })

  it('stays hidden when Gitr is up to date', async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue({ channel: 'direct', available: null })
    renderBanner()
    await startup()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays hidden for the Microsoft Store build', async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue({ channel: 'store', available: { version: '0.3.0', notes: null, date: null } })
    renderBanner()
    await startup()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a failed startup check shows nothing, not even a toast', async () => {
    vi.mocked(api.checkUpdate).mockRejectedValue(new Error('offline'))
    renderBanner()
    await startup()
    expect(api.checkUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()
    expect(useApp.getState().toasts).toEqual([])
  })

  it('Restart and update installs, showing Updating… meanwhile', async () => {
    vi.mocked(api.installUpdate).mockReturnValue(new Promise(() => {}))
    renderBanner()
    await startup()
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Restart and update' })))
    expect(api.installUpdate).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Updating…' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Updating to Gitr 0.3.0…')
    expect(screen.getByRole('button', { name: 'Dismiss update' })).toBeDisabled()
  })

  it('a failed install is reported as an error toast and the banner stays', async () => {
    vi.mocked(api.installUpdate).mockRejectedValue(new Error("Couldn't update Gitr: signature mismatch"))
    renderBanner()
    await startup()
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Restart and update' })))
    expect(useApp.getState().toasts.at(-1)).toMatchObject({ kind: 'error', message: "Couldn't update Gitr: signature mismatch" })
    expect(screen.getByRole('button', { name: 'Restart and update' })).toBeEnabled()
  })

  it('dismiss hides it for the rest of the session', async () => {
    renderBanner()
    await startup()
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss update' }))
    expect(screen.queryByRole('status')).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(api.checkUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
