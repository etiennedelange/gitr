import type { DiffLine, FileEntry, Hunk, RepoEntry, RepoSummary } from '../types'

export const isStaged = (f: FileEntry) => !f.untracked && !f.conflicted && f.index !== '.'
export const isUnstaged = (f: FileEntry) => f.untracked || f.conflicted || f.worktree !== '.'

/** Staged and unstaged files; conflicted files lead the unstaged list, since they block the rest. */
export function splitChanges(files: FileEntry[]) {
  const unstaged = files.filter(isUnstaged)
  return {
    staged: files.filter(isStaged),
    unstaged: [...unstaged.filter((f) => f.conflicted), ...unstaged.filter((f) => !f.conflicted)],
  }
}

/**
 * Single status letter shown next to a file, for the given side. The letters are git's own
 * (`git status --short`): U is unmerged (a conflict), ? is untracked.
 */
export function statusLetter(f: FileEntry, staged: boolean): string {
  if (f.conflicted) return 'U'
  if (f.untracked) return '?'
  const c = staged ? f.index : f.worktree
  return c === '.' ? ' ' : c
}

const STATUS: Record<string, { kind: string; label: string }> = {
  U: { kind: 'conflict', label: 'Conflicted' },
  '?': { kind: 'untracked', label: 'Untracked' },
  M: { kind: 'modified', label: 'Modified' },
  A: { kind: 'added', label: 'Added' },
  D: { kind: 'deleted', label: 'Deleted' },
  R: { kind: 'renamed', label: 'Renamed' },
  C: { kind: 'copied', label: 'Copied' },
  T: { kind: 'typechange', label: 'Type changed' },
}

export interface FileStatus {
  letter: string
  /** Class-safe name for the tile's colour (`l-conflict`, `l-modified`, …). */
  kind: string
  /** The word for it, for the tooltip and screen readers. */
  label: string
}

export const letterStatus = (letter: string): FileStatus => ({ letter, ...(STATUS[letter] ?? { kind: 'none', label: 'Changed' }) })

export const fileStatus = (f: FileEntry, staged: boolean): FileStatus => letterStatus(statusLetter(f, staged))

export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/** Pairs removals with following additions so changed lines sit side by side. */
export function toSplitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const flush = () => {
    const n = Math.max(removed.length, added.length)
    for (let i = 0; i < n; i++) rows.push({ left: removed[i] ?? null, right: added[i] ?? null })
    removed = []
    added = []
  }
  for (const line of hunk.lines) {
    if (line.kind === 'remove') {
      if (added.length) flush()
      removed.push(line)
    } else if (line.kind === 'add') {
      added.push(line)
    } else {
      flush()
      if (line.kind === 'context') rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}

export type SortKey = 'name' | 'status' | 'behind'
export type Filter = 'all' | 'attention' | 'dirty' | 'behind' | 'ahead'

export interface Row {
  repo: RepoEntry
  summary: RepoSummary | undefined
}

const dirtyCount = (s?: RepoSummary) => (s ? s.staged + s.unstaged + s.conflicted : 0)

const severity = (s?: RepoSummary) => {
  if (!s) return 0
  if (s.error) return 5
  if (s.conflicted || s.operation) return 4
  if (s.behind && s.ahead) return 3
  if (dirtyCount(s)) return 2
  if (s.behind || s.ahead) return 1
  return 0
}

/**
 * A repo that needs the user before anything else: git couldn't read it, a merge or rebase is
 * waiting, it has conflicts, or the last Fetch all / Pull all failed on it.
 */
export function needsAttention(s: RepoSummary | undefined, failed = false): boolean {
  return failed || !!s?.error || !!s?.operation || (s?.conflicted ?? 0) > 0
}

export function matchesFilter(row: Row, filter: Filter, text: string, failed = false): boolean {
  const s = row.summary
  if (text) {
    const q = text.toLowerCase()
    if (!row.repo.name.toLowerCase().includes(q) && !(s?.branch ?? '').toLowerCase().includes(q)) return false
  }
  switch (filter) {
    case 'all':
      return true
    case 'dirty':
      return dirtyCount(s) > 0
    case 'behind':
      return (s?.behind ?? 0) > 0
    case 'ahead':
      return (s?.ahead ?? 0) > 0
    case 'attention':
      return needsAttention(s, failed)
  }
}

export function sortRows(rows: Row[], key: SortKey): Row[] {
  const byName = (a: Row, b: Row) => a.repo.name.localeCompare(b.repo.name, undefined, { sensitivity: 'base' })
  const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
    name: byName,
    status: (a, b) => severity(b.summary) - severity(a.summary) || byName(a, b),
    behind: (a, b) => (b.summary?.behind ?? 0) - (a.summary?.behind ?? 0) || byName(a, b),
  }
  return [...rows].sort(cmp[key])
}

