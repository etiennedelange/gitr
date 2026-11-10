import { useState } from 'react'
import { abortOperation } from '../lib/abortOperation'
import { operationTitle } from '../lib/operation'
import type { Row } from '../lib/git'
import type { BatchProgress } from '../types'
import { StatusMark } from './Marks'

/** How many repos the banner lists before the rest fold under "Show N more". */
export const BANNER_ROWS = 3

interface Props {
  /** The repos that need you, in the order to list them. */
  rows: Row[]
  progress: Record<string, BatchProgress | undefined>
  /** A Fetch all / Pull all is running: retrying waits for it. */
  running: boolean
  open: (path: string) => void
  retry: (path: string, op: BatchProgress['op']) => void
}

/** What is wrong, in a few words: "Merge in progress · 2 conflicts", "Fetch failed · …". */
function problem(row: Row, p: BatchProgress | undefined): string {
  const s = row.summary
  const conflicts = s?.conflicted ? `${s.conflicted} conflict${s.conflicted === 1 ? '' : 's'}` : ''
  if (s?.operation) return [operationTitle(s.operation), conflicts].filter(Boolean).join(' · ')
  if (p?.state === 'error') {
    const verb = p.op === 'fetch' ? 'Fetch' : 'Pull'
    return p.signIn ? `${verb} needs you to sign in` : `${verb} failed${p.message ? ` · ${p.message}` : ''}`
  }
  if (s?.error) return s.error
  if (conflicts) return `${conflicts} to resolve`
  return 'Needs attention'
}

/**
 * The repos that need you, above the list: one callout with a row each, saying what is wrong and
 * offering the next step (abort the operation, retry the fetch, or open the repo). The repos stay
 * in their own groups below, with the same problem in their Status column.
 */
export function AttentionBanner({ rows, progress, running, open, retry }: Props) {
  const [expanded, setExpanded] = useState(false)
  if (!rows.length) return null
  const shown = expanded ? rows : rows.slice(0, BANNER_ROWS)
  const hidden = rows.length - shown.length
  return (
    <section className="attention-banner" aria-label="Needs attention">
      <ul>
        {shown.map((row) => {
          const { repo, summary: s } = row
          const p = progress[repo.path]
          const failed = p?.state === 'error'
          return (
            <li key={repo.path} className="attention-item">
              <StatusMark summary={s} />
              <span className="attention-text">
                <span className="attention-name">{repo.name}</span>
                <span className="attention-problem" title={problem(row, p)}>
                  {problem(row, p)}
                </span>
              </span>
              <span className="attention-actions">
                {s?.operation && (
                  <button className="small" onClick={() => void abortOperation(repo.path, s.operation!)}>
                    {s.operation === 'bisecting' ? 'End bisect' : 'Abort'}
                  </button>
                )}
                {!s?.operation && failed && (
                  <button className="small" disabled={running} onClick={() => retry(repo.path, p.op)}>
                    Retry
                  </button>
                )}
                <button className="small" onClick={() => open(repo.path)} aria-label={`Open ${repo.name}`}>
                  Open
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {rows.length > BANNER_ROWS && (
        <button className="link attention-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
    </section>
  )
}
