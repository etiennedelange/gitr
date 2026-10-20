import { useEffect, useRef, useState } from 'react'
import { FolderPlus, Plus, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { api, errorMessage } from '../api'
import { notifyError, useConfig, useRescan } from '../hooks'
import { useApp } from '../store'
import type { Config, Group } from '../types'
import { plainInput } from '../lib/inputProps'
import { saveThemePref, useTheme, type ThemePref } from '../theme'
import { folderName, pickFolder } from '../lib/addFolder'
import { GROUP_COLORS, groupColors, groupStyle, nextGroupColor } from '../lib/groupColor'

const SECTIONS = [
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'discovery', label: 'Discovery' },
  { id: 'git', label: 'Git' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'updates', label: 'Updates' },
  { id: 'developer', label: 'Developer' },
  { id: 'shortcuts', label: 'Shortcuts' },
]

/**
 * A whole-number field you can clear and retype: what it reports is always inside [min, max], and
 * it snaps back to the last good value on blur.
 */
function IntInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [raw, setRaw] = useState<string | null>(null)
  return (
    <input
      {...plainInput}
      type="number"
      min={min}
      max={max}
      value={raw ?? String(value)}
      onChange={(e) => {
        setRaw(e.target.value)
        const n = Number.parseInt(e.target.value, 10)
        // Out-of-range numbers are reported clamped right away, so Save is already enabled (and
        // saves the clamped value) when it is clicked before the field loses focus.
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)))
      }}
      onBlur={() => {
        const n = Number.parseInt(raw ?? '', 10)
        if (raw !== null && Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)))
        setRaw(null)
      }}
    />
  )
}