export const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p
export const dirName = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? '' : p.slice(0, i)
}

export function statusClass(s: RepoSummary | undefined): string {
  if (!s) return 'dot unknown'
  if (s.error) return 'dot error'
  if (s.conflicted) return 'dot conflict'
  if (s.operation) return 'dot operation'
  if (s.staged + s.unstaged) return 'dot dirty'
  if (s.behind) return 'dot behind'
  if (s.ahead) return 'dot ahead'
  return 'dot clean'
}

/** What went up in a repo between two summaries: the dashboard marks it as new. */
export type FreshKind = 'trouble' | 'behind' | 'dirty' | 'ahead'

/**
 * What a new summary brings that the last one didn't: an error or more conflicts, more incoming
 * commits, more changed files or more outgoing commits, in that order. Null for the first summary
 * of a repo (nothing to compare with) and for anything that only went down.
 */
export function freshKind(prev: RepoSummary | undefined, next: RepoSummary): FreshKind | null {
  if (!prev) return null
  if ((next.error && !prev.error) || next.conflicted > prev.conflicted) return 'trouble'
  if (next.behind > prev.behind) return 'behind'
  if (next.staged + next.unstaged > prev.staged + prev.unstaged) return 'dirty'
  if (next.ahead > prev.ahead) return 'ahead'
  return null
}

/** Whether the state a fresh mark points at is still there (a pull clears "behind", and so on). */
export function stillFresh(kind: FreshKind, s: RepoSummary): boolean {
  switch (kind) {
    case 'trouble':
      return !!s.error || s.conflicted > 0
    case 'behind':
      return s.behind > 0
    case 'dirty':
      return s.staged + s.unstaged > 0
    case 'ahead':
      return s.ahead > 0
  }
}

/** Age of a unix timestamp as a short label: now, 5m, 3h, 10d, 3mo, 2y. */
export function ago(secs: number): string {
  const d = Date.now() / 1000 - secs
  if (d < 60) return 'now'
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  if (d < 86400 * 60) return `${Math.floor(d / 86400)}d`
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))}mo`
  return `${Math.floor(d / (86400 * 365))}y`
}

/** Why git would refuse this branch name, or null when it is fine (or still empty). */
export function branchNameProblem(name: string): string | null {
  if (!name.trim()) return null
  if (/\s/.test(name)) return "Branch names can't contain spaces."
  if (name.startsWith('-') || name.startsWith('/')) return "Branch names can't start with “-” or “/”."
  if (name.includes('..')) return "Branch names can't contain “..”."
  if (name.includes('@{')) return "Branch names can't contain “@{”."
  const bad = /[~^:?*[\\]/.exec(name)
  if (bad) return `Branch names can't contain “${bad[0]}”.`
  if (name.endsWith('/') || name.endsWith('.')) return "Branch names can't end with “/” or “.”."
  if (name.endsWith('.lock')) return "Branch names can't end with “.lock”."
  return null
}

/** Names that start with the query first, then names that contain it; each group A to Z. */
export function rankRepos(repos: RepoEntry[], query: string): RepoEntry[] {
  const q = query.trim().toLowerCase()
  const byName = (a: RepoEntry, b: RepoEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  if (!q) return [...repos].sort(byName)
  const starts = repos.filter((r) => r.name.toLowerCase().startsWith(q)).sort(byName)
  const contains = repos.filter((r) => !r.name.toLowerCase().startsWith(q) && r.name.toLowerCase().includes(q)).sort(byName)
  return [...starts, ...contains]
}
