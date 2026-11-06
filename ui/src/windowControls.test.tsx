import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const win = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  startDragging: vi.fn(() => Promise.resolve()),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }))

import { WindowControls } from './components/WindowControls'
import { installWindowDrag, isDragTarget } from './lib/windowDrag'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('caption buttons', () => {
  it('minimise, maximise and close the window', async () => {
    render(<WindowControls />)
    fireEvent.click(screen.getByRole('button', { name: 'Minimise' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximise' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(win.minimize).toHaveBeenCalledOnce()
    expect(win.toggleMaximize).toHaveBeenCalledOnce()
    expect(win.close).toHaveBeenCalledOnce()
  })

  it('offers Restore while maximised', async () => {
    win.isMaximized.mockResolvedValueOnce(true)
    render(<WindowControls />)
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })
})

describe('dragging the window', () => {
  const page = () => {
    document.body.innerHTML = `
      <nav class="sidebar"><div class="brand"><span id="name">Gitr</span><button id="home">Home</button></div><div id="tree"></div></nav>
      <main class="main"><div class="dashboard"><header class="toolbar"><h1 id="title">Dashboard</h1><input id="search"></header><div id="body"></div></div></main>`
    return (id: string) => document.getElementById(id)!
  }

  it('starts from the bars at the top, but not their controls or the content', () => {
    const el = page()
    expect(isDragTarget(el('name'))).toBe(true)
    expect(isDragTarget(el('title'))).toBe(true)
    expect(isDragTarget(document.querySelector('.toolbar'))).toBe(true)
    expect(isDragTarget(el('home'))).toBe(false)
    expect(isDragTarget(el('search'))).toBe(false)
    expect(isDragTarget(el('tree'))).toBe(false)
    expect(isDragTarget(el('body'))).toBe(false)
  })

  it('drags on a press and maximises on a double-click', () => {
    const el = page()
    const off = installWindowDrag(document)
    fireEvent.mouseDown(el('title'), { button: 0, detail: 1 })
    expect(win.startDragging).toHaveBeenCalledOnce()
    fireEvent.mouseDown(el('title'), { button: 0, detail: 2 })
    expect(win.toggleMaximize).toHaveBeenCalledOnce()
    fireEvent.mouseDown(el('title'), { button: 2, detail: 1 })
    fireEvent.mouseDown(el('home'), { button: 0, detail: 1 })
    expect(win.startDragging).toHaveBeenCalledOnce()
    off()
  })
})
