// Real Fetch, Pull and Push through the real app on ONE repository that is already in sync with its
// remote (nothing ahead, nothing behind), using your own sign-in. All three are therefore no-ops for
// content, which makes this safe: it proves the real sign-in and network path work for each button
// without moving a commit or publishing anything. It refuses to run if the repo is not in sync.
//
// Usage:  REPO="D:\path\to\repo" node tools/e2e/real-sync.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO = process.env.REPO
if (!REPO) throw new Error('set REPO to the repository to sync')
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9363
const UI_PORT = 5327
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-sync-'))
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: REPO, env: ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim()
const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim()
const [ahead, behind] = git('rev-list', '--left-right', '--count', 'HEAD...@{u}').trim().split(/\s+/).map(Number)
if (ahead !== 0 || behind !== 0) throw new Error(`refusing to run: ${branch} is ${ahead} ahead / ${behind} behind ${upstream}; it must be in sync so every action is a no-op`)

const remoteName = upstream.split('/')[0]
const remoteTip = () => git('ls-remote', remoteName, `refs/heads/${branch}`).trim() // read-only network call

const state = () => ({
  refs: git('for-each-ref', '--format=%(refname) %(objectname)').trim(),
  head: git('rev-parse', 'HEAD').trim(),
  status: sha(git('status', '--porcelain=v1', '-z', '--untracked-files=all')),
  stash: sha(git('stash', 'list')),
  remote: remoteTip(),
})
const before = state()
console.log(`repo: ${basename(REPO)}, ${branch} in sync with ${upstream} at ${before.head.slice(0, 8)}`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`)
}

const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = false\nscanDepth = 1\n\n[[groups]]\nid = "one"\nname = "one"\nroots = ['${REPO}']\n`)

const vite = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'vp', 'dev', '--port', String(UI_PORT), '--strictPort'], {
  cwd: join(REPO_ROOT, 'ui'), stdio: 'ignore', shell: process.platform === 'win32',
})
let child
let app
let logFile
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
  await E(`e.openRepo(${JSON.stringify(basename(REPO))})`)

  for (const label of ['Fetch', 'Pull', 'Push']) {
    await W(`!!e.button('${label}') && !e.button('${label}').disabled && !document.querySelector('.pill.busy')`, `${label} enabled`, 30000)
    await E(`e.clearToasts()`)
    const t0 = Date.now()
    await E(`e.click('${label}')`)
    await sleep(1500)
    await W(`!document.querySelector('.pill.busy') && !!e.button('${label}') && !e.button('${label}').disabled`, `${label} to finish`, 240000)
    const toasts = await E(`[...document.querySelectorAll('.toast')].map((t) => t.className.replace('toast ', '') + ': ' + e.text(t)).join(' || ')`)
    console.log(`${label}: finished in ${Date.now() - t0} ms; toasts: ${toasts || '(none)'}`)
    check(`${label} finished with no error and no sign-in problem`, !/error/.test(toasts) && !/sign-in|credential|authentic|401|403/i.test(toasts), toasts)
    await app.screenshot(join(ROOT, `after-${label}.png`))
  }
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

await sleep(1000)
const after = state()
check('the remote branch is exactly where it was (nothing was published)', after.remote === before.remote, after.remote)
check('HEAD is where it was', after.head === before.head)
check('every ref, local and remote-tracking, is identical', after.refs === before.refs)
check('the working tree and index are unchanged', after.status === before.status)
check('the stash is unchanged', after.stash === before.stash)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed.`)
process.exit(failed.length ? 1 : 0)
