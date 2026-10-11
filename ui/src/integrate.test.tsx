import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { CmdError, Config, Divergence, IntegrateResult, RepoStatus, RepoSummary } from './types'

const PATH = 'D:/Repos/work/api'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
const ask = vi.fn<(q: string, o?: { okLabel?: string; title?: string }) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: { okLabel?: string }) => ask(q, o), open: vi.fn() }))
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn(() => Promise.resolve()) }))

const config: Config = {
  groups: [{ id: 'g', name: 'Work', roots: ['D:/Repos/work'] }],
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
const summary = (s: Partial<RepoSummary> = {}): RepoSummary => ({
  path: PATH,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 2,
  behind: 3,
  staged: 0,
  unstaged: 0,
  conflicted: 0,
  remote: null,
  error: null,
  operation: null,
  ...s,
})
let divergence: Divergence = { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, strategy: 'rebase' }
let integrateResult: IntegrateResult = { outcome: { kind: 'done' }, strategy: 'rebase', pushed: false }

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(structuredClone(config))),
    saveConfig: vi.fn(() => Promise.resolve()),
    listRepos: vi.fn(() => Promise.resolve([{ path: 'D:/Repos/work/api', name: 'api', groupId: 'g' }])),
    listModels: vi.fn(() => Promise.resolve([])),
    gitInfo: vi.fn(() => Promise.resolve({ path: 'C:/Git/cmd/git.exe', version: '2.55.0', problem: null, settingIgnored: false })),
    devtoolsAvailable: vi.fn(() => Promise.resolve(false)),
    repoSummary: vi.fn(() => Promise.resolve(useApp.getState().summaries['D:/Repos/work/api'])),
    status: vi.fn(() => Promise.resolve({ branch: 'main', files: [] } as unknown as RepoStatus)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
    busyRepos: vi.fn(() => Promise.resolve([])),
    pullStrategy: vi.fn(() => Promise.resolve(divergence.strategy)),
    divergence: vi.fn(() => Promise.resolve(divergence)),
    integrate: vi.fn(() => Promise.resolve(integrateResult)),
    continueOperation: vi.fn(() => Promise.resolve({ kind: 'done' })),
    abortOperation: vi.fn(() => Promise.resolve()),
    runBatch: vi.fn(() => Promise.resolve([{ path: 'D:/Repos/work/api', op: 'pull', state: 'ok', message: 'Fast-forwarded' }])),
    push: vi.fn(() => Promise.resolve()),
    openWith: vi.fn(() => Promise.resolve()),
  },
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e)),
  errorDetail: () => null,
  asCmdError: (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? e : null),
}))

const { api } = await import('./api')
const { notifyError } = await import('./hooks')
const { Toasts } = await import('./components/Toasts')
const { RepoView } = await import('./components/RepoView')
const { Settings } = await import('./components/Settings')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const lastToast = () => useApp.getState().toasts.at(-1)?.message
const pull = async () => {
  wrap(<RepoView path={PATH} />)
  const button = await screen.findByRole('button', { name: /^Pull/ })
  await act(async () => fireEvent.click(button))
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  divergence = { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, strategy: 'rebase' }
  integrateResult = { outcome: { kind: 'done' }, strategy: 'rebase', pushed: false }
  useApp.setState({ toasts: [], busy: {}, summaries: { [PATH]: summary() } })
})
afterEach(cleanup)

