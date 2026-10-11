/**
 * F6 / Shift+F6 move focus between the window's panes, as in Explorer and Outlook. A pane is any
 * element marked `data-pane`, in document order: the rail, then the view's lists, diff and
 * commit box. Focus lands on the pane itself when it takes focus, else on its first Tab stop.
 */
const TAB_STOP =
  '[tabindex="0"], button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled), select:not(:disabled)'

export function cyclePane(doc: Document, back: boolean): boolean {
  const panes = Array.from(doc.querySelectorAll<HTMLElement>('[data-pane]'))
  if (!panes.length) return false
  const i = panes.findIndex((p) => p.contains(doc.activeElement))
  const n = panes.length
  const next = i < 0 ? panes[back ? n - 1 : 0] : panes[(i + (back ? -1 : 1) + n) % n]
  const target = next.matches(TAB_STOP) ? next : next.querySelector<HTMLElement>(TAB_STOP)
  target?.focus()
  return !!target
}
