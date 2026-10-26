import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useApp } from './store'

vi.mock('./api', () => ({
  api: { pullStrategy: vi.fn(() => Promise.resolve('rebase')) },
  asCmdError: () => null,
}))
const { Toasts } = await import('./components/Toasts')

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Toasts />
    </QueryClientProvider>,
  )

beforeEach(() => {
  vi.useFakeTimers()
  useApp.setState({ toasts: [], busy: {} })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('toasts', () => {
  it('dismisses an info toast after a few seconds', () => {
    show()
    act(() => useApp.getState().toast('info', 'Committed abc'))
    expect(screen.getByText('Committed abc')).toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(4500))
    expect(screen.queryByText('Committed abc')).toBeNull()
  })

  it('keeps an info toast while the pointer is over it, then dismisses it', () => {
    show()
    act(() => useApp.getState().toast('info', 'Committed abc'))
    const toast = screen.getByText('Committed abc').closest('.toast') as HTMLElement
    fireEvent.mouseEnter(toast)
    act(() => void vi.advanceTimersByTime(10000))
    expect(screen.getByText('Committed abc')).toBeInTheDocument()
    fireEvent.mouseLeave(toast)
    act(() => void vi.advanceTimersByTime(4500))
    expect(screen.queryByText('Committed abc')).toBeNull()
  })

  it('announces info toasts through a polite live region that is always there', () => {
    show()
    const region = document.querySelector('.toasts') as HTMLElement
    expect(region.getAttribute('aria-live')).toBe('polite')
    act(() => useApp.getState().toast('info', 'Deleted feature'))
    expect(region.textContent).toContain('Deleted feature')
  })

  it('never auto-dismisses an error toast', () => {
    show()
    act(() => useApp.getState().toast('error', 'Push rejected'))
    act(() => void vi.advanceTimersByTime(60000))
    expect(screen.getByText('Push rejected')).toBeInTheDocument()
  })
})

describe('toast limit', () => {
  it('drops the oldest info toast before an unread error', () => {
    const { toast } = useApp.getState()
    toast('error', 'Push rejected')
    for (let i = 0; i < 5; i++) toast('info', `info ${i}`)
    const msgs = useApp.getState().toasts.map((t) => t.message)
    expect(msgs).toContain('Push rejected')
    expect(msgs).not.toContain('info 0')
    expect(msgs).toContain('info 4')
    expect(msgs.length).toBe(5)
  })
})

describe('repeated errors', () => {
  it('shows an identical error once instead of stacking copies', () => {
    const { toast } = useApp.getState()
    toast('error', 'Push rejected', 'detail')
    toast('error', 'Push rejected', 'detail')
    toast('error', 'Something else')
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Push rejected', 'Something else'])
  })
})
