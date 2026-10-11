import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { CmdError, Config, GitLocation, RepoStatus, RepoSummary } from './types'

const PATH = 'D:/Repos/work/api'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
const ask = vi.fn<(q: string, o?: unknown) => Promise<boolean>>()
const openDialog = vi.fn<(o?: unknown) => Promise<string | null>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: unknown) => ask(q, o), open: (o?: unknown) => openDialog(o) }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, key: i, size: 28, start: i * 28 })),
    measureElement: () => {},
  }),
}))
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
  ahead: 0,
  behind: 0,
  staged: 1,
  unstaged: 0,
  conflicted: 0,
  remote: null,
  error: null,
  operation: null,
  ...s,
})
const status: RepoStatus = {
  branch: 'main',
  files: [{ path: 'a.ts', origPath: null, index: 'M', worktree: '.', untracked: false, conflicted: false }],
} as unknown as RepoStatus
const goodGit: GitLocation = { path: 'C:/Program Files/Git/cmd/git.exe', version: '2.55.0.windows.1', problem: null, settingIgnored: false }
let gitLocation: GitLocation = goodGit

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(structuredClone(config))),
    saveConfig: vi.fn(() => Promise.resolve()),
    listRepos: vi.fn(() => Promise.resolve([{ path: 'D:/Repos/work/api', name: 'api', groupId: 'g' }])),
    listModels: vi.fn(() => Promise.resolve([])),
    devtoolsAvailable: vi.fn(() => Promise.resolve(false)),
    rescanRepos: vi.fn(() => Promise.resolve([])),
    refreshAll: vi.fn(() => Promise.resolve()),
    repoSummary: vi.fn(() => Promise.resolve(useApp.getState().summaries['D:/Repos/work/api'])),
    status: vi.fn(() => Promise.resolve(status)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    branches: vi.fn(() =>
      Promise.resolve([
        { name: 'main', remote: false, isHead: true, upstream: null, ahead: 0, behind: 0, gone: false, sha: 'a', committedAt: 0 },
        { name: 'feature', remote: false, isHead: false, upstream: null, ahead: 0, behind: 0, gone: false, sha: 'b', committedAt: 0 },
      ]),
    ),
    runBatch: vi.fn(() => Promise.resolve([{ path: 'D:/Repos/work/api', op: 'pull', state: 'ok', message: 'Fast-forwarded' }])),
    openWith: vi.fn(() => Promise.resolve()),
    removeStaleLock: vi.fn(() => Promise.resolve()),
    trustFolder: vi.fn(() => Promise.resolve()),
    abortOperation: vi.fn(() => Promise.resolve()),
    mergeMessage: vi.fn(() => Promise.resolve("Merge branch 'side'")),
    lastCommitUndo: vi.fn(() => Promise.resolve({ subject: 'Last', message: 'Last' })),
    checkout: vi.fn(() => Promise.resolve()),
    createBranch: vi.fn(() => Promise.resolve()),
    gitInfo: vi.fn(() => Promise.resolve(gitLocation)),
    recheckGit: vi.fn(() => Promise.resolve(goodGit)),
    setGitPath: vi.fn((p: string | null) => Promise.resolve({ ...goodGit, path: p })),
    busyRepos: vi.fn(() => Promise.resolve([])),
  },
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e)),
  errorDetail: (e: unknown) => (e && typeof e === 'object' && 'detail' in e ? (e as { detail: string }).detail : null),
  asCmdError: (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? e : null),
}))

const { api } = await import('./api')
const { notifyError } = await import('./hooks')
const { errorActions } = await import('./lib/errorActions')
const { Toasts } = await import('./components/Toasts')
const { Dashboard } = await import('./components/Dashboard')
const { RepoView } = await import('./components/RepoView')
const { Settings } = await import('./components/Settings')
const { GitBanner } = await import('./components/GitBanner')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const err = (kind: CmdError['kind'], extra: Partial<CmdError> = {}): CmdError => ({
  message: `msg for ${kind}`,
  detail: 'raw git output',
  kind,
  repo: PATH,
  lockPath: null,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  gitLocation = goodGit
  useApp.setState({ toasts: [], busy: {}, batch: {}, summaries: { [PATH]: summary() } })
})
afterEach(cleanup)

