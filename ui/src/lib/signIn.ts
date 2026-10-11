import { api } from '../api'
import { notifyError } from '../hooks'
import { useApp } from '../store'
import type { BatchOp, BatchProgress } from '../types'

/** Repos whose last Fetch all / Pull all result was "Sign-in needed". */
export const signInNeeded = (batch: Record<string, BatchProgress>) => Object.values(batch).filter((p) => p.state === 'error' && p.signIn)

const record = (results: BatchProgress[]) => results.forEach((r) => useApp.getState().setBatch(r))
const repoName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/**
 * What a repo signs in to: its remote's host plus owner (the Azure DevOps organisation or the
 * GitHub owner; every ADO organisation is on dev.azure.com and may need its own sign-in), or the
 * repo itself when the remote isn't one Gitr recognises.
 */
function server(path: string): string {
  const remote = useApp.getState().summaries[path]?.remote
  try {
    return remote ? `${new URL(remote.webUrl).host}/${remote.owner.toLowerCase()}` : path
  } catch {
    return path
  }
}

/** Runs `paths` again without prompting, grouped by operation. */
async function retrySilently(paths: BatchProgress[]) {
  for (const op of ['fetch', 'pull'] as BatchOp[]) {
    const group = paths.filter((p) => p.op === op).map((p) => p.path)
    if (group.length) record(await api.runBatch(op, group, false))
  }
}

/**
 * Signs in once per server. Batches never show sign-in windows, so this repeats one failed repo
 * per server as a single action (Git Credential Manager may show its window), then runs the
 * other failed repos again without prompting; those on the same server now succeed. Each server
 * gets at most one window, also when its sign-in fails (cancelled, or that one repo has no
 * access), so one bad repo doesn't stop the others. Ends with a summary.
 */
export async function signIn(): Promise<void> {
  const st = useApp.getState()
  if (st.signingIn) return
  st.setSigningIn(true)
  const triedServers = new Set<string>()
  const failedServers: string[] = []
  try {
    for (;;) {
      const first = signInNeeded(useApp.getState().batch).find((p) => !triedServers.has(server(p.path)))
      if (!first) break
      triedServers.add(server(first.path))
      const [result] = await api.runBatch(first.op, [first.path], true)
      if (result) record([result])
      if (result?.state !== 'ok') failedServers.push(`${repoName(first.path)}: ${result?.message ?? 'no result'}`)
      // Retried even when this sign-in failed: the window may have worked for the server while
      // only this repo is refused.
      await retrySilently(signInNeeded(useApp.getState().batch))
    }
  } catch (e) {
    notifyError(e)
    return
  } finally {
    useApp.getState().setSigningIn(false)
  }
  const left = signInNeeded(useApp.getState().batch).length
  if (!triedServers.size) return
  if (!left && !failedServers.length) {
    useApp.getState().toast('info', 'Signed in. The repositories that needed it ran again; their rows show the results.')
  } else {
    const still = left ? ` ${left === 1 ? '1 repository still needs' : `${left} repositories still need`} a sign-in.` : ''
    useApp.getState().toast('error', `Signing in didn't work everywhere.${still}`, failedServers.join('\n'))
  }
}
