import { getCurrentWindow } from '@tauri-apps/api/window'

// Moving the window by its top bars: it has no native title bar (decorations: false).

/** The window, or null outside Tauri (unit tests render the app without it). */
export function current() {
  try {
    return getCurrentWindow()
  } catch {
    return null
  }
}

/** Elements a press on starts a window drag: the bars at the top of the window. */
const DRAG = '.brand, .toolbar, .main > .banner'
/** Inside a drag bar, these keep their own clicks. */
const INTERACTIVE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"], [contenteditable], .caption'

/** True when a primary press on `target` should move the window instead of reaching the page. */
export function isDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest(DRAG) && !target.closest(INTERACTIVE)
}

/** Drag the window from the top bars, and maximise or restore it on a double-click there. */
export function installWindowDrag(doc: Document): () => void {
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || !isDragTarget(e.target)) return
    e.preventDefault()
    const win = current()
    if (!win) return
    void (e.detail === 2 ? win.toggleMaximize() : win.startDragging()).catch(() => {})
  }
  doc.addEventListener('mousedown', onDown)
  return () => doc.removeEventListener('mousedown', onDown)
}
