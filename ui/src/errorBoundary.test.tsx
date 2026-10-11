import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './components/ErrorBoundary'

let explode = true
function Bomb() {
  if (explode) throw new Error('boom')
  return <p>fine</p>
}

describe('ErrorBoundary', () => {
  afterEach(cleanup)

  it('shows a recoverable message instead of a blank window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    explode = true
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('unexpected error')
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    explode = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('fine')).toBeInTheDocument()
  })

  it('clears itself when the view changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    explode = true
    const { rerender } = render(
      <ErrorBoundary key="a">
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    explode = false
    rerender(
      <ErrorBoundary key="b">
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('fine')).toBeInTheDocument()
  })
})
