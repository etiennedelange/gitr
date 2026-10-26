import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Folder, FolderPlus, Plus, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { api, errorMessage } from '../api'
import { notifyError, useConfig, useRepos, useRescan } from '../hooks'
import { useApp } from '../store'
import type { Config, Group } from '../types'
import { plainInput } from '../lib/inputProps'
import { saveThemePref, useTheme, type ThemePref } from '../theme'
import { folderName, pickFolder } from '../lib/addFolder'

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
function IntInput({
  id,
  describedBy,
  value,
  min,
  max,
  onChange,
}: {
  id?: string
  describedBy?: string
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  const [raw, setRaw] = useState<string | null>(null)
  return (
    <input
      {...plainInput}
      id={id}
      aria-describedby={describedBy}
      className="num"
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

/**
 * One setting: its name and what it does on the left, the control on the right. The control gets
 * `id` (for the label) and is described by the hint.
 */
function Row({
  label,
  hint,
  control,
}: {
  label: ReactNode
  hint?: ReactNode
  control: (ids: { id: string; hintId?: string }) => ReactNode
}) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div className="set-row">
      <div className="set-text">
        <label htmlFor={id}>{label}</label>
        {hint && (
          <div className="set-hint" id={hintId}>
            {hint}
          </div>
        )}
      </div>
      <div className="set-control">{control({ id, hintId })}</div>
    </div>
  )
}

/** A section: its heading, an optional line on what it is for, and its rows. */
function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-h`}>
      <h2 id={`settings-${id}-h`}>{title}</h2>
      {intro && <p className="set-intro">{intro}</p>}
      {children}
    </section>
  )
}

/** A checkbox drawn as a Windows toggle switch. */
function Switch({ id, hintId, checked, onChange }: { id: string; hintId?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="switch"
      aria-describedby={hintId}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

const SHORTCUTS: { title: string; keys: [string[][], string][] }[] = [
  {
    title: 'Anywhere',
    keys: [
      [[['Ctrl', 'P']], 'Go to a repository by name'],
      [[['Ctrl', 'D']], 'Dashboard'],
      [[['Ctrl', ',']], 'Settings'],
      [[['Ctrl', 'Shift', 'F']], 'Fetch all'],
      [[['Ctrl', 'Shift', 'P']], 'Pull all'],
      [[['F6'], ['Shift', 'F6']], 'Next or previous pane'],
      [[['Ctrl', 'Scroll']], 'Zoom in or out'],
    ],
  },
  {
    title: 'Sidebar',
    keys: [
      [[['↑'], ['↓']], 'Move through the repositories'],
      [[['←'], ['→']], 'Fold or unfold a group'],
    ],
  },
  {
    title: 'Repository',
    keys: [
      [[['Ctrl', 'Tab']], 'Next tab: Changes, History, Branches'],
      [[['↑'], ['↓']], 'Select a file'],
      [[['Space']], 'Stage or unstage the file'],
      [[['Delete']], 'Discard the file’s changes'],
      [[['Ctrl', 'G']], 'Generate a commit message'],
      [[['Ctrl', 'Enter']], 'Commit'],
      [[['Ctrl', 'Shift', 'Enter']], 'Commit and push'],
      [[['Ctrl', 'O']], 'Open the branch in the browser'],
    ],
  },
]

/** Key combinations as key caps: each combo's keys side by side, alternatives split by "or". */
function Keys({ combos }: { combos: string[][] }) {
  return (
    <span className="keys">
      {combos.map((combo, i) => (
        <span key={i} className="combo">
          {/* Single keys read as a pair (↑ ↓); combos need the word between them. */}
          {i > 0 && combos.some((c) => c.length > 1) && <span className="or">or</span>}
          {combo.map((k) => (
            <kbd key={k}>{k}</kbd>
          ))}
        </span>
      ))}
    </span>
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
    <Section id="updates" title="Updates">
      <div className="set-list">
        <div className="set-row">
          <div className="set-text">
            <div className="set-label">{version.data ? `Gitr ${version.data.version}` : 'Gitr'}</div>
            {store ? (
              <div className="set-hint">Updates come from the Microsoft Store.</div>
            ) : (
              <div role="status" className={check.isError ? 'set-hint error-text' : available ? 'set-hint news' : 'set-hint'}>
                {check.isError
                  ? errorMessage(check.error)
                  : available
                    ? `Gitr ${available.version} is available.`
                    : check.isSuccess
                      ? 'Gitr is up to date.'
                      : ''}
              </div>
            )}
          </div>
          {!store && (
            <div className="set-control">
              <button disabled={check.isPending || install.isPending || !version.data} onClick={() => check.mutate()}>
                {check.isPending ? 'Checking…' : 'Check for updates'}
              </button>
              {available && (
                <button className="primary" disabled={install.isPending} onClick={() => install.mutate()}>
                  {install.isPending ? 'Updating…' : 'Restart and update'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </Section>
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
      groups: [...draft.groups, { id: crypto.randomUUID(), name: folderName(dir), roots: [dir] }],
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

  const repos = useRepos()
  // A count only means something for a group as it was last scanned; a new or changed one is scanned on Save.
  const repoCount = (g: Group) => {
    const was = saved.groups.find((x) => x.id === g.id)
    if (!was || was.roots.join('|') !== g.roots.join('|')) return 'Scanned when you save'
    if (!repos.data) return ''
    const n = repos.data.filter((r) => r.groupId === g.id).length
    return n === 1 ? '1 repository' : `${n} repositories`
  }

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
        {unnamed ? (
          <span className="field-hint" role="alert">
            Name every group before saving.
          </span>
        ) : (
          <span className="set-dirty" role="status">
            {dirty ? 'Unsaved changes' : ''}
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

      <div className="settings-body" ref={bodyRef} onScroll={onScroll} data-pane>
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
          <div className="settings-sections">
            <Section
              id="workspaces"
              title="Workspace groups"
              intro={
                draft.groups.length
                  ? 'Gitr finds every Git repository under these folders. Each group is a heading in the sidebar.'
                  : undefined
              }
            >
              {!draft.groups.length ? (
                <div className="first-run">
                  <p>
                    Gitr finds every Git repository under the folders you choose. Each folder becomes a group in the sidebar, such as Work
                    or Personal.
                  </p>
                  <p>Start with the folder you keep your clones in, for example D:\Repos.</p>
                </div>
              ) : (
                <div className="set-list groups">
                  {draft.groups.map((g) => (
                    <div key={g.id} className="group-block" role="group" aria-label={g.name.trim() || 'Unnamed group'}>
                      <div className="group-row">
                        <input
                          {...plainInput}
                          className="group-name"
                          aria-label="Group name"
                          value={g.name}
                          onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                        />
                        <span className="group-count">{repoCount(g)}</span>
                        <div className="spacer" />
                        <button className="small" aria-label={`Add folder to ${g.name.trim() || 'this group'}`} onClick={() => addRoot(g)}>
                          <FolderPlus className="ico" aria-hidden />
                          Add folder
                        </button>
                        <button
                          className="small danger"
                          aria-label={`Remove group ${g.name.trim() || 'Unnamed group'}`}
                          onClick={() => update({ groups: draft.groups.filter((x) => x.id !== g.id) })}
                        >
                          Remove group
                        </button>
                      </div>
                      <ul className="roots" aria-label={`Folders in ${g.name || 'this group'}`}>
                        {g.roots.map((r) => (
                          <li key={r}>
                            <Folder className="ico" aria-hidden />
                            <span className="mono selectable">{r}</span>
                            <button
                              className="icon"
                              title="Remove folder"
                              aria-label={`Remove folder ${r}`}
                              onClick={() => updateGroup(g.id, { roots: g.roots.filter((x) => x !== r) })}
                            >
                              <X className="ico" aria-hidden />
                            </button>
                          </li>
                        ))}
                        {!g.roots.length && <li className="roots-empty">No folders. Add one, or remove the group.</li>}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
              <button className={draft.groups.length ? 'set-add' : 'primary set-add'} onClick={() => void addGroup()}>
                <Plus className="ico" aria-hidden />
                {draft.groups.length ? 'Add group from folder…' : 'Choose a folder…'}
              </button>
            </Section>

            <Section id="discovery" title="Discovery" intro="How Gitr looks for repositories and keeps them up to date.">
              <div className="set-list">
                <Row
                  label="Scan depth"
                  hint="How many folders deep to look under each group folder, from 1 to 8."
                  control={({ id, hintId }) => (
                    <IntInput
                      id={id}
                      describedBy={hintId}
                      min={1}
                      max={8}
                      value={draft.scanDepth}
                      onChange={(scanDepth) => update({ scanDepth })}
                    />
                  )}
                />
                <Row
                  label="Excluded folders"
                  hint="Folder names never searched, separated by commas."
                  control={({ id, hintId }) => (
                    <input
                      {...plainInput}
                      id={id}
                      className="wide mono"
                      aria-describedby={hintId}
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
                  )}
                />
                <Row
                  label="Parallel operations"
                  hint="How many repositories Fetch all and Pull all work on at once, from 1 to 32."
                  control={({ id, hintId }) => (
                    <IntInput
                      id={id}
                      describedBy={hintId}
                      min={1}
                      max={32}
                      value={draft.concurrency}
                      onChange={(concurrency) => update({ concurrency })}
                    />
                  )}
                />
                <Row
                  label="Refresh automatically"
                  hint="Watch the repositories’ files and update their status when something changes."
                  control={(ids) => <Switch {...ids} checked={draft.watch} onChange={(watch) => update({ watch })} />}
                />
              </div>
            </Section>

            <Section id="git" title="Git">
              <div className="set-list">
                <Row
                  label="Git path"
                  hint={
                    <span role="status" className={gitInfo.data && !gitInfo.data.path ? 'error-text' : undefined}>
                      {gitInfo.data?.path
                        ? `Using ${gitInfo.data.path}, git ${gitInfo.data.version ?? '?'}.` +
                          (gitInfo.data.settingIgnored ? ' The path you chose could not be run, so Gitr found Git itself.' : '')
                        : gitInfo.data
                          ? 'Git was not found. Install Git for Windows, or choose git.exe.'
                          : 'Leave empty to find Git automatically.'}
                    </span>
                  }
                  control={({ id, hintId }) => (
                    <>
                      <input
                        {...plainInput}
                        id={id}
                        className="wide mono"
                        aria-describedby={hintId}
                        placeholder="Automatic"
                        value={draft.gitPath ?? ''}
                        onChange={(e) => update({ gitPath: e.target.value || null })}
                      />
                      <button onClick={browseGit}>Browse…</button>
                    </>
                  )}
                />
                <Row
                  label="When branches have diverged"
                  hint={
                    <>
                      What Pull does when both sides have new commits. A <code>pull.rebase</code> setting in the repository or your global
                      Git config wins.
                    </>
                  }
                  control={({ id, hintId }) => (
                    <select
                      id={id}
                      aria-describedby={hintId}
                      value={draft.divergedStrategy}
                      onChange={(e) => update({ divergedStrategy: e.target.value as Config['divergedStrategy'] })}
                    >
                      <option value="rebase">Rebase my commits onto the remote</option>
                      <option value="merge">Merge the remote into my branch</option>
                    </select>
                  )}
                />
              </div>
            </Section>

            <Section
              id="copilot"
              title="GitHub Copilot"
              intro={
                <>
                  Writes commit messages with your Copilot subscription, through the Copilot CLI. Install it with{' '}
                  <code>winget install GitHub.Copilot</code>, then run <code>copilot</code> once to sign in.
                </>
              }
            >
              <div className="set-list">
                <Row
                  label="Model"
                  hint={
                    models.isError ? (
                      <span className="error-text">{errorMessage(models.error)}</span>
                    ) : models.isLoading ? (
                      'Loading models…'
                    ) : (
                      'Default lets Copilot choose.'
                    )
                  }
                  control={({ id, hintId }) => (
                    <select
                      id={id}
                      aria-describedby={hintId}
                      value={draft.copilotModel ?? ''}
                      onChange={(e) => update({ copilotModel: e.target.value || null })}
                    >
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
                  )}
                />
                <Row
                  label="Copilot CLI path"
                  hint="Leave empty to find it on PATH. A change applies after Gitr restarts."
                  control={({ id, hintId }) => (
                    <input
                      {...plainInput}
                      id={id}
                      className="wide mono"
                      aria-describedby={hintId}
                      placeholder="Automatic"
                      value={draft.copilotCliPath ?? ''}
                      onChange={(e) => update({ copilotCliPath: e.target.value || null })}
                    />
                  )}
                />
              </div>
            </Section>

            <Section id="appearance" title="Appearance" intro="These apply right away on this computer, without Save.">
              <div className="set-list">
                <div className="set-row">
                  <div className="set-text">
                    <div className="set-label" id="settings-theme">
                      Theme
                    </div>
                  </div>
                  <div className="set-control">
                    <div className="segmented" role="group" aria-labelledby="settings-theme">
                      {(
                        [
                          ['system', 'Match Windows'],
                          ['light', 'Light'],
                          ['dark', 'Dark'],
                        ] as [ThemePref, string][]
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          className={theme === value ? 'on' : ''}
                          aria-pressed={theme === value}
                          onClick={() => saveThemePref(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="set-row">
                  <div className="set-text">
                    <div className="set-label" id="settings-zoom">
                      Zoom
                    </div>
                    <div className="set-hint" id="settings-zoom-hint">
                      Ctrl + scroll to change. Over a diff, Ctrl + scroll sizes only the diff text.
                    </div>
                  </div>
                  <div className="set-control">
                    {/* An output, so the level is read with its name and announced as Ctrl + scroll changes it. */}
                    <output className="set-value" aria-labelledby="settings-zoom" aria-describedby="settings-zoom-hint">
                      {zoom}%
                    </output>
                  </div>
                </div>
              </div>
            </Section>

            <UpdatesSection />

            <Section id="developer" title="Developer">
              <div className="set-list">
                <Row
                  label="Developer tools"
                  hint="F12 or Ctrl+Shift+I, and Inspect in right-click menus."
                  control={(ids) => <Switch {...ids} checked={draft.devtools} onChange={(devtools) => update({ devtools })} />}
                />
                <div className="set-row">
                  <div className="set-text">
                    <div className="set-label">Logs</div>
                    <div className="set-hint">For troubleshooting. Gitr keeps them for 14 days.</div>
                  </div>
                  <div className="set-control">
                    <button onClick={() => api.openLogsFolder().catch(notifyError)}>Open logs folder</button>
                  </div>
                </div>
              </div>
            </Section>

            <Section id="shortcuts" title="Keyboard shortcuts">
              {SHORTCUTS.map((group) => (
                <div key={group.title} className="shortcut-group">
                  <h3>{group.title}</h3>
                  <dl className="set-list shortcuts">
                    {group.keys.map(([combos, what]) => (
                      <div key={what} className="set-row">
                        <dt>{what}</dt>
                        <dd>
                          <Keys combos={combos} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </Section>
          </div>
        </div>
      </div>
    </div>
  )
}
