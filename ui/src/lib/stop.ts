import { ask } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { notifyError } from '../hooks'

/** Operations that only talk to the remote: stopping them can't leave local files half-written. */
const REMOTE_ONLY = new Set(['fetching', 'pushing'])

/**
 * Stops what Gitr is doing in the repo (the running operation and anything queued behind it).
 * Asks first when git may be writing local files.
 */
export async function stopOperation(path: string, op: string) {
  if (!REMOTE_ONLY.has(op)) {
    const question =
      `Stop ${op}?\n\nGit is stopped right away, including any hook it is running. ` +
      'Stopping in the middle of a write can leave files half-updated or a lock file behind; Gitr then offers to remove the lock.'
    if (!(await ask(question, { title: 'Stop', kind: 'warning', okLabel: 'Stop', cancelLabel: 'Keep going' }))) return
  }
  await api.cancelOperation(path).catch(notifyError)
}
