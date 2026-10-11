import { describe, expect, it, vi } from 'vite-plus/test'
import type { Branch, RepoSummary } from '../types'
import { branchMenu, commitMenu, describeMenu, diffMenu, fileMenu, inputMenu, repoMenu, withInspect, type MenuEntry } from './menus'

const summary = (p: Partial<RepoSummary> = {}): RepoSummary => ({
  path: 'C:/r',
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  conflicted: 0,
  remote: { kind: 'github', webUrl: 'https://github.com/o/r', owner: 'o', project: null, repo: 'r' },
  error: null,
  operation: null,
  ...p,
})

const branch = (p: Partial<Branch> = {}): Branch =>
  ({
    name: 'feature',
    remote: false,
    isHead: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    sha: 'abc',
    committedAt: 0,
    ...p,
  }) as Branch

const repoActions = () => ({
  open: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  explorer: vi.fn(),
  terminal: vi.fn(),
  vsCode: vi.fn(),
  browser: vi.fn(),
  copyPath: vi.fn(),
})

const run = (items: MenuEntry[], id: string) => {
  const it = items.find((i) => i.kind === 'item' && i.id === id)
  if (!it || it.kind !== 'item') throw new Error(`no item ${id}`)
  it.action()
}

describe('repoMenu', () => {
  it('lists all repo actions in order', () => {
    expect(describeMenu(repoMenu({ summary: summary(), batchRunning: false }, repoActions()))).toEqual([
      'Open',
      '---',
      'Fetch',
      'Pull',
      'Push',
      '---',
      'Open in Explorer',
      'Open in Terminal',
      'Open in VS Code',
      'Open in browser',
      '---',
      'Copy path',
    ])
  })

  it('disables Push on detached HEAD and Open in browser without a remote', () => {
    const d = describeMenu(
      repoMenu({ summary: summary({ detached: true, branch: null, remote: null }), batchRunning: false }, repoActions()),
    )
    expect(d).toContain('Push (disabled)')
    expect(d).toContain('Open in browser (disabled)')
    expect(d).toContain('Fetch')
  })

  it('disables Fetch/Pull/Push while a batch is running', () => {
    const d = describeMenu(repoMenu({ summary: summary(), batchRunning: true }, repoActions()))
    expect(d).toEqual(expect.arrayContaining(['Fetch (disabled)', 'Pull (disabled)', 'Push (disabled)']))
  })

  it('wires every action', () => {
    const a = repoActions()
    const items = repoMenu({ summary: summary(), batchRunning: false }, a)
    const ids = {
      open: 'open',
      fetch: 'fetch',
      pull: 'pull',
      push: 'push',
      explorer: 'explorer',
      terminal: 'terminal',
      vsCode: 'vscode',
      browser: 'browser',
      copyPath: 'copy-path',
    } as const
    for (const [k, id] of Object.entries(ids)) {
      run(items, id)
      expect(a[k as keyof typeof a]).toHaveBeenCalledOnce()
    }
  })
})

describe('fileMenu', () => {
  it('unstaged file: Stage, Discard…, Copy path', () => {
    expect(describeMenu(fileMenu({ staged: false }, { toggle: vi.fn(), discard: vi.fn(), copyPath: vi.fn() }))).toEqual([
      'Stage',
      'Discard…',
      '---',
      'Copy path',
    ])
  })
  it('staged file: Unstage, no Discard', () => {
    expect(describeMenu(fileMenu({ staged: true }, { toggle: vi.fn(), discard: vi.fn(), copyPath: vi.fn() }))).toEqual([
      'Unstage',
      '---',
      'Copy path',
    ])
  })
})

