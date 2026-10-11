// End-to-end check against the real app: repositories that are not the usual shape. A brand-new
// repo with no commits (first commit and undoing it), a detached HEAD, a linked worktree whose
// .git is a file, and a repo with a submodule.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/unusual-repos.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9358
const UI_PORT = 5322
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-unusual-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
mkdirSync(repos)
const repo = (name, commit = true) => {
  const dir = join(repos, name)
  mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  if (commit) {
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'base')
    writeFileSync(join(dir, 'b.txt'), 'second\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'second')
  }
  return dir
}

// 1. A repo with no commits at all, with one file waiting.
const unborn = repo('unborn', false)
writeFileSync(join(unborn, 'first.txt'), 'hello\n')

// 2. A detached HEAD with a local change.
const detached = repo('detached')
git(detached, 'checkout', '-q', '--detach', 'HEAD~1')
writeFileSync(join(detached, 'a.txt'), 'base\nedited while detached\n')

// 3. A linked worktree: its .git is a file pointing elsewhere.
const mainTree = repo('maintree')
const linked = join(repos, 'linked-worktree')
git(mainTree, 'worktree', 'add', '-q', '-b', 'wt-branch', linked)
writeFileSync(join(linked, 'wt.txt'), 'worktree file\n')

// 4. A repo with a submodule.
const subSource = join(ROOT, 'sub-source')
mkdirSync(subSource)
git(subSource, 'init', '-q', '-b', 'main')
writeFileSync(join(subSource, 's.txt'), 'sub\n')
git(subSource, 'add', '.')
git(subSource, 'commit', '-q', '-m', 'sub base')
const withSub = repo('withsub')
git(withSub, 'submodule', 'add', '-q', subSource, 'vendor/lib')
git(withSub, 'commit', '-q', '-m', 'add submodule')
writeFileSync(join(withSub, 'vendor', 'lib', 's.txt'), 'sub changed inside\n')
writeFileSync(join(withSub, 'top.txt'), 'top level\n')

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = true\nscanDepth = 4\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : ''}`)
}
const setMessage = (app, value) =>
  app.evaluate(`(() => { const t = document.querySelector('.commit-box textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(value)}); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)

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
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 4`, 'all four repos in sidebar', 40000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const rows = () => E(`[...document.querySelectorAll('.file-list li .fname')].map((n) => n.textContent)`)
  const sidebar = await E(`[...document.querySelectorAll('.repo-item .repo-name')].map((n) => n.textContent)`)
  console.log('sidebar:', JSON.stringify(sidebar))
  for (const n of ['unborn', 'detached', 'maintree', 'linked-worktree', 'withsub']) check(`"${n}" is discovered`, sidebar.includes(n))

  // ---- 1. unborn ----
  await E(`e.openRepo('unborn')`)
  await W(`[...document.querySelectorAll('.file-list li .fname')].some((n) => n.textContent === 'first.txt')`, 'first.txt listed', 20000)
  const head = await E(`document.querySelector('.branch-name')?.textContent`)
  check('an unborn repo shows its branch name, not an error', head === 'main', head)
  check('Undo last commit is not offered when there is no commit', !(await E(`!!e.button('Undo last commit')`)))
  await E(`e.click('Stage all')`)
  await W(`document.querySelectorAll('.file-section.staged .file-list li').length === 1`, 'staged')
  await setMessage(app, 'First commit')
  await W(`!!e.button('Commit') && !e.button('Commit').disabled`, 'Commit enabled')
  await E(`e.clearToasts()`)
  await E(`e.click('Commit')`)
  await W(`[...document.querySelectorAll('.toast')].some((t) => /Committed/.test(t.textContent))`, 'committed', 20000)
  check('the very first commit works', git(unborn, 'log', '-1', '--format=%s').trim() === 'First commit')
  await W(`!!e.button('Undo last commit') && !e.button('Undo last commit').disabled`, 'Undo offered for the first commit', 20000)
  await E(`e.click('Undo last commit')`)
  await W(`document.querySelector('.commit-box textarea').value === 'First commit'`, 'message restored', 20000)
  check('undoing the very first commit leaves the file staged', git(unborn, 'diff', '--cached', '--name-only').trim() === 'first.txt')
  check('the unborn branch really has no commit again', (() => { try { git(unborn, 'rev-parse', '--verify', 'HEAD'); return false } catch { return true } })())
  await E(`document.querySelector('#tab-branches').click()`)
  await sleep(600)
  check('the Branches tab does not break on an unborn repo', await E(`!!document.querySelector('.branches') && !document.querySelector('.banner.error')`))
  await E(`document.querySelector('#tab-changes').click()`)

  // ---- 2. detached ----
  await E(`e.openRepo('detached')`)
  await W(`document.querySelector('.branch-name')?.textContent === '(detached)'`, 'detached shown', 20000)
  check('a detached HEAD is labelled (detached)', true)
  check('Push is disabled while detached', await E(`e.button('Push').disabled`))
  await W(`[...document.querySelectorAll('.file-list li .fname')].some((n) => n.textContent === 'a.txt')`, 'a.txt listed')
  await E(`e.click('Stage all')`)
  await W(`document.querySelectorAll('.file-section.staged .file-list li').length === 1`, 'staged')
  await setMessage(app, 'Commit while detached')
  await E(`e.clearToasts()`)
  await E(`e.click('Commit')`)
  await W(`[...document.querySelectorAll('.toast')].some((t) => /Committed/.test(t.textContent))`, 'committed', 20000)
  check('committing on a detached HEAD works', git(detached, 'log', '-1', '--format=%s').trim() === 'Commit while detached')

  // ---- 3. linked worktree ----
  await E(`e.openRepo('linked-worktree')`)
  await W(`[...document.querySelectorAll('.file-list li .fname')].some((n) => n.textContent === 'wt.txt')`, 'worktree file listed', 20000)
  check('a linked worktree shows its own branch', (await E(`document.querySelector('.branch-name')?.textContent`)) === 'wt-branch')
  await E(`e.click('Stage all')`)
  await W(`document.querySelectorAll('.file-section.staged .file-list li').length === 1`, 'staged in worktree')
  await setMessage(app, 'From the worktree')
  await E(`e.clearToasts()`)
  await E(`e.click('Commit')`)
  await W(`[...document.querySelectorAll('.toast')].some((t) => /Committed/.test(t.textContent))`, 'committed', 20000)
  check('committing from a linked worktree lands on its branch', git(linked, 'log', '-1', '--format=%s').trim() === 'From the worktree' && git(mainTree, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main')

  // ---- 4. submodule ----
  await E(`e.openRepo('withsub')`)
  await W(`document.querySelectorAll('.file-list li').length >= 1`, 'files listed', 20000)
  const subRows = await rows()
  console.log('submodule repo rows:', JSON.stringify(subRows))
  check('the submodule with changes and the top-level file are both listed', subRows.includes('top.txt') && subRows.some((n) => /lib/.test(n)), subRows.join(', '))
  await E(`[...document.querySelectorAll('.file-list li')].find((l) => /lib/.test(l.querySelector('.fname')?.textContent))?.click()`)
  await sleep(900)
  check('selecting the submodule does not break the diff pane', await E(`!!document.querySelector('.diff') && !document.querySelector('.diff .banner.error')`))
  await app.screenshot(join(SHOTS, 'submodule.png'))
  // Discard must never delete a submodule folder.
  await E(`e.click('Discard all')`)
  await import('./cdp.mjs').then(({ answerDialog }) => answerDialog({ title: 'Discard changes', button: 'Keep changes', buttonId: 2 }))
  await sleep(800)
  check('cancelling Discard all leaves everything (including the submodule) in place', git(withSub, 'status', '--porcelain').trim().length > 0)
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