/** The running version, and a manual update check (its result also feeds the update banner). */
function UpdatesSection() {
  const qc = useQueryClient()
  const version = useQuery({ queryKey: ['appVersion'], queryFn: api.appVersion, staleTime: Infinity })
  const check = useMutation({ mutationFn: api.checkUpdate, onSuccess: (r) => qc.setQueryData(['updateCheck'], r) })
  const install = useMutation({ mutationFn: api.installUpdate, onError: notifyError })
  const store = version.data?.channel === 'store'
  const available = check.data?.available
  return (
    <section id="settings-updates">
      <h2>Updates</h2>
      <p>{version.data ? `Gitr ${version.data.version}` : ''}</p>
      {store ? (
        <p className="muted">Updates come from the Microsoft Store.</p>
      ) : (
        <div className="field">
          <button disabled={check.isPending || install.isPending || !version.data} onClick={() => check.mutate()}>
            {check.isPending ? 'Checking…' : 'Check for updates'}
          </button>
          <span role="status" className={check.isError ? 'error-text' : 'muted'}>
            {check.isError
              ? errorMessage(check.error)
              : available
                ? `Gitr ${available.version} is available.`
                : check.isSuccess
                  ? 'Gitr is up to date.'
                  : ''}
          </span>
          {available && (
            <button className="primary" disabled={install.isPending} onClick={() => install.mutate()}>
              {install.isPending ? 'Updating…' : 'Restart and update'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

export function Settings() {
  const config = useConfig()
  if (!config.data) return <div className="empty loading">Loading…</div>
  // A folder added from the sidebar or dashboard changes the groups; start the form again from
  // the kept draft, which carries that folder too.
  return <SettingsForm key={config.data.groups.map((g) => `${g.id}:${g.roots.join('|')}`).join(',')} saved={config.data} />
}

function SettingsForm({ saved }: { saved: Config }) {
  const qc = useQueryClient()
  const rescan = useRescan()
  const [draft, setDraftState] = useState<Config>(() => {
    const kept = useApp.getState().settingsDraft
    return kept && kept.base === saved ? kept.draft : structuredClone(saved)
  })
  // Unsaved edits survive leaving Settings (Esc, sidebar) so a half-made change is never lost silently.
  const setDraft = (next: Config) => {
    setDraftState(next)
    useApp.getState().setSettingsDraft({ base: saved, draft: next })
  }
  const revert = () => {
    setDraftState(structuredClone(saved))
    useApp.getState().setSettingsDraft(null)
  }
  const [excludesText, setExcludesText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const models = useQuery({ queryKey: ['models'], queryFn: api.listModels, staleTime: Infinity })
  const gitInfo = useQuery({ queryKey: ['gitInfo'], queryFn: api.gitInfo })
  const zoom = useApp((s) => s.zoom)
  // The theme applies immediately and is kept per machine, like zoom; not part of Save. The
  // sidebar's toggle changes it too.
  const theme = useTheme().pref

  const update = (patch: Partial<Config>) => setDraft({ ...draft, ...patch })

  const closeSettings = useApp((s) => s.closeSettings)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(SECTIONS[0].id)
  const jumping = useRef(false)
  const jumpTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  const jumpTo = (id: string) => {
    setActive(id)
    jumping.current = true
    clearTimeout(jumpTimer.current)
    // Ignore scroll-spy until the smooth scroll settles, or the highlight flickers through intermediate sections.
    jumpTimer.current = setTimeout(() => (jumping.current = false), 600)
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  }

  const onScroll = () => {
    const body = bodyRef.current
    if (!body) return
    if (jumping.current) {
      clearTimeout(jumpTimer.current)
      jumpTimer.current = setTimeout(() => (jumping.current = false), 150)
      return
    }
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4
    if (atEnd) return setActive(SECTIONS[SECTIONS.length - 1].id)
    const top = body.getBoundingClientRect().top
    let current = SECTIONS[0].id
    for (const s of SECTIONS) {
      const el = document.getElementById(`settings-${s.id}`)
      if (el && el.getBoundingClientRect().top - top <= 40) current = s.id
    }
    setActive(current)
  }

  const browseGit = async () => {
    const file = await open({
      multiple: false,
      directory: false,
      title: 'Choose git.exe',
      filters: [{ name: 'git.exe', extensions: ['exe'] }],
    })
    if (typeof file === 'string') update({ gitPath: file })
  }
  const updateGroup = (id: string, patch: Partial<Group>) =>
    update({ groups: draft.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })

  const addGroup = async () => {
    const dir = await pickFolder()
    if (!dir) return
    const next = {
      ...draft,
      groups: [...draft.groups, { id: crypto.randomUUID(), name: folderName(dir), roots: [dir], color: nextGroupColor(draft.groups) }],
    }
    // The first group is saved right away, so its repositories fill the sidebar without a Save step.
    if (!saved.groups.length && !draft.groups.length) {
      setDraft(next)
      await save(next)
    } else setDraft(next)
  }

  const addRoot = async (g: Group) => {
    const dir = await pickFolder()
    if (dir && !g.roots.includes(dir)) updateGroup(g.id, { roots: [...g.roots, dir] })
  }

  const colors = groupColors(draft.groups)
  const dirty = JSON.stringify({ ...draft, zoom: 0 }) !== JSON.stringify({ ...saved, zoom: 0 })
  const unnamed = draft.groups.some((g) => !g.name.trim())

  const save = async (draft: Config) => {
    setSaving(true)
    try {
      const rootsChanged =
        JSON.stringify(draft.groups) !== JSON.stringify(saved.groups) ||
        draft.scanDepth !== saved.scanDepth ||
        JSON.stringify(draft.excludes) !== JSON.stringify(saved.excludes)
      await api.saveConfig(draft)
      useApp.getState().setSettingsDraft(null)
      qc.setQueryData(['config'], draft)
      // The backend switches to the new Git path immediately; show what it found.
      if (draft.gitPath !== saved.gitPath) await qc.invalidateQueries({ queryKey: ['gitInfo'] })
      useApp.getState().toast('info', 'Settings saved')
      api.devtoolsAvailable().then(useApp.getState().setDevtools, () => {})
      if (rootsChanged) await rescan.mutateAsync()
    } catch (e) {
      notifyError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings">
      <header className="toolbar">
        <h1>Settings</h1>
        <div className="spacer" />
        {unnamed && (
          <span className="field-hint" role="alert">
            Name every group before saving.
          </span>
        )}
        <button disabled={!dirty} onClick={revert}>
          Revert
        </button>
        <button className="primary" disabled={!dirty || saving || unnamed} onClick={() => void save(draft)}>
          {saving || rescan.isPending ? 'Saving…' : 'Save'}
        </button>
        <button className="icon" title="Close (Esc)" aria-label="Close settings" onClick={closeSettings}>
          <X className="ico" aria-hidden />
        </button>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={active === s.id ? 'active' : ''}
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => jumpTo(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body" ref={bodyRef} onScroll={onScroll} data-pane>
          <section id="settings-workspaces">
            <h2>Workspace groups</h2>
            {!draft.groups.length ? (
              <div className="first-run">
                <p>
                  Gitr finds every Git repository under the folders you choose. Each folder becomes a group in the sidebar, such as Work or
                  Personal.
                </p>
                <p>Start with the folder you keep your clones in, for example D:\Repos.</p>
              </div>
            ) : (
              <p className="muted">Each group scans one or more root folders for Git repositories.</p>
            )}
            {draft.groups.map((g) => (
              <div key={g.id} className="card">
                <div className="card-head">
                  <input
                    {...plainInput}
                    aria-label="Group name"
                    value={g.name}
                    onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                  />
                  <div className="swatches" role="radiogroup" aria-label={`Colour of ${g.name || 'this group'}`}>
                    {GROUP_COLORS.map((c) => (
                      <label key={c} className="swatch-pick" title={c.charAt(0).toUpperCase() + c.slice(1)}>
                        <input
                          type="radio"
                          name={`color-${g.id}`}
                          value={c}
                          aria-label={c}
                          checked={colors.get(g.id) === c}
                          onChange={() => updateGroup(g.id, { color: c })}
                        />
                        <span className="swatch" style={groupStyle(c)} aria-hidden />
                      </label>
                    ))}
                  </div>
                  <div className="spacer" />
                  <button className="small" onClick={() => addRoot(g)}>
                    <FolderPlus className="ico" aria-hidden />
                    Add folder
                  </button>
                  <button className="small danger" onClick={() => update({ groups: draft.groups.filter((x) => x.id !== g.id) })}>
                    Remove group
                  </button>
                </div>
                <ul className="roots">
                  {g.roots.map((r) => (
                    <li key={r}>
                      <span className="mono selectable">{r}</span>
                      <button
                        className="icon"
                        title="Remove folder"
                        onClick={() => updateGroup(g.id, { roots: g.roots.filter((x) => x !== r) })}
                      >
                        <X className="ico" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <button className={draft.groups.length ? '' : 'primary'} onClick={() => void addGroup()}>
              <Plus className="ico" aria-hidden />
              {draft.groups.length ? 'Add group from folder…' : 'Choose a folder…'}
            </button>
          </section>

          <section id="settings-discovery">
            <h2>Discovery</h2>
            <label className="field">
              <span>Scan depth</span>
              <IntInput min={1} max={8} value={draft.scanDepth} onChange={(scanDepth) => update({ scanDepth })} />
            </label>
            <label className="field">
              <span>Excluded folders</span>
              <input
                {...plainInput}
                value={excludesText ?? draft.excludes.join(', ')}
                onChange={(e) => {
                  setExcludesText(e.target.value)
                  update({
                    excludes: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }}
                onBlur={() => setExcludesText(null)}
              />
            </label>
            <label className="field">
              <span>Parallel operations</span>
              <IntInput min={1} max={32} value={draft.concurrency} onChange={(concurrency) => update({ concurrency })} />
            </label>
            <label className="field check">
              <input type="checkbox" checked={draft.watch} onChange={(e) => update({ watch: e.target.checked })} />
              <span>Watch files and refresh automatically</span>
            </label>
          </section>

          <section id="settings-git">
            <h2>Git</h2>
            <label className="field">
              <span>Git path</span>
              <input
                {...plainInput}
                placeholder={gitInfo.data?.path && !draft.gitPath ? `Automatic (${gitInfo.data.path})` : 'Automatic'}
                value={draft.gitPath ?? ''}
                onChange={(e) => update({ gitPath: e.target.value || null })}
              />
              <button className="small" onClick={browseGit}>
                Browse…
              </button>
            </label>
            <label className="field">
              <span>When branches have diverged</span>
              <select
                value={draft.divergedStrategy}
                onChange={(e) => update({ divergedStrategy: e.target.value as Config['divergedStrategy'] })}
              >
                <option value="rebase">Rebase my commits onto the remote</option>
                <option value="merge">Merge the remote into my branch</option>
              </select>
              <span className="muted small">pull.rebase in the repo or your global git config wins</span>
            </label>
            <p className="muted small" role="status">
              {gitInfo.data?.path
                ? `Using ${gitInfo.data.path} · git ${gitInfo.data.version ?? '?'}`
                : gitInfo.data
                  ? 'Git was not found'
                  : ''}
              {gitInfo.data?.settingIgnored ? ' (the path above could not be run; found automatically instead)' : ''}
            </p>
          </section>

          <section id="settings-copilot">
            <h2>GitHub Copilot</h2>
            <p className="muted">
              Uses your Copilot subscription through the Copilot CLI. Install with <code>winget install GitHub.Copilot</code> and run{' '}
              <code>copilot</code> once to sign in.
            </p>
            <label className="field">
              <span>Model</span>
              <select value={draft.copilotModel ?? ''} onChange={(e) => update({ copilotModel: e.target.value || null })}>
                <option value="">Default</option>
                {models.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
                {draft.copilotModel && !models.data?.some((m) => m.id === draft.copilotModel) && (
                  <option value={draft.copilotModel}>{draft.copilotModel}</option>
                )}
              </select>
              {models.isLoading && <span className="muted small">loading models…</span>}
              {models.isError && <span className="error-text small">{errorMessage(models.error)}</span>}
            </label>
            <label className="field">
              <span>Copilot CLI path</span>
              <input
                {...plainInput}
                placeholder="Auto-detect from PATH"
                value={draft.copilotCliPath ?? ''}
                onChange={(e) => update({ copilotCliPath: e.target.value || null })}
              />
              <span className="muted small">applies after restart</span>
            </label>
          </section>

          <section id="settings-appearance">
            <h2>Appearance</h2>
            <label className="field">
              <span>Theme</span>
              <select value={theme} onChange={(e) => saveThemePref(e.target.value as ThemePref)}>
                <option value="system">Follow Windows</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <p className="zoom-level">
              Zoom: {zoom}% <span className="muted">— Ctrl + scroll to change; over a diff, it zooms only the diff</span>
            </p>
          </section>

          <UpdatesSection />

          <section id="settings-developer">
            <h2>Developer</h2>
            <label className="field check">
              <input type="checkbox" checked={draft.devtools} onChange={(e) => update({ devtools: e.target.checked })} />
              <span>Developer tools (F12 / Ctrl+Shift+I, and “Inspect” in right-click menus)</span>
            </label>
            <div className="field">
              <button onClick={() => api.openLogsFolder().catch(notifyError)}>Open logs folder</button>
              <span className="muted">Log files for troubleshooting (kept for 14 days)</span>
            </div>
          </section>

          <section id="settings-shortcuts">
            <h2>Keyboard shortcuts</h2>
            <table className="shortcuts">
              <tbody>
                {[
                  ['Ctrl+P', 'Go to a repository by name'],
                  ['Ctrl+D', 'Dashboard'],
                  ['Ctrl+Shift+F', 'Fetch all'],
                  ['Ctrl+Shift+P', 'Pull all'],
                  ['Ctrl+,', 'Settings'],
                  ['F6 / Shift+F6', 'Next / previous pane (repos, file lists, diff, commit message)'],
                  ['↑ / ↓, ← / →', 'Move through the repos in the sidebar, fold a group'],
                  ['Ctrl+Tab', 'Next tab: Changes, History, Branches'],
                  ['↑ / ↓, Space', 'Select file, stage / unstage'],
                  ['Delete', 'Discard selected file'],
                  ['Ctrl+G', 'Generate commit message'],
                  ['Ctrl+Enter', 'Commit'],
                  ['Ctrl+Shift+Enter', 'Commit & push'],
                  ['Ctrl+O', 'Open branch in browser'],
                  ['Ctrl+Scroll', 'Zoom in / out'],
                  ['Ctrl+Scroll over a diff', 'Zoom only the diff'],
                ].map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <kbd>{k}</kbd>
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  )
}
