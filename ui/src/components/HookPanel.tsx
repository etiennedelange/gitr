import { useEffect, useRef } from 'react'
import { SquareTerminal, X } from 'lucide-react'
import { ask } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { notifyError, useBusy } from '../hooks'
import { runCommit, runPush } from '../lib/send'
import { useApp } from '../store'

/**
 * Output of the hooks a commit or push runs in this repo, live while they run. When a hook
 * rejected the operation it stays, names the hook, and offers to repeat it without hooks.
 */
export function HookPanel({ path }: { path: string }) {
  const run = useApp((st) => st.hookRuns[path])
  const busyOp = useBusy(path)
  const out = useRef<HTMLPreElement>(null)
  const lines = run?.lines.length ?? 0

  // Follow the output, unless the user scrolled up to read.
  const follow = useRef(true)
  useEffect(() => {
    const el = out.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [lines])

  if (!run) return null
  const failed = run.failed
  const noun = run.op === 'commit' ? 'commit' : 'push'
  const title = failed ? failed.error.message : `Running ${noun} hooks…`

  const withoutHooks = async () => {
    if (!failed) return
    const hook = failed.error.hook ?? 'hook'
    const ok = await ask(
      `${noun === 'commit' ? 'Commit' : 'Push'} without running hooks?\n\nThe ${hook} hook rejected this ${noun}. ` +
        `Skipping hooks ${noun === 'commit' ? 'commits' : 'pushes'} anyway (git ${noun} --no-verify); the checks it would have run are not done.`,
      {
        title: `${noun === 'commit' ? 'Commit' : 'Push'} without hooks`,
        kind: 'warning',
        okLabel: `${noun === 'commit' ? 'Commit' : 'Push'} without hooks`,
        cancelLabel: 'Cancel',
      },
    )
    if (!ok) return
    const retry = failed.retry
    if (retry.kind === 'commit') await runCommit(path, retry.message, retry.amend, retry.andPush, true)
    else await runPush(path, useApp.getState().summaries[path]?.ahead ?? 1, true)
  }

  return (
    <section className={`hook-panel ${failed ? 'failed' : 'running'}`} aria-label="Hook output">
      <header>
        <span className="hook-title" role={failed ? 'alert' : 'status'}>
          {title}
        </span>
        {failed && (
          <span className="actions">
            <button className="small" disabled={!!busyOp} onClick={() => void withoutHooks()}>
              {noun === 'commit' ? 'Commit without hooks' : 'Push without hooks'}
            </button>
            <button className="small" onClick={() => api.openWith(path, 'terminal').catch(notifyError)}>
              <SquareTerminal className="ico" aria-hidden />
              Open terminal
            </button>
            <button className="icon" title="Dismiss" aria-label="Dismiss hook output" onClick={() => useApp.getState().clearHookRun(path)}>
              <X className="ico" aria-hidden />
            </button>
          </span>
        )}
      </header>
      {lines > 0 && (
        <pre
          ref={out}
          className="hook-output selectable"
          onScroll={(e) => {
            const el = e.currentTarget
            follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
          }}
        >
          {run.lines.join('\n')}
        </pre>
      )}
    </section>
  )
}
