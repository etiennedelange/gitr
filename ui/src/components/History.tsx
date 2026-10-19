import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ask } from '@tauri-apps/plugin-dialog'
import { ArrowUp, ChevronRight, Copy, GitBranch, GitMerge, History as HistoryIcon, RotateCcw, Tag, Undo2 } from 'lucide-react'
import { api, errorMessage } from '../api'
import { notifyError, useBusy } from '../hooks'
import { useApp } from '../store'
import { dirName, fileName, letterStatus } from '../lib/git'
import { reportOutcome } from '../lib/integrate'
import { operationTitle } from '../lib/operation'
import { absoluteTime, relativeTime } from '../lib/time'
import { commitMenu } from '../lib/menus'
import { copyText, showMenu } from '../nativeMenu'
import type { CommitDetails, CommitFile, LogEntry, RefLabel, RemoteInfo, ResetMode } from '../types'
import { DiffView } from './DiffView'
import { ResetDialog } from './ResetDialog'
import { FileViewToggle } from './FileViewToggle'
import { Splitter } from './Splitter'
import { useLayout } from '../layout'
import { buildTree, listRows, treeRows } from '../lib/fileTree'

const PAGE = 200
const ROW_H = 44
const short = (sha: string) => sha.slice(0, 7)
/** Narrowest the commit list and the commit beside it may get. */
const LIST_MIN = 260
const COMMIT_MIN = 340
/** Shortest a commit's file list and its diff may get. */
const FILES_MIN = 72
const DIFF_MIN = 120

