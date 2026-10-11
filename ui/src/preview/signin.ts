// Simulated sign-in for the preview's Fetch all / Pull all: with "Sign-in expired" a batch fails
// with "Sign-in needed" (as with GCM_INTERACTIVE=never), and a single action asks once per server
// in place of Git Credential Manager's window. Chosen with ?signin=expired or the toolbar.
// A server is a host plus owner (each Azure DevOps organisation signs in on its own), and
// data-pipeline stays refused after signing in (a 403), which no sign-in fixes.
import type { BatchOp, BatchProgress, RepoSummary } from '../types'

export type SignInMode = 'ok' | 'expired'
export const SIGN_IN_MODES: { id: SignInMode; name: string }[] = [
  { id: 'ok', name: 'Signed in' },
  { id: 'expired', name: 'Sign-in expired' },
]

let mode: SignInMode = new URLSearchParams(location.search).get('signin') === 'expired' ? 'expired' : 'ok'
const signedIn = new Set<string>()
export const signInMode = () => mode
export function setSignInMode(m: SignInMode) {
  mode = m
  signedIn.clear()
}

/** "dev.azure.com/acme": what one sign-in covers, as in the app's Sign in. */
const server = (s: RepoSummary) => `${new URL(s.remote!.webUrl).host}/${s.remote!.owner}`
const NO_ACCESS = 'data-pipeline'

/** One repo of a simulated batch. `interactive` = a single action, which may "show" a sign-in. */
export function batchResult(path: string, op: BatchOp, interactive: boolean, summary: RepoSummary | undefined): BatchProgress {
  const done = (state: BatchProgress['state'], message: string | null = null, kind: BatchProgress['kind'] = null, signIn = false) => ({
    path,
    op,
    state,
    message,
    kind,
    signIn,
  })
  if (!summary?.remote) return done('skipped', 'No remote')
  const h = server(summary)
  if (mode === 'expired' && !signedIn.has(h)) {
    if (!interactive) return done('error', 'Sign-in needed', 'auth', true)
    if (!window.confirm(`Git Credential Manager (simulated)\n\nSign in to ${h}?`))
      return done('error', 'Sign-in failed or is needed for this remote.', 'auth')
    signedIn.add(h)
  }
  if (mode === 'expired' && summary.remote.repo === NO_ACCESS)
    return done('error', 'The remote refused access: you are signed in but have no permission for this repository.', 'auth')
  return done('ok', op === 'pull' ? (summary.behind ? 'Fast-forwarded' : 'Up to date') : null)
}
