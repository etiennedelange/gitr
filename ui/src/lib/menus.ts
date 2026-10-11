/** Pure builders for native context menus. Rendering lives in `nativeMenu.ts`. */
import type { Branch, RepoSummary } from '../types'

export type PredefinedKind = 'Undo' | 'Cut' | 'Copy' | 'Paste' | 'SelectAll'

export type MenuEntry =
  | { kind: 'item'; id: string; text: string; enabled: boolean; action: () => void }
  | { kind: 'predefined'; item: PredefinedKind; text: string }
  | { kind: 'separator' }

const item = (id: string, text: string, action: () => void, enabled = true): MenuEntry => ({ kind: 'item', id, text, enabled, action })
const sep: MenuEntry = { kind: 'separator' }

export interface RepoActions {
  open: () => void
  fetch: () => void
  pull: () => void
  push: () => void
  explorer: () => void
  terminal: () => void
  vsCode: () => void
  browser: () => void
  copyPath: () => void
}

export function repoMenu(ctx: { summary?: RepoSummary; batchRunning: boolean }, a: RepoActions): MenuEntry[] {
  const s = ctx.summary
  const canPush = !ctx.batchRunning && !!s && !s.detached && !!s.branch
  return [
    item('open', 'Open', a.open),
    sep,
    item('fetch', 'Fetch', a.fetch, !ctx.batchRunning),
    item('pull', 'Pull', a.pull, !ctx.batchRunning),
    item('push', 'Push', a.push, canPush),
    sep,
    item('explorer', 'Open in Explorer', a.explorer),
    item('terminal', 'Open in Terminal', a.terminal),
    item('vscode', 'Open in VS Code', a.vsCode),
    item('browser', 'Open in browser', a.browser, !!s?.remote),
    sep,
    item('copy-path', 'Copy path', a.copyPath),
  ]
}

export interface GroupActions {
  addFolder: () => void
  settings: () => void
}

export function groupMenu(ctx: { name: string }, a: GroupActions): MenuEntry[] {
  return [item('add-folder', `Add folder to ${ctx.name}…`, a.addFolder), sep, item('settings', 'Edit groups in Settings', a.settings)]
}

export interface FileActions {
  toggle: () => void
  discard: () => void
  copyPath: () => void
}

export function fileMenu(ctx: { staged: boolean }, a: FileActions): MenuEntry[] {
  return [
    item('toggle', ctx.staged ? 'Unstage' : 'Stage', a.toggle),
    ...(ctx.staged ? [] : [item('discard', 'Discard…', a.discard)]),
    sep,
    item('copy-path', 'Copy path', a.copyPath),
  ]
}

export interface BranchActions {
  checkout: () => void
  browser: () => void
  pullRequest: () => void
  remove: () => void
  copyName: () => void
}

export function branchMenu(ctx: { branch: Branch; hasRemote: boolean }, a: BranchActions): MenuEntry[] {
  const b = ctx.branch
  return [
    item('checkout', 'Checkout', a.checkout, !b.isHead),
    sep,
    item('browser', 'Open in browser', a.browser, ctx.hasRemote),
    ...(b.remote ? [] : [item('pr', 'Create pull request', a.pullRequest, ctx.hasRemote)]),
    ...(b.remote ? [] : [sep, item('delete', 'Delete…', a.remove, !b.isHead)]),
    sep,
    item('copy-name', 'Copy name', a.copyName),
  ]
}

export function diffMenu(ctx: { hasSelection: boolean }, a: { copy: () => void }): MenuEntry[] {
  return [item('copy', 'Copy', a.copy, ctx.hasSelection)]
}

export function inputMenu(): MenuEntry[] {
  return [
    { kind: 'predefined', item: 'Undo', text: 'Undo' },
    sep,
    { kind: 'predefined', item: 'Cut', text: 'Cut' },
    { kind: 'predefined', item: 'Copy', text: 'Copy' },
    { kind: 'predefined', item: 'Paste', text: 'Paste' },
    sep,
    { kind: 'predefined', item: 'SelectAll', text: 'Select all' },
  ]
}

export function withInspect(items: MenuEntry[], devtools: boolean, inspect: () => void): MenuEntry[] {
  if (!devtools) return items
  return items.length ? [...items, sep, item('inspect', 'Inspect', inspect)] : [item('inspect', 'Inspect', inspect)]
}

/** Text of a menu for tests and debugging; disabled items are suffixed with " (disabled)". */
export const describeMenu = (items: MenuEntry[]) =>
  items.map((i) => (i.kind === 'separator' ? '---' : i.kind === 'predefined' ? i.text : i.enabled ? i.text : `${i.text} (disabled)`))

export interface CommitActions {
  copySha: () => void
  copySubject: () => void
  copyMessage: () => void
  browser: () => void
  revert: () => void
  reset: () => void
}

/** `isHead`: the top commit, which a reset can't move to. `canWrite`: not busy and no operation in progress. */
export function commitMenu(
  ctx: { isHead: boolean; canWrite: boolean; hasRemote: boolean; hostLabel: string },
  a: CommitActions,
): MenuEntry[] {
  return [
    item('copy-sha', 'Copy SHA', a.copySha),
    item('copy-subject', 'Copy subject', a.copySubject),
    item('copy-message', 'Copy message', a.copyMessage),
    sep,
    item('browser', `Open in ${ctx.hostLabel}`, a.browser, ctx.hasRemote),
    sep,
    item('revert', 'Revert commit…', a.revert, ctx.canWrite),
    item('reset', 'Reset branch to here…', a.reset, ctx.canWrite && !ctx.isHead),
  ]
}
