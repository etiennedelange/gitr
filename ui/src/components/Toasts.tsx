import { useEffect, useState, type ReactNode } from 'react'
import { useQueries } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { api, asCmdError } from '../api'
import { useApp } from '../store'
import { errorActions } from '../lib/errorActions'

const INFO_MS = 4000

/** Info toasts dismiss themselves, but wait while the pointer or keyboard focus is on them. */
function useAutoDismiss(id: number, kind: 'info' | 'error') {
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (kind !== 'info' || paused) return
    const t = setTimeout(() => useApp.getState().dismiss(id), INFO_MS)
    return () => clearTimeout(t)
  }, [id, kind, paused])
  return {
    onMouseEnter: () => setPaused(true),
    onMouseLeave: () => setPaused(false),
    onFocus: () => setPaused(true),
    onBlur: () => setPaused(false),
  }
}

function ToastShell({ id, kind, children }: { id: number; kind: 'info' | 'error'; children: ReactNode }) {
  const pause = useAutoDismiss(id, kind)
  return (
    <div className={`toast ${kind}`} role={kind === 'error' ? 'alert' : undefined} {...pause}>
      {children}
    </div>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismiss)
  const busy = useApp((s) => s.busy)
  const [open, setOpen] = useState<number | null>(null)
  const [running, setRunning] = useState<number | null>(null)
  // The strategy decides the label of the rejected-push fix (“Rebase & push” / “Merge & push”).
  const nonFfRepos = [...new Set(toasts.flatMap((t) => (t.error?.kind === 'non-fast-forward' && t.error.repo ? [t.error.repo] : [])))]
  const strategies = useQueries({
    queries: nonFfRepos.map((repo) => ({ queryKey: ['pullStrategy', repo], queryFn: () => api.pullStrategy(repo), staleTime: 60_000 })),
  })
  const strategyOf = (repo: string) => strategies[nonFfRepos.indexOf(repo)]?.data
  return (
    <div className="toasts">
      {toasts.map((t) => {
        const own = t.action ? [t.action] : []
        const actions = t.kind === 'error' ? [...errorActions(t.error, (repo) => !!busy[repo], strategyOf), ...own] : own
        return (
          <ToastShell key={t.id} id={t.id} kind={t.kind}>
            <div className="toast-row">
              {t.kind === 'error' ? <CircleAlert size={15} strokeWidth={2} /> : <CircleCheck size={15} strokeWidth={1.75} />}
              <span className="toast-msg selectable">{t.message}</span>
              {t.detail && (
                <button className="link" onClick={() => setOpen(open === t.id ? null : t.id)}>
                  details
                </button>
              )}
              <button className="icon" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            {actions.length > 0 && (
              <div className="toast-actions">
                {actions.map((a) => (
                  <button
                    key={a.label}
                    className="small"
                    disabled={running === t.id}
                    onClick={async () => {
                      setRunning(t.id)
                      try {
                        if ((await a.run()) !== false) dismiss(t.id)
                      } catch (e) {
                        const err = asCmdError(e)
                        useApp.getState().toast('error', err?.message ?? String(e), err?.detail ?? null, err)
                      } finally {
                        setRunning(null)
                      }
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            {open === t.id && t.detail && <pre className="toast-detail selectable">{t.detail}</pre>}
          </ToastShell>
        )
      })}
    </div>
  )
}
