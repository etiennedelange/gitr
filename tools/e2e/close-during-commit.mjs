// End-to-end check against the real app: closing the window while a commit is running must not
// kill git halfway. The close waits for the commit, then the app exits with a clean repository.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/close-during-commit.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9348
const UI_PORT = 5292
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-close-'))
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const dir = join(repos, 'slow')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
writeFileSync(join(dir, 'a.txt'), 'one\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')
// A pre-commit hook that takes a while, so the commit is still running when the window is closed.
writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 6\nexit 0\n')
writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
git(dir, 'add', '.')

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).slice(0, 160)}` : ''}`)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

  await E(`e.openRepo('slow')`)
  await W(`!!document.querySelector('.commit-box textarea')`, 'commit box')
  await app.evaluate(`(() => { const t = document.querySelector('.commit-box textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'slow commit'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await W(`!!e.button('Commit') && !e.button('Commit').disabled`, 'Commit enabled')
  await E(`e.click('Commit')`)
  await sleep(1500)
  check('the commit is still running (hook is sleeping)', existsSync(join(dir, '.git', 'index.lock')) || git(dir, 'log', '--oneline').trim().split('\n').length === 1)

  // Ask the window to close, like the X button does.
  execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`])
  await sleep(2500)
  check('the app is still alive while the commit runs', alive(child.pid))

  const end = Date.now() + 30000
  while (alive(child.pid) && Date.now() < end) await sleep(300)
  check('the app exits once the commit has finished', !alive(child.pid))
  check('the commit completed', git(dir, 'log', '--format=%s', '-n', '1').trim() === 'slow commit', git(dir, 'log', '--oneline'))
  check('no index.lock left behind', !existsSync(join(dir, '.git', 'index.lock')))
  check('nothing left staged or modified', git(dir, 'status', '--porcelain').trim() === '')
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
