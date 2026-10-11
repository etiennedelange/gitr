// Real Fetch through the real app on ONE repository you choose (it uses your own sign-in, via Git
// Credential Manager, like a fetch you run yourself). Fetch only updates remote-tracking refs: this
// proves that by comparing everything before and after, and saves the "before" refs to a file so
// anything a prune removed can be recreated.
//
// Usage:  REPO="D:\path\to\repo" node tools/e2e/real-fetch.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO = process.env.REPO
if (!REPO) throw new Error('set REPO to the repository to fetch')
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9362
const UI_PORT = 5326
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-fetch-'))
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: REPO, env: ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)

const state = () => {
  const refs = git('for-each-ref', '--format=%(refname) %(objectname)').trim().split('\n').filter(Boolean)
  return {
    refs,
    heads: refs.filter((r) => r.startsWith('refs/heads/')).join('\n'),
    remotes: refs.filter((r) => r.startsWith('refs/remotes/')),
    tags: refs.filter((r) => r.startsWith('refs/tags/')),
    head: (() => { try { return git('rev-parse', 'HEAD').trim() } catch { return 'unborn' } })(),
    status: sha(git('status', '--porcelain=v1', '-z', '--untracked-files=all')),
    stash: sha(git('stash', 'list')),
  }
}
const before = state()
const refsFile = join(ROOT, 'refs-before.txt')
writeFileSync(refsFile, before.refs.join('\n') + '\n')
console.log(`repo: ${basename(REPO)}  (${before.remotes.length} remote-tracking refs, ${before.tags.length} tags)`)
console.log(`refs saved to ${refsFile} (recreate any with: git update-ref <ref> <sha>)`)

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
  await W(`!!e.button('Fetch') && !e.button('Fetch').disabled`, 'Fetch enabled', 30000)
  const t0 = Date.now()
  await E(`e.clearToasts()`)
  await E(`e.click('Fetch')`)
  // Either an error toast (e.g. sign-in needed) or the repo going idle again; wait for the busy pill to go.
  await sleep(1500)
  await W(`!document.querySelector('.pill.busy') && !!e.button('Fetch') && !e.button('Fetch').disabled`, 'fetch to finish', 240000)
  const took = Date.now() - t0
  const toasts = await E(`[...document.querySelectorAll('.toast')].map((t) => t.className + ': ' + e.text(t)).join(' || ')`)
  console.log(`fetch finished in ${took} ms; toasts: ${toasts || '(none)'}`)
  await app.screenshot(join(ROOT, 'after-fetch.png'))
  check('Fetch finished without an error toast or banner', !/error/.test(toasts) && !(await E(`!!document.querySelector('.banner.error')`)), toasts)
  check('no sign-in or credential error appeared', !/sign-in|credential|authentic|401|403/i.test(toasts), toasts)
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
const asMap = (list) => new Map(list.map((l) => [l.split(' ')[0], l.split(' ')[1]]))
const b = asMap(before.remotes), a = asMap(after.remotes)
const added = [...a.keys()].filter((k) => !b.has(k))
const removed = [...b.keys()].filter((k) => !a.has(k))
const moved = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k))
console.log(`remote-tracking refs: ${added.length} new, ${moved.length} updated, ${removed.length} pruned`)
for (const k of added.slice(0, 8)) console.log('   new    ', k)
for (const k of moved.slice(0, 8)) console.log('   updated', k, b.get(k).slice(0, 8), '->', a.get(k).slice(0, 8))
for (const k of removed.slice(0, 8)) console.log('   pruned ', k, b.get(k).slice(0, 8), '(gone from the server)')
check('HEAD is where it was', after.head === before.head)
check('every local branch is exactly where it was', after.heads === before.heads)
check('the working tree and index are unchanged', after.status === before.status)
check('the stash is unchanged', after.stash === before.stash)
check('only remote-tracking refs (and possibly tags) changed', [...after.refs].filter((r) => !before.refs.includes(r)).every((r) => /^refs\/(remotes|tags)\//.test(r)))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed.`)
process.exit(failed.length ? 1 : 0)
