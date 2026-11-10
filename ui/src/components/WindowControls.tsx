import { useEffect, useState, type ReactNode } from 'react'
import { current } from '../lib/windowDrag'

// Gitr draws its own caption buttons: the window has no native title bar (decorations: false in
// tauri.conf.json), so the sidebar and the sheet run to the top edge as one surface. The buttons
// sit at the sheet's top-right corner, over the first bar of whatever view is open.

const glyph = (d: ReactNode) => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
    {d}
  </svg>
)

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const win = current()
    if (!win) return
    let live = true
    const read = () =>
      win.isMaximized().then(
        (m) => live && setMaximized(!!m),
        () => {},
      )
    void read()
    const off = win.onResized(() => void read()).catch(() => undefined)
    return () => {
      live = false
      void off.then((f) => f?.())
    }
  }, [])

  const run = (f: (win: NonNullable<ReturnType<typeof current>>) => Promise<unknown>) => () => {
    const win = current()
    if (win) void f(win).catch(() => {})
  }
  return (
    <div className="caption" role="group" aria-label="Window">
      <button className="caption-button" tabIndex={-1} aria-label="Minimise" title="Minimise" onClick={run((w) => w.minimize())}>
        {glyph(<path d="M0 5.5h10" />)}
      </button>
      <button
        className="caption-button"
        tabIndex={-1}
        aria-label={maximized ? 'Restore' : 'Maximise'}
        title={maximized ? 'Restore down' : 'Maximise'}
        onClick={run((w) => w.toggleMaximize())}
      >
        {maximized
          ? glyph(
              <>
                <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
                <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
              </>,
            )
          : glyph(<rect x="0.5" y="0.5" width="9" height="9" rx="1" />)}
      </button>
      <button className="caption-button close" tabIndex={-1} aria-label="Close" title="Close" onClick={run((w) => w.close())}>
        {glyph(<path d="M.5 .5l9 9M9.5 .5l-9 9" />)}
      </button>
    </div>
  )
}
