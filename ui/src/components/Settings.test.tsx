import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useApp } from '../store'
import type { Config } from '../types'
import { Settings } from './Settings'

const config: Config = {
  groups: [],
  scanDepth: 3,
  excludes: ['node_modules'],
  concurrency: 6,
  copilotModel: null,
  copilotCliPath: null,
  watch: true,
  zoom: 100,
  devtools: false,
  gitPath: null,
  divergedStrategy: 'rebase',
}

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('../api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(structuredClone(config))),
    saveConfig: vi.fn(() => Promise.resolve()),
    listModels: vi.fn(() => Promise.resolve([])),
    rescanRepos: vi.fn(() => Promise.resolve([])),
    refreshAll: vi.fn(() => Promise.resolve()),
    devtoolsAvailable: vi.fn(() => Promise.resolve(true)),
    openLogsFolder: vi.fn(() => Promise.resolve('C:\\logs')),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { api } = await import('../api')

const renderSettings = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Settings />
    </QueryClientProvider>,
  )

describe('Settings zoom display', () => {
  beforeEach(() => {
    vi.mocked(api.saveConfig).mockClear()
    useApp.setState({ zoom: 100 })
  })
  afterEach(cleanup)

  it('closes back to the previous view via the close button and Esc', async () => {
    useApp.setState({ view: { kind: 'repo', path: 'C:\\r' }, returnView: { kind: 'dashboard' } })
    useApp.getState().setView({ kind: 'settings' })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Close settings' }))
    expect(useApp.getState().view).toEqual({ kind: 'repo', path: 'C:\\r' })

    useApp.getState().setView({ kind: 'settings' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useApp.getState().view).toEqual({ kind: 'repo', path: 'C:\\r' })
  })

  it('lists every section in the nav', async () => {
    renderSettings()
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' })
    expect(nav.querySelectorAll('button')).toHaveLength(7)
  })

  it('shows the current zoom and updates live without touching unsaved edits', async () => {
    renderSettings()
    expect(await screen.findByText(/Zoom: 100%/)).toBeInTheDocument()

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    const depth = screen.getByLabelText('Scan depth') as HTMLInputElement
    fireEvent.change(depth, { target: { value: '5' } })
    expect(save).toBeEnabled()

    act(() => useApp.getState().setZoom(125))
    expect(screen.getByText(/Zoom: 125%/)).toBeInTheDocument()
    expect(save).toBeEnabled()
    expect(depth.value).toBe('5')

    await act(async () => fireEvent.click(save))
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ scanDepth: 5 }))
  })

  it('zoom changes alone never make the form dirty', async () => {
    renderSettings()
    await screen.findByText(/Zoom: 100%/)
    act(() => useApp.getState().setZoom(150))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled()
  })

  it('has a Developer tools checkbox, off by default, saved with Save', async () => {
    renderSettings()
    const box = (await screen.findByLabelText(/Developer tools/)) as HTMLInputElement
    expect(box.checked).toBe(false)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.click(box)
    expect(save).toBeEnabled()
    await act(async () => fireEvent.click(save))
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ devtools: true }))
    expect(useApp.getState().devtools).toBe(true)
  })

  it('has an Open logs folder button that asks the backend to open the folder', async () => {
    renderSettings()
    const button = await screen.findByRole('button', { name: 'Open logs folder' })
    await act(async () => fireEvent.click(button))
    expect(api.openLogsFolder).toHaveBeenCalledTimes(1)
    // It is an action, not a setting: the form stays clean.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
