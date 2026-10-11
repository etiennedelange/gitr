// Preview-only toolbar: switch mock scenario, hooks, sign-in and theme, fire sample toasts. Deliberately plain
// and dark so it never reads as part of the app. Closed, it is a small Mock button in the
// bottom-right corner; hide it with ?chrome=0 or its Hide toolbar button.
import { loadThemePref, resolveTheme, saveThemePref } from '../theme'
import { useApp } from '../store'
import type { Scenario } from './scenarios'
import { ERROR_SAMPLES, showErrorSample } from './errors'
import { HOOK_MODES, type HookMode, hookMode, setHookMode } from './hooks'
import { SIGN_IN_MODES, type SignInMode, setSignInMode, signInMode } from './signin'

const css = `
.pv-bar { position: fixed; right: 14px; bottom: 14px; z-index: 1000; display: flex; flex-direction: column; align-items: stretch; gap: 4px;
  padding: 6px; border-radius: 10px; background: #111; color: #eee; font: 12px/1 system-ui, sans-serif; box-shadow: 0 8px 24px rgb(0 0 0 / 0.35); }
.pv-bar * { font: inherit; }
.pv-bar .pv-controls { display: none; flex-direction: column; gap: 4px; min-width: 170px; }
.pv-bar.open .pv-controls { display: flex; }
.pv-bar select, .pv-bar button { all: unset; padding: 6px 9px; border-radius: 6px; background: #262626; color: #eee; cursor: default; }
.pv-bar button:hover, .pv-bar select:hover { background: #333; }
.pv-bar .pv-toggle { font-weight: 600; text-align: center; }
.pv-bar select { padding-right: 22px; background: #262626 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23aaa' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 8px center; }
.pv-bar option { background: #262626; }
/* Toasts sit above the closed toolbar. */
.toasts { bottom: 56px; }
`

export function mountToolbar(scenarios: Scenario[], current: Scenario) {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)

  const bar = document.createElement('div')
  bar.className = 'pv-bar'
  bar.title = current.about

  const pick = document.createElement('select')
  for (const s of scenarios) pick.append(new Option(s.name, s.id, false, s.id === current.id))
  pick.onchange = () => {
    const url = new URL(location.href)
    url.searchParams.set('scenario', pick.value)
    // A repo from the old scenario may not exist in the new one.
    for (const k of ['repo', 'file']) url.searchParams.delete(k)
    location.href = url.toString()
  }

  const button = (text: string, act: () => void) => {
    const b = document.createElement('button')
    b.textContent = text
    b.onclick = act
    return b
  }
  const themeText = () => (resolveTheme(loadThemePref()) === 'dark' ? 'Dark' : 'Light')
  const theme = button(themeText(), () => {
    saveThemePref(resolveTheme(loadThemePref()) === 'dark' ? 'light' : 'dark')
    theme.textContent = themeText()
  })
  const info = button('Toast', () => useApp.getState().toast('info', 'Committed a41f9c2 and pushed'))
  // Cycles through the sample git errors; each shows the fix buttons the app offers for it.
  const kinds = Object.keys(ERROR_SAMPLES)
  let next = 0
  const error = button('Error toast', () => {
    const repo = current.repos[0]?.path
    if (repo) showErrorSample(kinds[next++ % kinds.length], repo)
  })
  error.title = `Cycles through: ${kinds.join(', ')}`
  // Simulated hooks for Commit and Push; switching needs no reload.
  const hooks = document.createElement('select')
  for (const m of HOOK_MODES) hooks.append(new Option(m.name, m.id, false, m.id === hookMode()))
  hooks.title = 'What happens when you commit or push: hooks print output over a few seconds, then pass or fail'
  hooks.onchange = () => {
    setHookMode(hooks.value as HookMode)
    const url = new URL(location.href)
    if (hooks.value === 'none') url.searchParams.delete('hooks')
    else url.searchParams.set('hooks', hooks.value)
    history.replaceState(null, '', url)
  }
  // Simulated sign-in for Fetch all / Pull all; switching needs no reload.
  const signin = document.createElement('select')
  for (const m of SIGN_IN_MODES) signin.append(new Option(m.name, m.id, false, m.id === signInMode()))
  signin.title = 'Sign-in expired: Fetch all and Pull all report "Sign-in needed"; Sign in asks once per server'
  signin.onchange = () => {
    setSignInMode(signin.value as SignInMode)
    const url = new URL(location.href)
    if (signin.value === 'ok') url.searchParams.delete('signin')
    else url.searchParams.set('signin', signin.value)
    history.replaceState(null, '', url)
  }
  const hide = button('Hide toolbar', () => bar.remove())
  hide.title = 'Reload to bring it back, or use ?chrome=0 to start without it'

  // Closed it is one small button in the corner, so it never covers the app's own controls.
  const controls = document.createElement('div')
  controls.className = 'pv-controls'
  controls.append(pick, hooks, signin, theme, info, error, hide)
  const toggle = button('Mock', () => {
    bar.classList.toggle('open')
    toggle.textContent = bar.classList.contains('open') ? 'Mock ▾' : 'Mock'
  })
  toggle.className = 'pv-toggle'
  toggle.title = 'Mock scenario, hooks, theme and sample toasts'

  bar.append(controls, toggle)
  document.body.append(bar)
}
