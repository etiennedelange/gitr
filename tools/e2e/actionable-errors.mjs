// End-to-end check of actionable errors against the real app: real backend, real git,
// real UI, real native dialogs (answered through Windows UI Automation, see dialog.ps1).
//
// Usage (from the repo root, after `cargo build -p gitr`):  node tools/e2e/actionable-errors.mjs
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PAGE_HELPERS, answerDialog, connect, sleep } from './cdp.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const APP = join(REPO_ROOT, 'target', 'debug', 'gitr.exe')
const PORT = 9345
// Our own UI dev server (port 5173 may be another checkout's, e.g. a worktree).
const UI_PORT = 5290
const ROOT = mkdtempSync(join(tmpdir(), 'gitr-e2e-'))
const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS)
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com',
  GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
const gitFails = (cwd, ...args) => {
  try {
    git(cwd, ...args)
  } catch {
    return
  }
  throw new Error(`git ${args.join(' ')} should have failed`)
}
const write = (p, s) => writeFileSync(p, s)

// ---------- scenario repos ----------
const repos = join(ROOT, 'repos')
const remotes = join(ROOT, 'remotes')
mkdirSync(repos)
mkdirSync(remotes)

// nonff: the remote got a commit from someone else; we have a local commit to push.
git(remotes, 'init', '-q', '--bare', '-b', 'main', 'nonff.git')
const nonff = join(repos, 'nonff')
git(repos, 'clone', '-q', join(remotes, 'nonff.git'), 'nonff')
git(nonff, 'checkout', '-q', '-b', 'main')
write(join(nonff, 'a.txt'), '1\n')
git(nonff, 'add', '.')
git(nonff, 'commit', '-q', '-m', 'first')
git(nonff, 'push', '-q', '-u', 'origin', 'main')
const other = join(ROOT, 'other')
git(ROOT, 'clone', '-q', join(remotes, 'nonff.git'), 'other')
write(join(other, 'b.txt'), 'theirs\n')
git(other, 'add', '.')
git(other, 'commit', '-q', '-m', 'their commit')
git(other, 'push', '-q')
write(join(nonff, 'c.txt'), 'mine\n')
git(nonff, 'add', '.')
git(nonff, 'commit', '-q', '-m', 'my commit')

// ffonly: behind only (nothing local) — what "Pull" can actually fix.
const ffonly = join(repos, 'ffonly')
git(repos, 'clone', '-q', join(remotes, 'nonff.git'), 'ffonly')
git(ffonly, 'reset', '-q', '--hard', 'HEAD~1')

// locked: a leftover index.lock and a change to stage.
const locked = join(repos, 'locked')
mkdirSync(locked)
git(locked, 'init', '-q', '-b', 'main')
write(join(locked, 'a.txt'), '1\n')
git(locked, 'add', '.')
git(locked, 'commit', '-q', '-m', 'first')
write(join(locked, 'a.txt'), '2\n')
write(join(locked, '.git', 'index.lock'), '')

// merging: a merge stopped on a conflict.
const merging = join(repos, 'merging')
mkdirSync(merging)
git(merging, 'init', '-q', '-b', 'main')
write(join(merging, 'a.txt'), 'base\n')
git(merging, 'add', '.')
git(merging, 'commit', '-q', '-m', 'base')
git(merging, 'switch', '-q', '-c', 'side')
write(join(merging, 'a.txt'), 'side\n')
git(merging, 'commit', '-q', '-am', 'side')
git(merging, 'switch', '-q', 'main')
write(join(merging, 'a.txt'), 'main\n')
git(merging, 'commit', '-q', '-am', 'main')
gitFails(merging, 'merge', 'side')

// App config: one group with these repos.
const appdata = join(ROOT, 'appdata')
mkdirSync(join(appdata, 'gitr'), { recursive: true })
const configToml = join(appdata, 'gitr', 'config.toml')
writeFileSync(configToml, `watch = true\n\n[[groups]]\nid = "e2e"\nname = "E2E"\nroots = ['${repos}']\n`)

// ---------- run ----------
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function startApp(extraEnv = {}) {
  const env = {
    ...process.env,
    APPDATA: appdata,
    GITR_E2E_DEVTOOLS_PORT: String(PORT),
    GITR_E2E_DEV_URL: `http://localhost:${UI_PORT}/`,
    // Own WebView2 profile: instances sharing one (e.g. a Gitr you have open) share a browser
    // process, and the debugging port would not be applied.
    WEBVIEW2_USER_DATA_FOLDER: join(ROOT, 'webview2'),
    ...extraEnv,
  }
  const child = spawn(APP, [], { env, stdio: 'ignore' })
  const app = await connect(PORT)
  await app.waitFor(`!!window.__TAURI_INTERNALS__ && document.querySelectorAll('.repo-item').length >= 4`, 'repos in sidebar', 30000)
  await app.evaluate(PAGE_HELPERS)
  check('app runs the UI from this checkout', (await app.evaluate('location.port')) === String(UI_PORT))
  return { app, child }
}
async function stopApp({ app, child }) {
  app.close()
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch {}
  await sleep(1000)
}

