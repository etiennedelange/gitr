// READ-ONLY check of the real app against real repositories (yours, not throwaway ones).
//
// It never clicks anything that writes: no Stage / Unstage / Discard / Commit / Fetch / Pull / Push /
// Generate / Checkout / Delete. It only opens views and selects rows. It proves that by recording each
// repository's HEAD, refs, config, index timestamp and status before and after, and by comparing what
// Gitr shows with raw `git` for the same repository.
//
// The app runs with its own throwaway settings (APPDATA is a temp folder), file watching off, so your
// Gitr settings are not touched either.
//
// Usage:  REPOS="D:\path\one;D:\path\two" node tools/e2e/real-repos-readonly.mjs
//         (REPOS defaults to the repositories in your %APPDATA%\gitr\repos.json cache)
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9361
const UI_PORT = 5325
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-real-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)

const repoPaths = process.env.REPOS
  ? process.env.REPOS.split(';').filter(Boolean)
  : JSON.parse(readFileSync(join(process.env.APPDATA, 'gitr', 'repos.json'), 'utf8')).map((r) => r.path)

// Read-only git: never takes the index lock, never prompts, never needs credentials.
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const gitDir = (p) => resolve(p, git(p, 'rev-parse', '--git-dir').trim())
const commonDir = (p) => resolve(p, git(p, 'rev-parse', '--git-common-dir').trim())

/** Everything a write would change, so before/after can be compared. */
function snapshot(p) {
  const gd = gitDir(p)
  const idx = (() => {
    try {
      const s = statSync(join(gd, 'index'))
      return `${s.size}:${s.mtimeMs}`
    } catch {
      return 'none'
    }
  })()
  const head = (() => {
    try {
      return git(p, 'rev-parse', 'HEAD').trim()
    } catch {
      return 'unborn'
    }
  })()
  return {
    head,
    refs: sha(git(p, 'for-each-ref', '--format=%(refname) %(objectname)')),
    config: sha(readFileSync(join(commonDir(p), 'config'), 'utf8')),
    index: idx,
    status: sha(git(p, 'status', '--porcelain=v1', '-z', '--untracked-files=all')),
    stash: sha(git(p, 'stash', 'list')),
  }
}

