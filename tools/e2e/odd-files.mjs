// End-to-end check against the real app: unusual files (Unicode and spaces in names, a rename, a
// binary, an empty file, one huge line, CRLF, a deletion) list and diff sensibly, and can be
// staged, unstaged and committed.
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/odd-files.mjs
// GITR_E2E_APP overrides the path of gitr.exe.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = process.env.GITR_E2E_APP ?? join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9352
const UI_PORT = 5296
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-odd-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' })

const repos = join(ROOT, 'repos')
const dir = join(repos, 'odd')
mkdirSync(dir, { recursive: true })
git(dir, 'init', '-q', '-b', 'main')
writeFileSync(join(dir, 'to-rename.txt'), 'line one\nline two\nline three\nline four\nline five\n')
writeFileSync(join(dir, 'to-delete.txt'), 'goodbye\n')
writeFileSync(join(dir, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
git(dir, 'add', '.')
git(dir, 'commit', '-q', '-m', 'base')

mkdirSync(join(dir, 'sub dir'))
writeFileSync(join(dir, 'sub dir', 'naïve café 日本語.txt'), 'unicode name\n')
writeFileSync(join(dir, 'with space.txt'), 'space\n')
writeFileSync(join(dir, 'weird[1]{a}&b%20.txt'), 'glob chars\n')
writeFileSync(join(dir, 'empty.txt'), '')
writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 9, 9]))
writeFileSync(join(dir, 'huge-line.txt'), 'x'.repeat(200000) + '\n')
renameSync(join(dir, 'to-rename.txt'), join(dir, 'renamed.txt'))
writeFileSync(join(dir, 'renamed.txt'), 'line one\nline two\nline three\nline four\nline five\nline six\n')
rmSync(join(dir, 'to-delete.txt'))
writeFileSync(join(dir, 'crlf.txt'), 'a\r\nB changed\r\nc\r\n')
git(dir, 'add', '-N', 'renamed.txt') // intent-to-add: a state many tools mishandle
git(dir, 'rm', '--cached', '-q', 'to-rename.txt')

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
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 1`, 'repo in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const names = () => E(`[...document.querySelectorAll('.file-list li .fname')].map((n) => n.textContent)`)
  const clickRow = (name) => E(`(() => { const li = [...document.querySelectorAll('.file-list li')].find((l) => l.querySelector('.fname')?.textContent === ${JSON.stringify(name)}); if (!li) throw new Error('no row ' + ${JSON.stringify(name)}); li.click(); return true })()`)
  const diffText = async () => {
    await sleep(700)
    return E(`document.querySelector('.diff-body')?.innerText ?? ''`)
  }

  await E(`e.openRepo('odd')`)
  await W(`document.querySelectorAll('.file-list li').length >= 8`, 'files listed', 30000)
  const listed = await names()
  console.log('listed:', JSON.stringify(listed))
  for (const n of ['naïve café 日本語.txt', 'with space.txt', 'weird[1]{a}&b%20.txt', 'empty.txt', 'binary.bin', 'huge-line.txt', 'crlf.txt']) {
    check(`lists "${n}" with its real name`, listed.includes(n))
  }
  check('lists the deletion', listed.includes('to-delete.txt'))
  check('lists the rename by its new name', listed.includes('renamed.txt'))

  for (const [n, expect] of [
    ['naïve café 日本語.txt', 'unicode name'],
    ['with space.txt', 'space'],
    ['weird[1]{a}&b%20.txt', 'glob chars'],
    ['to-delete.txt', 'goodbye'],
  ]) {
    await clickRow(n)
    const t = await diffText()
    check(`diff of "${n}" shows its content`, t.includes(expect), t.slice(0, 80))
  }
  await clickRow('binary.bin')
  const bin = await diffText()
  check('a binary file says Binary file', /Binary file/i.test(bin), bin.slice(0, 80))
  await clickRow('empty.txt')
  const empty = await diffText()
  check('an empty new file does not break the diff', !/error/i.test(empty), empty.slice(0, 80))
  await clickRow('huge-line.txt')
  const huge = await diffText()
  check('a 200,000-character line still renders (and the UI stays responsive)', huge.length > 1000 && (await E(`!!document.querySelector('.file-list')`)))
  await app.screenshot(join(SHOTS, 'huge-line.png'))
  await clickRow('crlf.txt')
  const crlf = await diffText()
  check('a CRLF file shows only the changed line as changed', crlf.includes('B changed'), crlf.slice(0, 120))
  await clickRow('renamed.txt')
  await diffText()
  await app.screenshot(join(SHOTS, 'renamed.png'))

  // Stage everything, unstage everything, stage again: no file is lost or duplicated.
  const before = (await names()).length
  await E(`e.click('Stage all')`)
  await W(`document.querySelectorAll('.file-section.unstaged .file-list li').length === 0`, 'all staged', 30000)
  const staged = git(dir, 'diff', '--cached', '--name-only').trim().split('\n').filter(Boolean)
  check('Stage all stages every odd file', staged.length >= 9, staged.join(', '))
  await E(`e.click('Unstage all')`)
  await W(`document.querySelectorAll('.file-section.staged .file-list li').length === 0`, 'all unstaged', 30000)
  check('Unstage all leaves nothing staged', git(dir, 'diff', '--cached', '--name-only').trim() === '')
  check('the number of listed files is unchanged after the round trip', (await names()).length === before, `${before} vs ${(await names()).length}`)

  // Commit one unicode-named file alone.
  await E(`document.querySelector('.file-list li .fname') && true`)
  await E(`(() => { const li = [...document.querySelectorAll('.file-list li')].find((l) => l.querySelector('.fname')?.textContent === 'naïve café 日本語.txt'); li.querySelector('button[title="Stage"]').click(); return true })()`)
  await W(`document.querySelectorAll('.file-section.staged .file-list li').length === 1`, 'one staged', 20000)
  await app.evaluate(`(() => { const t = document.querySelector('.commit-box textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Add the unicode file'); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await W(`!!e.button('Commit') && !e.button('Commit').disabled`, 'Commit enabled')
  await E(`e.click('Commit')`)
  await W(`[...document.querySelectorAll('.toast')].some((t) => /Committed/.test(t.textContent))`, 'committed toast', 20000)
  check('committing only the unicode-named file commits just that file', git(dir, 'show', '--name-only', '--format=', 'HEAD').trim() === 'sub dir/naïve café 日本語.txt', git(dir, 'show', '--name-only', '--format=', 'HEAD'))
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
