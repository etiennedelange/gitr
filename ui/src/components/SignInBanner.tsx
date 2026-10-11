import { KeyRound, X } from 'lucide-react'
import { signIn, signInNeeded } from '../lib/signIn'
import { useApp } from '../store'

/**
 * After Fetch all / Pull all: the repos that need a sign-in, with one Sign in for all of them
 * (batches never open sign-in windows themselves). Stays up while Sign in runs, even when its
 * retries briefly leave no repo marked as needing a sign-in.
 */
export function SignInBanner({ running }: { running: boolean }) {
  const needed = signInNeeded(useApp((s) => s.batch))
  const signingIn = useApp((s) => s.signingIn)
  const dismissed = useApp((s) => s.signInDismissed)
  if (!signingIn && (!needed.length || dismissed || running)) return null
  const n = needed.length
  return (
    <div className="banner signin" role="alert">
      <KeyRound className="ico" aria-hidden />
      <span className="signin-text">
        {signingIn ? 'Signing in…' : n === 1 ? '1 repository needs you to sign in' : `${n} repositories need you to sign in`}
        <span className="muted">Sign in once; the others on the same server follow.</span>
      </span>
      <span className="actions">
        <button className="small primary" disabled={signingIn} onClick={() => void signIn()}>
          {signingIn ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          className="icon"
          title="Dismiss"
          aria-label="Dismiss sign-in reminder"
          disabled={signingIn}
          onClick={() => useApp.getState().dismissSignIn()}
        >
          <X className="ico" aria-hidden />
        </button>
      </span>
    </div>
  )
}
