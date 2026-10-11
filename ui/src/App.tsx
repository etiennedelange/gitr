import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, errorMessage } from './api'
import { notifyError, useBackendEvents, useBatch, useBatchRunning, useConfig, useRepos } from './hooks'
import { useApp } from './store'
import { useWheelZoom } from './useWheelZoom'
import { installNativeGuards, isEditable } from './lib/nativeGuards'
import { inputMenu } from './lib/menus'
import { showMenu } from './nativeMenu'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './components/Dashboard'
import { RepoView } from './components/RepoView'
import { Settings } from './components/Settings'
import { Toasts } from './components/Toasts'
import { GitBanner } from './components/GitBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RepoSwitcher } from './components/RepoSwitcher'
import { cyclePane } from './lib/panes'

export default function App() {
  useBackendEvents()
  const view = useApp((s) => s.view)
  const qc = useQueryClient()
  const setView = useApp((s) => s.setView)
  const config = useConfig()
  const repos = useRepos()
  const batch = useBatch()
  const batchRunning = useBatchRunning()
  const started = useRef(false)
  const [switcher, setSwitcher] = useState(false)
  useWheelZoom(config.data?.zoom)

  // A failed backend call nobody handled still tells the user instead of vanishing.
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      e.preventDefault()
      useApp.getState().toast('error', errorMessage(e.reason))
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  useEffect(() => {
    api.devtoolsAvailable().then(useApp.getState().setDevtools, () => {})
    return installNativeGuards(window, {
      onDevtools: () => void api.openDevtools().catch(notifyError),
      onContextMenu: (e) => {
        if (isEditable(e.target)) {
          ;(e.target as HTMLElement).focus()
          void showMenu(inputMenu())
        } else {
          void showMenu([]) // only "Inspect" when dev tools are available, otherwise nothing
        }
      },
    })
  }, [])

  useEffect(() => {
    if (started.current || !repos.data || !config.data) return
    started.current = true
    if (!config.data.groups.length) return setView({ kind: 'settings' })
    const cached = repos.data.map((r) => r.path).join('|')
    api.refreshAll().catch(notifyError)
    api
      .rescanRepos()
      .then((fresh) => {
        qc.setQueryData(['repos'], fresh)
        if (fresh.map((r) => r.path).join('|') !== cached) return api.refreshAll()
      })
      .catch(notifyError)
  }, [repos.data, config.data, setView, qc])

  // A rescan or a settings change can remove the repo you are looking at.
  const openPath = view.kind === 'repo' ? view.path : null
  useEffect(() => {
    if (!openPath || !repos.data || repos.data.some((r) => r.path === openPath)) return
    setView({ kind: 'dashboard' })
    useApp.getState().toast('info', 'That repository is no longer in the list')
  }, [openPath, repos.data, setView])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F6' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        cyclePane(document, e.shiftKey)
        return
      }
      if (!e.ctrlKey) return
      const paths = () => (repos.data ?? []).map((r) => r.path)
      if (e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (!batchRunning) batch.mutate({ op: 'fetch', paths: paths() })
      } else if (e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        if (!batchRunning) batch.mutate({ op: 'pull', paths: paths() })
      } else if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        if (repos.data?.length) setSwitcher(true)
      } else if (e.key === ',') {
        e.preventDefault()
        setView({ kind: 'settings' })
      } else if (e.key === '1' || e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setView({ kind: 'dashboard' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [repos.data, batch, batchRunning, setView])

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <GitBanner />
        <UpdateBanner />
        <ErrorBoundary key={view.kind === 'repo' ? `repo:${view.path}` : view.kind}>
          {view.kind === 'dashboard' && <Dashboard />}
          {view.kind === 'settings' && <Settings />}
          {view.kind === 'repo' && <RepoView key={view.path} path={view.path} />}
        </ErrorBoundary>
      </main>
      <Toasts />
      {switcher && <RepoSwitcher onClose={() => setSwitcher(false)} />}
    </div>
  )
}