export function History({ path, remote }: { path: string; remote: RemoteInfo | null }) {
  const log = useInfiniteQuery({
    queryKey: ['log', path],
    queryFn: ({ pageParam }) => api.log(path, pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.hasMore ? all.reduce((n, p) => n + p.commits.length, 0) : undefined),
  })
  const commits = useMemo(() => log.data?.pages.flatMap((p) => p.commits) ?? [], [log.data])
  const [selSha, setSelSha] = useState<string | null>(null)
  // The selection follows the commit by SHA across reloads; when it left the branch (amend,
  // reset, rebase) the top commit takes over.
  const selected = commits.find((c) => c.sha === selSha) ?? commits[0] ?? null
  const index = selected ? commits.indexOf(selected) : -1

  const s = useApp((st) => st.summaries[path])
  const lastReset = useApp((st) => st.resets[path])
  const busyOp = useBusy(path)
  const operation = s?.operation ?? null
  const blocked = busyOp ? `Busy: ${busyOp}` : operation ? `${operationTitle(operation)}: finish or abort it first` : null
  const target = s?.detached ? 'HEAD' : (s?.branch ?? 'HEAD')

  const listRef = useRef<HTMLDivElement>(null)
  const filesRef = useRef<HTMLUListElement>(null)
  const virtual = useVirtualizer({
    count: commits.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  })
  const items = virtual.getVirtualItems()
  const lastShown = items.at(-1)?.index ?? -1

  // Next page once the end of the loaded commits scrolls into view.
  useEffect(() => {
    if (lastShown >= commits.length - 20 && log.hasNextPage && !log.isFetchingNextPage) void log.fetchNextPage()
  }, [lastShown, commits.length, log])

  const select = (i: number) => {
    const c = commits[Math.max(0, Math.min(commits.length - 1, i))]
    if (!c) return
    setSelSha(c.sha)
    virtual.scrollToIndex(commits.indexOf(c), { align: 'auto' })
  }

  const onListKey = (e: React.KeyboardEvent) => {
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? ROW_H) / ROW_H) - 1)
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }
    if (e.key in moves) select(index + moves[e.key])
    else if (e.key === 'Home') select(0)
    else if (e.key === 'End') select(commits.length - 1)
    else if (e.key === 'Enter' || e.key === 'ArrowRight') filesRef.current?.focus()
    else return
    e.preventDefault()
  }

  const [resetTo, setResetTo] = useState<LogEntry | null>(null)

  const revert = async (c: LogEntry) => {
    if (blocked) return
    const merge = c.parents.length > 1
    const question = merge
      ? `Revert the merge “${c.subject}”? This adds a new commit that undoes the changes the merge brought in (compared with its first parent). Nothing is pushed.`
      : `Revert “${c.subject}”? This adds a new commit that undoes its changes. Nothing is pushed.`
    if (!(await ask(question, { title: 'Revert commit', kind: 'warning', okLabel: 'Revert', cancelLabel: 'Cancel' }))) return
    try {
      const outcome = await api.revertCommit(path, c.sha)
      // The new commit lands on top; let the selection fall back to it.
      setSelSha(null)
      reportOutcome(outcome, `Reverted ${short(c.sha)}`)
    } catch (e) {
      notifyError(e)
    }
  }

  const reset = async (c: LogEntry, mode: ResetMode) => {
    setResetTo(null)
    try {
      const previousHead = await api.resetBranch(path, c.sha, mode)
      const label = `${target} back to ${short(c.sha)}`
      const record = { previousHead, label }
      useApp.getState().setReset(path, record)
      setSelSha(c.sha)
      useApp.getState().toast('info', `Moved ${label}`, null, null, { label: 'Undo', run: () => undoReset(record.previousHead) })
    } catch (e) {
      notifyError(e)
    }
  }

  const undoReset = async (previousHead: string) => {
    try {
      await api.undoReset(path, previousHead)
      useApp.getState().setReset(path, null)
      setSelSha(previousHead)
      useApp.getState().toast('info', 'Reset undone')
    } catch (e) {
      notifyError(e)
    }
  }

  const hostLabel = remote?.kind === 'ado' ? 'ADO' : 'GitHub'
  const openMenu = (c: LogEntry, i: number) =>
    void showMenu(
      commitMenu(
        { isHead: i === 0, canWrite: !blocked, hasRemote: !!remote, hostLabel },
        {
          copySha: () => void copyText(c.sha),
          copySubject: () => void copyText(c.subject),
          copyMessage: () => void api.commitDetails(path, c.sha).then((d) => copyText(d.message), notifyError),
          browser: () => void api.openRemote(path, { kind: 'commit', sha: c.sha }).catch(notifyError),
          revert: () => void revert(c),
          reset: () => setResetTo(c),
        },
      ),
    )

  const unborn = log.isSuccess && !commits.length
  const listWidth = useLayout((s) => s.historyList)
  const setPane = useLayout((s) => s.setPane)
  const historyRoot = useRef<HTMLDivElement>(null)
  const historyLeft = useRef<HTMLElement>(null)

  return (
    <div
      className="history"
      ref={historyRoot}
      style={
        listWidth
          ? { gridTemplateColumns: `clamp(${LIST_MIN}px, ${listWidth}px, calc(100% - ${COMMIT_MIN}px)) 0 minmax(${COMMIT_MIN}px, 1fr)` }
          : undefined
      }
    >
      <section className="history-left" aria-label="Commits" ref={historyLeft}>
        <div className="section-head">
          <span className="section-title">
            History {log.isSuccess && <span className="count">{log.hasNextPage ? `${commits.length}+` : commits.length}</span>}
          </span>
          <div className="spacer" />
          {lastReset && (
            <button
              className="small undo-reset"
              disabled={!!busyOp}
              title={`Move ${lastReset.label.replace(/ back to .*/, '')} back to ${short(lastReset.previousHead)}, where the reset found it`}
              onClick={() => void undoReset(lastReset.previousHead)}
            >
              <Undo2 className="ico" aria-hidden />
              Undo reset
            </button>
          )}
        </div>
        {log.isError && <div className="banner error selectable">Could not read history: {errorMessage(log.error)}</div>}
        {log.isPending && <div className="empty loading">Loading history…</div>}
        {unborn && (
          <div className="empty history-empty">
            <HistoryIcon className="ico" aria-hidden />
            <span>No commits yet</span>
            <span className="muted small">The first commit you make in Changes starts the history.</span>
          </div>
        )}
        {commits.length > 0 && (
          <div
            className="commit-list"
            ref={listRef}
            role="listbox"
            tabIndex={0}
            data-pane
            aria-label={`Commits on ${target}`}
            aria-activedescendant={selected ? `commit-${selected.sha}` : undefined}
            onKeyDown={onListKey}
          >
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {items.map((v) => {
                const c = commits[v.index]
                return (
                  <CommitRow
                    key={c.sha}
                    commit={c}
                    first={v.index === 0}
                    last={v.index === commits.length - 1 && !log.hasNextPage}
                    active={c === selected}
                    top={v.start}
                    onSelect={() => setSelSha(c.sha)}
                    onMenu={() => {
                      setSelSha(c.sha)
                      openMenu(c, v.index)
                    }}
                  />
                )
              })}
            </div>
            {log.isFetchingNextPage && <div className="empty small">Loading more…</div>}
          </div>
        )}
      </section>
      <Splitter
        axis="x"
        label="Resize the commit list"
        size={() => historyLeft.current?.offsetWidth ?? 0}
        min={LIST_MIN}
        max={() => (historyRoot.current?.clientWidth ?? 0) - COMMIT_MIN}
        onResize={(px) => setPane('historyList', px)}
        onReset={() => setPane('historyList', undefined)}
      />
      <section className="history-right" aria-label="Commit">
        {selected ? (
          <CommitPane
            key={selected.sha}
            path={path}
            commit={selected}
            isHead={index === 0}
            blocked={blocked}
            filesRef={filesRef}
            onBack={() => listRef.current?.focus()}
            isLoaded={(sha) => commits.some((c) => c.sha === sha)}
            onParent={(sha) => select(commits.findIndex((c) => c.sha === sha))}
            onRevert={() => void revert(selected)}
            onReset={() => setResetTo(selected)}
          />
        ) : (
          <div className="empty diff-empty">{unborn ? 'Nothing to show yet' : log.isSuccess ? 'Select a commit' : ''}</div>
        )}
      </section>
      {resetTo && (
        <ResetDialog
          path={path}
          commit={resetTo}
          target={target}
          upstream={s?.upstream ?? null}
          onCancel={() => setResetTo(null)}
          onReset={(mode) => void reset(resetTo, mode)}
        />
      )}
    </div>
  )
}

