import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
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
const { setDiffSpotlight } = await import('./experiments')

afterEach(() => {
  cleanup()
  setDiffSpotlight(false)
  localStorage.clear()
})

describe('spotlight diff (experiment)', () => {
  it('is off until switched on, and applies right away', async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DiffView repo="D:/w/alpha" source={{ kind: 'worktree', path: 'a.ts', origPath: null, staged: false, untracked: false }} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(container.querySelector('table.hunk')).not.toBeNull())
    const root = () => container.querySelector('.diff') as HTMLElement
    expect(root().classList.contains('spotlight')).toBe(false)
    act(() => setDiffSpotlight(true))
    expect(root().classList.contains('spotlight')).toBe(true)
    expect(localStorage.getItem('expDiffSpotlight')).toBe('on')
    act(() => setDiffSpotlight(false))
    expect(root().classList.contains('spotlight')).toBe(false)
  })
})
