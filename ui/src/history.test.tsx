import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { CommitDetails, LogEntry, LogPage, RepoSummary, ResetPreview } from './types'

const PATH = 'D:/Repos/work/api'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
const ask = vi.fn<(q: string, o?: { okLabel?: string; title?: string }) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: { okLabel?: string }) => ask(q, o), open: vi.fn() }))
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn(() => Promise.resolve()) }))
// jsdom has no layout: render every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, key: i, size: 44, start: i * 44 })),
    scrollToIndex: () => {},
  }),
}))

const sha = (n: number) => String(n).repeat(40).slice(0, 40)
const entry = (n: number, e: Partial<LogEntry> = {}): LogEntry => ({
  sha: sha(n),
  parents: [sha(n + 1)],
  authorName: 'Thandi Mokoena',
  authorEmail: 'thandi@example.com',
  authorTime: Math.floor(Date.now() / 1000) - n * 3600,
  subject: `Commit ${n}`,
  refs: [],
  unpushed: false,
  ...e,
})
const details = (c: LogEntry): CommitDetails => ({
  sha: c.sha,
  parents: c.parents,
  authorName: c.authorName,
  authorEmail: c.authorEmail,
  authorTime: c.authorTime,
  committerName: c.authorName,
  committerEmail: c.authorEmail,
  committerTime: c.authorTime,
  message: `${c.subject}\n\nWhy it changed.\n`,
  files: [
    { path: 'src/a.ts', origPath: null, status: 'M', added: 4, removed: 1, binary: false },
    { path: 'src/new/b.ts', origPath: 'src/old/b.ts', status: 'R', added: 0, removed: 0, binary: false },
  ],
  truncated: false,
})

let pages: LogPage[] = []
let preview: ResetPreview = { leaving: 1, unpushed: 0, onUpstream: 0 }
const summary = (s: Partial<RepoSummary> = {}): RepoSummary => ({
  path: PATH,
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

vi.mock('./api', () => ({
  api: {
    log: vi.fn((_p: string, skip: number) => Promise.resolve(pages[skip === 0 ? 0 : 1] ?? { commits: [], hasMore: false })),
    commitDetails: vi.fn((_p: string, s: string) => {
      const c = pages.flatMap((p) => p.commits).find((x) => x.sha === s)!
      return Promise.resolve(details(c))
    }),
    commitFileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    resetPreview: vi.fn(() => Promise.resolve(preview)),
    resetBranch: vi.fn(() => Promise.resolve(sha(1))),
    undoReset: vi.fn(() => Promise.resolve()),
    revertCommit: vi.fn(() => Promise.resolve({ kind: 'done' })),
    openRemote: vi.fn(() => Promise.resolve('')),
  },
  errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? (e as { message: string }).message : String(e)),
  errorDetail: () => null,
  asCmdError: (e: unknown) => (e && typeof e === 'object' && 'kind' in e ? e : null),
}))

const { api } = await import('./api')
const { History } = await import('./components/History')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const lastToast = () => useApp.getState().toasts.at(-1)

beforeEach(() => {
  vi.clearAllMocks()
  pages = [
    {
      commits: [
        entry(1, { unpushed: true, refs: [{ kind: 'head', name: 'main' }] }),
        entry(2, {
          refs: [
            { kind: 'remote', name: 'origin/main' },
            { kind: 'tag', name: 'v1.0' },
          ],
        }),
        entry(3, { parents: [sha(4), sha(9)], subject: "Merge branch 'fix'" }),
        entry(4, { parents: [] }),
      ],
      hasMore: false,
    },
  ]
  preview = { leaving: 1, unpushed: 0, onUpstream: 0 }
  useApp.setState({ summaries: { [PATH]: summary({ ahead: 1 }) }, busy: {}, toasts: [], resets: {} })
})
afterEach(cleanup)

describe('commit list', () => {
  it('shows commits on the commit line with refs, unpushed and merge markers', async () => {
    wrap(<History path={PATH} remote={null} />)
    const list = await screen.findByRole('listbox', { name: 'Commits on main' })
    const rows = within(list).getAllByRole('option')
    expect(rows).toHaveLength(4)
    expect(within(rows[0]).getByText('not pushed')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('img', { name: 'HEAD, not pushed' })).toBeInTheDocument()
    // One chip, then "+n" for the rest, so the subject keeps its room.
    expect(within(rows[1]).getByText('v1.0')).toBeInTheDocument()
    expect(within(rows[1]).getByTitle('origin/main')).toHaveTextContent('+1')
    expect(within(rows[1]).queryByText('not pushed')).toBeNull()
    expect(within(rows[2]).getByText('merge')).toBeInTheDocument()
    expect(rows[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('selects with the arrow keys and moves to the files with Enter', async () => {
    wrap(<History path={PATH} remote={null} />)
    const list = await screen.findByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'End' })
    expect(within(list).getAllByRole('option')[3]).toHaveAttribute('aria-selected', 'true')
    const files = await screen.findByRole('tree', { name: 'Changed files' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(document.activeElement).toBe(files)
  })

  it('loads the next page once the end of the loaded commits is in view', async () => {
    pages = [
      { commits: [entry(1), entry(2)], hasMore: true },
      { commits: [entry(3)], hasMore: false },
    ]
    wrap(<History path={PATH} remote={null} />)
    await vi.waitFor(() => expect(api.log).toHaveBeenCalledWith(PATH, 2, 200))
    expect(await screen.findByText('Commit 3')).toBeInTheDocument()
  })

  it('says so on a branch with no commits', async () => {
    pages = [{ commits: [], hasMore: false }]
    wrap(<History path={PATH} remote={null} />)
    expect(await screen.findByText('No commits yet')).toBeInTheDocument()
  })
})

describe('commit pane', () => {
  it('shows the message, files and the diff of the first file from the commit', async () => {
    wrap(<History path={PATH} remote={null} />)
    expect(await screen.findByText('Why it changed.')).toBeInTheDocument()
    // A folder tree by default: the folder's row, then its files under it.
    const files = await screen.findByRole('tree', { name: 'Changed files' })
    const items = within(files).getAllByRole('treeitem')
    expect(items[0]).toHaveTextContent('src')
    expect(items[0]).toHaveAttribute('aria-expanded', 'true')
    expect(within(files).getByText('a.ts')).toBeInTheDocument()
    expect(within(files).getByText('from src/old/b.ts')).toBeInTheDocument()
    // The first file the tree shows: folders come before files, so src/new/b.ts.
    await vi.waitFor(() => expect(api.commitFileDiff).toHaveBeenCalledWith(PATH, sha(1), 'src/new/b.ts', 'src/old/b.ts'))
    // Collapsing the folder hides its files.
    fireEvent.click(items[0])
    expect(within(files).queryByText('a.ts')).toBeNull()
    fireEvent.click(items[0])
    // The list view shows every file with its folder beside it.
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    const list = screen.getByRole('listbox', { name: 'Changed files' })
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('a.ts')
    expect(within(list).getByText('src')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }))
  })

  it('says a merge is shown against its first parent', async () => {
    wrap(<History path={PATH} remote={null} />)
    fireEvent.click(await screen.findByText("Merge branch 'fix'"))
    expect(await screen.findByText('vs first parent')).toBeInTheDocument()
    expect(screen.getByText('Parents')).toBeInTheDocument()
  })
})

describe('revert', () => {
  it('asks first, then reverts and reports it', async () => {
    wrap(<History path={PATH} remote={null} />)
    await screen.findByText('Why it changed.')
    ask.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: /Revert/ }))
    await flush()
    expect(api.revertCommit).not.toHaveBeenCalled()
    ask.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: /Revert/ }))
    await vi.waitFor(() => expect(api.revertCommit).toHaveBeenCalledWith(PATH, sha(1)))
    expect(ask.mock.calls[0][1]?.okLabel).toBe('Revert')
    await vi.waitFor(() => expect(lastToast()?.message).toBe(`Reverted ${sha(1).slice(0, 7)}`))
  })

  it('is unavailable while the repo is busy or an operation is in progress', async () => {
    useApp.setState({ summaries: { [PATH]: summary({ operation: 'merging' }) } })
    wrap(<History path={PATH} remote={null} />)
    await screen.findByText('Why it changed.')
    expect(screen.getByRole('button', { name: /Revert/ })).toBeDisabled()
  })
})

