import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileDiff } from './types'
import { useApp } from './store'

vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))

const diff: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, lines: [{ kind: 'add', oldNo: null, newNo: 1, text: 'new' }] }],
}
vi.mock('./api', () => ({
  api: {
    fileDiff: vi.fn(() => Promise.resolve(diff)),
    fileDiffSyntax: vi.fn(() => Promise.resolve({ old: {}, new: {} })),
    setZoom: vi.fn((z: number) => Promise.resolve(z)),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { api } = await import('./api')
const { DiffView } = await import('./components/DiffView')
const { useWheelZoom } = await import('./useWheelZoom')

const worktree = { kind: 'worktree', path: 'a.ts', origPath: null, staged: false, untracked: false } as const
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="outside" tabIndex={0} />
      <DiffView repo="D:/w/alpha" source={worktree} />
    </QueryClientProvider>,
  )
const wheel = (target: EventTarget, deltaY: number) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}
const diffZoom = (c: HTMLElement) => (c.querySelector('.diff') as HTMLElement).style.getPropertyValue('--diff-zoom')

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
  useApp.setState({ zoom: 100 })
})

describe('diff text zoom', () => {
  it('Ctrl + wheel over the diff sizes the diff text, not the whole app', async () => {
    renderHook(() => useWheelZoom(100))
    const { container } = show()
    const body = await screen.findByRole('region', { name: /Diff of a\.ts/ })
    expect(wheel(body, -100).defaultPrevented).toBe(true)
    expect(diffZoom(container)).toBe('1.1')
    expect(useApp.getState().zoom).toBe(100)
    expect(api.setZoom).not.toHaveBeenCalled()
    expect(localStorage.getItem('diffZoom')).toBe('110')

    // Outside the diff the wheel still zooms the app.
    wheel(container.querySelector('.outside')!, -100)
    expect(useApp.getState().zoom).toBe(110)
    expect(diffZoom(container)).toBe('1.1')
  })

  it('Ctrl +/− step the diff text and Ctrl 0 or the level badge reset it; the size is remembered', async () => {
    const { container, unmount } = show()
    const body = await screen.findByRole('region', { name: /Diff of a\.ts/ })
    fireEvent.keyDown(body, { key: '=', ctrlKey: true })
    fireEvent.keyDown(body, { key: '=', ctrlKey: true })
    expect(diffZoom(container)).toBe('1.25')
    fireEvent.keyDown(body, { key: '-', ctrlKey: true })
    expect(diffZoom(container)).toBe('1.1')
    unmount()

    const again = show()
    expect(diffZoom(again.container)).toBe('1.1')
    fireEvent.click(screen.getByRole('button', { name: '110%' }))
    expect(diffZoom(again.container)).toBe('')
    expect(screen.queryByRole('button', { name: '110%' })).toBeNull()
    fireEvent.keyDown(again.container.querySelector('.diff')!, { key: '-', ctrlKey: true })
    expect(diffZoom(again.container)).toBe('0.9')
    fireEvent.keyDown(again.container.querySelector('.diff')!, { key: '0', ctrlKey: true })
    expect(diffZoom(again.container)).toBe('')
  })
})
