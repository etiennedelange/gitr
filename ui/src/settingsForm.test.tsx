import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useApp } from './store'
import type { Config } from './types'

const config: Config = {
  groups: [{ id: 'g1', name: 'Work', roots: ['D:/w'] }],
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
vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    saveConfig: vi.fn(() => Promise.resolve()),
    listModels: vi.fn(() => Promise.resolve([])),
    gitInfo: vi.fn(() => Promise.resolve({ path: 'git', version: '2.50', problem: null, settingIgnored: false })),
    rescanRepos: vi.fn(() => Promise.resolve([])),
    refreshAll: vi.fn(() => Promise.resolve()),
    devtoolsAvailable: vi.fn(() => Promise.resolve(false)),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { api } = await import('./api')
const { Settings } = await import('./components/Settings')

// One client for the whole test, like the real app, so a remount sees the same config object.
const mount = (client: QueryClient) =>
  render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  )
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ zoom: 100, toasts: [], view: { kind: 'settings' }, returnView: { kind: 'dashboard' } })
})
afterEach(cleanup)

describe('settings form', () => {
  it('keeps unsaved edits when you leave Settings and come back', async () => {
    const client = newClient()
    const first = mount(client)
    const name = await screen.findByLabelText('Group name')
    fireEvent.change(name, { target: { value: 'Renamed' } })
    first.unmount()
    mount(client)
    expect(await screen.findByLabelText('Group name')).toHaveValue('Renamed')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('forgets the kept edits after Revert', async () => {
    const client = newClient()
    const first = mount(client)
    fireEvent.change(await screen.findByLabelText('Group name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    first.unmount()
    mount(client)
    expect(await screen.findByLabelText('Group name')).toHaveValue('Work')
  })

  it('lets you type a comma to start the next excluded folder', async () => {
    mount(newClient())
    const input = await screen.findByLabelText('Excluded folders')
    fireEvent.change(input, { target: { value: 'node_modules, ' } })
    expect(input).toHaveValue('node_modules, ')
    fireEvent.change(input, { target: { value: 'node_modules, dist' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ excludes: ['node_modules', 'dist'] }))
  })

  it('lets you clear a number field to type a new value', async () => {
    mount(newClient())
    const depth = await screen.findByLabelText('Scan depth')
    fireEvent.change(depth, { target: { value: '' } })
    expect(depth).toHaveValue(null)
    fireEvent.change(depth, { target: { value: '5' } })
    expect(depth).toHaveValue(5)
    fireEvent.change(depth, { target: { value: '' } })
    fireEvent.blur(depth)
    expect(depth).toHaveValue(5)
  })

  it('saves an out-of-range number clamped, even when Save is clicked before the field blurs', async () => {
    mount(newClient())
    const depth = await screen.findByLabelText('Scan depth')
    fireEvent.change(depth, { target: { value: '99' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ scanDepth: 8 }))
  })

  it('will not save a group without a name', async () => {
    mount(newClient())
    fireEvent.change(await screen.findByLabelText('Group name'), { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('Name every group before saving.')).toBeInTheDocument()
  })

  it('offers no group colour, since groups are told apart by name', async () => {
    useApp.setState({ settingsDraft: null })
    mount(newClient())
    await screen.findByLabelText('Group name')
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('radio', { name: 'teal' })).toBeNull()
  })
})
