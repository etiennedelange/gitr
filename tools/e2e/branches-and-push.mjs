// End-to-end check against the real app: branches (create, checkout, delete, force-delete of an
// unmerged branch), Commit & Push to a remote, and the warning when amending a pushed commit.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/branches-and-push.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, answerDialog, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9350
const UI_PORT = 5294
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-branches-'))
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
git(repos, 'clone', '-q', remote, 'proj')
const dir = join(repos, 'proj')
git(dir, 'checkout', '-q', '-b', 'main')
writeFileSync(join(dir, 'a.txt'), 'base\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')
git(dir, 'push', '-q', '-u', 'origin', 'main')
// An unmerged local branch (one commit main does not have), to exercise the force-delete question.
git(dir, 'checkout', '-q', '-b', 'unmerged')
writeFileSync(join(dir, 'u.txt'), 'only here\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'unmerged work')
git(dir, 'checkout', '-q', 'main')
git(dir, 'branch', 'merged-already')
const branchList = () => git(dir, 'branch', '--format=%(refname:short)').trim().split(/\s+/)

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
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 1`, 'repo in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const branchRow = (name) => `[...document.querySelectorAll('.branch-list li')].find((li) => li.querySelector('.bname')?.textContent === '${name}')`
  const rowAction = (name, label) => `[...(${branchRow(name)}?.querySelectorAll('.row-actions button') ?? [])].find((b) => b.textContent.trim() === '${label}')`
  const setText = (selector, value) => `(() => { const t = document.querySelector('${selector}'); const proto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement; Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(t, ${JSON.stringify(value)}); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
  const lastToast = (kind) => W(`e.toast(${kind ? `'${kind}'` : ''}) && e.text(e.toast(${kind ? `'${kind}'` : ''}))`, 'toast')

  await E(`e.openRepo('proj')`)
  await W(`!!document.querySelector('#tab-branches')`, 'tabs')
  await E(`document.querySelector('#tab-branches').click()`)
  await W(`!!${branchRow('unmerged')} && !!${branchRow('merged-already')}`, 'branches listed')

  // 1. Create & checkout.
  await app.evaluate(setText('.inline-form input', 'feature/new-thing'))
  await E(`e.click('Create & checkout')`)
  await W(`${branchRow('feature/new-thing')}?.classList.contains('head')`, 'new branch is current', 20000)
  check('Create & checkout creates the branch and switches to it', git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'feature/new-thing')

  // 2. Checkout another branch.
  await E(`${rowAction('main', 'Checkout')}.click()`)
  await W(`${branchRow('main')}?.classList.contains('head')`, 'main is current', 20000)
  check('Checkout switches branch', git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main')

  // 3. Delete a fully merged branch: one question, then gone.
  await E(`${rowAction('merged-already', 'Delete')}.click()`)
  const q = await answerDialog({ title: 'Delete branch', button: 'Yes' })
  check('delete asks which branch', q.includes('merged-already'), q)
  await W(`!${branchRow('merged-already')}`, 'branch disappears', 20000)
  check('the merged branch is deleted', !branchList().includes('merged-already'))

  // 4. Delete an unmerged branch: asked twice, the second time warning it is not merged.
  await E(`${rowAction('unmerged', 'Delete')}.click()`)
  await answerDialog({ title: 'Delete branch', button: 'Yes' })
  const force = await answerDialog({ title: 'Force delete', button: 'No' })
  check('an unmerged branch needs a second, explicit confirmation', /not fully merged/i.test(force), force)
  await sleep(1000)
  check('answering No keeps the unmerged branch', branchList().includes('unmerged'))
  await E(`${rowAction('unmerged', 'Delete')}.click()`)
  await answerDialog({ title: 'Delete branch', button: 'Yes' })
  await answerDialog({ title: 'Force delete', button: 'Yes' })
  await W(`!${branchRow('unmerged')}`, 'unmerged branch disappears', 20000)
  check('answering Yes force-deletes it', !branchList().includes('unmerged'))

  // 5. Commit & Push to the remote.
  writeFileSync(join(dir, 'a.txt'), 'base\nsecond line\n')
  await E(`document.querySelector('#tab-changes').click()`)
  await W(`[...document.querySelectorAll('.file-list li')].some((li) => li.querySelector('.fname')?.textContent === 'a.txt')`, 'a.txt changed', 20000)
  await E(`e.click('Stage all')`)
  await W(`!!e.button('& Push') && !e.button('& Push').disabled || false`, 'staged', 20000).catch(() => {})
  await app.evaluate(setText('.commit-box textarea', 'Add a second line'))
  await W(`!!e.button('& Push') && !e.button('& Push').disabled`, '& Push enabled', 20000)
  await E(`e.click('& Push')`)
  const pushed = await W(`[...document.querySelectorAll('.toast')].map((t) => e.text(t)).find((t) => /pushed/.test(t))`, 'pushed toast', 30000)
  check('Commit & Push says it pushed', /Committed [0-9a-f]{7} and pushed/.test(pushed), pushed)
  git(dir, 'fetch', '-q')
  check('the remote has the new commit', git(dir, 'rev-parse', 'HEAD').trim() === git(dir, 'rev-parse', 'origin/main').trim())

  // 6. Amending the pushed commit asks first; declining changes nothing.
  const before = git(dir, 'rev-parse', 'HEAD').trim()
  await app.evaluate(`(() => { const c = document.querySelector('.commit-box input[type=checkbox]'); c.click(); return true })()`)
  await W(`document.querySelector('.commit-box textarea').value.includes('Add a second line')`, 'amend prefills the message', 20000)
  await app.evaluate(setText('.commit-box textarea', 'Rewritten message'))
  await W(`!!e.button('Amend') && !e.button('Amend').disabled`, 'Amend enabled', 20000)
  await E(`e.click('Amend')`)
  const warn = await answerDialog({ title: 'Amend pushed commit?', button: 'Cancel', buttonId: 2 })
  check('amending a pushed commit warns about rewriting history', /already pushed/.test(warn), warn)
  await sleep(1000)
  check('declining leaves the commit as it was', git(dir, 'rev-parse', 'HEAD').trim() === before)
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