function CommitRow(props: {
  commit: LogEntry
  first: boolean
  last: boolean
  active: boolean
  top: number
  onSelect: () => void
  onMenu: () => void
}) {
  const { commit: c, first: head, active } = props
  const merge = c.parents.length > 1
  const mark = [head && 'head', c.unpushed && 'unpushed', merge && 'merge'].filter(Boolean).join(' ')
  const markLabel = [head && 'HEAD', c.unpushed && 'not pushed', merge && 'merge commit'].filter(Boolean).join(', ')
  return (
    <div
      id={`commit-${c.sha}`}
      role="option"
      aria-selected={active}
      className={`commit-row${active ? ' active' : ''}${props.first ? ' first' : ''}${props.last ? ' last' : ''}`}
      style={{ transform: `translateY(${props.top}px)` }}
      onClick={props.onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onMenu()
      }}
    >
      <span className={`cmark ${mark}`} {...(markLabel ? { role: 'img', 'aria-label': markLabel, title: markLabel } : {})} />
      <span className="commit-lines">
        <span className="commit-line1">
          <span className="commit-subject">{c.subject || <em className="muted">(no message)</em>}</span>
          <Refs refs={c.refs} />
        </span>
        <span className="commit-line2">
          {c.unpushed && (
            <span className="unpushed-tag">
              <ArrowUp className="ico" aria-hidden />
              <span className="tag-text">not pushed</span>
            </span>
          )}
          {merge && (
            <span className="merge-tag">
              <GitMerge className="ico" aria-hidden />
              merge
            </span>
          )}
          <span className="commit-author">{c.authorName}</span>
          <span className="sep" aria-hidden>
            ·
          </span>
          <span title={absoluteTime(c.authorTime)}>{relativeTime(c.authorTime)}</span>
          <span className="sep" aria-hidden>
            ·
          </span>
          <span className="mono commit-sha">{short(c.sha)}</span>
        </span>
      </span>
    </div>
  )
}

