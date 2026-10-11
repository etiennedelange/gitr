// End-to-end check of pulling a diverged branch against the real app: real backend, real git,
// real UI, real native dialogs (answered through Windows UI Automation, see dialog.ps1).
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/diverged-pull.mjs
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, answerDialog, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9347
// Our own UI dev server (port 5173 may be another checkout's, e.g. a worktree).
const UI_PORT = 5291
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-diverged-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
  GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
const write = (p, s) => writeFileSync(p, s)
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

// ---------- scenario repos ----------
const repos = join(ROOT, 'repos')
const remotes = join(ROOT, 'remotes')
mkdirSync(repos)
mkdirSync(remotes)

/** `name`: a clone whose remote got a commit from someone else while it committed locally. */
function diverged(name, { conflict = false, config = [] } = {}) {
  const remote = join(remotes, `${name}.git`)
  git(remotes, 'init', '-q', '--bare', '-b', 'main', remote)
  const dir = join(repos, name)
  git(repos, 'clone', '-q', remote, name)
  git(dir, 'checkout', '-q', '-b', 'main')
  for (const [k, v] of config) git(dir, 'config', k, v)
  write(join(dir, 'shared.txt'), 'line 1\nline 2\nline 3\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  const other = join(ROOT, `other-${name}`)
  git(ROOT, 'clone', '-q', remote, `other-${name}`)
  if (conflict) write(join(other, 'shared.txt'), 'line 1\nline 2 THEIRS\nline 3\n')
  else write(join(other, 'theirs.txt'), 'theirs\n')
  git(other, 'add', '.')
  git(other, 'commit', '-q', '-m', 'their commit')
  git(other, 'push', '-q')
  if (conflict) write(join(dir, 'shared.txt'), 'line 1\nline 2 MINE\nline 3\n')
  else write(join(dir, 'mine.txt'), 'mine\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'my commit')
  return { dir, remote }
}

const pushRepo = diverged('pushme')
const mergeRepo = diverged('mergeme', { config: [['pull.rebase', 'false']] })
const conflictRepo = diverged('conflict', { conflict: true })
const abortRepo = diverged('abortme', { conflict: true })
write(join(abortRepo.dir, 'notes.txt'), 'uncommitted notes\n')
git(abortRepo.dir, 'add', 'notes.txt')
const abortHead = git(abortRepo.dir, 'rev-parse', 'HEAD').trim()

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

// ---------- run ----------
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
}

const vite = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'vp', 'dev', '--port', String(UI_PORT), '--strictPort'], {
  cwd: join(REPO_ROOT, 'ui'),
  stdio: 'ignore',
  shell: process.platform === 'win32',
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
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 4`, 'repos in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  check('app runs the UI from this checkout', (await app.evaluate('location.port')) === String(UI_PORT))
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const lastInfo = () => W(`e.toast() && e.text(e.toast())`, 'toast')
  const clearToasts = () => E(`e.clearToasts()`)

  // ===== A: rejected push → Rebase & push (facts 6, 7, 10, 3) =====
  await E(`e.openRepo('pushme')`)
  await W(`!!e.button('Push') && !e.button('Push').disabled`, 'Push enabled')
  await E(`e.click('Push')`)
  const nonff = await W(`e.toast('error') && e.text(e.toast('error'))`, 'rejected push toast')
  check('rejected push: new message', nonff.includes('Your branch and the remote have both moved on. Rebase or merge, then push.'), nonff)
  await W(`!!e.button('Rebase & push', e.toast('error'))`, 'Rebase & push')
  check('rejected push: toast offers Rebase & push (6)', true)
  await app.screenshot(join(SHOTS, 'a1-toast.png'))
  await E(`e.click('Rebase & push', e.toast('error'))`)
  const q = await answerDialog({ title: 'Rebase onto origin/main', button: 'Rebase', buttonId: 1 })
  check('confirmation states the counts (10)', q.includes('Your branch and origin/main have diverged: 1 local commit, 1 on the remote. Rebase your commit onto origin/main? Then push.'), q)
  const done = await W(`e.toast('info') && e.text(e.toast('info'))`, 'result toast', 30000)
  check('rebased and pushed, and says so (7)', done.startsWith('Rebased onto origin/main and pushed'), done)
  git(pushRepo.dir, 'fetch', '-q')
  const ab = git(pushRepo.dir, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').trim()
  check('remote now has both commits; branch neither ahead nor behind (3, 7)', ab === '0\t0', ab)
  const parents = git(pushRepo.dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length - 1
  check('rebase made no merge commit (3)', parents === 1)
  await clearToasts()

  // ===== B: repo view Pull with pull.rebase=false → merge (facts 1, 4, 8) =====
  await E(`e.openRepo('mergeme')`)
  await W(`!!e.button('Pull') && !e.button('Pull').disabled`, 'Pull enabled')
  await E(`e.click('Pull')`)
  const mq = await answerDialog({ title: 'Merge origin/main', button: 'Merge', buttonId: 1 })
  check('pull.rebase=false → asks to merge (1, 10)', mq.includes('Merge origin/main into main?') && !mq.includes('Then push'), mq)
  const merged = await W(`e.toast('info') && e.text(e.toast('info'))`, 'merge result', 30000)
  check('merged, not pushed (8)', merged.startsWith('Merged origin/main') && !merged.includes('pushed'), merged)
  const mParents = git(mergeRepo.dir, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length - 1
  check('merge commit with two parents (4)', mParents === 2)
  check('nothing pushed from the repo view (8)', git(mergeRepo.dir, 'rev-list', '--count', '@{u}..HEAD').trim() === '2')
  await clearToasts()

  // ===== C: conflict → banner → resolve → stage → Continue (facts 11, 12) =====
  await E(`e.openRepo('conflict')`)
  await W(`!!e.button('Pull') && !e.button('Pull').disabled`, 'Pull enabled')
  await E(`e.click('Pull')`)
  await answerDialog({ title: 'Rebase onto origin/main', button: 'Rebase', buttonId: 1 })
  const stopped = await W(`e.toast('error') && e.text(e.toast('error'))`, 'conflict toast', 30000)
  check('stops on conflicts and says so (11)', stopped.includes('Stopped on conflicts in 1 file'), stopped)
  const banner = await W(`document.querySelector('.banner.operation') && e.text(document.querySelector('.banner.operation'))`, 'rebase banner')
  check('rebase banner shown (11)', banner.includes('Rebase in progress') && banner.includes('1 conflicted file'), banner)
  check('Continue disabled while conflicted (12)', await E(`e.button('Continue').disabled`))
  await app.screenshot(join(SHOTS, 'c1-conflict.png'))
  write(join(conflictRepo.dir, 'shared.txt'), 'line 1\nline 2 RESOLVED\nline 3\n')
  // Stage the resolved file in the UI (git marks it resolved).
  await W(`!!e.button('Stage all')`, 'Stage all')
  await E(`e.click('Stage all')`)
  await W(`!e.button('Continue').disabled`, 'Continue enabled', 20000)
  check('Continue enabled once nothing is conflicted (12)', true)
  await E(`e.click('Continue')`)
  const fin = await W(`e.toast('info') && e.text(e.toast('info'))`, 'continue result', 30000)
  check('Continue finishes the rebase without an editor (12)', fin.startsWith('Rebase finished'), fin)
  await W(`!document.querySelector('.banner.operation')`, 'banner gone')
  check('banner gone, file resolved', read(join(conflictRepo.dir, 'shared.txt')) === 'line 1\nline 2 RESOLVED\nline 3\n')
  await clearToasts()

  // ===== D: conflict with uncommitted changes → Abort restores everything (fact 14) =====
  await E(`e.openRepo('abortme')`)
  await W(`!!e.button('Pull') && !e.button('Pull').disabled`, 'Pull enabled')
  await E(`e.click('Pull')`)
  await answerDialog({ title: 'Rebase onto origin/main', button: 'Rebase', buttonId: 1 })
  await W(`!!document.querySelector('.banner.operation')`, 'banner')
  await W(`!!e.button('Abort') && !e.button('Abort').disabled`, 'Abort enabled')
  await E(`e.click('Abort')`)
  await answerDialog({ title: 'Abort rebase', button: 'Yes' })
  await W(`!document.querySelector('.banner.operation')`, 'banner gone after abort', 20000)
  check('Abort: branch back where it was (14)', git(abortRepo.dir, 'rev-parse', 'HEAD').trim() === abortHead)
  check('Abort: uncommitted change restored (5, 14)', read(join(abortRepo.dir, 'notes.txt')) === 'uncommitted notes\n')
  check('Abort: nothing left in the stash list (5)', git(abortRepo.dir, 'stash', 'list').trim() === '')
  await app.screenshot(join(SHOTS, 'd1-after-abort.png'))
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
