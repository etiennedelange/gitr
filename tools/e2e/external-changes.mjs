// End-to-end check against the real app: changes made outside Gitr show up by themselves
// (file watcher), including a commit from a terminal, and a repository that disappears while it
// is open does not leave the UI stuck.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/external-changes.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9351
const UI_PORT = 5295
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-external-'))
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
mkdirSync(repos)
const make = (name) => {
  const dir = join(repos, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'base\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}
const watched = make('watched')
const doomed = make('doomed')

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 170)}` : ''}`)
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
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 2`, 'repos in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const fileRow = (name) => `[...document.querySelectorAll('.file-list li')].find((li) => li.querySelector('.fname')?.textContent === '${name}')`

  // 1. A file edited and another created outside Gitr appear without any click.
  await E(`e.openRepo('watched')`)
  await W(`!!document.querySelector('.empty.diff-empty')`, 'clean working tree shown')
  writeFileSync(join(watched, 'a.txt'), 'base\nedited elsewhere\n')
  writeFileSync(join(watched, 'brand-new.txt'), 'x\n')
  await W(`!!${fileRow('a.txt')} && !!${fileRow('brand-new.txt')}`, 'external edits appear', 20000)
  check('external edits show up by themselves', true)

  // 2. Staging from a terminal moves the file to Staged.
  git(watched, 'add', 'a.txt')
  await W(`document.querySelectorAll('.file-section.staged .file-list li').length === 1`, 'staged elsewhere shows as staged', 20000)
  check('staging in a terminal shows up as Staged', true)

  // 3. A commit from a terminal clears the list and updates the sidebar/ahead state.
  git(watched, 'add', '.')
  git(watched, 'commit', '-q', '-m', 'from terminal')
  await W(`document.querySelectorAll('.file-list li').length === 0`, 'list empties after outside commit', 20000)
  check('a commit made in a terminal empties the lists', true)
  await W(`!!e.button('Undo last commit')`, 'Undo offered for the outside commit', 20000)
  check('and Undo last commit becomes available for it', true)

  // 4. Switching branch in a terminal updates the header.
  git(watched, 'checkout', '-q', '-b', 'terminal-branch')
  await W(`document.querySelector('.branch-name')?.textContent === 'terminal-branch'`, 'branch name follows', 20000)
  check('a branch switch in a terminal updates the header', true)

  // 5. The open repo is deleted from disk: the UI must not stay stuck on it.
  await E(`e.openRepo('doomed')`)
  await W(`document.querySelector('.repo-head h1')?.textContent === 'doomed'`, 'doomed open')
  // Retry for a moment: a status that was already running may still hold the folder.
  let attempts = 0
  for (; attempts < 20; attempts++) {
    try {
      rmSync(doomed, { recursive: true, force: true })
      break
    } catch (e) {
      if (attempts === 19) throw e
      await sleep(500)
    }
  }
  console.log(`(deleted after ${attempts + 1} attempt(s))`)
  await sleep(2500)
  await app.evaluate(`document.querySelector('.nav-item')?.click()`)
  await sleep(500)
  const alive = await E(`document.querySelector('#root').innerText.trim().length > 20`)
  check('the UI is still alive after the open repo was deleted', alive)
  await E(`e.click('Rescan')`)
  await W(`![...document.querySelectorAll('.repo-item .repo-name')].some((n) => n.textContent === 'doomed')`, 'doomed leaves the sidebar after Rescan', 20000)
  check('Rescan drops the deleted repository', true)
} catch (e) {
  check('scenario ran to the end', false, e.message)
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
console.log(`\n${results.length - failed.length}/${results.length} passed.`)
process.exit(failed.length ? 1 : 0)
