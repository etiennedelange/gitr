import { api } from './api'
import { notifyError, useBatch, useBatchRunning } from './hooks'
import { repoMenu } from './lib/menus'
import { copyText, showMenu } from './nativeMenu'
import { useApp } from './store'

/** Returns an onContextMenu handler factory for repo rows (sidebar + dashboard). */
export function useRepoMenu() {
  const batch = useBatch()
  const batchRunning = useBatchRunning()
  return (path: string) => (e: { preventDefault(): void }) => {
    e.preventDefault()
    const { summaries, setView, toast } = useApp.getState()
    void showMenu(
      repoMenu(
        { summary: summaries[path], batchRunning },
        {
          open: () => setView({ kind: 'repo', path }),
          // One repo: a single action, so a sign-in window may appear (unlike Fetch all).
          fetch: () => batch.mutate({ op: 'fetch', paths: [path], interactive: true }),
          pull: () => batch.mutate({ op: 'pull', paths: [path], interactive: true }),
          push: () => {
            const ahead = summaries[path]?.ahead ?? 1
            return api.push(path).then(() => toast('info', ahead === 0 ? 'Nothing to push: already up to date' : 'Pushed'), notifyError)
          },
          explorer: () => void api.openWith(path, 'explorer').catch(notifyError),
          terminal: () => void api.openWith(path, 'terminal').catch(notifyError),
          vsCode: () => void api.openWith(path, 'vsCode').catch(notifyError),
          browser: () => void api.openRemote(path, { kind: 'repo' }).catch(notifyError),
          copyPath: () => void copyText(path),
        },
      ),
    )
  }
}