describe('repo view Pull on a diverged branch', () => {
  it('asks once with the counts, then rebases without pushing (facts 8, 10)', async () => {
    ask.mockResolvedValueOnce(true)
    await pull()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toBe(
      'Your branch and origin/main have diverged: 2 local commits, 3 on the remote. Rebase your 2 commits onto origin/main?',
    )
    expect(ask.mock.calls[0][1]?.okLabel).toBe('Rebase')
    expect(api.integrate).toHaveBeenCalledWith(PATH, false)
    expect(lastToast()).toBe('Rebased onto origin/main')
  })

  it('merge wording when the strategy is merge (facts 1, 2, 10)', async () => {
    divergence = { ...divergence, ahead: 1, strategy: 'merge' }
    integrateResult = { outcome: { kind: 'done' }, strategy: 'merge', pushed: false }
    ask.mockResolvedValueOnce(true)
    await pull()
    expect(ask.mock.calls[0][0]).toBe(
      'Your branch and origin/main have diverged: 1 local commit, 3 on the remote. Merge origin/main into main?',
    )
    expect(ask.mock.calls[0][1]?.okLabel).toBe('Merge')
    expect(lastToast()).toBe('Merged origin/main')
  })

  it('Cancel changes nothing (fact 10)', async () => {
    ask.mockResolvedValueOnce(false)
    await pull()
    expect(api.integrate).not.toHaveBeenCalled()
  })

  it('only behind: fast-forwards without asking; up to date: nothing (fact 9)', async () => {
    divergence = { ...divergence, ahead: 0 }
    await pull()
    expect(ask).not.toHaveBeenCalled()
    expect(api.runBatch).toHaveBeenCalledWith('pull', [PATH], true)
    expect(lastToast()).toBe('Fast-forwarded')
    cleanup()
    vi.clearAllMocks()
    divergence = { ...divergence, ahead: 0, behind: 0 }
    await pull()
    expect(api.runBatch).not.toHaveBeenCalled()
    expect(api.integrate).not.toHaveBeenCalled()
    expect(lastToast()).toBe('Up to date')
  })

  it('stopping on conflicts says so (fact 11)', async () => {
    integrateResult = { outcome: { kind: 'conflicts', files: 2 }, strategy: 'rebase', pushed: false }
    ask.mockResolvedValueOnce(true)
    await pull()
    const t = useApp.getState().toasts.at(-1)!
    expect(t.kind).toBe('error')
    expect(t.message).toBe('Stopped on conflicts in 2 files. Resolve them, then Continue, or Abort.')
  })

  it('uncommitted changes that conflicted on the way back are reported (risk in plan)', async () => {
    integrateResult = { outcome: { kind: 'stashConflict', files: 1 }, strategy: 'rebase', pushed: false }
    ask.mockResolvedValueOnce(true)
    await pull()
    expect(lastToast()).toMatch(/^Rebased onto origin\/main, but your uncommitted changes conflicted .*git stash list/)
  })
})

describe('rejected push', () => {
  const nonFf: CmdError = {
    message: 'Your branch and the remote have both moved on. Rebase or merge, then push.',
    detail: '! [rejected] (fetch first)',
    kind: 'non-fast-forward',
    repo: PATH,
    lockPath: null,
  }

  it('offers Rebase & push / Merge & push per strategy and pushes after a clean result (facts 6, 7)', async () => {
    wrap(<Toasts />)
    act(() => notifyError(nonFf))
    const button = await screen.findByRole('button', { name: 'Rebase & push' })
    integrateResult = { outcome: { kind: 'done' }, strategy: 'rebase', pushed: true }
    ask.mockResolvedValueOnce(true)
    await act(async () => fireEvent.click(button))
    await flush()
    expect(ask.mock.calls[0][0]).toMatch(/Rebase your 2 commits onto origin\/main\? Then push\.$/)
    expect(api.integrate).toHaveBeenCalledWith(PATH, true)
    expect(lastToast()).toBe('Rebased onto origin/main and pushed')
  })

  it('label follows a merge strategy (fact 6)', async () => {
    divergence = { ...divergence, strategy: 'merge' }
    wrap(<Toasts />)
    act(() => notifyError(nonFf))
    expect(await screen.findByRole('button', { name: 'Merge & push' })).toBeInTheDocument()
  })
})

describe('Continue in the banner', () => {
  it('is disabled while files are conflicted, enabled after, and continues (fact 12)', async () => {
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'rebasing', conflicted: 1 }) } })
    wrap(<RepoView path={PATH} />)
    const banner = (await screen.findByText('Rebase in progress')).closest('.banner') as HTMLElement
    const cont = within(banner).getByRole('button', { name: 'Continue' })
    expect(cont).toBeDisabled()
    expect(cont).toHaveAttribute('title', 'Resolve and stage the conflicted files first')
    act(() => useApp.getState().setSummary(summary({ operation: 'rebasing', conflicted: 0 })))
    expect(cont).toBeEnabled()
    await act(async () => fireEvent.click(cont))
    expect(api.continueOperation).toHaveBeenCalledWith(PATH)
    expect(lastToast()).toBe('Rebase finished')
  })

  it('another stop is reported again (fact 13)', async () => {
    vi.mocked(api.continueOperation).mockResolvedValueOnce({ kind: 'conflicts', files: 1 })
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'rebasing', conflicted: 0 }) } })
    wrap(<RepoView path={PATH} />)
    const banner = (await screen.findByText('Rebase in progress')).closest('.banner') as HTMLElement
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: 'Continue' })))
    expect(lastToast()).toBe('Stopped on conflicts in 1 file. Resolve them, then Continue, or Abort.')
  })
})

describe('Settings', () => {
  it('has the diverged-branches choice, saved with Save (fact 2)', async () => {
    wrap(<Settings />)
    const select = (await screen.findByLabelText(/^When branches have diverged/)) as HTMLSelectElement
    expect(select.value).toBe('rebase')
    fireEvent.change(select, { target: { value: 'merge' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ divergedStrategy: 'merge' }))
  })
})
