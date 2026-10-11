// End-to-end check against the real app: a merge conflict made in a terminal. The conflicted file is
// listed and its diff renders, Continue stays disabled until it is resolved and staged, the other
// buttons that would make things worse are disabled, and Continue then finishes the merge.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/conflict-states.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, answerDialog, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9357
const UI_PORT = 5321
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-conflict-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
  GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const dir = join(repos, 'clash')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
writeFileSync(join(dir, 'shared.txt'), 'line 1\nline 2\nline 3\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')
git(dir, 'checkout', '-q', '-b', 'side')
writeFileSync(join(dir, 'shared.txt'), 'line 1\nline 2 SIDE\nline 3\n')
git(dir, 'commit', '-q', '-am', 'side edit')
git(dir, 'checkout', '-q', 'main')
writeFileSync(join(dir, 'shared.txt'), 'line 1\nline 2 MAIN\nline 3\n')
git(dir, 'commit', '-q', '-am', 'main edit')
try {
  git(dir, 'merge', 'side')
} catch {
  // exits 1 on conflict: that is the state under test
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

  await E(`e.openRepo('clash')`)
  await W(`!!document.querySelector('.banner.operation')`, 'merge banner')
  const banner = await E(`e.text(document.querySelector('.banner.operation'))`)
  check('the merge banner says a merge is in progress with 1 conflicted file', /Merge in progress/.test(banner) && /1 conflicted file/.test(banner), banner)
  check('Continue is disabled while a file is conflicted', await E(`e.button('Continue').disabled`))
  check('Pull is disabled during the merge', await E(`e.button('Pull').disabled`))

  await W(`[...document.querySelectorAll('.file-list li .fname')].some((n) => n.textContent === 'shared.txt')`, 'conflicted file listed')
  await E(`[...document.querySelectorAll('.file-list li')].find((l) => l.querySelector('.fname')?.textContent === 'shared.txt').click()`)
  await sleep(900)
  const diff = await E(`document.querySelector('.diff-body')?.innerText ?? ''`)
  check('the conflicted file has a readable diff (markers or both sides visible)', /MAIN/.test(diff) && /SIDE/.test(diff), diff.slice(0, 160))
  await app.screenshot(join(SHOTS, 'conflicted.png'))

  // Resolve in the editor (here: on disk), stage it, then Continue is allowed.
  writeFileSync(join(dir, 'shared.txt'), 'line 1\nline 2 RESOLVED\nline 3\n')
  await W(`!!e.button('Stage all') || !!document.querySelector('.file-list li .row-actions button[title="Stage"]')`, 'stage control available')
  await E(`(() => { const li = [...document.querySelectorAll('.file-list li')].find((l) => l.querySelector('.fname')?.textContent === 'shared.txt'); li.click(); li.querySelector('button[title="Stage"]').click(); return true })()`)
  await W(`!e.button('Continue').disabled`, 'Continue enabled once nothing is conflicted', 20000)
  check('staging the resolved file enables Continue', true)
  await E(`e.click('Continue')`)
  await W(`!document.querySelector('.banner.operation')`, 'banner gone', 30000)
  check('Continue finishes the merge', git(dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length === 3)
  check('the resolved content is what was committed', git(dir, 'show', 'HEAD:shared.txt').includes('RESOLVED'))
  check('nothing is left modified or staged', git(dir, 'status', '--porcelain').trim() === '')
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
