import { useRef, useState } from 'react'

const STEP = 16

/**
 * A draggable boundary between two panes. `axis` is the direction it moves: `x` between columns,
 * `y` between rows. `size` is the pane before it (left or above), measured when a drag starts;
 * the result goes to `onResize`, kept between `min` and `max()`. Arrow keys move it, Enter or a
 * double-click puts the pane back to its default size.
 */
export function Splitter({
  axis,
  label,
  size,
  min,
  max,
  onResize,
  onReset,
}: {
  axis: 'x' | 'y'
  label: string
  size: () => number
  min: number
  max: () => number
  onResize: (px: number) => void
  onReset: () => void
}) {
  const drag = useRef<{ from: number; start: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState<number | null>(null)
  const clamp = (px: number) => Math.round(Math.max(min, Math.min(Math.max(min, max()), px)))
  const at = (e: React.PointerEvent) => (axis === 'x' ? e.clientX : e.clientY)
  const resize = (px: number) => {
    const v = clamp(px)
    setNow(v)
    onResize(v)
  }

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    document.body.classList.remove('resizing', `resizing-${axis}`)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div
      className={`splitter ${axis}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={now ?? undefined}
      aria-valuemin={min}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture?.(e.pointerId)
        drag.current = { from: at(e), start: size() }
        setDragging(true)
        document.body.classList.add('resizing', `resizing-${axis}`)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d) resize(d.start + at(e) - d.from)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        setNow(null)
        onReset()
      }}
      onKeyDown={(e) => {
        const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
        const fwd = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
        if (e.key === back || e.key === fwd) resize(size() + (e.key === fwd ? STEP : -STEP))
        else if (e.key === 'Enter') {
          setNow(null)
          onReset()
        } else return
        e.preventDefault()
      }}
    />
  )
}
