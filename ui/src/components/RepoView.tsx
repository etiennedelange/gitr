import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, ArrowUpFromLine, Code, FolderOpen, GitBranch, GitMerge, Globe, RefreshCw, SquareTerminal } from 'lucide-react'
import { ask } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { splitChanges } from '../lib/git'
import { canContinue, canSkip, operationNoun, operationTitle } from '../lib/operation'
import { reportOutcome, runIntegrate } from '../lib/integrate'
import { runPush } from '../lib/send'
import { notifyError, useAction, useBusy, useRepos } from '../hooks'
import { useApp } from '../store'
import type { LinkTarget } from '../types'
import { Changes } from './Changes'
import { Branches } from './Branches'
import { History } from './History'
import { StopButton } from './Busy'
import { HookPanel } from './HookPanel'
import { DropMenu, type DropMenuItem } from './DropMenu'

type Tab = 'changes' | 'history' | 'branches'
const TABS: Tab[] = ['changes', 'history', 'branches']
const TAB_LABEL: Record<Tab, string> = { changes: 'Changes', history: 'History', branches: 'Branches' }
const step = (t: Tab, by: number) => TABS[(TABS.indexOf(t) + by + TABS.length) % TABS.length]

export function RepoView({ path }: { path: string }) {
  const repos = useRepos()
  const repo = repos.data?.find((r) => r.path === path)
  const s = useApp((st) => st.summaries[path])
  const [tab, setTab] = useState<Tab>('changes')
  // The tab count matches the Changes list (same query): the summary counts an untracked folder
  // once and would disagree with it.
  const status = useQuery({ queryKey: ['status', path], queryFn: () => api.status(path) })
  const changeCount = useMemo(() => {
    if (!status.data) return null
    const { staged, unstaged } = splitChanges(status.data.files)
    return staged.length + unstaged.length
  }, [status.data])

  useEffect(() => {
    api.repoSummary(path).then(useApp.getState().setSummary, notifyError)
  }, [path])

  // Interactive: wait for a busy repo instead of being skipped like Fetch all / Pull all.
  const fetch = useAction(() => api.runBatch('fetch', [path], true))
  // Fast-forwards as before; on a diverged branch offers to rebase/merge (never pushes).
  const pull = useAction(() => runIntegrate(path, { push: false }))
  // Hook rejections go to the hook panel; see runPush.
  const push = () => void runPush(path, s?.ahead ?? 1)
  // Shared backend state: also covers commits, staging, branch work and Fetch all on this repo.
  const busyOp = useBusy(path)
  const busy = !!busyOp

  const open = (target: LinkTarget) => api.openRemote(path, target).catch(notifyError)
  const branch = s?.branch ?? null

  const continueOperation = async () => {
    if (!s?.operation) return
    const noun = operationNoun(s.operation)
    try {
      reportOutcome(await api.continueOperation(path), `${noun.charAt(0).toUpperCase()}${noun.slice(1)} finished`)
    } catch (e) {
      notifyError(e)
    }
  }

  const abortOperation = async () => {
    if (!s?.operation) return
    const bisect = s.operation === 'bisecting'
    const noun = operationNoun(s.operation)
    const ok = await ask(
      bisect
        ? 'End the bisect? You go back to the branch and commit you started it from.'
        : `Abort the ${noun}? Your branch goes back to how it was before the ${noun} started.`,
      {
        title: bisect ? 'End bisect' : `Abort ${noun}`,
        kind: 'warning',
        okLabel: bisect ? 'End bisect' : `Abort ${noun}`,
        cancelLabel: 'Cancel',
      },
    )
    if (!ok) return
    try {
      await api.abortOperation(path)
      useApp.getState().toast('info', bisect ? 'Bisect ended' : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} aborted`)
    } catch (e) {
      notifyError(e)
    }
  }

  // Skip throws away the commit it stopped on and any conflict resolutions made for it.
  const skipCommit = async () => {
    if (!s?.operation) return
    const noun = operationNoun(s.operation)
    const what = s.operation === 'applying-patches' ? 'patch' : 'commit'
    const ok = await ask(
      `Skip the ${what} the ${noun} stopped on? Its changes are left out, and so are any edits you made to resolve its conflicts. ` +
        `The ${noun} then goes on with the rest.`,
      {
        title: `Skip ${what}`,
        kind: 'warning',
        okLabel: `Skip ${what}`,
      },
    )
    if (!ok) return
    try {
      reportOutcome(await api.skipOperation(path), `${noun.charAt(0).toUpperCase()}${noun.slice(1)} finished`)
    } catch (e) {
      notifyError(e)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key.toLowerCase() === 'o' && !e.shiftKey) {
        e.preventDefault()
        open(branch ? { kind: 'branch', branch } : { kind: 'repo' })
      } else if (e.key === 'Tab') {
        e.preventDefault()
        setTab((t) => step(t, e.shiftKey ? -1 : 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, branch])

  const remoteItems: DropMenuItem[] = [
    { label: 'Repository', onSelect: () => open({ kind: 'repo' }) },
    ...(branch
      ? [
          { label: `Branch ${branch} (Ctrl+O)`, onSelect: () => open({ kind: 'branch', branch }) },
          { label: 'Create pull request', onSelect: () => open({ kind: 'pullRequest', branch, target: null }) },
        ]
      : []),
  ]
  const openItems: DropMenuItem[] = [
    { label: 'Explorer', onSelect: () => api.openWith(path, 'explorer').catch(notifyError) },
    { label: 'Terminal', onSelect: () => api.openWith(path, 'terminal').catch(notifyError) },
    { label: 'VS Code', onSelect: () => api.openWith(path, 'vsCode').catch(notifyError) },
  ]

  return (
    <div className="repo-view">
      <header className="toolbar repo-head">
        <div className="title">
          <h1 title={repo?.path ?? path}>{repo?.name ?? path}</h1>
          <span className="branch-line">
            <button
              className="branch-name"
              title={`${branch ?? 'No branch'}: switch branch (Branches tab)`}
              onClick={() => setTab('branches')}
            >
              <GitBranch className="ico" aria-hidden />
              <span className="branch-text">{s?.detached ? '(detached)' : (branch ?? '…')}</span>
            </button>
            {s?.upstream ? (
              <span className="upstream selectable" title={s.upstream}>
                → {s.upstream}
              </span>
            ) : s ? (
              <span className="upstream none">No upstream</span>
            ) : null}
            {s?.behind ? (
              <span className="badge behind" title={`${s.behind} behind ${s.upstream ?? 'upstream'}`}>
                ↓{s.behind}
              </span>
            ) : null}
            {s?.ahead ? (
              <span className="badge ahead" title={`${s.ahead} ahead of ${s.upstream ?? 'upstream'}`}>
                ↑{s.ahead}
              </span>
            ) : null}
          </span>
        </div>
        <div className="spacer" />
        {busyOp && (
          <>
            <span className="pill running busy" role="status">
              {busyOp}…
            </span>
            <StopButton path={path} op={busyOp} label />
          </>
        )}
        <div className="head-actions">
          <div className="icon-group" role="group" aria-label="Sync">
            <button
              className="icon"
              disabled={busy}
              onClick={() => fetch.mutate([])}
              aria-label={busyOp === 'fetching' ? 'Fetching…' : 'Fetch'}
              title="Fetch from the remote"
            >
              <RefreshCw className={`ico ${busyOp === 'fetching' ? 'spin' : ''}`} aria-hidden />
            </button>
            <button
              className={`icon ${s?.behind ? 'counted next next-behind' : ''}`}
              disabled={busy || !!s?.operation}
              onClick={() => pull.mutate([])}
              aria-label={busyOp === 'pulling' ? 'Pulling…' : `Pull${s?.behind ? ` (${s.behind})` : ''}`}
              title={s?.operation ? `${operationTitle(s.operation)}: finish or abort it first` : 'Pull (fast-forward)'}
            >
              <ArrowDownToLine className={`ico ${busyOp === 'pulling' ? 'pulse' : ''}`} aria-hidden />
              {s?.behind ? (
                <span className="count" aria-hidden>
                  {s.behind}
                </span>
              ) : null}
            </button>
            <button
              className={`icon ${s?.ahead ? 'counted next next-ahead' : ''}`}
              disabled={busy || s?.detached}
              aria-label={busyOp === 'pushing' ? 'Pushing…' : `Push${s?.ahead ? ` (${s.ahead})` : ''}`}
              title={s?.detached ? 'Detached HEAD: check out a branch to push' : 'Push your commits'}
              onClick={push}
            >
              <ArrowUpFromLine className={`ico ${busyOp === 'pushing' ? 'pulse' : ''}`} aria-hidden />
              {s?.ahead ? (
                <span className="count" aria-hidden>
                  {s.ahead}
                </span>
              ) : null}
            </button>
          </div>
          <span className="toolbar-sep" aria-hidden />
          {s?.remote && <DropMenu label={`Open in ${s.remote.kind === 'ado' ? 'ADO' : 'GitHub'}`} icon={Globe} items={remoteItems} />}
          <DropMenu label="Open" icon={FolderOpen} items={openItems} />
        </div>
      </header>
      {s?.error && <div className="banner error selectable">{s.error}</div>}
      <HookPanel path={path} />
      {s?.operation && (
        <div className={`banner operation ${s.conflicted > 0 ? 'conflicted' : ''}`} role="status">
          <GitMerge className="ico" aria-hidden />
          <span className="operation-text">
            {operationTitle(s.operation)}
            {s.operation !== 'bisecting' && (
              <span className="muted">{s.conflicted === 1 ? '1 conflicted file' : `${s.conflicted} conflicted files`}</span>
            )}
          </span>
          <span className="actions">
            {canContinue(s.operation) && (
              <button
                className="small primary"
                disabled={busy || s.conflicted > 0}
                title={s.conflicted > 0 ? 'Resolve and stage the conflicted files first' : `Continue the ${operationNoun(s.operation)}`}
                onClick={() => void continueOperation()}
              >
                Continue
              </button>
            )}
            {canSkip(s.operation) && (
              <button
                className="small"
                disabled={busy}
                title={`Leave out the ${s.operation === 'applying-patches' ? 'patch' : 'commit'} it stopped on and go on with the rest`}
                onClick={() => void skipCommit()}
              >
                Skip
              </button>
            )}
            <button className="small" disabled={busy} onClick={() => void abortOperation()}>
              {s.operation === 'bisecting' ? 'End bisect' : 'Abort'}
            </button>
            <button className="small" onClick={() => api.openWith(path, 'terminal').catch(notifyError)}>
              <SquareTerminal className="ico" aria-hidden />
              Open terminal
            </button>
            <button className="small" onClick={() => api.openWith(path, 'vsCode').catch(notifyError)}>
              <Code className="ico" aria-hidden />
              Open in VS Code
            </button>
          </span>
        </div>
      )}
      <div
        className="tabs"
        role="tablist"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          const next = step(tab, e.key === 'ArrowRight' ? 1 : -1)
          setTab(next)
          document.getElementById(`tab-${next}`)?.focus()
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            id={`tab-${t}`}
            aria-controls="repo-panel"
            aria-selected={tab === t}
            tabIndex={tab === t ? 0 : -1}
            title={`${TAB_LABEL[t]} (Ctrl+Tab cycles)`}
            className={tab === t ? 'on' : ''}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
            {t === 'changes' && changeCount !== null ? ' ' : null}
            {t === 'changes' && changeCount !== null ? <span className="tab-count">{changeCount}</span> : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="repo-panel" aria-labelledby={`tab-${tab}`} className="repo-panel">
        {tab === 'changes' && <Changes path={path} />}
        {tab === 'history' && <History path={path} remote={s?.remote ?? null} />}
        {tab === 'branches' && <Branches path={path} remote={s?.remote ?? null} />}
      </div>
    </div>
  )
}
