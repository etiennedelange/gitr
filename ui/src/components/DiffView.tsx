import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '../api'
import { dirName, fileName, toSplitRows } from '../lib/git'
import type { DiffLine, DiffSyntax, Hunk, Span } from '../types'
import { diffMenu } from '../lib/menus'
import { copyText, showMenu } from '../nativeMenu'
import { createWheelZoomAccumulator, DEFAULT_ZOOM, stepZoom, ZOOM_PRESETS } from '../lib/zoom'

type Mode = 'unified' | 'split'
/** Only the changed hunks, or the whole file with its changes inline. */
type Extent = 'hunks' | 'full'

const SPLIT_MIN_WIDTH = 560

const sign = { context: ' ', add: '+', remove: '-', nonewline: '\\' } as const

function loadMode(): Mode {
  try {
    return localStorage.getItem('diffMode') === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

function loadExtent(): Extent {
  try {
    return localStorage.getItem('diffExtent') === 'full' ? 'full' : 'hunks'
  } catch {
    return 'hunks'
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable; the choice then lasts until the view closes.
  }
}

function loadTextZoom(): number {
  try {
    const z = Number(localStorage.getItem('diffZoom'))
    return (ZOOM_PRESETS as readonly number[]).includes(z) ? z : DEFAULT_ZOOM
  } catch {
    return DEFAULT_ZOOM
  }
}

/**
 * Ctrl + wheel and Ctrl +/−/0 over the diff size its text alone, one zoom preset per step,
 * remembered across diffs. The app-wide zoom leaves wheel events inside `data-own-zoom` to this.
 */
function useTextZoom(root: RefObject<HTMLDivElement | null>) {
  const [zoom, setZoom] = useState(loadTextZoom)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else remember('diffZoom', String(zoom))
  }, [zoom])
  useEffect(() => {
    const el = root.current
    if (!el) return
    const accumulate = createWheelZoomAccumulator()
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const dir = accumulate(e.deltaY, e.deltaMode)
      if (dir) setZoom((z) => stepZoom(z, dir))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [root])
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey) return
    const k = e.key
    if (k === '=' || k === '+') setZoom(stepZoom(zoom, 1))
    else if (k === '-' || k === '_') setZoom(stepZoom(zoom, -1))
    else if (k === '0') setZoom(DEFAULT_ZOOM)
    else return
    e.preventDefault()
  }
  return { zoom, reset: () => setZoom(DEFAULT_ZOOM), onKeyDown }
}

/** Where the diff comes from: the working tree (Changes) or a commit (History). */
export type DiffSource =
  | { kind: 'worktree'; path: string; origPath: string | null; staged: boolean; untracked: boolean }
  | { kind: 'commit'; sha: string; path: string; origPath: string | null }

export function DiffView({ repo, source, note, conflicted }: { repo: string; source: DiffSource; note?: string; conflicted?: boolean }) {
  const [mode, setMode] = useState<Mode>(loadMode)
  const [extent, setExtent] = useState<Extent>(loadExtent)
  const full = extent === 'full'
  // Commit diffs never change, so they stay cached; worktree diffs are invalidated on refresh.
  const diff = useQuery(
    source.kind === 'commit'
      ? {
          queryKey: ['commitDiff', repo, source.sha, source.path, extent],
          queryFn: () => api.commitFileDiff(repo, source.sha, source.path, source.origPath, full),
          staleTime: Infinity,
        }
      : {
          queryKey: ['diff', repo, source.path, source.staged, extent],
          queryFn: () => api.fileDiff(repo, source.path, source.staged, source.untracked && !source.staged, full),
        },
  )

  // Colours come separately: they take longer, so the diff shows first and they fill in.
  const hasLines = !!diff.data && !diff.data.binary && diff.data.hunks.length > 0
  const syntax = useQuery(
    source.kind === 'commit'
      ? {
          queryKey: ['commitDiff', repo, source.sha, source.path, extent, 'syntax'],
          queryFn: () => api.commitFileDiffSyntax(repo, source.sha, source.path, source.origPath, full),
          staleTime: Infinity,
          enabled: hasLines,
        }
      : {
          queryKey: ['diff', repo, source.path, source.staged, extent, 'syntax'],
          queryFn: () => api.fileDiffSyntax(repo, source.path, source.staged, source.untracked && !source.staged, full),
          enabled: hasLines,
        },
  )
  const colours = syntax.data

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
  const text = useTextZoom(root)

  const changeMode = (m: Mode) => {
    remember('diffMode', m)
    setMode(m)
  }
  const changeExtent = (e: Extent) => {
    remember('diffExtent', e)
    setExtent(e)
  }

  return (
    <div
      className="diff"
      ref={root}
      data-own-zoom
      style={text.zoom === DEFAULT_ZOOM ? undefined : ({ '--diff-zoom': text.zoom / 100 } as CSSProperties)}
      onKeyDown={text.onKeyDown}
    >
      <div className="diff-head">
        <span className="diff-path ellipsis selectable" title={source.origPath ? `${source.origPath} → ${source.path}` : source.path}>
          {source.origPath ? <span className="diff-dir">{source.origPath} → </span> : null}
          {dirName(source.path) ? <span className="diff-dir">{dirName(source.path)}/</span> : null}
          <span className="diff-file">{fileName(source.path)}</span>
        </span>
        {note && <span className="diff-note">{note}</span>}
        <div className="spacer" />
        {text.zoom !== DEFAULT_ZOOM && (
          <button className="diff-zoom-level" title="Diff text size (Ctrl + scroll). Click to reset." onClick={text.reset}>
            {text.zoom}%
          </button>
        )}
        <div className="segmented" role="group" aria-label="Diff extent">
          <button className={full ? '' : 'on'} aria-pressed={!full} onClick={() => changeExtent('hunks')}>
            Hunks
          </button>
          <button className={full ? 'on' : ''} aria-pressed={full} onClick={() => changeExtent('full')}>
            Full file
          </button>
        </div>
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
        {diff.data?.hunks.map((h, i) =>
          shown === 'unified' ? (
            <Unified key={i} hunk={h} syntax={colours} header={!full} />
          ) : (
            <Split key={i} hunk={h} syntax={colours} header={!full} />
          ),
        )}
        {diff.data?.truncated && <div className="banner">Diff truncated: the file is too large to show completely.</div>}
      </div>
    </div>
  )
}

