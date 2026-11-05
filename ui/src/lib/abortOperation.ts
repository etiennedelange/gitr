import { ask } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { notifyError } from '../hooks'
import { useApp } from '../store'
import type { Operation } from '../types'
import { operationNoun } from './operation'

/**
 * Asks, then aborts the merge, rebase or other operation waiting in `path` (or ends a bisect).
 * Shared by the repo view's operation bar and the dashboard's attention banner.
 */
export async function abortOperation(path: string, op: Operation): Promise<void> {
  const bisect = op === 'bisecting'
  const noun = operationNoun(op)
  const ok = await ask(
    bisect
      ? 'End the bisect? You go back to the branch and commit you started it from.'
      : `Abort the ${noun}? Your branch goes back to how it was before the ${noun} started.`,
    {
      title: bisect ? 'End bisect' : `Abort ${noun}`,
      kind: 'warning',
      okLabel: bisect ? 'End bisect' : `Abort ${noun}`,
      cancelLabel: 'Cancel',
    },
  )
  if (!ok) return
  try {
    await api.abortOperation(path)
    useApp.getState().toast('info', bisect ? 'Bisect ended' : `${noun.charAt(0).toUpperCase()}${noun.slice(1)} aborted`)
  } catch (e) {
    notifyError(e)
  }
}
