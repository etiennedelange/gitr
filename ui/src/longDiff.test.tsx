import { afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DiffLine, FileDiff } from './types'

vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))
vi.mock('./api', () => ({
  api: { fileDiff: vi.fn(), fileDiffSyntax: vi.fn(), commitFileDiff: vi.fn(), commitFileDiffSyntax: vi.fn() },
  errorMessage: (e: unknown) => String(e),
}))
const { api } = await import('./api')
const { DiffView, VIRTUAL_MIN_ROWS, diffItems, widestLine } = await import('./components/DiffView')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const worktree = { kind: 'worktree', path: 'a.cs', origPath: null, staged: false, untracked: false } as const
const context = (no: number, text = `line ${no}`): DiffLine => ({ kind: 'context', oldNo: no, newNo: no, text })
const LONG = 'var widest = "' + 'x'.repeat(200) + '";'

/** A whole 5,000-line file with one long line in the middle. */
const whole: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,5000 +1,5000 @@',
      oldStart: 1,
      newStart: 1,
      lines: Array.from({ length: 5000 }, (_, i) => context(i + 1, i === 2500 ? LONG : undefined)),
    },
  ],
}

// jsdom lays nothing out: give every element (the diff pane among them) some height.
const clientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!
Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 800 })

afterAll(() => Object.defineProperty(Element.prototype, 'clientHeight', clientHeight))

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('a long diff', () => {
  it('draws only the rows in view, with the columns sized for every row', async () => {
    localStorage.setItem('diffExtent', 'full')
    vi.mocked(api.fileDiff).mockResolvedValue(whole)
    vi.mocked(api.fileDiffSyntax).mockResolvedValue({ old: {}, new: {} })
    wrap(<DiffView repo="D:/w/a" source={worktree} />)
    await screen.findByText('line 1')
    const drawn = document.querySelectorAll('.diff-body tr:not(.spacer):not(.sizer)')
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThan(200)
    expect(screen.queryByText('line 4000')).toBeNull()
    // The rows not drawn still take their room, and the widest line still sets the width.
    expect(document.querySelector('.diff-body tr.spacer')).not.toBeNull()
    const sizer = document.querySelector('.diff-body tr.sizer')!
    expect(sizer).toHaveAttribute('aria-hidden', 'true')
    expect(sizer.textContent).toContain(LONG)
    expect(sizer.textContent).toContain('5000')
  })

  it('draws a short diff whole', async () => {
    const short = { ...whole, hunks: [{ ...whole.hunks[0], lines: whole.hunks[0].lines.slice(0, VIRTUAL_MIN_ROWS - 1) }] }
    vi.mocked(api.fileDiff).mockResolvedValue(short)
    vi.mocked(api.fileDiffSyntax).mockResolvedValue({ old: {}, new: {} })
    wrap(<DiffView repo="D:/w/a" source={worktree} />)
    await screen.findByText(`line ${VIRTUAL_MIN_ROWS - 1}`)
    expect(document.querySelector('.diff-body tr.spacer, .diff-body tr.sizer')).toBeNull()
  })
})

describe('diff rows', () => {
  const two: FileDiff = {
    ...whole,
    hunks: [
      { header: '@@ -1 +1 @@', oldStart: 1, newStart: 1, lines: [context(1)] },
      { header: '@@ -9 +9 @@', oldStart: 9, newStart: 9, lines: [context(9)] },
    ],
  }

  it('puts a gap and a header before each hunk, and no headers for a whole file', () => {
    expect(diffItems(two, 'unified', true).map((i) => i.kind)).toEqual(['header', 'line', 'gap', 'header', 'line'])
    expect(diffItems(two, 'split', false).map((i) => i.kind)).toEqual(['pair', 'pair'])
  })

  it('finds the widest line, counting tabs to the next tab stop', () => {
    const diff = { ...two, hunks: [{ ...two.hunks[0], lines: [context(1, 'abcdefghij'), context(2, '\t\tx')] }] }
    expect(widestLine(diff)).toBe('\t\tx')
  })
})
