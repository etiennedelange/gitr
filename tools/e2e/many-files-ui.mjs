// End-to-end check against the real app: thousands of changed files in the UI. The window must
// stay responsive (list renders, selecting and keyboard navigation answer quickly, Stage all works).
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/many-files-ui.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const FILES = Number(process.env.FILES ?? 6000)
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9360
const UI_PORT = 5324
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-many-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const dir = join(repos, 'big')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
writeFileSync(join(dir, 'a.txt'), 'base\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')
for (let i = 0; i < FILES; i++) {
  const d = join(dir, 'modules', `pkg${i % 120}`)
  if (i < 120) mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `file${i}.js`), `module.exports = ${i}\n`)
}

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

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
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${UI_PORT}/`)).ok) break
    } catch {}
    await sleep(500)
  }
  child = spawn(APP, [], {
    env: { ...process.env, APPDATA: appdata, GITR_E2E_DEVTOOLS_PORT: String(PORT),
      GITR_E2E_DEV_URL: `http://localhost:${UI_PORT}/`, WEBVIEW2_USER_DATA_FOLDER: join(ROOT, 'webview2') },
    stdio: 'ignore',
  })
  app = await connect(PORT)
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 1`, 'repo in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)

  const t0 = Date.now()
  await E(`e.openRepo('big')`)
  await W(`document.querySelectorAll('.file-list li').length > 0`, 'list renders', 120000)
  const renderMs = Date.now() - t0
  const rowsInDom = await E(`document.querySelectorAll('.file-list li').length`)
  const countShown = await E(`e.text(document.querySelector('.section-title .count'))`)
  check(`opening a ${FILES}-file repo shows the list within 30s`, renderMs < 30000, `${renderMs} ms, ${rowsInDom} rows in the DOM, count ${countShown}`)
  check('the count shows every file', Number(countShown) === FILES + 0 || Number(countShown) >= FILES, countShown)

  // Responsiveness: a click must be answered (diff pane updates) quickly, and the page main thread isn't blocked.
  const ping = await E(`new Promise((r) => { const s = performance.now(); setTimeout(() => r(performance.now() - s), 0) })`)
  check('the page main thread is not blocked after render (timer fires within 500ms)', ping < 500, `${Math.round(ping)} ms`)
  const t1 = Date.now()
  await E(`document.querySelector('.file-list li').click()`)
  await W(`!!document.querySelector('.diff-head')`, 'diff pane', 30000)
  check('selecting a file answers within 5s', Date.now() - t1 < 5000, `${Date.now() - t1} ms`)

  // Keyboard navigation through the list.
  const t2 = Date.now()
  await E(`(() => { const ul = document.querySelector('.file-list'); ul.focus(); for (let i = 0; i < 30; i++) ul.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true })()`)
  await sleep(300)
  const frame = await E(`new Promise((r) => requestAnimationFrame(() => r(performance.now())))`)
  check('30 arrow-key presses are handled promptly', Date.now() - t2 < 5000, `${Date.now() - t2} ms`)
  await app.screenshot(join(SHOTS, 'many-files.png'))

  // Stage all moves every file to Staged without freezing or losing any.
  const t3 = Date.now()
  await E(`e.click('Stage all')`)
  await W(`document.querySelectorAll('.file-section.unstaged .file-list li').length === 0`, 'unstaged empties', 300000)
  const stageMs = Date.now() - t3
  const staged = git(dir, 'diff', '--cached', '--name-only').trim().split('\n').length
  check(`Stage all stages all ${FILES} files`, staged === FILES, `${staged} staged in ${stageMs} ms`)
  const ping2 = await E(`new Promise((r) => { const s = performance.now(); setTimeout(() => r(performance.now() - s), 0) })`)
  check('the UI is responsive after staging everything', ping2 < 500, `${Math.round(ping2)} ms`)
  const t4 = Date.now()
  await E(`e.click('Unstage all')`)
  await W(`document.querySelectorAll('.file-section.staged .file-list li').length === 0`, 'staged empties', 300000)
  check('Unstage all returns every file', git(dir, 'diff', '--cached', '--name-only').trim() === '', `${Date.now() - t4} ms`)
} catch (e) {
  check('scenario ran to the end', false, e.message)
  if (app) await app.screenshot(join(SHOTS, 'failure.png')).catch(() => {})
} finally {
  app?.close()
  for (const pid of [child?.pid, vite.pid]) {
    if (!pid) continue
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    } catch {}
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
