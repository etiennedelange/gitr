import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { FileDiff } from './types'

vi.mock('./nativeMenu', () => ({ showMenu: vi.fn(), copyText: vi.fn() }))

const diff: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,2 +1,3 @@',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'context', oldNo: 1, newNo: 1, text: 'Invoice total' },
        { kind: 'remove', oldNo: 2, newNo: null, text: 'old invoice' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'new INVOICE and invoice again' },
      ],
    },
  ],
}
vi.mock('./api', () => ({
  api: {
    fileDiff: vi.fn(() => Promise.resolve(diff)),
    fileDiffSyntax: vi.fn(() => Promise.resolve({ old: {}, new: { 2: [[0, 3, 'keyword']] } })),
  },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { DiffView, diffItems, findMatches } = await import('./components/DiffView')

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DiffView repo="D:/w/alpha" source={{ kind: 'worktree', path: 'a.ts', origPath: null, staged: false, untracked: false }} />
    </QueryClientProvider>,
  )

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('findMatches', () => {
  const items = diffItems(diff, 'unified', true)
  it('finds every occurrence in reading order, ignoring case unless asked', () => {
    expect(findMatches(items, 'invoice', false).map((m) => [m.item, m.start])).toEqual([
      [1, 0],
      [2, 4],
      [3, 4],
      [3, 16],
    ])
    expect(findMatches(items, 'invoice', true).map((m) => m.item)).toEqual([2, 3])
  })
  it('does not search hunk headers and finds nothing for an empty query', () => {
    expect(findMatches(items, '@@', false)).toEqual([])
    expect(findMatches(items, '', false)).toEqual([])
  })
  it('finds both sides of a split row', () => {
    const split = diffItems(diff, 'split', true)
    expect(findMatches(split, 'invoice', false).map((m) => m.slot)).toEqual([0, 1, 0, 1, 1])
  })
})

describe('find in diff', () => {
  it('Ctrl+F opens the bar, marks matches and Enter steps through them', async () => {
    const { container } = show()
    await screen.findByText('Invoice total')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = await screen.findByRole('textbox', { name: 'Find in diff' })
    fireEvent.change(input, { target: { value: 'invoice' } })
    expect(screen.getByRole('status')).toHaveTextContent('1 of 4')
    expect(container.querySelectorAll('mark.find-hit')).toHaveLength(4)
    expect(container.querySelectorAll('mark.find-hit.cur')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('status')).toHaveTextContent('2 of 4')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status')).toHaveTextContent('4 of 4')
  })

  it('says so when nothing matches, and Escape closes the bar', async () => {
    const { container } = show()
    await screen.findByText('Invoice total')
    fireEvent.click(screen.getByRole('button', { name: 'Find in diff' }))
    const input = await screen.findByRole('textbox', { name: 'Find in diff' })
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.getByRole('status')).toHaveTextContent('No results')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(container.querySelector('.diff-find')).toBeNull()
    expect(container.querySelectorAll('mark')).toHaveLength(0)
  })

  it('keeps syntax colours around a match', async () => {
    const { container } = show()
    await screen.findByText('Invoice total')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    fireEvent.change(await screen.findByRole('textbox', { name: 'Find in diff' }), { target: { value: 'new' } })
    await vi.waitFor(() => expect(container.querySelector('.tk-keyword mark.find-hit')).toHaveTextContent('new'))
  })
})