/** A line's colours: removed lines from the old file, the rest from the new one. */
function spansOf(line: DiffLine | null, syntax: DiffSyntax | undefined): Span[] | undefined {
  if (!line || !syntax) return undefined
  if (line.kind === 'remove') return line.oldNo == null ? undefined : syntax.old[line.oldNo]
  if (line.kind === 'nonewline') return undefined
  return line.newNo == null ? undefined : syntax.new[line.newNo]
}

/** A line's text with its coloured pieces. */
function Code({ text, spans }: { text: string; spans: Span[] | undefined }) {
  if (!spans?.length) return <>{text}</>
  const out: ReactNode[] = []
  let at = 0
  for (const [start, end, token] of spans) {
    // Colours from before a refresh can be for older text; past the text's end they are dropped.
    if (start < at || end > text.length) break
    if (start > at) out.push(text.slice(at, start))
    out.push(
      <span key={start} className={`tk-${token}`}>
        {text.slice(start, end)}
      </span>,
    )
    at = end
  }
  out.push(text.slice(at))
  return <>{out}</>
}

/** `header` is off for a full-file diff: its one hunk is the whole file, so the header says nothing. */
function Unified({ hunk, syntax, header }: { hunk: Hunk; syntax: DiffSyntax | undefined; header: boolean }) {
  return (
    <table className="hunk unified">
      <tbody>
        {header && (
          <tr className="hunk-header">
            <td colSpan={3}>{hunk.header}</td>
          </tr>
        )}
        {hunk.lines.map((l, i) => (
          <tr key={i} className={l.kind}>
            <td className="ln">{l.oldNo ?? ''}</td>
            <td className="ln">{l.newNo ?? ''}</td>
            <td className="code selectable">
              <span className="sign">{sign[l.kind]}</span>
              <Code text={l.text} spans={spansOf(l, syntax)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Side({ line, no, syntax }: { line: DiffLine | null; no: number | null | undefined; syntax: DiffSyntax | undefined }) {
  return (
    <>
      <td className={`ln ${line?.kind ?? 'empty'}`}>{no ?? ''}</td>
      <td className={`code selectable ${line?.kind ?? 'empty'}`}>
        <Code text={line?.text ?? ''} spans={spansOf(line, syntax)} />
      </td>
    </>
  )
}

function Split({ hunk, syntax, header }: { hunk: Hunk; syntax: DiffSyntax | undefined; header: boolean }) {
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
        {header && (
          <tr className="hunk-header">
            <td colSpan={4}>{hunk.header}</td>
          </tr>
        )}
        {toSplitRows(hunk).map((r, i) => (
          <tr key={i}>
            <Side line={r.left} no={r.left?.oldNo} syntax={syntax} />
            <Side line={r.right} no={r.right?.newNo} syntax={syntax} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}
