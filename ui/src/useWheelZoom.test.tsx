import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useApp } from './store'
import { useWheelZoom } from './useWheelZoom'

vi.mock('./api', () => ({
  api: { setZoom: vi.fn((z: number) => Promise.resolve(z)) },
  errorMessage: (e: unknown) => String(e),
  errorDetail: () => null,
  asCmdError: () => null,
}))
const { api } = await import('./api')

const wheel = (target: EventTarget, init: WheelEventInit) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

describe('useWheelZoom', () => {
  beforeEach(() => {
    vi.mocked(api.setZoom).mockClear()
    useApp.setState({ zoom: 100, toasts: [] })
  })
  afterEach(cleanup)

  it('seeds the store from the saved config once', () => {
    const { rerender } = renderHook(({ z }) => useWheelZoom(z), { initialProps: { z: 125 as number | undefined } })
    expect(useApp.getState().zoom).toBe(125)
    act(() => useApp.getState().setZoom(150))
    rerender({ z: 125 })
    expect(useApp.getState().zoom).toBe(150)
  })

  it('zooms on Ctrl+wheel on window and prevents scrolling', () => {
    renderHook(() => useWheelZoom(100))
    const e = wheel(window, { ctrlKey: true, deltaY: -100 })
    expect(e.defaultPrevented).toBe(true)
    expect(api.setZoom).toHaveBeenCalledWith(110)
    expect(useApp.getState().zoom).toBe(110)
    wheel(window, { ctrlKey: true, deltaY: 100 })
    expect(useApp.getState().zoom).toBe(100)
  })

  it('works over a focused textarea and nested scroll containers', () => {
    renderHook(() => useWheelZoom(100))
    const { container } = render(
      <div style={{ overflow: 'auto' }} data-testid="scroller">
        <textarea />
      </div>,
    )
    const textarea = container.querySelector('textarea')!
    textarea.focus()
    expect(wheel(textarea, { ctrlKey: true, deltaY: -100 }).defaultPrevented).toBe(true)
    expect(useApp.getState().zoom).toBe(110)
    const scroller = container.firstElementChild!
    expect(wheel(scroller, { ctrlKey: true, deltaY: -100 }).defaultPrevented).toBe(true)
    expect(useApp.getState().zoom).toBe(125)
    expect(api.setZoom).toHaveBeenLastCalledWith(125)
  })

  it('ignores wheel without Ctrl', () => {
    renderHook(() => useWheelZoom(100))
    const e = wheel(window, { deltaY: -100 })
    expect(e.defaultPrevented).toBe(false)
    expect(api.setZoom).not.toHaveBeenCalled()
    expect(useApp.getState().zoom).toBe(100)
  })

  it('stays clamped at 200% without calling the backend', () => {
    renderHook(() => useWheelZoom(200))
    expect(wheel(window, { ctrlKey: true, deltaY: -100 }).defaultPrevented).toBe(true)
    expect(api.setZoom).not.toHaveBeenCalled()
    expect(useApp.getState().zoom).toBe(200)
  })

  it('reverts and reports when the backend fails', async () => {
    vi.mocked(api.setZoom).mockRejectedValueOnce('boom')
    renderHook(() => useWheelZoom(100))
    wheel(window, { ctrlKey: true, deltaY: -100 })
    await act(async () => {})
    expect(useApp.getState().zoom).toBe(100)
    expect(useApp.getState().toasts.at(-1)?.kind).toBe('error')
  })
})
