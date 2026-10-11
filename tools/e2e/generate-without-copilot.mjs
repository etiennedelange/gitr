// End-to-end check against the real app: "Generate" with no Copilot CLI installed shows a clear
// error, keeps the commit message you had typed, and nothing is sent anywhere (the app runs with a
// PATH that has no copilot on it).
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/generate-without-copilot.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9354
const UI_PORT = 5298
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-generate-'))
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const dir = join(repos, 'gen')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
writeFileSync(join(dir, 'a.txt'), 'base\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')
writeFileSync(join(dir, 'a.txt'), 'base\nchange\n')
git(dir, 'add', '.')

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
  // No copilot anywhere on PATH, and no override: the generator cannot start a CLI.
  const env = { ...process.env, APPDATA: appdata, GITR_E2E_DEVTOOLS_PORT: String(PORT),
    GITR_E2E_DEV_URL: `http://localhost:${UI_PORT}/`, WEBVIEW2_USER_DATA_FOLDER: join(ROOT, 'webview2'),
    PATH: 'C:\Windows\System32;C:\Windows;C:\Program Files\Git\cmd' }
  delete env.COPILOT_CLI_PATH
  child = spawn(APP, [], { env, stdio: 'ignore' })
  app = await connect(PORT)
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 1`, 'repo in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)

  await E(`e.openRepo('gen')`)
  await W(`!!document.querySelector('.commit-box textarea')`, 'commit box')
  await app.evaluate(`(() => { const t = document.querySelector('.commit-box textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'My handwritten draft'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await W(`!!e.button('Generate') && !e.button('Generate').disabled`, 'Generate enabled')
  await E(`e.click('Generate')`)
  await W(`!!document.querySelector('.commit-box .banner.error')`, 'an error is shown', 30000)
  const msg = await E(`e.text(document.querySelector('.commit-box .banner.error'))`)
  check('the error says Copilot could not be found, in plain words', /copilot/i.test(msg) && /(not found|install|could not|couldn't)/i.test(msg), msg)
  check('the handwritten draft is still in the box', (await E(`document.querySelector('.commit-box textarea').value`)) === 'My handwritten draft')
  check('Generate is usable again (not stuck on Stop)', await E(`e.button('Generate') && !e.button('Generate').disabled`))
  check('the box is editable again', !(await E(`document.querySelector('.commit-box textarea').readOnly`)))
  check('committing the draft still works', await (async () => {
    await W(`!!e.button('Commit') && !e.button('Commit').disabled`, 'Commit enabled')
    await E(`e.click('Commit')`)
    await W(`[...document.querySelectorAll('.toast')].some((t) => /Committed/.test(t.textContent))`, 'committed', 20000)
    return git(dir, 'log', '-1', '--format=%s').trim() === 'My handwritten draft'
  })())
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