describe('branchMenu', () => {
  const acts = () => ({ checkout: vi.fn(), browser: vi.fn(), pullRequest: vi.fn(), remove: vi.fn(), copyName: vi.fn() })
  it('local branch with remote', () => {
    expect(describeMenu(branchMenu({ branch: branch(), hasRemote: true }, acts()))).toEqual([
      'Checkout',
      '---',
      'Open in browser',
      'Create pull request',
      '---',
      'Delete…',
      '---',
      'Copy name',
    ])
  })
  it('current branch: Checkout and Delete disabled', () => {
    const d = describeMenu(branchMenu({ branch: branch({ isHead: true }), hasRemote: true }, acts()))
    expect(d).toContain('Checkout (disabled)')
    expect(d).toContain('Delete… (disabled)')
  })
  it('no remote: browser and PR disabled', () => {
    const d = describeMenu(branchMenu({ branch: branch(), hasRemote: false }, acts()))
    expect(d).toContain('Open in browser (disabled)')
    expect(d).toContain('Create pull request (disabled)')
  })
  it('remote branch: no PR and no Delete', () => {
    expect(describeMenu(branchMenu({ branch: branch({ name: 'origin/x', remote: true }), hasRemote: true }, acts()))).toEqual([
      'Checkout',
      '---',
      'Open in browser',
      '---',
      'Copy name',
    ])
  })
  it('wires actions', () => {
    const a = acts()
    const items = branchMenu({ branch: branch(), hasRemote: true }, a)
    for (const id of ['checkout', 'browser', 'pr', 'delete', 'copy-name']) run(items, id)
    for (const fn of Object.values(a)) expect(fn).toHaveBeenCalledOnce()
  })
})

describe('diffMenu / inputMenu / withInspect', () => {
  it('Copy is enabled only with a selection', () => {
    expect(describeMenu(diffMenu({ hasSelection: false }, { copy: vi.fn() }))).toEqual(['Copy (disabled)'])
    expect(describeMenu(diffMenu({ hasSelection: true }, { copy: vi.fn() }))).toEqual(['Copy'])
  })
  it('input menu uses predefined edit items', () => {
    const m = inputMenu()
    expect(describeMenu(m)).toEqual(['Undo', '---', 'Cut', 'Copy', 'Paste', '---', 'Select all'])
    expect(m.filter((i) => i.kind === 'predefined').map((i) => i.kind === 'predefined' && i.item)).toEqual([
      'Undo',
      'Cut',
      'Copy',
      'Paste',
      'SelectAll',
    ])
  })
  it('adds Inspect only when dev tools are available', () => {
    const base = diffMenu({ hasSelection: true }, { copy: vi.fn() })
    expect(describeMenu(withInspect(base, false, vi.fn()))).toEqual(['Copy'])
    expect(describeMenu(withInspect(base, true, vi.fn()))).toEqual(['Copy', '---', 'Inspect'])
    expect(describeMenu(withInspect([], true, vi.fn()))).toEqual(['Inspect'])
    expect(withInspect([], false, vi.fn())).toEqual([])
  })
})

describe('commitMenu', () => {
  const actions = { copySha: vi.fn(), copySubject: vi.fn(), copyMessage: vi.fn(), browser: vi.fn(), revert: vi.fn(), reset: vi.fn() }
  const enabled = (m: MenuEntry[]) => m.flatMap((e) => (e.kind === 'item' && e.enabled ? [e.id] : []))

  it('lists copy, open, revert and reset', () => {
    const m = commitMenu({ isHead: false, canWrite: true, hasRemote: true, hostLabel: 'GitHub' }, actions)
    expect(describeMenu(m)).toEqual([
      'Copy SHA',
      'Copy subject',
      'Copy message',
      '---',
      'Open in GitHub',
      '---',
      'Revert commit…',
      'Reset branch to here…',
    ])
  })
  it("can't reset to the top commit, and writes wait while the repo is busy", () => {
    expect(enabled(commitMenu({ isHead: true, canWrite: true, hasRemote: false, hostLabel: 'ADO' }, actions))).toEqual([
      'copy-sha',
      'copy-subject',
      'copy-message',
      'revert',
    ])
    expect(enabled(commitMenu({ isHead: false, canWrite: false, hasRemote: true, hostLabel: 'ADO' }, actions))).not.toContain('revert')
  })
})
