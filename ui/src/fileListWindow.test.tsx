import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import { FILE_LIST_VIRTUAL_MIN } from './lib/rowWindow'
import type { CommitDetails, CommitFile, LogEntry, RepoStatus } from './types'

const PATH = 'C:/w/big'
const N = 3000

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), open: vi.fn() }))
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))

const name = (i: number) => `f${String(i).padStart(4, '0')}.ts`
const entry: LogEntry = {
  sha: 'a'.repeat(40),
  parents: ['b'.repeat(40)],
  authorName: 'Thandi',
  authorEmail: 't@example.com',
  authorTime: 1_700_000_000,
  subject: 'Big commit',
  refs: [],
  unpushed: false,
}
const commitFiles: CommitFile[] = Array.from({ length: N }, (_, i) => ({
  path: name(i),
  origPath: null,
  status: 'M',
  added: 1,
  removed: 1,
  binary: false,
}))
const details: CommitDetails = {
  ...entry,
  committerName: entry.authorName,
  committerEmail: entry.authorEmail,
  committerTime: entry.authorTime,
  message: 'Big commit',
  files: commitFiles,
  truncated: false,
}
let changed = Array.from({ length: N }, (_, i) => ({
  path: name(i),
  origPath: null,
  index: '.',
  worktree: 'M',
  untracked: false,
  conflicted: false,
}))

vi.mock('./api', () => ({
  api: {
    status: vi.fn(() => Promise.resolve({ branch: 'main', files: changed } as unknown as RepoStatus)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    fileDiffSyntax: vi.fn(() => Promise.resolve({ old: {}, new: {} })),
    commitFileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    commitFileDiffSyntax: vi.fn(() => Promise.resolve({ old: {}, new: {} })),
    log: vi.fn(() => Promise.resolve({ commits: [entry], hasMore: false })),
    commitDetails: vi.fn(() => Promise.resolve(details)),
    stage: vi.fn(() => Promise.resolve()),
    unstage: vi.fn(() => Promise.resolve()),
    discard: vi.fn(() => Promise.resolve({ failed: [] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { Changes } = await import('./components/Changes')
const { History } = await import('./components/History')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))

// jsdom lays nothing out: give every element some height, and let scrollTo move the scroll position.
const sizes = ['clientHeight', 'offsetHeight', 'scrollHeight'] as const
const saved = sizes.map(
  (k) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, k) ?? Object.getOwnPropertyDescriptor(Element.prototype, k)!,
)
const scrollTo = Element.prototype.scrollTo
beforeEach(() => {
  for (const k of sizes)
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => (k === 'scrollHeight' ? 1_000_000 : 800) })
  Element.prototype.scrollTo = function (this: Element, o?: ScrollToOptions | number) {
    // jsdom ignores assignments to scrollTop: keep the position on the element itself.
    Object.defineProperty(this, 'scrollTop', { configurable: true, writable: true, value: typeof o === 'object' ? (o.top ?? 0) : 0 })
    this.dispatchEvent(new Event('scroll'))
  } as typeof Element.prototype.scrollTo
  vi.clearAllMocks()
  localStorage.clear()
  useApp.setState({ busy: {}, summaries: {}, toasts: [] })
})
afterEach(cleanup)
afterAll(() => {
  sizes.forEach((k, i) => Object.defineProperty(HTMLElement.prototype, k, saved[i]))
  Element.prototype.scrollTo = scrollTo
})

const unstaged = () => document.querySelector('.file-section.unstaged .file-list') as HTMLElement
const rowsOf = (list: HTMLElement) => [...list.querySelectorAll('li:not(.row-gap)')]
const names = (list: HTMLElement) => [...list.querySelectorAll('li:not(.row-gap) .fname')].map((e) => e.textContent)
const gap = (list: HTMLElement, which: 'first' | 'last') => {
  const g = list.querySelector(`li.row-gap:${which}-child`) as HTMLElement | null
  return g ? Number.parseFloat(g.style.height) : 0
}

describe('a long list of changed files', () => {
  it('draws only the rows in view and leaves room for the rest', async () => {
    wrap(<Changes path={PATH} />)
    await screen.findByText(name(0))
    await flush()
    const drawn = rowsOf(unstaged())
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThan(200)
    expect(screen.queryByText(name(N - 1))).toBeNull()
    // The count still says how many there are, and the rows not drawn take their room.
    expect(document.querySelector('.file-section.unstaged .count')).toHaveTextContent(String(N))
    expect(gap(unstaged(), 'last')).toBe((N - drawn.length) * 28)
    expect(gap(unstaged(), 'first')).toBe(0)
    expect(unstaged().querySelector('.row-gap')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws a short list whole', async () => {
    changed = changed.slice(0, FILE_LIST_VIRTUAL_MIN)
    wrap(<Changes path={PATH} />)
    await screen.findByText(name(FILE_LIST_VIRTUAL_MIN - 1))
    expect(rowsOf(unstaged())).toHaveLength(FILE_LIST_VIRTUAL_MIN)
    expect(unstaged().querySelector('.row-gap')).toBeNull()
  })

  it('keeps the selected file in view as the arrow keys move past the drawn rows', async () => {
    changed = Array.from({ length: N }, (_, i) => ({
      path: name(i),
      origPath: null,
      index: '.',
      worktree: 'M',
      untracked: false,
      conflicted: false,
    }))
    wrap(<Changes path={PATH} />)
    fireEvent.click(await screen.findByText(name(0)))
    for (let i = 0; i < 150; i++) fireEvent.keyDown(unstaged(), { key: 'ArrowDown' })
    await flush()
    const active = unstaged().querySelector('li.active .fname')
    expect(active).toHaveTextContent(name(150))
    // The list scrolled with it: the first rows are no longer drawn.
    expect(names(unstaged())).not.toContain(name(0))
    expect(gap(unstaged(), 'first')).toBeGreaterThan(0)
  })
})

describe('a commit with many files', () => {
  it('draws only the rows in view, each with its place among all of them', async () => {
    wrap(<History path={PATH} remote={null} />)
    const tree = await screen
      .findByRole('listbox', { name: 'Changed files' })
      .catch(() => screen.findByRole('tree', { name: 'Changed files' }))
    await flush()
    // List view: the files are options.
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    await flush()
    const list = screen.getByRole('listbox', { name: 'Changed files' })
    const rows = within(list).getAllByRole('option') // the gaps are hidden, so they are not options
    expect(rows.length).toBeLessThan(200)
    expect(rows[0]).toHaveAttribute('aria-posinset', '1')
    expect(rows[0]).toHaveAttribute('aria-setsize', String(N))
    expect(screen.queryByText(name(N - 1))).toBeNull()
    // The row the screen reader is on is drawn.
    const activeId = list.getAttribute('aria-activedescendant')!
    expect(document.getElementById(activeId)).not.toBeNull()
    expect(tree).toBeTruthy()
  })
})
