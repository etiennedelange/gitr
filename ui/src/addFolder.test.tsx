import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { Config, RepoEntry } from './types'

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), ask: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

let rescanned: RepoEntry[] = []
vi.mock('./api', () => ({
  api: {
    saveConfig: vi.fn(() => Promise.resolve()),
    rescanRepos: vi.fn(() => Promise.resolve(rescanned)),
    refreshAll: vi.fn(() => Promise.resolve()),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { open } = await import('@tauri-apps/plugin-dialog')
const { api } = await import('./api')
const { useAddFolder, overlapping } = await import('./lib/addFolder')

const work = { id: 'w', name: 'Work', roots: ['D:\\Repos\\Work'] }
const config = { groups: [work], zoom: 100 } as unknown as Config

let qc: QueryClient
const mount = () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return renderHook(() => useAddFolder(), { wrapper }).result
}
const lastToast = () => useApp.getState().toasts.at(-1)?.message

beforeEach(() => {
  qc = new QueryClient()
  qc.setQueryData(['config'], config)
  qc.setQueryData(['repos'], [{ path: 'D:\\Repos\\Work\\api', name: 'api', groupId: 'w' }])
  useApp.setState({ toasts: [], settingsDraft: null })
  vi.mocked(api.saveConfig).mockClear()
})
afterEach(cleanup)

describe('overlapping', () => {
  it('matches the same folder whatever the case, slashes or trailing separator', () => {
    expect(overlapping([work], 'd:/repos/work/')?.group.name).toBe('Work')
  })
  it('matches a folder inside or around one already scanned', () => {
    expect(overlapping([work], 'D:\\Repos\\Work\\tools')).not.toBeNull()
    expect(overlapping([work], 'D:\\Repos')).not.toBeNull()
  })
  it('lets a sibling folder through, even one sharing a prefix', () => {
    expect(overlapping([work], 'D:\\Repos\\Workshop')).toBeNull()
  })
})

describe('Add folder', () => {
  it('adds the folder as a new group, saves, rescans and says what it found', async () => {
    vi.mocked(open).mockResolvedValueOnce('D:\\Repos\\Personal')
    rescanned = [
      { path: 'D:\\Repos\\Work\\api', name: 'api', groupId: 'w' },
      { path: 'D:\\Repos\\Personal\\notes', name: 'notes', groupId: 'NEW' },
    ]
    const r = mount()
    // The new group's id is random; point the rescanned repo at it once it is known.
    vi.mocked(api.saveConfig).mockImplementationOnce(async (c: Config) => {
      rescanned[1].groupId = c.groups[1].id
    })
    await act(() => r.current.add())
    const saved = vi.mocked(api.saveConfig).mock.calls[0][0]
    expect(saved.groups.map((g) => [g.name, g.roots])).toEqual([
      ['Work', ['D:\\Repos\\Work']],
      ['Personal', ['D:\\Repos\\Personal']],
    ])
    expect(qc.getQueryData<Config>(['config'])?.groups).toHaveLength(2)
    expect(lastToast()).toBe('Added Personal: 1 repository')
  })

  it('adds the folder to an existing group, counting only the repos it brought', async () => {
    vi.mocked(open).mockResolvedValueOnce('D:\\Clones')
    rescanned = [
      { path: 'D:\\Repos\\Work\\api', name: 'api', groupId: 'w' },
      { path: 'D:\\Clones\\web', name: 'web', groupId: 'w' },
      { path: 'D:\\Clones\\cli', name: 'cli', groupId: 'w' },
    ]
    const r = mount()
    await act(() => r.current.add('w'))
    expect(vi.mocked(api.saveConfig).mock.calls[0][0].groups).toEqual([{ ...work, roots: ['D:\\Repos\\Work', 'D:\\Clones'] }])
    expect(lastToast()).toBe('Added Clones to Work: 2 repositories')
  })

  it('refuses a folder that is already scanned, without saving', async () => {
    vi.mocked(open).mockResolvedValueOnce('d:/repos/work')
    const r = mount()
    await act(() => r.current.add())
    expect(api.saveConfig).not.toHaveBeenCalled()
    expect(lastToast()).toMatch(/already in Work/)
  })

  it('does nothing when the folder picker is cancelled', async () => {
    vi.mocked(open).mockResolvedValueOnce(null)
    const r = mount()
    await act(() => r.current.add())
    expect(api.saveConfig).not.toHaveBeenCalled()
    expect(useApp.getState().toasts).toHaveLength(0)
  })

  it('keeps unsaved Settings edits and adds the folder to them too', async () => {
    const draft = { ...config, scanDepth: 5, groups: [{ ...work, name: 'Day job' }] } as Config
    useApp.setState({ settingsDraft: { base: config, draft } })
    vi.mocked(open).mockResolvedValueOnce('D:\\Repos\\Personal')
    rescanned = []
    const r = mount()
    await act(() => r.current.add())
    const kept = useApp.getState().settingsDraft!
    expect(kept.base).toBe(qc.getQueryData(['config']))
    expect(kept.draft.scanDepth).toBe(5)
    expect(kept.draft.groups.map((g) => g.name)).toEqual(['Day job', 'Personal'])
  })
})
