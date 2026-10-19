import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DiffSyntax, FileDiff } from './types'

const PATH = 'D:/w/alpha'
vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))

const diff: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'remove', oldNo: 1, newNo: null, text: 'int count = 0;' },
        { kind: 'add', oldNo: null, newNo: 1, text: 'var total = "x";' },
        { kind: 'context', oldNo: 2, newNo: 2, text: '// done' },
      ],
    },
  ],
}
const syntax: DiffSyntax = {
  old: { 1: [[0, 3, 'keyword']] },
  new: {
    1: [
      [0, 3, 'keyword'],
      [12, 15, 'string'],
    ],
    // Context lines take the new file's colours, whatever the old one says.
    2: [[0, 7, 'comment']],
  },
}
vi.mock('./api', () => ({
  api: {
    fileDiff: vi.fn(() => Promise.resolve(diff)),
    fileDiffSyntax: vi.fn(() => Promise.resolve(syntax)),
    commitFileDiff: vi.fn(() => Promise.resolve(diff)),
    commitFileDiffSyntax: vi.fn(() => Promise.resolve({ old: {}, new: { 1: [[0, 3, 'keyword']], 2: [[0, 99, 'comment']] } })),
  },
  errorMessage: (e: unknown) => String(e),
}))
const { api } = await import('./api')
const { DiffView } = await import('./components/DiffView')

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
const tokens = (cls: string) => [...document.querySelectorAll(`.tk-${cls}`)].map((e) => e.textContent)

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('diff syntax colours', () => {
  it('colours removed lines from the old file and the rest from the new one', async () => {
    wrap(<DiffView repo={PATH} source={{ kind: 'worktree', path: 'a.cs', origPath: null, staged: true, untracked: false }} />)
    await vi.waitFor(() => expect(tokens('string')).toEqual(['"x"']))
    expect(tokens('keyword')).toEqual(['int', 'var'])
    expect(tokens('comment')).toEqual(['// done'])
    expect(api.fileDiffSyntax).toHaveBeenCalledWith(PATH, 'a.cs', true, false)
    // The text itself is unchanged, so copying a line copies what the file says.
    expect(screen.getByText('"x"').closest('td')?.textContent).toBe('+var total = "x";')
  })

  it('colours both sides of the split view', async () => {
    localStorage.setItem('diffMode', 'split')
    wrap(<DiffView repo={PATH} source={{ kind: 'worktree', path: 'a.cs', origPath: null, staged: false, untracked: false }} />)
    await vi.waitFor(() => expect(tokens('keyword')).toEqual(['int', 'var']))
    // The context line shows on both sides, coloured the same.
    expect(tokens('comment')).toEqual(['// done', '// done'])
  })

  it('drops colours that no longer fit the text', async () => {
    wrap(<DiffView repo={PATH} source={{ kind: 'commit', sha: 'a'.repeat(40), path: 'a.cs', origPath: null }} />)
    await vi.waitFor(() => expect(tokens('keyword')).toEqual(['var']))
    expect(api.commitFileDiffSyntax).toHaveBeenCalledWith(PATH, 'a'.repeat(40), 'a.cs', null)
    expect(tokens('comment')).toEqual([])
    expect(screen.getByText('// done')).toBeInTheDocument()
  })
})
