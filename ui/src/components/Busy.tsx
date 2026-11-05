import type { ReactNode } from 'react'
import { Square } from 'lucide-react'
import { BUSY_MIN_VISIBLE, useBusy } from '../hooks'
import { stopOperation } from '../lib/stop'

/** Stops the repo's operation. */
export function StopButton({ path, op }: { path: string; op: string }) {
  return (
    <button
      className="icon stop"
      title={`Stop ${op}`}
      aria-label={`Stop ${op}`}
      onClick={(e) => {
        // Dashboard rows select on click.
        e.stopPropagation()
        void stopOperation(path, op)
      }}
    >
      <Square className="ico" aria-hidden />
    </button>
  )
}

/** "fetching" → "Fetching…": operation names are stored lower case; a running one ends in an ellipsis. */
export const opLabel = (op: string) => `${op.charAt(0).toUpperCase()}${op.slice(1)}…`

/** The repo's running operation as a chip, or nothing while it is idle. */
export function BusyChip({ path }: { path: string }) {
  const op = useBusy(path, BUSY_MIN_VISIBLE)
  return op ? <Chip path={path} op={op} /> : null
}

/** A running operation: a small spinner, its name in sentence case, and a Stop key, as one quiet chip. */
function Chip({ path, op }: { path: string; op: string }) {
  return (
    <span className="busy-chip">
      <span className="busy-label" role="status">
        <span className="spinner" aria-hidden />
        {opLabel(op)}
      </span>
      <StopButton path={path} op={op} />
    </span>
  )
}

/** Shows the running operation with a Stop button while the repo is busy, otherwise `children`. */
export function BusyOr({ path, children }: { path: string; children?: ReactNode }) {
  const op = useBusy(path, BUSY_MIN_VISIBLE)
  return op ? <Chip path={path} op={op} /> : <>{children}</>
}

/** A small pulsing dot while the repo is busy (sidebar). */
export function BusyDot({ path }: { path: string }) {
  const op = useBusy(path, BUSY_MIN_VISIBLE)
  return op ? <span className="busy-dot" role="status" title={opLabel(op)} aria-label={opLabel(op)} /> : null
}
