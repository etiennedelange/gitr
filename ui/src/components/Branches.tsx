import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ask } from '@tauri-apps/plugin-dialog'
import { api, errorMessage } from '../api'
import { notifyError, useAction, useBusy } from '../hooks'
import { useApp } from '../store'
import type { Branch, RemoteInfo } from '../types'
import { branchMenu } from '../lib/menus'
import { copyText, showMenu } from '../nativeMenu'
import { plainInput } from '../lib/inputProps'
import { ago, branchNameProblem } from '../lib/git'

export function Branches({ path, remote }: { path: string; remote: RemoteInfo | null }) {
  const branches = useQuery({ queryKey: ['branches', path], queryFn: () => api.branches(path) })
  const [filter, setFilter] = useState('')
  const [newName, setNewName] = useState('')
  // Set when Create is pressed with no name, until the name changes.
  const [nameMissing, setNameMissing] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  const busy = !!useBusy(path)
  // Switching branches during a merge, rebase, cherry-pick or revert would make it worse.
  const operation = useApp((st) => st.summaries[path]?.operation ?? null)
  const noSwitch = busy || !!operation

  const shortName = (b: Branch) => (b.remote ? b.name.slice(b.name.indexOf('/') + 1) : b.name)

  const checkout = useAction(
    (b: Branch) => {
      const local = b.remote && branches.data?.find((x) => !x.remote && x.name === shortName(b))
      return local ? api.checkout(path, local.name, false) : api.checkout(path, b.name, b.remote)
    },
    () => 'Checked out',
  )
  const create = useAction(
    (name: string) => api.createBranch(path, name, null, true),
    () => 'Branch created',
  )

  const nameProblem = branchNameProblem(newName.trim()) ?? (nameMissing ? 'Type a name for the new branch.' : null)

  const { local, remotes } = useMemo(() => {
    const q = filter.toLowerCase()
    const all = (branches.data ?? []).filter((b) => !q || b.name.toLowerCase().includes(q))
    return { local: all.filter((b) => !b.remote), remotes: all.filter((b) => b.remote && !b.name.endsWith('/HEAD')) }
  }, [branches.data, filter])

  const remove = async (b: Branch) => {
    if (busy) return
    const unpushed = b.ahead ? ` It has ${b.ahead} commit${b.ahead === 1 ? '' : 's'} not pushed.` : ''
    if (
      !(await ask(`Delete local branch ${b.name}?${unpushed}`, {
        title: 'Delete branch',
        kind: 'warning',
        okLabel: 'Delete branch',
        cancelLabel: 'Cancel',
      }))
    )
      return
    try {
      await api.deleteBranch(path, b.name, false)
    } catch (e) {
      const msg = errorMessage(e)
      if (!/not fully merged/i.test(msg)) return notifyError(e)
      if (
        !(await ask(`${b.name} is not fully merged. Delete anyway?`, {
          title: 'Force delete',
          kind: 'warning',
          okLabel: 'Force delete',
          cancelLabel: 'Cancel',
        }))
      )
        return
      try {
        await api.deleteBranch(path, b.name, true)
      } catch (e2) {
        return notifyError(e2)
      }
    }
    useApp.getState().toast('info', `Deleted ${b.name}`)
    branches.refetch()
    api.repoSummary(path).then(useApp.getState().setSummary, () => {})
  }

  const open = (name: string, pr = false) =>
    api.openRemote(path, pr ? { kind: 'pullRequest', branch: name, target: null } : { kind: 'branch', branch: name }).catch(notifyError)

  const row = (b: Branch) => (
    <li
      key={(b.remote ? 'r:' : 'l:') + b.name}
      className={b.isHead ? 'head' : ''}
      onDoubleClick={() => !b.isHead && !noSwitch && checkout.mutate([b])}
      onContextMenu={(e) => {
        e.preventDefault()
        void showMenu(
          branchMenu(
            { branch: b, hasRemote: !!remote },
            {
              checkout: () => !noSwitch && checkout.mutate([b]),
              browser: () => void open(shortName(b)),
              pullRequest: () => void open(b.name, true),
              remove: () => void remove(b),
              copyName: () => void copyText(b.name),
            },
          ),
        )
      }}
    >
      <span className="bmark" {...(b.isHead ? { role: 'img', 'aria-label': 'Current branch', title: 'Current branch' } : {})}></span>
      <span className="mono bname">{b.name}</span>
      <span className="muted mono small">
        {b.upstream && !b.gone ? `→ ${b.upstream}` : ''}
        {b.gone ? 'upstream gone' : ''}
      </span>
      <span className="mono small">
        {b.behind ? <span className="behind">↓{b.behind} </span> : null}
        {b.ahead ? <span className="ahead">↑{b.ahead}</span> : null}
      </span>
      <span className="muted small">{b.committedAt ? ago(b.committedAt) : ''}</span>
      <span className="row-actions">
        {!b.isHead && (
          <button className="small" disabled={noSwitch} onClick={() => checkout.mutate([b])}>
            Checkout
          </button>
        )}
        {remote && (
          <button className="small" title="Open in browser" onClick={() => open(shortName(b))}>
            Open
          </button>
        )}
        {remote && !b.remote && (
          <button className="small" title="Create pull request" onClick={() => open(b.name, true)}>
            PR
          </button>
        )}
        {!b.remote && !b.isHead && (
          <button className="small danger" disabled={busy} onClick={() => remove(b)}>
            Delete
          </button>
        )}
      </span>
    </li>
  )

  return (
    <div className="branches">
      <div className="filters">
        <input
          {...plainInput}
          className="search"
          placeholder="Filter branches…"
          aria-label="Filter branches"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="spacer" />
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newName.trim()) {
              setNameMissing(true)
              nameInput.current?.focus()
              return
            }
            if (!nameProblem && !noSwitch) create.mutate([newName.trim()], { onSuccess: () => setNewName('') })
          }}
        >
          {nameProblem && (
            <span className="field-hint" role="alert">
              {nameProblem}
            </span>
          )}
          <input
            {...plainInput}
            ref={nameInput}
            placeholder="new-branch-name"
            aria-label="New branch name"
            value={newName}
            aria-invalid={!!nameProblem}
            onChange={(e) => {
              setNewName(e.target.value)
              setNameMissing(false)
            }}
          />
          <button type="submit" disabled={!!nameProblem || create.isPending || noSwitch}>
            Create & checkout
          </button>
        </form>
      </div>
      <div className="branch-lists" data-pane>
        {branches.isError && <div className="banner error selectable">{errorMessage(branches.error)}</div>}
        <h2>Local ({local.length})</h2>
        <ul className="branch-list">{local.map(row)}</ul>
        <h2>Remote ({remotes.length})</h2>
        <ul className="branch-list">{remotes.map(row)}</ul>
      </div>
    </div>
  )
}
