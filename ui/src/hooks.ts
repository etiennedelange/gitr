import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, asCmdError, errorDetail, errorMessage } from './api'
import { useApp } from './store'
import type { BatchOp, BatchProgress, RepoBusy, RepoSummary } from './types'

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: Infinity })
export const useRepos = () => useQuery({ queryKey: ['repos'], queryFn: api.listRepos, staleTime: Infinity })

export function useBackendEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    const subs = [
      listen<RepoSummary>('repo-summary', ({ payload }) => {
        const before = useApp.getState().summaries[payload.path]
        useApp.getState().setSummary(payload)
        for (const key of ['status', 'lineStats', 'branches', 'diff', 'lastCommit']) qc.invalidateQueries({ queryKey: [key, payload.path] })
        // History only reloads when HEAD moved or a push changed which commits are unpushed,
        // not on every save in the working tree.
        if (!before || before.head !== payload.head || before.ahead !== payload.ahead)
          void qc.invalidateQueries({ queryKey: ['log', payload.path] })
      }),
      listen<BatchProgress>('batch-progress', ({ payload }) => useApp.getState().setBatch(payload)),
      listen<RepoBusy>('repo-busy', ({ payload }) => useApp.getState().setRepoBusy(payload.path, payload.op)),
      listen<{ path: string; op: 'commit' | 'push' }>('hooks-started', ({ payload }) =>
        useApp.getState().hooksStarted(payload.path, payload.op),
      ),
      listen<{ path: string; line: string }>('hook-output', ({ payload }) => useApp.getState().hookOutput(payload.path, payload.line)),
      // Back from the editor or terminal: the open repo may have changed in ways the watcher
      // missed (repos that changed meanwhile are refreshed by the backend already).
      listen('window-focused', () => {
        const view = useApp.getState().view
        if (view.kind === 'repo') api.refreshRepo(view.path).catch(() => {})
      }),
    ]
    // Repos already busy before the listeners were attached.
    api
      .busyRepos()
      .then((list) => useApp.getState().setAllBusy(Object.fromEntries(list.filter((b) => b.op).map((b) => [b.path, b.op as string]))))
      .catch(() => {})
    return () => subs.forEach((p) => p.then((unlisten) => unlisten()))
  }, [qc])
}

export function notifyError(e: unknown) {
  const err = asCmdError(e)
  // The user stopped it; that is not a failure.
  if (err?.kind === 'cancelled') return useApp.getState().toast('info', err.message)
  useApp.getState().toast('error', errorMessage(e), errorDetail(e), err)
}

/** Wraps a backend action with error toasts; optional success message. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, success?: (r: R) => string) {
  return useMutation({
    mutationFn: (args: A) => fn(...args),
    onSuccess: (r) => success && useApp.getState().toast('info', success(r)),
    onError: notifyError,
  })
}

export const useBatchRunning = () => useIsMutating({ mutationKey: ['batch'] }) > 0

export function useBatch() {
  return useMutation({
    mutationKey: ['batch'],
    // `interactive`: a single action on one repo (sidebar menu), which waits for a busy repo and
    // may show a sign-in window; a batch never does.
    mutationFn: ({ op, paths, interactive = false }: { op: BatchOp; paths: string[]; interactive?: boolean }) => {
      useApp.getState().clearBatch()
      return api.runBatch(op, paths, interactive)
    },
    onSuccess: (results, { op }) => {
      const signIn = results.filter((r) => r.state === 'error' && r.signIn).length
      const failed = results.filter((r) => r.state === 'error').length - signIn
      const skipped = results.filter((r) => r.state === 'skipped').length
      const verb = op === 'fetch' ? 'Fetched' : 'Pulled'
      const parts = [`${verb} ${results.length - failed - skipped - signIn}/${results.length}`]
      if (skipped) parts.push(`${skipped} skipped`)
      if (signIn) parts.push(`${signIn} need sign-in`)
      if (failed) parts.push(`${failed} failed`)
      useApp.getState().toast(failed ? 'error' : 'info', parts.join(', '))
    },
    onError: notifyError,
  })
}

export function useRescan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const repos = await api.rescanRepos()
      qc.setQueryData(['repos'], repos)
      await api.refreshAll()
      return repos
    },
    onError: notifyError,
  })
}

/** How long a repo must be busy before the UI shows it (avoids flicker on fast writes). */
export const BUSY_DISPLAY_DELAY = 200

/**
 * The operation running on `path` (e.g. "committing") once it has lasted BUSY_DISPLAY_DELAY,
 * else null. The backend queues writes regardless, so a click during the delay is safe.
 */
export function useBusy(path: string): string | null {
  const op = useApp((s) => s.busy[path] ?? null)
  const [shown, setShown] = useState<string | null>(null)
  useEffect(() => {
    if (!op) {
      setShown(null)
      return
    }
    // Already showing: switch the label right away (e.g. fetching → pulling).
    if (shown) {
      setShown(op)
      return
    }
    const t = setTimeout(() => setShown(op), BUSY_DISPLAY_DELAY)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op])
  return shown
}