describe('reset', () => {
  it("can't reset to the commit the branch is already on", async () => {
    wrap(<History path={PATH} remote={null} />)
    await screen.findByText('Why it changed.')
    expect(screen.getByRole('button', { name: /Reset to here/ })).toBeDisabled()
  })

  it('defaults to keeping changes unstaged, starts on Cancel, and warns only when it applies', async () => {
    preview = { leaving: 2, unpushed: 1, onUpstream: 1 }
    wrap(<History path={PATH} remote={null} />)
    fireEvent.click(await screen.findByText("Merge branch 'fix'"))
    fireEvent.click(await screen.findByRole('button', { name: /Reset to here/ }))
    const dialog = await screen.findByRole('dialog', { name: /Reset main to/ })
    expect(await within(dialog).findByText(/2 commits leave the branch/)).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /Keep changes unstaged/ })).toBeChecked()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).getByText(/1 of them is not on any remote/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Gitr never force-pushes/)).toBeInTheDocument()
  })

  it('has no warnings when the commits leaving are only local and none is unpushed', async () => {
    preview = { leaving: 1, unpushed: 0, onUpstream: 0 }
    wrap(<History path={PATH} remote={null} />)
    fireEvent.click(await screen.findByText('Commit 2'))
    fireEvent.click(await screen.findByRole('button', { name: /Reset to here/ }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText(/1 commit leaves the branch/)
    expect(within(dialog).queryByText(/not on any remote/)).toBeNull()
    expect(within(dialog).queryByText(/force-pushes/)).toBeNull()
  })

  it('resets in the chosen mode, then offers Undo in the toast and above the list', async () => {
    wrap(<History path={PATH} remote={null} />)
    fireEvent.click(await screen.findByText('Commit 2'))
    fireEvent.click(await screen.findByRole('button', { name: /Reset to here/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('radio', { name: /Keep changes staged/ }))
    await within(dialog).findByText(/leaves the branch/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset main' }))
    await vi.waitFor(() => expect(api.resetBranch).toHaveBeenCalledWith(PATH, sha(2), 'soft'))
    await vi.waitFor(() => expect(lastToast()?.action?.label).toBe('Undo'))
    const undo = await screen.findByRole('button', { name: 'Undo reset' })
    fireEvent.click(undo)
    await vi.waitFor(() => expect(api.undoReset).toHaveBeenCalledWith(PATH, sha(1)))
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Undo reset' })).toBeNull())
  })

  it('forgets the reset once another write starts on the repo', async () => {
    useApp.getState().setReset(PATH, { previousHead: sha(1), label: 'main back to 2222222' })
    wrap(<History path={PATH} remote={null} />)
    expect(await screen.findByRole('button', { name: 'Undo reset' })).toBeInTheDocument()
    act(() => useApp.getState().setRepoBusy(PATH, 'committing'))
    expect(screen.queryByRole('button', { name: 'Undo reset' })).toBeNull()
  })
})
