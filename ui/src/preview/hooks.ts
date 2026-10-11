// Simulated git hooks for the preview: commit and push run "hooks" that print output over a few
// seconds and then pass or fail, so the hook panel, the busy pill and Stop can be tried.
// Chosen with ?hooks=pass|fail or the toolbar's Hooks menu.
import { emit } from '@tauri-apps/api/event'

export type HookMode = 'none' | 'pass' | 'fail'
export const HOOK_MODES: { id: HookMode; name: string }[] = [
  { id: 'none', name: 'No hooks' },
  { id: 'pass', name: 'Hooks pass (slow)' },
  { id: 'fail', name: 'Hooks fail' },
]

const initial = new URLSearchParams(location.search).get('hooks')
let mode: HookMode = initial === 'pass' || initial === 'fail' ? initial : 'none'
export const hookMode = () => mode
export function setHookMode(m: HookMode) {
  mode = m
}

const OUTPUT = {
  commit: {
    hook: 'pre-commit',
    common: [
      '> lint-staged',
      '✔ Preparing lint-staged...',
      '❯ Running tasks for staged files...',
      '  ❯ *.{ts,tsx} — 4 files',
      '    ❯ eslint --fix',
      '    ❯ prettier --write',
    ],
    pass: ['    ✔ eslint --fix', '    ✔ prettier --write', '✔ Applying modifications from tasks...', '✔ Cleaning up temporary files...'],
    fail: [
      '    ✖ eslint --fix [FAILED]',
      '',
      'src/invoices/export.ts',
      "  14:7  error  'pdf' is assigned a value but never used  no-unused-vars",
      '',
      '✖ 1 problem (1 error, 0 warnings)',
    ],
  },
  push: {
    hook: 'pre-push',
    common: [
      '> npm test',
      '',
      ' RUN  v4.1.0',
      '',
      ' ✓ src/invoices/csv.test.ts (12 tests) 41ms',
      ' ✓ src/invoices/format.test.ts (8 tests) 17ms',
    ],
    pass: [' ✓ src/invoices/pdf.test.ts (5 tests) 88ms', '', ' Test Files  3 passed (3)', '      Tests  25 passed (25)'],
    fail: [
      ' ✗ src/invoices/pdf.test.ts (5 tests | 1 failed) 92ms',
      '   ✗ renders the total row',
      "     → expected '€ 1.204,50' to be '€ 1,204.50'",
      '',
      ' Test Files  1 failed | 2 passed (3)',
      '      Tests  1 failed | 24 passed (25)',
    ],
  },
}

const stopped = new Set<string>()
/** Stop (cancel_operation) on a repo whose simulated hooks run. */
export function stopHooks(path: string): boolean {
  if (!running.has(path)) return false
  stopped.add(path)
  return true
}
const running = new Set<string>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Runs the simulated hooks of a commit or push on `path`, like the backend: busy pill,
 * `hooks-started`, `hook-output` line by line. Rejects like the backend when a hook fails or
 * Stop is clicked. Nothing happens without hooks or with `skip` (--no-verify).
 */
export async function runHooks(path: string, op: 'commit' | 'push', skip: boolean): Promise<void> {
  if (mode === 'none' || skip) return
  const out = OUTPUT[op]
  const busy = op === 'commit' ? 'committing' : 'pushing'
  const lines = [...out.common, ...out[mode]]
  running.add(path)
  stopped.delete(path)
  void emit('repo-busy', { path, op: busy })
  void emit('hooks-started', { path, op })
  try {
    for (const line of lines) {
      await sleep(line ? 350 : 120)
      if (stopped.has(path)) throw { message: `Stopped ${busy}.`, detail: null, kind: 'cancelled', repo: path, lockPath: null, hook: null }
      void emit('hook-output', { path, line })
    }
    if (mode === 'fail') {
      const message = `The ${out.hook} hook rejected the ${op}.`
      throw { message, detail: lines.join('\n'), kind: 'hook', repo: path, lockPath: null, hook: out.hook }
    }
  } finally {
    running.delete(path)
    stopped.delete(path)
    void emit('repo-busy', { path, op: null })
  }
}
