import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import { reloadLayout, useLayout } from './layout'
import type { RepoStatus } from './types'

const PATH = 'C:/w/layout'

vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: vi.fn(async () => ({ popup: vi.fn(() => Promise.resolve()) })) } }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(() => Promise.resolve(true)), open: vi.fn() }))

const file = (path: string) => ({ path, origPath: null, index: '.', worktree: 'M', untracked: false, conflicted: false })
const files = [file('README.md'), file('src/lib/a.ts'), file('src/lib/b.ts'), file('src/main.ts')]

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
const unstaged = () => screen.getByRole('list', { name: 'Unstaged files' })
const rowTexts = () => within(unstaged()).getAllByRole('listitem').map((li) => li.querySelector('.fname')?.textContent)
const saved = () => JSON.parse(localStorage.getItem('layout') ?? '{}')

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  reloadLayout()
  useApp.setState({ busy: {}, summaries: {}, toasts: [] })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('changed files as a tree', () => {
  it('is the default: folders first, single-folder chains folded, files under their folder', async () => {
    wrap(<Changes path={PATH} />)
    await screen.findByText('README.md')
    expect(rowTexts()).toEqual(['src', 'lib', 'a.ts', 'b.ts', 'main.ts', 'README.md'])
    expect(screen.getByRole('button', { name: 'Tree' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('collapses a folder, and its stage button stages every file in it', async () => {
    wrap(<Changes path={PATH} />)
    await screen.findByText('README.md')
    const lib = screen.getByRole('button', { name: 'lib' })
    fireEvent.click(lib)
    expect(lib).toHaveAttribute('aria-expanded', 'false')
    expect(rowTexts()).toEqual(['src', 'lib', 'main.ts', 'README.md'])
    const src = within(unstaged()).getAllByRole('listitem')[0]
    fireEvent.click(within(src).getByTitle('Stage folder'))
    await flush()
    expect(api.stage).toHaveBeenCalledWith(PATH, ['src/lib/a.ts', 'src/lib/b.ts', 'src/main.ts'])
  })

  it('arrow keys skip folder rows and the files of collapsed folders', async () => {
    wrap(<Changes path={PATH} />)
    fireEvent.click(await screen.findByText('a.ts'))
    fireEvent.click(screen.getByRole('button', { name: 'lib' }))
    unstaged().focus()
    fireEvent.keyDown(unstaged(), { key: 'ArrowDown' })
    expect(document.querySelector('.file-list li.active .fname')?.textContent).toBe('main.ts')
  })

  it('switches to the flat list, and remembers the choice', async () => {
    wrap(<Changes path={PATH} />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(rowTexts()).toEqual(['README.md', 'a.ts', 'b.ts', 'main.ts'])
    expect(saved().fileView).toBe('list')
    // As after a restart: the store starts over from what was saved.
    cleanup()
    const stored = localStorage.getItem('layout')!
    useLayout.setState({ fileView: 'tree' })
    localStorage.setItem('layout', stored)
    reloadLayout()
    wrap(<Changes path={PATH} />)
    await screen.findByText('README.md')
    expect(rowTexts()).toEqual(['README.md', 'a.ts', 'b.ts', 'main.ts'])
  })
})

describe('resizable panes', () => {
  it('the file list is resized by keyboard or drag, kept within bounds, remembered, and reset by Enter', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    wrap(<Changes path={PATH} />)
    await screen.findByText('README.md')
    const splitter = screen.getByRole('separator', { name: 'Resize the file list' })
    fireEvent.keyDown(splitter, { key: 'ArrowRight' })
    expect(saved().changesList).toBe(316)
    expect((document.querySelector('.changes') as HTMLElement).style.gridTemplateColumns).toContain('316px')

    fireEvent.pointerDown(splitter, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(splitter, { clientX: 2000, pointerId: 1 })
    fireEvent.pointerUp(splitter, { pointerId: 1 })
    // At most the pane's width less room for the diff.
    expect(saved().changesList).toBe(1000 - 320)

    cleanup()
    reloadLayout()
    wrap(<Changes path={PATH} />)
    await screen.findByText('README.md')
    expect((document.querySelector('.changes') as HTMLElement).style.gridTemplateColumns).toContain('680px')
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the file list' }), { key: 'Enter' })
    expect(saved().changesList).toBeUndefined()
    expect((document.querySelector('.changes') as HTMLElement).style.gridTemplateColumns).toBe('')
  })

  it('the split between the unstaged and staged lists is a remembered share', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    wrap(<Changes path={PATH} />)
    await screen.findByText('README.md')
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the unstaged and staged lists' }), { key: 'ArrowDown' })
    // 216 of the two lists' 400px.
    expect(saved().changesSplit).toBe(0.54)
    expect((document.querySelector('.file-section.unstaged') as HTMLElement).style.flexGrow).toBe('0.54')
  })

  it('ignores a malformed saved layout', () => {
    localStorage.setItem('layout', '{"fileView":"grid","sidebar":-4,"historyList":"wide"}')
    reloadLayout()
    const s = useLayout.getState()
    expect([s.fileView, s.sidebar, s.historyList]).toEqual(['tree', undefined, undefined])
  })
})
