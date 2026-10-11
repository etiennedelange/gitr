import { useEffect, useState } from 'react'
import { CircleArrowDown, X } from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { notifyError } from '../hooks'

/** The startup check waits this long, so it never competes with the first repository refresh. */
export const UPDATE_CHECK_DELAY_MS = 5000

/**
 * The update check, run once a few seconds after startup. A failed check stays quiet (the backend
 * logs it); Settings → Check for updates shows errors and refreshes this result.
 */
function useUpdateCheck() {
  const [due, setDue] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setDue(true), UPDATE_CHECK_DELAY_MS)
    return () => clearTimeout(t)
  }, [])
  return useQuery({ queryKey: ['updateCheck'], queryFn: api.checkUpdate, enabled: due, staleTime: Infinity, retry: false })
}

/** Offers a newer version of the direct download. The Store build never shows it. */
export function UpdateBanner() {
  const check = useUpdateCheck()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const install = useMutation({ mutationFn: api.installUpdate, onError: notifyError })

  const update = check.data?.channel === 'direct' ? check.data.available : null
  if (!update || dismissed === update.version) return null
  const updating = install.isPending
  return (
    <div className="banner update" role="status">
      <CircleArrowDown className="ico" aria-hidden />
      <span className="update-text">
        {updating ? `Updating to Gitr ${update.version}…` : `Gitr ${update.version} is available.`}
        {updating && <span className="muted">Gitr restarts when the update is installed.</span>}
      </span>
      <span className="actions">
        <button className="small" disabled={updating} onClick={() => api.openReleasePage(update.version).catch(notifyError)}>
          What's new
        </button>
        <button className="small primary" disabled={updating} onClick={() => install.mutate()}>
          {updating ? 'Updating…' : 'Restart and update'}
        </button>
        <button
          className="icon"
          title="Dismiss"
          aria-label="Dismiss update"
          disabled={updating}
          onClick={() => setDismissed(update.version)}
        >
          <X className="ico" aria-hidden />
        </button>
      </span>
    </div>
  )
}
