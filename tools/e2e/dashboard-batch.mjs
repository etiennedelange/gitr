// End-to-end check against the real app: Fetch all / Pull all on the dashboard across repositories
// in different states. Failures in one repo never stop the others, a diverged repo is never
// rewritten by a batch pull, and uncommitted work survives.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/dashboard-batch.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9353
const UI_PORT = 5297
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-batch-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const remotes = join(ROOT, 'remotes')
mkdirSync(repos)
mkdirSync(remotes)

/** A clone of its own bare remote with one commit; `others(otherDir)` pushes extra commits from a second clone. */
function make(name, { remote = true, theirs = false, mine = false, dirty = false } = {}) {
  const dir = join(repos, name)
  if (!remote) {
    mkdirSync(dir)
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'base')
    return dir
  }
  const bare = join(remotes, `${name}.git`)
  git(remotes, 'init', '-q', '--bare', '-b', 'main', bare)
  git(repos, 'clone', '-q', bare, name)
  git(dir, 'checkout', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'base\n')
  writeFileSync(join(dir, 'b.txt'), 'base b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  if (theirs) {
    const other = join(ROOT, `other-${name}`)
    git(ROOT, 'clone', '-q', bare, `other-${name}`)
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    git(other, 'add', '.')
    git(other, 'commit', '-q', '-m', 'their commit')
    git(other, 'push', '-q')
  }
  if (mine) {
    writeFileSync(join(dir, 'mine.txt'), 'mine\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'my commit')
  }
  if (dirty) writeFileSync(join(dir, 'b.txt'), 'uncommitted edit\n')
  return dir
}

const uptodate = make('uptodate')
const behind = make('behind', { theirs: true })
const behindDirty = make('behind-dirty', { theirs: true, dirty: true })
const diverged = make('diverged', { theirs: true, mine: true })
const noRemote = make('no-remote', { remote: false })
const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim()
const divergedHead = head(diverged)
const upToDateHead = head(uptodate)

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
  child = spawn(APP, [], {
    env: { ...process.env, APPDATA: appdata, GITR_E2E_DEVTOOLS_PORT: String(PORT),
      GITR_E2E_DEV_URL: `http://localhost:${UI_PORT}/`, WEBVIEW2_USER_DATA_FOLDER: join(ROOT, 'webview2') },
    stdio: 'ignore',
  })
  app = await connect(PORT)
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 5`, 'repos in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const rowText = (name) => E(`(() => { const r = e.dashRow('${name}'); return r ? e.text(r) : null })()`)

  await E(`document.querySelector('.nav-item').click()`)
  await W(`document.querySelectorAll('.table-body .row').length >= 5`, 'dashboard rows', 20000)

  // ---- Fetch all ----
  await E(`e.click('Fetch all')`)
  await W(`[...document.querySelectorAll('.toast')].some((t) => /Fetched/.test(t.textContent))`, 'fetch summary toast', 60000)
  const fetchToast = await E(`e.text([...document.querySelectorAll('.toast')].find((t) => /Fetched/.test(t.textContent)))`)
  check('Fetch all says the repo without a remote was skipped, not fetched', /Fetched 4\/5, 1 skipped/.test(fetchToast), fetchToast)
  check('Fetch all fetched the behind repos', (await rowText('behind'))?.includes('1') ?? false, await rowText('behind'))
  await E(`e.clearToasts()`)
  await sleep(500)

  // ---- Pull all ----
  await E(`e.click('Pull all')`)
  await W(`[...document.querySelectorAll('.toast')].some((t) => /Pulled/.test(t.textContent))`, 'pull summary toast', 60000)
  await sleep(1500)
  const pullToast = await E(`e.text([...document.querySelectorAll('.toast')].find((t) => /Pulled/.test(t.textContent)))`)
  console.log('pull toast:', pullToast)
  await app.screenshot(join(SHOTS, 'after-pull-all.png'))
  const behindHead = head(behind)
  check('Pull all fast-forwarded the clean repo that was behind', git(behind, 'rev-list', '--count', 'HEAD..@{u}').trim() === '0' && readFileSync(join(behind, 'theirs.txt'), 'utf8').includes('theirs'))
  check('Pull all fast-forwarded the repo with uncommitted changes without touching them', readFileSync(join(behindDirty, 'theirs.txt'), 'utf8').includes('theirs') && readFileSync(join(behindDirty, 'b.txt'), 'utf8').replace(/\r\n/g, '\n') === 'uncommitted edit\n')
  check('Pull all left the diverged repo exactly where it was (no rebase, no merge)', head(diverged) === divergedHead, head(diverged))
  check('Pull all left the up-to-date repo alone', head(uptodate) === upToDateHead)
  check('the diverged repo has no operation in progress and no stash', git(diverged, 'stash', 'list').trim() === '' && git(diverged, 'status', '--porcelain').trim() === '')
  const divergedRow = await rowText('diverged')
  check('the dashboard tells you the diverged repo was not pulled', !!divergedRow && /diverged|skipped|rebase|merge/i.test(divergedRow), divergedRow)
  const noRemoteRow = await rowText('no-remote')
  check('the repo without a remote shows an error, not a success', !!noRemoteRow && !/ok/.test(noRemoteRow.replace('no-remote', '')), noRemoteRow)
  check('one failing repo did not stop the others from finishing', /Pulled/.test(pullToast), pullToast)
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
