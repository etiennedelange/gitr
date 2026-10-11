import { TriangleAlert } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { notifyError } from '../hooks'
import { copyText } from '../nativeMenu'
import { useApp } from '../store'
import type { GitLocation } from '../types'

export const INSTALL_COMMAND = 'winget install Git.Git'
export const MIN_GIT_VERSION = '2.27'

/** Stays at the top of the app while git is missing or too old (or the Git path setting is broken). */
export function GitBanner() {
  const qc = useQueryClient()
  const info = useQuery({ queryKey: ['gitInfo'], queryFn: api.gitInfo })

  const apply = async (located: Promise<GitLocation>) => {
    try {
      const loc = await located
      qc.setQueryData(['gitInfo'], loc)
      if (loc.problem) {
        // Say the check ran, or "Check again" looks like it did nothing.
        useApp
          .getState()
          .toast('error', loc.problem.kind === 'missing' ? "Git still wasn't found." : `Git ${loc.problem.found} is still too old.`)
      } else {
        useApp.getState().toast('info', `Using git ${loc.version ?? ''}`.trim())
        api.refreshAll().catch(notifyError)
      }
    } catch (e) {
      notifyError(e)
    }
  }

  const choose = async () => {
    const file = await open({
      multiple: false,
      directory: false,
      title: 'Choose git.exe',
      filters: [{ name: 'git.exe', extensions: ['exe'] }],
    })
    if (typeof file === 'string') {
      await apply(api.setGitPath(file))
      qc.invalidateQueries({ queryKey: ['config'] })
    }
  }

  const loc = info.data
  if (!loc) return null
  const problem = loc.problem
  if (!problem && !loc.settingIgnored) return null

  if (!problem) {
    return (
      <div className="banner git" role="status">
        <TriangleAlert size={14} strokeWidth={2} />
        <span className="git-text">
          The Git path in Settings couldn't be run, so Gitr is using <code>{loc.path}</code> instead.
        </span>
      </div>
    )
  }

  const text = problem.kind === 'missing' ? "Git wasn't found." : `Git ${problem.found} is too old. Gitr needs ${MIN_GIT_VERSION} or newer.`
  return (
    <div className="banner git" role="alert">
      <TriangleAlert size={14} strokeWidth={2} />
      <span className="git-text">
        {text} {problem.kind === 'missing' ? 'Install' : 'Update'} it with <code>{INSTALL_COMMAND}</code>
        <button className="small" onClick={() => void copyText(INSTALL_COMMAND).then(() => useApp.getState().toast('info', 'Copied'))}>
          Copy
        </button>
      </span>
      <span className="actions">
        <button className="small" onClick={() => void choose()}>
          Choose git.exe…
        </button>
        <button className="small primary" onClick={() => void apply(api.recheckGit())}>
          Check again
        </button>
      </span>
    </div>
  )
}