describe('error actions by kind', () => {
  const labels = (e: CmdError, busy = false) => errorActions(e, () => busy).map((a) => a.label)
  it('offers the right fix per kind (facts 5–8)', () => {
    expect(labels(err('non-fast-forward'))).toEqual(['Rebase & push'])
    expect(labels(err('lock', { lockPath: `${PATH}/.git/index.lock` }))).toEqual(['Remove stale lock'])
    expect(labels(err('dubious-ownership'))).toEqual(['Trust this folder'])
    for (const k of ['auth', 'hook', 'signing'] as const) expect(labels(err(k))).toEqual(['Open terminal here'])
    for (const k of ['network', 'overwrite', 'not-a-repo', 'conflict', 'other', 'git-missing'] as const) expect(labels(err(k))).toEqual([])
  })
  it('does not offer to remove a lock while Gitr itself works on the repo (fact 6)', () => {
    expect(labels(err('lock', { lockPath: 'x/.git/index.lock' }), true)).toEqual([])
    expect(labels(err('lock'))).toEqual([]) // no lock path → nothing to remove
    expect(labels(err('non-fast-forward', { repo: null }))).toEqual([])
  })
})

describe('error toasts', () => {
  const showError = (e: CmdError) => act(() => notifyError(e))

  it('shows the friendly message and raw output behind details; the fix is Rebase & push (facts 3, 4; diverged-pull 6)', async () => {
    wrap(<Toasts />)
    showError(err('non-fast-forward', { message: 'Your branch and the remote have both moved on. Rebase or merge, then push.' }))
    const toast = screen.getByRole('alert')
    expect(toast).toHaveTextContent('Your branch and the remote have both moved on. Rebase or merge, then push.')
    expect(within(toast).queryByText('raw git output')).toBeNull()
    fireEvent.click(within(toast).getByRole('button', { name: 'details' }))
    expect(within(toast).getByText('raw git output')).toBeInTheDocument()
    expect(within(toast).getByRole('button', { name: 'Rebase & push' })).toBeInTheDocument()
  })

  it('Remove stale lock asks with the file name, then removes exactly that file (fact 6)', async () => {
    const lock = `${PATH}/.git/index.lock`
    ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    wrap(<Toasts />)
    showError(err('lock', { lockPath: lock }))
    const button = screen.getByRole('button', { name: 'Remove stale lock' })
    await act(async () => fireEvent.click(button))
    expect(ask.mock.calls[0][0]).toContain(lock)
    expect(ask.mock.calls[0][0]).toMatch(/no other git tool/)
    expect(api.removeStaleLock).not.toHaveBeenCalled()
    // Cancelling keeps the error and its fix visible.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove stale lock' })))
    expect(api.removeStaleLock).toHaveBeenCalledWith(PATH, lock)
  })

  it('hides Remove stale lock while the repo is busy (fact 6)', () => {
    useApp.setState({ busy: { [PATH]: 'committing' } })
    wrap(<Toasts />)
    showError(err('lock', { lockPath: `${PATH}/.git/index.lock` }))
    expect(screen.queryByRole('button', { name: 'Remove stale lock' })).toBeNull()
  })

  it('Trust this folder asks, then trusts (fact 7)', async () => {
    ask.mockResolvedValueOnce(true)
    wrap(<Toasts />)
    showError(err('dubious-ownership'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Trust this folder' })))
    expect(ask.mock.calls[0][0]).toMatch(/safe\.directory in your global git config/)
    expect(api.trustFolder).toHaveBeenCalledWith(PATH)
  })

  it('auth, hook and signing open a terminal in the repo (fact 8)', async () => {
    wrap(<Toasts />)
    showError(err('hook'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open terminal here' })))
    expect(api.openWith).toHaveBeenCalledWith(PATH, 'terminal')
  })
})

describe('in-progress merge / rebase', () => {
  it('dashboard row shows the state pill and the friendly error message (facts 9, 15)', async () => {
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'rebasing' }) } })
    wrap(<Dashboard />)
    const row = (await screen.findByRole('button', { name: 'api' })).closest('.row') as HTMLElement
    expect(within(row).getByText('Rebasing').closest('.pill')).not.toBeNull()
    act(() =>
      useApp.getState().setSummary(summary({ error: "Couldn't reach the remote. Check the network or VPN, and the remote address." })),
    )
    expect(within(row).getByText(/Couldn't reach the remote/)).toBeInTheDocument()
  })

  it('repo view banner: state, conflicted count, Abort asks then aborts, Pull disabled (facts 16–18)', async () => {
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'merging', conflicted: 2 }) } })
    ask.mockResolvedValueOnce(true)
    wrap(<RepoView path={PATH} />)
    await screen.findByText('Merge in progress')
    const b = screen.getByText('Merge in progress').closest('.banner') as HTMLElement
    expect(b).toHaveTextContent('2 conflicted files')
    expect(within(b).getByRole('button', { name: /Open terminal/ })).toBeInTheDocument()
    expect(within(b).getByRole('button', { name: /Open in VS Code/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Pull/ })).toBeDisabled()
    await act(async () => fireEvent.click(within(b).getByRole('button', { name: 'Abort' })))
    expect(ask.mock.calls[0][0]).toMatch(/^Abort the merge\?/)
    expect(api.abortOperation).toHaveBeenCalledWith(PATH)
  })

  it('merge: commit stays possible and is prefilled from MERGE_MSG; undo is disabled (facts 18, 19)', async () => {
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'merging' }) } })
    wrap(<RepoView path={PATH} />)
    await flush()
    await flush()
    expect(document.querySelector('textarea')!.value).toBe("Merge branch 'side'")
    expect(screen.getByRole('button', { name: /^Commit/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Undo last commit/ })).toBeDisabled()
    expect(screen.queryByText(/git rebase --continue/)).toBeNull()
  })

  it('rebase: commit is disabled with a hint to continue in a terminal (fact 19)', async () => {
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'rebasing' }) } })
    wrap(<RepoView path={PATH} />)
    await flush()
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'msg' } })
    expect(screen.getByRole('button', { name: /^Commit/ })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent('Continue in the banner above, or in a terminal: git rebase --continue')
    expect(api.mergeMessage).not.toHaveBeenCalled()
  })

  it('checkout and create-and-checkout are disabled (fact 18)', async () => {
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'cherry-picking' }) } })
    wrap(<RepoView path={PATH} />)
    fireEvent.click(await screen.findByRole('tab', { name: /Branches/ }))
    await screen.findByText('feature')
    expect(screen.getByRole('button', { name: 'Checkout' })).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('new-branch-name'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: /Create & checkout/ })).toBeDisabled()
    fireEvent.doubleClick(screen.getByText('feature'))
    await flush()
    expect(api.checkout).not.toHaveBeenCalled()
  })
})

