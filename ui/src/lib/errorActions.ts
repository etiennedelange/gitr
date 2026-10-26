import { ask } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { useApp } from '../store'
import type { CmdError, Strategy } from '../types'
import { runIntegrate, strategyVerb } from './integrate'

export interface ErrorAction {
  label: string
  /** Resolves `false` when the user cancelled (the error stays visible). */
  run: () => Promise<boolean | void>
}

const info = (message: string) => useApp.getState().toast('info', message)

/**
 * The fix offered for an error, by kind. `busy` tells whether Gitr itself is working on a
 * repo (a lock is then not stale, so removing it is not offered).
 */
export function errorActions(
  err: CmdError | null | undefined,
  busy: (repo: string) => boolean,
  /** The repo's strategy for diverged branches, once known (default rebase). */
  strategy: (repo: string) => Strategy | undefined = () => undefined,
): ErrorAction[] {
  const repo = err?.repo
  if (!err || !repo) return []
  switch (err.kind) {
    case 'non-fast-forward':
      // A rejected push means both sides moved on: rebase/merge, then push.
      return [
        {
          label: `${strategyVerb(strategy(repo) ?? 'rebase')} & push`,
          run: () => runIntegrate(repo, { push: true }),
        },
      ]
    case 'lock': {
      const lock = err.lockPath
      if (!lock || busy(repo)) return []
      return [
        {
          label: 'Remove stale lock',
          run: async () => {
            const ok = await ask(
              `Remove the lock file ${lock}?\n\nOnly do this if no other git tool (IDE, terminal, another git client) is working in this repository. Close them first.`,
              { title: 'Remove stale lock', kind: 'warning', okLabel: 'Remove lock', cancelLabel: 'Cancel' },
            )
            if (!ok) return false
            await api.removeStaleLock(repo, lock)
            info('Lock file removed. Try again.')
          },
        },
      ]
    }
    case 'dubious-ownership':
      return [
        {
          label: 'Trust this folder',
          run: async () => {
            const ok = await ask(
              `Trust ${repo}?\n\nThis adds the folder to safe.directory in your global git config, so git works in it even though another user owns it.`,
              { title: 'Trust this folder', kind: 'warning', okLabel: 'Trust folder', cancelLabel: 'Cancel' },
            )
            if (!ok) return false
            await api.trustFolder(repo)
            info('Folder trusted.')
          },
        },
      ]
    case 'auth':
    case 'hook':
    case 'signing':
      return [{ label: 'Open terminal here', run: () => api.openWith(repo, 'terminal') }]
    default:
      return []
  }
}
