import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api, errorMessage } from '../api'
import { dirName, fileName, toSplitRows } from '../lib/git'
import type { DiffLine, DiffSyntax, FileDiff, Span } from '../types'
import { diffMenu } from '../lib/menus'
import { copyText, showMenu } from '../nativeMenu'
import { createWheelZoomAccumulator, DEFAULT_ZOOM, stepZoom, ZOOM_PRESETS } from '../lib/zoom'

type Mode = 'unified' | 'split'
/** Only the changed hunks, or the whole file with its changes inline. */
type Extent = 'hunks' | 'full'

const SPLIT_MIN_WIDTH = 560
/** A diff with more rows than this draws only the rows in view: a whole file can have thousands,
 * and drawing them all took long enough to hold up its colours and every zoom step. */
export const VIRTUAL_MIN_ROWS = 400
/** A code line's height at the default font size (13px × 1.6); rows are measured once drawn. */
const ROW_H = 21

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

/**
 * Clicking or arrowing quickly through files: a diff opened within this long of the previous one
 * waits until the selection rests, so the files passed over run no git.
 */
const SETTLE_MS = 150
let lastOpened = 0

function useSettled(): boolean {
  const [settled, setSettled] = useState(() => Date.now() - lastOpened >= SETTLE_MS)
  useEffect(() => {
    lastOpened = Date.now()
  }, [])
  useEffect(() => {
    if (settled) return
    const t = setTimeout(() => setSettled(true), SETTLE_MS)
    return () => clearTimeout(t)
  }, [settled])
  return settled
}

/** Where the diff comes from: the working tree (Changes) or a commit (History). */
export type DiffSource =
  | { kind: 'worktree'; path: string; origPath: string | null; staged: boolean; untracked: boolean }
  | { kind: 'commit'; sha: string; path: string; origPath: string | null }

