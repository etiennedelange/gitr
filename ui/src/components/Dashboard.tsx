import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Code, Ellipsis, FolderGit2, FolderPlus, RefreshCw, RotateCw, ScanSearch, Search, X } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../api'
import { notifyError, useBatch, useBatchRunning, useConfig, useRepos, useRescan } from '../hooks'
import { matchesFilter, needsAttention, sortRows, type Filter, type Row, type SortKey } from '../lib/git'
import { useApp } from '../store'
import { useRepoMenu } from '../repoMenu'
import { plainInput } from '../lib/inputProps'
import { useAddFolder } from '../lib/addFolder'
import { BusyOr } from './Busy'
import { SignInBanner } from './SignInBanner'
import { operationNoun } from '../lib/operation'
import { CountChips, Divergence, StatusMark } from './Marks'
import type { BatchProgress, RepoSummary } from '../types'

const FILTERS: Filter[] = ['all', 'attention', 'dirty', 'behind', 'ahead']
const FILTER_LABEL: Record<Filter, string> = { all: 'All', attention: 'Attention', dirty: 'Changes', behind: 'Behind', ahead: 'Ahead' }
const ROW_H = 30
const BAND_H = 28

/** A virtual list item: a repo row, or the heading of the band of rows below it. */
type Item = { kind: 'band'; label: string; count: number } | { kind: 'row'; row: Row }

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
export function Dashboard() {
  const config = useConfig()
  const repos = useRepos()
  const summaries = useApp((s) => s.summaries)
  const progress = useApp((s) => s.batch)
  const setView = useApp((s) => s.setView)
  const batch = useBatch()
  const running = useBatchRunning()
  const repoMenu = useRepoMenu()
  const rescan = useRescan()
  const folder = useAddFolder()
  // Kept in the store so they survive a trip into a repo and back.
  const filter = useApp((s) => s.dashboard.filter)
  const text = useApp((s) => s.dashboard.text)
  const sort = useApp((s) => s.dashboard.sort)
  const group = useApp((s) => s.dashboard.group)
  const setDashboard = useApp((s) => s.setDashboard)
  const [refreshing, setRefreshing] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)

  // While the results of Fetch all / Pull all are on screen, rows keep their places: the results
  // change their status, and re-sorting would move the row you are reading. Choosing a sort, or
  // coming back to the dashboard, sorts again.
  const holdOrder = Object.keys(progress).length > 0
  const order = useRef<{ sort: SortKey; at: Map<string, number> } | null>(null)
  const rows = useMemo(() => {
    const all = (repos.data ?? []).map((repo) => ({ repo, summary: summaries[repo.path] }))
    const held = order.current
    let sorted: Row[]
    if (holdOrder && held?.sort === sort && all.every((r) => held.at.has(r.repo.path))) {
      sorted = [...all].sort((a, b) => held.at.get(a.repo.path)! - held.at.get(b.repo.path)!)
    } else {
      sorted = sortRows(all, sort)
      // Held over every repo, so a filter, search or group still applies without moving rows.
      if (all.length) order.current = { sort, at: new Map(sorted.map((r, i) => [r.repo.path, i])) }
    }
    const failed = (path: string) => progress[path]?.state === 'error'
    return sorted.filter((r) => (!group || r.repo.groupId === group) && matchesFilter(r, filter, text, failed(r.repo.path)))
  }, [repos.data, summaries, filter, text, sort, group, holdOrder, progress])

  const attention = (r: Row) => needsAttention(r.summary, progress[r.repo.path]?.state === 'error')

  // Sorted by status, the repos that need you get their own band above the rest. Held rows keep
  // their places, so the bands only form when the order is fresh.
  const items = useMemo((): Item[] => {
    const urgent = sort === 'status' && filter !== 'attention' && !holdOrder ? rows.filter(attention) : []
    if (!urgent.length || urgent.length === rows.length) return rows.map((row) => ({ kind: 'row', row }))
    const rest = rows.filter((r) => !urgent.includes(r))
    return [
      { kind: 'band', label: 'Needs attention', count: urgent.length },
      ...urgent.map((row): Item => ({ kind: 'row', row })),
      { kind: 'band', label: 'Everything else', count: rest.length },
      ...rest.map((row): Item => ({ kind: 'row', row })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, filter, holdOrder])

  // How many repos each filter tab would show, within the chosen group and search.
  const counts = useMemo(() => {
    const scoped = (repos.data ?? [])
      .map((repo) => ({ repo, summary: summaries[repo.path] }))
      .filter((r) => !group || r.repo.groupId === group)
    return Object.fromEntries(
      FILTERS.map((f) => [f, scoped.filter((r) => matchesFilter(r, f, text, progress[r.repo.path]?.state === 'error')).length]),
    ) as Record<Filter, number>
  }, [repos.data, summaries, group, text, progress])

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === 'band' ? BAND_H : ROW_H),
    overscan: 12,
  })

  // Ctrl+F finds a repository, as in Explorer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Put the list back where it was once there are rows to scroll.
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || !rows.length || !scrollRef.current) return
    restored.current = true
    scrollRef.current.scrollTop = useApp.getState().dashboard.scroll
  }, [rows.length])

  // Rows in display order (bands put the urgent ones first), for the keyboard cursor.
  const ordered = useMemo(() => items.flatMap((it) => (it.kind === 'row' ? [it.row] : [])), [items])
  const onListKey = (e: React.KeyboardEvent) => {
    const i = ordered.findIndex((r) => r.repo.path === cursor)
    const go = (n: number) => {
      const k = Math.min(ordered.length - 1, Math.max(0, n))
      const row = ordered[k]
      if (!row) return
      setCursor(row.repo.path)
      virtual.scrollToIndex?.(items.findIndex((it) => it.kind === 'row' && it.row === row))
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_H) / ROW_H) - 1)
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1)
    else if (e.key === 'PageDown') go(i + page)
    else if (e.key === 'PageUp') go(i - page)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(ordered.length - 1)
    else if (e.key === 'Enter' && i >= 0) setView({ kind: 'repo', path: ordered[i].repo.path })
    else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && i >= 0) repoMenu(ordered[i].repo.path)(e)
    else return
    e.preventDefault()
  }

  const refresh = () => {
    setRefreshing(true)
    api
      .refreshAll()
      .catch(notifyError)
      .finally(() => setRefreshing(false))
  }

  const paths = rows.map((r) => r.repo.path)
  const showingAll = filter === 'all' && !group && !text
  const states = Object.values(progress)
  const done = states.filter((p) => p.state !== 'running').length
  const total = states.length
  // What the last Fetch all / Pull all did, kept until the next one starts.
  const count = (f: (p: (typeof states)[number]) => boolean) => states.filter(f).length
  const needSignIn = count((p) => p.state === 'error' && !!p.signIn)
  const failed = count((p) => p.state === 'error') - needSignIn
  const skipped = count((p) => p.state === 'skipped')
  const outcome = [
    `${count((p) => p.state === 'ok')} done`,
    ...(skipped ? [`${skipped} skipped`] : []),
    ...(needSignIn ? [`${needSignIn} need sign-in`] : []),
    ...(failed ? [`${failed} failed`] : []),
  ].join(', ')

  const noRepos = !!repos.data && !repos.data.length
  const tallyText = tally(repos.data?.map((r) => summaries[r.path]) ?? [])

  return (
    <div className="dashboard">
      <header className="toolbar">
        <h1>Dashboard</h1>
        {total > 0 && (
          <span className={`progress-text ${running ? 'running' : ''}`} role="status">
            {running ? `${op(states)} ${done} of ${total}` : outcome}
          </span>
        )}
        <div className="spacer" />
        <button
          className="quiet"
          disabled={running || !paths.length}
          onClick={() => batch.mutate({ op: 'fetch', paths })}
          title={showingAll ? 'Ctrl+Shift+F' : 'Fetch the shown repositories (Ctrl+Shift+F fetches all)'}
        >
          <RefreshCw className="ico" aria-hidden />
          Fetch {showingAll ? 'all' : 'shown'}
        </button>
        <button
          className="quiet"
          disabled={running || !paths.length}
          onClick={() => batch.mutate({ op: 'pull', paths })}
          title={showingAll ? 'Ctrl+Shift+P' : 'Pull the shown repositories (Ctrl+Shift+P pulls all)'}
        >
          <ArrowDownToLine className="ico" aria-hidden />
          Pull {showingAll ? 'all' : 'shown'}
        </button>
        <span className="toolbar-sep" aria-hidden />
        <button
          className="icon"
          disabled={refreshing}
          onClick={refresh}
          aria-label={refreshing ? 'Refreshing…' : 'Refresh'}
          title="Refresh: re-read the status of every repository"
        >
          <RotateCw className={`ico ${refreshing ? 'spin' : ''}`} aria-hidden />
        </button>
        <button
          className="icon"
          disabled={rescan.isPending}
          onClick={() => rescan.mutate()}
          aria-label={rescan.isPending ? 'Scanning…' : 'Rescan'}
          title="Rescan: look in your workspace folders for new or removed repositories"
        >
          <ScanSearch className={`ico ${rescan.isPending ? 'pulse' : ''}`} aria-hidden />
        </button>
        <button
          className="icon"
          disabled={folder.pending || !config.data}
          onClick={() => void folder.add()}
          aria-label="Add a folder of repositories"
          title="Add a folder of repositories…"
        >
          <FolderPlus className="ico" aria-hidden />
        </button>
      </header>

      <SignInBanner running={running} />

      {!noRepos && (
        <div className="filters">
          <span className="search-field">
            <Search className="ico" aria-hidden />
            <input
              {...plainInput}
              ref={searchRef}
              className="search"
              placeholder="Search name or branch (Ctrl+F)"
              aria-label="Search repositories"
              value={text}
              onChange={(e) => setDashboard({ text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && text) {
                  e.preventDefault()
                  e.stopPropagation()
                  setDashboard({ text: '' })
                } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                  e.preventDefault()
                  if (!cursor && ordered[0]) setCursor(ordered[0].repo.path)
                  scrollRef.current?.focus()
                }
              }}
            />
            {text && (
              <button className="icon clear" aria-label="Clear search" title="Clear (Esc)" onClick={() => setDashboard({ text: '' })}>
                <X className="ico" aria-hidden />
              </button>
            )}
          </span>
          <div className="filter-tabs" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f}
                className={`${filter === f ? 'on' : ''} ${f === 'attention' && counts.attention ? 'alert' : ''}`}
                aria-pressed={filter === f}
                onClick={() => setDashboard({ filter: f })}
              >
                {FILTER_LABEL[f]}
                <span className="filter-count">{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="spacer" />
          {(config.data?.groups.length ?? 0) > 1 && (
            <select aria-label="Group" value={group} onChange={(e) => setDashboard({ group: e.target.value })}>
              <option value="">All groups</option>
              {config.data?.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
          <select aria-label="Sort by" value={sort} onChange={(e) => setDashboard({ sort: e.target.value as SortKey })}>
            <option value="status">Sort by status</option>
            <option value="name">Sort by name</option>
            <option value="behind">Sort by behind</option>
          </select>
        </div>
      )}

      {!noRepos && (
        <div className="table-head row" aria-hidden>
          <span />
          <span>Repository</span>
          <span>Branch</span>
          <span className="th-divergence">
            <span>Behind</span>
            <span>Ahead</span>
          </span>
          <span className="num">Changes</span>
          <span>Status</span>
          <span />
        </div>
      )}
      <div
        className="table-body"
        ref={scrollRef}
        tabIndex={noRepos ? -1 : 0}
        aria-label="Repositories"
        data-pane
        onKeyDown={onListKey}
        onScroll={(e) => useApp.setState((st) => ({ dashboard: { ...st.dashboard, scroll: e.currentTarget.scrollTop } }))}
      >
        {!rows.length &&
          (noRepos ? (
            <div className="empty first-run-empty">
              <FolderGit2 className="ico" aria-hidden />
              <p className="empty-title">No repositories yet</p>
              <p>Point Gitr at the folder you keep your clones in. Every repository under it shows up here.</p>
              <button className="primary" disabled={folder.pending} onClick={() => void folder.add()}>
                <FolderPlus className="ico" aria-hidden />
                {folder.pending ? 'Adding…' : 'Add a folder…'}
              </button>
            </div>
          ) : repos.data ? (
            <div className="empty">
              <p>No repositories match.</p>
              {(text || filter !== 'all' || group) && (
                <button className="small" onClick={() => setDashboard({ text: '', filter: 'all', group: '' })}>
                  Show all
                </button>
              )}
            </div>
          ) : null)}
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((v) => {
            const it = items[v.index]
            if (!it) return null
            const place = {
              position: 'absolute' as const,
              top: 0,
              left: 0,
              right: 0,
              height: v.size,
              transform: `translateY(${v.start}px)`,
            }
            if (it.kind === 'band') {
              return (
                <div key={'band:' + it.label} className={`band ${v.index === 0 ? 'first' : ''}`} style={place}>
                  {it.label}
                  <span className="band-count">{it.count}</span>
                </div>
              )
            }
            const { repo, summary: s } = it.row
            const p = progress[repo.path]
            const changes = s ? s.staged + s.unstaged + s.conflicted : 0
            const open = () => setView({ kind: 'repo', path: repo.path })
            return (
              <div
                key={repo.path}
                className={`row ${repo.path === cursor ? 'cursor' : ''} ${attention(it.row) ? 'urgent' : ''}`}
                aria-current={repo.path === cursor ? 'true' : undefined}
                onClick={() => setCursor(repo.path)}
                style={place}
                onDoubleClick={open}
                onContextMenu={repoMenu(repo.path)}
              >
                <StatusMark summary={s} />
                <button className="link repo-link" tabIndex={-1} onClick={open} title={repo.path}>
                  {repo.name}
                </button>
                <span
                  className="mono branch-cell ellipsis"
                  title={s?.branch ? (s.upstream ? `${s.branch} → ${s.upstream}` : s.branch) : undefined}
                >
                  {s?.detached ? '(detached)' : (s?.branch ?? '…')}
                </span>
                <Divergence summary={s} />
                <span className="num counts">{changes ? <CountChips summary={s} only="changes" /> : <span className="none">–</span>}</span>
                <span className="ellipsis status-cell" title={p?.message ?? s?.error ?? undefined}>
                  <BusyOr path={repo.path}>
                    {s?.operation ? (
                      <OperationPill s={s} />
                    ) : p ? (
                      <span className={`pill ${p.state} ${p.signIn ? 'signin' : ''}`}>{batchText(p)}</span>
                    ) : s?.error ? (
                      <span className="pill error">{s.error}</span>
                    ) : !s?.upstream && s ? (
                      <span className="muted">No upstream</span>
                    ) : null}
                  </BusyOr>
                </span>
                <span className="row-tools">
                  <button
                    className="icon"
                    tabIndex={-1}
                    title="Pull"
                    aria-label={`Pull ${repo.name}`}
                    disabled={running || !s?.behind}
                    onClick={(e) => {
                      e.stopPropagation()
                      batch.mutate({ op: 'pull', paths: [repo.path], interactive: true })
                    }}
                  >
                    <ArrowDownToLine className="ico" aria-hidden />
                  </button>
                  <button
                    className="icon"
                    tabIndex={-1}
                    title="Open in VS Code"
                    aria-label={`Open ${repo.name} in VS Code`}
                    onClick={(e) => {
                      e.stopPropagation()
                      api.openWith(repo.path, 'vsCode').catch(notifyError)
                    }}
                  >
                    <Code className="ico" aria-hidden />
                  </button>
                  <button
                    className="icon"
                    tabIndex={-1}
                    title="More (Shift+F10)"
                    aria-label={`More actions for ${repo.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setCursor(repo.path)
                      repoMenu(repo.path)(e)
                    }}
                  >
                    <Ellipsis className="ico" aria-hidden />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <footer className="table-foot status-bar" aria-label="Status">
        <span className="tally">{tallyText}</span>
        {!noRepos && <Legend />}
      </footer>
    </div>
  )
}

/** "Fetching" or "Pulling", for the running batch's progress. */
const op = (states: BatchProgress[]) => (states.some((p) => p.op === 'pull') ? 'Pulling' : 'Fetching')

/** One line on the whole set, all groups and filters included. */
function tally(all: (RepoSummary | undefined)[]): string {
  const known = all.filter((s): s is RepoSummary => !!s)
  if (!all.length) return ''
  if (known.length < all.length) return `${all.length} repositories · reading status…`
  const n = (f: (s: RepoSummary) => boolean) => known.filter(f).length
  const changes = n((s) => s.staged + s.unstaged + s.conflicted > 0)
  const behind = n((s) => s.behind > 0)
  const ahead = n((s) => s.ahead > 0)
  const trouble = n((s) => !!s.error || s.conflicted > 0)
  const total = `${all.length} ${all.length === 1 ? 'repository' : 'repositories'}`
  if (!changes && !behind && !ahead && !trouble) return `${total}, all clean and up to date`
  return [
    total,
    ...(changes ? [`${changes} with changes`] : []),
    ...(behind ? [`${behind} behind`] : []),
    ...(ahead ? [`${ahead} ahead`] : []),
    ...(trouble ? [`${trouble} need${trouble === 1 ? 's' : ''} attention`] : []),
  ].join(' · ')
}

/** What the marks mean, for anyone new to them. */
function Legend() {
  const item = (cls: string, label: string) => (
    <span className="legend-item">
      <span className={`dot ${cls}`} aria-hidden />
      {label}
    </span>
  )
  return (
    <span className="legend" aria-label="Legend">
      {item('dirty', 'changes')}
      {item('behind', 'behind')}
      {item('ahead', 'ahead')}
      {item('clean', 'clean')}
      {item('operation', 'in progress')}
      {item('conflict', 'conflict')}
      {item('error', 'error')}
    </span>
  )
}
