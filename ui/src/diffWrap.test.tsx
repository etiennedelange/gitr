import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileDiff } from './types'

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
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { DiffView } = await import('./components/DiffView')

const worktree = { kind: 'worktree', path: 'a.ts', origPath: null, staged: false, untracked: false } as const
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DiffView repo="D:/w/alpha" source={worktree} />
    </QueryClientProvider>,
  )

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('diff line wrapping', () => {
  it('is off by default and the button turns it on and off, remembered', async () => {
    const { container } = show()
    await waitFor(() => expect(container.querySelector('table.hunk')).not.toBeNull())
    const table = () => container.querySelector('table.hunk') as HTMLElement
    expect(table().classList.contains('wrap')).toBe(false)
    const btn = screen.getByRole('button', { name: 'Wrap long lines' })
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(btn)
    expect(table().classList.contains('wrap')).toBe(true)
    expect(localStorage.getItem('diffWrap')).toBe('on')
    fireEvent.click(btn)
    expect(table().classList.contains('wrap')).toBe(false)
  })

  it('scrolls each side of an unwrapped split on its own, and has no bars when wrapped', async () => {
    localStorage.setItem('diffMode', 'split')
    const { container } = show()
    await waitFor(() => expect(container.querySelector('table.hunk.split')).not.toBeNull())
    const bars = () => container.querySelectorAll('.split-bar')
    expect(bars()).toHaveLength(2)
    const frame = container.querySelector('.split-frame') as HTMLElement
    const [left, right] = Array.from(bars()) as HTMLElement[]
    left.scrollLeft = 40
    fireEvent.scroll(left)
    expect(frame.style.getPropertyValue('--sx-l')).toBe('-40px')
    expect(frame.style.getPropertyValue('--sx-r')).toBe('')
    right.scrollLeft = 7
    fireEvent.scroll(right)
    expect(frame.style.getPropertyValue('--sx-r')).toBe('-7px')
    fireEvent.click(screen.getByRole('button', { name: 'Wrap long lines' }))
    expect(bars()).toHaveLength(0)
  })
})
