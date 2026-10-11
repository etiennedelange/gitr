import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { RepoStatus } from './types'

const PATH = 'C:/w/keys'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
const ask = vi.fn<(q: string, o?: unknown) => Promise<boolean>>()
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: (q: string, o?: unknown) => ask(q, o), open: vi.fn() }))

const file = (path: string) => ({ path, origPath: null, index: '.', worktree: 'M', untracked: false, conflicted: false })
let files = [file('a.ts'), file('b.ts'), file('c.ts')]

vi.mock('./api', () => ({
  api: {
    status: vi.fn(() => Promise.resolve({ branch: 'main', files } as unknown as RepoStatus)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    fileDiff: vi.fn(() => Promise.resolve({ binary: false, truncated: false, hunks: [] })),
    stage: vi.fn(() => Promise.resolve()),
    unstage: vi.fn(() => Promise.resolve()),
    discard: vi.fn(() => Promise.resolve({ failed: [] })),
    lastCommitUndo: vi.fn(() => Promise.resolve(null)),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { api } = await import('./api')
const { Changes } = await import('./components/Changes')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)))
const unstagedList = () => document.querySelector('.file-section.unstaged .file-list') as HTMLElement
const stagedList = () => document.querySelector('.file-section.staged .file-list') as HTMLElement
const active = () => document.querySelector('.file-list li.active .fname')?.textContent

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ busy: {}, summaries: {}, toasts: [] })
  files = [file('a.ts'), file('b.ts'), file('c.ts')]
})
afterEach(cleanup)

const select = async (name: string) => {
  fireEvent.click(await screen.findByText(name))
  unstagedList().focus()
}

describe('file list keyboard flow', () => {
  it('moves the selection to the next file after Space stages one', async () => {
    wrap(<Changes path={PATH} />)
    await select('a.ts')
    await act(async () => fireEvent.keyDown(unstagedList(), { key: ' ' }))
    expect(api.stage).toHaveBeenCalledWith(PATH, ['a.ts'])
    expect(active()).toBe('b.ts')
  })

  it('falls back to the previous file when the last one is staged', async () => {
    wrap(<Changes path={PATH} />)
    await select('c.ts')
    await act(async () => fireEvent.keyDown(unstagedList(), { key: ' ' }))
    expect(active()).toBe('b.ts')
  })

  it('keeps the selection when a file other than the selected one is toggled with the mouse', async () => {
    wrap(<Changes path={PATH} />)
    await select('a.ts')
    await act(async () => fireEvent.click(screen.getAllByTitle('Stage')[2]))
    expect(api.stage).toHaveBeenCalledWith(PATH, ['c.ts'])
    expect(active()).toBe('a.ts')
  })

  it('moves focus to the other list when staging empties the focused one', async () => {
    files = [file('a.ts')]
    wrap(<Changes path={PATH} />)
    await select('a.ts')
    await act(async () => fireEvent.keyDown(unstagedList(), { key: ' ' }))
    expect(document.activeElement).toBe(stagedList())
  })

  it('moves the selection to a neighbour after the selected file is discarded', async () => {
    ask.mockResolvedValue(true)
    wrap(<Changes path={PATH} />)
    await select('b.ts')
    await act(async () => fireEvent.keyDown(unstagedList(), { key: 'Delete' }))
    await flush()
    expect(api.discard).toHaveBeenCalledWith(PATH, ['b.ts'], [])
    expect(active()).toBe('c.ts')
  })

  it('keeps the selection when the discard is declined', async () => {
    ask.mockResolvedValue(false)
    wrap(<Changes path={PATH} />)
    await select('b.ts')
    await act(async () => fireEvent.keyDown(unstagedList(), { key: 'Delete' }))
    await flush()
    expect(active()).toBe('b.ts')
  })
})

describe('row actions', () => {
  it('are only tab stops on the selected row, so Tab does not walk every file', async () => {
    wrap(<Changes path={PATH} />)
    await select('b.ts')
    const rows = Array.from(unstagedList().querySelectorAll('li'))
    const stops = rows.map((li) => Array.from(li.querySelectorAll('button')).every((b) => b.tabIndex === 0))
    expect(stops).toEqual([false, true, false])
  })
})

describe('row action buttons', () => {
  it('are left to the button: Space on Stage is not also handled by the list', async () => {
    wrap(<Changes path={PATH} />)
    await select('a.ts')
    const stage = unstagedList().querySelector('li.active button[title="Stage"]') as HTMLElement
    await act(async () => fireEvent.keyDown(stage, { key: ' ' }))
    expect(api.stage).not.toHaveBeenCalled()
  })
})
