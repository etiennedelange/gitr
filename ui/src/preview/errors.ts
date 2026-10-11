// Sample failed-command errors for the preview, each with the fix buttons the app offers for it.
// Shown with ?toast=<kind> or the toolbar's Error toast button (which cycles through them).
import { useApp } from '../store'

export const ERROR_SAMPLES: Record<string, { message: string; detail: string; lockPath?: string }> = {
  'non-fast-forward': {
    message: "The remote has commits you don't have yet. Pull first, then push again.",
    detail:
      "error: failed to push some refs to 'https://dev.azure.com/acme/Platform/_git/billing-service'\nhint: Updates were rejected because the remote contains work that you do not\n!\trefs/heads/feature/invoice-export:refs/heads/feature/invoice-export\t[rejected] (fetch first)",
  },
  lock: {
    message: 'Another git process is using this repository, or one left a lock file behind.',
    detail:
      "fatal: Unable to create 'D:/Repos/Work/billing-service/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
    lockPath: 'D:/Repos/Work/billing-service/.git/index.lock',
  },
  'dubious-ownership': {
    message: 'Git refuses to work in this folder because it is owned by another user.',
    detail: "fatal: detected dubious ownership in repository at 'D:/Repos/Work/billing-service'",
  },
  auth: {
    message: 'Sign-in failed or is needed for this remote.',
    detail: "fatal: Authentication failed for 'https://dev.azure.com/acme/'",
  },
}

/** Shows the sample error `kind` as a toast about `repo`; false when there is no such sample. */
export function showErrorSample(kind: string, repo: string): boolean {
  const s = ERROR_SAMPLES[kind]
  if (!s) return false
  useApp
    .getState()
    .toast('error', s.message, s.detail, { message: s.message, detail: s.detail, kind: kind as never, repo, lockPath: s.lockPath ?? null })
  return true
}
