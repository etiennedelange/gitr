import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ask } from '@tauri-apps/plugin-dialog'
import { Check, Minus, Plus, TriangleAlert, Undo2 } from 'lucide-react'
import { api, errorMessage } from '../api'
import { useAction, useBusy } from '../hooks'
import { useApp } from '../store'
import { dirName, fileName, fileStatus, splitChanges } from '../lib/git'
import type { FileEntry } from '../types'
import { DiffView } from './DiffView'
import { CommitBox } from './CommitBox'
import { fileMenu } from '../lib/menus'
import { copyText, showMenu } from '../nativeMenu'

interface Selection {
  path: string
  staged: boolean
}

export function Changes({ path }: { path: string }) {
  const status = useQuery({ queryKey: ['status', path], queryFn: () => api.status(path) })
  const { staged, unstaged } = useMemo(() => splitChanges(status.data?.files ?? []), [status.data])
  const [sel, setSel] = useState<Selection | null>(null)
  const lines = useQuery({ queryKey: ['lineStats', path], queryFn: () => api.lineStats(path) })
  // "s:" / "u:" + path -> added and removed lines; untracked and binary files have none.
  const lineCount = useMemo(() => {
    const m = new Map<string, { added: number; removed: number }>()
    for (const l of lines.data?.staged ?? []) m.set('s:' + l.path, l)
    for (const l of lines.data?.unstaged ?? []) m.set('u:' + l.path, l)
    return m
  }, [lines.data])

  const stage = useAction((files: string[]) => api.stage(path, files))
  const unstage = useAction((files: string[]) => api.unstage(path, files))
  // Files go to the Recycle Bin first. Any the bin refuses stay untouched until the user
  // explicitly agrees to lose them.
  const discard = useAction(async (tracked: string[], untracked: string[]) => {
    const { failed } = await api.discard(path, tracked, untracked)
    if (!failed.length) return
    const n = failed.length
    const question =
      `Couldn't move ${n} file${n === 1 ? '' : 's'} to the Recycle Bin: ${failed[0].reason}. ` +
      `Discard ${n === 1 ? 'it' : 'them'} permanently?`
    if (!(await ask(question, { title: 'Discard permanently?', kind: 'warning' }))) return
    await api.discard(
      path,
      failed.filter((f) => !f.untracked).map((f) => f.path),
      failed.filter((f) => f.untracked).map((f) => f.path),
      true,
    )
  })
  const busy = !!useBusy(path)

  // A conflict blocks everything else, so with nothing selected the first one is.
  const firstConflict = unstaged.find((f) => f.conflicted)
  // Follow the selected file across lists after stage/unstage; drop it when it disappears.
  const current = useMemo((): (Selection & { file: FileEntry }) | null => {
    if (!sel) return firstConflict ? { path: firstConflict.path, staged: false, file: firstConflict } : null
    const same = (sel.staged ? staged : unstaged).find((f) => f.path === sel.path)
    if (same) return { ...sel, file: same }
    const other = (sel.staged ? unstaged : staged).find((f) => f.path === sel.path)
    return other ? { path: other.path, staged: !sel.staged, file: other } : null
  }, [sel, staged, unstaged, firstConflict])

  const unstagedList = useRef<HTMLUListElement>(null)
  const stagedList = useRef<HTMLUListElement>(null)

  // The file to select once the selected one leaves `list`: the next one, else the previous one.
  const neighbour = (list: FileEntry[], leaving: Set<string>): FileEntry | undefined => {
    const i = list.findIndex((f) => f.path === current?.path)
    if (i < 0) return undefined
    return (
      list.slice(i + 1).find((f) => !leaving.has(f.path)) ??
      list
        .slice(0, i)
        .reverse()
        .find((f) => !leaving.has(f.path))
    )
  }

  const confirmDiscard = async (files: FileEntry[]) => {
    if (busy) return
    const label = files.length === 1 ? files[0].path : `${files.length} files`
    const question = `Discard changes to ${label}? The current version goes to the Recycle Bin.`
    if (!(await ask(question, { title: 'Discard changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Keep changes' }))) return
    // The dialog is modal to the user, not to the repo: a pull or commit may have started meanwhile.
    if (useApp.getState().busy[path]) return
    if (current && !current.staged && files.some((f) => f.path === current.path)) {
      const next = neighbour(unstaged, new Set(files.map((f) => f.path)))
      if (next) setSel({ path: next.path, staged: false })
    }
    discard.mutate([files.filter((f) => !f.untracked).map((f) => f.path), files.filter((f) => f.untracked).map((f) => f.path)])
  }

  // Staging the selected file keeps the selection (and keyboard focus) in the same list, on the
  // next file, so a run of Space presses works through the list. Returns false when the list empties.
  const toggle = (f: FileEntry, isStaged: boolean): boolean => {
    if (busy) return true
    let stays = true
    if (current?.path === f.path && current.staged === isStaged) {
      const next = neighbour(isStaged ? staged : unstaged, new Set([f.path]))
      if (next) setSel({ path: next.path, staged: isStaged })
      else stays = false
    }
    ;(isStaged ? unstage : stage).mutate([[f.path]])
    return stays
  }

  const onListKey = (e: React.KeyboardEvent, list: FileEntry[], isStaged: boolean) => {
    const i = list.findIndex((f) => f.path === current?.path && current.staged === isStaged)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) setSel({ path: next.path, staged: isStaged })
    } else if ((e.key === ' ' || e.key === 'Enter') && i >= 0) {
      // On a row's own button, Space and Enter belong to that button.
      if ((e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      // The list emptied: the file moved to the other list, so follow it with keyboard focus too.
      if (!toggle(list[i], isStaged)) (isStaged ? unstagedList : stagedList).current?.focus()
    } else if (e.key === 'Delete' && i >= 0 && !isStaged) {
      e.preventDefault()
      confirmDiscard([list[i]])
    }
  }

  const fileList = (title: string, list: FileEntry[], isStaged: boolean) => (
    <section className={`file-section ${isStaged ? 'staged' : 'unstaged'}`}>
      <div className="section-head">
        <span className="section-title">
          {title} <span className="count">{list.length}</span>
        </span>
        <div className="spacer" />
        {!isStaged && list.length > 0 && (
          <button
            className="quiet small"
            disabled={busy}
            onClick={() => confirmDiscard(list)}
            title="Move every unstaged change to the Recycle Bin"
          >
            Discard all
          </button>
        )}
        {list.length > 0 && (
          <button className="quiet small" disabled={busy} onClick={() => (isStaged ? unstage : stage).mutate([[]])}>
            {isStaged ? 'Unstage all' : 'Stage all'}
          </button>
        )}
      </div>
      {!list.length && status.data && (
        <p className="list-empty">{isStaged ? 'Nothing staged yet. Stage files with + or Space.' : 'No unstaged changes.'}</p>
      )}
      <ul
        className="file-list"
        tabIndex={0}
        data-pane
        aria-label={`${title} files`}
        ref={isStaged ? stagedList : unstagedList}
        onKeyDown={(e) => onListKey(e, list, isStaged)}
      >
        {list.map((f) => {
          const active = current?.path === f.path && current.staged === isStaged
          const st = fileStatus(f, isStaged)
          const lc = lineCount.get((isStaged ? 's:' : 'u:') + f.path)
          return (
            <li
              key={f.path}
              className={active ? 'active' : ''}
              onClick={() => setSel({ path: f.path, staged: isStaged })}
              onDoubleClick={() => toggle(f, isStaged)}
              onContextMenu={(e) => {
                e.preventDefault()
                setSel({ path: f.path, staged: isStaged })
                void showMenu(
                  fileMenu(
                    { staged: isStaged },
                    { toggle: () => toggle(f, isStaged), discard: () => void confirmDiscard([f]), copyPath: () => void copyText(f.path) },
                  ),
                )
              }}
              title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
            >
              <span className={`letter l-${st.kind}`} title={st.label}>
                <span aria-hidden>{st.letter}</span>
                <span className="sr-only">{st.label}</span>
              </span>
              <span className="fname">{fileName(f.path)}</span>
              <span className="fdir">
                <bdi>{dirName(f.path)}</bdi>
              </span>
              {lc && (
                <span className="lines mono" title={`+${lc.added} −${lc.removed} lines`}>
                  <span className="add-n">+{lc.added}</span>
                  <span className="del-n">−{lc.removed}</span>
                </span>
              )}
              <span className="row-actions">
                {!isStaged && (
                  <button
                    className="icon"
                    title="Discard"
                    tabIndex={active ? 0 : -1}
                    disabled={busy}
                    onClick={(e) => (e.stopPropagation(), confirmDiscard([f]))}
                  >
                    <Undo2 className="ico" aria-hidden />
                  </button>
                )}
                <button
                  className="icon"
                  tabIndex={active ? 0 : -1}
                  disabled={busy}
                  title={isStaged ? 'Unstage' : 'Stage'}
                  onClick={(e) => (e.stopPropagation(), toggle(f, isStaged))}
                >
                  {isStaged ? <Minus className="ico" aria-hidden /> : <Plus className="ico" aria-hidden />}
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )

  return (
    <div className="changes">
      <div className="changes-left">
        {status.isError && <div className="banner error selectable">Could not read status: {errorMessage(status.error)}</div>}
        {fileList('Unstaged', unstaged, false)}
        {fileList('Staged', staged, true)}
        <CommitBox path={path} stagedCount={staged.length} branch={status.data?.branch ?? null} />
      </div>
      <div className="changes-right">
        {/* Arrow keys move the selection without moving focus; this says where it landed. */}
        <span className="sr-only" aria-live="polite">
          {current
            ? `${fileName(current.path)}, ${fileStatus(current.file, current.staged).label}, ${current.staged ? 'staged' : 'unstaged'}`
            : ''}
        </span>
        {current?.file.conflicted && (
          <div className="conflict-note">
            <TriangleAlert className="ico" aria-hidden />
            <span className="conflict-text">
              <strong>{fileName(current.path)} has conflicts.</strong> Resolve them in your editor, then stage the file to mark it resolved.
            </span>
            <button className="small" disabled={busy} onClick={() => toggle(current.file, false)}>
              <Check className="ico" aria-hidden />
              Mark resolved
            </button>
          </div>
        )}
        {current ? (
          <DiffView
            key={`${current.staged ? 's' : 'u'}:${current.path}`}
            repo={path}
            conflicted={current.file.conflicted}
            source={{
              kind: 'worktree',
              path: current.file.path,
              origPath: current.file.origPath,
              staged: current.staged,
              untracked: current.file.untracked,
            }}
          />
        ) : (
          <div className="empty diff-empty">
            {status.data && !status.data.files.length ? (
              <div className="empty-stack">
                <Check className="ico" aria-hidden />
                <span className="empty-title">Working tree clean</span>
                <span className="muted">No changes to commit. Edits you make in this repository show up here.</span>
              </div>
            ) : (
              <span className="muted">Select a file to see its changes</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
