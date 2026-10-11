import { describe, expect, it } from 'vite-plus/test'
import type { FileEntry, Hunk, RepoSummary } from '../types'
import { fileStatus, matchesFilter, sortRows, splitChanges, statusLetter, toSplitRows } from './git'

const file = (p: Partial<FileEntry>): FileEntry => ({
  path: 'a.txt',
  origPath: null,
  index: '.',
  worktree: '.',
  untracked: false,
  conflicted: false,
  ...p,
})

const summary = (p: Partial<RepoSummary>): RepoSummary => ({
  path: 'x',
  branch: 'main',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  conflicted: 0,
  remote: null,
  error: null,
  operation: null,
  ...p,
})

const row = (name: string, s?: Partial<RepoSummary>) => ({
  repo: { path: name, name, groupId: 'g' },
  summary: s ? summary(s) : undefined,
})

describe('splitChanges', () => {
  it('puts partially staged files on both sides', () => {
    const files = [
      file({ path: 'both', index: 'M', worktree: 'M' }),
      file({ path: 'new', untracked: true, worktree: '?' }),
      file({ path: 'staged', index: 'A' }),
      file({ path: 'conflict', conflicted: true, index: 'U', worktree: 'U' }),
    ]
    const { staged, unstaged } = splitChanges(files)
    expect(staged.map((f) => f.path)).toEqual(['both', 'staged'])
    expect(unstaged.map((f) => f.path)).toEqual(['conflict', 'both', 'new'])
  })

  it('shows side-specific letters', () => {
    const f = file({ index: 'A', worktree: 'M' })
    expect(statusLetter(f, true)).toBe('A')
    expect(statusLetter(f, false)).toBe('M')
    expect(statusLetter(file({ untracked: true }), false)).toBe('?')
  })

  it("marks a conflict with git's U for unmerged, not C (which is a copy)", () => {
    const f = file({ conflicted: true, index: 'U', worktree: 'U' })
    expect(statusLetter(f, false)).toBe('U')
    expect(fileStatus(f, false)).toEqual({ letter: 'U', kind: 'conflict', label: 'Conflicted' })
    expect(fileStatus(file({ index: 'C' }), true)).toEqual({ letter: 'C', kind: 'copied', label: 'Copied' })
  })
})

describe('toSplitRows', () => {
  it('pairs removals with additions and keeps context aligned', () => {
    const hunk: Hunk = {
      header: '@@',
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: 'context', oldNo: 1, newNo: 1, text: 'a' },
        { kind: 'remove', oldNo: 2, newNo: null, text: 'b' },
        { kind: 'remove', oldNo: 3, newNo: null, text: 'c' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'B' },
        { kind: 'context', oldNo: 4, newNo: 3, text: 'd' },
        { kind: 'add', oldNo: null, newNo: 4, text: 'e' },
      ],
    }
    const rows = toSplitRows(hunk).map((r) => [r.left?.text ?? null, r.right?.text ?? null])
    expect(rows).toEqual([
      ['a', 'a'],
      ['b', 'B'],
      ['c', null],
      ['d', 'd'],
      [null, 'e'],
    ])
  })
})

describe('dashboard rows', () => {
  it('filters by text on name or branch', () => {
    expect(matchesFilter(row('Api', { branch: 'feature/AB-1' }), 'all', 'ab-1')).toBe(true)
    expect(matchesFilter(row('Api'), 'all', 'web')).toBe(false)
  })

  it('filters by state', () => {
    expect(matchesFilter(row('a', { unstaged: 2 }), 'dirty', '')).toBe(true)
    expect(matchesFilter(row('a', {}), 'dirty', '')).toBe(false)
    expect(matchesFilter(row('a', { error: 'x' }), 'attention', '')).toBe(true)
    expect(matchesFilter(row('a', { operation: 'merging' }), 'attention', '')).toBe(true)
    expect(matchesFilter(row('a', { conflicted: 1 }), 'attention', '')).toBe(true)
    expect(matchesFilter(row('a', { unstaged: 3, behind: 2 }), 'attention', '')).toBe(false)
    // The last Fetch all / Pull all failed on it.
    expect(matchesFilter(row('a', {}), 'attention', '', true)).toBe(true)
  })

  it('sorts problems first by status', () => {
    const rows = [row('clean', {}), row('err', { error: 'boom' }), row('dirty', { staged: 1 }), row('unknown')]
    expect(sortRows(rows, 'status').map((r) => r.repo.name)).toEqual(['err', 'dirty', 'clean', 'unknown'])
    expect(sortRows(rows, 'name').map((r) => r.repo.name)).toEqual(['clean', 'dirty', 'err', 'unknown'])
  })
})

import { ago, branchNameProblem } from './git'

describe('ago', () => {
  const at = (secs: number) => Date.now() / 1000 - secs
  it('formats each range in its own unit', () => {
    expect(ago(at(20))).toBe('now')
    expect(ago(at(5 * 60))).toBe('5m')
    expect(ago(at(59.6 * 60))).toBe('59m')
    expect(ago(at(3 * 3600))).toBe('3h')
    expect(ago(at(10 * 86400))).toBe('10d')
    expect(ago(at(90 * 86400))).toBe('3mo')
    expect(ago(at(800 * 86400))).toBe('2y')
  })
})

describe('branchNameProblem', () => {
  it('accepts normal names', () => {
    for (const n of ['feature/x', 'fix-123', 'release_1.2']) expect(branchNameProblem(n)).toBeNull()
  })
  it('explains what is wrong with names git refuses', () => {
    expect(branchNameProblem('has space')).toMatch(/space/)
    expect(branchNameProblem('-leading')).toMatch(/start with/)
    expect(branchNameProblem('a..b')).toMatch(/\.\./)
    expect(branchNameProblem('trailing/')).toMatch(/end with/)
    expect(branchNameProblem('x.lock')).toMatch(/\.lock/)
    expect(branchNameProblem('a:b')).toMatch(/:/)
    expect(branchNameProblem('')).toBeNull()
  })
})
