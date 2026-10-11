// End-to-end check against the real app: discarding changes (native confirmation, real Recycle
// Bin) and undoing the last commit.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/discard-and-undo.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, answerDialog, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9349
const UI_PORT = 5293
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-discard-'))
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const dir = join(repos, 'work')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
const read = (f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n')
writeFileSync(join(dir, 'a.txt'), 'a original\n')
writeFileSync(join(dir, 'b.txt'), 'b original\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')
writeFileSync(join(dir, 'c.txt'), 'c content\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'Add c with a body\n\nSecond paragraph.')
writeFileSync(join(dir, 'a.txt'), 'a CHANGED\n')
writeFileSync(join(dir, 'b.txt'), 'b CHANGED\n')
writeFileSync(join(dir, 'new.txt'), 'untracked\n')

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
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
  const row = (name) => `[...document.querySelectorAll('.file-list li')].find((li) => li.querySelector('.fname')?.textContent === '${name}')`
  const rowButton = (name, title) => `${row(name)}?.querySelector('button[title="${title}"]')`

  await E(`e.openRepo('work')`)
  await W(`!!${row('a.txt')} && !!${row('b.txt')} && !!${row('new.txt')}`, 'three changed files listed')

  // 1. Discard one tracked file: asks first, then restores it.
  await app.evaluate(`${rowButton('a.txt', 'Discard')}.click()`)
  const q1 = await answerDialog({ title: 'Discard changes', button: 'Discard', buttonId: 1 })
  check('discard asks first and names the file and the Recycle Bin', q1.includes('a.txt') && q1.includes('Recycle Bin'), q1)
  await W(`!${row('a.txt')}`, 'a.txt leaves the list', 20000)
  check('a tracked file is restored to its committed content', read('a.txt') === 'a original\n', read('a.txt'))

  // 2. Cancelling leaves the file alone.
  await app.evaluate(`${rowButton('b.txt', 'Discard')}.click()`)
  await answerDialog({ title: 'Discard changes', button: 'Keep changes', buttonId: 2 })
  await sleep(1500)
  check('"Keep changes" leaves the file untouched', read('b.txt') === 'b CHANGED\n' && !!(await E(`!!${row('b.txt')}`)))

  // 3. Discard all, including the untracked file.
  await E(`e.click('Discard all')`)
  await answerDialog({ title: 'Discard changes', button: 'Discard', buttonId: 1 })
  await W(`!${row('b.txt')} && !${row('new.txt')}`, 'list empties', 20000)
  check('Discard all restores the tracked file', read('b.txt') === 'b original\n')
  check('Discard all removes the untracked file', !existsSync(join(dir, 'new.txt')))
  check('the working tree is clean afterwards', git(dir, 'status', '--porcelain').trim() === '')

  // 4. Undo the last (unpushed) commit: it asks nothing, keeps the changes staged, restores the message.
  const head = git(dir, 'rev-parse', 'HEAD').trim()
  await W(`!!e.button('Undo last commit') && !e.button('Undo last commit').disabled`, 'Undo enabled')
  await E(`e.click('Undo last commit')`)
  await W(`document.querySelector('.commit-box textarea')?.value.startsWith('Add c with a body')`, 'message restored', 20000)
  check('undo restores the full message', (await E(`document.querySelector('.commit-box textarea').value`)).includes('Second paragraph.'))
  check('undo moved HEAD back one commit', git(dir, 'rev-parse', 'HEAD').trim() === git(dir, 'rev-parse', head + '~1').trim())
  check('undo keeps the commits changes staged', git(dir, 'diff', '--cached', '--name-only').trim() === 'c.txt')
  check('c.txt itself is untouched', read('c.txt') === 'c content\n')
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