/** What raw git says the dashboard should show. */
function expected(p) {
  const out = git(p, 'status', '--porcelain=v2', '--branch', '--untracked-files=all')
  let branch = null, ahead = 0, behind = 0, upstream = null, changes = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14)
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      ahead = Number(m[1])
      behind = Number(m[2])
    } else if (/^[12u?] /.test(line)) changes++
  }
  const refs = git(p, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes').split('\n').filter(Boolean)
  return {
    branch, upstream, ahead, behind, changes,
    local: refs.filter((r) => r.startsWith('refs/heads/')).length,
    remote: refs.filter((r) => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')).length,
  }
}

const before = Object.fromEntries(repoPaths.map((p) => [p, snapshot(p)]))
const want = Object.fromEntries(repoPaths.map((p) => [p, expected(p)]))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`)
}

// Isolated settings: one group per repo's parent folder would scan more than the named repos, so use
// each repository itself as a root (scan depth 1 finds exactly it).
const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
const groups = repoPaths.map((p, i) => `[[groups]]\nid = "g${i}"\nname = "${basename(p).replace(/"/g, '')}"\nroots = ['${p}']\n`).join('\n')
writeFileSync(join(appdata, 'gitr', 'config.toml'), `watch = false\nscanDepth = 1\nconcurrency = 3\n\n${groups}`)

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
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= ${repoPaths.length}`, 'all repos in the sidebar', 60000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const errors = []
  await app.evaluate(`window.addEventListener('error', (ev) => (window.__errs = (window.__errs || []).concat(String(ev.message))))`)

  // ---- dashboard vs raw git ----
  await E(`document.querySelector('.nav-item').click()`)
  await W(`document.querySelectorAll('.table-body .row').length >= ${repoPaths.length}`, 'dashboard rows', 60000)
  await sleep(4000) // let the startup refresh finish
  await app.screenshot(join(SHOTS, 'dashboard.png'))
  const rows = await E(`[...document.querySelectorAll('.table-body .row')].map((r) => ({ name: r.querySelector('button.link')?.textContent, cells: [...r.children].map((c) => e.text(c)) }))`)
  for (const p of repoPaths) {
    const name = basename(p)
    const row = rows.find((r) => r.name === name)
    const w = want[p]
    if (!row) { check(`${name}: appears on the dashboard`, false); continue }
    const text = row.cells.join(' | ')
    const branchOk = w.branch === '(detached)' ? /detached/.test(text) : text.includes(w.branch ?? '')
    check(`${name}: branch matches git (${w.branch})`, branchOk, text)
    check(`${name}: behind/ahead match git (${w.behind}/${w.ahead})`, new RegExp(`${w.behind}\\s*/\\s*${w.ahead}`).test(text), text)
    check(`${name}: change count matches git (${w.changes})`, (w.changes === 0 ? /–|-|0/.test(row.cells[4] ?? '') : (row.cells[4] ?? '').includes(String(w.changes))), `cells: ${row.cells.join(' | ')}`)
  }

  // ---- each repo: Changes view, one real diff, Branches view (all read-only) ----
  for (const p of repoPaths) {
    const name = basename(p)
    const w = want[p]
    const t0 = Date.now()
    await E(`e.openRepo(${JSON.stringify(name)})`)
    await W(`document.querySelector('.repo-head h1')?.textContent === ${JSON.stringify(name)}`, `${name} header`, 30000)
    if (w.changes > 0) await W(`document.querySelectorAll('.file-list li').length > 0`, `${name} file list`, 60000)
    else await sleep(1500)
    const staged = await E(`document.querySelectorAll('.file-section.staged .file-list li').length`)
    const unstaged = await E(`document.querySelectorAll('.file-section.unstaged .file-list li').length`)
    check(`${name}: Changes view lists exactly git's ${w.changes} changed files`, staged + unstaged === w.changes, `${staged} staged + ${unstaged} unstaged, opened in ${Date.now() - t0} ms`)
    if (w.changes > 0) {
      await E(`document.querySelector('.file-list li').click()`)
      await sleep(1200)
      const diffOk = await E(`!!document.querySelector('.diff-head') && !document.querySelector('.diff .banner.error')`)
      const diffText = await E(`(document.querySelector('.diff-body')?.innerText ?? '').slice(0, 80)`)
      check(`${name}: a real diff renders without an error`, diffOk, diffText)
    }
    await app.screenshot(join(SHOTS, `${name}-changes.png`))
    await E(`document.querySelector('#tab-branches').click()`)
    await sleep(900)
    const local = await E(`(() => { const h = [...document.querySelectorAll('.branch-lists h2')]; return h.map((x) => x.textContent) })()`)
    const counts = local.map((t) => Number((t.match(/\((\d+)\)/) ?? [])[1]))
    check(`${name}: Branches view shows git's ${w.local} local and ${w.remote} remote branches`, counts[0] === w.local && counts[1] === w.remote, local.join(' / '))
    await app.screenshot(join(SHOTS, `${name}-branches.png`))
    await E(`document.querySelector('#tab-changes').click()`)
    const errToasts = await E(`[...document.querySelectorAll('.toast.error, .banner.error')].map((t) => e.text(t)).join(' || ')`)
    check(`${name}: no error banner or toast`, errToasts === '', errToasts)
  }
  const pageErrors = await E(`(window.__errs || []).join(' | ')`)
  check('no uncaught page errors across all repositories', pageErrors === '', pageErrors)
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

// ---- prove nothing was written ----
await sleep(1500)
for (const p of repoPaths) {
  const after = snapshot(p)
  const b = before[p]
  const diffs = Object.keys(b).filter((k) => b[k] !== after[k])
  check(`${basename(p)}: untouched (HEAD, refs, config, index, status, stash all identical)`, diffs.length === 0, diffs.length ? `changed: ${diffs.join(', ')}` : '')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots (contain your repo names; delete when done): ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
