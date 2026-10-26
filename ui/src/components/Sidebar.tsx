import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useConfig, useRepos } from '../hooks'
import { useApp } from '../store'
import { ChevronDown, ChevronRight, FolderPlus, LayoutGrid, Moon, Settings as SettingsIcon, Sun } from 'lucide-react'
import { useRepoMenu } from '../repoMenu'
import { plainInput } from '../lib/inputProps'
import { BusyDot } from './Busy'
import { CountChips, StatusMark } from './Marks'
import { needsAttention } from '../lib/git'
import { useAddFolder } from '../lib/addFolder'
import { groupMenu } from '../lib/menus'
import { groupColors, groupStyle } from '../lib/groupColor'
import { showMenu } from '../nativeMenu'
import { saveThemePref, useTheme } from '../theme'

export function Sidebar() {
  const config = useConfig()
  const repos = useRepos()
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const summaries = useApp((s) => s.summaries)
  const [filter, setFilter] = useState('')
  const repoMenu = useRepoMenu()
  const folder = useAddFolder()
  // Settings edits that were left unsaved (see Settings.tsx).
  const unsavedSettings = useApp((s) => {
    const k = s.settingsDraft
    return !!k && JSON.stringify({ ...k.draft, zoom: 0 }) !== JSON.stringify({ ...k.base, zoom: 0 })
  })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Repos that need the user, shown on the Dashboard item so it's visible from inside a repo.
  const urgent = useApp(
    (s) => (repos.data ?? []).filter((r) => needsAttention(s.summaries[r.path], s.batch[r.path]?.state === 'error')).length,
  )

  // While filtering, groups without a match disappear and the rest open so matches are visible.
  const filtering = filter.trim() !== ''
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (config.data?.groups ?? [])
      .map((g) => ({
        ...g,
        repos: (repos.data ?? [])
          .filter((r) => r.groupId === g.id && (!q || r.name.toLowerCase().includes(q)))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      }))
      .filter((g) => !q || g.repos.length > 0)
  }, [config.data, repos.data, filter])
  // With more than one group, each carries its colour: a swatch on its heading and a stripe down
  // its repos, matching the stripes on the dashboard.
  const colors = useMemo(() => groupColors(config.data?.groups ?? []), [config.data])
  const colored = (config.data?.groups.length ?? 0) > 1

  // The tree is one Tab stop; arrow keys move within it (like a Windows tree view). The stop is the
  // item last focused, else the open repo, else the first group.
  const treeRef = useRef<HTMLDivElement>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const keys = groups.flatMap((g) => ['g:' + g.id, ...(filtering || !collapsed[g.id] ? g.repos.map((r) => 'r:' + r.path) : [])])
  const activeKey = view.kind === 'repo' ? 'r:' + view.path : null
  const tabStop = [focusKey, activeKey, keys[0]].find((k) => k && keys.includes(k)) ?? null

  const focusItem = (key: string | undefined) => {
    const items = treeRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? []
    if (key)
      Array.from(items)
        .find((el) => el.dataset.key === key)
        ?.focus()
  }
  const onTreeKey = (e: KeyboardEvent) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key
    if (!key) return
    const i = keys.indexOf(key)
    const isGroup = key.startsWith('g:')
    const groupId = isGroup ? key.slice(2) : (repos.data ?? []).find((r) => 'r:' + r.path === key)?.groupId
    const open = isGroup && (filtering || !collapsed[key.slice(2)])
    if (e.key === 'ArrowDown') focusItem(keys[i + 1])
    else if (e.key === 'ArrowUp') focusItem(keys[i - 1])
    else if (e.key === 'Home') focusItem(keys[0])
    else if (e.key === 'End') focusItem(keys[keys.length - 1])
    else if (e.key === 'ArrowRight' && isGroup && !open) setCollapsed((c) => ({ ...c, [key.slice(2)]: false }))
    else if (e.key === 'ArrowRight' && isGroup) focusItem(keys[i + 1]?.startsWith('r:') ? keys[i + 1] : undefined)
    else if (e.key === 'ArrowLeft' && isGroup && open && !filtering) setCollapsed((c) => ({ ...c, [key.slice(2)]: true }))
    else if (e.key === 'ArrowLeft' && !isGroup && groupId) focusItem('g:' + groupId)
    else return
    e.preventDefault()
  }

  return (
    <nav className="sidebar" aria-label="Repositories">
      <div className="brand">
        {/* Two commits on a line; the newest in accent. */}
        <svg className="brand-mark" viewBox="0 0 18 18" aria-hidden>
          <rect width="18" height="18" rx="4" className="bm-ground" />
          <path d="M5 9h8" className="bm-line" />
          <circle cx="5" cy="9" r="2.2" className="bm-old" />
          <circle cx="13" cy="9" r="2.6" className="bm-new" />
        </svg>
        <span className="nav-label">Gitr</span>
      </div>
      <button
        className={`nav-item ${view.kind === 'dashboard' ? 'active' : ''}`}
        onClick={() => setView({ kind: 'dashboard' })}
        title="Dashboard (Ctrl+D)"
      >
        <LayoutGrid className="ico" aria-hidden />
        <span className="nav-label">Dashboard</span>
        {urgent > 0 && (
          <span className="nav-count alert" title={`${urgent} ${urgent === 1 ? 'repository needs' : 'repositories need'} attention`}>
            {urgent}
          </span>
        )}
      </button>
      <div className="rail-tools">
        <input
          {...plainInput}
          className="search"
          placeholder="Filter repositories…"
          aria-label="Filter repositories in the sidebar"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault()
              e.stopPropagation()
              setFilter('')
            }
          }}
        />
        <button
          className="icon add-folder"
          disabled={folder.pending || !config.data}
          onClick={() => void folder.add()}
          aria-label="Add a folder of repositories"
          title="Add a folder of repositories…"
        >
          <FolderPlus className={`ico ${folder.pending ? 'pulse' : ''}`} aria-hidden />
        </button>
      </div>
      <div className="tree" ref={treeRef} data-pane onKeyDown={onTreeKey}>
        {filtering && !groups.length && <div className="empty small">No repositories match.</div>}
        {config.data && !config.data.groups.length && (
          <div className="tree-empty">
            <p>Add the folder you keep your clones in. Every repository under it shows up here.</p>
            <button className="small" disabled={folder.pending} onClick={() => void folder.add()}>
              <FolderPlus className="ico" aria-hidden />
              Add a folder…
            </button>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.id} className="group" style={colored ? groupStyle(colors.get(g.id)) : undefined}>
            <button
              className="group-head"
              data-key={'g:' + g.id}
              tabIndex={tabStop === 'g:' + g.id ? 0 : -1}
              onFocus={() => setFocusKey('g:' + g.id)}
              title={g.name}
              aria-expanded={filtering || !collapsed[g.id]}
              onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}
              onContextMenu={(e) => {
                e.preventDefault()
                void showMenu(
                  groupMenu({ name: g.name }, { addFolder: () => void folder.add(g.id), settings: () => setView({ kind: 'settings' }) }),
                )
              }}
            >
              {collapsed[g.id] && !filtering ? (
                <ChevronRight className="chevron" aria-hidden />
              ) : (
                <ChevronDown className="chevron" aria-hidden />
              )}
              {colored && <span className="group-swatch" aria-hidden />}
              <span className="group-name">{g.name}</span>
              <span className="count">{g.repos.length}</span>
            </button>
            {(filtering || !collapsed[g.id]) &&
              g.repos.map((r) => {
                const s = summaries[r.path]
                const active = view.kind === 'repo' && view.path === r.path
                return (
                  <button
                    key={r.path}
                    className={`repo-item ${active ? 'active' : ''}`}
                    data-key={'r:' + r.path}
                    tabIndex={tabStop === 'r:' + r.path ? 0 : -1}
                    onFocus={() => setFocusKey('r:' + r.path)}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setView({ kind: 'repo', path: r.path })}
                    onContextMenu={repoMenu(r.path)}
                    title={`${r.name}\n${r.path}`}
                  >
                    {colored && <span className="group-stripe" aria-hidden />}
                    <StatusMark summary={s} />
                    <span className="repo-name">{r.name}</span>
                    <BusyDot path={r.path} />
                    <span className="slot slot-changes">
                      <CountChips summary={s} only="changes" />
                    </span>
                    <span className="slot slot-sync">
                      <CountChips summary={s} only="sync" />
                    </span>
                  </button>
                )
              })}
          </div>
        ))}
      </div>
      <div className="rail-foot">
        <button
          className={`nav-item nav-settings ${view.kind === 'settings' ? 'active' : ''}`}
          onClick={() => setView({ kind: 'settings' })}
          title="Settings (Ctrl+,)"
        >
          <SettingsIcon className="ico" aria-hidden />
          <span className="nav-label">Settings</span>
          {unsavedSettings && <span className="badge dirty unsaved">Unsaved</span>}
        </button>
        <ThemeToggle />
      </div>
    </nav>
  )
}

/** Flips between light and dark in one click; Settings → Appearance can follow Windows instead. */
function ThemeToggle() {
  const next = useTheme().resolved === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${next} theme`
  return (
    <button className="icon theme-toggle" title={label} aria-label={label} onClick={() => saveThemePref(next)}>
      {next === 'light' ? <Sun className="ico" aria-hidden /> : <Moon className="ico" aria-hidden />}
    </button>
  )
}
