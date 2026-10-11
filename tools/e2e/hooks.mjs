// End-to-end check against the real app: Git hooks that reject. A failing pre-commit hook and a
// failing pre-push hook must show the hook's own message, keep the typed commit message, leave
// the repo usable (not stuck busy), and a passing retry must work afterwards.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/hooks.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9359
const UI_PORT = 5323
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-hooks-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const remote = join(ROOT, 'remote.git')
mkdirSync(repos)
git(ROOT, 'init', '-q', '--bare', '-b', 'main', remote)
git(repos, 'clone', '-q', remote, 'hooked')
const dir = join(repos, 'hooked')
git(dir, 'checkout', '-q', '-b', 'main')
writeFileSync(join(dir, 'a.txt'), 'base\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')
git(dir, 'push', '-q', '-u', 'origin', 'main')

const preCommit = join(dir, '.git', 'hooks', 'pre-commit')
const prePush = join(dir, '.git', 'hooks', 'pre-push')
writeFileSync(preCommit, '#!/bin/sh\necho "LINT FAILED: trailing whitespace in a.txt" >&2\nexit 1\n')
writeFileSync(prePush, '#!/bin/sh\necho "PUSH BLOCKED: tests are red" >&2\nexit 1\n')
writeFileSync(join(dir, 'a.txt'), 'base\nchange\n')
git(dir, 'add', '.')

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`)
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
  const toastText = () => E(`[...document.querySelectorAll('.toast.error')].map((t) => e.text(t)).join(' || ')`)

  await E(`e.openRepo('hooked')`)
  await W(`!!document.querySelector('.commit-box textarea')`, 'commit box')
  await app.evaluate(`(() => { const t = document.querySelector('.commit-box textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Carefully written message'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await W(`!!e.button('Commit') && !e.button('Commit').disabled`, 'Commit enabled')

  // ---- a pre-commit hook that rejects ----
  await E(`e.clearToasts()`)
  await E(`e.click('Commit')`)
  await W(`!!document.querySelector('.toast.error')`, 'error toast', 30000)
  let t = await toastText()
  // The hook's own words may be behind "details".
  await E(`(() => { const b = [...document.querySelectorAll('.toast.error button')].find((x) => /details/i.test(x.textContent)); b?.click(); return true })()`)
  await sleep(300)
  t = await toastText()
  await app.screenshot(join(SHOTS, 'hook-rejected.png'))
  check('a rejecting pre-commit hook is reported as an error', t.length > 0, t)
  check("the hook's own message is shown (so you know what to fix)", /LINT FAILED/.test(t), t)
  check('your typed commit message is still in the box', (await E(`document.querySelector('.commit-box textarea').value`)) === 'Carefully written message')
  check('no commit was made', git(dir, 'log', '--oneline').trim().split('\n').length === 1)
  check('the file is still staged', git(dir, 'diff', '--cached', '--name-only').trim() === 'a.txt')
  check('the repo is not stuck busy', await E(`!document.querySelector('.pill.busy') && !e.button('Commit').disabled`))
  check('there is no index.lock left behind', !existsSync(join(dir, '.git', 'index.lock')))

  // ---- fix the hook, retry ----
  rmSync(preCommit)
  await E(`e.clearToasts()`)
  await E(`e.click('Commit')`)
  await W(`[...document.querySelectorAll('.toast')].some((x) => /Committed/.test(x.textContent))`, 'committed after the hook passes', 30000)
  check('the retry commits with the same message', git(dir, 'log', '-1', '--format=%s').trim() === 'Carefully written message')

  // ---- a pre-push hook that rejects ----
  await E(`e.clearToasts()`)
  await W(`!!e.button('Push') && !e.button('Push').disabled`, 'Push enabled')
  await E(`e.click('Push')`)
  await W(`!!document.querySelector('.toast.error')`, 'push error toast', 60000)
  await E(`(() => { const b = [...document.querySelectorAll('.toast.error button')].find((x) => /details/i.test(x.textContent)); b?.click(); return true })()`)
  await sleep(300)
  t = await toastText()
  await app.screenshot(join(SHOTS, 'push-rejected.png'))
  check("a rejecting pre-push hook shows the hook's message", /PUSH BLOCKED/.test(t), t)
  git(dir, 'fetch', '-q')
  check('nothing was pushed', git(dir, 'rev-list', '--count', 'origin/main..HEAD').trim() === '1')
  check('Push is usable again afterwards', await E(`!!e.button('Push') && !e.button('Push').disabled`))
  rmSync(prePush)
  await E(`e.clearToasts()`)
  await E(`e.click('Push')`)
  await W(`[...document.querySelectorAll('.toast')].some((x) => /Pushed/.test(x.textContent))`, 'pushed after the hook passes', 60000)
  git(dir, 'fetch', '-q')
  check('the retry pushes', git(dir, 'rev-list', '--count', 'origin/main..HEAD').trim() === '0')
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
