import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileDiff } from './types'

const PATH = 'D:/w/alpha'
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))

const hunks: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -2,2 +2,2 @@ class A',
      oldStart: 2,
      newStart: 2,
      lines: [
        { kind: 'remove', oldNo: 2, newNo: null, text: 'old' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'new' },
        { kind: 'context', oldNo: 3, newNo: 3, text: 'after' },
      ],
    },
  ],
}
const whole: FileDiff = {
  ...hunks,
  hunks: [
    {
      header: '@@ -1,3 +1,3 @@',
      oldStart: 1,
      newStart: 1,
      lines: [{ kind: 'context', oldNo: 1, newNo: 1, text: 'first' }, ...hunks.hunks[0].lines],
    },
  ],
}
const pick = (full?: boolean) => Promise.resolve(full ? whole : hunks)
vi.mock('./api', () => ({
  api: {
    fileDiff: vi.fn((_p: string, _f: string, _s: boolean, _u: boolean, full?: boolean) => pick(full)),
    fileDiffSyntax: vi.fn(() => Promise.resolve({ old: {}, new: {} })),
    commitFileDiff: vi.fn((_p: string, _s: string, _f: string, _o: string | null, full?: boolean) => pick(full)),
    commitFileDiffSyntax: vi.fn(() => Promise.resolve({ old: {}, new: {} })),
  },
  errorMessage: (e: unknown) => String(e),
}))
const { api } = await import('./api')
const { DiffView } = await import('./components/DiffView')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const worktree = { kind: 'worktree', path: 'a.cs', origPath: null, staged: false, untracked: false } as const

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

describe('full file diff', () => {
  it('shows only the hunks by default, then the whole file with its changes inline', async () => {
    wrap(<DiffView repo={PATH} source={worktree} />)
    await screen.findByText('new')
    expect(screen.queryByText('first')).toBeNull()
    expect(screen.getByText('@@ -2,2 +2,2 @@ class A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hunks' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Full file' }))
    await screen.findByText('first')
    expect(api.fileDiff).toHaveBeenLastCalledWith(PATH, 'a.cs', false, false, true)
    expect(api.fileDiffSyntax).toHaveBeenLastCalledWith(PATH, 'a.cs', false, false, true)
    // The changes stay marked, and the one whole-file hunk needs no header.
    expect(screen.getByText('new').closest('tr')).toHaveClass('add')
    expect(screen.getByText('old').closest('tr')).toHaveClass('remove')
    expect(document.querySelector('.hunk-header')).toBeNull()
    expect(screen.getByRole('button', { name: 'Full file' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Hunks' }))
    await vi.waitFor(() => expect(screen.queryByText('first')).toBeNull())
    expect(screen.getByText('@@ -2,2 +2,2 @@ class A')).toBeInTheDocument()
  })

  it('is remembered, and applies to commit diffs and the split layout too', async () => {
    localStorage.setItem('diffExtent', 'full')
    localStorage.setItem('diffMode', 'split')
    wrap(<DiffView repo={PATH} source={{ kind: 'commit', sha: 'a'.repeat(40), path: 'a.cs', origPath: null }} />)
    await screen.findAllByText('first')
    expect(api.commitFileDiff).toHaveBeenCalledWith(PATH, 'a'.repeat(40), 'a.cs', null, true)
    expect(document.querySelector('.hunk.split')).not.toBeNull()
    expect(document.querySelector('.hunk-header')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Hunks' }))
    expect(localStorage.getItem('diffExtent')).toBe('hunks')
  })
})
