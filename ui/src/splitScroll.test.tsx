import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileDiff } from './types'

vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))

const LONG_OLD = 'old ' + 'x'.repeat(150)
const diff: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'remove', oldNo: 1, newNo: null, text: LONG_OLD },
        { kind: 'add', oldNo: null, newNo: 1, text: 'new\tline' },
        { kind: 'context', oldNo: 2, newNo: 2, text: 'same' },
      ],
    },
  ],
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
const { DiffView, sideWidths } = await import('./components/DiffView')

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

describe('split diff without wrapping', () => {
  it('measures each side by its own lines', () => {
    expect(sideWidths(diff)).toEqual([LONG_OLD.length, 'new\tline'.length + 4])
  })

  it('gives each half its own sideways scrollbar instead of widening the whole table', async () => {
    localStorage.setItem('diffMode', 'split')
    show()
    const table = (await screen.findAllByText('same', { selector: '.side-text' }))[0].closest('table') as HTMLTableElement
    expect(table).toHaveClass('side-scroll')
    // The table no longer grows to fit the longest line: each half stays half the pane.
    expect(table.style.width).toBe('')
    const left = screen.getByTestId('split-scrollbar-left')
    const right = screen.getByTestId('split-scrollbar-right')
    expect((left.firstChild as HTMLElement).style.width).toContain(`${LONG_OLD.length}ch`)
    expect((right.firstChild as HTMLElement).style.width).toContain('12ch')
    // Scrolling one half moves only that half's lines.
    left.scrollLeft = 300
    fireEvent.scroll(left)
    expect(table.style.getPropertyValue('--sx-0')).toBe('-300px')
    expect(table.style.getPropertyValue('--sx-1')).toBe('')
  })

  it('moves both halves together on a sideways wheel or Shift + wheel', async () => {
    localStorage.setItem('diffMode', 'split')
    show()
    const table = (await screen.findAllByText('same', { selector: '.side-text' }))[0].closest('table') as HTMLTableElement
    const left = screen.getByTestId('split-scrollbar-left')
    const right = screen.getByTestId('split-scrollbar-right')
    fireEvent.wheel(table, { deltaX: 50 })
    expect([left.scrollLeft, right.scrollLeft]).toEqual([50, 50])
    fireEvent.wheel(table, { deltaY: 30, shiftKey: true })
    expect([left.scrollLeft, right.scrollLeft]).toEqual([80, 80])
    // A plain wheel scrolls up and down, not sideways.
    fireEvent.wheel(table, { deltaY: 30 })
    expect([left.scrollLeft, right.scrollLeft]).toEqual([80, 80])
  })

  it('has no side scrollbars when lines wrap', async () => {
    localStorage.setItem('diffMode', 'split')
    localStorage.setItem('diffWrap', 'on')
    show()
    await screen.findAllByText('same')
    expect(screen.queryByTestId('split-scrollbar-left')).toBeNull()
  })
})
