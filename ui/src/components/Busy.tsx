import type { ReactNode } from 'react'
import { Square } from 'lucide-react'
import { useBusy } from '../hooks'
import { stopOperation } from '../lib/stop'

/** Stops the repo's operation; an icon, or a labelled button with `label`. */
export function StopButton({ path, op, label }: { path: string; op: string; label?: boolean }) {
  return (
    <button
      className={label ? 'small stop' : 'icon stop'}
      title={`Stop ${op}`}
      aria-label={`Stop ${op}`}
      onClick={(e) => {
        // Dashboard rows select on click.
        e.stopPropagation()
        void stopOperation(path, op)
      }}
    >
      <Square className="ico" aria-hidden />
      {label && 'Stop'}
    </button>
  )
}

/** Shows “<operation>…” with a Stop button while the repo is busy, otherwise `children`. */
export function BusyOr({ path, children }: { path: string; children?: ReactNode }) {
  const op = useBusy(path)
  return op ? (
    <>
      <span className="pill running busy">{op}…</span>
      <StopButton path={path} op={op} />
    </>
  ) : (
    <>{children}</>
  )
}

/** A small pulsing dot while the repo is busy (sidebar). */
export function BusyDot({ path }: { path: string }) {
  const op = useBusy(path)
  return op ? <span className="busy-dot" role="status" title={`${op}…`} aria-label={`${op}…`} /> : null
}
