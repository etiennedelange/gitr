import css from './index.css?raw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { Branch, Config, RepoStatus } from './types'

const menus: { items: { text?: string; item?: string; enabled?: boolean }[] }[] = []
vi.mock('@tauri-apps/api/menu', () => ({
  Menu: {
    new: vi.fn(async (opts: { items: { text?: string; item?: string; enabled?: boolean }[] }) => {
      menus.push(opts)
      return { popup: vi.fn(() => Promise.resolve()) }
    }),
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(() => Promise.resolve(false)), open: vi.fn() }))

const config: Config = {
  groups: [{ id: 'g', name: 'Work', roots: ['C:/w'] }],
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
const status: RepoStatus = {
  branch: 'main',
  files: [{ path: 'src/a.ts', origPath: null, index: '.', worktree: 'M', untracked: false, conflicted: false }],
} as unknown as RepoStatus
const branches: Branch[] = [
  { name: 'main', remote: false, isHead: true, upstream: null, ahead: 0, behind: 0, gone: false, sha: 'a', committedAt: 0 },
  { name: 'feature', remote: false, isHead: false, upstream: null, ahead: 0, behind: 0, gone: false, sha: 'b', committedAt: 0 },
]

vi.mock('./api', () => ({
  api: {
    getConfig: vi.fn(() => Promise.resolve(config)),
    listRepos: vi.fn(() => Promise.resolve([{ path: 'C:/w/repo', name: 'repo', groupId: 'g' }])),
    status: vi.fn(() => Promise.resolve(status)),
    lineStats: vi.fn(() => Promise.resolve({ staged: [], unstaged: [] })),
    branches: vi.fn(() => Promise.resolve(branches)),
    fileDiff: vi.fn(() =>
      Promise.resolve({
        binary: false,
        truncated: false,
        hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'add', text: 'hello', oldNo: null, newNo: 1 }] }],
      }),
    ),
    lastCommitMessage: vi.fn(() => Promise.resolve('')),
    listModels: vi.fn(() => Promise.resolve([])),
    openDevtools: vi.fn(() => Promise.resolve(true)),
    devtoolsAvailable: vi.fn(() => Promise.resolve(false)),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { Sidebar } = await import('./components/Sidebar')
const { Changes } = await import('./components/Changes')
const { Branches } = await import('./components/Branches')
const { Toasts } = await import('./components/Toasts')
const { Settings } = await import('./components/Settings')
const { installNativeGuards, isEditable } = await import('./lib/nativeGuards')
const { inputMenu } = await import('./lib/menus')
const { showMenu } = await import('./nativeMenu')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

const texts = (i = -1) => menus.at(i)!.items.map((x) => x.text ?? x.item)
const rightClick = async (el: Element) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  await act(async () => {
    el.dispatchEvent(e)
  })
  return e
}

describe('native context menus', () => {
  let uninstall = () => {}
  beforeEach(() => {
    menus.length = 0
    useApp.setState({ devtools: false, summaries: {}, toasts: [] })
    // Same fallback App installs.
    uninstall = installNativeGuards(window, {
      onDevtools: () => {},
      onContextMenu: (e) => void showMenu(isEditable(e.target) ? inputMenu() : []),
    })
  })
  afterEach(() => {
    uninstall()
    cleanup()
  })

  it('repo in the sidebar shows the repo menu', async () => {
    wrap(<Sidebar />)
    const e = await rightClick(await screen.findByText('repo'))
    expect(e.defaultPrevented).toBe(true)
    expect(texts()).toEqual([
      'Open',
      'Separator',
      'Fetch',
      'Pull',
      'Push',
      'Separator',
      'Open in Explorer',
      'Open in Terminal',
      'Open in VS Code',
      'Open in browser',
      'Separator',
      'Copy path',
    ])
  })

  it('changed file shows the file menu and becomes selected', async () => {
    wrap(<Changes path="C:/w/repo" />)
    const name = await screen.findByText('a.ts', { selector: '.fname' })
    await rightClick(name)
    expect(texts()).toEqual(['Stage', 'Discard…', 'Separator', 'Copy path'])
    expect(name.closest('li')).toHaveClass('active')
  })

  it('branch shows the branch menu with head disabled items', async () => {
    wrap(<Branches path="C:/w/repo" remote={null} />)
    await rightClick(await screen.findByText('main'))
    const m = menus.at(-1)!.items
    expect(m.find((x) => x.text === 'Checkout')?.enabled).toBe(false)
    expect(m.find((x) => x.text === 'Delete…')?.enabled).toBe(false)
    expect(texts()).toContain('Copy name')
  })

  it('diff shows Copy, input shows edit items, plain UI shows nothing', async () => {
    wrap(<Changes path="C:/w/repo" />)
    fireEvent.click(await screen.findByText('a.ts', { selector: '.fname' }))
    await rightClick(await screen.findByText('hello'))
    expect(texts()).toEqual(['Copy'])
    expect(menus.at(-1)!.items[0].enabled).toBe(false)

    await rightClick(document.querySelector('textarea')!)
    expect(texts()).toEqual(['Undo', 'Separator', 'Cut', 'Copy', 'Paste', 'Separator', 'Select all'])

    const count = menus.length
    const e = await rightClick(screen.getByText('Unstaged'))
    expect(e.defaultPrevented).toBe(true)
    expect(menus.length).toBe(count)
  })

  it('adds Inspect when dev tools are available, including on plain UI', async () => {
    useApp.setState({ devtools: true })
    wrap(<Changes path="C:/w/repo" />)
    await rightClick(await screen.findByText('a.ts', { selector: '.fname' }))
    expect(texts().slice(-2)).toEqual(['Separator', 'Inspect'])
    await rightClick(screen.getByText('Unstaged'))
    expect(texts()).toEqual(['Inspect'])
  })
})

describe('selection, inputs and cursor', () => {
  afterEach(cleanup)

  it('marks diff, paths, toasts and errors as selectable but not UI rows', async () => {
    useApp.setState({ toasts: [{ id: 1, kind: 'error', message: 'Committed abc1234', detail: 'trace' }] })
    wrap(
      <>
        <Changes path="C:/w/repo" />
        <Toasts />
      </>,
    )
    const name = await screen.findByText('a.ts', { selector: '.fname' })
    fireEvent.click(name)
    expect((await screen.findByText('hello')).closest('td')).toHaveClass('selectable')
    expect(document.querySelector('.diff-path')?.closest('.selectable')).not.toBeNull()
    expect(screen.getByText('Committed abc1234')).toHaveClass('selectable')
    fireEvent.click(screen.getByText('details'))
    expect(screen.getByText('trace')).toHaveClass('selectable')
    expect(name.closest('.selectable')).toBeNull()
    expect(screen.getByText('Stage all').closest('.selectable')).toBeNull()
  })

  it('text inputs have spellcheck/autofill off; commit box keeps spellcheck', async () => {
    wrap(
      <>
        <Sidebar />
        <Changes path="C:/w/repo" />
        <Branches path="C:/w/repo" remote={null} />
        <Settings />
      </>,
    )
    await screen.findByText('a.ts', { selector: '.fname' })
    await screen.findByLabelText(/Scan depth/)
    const inputs = [...document.querySelectorAll('input')].filter((i) => !['checkbox', 'radio'].includes(i.type))
    expect(inputs.length).toBeGreaterThanOrEqual(5)
    for (const i of inputs) {
      expect(i).toHaveAttribute('spellcheck', 'false')
      expect(i).toHaveAttribute('autocomplete', 'off')
    }
    const ta = document.querySelector('textarea')!
    expect(ta).toHaveAttribute('spellcheck', 'true')
    expect(ta).toHaveAttribute('autocomplete', 'off')
  })

  it('CSS disables selection and drag on UI and never uses the hand cursor', () => {
    expect(css).not.toMatch(/cursor:\s*pointer/)
    expect(css).toMatch(/body\s*\{[^}]*user-select:\s*none/)
    expect(css).toMatch(/body\s*\{[^}]*cursor:\s*default/)
    expect(css).toMatch(/\.selectable[^{]*\{[^}]*user-select:\s*text/)
    expect(css).toMatch(/input,\s*textarea[^{]*\{[^}]*user-select:\s*text/)
    expect(css).toMatch(/-webkit-user-drag:\s*none/)
  })
})
