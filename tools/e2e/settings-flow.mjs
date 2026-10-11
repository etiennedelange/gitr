// End-to-end check against the real app: Settings. Editing marks them unsaved, Revert discards,
// Save writes config.toml and survives a restart, bad numbers are clamped, Escape keeps the draft.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/settings-flow.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9356
const UI_PORT = 5320
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-settings-'))
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const dir = join(repos, 'one')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
writeFileSync(join(dir, 'a.txt'), 'x\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')

const appdata = join(ROOT, 'appdata')
const configFile = join(appdata, 'gitr', 'config.toml')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(configFile, `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)
const config = () => readFileSync(configFile, 'utf8')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`)
}

const vite = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'vp', 'dev', '--port', String(UI_PORT), '--strictPort'], {
  cwd: join(REPO_ROOT, 'ui'), stdio: 'ignore', shell: process.platform === 'win32',
})
let child
let app
const launch = async () => {
  child = spawn(APP, [], {
    env: { ...process.env, APPDATA: appdata, GITR_E2E_DEVTOOLS_PORT: String(PORT),
      GITR_E2E_DEV_URL: `http://localhost:${UI_PORT}/`, WEBVIEW2_USER_DATA_FOLDER: join(ROOT, 'webview2') },
    stdio: 'ignore',
  })
  app = await connect(PORT)
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 1`, 'repo in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
}
const kill = () => {
  app?.close()
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch {}
}
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${UI_PORT}/`)).ok) break
    } catch {}
    await sleep(500)
  }
  await launch()
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const setField = (selector, value) =>
    E(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) throw new Error('no field: ' + ${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const openSettings = async () => {
    await E(`document.querySelector('.nav-settings').click()`)
    await W(`!!document.querySelector('.settings')`, 'settings open')
  }

  await openSettings()
  check('Save and Revert start disabled (nothing changed)', await E(`e.button('Save').disabled && e.button('Revert').disabled`))

  // Edit the group name: Save enables and the sidebar flags unsaved settings after leaving.
  await setField('input[aria-label="Group name"]', 'Renamed group')
  await W(`!e.button('Save').disabled`, 'Save enabled')
  check('editing enables Save and Revert', await E(`!e.button('Save').disabled && !e.button('Revert').disabled`))
  await E(`document.querySelector('.nav-item').click()`) // leave to the dashboard
  await W(`!!document.querySelector('.nav-settings .unsaved')`, 'Unsaved marker')
  check('leaving with edits flags Settings as Unsaved in the sidebar', true)
  await openSettings()
  check('the unsaved edit is still there when you come back', (await E(`document.querySelector('input[aria-label="Group name"]').value`)) === 'Renamed group')

  // Revert discards.
  await E(`e.click('Revert')`)
  await W(`document.querySelector('input[aria-label="Group name"]').value === 'E2E'`, 'reverted')
  check('Revert restores the saved value', true)
  check('config.toml was not touched by Revert', config().includes('name = "E2E"'))

  // Bad numbers are clamped, not saved raw.
  await setField('.settings-body section#settings-discovery input[type=number]', '99')
  await E(`document.activeElement?.blur(); document.querySelector('#settings-discovery input[type=number]').dispatchEvent(new Event('blur', { bubbles: true })); true`)
  await sleep(300)

  // Save a real change.
  await setField('input[aria-label="Group name"]', 'Saved group')
  await E(`e.click('Save')`)
  await W(`[...document.querySelectorAll('.toast')].some((t) => /Settings saved/.test(t.textContent))`, 'saved toast', 20000)
  check('Save writes the new name to config.toml', config().includes('name = "Saved group"'), config().split('\n').slice(0, 8).join(' | '))
  check('Save leaves no "Unsaved" marker', !(await E(`!!document.querySelector('.nav-settings .unsaved')`)))
  const depth = config().match(/scanDepth = (\d+)/)?.[1]
  check('an out-of-range scan depth was clamped before saving (max 8)', depth === undefined || Number(depth) <= 8, `scanDepth=${depth}`)

  // Escape closes Settings, and the app keeps working.
  await E(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)
  check('Escape leaves Settings', !(await E(`!!document.querySelector('.settings')`)))

  // Survives a restart.
  kill()
  await sleep(1500)
  await launch()
  const E2 = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  await E2(`document.querySelector('.nav-settings').click()`)
  await app.waitFor(`!!document.querySelector('input[aria-label="Group name"]')`, 'settings after restart')
  check('the saved name survives a restart', (await E2(`document.querySelector('input[aria-label="Group name"]').value`)) === 'Saved group')
  check('the repo is still found after the restart', await E2(`!![...document.querySelectorAll('.repo-item .repo-name')].find((n) => n.textContent === 'one')`))
} catch (e) {
  check('scenario ran to the end', false, e.message)
} finally {
  kill()
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(vite.pid)], { stdio: 'ignore' })
  } catch {}
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed.`)
process.exit(failed.length ? 1 : 0)
