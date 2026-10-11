import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export interface DropMenuItem {
  label: string
  onSelect: () => void
}

/** A toolbar dropdown that closes like a native menu: on Escape, on a click elsewhere, when an item is chosen, and when another menu opens. */
export function DropMenu({ label, items }: { label: ReactNode; items: DropMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <details
      className="menu"
      ref={root}
      open={open}
      onBlur={(e) => {
        // Keyboard focus moved out of the menu: close it, like a native menu.
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={(e) => {
        if (!open) return
        // Up and Down move through the items, like a native menu.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('.menu-items button') ?? [])]
          const i = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
          items[i < 0 && e.key === 'ArrowDown' ? 0 : next]?.focus()
          return
        }
        if (e.key !== 'Escape') return
        e.stopPropagation()
        setOpen(false)
        root.current?.querySelector('summary')?.focus()
      }}
    >
      <summary
        onClick={(e) => {
          e.preventDefault()
          setOpen(!open)
        }}
      >
        {label} <ChevronDown className="ico chev" aria-hidden />
      </summary>
      <div className="menu-items" role="menu">
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            onClick={() => {
              setOpen(false)
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </details>
  )
}