const vite = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'vp', 'dev', '--port', String(UI_PORT), '--strictPort'], {
  cwd: join(REPO_ROOT, 'ui'),
  stdio: 'ignore',
  shell: process.platform === 'win32',
})
let run
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${UI_PORT}/`)).ok) break
    } catch {}
    await sleep(500)
  }

  // ===== Run 1: git available =====
  run = await startApp()
  const { app } = run
  const E = (expr) => app.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W = (expr, what, ms) => app.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)

  // Fact 15: dashboard pill, on the merging repo only.
  const pill = await W(`e.dashRow('merging')?.querySelector('.status-cell .pill') ? e.text(e.dashRow('merging').querySelector('.status-cell .pill')) : ''`, 'merging pill')
  check('dashboard: merging repo shows a "merging" pill (15)', pill === 'merging', pill)
  check('dashboard: other repos show no operation pill', await E(`!['nonff', 'locked', 'ffonly'].some((n) => e.text(e.dashRow(n)?.querySelector('.status-cell') ?? document.createElement('i')).includes('merging'))`))
  await app.screenshot(join(SHOTS, '1-dashboard.png'))

  // Facts 3–5: rejected push → friendly message, details, Pull.
  await E(`e.openRepo('nonff')`)
  await W(`e.button('Push') && !e.button('Push').disabled`, 'Push enabled')
  await E(`e.click('Push')`)
  const toastText = await W(`e.toast('error') && e.text(e.toast('error'))`, 'push error toast')
  check('push rejected: plain-language message (3)', toastText.includes('Your branch and the remote have both moved on. Rebase or merge, then push.'), toastText)
  await E(`e.click('details', e.toast('error'))`)
  const details = await W(`e.toast('error').querySelector('.toast-detail') && e.text(e.toast('error').querySelector('.toast-detail'))`, 'details')
  check('push rejected: raw git output behind details, incl. stdout reason (4)', details.includes('[rejected]') && details.includes('fetch first'), details.slice(0, 120))
  // Since diverged-pull the fix is Rebase & push (tested in full by diverged-pull.mjs).
  check('push rejected: toast offers Rebase & push (5, superseded by diverged-pull 6)', await W(`!!e.button('Rebase & push', e.toast('error'))`, 'Rebase & push'))
  await app.screenshot(join(SHOTS, '2-nonff-toast.png'))
  await E(`e.clearToasts()`)

  // Pull where it can actually fix things (only behind).
  await E(`e.openRepo('ffonly')`)
  await W(`e.button('Pull') && !e.button('Pull').disabled`, 'Pull enabled')

  // Fact 6: lock → Remove stale lock (dialog answered yes; text recorded), lock gone, staging works.
  await E(`e.openRepo('locked')`)
  await W(`!!e.button('Stage all')`, 'Stage all button')
  await E(`e.click('Stage all')`)
  const lockToast = await W(`e.toast('error') && e.text(e.toast('error'))`, 'lock toast')
  check('lock: plain-language message (3)', lockToast.includes('Another git process is using this repository'), lockToast)
  check('lock: toast offers Remove stale lock (6)', await E(`!!e.button('Remove stale lock', e.toast('error'))`))
  await app.screenshot(join(SHOTS, '3-lock-toast.png'))
  await E(`e.click('Remove stale lock', e.toast('error'))`)
  // The real Windows dialog, answered via UI Automation.
  const asked = await answerDialog({ title: 'Remove stale lock', button: 'Yes' })
  check('lock: confirmation names the lock file and warns about other tools (6)', asked.includes('index.lock') && asked.includes('no other git tool'), asked.replace(/\s+/g, ' ').slice(0, 160))
  await W(`!e.toast('error') || !e.text(e.toast('error')).includes('Another git process')`, 'lock toast closed')
  await sleep(300)
  check('lock: the file is deleted (6)', !existsSync(join(locked, '.git', 'index.lock')))
  await E(`e.click('Stage all')`)
  await sleep(1500)
  check('lock: staging works afterwards', git(locked, 'diff', '--cached', '--name-only').trim() === 'a.txt')

  // Facts 16–19: merging repo.
  await E(`e.openRepo('merging')`)
  const banner = await W(`document.querySelector('.banner.operation') && e.text(document.querySelector('.banner.operation'))`, 'operation banner')
  check('merge: banner with state and conflicted count (16)', banner.includes('Merge in progress') && banner.includes('1 conflicted file'), banner)
  check('merge: banner has Abort, Open terminal, Open in VS Code (16)', ['Abort', 'Open terminal', 'Open in VS Code'].every((l) => banner.includes(l)))
  check('merge: Pull disabled (18)', await E(`e.button('Pull').disabled`))
  const msg = await W(`document.querySelector('textarea') && document.querySelector('textarea').value`, 'prefilled message')
  check('merge: commit box prefilled from MERGE_MSG (19)', msg.startsWith("Merge branch 'side'"), JSON.stringify(msg.slice(0, 40)))
  check('merge: Undo last commit disabled (18)', await E(`!e.button('Undo last commit') || e.button('Undo last commit').disabled`))
  await app.screenshot(join(SHOTS, '4-merge-banner.png'))
  await E(`[...document.querySelectorAll('.tabs button')][1].click()`)
  await W(`!!e.button('Checkout')`, 'branch list')
  check('merge: Checkout disabled (18)', await E(`e.button('Checkout').disabled`))
  await E(`[...document.querySelectorAll('.tabs button')][0].click()`)
  await W(`e.button('Abort') && !e.button('Abort').disabled`, 'Abort enabled')
  await E(`e.click('Abort')`)
  const abortQ = await answerDialog({ title: 'Abort merge', button: 'Yes' })
  check('merge: Abort asks first (17)', abortQ.includes('Abort the merge?'), abortQ.slice(0, 120))
  await W(`!document.querySelector('.banner.operation')`, 'banner gone', 15000)
  check('merge: banner disappears after abort (17)', true)
  check('merge: repository is no longer merging (17)', !existsSync(join(merging, '.git', 'MERGE_HEAD')))

  // Facts 11, 14: Settings Git path.
  await E(`e.click('Settings')`)
  const using = await W(`[...document.querySelectorAll('p[role=status]')].map(e.text).find((t) => t.startsWith('Using '))`, 'git in use')
  check('settings: shows git in use and version (11)', /Using .*git\.exe · git \d+\.\d+/.test(using), using)
  await E(`e.setInput(document.querySelector('input[placeholder^="Automatic"]'), 'C:\\\\nope\\\\git.exe')`)
  await E(`e.click('Save')`)
  const ignored = await W(`[...document.querySelectorAll('p[role=status]')].map(e.text).find((t) => t.includes('could not be run'))`, 'setting ignored note')
  check('settings: a wrong Git path is reported and automatic is used (11, 14)', ignored.includes('Using ') && ignored.includes('could not be run'), ignored)
  await app.screenshot(join(SHOTS, '5-settings-bad-path.png'))
  await E(`e.setInput(document.querySelector('input[placeholder^="Automatic"]'), '')`)
  await E(`e.click('Save')`)
  await W(`[...document.querySelectorAll('p[role=status]')].map(e.text).some((t) => t.startsWith('Using ') && !t.includes('could not be run'))`, 'back to automatic')
  check('settings: clearing the path goes back to automatic (14)', true)
  await stopApp(run)
  run = null

  // ===== Run 2: git not findable (PATH stripped, Program Files hidden) =====
  run = await startApp({ PATH: 'C:\\Windows\\System32;C:\\Windows', ProgramFiles: 'C:\\nope-pf', 'ProgramFiles(x86)': 'C:\\nope-pf86', ProgramW6432: 'C:\\nope-pf' })
  const A = run.app
  const E2 = (expr) => A.evaluate(`(() => { const e = window.__e2e; return ${expr} })()`)
  const W2 = (expr, what, ms) => A.waitFor(`(() => { const e = window.__e2e; return ${expr} })()`, what, ms)
  const gitBanner = await W2(`document.querySelector('.banner.git') && e.text(document.querySelector('.banner.git'))`, 'git banner')
  check('git missing: banner says so with winget install Git.Git (12)', gitBanner.includes("Git wasn't found.") && gitBanner.includes('winget install Git.Git'), gitBanner)
  check('git missing: Copy, Choose git.exe…, Check again (12)', ['Copy', 'Choose git.exe…', 'Check again'].every((l) => gitBanner.includes(l)))
  await A.screenshot(join(SHOTS, '6-git-missing.png'))
  await E2(`e.click('Check again')`)
  await sleep(1000)
  check('git missing: Check again keeps the banner while git is still missing (12)', await E2(`!!document.querySelector('.banner.git')`))
  await E2(`e.click('Choose git.exe…')`)
  // The real file picker opens; cancelling it changes nothing.
  await answerDialog({ title: 'Choose git.exe', button: 'Cancel' })
  check('git missing: Choose git.exe… opens the file picker; cancelling keeps the banner (12)', await E2(`!!document.querySelector('.banner.git')`))
  // What the picker does on Open: the same backend command, through the app's own IPC.
  await E2(`window.__TAURI_INTERNALS__.invoke('set_git_path', { path: 'C:\\\\Program Files\\\\Git\\\\cmd\\\\git.exe' })`)
  await E2(`e.click('Check again')`)
  await W2(`!document.querySelector('.banner.git')`, 'banner gone after choosing git')
  check('git missing: choosing git.exe fixes it immediately, no restart (14)', true)
  const saved = readFileSync(configToml, 'utf8')
  check('git missing: chosen path saved in config', saved.includes('git_path') || saved.includes('gitPath'), saved.split('\n').find((l) => /git_?[pP]ath/.test(l)) ?? '')
  await stopApp(run)
  run = null
} catch (e) {
  check('scenario ran to the end', false, e.message)
  if (run) await run.app.screenshot(join(SHOTS, 'failure.png')).catch(() => {})
} finally {
  if (run) await stopApp(run)
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(vite.pid)], { stdio: 'ignore' })
  } catch {}
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${SHOTS}`)
process.exit(failed.length ? 1 : 0)
