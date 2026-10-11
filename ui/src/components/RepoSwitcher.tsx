import { useEffect, useMemo, useRef, useState } from 'react'
import { useConfig, useRepos } from '../hooks'
import { useApp } from '../store'
import { plainInput } from '../lib/inputProps'
import { rankRepos } from '../lib/git'
import type { RepoEntry } from '../types'
import { CountChips, StatusMark } from './Marks'

/** Ctrl+P: type part of a repo's name, Enter opens it. */
export function RepoSwitcher({ onClose }: { onClose: () => void }) {
  const repos = useRepos()
  const config = useConfig()
  const summaries = useApp((s) => s.summaries)
  const setView = useApp((s) => s.setView)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const matches = useMemo(() => rankRepos(repos.data ?? [], query), [repos.data, query])
  const groupName = (id: string) => config.data?.groups.find((g) => g.id === id)?.name ?? ''
  const current = matches[Math.min(index, matches.length - 1)]

  useEffect(() => {
    const el = dialog.current
    if (!el || el.open) return
    // Without showModal (jsdom) the dialog still opens, just not modally.
    if (typeof el.showModal === 'function') el.showModal()
    else el.setAttribute('open', '')
  }, [])

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [index, query])

  const open = (r: RepoEntry | undefined) => {
    if (!r) return
    setView({ kind: 'repo', path: r.path })
    onClose()
  }

  return (
    <dialog
      ref={dialog}
      className="switcher"
      aria-label="Go to repository"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog box itself, outside the panel) closes it.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="switcher-panel">
        <input
          {...plainInput}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="switcher-list"
          aria-activedescendant={current ? `switch-${current.path}` : undefined}
          placeholder="Go to repository…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIndex((i) => Math.min(matches.length - 1, i + 1))
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1))
            else if (e.key === 'Enter') open(current)
            else return
            e.preventDefault()
          }}
        />
        <ul id="switcher-list" ref={list} role="listbox" aria-label="Repositories" className="switcher-list">
          {matches.map((r) => {
            const s = summaries[r.path]
            return (
              <li
                key={r.path}
                id={`switch-${r.path}`}
                role="option"
                aria-selected={r === current}
                className={r === current ? 'active' : ''}
                onMouseMove={() => setIndex(matches.indexOf(r))}
                onClick={() => open(r)}
                title={r.path}
              >
                <StatusMark summary={s} />
                <span className="switch-name">{r.name}</span>
                <span className="switch-meta">
                  {groupName(r.groupId)}
                  {s?.branch ? ` · ${s.branch}` : ''}
                </span>
                <CountChips summary={s} />
              </li>
            )
          })}
          {!matches.length && <li className="switcher-none">No repository matches “{query.trim()}”.</li>}
        </ul>
      </div>
    </dialog>
  )
}
