import { useApp } from '../store'
import { BusyOr } from './Busy'
import { operationNoun } from '../lib/operation'
import type { BatchProgress, RepoSummary } from '../types'

/** What the last Fetch all / Pull all did for a repo, in words: "Up to date", "Pull failed · …". */
function batchText(p: BatchProgress): string {
  const verb = p.op === 'fetch' ? 'Fetch' : 'Pull'
  const msg = p.message ? ` · ${p.message}` : ''
  switch (p.state) {
    case 'running':
      return p.op === 'fetch' ? 'Fetching…' : 'Pulling…'
    case 'ok':
      return p.message ?? (p.op === 'fetch' ? 'Fetched' : 'Pulled')
    case 'skipped':
      return `Skipped${msg}`
    case 'error':
      return p.signIn ? 'Sign-in needed' : `${verb} failed${msg}`
  }
}

/** The operation in progress, short: "merging · 2 conflicts". */
function OperationPill({ s }: { s: RepoSummary }) {
  const op = s.operation!
  const n = s.conflicted
  return (
    <span className={`pill operation ${n ? 'conflicted' : ''}`} title={`A ${operationNoun(op)} is in progress`}>
      <span>{op === 'applying-patches' ? 'Applying patches' : op.charAt(0).toUpperCase() + op.slice(1)}</span>
      {n > 0 && <span>{` · ${n} conflict${n === 1 ? '' : 's'}`}</span>}
    </span>
  )
}

/**
 * A repo's status in words, as the ledger's Status column and the cards show it: the running
 * operation, the operation waiting for the user, the last Fetch all / Pull all, an error or "No
 * upstream". `idle` is shown when none of those applies; `hideError` leaves the error to the caller.
 */
export function RepoStatusText({
  path,
  summary: s,
  idle = null,
  hideError = false,
}: {
  path: string
  summary: RepoSummary | undefined
  idle?: React.ReactNode
  hideError?: boolean
}) {
  const p = useApp((st) => st.batch[path])
  return (
    <BusyOr path={path}>
      {s?.operation ? (
        <OperationPill s={s} />
      ) : p ? (
        <span className={`pill ${p.state} ${p.signIn ? 'signin' : ''}`}>{batchText(p)}</span>
      ) : s?.error ? (
        hideError ? null : (
          <span className="pill error">{s.error}</span>
        )
      ) : !s?.upstream && s ? (
        <span className="muted">No upstream</span>
      ) : (
        idle
      )}
    </BusyOr>
  )
}