describe('finding git', () => {
  it('Settings shows the git in use and saving a new path re-reads it (facts 11, 14)', async () => {
    wrap(<Settings />)
    expect(await screen.findByText('Using C:/Program Files/Git/cmd/git.exe · git 2.55.0.windows.1')).toBeInTheDocument()
    const field = screen.getByLabelText('Git path') as HTMLInputElement
    expect(field.placeholder).toBe('Automatic (C:/Program Files/Git/cmd/git.exe)')
    openDialog.mockResolvedValueOnce('D:/tools/git/cmd/git.exe')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse…' })))
    expect(field.value).toBe('D:/tools/git/cmd/git.exe')
    const calls = vi.mocked(api.gitInfo).mock.calls.length
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
    expect(api.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ gitPath: 'D:/tools/git/cmd/git.exe' }))
    expect(vi.mocked(api.gitInfo).mock.calls.length).toBeGreaterThan(calls)
  })

  it('missing git: banner with install command, Copy, Choose git.exe…, Check again (facts 12, 14)', async () => {
    gitLocation = { path: null, version: null, problem: { kind: 'missing' }, settingIgnored: false }
    const { copyText } = await import('./nativeMenu')
    wrap(<GitBanner />)
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent("Git wasn't found.")
    expect(within(banner).getByText('winget install Git.Git').tagName).toBe('CODE')
    fireEvent.click(within(banner).getByRole('button', { name: 'Copy' }))
    expect(copyText).toHaveBeenCalledWith('winget install Git.Git')
    openDialog.mockResolvedValueOnce('D:/tools/git.exe')
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: 'Choose git.exe…' })))
    expect(api.setGitPath).toHaveBeenCalledWith('D:/tools/git.exe')
    await flush()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Check again hides the banner once git is found', async () => {
    gitLocation = { path: null, version: null, problem: { kind: 'missing' }, settingIgnored: false }
    wrap(<GitBanner />)
    const banner = await screen.findByRole('alert')
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: 'Check again' })))
    expect(api.recheckGit).toHaveBeenCalled()
    await flush()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Check again says so when git is still missing, so it does not look like nothing happened', async () => {
    gitLocation = { path: null, version: null, problem: { kind: 'missing' }, settingIgnored: false }
    vi.mocked(api.recheckGit).mockResolvedValueOnce(gitLocation)
    wrap(<GitBanner />)
    const banner = await screen.findByRole('alert')
    await act(async () => fireEvent.click(within(banner).getByRole('button', { name: 'Check again' })))
    await flush()
    expect(api.recheckGit).toHaveBeenCalled()
    expect(useApp.getState().toasts.at(-1)).toMatchObject({ kind: 'error', message: "Git still wasn't found." })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('too old: says which version was found and which is needed (fact 13)', async () => {
    gitLocation = {
      path: 'C:/old/git.exe',
      version: '2.20.1.windows.1',
      problem: { kind: 'tooOld', found: '2.20.1.windows.1' },
      settingIgnored: false,
    }
    wrap(<GitBanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Git 2.20.1.windows.1 is too old. Gitr needs 2.27 or newer. Update it with winget install Git.Git',
    )
  })

  it('no banner when git is fine', async () => {
    wrap(<GitBanner />)
    await flush()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
