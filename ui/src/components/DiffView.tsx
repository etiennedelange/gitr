import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '../api'
import { dirName, fileName, toSplitRows } from '../lib/git'
import type { DiffLine, Hunk } from '../types'
import { diffMenu } from '../lib/menus'
import { copyText, showMenu } from '../nativeMenu'

type Mode = 'unified' | 'split'

const SPLIT_MIN_WIDTH = 560

const sign = { context: ' ', add: '+', remove: '-', nonewline: '\\' } as const

function loadMode(): Mode {
  try {
    return localStorage.getItem('diffMode') === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

/** Where the diff comes from: the working tree (Changes) or a commit (History). */
export type DiffSource =
  | { kind: 'worktree'; path: string; origPath: string | null; staged: boolean; untracked: boolean }
  | { kind: 'commit'; sha: string; path: string; origPath: string | null }

export function DiffView({ repo, source, note, conflicted }: { repo: string; source: DiffSource; note?: string; conflicted?: boolean }) {
  const [mode, setMode] = useState<Mode>(loadMode)
  // Commit diffs never change, so they stay cached; worktree diffs are invalidated on refresh.
  const diff = useQuery(
    source.kind === 'commit'
      ? {
          queryKey: ['commitDiff', repo, source.sha, source.path],
          queryFn: () => api.commitFileDiff(repo, source.sha, source.path, source.origPath),
          staleTime: Infinity,
        }
      : {
          queryKey: ['diff', repo, source.path, source.staged],
          queryFn: () => api.fileDiff(repo, source.path, source.staged, source.untracked && !source.staged),
        },
  )

  // Two columns of code need room; in a narrow pane the diff shows unified instead.
  const root = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < SPLIT_MIN_WIDTH))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const shown: Mode = narrow ? 'unified' : mode

  const changeMode = (m: Mode) => {
    try {
      localStorage.setItem('diffMode', m)
    } catch {
      // Storage can be unavailable; the choice then lasts until the view closes.
    }
    setMode(m)
  }

  return (
    <div className="diff" ref={root}>
      <div className="diff-head">
        <span className="diff-path ellipsis selectable" title={source.origPath ? `${source.origPath} → ${source.path}` : source.path}>
          {source.origPath ? <span className="diff-dir">{source.origPath} → </span> : null}
          {dirName(source.path) ? <span className="diff-dir">{dirName(source.path)}/</span> : null}
          <span className="diff-file">{fileName(source.path)}</span>
        </span>
        {note && <span className="diff-note">{note}</span>}
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="Diff layout">
          <button className={shown === 'unified' ? 'on' : ''} onClick={() => changeMode('unified')}>
            Unified
          </button>
          <button
            className={shown === 'split' ? 'on' : ''}
            disabled={narrow}
            title={narrow ? 'Too narrow for a side-by-side diff' : undefined}
            onClick={() => changeMode('split')}
          >
            Split
          </button>
        </div>
      </div>
      <div
        className="diff-body"
        role="region"
        tabIndex={0}
        data-pane
        aria-label={`Diff of ${source.path}`}
        onContextMenu={(e) => {
          e.preventDefault()
          const text = window.getSelection()?.toString() ?? ''
          void showMenu(diffMenu({ hasSelection: !!text }, { copy: () => void copyText(text) }))
        }}
      >
        {diff.isLoading && (
          <div className="empty loading" role="status">
            Loading…
          </div>
        )}
        {diff.isError && <div className="banner error selectable">{errorMessage(diff.error)}</div>}
        {diff.data?.binary && <div className="empty">Binary file</div>}
        {diff.data && !diff.data.binary && !diff.data.hunks.length && (
          <div className="empty">
            {conflicted
              ? 'Git has no diff to show for this file while it is conflicted. Open it in your editor to resolve the conflict markers.'
              : 'No textual changes'}
          </div>
        )}
        {diff.data?.hunks.map((h, i) => (shown === 'unified' ? <Unified key={i} hunk={h} /> : <Split key={i} hunk={h} />))}
        {diff.data?.truncated && <div className="banner">Diff truncated: the file is too large to show completely.</div>}
      </div>
    </div>
  )
}

function Unified({ hunk }: { hunk: Hunk }) {
  return (
    <table className="hunk unified">
      <tbody>
        <tr className="hunk-header">
          <td colSpan={3}>{hunk.header}</td>
        </tr>
        {hunk.lines.map((l, i) => (
          <tr key={i} className={l.kind}>
            <td className="ln">{l.oldNo ?? ''}</td>
            <td className="ln">{l.newNo ?? ''}</td>
            <td className="code selectable">
              <span className="sign">{sign[l.kind]}</span>
              {l.text}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Side({ line, no }: { line: DiffLine | null; no: number | null | undefined }) {
  return (
    <>
      <td className={`ln ${line?.kind ?? 'empty'}`}>{no ?? ''}</td>
      <td className={`code selectable ${line?.kind ?? 'empty'}`}>{line?.text ?? ''}</td>
    </>
  )
}

function Split({ hunk }: { hunk: Hunk }) {
  return (
    // Fixed column widths, so both sides get half whatever their lines are, and every hunk's
    // divider lines up with the next one's.
    <table className="hunk split">
      <colgroup>
        <col className="ln-col" />
        <col />
        <col className="ln-col" />
        <col />
      </colgroup>
      <tbody>
        <tr className="hunk-header">
          <td colSpan={4}>{hunk.header}</td>
        </tr>
        {toSplitRows(hunk).map((r, i) => (
          <tr key={i}>
            <Side line={r.left} no={r.left?.oldNo} />
            <Side line={r.right} no={r.right?.newNo} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}
