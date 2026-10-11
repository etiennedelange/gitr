/** Keeps the WebView from behaving like a browser tab (fallback for the native WebView2 settings). */

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>

const isDevtoolsKey = (e: KeyLike) => e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i')

/** Browser shortcuts that should do nothing in Gitr. Gitr and editing shortcuts are not included. */
export function isBlockedBrowserKey(e: KeyLike): boolean {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (k === 'F5' || k === 'F3' || k === 'F7' || isDevtoolsKey(e)) return true
  if (e.altKey && !e.ctrlKey && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home')) return true
  if (e.ctrlKey && e.shiftKey && (k === 'j' || k === 'c' || k === 'r')) return true
  if (e.ctrlKey && !e.shiftKey && !e.altKey && ['r', 'f', 'p', 's', 'u', 'h', 'j', 'n', 't', 'w'].includes(k)) return true
  return false
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement)
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type)
  return false
}

export const isInSelectable = (target: EventTarget | null) => target instanceof Element && target.closest('.selectable') !== null

export interface GuardHandlers {
  onDevtools: () => void
  /** Called for right-clicks that no component handled (i.e. not yet defaultPrevented). */
  onContextMenu?: (e: MouseEvent) => void
}

export function installNativeGuards(win: Window, { onDevtools, onContextMenu }: GuardHandlers) {
  const onKey = (e: KeyboardEvent) => {
    if (isBlockedBrowserKey(e)) {
      e.preventDefault()
      if (isDevtoolsKey(e)) onDevtools()
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'a' && !isEditable(e.target) && !isInSelectable(e.target)) {
      e.preventDefault()
    }
  }
  const prevent = (e: Event) => e.preventDefault()
  const onCtx = (e: MouseEvent) => {
    if (!e.defaultPrevented) onContextMenu?.(e)
    e.preventDefault()
  }
  const onDragStart = (e: DragEvent) => {
    if (!isEditable(e.target)) e.preventDefault()
  }
  const onMouseNav = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault()
  }
  const listeners: [string, EventListener, boolean][] = [
    ['keydown', onKey as EventListener, true],
    // Bubble phase: component handlers show their native menu first.
    ['contextmenu', onCtx as EventListener, false],
    ['dragstart', onDragStart as EventListener, true],
    ['dragover', prevent, false],
    ['drop', prevent, false],
    ['mouseup', onMouseNav as EventListener, true],
    ['mousedown', onMouseNav as EventListener, true],
    ['auxclick', onMouseNav as EventListener, true],
  ]
  for (const [type, fn, capture] of listeners) win.addEventListener(type, fn, capture)
  return () => {
    for (const [type, fn, capture] of listeners) win.removeEventListener(type, fn, capture)
  }
}
