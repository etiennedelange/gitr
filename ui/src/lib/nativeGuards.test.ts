import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { installNativeGuards, isBlockedBrowserKey } from './nativeGuards'

const key = (key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe('isBlockedBrowserKey', () => {
  it.each([
    ['F5', {}],
    ['r', { ctrlKey: true }],
    ['R', { ctrlKey: true, shiftKey: true }],
    ['f', { ctrlKey: true }],
    ['F3', {}],
    ['p', { ctrlKey: true }],
    ['s', { ctrlKey: true }],
    ['u', { ctrlKey: true }],
    ['ArrowLeft', { altKey: true }],
    ['ArrowRight', { altKey: true }],
    ['F7', {}],
    ['F12', {}],
    ['I', { ctrlKey: true, shiftKey: true }],
    ['J', { ctrlKey: true, shiftKey: true }],
    ['C', { ctrlKey: true, shiftKey: true }],
  ])('blocks %s %o', (k, mods) => expect(isBlockedBrowserKey(key(k, mods))).toBe(true))

  it.each([
    ['g', { ctrlKey: true }],
    ['o', { ctrlKey: true }],
    ['d', { ctrlKey: true }],
    [',', { ctrlKey: true }],
    ['1', { ctrlKey: true }],
    ['Tab', { ctrlKey: true }],
    ['Enter', { ctrlKey: true }],
    ['Enter', { ctrlKey: true, shiftKey: true }],
    ['F', { ctrlKey: true, shiftKey: true }],
    ['P', { ctrlKey: true, shiftKey: true }],
    ['c', { ctrlKey: true }],
    ['x', { ctrlKey: true }],
    ['v', { ctrlKey: true }],
    ['z', { ctrlKey: true }],
    ['y', { ctrlKey: true }],
    ['a', { ctrlKey: true }],
    ['ArrowLeft', {}],
    ['Home', {}],
    ['End', {}],
  ])('allows %s %o', (k, mods) => expect(isBlockedBrowserKey(key(k, mods))).toBe(false))
})

describe('installNativeGuards', () => {
  let uninstall: () => void
  const onDevtools = vi.fn()
  beforeEach(() => {
    onDevtools.mockClear()
    uninstall = installNativeGuards(window, { onDevtools })
  })
  afterEach(() => {
    uninstall()
    document.body.replaceChildren()
  })

  const el = (html: string) => {
    const wrap = document.createElement('div')
    wrap.innerHTML = html
    document.body.append(wrap)
    return wrap.firstElementChild as HTMLElement
  }
  const fire = (target: EventTarget, e: Event) => (target.dispatchEvent(e), e.defaultPrevented)
  const kd = (k: string, mods = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })

  it('prevents browser keys but lets Gitr and editing keys through', () => {
    const input = el('<input />')
    expect(fire(document.body, kd('F5'))).toBe(true)
    expect(fire(input, kd('f', { ctrlKey: true }))).toBe(true)
    expect(fire(document.body, kd('g', { ctrlKey: true }))).toBe(false)
    expect(fire(document.body, kd('Enter', { ctrlKey: true }))).toBe(false)
    for (const k of ['c', 'x', 'v', 'z', 'y', 'a']) expect(fire(input, kd(k, { ctrlKey: true }))).toBe(false)
    expect(fire(input, kd('Home'))).toBe(false)
  })

  it('opens devtools via F12 and Ctrl+Shift+I', () => {
    fire(document.body, kd('F12'))
    fire(document.body, kd('I', { ctrlKey: true, shiftKey: true }))
    expect(onDevtools).toHaveBeenCalledTimes(2)
  })

  it('blocks Ctrl+A on UI but not in inputs, textareas or selectable content', () => {
    expect(fire(el('<div>hi</div>'), kd('a', { ctrlKey: true }))).toBe(true)
    expect(fire(el('<textarea></textarea>'), kd('a', { ctrlKey: true }))).toBe(false)
    expect(fire(el('<div class="selectable"><span>x</span></div>').firstElementChild!, kd('a', { ctrlKey: true }))).toBe(false)
  })

  it('prevents the browser context menu everywhere', () => {
    expect(fire(el('<div></div>'), new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true)
  })

  it('prevents dragging UI, but not from inputs', () => {
    const drag = () => new Event('dragstart', { bubbles: true, cancelable: true })
    expect(fire(el('<span>text</span>'), drag())).toBe(true)
    expect(fire(el('<input value="x" />'), drag())).toBe(false)
  })

  it('prevents drops from navigating', () => {
    expect(fire(document.body, new Event('drop', { bubbles: true, cancelable: true }))).toBe(true)
    expect(fire(document.body, new Event('dragover', { bubbles: true, cancelable: true }))).toBe(true)
  })

  it('prevents mouse back/forward buttons', () => {
    for (const button of [3, 4]) {
      expect(fire(document.body, new MouseEvent('mouseup', { button, bubbles: true, cancelable: true }))).toBe(true)
    }
    expect(fire(document.body, new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }))).toBe(false)
  })

  it('uninstalls cleanly', () => {
    uninstall()
    expect(fire(document.body, kd('F5'))).toBe(false)
    uninstall = () => {}
  })
})
