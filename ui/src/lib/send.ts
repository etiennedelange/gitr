import { api, asCmdError } from '../api'
import { notifyError } from '../hooks'
import { type HookRetry, useApp } from '../store'

const info = (message: string) => useApp.getState().toast('info', message)

/** A hook rejection goes to the repo's hook panel (with what to repeat without hooks); anything else is a toast. */
function report(path: string, e: unknown, retry: HookRetry) {
  const err = asCmdError(e)
  if (err?.kind === 'hook') {
    useApp.getState().hookFailed(path, err, retry)
    return
  }
  useApp.getState().clearHookRun(path)
  notifyError(e)
}

/**
 * Commits, then pushes with `andPush`. `skipHooks` (`--no-verify`) only after the user chose it.
 * Resolves whether the commit landed (the commit box is cleared through `committed`).
 */
export async function runCommit(path: string, message: string, amend: boolean, andPush: boolean, skipHooks = false): Promise<boolean> {
  const st = useApp.getState()
  let sha: string
  try {
    sha = await api.commit(path, message, amend, skipHooks)
  } catch (e) {
    report(path, e, { kind: 'commit', message, amend, andPush })
    return false
  }
  st.committed(path)
  st.clearHookRun(path)
  const short = sha.slice(0, 7)
  const how = skipHooks ? ' without hooks' : ''
  if (!andPush) {
    info(`Committed ${short}${how}`)
    return true
  }
  try {
    await api.push(path)
    useApp.getState().clearHookRun(path)
    info(`Committed ${short}${how} and pushed`)
  } catch (e) {
    // The commit is done; say so, so the user retries Push rather than committing again.
    info(`Committed ${short}${how}, but the push failed`)
    report(path, e, { kind: 'push' })
  }
  return true
}

/**
 * Pushes the current branch. `ahead` is read at click time: by the time the push finishes, the
 * refreshed summary says 0 ahead either way.
 */
export async function runPush(path: string, ahead: number, skipHooks = false): Promise<boolean> {
  try {
    await api.push(path, skipHooks)
  } catch (e) {
    report(path, e, { kind: 'push' })
    return false
  }
  useApp.getState().clearHookRun(path)
  info(ahead === 0 ? 'Nothing to push: already up to date' : skipHooks ? 'Pushed without hooks' : 'Pushed')
  return true
}