const REF_ORDER: Record<RefLabel['kind'], number> = { head: 0, local: 1, tag: 2, remote: 3 }

/** One chip plus “+n”: the list column is at most 380px, and the subject comes first. */
function Refs({ refs, max = 1 }: { refs: RefLabel[]; max?: number }) {
  if (!refs.length) return null
  const sorted = [...refs].sort((a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind])
  const shown = sorted.slice(0, max)
  const rest = sorted.slice(max)
  return (
    <span className="refs">
      {shown.map((r) => (
        <RefChip key={r.kind + r.name} r={r} />
      ))}
      {rest.length > 0 && (
        <span className="ref more" title={rest.map((r) => r.name).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  )
}

function RefChip({ r }: { r: RefLabel }) {
  const title = { head: `Checked out: ${r.name}`, local: `Branch ${r.name}`, remote: `Remote branch ${r.name}`, tag: `Tag ${r.name}` }[
    r.kind
  ]
  return (
    <span className={`ref ${r.kind}`} title={title}>
      {r.kind === 'tag' ? <Tag className="ico" aria-hidden /> : r.kind !== 'remote' ? <GitBranch className="ico" aria-hidden /> : null}
      <span className="ref-name">{r.name}</span>
    </span>
  )
}

function CommitPane({
  path,
  commit: c,
  isHead,
  blocked,
  filesRef,
  onBack,
  isLoaded,
  onParent,
  onRevert,
  onReset,
}: {
  path: string
  commit: LogEntry
  isHead: boolean
  blocked: string | null
  filesRef: React.RefObject<HTMLUListElement | null>
  onBack: () => void
  isLoaded: (sha: string) => boolean
  onParent: (sha: string) => void
  onRevert: () => void
  onReset: () => void
}) {
  const details = useQuery({
    queryKey: ['commit', path, c.sha],
    queryFn: () => api.commitDetails(path, c.sha),
    staleTime: Infinity,
  })
  const files = useMemo(() => details.data?.files ?? [], [details.data])
  const fileView = useLayout((s) => s.fileView)
  const filesHeight = useLayout((s) => s.historyFiles)
  const setPane = useLayout((s) => s.setPane)
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const toggleFolder = (dir: string) =>
    setClosed((c) => {
      const next = new Set(c)
      if (!next.delete(dir)) next.add(dir)
      return next
    })
  const rows = useMemo(() => (fileView === 'tree' ? treeRows(buildTree(files), closed) : listRows(files)), [files, fileView, closed])
  // The files in the order they show, without those in collapsed folders: what the arrow keys walk.
  const shown = useMemo(() => rows.flatMap((r) => (r.kind === 'file' ? [r.file] : [])), [rows])
  const [selPath, setSelPath] = useState<string | null>(null)
  const file = files.find((f) => f.path === selPath) ?? shown[0] ?? files[0] ?? null
  const fi = file ? shown.indexOf(file) : -1
  const merge = c.parents.length > 1
  const pane = useRef<HTMLDivElement>(null)
  const filesBox = useRef<HTMLDivElement>(null)
  const tree = fileView === 'tree'

  const onFilesKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = shown[Math.max(0, Math.min(shown.length - 1, fi + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) setSelPath(next.path)
    } else if (e.key === 'ArrowLeft' || e.key === 'Escape') onBack()
    else return
    e.preventDefault()
  }

  return (
    <div className="commit-pane" ref={pane}>
      <header className="commit-head">
        <div className="commit-title-row">
          <h2 className="commit-title selectable">{c.subject || '(no message)'}</h2>
          <div className="commit-actions-row">
            <button className="small" disabled={!!blocked} title={blocked ?? 'Add a commit that undoes this one'} onClick={onRevert}>
              <RotateCcw className="ico" aria-hidden />
              Revert
            </button>
            <button
              className="small"
              disabled={!!blocked || isHead}
              title={blocked ?? (isHead ? 'The branch is already here' : 'Move the branch back to this commit')}
              onClick={onReset}
            >
              <Undo2 className="ico" aria-hidden />
              Reset to here…
            </button>
          </div>
        </div>
        <Meta commit={c} details={details.data} isLoaded={isLoaded} onParent={onParent} />
        {details.data && <Body message={details.data.message} />}
        {details.isError && <div className="banner error small selectable">{errorMessage(details.error)}</div>}
      </header>
      <div
        className="commit-files"
        ref={filesBox}
        style={filesHeight ? { flex: 'none', height: filesHeight, maxHeight: `calc(100% - ${DIFF_MIN}px)` } : undefined}
      >
        <div className="files-head">
          <span className="files-title">Files {details.data && <span className="count">{files.length}</span>}</span>
          {details.data && <Totals files={files} />}
          {merge && (
            <span className="files-note" title={`Changes compared with the first parent, ${short(c.parents[0])}`}>
              <GitMerge className="ico" aria-hidden />
              vs first parent
            </span>
          )}
          <FileViewToggle />
        </div>
        {details.isPending && <div className="empty small loading">Loading…</div>}
        {details.data && !files.length && <div className="empty small">No file changes</div>}
        {files.length > 0 && (
          <ul
            className="file-list"
            role={tree ? 'tree' : 'listbox'}
            tabIndex={0}
            data-pane
            ref={filesRef}
            onKeyDown={onFilesKey}
            aria-label="Changed files"
            aria-activedescendant={file && fi >= 0 ? `file-${files.indexOf(file)}` : undefined}
          >
            {rows.map((r) =>
              r.kind === 'folder' ? (
                <li
                  key={`dir:${r.path}`}
                  className="folder"
                  role="treeitem"
                  aria-level={r.depth + 1}
                  aria-expanded={r.open}
                  aria-selected={false}
                  style={{ '--depth': r.depth } as CSSProperties}
                  title={r.path}
                  onClick={() => toggleFolder(r.path)}
                >
                  <span className="folder-toggle">
                    <ChevronRight className={`ico chevron${r.open ? ' open' : ''}`} aria-hidden />
                    <span className="fname">{r.name}</span>
                  </span>
                </li>
              ) : (
                <FileRow
                  key={r.file.path}
                  id={`file-${files.indexOf(r.file)}`}
                  f={r.file}
                  depth={tree ? r.depth : null}
                  active={r.file === file}
                  onSelect={() => setSelPath(r.file.path)}
                />
              ),
            )}
          </ul>
        )}
        {details.data?.truncated && <div className="banner small">Too many files to list them all.</div>}
      </div>
      <Splitter
        axis="y"
        label="Resize the file list"
        size={() => filesBox.current?.offsetHeight ?? 0}
        min={FILES_MIN}
        max={() => (pane.current?.getBoundingClientRect().bottom ?? 0) - (filesBox.current?.getBoundingClientRect().top ?? 0) - DIFF_MIN}
        onResize={(px) => setPane('historyFiles', px)}
        onReset={() => setPane('historyFiles', undefined)}
      />
      <div className="commit-diff">
        {file ? (
          <DiffView
            key={file.path}
            repo={path}
            source={{ kind: 'commit', sha: c.sha, path: file.path, origPath: file.origPath }}
            note={!c.parents.length ? 'root commit' : undefined}
          />
        ) : (
          <div className="empty diff-empty">{details.isPending ? '' : 'Select a file to view its diff'}</div>
        )}
      </div>
    </div>
  )
}

function Meta(props: { commit: LogEntry; details?: CommitDetails; isLoaded: (sha: string) => boolean; onParent: (sha: string) => void }) {
  const { commit: c, details: d } = props
  const committer = d && (d.committerName !== d.authorName || d.committerEmail !== d.authorEmail) ? d : null
  return (
    <div className="commit-meta">
      <span className="selectable" title={c.authorEmail}>
        {c.authorName}
      </span>
      <span className="sep" aria-hidden>
        ·
      </span>
      <span title={relativeTime(c.authorTime)}>{absoluteTime(c.authorTime)}</span>
      <span className="sep" aria-hidden>
        ·
      </span>
      <button className="sha-chip mono" title={`Copy ${c.sha}`} onClick={() => void copyText(c.sha)}>
        {short(c.sha)}
        <Copy className="ico" aria-hidden />
      </button>
      {c.parents.length > 0 && (
        <span className="parents">
          {c.parents.length === 1 ? 'Parent' : 'Parents'}
          {c.parents.map((p) =>
            props.isLoaded(p) ? (
              <button key={p} className="link mono" title={`Show ${p}`} onClick={() => props.onParent(p)}>
                {short(p)}
              </button>
            ) : (
              <span key={p} className="mono unloaded selectable" title={`${p}: not on this branch's first-parent line, or not loaded yet`}>
                {short(p)}
              </span>
            ),
          )}
        </span>
      )}
      {committer && (
        <span className="committer muted" title={committer.committerEmail}>
          Committed by {committer.committerName}, {relativeTime(committer.committerTime)}
        </span>
      )}
    </div>
  )
}

/** The message after the subject line, if any. */
function Body({ message }: { message: string }) {
  const body = message.split('\n').slice(1).join('\n').replace(/^\n+/, '').trimEnd()
  if (!body) return null
  return <pre className="commit-body selectable">{body}</pre>
}

function Totals({ files }: { files: CommitFile[] }) {
  const added = files.reduce((n, f) => n + f.added, 0)
  const removed = files.reduce((n, f) => n + f.removed, 0)
  return (
    <span className="lines mono" title={`+${added} −${removed} lines`}>
      <span className="add-n">+{added}</span>
      <span className="del-n">−{removed}</span>
    </span>
  )
}

/** A changed file; `depth` is its level in the tree view, null in the list view. */
function FileRow(props: { id: string; f: CommitFile; depth: number | null; active: boolean; onSelect: () => void }) {
  const { id, f, depth, active, onSelect } = props
  const st = letterStatus(f.status.charAt(0) || 'M')
  const tree = depth !== null
  return (
    <li
      id={id}
      role={tree ? 'treeitem' : 'option'}
      aria-level={tree ? depth + 1 : undefined}
      aria-selected={active}
      className={active ? 'active' : ''}
      style={depth ? ({ '--depth': depth } as CSSProperties) : undefined}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onSelect()
      }}
      title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
    >
      <span className={`letter l-${st.kind}`} title={st.label}>
        <span aria-hidden>{st.letter}</span>
        <span className="sr-only">{st.label}</span>
      </span>
      <span className="fname">{fileName(f.path)}</span>
      {(!tree || f.origPath) && (
        <span className="fdir">
          <bdi>{f.origPath ? `from ${f.origPath}` : dirName(f.path)}</bdi>
        </span>
      )}
      {f.binary ? (
        <span className="lines muted">binary</span>
      ) : (
        <span className="lines mono">
          <span className="add-n">+{f.added}</span>
          <span className="del-n">−{f.removed}</span>
        </span>
      )}
    </li>
  )
}