export function DiffView({ repo, source, note, conflicted }: { repo: string; source: DiffSource; note?: string; conflicted?: boolean }) {
  const [mode, setMode] = useState<Mode>(loadMode)
  const [extent, setExtent] = useState<Extent>(loadExtent)
  const full = extent === 'full'
  const settled = useSettled()
  // Commit diffs never change, so they stay cached; worktree diffs are invalidated on refresh.
  const diff = useQuery(
    source.kind === 'commit'
      ? {
          queryKey: ['commitDiff', repo, source.sha, source.path, extent],
          queryFn: () => api.commitFileDiff(repo, source.sha, source.path, source.origPath, full),
          staleTime: Infinity,
          enabled: settled,
        }
      : {
          queryKey: ['diff', repo, source.path, source.staged, extent],
          queryFn: () => api.fileDiff(repo, source.path, source.staged, source.untracked && !source.staged, full),
          enabled: settled,
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
  const body = useRef<HTMLDivElement>(null)

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
        ref={body}
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
        {(diff.isLoading || (!settled && !diff.data)) && (
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
        {hasLines && <Rows key={shown} diff={diff.data} mode={shown} syntax={colours} header={!full} body={body} zoom={text.zoom} />}
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

/** One row of the diff table. Hunks after the first start with a gap, then their header. */
type Item =
  | { kind: 'gap' }
  | { kind: 'header'; text: string; first: boolean }
  | { kind: 'line'; line: DiffLine }
  | { kind: 'pair'; left: DiffLine | null; right: DiffLine | null }

/** `header` is off for a full-file diff: its one hunk is the whole file, so the header says nothing. */
export function diffItems(diff: FileDiff, mode: Mode, header: boolean): Item[] {
  const items: Item[] = []
  diff.hunks.forEach((h, i) => {
    if (header) {
      if (i > 0) items.push({ kind: 'gap' })
      items.push({ kind: 'header', text: h.header, first: i === 0 })
    }
    if (mode === 'unified') for (const line of h.lines) items.push({ kind: 'line', line })
    else for (const r of toSplitRows(h)) items.push({ kind: 'pair', left: r.left, right: r.right })
  })
  return items
}

/** The widest line, counting a tab as up to 8 columns (the default tab size). */
export function widestLine(diff: FileDiff): string {
  let best = ''
  let bestCols = -1
  for (const h of diff.hunks)
    for (const l of h.lines) {
      if (l.text.length * 8 <= bestCols) continue
      let cols = 0
      for (const ch of l.text) cols = ch === '\t' ? cols + 8 - (cols % 8) : cols + 1
      if (cols > bestCols) [best, bestCols] = [l.text, cols]
    }
  return best
}

/**
 * The diff as one table. A long one draws only the rows in view (plus a margin), with spacer rows
 * standing in for the rest; a hidden row holding the widest line and the largest line numbers
 * keeps the columns as wide as if every row were drawn.
 */
function Rows({
  diff,
  mode,
  syntax,
  header,
  body,
  zoom,
}: {
  diff: FileDiff
  mode: Mode
  syntax: DiffSyntax | undefined
  header: boolean
  body: RefObject<HTMLDivElement | null>
  /** The diff's text zoom in percent: rows not yet drawn are estimated at that size. */
  zoom: number
}) {
  const items = useMemo(() => diffItems(diff, mode, header), [diff, mode, header])
  const virtual = items.length > VIRTUAL_MIN_ROWS
  const rowH = (ROW_H * zoom) / 100
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => body.current,
    estimateSize: (i) => (items[i].kind === 'gap' ? 13 : rowH),
    // A hidden pane measures every row as 0 high, which would draw all of them.
    measureElement: (el) => el.getBoundingClientRect().height || rowH,
    overscan: 30,
    // The first screen of rows is drawn at once, before the pane has been measured.
    initialRect: { width: 0, height: 1200 },
    enabled: virtual,
  })
  // A new text size makes every row taller or shorter: drop the old measurements.
  useEffect(() => {
    rows.measure?.()
  }, [rows, zoom])
  const cols = mode === 'unified' ? 3 : 4
  const draw = (item: Item, key: number, measure?: boolean) => {
    const ref = measure ? rows.measureElement : undefined
    switch (item.kind) {
      case 'gap':
        return (
          <tr key={key} ref={ref} data-index={key} className="hunk-gap" aria-hidden="true">
            <td colSpan={cols} />
          </tr>
        )
      case 'header':
        return (
          <tr key={key} ref={ref} data-index={key} className={item.first ? 'hunk-header first' : 'hunk-header'}>
            <td colSpan={cols}>{item.text}</td>
          </tr>
        )
      case 'line':
        return (
          <tr key={key} ref={ref} data-index={key} className={item.line.kind}>
            <td className="ln">{item.line.oldNo ?? ''}</td>
            <td className="ln">{item.line.newNo ?? ''}</td>
            <td className="code selectable">
              <span className="sign">{sign[item.line.kind]}</span>
              <Code text={item.line.text} spans={spansOf(item.line, syntax)} />
            </td>
          </tr>
        )
      case 'pair':
        return (
          <tr key={key} ref={ref} data-index={key}>
            <Side line={item.left} no={item.left?.oldNo} syntax={syntax} />
            <Side line={item.right} no={item.right?.newNo} syntax={syntax} />
          </tr>
        )
    }
  }

  let drawn: ReactNode
  if (!virtual) {
    drawn = items.map((it, i) => draw(it, i))
  } else {
    const shown = rows.getVirtualItems()
    const before = shown[0]?.start ?? 0
    const after = rows.getTotalSize() - (shown.at(-1)?.end ?? 0)
    drawn = (
      <>
        {mode === 'unified' && <Sizer diff={diff} />}
        {before > 0 && <Spacer height={before} cols={cols} />}
        {shown.map((v) => draw(items[v.index], v.index, true))}
        {after > 0 && <Spacer height={after} cols={cols} />}
      </>
    )
  }

  return mode === 'unified' ? (
    <table className="hunk unified">
      <tbody>{drawn}</tbody>
    </table>
  ) : (
    // Fixed column widths, so both sides get half whatever their lines are.
    <table className="hunk split">
      <colgroup>
        <col className="ln-col" />
        <col />
        <col className="ln-col" />
        <col />
      </colgroup>
      <tbody>{drawn}</tbody>
    </table>
  )
}

function Spacer({ height, cols }: { height: number; cols: number }) {
  return (
    <tr className="spacer" aria-hidden="true">
      <td colSpan={cols} style={{ height }} />
    </tr>
  )
}

/** A row of no height that sizes the columns for rows that aren't drawn. */
function Sizer({ diff }: { diff: FileDiff }) {
  const { text, oldNo, newNo } = useMemo(() => {
    let oldNo = 0
    let newNo = 0
    for (const h of diff.hunks)
      for (const l of h.lines) {
        oldNo = Math.max(oldNo, l.oldNo ?? 0)
        newNo = Math.max(newNo, l.newNo ?? 0)
      }
    return { text: widestLine(diff), oldNo, newNo }
  }, [diff])
  return (
    <tr className="sizer" aria-hidden="true">
      <td className="ln">{oldNo || ''}</td>
      <td className="ln">{newNo || ''}</td>
      <td className="code">
        <span className="sign"> </span>
        {text}
      </td>
    </tr>
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
