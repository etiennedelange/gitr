import { ask } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { useApp } from '../store'
import type { Divergence, IntegrateOutcome, Strategy } from '../types'

const info = (message: string) => useApp.getState().toast('info', message)
const warn = (message: string) => useApp.getState().toast('error', message)

const commits = (n: number) => (n === 1 ? '1 commit' : `${n} commits`)

/** The confirmation shown before rebasing or merging a diverged branch. */
export function divergenceQuestion(d: Divergence, push: boolean): string {
  const up = d.upstream ?? 'the remote'
  const local = d.ahead === 1 ? '1 local commit' : `${d.ahead} local commits`
  const facts = `Your branch and ${up} have diverged: ${local}, ${d.behind} on the remote.`
  const action =
    d.strategy === 'rebase'
      ? `Rebase your ${d.ahead === 1 ? 'commit' : commits(d.ahead)} onto ${up}?`
      : `Merge ${up} into ${d.branch ?? 'your branch'}?`
  return `${facts} ${action}${push ? ' Then push.' : ''}`
}

export const strategyVerb = (s: Strategy) => (s === 'rebase' ? 'Rebase' : 'Merge')

/** Tells the user how a rebase / merge / continue ended. */
export function reportOutcome(outcome: IntegrateOutcome, done: string) {
  switch (outcome.kind) {
    case 'done':
      info(done)
      return
    case 'conflicts':
      warn(`Stopped on conflicts in ${outcome.files === 1 ? '1 file' : `${outcome.files} files`}. Resolve them, then Continue, or Abort.`)
      return
    case 'stashConflict':
      warn(
        `${done}, but your uncommitted changes conflicted when they were put back (${outcome.files === 1 ? '1 file' : `${outcome.files} files`}). ` +
          'They are also kept in git stash list.',
      )
  }
}

/**
 * Pull that handles a diverged branch: fetch; nothing to do → say so; only behind → fast-forward
 * as before; diverged → ask once with the counts, then rebase or merge (and push when `push`).
 */
export async function runIntegrate(repo: string, { push }: { push: boolean }): Promise<void> {
  const d = await api.divergence(repo)
  if (!d.upstream) {
    info('This branch has no upstream branch.')
    return
  }
  if (d.behind === 0) {
    if (push && d.ahead > 0) {
      await api.push(repo)
      info('Pushed')
    } else {
      info('Up to date')
    }
    return
  }
  if (d.ahead === 0) {
    const [result] = await api.runBatch('pull', [repo], true)
    if (result?.state === 'error') warn(result.message ?? 'Pull failed')
    else info(result?.message ?? 'Pulled')
    return
  }
  const verb = strategyVerb(d.strategy)
  const ok = await ask(divergenceQuestion(d, push), {
    title: d.strategy === 'rebase' ? `Rebase onto ${d.upstream}` : `Merge ${d.upstream}`,
    kind: 'info',
    okLabel: verb,
    cancelLabel: 'Cancel',
  })
  if (!ok) return
  const result = await api.integrate(repo, push)
  const what = result.strategy === 'rebase' ? `Rebased onto ${d.upstream}` : `Merged ${d.upstream}`
  reportOutcome(result.outcome, result.pushed ? `${what} and pushed` : what)
}
